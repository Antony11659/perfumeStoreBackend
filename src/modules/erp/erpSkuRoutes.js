export const text = { type: "string" };
export const bigint = { type: "string", pattern: "^[1-9][0-9]{0,18}$" };
export const uuid = { type: "string", format: "uuid" };
export const volume = { type: "integer", minimum: 1, maximum: 32767 };
export const skuText = { ...text, minLength: 1, maxLength: 200, pattern: "\\S" };
export const object = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: false,
});
export const maxId = 9223372036854775807n;
export const errorSchema = (description) => ({ description, ...object({ code: text, message: text }) });
export const standardErrors = {
  400: errorSchema("Invalid identifier, fields, or registered variant"),
  401: errorSchema("A valid bearer token is required"),
  403: errorSchema("ERP staff access is required"),
  404: errorSchema("Shop or mapping not found for the requested perfume"),
  409: errorSchema("Duplicate SKU, stale edit, or fulfillment dependency"),
  503: errorSchema("Authentication or catalog service unavailable"),
};
const flag = { type: "boolean" };
const flags = { is_active: flag, is_archived: flag };
const fields = { shop_id: uuid, volume_ml: volume, sku: skuText, ...flags };
const stamp = { type: "string", format: "date-time" };
const mapping = object({ id: uuid, perfume_id: bigint, ...fields, updated_at: stamp });

export function skuFailure(error) {
  switch (error?.code) {
    case "23505": return [409, "ERP_SKU_DUPLICATE", "This SKU is already registered. Existing mappings have been preserved."];
    case "40001":
    case "40P01": return [409, "ERP_SKU_STALE", "The mapping changed or was busy. Reload it before retrying."];
    case "P0001": return [409, "ERP_SKU_DEPENDENCY", "Existing fulfillment or historical use prevents this change."];
    case "PT409": return [409, "ERP_SKU_FULFILLMENT", "This Raspiv volume already has an eligible mapping."];
    case "PT404": return [404, "ERP_SKU_NOT_FOUND", "Shop or mapping not found for this perfume."];
    case "22023":
    case "23503": return [400, "ERP_SKU_INVALID_VARIANT", "Select a registered perfume and volume."];
    default: return [503, "ERP_SKU_UNAVAILABLE", "SKU registration or editing is temporarily unavailable."];
  }
}

export function createSku(db, id, fields, replay = false) {
  return db.rpc("erp_create_sku_v1", {
    p_perfume_id: id,
    p_shop_id: fields.shop_id,
    p_volume_ml: fields.volume_ml,
    p_sku: fields.sku.trim(),
    p_active: fields.is_active ?? true,
    p_archived: fields.is_archived ?? false,
    p_allow_replay: replay,
  });
}

export default async function erpSkuRoutes(fastify, { db, onWrite }) {
  const path = "/perfumes/:id/skus";
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const add = method === "POST";
    const edit = method === "PATCH";
    const body = add ? object(fields, ["shop_id", "volume_ml", "sku"])
      : object({ ...fields, perfume_id: bigint, expected_updated_at: stamp }, ["expected_updated_at"]);
    fastify.route({
      method,
      url: add ? path : path + "/:skuId",
      schema: {
        tags: ["ERP"], security: [{ erpBearer: [] }],
        summary: add ? "Register an internal marketplace SKU" : edit ? "Update eligible internal SKU status" : "Check permanent SKU deletion eligibility",
        description: add ? "Global SKU uniqueness is enforced. A second eligible Raspiv mapping for the same variant is blocked."
          : edit ? "Requires the exact updated_at version. Identity changes and Raspiv status changes are blocked."
          : "Ownership is verified. Deletion is blocked while historical marketplace usage cannot be established.",
        params: object(add ? { id: bigint } : { id: bigint, skuId: uuid }),
        ...(method !== "DELETE" && { body: { ...body, minProperties: edit ? 2 : 3 } }),
        response: { ...(method !== "DELETE" && { [add ? 201 : 200]: mapping }), ...standardErrors },
      },
      async preValidation(request, reply) {
        if (request.body && typeof request.body === "object" && (("sku" in request.body && typeof request.body.sku !== "string")
          || ("perfume_id" in request.body && typeof request.body.perfume_id !== "string"))) {
          return reply.code(400).send({ code: "ERP_INVALID_IDENTIFIERS", message: "Send SKUs and perfume identifiers as strings." });
        }
        if (request.body && (method === "DELETE" || Object.keys(request.body).some(key => !Object.hasOwn(body.properties, key)))) {
          return reply.code(400).send({ code: "ERP_INVALID_FIELDS", message: "Unsupported SKU fields." });
        }
      },
      async handler(request, reply) {
        const { id, skuId } = request.params;
        if (BigInt(id) > maxId || (request.body?.perfume_id && BigInt(request.body.perfume_id) > maxId)) {
          return reply.code(400).send({ code: "ERP_INVALID_ID", message: "Invalid perfume ID." });
        }
        try {
          let result;
          if (add) result = await createSku(db, id, request.body);
          else if (edit) {
            const { expected_updated_at, ...patch } = request.body;
            if (patch.sku) patch.sku = patch.sku.trim();
            result = await db.rpc("erp_update_sku_v1", { p_perfume_id: id, p_sku_id: skuId, p_expected_updated_at: expected_updated_at, p_patch: patch });
          } else {
            result = await db.rpc("erp_delete_sku_v1", { p_perfume_id: id, p_sku_id: skuId });
          }
          if (result.data && !result.error && (add || edit)) {
            try { await onWrite?.(); }
            catch { request.log.warn({ event: "erp_sku_comparison_refresh_failed" }); }
            return reply.code(add ? 201 : 200).send(result.data);
          }
          const [status, code, message] = skuFailure(result.error);
          return reply.code(status).send({ code, message });
        } catch {
          return reply.code(503).send({ code: "ERP_SKU_UNAVAILABLE", message: "SKU operations are temporarily unavailable." });
        }
      },
    });
  }
}
