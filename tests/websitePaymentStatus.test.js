import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

const modules = new URL("../src/modules/", import.meta.url);
const source = (path) => readFile(new URL(path, modules), "utf8");
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const featureUrl = moduleUrl(`
  const process = { env: {} };
  ${await source("website/websitePaymentFeature.js")}
`);

const database = moduleUrl(`
  export const supabase = {
    from: (...args) => globalThis.paymentStatusFixture.from(...args),
    rpc: (...args) => globalThis.paymentStatusFixture.rpc(...args),
  };
`);
const delivery = moduleUrl("export function calculateWebsiteOzonDelivery() { throw Error('Unexpected delivery call'); }");
const token = moduleUrl(`
  const process = { env: { get WEBSITE_PAYMENT_TOKEN_SECRET() { return globalThis.paymentStatusFixture.secret; } } };
  ${await source("website/websitePaymentAccessToken.js")}
`);
const providerModule = moduleUrl(`
  const process = { env: { OZON_PAY_ACCESS_KEY: "fixture-access", OZON_PAY_SECRET_KEY: "fixture-secret" } };
  const fetch = (...args) => globalThis.paymentStatusFixture.fetch(...args);
  ${await source("payment/ozon/ozonPayService.js")}
`);
const service = moduleUrl((await source("website/websiteOrdersService.js"))
  .replace('"../../lib/supabase.js"', JSON.stringify(database))
  .replace('"./websiteDeliveryService.js"', JSON.stringify(delivery))
  .replace('"../payment/ozon/ozonPayService.js"', JSON.stringify(providerModule)));

const ready = {
  id: 1052, order_number: "LDP-1052", total: "1250.4500",
  status: "new", payment_state: "ready", ozon_payment_id: "fixture-payment",
  payment_link: "https://example.invalid/private", customer_name: "fixture-private",
};
const confirmed = { ...ready, status: "paid", payment_state: "confirmed" };
const paid = {
  id: ready.ozon_payment_id, extId: ready.order_number, isTestMode: false,
  status: "STATUS_PAID", originalAmount: { currencyCode: "643", value: "125045" },
};
const header = "x-website-payment-token";
const endpoint = (id) => `/website/orders/${id}/payment-status`;
const fixture = globalThis.paymentStatusFixture = {
  secret: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
};
const { issueWebsitePaymentAccessToken } = await import(token);
const { createOzonPayGetOrderStatusSign } = await import(providerModule);
const { default: routes } = await import(moduleUrl((await source("website/websitePaymentRoutes.js"))
  .replace('"./websitePaymentFeature.js"', JSON.stringify(featureUrl))
  .replace('"./websitePaymentAccessToken.js"', JSON.stringify(token))
  .replace('"./websiteOrdersService.js"', JSON.stringify(service))
  .replace('"../payment/ozon/ozonPayService.js"', JSON.stringify(providerModule))));

async function setup(t, { row = ready, provider = paid, read, commit, http, openapi } = {}) {
  const app = Fastify();
  t.after(() => app.close());
  if (openapi) {
    await app.register(swagger, { openapi: { openapi: "3.0.3", info: { title: "Fixture", version: "1" } } });
    await app.register(swaggerUi, { routePrefix: "/documentation" });
  }
  await app.register(routes);
  const calls = [];
  const boundaryErrors = [];
  t.after(() => assert.deepEqual(boundaryErrors, []));
  const check = (assertions) => {
    try {
      assertions();
    } catch (error) {
      boundaryErrors.push(error.message);
      throw error;
    }
  };
  let stored = row;
  let transitions = 0;
  const confirm = () => { stored = confirmed; transitions++; };
  const result = (...data) => ({ data, error: null });

  fixture.from = (table) => ({
    select: (fields) => ({
      eq: (column, value) => ({
        abortSignal: (signal) => ({
          async maybeSingle() {
            calls.push("read");
            check(() => {
              assert.equal(table, "website_orders");
              assert.equal(fields, "id,order_number,total::text,status,payment_state,ozon_payment_id");
              assert.equal(column, "id");
              assert.equal(value, ready.id);
              assert.ok(signal instanceof AbortSignal);
            });
            return read ? read(stored, calls) : { data: stored, error: null };
          },
        }),
      }),
    }),
  });
  fixture.rpc = (name, args) => ({
    async abortSignal(signal) {
      calls.push("rpc");
      check(() => {
        assert.equal(name, "confirm_website_order_payment_v1");
        assert.ok(signal instanceof AbortSignal);
        assert.deepEqual(args, {
          p_order_id: ready.id, p_ozon_payment_id: paid.id,
          p_order_number: paid.extId, p_amount_kopecks: 125045,
        });
      });
      if (commit) return commit({ confirm, result });
      if (stored.payment_state !== "ready") return result();
      confirm();
      return result(confirmed);
    },
  });
  fixture.fetch = async (url, options) => {
    calls.push("provider");
    check(() => {
      assert.equal(url, "https://payapi.ozon.ru/v1/getOrderStatus");
      assert.equal(options.method, "POST");
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(options.body), {
        id: paid.id, accessKey: "fixture-access",
        requestSign: createOzonPayGetOrderStatusSign({ id: paid.id }),
      });
    });
    return http ? http(options.signal) : Response.json(provider);
  };

  const validToken = issueWebsitePaymentAccessToken(ready.id);
  const send = ({ id = ready.id, capability = validToken, method = "GET" } = {}) => app.inject({
    method, url: endpoint(id), headers: capability === null ? {} : { [header]: capability },
  });
  return { app, send, calls, transitions: () => transitions };
}

function assertStatus(response, paymentStatus) {
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json(), { success: true, orderId: ready.id, paymentStatus });
}

function assertFailure(response, code) {
  assert.equal(response.statusCode, code);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json(), { success: false, message: response.json().message });
  assert.equal(typeof response.json().message, "string");
}

test("authorization and ID validation precede all database and provider calls", async (t) => {
  const { send, calls } = await setup(t);
  assertFailure(await send({ capability: null }), 401);
  assertFailure(await send({ capability: "invalid" }), 401);
  assertFailure(await send({ capability: issueWebsitePaymentAccessToken(1) }), 403);
  for (const id of ["0", "-1", "1e3", "1.2", "9007199254740992"]) {
    assertFailure(await send({ id }), 400);
  }
  const now = Date.now();
  const clock = t.mock.method(Date, "now", () => now - 3601000);
  const expired = issueWebsitePaymentAccessToken(ready.id);
  clock.mock.restore();
  assertFailure(await send({ capability: expired }), 401);
  const secret = fixture.secret;
  try {
    fixture.secret = undefined;
    assertFailure(await send(), 503);
  } finally {
    fixture.secret = secret;
  }
  assert.equal((await send({ method: "HEAD" })).statusCode, 404);
  assert.deepEqual(calls, []);
});

for (const [name, row, outcome] of [
  ["missing order", null, 404],
  ["not started", { ...ready, payment_state: null, ozon_payment_id: null }, "not_started"],
  ["reserved payment", { ...ready, payment_state: "reserved", ozon_payment_id: null }, "processing"],
  ["unknown payment", { ...ready, payment_state: "unknown", ozon_payment_id: null }, "recovery_required"],
  ["already confirmed", confirmed, "paid"],
  ["inconsistent confirmed state", { ...confirmed, status: "new" }, 409],
  ["missing saved provider ID", { ...ready, ozon_payment_id: null }, 503],
  ["cancelled order", { ...ready, status: "cancelled" }, 409],
  ["fractional kopecks", { ...ready, total: "1250.45001" }, 503],
]) {
  test(name, async (t) => {
    const { send, calls } = await setup(t, { row });
    if (typeof outcome === "number") assertFailure(await send(), outcome);
    else assertStatus(await send(), outcome);
    assert.deepEqual(calls, ["read"]);
  });
}

for (const status of [
  "STATUS_NEW", "STATUS_PAYMENT_PENDING", "STATUS_AUTHORIZED",
  "STATUS_CANCELED", "STATUS_EXPIRED", "STATUS_REFUNDED",
]) {
  test(status, async (t) => {
    const { send, calls } = await setup(t, { provider: { ...paid, status } });
    const pending = ["STATUS_NEW", "STATUS_PAYMENT_PENDING", "STATUS_AUTHORIZED"].includes(status);
    assertStatus(await send(), pending ? "pending" : "unavailable");
    assert.deepEqual(calls, ["read", "provider"]);
  });
}

for (const [name, fields] of [
  ["wrong provider ID", { id: "other" }],
  ["wrong merchant reference", { extId: "other" }],
  ["wrong amount", { originalAmount: { ...paid.originalAmount, value: "125046" } }],
  ["wrong currency", { originalAmount: { ...paid.originalAmount, currencyCode: "USD" } }],
  ["test payment", { isTestMode: true }],
  ["unknown provider status", { status: "UNKNOWN" }],
  ["incomplete pending response", { status: "STATUS_PAYMENT_PENDING", originalAmount: null }],
  ["malformed provider status", { status: null }],
]) {
  test(name, async (t) => {
    const { send, calls } = await setup(t, { provider: { ...paid, ...fields } });
    assertFailure(await send(), 503);
    assert.deepEqual(calls, ["read", "provider"]);
  });
}

test("provider timeout does not retry or settle", async (t) => {
  const controller = new AbortController();
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (ms) => ms === 5000 ? controller.signal : timeout(ms));
  const { send, calls } = await setup(t, { http(signal) {
    controller.abort();
    signal.throwIfAborted();
  } });
  assertFailure(await send(), 503);
  assert.deepEqual(calls, ["read", "provider"]);
});

test("verified payment recovers once and exposes only the documented fields", async (t) => {
  const { send, calls, transitions } = await setup(t);
  assertStatus(await send(), "paid");
  assertStatus(await send(), "paid");
  assert.deepEqual(calls, ["read", "provider", "rpc", "read"]);
  assert.equal(transitions(), 1);
});

for (const [name, commit, code] of [
  ["zero rows with matching durable readback", ({ confirm, result }) => { confirm(); return result(); }, 200],
  ["zero rows without durable confirmation", ({ result }) => result(), 409],
  ["timeout after commit", ({ confirm }) => { confirm(); throw Error("fixture timeout"); }, 200],
  ["timeout before commit", () => { throw Error("fixture timeout"); }, 503],
  ["wrong provider on readback", ({ result }) => result(), 409],
  ["unavailable readback", () => { throw Error("fixture timeout"); }, 503],
]) {
  test(name, async (t) => {
    const read = (stored, calls) => {
      if (calls.length === 1) return { data: stored, error: null };
      if (name === "wrong provider on readback") {
        return { data: { ...confirmed, ozon_payment_id: "other" }, error: null };
      }
      if (name === "unavailable readback") return { data: null, error: { message: "private" } };
      return { data: stored, error: null };
    };
    const { send, calls } = await setup(t, { commit, read });
    if (code === 200) assertStatus(await send(), "paid");
    else assertFailure(await send(), code);
    assert.deepEqual(calls, ["read", "provider", "rpc", "read"]);
  });
}

test("concurrent checks acknowledge one mocked database transition", { timeout: 2000 }, async (t) => {
  let entered = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const { send, calls, transitions } = await setup(t, {
    async commit({ confirm, result }) {
      const winner = ++entered === 1;
      if (!winner) release();
      await barrier;
      if (!winner) return result();
      confirm();
      return result(confirmed);
    },
  });
  for (const response of await Promise.all([send(), send()])) assertStatus(response, "paid");
  assert.equal(transitions(), 1);
  assert.equal(calls.filter((call) => call === "rpc").length, 2);
  assert.equal(calls.filter((call) => call === "read").length, 3);
});

test("Swagger UI serves the route's exact response, auth and path contract", async (t) => {
  const { app } = await setup(t, { openapi: true });
  const response = await app.inject("/documentation/json");
  assert.equal(response.statusCode, 200);
  const route = response.json().paths[endpoint("{orderId}")].get;
  assert.deepEqual(route.tags, ["Website Payments"]);
  assert.equal(route.summary, "Get website order payment status");
  assert.deepEqual(Object.keys(route.responses), ["200", "400", "401", "403", "404", "409", "503"]);
  const orderParam = route.parameters.find((param) => param.name === "orderId");
  assert.equal(orderParam.in, "path");
  assert.equal(orderParam.required, true);
  assert.equal(orderParam.schema.type, "integer");
  assert.equal(orderParam.schema.minimum, 1);
  const tokenParam = route.parameters.find((param) => param.name === header);
  assert.equal(tokenParam.in, "header");
  assert.equal(tokenParam.required, true);
  const schema = route.responses["200"].content["application/json"].schema;
  assert.deepEqual(schema.required, ["success", "orderId", "paymentStatus"]);
  assert.deepEqual(schema.properties.paymentStatus.enum, [
    "paid", "not_started", "pending", "processing", "recovery_required", "unavailable",
  ]);
});
