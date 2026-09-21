import { supabase } from "../../lib/supabase.js";
import { getPerfumesSchema, getPerfumeByIdSchema } from "./perfumesSchemas.js";

export default async function perfumeRoutes(fastify) {
  fastify.get("/", {
    schema: getPerfumesSchema,
  }, async (request, reply) => {
    const { data, error } = await supabase
      .from("perfumes")
      .select(`
        id,
        name,
        gender,
        fragrance_family,
        created_at,
        updated_at,
        brand: brands(
        id,
        name,
        country)`)
      .order("name");

    if (error) {
      request.log.error(error);

      return reply.code(500).send({
        message: "Failed to load perfumes",
      });
    }

    return data;
  });

  fastify.get("/:id", {
    schema: getPerfumeByIdSchema,
  }, async (request, reply) => {
    const { id: perfumeId } = request.params;

    const { data, error } = await supabase
      .from("perfumes")
      .select(`
        id,
        name,
        gender,
        fragrance_family,
        created_at,
        updated_at,
        brand: brands (
          id,
          name,
          country
        )
      `)
      .eq("id", perfumeId)
      .maybeSingle();

    if (error) {
      request.log.error(error);

      return reply.code(500).send({
        message: "Failed to load the perfume",
      });
    }

    if (!data) {
      return reply.code(404).send({
        message: "Perfume not found",
      });
    }

    return data;
  });
}
