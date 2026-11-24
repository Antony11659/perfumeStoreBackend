import { createHash, randomUUID } from "node:crypto";

import { supabase } from "../../lib/supabase.js";

import {
  calculateWebsiteOzonDelivery,
} from "./websiteDeliveryService.js";

import * as ozonPay from "../payment/ozon/ozonPayService.js";

const { createOzonPayOrder } = ozonPay;


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

function archivedPerfumeError() {
  return orderRequestError(409, "WEBSITE_PERFUME_ARCHIVED",
    "One or more perfumes are no longer available. Refresh your cart before checking out.");
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
  } catch (error) {
    if (error?.code === "PT409" && error.message === "WEBSITE_PERFUME_ARCHIVED") {
      throw archivedPerfumeError();
    }
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
      volume_ml,
      perfume:perfumes(is_archived)
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


  if (variants.some(variant => variant.perfume?.is_archived === true)) {
    throw archivedPerfumeError();
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

const settlementUnavailable = () => orderRequestError(503, undefined, "Payment settlement is unresolved");
const settlementConflict = () => orderRequestError(409, undefined, "Payment does not match an eligible order");

export function getWebsiteDeliveryAutoStartAt() {
  if (process.env.WEBSITE_OZON_DELIVERY_AUTO_CREATE_ENABLED !== "true") return null;
  const startAt = process.env.WEBSITE_OZON_DELIVERY_AUTO_CREATE_START_AT;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(startAt ?? "") ||
      !Number.isFinite(Date.parse(startAt)) ||
      new Date(startAt).toISOString() !== startAt.replace("Z", ".000Z")) return null;
  const approved = (process.env.OZON_WEBSITE_STANDARD_PARCEL_VARIANT_IDS ?? "").split(",");
  return approved.some((id) => id.trim() === "422") ? startAt : null;
}

async function readWebsitePayment(column, value) {
  try {
    // Preserve the exact PostgreSQL numeric value across the JSON boundary.
    const { data, error } = await supabase.from("website_orders")
      .select("id,order_number,total::text,status,payment_state,ozon_payment_id")
      .eq(column, value)
      .abortSignal(AbortSignal.timeout(10000))
      .maybeSingle();
    if (!error) return data;
  } catch {
    throw settlementUnavailable();
  }
  throw settlementUnavailable();
}

function websitePaymentKopecks(total) {
  if (typeof total !== "string" && typeof total !== "number") return null;
  const decimal = String(total);
  const parts = /^(\d+)(?:\.(\d{1,2})0*)?$/.exec(decimal);
  if (!parts || parts[0] !== decimal) return null;
  const [, rubles, fraction = ""] = parts;
  const kopecks = Number(rubles + fraction.padEnd(2, "0"));
  return Number.isSafeInteger(kopecks) && kopecks > 0 ? kopecks : null;
}

async function lookupWebsitePayment(order) {
  try {
    return await ozonPay.getOzonPayOrderStatus({ id: order.ozon_payment_id });
  } catch {
    throw settlementUnavailable();
  }
}

async function confirmVerifiedWebsitePayment(order, status, amountKopecks) {
  const id = String(order.id);
  const verification = ozonPay.validateOzonPaySettlement(status, {
    id: order.ozon_payment_id,
    extId: order.order_number,
    amountKopecks,
    currencyCode: "643",
    environment: "production",
  });
  if (!verification.valid) throw settlementUnavailable();

  function isConfirmed(row) {
    return row?.status === "paid" && row.payment_state === "confirmed" &&
      String(row.id) === id && row.order_number === order.order_number &&
      row.ozon_payment_id === order.ozon_payment_id &&
      websitePaymentKopecks(row.total) === amountKopecks;
  }

  if (isConfirmed(order)) return { updated: false, alreadyPaid: true };

  let result;
  try {
    const websiteDeliveryAutoStartAt = getWebsiteDeliveryAutoStartAt();
    const rpc = websiteDeliveryAutoStartAt
      ? "confirm_website_order_payment_and_queue_delivery_v1"
      : "confirm_website_order_payment_v1";
    result = await supabase.rpc(rpc, {
      p_order_id: order.id,
      p_ozon_payment_id: order.ozon_payment_id,
      p_order_number: order.order_number,
      p_amount_kopecks: amountKopecks,
      ...(websiteDeliveryAutoStartAt && { p_start_at: websiteDeliveryAutoStartAt }),
    }).abortSignal(AbortSignal.timeout(10000));
  } catch {
    // A thrown or timed-out response can follow a successful commit.
  }

  if (result?.error === null && Array.isArray(result.data) &&
      result.data.length === 1 && isConfirmed(result.data[0])) {
    return { updated: true, alreadyPaid: false };
  }

  const current = await readWebsitePayment("id", order.id);
  if (isConfirmed(current)) return { updated: false, alreadyPaid: true };
  if (result?.error === null && Array.isArray(result.data) && result.data.length === 0) {
    throw settlementConflict();
  }
  throw settlementUnavailable();
}

export async function markWebsiteOrderPaidFromOzon({ orderID, extOrderID, amount, currencyCode }) {
  const order = await readWebsitePayment("order_number", extOrderID);
  if (!order) throw orderRequestError(404, undefined, "Website order not found");
  if (order.order_number !== extOrderID) throw settlementConflict();
  if (order.status === "new" && (
    order.payment_state === "reserved" || order.payment_state === "unknown" ||
    order.payment_state === null
  )) {
    throw settlementUnavailable();
  }
  if (order.ozon_payment_id !== orderID ||
      !((order.status === "new" && order.payment_state === "ready") ||
        (order.status === "paid" && order.payment_state === "confirmed"))) {
    throw settlementConflict();
  }

  // A bigint serialized as an unsafe JSON number cannot reliably identify the row.
  const id = String(order.id);
  if (!/^[1-9][0-9]*$/.test(id) ||
      (typeof order.id !== "string" && !Number.isSafeInteger(order.id))) {
    throw settlementUnavailable();
  }

  const amountKopecks = websitePaymentKopecks(order.total);
  if (amountKopecks === null) throw settlementUnavailable();
  if (currencyCode !== "643" || amount !== amountKopecks) {
    throw orderRequestError(400, undefined, "Notification amount or currency does not match");
  }

  return confirmVerifiedWebsitePayment(order, await lookupWebsitePayment(order), amountKopecks);
}

export async function getWebsiteOrderPaymentStatus(orderId) {
  const order = await readWebsitePayment("id", orderId);
  if (!order) throw orderRequestError(404, undefined, "Website order not found");
  if (order.id !== orderId && order.id !== String(orderId)) throw settlementUnavailable();

  const hasReference = (value) => typeof value === "string" && value.trim().length > 0;
  if (order.payment_state === "confirmed" || order.payment_state === "ready") {
    const amountKopecks = websitePaymentKopecks(order.total);
    if (!hasReference(order.ozon_payment_id) || !hasReference(order.order_number) ||
        amountKopecks === null) throw settlementUnavailable();

    if (order.payment_state === "confirmed" && order.status === "paid") return "paid";
    if (order.payment_state !== "ready" || order.status !== "new") throw settlementConflict();

    const status = await lookupWebsitePayment(order);
    if (status.status === "STATUS_PAID") {
      await confirmVerifiedWebsitePayment(order, status, amountKopecks);
      return "paid";
    }

    // An unconfirmed response can describe this payment only if its details match.
    if (status.id !== order.ozon_payment_id || status.extId !== order.order_number ||
        status.isTestMode !== false || status.originalAmount?.currencyCode !== "643" ||
        status.originalAmount.value !== String(amountKopecks)) throw settlementUnavailable();

    if (["STATUS_NEW", "STATUS_PAYMENT_PENDING", "STATUS_AUTHORIZED"].includes(status.status)) {
      return "pending";
    }
    if (["STATUS_CANCELED", "STATUS_EXPIRED", "STATUS_REFUNDED"].includes(status.status)) {
      return "unavailable";
    }
    throw settlementUnavailable();
  }

  if (order.status !== "new" || order.ozon_payment_id !== null) throw settlementConflict();
  if (order.payment_state === null) return "not_started";
  if (order.payment_state === "reserved") return "processing";
  if (order.payment_state === "unknown") return "recovery_required";
  throw settlementConflict();
}

// --------------------------------------------------
// Create Ozon Pay payment for website order
// --------------------------------------------------

// Parse decimal digits directly so fractional kopecks cannot be rounded away.
function toKopecks(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const decimal = String(value);
  const parts = /^(\d+)(?:\.(\d{1,2})0*)?$/.exec(decimal);
  if (!parts || parts[0] !== decimal) return null;

  const [, rubles, fraction = ""] = parts;
  const kopecks = Number(rubles + fraction.padEnd(2, "0"));
  return Number.isSafeInteger(kopecks) ? kopecks : null;
}



async function loadWebsitePaymentReceipt(order, vat) {
  const unavailable = () => orderRequestError(503, undefined, "Website order receipt data is unavailable");
  const phone = typeof order.phone === "string" ? order.phone.trim() : "";
  const total = toKopecks(order.total);
  const delivery = toKopecks(order.delivery_price);
  if (!phone || !total || delivery === null) throw unavailable();

  const { data, error } = await supabase
    .from("website_order_items")
    .select("quantity, unit_price, line_total, variant:perfume_variants(volume_ml, perfume:perfumes(name))")
    .eq("order_id", order.id)
    .abortSignal(AbortSignal.timeout(10000));
  if (error || !Array.isArray(data) || !data.length) throw unavailable();

  let sum = BigInt(delivery);
  const items = data.map(({ quantity, unit_price, line_total, variant }) => {
    const catalogName = variant?.perfume?.name;
    const name = typeof catalogName === "string" ? catalogName.trim() : "";
    const volume = Number(variant?.volume_ml);
    const unitPrice = toKopecks(unit_price);
    const lineTotal = toKopecks(line_total);
    if (!name || !Number.isFinite(volume) || volume <= 0 || !unitPrice ||
        !Number.isSafeInteger(quantity) || quantity < 1 || lineTotal === null ||
        BigInt(unitPrice) * BigInt(quantity) !== BigInt(lineTotal)) {
      throw unavailable();
    }
    sum += BigInt(lineTotal);
    return {
      name: `${name}, ${volume} мл`,
      quantity,
      price: { currencyCode: "643", value: String(unitPrice) },
      type: "TYPE_PRODUCT",
      vat,
    };
  });
  if (sum !== BigInt(total)) throw unavailable();
  if (delivery > 0) {
    items.push({
      name: "Доставка",
      quantity: 1,
      price: { currencyCode: "643", value: String(delivery) },
      vat,
    });
  }
  return { phone, items, total };
}

export async function createWebsiteOrderPayment(
  orderId
) {

  if (!Number.isSafeInteger(orderId) || orderId < 1) {
    throw orderRequestError(400, undefined, "Invalid website order ID");
  }

  // --------------------------------------------------
  // 1. Load our trusted website order
  // --------------------------------------------------

  const fiscalizationVat = process.env.OZON_PAY_FISCALIZATION_NO_VAT;
  const {
    data: order,
    error: orderError,
  } = await supabase
    .from("website_orders")
    .select(`
      id,
      order_number,
      total,
      status,
      phone,
      delivery_price
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


  const expectedMode = process.env.OZON_PAY_EXPECTED_MODE;
  if (expectedMode !== "production" && expectedMode !== "test") {
    throw orderRequestError(503, undefined, "Ozon Pay environment configuration is unavailable");
  }

  if (fiscalizationVat !== "VAT_NONE") {
    throw orderRequestError(503, undefined, "Ozon Pay fiscalization configuration is unavailable");
  }
  const receipt = await loadWebsitePaymentReceipt(order, fiscalizationVat);

  const reservationUnavailable = () => orderRequestError(
    503,
    undefined,
    "Website order payment reservation is temporarily unavailable"
  );

  let reservation;
  try {
    reservation = await supabase
      .rpc("reserve_website_order_payment_v1", { p_order_id: orderId })
      .abortSignal(AbortSignal.timeout(10000));
  } catch {
    throw reservationUnavailable();
  }

  if (reservation?.error !== null || !Array.isArray(reservation.data)) {
    throw reservationUnavailable();
  }

  if (reservation.data.length === 0) {
    throw orderRequestError(409, undefined, "Website order payment reservation was denied");
  }

  const matchesOrderId = (id) => id === orderId || id === String(orderId);
  const [reservedOrder] = reservation.data;
  if (
    reservation.data.length !== 1 ||
    !matchesOrderId(reservedOrder?.id) ||
    reservedOrder.payment_state !== "reserved" ||
    typeof reservedOrder.order_number !== "string" ||
    !reservedOrder.order_number.trim()
  ) {
    throw reservationUnavailable();
  }

  const amountKopecks = toKopecks(reservedOrder.total);
  if (amountKopecks !== receipt.total) {
    throw reservationUnavailable();
  }

  let ozonResult;
  try {
    ozonResult = await createOzonPayOrder({
      extId: reservedOrder.order_number,
      amountValue: String(amountKopecks),
      receipt,
    });
  } catch {
    throw orderRequestError(503, undefined, "Ozon Pay creation could not be confirmed");
  }

  const ozonOrder = ozonResult?.order;
  const providerId = ozonOrder?.id;
  const paymentLink = ozonOrder?.payLink;
  if (
    typeof providerId !== "string" || !providerId.trim() ||
    typeof paymentLink !== "string" || !paymentLink.trim()
  ) {
    throw orderRequestError(502, undefined, "Ozon Pay returned invalid order");
  }

  const isTestMode = ozonOrder.isTestMode;
  if (isTestMode !== (expectedMode === "test")) {
    throw orderRequestError(502, undefined, "Ozon Pay returned an unexpected payment environment");
  }

  const saveUnavailable = () => orderRequestError(
    503,
    undefined,
    "Website order payment persistence could not be confirmed"
  );

  let save;
  try {
    save = await supabase.rpc("save_website_order_payment_v1", {
      p_order_id: orderId,
      p_ozon_payment_id: providerId,
      p_payment_link: paymentLink,
    }).abortSignal(AbortSignal.timeout(10000));
  } catch {
    throw saveUnavailable();
  }

  if (save?.error !== null || !Array.isArray(save.data) || save.data.length !== 1) {
    throw saveUnavailable();
  }

  const [savedOrder] = save.data;
  if (
    !matchesOrderId(savedOrder?.id) ||
    savedOrder.payment_state !== "ready" ||
    savedOrder.ozon_payment_id !== providerId ||
    savedOrder.payment_link !== paymentLink ||
    savedOrder.order_number !== reservedOrder.order_number ||
    toKopecks(savedOrder.total) !== amountKopecks
  ) {
    throw saveUnavailable();
  }

  return {

    orderId:
      Number(
        reservedOrder.id
      ),

    orderNumber:
      reservedOrder.order_number,

    amount:
      Number(reservedOrder.total),

    ozonPayOrderId:
      savedOrder.ozon_payment_id,

    ozonPayStatus:
      ozonOrder.status,

    payLink:
      savedOrder.payment_link,

    isTestMode,

  };

}
