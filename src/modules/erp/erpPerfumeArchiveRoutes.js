import { catalogSchema } from "./erpCatalogSchemas.js";

const id = { type: "string", pattern: "^[1-9][0-9]{0,18}$" };
const result = {
  type: "object", required: ["changed"],
  properties: { changed: { type: "integer", minimum: 0, maximum: 50 } },
};
const failure = {
  type: "object", required: ["code", "message"],
  properties: { code: { type: "string" }, message: { type: "string" } },
};

export default async function erpPerfumeArchiveRoutes(fastify, { db }) {
  for (const [path, archived, bulk, summary] of [
    ["/perfumes/:id/archive", true, false, "Archive a perfume"],
    ["/perfumes/:id/restore", false, false, "Restore an archived perfume"],
    ["/perfumes/bulk-archive", true, true, "Archive up to 50 selected perfumes"],
  ]) {
    const schema = catalogSchema({
      summary, result, description: "Idempotent. Returns the number of perfumes whose status changed. Existing related records are preserved.",
    }, !bulk);
    if (bulk) {
      schema.body = {
        type: "object", additionalProperties: false, required: ["ids"],
        properties: { ids: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: id } },
      };
      schema.response[400] = { ...failure, required: ["message"], description: "Invalid perfume IDs" };
      schema.response[404] = { ...failure, description: "A perfume was not found. No changes were made." };
    }
    schema.response[409] = { ...failure, description: "Concurrent catalog operation. The request can be retried." };

    fastify.post(path, {
      schema,
      preValidation(request, reply, done) {
        if ((bulk && Array.isArray(request.body?.ids) && request.body.ids.some(value => typeof value !== "string"))
          || (!bulk && request.body !== undefined)) {
          return reply.code(400).send({ code: "ERP_INVALID_IDS", message: "Use decimal-string perfume IDs." });
        }
        done();
      },
    }, async (request, reply) => {
      const ids = bulk ? request.body.ids : [request.params.id];
      if (ids.some(value => BigInt(value) > 9223372036854775807n)) {
        return reply.code(400).send({ code: "ERP_INVALID_IDS", message: "Invalid perfume ID." });
      }
      try {
        const { data, error } = await db.rpc("erp_set_perfume_archive_v1", { p_perfume_ids: ids, p_archived: archived });
        if (error?.code === "PT404") {
          return reply.code(404).send({ code: "ERP_PERFUME_NOT_FOUND", message: "One or more perfumes were not found." });
        }
        if (["40001", "40P01"].includes(error?.code)) {
          return reply.code(409).send({ code: "ERP_PERFUME_ARCHIVE_BUSY", message: "A concurrent change blocked this request. Try again." });
        }
        if (!error && Number.isInteger(data?.changed)) return data;
      } catch {
        request.log.warn({ event: "erp_perfume_archive_failed" });
      }
      return reply.code(503).send({ code: "ERP_PERFUME_ARCHIVE_UNAVAILABLE", message: "Could not save perfume status." });
    });
  }
}
