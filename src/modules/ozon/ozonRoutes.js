import { createOzonShopsSession, getPackagingPage, preparePackagingOrders } from "./ozonService.js";
import { saveOzonSession, getOzonSession } from "./ozonSessions.js";
  
  
export default async function ozonRoutes(fastify) {
  
    fastify.post("/session", async (request, reply) => {
      const session = await createOzonShopsSession();
  
      const savedSession = await saveOzonSession(session);
  
      return reply.code(201).send(savedSession);
    });

    fastify.get("/packaging", async (request, reply) => {
        const rawOrders = await getOzonSession();
        const preparedOrders = preparePackagingOrders(rawOrders);
      
        const {
          startNum,
          startIndex,
          limit
        } = request.query;
      
        const page = getPackagingPage(preparedOrders, {
          startNum,
          startIndex,
          limit
        });
      
        if (!page) {
          return reply.code(404).send({
            error: "Order not found"
          });
        }
      
        return page;
      });
  
}