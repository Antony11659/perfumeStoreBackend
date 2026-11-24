import erpPerfumeArchiveRoutes from "./erpPerfumeArchiveRoutes.js";
import erpPerfumeDeleteRoutes from "./erpPerfumeDeleteRoutes.js";
import erpSkuRoutes from "./erpSkuRoutes.js";
import erpMatchingRoutes from "./erpMatchingRoutes.js";
import erpVariantWriteRoutes from "./erpVariantWriteRoutes.js";
import erpCatalogWriteRoutes from "./erpCatalogWriteRoutes.js";
import erpCatalogRoutes from "./erpCatalogRoutes.js";
import { requireErpStaff } from "./erpAuth.js";

export const erpBearer = { type: "http", scheme: "bearer", bearerFormat: "JWT" };

function errorSchema(description, code) {
  return {
    description,
    type: "object",
    required: ["code", "message"],
    properties: { code: { type: "string", enum: [code] }, message: { type: "string" } },
  };
}

export default async function erpRoutes(fastify, { getUser, db }) {
  fastify.decorateRequest("erpStaff", null);
  fastify.addHook("onRequest", requireErpStaff(getUser));

  if (db) {
    fastify.register(erpCatalogRoutes, { db });
    fastify.register(erpCatalogWriteRoutes, { db });
    fastify.register(erpPerfumeDeleteRoutes, { db });
    fastify.register(erpPerfumeArchiveRoutes, { db });
    fastify.register(erpVariantWriteRoutes, { db });
    let refreshMatching;
    fastify.register(erpMatchingRoutes, { db, registerRefresh: refresh => { refreshMatching = refresh; } });
    fastify.register(erpSkuRoutes, { db, onWrite: () => refreshMatching?.() });
  }

  fastify.get("/me", {
    schema: {
      tags: ["ERP"],
      summary: "Get the authenticated ERP staff account",
      description: "Verifies the Supabase access token and requires the server-managed ERP staff flag.",
      security: [{ erpBearer: [] }],
      response: {
        200: {
          description: "Verified ERP staff account",
          type: "object",
          required: ["id", "email", "erpStaff"],
          properties: {
            id: { type: "string" },
            email: { type: "string", nullable: true },
            erpStaff: { type: "boolean", enum: [true] },
          },
        },
        401: {
          ...errorSchema("Missing, invalid or expired access token", "ERP_UNAUTHENTICATED"),
          headers: { "WWW-Authenticate": { schema: { type: "string" } } },
        },
        403: errorSchema("The authenticated account lacks ERP staff access", "ERP_STAFF_REQUIRED"),
        503: errorSchema("Supabase authentication could not be verified", "ERP_AUTH_UNAVAILABLE"),
      },
    },
  }, async (request) => request.erpStaff);
}
