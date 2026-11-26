import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import erpRoutes, { erpBearer } from "../src/modules/erp/erpRoutes.js";
import erpImageStudioRoutes from "../src/modules/erp/erpImageStudioRoutes.js";
import { requireErpStaff } from "../src/modules/erp/erpAuth.js";

const png = Buffer.from("89504e470d0a1a0a", "hex");
const path = "/erp/image-studio";
const endpoint = `${path}/perfumes/26/jobs`;
const headers = {
  authorization: "Bearer signed.owner.token", "content-type": "image/png",
  "x-source-approved": "true", "x-source-usage-permitted": "true",
};
const getUser = async (token) => {
  const account = token.split(".")[1];
  return { data: { user: { id: account, app_metadata: { erp_staff: account === "owner" || account === "another" } } } };
};
const db = { from(table) {
  assert.equal(table, "perfumes");
  return { select(fields) {
    assert.equal(fields, "is_archived");
    return { eq(column, id) {
      assert.equal(column, "id");
      return { maybeSingle: async () => ({ data: id === "26" || id === "27" ? { is_archived: id === "27" } : null }) };
    } };
  } };
} };

async function setup(t, runner, timeoutMs, publisher) {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(swagger, { openapi: {
    info: { title: "Fixture", version: "1" }, components: { securitySchemes: { erpBearer } },
  } });
  await app.register(async scope => {
    scope.decorateRequest("erpStaff", null);
    scope.addHook("onRequest", requireErpStaff(getUser));
    await scope.register(erpImageStudioRoutes, { db, runner, timeoutMs, publisher });
  }, { prefix: "/erp" });
  await app.ready();
  return app;
}

function submit(app, payload = png, values = {}) {
  return app.inject({ method: "POST", url: endpoint, headers, payload, ...values });
}
function read(app, jobId, suffix = "", authorization = headers.authorization) {
  return app.inject({ url: `${path}/jobs/${jobId}${suffix}`, headers: { authorization } });
}
async function awaitStatus(app, id, status) {
  for (let count = 0; count < 100; count++) {
    const response = (await read(app, id)).json();
    if (response.status === status) return response;
    await sleep(5);
  }
  assert.fail(`Job never reached ${status}`);
}

test("image studio routes are absent without an explicit runner", async t => {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(erpRoutes, { prefix: "/erp", db, getUser });
  const response = await submit(app);
  assert.equal(response.statusCode, 404);
});

test("documents binary media, error responses and bearer security for all four endpoints", async t => {
  const app = await setup(t, () => assert.fail("Image worker should not run"));
  const spec = app.swagger();
  const submission = spec.paths[`${path}/perfumes/{perfumeId}/jobs`].post;
  assert.deepEqual(Object.keys(submission.requestBody.content), ["application/octet-stream", "image/png", "image/jpeg", "image/webp"]);
  assert.equal(submission.requestBody.content["image/png"].schema.format, "binary");
  assert.deepEqual(submission.parameters.filter(param => param.in === "header").map(param => param.name),
    ["x-source-approved", "x-source-usage-permitted"]);
  const preview = spec.paths[`${path}/jobs/{jobId}/preview`].get;
  assert.equal(preview.responses["200"].content["image/webp"].schema.format, "binary");
  for (const operations of Object.values(spec.paths)) {
    for (const route of Object.values(operations)) {
      assert.deepEqual(route.security, [{ erpBearer: [] }]);
      assert.ok(route.responses["401"] && route.responses["403"]);
    }
  }
});

test("guards uploads and all reads, rejects bad inputs and archived perfumes", async t => {
  const app = await setup(t, () => assert.fail("Image worker should not run"));
  assert.equal((await submit(app, png, { headers: {} })).statusCode, 401);
  assert.equal((await submit(app, png, { headers: { ...headers, authorization: "Bearer signed.nonstaff.token" } })).statusCode, 403);
  assert.equal((await submit(app, png, { headers: { ...headers, "x-source-approved": "false" } })).statusCode, 400);
  assert.equal((await submit(app, png, { headers: { ...headers, "x-source-usage-permitted": "false" } })).statusCode, 400);
  assert.equal((await submit(app, Buffer.from("not an image"), { headers: { ...headers, "content-type": "image/jpeg" } })).statusCode, 415);
  assert.equal((await submit(app, Buffer.from("GIF89a"), { headers: { ...headers, "content-type": "image/gif" } })).statusCode, 415);
  assert.equal((await submit(app, Buffer.alloc(20 * 1024 * 1024 + 1))).statusCode, 413);
  assert.equal((await submit(app, png, { url: endpoint.replace("26", "27") })).json().code, "ERP_STUDIO_ARCHIVED");
  assert.equal((await submit(app, png, { url: endpoint.replace("26", "28") })).statusCode, 404);
  const id = "cfb2c77c-9497-4515-ae48-cd54c5791011";
  for (const suffix of ["", "/preview", "/validation"]) {
    assert.equal((await read(app, id, suffix, "")).statusCode, 401);
    assert.equal((await read(app, id, suffix, "Bearer signed.nonstaff.token")).statusCode, 403);
  }
});

test("deduplicates concurrent uploads, runs one job at a time and scopes candidate reads to the submitter", async t => {
  const candidate = Buffer.from("private fixture preview");
  const workers = [];
  const validation = {
    preset: "parfuma-master-v1", method: "existing-alpha", width: 900, height: 1200, format: "webp",
    bytes: 110800, aspectRatio: "3:4", opaque: true, clipped: false, quality: 100,
    sourceFormat: "PNG", sourceWidth: 900, sourceHeight: 1200, sourceSha256: "a".repeat(64), cutoutSha256: "b".repeat(64),
    candidateSha256: "c".repeat(64), preprocessingMs: 10, compositionMs: 200,
  };
  const app = await setup(t, async ({ dir, signal, setStatus }) => {
    setStatus("preprocessing");
    await new Promise((resolve, reject) => {
      workers.push(resolve);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    setStatus("composing");
    await writeFile(join(dir, "candidate.webp"), candidate);
    setStatus("validating");
    return validation;
  });
  const [first, duplicate, generic, text] = await Promise.all([
    submit(app),
    submit(app, png, { headers: { ...headers, "content-type": "image/jpeg" } }),
    submit(app, png, { headers: { ...headers, "content-type": "application/octet-stream" } }),
    submit(app, png, { headers: { ...headers, "content-type": "text/plain" } }),
  ]);
  assert.equal(first.statusCode, 202);
  for (const response of [duplicate, generic, text]) {
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().id, first.json().id);
  }
  const id = first.json().id;
  await awaitStatus(app, id, "preprocessing");
  const second = (await submit(app, Buffer.concat([png, Buffer.from([1])]))).json();
  assert.notEqual(second.id, id);
  assert.equal(second.status, "queued");
  assert.equal(workers.length, 1);
  assert.equal((await read(app, id, "/preview")).statusCode, 409);
  workers.shift()();
  await awaitStatus(app, id, "completed");
  await awaitStatus(app, second.id, "preprocessing");
  assert.equal((await submit(app)).json().id, id);
  for (const suffix of ["", "/preview", "/validation"]) {
    assert.equal((await read(app, id, suffix, "Bearer signed.another.token")).statusCode, 404);
  }
  const preview = await read(app, id, "/preview");
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.headers["content-type"], "image/webp");
  assert.equal(preview.headers["cache-control"], "no-store");
  assert.deepEqual(preview.rawPayload, candidate);
  assert.deepEqual((await read(app, id, "/validation")).json(), validation);
  workers.shift()();
  await awaitStatus(app, second.id, "completed");
});

test("timeouts and worker errors are structured and permit a new attempt", async t => {
  let attempts = 0;
  const app = await setup(t, ({ signal, setStatus }) => {
    setStatus("preprocessing");
    if (attempts++ === 0) return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    throw new Error("private implementation detail");
  }, 30);
  const first = (await submit(app)).json();
  assert.equal((await awaitStatus(app, first.id, "failed")).error.code, "ERP_STUDIO_TIMEOUT");
  const retry = (await submit(app)).json();
  assert.notEqual(retry.id, first.id);
  const failed = await awaitStatus(app, retry.id, "failed");
  assert.equal(failed.error.code, "ERP_STUDIO_WORKER_FAILED");
  assert.doesNotMatch(failed.error.message, /private/);
});

test("publication requires ownership, explicit approval and an unexpired completed candidate, and shares concurrent requests", async t => {
  const start = Date.now();
  let now = start;
  t.mock.method(Date, "now", () => now);
  let publishCount = 0;
  let finish;
  const response = {
    imageId: "6", perfumeId: "26", storageKey: "fixture/master.webp", imageUrl: "https://fixture.example/master.webp",
    candidateSha256: "f".repeat(64),
  };
  const app = await setup(t, async () => ({ fixture: true }), undefined, () => {
    publishCount++;
    return new Promise(resolve => { finish = () => resolve(response); });
  });
  const job = (await submit(app)).json();
  assert.equal(job.publicationEnabled, true);
  await awaitStatus(app, job.id, "completed");
  const inject = (authorization = headers.authorization, approval = "true") => app.inject({
    method: "POST", url: `${path}/jobs/${job.id}/publish`,
    headers: { authorization, "x-candidate-approved": approval },
  });
  assert.equal((await inject("")).statusCode, 401);
  assert.equal((await inject("Bearer signed.nonstaff.token")).statusCode, 403);
  assert.equal((await inject("Bearer signed.another.token")).statusCode, 404);
  assert.equal((await inject(headers.authorization, "false")).statusCode, 400);
  const spec = app.swagger().paths[`${path}/jobs/{jobId}/publish`].post;
  assert.deepEqual(spec.security, [{ erpBearer: [] }]);
  assert.ok(spec.parameters.some(parameter => parameter.name === "x-candidate-approved" && parameter.in === "header" && parameter.required));
  assert.deepEqual(Object.keys(spec.responses), ["200", "400", "401", "403", "404", "409", "422", "503"]);

  const first = inject();
  const second = inject();
  for (let i = 0; i < 50 && !finish; i++) await sleep(2);
  assert.equal(publishCount, 1);
  await sleep(20);
  finish();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), response);
  }
  assert.equal(publishCount, 1);
  now += 31 * 60 * 1000;
  assert.equal((await inject()).statusCode, 404);
});
