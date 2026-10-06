import { createOzonClient } from "./ozonClient.js";
import { supabase } from "../../lib/supabase.js";


export const getShopOrders = async (shopName) => {
  const ozonClient = createOzonClient(shopName);

  const to = new Date();
  const since = new Date(to);

  since.setDate(since.getDate() - 10);

  const orders = [];

  let cursor = "";

  while (true) {
    const data = await ozonClient.post(
      "/v4/posting/fbs/list",
      {
        filter: {
          since: since.toISOString(),
          to: to.toISOString(),
          statuses: ["awaiting_deliver"],
        },

        limit: 100,
        cursor,

        with: {
          barcodes: true,
        },
      }
    );

    if (!Array.isArray(data?.postings)) {
      throw new Error(
        `Unexpected Ozon response for shop: ${shopName}`
      );
    }

    orders.push(...data.postings);

    if (!data.has_next) {
      break;
    }

    cursor = data.cursor;
  }

  return orders;
};

export const createOzonShopsSession = async () => {
    const { data, error } = await supabase
      .from("shops")
      .select("code")
      .eq("marketplace", "ozon")
      .eq("is_active", true);

    if (error) {
      throw new Error(
        `Failed to load Ozon shops: ${error.message}`
      );
    }

    const shops = data.map((shop) => shop.code);
  
    const shopsOrders = await Promise.all(
      shops.map(async (shop) => {
        const orders = await getShopOrders(shop);
  
        return {
          shop,
          orders
        };
      })
    );
  
    return {
      createdAt: new Date().toISOString(),
      shops: shopsOrders
    };
  };


  const normalizeNum = (ii, orderNumber) => {
    if (ii) {
      return ii.slice(-4);
    }
  
    const dashIndex = orderNumber.indexOf("-");
  
    return orderNumber.slice(dashIndex);
  };

  const normalizeSearchNum = (value) => {
    return String(value ?? "").replace(/\D/g, "");
  };


  const prepareProduct = (product, productsBySku) => {
    const sku = String(product.sku);
  
    const productData = productsBySku.get(sku);
  
    if (!productData) {
      return {
        sku,
        name: product.offer_id,
        volume: null,
        quantity: product.quantity,
        unknown: true,
      };
    }
  
    return {
      sku,
      name: productData.name,
      volume: productData.volume,
      quantity: product.quantity,
      unknown: false,
    };
  };
  
  
  export const preparePackagingOrders = async (session) => {
    const skus = [...new Set(session.shops.flatMap((shop) => {
      return shop.orders.flatMap((order) => {
        return order.products.map((product) => String(product.sku));
      });
    }))];

    const productsBySku = new Map();

    if (skus.length > 0) {
      const { data, error } = await supabase
        .from("shop_products")
        .select("sku, perfume_id, volume_ml")
        .in("sku", skus);

      if (error) {
        throw new Error(
          `Failed to load packaging products: ${error.message}`
        );
      }

      const perfumeIds = [...new Set(data.map((product) => product.perfume_id))];
      const perfumeNamesById = new Map();

      if (perfumeIds.length > 0) {
        const { data: perfumes, error: perfumesError } = await supabase
          .from("perfumes")
          .select("id, name")
          .in("id", perfumeIds);

        if (perfumesError) {
          throw new Error(
            `Failed to load packaging perfumes: ${perfumesError.message}`
          );
        }

        for (const perfume of perfumes) {
          perfumeNamesById.set(perfume.id, perfume.name);
        }
      }

      for (const product of data) {
        productsBySku.set(String(product.sku), {
          name: perfumeNamesById.get(product.perfume_id),
          volume: product.volume_ml,
        });
      }
    }

    const orders = session.shops.flatMap((shop) => {
      return shop.orders.map((order) => {
        const ii = order.scanit;
        const orderNumber = order.posting_number;
  
        return {
          ii,
          orderNumber,
          displayedNum: normalizeNum(ii, orderNumber),
          products: order.products.map(order => prepareProduct(order, productsBySku)),
          shop: shop.shop,
        };
      });
    });
  
    return orders;
  };


  

  export const getPackagingPage = (
    orders,
    {
      startNum,
      startIndex = 0,
      limit = 10
    } = {}
  ) => {
    let index = Number(startIndex);
    const pageLimit = Number(limit);
  
    if (startNum !== undefined && startNum !== "") {
      const searchNum = normalizeSearchNum(startNum);
  
      index = orders.findIndex((order) => {
        const orderNum = normalizeSearchNum(
          order.displayedNum
        );
  
        return orderNum === searchNum;
      });
  
      if (index === -1) {
        return null;
      }
    }
  
    const pageOrders = orders.slice(
      index,
      index + pageLimit
    );
  
    const nextIndex = index + pageOrders.length;
  
    return {
      startIndex: index,
      nextIndex,
      limit: pageLimit,
      hasNext: nextIndex < orders.length,
      totalOrders: orders.length,
      orders: pageOrders,
    };
  };
