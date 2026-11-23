import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";

const phone = "+79990000000";
const clientId = "fixture-client-id";
const secret = "fixture-client-secret";
const token = "fixture-access-token";
const privateMessage = "fixture-private-provider-error";
const routePath = "/website/delivery/check-client";

process.env.SUPABASE_URL = "https://fixture.invalid";
process.env.SUPABASE_SECRET_KEY = "fixture-supabase-key";
process.env.OZON_DELIVERY_CLIENT_ID = clientId;
process.env.OZON_DELIVERY_CLIENT_SECRET = secret;

const { default: routes } = await import("../src/modules/website/websiteDeliveryRoutes.js");
const { checkOzonDeliveryClient } = await import("../src/modules/delivery/ozon/ozonDeliveryService.js");

test("check-client timing preserves responses and records only correlated phase metadata", async (t) => {
  const logs = [];
  const app = Fastify({
    logger: {
      stream: new Writable({
        write(chunk, encoding, done) {
          logs.push(JSON.parse(chunk.toString()));
          done();
        },
      }),
    },
  });
  t.after(() => app.close());
  await app.register(swagger, { openapi: { openapi: "3.0.3" } });
  await app.register(routes, { prefix: "/website/delivery" });
  await app.ready();

  const operation = app.swagger().paths[routePath].post;
  const requestSchema = operation.requestBody.content["application/json"].schema;
  assert.deepEqual(requestSchema.required, ["phone"]);
  assert.equal(requestSchema.properties.phone.type, "string");
  assert.deepEqual(Object.keys(operation.responses), ["200", "400", "500"]);
  const responseSchema = (status) => operation.responses[status].content["application/json"].schema;
  assert.deepEqual(responseSchema(200).properties, {
    success: { type: "boolean" },
    canBeDelivered: { type: "boolean" },
  });
  for (const status of [400, 500]) {
    assert.deepEqual(responseSchema(status).properties, {
      success: { type: "boolean" },
      message: { type: "string" },
    });
  }

  const failure = { success: false, message: "Failed to check Ozon Delivery customer" };
  const cases = [
    { name: "eligible", eligible: true, clientStatus: 200, phases: [["access-token", 200, "success"], ["eligibility", 200, "success"]] },
    { name: "ineligible", eligible: false, clientStatus: 200, phases: [["access-token", 200, "success"], ["eligibility", 200, "success"]] },
    { name: "OAuth rejected", oauthStatus: 403, clientStatus: 500, phases: [["access-token", 403, "failure"]] },
    { name: "OAuth body read failed", oauthReadFails: true, clientStatus: 500, phases: [["access-token", 200, "failure"]] },
    { name: "Ozon eligibility rejected", ozonStatus: 503, clientStatus: 500, phases: [["access-token", 200, "success"], ["eligibility", 503, "failure"]] },
    { name: "Ozon eligibility body read failed", ozonReadFails: true, clientStatus: 500, phases: [["access-token", 200, "success"], ["eligibility", 200, "failure"]] },
    { name: "Ozon transport failed", ozonFetchFails: true, clientStatus: 500, phases: [["access-token", 200, "success"], ["eligibility", undefined, "failure"]] },
    { name: "invalid phone", invalidPhone: true, clientStatus: 400, phases: [] },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async (t) => {
      const start = logs.length;
      const timingLogs = () => logs.slice(start).filter((entry) => entry.msg === "Ozon check-client timing");
      const calls = [];
      let bodyRead = false;
      t.mock.method(globalThis, "fetch", async (url, options) => {
        const path = new URL(url).pathname;
        calls.push(path);
        if (path === "/oauth/token") {
          assert.equal(JSON.parse(options.body).client_secret, secret);
          return {
            status: fixture.oauthStatus ?? 200,
            ok: !fixture.oauthStatus,
            async text() { return privateMessage; },
            async json() {
              assert.equal(timingLogs().length, 0);
              if (fixture.oauthReadFails) throw new Error(privateMessage);
              return { access_token: token };
            },
          };
        }
        assert.equal(path, "/v1/delivery/check-client");
        assert.equal(options.headers.Authorization, `Bearer ${token}`);
        assert.equal(JSON.parse(options.body).phone_number, phone);
        assert.deepEqual(timingLogs().map((entry) => entry.phase), ["access-token"]);
        if (fixture.ozonFetchFails) throw new Error(privateMessage);
        return {
          status: fixture.ozonStatus ?? 200,
          ok: !fixture.ozonStatus,
          async json() {
            assert.deepEqual(timingLogs().map((entry) => entry.phase), ["access-token"]);
            bodyRead = true;
            if (fixture.ozonReadFails) throw new Error(privateMessage);
            return { can_be_delivered: fixture.eligible, privateMessage, phone, token };
          },
        };
      });

      const reply = await app.inject({
        method: "POST", url: routePath,
        payload: { phone: fixture.invalidPhone ? "invalid" : phone },
      });
      assert.equal(reply.statusCode, fixture.clientStatus);
      assert.deepEqual(reply.json(), fixture.clientStatus === 200
        ? { success: true, canBeDelivered: fixture.eligible }
        : fixture.invalidPhone ? { success: false, message: "Invalid phone number" } : failure);

      const expectedPaths = fixture.invalidPhone ? [] : ["/oauth/token"];
      if (fixture.phases.length === 2) expectedPaths.push("/v1/delivery/check-client");
      assert.deepEqual(calls, expectedPaths);
      assert.equal(bodyRead, fixture.phases.length === 2 && !fixture.ozonFetchFails);
      const requestId = logs.slice(start).find((entry) => entry.msg === "incoming request").reqId;
      assert.ok(requestId);
      assert.deepEqual(timingLogs().map((entry) => [entry.phase, entry.httpStatus, entry.outcome]), fixture.phases);
      for (const entry of timingLogs()) {
        assert.equal(entry.reqId, requestId);
        assert.ok(Number.isFinite(entry.durationMs) && entry.durationMs >= 0);
        const { level, time, pid, hostname, reqId, msg, ...fields } = entry;
        const allowed = ["durationMs", "outcome", "phase"];
        if (entry.httpStatus !== undefined) allowed.push("httpStatus");
        assert.deepEqual(Object.keys(fields).sort(), allowed.sort());
      }
      const serialized = JSON.stringify(logs.slice(start));
      for (const sensitive of [phone, clientId, secret, token, privateMessage, "Authorization"]) {
        assert.ok(!serialized.includes(sensitive), "request logs must exclude sensitive fixture data");
      }
    });
  }

  await t.test("service callers without a timing callback retain the original result", async (t) => {
    const start = logs.length;
    t.mock.method(globalThis, "fetch", async (url) => new Response(JSON.stringify(
      new URL(url).pathname === "/oauth/token" ? { access_token: token } : { can_be_delivered: true }
    )));
    assert.deepEqual(await checkOzonDeliveryClient(phone), { canBeDelivered: true });
    assert.equal(logs.length, start);
  });
});
