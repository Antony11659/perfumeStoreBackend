import { supabase } from "../../lib/supabase.js";

import {
  activatePromoSchema,
} from "./promoSchemas.js";


export default async function promoRoutes(fastify) {

  // POST /promo/activate
  fastify.post("/activate", {
    schema: activatePromoSchema,
  }, async (request, reply) => {

    const code = request.body.code
      .trim()
      .toUpperCase();


    const { data, error } = await supabase
      .from("promo_codes")
      .select(`
        id,
        code,
        is_active
      `)
      .eq("code", code)
      .eq("is_active", true)
      .maybeSingle();


    if (error) {
      request.log.error(error);

      return reply.code(500).send({
        success: false,
        message: "Failed to validate promo code",
      });
    }


    if (!data) {
      return reply.code(400).send({
        success: false,
        message: "Invalid promo code",
      });
    }


    return {
      success: true,
      pricingMode: "discount",
    };
  });

}