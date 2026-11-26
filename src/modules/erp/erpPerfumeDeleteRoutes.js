const id = { type: "string", pattern: "^[1-9][0-9]{0,18}$" };
const count = { type: "integer", minimum: 0 };
const text = { type: "string" };
const countFields = ["variants", "skuMappings", "websiteOrderItems", "images", "unverifiedForeignKeys"];
const object = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: false,
});
const dependencies = object({ ...Object.fromEntries(countFields.map(field => [field, count])), canDelete: { type: "boolean" } });
const fields = { code: text, message: text };
const error = (description) => ({ description, ...object(fields) });

function safeDependencies(detail) {
  try {
    const value = JSON.parse(detail);
    if (countFields.every(field => Number.isSafeInteger(value?.[field]) && value[field] >= 0) && value.canDelete === false) {
      return { ...Object.fromEntries(countFields.map(field => [field, value[field]])), canDelete: false };
    }
  } catch {
    // PostgreSQL details from other errors are not safe API text.
  }
  return null;
}

function failure(reply, pgError) {
  switch (pgError?.code) {
    case "PT404": return reply.code(404).send({ code: "ERP_PERFUME_NOT_FOUND", message: "Perfume not found." });
    case "P0001":
    case "23503": {
      const blocker = safeDependencies(pgError.details);
      const reasons = [
        blocker?.websiteOrderItems && "historical website order items",
        blocker?.images && "registered images",
        blocker?.unverifiedForeignKeys && "unverified database relationships",
      ].filter(Boolean);
      return reply.code(409).send({
        code: "ERP_PERFUME_DELETE_BLOCKED",
        message: reasons.length ? `Deletion is blocked by ${reasons.join(", ")}.` : "Related records prevent deletion. Check dependencies again.",
        ...(blocker && { dependencies: blocker }),
      });
    }
    case "40001":
    case "40P01":
      return reply.code(409).send({ code: "ERP_PERFUME_DELETE_BUSY", message: "The perfume was busy. Check dependencies before trying again." });
    default:
      return reply.code(503).send({ code: "ERP_PERFUME_DELETE_UNAVAILABLE", message: "Perfume deletion is unavailable." });
  }
}

export default async function erpPerfumeDeleteRoutes(fastify, { db }) {
  for (const method of ["GET", "DELETE"]) {
    const preview = method === "GET";
    fastify.route({
      method,
      url: preview ? "/perfumes/:id/dependencies" : "/perfumes/:id",
      schema: {
        tags: ["ERP"],
        summary: preview ? "Preview perfume deletion dependencies" : "Delete a perfume and unmatch its SKUs",
        description: preview
          ? "Reports how many SKUs will become unmatched and checks protections for order history and image publication."
          : "Atomically detaches marketplace SKUs and removes the perfume and variants. Historical order and image publication dependencies are protected.",
        security: [{ erpBearer: [] }],
        params: object({ id }),
        response: {
          200: preview ? dependencies : object({ id }),
          400: error("Invalid perfume ID or unsupported request body"),
          401: error("A valid bearer token is required"),
          403: error("ERP staff access is required"),
          404: error("Perfume not found"),
          ...(!preview && { 409: {
            description: "Deletion blocked by dependencies or a concurrent change",
            ...object({ ...fields, dependencies }, ["code", "message"]),
          } }),
          503: error("Authentication or catalog service unavailable"),
        },
      },
      async handler(request, reply) {
        const { id: perfumeId } = request.params;
        if (BigInt(perfumeId) > 9223372036854775807n || (!preview && request.body !== undefined)) {
          return reply.code(400).send({ code: "ERP_INVALID_FIELDS", message: "Invalid perfume ID or unsupported request body." });
        }
        try {
          const { data, error: pgError } = await db.rpc(preview ? "erp_perfume_dependencies_v1" : "erp_delete_perfume_v1", {
            p_perfume_id: perfumeId,
          });
          return data && !pgError ? data : failure(reply, pgError);
        } catch {
          request.log.warn({ event: "erp_perfume_delete_request_failed", method });
          return failure(reply);
        }
      },
    });
  }
}
