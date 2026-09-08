import Fastify from "fastify";
import { supabase } from "./lib/supabase.js";

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

// fastify.post("/perfumes", async (request, reply) => {
//     const id = Number(request.body.id);
//     const { name, brand, price } = request.body;
//     const newItem = {
//         id: 3,
//         name,
//         brand,
//         price
//     }
//     if(name.length > 0 && brand.length > 0 && price >= 0) {
//         perfumes.push(newItem);
//         reply.code(201).send(perfumes);
//     }else{
//         reply.code(404).send('Error to add a new item')
//     }
// });

// fastify.get('/perfumes/:id', async (request, reply) => {
//     const id = Number(request.params.id);
//     const item = perfumes.find(el => el.id === id);

//     if (!item) {
//         reply.code(404).send("Perfume not found");
//         return;
//     }

//     return item;
// });

fastify.get("/health", async () => {
  return {
    status: "ok",
    message: "Perfume Store API is running",
  };
});

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