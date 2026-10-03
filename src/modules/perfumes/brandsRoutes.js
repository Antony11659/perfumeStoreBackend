import { supabase } from "../../lib/supabase.js";

import {
  getBrandsSchema,
  createBrandSchema,
} from "./brandsSchemas.js";


export default async function brandsRoutes(fastify) {

  // GET /brands
  fastify.get("/", {
    schema: getBrandsSchema,
  }, async (request, reply) => {

    const { data, error } = await supabase
      .from("brands")
      .select(`
        id,
        name,
        country,
        created_at,
        updated_at
      `)
      .order("name");

    if (error) {
      request.log.error(error);

      return reply.code(500).send({
        message: "Failed to load brands",
      });
    }

    return data;
  });


  // POST /brands
  fastify.post("/", {
    schema: createBrandSchema,
  }, async (request, reply) => {

    const {
      name,
      country,
    } = request.body;

    const brandName = name.trim();
    const brandCountry = country?.trim() || null;

    const { data, error } = await supabase
      .from("brands")
      .insert({
        name: brandName,
        country: brandCountry,
      })
      .select(`
        id,
        name,
        country,
        created_at,
        updated_at
      `)
      .single();


    if (error) {

      // PostgreSQL unique constraint violation
      if (error.code === "23505") {
        return reply.code(409).send({
          message: "Brand already exists",
        });
      }

      request.log.error(error);

      return reply.code(500).send({
        message: "Failed to create brand",
      });
    }


    return reply
      .code(201)
      .send(data);
  });

}