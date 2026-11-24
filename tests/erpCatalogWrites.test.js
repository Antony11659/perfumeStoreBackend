import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import erpRoutes, { erpBearer } from "../src/modules/erp/erpRoutes.js";

const id = "aaaaaaaa-0000-4000-8000-000000000001";
const largeId = "9007199254740993";
const headers = { authorization: "Bearer mock.staff.token" };
const timestamp = "2026-11-24T12:00:00Z";

async function setup(t, rpc) {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(swagger, {
    openapi: { info: { title: "Fixture", version: "1" }, components: { securitySchemes: { erpBearer } } },
  });
  await app.register(erpRoutes, {
    prefix: "/erp", db: { rpc },
    getUser: async (token) => ({ data: { user: { id, app_metadata: { erp_staff: token === "mock.staff.token" } } } }),
  });
  return app;
}

test("authorizes and documents all four operations before DB access", async (t) => {
  const rpc = t.mock.fn();
  const app = await setup(t, rpc);
  for (const [method, resource, resourceId] of [
    ["POST", "perfumes"], ["PATCH", "perfumes", largeId], ["POST", "brands"], ["PATCH", "brands", id],
  ]) {
    const url = `/erp/${resource}${resourceId ? "/" + resourceId : ""}`;
    assert.equal((await app.inject({ url, method, payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ url, method, payload: {}, headers: { authorization: "Bearer mock.other.token" } })).statusCode, 403);
    assert.equal((await app.inject({ url, method, payload: {}, headers })).statusCode, 400);
    const route = `/erp/${resource}${resourceId ? "/{id}" : ""}`;
    const operation = app.swagger().paths[route][method.toLowerCase()];
    assert.deepEqual(operation.security, [{ erpBearer: [] }]);
    assert.ok(operation.responses[409]);
  }
  assert.equal(rpc.mock.callCount(), 0);
});

test("normalizes input and returns string IDs, and maps database conflicts", async (t) => {
  const rpc = t.mock.fn(async () => ({
    data: { id: largeId, name: "Test", brand_id: id, gender: "U", fragrance_family: null, created_at: timestamp, updated_at: timestamp },
  }));
  rpc.mock.mockImplementationOnce(async () => ({ error: { code: "23505", message: "private" } }), 1);
  rpc.mock.mockImplementationOnce(async () => ({ error: { code: "P0001", message: "private" } }), 2);
  rpc.mock.mockImplementationOnce(async () => ({ error: { code: "22023", message: "private" } }), 3);
  const app = await setup(t, rpc);
  const payload = { name: "  Test  ", brand_id: id, gender: "U", fragrance_family: " ", volumes: [3, 10] };
  const create = () => app.inject({ method: "POST", url: "/erp/perfumes", headers, payload });
  const created = await create();
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().id, largeId);
  assert.deepEqual(rpc.mock.calls[0].arguments, ["erp_create_perfume_v1", {
    p_name: "Test", p_brand_id: id, p_gender: "U", p_fragrance_family: null, p_volumes: [3, 10],
  }]);
  assert.equal((await create()).json().code, "ERP_CATALOG_DUPLICATE");
  const conflict = await app.inject({ method: "PATCH", url: `/erp/perfumes/${largeId}`, headers, payload: { name: "New" } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "ERP_CATALOG_DEPENDENCY");
  assert.ok(!conflict.body.includes("private"));
  assert.equal((await create()).statusCode, 400);
  const cleared = await app.inject({ method: "PATCH", url: `/erp/perfumes/${largeId}`, headers, payload: { gender: null } });
  assert.equal(cleared.statusCode, 200);
  assert.deepEqual(rpc.mock.calls[4].arguments[1].p_patch, { gender: null });
});
