import { createOzonClient } from "./ozonClient.js";
import fs from "node:fs";

const productsData = JSON.parse(
  fs.readFileSync(
    new URL("../../temporary/data.json", import.meta.url),
    "utf8"
  )
);


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
    const shops = [
      "raspiv",
      "motive",
      "laDePurfum",
      "dubaiOil"
    ];
  
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


  const prepareProduct = (product) => {
    const sku = String(product.sku);
  
    const productData = productsData[sku];
  
    if (!productData) {
      return {
        sku,
        name: null,
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
  
  
  export const preparePackagingOrders = (session) => {
    const orders = session.shops.flatMap((shop) => {
      return shop.orders.map((order) => {
        const ii = order.scanit;
        const orderNumber = order.posting_number;
  
        return {
          ii,
          orderNumber,
          displayedNum: normalizeNum(ii, orderNumber),
          products: order.products.map(order => prepareProduct(order)),
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


