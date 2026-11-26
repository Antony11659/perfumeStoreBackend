import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import { createClient } from "@supabase/supabase-js";
import erpRoutes, { erpBearer } from "../src/modules/erp/erpRoutes.js";

const brand = { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Fixture Brand", country: null };
const shop = { id: "bbbbbbbb-0000-4000-8000-000000000001", name: "Fixture Shop", code: "fixture", marketplace: "Ozon", is_active: true };
const otherShop = { ...shop, id: "bbbbbbbb-0000-4000-8000-000000000002", name: "Other Shop" };
const largeId = "9007199254740993";
const staff = { authorization: "Bearer test.staff.token" };

async function setup(t, fetch) {
  const db = createClient("https://db.example.test", "fixture", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch },
  });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(swagger, {
    openapi: { info: { title: "Fixture", version: "1" }, components: { securitySchemes: { erpBearer } } },
  });
  await app.register(erpRoutes, {
    prefix: "/erp", db,
    getUser: async (token) => ({ data: { user: { id: "fixture", app_metadata: { erp_staff: token === "test.staff.token" } } } }),
  });
  await app.ready();
  return app;
}

test("catalog routes are read-only, documented and guarded before database access", async (t) => {
  const fetch = t.mock.fn(() => { throw Error("Unexpected database access"); });
  const app = await setup(t, fetch);
  const paths = Object.entries(app.swagger().paths).filter(([path, operations]) => path !== "/erp/me" && !path.startsWith("/erp/marketplaces/") && !path.endsWith("/dependencies") && operations.get);
  assert.equal(paths.length, 10);
  const library = app.swagger().paths["/erp/image-library/perfumes"].get;
  assert.deepEqual(library.parameters.map(({ name }) => name).sort(), ["page", "pageSize", "q", "view"]);
  assert.deepEqual(Object.keys(library.responses), ["200", "400", "401", "403", "503"]);
  for (const [path, operations] of paths) {
    assert.ok(operations.get);
    assert.deepEqual(operations.get.security, [{ erpBearer: [] }]);
    const url = path.replace("{id}", largeId);
    assert.equal((await app.inject(url)).statusCode, 401);
    assert.equal((await app.inject({ url, headers: { authorization: "Bearer test.nonstaff.token" } })).statusCode, 403);
  }
  assert.equal((await app.inject({ url: "/erp/perfumes?pageSize=51", headers: staff })).statusCode, 400);
  assert.equal((await app.inject({ url: "/erp/perfumes?status=invalid", headers: staff })).statusCode, 400);
  assert.equal((await app.inject({ url: "/erp/perfumes/9223372036854775808", headers: staff })).statusCode, 400);
  assert.equal((await app.inject({ url: "/erp/image-library/perfumes?view=invalid", headers: staff })).statusCode, 400);
  assert.equal(fetch.mock.callCount(), 0);
});

test("list requests an exact parent count, stable range and independent child counts", async (t) => {
  const app = await setup(t, async (input, init) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/rest/v1/perfumes");
    if (init.method === "HEAD") {
      const count = url.searchParams.get("is_archived") === "eq.true" ? 4 : 26;
      return new Response(null, { headers: { "Content-Range": `*/${count}` } });
    }
    assert.equal(init.method, "GET");
    assert.equal(url.searchParams.get("is_archived"), "eq.false");
    assert.equal(init.headers.get("Prefer"), "count=exact");
    assert.equal(url.searchParams.get("offset"), "25");
    assert.equal(url.searchParams.get("limit"), "25");
    assert.equal(url.searchParams.get("order"), "name.asc,id.asc");
    assert.match(url.searchParams.get("select"), /id:id::text/);
    assert.equal(url.searchParams.get("master.image_type"), "eq.master");
    return Response.json([{
      id: largeId, name: "Fixture perfume", brand, gender: "U", is_archived: false, archived_at: null, variants: [{ count: 2 }],
      sku_counts: [{ shop_products: [{ count: 3 }] }, { shop_products: [{ count: 1 }] }], master: [],
    }], { status: 206, headers: { "Content-Range": "25-25/26" } });
  });
  const response = await app.inject({ url: "/erp/perfumes?page=2", headers: staff });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    items: [{
      id: largeId, name: "Fixture perfume", brand, gender: "U", is_archived: false, archived_at: null, variant_count: 2, sku_count: 4, primary_master_image: null,
    }], total: 26, page: 2, pageSize: 25, counts: { active: 26, archived: 4 },
  });
});

test("SKU ambiguity flags only active, unarchived records in the same shop and volume", async (t) => {
  const mappings = [
    ["0001", shop, 5, true, false], ["0002", shop, 5, true, false], ["0003", shop, 5, false, false],
    ["0004", shop, 5, true, true], ["0005", otherShop, 5, true, false], ["0006", shop, 10, true, false],
  ].map(([sku, shop, volume_ml, is_active, is_archived], index) => ({
    id: `cccccccc-0000-4000-8000-00000000000${index + 1}`, sku, shop, volume_ml, is_active, is_archived, updated_at: "2026-11-24T12:00:00Z",
  }));
  const app = await setup(t, async (input) => {
    assert.equal(new URL(input).searchParams.get("id"), "eq." + largeId);
    return Response.json([{ variants: [{ shop_products: mappings }] }]);
  });
  const response = await app.inject({ url: `/erp/perfumes/${largeId}/skus`, headers: staff });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().length, mappings.length);
  assert.deepEqual(response.json().filter(row => row.ambiguous).map(row => row.sku), ["0001", "0002"]);
});

test("image coverage counts parents with a primary master independently of master record count", async (t) => {
  for (const active of [10, 0]) {
    const app = await setup(t, async (input, init) => {
      const url = new URL(input);
      assert.equal(init.method, "HEAD");
      assert.equal(init.headers.get("Prefer"), "count=exact");
      let count;
      if (url.pathname.endsWith("/perfume_images")) {
        assert.equal(url.searchParams.get("image_type"), "eq.master");
        count = 5;
      } else if (url.searchParams.get("select") === "id,master:perfume_images!inner()") {
        assert.equal(url.searchParams.get("is_archived"), "eq.false");
        assert.equal(url.searchParams.get("master.image_type"), "eq.master");
        assert.equal(url.searchParams.get("master.is_primary"), "eq.true");
        count = active ? 2 : 0;
      } else {
        assert.equal(url.searchParams.get("select"), "id");
        count = url.searchParams.get("is_archived") === "eq.true" ? 3 : active;
      }
      return new Response(null, { headers: { "Content-Range": `*/${count}` } });
    });

    const response = await app.inject({ url: "/erp/image-library/stats", headers: staff });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      totalPerfumes: active + 3, activePerfumes: active, archivedPerfumes: 3, masterImageRecords: 5,
      activeWithPrimaryMaster: active ? 2 : 0, activeWithoutPrimaryMaster: active ? 8 : 0,
      activeCoveragePercent: active ? 20 : 0,
    });
  }
});

test("image library keeps the exact filtered total past the last page", async (t) => {
  const fetch = t.mock.fn(async (input, init) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/rest/v1/perfumes");
    assert.equal(url.searchParams.get("is_archived"), "eq.false");
    assert.equal(url.searchParams.get("master"), "not.is.null");
    assert.equal(url.searchParams.get("brand_search.name"), "imatch.Fixture");
    assert.equal(init.headers.get("Prefer"), "count=exact");
    if (init.method === "HEAD") {
      assert.equal(url.searchParams.has("offset"), false);
      return new Response(null, { headers: { "Content-Range": "*/5" } });
    }
    assert.equal(init.method, "GET");
    assert.equal(url.searchParams.get("offset"), "100");
    return Response.json({ code: "PGRST103", message: "Requested range not satisfiable" }, { status: 416 });
  });
  const app = await setup(t, fetch);
  const response = await app.inject({
    url: "/erp/image-library/perfumes?view=registered&q=Fixture&page=5", headers: staff,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { items: [], total: 5, page: 5, pageSize: 25 });
  assert.equal(fetch.mock.callCount(), 2);
});
