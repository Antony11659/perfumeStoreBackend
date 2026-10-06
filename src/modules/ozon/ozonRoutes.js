import {
  createOzonShopsSession,
  getPackagingPage,
  preparePackagingOrders,
} from "./ozonService.js";

import {
  saveOzonSession,
  getOzonSession,
} from "./ozonSessions.js";

import {
  createOzonSessionSchema,
  getOzonSessionSchema,
  getPackagingSchema,
} from "./ozonSchemas.js";


export default async function ozonRoutes(fastify) {

  fastify.post("/session", {
    schema: createOzonSessionSchema,
  }, async (request, reply) => {
    try {
      const session = await createOzonShopsSession();

      const savedSession = await saveOzonSession(session);

      return reply.code(201).send(savedSession);

    } catch (error) {
      request.log.error(error);

      return reply.code(500).send({
        error: error.message,
      });
    }
  });


  fastify.get("/session", {
    schema: getOzonSessionSchema,
  }, async (request, reply) => {
    try {
      const session = await getOzonSession();

      return session;

    } catch (error) {
      request.log.error(error);

      return reply.code(500).send({
        error: error.message,
      });
    }
  });


  fastify.get("/packaging", {
    schema: getPackagingSchema,
  }, async (request, reply) => {
    try {
      const rawOrders = await getOzonSession();

      const preparedOrders = await preparePackagingOrders(rawOrders);

      const {
        startNum,
        startIndex,
        limit,
      } = request.query;

      const page = getPackagingPage(preparedOrders, {
        startNum,
        startIndex,
        limit,
      });

      if (!page) {
        return reply.code(404).send({
          error: "Order not found",
        });
      }

      return page;

    } catch (error) {
      request.log.error(error);

      return reply.code(500).send({
        error: error.message,
      });
    }
  });

}