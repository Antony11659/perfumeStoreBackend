const id = { type: "string", pattern: "^[1-9][0-9]{0,18}$" };
const volume = { type: "integer", minimum: 1, maximum: 32767 };
const boolean = { type: "boolean" };
const maxId = 9223372036854775807n;
const object = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: false,
});
const errorFields = { code: { type: "string" }, message: { type: "string" } };
const error = (description) => ({ description, ...object(errorFields) });

function dependencyDetails(details) {
  try {
    const parsed = JSON.parse(details);
    return {
      websiteOrders: parsed.websiteOrders === true,
      marketplaceMappings: parsed.marketplaceMappings === true,
    };
  } catch {
    return null;
  }
}

function failure(reply, pgError) {
  switch (pgError?.code) {
    case "23505":
      return reply.code(409).send({ code: "ERP_VARIANT_DUPLICATE", message: "This volume is already registered for this perfume." });
    case "P0001":
    case "23503": {
      const dependencies = dependencyDetails(pgError.details);
      const sources = [
        dependencies?.websiteOrders && "historical website orders",
        dependencies?.marketplaceMappings && "marketplace SKU mappings",
      ].filter(Boolean);
      return reply.code(409).send({
        code: "ERP_VARIANT_DEPENDENCY",
        message: sources.length
          ? `This variant is used by ${sources.join(" and ")}.`
          : "The variant is referenced by other records or its references changed. Refresh and check again.",
        ...(dependencies && { dependencies }),
      });
    }
    case "40001":
    case "40P01":
      return reply.code(409).send({ code: "ERP_CATALOG_CONCURRENT_EDIT", message: "The variant was busy. Refresh and try again." });
    case "P0002":
      return reply.code(404).send({ code: "ERP_VARIANT_NOT_FOUND", message: "The perfume or its variant was not found." });
    case "22023":
      return reply.code(400).send({ code: "ERP_INVALID_VARIANT_VOLUME", message: "Select a registered volume." });
    default:
      return reply.code(503).send({ code: "ERP_CATALOG_UNAVAILABLE", message: "Variant changes are unavailable." });
  }
}

export default async function erpVariantWriteRoutes(fastify, { db }) {
  for (const [method, summary] of [
    ["POST", "Create a volume variant"], ["PATCH", "Change a variant's volume"], ["DELETE", "Delete a variant and unmatch its SKUs"],
  ]) {
    const create = method === "POST";
    const remove = method === "DELETE";
    fastify.route({
      method,
      url: `/perfumes/:id/variants${create ? "" : "/:variantId"}`,
      schema: {
        tags: ["ERP"],
        summary,
        description: remove
          ? "Detaches any SKU mappings. Historical website order references prevent variant deletion."
          : "IDs are decimal strings. A volume correction keeps the variant ID and updates its SKU mappings.",
        security: [{ erpBearer: [] }],
        params: object(create ? { id } : { id, variantId: id }),
        ...(!remove && { body: object({ volume_ml: volume }) }),
        response: {
          [create ? 201 : 200]: object({ id, volume_ml: volume, updated_at: { type: "string", format: "date-time" } }),
          400: error("Invalid identifier, fields, or volume"),
          401: error("A valid bearer token is required"),
          403: error("ERP staff access is required"),
          404: error("Perfume or variant not found"),
          409: {
            description: "Duplicate volume, historical dependency, or concurrent edit",
            ...object({ ...errorFields, dependencies: object({ websiteOrders: boolean, marketplaceMappings: boolean }) },
              ["code", "message"]),
          },
          503: error("Authentication or database service unavailable"),
        },
      },
      async preValidation(request, reply) {
        if (request.body && (remove || Object.keys(request.body).some((key) => key !== "volume_ml"))) {
          return reply.code(400).send({ code: "ERP_INVALID_FIELDS", message: "The request contains unsupported fields." });
        }
      },
      async handler(request, reply) {
        const { id: perfumeId, variantId } = request.params;
        if (BigInt(perfumeId) > maxId || (variantId && BigInt(variantId) > maxId)) {
          return reply.code(400).send({ code: "ERP_INVALID_ID", message: "Invalid perfume or variant ID." });
        }
        const params = { p_perfume_id: perfumeId, p_volume_ml: remove ? null : request.body.volume_ml };
        try {
          const { data, error: pgError } = create
            ? await db.rpc("erp_create_variant_v1", params)
            : await db.rpc("erp_change_variant_v1", { ...params, p_variant_id: variantId });
          if (data && !pgError) return reply.code(create ? 201 : 200).send(data);
          return failure(reply, pgError);
        } catch {
          request.log.warn({ event: "erp_variant_write_failed", method });
          return failure(reply);
        }
      },
    });
  }
}
