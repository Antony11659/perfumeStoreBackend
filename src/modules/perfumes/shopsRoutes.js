import { supabase } from "../../lib/supabase.js";
import { createOzonClient } from "../ozon/ozonClient.js";

import {
  getShopsSchema,
  getMissingShopProductsSchema,
} from "./shopsSchemas.js";


export default async function shopsRoutes(fastify) {

  // GET ALL ACTIVE SHOPS
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


  // GET OZON PRODUCTS THAT ARE NOT MAPPED IN SUPABASE
  fastify.get("/:id/missing-products",{
    schema: getMissingShopProductsSchema,
  }, async (request, reply) => {

    const { id: shopId } = request.params;


    // 1. Get shop
    const { data: shop, error: shopError } = await supabase
      .from("shops")
      .select(`
        id,
        name,
        code,
        marketplace
      `)
      .eq("id", shopId)
      .maybeSingle();


    if (shopError) {
      request.log.error(shopError);

      return reply.code(500).send({
        message: "Failed to load shop",
      });
    }


    if (!shop) {
      return reply.code(404).send({
        message: "Shop not found",
      });
    }


    if (shop.marketplace.toLowerCase() !== "ozon") {
      return reply.code(400).send({
        message: "Missing product checker currently supports Ozon only",
      });
    }


    try {

      const ozon = createOzonClient(shop.code);


      // 2. Get ALL visible products from Ozon
      const ozonProducts = [];

      let lastId = "";


      while (true) {

        const response = await ozon.post("/v3/product/list", {
          filter: {
            visibility: "VISIBLE",
          },

          last_id: lastId,
          limit: 1000,
        });


        const result = response.result;

        const items = result?.items ?? [];


        ozonProducts.push(...items);


        // No more products
        if (items.length === 0) {
          break;
        }


        const nextLastId = result?.last_id;


        // Ozon did not give us another page
        if (!nextLastId || nextLastId === lastId) {
          break;
        }


        lastId = nextLastId;


        // Last page was smaller than limit
        if (items.length < 1000) {
          break;
        }
      }


// 3. Get ALL SKU mappings that already exist
// for THIS shop in Supabase
const mappedProducts = [];

const pageSize = 1000;
let from = 0;

while (true) {
  const { data, error } = await supabase
    .from("shop_products")
    .select("sku")
    .eq("shop_id", shopId)
    .range(from, from + pageSize - 1);

  if (error) {
    request.log.error(error);

    return reply.code(500).send({
      message: "Failed to load mapped shop products",
    });
  }

  mappedProducts.push(...data);

  if (data.length < pageSize) {
    break;
  }

  from += pageSize;
}


      // 4. Create fast lookup Set
      //
      // Supabase SKU = text
      // Ozon SKU = number
      //
      // Normalize both to String.
      const mappedSkus = new Set(
        mappedProducts.map((product) => String(product.sku))
      );


      // 5. Find products that exist in Ozon
      // but do NOT exist in shop_products
      const missingProducts = ozonProducts
        .filter((product) => {
          return !mappedSkus.has(String(product.sku));
        })
        .map((product) => ({
          sku: String(product.sku),
          offer_id: product.offer_id,
        }));


      // 6. Return useful statistics + missing products
      return {
        shop: {
          id: shop.id,
          name: shop.name,
          code: shop.code,
          marketplace: shop.marketplace,
        },

        stats: {
          ozonProducts: ozonProducts.length,
          mappedProducts: mappedProducts.length,
          missingProducts: missingProducts.length,
        },

        missingProducts,
      };


    } catch (error) {

      request.log.error(error);

      return reply.code(500).send({
        message: error.message,
      });
    }

  });

}