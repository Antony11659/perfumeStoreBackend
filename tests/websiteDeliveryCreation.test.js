import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";

const modules = new URL("../src/modules/", import.meta.url);
const source = (path) => readFile(new URL(path, modules), "utf8");
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const business = moduleUrl(`
  const process = { env: { OZON_DELIVERY_CLIENT_ID: "fixture-id", OZON_DELIVERY_CLIENT_SECRET: "fixture-secret" } };
  ${await source("delivery/ozon/ozonDeliveryService.js")}
`);
const serviceSource = (await source("website/websiteDeliveryCreationService.js"))
  .replace('import { supabase } from "../../lib/supabase.js";',
    'const supabase = new Proxy({}, { get: (_, key) => globalThis.shipmentFixture[key] });')
  .replace('"../delivery/ozon/ozonDeliveryService.js"', JSON.stringify(business));
const routeSource = await source("website/websiteDeliveryCreationRoutes.js");
function route(enabled, approvedVariants) {
  const service = moduleUrl(`
    const process = { env: { OZON_WEBSITE_STANDARD_PARCEL_VARIANT_IDS: ${JSON.stringify(approvedVariants)} } };
    ${serviceSource}
  `);
  return import(moduleUrl(`
    const process = { env: { WEBSITE_OZON_DELIVERY_CREATION_ENABLED: ${JSON.stringify(enabled)},
      WEBSITE_OZON_DELIVERY_ADMIN_KEY: "fixture-operator-key" } };
    ${routeSource.replace('"./websiteDeliveryCreationService.js"', JSON.stringify(service))}
  `));
}

const expectedDimensions = { weight_g: 60, length_mm: 100, width_mm: 50, height_mm: 20 };

await test("website delivery calculation uses the standard parcel for availability and checkout", async (t) => {
  const checkout = moduleUrl((await source("website/websiteDeliveryService.js"))
    .replace('"../delivery/ozon/ozonDeliveryService.js"', JSON.stringify(business)));
  const { calculateWebsiteOzonDelivery } = await import(checkout);
  const { OZON_DEFAULT_PARCEL_DIMENSIONS, OZON_STANDARD_PARCEL_DESCRIPTION } = await import(business);
  assert.deepEqual(OZON_DEFAULT_PARCEL_DIMENSIONS, expectedDimensions);
  assert.equal(OZON_STANDARD_PARCEL_DESCRIPTION, "Perfume");
  const paths = [];
  const cutoff = "2099-01-01T00:00:00Z";
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "https://xapi.ozon.ru/oauth/token") return Response.json({ access_token: "fixture-bearer" });
    assert.equal(new URL(url).origin, "https://api-delivery.ozon.ru");
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === "/v1/delivery/check-client") return Response.json({ can_be_delivered: true });
    if (path === "/v1/delivery-point/info") {
      return Response.json({ delivery_points: [{ is_active: true, name: "Fixture pickup point" }] });
    }
    assert.deepEqual(JSON.parse(options.body).postings[0].dimensions, expectedDimensions);
    if (path === "/v1/delivery-point/check-availability") return Response.json({ results: [{}] });
    assert.equal(path, "/v1/order/checkout");
    return Response.json({ results: [{ posting: {
      estimated_delivery_cost: { amount: "123.45" },
      estimated_insurance_cost: { amount: "2.00" },
      estimated_delivery_days: 2,
      cutoff_at: cutoff,
    } }] });
  });
  const quote = await calculateWebsiteOzonDelivery({
    phone: "+79990000000", deliveryPointId: "12345", declaredValue: 150.20,
  });
  assert.deepEqual(paths, [
    "/v1/delivery/check-client", "/v1/delivery-point/info",
    "/v1/delivery-point/check-availability", "/v1/order/checkout",
  ]);
  assert.equal(quote.deliveryPointId, "12345");
  assert.equal(quote.deliveryCost, 123.45);
  assert.equal(quote.insuranceCost, 2);
  assert.equal(quote.customerDeliveryPrice, 0);
  assert.equal(quote.cutoffAt, cutoff);
});

function success(payload) {
  return Response.json({
    order_number: "ozon-order",
    order_external_id: payload.order_external_id,
    postings: [{
      request_id: 1, posting_number: "ozon-posting",
      posting_external_id: payload.postings[0].posting_external_id,
      estimated_delivery_days: 2, cutoff_at: payload.postings[0].cutoff_at,
    }],
  });
}

async function setup(t, {
  enabled = "true", orderFields = {}, deliveryFields = {}, onCheckout, onCreate, rejectSave, rejectClaim,
  approvedVariants = "42", items = [{ variant_id: "42", quantity: 1, unit_price: "150.20", line_total: "150.20" }],
} = {}) {
  const order = {
    id: 11, order_number: "LDP-SYNTHETIC", status: "paid", payment_state: "confirmed",
    customer_name: "Synthetic recipient", phone: "+7 (999) 000-00-00", subtotal: "150.20",
    ...orderFields,
  };
  const saved = {
    provider: "ozon", delivery_type: "pvz", delivery_point_id: "12345",
    cutoff_at: new Date(Date.now() + 3600000).toISOString(), status: "calculated",
    parcel: null,
    external_order_number: null, external_posting_number: null, creation_state: null,
    ...deliveryFields,
  };
  const calls = [];
  const claimKeys = [];
  const creates = [];
  const checked = [];
  globalThis.shipmentFixture = {
    from(table) {
      return {
        select() {
          return { eq(column, id) {
            assert.equal(id, order.id);
            assert.equal(column, table === "website_orders" ? "id" : "order_id");
            return { abortSignal() {
              if (table === "website_order_items") {
                return Promise.resolve({ data: items, error: null });
              }
              assert.ok(["website_orders", "website_order_deliveries"].includes(table));
              return { async maybeSingle() { return { data: { ...(table === "website_orders" ? order : saved) }, error: null }; } };
            } };
          } };
        },
        update(fields) {
          assert.equal(table, "website_order_deliveries");
          const filters = {};
          const query = {
            eq(name, value) { filters[name] = value; return query; },
            select() { return query; },
            abortSignal() { return query; },
            async maybeSingle() {
              assert.deepEqual(filters, { order_id: order.id, creation_key: saved.creation_key, creation_state: "creating" });
              if (rejectSave) return { data: null, error: { code: "fixture-write-failed" } };
              Object.assign(saved, fields);
              return { data: { creation_key: saved.creation_key }, error: null };
            },
          };
          return query;
        },
      };
    },
    rpc(name, args) {
      assert.equal(name, "claim_website_delivery_creation_v1");
      assert.equal(args.p_order_id, order.id);
      return { async abortSignal() {
        calls.push("claim");
        if (rejectClaim) return { data: null, error: { code: "fixture-claim-missing" } };
        const previous = saved.creation_state;
        if (args.p_retry ? !["unknown", "retryable"].includes(previous) : previous !== null) {
          return { data: [], error: null };
        }
        if (args.p_retry) {
          assert.equal(args.p_key, saved.creation_key);
          assert.equal(args.p_body, saved.creation_body);
        } else {
          const { dimensions, description } = JSON.parse(args.p_body).postings[0];
          saved.parcel = { ...dimensions, description };
        }
        claimKeys.push(args.p_key);
        Object.assign(saved, { creation_state: "creating", creation_key: args.p_key, creation_body: args.p_body });
        return { data: [{ creation_key: saved.creation_key, creation_body: saved.creation_body, previous_state: previous }], error: null };
      } };
    },
  };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const path = new URL(url).pathname;
    assert.ok(options.signal instanceof AbortSignal);
    const payload = JSON.parse(options.body);
    if (url === "https://xapi.ozon.ru/oauth/token") return Response.json({ access_token: "fixture-bearer" });
    assert.equal(new URL(url).origin, "https://api-delivery.ozon.ru");
    assert.equal(options.headers.Authorization, "Bearer fixture-bearer");
    if (path === "/v1/order/checkout") {
      assert.equal(saved.creation_state, "creating");
      assert.deepEqual(saved.parcel, { ...expectedDimensions, description: "Perfume" });
      calls.push("checkout");
      checked.push(payload);
      return onCheckout?.() ?? Response.json({ results: [{ request_id: 1, posting: {} }] });
    }
    assert.equal(path, "/v1/order/create");
    calls.push("create");
    creates.push({ url, body: options.body, headers: options.headers });
    return onCreate ? onCreate(payload, creates.length) : success(payload);
  });
  const app = Fastify();
  t.after(async () => { await app.close(); delete globalThis.shipmentFixture; });
  await app.register(swagger, { openapi: { info: { title: "Fixture", version: "1" } } });
  await app.register((await route(enabled, approvedVariants)).default);
  await app.ready();
  const request = (body = {}, key = "fixture-operator-key", orderId = "11") => app.inject({
    method: "POST", url: `/website/orders/${orderId}/delivery/create`,
    headers: { "x-website-delivery-admin-key": key }, payload: body,
  });
  return { app, request, saved, creates, checked, calls, claimKeys, order };
}

await test("manual creation claims, checks matching checkout inputs, and saves linked Ozon references", async (t) => {
  const f = await setup(t);
  assert.equal(f.saved.parcel, null);
  const response = await f.request();
  assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(response.json(), { success: true, orderNumber: "ozon-order", postingNumber: "ozon-posting" });
  assert.deepEqual(f.calls, ["claim", "checkout", "create"]);
  const { body, headers } = f.creates[0];
  assert.match(headers["Idempotency-Key"], /^[0-9a-f-]{36}$/);
  assert.equal(headers["Idempotency-Key"], f.saved.creation_key);
  assert.equal(body, f.saved.creation_body);
  const payload = JSON.parse(body);
  const { posting_external_id, description, ...posting } = payload.postings[0];
  assert.equal(posting_external_id, "LDP-SYNTHETIC-1");
  assert.equal(description, "Perfume");
  assert.deepEqual(posting.dimensions, expectedDimensions);
  assert.deepEqual(f.saved.parcel, { ...expectedDimensions, description });
  assert.equal(payload.recipient.full_name, f.order.customer_name);
  assert.deepEqual(payload.delivery, { delivery_point: { delivery_point_id: 12345 } });
  assert.deepEqual(posting.declared_value, { amount: "150.20", currency_code: "RUB" });
  assert.equal(posting.shipment_method_id, (await import(business)).OZON_WEBSITE_SHIPMENT_METHOD_ID);
  assert.deepEqual(f.checked, [{
    recipient: { phone_number: "+79990000000" }, delivery: payload.delivery, postings: [posting],
  }]);
  assert.equal(f.saved.creation_state, "created");
  assert.equal(f.saved.external_order_number, "ozon-order");
  assert.equal(f.saved.external_posting_number, "ozon-posting");
  assert.equal((await f.request()).statusCode, 409);
  assert.equal(f.creates.length, 1);
  const docs = f.app.swagger().paths["/website/orders/{orderId}/delivery/create"].post;
  assert.ok(docs.parameters.some(({ name, required }) => name === "x-website-delivery-admin-key" && required));
  assert.ok(docs.requestBody && docs.responses[201] && docs.responses[409] && docs.responses[502]);
  assert.match(docs.responses[422].description, /standard parcel fit/);
});

for (const cutoff of [
  "2099-01-01T12:00:00.123Z",
  "2099-01-01T12:00:00.123456Z",
  "2099-01-01T12:00:00Z",
  "2099-01-01T15:00:00.123456+03:00",
]) {
  await test(`preserves cutoff ${cutoff} through claim, checkout, and create`, async (t) => {
    const f = await setup(t, { deliveryFields: { cutoff_at: cutoff } });
    const response = await f.request();
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(JSON.parse(f.saved.creation_body).postings[0].cutoff_at, cutoff);
    assert.equal(f.checked[0].postings[0].cutoff_at, cutoff);
    assert.equal(JSON.parse(f.creates[0].body).postings[0].cutoff_at, cutoff);
  });
}

for (const [label, options] of [
  ["unpaid order", { orderFields: { status: "new" } }],
  ["unconfirmed payment", { orderFields: { payment_state: "ready" } }],
  ["missing pickup point", { deliveryFields: { delivery_point_id: null } }],
  ["missing variant approval configuration", { approvedVariants: "" }],
  ["unknown parcel fit", { approvedVariants: "43" }],
  ["multiple units", { items: [{ variant_id: "42", quantity: 2, unit_price: "75.10", line_total: "150.20" }] }],
  ["missing order items", { items: [] }],
  ["expired cutoff", { deliveryFields: { cutoff_at: "2020-01-01T00:00:00Z" } }],
  ["invalid subtotal", { orderFields: { subtotal: "150.21" } }],
]) {
  await test(`blocks ${label} before claim and Ozon`, async (t) => {
    const f = await setup(t, options);
    assert.equal((await f.request()).statusCode, 422);
    assert.deepEqual(f.calls, []);
    assert.equal(f.saved.parcel, null);
  });
}

await test("activation and operator authentication fail closed", async (t) => {
  const f = await setup(t, { enabled: "TRUE" });
  assert.equal((await f.request()).statusCode, 503);
  assert.deepEqual(f.calls, []);
});

await test("rejects invalid operator authorization and invalid IDs before claim", async (t) => {
  const f = await setup(t);
  assert.equal((await f.request({}, "wrong")).statusCode, 401);
  assert.equal((await f.request({}, "fixture-operator-key", "9007199254740993")).statusCode, 400);
  assert.deepEqual(f.calls, []);
});

await test("concurrent creation allows only one provider mutation", async (t) => {
  const f = await setup(t);
  const results = await Promise.all([f.request(), f.request()]);
  assert.deepEqual(results.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal(f.creates.length, 1);
  assert.equal(f.claimKeys.length, 1);
});

await test("timeout preserves an unknown outcome and an explicit retry uses byte-identical body and UUID", async (t) => {
  const cutoff = "2099-01-01T15:00:00.123456+03:00";
  const f = await setup(t, { deliveryFields: { cutoff_at: cutoff }, onCreate(payload, count) {
    if (count === 1) throw new DOMException("Mock deadline", "TimeoutError");
    return success(payload);
  } });
  const first = await f.request();
  assert.equal(first.statusCode, 502);
  assert.equal(first.json().code, "CREATE_OUTCOME_UNKNOWN");
  assert.equal(f.saved.creation_state, "unknown");
  const originalParcel = f.saved.parcel;
  assert.equal((await f.request()).statusCode, 409);
  assert.equal(f.creates.length, 1);
  assert.equal((await f.request({ retry: true })).statusCode, 201);
  assert.deepEqual(f.creates[1], f.creates[0]);
  assert.equal(JSON.parse(f.creates[1].body).postings[0].cutoff_at, cutoff);
  assert.equal(f.saved.parcel, originalParcel);
  assert.deepEqual(f.claimKeys, [f.saved.creation_key, f.saved.creation_key]);
});

await test("an unexpected create response leaves durable unknown state", async (t) => {
  const f = await setup(t, { onCreate: () => Response.json({ order_number: "unlinked" }) });
  assert.equal((await f.request()).statusCode, 502);
  assert.equal(f.saved.creation_state, "unknown");
  assert.equal(f.saved.external_order_number, null);
});

await test("checkout rejection persists a retryable attempt without creating an Ozon order", async (t) => {
  const f = await setup(t, { onCheckout: () => Response.json({ results: [{ error: { code: "fixture" } }] }) });
  assert.equal((await f.request()).statusCode, 422);
  assert.equal(f.saved.creation_state, "retryable");
  assert.equal(f.creates.length, 0);
});

await test("failed outcome persistence leaves the claim in place and withholds provider references", async (t) => {
  const f = await setup(t, { rejectSave: true });
  const response = await f.request();
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "SHIPMENT_OUTCOME_UNCONFIRMED");
  assert.equal(f.saved.creation_state, "creating");
  assert.equal((await f.request({ retry: true })).statusCode, 409);
  assert.equal(f.creates.length, 1);
});

await test("unavailable claim RPC blocks every provider request", async (t) => {
  const f = await setup(t, { rejectClaim: true });
  assert.equal((await f.request()).statusCode, 503);
  assert.deepEqual(f.calls, ["claim"]);
  assert.equal(f.saved.creation_state, null);
  assert.equal(f.saved.parcel, null);
});

await test("same-origin testcookie replay preserves the serialized request and idempotency key", async (t) => {
  const f = await setup(t, { onCreate(payload, count) {
    if (count === 1) return new Response(null, {
      status: 307, headers: { location: "/v1/order/create?challenge=1", "set-cookie": "testcookie=fixture; Secure" },
    });
    return success(payload);
  } });
  assert.equal((await f.request()).statusCode, 201);
  assert.equal(f.creates.length, 2);
  assert.equal(f.creates[1].body, f.creates[0].body);
  assert.equal(f.creates[1].headers["Idempotency-Key"], f.creates[0].headers["Idempotency-Key"]);
  assert.equal(f.creates[1].headers.Cookie, "testcookie=fixture");
});

for (const [label, location, cookie] of [
  ["cross-origin redirect", "https://untrusted.example/v1/order/create", "testcookie=fixture"],
  ["redirect without a testcookie challenge", "/v1/order/create", "other-cookie=fixture"],
]) {
  await test(`blocks ${label} without replaying the mutation`, async (t) => {
    const f = await setup(t, { onCreate: () => new Response(null, {
      status: 307, headers: { location, "set-cookie": cookie },
    }) });
    assert.equal((await f.request()).statusCode, 502);
    assert.equal(f.saved.creation_state, "unknown");
    assert.equal(f.creates.length, 1);
  });
}
