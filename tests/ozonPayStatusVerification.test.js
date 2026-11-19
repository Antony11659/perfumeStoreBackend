import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  createOzonPayGetOrderStatusSign,
  createOzonPayNotificationSign,
  getOzonPayOrderStatus,
  validateOzonPaySettlement,
  verifyOzonPayNotification,
} from "../src/modules/payment/ozon/ozonPayService.js";

const expected = {
  id: "provider-id",
  extId: "merchant-id",
  amountKopecks: 10050,
  currencyCode: "643",
  environment: "production",
};
const paid = {
  id: expected.id,
  extId: expected.extId,
  status: "STATUS_PAID",
  isTestMode: false,
  originalAmount: { currencyCode: "643", value: "10050" },
};
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

test("Ozon status lookup with mocked HTTP", async (t) => {
  const keys = { OZON_PAY_ACCESS_KEY: "fixture-access", OZON_PAY_SECRET_KEY: "fixture-secret" };
  for (const [key, value] of Object.entries(keys)) {
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }

  for (const identifier of [{ id: paid.id }, { extId: paid.extId }]) {
    await t.test(`lookup by ${Object.keys(identifier)[0]} signs exactly the supplied identifier`, async (t) => {
      const signature = sha256(`${paid[Object.keys(identifier)[0]]}fixture-accessfixture-secret`);
      assert.equal(createOzonPayGetOrderStatusSign(identifier), signature);
      const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(url, "https://payapi.ozon.ru/v1/getOrderStatus");
        assert.equal(options.method, "POST");
        assert.equal(options.headers["Content-Type"], "application/json");
        assert.equal(options.redirect, "error");
        assert.ok(options.signal instanceof AbortSignal);
        assert.deepEqual(JSON.parse(options.body), {
          ...identifier, accessKey: "fixture-access", requestSign: signature,
        });
        return Response.json(paid);
      });
      assert.deepEqual(await getOzonPayOrderStatus(identifier), paid);
      assert.equal(fetch.mock.callCount(), 1);
    });
  }

  await t.test("rejects missing, invalid or multiple identifiers before fetch", async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(paid));
    for (const params of [undefined, {}, { id: "" }, { extId: " " }, { id: 123 }, { id: paid.id, extId: paid.extId }]) {
      await assert.rejects(getOzonPayOrderStatus(params), /exactly one order identifier/);
    }
    assert.equal(fetch.mock.callCount(), 0);
  });

  for (const status of [400, 500]) {
    await t.test(`HTTP ${status} hides provider body`, async (t) => {
      t.mock.method(globalThis, "fetch", async () => Response.json({ message: "private" }, { status }));
      await assert.rejects(getOzonPayOrderStatus({ id: paid.id }), {
        message: `Ozon Pay status lookup failed (HTTP ${status})`,
      });
    });
  }

  await t.test("aborts a slow request without retrying", async (t) => {
    const controller = new AbortController();
    const timeout = t.mock.method(AbortSignal, "timeout", () => controller.signal);
    const fetch = t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
      controller.abort();
      signal.throwIfAborted();
    });
    await assert.rejects(getOzonPayOrderStatus({ id: paid.id }), /timed out/);
    assert.deepEqual(timeout.mock.calls[0].arguments, [5000]);
    assert.equal(fetch.mock.callCount(), 1);
  });

  for (const [name, body, error] of [
    ["invalid JSON", "{", "Invalid Ozon Pay status response"],
    ["empty object", "{}", "Invalid Ozon Pay status response"],
    ["wrong lookup identity", JSON.stringify({ ...paid, id: "other" }), "Invalid Ozon Pay status response"],
    ["business error", '{"code":5,"message":"private"}', "Ozon Pay status lookup returned a provider error"],
  ]) {
    await t.test(name, async (t) => {
      t.mock.method(globalThis, "fetch", async () => new Response(body));
      await assert.rejects(getOzonPayOrderStatus({ id: paid.id }), { message: error });
    });
  }
});

test("settlement accepts only matching paid orders in the expected mode", () => {
  assert.deepEqual(validateOzonPaySettlement(paid, expected), { valid: true });
  assert.deepEqual(validateOzonPaySettlement({ ...paid, isTestMode: true }, {
    ...expected, environment: "test",
  }), { valid: true });

  for (const status of [
    "STATUS_PAYMENT_PENDING", "STATUS_AUTHORIZED", "STATUS_NEW", "STATUS_EXPIRED",
    "STATUS_CANCELED", "STATUS_REFUNDED", "STATUS_PARTITIONAL_REFUND",
    "STATUS_DISPUTED", "STATUS_DISPUTING", "STATUS_PARTITION_CANCELED", "Completed",
  ]) {
    assert.deepEqual(validateOzonPaySettlement({ ...paid, status }, expected), {
      valid: false, reason: "NOT_PAID",
    });
  }
});

test("settlement rejects different IDs, mode, currency and missing fields", () => {
  for (const change of [
    { id: "other" }, { extId: "other" }, { isTestMode: true }, { isTestMode: 0 },
    { originalAmount: { currencyCode: "USD", value: "10050" } },
    { originalAmount: { currencyCode: 643, value: "10050" } },
    ...Object.keys(paid).map((key) => ({ [key]: undefined })),
  ]) {
    assert.equal(validateOzonPaySettlement({ ...paid, ...change }, expected).valid, false);
  }
  assert.equal(validateOzonPaySettlement({}, expected).valid, false);
  assert.equal(validateOzonPaySettlement(null, expected).valid, false);
});

test("settlement compares canonical positive safe minor units exactly", () => {
  for (const value of [
    "10051", "10050.0", "10050.5", "-10050", "0", "9007199254740992",
    "1e4", " 10050 ", "010050", "+10050", "", null, undefined, 10050,
  ]) {
    assert.deepEqual(validateOzonPaySettlement({
      ...paid, originalAmount: { currencyCode: "643", value },
    }, expected), { valid: false, reason: "AMOUNT_MISMATCH" });
  }
  for (const amountKopecks of [0, -1, 10050.5, 9007199254740992, "10050"]) {
    assert.deepEqual(validateOzonPaySettlement(paid, { ...expected, amountKopecks }), {
      valid: false, reason: "INVALID_EXPECTATIONS",
    });
  }
});

test("notification fixture and both UID spellings preserve the documented signed fields", (t) => {
  const keys = {
    OZON_PAY_ACCESS_KEY: "1fac5a70-0ec4-4963-a33a-040ea301ea85",
    OZON_PAY_SECRET_KEY: "unused-fixture-secret",
    OZON_PAY_NOTIFICATION_SECRET_KEY: "4qEzUJjBoCXwA6P5NMyrJJUdA6xsnvbV",
  };
  for (const [key, value] of Object.entries(keys)) {
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
  const event = {
    orderID: "69f37767-8a8b-4de1-a601-384387aea8c4",
    extOrderID: "",
    transactionID: 6981437,
    transactionUID: "ignored-when-integer-is-present",
    amount: 52569,
    currencyCode: "643",
    status: "Rejected",
    requestSign: "ae3c635dd72ec6b2c7833aa7458d57827895a57d4c35fba0e7dcb48f1d367d5f",
  };
  assert.equal(createOzonPayNotificationSign(event), event.requestSign);
  assert.equal(verifyOzonPayNotification(event), true);
  assert.equal(verifyOzonPayNotification({ ...event, status: "Completed", operationType: "Payment", testMode: 0 }), true);
  assert.equal(verifyOzonPayNotification({ ...event, amount: 52570 }), false);
  assert.equal(verifyOzonPayNotification({ ...event, requestSign: "0".repeat(64) }), false);
  assert.equal(verifyOzonPayNotification({ ...event, requestSign: 123 }), false);
  const uidSignature = sha256(
    `${keys.OZON_PAY_ACCESS_KEY}|${event.orderID}|fixture-uid|заказ|52569|643|${keys.OZON_PAY_NOTIFICATION_SECRET_KEY}`,
  );
  for (const key of ["transactionUID", "transactionUid"]) {
    assert.equal(verifyOzonPayNotification({
      ...event, extOrderID: "заказ", transactionID: null, transactionUID: undefined,
      [key]: "fixture-uid", requestSign: uidSignature,
    }), true);
  }
});
