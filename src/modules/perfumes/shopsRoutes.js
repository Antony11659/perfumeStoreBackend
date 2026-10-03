import { supabase } from "../../lib/supabase.js";

import {
  getShopsSchema,
} from "./shopsSchemas.js";


export default async function shopsRoutes(fastify) {

  fastify.get("/", {
    schema: getShopsSchema,
  }, async (request, reply) => {

    const { data, error } = await supabase
      .from("shops")
      .select(`
        id,
        name,
        code,
        marketplace,
        is_active
      `)
      .eq("is_active", true)
      .order("name");


    if (error) {
      request.log.error(error);

      return reply.code(500).send({
        message: "Failed to load shops",
      });
    }


    return data;
  });

}