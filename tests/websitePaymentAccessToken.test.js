import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";

const modules = new URL("../src/modules/", import.meta.url);
const source = (path) => readFile(new URL(path, modules), "utf8");
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const featureUrl = moduleUrl(`
  const process = { env: { WEBSITE_OZON_PAY_ENABLED: "true" } };
  ${await source("website/websitePaymentFeature.js")}
`);
const fixtureSecret = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const tokenUrl = moduleUrl(`
  const process = { get env() { return globalThis.paymentAccessFixture.env; } };
  const Date = { now: () => globalThis.paymentAccessFixture.now * 1000 };
  ${await source("website/websitePaymentAccessToken.js")}
`);
const tokenUtility = await import(tokenUrl);
const checkoutService = moduleUrl(`
  export const createWebsiteOrder = (...args) => globalThis.paymentAccessFixture.checkout(...args);
`);
const database = moduleUrl(`
  export const supabase = new Proxy({}, {
    get(_target, key) { return globalThis.paymentAccessFixture.database[key]; }
  });
`);
const delivery = moduleUrl(`
  export function calculateWebsiteOzonDelivery() { throw new Error("Unexpected delivery call"); }
`);
const provider = moduleUrl(`
  export const createOzonPayOrder = (...args) => globalThis.paymentAccessFixture.provider(...args);
  export function verifyOzonPayNotification() { throw new Error("Unexpected notification"); }
`);
const service = moduleUrl(`const process = { env: { OZON_PAY_EXPECTED_MODE: "production", OZON_PAY_FISCALIZATION_NO_VAT: "VAT_NONE" } };\n` +
  (await source("website/websiteOrdersService.js"))
  .replace('"../../lib/supabase.js"', JSON.stringify(database))
  .replace('"./websiteDeliveryService.js"', JSON.stringify(delivery))
  .replace('"../payment/ozon/ozonPayService.js"', JSON.stringify(provider)));
const paymentRoutes = (await import(moduleUrl((await source("website/websitePaymentRoutes.js"))
  .replace('"./websitePaymentFeature.js"', JSON.stringify(featureUrl))
  .replace('"./websitePaymentAccessToken.js"', JSON.stringify(tokenUrl))
  .replace('"./websiteOrdersService.js"', JSON.stringify(service))
  .replace('"../payment/ozon/ozonPayService.js"', JSON.stringify(provider))))).default;
const checkoutRoutes = (await import(moduleUrl((await source("website/websiteOrdersRoutes.js"))
  .replace('"./websitePaymentFeature.js"', JSON.stringify(featureUrl))
  .replace('"./websitePaymentAccessToken.js"', JSON.stringify(tokenUrl))
  .replace('"./websiteOrdersService.js"', JSON.stringify(checkoutService))
  .replace('"./websiteOrdersSchemas.js"', JSON.stringify(new URL("website/websiteOrdersSchemas.js", modules).href))))).default;

const id = 123;
const now = 1800000000;
const key = "32ff023c-a3fe-48c6-bdae-63de5413dd5f";
const stored = Object.freeze({
  success: true,
  order: Object.freeze({
    id, orderNumber: "LDP-123", pricingMode: "website",
    subtotal: 1200, deliveryPrice: 50, total: 1250, status: "new",
  }),
});
const body = {
  customer: { name: "Fixture", phone: "+79991234567", city: "City", address: "Address" },
  delivery: { provider: "ozon", deliveryPointId: "2002344" },
  items: [{ variantId: 1, quantity: 1 }],
};
const payment = { id: "provider-fixture", payLink: "https://payments.example.invalid", status: "created", isTestMode: false };
const reserve = { id, order_number: stored.order.orderNumber, total: 1250, payment_state: "reserved" };

function signedClaims(overrides) {
  const claims = { v: 1, orderId: id, purpose: "website_order_payment", iat: now, exp: now + 3600, ...overrides };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(fixtureSecret, "hex")).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

async function setup(t, { status = "new", checkoutError, snapshot = stored } = {}) {
  const calls = [];
  const logs = [];
  const app = Fastify({ logger: { stream: { write(line) { logs.push(line); } } } });
  t.mock.method(globalThis, "fetch", async () => {
    calls.push("unexpected external fetch");
    throw new Error("Unexpected external fetch");
  });
  const fixture = {
    now,
    env: { WEBSITE_PAYMENT_TOKEN_SECRET: fixtureSecret },
    checkout(payload, idempotencyKey) {
      calls.push("checkout");
      assert.deepEqual(payload, body);
      assert.equal(idempotencyKey, key);
      if (checkoutError) throw checkoutError;
      return snapshot;
    },
    database: {
      from(table) {
        if (table === "website_order_items") {
          return { select: () => ({ eq: () => ({ abortSignal: async () => ({
            data: [{ quantity: 1, unit_price: "1200.00", line_total: "1200.00",
              variant: { volume_ml: 10, perfume: { name: "Fixture perfume" } } }],
            error: null,
          }) }) }) };
        }
        calls.push("read");
        assert.equal(table, "website_orders");
        return { select: () => ({ eq: () => ({
          maybeSingle: async () => ({ data: { ...reserve, status, phone: "+79990000000", delivery_price: 50 }, error: null }),
        }) }) };
      },
      rpc(name, args) {
        calls.push(name);
        assert.equal(args.p_order_id, id);
        if (name === "reserve_website_order_payment_v1") {
          return { abortSignal: async () => ({ data: [reserve], error: null }) };
        }
        assert.equal(name, "save_website_order_payment_v1");
        assert.equal(args.p_ozon_payment_id, payment.id);
        assert.equal(args.p_payment_link, payment.payLink);
        return { abortSignal: async () => ({ data: [{
          ...reserve, payment_state: "ready", ozon_payment_id: payment.id, payment_link: payment.payLink,
        }], error: null }) };
      },
    },
    provider(options) {
      calls.push("provider");
      assert.equal(options.extId, stored.order.orderNumber);
      assert.equal(options.amountValue, "125000");
      assert.equal(options.receipt.phone, "+79990000000");
      return { order: payment };
    },
  };
  globalThis.paymentAccessFixture = fixture;
  t.after(async () => {
    await app.close();
    delete globalThis.paymentAccessFixture;
  });
  await app.register(checkoutRoutes);
  await app.register(checkoutRoutes, { prefix: "/website" });
  await app.register(paymentRoutes);
  return {
    fixture, calls, logs,
    checkout: (url = "/website/orders") => app.inject({
      method: "POST", url, payload: body, headers: { "idempotency-key": key },
    }),
    pay: (token, path = String(id), query = "") => app.inject({
      method: "POST", url: `/website/orders/${path}/payment${query}`,
      headers: token === undefined ? {} : { "x-website-payment-token": token },
    }),
  };
}

await test("checkout issues a token and it permits the existing payment flow", async (t) => {
  const harness = await setup(t);
  const response = await harness.checkout();
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers["cache-control"], "no-store");
  const { paymentAccessToken, ...snapshot } = response.json();
  assert.deepEqual(snapshot, stored);
  assert.equal(paymentAccessToken, signedClaims());
  const paid = await harness.pay(paymentAccessToken);
  assert.equal(paid.statusCode, 200);
  assert.deepEqual(paid.json(), {
    success: true,
    payment: {
      orderId: id, orderNumber: stored.order.orderNumber, amount: 1250,
      ozonPayOrderId: payment.id, ozonPayStatus: payment.status, payLink: payment.payLink, isTestMode: false,
    },
  });
  assert.deepEqual(harness.calls, [
    "checkout", "read", "reserve_website_order_payment_v1", "provider", "save_website_order_payment_v1",
  ]);
  assert.ok(!harness.logs.join("").includes(paymentAccessToken));
});

await test("replays across both aliases get fresh tokens for the same frozen response", async (t) => {
  const harness = await setup(t);
  const oldTokens = [];
  for (const url of ["/website/orders", "/website/orders", "/orders", "/website/orders"]) {
    const response = await harness.checkout(url);
    assert.equal(response.statusCode, 201);
    const { paymentAccessToken, ...snapshot } = response.json();
    assert.deepEqual(snapshot, stored);
    assert.equal(tokenUtility.verifyWebsitePaymentAccessToken(paymentAccessToken, id), undefined);
    assert.ok(!oldTokens.includes(paymentAccessToken));
    oldTokens.push(paymentAccessToken);
    harness.fixture.now += 60;
  }
  assert.ok(!Object.hasOwn(stored, "paymentAccessToken"));
});

const rejected = [
  ["missing token", () => undefined, 401],
  ["signature mismatch", () => {
    const [payload, signature] = signedClaims().split(".");
    return `${payload}.${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
  }, 401],
  ["expiry at current second", () => signedClaims({ iat: now - 3600, exp: now }), 401],
  ["wrong order", () => signedClaims({ orderId: id + 1 }), 403],
  ["wrong purpose", () => signedClaims({ purpose: "different" }), 401],
  ["malformed token", () => "bad.token.extra", 401],
  ["unsupported version", () => signedClaims({ v: 2 }), 401],
  ["future issue time", () => signedClaims({ iat: now + 31 }), 401],
  ["unsafe order claim", () => signedClaims({ orderId: Number.MAX_SAFE_INTEGER + 1 }), 401],
  ["excessive lifetime", () => signedClaims({ exp: now + 3601 }), 401],
  ["duplicate token header", () => [signedClaims(), signedClaims()], 401],
];
for (const [name, tokenForCase, status] of rejected) {
  await test(`${name} is rejected before any payment I/O`, async (t) => {
    const harness = await setup(t);
    const token = tokenForCase();
    const response = await harness.pay(token);
    assert.equal(response.statusCode, status);
    assert.deepEqual(response.json(), {
      success: false,
      message: status === 403 ? "Website payment token is for another order" : "Valid website payment token required",
    });
    assert.deepEqual(harness.calls, []);
    for (const value of [fixtureSecret, payment.id, payment.payLink, ...[token].flat().filter(Boolean)]) {
      assert.ok(!response.body.includes(value));
      assert.ok(!harness.logs.join("").includes(value));
    }
  });
}

await test("unsafe and invalid path IDs are rejected before any payment I/O", async (t) => {
  const harness = await setup(t);
  for (const path of ["0", "-1", "123.0", "1e3", "NaN", "9007199254740992"]) {
    assert.equal((await harness.pay(signedClaims(), path)).statusCode, 400);
  }
  assert.equal((await harness.pay(undefined, String(id), `?token=${signedClaims()}`)).statusCode, 401);
  assert.deepEqual(harness.calls, []);
});

await test("missing or weak configuration fails closed for payment and checkout", async (t) => {
  const harness = await setup(t);
  for (const secret of [undefined, "short", "00".repeat(32)]) {
    harness.fixture.env.WEBSITE_PAYMENT_TOKEN_SECRET = secret;
    for (const response of [await harness.pay(signedClaims()), await harness.checkout()]) {
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { success: false, message: "Website payment authorization is unavailable" });
    }
  }
  assert.deepEqual(harness.calls, []);
});

for (const code of ["IDEMPOTENCY_KEY_CONFLICT", "ORDER_IN_PROGRESS"]) {
  await test(`checkout ${code} never issues a token`, async (t) => {
    const harness = await setup(t, { checkoutError: Object.assign(new Error("Checkout rejected"), { statusCode: 409, code }) });
    const response = await harness.checkout();
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { success: false, code, message: "Checkout rejected" });
    assert.deepEqual(harness.calls, ["checkout"]);
  });
}

await test("checkout cannot issue a token for a malformed confirmed ID", async (t) => {
  const harness = await setup(t, { snapshot: { ...stored, order: { ...stored.order, id: 1e16 } } });
  const response = await harness.checkout();
  assert.equal(response.statusCode, 503);
  assert.ok(!Object.hasOwn(response.json(), "paymentAccessToken"));
});

await test("authorized already-paid orders still reject before the RPC or provider", async (t) => {
  const harness = await setup(t, { status: "paid" });
  const response = await harness.pay(signedClaims({ iat: now + 30 }));
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { success: false, message: "Website order is already paid" });
  assert.deepEqual(harness.calls, ["read"]);
});
