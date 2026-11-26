import { createOzonClient } from "../ozon/ozonClient.js";
import { bigint, createSku, errorSchema, maxId, object, skuFailure, skuText, standardErrors, text, uuid, volume } from "./erpSkuRoutes.js";
import { compareProducts, fetchVisibleProducts, readComparison, readComparisonCatalog, readDetachedSkus, readShops } from "./skuMatchingService.js";

const nullable = schema => ({ ...schema, nullable: true });
const array = items => ({ type: "array", items });
const count = { type: "integer", minimum: 0 };
const flag = { type: "boolean" };
const stamps = nullable({ ...text, format: "date-time" });
const status = { ...text, enum: ["matched", "unmatched", "otherShop", "inactive", "archived", "ambiguous", "catalogConflict"] };
const stats = object({ total: count, matched: count, unmatched: count, conflicts: count, completion: { type: "number" } });
const shopSchema = object({
  id: uuid, name: text, marketplace: text, is_active: flag,
  state: { ...text, enum: ["notSynced", "syncing", "ready", "error", "unsupported"] },
  lastSync: stamps, stats: nullable(stats), message: nullable(text),
});
const suggestion = object({ perfumeId: nullable(bigint), perfumeName: nullable(text), brandName: nullable(text),
  volumeMl: nullable(volume), extractedVolume: nullable(count) });
const row = object({
  sku: skuText, name: text, offerId: nullable(text), imageUrl: nullable(text),
  status, suggestion: nullable(suggestion),
});
const batchRecord = object({ sku: skuText, perfume_id: bigint, volume_ml: volume });
const batchResult = object({ sku: skuText, status: { ...text, enum: ["registered", "alreadyRegistered", "conflict", "error"] },
  code: nullable(text), message: nullable(text), mappingId: nullable(uuid) });

export default async function erpMatchingRoutes(fastify, { db, ozonFactory = createOzonClient, registerRefresh }) {
  const snapshots = new Map();
  let queue = Promise.resolve();
  let comparisonRevision = 0;

  async function refreshComparisons() {
    const revision = ++comparisonRevision;
    const ready = [...snapshots].filter(([, entry]) => entry.state === "ready");
    if (!ready.length) return;
    const [mappings, perfumes, detached] = await readComparisonCatalog(db);
    if (revision !== comparisonRevision) return;
    for (const [shopId, entry] of ready) {
      if (snapshots.get(shopId) === entry) {
        entry.comparison = compareProducts(shopId, entry.products, mappings, perfumes, detached);
      }
    }
  }

  registerRefresh?.(refreshComparisons);

  function summary(shop) {
    const data = snapshots.get(shop.id);
    const supported = shop.marketplace.toLowerCase() === "ozon";
    return {
      id: shop.id, name: shop.name, marketplace: shop.marketplace, is_active: shop.is_active,
      state: supported ? data?.state ?? "notSynced" : "unsupported",
      lastSync: data?.lastSync ?? null,
      stats: data?.state === "ready" ? data.comparison.stats : null,
      message: supported ? data?.message ?? null : "No marketplace reader is configured for this shop.",
    };
  }

  function start(shop) {
    const previous = snapshots.get(shop.id);
    if (shop.marketplace.toLowerCase() !== "ozon" || previous?.state === "syncing") return;
    const entry = { state: "syncing", lastSync: previous?.lastSync ?? null };
    snapshots.set(shop.id, entry);
    queue = queue.then(async () => {
      try {
        let client;
        try { client = ozonFactory(shop.code); } catch { throw new Error("Marketplace credentials are unavailable for this shop."); }
        const products = await fetchVisibleProducts(client);
        const comparison = await readComparison(db, shop.id, products);
        Object.assign(entry, { state: "ready", lastSync: new Date().toISOString(), products, comparison });
      } catch (error) {
        const safe = /^(Marketplace |Internal catalog data )/.test(error.message);
        Object.assign(entry, { state: "error", message: safe ? error.message : "Shop synchronization failed." });
      }
    });
  }

  function route(method, url, summary, schema, handler) {
    fastify.route({
      method, url, schema: {
        tags: ["ERP"], summary, security: [{ erpBearer: [] }], ...schema,
        response: { ...standardErrors, ...schema.response },
      },
      async preValidation(request, reply) {
        const records = request.body?.records;
        if (Array.isArray(records) && records.some(record => typeof record?.sku !== "string" || typeof record?.perfume_id !== "string")) {
          return reply.code(400).send({ code: "ERP_INVALID_IDENTIFIERS", message: "Send SKUs and perfume identifiers as strings." });
        }
      },
      async handler(request, reply) {
        try { return await handler(request, reply); }
        catch { return reply.code(503).send({ code: "ERP_MATCHING_UNAVAILABLE", message: "Marketplace matching is temporarily unavailable." }); }
      },
    });
  }

  route("GET", "/marketplaces/shops", "List marketplace shop synchronization status", {
    response: { 200: array(shopSchema) },
  }, async () => (await readShops(db)).map(summary));

  route("POST", "/marketplaces/sync", "Queue read-only marketplace synchronization", {
    description: "Queues one shop or all Ozon shops. Poll the shop list for completion. Counts are published only after fetching every visible product page and its details.",
    body: object({ shopId: uuid }, []), response: { 202: array(shopSchema) },
  }, async ({ body }, reply) => {
    const shops = await readShops(db);
    const targets = body.shopId ? shops.filter(s => s.id === body.shopId) : shops;
    if (!targets.length && body.shopId) return reply.code(404).send({ code: "ERP_SHOP_NOT_FOUND", message: "Shop not found." });
    for (const shop of targets) start(shop);
    return reply.code(202).send(shops.map(summary));
  });

  const params = object({ shopId: uuid });
  route("GET", "/marketplaces/shops/:shopId/matching", "Get matching results for the last marketplace sync using the current catalog", {
    params,
    description: "Includes persisted detached SKUs, even when they are absent from the latest marketplace snapshot.",
    querystring: object({
      page: { type: "integer", minimum: 1, default: 1 },
      pageSize: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      status,
      q: { ...text, maxLength: 100 },
    }, []),
    response: { 200: object({ items: array(row), total: count, stats, lastSync: stamps, page: count, pageSize: count }),
      404: errorSchema("Shop not found") },
  }, async ({ params, query }, reply) => {
    const entry = snapshots.get(params.shopId);
    const ready = entry?.state === "ready";
    if (!ready && !(await readShops(db)).some(shop => shop.id === params.shopId)) {
      return reply.code(404).send({ code: "ERP_SHOP_NOT_FOUND", message: "Shop not found." });
    }
    const term = query.q?.trim().toLowerCase();
    const comparison = await readComparison(db, params.shopId, ready ? entry.products : []);
    const rows = comparison.rows.filter(item => (!query.status || item.status === query.status) && (
      !term || [item.name, item.sku, item.offerId].some(value => value?.toLowerCase().includes(term))
    ));
    const offset = (query.page - 1) * query.pageSize;
    return { items: rows.slice(offset, offset + query.pageSize), total: rows.length, stats: comparison.stats,
      lastSync: ready ? entry.lastSync : null, page: query.page, pageSize: query.pageSize };
  });

  route("POST", "/marketplaces/shops/:shopId/mappings/batch", "Register explicitly approved internal mappings", {
    description: "Accepts SKUs from the current shop snapshot or the persisted unmatched collection. Each row commits independently and conflicts preserve existing mappings.",
    params, body: object({ records: { ...array(batchRecord), minItems: 1, maxItems: 50 } }),
    response: { 200: object({ results: array(batchResult), comparisonRefreshed: flag }) },
  }, async ({ params, body }, reply) => {
    const entry = snapshots.get(params.shopId);
    if (body.records.some(record => BigInt(record.perfume_id) > maxId) ||
        new Set(body.records.map(record => record.sku.trim())).size !== body.records.length) {
      return reply.code(400).send({ code: "ERP_INVALID_BATCH", message: "Use valid perfume IDs and include each SKU once." });
    }
    const scope = new Map((entry?.state === "ready" ? entry.products : []).map(product => [product.sku, product]));
    for (const row of await readDetachedSkus(db)) {
      if (row.shop_id === params.shopId && !scope.has(row.sku)) scope.set(row.sku, row);
    }
    const results = [];
    for (const record of body.records) {
      const sku = record.sku.trim();
      if (!scope.has(sku) || scope.get(sku).catalogCollision) {
        results.push({ sku, status: "conflict", code: "ERP_SKU_SCOPE", message: "This SKU is outside the shop snapshot or is duplicated in the marketplace.", mappingId: null });
        continue;
      }
      let outcome;
      try { outcome = await createSku(db, record.perfume_id, { ...record, shop_id: params.shopId }, true); }
      catch { outcome = { error: {} }; }
      if (outcome.data && !outcome.error) {
        results.push({ sku, status: outcome.data.replayed ? "alreadyRegistered" : "registered", code: null, message: null, mappingId: outcome.data.id });
      } else {
        const [status, code, message] = skuFailure(outcome.error);
        results.push({ sku, status: status < 500 ? "conflict" : "error", code, message, mappingId: null });
      }
    }
    let comparisonRefreshed = false;
    try {
      await refreshComparisons();
      comparisonRefreshed = true;
    } catch {
      // Keep per-record results authoritative even when the comparison refresh fails.
    }
    return { results, comparisonRefreshed };
  });
}
