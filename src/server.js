import Fastify from "fastify";
import { supabase } from "./lib/supabase.js";

import { saveRaspivSession, getRaspivSession } from "./temporary/raspiv.js"; // should be deleted 

const fastify = Fastify({
  logger: true,
});


fastify.get("/perfumes", async (request, reply) => {
    const { data, error } = await supabase
      .from("perfumes")
      .select("*")
      .order("name");
  
    if (error) {
      fastify.log.error(error);
  
      return reply.code(500).send({
        message: "Failed to load perfumes",
      });
    }
  
    return data;
  });

fastify.get("/health", async () => {
  return {
    status: "ok",
    message: "Perfume Store API is running",
  };
});

// START TEMPORARY SECTION

fastify.get("/raspiv/session", async () => {
  const products = getRaspivSession();

  return products;
});

fastify.post("/raspiv/session", async (request, reply) => {
  const products = request.body;

  saveRaspivSession(products);

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