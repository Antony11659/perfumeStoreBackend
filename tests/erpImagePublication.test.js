import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImagePublisher } from "../src/modules/erp/erpImagePublication.js";
import { digest } from "../src/modules/erp/erpImageStudioRunner.js";

const input = Buffer.alloc(90000, 3);

async function fixture(t, { outcomes = ["ready", "published"], storageFails = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "erp-publication-fixture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "candidate.webp"), input);
  const job = { id: "75d44fb1-9825-4eea-98f3-43f9dc1d3572", owner: "c7ca3719-eff2-43e6-931f-4c5014d03082",
    dir, perfumeId: "229", sourceSha256: "d".repeat(64),
    validation: { bytes: input.length, candidateSha256: digest(input) } };
  const calls = [];
  const objects = new Map();
  const storage = {
    url: key => `https://fixture.example/bucket/${key}`,
    async putAndVerify(key, bytes, sha) {
      calls.push(["storage", key]);
      if (storageFails) throw new Error("fixture credential must not leak");
      assert.equal(digest(bytes), sha);
      if (!objects.has(key)) objects.set(key, Buffer.from(bytes));
      assert.deepEqual(objects.get(key), input);
    },
  };
  const publish = createImagePublisher({
    db: { rpc(name, args) {
      assert.equal(name, "erp_publish_master_v1");
      calls.push([args.p_commit ? "register" : "reserve", args]);
      return { abortSignal: async () => {
        const state = outcomes.shift();
        return state === "error" ? { error: true } : { data: { state, image_id: "6" } };
      } };
    } },
    storage,
    verifyBytes: async (bytes, sha) => {
      assert.deepEqual(bytes, input);
      assert.equal(digest(bytes), sha);
      calls.push(["decode"]);
    },
  });
  return { publish, job, calls, objects };
}

test("verifies bytes before reserving and registers exactly the validated object", async t => {
  const { publish, job, calls } = await fixture(t);
  const result = await publish(job);
  assert.equal(result.imageId, "6");
  assert.equal(result.storageKey, `perfume-library/perfumes/229/master-v1-${digest(input)}.webp`);
  assert.deepEqual(calls.map(([operation]) => operation), ["decode", "reserve", "storage", "register"]);
  assert.deepEqual(calls[3][1], { ...calls[1][1], p_commit: true });
  assert.equal(calls[3][1].p_staff_id, job.owner);
  assert.equal(calls[3][1].p_job_id, job.id);
});

test("rejects changed candidate bytes before any external operation", async t => {
  const { publish, job, calls } = await fixture(t);
  await writeFile(join(job.dir, "candidate.webp"), Buffer.alloc(input.length, 4));
  await assert.rejects(publish(job), { code: "ERP_STUDIO_CANDIDATE_INVALID" });
  assert.deepEqual(calls, []);
});

test("blocks archives, existing primary images, competing reservations and missing RPC before upload", async t => {
  for (const [state, code] of [
    ["archived", "ERP_STUDIO_ARCHIVED"], ["primary_exists", "ERP_STUDIO_PRIMARY_EXISTS"],
    ["publication_conflict", "ERP_STUDIO_PUBLICATION_CONFLICT"], ["error", "ERP_STUDIO_REGISTRATION_UNAVAILABLE"],
  ]) {
    const { publish, job, calls } = await fixture(t, { outcomes: [state] });
    await assert.rejects(publish(job), { code });
    assert.deepEqual(calls.map(([operation]) => operation), ["decode", "reserve"]);
  }
});

test("storage verification failure blocks registration", async t => {
  const { publish, job, calls } = await fixture(t, { storageFails: true });
  await assert.rejects(publish(job), { code: "ERP_STUDIO_STORAGE_UNAVAILABLE" });
  assert.deepEqual(calls.map(([operation]) => operation), ["decode", "reserve", "storage"]);
});

test("registration failure retains the exact object and retry reuses it and the resulting row", async t => {
  const { publish, job, calls, objects } = await fixture(t, { outcomes: ["ready", "error", "ready", "published", "published"] });
  await assert.rejects(publish(job), { code: "ERP_STUDIO_REGISTRATION_UNAVAILABLE" });
  assert.equal(objects.size, 1);
  const second = await publish(job);
  const replay = await publish(job);
  assert.deepEqual(replay, second);
  assert.equal(objects.size, 1);
  assert.equal(calls.filter(([operation]) => operation === "storage").length, 2);
  assert.equal(calls.filter(([operation]) => operation === "register").length, 2);
});
