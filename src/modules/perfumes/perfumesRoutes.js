import { supabase } from "../../lib/supabase.js";
import {
  getPerfumesSchema,
  getPerfumeByIdSchema,
  updatePerfumeSchema,
  createPerfumeSchema,
  getPerfumeShopProductsSchema,
  createPerfumeShopProductSchema,
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

  fastify.post("/", {
    schema: createPerfumeSchema,
  }, async (request, reply) => {
  
    const {
      name,
      brand_id,
      gender,
      fragrance_family,
    } = request.body;
  
    const perfumeName = name.trim();
  
    const fragranceFamily =
      fragrance_family?.trim() || null;
  
  
    // 1. Make sure brand exists
  
    const {
      data: brand,
      error: brandError,
    } = await supabase
      .from("brands")
      .select(`
        id,
        name,
        country
      `)
      .eq("id", brand_id)
      .maybeSingle();
  
  
    if (brandError) {
      request.log.error(brandError);
  
      return reply.code(500).send({
        message: "Failed to check brand",
      });
    }
  
  
    if (!brand) {
      return reply.code(404).send({
        message: "Brand not found",
      });
    }

    
  
  
    // 2. Create perfume
  
    const {
      data: perfume,
      error: perfumeError,
    } = await supabase
      .from("perfumes")
      .insert({
        name: perfumeName,
        brand_id,
        gender,
        fragrance_family: fragranceFamily,
      })
      .select(`
        id,
        name,
        gender,
        fragrance_family
      `)
      .single();
  
  
    if (perfumeError) {
  
      // unique (brand_id, name)
      if (perfumeError.code === "23505") {
        return reply.code(409).send({
          message: "Perfume already exists for this brand",
        });
      }
  
      request.log.error(perfumeError);
  
      return reply.code(500).send({
        message: "Failed to create perfume",
      });
    }
  
  
    // 3. Create standard variants
  
    const standardVolumes = [
      1,
      3,
      5,
      10,
      20,
      30,
      50,
    ];
  
  
    const variantsToInsert = standardVolumes.map(
      (volume) => ({
        perfume_id: perfume.id,
        volume_ml: volume,
      })
    );
  
  
    const {
      data: variants,
      error: variantsError,
    } = await supabase
      .from("perfume_variants")
      .insert(variantsToInsert)
      .select(`
        id,
        volume_ml
      `);
  
  
    if (variantsError) {
      request.log.error(variantsError);
  
      return reply.code(500).send({
        message: "Perfume created but failed to create variants",
      });
    }
  
  
    // 4. Return complete perfume
  
    return reply.code(201).send({
      ...perfume,
  
      brand,
  
      variants: variants.sort(
        (a, b) => a.volume_ml - b.volume_ml
      ),
  
      images: [],
    });
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

  fastify.get("/:id/shop-products", {
    schema: getPerfumeShopProductsSchema,
  }, async (request, reply) => {
  
    const { id: perfumeId } = request.params;
  
  
    const { data, error } = await supabase
      .from("shop_products")
      .select(`
        id,
        volume_ml,
        sku,
        is_active,
        is_archived,
  
        shop:shops (
          id,
          name,
          code,
          marketplace
        )
      `)
      .eq("perfume_id", perfumeId)
      .order("volume_ml");
  
  
    if (error) {
      request.log.error(error);
  
      return reply.code(500).send({
        message: "Failed to load perfume shop products",
      });
    }
  
  
    return data;
  });

  fastify.post("/:id/shop-products", {
    schema: createPerfumeShopProductSchema,
  }, async (request, reply) => {
  
    const { id: perfumeId } = request.params;
  
    const {
      shop_id,
      volume_ml,
      sku,
    } = request.body;
  
    const cleanSku = sku.trim();
  
  
    // Check that this perfume + volume actually exists.
  
    const {
      data: variant,
      error: variantError,
    } = await supabase
      .from("perfume_variants")
      .select("id")
      .eq("perfume_id", perfumeId)
      .eq("volume_ml", volume_ml)
      .maybeSingle();
  
  
    if (variantError) {
      request.log.error(variantError);
  
      return reply.code(500).send({
        message: "Failed to check perfume variant",
      });
    }
  
  
    if (!variant) {
      return reply.code(400).send({
        message: "This volume does not exist for this perfume",
      });
    }
  
  
    // Check that shop exists.
  
    const {
      data: shop,
      error: shopError,
    } = await supabase
      .from("shops")
      .select(`
        id,
        name,
        code,
        marketplace
      `)
      .eq("id", shop_id)
      .maybeSingle();
  
  
    if (shopError) {
      request.log.error(shopError);
  
      return reply.code(500).send({
        message: "Failed to check shop",
      });
    }
  
  
    if (!shop) {
      return reply.code(404).send({
        message: "Shop not found",
      });
    }
  
  
    // Create SKU mapping.
  
    const {
      data,
      error,
    } = await supabase
      .from("shop_products")
      .insert({
        perfume_id: perfumeId,
        volume_ml,
        shop_id,
        sku: cleanSku,
      })
      .select(`
        id,
        perfume_id,
        volume_ml,
        sku,
        is_active,
        is_archived
      `)
      .single();
  
  
    if (error) {
  
      // sku is UNIQUE
      if (error.code === "23505") {
        return reply.code(409).send({
          message: "SKU already exists",
        });
      }
  
      request.log.error(error);
  
      return reply.code(500).send({
        message: "Failed to create SKU",
      });
    }
  
  
    return reply.code(201).send({
      ...data,
      shop,
    });
  });
  
}