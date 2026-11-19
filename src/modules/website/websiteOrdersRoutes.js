import { websiteOzonPayEnabled } from "./websitePaymentFeature.js";

import {
  issueWebsitePaymentAccessToken,
  requireWebsitePaymentTokenSecret,
} from "./websitePaymentAccessToken.js";

import {
    createWebsiteOrderSchema,
  } from "./websiteOrdersSchemas.js";
  
  import {
    createWebsiteOrder,
  } from "./websiteOrdersService.js";
  
  
  export default async function websiteOrdersRoutes(
    fastify
  ) {
  
    fastify.post(
      "/orders",
      {
        schema: {
          ...createWebsiteOrderSchema,
          description: createWebsiteOrderSchema.description +
            " When backend payments are disabled, HTTP 201 contains only the Stage 2 response. " +
            " When enabled, HTTP 201 also contains an order-scoped paymentAccessToken, freshly issued on replay. " +
            " Missing or invalid payment-token signing configuration causes HTTP 503 only when enabled.",
          response: {
            ...createWebsiteOrderSchema.response,
            201: {
              ...createWebsiteOrderSchema.response[201],
              properties: {
                ...createWebsiteOrderSchema.response[201].properties,
                paymentAccessToken: {
                  type: "string",
                  description: "Present only when backend payment initiation is enabled.",
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
  
        try {
  
          const duplicateKey = request.raw.rawHeaders.filter(
            (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key"
          ).length > 1;

          const secret = websiteOzonPayEnabled ? requireWebsitePaymentTokenSecret() : undefined;
          const response =
            await createWebsiteOrder(
              request.body,
              duplicateKey ? [] : request.headers["idempotency-key"]
            );
          if (!websiteOzonPayEnabled) return reply.code(201).send(response);

          const orderId = response?.success === true ? response.order?.id : undefined;
          const paymentAccessToken = issueWebsitePaymentAccessToken(orderId, secret);

          return reply
            .code(201)
            .header("Cache-Control", "no-store")
            .send({ ...response, paymentAccessToken });
  
  
        } catch (error) {
  
          const statusCode =
            error.statusCode || 500;

          // Upstream errors can contain customer data or credentials. Never log
          // the original error, request payload or idempotency header here.
          request.log.error({ statusCode }, "Website order request failed");

          if (statusCode === 503 || error.code === "ORDER_IN_PROGRESS") {
            reply.header("Retry-After", "2");
          }
  
  
          return reply
            .code(statusCode)
            .send({
              success: false,
              code: error.code,
  
              message:
                statusCode === 500
                  ? "Failed to create website order"
                  : error.message,
            });
  
        }
  
      }
    );
  
  }
