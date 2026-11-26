import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import { requireErpStaff } from "../src/modules/erp/erpAuth.js";
import { erpBearer } from "../src/modules/erp/erpRoutes.js";
import erpSkuRoutes from "../src/modules/erp/erpSkuRoutes.js";
import erpMatchingRoutes from "../src/modules/erp/erpMatchingRoutes.js";
import { compareProducts, fetchVisibleProducts, suggestMatch } from "../src/modules/erp/skuMatchingService.js";

const shop = { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Test shop", marketplace: "Ozon", code: "fixture", is_active: true };
const other = "aaaaaaaa-0000-4000-8000-000000000002";
const perfume = { id: "9007199254740993", name: "Imagination", brand: { name: "Louis Vuitton" }, variants: [{ volume_ml: 10 }] };
const stamp = "2026-11-24T12:00:00.123456Z";
const mappingId = "bbbbbbbb-0000-4000-8000-000000000001";
const staff = { authorization: "Bearer fixture.staff.token" };
const options = {
  post: async (path, body) => {
    if (path === "/v3/product/list") return { result: body.last_id
      ? { items: [{ product_id: 2, sku: "456" }], total: 2, last_id: "next" }
      : { items: [{ product_id: 1, sku: "123", offer_id: "offer-123" }], total: 2, last_id: "next" } };
    return { items: body.product_id.map(id => ({ id, name: "Louis Vuitton Imagination 10 мл", primary_image: ["https://cdn.example/fixture.jpg"] })) };
  },
};

test("paginates small pages, retrieves metadata and retries a bounded rate limit", async () => {
  const calls = [];
  const waits = [];
  const products = await fetchVisibleProducts({ post: async (...args) => {
    calls.push(args[0]);
    if (calls.length === 1) throw Error('Ozon API error for shop "fixture" 429: fixture');
    return options.post(...args);
  } }, async delay => waits.push(delay));
  assert.equal(calls.filter(path => path === "/v3/product/list").length, 3);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(products.map(row => row.sku), ["123", "456"]);
  assert.equal(products[0].offerId, "offer-123");
  assert.ok(products[0].imageUrl);
  await assert.rejects(fetchVisibleProducts({ post: async () => ({ result: { total: 3, items: [], last_id: "" } }) }), /ended before/);
});

test("distinguishes conflicts and requires a unique name and a compatible volume for complete suggestions", () => {
  const mappings = [
    ["a", shop.id, true, false, 3], ["b", other, true, false, 10],
    ["c", shop.id, false, false, 10], ["d", shop.id, true, true, 10],
    ["e", shop.id, true, false, 20], ["f", shop.id, true, false, 20],
  ].map(([sku, shop_id, is_active, is_archived, volume_ml]) => ({
    sku, shop_id, is_active, is_archived, volume_ml, perfume_id: perfume.id,
  }));
  const products = [..."abcdefghi"].map(sku => ({ sku, name: "Louis Vuitton Imagination 10 ml", catalogCollision: sku === "i" }));
  const { rows, stats } = compareProducts(shop.id, products, mappings, [perfume]);
  assert.deepEqual(rows.map(row => row.status), ["matched", "otherShop", "inactive", "archived", "ambiguous", "ambiguous", "unmatched", "unmatched", "catalogConflict"]);
  assert.deepEqual(stats, { total: 9, matched: 1, unmatched: 2, conflicts: 6, completion: 11.11 });
  assert.equal(rows[6].suggestion.volumeMl, 10);
  assert.equal(suggestMatch("Imagination 10 ml and 20 ml", [perfume]).volumeMl, null);
  assert.equal(suggestMatch("Imagination 10 ml", [perfume, { ...perfume, id: "2", brand: { name: "Other" } }]).perfumeId, null);
});

test("staff protects all routes and batch replay does not overwrite changed or cross-shop rows", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const mapped = [];
  const detached = [{ id: mappingId, sku: "789", shop_id: shop.id }];
  let archived = false;
  const calls = [];
  const db = {
    from: table => ({ select: () => {
      const query = {
        order: () => query,
        eq(column, value) {
          assert.equal(table, "perfumes");
          assert.equal(column, "is_archived");
          assert.equal(value, false);
          return query;
        },
        range: async () => ({ data: { shops: [shop], perfumes: archived ? [] : [perfume], shop_products: mapped, erp_unmatched_skus: detached }[table] }),
      };
      return query;
    } }),
    rpc: async (name, input) => {
      calls.push({ name, input });
      if (name !== "erp_create_sku_v1") return { error: { code: name.includes("delete") ? "P0001" : "40001" } };
      const existing = mapped.find(item => item.sku === input.p_sku);
      if (existing) {
        if (input.p_allow_replay && existing.shop_id === input.p_shop_id && existing.perfume_id === input.p_perfume_id
          && existing.volume_ml === input.p_volume_ml) return { data: { ...existing, replayed: true } };
        return { error: { code: "23505" } };
      }
      const data = { id: mappingId, sku: input.p_sku, shop_id: input.p_shop_id, perfume_id: input.p_perfume_id,
        volume_ml: input.p_volume_ml, is_active: true, is_archived: false, updated_at: stamp };
      mapped.push(data);
      const detachedIndex = detached.findIndex(row => row.sku === input.p_sku);
      if (detachedIndex >= 0) detached.splice(detachedIndex, 1);
      return { data };
    },
  };
  await app.register(swagger, { openapi: { info: { title: "Fixture", version: "1" }, components: { securitySchemes: { erpBearer } } } });
  await app.register(async router => {
    router.addHook("onRequest", requireErpStaff(async token => ({ data: { user: { id: "fixture", app_metadata: { erp_staff: token === "fixture.staff.token" } } } })));
    await router.register(erpSkuRoutes, { db });
    await router.register(erpMatchingRoutes, { db, ozonFactory: () => options });
  }, { prefix: "/erp" });
  const base = "/erp/marketplaces/shops";
  const batch = base + "/" + shop.id + "/mappings/batch";
  const skuPath = "/erp/perfumes/" + perfume.id + "/skus";
  const request = (method, url, payload) => app.inject({ method, url, headers: staff, payload });
  for (const [method, url] of [["POST",batch], ["GET",base], ["POST","/erp/marketplaces/sync"], ["GET",base+"/"+shop.id+"/matching"],
    ["POST",skuPath], ["PATCH",skuPath+"/"+mappingId], ["DELETE",skuPath+"/"+mappingId]]) {
    assert.equal((await app.inject({ method, url })).statusCode, 401);
    assert.equal((await app.inject({ method, url, headers: { authorization: "Bearer fixture.other.token" } })).statusCode, 403);
  }
  assert.equal(calls.length, 0);
  assert.equal((await request("GET",base)).json()[0].stats, null);
  const matching = base + "/" + shop.id + "/matching";
  const retained = await request("GET", matching + "?status=unmatched");
  assert.equal(retained.statusCode, 200);
  assert.deepEqual(retained.json().items.map(row => row.sku), ["789"]);
  const rematched = await request("POST", batch, { records: [{ sku: "789", perfume_id: perfume.id, volume_ml: 10 }] });
  assert.equal(rematched.json().results[0].status, "registered");
  assert.equal((await request("GET", matching + "?status=unmatched")).json().total, 0);
  mapped.length = 0;
  assert.equal((await request("POST","/erp/marketplaces/sync",{})).statusCode, 202);
  await new Promise(resolve => setImmediate(resolve));
  const matches = await request("GET",base+"/"+shop.id+"/matching?pageSize=1&status=unmatched");
  assert.equal(matches.statusCode, 200);
  assert.equal(matches.json().items.length, 1);
  assert.equal(matches.json().items[0].suggestion.volumeMl, 10);
  assert.equal(matches.json().total, 2);
  const records = [{ sku: "123", perfume_id: perfume.id, volume_ml: 10 }];
  assert.equal((await request("POST",batch,{records})).json().results[0].status, "registered");
  assert.equal((await request("POST",batch,{records})).json().results[0].status, "alreadyRegistered");
  assert.equal((await request("POST",batch,{records:[{ ...records[0], volume_ml: 3 }]})).json().results[0].status, "conflict");
  assert.equal((await request("POST",batch,{records:[{ ...records[0], sku: "999" }]})).json().results[0].code, "ERP_SKU_SCOPE");
  assert.equal((await request("POST",skuPath,{sku:123,shop_id:shop.id,volume_ml:10})).statusCode,400);
  assert.equal((await request("PATCH",skuPath+"/"+mappingId,{expected_updated_at:stamp,is_archived:true})).json().code,"ERP_SKU_STALE");
  assert.equal((await request("DELETE",skuPath+"/"+mappingId)).json().code,"ERP_SKU_DEPENDENCY");
  assert.equal(mapped.length, 1);
  archived = true;
  const afterArchive = (await request("GET", base + "/" + shop.id + "/matching")).json();
  assert.equal(afterArchive.items.find(item => item.sku === "123").status, "matched");
  assert.ok(afterArchive.items.filter(item => item.status === "unmatched").every(item => item.suggestion.perfumeId === null));
  assert.equal(app.swagger().paths["/erp/marketplaces/shops/{shopId}/mappings/batch"].post.security[0].erpBearer.length, 0);
});
