import { supabase } from "../../lib/supabase.js";

import {
  getPricesSchema,
} from "./pricingSchemas.js";


export default async function pricingRoutes(fastify) {

  // GET /prices
  fastify.get("/", {
    schema: getPricesSchema,
  }, async (request, reply) => {

    const { data, error } = await supabase
      .from("prices")
      .select(`
        id,
        volume_ml,
        website_price,
        discount_price,
        wholesale_price,
        created_at,
        updated_at
      `)
      .order("volume_ml");

    if (error) {
      request.log.error(error);

      return reply.code(500).send({
        message: "Failed to load prices",
      });
    }

    return data;
  });

}