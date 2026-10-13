import { randomUUID } from "node:crypto";

import { supabase } from "../../lib/supabase.js";


export async function createWebsiteOrder(payload) {

  const {
    customer,
    promoCode,
    items,
  } = payload;


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
  // 9. Delivery
  // --------------------------------------------------

  // Ozon Delivery will be connected later.
  // For now delivery is free / not calculated.

  const deliveryPrice = 0;

  const total =
    subtotal + deliveryPrice;


  // --------------------------------------------------
  // 10. Generate server-side order number
  // --------------------------------------------------

  const orderNumber =
    `LDP-${Date.now()}-${randomUUID()
      .slice(0, 8)
      .toUpperCase()}`;


  // --------------------------------------------------
  // 11. Create website order
  // --------------------------------------------------

  const {
    data: order,
    error: orderError,
  } = await supabase
    .from("website_orders")
    .insert({
      order_number: orderNumber,

      customer_name:
        customer.name.trim(),

      phone:
        customer.phone.trim(),

      messenger:
        customer.messenger?.trim() || null,

      city:
        customer.city.trim(),

      address:
        customer.address.trim(),

      comment:
        customer.comment?.trim() || null,

      promo_code:
        normalizedPromoCode,

      pricing_mode:
        pricingMode,

      subtotal,

      delivery_price:
        deliveryPrice,

      total,

      status:
        "new",
    })
    .select(`
      id,
      order_number,
      pricing_mode,
      subtotal,
      delivery_price,
      total,
      status
    `)
    .single();


  if (orderError) {
    throw new Error(
      "Failed to create website order"
    );
  }


  // --------------------------------------------------
  // 12. Attach items to created order
  // --------------------------------------------------

  const orderItems =
    calculatedItems.map((item) => ({
      order_id: order.id,
      ...item,
    }));


  const {
    error: orderItemsError,
  } = await supabase
    .from("website_order_items")
    .insert(orderItems);


  if (orderItemsError) {

    /*
      We don't want to leave an empty order
      if inserting its items failed.
    */

    await supabase
      .from("website_orders")
      .delete()
      .eq("id", order.id);


    throw new Error(
      "Failed to create website order items"
    );
  }


  // --------------------------------------------------
  // 13. Return clean API result
  // --------------------------------------------------

  return {
    id: Number(order.id),

    orderNumber:
      order.order_number,

    pricingMode:
      order.pricing_mode,

    subtotal:
      Number(order.subtotal),

    deliveryPrice:
      Number(order.delivery_price),

    total:
      Number(order.total),

    status:
      order.status,
  };

}