import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import erpRoutes, { erpBearer } from "../src/modules/erp/erpRoutes.js";

const id = "9007199254740993";
const path = `/erp/perfumes/${id}`;
const staff = { authorization: "Bearer fixture.staff.token" };
const eligible = { variants: 2, skuMappings: 0, websiteOrderItems: 0, images: 0, unverifiedForeignKeys: 0, canDelete: true };

async function appFor(t, rpc) {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(swagger, { openapi: { info: { title: "Fixture", version: "1" }, components: { securitySchemes: { erpBearer } } } });
  await app.register(erpRoutes, { prefix: "/erp", db: { rpc }, getUser: async token => ({
    data: { user: { id: "fixture", app_metadata: { erp_staff: token === "fixture.staff.token" } } },
  }) });
  return app;
}

test("documents and protects both deletion routes before DB access", async t => {
  const rpc = t.mock.fn();
  const app = await appFor(t, rpc);
  for (const [method, suffix] of [["GET", "/dependencies"], ["DELETE", ""]]) {
    assert.equal((await app.inject({ method, url: path + suffix })).statusCode, 401);
    assert.equal((await app.inject({ method, url: path + suffix,
      headers: { authorization: "Bearer fixture.other.token" } })).statusCode, 403);
    assert.deepEqual(app.swagger().paths["/erp/perfumes/{id}" + suffix][method.toLowerCase()].security, [{ erpBearer: [] }]);
  }
  assert.equal((await app.inject({ method: "DELETE", url: path, headers: staff, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ url: "/erp/perfumes/9223372036854775808/dependencies", headers: staff })).statusCode, 400);
  assert.equal(rpc.mock.callCount(), 0);
});

test("DELETE can run without a preview and PostgreSQL remains authoritative after a preview", async t => {
  const rpc = t.mock.fn(async name => ({ data: name.endsWith("dependencies_v1") ? eligible : { id } }));
  const blocked = { ...eligible, images: 1, canDelete: false };
  rpc.mock.mockImplementationOnce(async () => ({ error: { code: "P0001",
    details: JSON.stringify({ ...blocked, private: "fixture sensitive field" }) } }), 2);
  rpc.mock.mockImplementationOnce(async () => ({ error: { code: "PT404" } }), 3);
  const app = await appFor(t, rpc);
  const deletePerfume = () => app.inject({ url: path, method: "DELETE", headers: staff });
  assert.deepEqual((await deletePerfume()).json(), { id });
  assert.deepEqual(rpc.mock.calls[0].arguments, ["erp_delete_perfume_v1", { p_perfume_id: id }]);
  assert.deepEqual((await app.inject({ url: path + "/dependencies", headers: staff })).json(), eligible);
  const conflict = await deletePerfume();
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.json().dependencies, blocked);
  assert.match(conflict.json().message, /registered images/);
  assert.ok(!conflict.body.includes("private"));
  assert.equal((await deletePerfume()).statusCode, 404);
});
