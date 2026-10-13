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
  
          const order =
            await createWebsiteOrder(
              request.body
            );
  
  
          return reply
            .code(201)
            .send({
              success: true,
              order,
            });
  
  
        } catch (error) {
  
          request.log.error(error);
  
  
          const statusCode =
            error.statusCode || 500;
  
  
          return reply
            .code(statusCode)
            .send({
              success: false,
  
              message:
                statusCode === 500
                  ? "Failed to create website order"
                  : error.message,
            });
  
        }
  
      }
    );
  
  }