import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import erpRoutes, { erpBearer } from "../src/modules/erp/erpRoutes.js";

const perfumeId = "9007199254740993";
const variantId = "9007199254740994";
const path = `/erp/perfumes/${perfumeId}/variants`;
const headers = { authorization: "Bearer fixture.staff.token" };

async function setup(t, rpc) {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(swagger, {
    openapi: { info: { title: "Fixture", version: "1" }, components: { securitySchemes: { erpBearer } } },
  });
  await app.register(erpRoutes, {
    prefix: "/erp", db: { rpc },
    getUser: async (token) => ({ data: { user: { id: "fixture", app_metadata: { erp_staff: token === "fixture.staff.token" } } } }),
  });
  return app;
}

test("three writes are documented and denied before DB access without staff authorization", async (t) => {
  const call = t.mock.fn();
  const app = await setup(t, call);
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const url = method === "POST" ? path : `${path}/${variantId}`;
    const template = "/erp/perfumes/{id}/variants" + (method === "POST" ? "" : "/{variantId}");
    assert.equal((await app.inject({ method, url })).statusCode, 401);
    assert.equal((await app.inject({ method, url, headers: { authorization: "Bearer fixture.other.token" } })).statusCode, 403);
    const operation = app.swagger().paths[template][method.toLowerCase()];
    assert.deepEqual(operation.security, [{ erpBearer: [] }]);
    assert.ok(operation.responses[409]);
  }
  assert.equal(call.mock.callCount(), 0);
});

test("wire payloads preserve decimal strings and the delete operation passes a null volume", async (t) => {
  const variant = { id: variantId, volume_ml: 10, updated_at: "2026-11-24T00:00:00Z" };
  const rpc = t.mock.fn(async () => ({ data: variant }));
  const app = await setup(t, rpc);
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const url = method === "POST" ? path : `${path}/${variantId}`;
    const response = await app.inject({ method, url, headers, ...(method !== "DELETE" && { payload: { volume_ml: 10 } }) });
    assert.equal(response.statusCode, method === "POST" ? 201 : 200);
    assert.equal(response.json().id, variantId);
  }
  assert.deepEqual(rpc.mock.calls.map(call => call.arguments), [
    ["erp_create_variant_v1", { p_perfume_id: perfumeId, p_volume_ml: 10 }],
    ["erp_change_variant_v1", { p_perfume_id: perfumeId, p_volume_ml: 10, p_variant_id: variantId }],
    ["erp_change_variant_v1", { p_perfume_id: perfumeId, p_volume_ml: null, p_variant_id: variantId }],
  ]);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { volume_ml: 0 } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { volume_ml: 3, id: "1" } })).statusCode, 400);
  assert.equal(rpc.mock.callCount(), 3);
});

test("conflict details contain only dependency flags and actions map DB failures safely", async (t) => {
  const errors = [
    { code: "P0001", details: JSON.stringify({ websiteOrders: true, marketplaceMappings: false, secret: "fixture" }) },
    { code: "23505" }, { code: "22023" }, { code: "P0002" }, { code: "40P01" },
  ];
  const app = await setup(t, async () => ({ error: errors.shift() }));
  const send = () => app.inject({ method: "PATCH", url: `${path}/${variantId}`, headers, payload: { volume_ml: 3 } });
  const conflict = await send();
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.json().dependencies, { websiteOrders: true, marketplaceMappings: false });
  assert.match(conflict.json().message, /historical website orders/);
  assert.ok(!conflict.body.includes("secret"));
  for (const status of [409, 400, 404, 409]) assert.equal((await send()).statusCode, status);
});
