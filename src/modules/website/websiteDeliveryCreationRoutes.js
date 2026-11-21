import { timingSafeEqual } from "node:crypto";
import { createWebsiteDeliveryOrder } from "./websiteDeliveryCreationService.js";

const errorSchema = {
  type: "object",
  required: ["success", "code", "message"],
  properties: { success: { type: "boolean" }, code: { type: "string" }, message: { type: "string" } },
};

export default async function websiteDeliveryCreationRoutes(fastify) {
  const enabled = process.env.WEBSITE_OZON_DELIVERY_CREATION_ENABLED === "true";
  const adminKey = process.env.WEBSITE_OZON_DELIVERY_ADMIN_KEY;

  fastify.post("/website/orders/:orderId/delivery/create", {
    // Authenticate before body validation and avoid echoing the header in errors.
    async onRequest(request, reply) {
      if (!enabled || !adminKey?.trim()) {
        return reply.code(503).send({ success: false, code: "DELIVERY_DISABLED", message: "Shipment creation is unavailable" });
      }
      const received = request.headers["x-website-delivery-admin-key"];
      const expected = Buffer.from(adminKey);
      const candidate = Buffer.from(typeof received === "string" ? received : "");
      if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
        return reply.code(401).send({ success: false, code: "UNAUTHORIZED", message: "Shipment operator credentials required" });
      }
    },
    schema: {
      tags: ["Website Delivery"],
      summary: "Manually create an Ozon Business Delivery order for a paid website order",
      description: "Requires the x-website-delivery-admin-key header. Disabled by default. Set retry to true only after reviewing an unresolved attempt. Retries use the stored body and idempotency key.",
      headers: {
        type: "object",
        required: ["x-website-delivery-admin-key"],
        properties: { "x-website-delivery-admin-key": { type: "string", description: "Shipment operator key" } },
      },
      params: {
        type: "object",
        required: ["orderId"],
        properties: { orderId: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
      },
      body: {
        type: "object",
        additionalProperties: false,
        properties: { retry: { type: "boolean", description: "Explicitly retry a reconciled attempt with its original UUID and body" } },
      },
      response: {
        201: {
          type: "object",
          required: ["success", "orderNumber", "postingNumber"],
          properties: { success: { type: "boolean" }, orderNumber: { type: "string" }, postingNumber: { type: "string" } },
        },
        400: {
          type: "object",
          description: "Invalid order ID or request body",
          properties: {
            statusCode: { type: "integer" }, code: { type: "string" },
            error: { type: "string" }, message: { type: "string" },
          },
        },
        401: { ...errorSchema, description: "Missing or invalid operator key" },
        404: { ...errorSchema, description: "Website order not found" },
        409: { ...errorSchema, description: "Duplicate, in-progress, or unresolved shipment attempt" },
        422: { ...errorSchema, description: "Unconfirmed payment, unverified standard parcel fit, invalid shipment data, or Ozon checkout rejection" },
        502: { ...errorSchema, description: "Ozon checkout failed or the create outcome is unknown" },
        503: { ...errorSchema, description: "Disabled, shipment storage unavailable, or outcome could not be saved" },
      },
    },
  }, async (request, reply) => {
    try {
      const shipment = await createWebsiteDeliveryOrder(request.params.orderId, request.body.retry === true);
      return reply.code(201).send({ success: true, ...shipment });
    } catch (error) {
      if ([404, 409, 422, 502, 503].includes(error?.statusCode) && typeof error.code === "string") {
        return reply.code(error.statusCode).send({ success: false, code: error.code, message: error.message });
      }
      request.log.warn("Website shipment creation could not be confirmed");
      return reply.code(503).send({ success: false, code: "DELIVERY_UNAVAILABLE", message: "Shipment creation could not be confirmed" });
    }
  });
}
