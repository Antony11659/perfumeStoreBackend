import { createHash, randomUUID } from "node:crypto";

import { supabase } from "../../lib/supabase.js";

import {
  calculateWebsiteOzonDelivery,
} from "./websiteDeliveryService.js";

import {
  createOzonPayOrder,
} from "../payment/ozon/ozonPayService.js";


function orderRequestError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function normalizeWebsiteOrder(payload) {
  const pointId = Number(payload.delivery.deliveryPointId);
  if (!Number.isInteger(pointId) || pointId < 1) {
    throw orderRequestError(400, undefined, "Invalid Ozon delivery point ID");
  }

  // Version 1: trim stored strings, collapse optional blanks to null, retain
  // phone formatting and duplicate lines, and ignore item ordering.
  return {
    version: 1,
    operation: "website-order",
    customer: {
      name: payload.customer.name.trim(),
      phone: payload.customer.phone.trim(),
      messenger: payload.customer.messenger?.trim() || null,
      city: payload.customer.city.trim(),
      address: payload.customer.address.trim(),
      comment: payload.customer.comment?.trim() || null,
    },
    delivery: {
      provider: payload.delivery.provider,
      deliveryPointId: String(pointId),
    },
    promoCode: payload.promoCode?.trim().toUpperCase() || null,
    items: payload.items.map(({ variantId, quantity }) => ({ variantId, quantity }))
      .sort((a, b) => a.variantId - b.variantId || a.quantity - b.quantity),
  };
}

async function persistWebsiteOrder(key, hash, prepared = null) {
  let result;
  try {
    result = await supabase.rpc("persist_website_order_v1", {
      p_key: key,
      p_hash: hash,
      p_prepared: prepared,
    }).abortSignal(AbortSignal.timeout(10000));
    if (result.error) throw result.error;
  } catch {
    // Transport failure/timeout may follow a successful commit. Never fall back
    // to separate inserts or replace the key; resolve with the same key/body.
    throw orderRequestError(503, "ORDER_PERSISTENCE_UNAVAILABLE",
      "Order persistence is unavailable. Retry with the same idempotency key and request.");
  }

  const data = result?.data;
  if (data?.outcome === "conflict") {
    throw orderRequestError(409, "IDEMPOTENCY_KEY_CONFLICT",
      "Idempotency key has already been used with a different request.");
  }
  if (data?.outcome === "in_progress") {
    throw orderRequestError(409, "ORDER_IN_PROGRESS",
      "Order creation is in progress. Retry with the same idempotency key and request.");
  }
  if (data?.outcome === "ready" && prepared === null) return null;
  if (["created", "completed"].includes(data?.outcome) &&
      data.response?.success === true && data.response.order &&
      typeof data.response.order.orderNumber === "string" &&
      Number.isFinite(data.response.order.total)) {
    return data.response;
  }
  throw orderRequestError(503, "ORDER_PERSISTENCE_UNAVAILABLE",
    "Order persistence is unavailable. Retry with the same idempotency key and request.");
}

export async function createWebsiteOrder(payload, idempotencyKey) {

  if (idempotencyKey !== undefined && (
    typeof idempotencyKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey) ||
    idempotencyKey === "00000000-0000-0000-0000-000000000000"
  )) {
    throw orderRequestError(400, "IDEMPOTENCY_KEY_INVALID",
      "Idempotency-Key must be a single non-nil UUID.");
  }

  // Compatibility rollout: missing headers get one key per HTTP request.
  // Only clients that retain/send their key receive retry deduplication.
  const key = idempotencyKey?.toLowerCase() || randomUUID();
  const normalized = normalizeWebsiteOrder(payload);
  const hash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const completed = await persistWebsiteOrder(key, hash);
  if (completed) return completed;

  const {
    customer,
    delivery,
    promoCode,
    items,
  } = normalized;


  // --------------------------------------------------
  // 1. Collect unique variant IDs
  // --------------------------------------------------

  const variantIds = [
    ...new Set(
      items.map((item) => item.variantId)
    ),
  ];


  // --------------------------------------------------
  // 2. Load variants
  // --------------------------------------------------

  const {
    data: variants,
    error: variantsError,
  } = await supabase
    .from("perfume_variants")
    .select(`
      id,
      perfume_id,
      volume_ml
    `)
    .in("id", variantIds);


  if (variantsError) {
    throw new Error(
      "Failed to load perfume variants"
    );
  }


  // Every requested variant must exist.

  if (
    !variants ||
    variants.length !== variantIds.length
  ) {
    const error = new Error(
      "One or more perfume variants do not exist"
    );

    error.statusCode = 400;

    throw error;
  }


  // --------------------------------------------------
  // 3. Create fast variant lookup
  // --------------------------------------------------

  const variantMap = new Map(
    variants.map((variant) => [
      Number(variant.id),
      variant,
    ])
  );


  // --------------------------------------------------
  // 4. Collect required volumes
  // --------------------------------------------------

  const volumes = [
    ...new Set(
      variants.map(
        (variant) => variant.volume_ml
      )
    ),
  ];


  // --------------------------------------------------
  // 5. Load trusted prices
  // --------------------------------------------------

  const {
    data: prices,
    error: pricesError,
  } = await supabase
    .from("prices")
    .select(`
      volume_ml,
      website_price,
      discount_price
    `)
    .in("volume_ml", volumes);


  if (pricesError) {
    throw new Error(
      "Failed to load prices"
    );
  }


  if (
    !prices ||
    prices.length !== volumes.length
  ) {
    const error = new Error(
      "Price is missing for one or more volumes"
    );

    error.statusCode = 400;

    throw error;
  }


  // --------------------------------------------------
  // 6. Create fast price lookup
  // --------------------------------------------------

  const priceMap = new Map(
    prices.map((price) => [
      Number(price.volume_ml),
      price,
    ])
  );


  // --------------------------------------------------
  // 7. Validate promo code
  // --------------------------------------------------

  let pricingMode = "website";
  let normalizedPromoCode = null;


  if (
    typeof promoCode === "string" &&
    promoCode.trim()
  ) {

    normalizedPromoCode =
      promoCode
        .trim()
        .toUpperCase();


    const {
      data: promo,
      error: promoError,
    } = await supabase
      .from("promo_codes")
      .select(`
        id,
        code,
        is_active
      `)
      .eq("code", normalizedPromoCode)
      .eq("is_active", true)
      .maybeSingle();


    if (promoError) {
      throw new Error(
        "Failed to validate promo code"
      );
    }


    if (!promo) {
      const error = new Error(
        "Invalid promo code"
      );

      error.statusCode = 400;

      throw error;
    }


    pricingMode = "discount";
  }


  // --------------------------------------------------
  // 8. Calculate trusted order items
  // --------------------------------------------------

  let subtotal = 0;


  const calculatedItems =
    items.map((item) => {

      const variant =
        variantMap.get(
          Number(item.variantId)
        );


      const price =
        priceMap.get(
          Number(variant.volume_ml)
        );


      const unitPrice =
        pricingMode === "discount"
          ? Number(price.discount_price)
          : Number(price.website_price);


      if (!Number.isFinite(unitPrice)) {

        const error = new Error(
          "Invalid price configuration"
        );

        error.statusCode = 500;

        throw error;
      }


      const lineTotal =
        unitPrice * item.quantity;


      subtotal += lineTotal;


      return {
        variant_id: variant.id,
        quantity: item.quantity,
        unit_price: unitPrice,
        line_total: lineTotal,
      };

    });


  // --------------------------------------------------
  // 9. Calculate trusted delivery
  // --------------------------------------------------

  if (
    !delivery ||
    delivery.provider !== "ozon"
  ) {

    const error = new Error(
      "Unsupported delivery provider"
    );

    error.statusCode = 400;

    throw error;
  }


  /*
    IMPORTANT:

    The browser only tells us which Ozon PVZ
    the customer selected.

    We do NOT trust the browser for:
    - delivery price
    - Ozon logistics cost
    - insurance cost
    - estimated delivery days
    - cutoff
    - order total

    The subtotal above was calculated from
    trusted Supabase prices.

    We now send that trusted subtotal to
    our delivery service.
  */

  const calculatedDelivery =
    await calculateWebsiteOzonDelivery({
      phone:
        customer.phone.trim(),

      deliveryPointId:
        delivery.deliveryPointId,

      declaredValue:
        subtotal,
    });


  /*
    Current La De Parfum model:

    Ozon delivery is free for the customer.

    The real Ozon logistics cost is still
    stored in website_order_deliveries.
  */

  const deliveryPrice =
    Number(
      calculatedDelivery.customerDeliveryPrice ||
      0
    );


  const total =
    subtotal + deliveryPrice;


  // --------------------------------------------------
  // 10. Generate server-side order number
  // --------------------------------------------------

  const orderNumber =
    `LDP-${Date.now()}-${randomUUID()
      .slice(0, 8)
      .toUpperCase()}`;


  // Persist the trusted snapshot and original response in one database transaction.
  return persistWebsiteOrder(key, hash, {
    order: {
      order_number: orderNumber,
      customer_name: customer.name,
      phone: customer.phone,
      messenger: customer.messenger,
      city: customer.city,
      address: calculatedDelivery.deliveryPointAddress || customer.address,
      comment: customer.comment,
      promo_code: normalizedPromoCode,
      pricing_mode: pricingMode,
      subtotal,
      delivery_price: deliveryPrice,
      total,
      status: "new",
    },
    items: calculatedItems,
    delivery: {
      provider: calculatedDelivery.provider,
      delivery_type: calculatedDelivery.deliveryType,
      delivery_point_id: calculatedDelivery.deliveryPointId,
      delivery_point_name: calculatedDelivery.deliveryPointName,
      delivery_point_address: calculatedDelivery.deliveryPointAddress,
      estimated_delivery_days: calculatedDelivery.estimatedDeliveryDays,
      delivery_cost: calculatedDelivery.deliveryCost,
      insurance_cost: calculatedDelivery.insuranceCost,
      customer_delivery_price: calculatedDelivery.customerDeliveryPrice,
      cutoff_at: calculatedDelivery.cutoffAt,
      external_order_number: null,
      external_posting_number: null,
      status: "calculated",
    },
  });

}

export async function getWebsiteOrderRaspivItems(
  orderId
) {

  // --------------------------------------------------
  // 1. Load Raspiv shop
  // --------------------------------------------------

  const {
    data: raspivShop,
    error: shopError,
  } = await supabase
    .from("shops")
    .select(`
      id,
      code
    `)
    .eq(
      "code",
      "raspiv"
    )
    .eq(
      "is_active",
      true
    )
    .single();


  if (
    shopError ||
    !raspivShop
  ) {

    throw new Error(
      "Active Raspiv shop not found"
    );

  }


  // --------------------------------------------------
  // 2. Load website order items
  // --------------------------------------------------

  const {
    data: orderItems,
    error: orderItemsError,
  } = await supabase
    .from("website_order_items")
    .select(`
      variant_id,
      quantity
    `)
    .eq(
      "order_id",
      orderId
    );


  if (orderItemsError) {

    throw new Error(
      "Failed to load website order items"
    );

  }


  if (
    !orderItems ||
    orderItems.length === 0
  ) {

    throw new Error(
      "Website order has no items"
    );

  }


  // --------------------------------------------------
  // 3. Load perfume variants
  // --------------------------------------------------

  const variantIds = [
    ...new Set(
      orderItems.map(
        (item) =>
          item.variant_id
      )
    ),
  ];


  const {
    data: variants,
    error: variantsError,
  } = await supabase
    .from("perfume_variants")
    .select(`
      id,
      perfume_id,
      volume_ml
    `)
    .in(
      "id",
      variantIds
    );


  if (variantsError) {

    throw new Error(
      "Failed to load perfume variants"
    );

  }


  if (
    !variants ||
    variants.length !==
      variantIds.length
  ) {

    throw new Error(
      "One or more perfume variants are missing"
    );

  }


  const variantMap =
    new Map(
      variants.map(
        (variant) => [
          Number(
            variant.id
          ),
          variant,
        ]
      )
    );


  // --------------------------------------------------
  // 4. Load Raspiv shop products
  // --------------------------------------------------

  const perfumeIds = [
    ...new Set(
      variants.map(
        (variant) =>
          variant.perfume_id
      )
    ),
  ];


  const {
    data: shopProducts,
    error: shopProductsError,
  } = await supabase
    .from("shop_products")
    .select(`
      perfume_id,
      volume_ml,
      sku
    `)
    .eq(
      "shop_id",
      raspivShop.id
    )
    .eq(
      "is_active",
      true
    )
    .eq(
      "is_archived",
      false
    )
    .in(
      "perfume_id",
      perfumeIds
    );


  if (shopProductsError) {

    throw new Error(
      "Failed to load Raspiv shop products"
    );

  }


  // --------------------------------------------------
  // 5. Create perfume + volume -> SKU lookup
  // --------------------------------------------------

  const skuMap =
    new Map(
      shopProducts.map(
        (product) => [
          `${product.perfume_id}:${product.volume_ml}`,
          product.sku,
        ]
      )
    );


  // --------------------------------------------------
  // 6. Convert website items to Raspiv items
  // --------------------------------------------------

  return orderItems.map(
    (item) => {

      const variant =
        variantMap.get(
          Number(
            item.variant_id
          )
        );


      const key =
        `${variant.perfume_id}:${variant.volume_ml}`;


      const sku =
        skuMap.get(
          key
        );


      if (!sku) {

        throw new Error(
          `Raspiv SKU not found for variant ${item.variant_id}`
        );

      }


      return {
        sku,

        quantity:
          Number(
            item.quantity
          ),
      };

    }
  );

}

// --------------------------------------------------
// Mark website order as paid from Ozon Pay
// --------------------------------------------------

export async function markWebsiteOrderPaidFromOzon(
  notification
) {

  const {
    extOrderID,
    amount,
    currencyCode,
    status,
    operationType,
  } = notification;


  // --------------------------------------------------
  // 1. Validate payment event
  // --------------------------------------------------

  if (
    operationType !== "Payment" ||
    status !== "Completed"
  ) {

    return {
      updated: false,
      reason: "Payment is not completed",
    };

  }


  // --------------------------------------------------
  // 2. We only accept Russian rubles
  // --------------------------------------------------

  if (
    String(currencyCode) !== "643"
  ) {

    const error =
      new Error(
        "Unexpected Ozon Pay currency"
      );


    error.statusCode = 400;


    throw error;

  }


  // --------------------------------------------------
  // 3. Ozon must tell us which website order
  //    this payment belongs to
  // --------------------------------------------------

  if (
    typeof extOrderID !== "string" ||
    !extOrderID.trim()
  ) {

    const error =
      new Error(
        "Ozon Pay notification has no extOrderID"
      );


    error.statusCode = 400;


    throw error;

  }


  // --------------------------------------------------
  // 4. Find our website order
  // --------------------------------------------------

  const {
    data: order,
    error: orderError,
  } = await supabase
    .from("website_orders")
    .select(`
      id,
      order_number,
      total,
      status
    `)
    .eq(
      "order_number",
      extOrderID.trim()
    )
    .maybeSingle();


  if (orderError) {

    throw new Error(
      "Failed to load website order"
    );

  }


  if (!order) {

    const error =
      new Error(
        "Website order not found"
      );


    error.statusCode = 404;


    throw error;

  }


  // --------------------------------------------------
  // 5. Validate Ozon amount
  //
  // Ozon notification amount is in kopecks.
  //
  // Example:
  // 380000 → 3800 ₽
  // --------------------------------------------------

  const ozonAmountKopecks =
    Number(amount);


  if (
    !Number.isInteger(
      ozonAmountKopecks
    ) ||
    ozonAmountKopecks < 0
  ) {

    const error =
      new Error(
        "Invalid Ozon Pay amount"
      );


    error.statusCode = 400;


    throw error;

  }


  const orderTotalKopecks =
    Math.round(
      Number(order.total) * 100
    );


  if (
    ozonAmountKopecks !==
    orderTotalKopecks
  ) {

    const error =
      new Error(
        "Ozon Pay amount does not match website order total"
      );


    error.statusCode = 400;


    throw error;

  }


  // --------------------------------------------------
  // 6. Idempotency
  //
  // Ozon may send the same notification again.
  // If we already marked this order as paid,
  // there is nothing else to do.
  // --------------------------------------------------

  if (
    order.status === "paid"
  ) {

    return {
      updated: false,
      alreadyPaid: true,
      orderId:
        Number(order.id),

      orderNumber:
        order.order_number,
    };

  }


  // --------------------------------------------------
  // 7. Update our authoritative order status
  // --------------------------------------------------

  const {
    data: updatedOrder,
    error: updateError,
  } = await supabase
    .from("website_orders")
    .update({
      status:
        "paid",

      updated_at:
        new Date()
          .toISOString(),
    })
    .eq(
      "id",
      order.id
    )
    .select(`
      id,
      order_number,
      total,
      status
    `)
    .single();


  if (updateError) {

    throw new Error(
      "Failed to mark website order as paid"
    );

  }


  // --------------------------------------------------
  // 8. Return result
  // --------------------------------------------------

  return {
    updated: true,

    alreadyPaid: false,

    orderId:
      Number(
        updatedOrder.id
      ),

    orderNumber:
      updatedOrder.order_number,

    total:
      Number(
        updatedOrder.total
      ),

    status:
      updatedOrder.status,
  };

}

// --------------------------------------------------
// Create Ozon Pay payment for website order
// --------------------------------------------------

export async function createWebsiteOrderPayment(
  orderId
) {

  // --------------------------------------------------
  // 1. Load our trusted website order
  // --------------------------------------------------

  const {
    data: order,
    error: orderError,
  } = await supabase
    .from("website_orders")
    .select(`
      id,
      order_number,
      total,
      status
    `)
    .eq(
      "id",
      orderId
    )
    .maybeSingle();


  if (orderError) {

    throw new Error(
      "Failed to load website order"
    );

  }


  if (!order) {

    const error =
      new Error(
        "Website order not found"
      );


    error.statusCode = 404;


    throw error;

  }


  // --------------------------------------------------
  // 2. Do not create payment for paid order
  // --------------------------------------------------

  if (
    order.status === "paid"
  ) {

    const error =
      new Error(
        "Website order is already paid"
      );


    error.statusCode = 400;


    throw error;

  }


  // --------------------------------------------------
  // 3. Convert trusted total to kopecks
  //
  // Supabase:
  // 6300 ₽
  //
  // Ozon Pay:
  // 630000 kopecks
  // --------------------------------------------------

  const total =
    Number(
      order.total
    );


  if (
    !Number.isFinite(total) ||
    total <= 0
  ) {

    throw new Error(
      "Invalid website order total"
    );

  }


  const amountKopecks =
    Math.round(
      total * 100
    );


  // --------------------------------------------------
  // 4. Create Ozon Pay order
  //
  // IMPORTANT:
  //
  // extId is OUR order number.
  //
  // This is what allows the future webhook:
  //
  // extOrderID = LDP-...
  //
  // to find the correct Supabase order.
  // --------------------------------------------------

  const ozonResult =
    await createOzonPayOrder({
      extId:
        order.order_number,

      amountValue:
        String(
          amountKopecks
        ),
    });


  const ozonOrder =
    ozonResult?.order;


  if (
    !ozonOrder ||
    !ozonOrder.id ||
    !ozonOrder.payLink
  ) {

    throw new Error(
      "Ozon Pay returned invalid order"
    );

  }


  // --------------------------------------------------
  // 5. Return only what website needs
  // --------------------------------------------------

  return {

    orderId:
      Number(
        order.id
      ),

    orderNumber:
      order.order_number,

    amount:
      total,

    ozonPayOrderId:
      ozonOrder.id,

    ozonPayStatus:
      ozonOrder.status,

    payLink:
      ozonOrder.payLink,

    isTestMode:
      Boolean(
        ozonOrder.isTestMode
      ),

  };

}
