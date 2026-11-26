import { catalogSchema, catalogSchemas } from "./erpCatalogSchemas.js";

const brand = "brand:brands(id,name,country)";
const general = `id:id::text,name,gender,${brand},fragrance_family,created_at,updated_at,is_archived,archived_at`;
const imageFields = "id:id::text,image_url,sort_order,is_primary,storage_key,image_type,width_px,height_px,size_bytes,mime_type";
const shop = "id,name,code,marketplace,is_active";

function safeSearch(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function logicValue(value) {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

function databaseResult(result) {
  if (result.error) throw new Error("Catalog database read failed");
  return result.data;
}

// Mapping lookups are batched at the API row cap. Dedupe perfume IDs before
// filtering the parent table so SKU and variant multiplicity cannot affect its count.
async function matchingIds(query, key) {
  const batchSize = 1000;
  const ids = new Set();
  for (let first = 0; ; first += batchSize) {
    const rows = databaseResult(await query.range(first, first + batchSize - 1));
    for (const row of rows) ids.add(row[key]);
    if (rows.length < batchSize) return [...ids];
  }
}

async function listPerfumes(db, query) {
  const { brandId, gender, shopId, sort, direction, page, pageSize, status } = query;
  const term = query.q?.trim();
  const pattern = term && safeSearch(term);
  const skuIds = () => db.from("shop_products").select("perfume_id:perfume_id::text").order("id");
  const countStatus = async (archived) => {
    const result = await db.from("perfumes").select("id", { count: "exact", head: true }).eq("is_archived", archived);
    if (result.error || !Number.isInteger(result.count)) throw new Error("Catalog count missing");
    return result.count;
  };
  const [brandMatches, skuMatches, shopMatches, active, archived] = await Promise.all([
    pattern ? matchingIds(db.from("brands").select("id").filter("name", "imatch", pattern).order("id"), "id") : [],
    pattern ? matchingIds(skuIds().filter("sku", "imatch", pattern), "perfume_id") : [],
    shopId ? matchingIds(skuIds().eq("shop_id", shopId), "perfume_id") : null,
    countStatus(false),
    countStatus(true),
  ]);
  const counts = { active, archived };
  if (shopMatches?.length === 0) return { items: [], total: 0, page, pageSize, counts };

  let request = db.from("perfumes").select([
    `id:id::text,name,gender,is_archived,archived_at,${brand}`,
    "variants:perfume_variants(count)",
    "sku_counts:perfume_variants(shop_products(count))",
    "master:perfume_images(id:id::text,image_url)",
  ].join(","), { count: "exact" })
    .eq("master.image_type", "master")
    .eq("master.is_primary", true)
    .order("sort_order", { referencedTable: "master" })
    .order("id", { referencedTable: "master" })
    .limit(1, { referencedTable: "master" });

  if (pattern) {
    const alternatives = [`name.imatch.${logicValue(pattern)}`];
    if (brandMatches.length) alternatives.push(`brand_id.in.(${brandMatches.join(",")})`);
    if (skuMatches.length) alternatives.push(`id.in.(${skuMatches.join(",")})`);
    request = request.or(alternatives.join(","));
  }
  if (status !== "all") request = request.eq("is_archived", status === "archived");
  if (brandId) request = request.eq("brand_id", brandId);
  if (gender) request = request.eq("gender", gender);
  if (shopMatches) request = request.in("id", shopMatches);

  const column = { name: "name", brand: "brand(name)", updated: "updated_at" }[sort];
  const first = (page - 1) * pageSize;
  const result = await request.order(column, { ascending: direction === "asc" }).order("id").range(first, first + pageSize - 1);
  // PostgREST returns 416 with the exact count for offsets beyond the last page.
  if (result.status === 416 && Number.isInteger(result.count) && first >= result.count) {
    return { items: [], total: result.count, page, pageSize, counts };
  }
  const rows = databaseResult(result);
  if (!Number.isInteger(result.count)) throw new Error("Catalog count missing");
  return {
    items: rows.map((row) => ({
      id: row.id, name: row.name, brand: row.brand, gender: row.gender,
      is_archived: row.is_archived, archived_at: row.archived_at,
      variant_count: row.variants[0]?.count ?? 0,
      sku_count: row.sku_counts.reduce((total, variant) => total + (variant.shop_products[0]?.count ?? 0), 0),
      primary_master_image: row.master[0] ?? null,
    })),
    total: result.count, page, pageSize, counts,
  };
}

function primaryMaster(request) {
  return request.eq("master.image_type", "master").eq("master.is_primary", true);
}

async function imageLibraryStats(db) {
  const perfumeCount = () => db.from("perfumes").select("id", { count: "exact", head: true });
  const results = await Promise.all([
    perfumeCount().eq("is_archived", false),
    perfumeCount().eq("is_archived", true),
    db.from("perfume_images").select("id", { count: "exact", head: true }).eq("image_type", "master"),
    // The filtered inner embed tests for existence; its count is on the parent perfume rows.
    primaryMaster(db.from("perfumes").select("id,master:perfume_images!inner()", { count: "exact", head: true }))
      .eq("is_archived", false),
  ]);
  const [activePerfumes, archivedPerfumes, masterImageRecords, activeWithPrimaryMaster] = results.map((result) => {
    if (result.error || !Number.isInteger(result.count)) throw new Error("Image library count missing");
    return result.count;
  });
  if (activeWithPrimaryMaster > activePerfumes) throw new Error("Inconsistent image library counts");
  return {
    totalPerfumes: activePerfumes + archivedPerfumes, activePerfumes, archivedPerfumes, masterImageRecords,
    activeWithPrimaryMaster, activeWithoutPrimaryMaster: activePerfumes - activeWithPrimaryMaster,
    activeCoveragePercent: activePerfumes ? (activeWithPrimaryMaster / activePerfumes) * 100 : 0,
  };
}

async function imageLibraryPerfumes(db, { q, view, page, pageSize }) {
  const term = q?.trim();
  const brandSearch = term ? ",brand_search:brands()" : "";
  function filteredRequest(head = false) {
    const select = head
      ? `id,master:perfume_images()${brandSearch}`
      : `id:id::text,name,is_archived,${brand},master:perfume_images(${imageFields})${brandSearch}`;
    let request = primaryMaster(db.from("perfumes").select(select, { count: "exact", head }))
      .eq("is_archived", view === "archived");
    if (term) {
      const pattern = safeSearch(term);
      request = request.filter("brand_search.name", "imatch", pattern)
        .or(`name.imatch.${logicValue(pattern)},brand_search.not.is.null`);
    }
    if (view === "missing") request = request.is("master", null);
    if (view === "registered") request = request.not("master", "is", null);
    return request;
  }

  const first = (page - 1) * pageSize;
  const result = await filteredRequest()
    .order("sort_order", { referencedTable: "master" }).order("id", { referencedTable: "master" })
    .limit(1, { referencedTable: "master" }).order("name").order("id").range(first, first + pageSize - 1);

  // The client omits the count on an unsatisfiable range. Read the filtered count separately.
  if (result.status === 416 && result.error?.code === "PGRST103") {
    const { count, error } = await filteredRequest(true);
    if (!error && Number.isInteger(count) && first >= count) return { items: [], total: count, page, pageSize };
  }
  const rows = databaseResult(result);
  if (!Number.isInteger(result.count)) throw new Error("Image library count missing");
  return {
    items: rows.map(({ id, name, brand, is_archived, master }) => ({
      id, name, brand, is_archived, primary_master_image: master[0] ?? null,
    })),
    total: result.count, page, pageSize,
  };
}

async function perfumeRecord(db, id, select, configure = (request) => request) {
  return databaseResult(await configure(db.from("perfumes").select(select).eq("id", id)).maybeSingle());
}

function skuMappings(row) {
  const mappings = row.variants.flatMap((variant) => variant.shop_products)
    .sort((a, b) => a.shop.name.localeCompare(b.shop.name) || a.volume_ml - b.volume_ml || a.sku.localeCompare(b.sku) || a.id.localeCompare(b.id));
  const counts = new Map();
  const group = (mapping) => `${mapping.shop.id}:${mapping.volume_ml}`;
  for (const mapping of mappings) {
    if (mapping.is_active && !mapping.is_archived) {
      const key = group(mapping);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return mappings.map((mapping) => ({
    ...mapping,
    ambiguous: mapping.is_active && !mapping.is_archived && counts.get(group(mapping)) > 1,
  }));
}

export default async function erpCatalogRoutes(fastify, { db }) {
  function route(path, name, load, withId = false) {
    fastify.get(path, { schema: catalogSchema(catalogSchemas[name], withId) }, async (request, reply) => {
      const id = request.params?.id;
      if (id && BigInt(id) > 9223372036854775807n) {
        return reply.code(400).send({ code: "ERP_INVALID_ID", message: "Invalid perfume ID." });
      }
      try {
        const data = await load(request);
        if (data === null) {
          return reply.code(404).send({ code: "ERP_PERFUME_NOT_FOUND", message: "Perfume not found." });
        }
        return data;
      } catch {
        request.log.warn({ event: "erp_catalog_read_failed", resource: name });
        return reply.code(503).send({ code: "ERP_CATALOG_UNAVAILABLE", message: "Could not load catalog data." });
      }
    });
  }

  route("/image-library/stats", "imageLibraryStats", () => imageLibraryStats(db));
  route("/image-library/perfumes", "imageLibraryPerfumes", ({ query }) => imageLibraryPerfumes(db, query));
  route("/perfumes", "list", ({ query }) => listPerfumes(db, query));
  route("/perfumes/:id", "detail", ({ params }) => perfumeRecord(db, params.id, general), true);
  route("/perfumes/:id/variants", "variants", async ({ params }) => {
    const row = await perfumeRecord(db, params.id, "variants:perfume_variants(id:id::text,volume_ml)", (request) =>
      request.order("volume_ml", { referencedTable: "variants" }).order("id", { referencedTable: "variants" }));
    return row === null ? null : row.variants;
  }, true);
  route("/perfumes/:id/skus", "skus", async ({ params }) => {
    const row = await perfumeRecord(db, params.id,
      `variants:perfume_variants(shop_products(id,sku,volume_ml,is_active,is_archived,updated_at,shop:shops(${shop})))`);
    return row === null ? null : skuMappings(row);
  }, true);
  route("/perfumes/:id/images", "images", async ({ params }) => {
    const row = await perfumeRecord(db, params.id,
      `images:perfume_images(${imageFields})`,
      (request) => request.eq("images.image_type", "master").order("sort_order", { referencedTable: "images" })
        .order("id", { referencedTable: "images" }));
    return row === null ? null : row.images;
  }, true);
  route("/brands", "brands", async () => databaseResult(await db.from("brands").select("id,name,country").order("name").order("id")));
  route("/shops", "shops", async () => databaseResult(await db.from("shops").select(shop).order("marketplace").order("name").order("id")));
  route("/volumes", "volumes", async () => databaseResult(await db.from("volumes").select("volume_ml").order("volume_ml")));
}
