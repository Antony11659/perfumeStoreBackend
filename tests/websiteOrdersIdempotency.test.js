import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import cors from "@fastify/cors";

// Replace imports before loading production modules: never load dotenv, real
// Supabase or payment clients. Unexpected network access fails immediately.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("External network access forbidden in order tests"); };
const moduleUrl = (text) => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const root = new URL("../src/modules/", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
let state;
const clone = (value) => structuredClone(value);
function reset() {
  state = {
    requests: new Map(), rpcCalls: [], reads: [], ozon: [], orders: [], payments: 0,
    variants: [{ id: 1, perfume_id: 10, volume_ml: 5 }, { id: 2, perfume_id: 11, volume_ml: 10 }],
    prices: [{ volume_ml: 5, website_price: 100, discount_price: 80 }, { volume_ml: 10, website_price: 200, discount_price: 160 }],
    promo: { id: 1, code: "SALE", is_active: true },
  };
  globalThis.websiteOrdersTestState = state;
}
reset();

globalThis.websiteOrdersTestSupabase = {
  from(table) {
    assert.ok(["perfume_variants", "prices", "promo_codes"].includes(table), `Unexpected table/write: ${table}`);
    state.reads.push(table);
    return {
      select() {
        if (table === "promo_codes") {
          const filters = [];
          return {
            eq(column, value) { filters.push([column, value]); return this; },
            async maybeSingle() {
              assert.deepEqual(filters, [["code", "SALE"], ["is_active", true]]);
              return { data: state.promo, error: state.readError };
            },
          };
        }
        return { async in(column, values) {
          return {
            data: (table === "perfume_variants" ? state.variants : state.prices)
              .filter((row) => values.includes(row[column])),
            error: state.readError,
          };
        } };
      },
    };
  },
  rpc(name, args) {
    assert.equal(name, "persist_website_order_v1");
    state.rpcCalls.push(clone(args));
    return { async abortSignal(signal) {
      assert.ok(signal instanceof AbortSignal);
      if (state.rpcFailure) return state.rpcFailure(args);
      return mockPersist(args);
    } };
  },
};

async function mockPersist(args) {
  const { p_key, p_hash, p_prepared } = args;
  assert.match(p_key, /^[0-9a-f-]{36}$/);
  assert.match(p_hash, /^[0-9a-f]{64}$/);
  let record = state.requests.get(p_key);
  if (!record) {
    record = { hash: p_hash };
    state.requests.set(p_key, record);
  }
  if (record.hash !== p_hash) return { data: { outcome: "conflict" } };
  if (record.response) return { data: { outcome: "completed", response: clone(record.response) } };
  if (!p_prepared) return { data: { outcome: "ready" } };
  if (record.locked) return { data: { outcome: "in_progress" } };
  record.locked = true;
  if (state.finalizeGate) {
    state.finalizeStarted();
    await state.finalizeGate;
  }
  const o = p_prepared.order;
  const response = { success: true, order: {
    id: state.orders.length + 1, orderNumber: o.order_number, pricingMode: o.pricing_mode,
    subtotal: o.subtotal, deliveryPrice: o.delivery_price, total: o.total, status: "new",
  } };
  state.orders.push(clone(p_prepared));
  record.response = clone(response);
  record.locked = false;
  return { data: { outcome: "created", response } };
}

const ozonUrl = moduleUrl(`
  const record = (name, args) => {
    const s = globalThis.websiteOrdersTestState;
    s.ozon.push({ name, args });
    if (s.ozonError) throw s.ozonError;
  };
  export async function checkOzonDeliveryClient(phone) {
    record('client', phone); return { canBeDelivered: true };
  }
  export async function getOzonDeliveryPointInfo(ids) {
    record('point', ids); return [{ is_active: true, name: 'Trusted PVZ', full_address: 'Trusted address' }];
  }
  export async function checkOzonDeliveryPointAvailability(args) {
    record('availability', args); return { available: true };
  }
  export async function checkoutOzonDelivery(args) {
    record('checkout', args); return { available: true, estimatedDeliveryDays: 3, deliveryCost: 125, insuranceCost: 2 };
  }
`);
const deliveryUrl = moduleUrl((await source("website/websiteDeliveryService.js"))
  .replace('"../delivery/ozon/ozonDeliveryService.js"', JSON.stringify(ozonUrl)));
const paymentUrl = moduleUrl(`export async function createOzonPayOrder() {
  globalThis.websiteOrdersTestState.payments++;
  throw new Error('Payments forbidden in order creation tests');
}`);
const serviceUrl = moduleUrl((await source("website/websiteOrdersService.js"))
  .replace('import { supabase } from "../../lib/supabase.js";', 'const supabase = globalThis.websiteOrdersTestSupabase;')
  .replace('"./websiteDeliveryService.js"', JSON.stringify(deliveryUrl))
  .replace('"../payment/ozon/ozonPayService.js"', JSON.stringify(paymentUrl)));
const routesUrl = moduleUrl((await source("website/websiteOrdersRoutes.js"))
  .replace('"./websiteOrdersSchemas.js"', JSON.stringify(new URL("website/websiteOrdersSchemas.js", root).href))
  .replace('"./websiteOrdersService.js"', JSON.stringify(serviceUrl)));
const routes = (await import(routesUrl)).default;
const logs = [];
const app = Fastify({ logger: { stream: { write(line) { logs.push(line); } } } });
await app.register(cors, { origin: true, methods: ["GET", "POST", "OPTIONS"] });
await app.register(routes);
await app.register(routes, { prefix: "/website" });
await app.ready();

function payload() {
  return {
    customer: { name: "Customer", phone: "+79991234567", city: "City", address: "Submitted address" },
    delivery: { provider: "ozon", deliveryPointId: "2002344" },
    items: [{ variantId: 1, quantity: 2 }, { variantId: 2, quantity: 1 }],
  };
}
function request(body = payload(), key = randomUUID(), url = "/website/orders") {
  return app.inject({ method: "POST", url, payload: clone(body), headers: key === undefined ? {} : { "Idempotency-Key": key } });
}

await test("initial order uses trusted data and RPC only, with existing 201 response", async () => {
  reset();
  const p = payload();
  p.total = 1; p.customer.customer_name = "Untrusted";
  p.items[0].unit_price = 1; p.delivery.delivery_cost = 1;
  const result = await request(p);
  assert.equal(result.statusCode, 201);
  assert.deepEqual(result.json(), { success: true, order: {
    id: 1, orderNumber: state.orders[0].order.order_number, pricingMode: "website",
    subtotal: 400, deliveryPrice: 0, total: 400, status: "new",
  } });
  assert.match(result.json().order.orderNumber, /^LDP-\d+-[0-9A-F]{8}$/);
  assert.equal(state.rpcCalls.length, 2);
  assert.equal(state.rpcCalls[0].p_prepared, null);
  assert.equal(state.orders[0].order.address, "Trusted address");
  assert.equal(state.orders[0].items[0].unit_price, 100);
  assert.equal(state.orders[0].delivery.delivery_cost, 125);
  assert.equal(state.orders[0].delivery.external_order_number, null);
  assert.equal(state.orders[0].delivery.status, "calculated");
  assert.deepEqual(state.ozon.map((x) => x.name), ["client", "point", "availability", "checkout"]);
  assert.equal(state.ozon[3].args.declaredValue, 400);
  assert.equal(state.payments, 0);
});

await test("completed retry across both aliases returns original response without validation", async () => {
  for (const [first, second] of [["/orders", "/website/orders"], ["/website/orders", "/orders"]]) {
    reset(); const key = randomUUID();
    const result = await request(payload(), key, first);
    const reads = state.reads.length, ozon = state.ozon.length;
    state.prices = []; state.variants = []; state.promo = null;
    state.ozonError = new Error("Must not revalidate");
    const again = await request(payload(), key.toUpperCase(), second);
    assert.equal(again.statusCode, 201);
    assert.deepEqual(again.json(), result.json());
    assert.equal(state.reads.length, reads);
    assert.equal(state.ozon.length, ozon);
    assert.equal(state.orders.length, 1);
  }
});

await test("normalized equivalent payloads hash identically, retaining duplicate lines", async () => {
  reset(); const key = randomUUID(); const p = payload();
  p.promoCode = " sale ";
  p.items.push({ variantId: 1, quantity: 2 });
  const result = await request(p, key);
  assert.equal(result.statusCode, 201);
  assert.equal(state.orders[0].items.length, 3);
  assert.equal(state.orders[0].order.subtotal, 480);
  const reordered = payload();
  reordered.customer.name = " Customer ";
  reordered.customer.comment = " "; reordered.customer.messenger = null;
  reordered.delivery.deliveryPointId = "02002344";
  reordered.promoCode = "SALE";
  reordered.items = [{ quantity: "1", variantId: "2" }, { quantity: 2, variantId: 1 }, { variantId: 1, quantity: 2 }];
  const again = await request(reordered, key);
  assert.equal(again.statusCode, 201);
  assert.deepEqual(again.json(), result.json());
  assert.equal(state.rpcCalls[0].p_hash, state.rpcCalls.at(-1).p_hash);
  reordered.items = [{ variantId: 1, quantity: 4 }, { variantId: 2, quantity: 1 }];
  assert.equal((await request(reordered, key)).statusCode, 409);
});

await test("each meaningful payload change conflicts without further reads or Ozon calls", async () => {
  const mutations = [
    (p) => { p.customer.name = "Changed"; }, (p) => { p.customer.phone = "+7 9991234567"; },
    (p) => { p.customer.city = "Changed"; }, (p) => { p.customer.address = "Changed"; },
    (p) => { p.customer.comment = "Changed"; }, (p) => { p.customer.messenger = "Changed"; },
    (p) => { p.delivery.deliveryPointId = "3"; }, (p) => { p.promoCode = "SALE"; },
    (p) => { p.items[0].quantity = 3; }, (p) => { p.items[0].variantId = 3; },
  ];
  for (const mutate of mutations) {
    reset(); const key = randomUUID(); await request(payload(), key);
    const reads = state.reads.length, ozon = state.ozon.length;
    const changed = payload(); mutate(changed);
    const r = await request(changed, key);
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, "IDEMPOTENCY_KEY_CONFLICT");
    assert.equal(r.headers["retry-after"], undefined);
    assert.equal(state.reads.length, reads); assert.equal(state.ozon.length, ozon);
    assert.equal(state.orders.length, 1);
  }
});

await test("concurrent finalization reports in progress, then replays a single completed order", async () => {
  reset(); const key = randomUUID(); let release;
  state.finalizeGate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { state.finalizeStarted = resolve; });
  const first = request(payload(), key);
  try {
    await started;
    const other = await request(payload(), key, "/orders");
    assert.equal(other.statusCode, 409);
    assert.equal(other.json().code, "ORDER_IN_PROGRESS");
    assert.equal(other.headers["retry-after"], "2");
  } finally { release(); }
  const result = await first;
  assert.equal(result.statusCode, 201);
  const retry = await request(payload(), key);
  assert.deepEqual(retry.json(), result.json());
  assert.equal(state.orders.length, 1);
});

await test("persistence errors and malformed results return retryable 503 without fallback", async () => {
  for (const phase of ["reserve", "finalize"]) {
    for (const failure of [
      () => ({ error: { code: "55P03", message: "private upstream error" } }),
      () => { throw Object.assign(new Error("private upstream error"), { name: "TimeoutError" }); },
      () => ({ data: null }),
      () => ({ data: { outcome: "unexpected" } }),
      () => ({ data: { outcome: "completed", response: {} } }),
    ]) {
      reset(); const key = randomUUID();
      state.rpcFailure = (args) => (phase === "reserve" || args.p_prepared) ? failure() : mockPersist(args);
      const r = await request(payload(), key);
      assert.equal(r.statusCode, 503);
      assert.equal(r.json().code, "ORDER_PERSISTENCE_UNAVAILABLE");
      assert.equal(r.headers["retry-after"], "2");
      assert.ok(!r.body.includes("private upstream error"));
      assert.equal(state.orders.length, 0);
      state.rpcFailure = null;
      assert.equal((await request(payload(), key)).statusCode, 201);
      assert.equal(state.orders.length, 1);
    }
  }
});

await test("lost reservation and finalization responses recover with the same key", async () => {
  for (const phase of ["reserve", "finalize"]) {
    reset(); const key = randomUUID();
    state.rpcFailure = async (args) => {
      const result = await mockPersist(args);
      if ((phase === "reserve" && !args.p_prepared) || (phase === "finalize" && args.p_prepared)) {
        throw new Error("Response lost after persistence");
      }
      return result;
    };
    assert.equal((await request(payload(), key)).statusCode, 503);
    const original = clone(state.requests.get(key).response);
    const reads = state.reads.length;
    state.rpcFailure = null;
    const retry = await request(payload(), key);
    assert.equal(retry.statusCode, 201);
    if (phase === "finalize") {
      assert.deepEqual(retry.json(), original);
      assert.equal(state.reads.length, reads);
    }
    assert.equal(state.orders.length, 1);
  }
});

await test("missing headers remain compatible; invalid and duplicate keys are rejected", async () => {
  reset();
  for (const bad of ["", "not-a-uuid", "00000000-0000-0000-0000-000000000000", `${randomUUID()}, ${randomUUID()}`, [randomUUID(), randomUUID()]]) {
    const r = await request(payload(), bad);
    assert.equal(r.statusCode, 400);
  }
  assert.equal(state.rpcCalls.length, 0);
  for (let i = 0; i < 2; i++) {
    const r = await app.inject({ method: "POST", url: "/orders", payload: payload() });
    assert.equal(r.statusCode, 201);
  }
  assert.equal(state.orders.length, 2);
  assert.notEqual(state.rpcCalls[0].p_key, state.rpcCalls[2].p_key);
});

await test("body validation and invalid PVZ fail before reservation", async () => {
  reset();
  for (const mutate of [
    (p) => { delete p.customer; }, (p) => { p.items = []; },
    (p) => { p.items[0].quantity = 0; }, (p) => { p.delivery.provider = "other"; },
    (p) => { p.delivery.deliveryPointId = "invalid"; },
  ]) {
    const p = payload(); mutate(p);
    assert.equal((await request(p)).statusCode, 400);
  }
  assert.equal(state.rpcCalls.length, 0);
});

await test("variant, pricing, promo and Ozon failures preserve validation and leave reservation retryable", async () => {
  for (const kind of ["variant", "price", "promo", "ozon"]) {
    reset(); const key = randomUUID(), p = payload();
    if (kind === "variant") state.variants = [];
    if (kind === "price") state.prices = [];
    if (kind === "promo") { p.promoCode = "SALE"; state.promo = null; }
    if (kind === "ozon") state.ozonError = Object.assign(new Error("Ozon unavailable"), { statusCode: 400 });
    const r = await request(p, key);
    assert.equal(r.statusCode, 400);
    assert.equal(state.orders.length, 0);
    assert.equal(state.rpcCalls.length, 1);
    assert.ok(state.requests.has(key));
    state.variants = [{ id: 1, volume_ml: 5 }, { id: 2, volume_ml: 10 }];
    state.prices = [{ volume_ml: 5, website_price: 100, discount_price: 80 }, { volume_ml: 10, website_price: 200, discount_price: 160 }];
    state.promo = { id: 1 }; state.ozonError = null;
    assert.equal((await request(p, key)).statusCode, 201);
  }
});

await test("failure logs exclude upstream error text, customer values and idempotency keys", async () => {
  reset(); const key = randomUUID(), start = logs.length, p = payload();
  state.rpcFailure = () => { throw new Error(`SECRET ${p.customer.phone} ${key}`); };
  assert.equal((await request(p, key)).statusCode, 503);
  const output = logs.slice(start).join("");
  for (const secret of ["SECRET", p.customer.phone, p.customer.name, key]) assert.ok(!output.includes(secret));
  assert.ok(output.includes("Website order request failed"));
});

await test("CORS preflight accepts Idempotency-Key", async () => {
  const r = await app.inject({ method: "OPTIONS", url: "/website/orders", headers: {
    origin: "https://store.example", "access-control-request-method": "POST",
    "access-control-request-headers": "content-type,idempotency-key",
  } });
  assert.equal(r.statusCode, 204);
  assert.match(r.headers["access-control-allow-headers"], /idempotency-key/i);
});

await app.close();
globalThis.fetch = originalFetch;
delete globalThis.websiteOrdersTestSupabase;
delete globalThis.websiteOrdersTestState;
