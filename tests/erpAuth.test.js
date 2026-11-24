import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import erpRoutes, { erpBearer } from "../src/modules/erp/erpRoutes.js";

async function setup(t, getUser) {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(swagger, {
    openapi: { info: { title: "Fixture", version: "1" }, components: { securitySchemes: { erpBearer } } },
  });
  await app.register(erpRoutes, { prefix: "/erp", getUser });
  app.get("/health", async () => ({ status: "ok" }));
  await app.ready();
  return app;
}

const token = "fixture.payload.signature";
const requestMe = (app, authorization = `Bearer ${token}`) =>
  app.inject({ url: "/erp/me", headers: { authorization } });

test("verifies staff through Auth and returns only the account projection", async (t) => {
  const app = await setup(t, async (received) => {
    assert.equal(received, token);
    return { data: { user: {
      id: "staff-id", email: "staff@example.test", app_metadata: { erp_staff: true, extra: "private" },
    } } };
  });
  const response = await requestMe(app, `bearer ${token}`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json(), { id: "staff-id", email: "staff@example.test", erpStaff: true });
  const schema = app.swagger();
  assert.deepEqual(schema.components.securitySchemes.erpBearer, erpBearer);
  assert.deepEqual(schema.paths["/erp/me"].get.security, [{ erpBearer: [] }]);
  assert.deepEqual(Object.keys(schema.paths["/erp/me"].get.responses), ["200", "401", "403", "503"]);
  assert.equal((await app.inject("/health")).statusCode, 200);
});

test("rejects missing or malformed Authorization without calling Auth", async (t) => {
  const getUser = t.mock.fn();
  const app = await setup(t, getUser);
  const missing = await app.inject("/erp/me");
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.headers["www-authenticate"], "Bearer");
  assert.equal((await requestMe(app, "Basic abc")).statusCode, 401);
  assert.equal((await requestMe(app, "Bearer invalid")).statusCode, 401);
  assert.equal(getUser.mock.callCount(), 0);
});

for (const [name, error] of [
  ["invalid token", { status: 403, code: "bad_jwt" }],
  ["expired token", { status: 401, code: "bad_jwt" }],
  ["missing session", { status: 400, name: "AuthSessionMissingError" }],
]) {
  test(`rejects ${name} with 401`, async (t) => {
    const app = await setup(t, async () => ({ error }));
    assert.equal((await requestMe(app)).statusCode, 401);
  });
}

for (const [name, user] of [
  ["non-staff", { app_metadata: {} }],
  ["user-editable staff flag", { user_metadata: { erp_staff: true } }],
  ["non-boolean staff flag", { app_metadata: { erp_staff: "true" } }],
]) {
  test(`rejects ${name} with 403`, async (t) => {
    const app = await setup(t, async () => ({ data: { user: { id: "user-id", ...user } } }));
    assert.equal((await requestMe(app)).statusCode, 403);
  });
}

test("fails closed for Auth errors and unexpected responses without leaking details", async (t) => {
  const getUser = t.mock.fn(async () => ({ error: { status: 500, message: token } }));
  getUser.mock.mockImplementationOnce(async () => { throw Error(token); }, 1);
  getUser.mock.mockImplementationOnce(async () => ({ data: null }), 2);
  const app = await setup(t, getUser);
  for (let index = 0; index < 3; index++) {
    const response = await requestMe(app);
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "ERP_AUTH_UNAVAILABLE");
    assert.ok(!response.body.includes(token));
  }
});
