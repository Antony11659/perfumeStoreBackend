import { supabase } from "../../lib/supabase.js";
import {
  getPerfumesSchema,
  getPerfumeByIdSchema,
  updatePerfumeSchema,
} from "./perfumesSchemas.js";

export default async function perfumeRoutes(fastify) {

  /**
   * GET /perfumes
   *
   * Returns the complete canonical perfume catalog:
   * - perfume information
   * - brand
   * - volume variants
   * - website images
   *
   * Marketplace SKUs are intentionally not returned here.
   */
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
  
        brand:brands (
          id,
          name,
          country
        ),
  
        variants:perfume_variants (
          id,
          volume_ml
        ),
  
        images:perfume_images (
          id,
          image_url,
          sort_order,
          is_primary
        )
      `)
      .order("name");
  
    if (error) {
      request.log.error(error);
  
      return reply.code(500).send({
        message: "Failed to load perfumes",
      });
    }
  
    const perfumes = data.map((perfume) => ({
      ...perfume,
  
      variants: (perfume.variants ?? []).sort(
        (a, b) => a.volume_ml - b.volume_ml
      ),
  
      images: (perfume.images ?? []).sort(
        (a, b) => a.sort_order - b.sort_order
      ),
    }));
  
    return perfumes;
  });


  /**
   * GET /perfumes/:id
   *
   * Returns everything needed to manage one perfume:
   * - perfume information
   * - brand
   * - volume variants
   * - website images
   * - marketplace products/SKUs
   * - shop information
   */
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
  
        brand:brands (
          id,
          name,
          country
        ),
  
        variants:perfume_variants (
          id,
          volume_ml
        ),
  
        images:perfume_images (
          id,
          image_url,
          sort_order,
          is_primary
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
  
    return {
      ...data,
  
      variants: (data.variants ?? []).sort(
        (a, b) => a.volume_ml - b.volume_ml
      ),
  
      images: (data.images ?? []).sort(
        (a, b) => a.sort_order - b.sort_order
      ),
  
      shop_products: [],
    };
  });

  fastify.patch("/:id", {
    schema: updatePerfumeSchema,
  }, async (request, reply) => {
  
    const { id: perfumeId } = request.params;
  
    const {
      name,
      gender,
      fragrance_family,
    } = request.body;
  
    const updates = {
      updated_at: new Date().toISOString(),
    };
  
    if (name !== undefined) {
      updates.name = name.trim();
    }
  
    if (gender !== undefined) {
      updates.gender = gender;
    }
  
    if (fragrance_family !== undefined) {
      updates.fragrance_family = fragrance_family;
    }
  
    const { data, error } = await supabase
      .from("perfumes")
      .update(updates)
      .eq("id", perfumeId)
      .select(`
        id,
        name,
        gender,
        fragrance_family,
        updated_at
      `)
      .maybeSingle();
  
    if (error) {
      request.log.error(error);
  
      return reply.code(500).send({
        message: "Failed to update perfume",
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