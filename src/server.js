import "dotenv/config";

import Fastify from "fastify";
import cors from "@fastify/cors";

import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

import { supabase } from "./lib/supabase.js";
import erpRoutes, { erpBearer } from "./modules/erp/erpRoutes.js";
import brandsRoutes from "./modules/perfumes/brandsRoutes.js";
import perfumeRoutes from "./modules/perfumes/perfumesRoutes.js";
import ozonRoutes from "./modules/ozon/ozonRoutes.js";
import shopsRoutes from "./modules/perfumes/shopsRoutes.js";
import pricingRoutes from "./modules/pricing/pricingRoutes.js";
import promoRoutes from "./modules/promo/promoRoutes.js";
import websiteOrdersRoutes from "./modules/website/websiteOrdersRoutes.js";
import websiteDeliveryRoutes from "./modules/website/websiteDeliveryRoutes.js";
import websiteDeliveryCreationRoutes from "./modules/website/websiteDeliveryCreationRoutes.js";
import websiteDeliveryWorker from "./modules/website/websiteDeliveryWorker.js";
import websitePaymentRoutes from "./modules/website/websitePaymentRoutes.js";
import ozonSellerOAuthRoutes from "./modules/delivery/ozonSeller/ozonSellerOAuthRoutes.js";


import { saveRaspivSession, getRaspivSession } from "./temporary/raspiv.js"; // should be deleted 

const fastify = Fastify({
  logger: true,
});

await fastify.register(cors, {
  origin: true,
  methods: [
    "GET",
    "POST",
    "PATCH",
    "PUT",
    "DELETE",
    "OPTIONS",
  ],
});

await fastify.register(swagger, {
  openapi: {
    openapi: "3.0.3",
    info: {
      title: "Perfume Store ERP API",
      description: "API for managing the perfume catalogue and ERP operations",
      version: "1.0.0",
    },
    components: { securitySchemes: { erpBearer } },
    tags: [
      { name: "ERP", description: "Staff-only ERP endpoints" },
      {
        name: "Perfumes",
        description: "Perfume catalogue endpoints",
      },
      {

        name: "Pricing",
        description: "Website, discount and wholesale pricing",
    
      },
      {
        name: "Promo",
        description: "Promo code validation and activation",
      },
      {
        name: "Ozon Seller Logistics",
        description: "Ozon Seller OAuth and customer pickup point discovery",
      },
    ],
  },
});

await fastify.register(swaggerUi, {
  routePrefix: "/documentation",
});

await fastify.register(erpRoutes, {
  prefix: "/erp",
  getUser: (token) => supabase.auth.getUser(token),
  db: supabase,
});

await fastify.register(perfumeRoutes, {
  prefix: "/perfumes",
});

fastify.register(brandsRoutes, {
  prefix: "/brands",
});

fastify.register(shopsRoutes, {
  prefix: "/shops",
});

await fastify.register(ozonRoutes, {
  prefix: "/ozon",
});

await fastify.register(
  ozonSellerOAuthRoutes,
  {
    prefix: "/ozon-seller",
  }
);

fastify.register(
  websiteDeliveryRoutes,
  {
    prefix: "/website/delivery",
  }
);

fastify.register(websiteDeliveryCreationRoutes);
fastify.register(websiteDeliveryWorker);

// await fastify.register(ozonDeliveryRoutes, {
//   prefix: "/delivery/ozon",
// });

fastify.register(
  websiteOrdersRoutes
);
fastify.register(
  websitePaymentRoutes
);

fastify.register(pricingRoutes, {
  prefix: "/prices",
});

fastify.register(promoRoutes, {
  prefix: "/promo",
});

fastify.register(websiteOrdersRoutes, {
  prefix: "/website",
});

fastify.get("/health", async () => {
  return {
    status: "ok",
    message: "Perfume Store API is running",
  };
});



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

const shutdown = async () => {
  try {
    await fastify.close();
  } catch {
    fastify.log.error("Backend shutdown failed");
    process.exitCode = 1;
  }
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
start();
