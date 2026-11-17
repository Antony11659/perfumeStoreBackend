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
        schema: createWebsiteOrderSchema,
      },
      async (request, reply) => {
  
        try {
  
          const duplicateKey = request.raw.rawHeaders.filter(
            (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key"
          ).length > 1;

          const response =
            await createWebsiteOrder(
              request.body,
              duplicateKey ? [] : request.headers["idempotency-key"]
            );
  
  
          return reply
            .code(201)
            .send(response);
  
  
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
