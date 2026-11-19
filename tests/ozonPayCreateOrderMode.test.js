import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";

const root = new URL("../src/modules/", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const order = { id: 123, order_number: "LDP-MODE", total: "10.00", status: "new" };
const reserved = { ...order, payment_state: "reserved" };
const providerId = "fixture-provider-private";
const payLink = "https://payment.example.invalid/fixture-private";
const fixtureKeys = {
  OZON_PAY_ACCESS_KEY: "fixture-access-private",
  OZON_PAY_SECRET_KEY: "fixture-secret-private",
  OZON_PAY_NOTIFICATION_SECRET_KEY: "fixture-notification-private",
};
const snapshot = { success: true, order: {
  id: order.id, orderNumber: order.order_number, status: "new", pricingMode: "website",
  subtotal: 10, deliveryPrice: 0, total: 10,
} };

const db = moduleUrl("export const supabase = globalThis.createOrderModeFixture.database;");
const delivery = moduleUrl("export function calculateWebsiteOzonDelivery() { throw Error('Unexpected delivery call'); }");
const provider = moduleUrl(`
  const process = { env: ${JSON.stringify(fixtureKeys)} };
  const fetch = (...args) => globalThis.createOrderModeFixture.fetch(...args);
  ${await source("payment/ozon/ozonPayService.js")}
`);
const token = moduleUrl(`
  const process = { env: { WEBSITE_PAYMENT_TOKEN_SECRET:
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" } };
  ${await source("website/websitePaymentAccessToken.js")}
`);
const capability = (await import(token)).issueWebsitePaymentAccessToken(order.id);
const { createOzonPayNotificationSign } = await import(provider);

globalThis.createOrderModeFixture = {
  database: {
    from: (...args) => globalThis.createOrderModeFixture.from(...args),
    rpc: (...args) => globalThis.createOrderModeFixture.rpc(...args),
  },
};

const service = moduleUrl(`
  const process = { get env() { return globalThis.createOrderModeFixture.env; } };
  ${(await source("website/websiteOrdersService.js"))
    .replace('"../../lib/supabase.js"', JSON.stringify(db))
    .replace('"./websiteDeliveryService.js"', JSON.stringify(delivery))
    .replace('"../payment/ozon/ozonPayService.js"', JSON.stringify(provider))}
`);

async function setup(t, { expectedMode, modeFields, enabled = true, alreadyPaid = false }) {
  const logs = [];
  const unexpected = [];
  const calls = [];
  const signatures = [];
  const app = Fastify({ logger: { stream: { write(line) { logs.push(line); } } } });
  t.after(() => app.close());
  t.after(() => assert.deepEqual(unexpected, []));
  let stored = { ...order, status: alreadyPaid ? "paid" : "new", payment_state: null };
  const api = globalThis.createOrderModeFixture;
  api.env = { OZON_PAY_EXPECTED_MODE: expectedMode };
  const guard = (check) => {
    try { check(); } catch (error) {
      unexpected.push(error.message);
      throw error;
    }
  };
  api.from = (table) => {
    guard(() => assert.equal(table, "website_orders"));
    return {
      select: () => ({
        eq: (column, value) => ({
          abortSignal: () => ({ maybeSingle: async () => read(column, value) }),
          maybeSingle: async () => read(column, value),
        }),
      }),
    };
  };
  function read(column, value) {
    calls.push("read");
    guard(() => {
      assert.ok(["id", "order_number"].includes(column));
      assert.equal(value, order[column]);
    });
    return { data: { ...stored }, error: null };
  }
  api.rpc = (name, args) => ({
    async abortSignal() {
      calls.push(name);
      if (name === "persist_website_order_v1") {
        guard(() => assert.equal(args.p_prepared, null));
        return { data: { outcome: "completed", response: snapshot }, error: null };
      }
      if (name === "reserve_website_order_payment_v1") {
        guard(() => assert.deepEqual(args, { p_order_id: order.id }));
        if (stored.payment_state !== null) return { data: [], error: null };
        stored = reserved;
        return { data: [reserved], error: null };
      }
      if (name === "save_website_order_payment_v1") {
        guard(() => assert.deepEqual(args, { p_order_id: order.id, p_ozon_payment_id: providerId, p_payment_link: payLink }));
        stored = { ...reserved, payment_state: "ready", ozon_payment_id: providerId, payment_link: payLink };
        return { data: [stored], error: null };
      }
      guard(() => assert.fail(`Unexpected RPC ${name}`));
    },
  });
  api.fetch = async (url, options) => {
    const request = JSON.parse(options.body);
    signatures.push(request.requestSign);
    if (url === "https://payapi.ozon.ru/v1/getOrderStatus") {
      calls.push("getOrderStatus");
      guard(() => assert.equal(request.id, providerId));
      return Response.json({
        id: providerId, extId: order.order_number, status: "STATUS_PAID", isTestMode: true,
        originalAmount: { currencyCode: "643", value: "1000" },
      });
    }
    calls.push("createOrder");
    guard(() => {
      assert.equal(url, "https://payapi.ozon.ru/v1/createOrder");
      assert.equal(options.method, "POST");
      assert.equal(request.extId, order.order_number);
      assert.equal(request.amount.value, "1000");
    });
    return Response.json({ order: { id: providerId, payLink, status: "STATUS_NEW", ...modeFields },
      privateField: "provider-response-private" });
  };

  const feature = moduleUrl(`
    const process = { env: { WEBSITE_OZON_PAY_ENABLED: ${JSON.stringify(enabled ? "true" : undefined)} } };
    ${await source("website/websitePaymentFeature.js")}
  `);
  const routes = async (file) => (await import(moduleUrl((await source(file))
    .replace('"./websitePaymentFeature.js"', JSON.stringify(feature))
    .replace('"./websitePaymentAccessToken.js"', JSON.stringify(token))
    .replace('"./websiteOrdersService.js"', JSON.stringify(service))
    .replace('"../payment/ozon/ozonPayService.js"', JSON.stringify(provider))
    .replace('"./websiteOrdersSchemas.js"', JSON.stringify(new URL("website/websiteOrdersSchemas.js", root).href))))).default;
  await app.register(await routes("website/websitePaymentRoutes.js"));
  await app.register(await routes("website/websiteOrdersRoutes.js"), { prefix: "/website" });
  const pay = () => app.inject({
    method: "POST", url: `/website/orders/${order.id}/payment`,
    headers: { "x-website-payment-token": capability },
  });
  const assertPrivate = (response) => {
    const output = [response.body, ...logs].join("\n");
    for (const value of [...Object.values(fixtureKeys), ...signatures, providerId, payLink, "provider-response-private"]) {
      assert.ok(!output.includes(value));
    }
  };
  return { app, pay, calls, stored: () => stored, assertPrivate };
}

const createCalls = ["read", "reserve_website_order_payment_v1", "createOrder"];

for (const [expectedMode, isTestMode] of [["production", false], ["test", true]]) {
  test(`matching ${expectedMode} mode preserves the save and success contract`, async (t) => {
    const f = await setup(t, { expectedMode, modeFields: { isTestMode } });
    const response = await f.pay();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { success: true, payment: {
      orderId: order.id, orderNumber: order.order_number, amount: 10, ozonPayOrderId: providerId,
      ozonPayStatus: "STATUS_NEW", payLink, isTestMode,
    } });
    assert.deepEqual(f.calls, [...createCalls, "save_website_order_payment_v1"]);
    assert.equal(f.stored().payment_state, "ready");
  });
}

for (const [expectedMode, fields, label] of [
  ["production", { isTestMode: true }, "test payment in production"],
  ["test", { isTestMode: false }, "live payment in test"],
  ["production", {}, "absent mode"],
  ["production", { isTestMode: null }, "null mode"],
  ["production", { isTestMode: "false" }, "string mode"],
  ["production", { isTestMode: 0 }, "numeric mode"],
]) {
  test(`${label} leaves the reservation intact and withholds private payment data`, async (t) => {
    const f = await setup(t, { expectedMode, modeFields: fields });
    const response = await f.pay();
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), { success: false, message: "Ozon Pay returned an unexpected payment environment" });
    f.assertPrivate(response);
    assert.deepEqual(f.calls, createCalls);
    assert.deepEqual(f.stored(), reserved);

    const retry = await f.pay();
    assert.equal(retry.statusCode, 409);
    assert.deepEqual(f.calls, [...createCalls, "read", "reserve_website_order_payment_v1"]);
    assert.deepEqual(f.stored(), reserved);
    f.assertPrivate(retry);
  });
}

for (const expectedMode of [undefined, "PRODUCTION", " production", "sandbox"]) {
  test(`invalid expected mode ${String(expectedMode)} returns 503 before reservation`, async (t) => {
    const f = await setup(t, { expectedMode });
    const response = await f.pay();
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { success: false, message: "Ozon Pay environment configuration is unavailable" });
    assert.deepEqual(f.calls, ["read"]);
    assert.equal(f.stored().payment_state, null);
    f.assertPrivate(response);
  });
}

test("already-paid order retains its rejection before the mode check or claim", async (t) => {
  const f = await setup(t, { alreadyPaid: true });
  const response = await f.pay();
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { success: false, message: "Website order is already paid" });
  assert.deepEqual(f.calls, ["read"]);
});

test("valid expected mode cannot bypass disabled payment initiation", async (t) => {
  const f = await setup(t, { enabled: false, expectedMode: "test" });
  assert.equal((await f.pay()).statusCode, 503);
  assert.deepEqual(f.calls, []);
});

test("flag off and unset expected mode preserve the Stage 2 replay response", async (t) => {
  const f = await setup(t, { enabled: false });
  const response = await f.app.inject({
    method: "POST", url: "/website/orders",
    headers: { "idempotency-key": "00000000-0000-4000-8000-000000000001" },
    payload: {
      customer: { name: "Fixture", phone: "+79991234567", city: "Moscow", address: "Fixture" },
      delivery: { provider: "ozon", deliveryPointId: "123" }, items: [{ variantId: 1, quantity: 1 }],
    },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), snapshot);
  assert.deepEqual(f.calls, ["persist_website_order_v1"]);
});

test("test-mode creation cannot settle through the signed webhook or status recovery", async (t) => {
  const f = await setup(t, { expectedMode: "test", modeFields: { isTestMode: true } });
  assert.equal((await f.pay()).statusCode, 200);
  const payload = {
    orderID: providerId, extOrderID: order.order_number, amount: 1000,
    currencyCode: "643", transactionUID: "fixture-transaction",
  };
  payload.requestSign = createOzonPayNotificationSign(payload);
  const webhook = await f.app.inject({ method: "POST", url: "/website/payments/ozon/notification", payload });
  assert.equal(webhook.statusCode, 503);
  assert.deepEqual(webhook.json(), { success: false });
  const status = await f.app.inject({
    method: "GET", url: `/website/orders/${order.id}/payment-status`,
    headers: { "x-website-payment-token": capability },
  });
  assert.equal(status.statusCode, 503);
  assert.deepEqual(f.calls, [...createCalls, "save_website_order_payment_v1", "read", "getOrderStatus", "read", "getOrderStatus"]);
  assert.equal(f.stored().payment_state, "ready");
  assert.equal(f.stored().status, "new");
  f.assertPrivate(webhook);
  f.assertPrivate(status);
});
