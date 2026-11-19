import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

const modules = new URL("../src/modules/", import.meta.url);
const source = (path) => readFile(new URL(path, modules), "utf8");
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const tokenHeader = "x-website-payment-token";
const initPath = "/website/orders/{orderId}/payment";
const statusPath = "/website/orders/{orderId}/payment-status";
const webhookPath = "/website/payments/ozon/notification";
const secrets = {
  WEBSITE_PAYMENT_TOKEN_SECRET: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  OZON_PAY_ACCESS_KEY: "fixture-access",
  OZON_PAY_SECRET_KEY: "fixture-secret",
  OZON_PAY_NOTIFICATION_SECRET_KEY: "fixture-notification",
};
const payment = {
  orderId: 123, orderNumber: "LDP-FIXTURE", amount: 24.9, ozonPayOrderId: "fixture-provider",
  ozonPayStatus: "STATUS_PAYMENT_PENDING", payLink: "https://example.invalid/fixture", isTestMode: false,
};
const fixtureModule = async (path, prefix = "") => moduleUrl(
  `const process = { env: ${JSON.stringify(secrets)} };\n${prefix}\n${await source(path)}`
);
const token = await fixtureModule("website/websitePaymentAccessToken.js");
const provider = await fixtureModule("payment/ozon/ozonPayService.js",
  "const fetch = () => { throw Error('External network forbidden'); };");
const feature = moduleUrl(`
  const process = { env: { WEBSITE_OZON_PAY_ENABLED: "true" } };
  ${await source("website/websitePaymentFeature.js")}
`);
const service = moduleUrl(`
  export const createWebsiteOrderPayment = (id) => globalThis.ozonSwaggerFixture.create(id);
  export const getWebsiteOrderPaymentStatus = (id) => globalThis.ozonSwaggerFixture.status(id);
  export const markWebsiteOrderPaidFromOzon = (data) => globalThis.ozonSwaggerFixture.notify(data);
`);
const { issueWebsitePaymentAccessToken } = await import(token);
const { createOzonPayNotificationSign } = await import(provider);
const { default: routes } = await import(moduleUrl((await source("website/websitePaymentRoutes.js"))
  .replace('"./websitePaymentFeature.js"', JSON.stringify(feature))
  .replace('"./websitePaymentAccessToken.js"', JSON.stringify(token))
  .replace('"../payment/ozon/ozonPayService.js"', JSON.stringify(provider))
  .replace('"./websiteOrdersService.js"', JSON.stringify(service))));

async function setup(t) {
  const app = Fastify();
  const calls = [];
  const fixture = globalThis.ozonSwaggerFixture = {
    create(id) { assert.equal(id, payment.orderId); return payment; },
    status(id) { assert.equal(id, payment.orderId); return "pending"; },
    notify(data) { calls.push(data); },
  };
  t.after(async () => {
    await app.close();
    delete globalThis.ozonSwaggerFixture;
  });
  await app.register(swagger, { openapi: { openapi: "3.0.3", info: { title: "Fixture", version: "1" } } });
  await app.register(swaggerUi, { routePrefix: "/documentation" });
  await app.register(routes);
  const docs = await app.inject("/documentation/json");
  assert.equal(docs.statusCode, 200);
  return { app, docs, calls, fixture };
}

const jsonSchema = (response) => response.content["application/json"].schema;

test("OpenAPI describes all three payment routes without disclosing capabilities or payment links", async (t) => {
  const { docs } = await setup(t);
  const { paths } = docs.json();
  const create = paths[initPath].post;
  const webhook = paths[webhookPath].post;
  const status = paths[statusPath].get;
  for (const endpoint of [create, webhook, status]) assert.deepEqual(endpoint.tags, ["Website Payments"]);

  assert.equal(create.summary, "Create Ozon Pay payment for website order");
  assert.match(create.description, /empty request body/);
  assert.match(create.description, /reserves payment creation atomically/);
  assert.match(create.description, /A link does not confirm payment/);
  assert.equal(create.requestBody, undefined);
  const creationId = create.parameters.find((p) => p.name === "orderId");
  assert.equal(creationId.in, "path");
  assert.equal(creationId.required, true);
  assert.equal(creationId.schema.minimum, 1);
  assert.equal(creationId.schema.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(creationId.schema.type, "integer");
  for (const endpoint of [create, status]) {
    const header = endpoint.parameters.find((p) => p.name === tokenHeader);
    assert.equal(header.in, "header");
    assert.equal(header.required, true);
  }
  assert.deepEqual(Object.keys(create.responses), ["200", "400", "401", "403", "404", "409", "500", "502", "503"]);
  assert.match(create.responses["503"].description, /disabled/);
  assert.match(create.responses["502"].description, /unexpected payment environment/);
  assert.equal(jsonSchema(create.responses["200"]).properties.payment.properties.amount.type, "number");
  assert.match(jsonSchema(create.responses["200"]).properties.payment.properties.amount.description, /rubles/);
  assert.deepEqual(Object.keys(jsonSchema(create.responses["200"]).properties.payment.properties), Object.keys(payment));
  for (const [code, response] of Object.entries(create.responses)) {
    if (code !== "200") assert.deepEqual(jsonSchema(response).required, ["success", "message"]);
  }

  assert.equal(webhook.summary, "Receive Ozon Pay transaction notification");
  assert.match(webhook.description, /authenticated Ozon order status/);
  assert.match(webhook.description, /does not create shipments/);
  assert.ok(!webhook.parameters?.some((p) => p.name === tokenHeader));
  assert.equal(webhook.security, undefined);
  assert.equal(webhook.requestBody.required, true);
  const body = jsonSchema(webhook.requestBody);
  assert.deepEqual(body.required, ["orderID", "extOrderID", "amount", "currencyCode", "requestSign"]);
  assert.deepEqual(body.anyOf.map((variant) => variant.required), [["transactionID"], ["transactionUID"], ["transactionUid"]]);
  assert.equal(body.properties.transactionID.deprecated, true);
  assert.equal(body.properties.amount.minimum, 1);
  assert.equal(body.properties.amount.type, "integer");
  assert.deepEqual(body.properties.currencyCode.enum, ["643"]);
  assert.deepEqual(body.properties.testMode.enum, [0, 1]);
  assert.equal(body.properties.requestSign.pattern, "^[a-f0-9]{64}$");
  assert.deepEqual(Object.keys(webhook.responses), ["200", "400", "401", "404", "409", "503"]);
  for (const [code, response] of Object.entries(webhook.responses)) {
    assert.deepEqual(jsonSchema(response).required, ["success"]);
    assert.deepEqual(jsonSchema(response).properties.success.enum, [code === "200"]);
  }
  assert.match(webhook.responses["503"].description, /Redelivery is not guaranteed/);

  assert.equal(status.summary, "Get website order payment status");
  assert.match(status.description, /reconcile/);
  assert.deepEqual(Object.keys(status.responses), ["200", "400", "401", "403", "404", "409", "503"]);
  assert.deepEqual(jsonSchema(status.responses["200"]).properties.paymentStatus.enum,
    ["paid", "not_started", "pending", "processing", "recovery_required", "unavailable"]);
  for (const value of [...Object.values(secrets), issueWebsitePaymentAccessToken(123), payment.payLink, "https://checkout.ozon.ru/"]) {
    assert.ok(!docs.body.includes(value));
  }
});

test("existing payment response serialization keeps the entire success payload and optional provider status", async (t) => {
  const { app, fixture } = await setup(t);
  const headers = { [tokenHeader]: issueWebsitePaymentAccessToken(123) };
  const send = () => app.inject({ method: "POST", url: initPath.replace("{orderId}", "123"), headers });
  const response = await send();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { success: true, payment });
  const { ozonPayStatus: _omitted, ...withoutStatus } = payment;
  fixture.create = () => withoutStatus;
  const optional = await send();
  assert.equal(optional.statusCode, 200);
  assert.deepEqual(optional.json(), { success: true, payment: withoutStatus });
});

test("webhook docs do not coerce signed fields, add authentication, or change acknowledgements", async (t) => {
  const { app, calls, fixture } = await setup(t);
  const event = { orderID: "fixture-provider", extOrderID: "LDP-FIXTURE", amount: 2490, currencyCode: "643" };
  const send = (fields, sign = true) => {
    const payload = { ...event, ...fields };
    if (sign) payload.requestSign = createOzonPayNotificationSign(payload);
    return app.inject({ method: "POST", url: webhookPath, payload });
  };
  for (const fields of [
    { transactionID: 0, transactionUID: "ignored-uid" },
    { transactionID: null, transactionUID: "fixture-uid", additionalProviderField: { value: 1 } },
    { transactionUid: "fixture-alternate", transactionUID: null, status: "Completed", operationType: "Payment", testMode: 0 },
    { transactionUid: "fixture-alternate", testMode: "unsigned and ignored" },
  ]) {
    const response = await send(fields);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { success: true });
  }
  assert.deepEqual(calls, Array(4).fill(event));
  for (const fields of [{ transactionID: "7" }, { transactionUID: "fixture-uid", amount: "2490" }, {}]) {
    const response = await send(fields);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { success: false });
  }
  const invalid = await send({ transactionUid: "fixture-alternate" }, false);
  assert.equal(invalid.statusCode, 401);
  assert.deepEqual(invalid.json(), { success: false });
  assert.equal(calls.length, 4);
  for (const [errorStatus, expected] of [[400, 400], [404, 404], [409, 409], [500, 503], [503, 503]]) {
    fixture.notify = () => { throw Object.assign(new Error("private fixture failure"), { statusCode: errorStatus }); };
    const response = await send({ transactionUID: "fixture-uid" });
    assert.equal(response.statusCode, expected);
    assert.deepEqual(response.json(), { success: false });
  }
});
