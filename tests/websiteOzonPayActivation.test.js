import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";

const root = new URL("../src/modules/", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const fixtureSecret = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const key = "00000000-0000-4000-8000-000000000001";
const order = Object.freeze({
  id: 123, orderNumber: "LDP-GATE", pricingMode: "website", subtotal: 1100,
  deliveryPrice: 100, total: 1200, status: "new",
});
const stage2 = Object.freeze({ success: true, order });
const payload = {
  customer: { name: "Fixture", phone: "+79991234567", city: "Moscow", address: "Fixture street" },
  delivery: { provider: "ozon", deliveryPointId: "123" },
  items: [{ variantId: 1, quantity: 1 }],
};
const payment = {
  orderId: order.id, orderNumber: order.orderNumber, amount: order.total,
  ozonPayOrderId: "fixture-payment", ozonPayStatus: "STATUS_NEW",
  payLink: "https://payment.example.invalid/fixture", isTestMode: true,
};
const path = `/website/orders/${order.id}`;
const aliases = ["/orders", "/website/orders"];

const tokenCode = await source("website/websitePaymentAccessToken.js");
const featureCode = await source("website/websitePaymentFeature.js");
const ordersCode = await source("website/websiteOrdersRoutes.js");
const paymentCode = await source("website/websitePaymentRoutes.js");
const providerUrl = moduleUrl(`
  const process = { env: {
    OZON_PAY_ACCESS_KEY: "fixture", OZON_PAY_SECRET_KEY: "fixture",
    OZON_PAY_NOTIFICATION_SECRET_KEY: "fixture-notification-secret",
  } };
  const fetch = () => { throw Error("External network access forbidden"); };
  ${await source("payment/ozon/ozonPayService.js")}
`);
const { createOzonPayNotificationSign } = await import(providerUrl);
const previousToken = (await import(moduleUrl(`
  const process = { env: { WEBSITE_PAYMENT_TOKEN_SECRET: ${JSON.stringify(fixtureSecret)} } };
  ${tokenCode}
`))).issueWebsitePaymentAccessToken(order.id);

const serviceUrl = moduleUrl(`
  export const createWebsiteOrder = (...args) => globalThis.websiteActivationFixture.checkout(...args);
  export const createWebsiteOrderPayment = (...args) => globalThis.websiteActivationFixture.payment(...args);
  export const getWebsiteOrderPaymentStatus = (...args) => globalThis.websiteActivationFixture.status(...args);
  export const markWebsiteOrderPaidFromOzon = (...args) => globalThis.websiteActivationFixture.webhook(...args);
`);

async function setup(t, { flag, secret } = {}) {
  const env = { WEBSITE_OZON_PAY_ENABLED: flag, WEBSITE_PAYMENT_TOKEN_SECRET: secret };
  const calls = [];
  const snapshots = new Map();
  let secretReads = 0;
  globalThis.websiteActivationFixture = {
    env,
    readSecret() { secretReads++; return env.WEBSITE_PAYMENT_TOKEN_SECRET; },
    checkout(input, idempotencyKey) {
      calls.push(["checkout", input, idempotencyKey]);
      if (!snapshots.has(idempotencyKey)) snapshots.set(idempotencyKey, stage2);
      return snapshots.get(idempotencyKey);
    },
    payment(id) { calls.push(["payment", id]); return payment; },
    status(id) { calls.push(["status", id]); return "paid"; },
    webhook(event) { calls.push(["webhook", event]); },
  };
  t.after(() => { delete globalThis.websiteActivationFixture; });
  const featureUrl = moduleUrl(`
    // Fixture flag: ${JSON.stringify(flag)}
    const process = { env: globalThis.websiteActivationFixture.env };
    ${featureCode}
  `);
  const tokenUrl = moduleUrl(`
    const process = { env: { get WEBSITE_PAYMENT_TOKEN_SECRET() {
      return globalThis.websiteActivationFixture.readSecret();
    } } };
    ${tokenCode}
  `);
  const wire = (code) => moduleUrl(code
    .replace('"./websitePaymentFeature.js"', JSON.stringify(featureUrl))
    .replace('"./websitePaymentAccessToken.js"', JSON.stringify(tokenUrl))
    .replace('"./websiteOrdersService.js"', JSON.stringify(serviceUrl))
    .replace('"./websiteOrdersSchemas.js"', JSON.stringify(new URL("website/websiteOrdersSchemas.js", root).href))
    .replace('"../payment/ozon/ozonPayService.js"', JSON.stringify(providerUrl)));

  const app = Fastify();
  t.after(() => app.close());
  await app.register(swagger, { openapi: { openapi: "3.0.3", info: { title: "Fixture", version: "1" } } });
  const { default: orders } = await import(wire(ordersCode));
  const { default: payments } = await import(wire(paymentCode));
  await app.register(orders);
  await app.register(orders, { prefix: "/website" });
  await app.register(payments);
  await app.ready();

  const checkout = (url) => app.inject({ method: "POST", url, headers: { "idempotency-key": key }, payload });
  const authorized = (method, url, capability) => app.inject({
    method, url, headers: capability === undefined ? {} : { "x-website-payment-token": capability },
  });
  return { app, env, checkout, authorized, calls, snapshots, secretReads: () => secretReads,
    verify: (await import(tokenUrl)).verifyWebsitePaymentAccessToken };
}

for (const flag of [undefined, "false", "TRUE", "1"]) {
  test(`flag ${String(flag)} leaves Stage 2 checkout and replay intact without reading the signing secret`, async (t) => {
    const f = await setup(t, { flag });
    for (const url of [...aliases, ...aliases]) {
      const response = await f.checkout(url);
      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.json(), stage2);
    }
    assert.equal(f.snapshots.size, 1);
    assert.deepEqual(f.calls, aliases.concat(aliases).map(() => ["checkout", payload, key]));
    assert.equal(f.secretReads(), 0);

    for (const capability of [undefined, previousToken]) {
      const response = await f.authorized("POST", `${path}/payment`, capability);
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { success: false, message: "Website payments are temporarily unavailable" });
    }
    assert.equal((await f.authorized("POST", "/website/orders/1e2/payment")).statusCode, 400);
    assert.equal(f.calls.length, 4);
    assert.equal(f.secretReads(), 0);
  });
}

test("enabled checkout rejects missing signing configuration before order creation on both aliases", async (t) => {
  const f = await setup(t, { flag: "true" });
  for (const url of aliases) {
    const response = await f.checkout(url);
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["retry-after"], "2");
    assert.deepEqual(response.json(), { success: false, message: "Website payment authorization is unavailable" });
  }
  assert.deepEqual(f.calls, []);
});

test("enabled checkout issues valid tokens on both aliases without changing the replay snapshot", async (t) => {
  const f = await setup(t, { flag: "true", secret: fixtureSecret });
  // The flag was evaluated when the module loaded, before these requests.
  f.env.WEBSITE_OZON_PAY_ENABLED = "false";
  for (const url of [...aliases, ...aliases]) {
    const response = await f.checkout(url);
    assert.equal(response.statusCode, 201);
    assert.equal(response.headers["cache-control"], "no-store");
    const { paymentAccessToken, ...snapshot } = response.json();
    assert.deepEqual(snapshot, stage2);
    assert.doesNotThrow(() => f.verify(paymentAccessToken, order.id));
  }
  assert.deepEqual(f.snapshots.get(key), stage2);
  const count = f.calls.length;
  for (const capability of [undefined, "invalid"]) {
    assert.equal((await f.authorized("POST", `${path}/payment`, capability)).statusCode, 401);
  }
  assert.equal((await f.authorized("POST", "/website/orders/001e2/payment", previousToken)).statusCode, 400);
  assert.equal(f.calls.length, count);
  const response = await f.authorized("POST", `${path}/payment`, previousToken);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { success: true, payment });
  assert.deepEqual(f.calls.slice(count), [["payment", order.id]]);
});

test("flag off leaves signed webhook settlement and authorized status available", async (t) => {
  const f = await setup(t, { secret: fixtureSecret });
  assert.equal((await f.authorized("GET", `${path}/payment-status`)).statusCode, 401);
  assert.deepEqual(f.calls, []);
  const response = await f.authorized("GET", `${path}/payment-status`, previousToken);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { success: true, orderId: order.id, paymentStatus: "paid" });
  const event = { orderID: "fixture-payment", extOrderID: order.orderNumber, amount: 120000, currencyCode: "643" };
  const notification = { ...event, transactionUID: "fixture-transaction" };
  notification.requestSign = createOzonPayNotificationSign(notification);
  const webhook = await f.app.inject({ method: "POST", url: "/website/payments/ozon/notification", payload: notification });
  assert.equal(webhook.statusCode, 200);
  assert.deepEqual(webhook.json(), { success: true });
  assert.deepEqual(f.calls, [["status", order.id], ["webhook", event]]);

  f.env.WEBSITE_PAYMENT_TOKEN_SECRET = undefined;
  const missing = await f.authorized("GET", `${path}/payment-status`, previousToken);
  assert.equal(missing.statusCode, 503);
  assert.deepEqual(missing.json(), { success: false, message: "Website payment authorization is unavailable" });
  assert.equal(f.calls.length, 2);
});

test("OpenAPI documents conditional checkout token and payment initiation gate", async (t) => {
  const f = await setup(t, { flag: "false" });
  const { paths } = f.app.swagger();
  for (const url of aliases) {
    const post = paths[url].post;
    assert.match(post.description, /disabled.+Stage 2/);
    assert.match(post.description, /signing configuration causes HTTP 503 only when enabled/);
    const schema = post.responses["201"].content["application/json"].schema;
    assert.equal(schema.properties.paymentAccessToken.type, "string");
    assert.ok(!schema.required?.includes("paymentAccessToken"));
  }
  const post = paths["/website/orders/{orderId}/payment"].post;
  assert.match(post.description, /empty request body/);
  assert.match(post.responses["503"].description, /disabled/);
  assert.ok(post.parameters.some((p) => p.name === "x-website-payment-token" && p.in === "header" && p.required));
  assert.ok(post.parameters.some((p) => p.name === "orderId" && p.in === "path" && p.schema.minimum === 1));
  assert.equal(post.requestBody, undefined);
  assert.deepEqual(Object.keys(post.responses), ["200", "400", "401", "403", "404", "409", "500", "502", "503"]);
  assert.equal(post.responses["200"].content["application/json"].schema.properties.payment.properties.payLink.type, "string");
});
