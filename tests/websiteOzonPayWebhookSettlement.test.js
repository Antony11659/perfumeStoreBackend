import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";

const modules = new URL("../src/modules/", import.meta.url);
const source = (path) => readFile(new URL(path, modules), "utf8");
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const featureUrl = moduleUrl(`
  const process = { env: {} };
  ${await source("website/websitePaymentFeature.js")}
`);
const db = moduleUrl("export const supabase = globalThis.webhookFixture.database;");
const delivery = moduleUrl("export function calculateWebsiteOzonDelivery() { throw Error('Unexpected delivery call'); }");
const token = moduleUrl("export function verifyWebsitePaymentAccessToken() { throw Error('Unexpected token call'); }");
const provider = moduleUrl(`
  const process = { env: {
    OZON_PAY_ACCESS_KEY: "fixture-access",
    OZON_PAY_SECRET_KEY: "fixture-secret",
    OZON_PAY_NOTIFICATION_SECRET_KEY: "fixture-notification",
  } };
  const fetch = (...args) => globalThis.webhookFixture.fetch(...args);
  ${await source("payment/ozon/ozonPayService.js")}
`);
const service = moduleUrl((await source("website/websiteOrdersService.js"))
  .replace('"../../lib/supabase.js"', JSON.stringify(db))
  .replace('"./websiteDeliveryService.js"', JSON.stringify(delivery))
  .replace('"../payment/ozon/ozonPayService.js"', JSON.stringify(provider)));
const { createOzonPayNotificationSign, createOzonPayGetOrderStatusSign } = await import(provider);

const ready = {
  id: 123, order_number: "LDP-123", total: "1250.4500",
  status: "new", payment_state: "ready", ozon_payment_id: "ozon-123",
};
const confirmed = { ...ready, status: "paid", payment_state: "confirmed" };
const paid = {
  id: ready.ozon_payment_id, extId: ready.order_number, status: "STATUS_PAID",
  isTestMode: false, originalAmount: { currencyCode: "643", value: "125045" },
};

globalThis.webhookFixture = {
  database: {
    from: (...args) => globalThis.webhookFixture.from(...args),
    rpc: (...args) => globalThis.webhookFixture.rpc(...args),
  },
};
const { default: routes } = await import(moduleUrl((await source("website/websitePaymentRoutes.js"))
  .replace('"./websitePaymentFeature.js"', JSON.stringify(featureUrl))
  .replace('"./websitePaymentAccessToken.js"', JSON.stringify(token))
  .replace('"./websiteOrdersService.js"', JSON.stringify(service))
  .replace('"../payment/ozon/ozonPayService.js"', JSON.stringify(provider))));

async function setup(t, { row = ready, providerResponse = paid, commit, http } = {}) {
  const app = Fastify();
  await app.register(routes);
  t.after(() => app.close());
  const calls = [];
  const unexpected = [];
  t.after(() => assert.deepEqual(unexpected, []));
  const check = (fn) => {
    try {
      fn();
    } catch (error) {
      unexpected.push(error.message);
      throw error;
    }
  };
  let stored = row;
  let transitions = 0;
  const setConfirmed = () => {
    stored = confirmed;
    transitions++;
  };
  const result = (...data) => ({ data, error: null });
  const fixture = globalThis.webhookFixture;
  fixture.from = (table) => {
    check(() => assert.equal(table, "website_orders"));
    return {
      select: (columns) => ({
        eq: (column, value) => ({
          abortSignal: (signal) => ({
            async maybeSingle() {
              check(() => {
                assert.match(columns, /total::text/);
                assert.ok(signal instanceof AbortSignal);
                assert.ok(["id", "order_number"].includes(column));
              });
              calls.push(column === "id" ? "readback" : "lookup");
              return { data: stored?.[column] === value ? stored : null, error: null };
            },
          }),
        }),
      }),
    };
  };
  fixture.rpc = (name, args) => ({
    async abortSignal(signal) {
      calls.push("rpc");
      check(() => {
        assert.ok(signal instanceof AbortSignal);
        assert.equal(name, "confirm_website_order_payment_v1");
        assert.deepEqual(args, {
          p_order_id: ready.id, p_ozon_payment_id: ready.ozon_payment_id,
          p_order_number: ready.order_number, p_amount_kopecks: 125045,
        });
      });
      if (commit) return commit({ stored, setConfirmed, result });
      if (stored.payment_state !== "ready") return result();
      setConfirmed();
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
        id: ready.ozon_payment_id, accessKey: "fixture-access",
        requestSign: createOzonPayGetOrderStatusSign({ id: ready.ozon_payment_id }),
      });
    });
    return http ? http(options.signal) : Response.json(providerResponse);
  };

  async function send(changes = {}, afterSigning = {}) {
    const payload = {
      orderID: paid.id, extOrderID: paid.extId, amount: 125045,
      currencyCode: "643", transactionUid: "fixture-uid", status: "Completed",
      operationType: "Payment", testMode: 0, ...changes,
    };
    payload.requestSign = createOzonPayNotificationSign(payload);
    return app.inject({
      method: "POST", url: "/website/payments/ozon/notification",
      payload: { ...payload, ...afterSigning },
    });
  }
  return { send, calls, stored: () => stored, transitions: () => transitions };
}

function assertResponse(response, status) {
  assert.equal(response.statusCode, status);
  assert.deepEqual(response.json(), { success: status === 200 });
}

test("valid notification settles once and a duplicate verifies status again", async (t) => {
  const fixture = await setup(t);
  assertResponse(await fixture.send(), 200);
  assertResponse(await fixture.send(), 200);
  assert.deepEqual(fixture.calls, ["lookup", "provider", "rpc", "lookup", "provider"]);
  assert.equal(fixture.transitions(), 1);
  assert.deepEqual(fixture.stored(), confirmed);
});

for (const [name, options, changes, afterSigning, status, calls] of [
  ["invalid signature", {}, {}, { requestSign: "0".repeat(64) }, 401, []],
  ["wrong saved provider ID", {}, { orderID: "other" }, {}, 409, ["lookup"]],
  ["wrong merchant reference", {}, { extOrderID: "other" }, {}, 404, ["lookup"]],
  ["wrong signed amount", {}, { amount: 125046 }, {}, 400, ["lookup"]],
  ["wrong signed currency", {}, { currencyCode: "USD" }, {}, 400, ["lookup"]],
  ["early notification", { row: { ...ready, payment_state: "reserved", ozon_payment_id: null } }, {}, {}, 503, ["lookup"]],
  ["cancelled order", { row: { ...ready, status: "cancelled" } }, {}, {}, 409, ["lookup"]],
  ["fractional kopeck total", { row: { ...ready, total: "1250.45001" } }, {}, {}, 503, ["lookup"]],
  ["malformed amount", {}, { amount: null }, {}, 400, []],
  ["amount string", {}, { amount: "125045" }, {}, 400, []],
  ["missing transaction identifier", {}, { transactionUid: undefined }, {}, 400, []],
  ["provider HTTP error", { http: () => new Response(null, { status: 500 }) }, {}, {}, 503, ["lookup", "provider"]],
  ["invalid provider JSON", { http: () => new Response("{") }, {}, {}, 503, ["lookup", "provider"]],
  ["pending despite unsigned success claim", { providerResponse: { ...paid, status: "STATUS_PAYMENT_PENDING" } },
    { status: "Rejected" }, { status: "Completed" }, 503, ["lookup", "provider"]],
  ...["STATUS_AUTHORIZED", "STATUS_NEW", "STATUS_CANCELED", "STATUS_EXPIRED", "STATUS_REFUNDED"].map((status) =>
    [status, { providerResponse: { ...paid, status } }, {}, {}, 503, ["lookup", "provider"]]),
  ...[
    ["test mode", { isTestMode: true }],
    ["wrong authoritative amount", { originalAmount: { currencyCode: "643", value: "125046" } }],
    ["wrong authoritative currency", { originalAmount: { currencyCode: "USD", value: "125045" } }],
    ["wrong authoritative provider ID", { id: "other" }],
    ["wrong authoritative merchant reference", { extId: "other" }],
  ].map(([name, fields]) =>
    [name, { providerResponse: { ...paid, ...fields } }, {}, {}, 503, ["lookup", "provider"]]),
]) {
  test(name, async (t) => {
    const fixture = await setup(t, options);
    assertResponse(await fixture.send(changes, afterSigning), status);
    assert.deepEqual(fixture.calls, calls);
    assert.deepEqual(fixture.stored(), options.row ?? ready);
    assert.equal(fixture.transitions(), 0);
  });
}

test("provider timeout is temporary and is not retried", async (t) => {
  const controller = new AbortController();
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (delay) => delay === 5000 ? controller.signal : timeout(delay));
  const fixture = await setup(t, {
    http(signal) {
      controller.abort();
      signal.throwIfAborted();
    },
  });
  assertResponse(await fixture.send(), 503);
  assert.deepEqual(fixture.calls, ["lookup", "provider"]);
  assert.deepEqual(fixture.stored(), ready);
});

test("concurrent requests recognize one mocked RPC winner and one durable replay", async (t) => {
  let entered = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const fixture = await setup(t, {
    async commit({ setConfirmed, result }) {
      const winner = ++entered === 1;
      if (!winner) release();
      await barrier;
      if (!winner) return result();
      setConfirmed();
      return result(confirmed);
    },
  });
  for (const response of await Promise.all([fixture.send(), fixture.send()])) {
    assertResponse(response, 200);
  }
  assert.equal(fixture.transitions(), 1);
  assert.equal(fixture.calls.filter((call) => call === "rpc").length, 2);
  assert.equal(fixture.calls.filter((call) => call === "readback").length, 1);
});

for (const [name, commit, status, transitions] of [
  ["zero rows without confirmation", ({ result }) => result(), 409, 0],
  ["zero rows after another confirmation", ({ result, setConfirmed }) => {
    setConfirmed();
    return result();
  }, 200, 1],
  ["response lost after commit", ({ setConfirmed }) => {
    setConfirmed();
    throw new Error("fixture timeout");
  }, 200, 1],
  ["error before commit", () => ({ data: null, error: { message: "fixture secret" } }), 503, 0],
  ["wrong RPC echo", ({ result }) => result({ ...confirmed, total: "1250.46" }), 503, 0],
]) {
  test(name, async (t) => {
    const fixture = await setup(t, { commit });
    assertResponse(await fixture.send(), status);
    assert.deepEqual(fixture.calls, ["lookup", "provider", "rpc", "readback"]);
    assert.equal(fixture.transitions(), transitions);
    assert.deepEqual(fixture.stored(), transitions ? confirmed : ready);
  });
}
