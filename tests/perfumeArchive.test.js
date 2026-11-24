import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import erpRoutes, { erpBearer } from "../src/modules/erp/erpRoutes.js";

const staff = { authorization: "Bearer fixture.staff.token" };
const other = { authorization: "Bearer fixture.other.token" };
const id = "9007199254740993";
const status = new Map([[id, false], ["2", true]]);
const rows = [
  { id, name: "Active sample", brand: { id: "560bc768-5813-444b-9238-3f852c06d578", name: "Brand", country: null },
    gender: "U", fragrance_family: null, variants: [], sku_counts: [], master: [], images: [], created_at: "2026-11-24", updated_at: "2026-11-24" },
  { id: "2", name: "архив sample", brand: { id: "560bc768-5813-444b-9238-3f852c06d578", name: "Brand", country: null },
    gender: "U", fragrance_family: null, variants: [], sku_counts: [], master: [], images: [], created_at: "2026-11-24", updated_at: "2026-11-24" },
];

function fixtureRows(filters) {
  return rows.map(row => ({
    ...row, is_archived: status.get(row.id), archived_at: status.get(row.id) ? "2026-11-24T12:00:00Z" : null,
  })).filter(row => Object.entries(filters).every(([field, value]) => field === "id" ? row.id === String(value) : row[field] === value));
}

function queryBuilder() {
  const filters = {};
  let head;
  const query = {
    select(projection, options) { head = options?.head; return query; },
    eq(column, value) { if (!column.includes(".")) filters[column] = value; return query; },
    order() { return query; },
    limit() { return query; },
    range() { return query; },
    maybeSingle() { return { data: fixtureRows(filters)[0] ?? null }; },
    then(resolve) { const items = fixtureRows(filters); return resolve({ data: head ? null : items, count: items.length }); },
  };
  return query;
}

test("archive and restore are staff-only and documented; status filters retain archived detail access", async t => {
  const app = Fastify();
  t.after(() => app.close());
  const calls = [];
  await app.register(swagger, { openapi: { info: { title: "Fixture", version: "1" }, components: { securitySchemes: { erpBearer } } } });
  await app.register(erpRoutes, { prefix: "/erp", getUser: async token => ({
    data: { user: { id: "fixture", app_metadata: { erp_staff: token === "fixture.staff.token" } } },
  }), db: {
    from: queryBuilder,
    async rpc(name, args) {
      assert.equal(name, "erp_set_perfume_archive_v1");
      calls.push(args);
      if (args.p_perfume_ids.some(key => !status.has(key))) return { error: { code: "PT404" } };
      let changed = 0;
      for (const key of args.p_perfume_ids) {
        if (status.get(key) !== args.p_archived) changed++;
        status.set(key, args.p_archived);
      }
      return { data: { changed } };
    },
  } });
  await app.ready();
  const write = (url, payload, headers = staff) => app.inject({ method: "POST", url, payload, headers });
  const read = query => app.inject({ url: "/erp/perfumes" + query, headers: staff });
  for (const [path, payload] of [[`/${id}/archive`], [`/${id}/restore`], ["/bulk-archive", { ids: [id] }]]) {
    assert.equal((await write("/erp/perfumes" + path, payload, {})).statusCode, 401);
    assert.equal((await write("/erp/perfumes" + path, payload, other)).statusCode, 403);
    const doc = app.swagger().paths["/erp/perfumes" + path.replace(id, "{id}")].post;
    assert.deepEqual(doc.security, [{ erpBearer: [] }]);
  }
  assert.equal(calls.length, 0);
  assert.equal((await write("/erp/perfumes/bulk-archive", { ids: [2] })).statusCode, 400);
  assert.equal((await write("/erp/perfumes/bulk-archive", { ids: [id, id] })).statusCode, 400);
  assert.equal((await write("/erp/perfumes/bulk-archive", { ids: [id, "3"] })).statusCode, 404);
  assert.deepEqual((await read("")).json().counts, { active: 1, archived: 1 });
  assert.deepEqual((await read("")).json().items.map(row => row.id), [id]);
  assert.deepEqual((await read("?status=archived")).json().items.map(row => row.id), ["2"]);
  assert.equal((await read("?status=all")).json().total, 2);
  assert.equal((await read("/2")).json().is_archived, true);
  assert.deepEqual((await write(`/erp/perfumes/${id}/archive`)).json(), { changed: 1 });
  assert.deepEqual((await write(`/erp/perfumes/${id}/archive`)).json(), { changed: 0 });
  assert.equal((await read("")).json().total, 0);
  assert.deepEqual((await write(`/erp/perfumes/${id}/restore`)).json(), { changed: 1 });
  assert.deepEqual((await write("/erp/perfumes/bulk-archive", { ids: [id, "2"] })).json(), { changed: 1 });
  status.set(id, false);
});

test("public perfume list and direct detail filter archive status and disable caching", async t => {
  const app = Fastify();
  t.after(() => app.close());
  const url = new URL("../src/modules/perfumes/perfumesRoutes.js", import.meta.url);
  const source = (await readFile(url, "utf8"))
    .replace('import { supabase } from "../../lib/supabase.js";', "const supabase = { from: globalThis.testPerfumeArchiveQuery };")
    .replace('"./perfumesSchemas.js"', JSON.stringify(new URL("./perfumesSchemas.js", url).href));
  globalThis.testPerfumeArchiveQuery = queryBuilder;
  t.after(() => { delete globalThis.testPerfumeArchiveQuery; });
  const { default: routes } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  await app.register(routes, { prefix: "/perfumes" });
  const catalog = await app.inject("/perfumes/");
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.headers["cache-control"], "no-store");
  assert.deepEqual(catalog.json().map(row => row.name), ["Active sample"]);
  status.set("2", false);
  assert.equal((await app.inject("/perfumes/2")).statusCode, 200);
  status.set("2", true);
  const hidden = await app.inject("/perfumes/2");
  assert.equal(hidden.statusCode, 404);
  assert.equal(hidden.headers["cache-control"], "no-store");
});
