const text = { type: "string" };
const integer = { type: "integer", minimum: 0 };
const boolean = { type: "boolean" };
const uuid = { type: "string", format: "uuid" };
const id = { type: "string", pattern: "^[1-9][0-9]{0,18}$" };
const nullable = (schema) => ({ ...schema, nullable: true });
const array = (items) => ({ type: "array", items });
const object = (properties) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});

const error = { ...object({ code: text, message: text }) };
const brand = object({ id: uuid, name: text, country: nullable(text) });
const shop = object({ id: uuid, name: text, code: text, marketplace: text, is_active: boolean });
const variant = object({ id, volume_ml: integer });
const sku = object({
  id: uuid, shop, sku: text, volume_ml: integer, is_active: boolean, is_archived: boolean, ambiguous: boolean,
  updated_at: { type: "string", format: "date-time" },
});
const thumbnail = object({ id, image_url: text });
const image = object({
  id, image_url: text, sort_order: integer, is_primary: boolean, storage_key: text, image_type: text,
  width_px: integer, height_px: integer, size_bytes: integer, mime_type: text,
});
const gender = { type: "string", enum: ["M", "W", "U"] };
const perfume = { id, name: text, brand, gender: nullable(text), is_archived: boolean, archived_at: nullable(text) };
const perfumeList = object({
  items: array(object({ ...perfume, variant_count: integer, sku_count: integer, primary_master_image: nullable(thumbnail) })),
  total: integer, page: integer, pageSize: integer,
  counts: object({ active: integer, archived: integer }),
});

export const listQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    q: { type: "string", maxLength: 100, description: "Case-insensitive perfume name, brand name, or SKU substring" },
    brandId: uuid,
    gender,
    status: { type: "string", enum: ["active", "archived", "all"], default: "active" },
    shopId: { ...uuid, description: "Perfumes with any mapping for the selected shop, including archived mappings" },
    sort: { type: "string", enum: ["name", "brand", "updated"], default: "name" },
    direction: { type: "string", enum: ["asc", "desc"], default: "asc" },
    page: { type: "integer", minimum: 1, maximum: 100000, default: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 50, default: 25 },
  },
};

export const catalogSchemas = {
  list: {
    summary: "List and search perfumes by archive status",
    description: "Defaults to active perfumes. Counts include the entire catalog; total reflects the search, filters and selected status.",
    result: perfumeList, querystring: listQuery,
  },
  detail: {
    summary: "Get perfume general information, including archived records",
    result: object({ ...perfume, fragrance_family: nullable(text), created_at: text, updated_at: text }),
  },
  variants: { summary: "List registered volume variants", result: array(variant) },
  skus: {
    summary: "List shop SKU mappings with active mapping ambiguity flags",
    description: "An ambiguity flag means multiple active, non-archived mappings share the same shop and volume for this perfume.",
    result: array(sku),
  },
  images: { summary: "List registered master images", result: array(image) },
  brands: { summary: "List brands for ERP filters", result: array(brand) },
  shops: { summary: "List shops for ERP filters", result: array(shop) },
  volumes: { summary: "List registered volumes", result: array(object({ volume_ml: integer })) },
};

export function catalogSchema({ summary, description, result, querystring }, withId = false) {
  return {
    tags: ["ERP"],
    summary,
    ...(description ? { description } : {}),
    security: [{ erpBearer: [] }],
    ...(querystring ? { querystring } : {}),
    ...(withId ? { params: object({ id }) } : {}),
    response: {
      200: result,
      ...(withId || querystring ? {
        400: { description: "Invalid parameters", ...error, required: ["message"], additionalProperties: true },
      } : {}),
      401: { description: "A valid bearer token is required", ...error },
      403: { description: "ERP staff access required", ...error },
      ...(withId ? { 404: { description: "Perfume does not exist", ...error } } : {}),
      503: { description: "Authentication or catalog data is unavailable", ...error },
    },
  };
}
