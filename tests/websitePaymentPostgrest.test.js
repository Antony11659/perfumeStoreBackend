import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";

// Run explicitly with RUN_PAYMENT_POSTGREST_TEST=1. No application modules or dotenv are loaded.
test("website payment over disposable PostgREST", {
  skip: process.env.RUN_PAYMENT_POSTGREST_TEST !== "1",
  timeout: 120_000,
}, async (t) => {
  const root = new URL("../", import.meta.url);
  const read = (file) => readFileSync(new URL(file, root), "utf8");
  const postgresImage = "postgres:16-alpine";
  const postgrestImage = "postgrest/postgrest:v12.2.3";
  const name = `ldp-step17-${randomUUID().slice(0, 12)}`;
  const network = `${name}-net`;
  const database = `${name}-db`;
  const api = `${name}-api`;
  const label = `ldp.step17=${name}`;
  const dbPassword = randomBytes(24).toString("hex");
  const jwtSecret = randomBytes(32).toString("hex");
  const docker = (args, input) => execFileSync("docker", ["--host", "unix:///var/run/docker.sock", ...args], {
    env: { PATH: process.env.PATH }, encoding: "utf8", input, timeout: 20_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  const sql = (statement) => docker([
    "exec", "-i", database, "psql", "-h", "/var/run/postgresql",
    "-U", "fixture_admin", "-d", "fixture", "-XAtq", "-v", "ON_ERROR_STOP=1",
  ], statement);
  const waitFor = async (description, check) => {
    const deadline = Date.now() + 20_000;
    let lastError;
    while (Date.now() < deadline) {
      try {
        return await check();
      } catch (error) {
        lastError = error;
        await delay(200);
      }
    }
    throw new Error(`${description}: ${lastError?.message}`);
  };
  const jwt = (role, secret = jwtSecret) => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role, exp: Math.floor(Date.now() / 1000) + 600 })}`;
    return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  };
  const ops = {
    reserve_website_order_payment_v1: { p_order_id: 101 },
    save_website_order_payment_v1: {
      p_order_id: 101, p_ozon_payment_id: "fixture-payment", p_payment_link: "https://example.invalid/fixture",
    },
    confirm_website_order_payment_v1: {
      p_order_id: 101, p_ozon_payment_id: "fixture-payment",
      p_order_number: "fixture-101", p_amount_kopecks: 125045,
    },
  };
  const [reserve, save, confirm] = Object.keys(ops);
  const projection = "id,order_number,total::text,status,payment_state,ozon_payment_id";
  assert.ok(read("src/modules/website/websiteOrdersService.js").includes(`.select("${projection}")`));
  const fixture = read("tests/websitePaymentReservation.test.py").match(/^FIXTURE = """\n([\s\S]+?)^"""/m)?.[1];
  assert.ok(fixture, "existing disposable PostgreSQL schema fixture");

  let networkCreated = false;
  try {
    docker(["image", "inspect", "--format", "{{.Architecture}}", postgresImage, postgrestImage]
    ).split("\n").forEach((arch) => assert.equal(arch, "arm64"));
    docker(["network", "create", "--label", label, network]);
    networkCreated = true;
    docker(["run", "-d", "--pull=never", "--name", database, "--label", label, "--network", network,
      "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_USER=fixture_admin",
      "-e", "POSTGRES_DB=fixture", "-e", `POSTGRES_PASSWORD=${dbPassword}`,
      postgresImage]);
    await waitFor("PostgreSQL readiness", () => docker([
      "exec", database, "pg_isready", "-h", "127.0.0.1", "-U", "fixture_admin", "-d", "fixture",
    ]));
    const dbVersion = sql("SHOW server_version;");
    sql(fixture);
    for (const migration of [
      "20261116000000_website_order_idempotency.sql",
      "20261118000000_website_payment_reservation.sql",
    ]) {
      sql(read(`supabase/migrations/${migration}`));
    }
    sql(`
      CREATE ROLE fixture_authenticator LOGIN NOINHERIT PASSWORD '${dbPassword}';
      GRANT anon, authenticated, service_role TO fixture_authenticator;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      -- Exercise RLS with a permitted SELECT and no visible rows for browser roles.
      GRANT SELECT (id) ON public.website_orders TO anon, authenticated;
      INSERT INTO public.website_orders (id, order_number, total, status)
      VALUES (101, 'fixture-101', 1250.45, 'new'), (102, 'fixture-102', 2490.00, 'new'),
        (103, 'fixture-103', 0.01, 'new'), (104, 'fixture-104', 999999.99, 'paid'),
        (105, 'fixture-105', 1250.451, 'new'), (106, 'fixture-106', 10, 'new'),
        (9007199254740993, 'bigint-probe', 10, 'new');
    `);
    docker(["run", "-d", "--pull=never", "--name", api, "--label", label, "--network", network,
      "-p", "127.0.0.1::3000", "-e", "PGRST_SERVER_HOST=0.0.0.0",
      "-e", `PGRST_DB_URI=postgres://fixture_authenticator:${dbPassword}@${database}:5432/fixture`,
      "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon",
      "-e", `PGRST_JWT_SECRET=${jwtSecret}`, postgrestImage]);
    const binding = docker(["port", api, "3000/tcp"]);
    assert.match(binding, /^127\.0\.0\.1:[0-9]+$/);
    const origin = `http://${binding}`;
    assert.equal(docker(["inspect", "--format", "{{json .HostConfig.PortBindings}}", database]), "{}");
    const mounts = JSON.parse(docker(["inspect", "--format", "{{json .Mounts}}", database]));
    assert.ok(!mounts.some(({ Type }) => Type === "volume" || Type === "bind"));
    const guard = async (input, options) => {
      assert.equal(new URL(typeof input === "string" ? input : input.url).origin, origin);
      return fetch(input, { ...options, redirect: "error" });
    };
    const rest = (path, role) => guard(`${origin}/${path}`, {
      headers: role ? { Authorization: `Bearer ${jwt(role)}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    await waitFor("PostgREST readiness", async () => {
      const response = await rest("website_orders?select=id&limit=1", "service_role");
      assert.equal(response.status, 200, await response.text());
    });
    const apiVersion = docker(["exec", api, "postgrest", "--version"]);
    t.diagnostic(`Docker ${docker(["version", "--format", "{{.Server.Version}} {{.Server.Arch}}"])}; PostgreSQL ${dbVersion}; ${apiVersion}; HTTP ${binding}`);

    const client = (role, key = jwt(role)) => createClient(origin, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, options) => {
        const url = new URL(input);
        // Supabase's gateway adds /rest/v1. PostgREST itself serves the same API at /.
        assert.equal(url.origin, origin);
        assert.ok(url.pathname.startsWith("/rest/v1/"), `Unexpected Supabase path: ${url.pathname}`);
        url.pathname = url.pathname.slice("/rest/v1".length);
        return guard(url.href, options);
      } },
    });
    const service = client("service_role");
    const rpc = (name, args = {}) => service.rpc(name, { ...ops[name], ...args }).abortSignal(AbortSignal.timeout(5000));
    const query = (column, id) => service.from("website_orders").select(projection)
      .eq(column, id).abortSignal(AbortSignal.timeout(5000)).maybeSingle();
    const data = ({ data, error }) => {
      assert.equal(error, null, JSON.stringify(error));
      return data;
    };

    // Check effective privileges before executing payment operations.
    const permissions = sql(`
      SELECT proname, has_function_privilege('anon', oid, 'EXECUTE'),
        has_function_privilege('authenticated', oid, 'EXECUTE'),
        has_function_privilege('service_role', oid, 'EXECUTE'),
        EXISTS (SELECT 1 FROM aclexplode(coalesce(proacl, acldefault('f', proowner)))
                WHERE grantee = 0 AND privilege_type = 'EXECUTE')
      FROM pg_proc WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('${Object.keys(ops).join("','")}') ORDER BY proname;
    `);
    assert.deepEqual(permissions.split("\n"), Object.keys(ops).sort().map((name) => `${name}|f|f|t|f`));
    assert.equal(sql("SELECT has_schema_privilege('service_role', 'public', 'USAGE');"), "t");
    for (const role of ["anon", "authenticated"]) {
      const denied = client(role);
      assert.deepEqual(data(await denied.from("website_orders").select("id")), []);
      for (const [name, args] of Object.entries(ops)) {
        const response = await denied.rpc(name, args);
        assert.equal(response.data, null);
        assert.equal(response.error?.code, "42501");
        assert.equal(response.status, role === "anon" ? 401 : 403);
      }
    }
    t.diagnostic("Permissions: service_role has schema USAGE and EXECUTE for all 3 RPCs; PUBLIC lacks EXECUTE; all anon calls 401/42501, authenticated calls 403/42501; RLS hides order rows.");
    const badJwt = await client("service_role", jwt("service_role", "wrong-fixture-key"))
      .from("website_orders").select("id");
    assert.equal(badJwt.status, 401);

    const expectedTotals = ["1250.45", "2490.00", "0.01", "999999.99", "1250.451"];
    const http = await rest(`website_orders?select=${encodeURIComponent(projection)}&id=gte.101&id=lte.105&order=id`, "service_role");
    assert.equal(http.status, 200);
    assert.deepEqual((await http.json()).map((row) => row.total), expectedTotals);
    for (const [index, total] of expectedTotals.entries()) {
      const row = data(await query("id", 101 + index));
      assert.equal(row.total, total);
      assert.equal(typeof row.id, "number");
    }
    assert.equal(data(await query("order_number", "fixture-101")).total, "1250.45");
    assert.equal(data(await query("id", -1)), null);
    const missingSingle = await service.from("website_orders").select(projection).eq("id", -1).single();
    assert.equal(missingSingle.status, 406);
    assert.equal(missingSingle.error?.code, "PGRST116");
    const bigintHTTP = await rest("website_orders?select=id&order_number=eq.bigint-probe", "service_role");
    assert.equal(bigintHTTP.status, 200);
    assert.match(await bigintHTTP.text(), /"id":9007199254740993/);
    const bigint = data(await query("order_number", "bigint-probe")).id;
    assert.equal(bigint, 9007199254740992);
    assert.equal(Number.isSafeInteger(bigint), false);
    t.diagnostic(`Projection HTTP 200: ${JSON.stringify(expectedTotals)} (all strings); bigint raw JSON is numeric, JS rounds 9007199254740993 to ${bigint}; .maybeSingle missing returns null, .single missing 406/PGRST116.`);

    // A fixture function makes a real HTTP request exceed its deadline.
    sql(`
      CREATE FUNCTION public.fixture_slow_read() RETURNS integer LANGUAGE sql AS
      'SELECT 1 FROM pg_sleep(1)';
      REVOKE EXECUTE ON FUNCTION public.fixture_slow_read() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.fixture_slow_read() TO service_role;
      NOTIFY pgrst, 'reload schema';
    `);
    await waitFor("fixture function schema reload", async () => {
      const response = await service.rpc("fixture_slow_read").abortSignal(AbortSignal.timeout(2000));
      assert.equal(data(response), 1);
    });
    const timedOut = await service.rpc("fixture_slow_read").abortSignal(AbortSignal.timeout(50));
    assert.equal(timedOut.status, 0);
    assert.match(timedOut.error?.message, /timeout/i);
    t.diagnostic("Supabase client timeout: status 0 with a controlled timeout error.");

    const reservation = data(await rpc(reserve));
    assert.deepEqual(reservation, [{ id: 101, total: 1250.45, order_number: "fixture-101", payment_state: "reserved" }]);
    for (const id of [101, 104, -1]) assert.deepEqual(data(await rpc(reserve, { p_order_id: id })), []);
    const invalid = await rpc(reserve, { p_order_id: "invalid" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.error?.code, "22P02");
    t.diagnostic(`Reservation response: ${JSON.stringify(reservation)}; repeat, paid and absent return []; malformed ID 400/22P02.`);

    const saved = data(await rpc(save));
    assert.deepEqual(saved, [{
      ...reservation[0], payment_state: "ready", ozon_payment_id: ops[save].p_ozon_payment_id,
      payment_link: ops[save].p_payment_link,
    }]);
    assert.deepEqual(data(await rpc(save)), []);
    assert.deepEqual(data(await rpc(save, { p_ozon_payment_id: "other-provider" })), []);
    assert.equal(data(await service.from("website_orders").select("payment_link").eq("id", 101).single()).payment_link,
      ops[save].p_payment_link);
    assert.equal(data(await rpc(reserve, { p_order_id: 102 })).length, 1);
    const duplicateId = await rpc(save, { p_order_id: 102 });
    assert.equal(duplicateId.status, 409);
    assert.equal(duplicateId.error?.code, "23505");
    const unchanged = data(await query("id", 102));
    assert.equal(unchanged.payment_state, "reserved");
    assert.equal(unchanged.ozon_payment_id, null);
    assert.equal(data(await service.from("website_orders").select("payment_link").eq("id", 102).single()).payment_link, null);
    const malformedSave = await rpc(save, { p_order_id: "invalid" });
    assert.equal(malformedSave.status, 400);
    assert.equal(malformedSave.data, null);
    t.diagnostic(`Payment save response: ${JSON.stringify(saved)}; repeat/conflict return []; duplicate provider 409/23505; malformed save 400 with null data.`);

    for (const args of [
      { p_ozon_payment_id: "other" }, { p_order_number: "other" }, { p_amount_kopecks: 125046 },
    ]) assert.deepEqual(data(await rpc(confirm, args)), []);
    assert.equal(data(await query("id", 101)).payment_state, "ready");
    for (const id of [105, 106]) {
      assert.equal(data(await rpc(reserve, { p_order_id: id })).length, 1);
      assert.equal(data(await rpc(save, { p_order_id: id, p_ozon_payment_id: `provider-${id}` })).length, 1);
    }
    sql("UPDATE public.website_orders SET status = 'cancelled' WHERE id = 106;");
    for (const [id, amount] of [[105, 125045], [106, 1000]]) {
      assert.deepEqual(data(await rpc(confirm, {
        p_order_id: id, p_order_number: `fixture-${id}`, p_ozon_payment_id: `provider-${id}`,
        p_amount_kopecks: amount,
      })), []);
    }
    assert.equal(data(await query("id", 105)).payment_state, "ready");
    assert.equal(data(await query("id", 106)).status, "cancelled");
    const settled = data(await rpc(confirm));
    assert.deepEqual(settled, [{
      id: 101, order_number: "fixture-101", total: 1250.45,
      status: "paid", payment_state: "confirmed", ozon_payment_id: ops[confirm].p_ozon_payment_id,
    }]);
    assert.deepEqual(data(await rpc(confirm)), []);
    assert.deepEqual(data(await query("id", 101)), { ...settled[0], total: "1250.45" });
    t.diagnostic(`Settlement response: ${JSON.stringify(settled)}; durable readback matches; replay, mismatches, fractional total and cancellation return [].`);

    const stage2Args = { p_key: "00000000-0000-4000-8000-000000000001", p_hash: "a".repeat(64) };
    const persist = (p_prepared) => service.rpc("persist_website_order_v1", { ...stage2Args, p_prepared });
    assert.deepEqual(data(await persist(null)), { outcome: "ready" });
    const created = data(await persist({
      order: { order_number: "stage-2-fixture", pricing_mode: "website", subtotal: 100, delivery_price: 0, total: 100 },
      items: [{ variant_id: 1, quantity: 1, unit_price: 100, line_total: 100 }],
      delivery: { provider: "ozon", delivery_type: "pvz" },
    }));
    assert.equal(created.outcome, "created");
    assert.deepEqual(created.response, { success: true, order: {
      id: created.response.order.id, orderNumber: "stage-2-fixture", pricingMode: "website",
      subtotal: 100, deliveryPrice: 0, total: 100, status: "new",
    } });
    assert.deepEqual(data(await persist(null)), { outcome: "completed", response: created.response });
    assert.equal(sql(`
      SELECT (ROW(payment_state, ozon_payment_id, payment_link) IS NULL)::int
      FROM public.website_orders WHERE order_number = 'stage-2-fixture';
    `), "1");
    t.diagnostic(`Stage 2 stored response: ${JSON.stringify(created.response)}; replay identical; payment columns NULL.`);
  } finally {
    // Discover only our own labeled containers, including one created before a failed start.
    const owned = docker(["ps", "-aq", "--filter", `label=${label}`]).split("\n").filter(Boolean);
    if (owned.length) docker(["rm", "-fv", ...owned]);
    if (networkCreated) docker(["network", "rm", network]);
    assert.equal(docker(["ps", "-aq", "--filter", `label=${label}`]), "");
    assert.equal(docker(["network", "ls", "-q", "--filter", `label=${label}`]), "");
    t.diagnostic(`Cleanup verified for ${name}; database storage was tmpfs.`);
  }
});
