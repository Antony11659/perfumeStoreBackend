import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const modules = new URL("../src/modules/", import.meta.url);
const source = (path) => readFile(new URL(path, modules), "utf8");
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

const order = Object.freeze({
  id: 123,
  order_number: "LDP-TEST-123",
  total: "1250.45",
  status: "new",
});

// Follow the order tests' data URL pattern. Swap the import boundary before
// loading the service so the real Supabase client and dotenv never initialize.
const paymentUrl = moduleUrl(`
  const process = { env: {
    OZON_PAY_ACCESS_KEY: "fixture-access-key",
    OZON_PAY_SECRET_KEY: "fixture-secret-key",
  } };
  ${await source("payment/ozon/ozonPayService.js")}
`);
const deliveryUrl = moduleUrl(`
  export function calculateWebsiteOzonDelivery() {
    throw new Error("Delivery must not run during payment creation");
  }
`);
const { createWebsiteOrderPayment } = await import(
  moduleUrl(`const process = { get env() { return globalThis.websiteOzonPayCreationEnv; } };\n` +
  (await source("website/websiteOrdersService.js"))
    .replace('import { supabase } from "../../lib/supabase.js";',
      'const supabase = new Proxy({}, { get: (_, name) => globalThis.websiteOzonPayCreationSupabase[name] });')
    .replace('"./websiteDeliveryService.js"', JSON.stringify(deliveryUrl))
    .replace('"../payment/ozon/ozonPayService.js"', JSON.stringify(paymentUrl)))
);

function providerResponse(sequence, isTestMode = true) {
  return Response.json({
    order: {
      id: `provider-${sequence}`,
      status: "fixture-status",
      payLink: `https://payments.example.invalid/${sequence}`,
      isTestMode,
    },
  });
}

const receiptItem = {
  quantity: 2, unit_price: "600.10", line_total: "1200.20",
  variant: { volume_ml: 10, perfume: { name: "Fixture perfume" } },
};

function setup(t, {
  status = "new", respond, vat = "VAT_NONE", expectedMode = "test", omitVat = false,
  receiptItems = [receiptItem], orderFields = {}, reservedTotal,
} = {}) {
  const reads = [];
  const reservations = [];
  const requests = [];
  const unexpected = [];
  const savedOrder = Object.freeze({ ...order, status, phone: "+79990000000", delivery_price: "50.25", ...orderFields });
  globalThis.websiteOzonPayCreationEnv = { OZON_PAY_EXPECTED_MODE: expectedMode, OZON_PAY_FISCALIZATION_NO_VAT: omitVat ? undefined : vat };

  // Allow only the order read and the two payment RPCs. Record any unexpected
  // operation even if the application catches the mock's exception.
  function expectedOperations(operations) {
    return new Proxy(operations, {
      get(target, name) {
        if (Object.hasOwn(target, name)) return target[name];
        unexpected.push(String(name));
        assert.fail(`Unexpected database operation: ${String(name)}`);
      },
    });
  }

  globalThis.websiteOzonPayCreationSupabase = expectedOperations({
    rpc(name, args) {
      if (name === "save_website_order_payment_v1") {
        assert.deepEqual(args, {
          p_order_id: order.id,
          p_ozon_payment_id: "provider-1",
          p_payment_link: "https://payments.example.invalid/1",
        });
        return expectedOperations({
          async abortSignal(signal) {
            assert.ok(signal instanceof AbortSignal);
            return {
              data: [{
                ...savedOrder,
                payment_state: "ready",
                ozon_payment_id: args.p_ozon_payment_id,
                payment_link: args.p_payment_link,
              }],
              error: null,
            };
          },
        });
      }
      assert.equal(name, "reserve_website_order_payment_v1");
      assert.deepEqual(args, { p_order_id: order.id });
      reservations.push(args.p_order_id);
      return expectedOperations({
        async abortSignal(signal) {
          assert.ok(signal instanceof AbortSignal);
          const data = reservations.length === 1 && status === "new"
            ? [{ ...savedOrder, total: reservedTotal ?? savedOrder.total, payment_state: "reserved" }]
            : [];
          return { data, error: null };
        },
      });
    },
    from(table) {
      if (table === "website_order_items" && vat === "VAT_NONE" && !omitVat) {
        return expectedOperations({
          select(columns) {
            assert.equal(columns, "quantity, unit_price, line_total, variant:perfume_variants(volume_ml, perfume:perfumes(name))");
            return expectedOperations({
              eq(column, value) {
                assert.equal(column, "order_id");
                assert.equal(value, order.id);
                return expectedOperations({
                  async abortSignal(signal) {
                    assert.ok(signal instanceof AbortSignal);
                    return { data: receiptItems, error: null };
                  },
                });
              },
            });
          },
        });
      }
      assert.equal(table, "website_orders");
      return expectedOperations({
        select(columns) {
          assert.deepEqual(columns.split(",").map((column) => column.trim()),
            ["id", "order_number", "total", "status", "phone", "delivery_price"]);
          return expectedOperations({
            eq(column, value) {
              assert.equal(column, "id");
              assert.equal(value, order.id);
              return expectedOperations({
                async maybeSingle() {
                  reads.push(value);
                  return { data: { ...savedOrder }, error: null };
                },
              });
            },
          });
        },
      });
    },
  });

  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    assert.equal(url, "https://payapi.ozon.ru/v1/createOrder");
    assert.equal(options.method, "POST");
    return respond ? respond(requests.length) : providerResponse(requests.length, expectedMode === "test");
  });
  t.after(() => {
    delete globalThis.websiteOzonPayCreationSupabase;
    delete globalThis.websiteOzonPayCreationEnv;
    assert.deepEqual(unexpected, []);
  });
  return { reads, reservations, requests };
}

await test("creates a payment using the saved order reference and total", async (t) => {
  const { reads, reservations, requests } = setup(t);

  const payment = await createWebsiteOrderPayment(order.id);

  assert.deepEqual(reads, [order.id]);
  assert.deepEqual(reservations, [order.id]);
  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.extId, order.order_number);
  assert.deepEqual(body.amount, { currencyCode: "643", value: "125045" });
  assert.deepEqual(payment, {
    orderId: order.id,
    orderNumber: order.order_number,
    amount: 1250.45,
    ozonPayOrderId: "provider-1",
    ozonPayStatus: "fixture-status",
    payLink: "https://payments.example.invalid/1",
    isTestMode: true,
  });
});

await test("a sequential request is denied after the first creates a payment", async (t) => {
  const { reads, reservations, requests } = setup(t);

  const first = await createWebsiteOrderPayment(order.id);
  await assert.rejects(createWebsiteOrderPayment(order.id), { statusCode: 409 });

  assert.deepEqual(reads, [order.id, order.id]);
  assert.deepEqual(reservations, [order.id, order.id]);
  assert.equal(requests.length, 1);
  assert.equal(first.ozonPayOrderId, "provider-1");
});

await test("a second request is denied while the first provider call is pending", { timeout: 2000 }, async (t) => {
  const firstEntered = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  const { reads, reservations, requests } = setup(t, {
    async respond(sequence) {
      if (sequence === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      return providerResponse(sequence);
    },
  });
  t.signal.addEventListener("abort", () => releaseFirst.resolve(), { once: true });

  const first = createWebsiteOrderPayment(order.id);
  await Promise.race([firstEntered.promise, first]);
  try {
    await assert.rejects(createWebsiteOrderPayment(order.id), { statusCode: 409 });
    assert.deepEqual(reads, [order.id, order.id]);
    assert.deepEqual(reservations, [order.id, order.id]);
    assert.equal(requests.length, 1);
  } finally {
    releaseFirst.resolve();
    assert.equal((await first).ozonPayOrderId, "provider-1");
  }
});

await test("an interrupted provider response returns a controlled error and retry is denied", async (t) => {
  const interrupted = new DOMException("Mock provider response timed out", "TimeoutError");
  const { reads, reservations, requests } = setup(t, {
    respond(sequence) {
      if (sequence === 1) throw interrupted;
      return providerResponse(sequence);
    },
  });

  await assert.rejects(createWebsiteOrderPayment(order.id), {
    statusCode: 503,
    message: "Ozon Pay creation could not be confirmed",
  });
  assert.equal(requests.length, 1);

  await assert.rejects(createWebsiteOrderPayment(order.id), { statusCode: 409 });
  assert.deepEqual(reads, [order.id, order.id]);
  assert.deepEqual(reservations, [order.id, order.id]);
  assert.equal(requests.length, 1);
});

await test("rejects an already paid order without calling Ozon", async (t) => {
  const { reads, reservations, requests } = setup(t, { status: "paid" });

  await assert.rejects(createWebsiteOrderPayment(order.id), {
    message: "Website order is already paid",
    statusCode: 400,
  });
  assert.deepEqual(reads, [order.id]);
  assert.deepEqual(reservations, []);
  assert.equal(requests.length, 0);
});

await test("sends a signed production double-fiscalization request with persisted merchandise and delivery", async (t) => {
  const { reservations, requests } = setup(t, { expectedMode: "production" });
  const payment = await createWebsiteOrderPayment(order.id);
  assert.equal(payment.isTestMode, false);
  assert.deepEqual(reservations, [order.id]);
  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.mode, "MODE_FULL");
  assert.equal(body.fiscalizationType, "FISCAL_TYPE_DOUBLE");
  assert.equal(body.enableFiscalization, true);
  assert.equal(body.paymentAlgorithm, "PAY_ALGO_SMS");
  assert.equal(body.fiscalizationPhone, "+79990000000");
  assert.deepEqual(body.items, [
    { name: "Fixture perfume, 10 мл", quantity: 2, price: { currencyCode: "643", value: "60010" }, type: "TYPE_PRODUCT", vat: "VAT_NONE" },
    { name: "Доставка", quantity: 1, price: { currencyCode: "643", value: "5025" }, vat: "VAT_NONE" },
  ]);
  assert.deepEqual(body.amount, { currencyCode: "643", value: "125045" });
  const fingerprint = [
    "fixture-access-key", body.expiresAt, order.order_number, "FISCAL_TYPE_DOUBLE",
    "PAY_ALGO_SMS", "643", "125045", "fixture-secret-key",
  ].join("");
  assert.equal(body.requestSign, createHash("sha256").update(fingerprint).digest("hex"));
});

await test("omits the delivery line when the persisted delivery charge is zero", async (t) => {
  const { requests } = setup(t, { vat: "VAT_NONE", orderFields: { delivery_price: "0.00", total: "1200.20" } });
  await createWebsiteOrderPayment(order.id);
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.items.length, 1);
  assert.equal(body.amount.value, "120020");
});

for (const [reason, options] of [
  ["missing VAT configuration in production", { expectedMode: "production", omitVat: true }],
  ["missing VAT configuration in test", { omitVat: true }],
  ["zero-rate VAT", { vat: "VAT_0" }],
  ["blank VAT", { vat: "" }],
  ["missing phone", { orderFields: { phone: "" } }],
  ["missing catalog name", { receiptItems: [{ ...receiptItem, variant: null }] }],
  ["fractional kopecks", { receiptItems: [{ ...receiptItem, unit_price: "600.101" }] }],
  ["inconsistent line total", { receiptItems: [{ ...receiptItem, line_total: "1200.21" }] }],
  ["inconsistent grand total", { orderFields: { total: "1250.46" } }],
]) {
  await test(`fiscalization rejects ${reason} before reservation or provider calls`, async (t) => {
    const { reservations, requests } = setup(t, { vat: "VAT_NONE", ...options });
    await assert.rejects(createWebsiteOrderPayment(order.id), { statusCode: 503 });
    assert.deepEqual(reservations, []);
    assert.deepEqual(requests, []);
  });
}

await test("does not contact Ozon when the reserved total changed", async (t) => {
  const { reservations, requests } = setup(t, { vat: "VAT_NONE", reservedTotal: "1250.46" });
  await assert.rejects(createWebsiteOrderPayment(order.id), { statusCode: 503 });
  assert.deepEqual(reservations, [order.id]);
  assert.deepEqual(requests, []);
});
