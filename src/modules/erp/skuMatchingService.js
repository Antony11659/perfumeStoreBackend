const PAGE_SIZE = 1000;
const INFO_SIZE = 100;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function marketplaceId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? value : null;
}

export async function fetchVisibleProducts(client, wait = sleep) {
  async function post(path, payload) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.post(path, payload, { signal: AbortSignal.timeout(10000), redirect: "error" });
      } catch (error) {
        // The shared client includes the upstream status in its error text.
        const limited = /^Ozon API error for shop .* 429:/.test(error.message);
        if (!limited || attempt === 2) throw new Error(limited ? "Marketplace rate limit reached. Try again later." : "Marketplace retrieval failed.");
        await wait(1000 * 2 ** attempt);
      }
    }
  }
  const listings = new Map();
  const cursors = new Set();
  let cursor = "";
  let total;
  for (;;) {
    const { result } = await post("/v3/product/list", { filter: { visibility: "VISIBLE" }, last_id: cursor, limit: PAGE_SIZE });
    if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.total) || result.total < 0 ||
        (total !== undefined && total !== result.total)) {
      throw new Error("Marketplace returned an incomplete or changing product list. Refresh again.");
    }
    total = result.total;
    for (const row of result.items) {
      const id = marketplaceId(row.product_id);
      if (!id || listings.has(id)) throw new Error("Marketplace pagination returned invalid or repeated products.");
      listings.set(id, row);
    }
    if (listings.size === total) break;
    const next = result.last_id;
    if (!result.items.length || listings.size > total || typeof next !== "string" || !next || cursors.has(next)) {
      throw new Error("Marketplace pagination ended before the reported total.");
    }
    cursors.add(next);
    cursor = next;
  }

  const products = new Map();
  const ids = [...listings.keys()];
  for (let offset = 0; offset < ids.length; offset += INFO_SIZE) {
    const batch = ids.slice(offset, offset + INFO_SIZE);
    const { items } = await post("/v3/product/info/list", { product_id: batch });
    if (!Array.isArray(items)) throw new Error("Marketplace product details are unavailable.");
    const byId = new Map(items.map(item => [marketplaceId(item.id), item]));
    for (const id of batch) {
      const listing = listings.get(id);
      const info = byId.get(id);
      if (!info || typeof info.name !== "string" || !info.name.trim()) throw new Error("Marketplace product details are incomplete.");
      // Match the legacy visible-list primary SKU scope. Product info provides
      // metadata and the primary SKU only when the listing omits it.
      const source = listing.sku == null || listing.sku === 0 || listing.sku === "0" ? info.sku : listing.sku;
      const sku = marketplaceId(source);
      if (!sku) throw new Error("Marketplace returned a missing or unsafe primary SKU.");
      if (products.has(sku)) {
        products.get(sku).catalogCollision = true;
        continue;
      }
      const image = Array.isArray(info.primary_image) ? info.primary_image[0] : info.primary_image;
      products.set(sku, {
        sku, name: info.name.trim(), offerId: [info.offer_id, listing.offer_id].find(value => typeof value === "string" && value) ?? null,
        imageUrl: [image, info.images?.[0]].find(value => typeof value === "string" && /^https:\/\//i.test(value)) ?? null,
        catalogCollision: false,
      });
    }
  }
  return [...products.values()];
}

async function readPages(db, table, projection, activePerfumesOnly = false) {
  const rows = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const query = db.from(table).select(projection).order("id");
    const { data, error } = await (activePerfumesOnly ? query.eq("is_archived", false) : query)
      .range(start, start + PAGE_SIZE - 1);
    if (error || !Array.isArray(data)) throw new Error("Internal catalog data is unavailable.");
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

export const readShops = db => readPages(db, "shops", "id,name,code,marketplace,is_active");
const eligible = mapping => mapping.is_active && !mapping.is_archived;
const groupKey = m => JSON.stringify([m.shop_id, m.perfume_id, m.volume_ml]);
const normalize = value => value.trim().toLowerCase();

export function suggestMatch(productName, perfumes) {
  const normalized = normalize(productName);
  const amounts = [...new Set([...normalized.matchAll(/(?:^|[^\d.,])(\d+)\s*(?:мл|ml)(?=$|[^\p{L}])/giu)].map(match => Number(match[1])))];
  const words = value => normalize(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const title = " " + words(normalized) + " ";
  const candidates = perfumes.flatMap(perfume => {
    const name = words(perfume.name);
    if (name.length < 2 || !title.includes(" " + name + " ")) return [];
    const brand = perfume.brand?.name ? words(perfume.brand.name) : "";
    return [{ perfume, score: name.length + (brand && title.includes(" " + brand + " ") ? 1000 : 0) }];
  }).sort((a, b) => b.score - a.score);
  const best = candidates[0]?.score !== candidates[1]?.score ? candidates[0]?.perfume : undefined;
  const extractedVolume = amounts.length === 1 ? amounts[0] : null;
  const volumeMl = best?.variants?.some(row => row.volume_ml === extractedVolume) ? extractedVolume : null;
  return { perfumeId: best?.id ?? null, perfumeName: best?.name ?? null, brandName: best?.brand?.name ?? null, volumeMl, extractedVolume };
}

export function compareProducts(shopId, products, mappings, perfumes, detached = []) {
  const bySku = new Map(mappings.map(row => [row.sku, row]));
  const groups = new Map();
  for (const mapping of mappings.filter(eligible)) {
    const key = groupKey(mapping);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const reserved = new Map(detached.map(row => [row.sku, row]));
  const visible = new Set(products.map(row => row.sku));
  const retained = detached.filter(row => row.shop_id === shopId && !visible.has(row.sku))
    .map(row => ({ sku: row.sku, name: row.sku, imageUrl: null, offerId: null }));
  const rows = [...products, ...retained].map(product => {
    const found = bySku.get(product.sku);
    const reservation = reserved.get(product.sku);
    let status = "unmatched";
    if (product.catalogCollision) status = "catalogConflict";
    else if ((found ?? reservation) && (found ?? reservation).shop_id !== shopId) status = "otherShop";
    else if (found?.is_archived) status = "archived";
    else if (found && !found.is_active) status = "inactive";
    else if (found) status = groups.get(groupKey(found)) > 1 ? "ambiguous" : "matched";
    return { ...product, status, suggestion: status === "unmatched" ? suggestMatch(product.name, perfumes) : null };
  });
  const matched = rows.filter(row => row.status === "matched").length;
  const unmatched = rows.filter(row => row.status === "unmatched").length;
  return {
    rows,
    stats: { total: rows.length, matched, unmatched, conflicts: rows.length - matched - unmatched,
      completion: rows.length ? Math.round(matched / rows.length * 10000) / 100 : 0 },
  };
}

export function readComparisonCatalog(db) {
  return Promise.all([
    readPages(db, "shop_products", "id,sku,shop_id,perfume_id:perfume_id::text,volume_ml,is_active,is_archived"),
    readPages(db, "perfumes", "id:id::text,name,brand:brands(name),variants:perfume_variants(volume_ml)", true),
    readDetachedSkus(db),
  ]);
}

export async function readComparison(db, shopId, products) {
  const [mappings, perfumes, detached] = await readComparisonCatalog(db);
  return compareProducts(shopId, products, mappings, perfumes, detached);
}

export const readDetachedSkus = db => readPages(db, "erp_unmatched_skus", "id,sku,shop_id");
