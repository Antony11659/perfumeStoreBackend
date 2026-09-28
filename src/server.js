import "dotenv/config";

import Fastify from "fastify";
import cors from "@fastify/cors";

import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";


import perfumeRoutes from "./modules/perfumes/perfumesRoutes.js";
import ozonRoutes from "./modules/ozon/ozonRoutes.js";

import { saveRaspivSession, getRaspivSession } from "./temporary/raspiv.js"; // should be deleted 

const fastify = Fastify({
  logger: true,
});

await fastify.register(cors, {
  origin: true,
});

await fastify.register(swagger, {
  openapi: {
    openapi: "3.0.3",
    info: {
      title: "Perfume Store ERP API",
      description: "API for managing the perfume catalogue and ERP operations",
      version: "1.0.0",
    },
    tags: [
      {
        name: "Perfumes",
        description: "Perfume catalogue endpoints",
      },
    ],
  },
});

await fastify.register(swaggerUi, {
  routePrefix: "/documentation",
});

await fastify.register(perfumeRoutes, {
  prefix: "/perfumes",
});

await fastify.register(ozonRoutes, {
  prefix: "/ozon",
});

fastify.get("/health", async () => {
  return {
    status: "ok",
    message: "Perfume Store API is running",
  };
});

// START OZON SESSIONS SECTION



// END OZON SESSIONS SECTION 


// START TEMPORARY SECTION

fastify.get("/raspiv/session", async () => {
  const products = await getRaspivSession();

  return products;
});

fastify.post("/raspiv/session", async (request, reply) => {
  const products = request.body;

  await saveRaspivSession(products);

  return {
    success: true
  };
});

// END TEMPORARY SECTION

const start = async () => {
  try {
    await fastify.listen({
      port: 3000,
      host: "0.0.0.0",
    });
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
};

start();
