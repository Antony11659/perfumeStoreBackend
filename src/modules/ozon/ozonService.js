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


  

  export const prepareStickingLabels = async (session, preparedOrders) => {
    const orders =
      preparedOrders ?? await preparePackagingOrders(session);
  
    const labelsByName = new Map();
    const volumesByName = new Map();
    const unknownProductsByShopSku = new Map();
  
  
    // --------------------------------------------------
    // COLLECT PRODUCTS
    // --------------------------------------------------
  
    for (const order of orders) {
      for (const product of order.products) {
  
        // UNKNOWN SKU
        if (product.unknown) {
          const key = JSON.stringify([
            order.shop,
            product.sku
          ]);
  
          const unknownProduct =
            unknownProductsByShopSku.get(key);
  
          if (unknownProduct) {
            unknownProduct.quantity += product.quantity;
          } else {
            unknownProductsByShopSku.set(key, {
              sku: product.sku,
              offer_id: product.name,
              quantity: product.quantity,
              shop: order.shop,
            });
          }
  
          continue;
        }
  
  
        if (!product.name) {
          continue;
        }
  
  
        // TOTAL QUANTITY BY PERFUME NAME
        labelsByName.set(
          product.name,
          (labelsByName.get(product.name) ?? 0) +
            product.quantity
        );
  
  
        // QUANTITY BY PERFUME + VOLUME
        if (!volumesByName.has(product.name)) {
          volumesByName.set(
            product.name,
            new Map()
          );
        }
  
        const volumes =
          volumesByName.get(product.name);
  
        volumes.set(
          product.volume,
          (volumes.get(product.volume) ?? 0) +
            product.quantity
        );
      }
    }
  
  
    // --------------------------------------------------
    // SORT PERFUMES BY TOTAL QUANTITY
    // --------------------------------------------------
  
    const sortedLabels = [...labelsByName]
      .map(([name, quantity]) => ({
        name,
        quantity,
      }))
      .sort(
        (a, b) =>
          b.quantity - a.quantity
      );
  
  
    // --------------------------------------------------
    // REGULAR + UNIQUE
    // --------------------------------------------------
  
    const regularLabels = [];
    const uniqueByVolume = new Map();
  
  
    for (const label of sortedLabels) {
      const {
        name,
        quantity
      } = label;
  
  
      // REGULAR PERFUME
      if (quantity > 1) {
        regularLabels.push({
          name,
          quantity,
        });
  
        continue;
      }
  
  
      // UNIQUE PERFUME
      const volumes =
        volumesByName.get(name);
  
      if (!volumes) {
        continue;
      }
  
  
      const volume =
        [...volumes.keys()][0];
  
  
      if (!uniqueByVolume.has(volume)) {
        uniqueByVolume.set(
          volume,
          []
        );
      }
  
  
      uniqueByVolume
        .get(volume)
        .push(name);
    }
  
  
    // --------------------------------------------------
    // FINAL PRINTER LABEL ARRAY
    // --------------------------------------------------
  
    const labels = [
      ...regularLabels
    ];
  
  
    const sortedVolumes =
      [...uniqueByVolume.keys()]
        .sort(
          (a, b) =>
            Number(a) - Number(b)
        );
  
  
    // --------------------------------------------------
    // UNIQUE GROUPS
    //
    // Structure:
    //
    // blank
    // ОДИНОЧНЫЕ 1 МЛ
    // perfume
    // perfume
    //
    // blank
    // ОДИНОЧНЫЕ 3 МЛ
    // perfume
    // perfume
    //
    // blank
    // --------------------------------------------------
  
    for (const volume of sortedVolumes) {
      const perfumeNames =
        uniqueByVolume.get(volume);
  
  
      // START OF THIS UNIQUE GROUP
      // Also ends the previous unique group.
      labels.push({
        name: "",
        quantity: 1,
      });
  
  
      // GROUP HEADER
      labels.push({
        name: `ОДИНОЧНЫЕ ${volume} МЛ`,
        quantity: 1,
      });
  
  
      // PERFUMES
      for (const name of perfumeNames) {
        labels.push({
          name,
          quantity: 1,
        });
      }
    }
  
  
    // FINAL BLANK
    // Ends the last unique group.
    if (sortedVolumes.length > 0) {
      labels.push({
        name: "",
        quantity: 1,
      });
    }
  
  
    return {
      labels,
  
      unknownProducts:
        [...unknownProductsByShopSku.values()],
    };
  };


  export const prepareStickingPlan = async (session) => {
    const orders = await preparePackagingOrders(session);
  
    const totalsByName = new Map();
    const volumesByName = new Map();
    const unknownProductsByShopSku = new Map();
  
    for (const order of orders) {
      for (const product of order.products) {
        if (product.unknown) {
          const key = JSON.stringify([
            order.shop,
            product.sku
          ]);
  
          const existing =
            unknownProductsByShopSku.get(key);
  
          if (existing) {
            existing.quantity += product.quantity;
          } else {
            unknownProductsByShopSku.set(key, {
              sku: product.sku,
              offer_id: product.name,
              quantity: product.quantity,
              shop: order.shop,
            });
          }
  
          continue;
        }
  
        if (!product.name) {
          continue;
        }
  
        totalsByName.set(
          product.name,
          (totalsByName.get(product.name) ?? 0) +
            product.quantity
        );
  
        if (!volumesByName.has(product.name)) {
          volumesByName.set(
            product.name,
            new Map()
          );
        }
  
        const volumes =
          volumesByName.get(product.name);
  
        volumes.set(
          product.volume,
          (volumes.get(product.volume) ?? 0) +
            product.quantity
        );
      }
    }
  
    const sortedPerfumes = [...totalsByName]
      .map(([name, total]) => ({
        name,
        total,
      }))
      .sort(
        (a, b) =>
          b.total - a.total
      );
  
    const regular = [];
    const unique = {};
  
    for (const { name, total } of sortedPerfumes) {
      const bottles = [...volumesByName.get(name)]
        .filter(([, quantity]) => quantity > 0)
        .map(([volume, quantity]) => ({
          volume,
          quantity,
        }))
        .sort(
          (a, b) =>
            a.volume - b.volume
        );
  
      if (total === 1) {
        const volume = bottles[0].volume;
  
        unique[volume] ??= [];
        unique[volume].push(name);
      } else if (total > 1) {
        regular.push({
          name,
          bottles,
          total,
        });
      }
    }
  
    return {
      updatedAt: session.updated_at,
      regular,
      unique,
      unknownProducts:
        [...unknownProductsByShopSku.values()],
    };
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
