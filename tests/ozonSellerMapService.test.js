import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";

const originalFetch = globalThis.fetch;
const env = { ...process.env };
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const root = new URL("../src/modules/", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
let stored, saved, requests, mapResponse, sellerPoints, businessPoints, failure;
const jwt = (exp) => `e30.${Buffer.from(JSON.stringify({ sub: "seller", exp })).toString("base64url")}.signature`;
const freshToken = () => jwt(Math.floor(Date.now() / 1000) + 3600);
globalThis.ozonMapTestSupabase = {
  from() {
    return {
      select() { return { eq() { return { abortSignal() { return { maybeSingle: async () => ({ data: stored }) }; } }; } }; },
      upsert(value) { saved = value; return { select() { return { abortSignal() { return { single: async () => ({ data: value }) }; } }; } }; },
    };
  },
};
const oauthUrl = moduleUrl((await source("delivery/ozonSeller/ozonSellerOAuthService.js"))
  .replace('import { supabase } from "../../../lib/supabase.js";', 'const supabase = globalThis.ozonMapTestSupabase;'));
const businessUrl = new URL("delivery/ozon/ozonDeliveryService.js", root).href;
const mapUrl = moduleUrl((await source("delivery/ozonSeller/ozonSellerMapService.js"))
  .replace('"./ozonSellerOAuthService.js"', JSON.stringify(oauthUrl))
  .replace('"../ozon/ozonDeliveryService.js"', JSON.stringify(businessUrl)));
const { findOzonSellerDeliveryPointAtLocation: find } = await import(mapUrl);
const latitude = 55.64566, longitude = 37.390603;
const address = "Россия, Москва, улица Авиаторов, 1";
function seller(id = 2002344, lat = 55.645691, long = 37.390663, enabled = true) {
  return { enabled, delivery_method: { map_point_id: id, address, coordinates: { lat, long } } };
}
function business(id = 2002344, lat = 55.645691, lon = 37.390663) {
  return { delivery_point_id: id, is_active: true, type: "pvz", name: "Пункт Ozon", full_address: address,
    coordinates: { latitude: lat, longitude: lon }, storage_period_days: 14 };
}
function cluster(ids) { return { map_point_ids: ids, points_count: ids.length, viewport: null }; }
function reset() {
  Object.assign(process.env, { OZON_SELLER_LOGISTICS_SELLER_ID: "seller", OZON_SELLER_LOGISTICS_CLIENT_ID: "client",
    OZON_SELLER_LOGISTICS_CLIENT_SECRET: "secret", OZON_DELIVERY_CLIENT_ID: "business-client", OZON_DELIVERY_CLIENT_SECRET: "business-secret" });
  stored = { access_token: freshToken(), refresh_token: "refresh", expires_at: "2083-09-30T15:05:28.799Z" };
  saved = null; requests = []; failure = null;
  mapResponse = { clusters: [cluster([2002344])] };
  sellerPoints = [seller()]; businessPoints = [business()];
  globalThis.fetch = async (url, options) => {
    assert.ok(options.signal, "all OAuth, Seller, and Business requests carry a deadline");
    const body = JSON.parse(options.body);
    requests.push({ url, body, headers: options.headers });
    if (failure) { const result = await failure(url, body, options); if (result) return result; }
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: freshToken() });
    if (url.endsWith("/v1/delivery/map")) return Response.json(mapResponse);
    if (url.endsWith("/v1/delivery/point/info")) {
      assert.ok(body.map_point_ids.length <= 100);
      return Response.json({ points: sellerPoints.filter((p) => body.map_point_ids.includes(String(p.delivery_method.map_point_id))) });
    }
    if (url.endsWith("/v1/delivery-point/info")) return Response.json({ delivery_points: businessPoints });
    throw new Error("Unexpected request");
  };
}
await test("known point selected, physically confirmed through Business, response contract preserved", async () => {
  reset();
  assert.deepEqual(await find(latitude, longitude), { deliveryPointId: 2002344, name: "Пункт Ozon", address, type: "pvz",
    latitude: 55.645691, longitude: 37.390663, distanceMeters: 5, storagePeriodDays: 14 });
  assert.deepEqual(requests.at(-1).body, { delivery_point_ids: [2002344] });
  const viewport = requests[0].body.viewport;
  assert.ok(viewport.left_bottom.lat < latitude && viewport.right_top.lat > latitude);
});
await test("nearest enabled candidate selected regardless of API ordering, duplicate IDs removed", async () => {
  reset(); mapResponse.clusters = [cluster([2, 3, 2002344]), cluster([2002344])];
  sellerPoints = [seller(2, latitude + .001), seller(3, latitude, longitude, false), seller()];
  businessPoints = [business(2, latitude + .001), business()];
  assert.equal((await find(latitude, longitude)).deliveryPointId, 2002344);
  assert.equal(requests[1].body.map_point_ids.length, 3);
});
await test("nearest choice uses verified Business coordinates when APIs differ slightly", async () => {
  reset(); mapResponse.clusters = [cluster([1, 2])];
  sellerPoints = [seller(1, latitude + .0001, longitude), seller(2, latitude + .0002, longitude)];
  businessPoints = [business(1, latitude + .0003, longitude), business(2, latitude + .00005, longitude)];
  assert.equal((await find(latitude, longitude)).deliveryPointId, 2);
});
await test("empty clusters and no nearby/disabled points return null", async () => {
  for (const mode of ["empty", "disabled", "distant"]) {
    reset();
    if (mode === "empty") mapResponse.clusters = [];
    if (mode === "disabled") sellerPoints[0].enabled = false;
    if (mode === "distant") sellerPoints[0].delivery_method.coordinates.lat += .01;
    assert.equal(await find(latitude, longitude), null);
    assert.equal(requests.some((r) => r.url.endsWith("/v1/delivery-point/info")), false);
  }
});
await test("same-building multi-point cluster does not need expansion", async () => {
  reset(); mapResponse.clusters = [cluster([2002344, 2])]; sellerPoints.push(seller(2, latitude + .001));
  await find(latitude, longitude); assert.equal(requests.filter((r) => r.url.endsWith("/map")).length, 1);
});
await test("unresolved overlapping cluster expanded only as needed", async () => {
  reset(); let maps = 0;
  failure = (url, body) => {
    if (!url.endsWith("/map")) return;
    maps++;
    return Response.json(maps === 1 ? { clusters: [{ map_point_ids: [], points_count: 2, viewport: body.viewport }] } : mapResponse);
  };
  assert.equal((await find(latitude, longitude)).deliveryPointId, 2002344); assert.equal(maps, 2);
});
await test("unresolved distant cluster not expanded", async () => {
  reset(); mapResponse.clusters = [{ map_point_ids: [], points_count: 3,
    viewport: { left_bottom: { lat: 1, long: 1 }, right_top: { lat: 2, long: 2 } } }];
  assert.equal(await find(latitude, longitude), null); assert.equal(requests.length, 1);
});
await test("unresolvable nearby cluster errors rather than pretending no match", async () => {
  reset(); failure = (url, body) => url.endsWith("/map") ? Response.json({ clusters: [{ map_point_ids: [], points_count: 3, viewport: body.viewport }] }) : null;
  await assert.rejects(find(latitude, longitude), { statusCode: 502 });
  assert.equal(requests.length, 3);
});
await test("point info requests batched at 100 IDs", async () => {
  reset(); const ids = Array.from({ length: 101 }, (_, i) => i + 1); mapResponse.clusters = [cluster(ids)];
  sellerPoints = ids.map((id) => seller(id, 1, 1));
  assert.equal(await find(latitude, longitude), null);
  assert.deepEqual(requests.slice(1).map((r) => r.body.map_point_ids.length), [100, 1]);
});
await test("Business identity, activity, type, coordinates, and address must agree", async () => {
  for (const mutation of [p => p.delivery_point_id++, p => p.is_active = false, p => p.type = "postamat",
    p => p.coordinates.latitude += .001, p => p.full_address = "Different address", p => p.full_address = null]) {
    reset(); mutation(businessPoints[0]); assert.equal(await find(latitude, longitude), null);
  }
  reset(); businessPoints = []; assert.equal(await find(latitude, longitude), null);
});
await test("expired Seller JWT refreshes, preserves refresh token, uses new token", async () => {
  reset(); stored.access_token = jwt(1);
  assert.ok(await find(latitude, longitude)); assert.equal(saved.refresh_token, "refresh");
  assert.notEqual(saved.access_token, stored.access_token);
  assert.equal(requests[1].headers.Authorization, `Bearer ${saved.access_token}`);
  assert.ok(new Date(saved.expires_at).getTime() > Date.now());
});
await test("failed token refresh fails lookup safely", async () => {
  reset(); stored.access_token = jwt(1);
  failure = (url) => url.endsWith("/oauth/token") ? Response.json({ secret: "must-not-leak" }, { status: 401 }) : null;
  await assert.rejects(find(latitude, longitude), { statusCode: 502, message: "Ozon pickup point lookup failed" });
  assert.equal(requests.length, 1);
});
for (const status of [401, 403, 429, 500]) {
  await test(`Seller HTTP ${status} is an upstream error`, async () => {
    reset(); failure = () => Response.json({ token: "must-not-leak" }, { status });
    await assert.rejects(find(latitude, longitude), { statusCode: status === 429 ? 503 : 502 });
  });
}
await test("timeouts and network errors fail instead of returning no match", async () => {
  for (const [name, statusCode] of [["TimeoutError", 504], ["TypeError", 502]]) {
    reset(); failure = () => { throw Object.assign(new Error("must-not-leak"), { name }); };
    await assert.rejects(find(latitude, longitude), { statusCode });
  }
});
await test("invalid Seller and Business responses fail safely", async () => {
  for (const suffix of ["/map", "/delivery/point/info", "/delivery-point/info"]) {
    reset(); failure = (url) => url.endsWith(suffix) ? Response.json({ invalid: true }) : null;
    await assert.rejects(find(latitude, longitude), { statusCode: 502 });
  }
  reset(); failure = () => new Response("not JSON");
  await assert.rejects(find(latitude, longitude), { statusCode: 502 });
});
await test("Business HTTP failure is an upstream error with no raw body exposed", async () => {
  reset(); failure = (url) => url.endsWith("/delivery-point/info") ? Response.json({ token: "must-not-leak" }, { status: 500 }) : null;
  await assert.rejects(find(latitude, longitude), { statusCode: 502, message: "Ozon pickup point lookup failed" });
});
await test("coordinate and radius validation precede requests; radius configurable", async () => {
  reset();
  for (const coords of [[NaN, longitude], [91, longitude], [latitude, Infinity], [latitude, "37"]]) {
    await assert.rejects(find(...coords), { statusCode: 400 });
  }
  assert.equal(requests.length, 0);
  await assert.rejects(find(latitude, longitude, { radiusMeters: 1001 }), { statusCode: 500 });
  assert.equal(await find(latitude, longitude, { radiusMeters: 1 }), null);
});
await test("antimeridian and polar viewports remain valid and bounded", async () => {
  for (const [lat, lon, count] of [[0, 179.9999, 2], [0, -179.9999, 2], [90, 0, 1], [-90, 0, 1]]) {
    reset(); mapResponse.clusters = [];
    assert.equal(await find(lat, lon), null);
    assert.equal(requests.length, count);
    for (const request of requests) {
      const { left_bottom: left, right_top: right } = request.body.viewport;
      assert.ok(left.lat >= -90 && right.lat <= 90 && left.lat <= right.lat);
      assert.ok(left.long >= -180 && right.long <= 180 && left.long <= right.long);
    }
  }
});
await test("optional metadata stays null instead of being invented", async () => {
  reset(); delete businessPoints[0].name; delete businessPoints[0].storage_period_days;
  const point = await find(latitude, longitude);
  assert.equal(point.name, null); assert.equal(point.storagePeriodDays, null);
});
await test("website route uses new lookup and existing schema, including upstream errors", async () => {
  const routesSource = (await source("website/websiteDeliveryRoutes.js"))
    .replace('"./websiteDeliverySchemas.js"', JSON.stringify(new URL("website/websiteDeliverySchemas.js", root).href))
    .replace('"../delivery/dadata/dadataService.js"', JSON.stringify(new URL("delivery/dadata/dadataService.js", root).href))
    .replace('"../delivery/ozon/ozonDeliveryService.js"', JSON.stringify(businessUrl))
    .replace('"../delivery/ozonSeller/ozonSellerMapService.js"', JSON.stringify(mapUrl));
  const app = Fastify(); await app.register((await import(moduleUrl(routesSource))).default, { prefix: "/website/delivery" });
  try {
    reset();
    const request = () => app.inject({ method: "POST", url: "/website/delivery/verify-pvz", payload: { latitude, longitude } });
    const result = await request(); assert.equal(result.statusCode, 200);
    const body = result.json(); assert.equal(body.success, true); assert.equal(body.found, true); assert.equal(body.point.deliveryPointId, 2002344);
    assert.deepEqual(Object.keys(body.point).sort(), ["deliveryPointId", "name", "address", "type", "latitude", "longitude", "distanceMeters", "storagePeriodDays"].sort());
    reset(); mapResponse.clusters = []; assert.deepEqual((await request()).json(), { success: true, found: false, point: null });
    reset(); failure = () => Response.json({}, { status: 429 }); assert.equal((await request()).statusCode, 503);
    assert.equal((await app.inject({ method: "POST", url: "/website/delivery/verify-pvz", payload: { latitude: 91, longitude } })).statusCode, 400);
  } finally { await app.close(); }
});

globalThis.fetch = originalFetch;
process.env = env;
delete globalThis.ozonMapTestSupabase;
