import assert from "node:assert/strict";
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
const orderId = 123;
const denied = { data: [], error: null };
const reservedOrder = {
  id: orderId,
  order_number: "LDP-RESERVED",
  total: "1250.45",
  payment_state: "reserved",
};
const confirmed = { data: [reservedOrder], error: null };

// Load the real route, service and payment client with in-memory dependency
// replacements, using the same data URL approach as the payment creation tests.
const mockDatabase = moduleUrl(`
  export const supabase = new Proxy({}, {
    get(_target, key) { return globalThis.websitePaymentDecisionDatabase[key]; }
  });
`);
const payment = moduleUrl(`
  const process = { env: {
    OZON_PAY_ACCESS_KEY: "fixture-access-key",
    OZON_PAY_SECRET_KEY: "fixture-secret-key",
  } };
  const fetch = (...args) => globalThis.websitePaymentDecisionFetch(...args);
  ${await source("payment/ozon/ozonPayService.js")}
`);
const delivery = moduleUrl(`
  export function calculateWebsiteOzonDelivery() {
    throw new Error("Delivery must not run during payment creation");
  }
`);
const service = moduleUrl(`const process = { env: { OZON_PAY_EXPECTED_MODE: "test" } };\n` +
  (await source("website/websiteOrdersService.js"))
  .replace('"../../lib/supabase.js"', JSON.stringify(mockDatabase))
  .replace('"./websiteDeliveryService.js"', JSON.stringify(delivery))
  .replace('"../payment/ozon/ozonPayService.js"', JSON.stringify(payment)));
const tokenUrl = moduleUrl(`
  const process = { env: { WEBSITE_PAYMENT_TOKEN_SECRET:
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" } };
  ${await source("website/websitePaymentAccessToken.js")}
`);
const tokenUtility = await import(tokenUrl);
const { default: routes } = await import(moduleUrl((await source("website/websitePaymentRoutes.js"))
  .replace('"./websitePaymentFeature.js"', JSON.stringify(featureUrl))
  .replace('"./websitePaymentAccessToken.js"', JSON.stringify(tokenUrl))
  .replace('"./websiteOrdersService.js"', JSON.stringify(service))
  .replace('"../payment/ozon/ozonPayService.js"', JSON.stringify(payment))));

async function setup(t, { status = "new", outcomes = [] } = {}) {
  const rpcCalls = [];
  const providerCalls = [];
  const events = [];
  // The legacy read deliberately differs from the authoritative reservation.
  const legacyOrder = { id: orderId, order_number: "LDP-LEGACY-READ", total: "999.99", status };
  globalThis.websitePaymentDecisionDatabase = {
    from(table) {
      assert.equal(table, "website_orders");
      return {
        select() {
          return {
            eq(column, value) {
              assert.equal(column, "id");
              assert.equal(value, orderId);
              return { async maybeSingle() { return { data: legacyOrder, error: null }; } };
            },
          };
        },
      };
    },
    rpc(name, args) {
      if (name === "save_website_order_payment_v1") {
        assert.deepEqual(args, {
          p_order_id: orderId,
          p_ozon_payment_id: "fixture-provider-id",
          p_payment_link: "https://payment.example.invalid",
        });
        return {
          async abortSignal() {
            events.push("payment saved");
            return {
              data: [{
                ...reservedOrder,
                payment_state: "ready",
                ozon_payment_id: args.p_ozon_payment_id,
                payment_link: args.p_payment_link,
              }],
              error: null,
            };
          },
        };
      }
      assert.equal(name, "reserve_website_order_payment_v1");
      assert.deepEqual(args, { p_order_id: orderId });
      const index = rpcCalls.push({ name, args }) - 1;
      assert.ok(index < outcomes.length, "Unexpected reservation request");
      events.push("reservation requested");
      const request = {
        async then(resolve, reject) {
          const outcome = outcomes[index];
          if (outcome instanceof Error || outcome instanceof DOMException) {
            events.push("reservation rejected");
            return reject(outcome);
          }
          events.push("reservation responded");
          return resolve(outcome);
        },
        abortSignal() { return this; },
      };
      return request;
    },
  };
  globalThis.websitePaymentDecisionFetch = async (url, options) => {
    assert.equal(url, "https://payapi.ozon.ru/v1/createOrder");
    assert.equal(options.method, "POST");
    const { extId, amount } = JSON.parse(options.body);
    providerCalls.push({ extId, amount });
    events.push("provider called");
    return Response.json({
      order: { id: "fixture-provider-id", payLink: "https://payment.example.invalid", isTestMode: true },
    });
  };

  const app = Fastify();
  t.after(async () => {
    delete globalThis.websitePaymentDecisionDatabase;
    delete globalThis.websitePaymentDecisionFetch;
    await app.close();
  });
  await app.register(routes);
  await app.ready();
  return {
    pay: () => app.inject({ method: "POST", url: `/website/orders/${orderId}/payment`,
      headers: { "x-website-payment-token": tokenUtility.issueWebsitePaymentAccessToken(orderId) },
    }),
    providerCalls, rpcCalls, events,
  };
}

function observed(harness, responses) {
  return {
    reservations: harness.rpcCalls.length,
    providerCalls: harness.providerCalls,
    success: responses.map((response) => response.json().success),
  };
}

await test("A: one confirmed reservation permits creation with the claimed order data", async (t) => {
  const harness = await setup(t, { outcomes: [confirmed] });
  const response = await harness.pay();

  assert.deepEqual(observed(harness, [response]), {
    reservations: 1,
    providerCalls: [{ extId: "LDP-RESERVED", amount: { currencyCode: "643", value: "125045" } }],
    success: [true],
  });
  assert.deepEqual(harness.events, ["reservation requested", "reservation responded", "provider called", "payment saved"]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().payment.ozonPayOrderId, "fixture-provider-id");
});

await test("B: zero reservation rows deny creation", async (t) => {
  const harness = await setup(t, { outcomes: [denied] });
  const response = await harness.pay();

  assert.deepEqual(observed(harness, [response]), { reservations: 1, providerCalls: [], success: [false] });
  assert.ok(response.statusCode >= 400);
});

await test("C: a Supabase RPC error prevents creation", async (t) => {
  const error = { code: "42501", message: "Fixture permission denied" };
  const harness = await setup(t, { outcomes: [{ data: null, error }] });
  const response = await harness.pay();

  assert.deepEqual(observed(harness, [response]), { reservations: 1, providerCalls: [], success: [false] });
  assert.ok(response.statusCode >= 400);
});

await test("D: an ambiguous timeout blocks creation, and retry must reserve again", async (t) => {
  const timeout = new DOMException("Fixture reservation response timed out", "TimeoutError");
  const harness = await setup(t, { outcomes: [timeout, denied] });
  const first = await harness.pay();
  const retry = await harness.pay();

  assert.deepEqual(observed(harness, [first, retry]), {
    reservations: 2, providerCalls: [], success: [false, false],
  });
  assert.ok(first.statusCode >= 400);
  assert.ok(retry.statusCode >= 400);
});

await test("E: malformed reservation responses fail closed", async (t) => {
  const cases = [
    ["missing result", undefined],
    ["unexpected shape", { data: reservedOrder, error: null }],
    ["multiple rows", { data: [reservedOrder, reservedOrder], error: null }],
    ["missing order ID", { data: [{ ...reservedOrder, id: undefined }], error: null }],
    ["mismatched order ID", { data: [{ ...reservedOrder, id: orderId + 1 }], error: null }],
    ["invalid payment state", { data: [{ ...reservedOrder, payment_state: "ready" }], error: null }],
  ];
  const harness = await setup(t, { outcomes: cases.map(([, outcome]) => outcome) });
  const responses = [];
  for (const [name] of cases) {
    const response = await harness.pay();
    responses.push({ name, failed: response.statusCode >= 400 && response.json().success === false });
  }

  assert.deepEqual({
    reservations: harness.rpcCalls.length,
    providerCalls: harness.providerCalls,
    responses,
  }, {
    reservations: cases.length,
    providerCalls: [],
    responses: cases.map(([name]) => ({ name, failed: true })),
  });
});

await test("F: two requests with one mocked reservation winner permit only one create call", async (t) => {
  // This covers the Fastify decision. The fixture supplies database outcomes;
  // real PostgreSQL lock contention is covered by the separate database tests.
  const harness = await setup(t, { outcomes: [confirmed, denied] });
  const responses = await Promise.all([harness.pay(), harness.pay()]);
  const result = observed(harness, responses);

  assert.deepEqual({ ...result, success: result.success.sort() }, {
    reservations: 2,
    providerCalls: [{ extId: "LDP-RESERVED", amount: { currencyCode: "643", value: "125045" } }],
    success: [false, true],
  });
});

await test("G: an already-paid order retains the existing rejection", async (t) => {
  const harness = await setup(t, { status: "paid", outcomes: [denied] });
  const response = await harness.pay();

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { success: false, message: "Website order is already paid" });
  assert.deepEqual(harness.providerCalls, []);
});
