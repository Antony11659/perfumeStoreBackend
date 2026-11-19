import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// Published test vector credentials from the supplied Acquiring API 1.0.0 reference.
const accessKey = "63fd43a4-f16d-4c3a-9bdf-50f2328781db";
const secretKey = "PnHtbKc0lLiTlo4WITnWB44Qb1kpygRl";
const endpoint = "https://payapi.ozon.ru/v1/createOrder";
const input = { extId: "fixture-order", amountValue: "1000" };
const result = {
  order: {
    id: "fixture-provider-id", payLink: "https://example.invalid/private-payment",
    status: "STATUS_NEW", isTestMode: true,
  },
  extData: { fixture: "unchanged" },
};
const providerText = "fixture-private-provider-error";
const genericMessage = "Ozon Pay creation could not be confirmed";
const source = await readFile(new URL("../src/modules/payment/ozon/ozonPayService.js", import.meta.url), "utf8");
const fixtureSource = `
  const process = { env: ${JSON.stringify({
    OZON_PAY_ACCESS_KEY: accessKey, OZON_PAY_SECRET_KEY: secretKey,
  })} };
  ${source}
`;
const { createOzonPayOrder, createOzonPayCreateOrderSign } = await import(
  `data:text/javascript;base64,${Buffer.from(fixtureSource).toString("base64")}`
);

function mockHttp(t, respond) {
  const logs = t.mock.method(console, "error", () => {});
  const requests = [];
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return respond(options);
  });
  t.after(() => {
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(requests[0]?.url, endpoint);
  });
  return { logs, requests };
}

async function assertFailure(http, code, status) {
  await assert.rejects(createOzonPayOrder(input), (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, genericMessage);
    assert.equal(error.cause, undefined);
    const { requestSign } = JSON.parse(http.requests[0].options.body);
    const captured = [String(error), error.stack, JSON.stringify(error), JSON.stringify(http.logs.mock.calls.map((call) => call.arguments))].join(" ");
    for (const value of [accessKey, secretKey, requestSign, result.order.payLink, providerText]) {
      assert.ok(!captured.includes(value));
    }
    return true;
  });
  assert.deepEqual(http.logs.mock.calls.map((call) => call.arguments), [[
    "Ozon Pay createOrder failed", { code, ...(status === undefined ? {} : { status }) },
  ]]);
}

test("the supplied Ozon createOrder signing vector is unchanged", () => {
  assert.equal(createOzonPayCreateOrderSign({
    expiresAt: "2025-10-01T20:00:00.000Z", extId: "MyOrderID-1",
    fiscalizationType: "FISCAL_TYPE_SINGLE", paymentAlgorithm: "PAY_ALGO_SMS",
    currencyCode: "643", amountValue: "100",
  }), "406d29c45ffcb991eb40c3fbce98e714c1ed8963fee0024d7c3ba80dabc407bd");
});

test("successful createOrder keeps exact signed payload and response, with redirect rejection and five-second deadline", async (t) => {
  const now = Date.parse("2026-11-19T10:00:00.000Z");
  t.mock.method(Date, "now", () => now);
  const timeout = AbortSignal.timeout;
  const timeoutMock = t.mock.method(AbortSignal, "timeout", (ms) => timeout(ms));
  const http = mockHttp(t, () => Response.json(result));
  assert.deepEqual(await createOzonPayOrder(input), result);
  const request = http.requests[0].options;
  assert.equal(request.method, "POST");
  assert.deepEqual(request.headers, { "Content-Type": "application/json" });
  assert.equal(request.redirect, "error");
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(request.signal, timeoutMock.mock.calls[0].result);
  assert.deepEqual(timeoutMock.mock.calls.map((call) => call.arguments), [[5000]]);
  const expiresAt = "2026-11-19T10:30:00.000Z";
  const signature = createHash("sha256").update(
    `${accessKey}${expiresAt}fixture-orderFISCAL_TYPE_SINGLEPAY_ALGO_SMS6431000${secretKey}`, "utf8",
  ).digest("hex");
  assert.deepEqual(JSON.parse(request.body), {
    accessKey, amount: { currencyCode: "643", value: "1000" }, expiresAt,
    extId: "fixture-order", fiscalizationType: "FISCAL_TYPE_SINGLE",
    paymentAlgorithm: "PAY_ALGO_SMS", mode: "MODE_SHORTENED", enableFiscalization: false,
    successUrl: "https://ladeparfume.ru/payment-success",
    failUrl: "https://ladeparfume.ru/payment-failed", requestSign: signature,
  });
  assert.equal(http.logs.mock.callCount(), 0);
});

for (const duringBody of [false, true]) {
  test(`deadline while waiting for ${duringBody ? "the response body" : "response headers"} is sanitized and never retried`, async (t) => {
    const controller = new AbortController();
    t.mock.method(AbortSignal, "timeout", () => controller.signal);
    const abortRead = (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      queueMicrotask(() => controller.abort(new DOMException(providerText, "TimeoutError")));
    });
    const http = mockHttp(t, ({ signal }) => duringBody
      ? { ok: true, status: 200, json: () => abortRead(signal) }
      : abortRead(signal));
    await assertFailure(http, "OZON_PAY_TIMEOUT", duringBody ? 200 : undefined);
  });
}

test("connection failure and private underlying error are sanitized", async (t) => {
  const http = mockHttp(t, () => { throw new TypeError(providerText, { cause: new Error(secretKey) }); });
  await assertFailure(http, "OZON_PAY_NETWORK_ERROR");
});

test("fetch redirect rejection is an uncertain outcome with no redirected request", async (t) => {
  const http = mockHttp(t, ({ redirect }) => {
    assert.equal(redirect, "error");
    throw new TypeError("fetch failed", { cause: new Error(`unexpected redirect to ${result.order.payLink}`) });
  });
  await assertFailure(http, "OZON_PAY_NETWORK_ERROR");
});

for (const status of [302, 307, 400, 401, 403, 429, 500, 503]) {
  test(`HTTP ${status} is rejected without reading its private body or following Location`, async (t) => {
    const body = t.mock.fn(() => ({ message: providerText, ...result }));
    const http = mockHttp(t, () => ({
      ok: false, status, json: body,
      get headers() { assert.fail("HTTP error headers must not be inspected"); },
    }));
    await assertFailure(http, "OZON_PAY_HTTP_ERROR", status);
    assert.equal(body.mock.callCount(), 0);
  });
}

for (const [label, body] of [
  ["invalid JSON", `{${providerText}`],
  ["null JSON", "null"],
  ["primitive JSON", JSON.stringify(providerText)],
  ["array JSON", "[]"],
]) {
  test(`HTTP 200 with ${label} is rejected`, async (t) => {
    const http = mockHttp(t, () => new Response(body));
    await assertFailure(http, "OZON_PAY_INVALID_RESPONSE", 200);
  });
}

test("a non-timeout interrupted body read is sanitized", async (t) => {
  const http = mockHttp(t, () => ({
    ok: true, status: 200, json() { throw new TypeError(providerText); },
  }));
  await assertFailure(http, "OZON_PAY_INVALID_RESPONSE", 200);
});
