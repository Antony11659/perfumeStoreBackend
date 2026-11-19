import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";

const modules = new URL("../src/modules/", import.meta.url);
const source = (path) => readFile(new URL(path, modules), "utf8");
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const featureUrl = moduleUrl(`
  const process = { env: { WEBSITE_OZON_PAY_ENABLED: "true" } };
  ${await source("website/websitePaymentFeature.js")}
`);
const providerId = "fixture-payment";
const payLink = "https://payments.example.invalid/fixture";
const providerOrder = { id: providerId, payLink, status: "created", isTestMode: true };
const reserved = { id: 123, order_number: "LDP-123", total: "1250.45", payment_state: "reserved" };
const saved = {
  ...reserved,
  id: String(reserved.id),
  total: "1250.4500",
  payment_state: "ready",
  ozon_payment_id: providerId,
  payment_link: payLink,
};
const result = (...rows) => ({ data: rows, error: null });

const database = moduleUrl(`
  export const supabase = new Proxy({}, {
    get(_target, key) { return globalThis.websitePaymentPersistenceDatabase[key]; }
  });
`);
const delivery = moduleUrl(`
  export function calculateWebsiteOzonDelivery() { throw new Error("Unexpected delivery call"); }
`);
const payment = moduleUrl(`
  const process = { env: { OZON_PAY_ACCESS_KEY: "fixture", OZON_PAY_SECRET_KEY: "fixture" } };
  const fetch = (...args) => globalThis.websitePaymentPersistenceFetch(...args);
  ${await source("payment/ozon/ozonPayService.js")}
`);
const service = moduleUrl(`const process = { env: { OZON_PAY_EXPECTED_MODE: "test" } };\n` +
  (await source("website/websiteOrdersService.js"))
  .replace('"../../lib/supabase.js"', JSON.stringify(database))
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

async function setup(t, { status = "new", save = () => result(saved), ozonOrder = providerOrder } = {}) {
  const calls = [];
  let claimed = false;
  globalThis.websitePaymentPersistenceDatabase = {
    from(table) {
      assert.equal(table, "website_orders");
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { ...reserved, status }, error: null }),
          }),
        }),
      };
    },
    rpc(name, args) {
      calls.push(name);
      return {
        async abortSignal(signal) {
          assert.ok(signal instanceof AbortSignal);
          if (name === "reserve_website_order_payment_v1") {
            assert.deepEqual(args, { p_order_id: reserved.id });
            if (claimed) return result();
            claimed = true;
            return result(reserved);
          }
          assert.equal(name, "save_website_order_payment_v1");
          assert.deepEqual(args, {
            p_order_id: reserved.id,
            p_ozon_payment_id: providerId,
            p_payment_link: payLink,
          });
          return save();
        },
      };
    },
  };
  globalThis.websitePaymentPersistenceFetch = async (url, options) => {
    calls.push("Ozon");
    assert.equal(url, "https://payapi.ozon.ru/v1/createOrder");
    assert.equal(options.method, "POST");
    return Response.json({ order: ozonOrder });
  };

  const app = Fastify();
  t.after(async () => {
    await app.close();
    delete globalThis.websitePaymentPersistenceDatabase;
    delete globalThis.websitePaymentPersistenceFetch;
  });
  await app.register(routes);
  return { calls, pay: () => app.inject({ method: "POST", url: "/website/orders/123/payment",
      headers: { "x-website-payment-token": tokenUtility.issueWebsitePaymentAccessToken(reserved.id) },
    }) };
}

const attempt = ["reserve_website_order_payment_v1", "Ozon", "save_website_order_payment_v1"];

await test("Fastify waits for persistence and returns the existing payment response", async (t) => {
  const saving = Promise.withResolvers();
  const finishedSave = Promise.withResolvers();
  const harness = await setup(t, {
    save() {
      saving.resolve();
      return finishedSave.promise;
    },
  });
  let replied = false;
  const pending = harness.pay().then((response) => {
    replied = true;
    return response;
  });

  await Promise.race([saving.promise, pending]);
  try {
    assert.deepEqual(harness.calls, attempt);
    const retry = await harness.pay();
    assert.equal(retry.statusCode, 409);
    assert.equal(replied, false);
  } finally {
    finishedSave.resolve(result(saved));
  }
  const response = await pending;
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    success: true,
    payment: {
      orderId: 123, orderNumber: "LDP-123", amount: 1250.45,
      ozonPayOrderId: providerId, ozonPayStatus: "created", payLink, isTestMode: true,
    },
  });
  assert.deepEqual(harness.calls, [...attempt, attempt[0]]);
});

const failures = [
  ["zero rows", () => result()],
  ["unique constraint error alongside data", () => ({ data: [saved], error: { code: "23505" } })],
  ["timeout", () => { throw new DOMException("Save timed out", "TimeoutError"); }],
  ["missing response", () => undefined],
  ["malformed data", () => ({ data: saved, error: null })],
  ["multiple rows", () => result(saved, saved)],
  ["provider ID mismatch", () => result({ ...saved, ozon_payment_id: "different" })],
  ["payment link mismatch", () => result({ ...saved, payment_link: "different" })],
  ["order ID mismatch", () => result({ ...saved, id: 124 })],
  ["payment state mismatch", () => result({ ...saved, payment_state: "reserved" })],
  ["order number mismatch", () => result({ ...saved, order_number: "LDP-OTHER" })],
  ["total mismatch", () => result({ ...saved, total: "1250.46" })],
  ["fractional kopecks", () => result({ ...saved, total: "1250.4501" })],
];

for (const [name, save] of failures) {
  await test(`Fastify withholds the link after a save with ${name}`, async (t) => {
    const harness = await setup(t, { save });
    const response = await harness.pay();
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      success: false,
      message: "Website order payment persistence could not be confirmed",
    });
    assert.equal((await harness.pay()).statusCode, 409);
    assert.deepEqual(harness.calls, [...attempt, attempt[0]]);
  });
}

for (const fields of [{ id: " " }, { payLink: "" }]) {
  await test(`Fastify rejects invalid Ozon ${Object.keys(fields)[0]} before saving`, async (t) => {
    const harness = await setup(t, { ozonOrder: { ...providerOrder, ...fields } });
    assert.equal((await harness.pay()).statusCode, 502);
    assert.deepEqual(harness.calls, attempt.slice(0, 2));
  });
}

await test("Fastify rejects paid orders before either RPC or Ozon", async (t) => {
  const harness = await setup(t, { status: "paid" });
  const response = await harness.pay();
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { success: false, message: "Website order is already paid" });
  assert.deepEqual(harness.calls, []);
});

// Reuse the existing socket-only cluster, migration loading and Stage 2
// compatibility test. Python starts every PostgreSQL command with env={}.
test("Disposable PostgreSQL persistence", { timeout: 90000 }, () => {
  const output = execFileSync("python3", ["-B", "-c", String.raw`
import runpy
import subprocess
import sys
import time
import unittest

PaymentReservationTest = runpy.run_path(
    sys.argv[1] + "/websitePaymentReservation.test.py"
)["PaymentReservationTest"]


class PaymentPersistenceTest(PaymentReservationTest):
    @staticmethod
    def save_sql(order_id, provider_id="provider", link="https://payments.example.invalid/1"):
        return ("SELECT * FROM public.save_website_order_payment_v1("
                f"{order_id}, '{provider_id}', '{link}');")

    def save(self, order_id, *args):
        return self.query("SET ROLE service_role; " + self.save_sql(order_id, *args))

    def reserved(self, number):
        order_id = self.seed(number)
        self.assertEqual(self.claim(order_id), f"{order_id}|{number}|1250.45|reserved")
        return order_id

    def stored(self, order_id):
        return self.query(
            "SELECT status, payment_state, ozon_payment_id, payment_link "
            f"FROM public.website_orders WHERE id = {order_id}"
        )

    def test_save_atomic_transition(self):
        order_id = self.reserved("save-normal")
        self.assertEqual(self.save(order_id),
                         f"{order_id}|save-normal|1250.45|ready|provider|https://payments.example.invalid/1")
        self.assertEqual(self.stored(order_id), "new|ready|provider|https://payments.example.invalid/1")

    def test_save_requires_reservation(self):
        order_id = self.seed("save-unreserved")
        self.assertEqual(self.save(order_id), "")
        self.assertEqual(self.stored(order_id), "new|||")

    def test_save_rejects_paid_even_if_reserved(self):
        order_id = self.reserved("save-paid")
        self.query(f"UPDATE public.website_orders SET status = 'paid' WHERE id = {order_id}")
        self.assertEqual(self.save(order_id), "")
        self.assertEqual(self.stored(order_id), "paid|reserved||")

    def test_save_rejects_blank_values_and_preserves_reservation(self):
        order_id = self.reserved("save-blank")
        self.assertEqual(self.save(order_id, " ", "https://payments.example.invalid"), "")
        self.assertEqual(self.save(order_id, "valid", "\t"), "")
        self.assertEqual(self.stored(order_id), "new|reserved||")

    def test_save_replays_and_conflicts_cannot_overwrite(self):
        order_id = self.reserved("save-conflicts")
        link = "https://payments.example.invalid/original"
        self.assertTrue(self.save(order_id, "original", link))
        for provider_id, payment_link in [
            ("original", link),
            ("different", link),
            ("original", "https://payments.example.invalid/different"),
        ]:
            with self.subTest(provider_id=provider_id, link=payment_link):
                self.assertEqual(self.save(order_id, provider_id, payment_link), "")
                self.assertEqual(self.stored(order_id), f"new|ready|original|{link}")

    def test_save_provider_id_is_unique(self):
        first = self.reserved("save-unique-first")
        second = self.reserved("save-unique-second")
        self.assertTrue(self.save(first, "unique"))
        with self.assertRaisesRegex(RuntimeError, "23505"):
            self.run_tool(*self.psql, "-v", "VERBOSITY=verbose", "-c",
                          "SET ROLE service_role; " + self.save_sql(second, "unique"))
        self.assertEqual(self.stored(first), "new|ready|unique|https://payments.example.invalid/1")
        self.assertEqual(self.stored(second), "new|reserved||")

    def test_save_concurrent_conflicts_cannot_overwrite(self):
        order_id = self.reserved("save-concurrent")
        contender_sql = ("/* payment_save_contender */ SET statement_timeout = '8s'; "
                         "SET ROLE service_role; " + self.save_sql(order_id, "loser"))
        with subprocess.Popen(self.psql, env={}, text=True, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE) as first:
            try:
                first.stdin.write("BEGIN; SET LOCAL statement_timeout = '8s'; SET ROLE service_role; "
                                  + self.save_sql(order_id, "winner") + "\n")
                first.stdin.flush()
                self.assertEqual(first.stdout.readline().strip(),
                                 f"{order_id}|save-concurrent|1250.45|ready|winner|https://payments.example.invalid/1")
                self.assertEqual(self.stored(order_id), "new|reserved||")
                with subprocess.Popen([*self.psql, "-c", contender_sql], env={}, text=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE) as second:
                    try:
                        deadline = time.monotonic() + 5
                        while time.monotonic() < deadline:
                            if self.query(
                                "SELECT count(*) FROM pg_stat_activity "
                                "WHERE query LIKE '/* payment_save_contender */%' AND wait_event_type = 'Lock'"
                            ) == "1":
                                break
                            self.assertIsNone(second.poll(), "Contender exited before waiting on the save")
                            time.sleep(0.02)
                        else:
                            self.fail("PostgreSQL never reported the contender waiting on the save")
                        _, errors = first.communicate("COMMIT;\n", timeout=5)
                        self.assertEqual(first.returncode, 0, errors)
                        output, errors = second.communicate(timeout=5)
                        self.assertEqual(second.returncode, 0, errors)
                        self.assertEqual(output.strip(), "")
                    finally:
                        if second.poll() is None:
                            second.kill()
            finally:
                if first.poll() is None:
                    first.kill()
        self.assertEqual(self.stored(order_id), "new|ready|winner|https://payments.example.invalid/1")

suite = unittest.defaultTestLoader.loadTestsFromTestCase(PaymentPersistenceTest)
sys.exit(not unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(suite).wasSuccessful())
`, fileURLToPath(new URL(".", import.meta.url))], { encoding: "utf8", timeout: 85000 });
  for (const line of output.trimEnd().split("\n")) {
    if (line) console.log(line);
  }
});
