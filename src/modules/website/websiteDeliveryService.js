import {
    checkOzonDeliveryClient,
    getOzonDeliveryPointInfo,
    checkOzonDeliveryPointAvailability,
    checkoutOzonDelivery,
  } from "../delivery/ozon/ozonDeliveryService.js";
  
  
  export async function calculateWebsiteOzonDelivery({
    phone,
    deliveryPointId,
    declaredValue,
  }) {
  
    /* =========================
       1. NORMALIZE PVZ ID
    ========================= */
  
    const numericDeliveryPointId =
      Number(
        deliveryPointId
      );
  
  
    if (
      !Number.isInteger(
        numericDeliveryPointId
      ) ||
      numericDeliveryPointId < 1
    ) {
  
      const error =
        new Error(
          "Invalid Ozon delivery point ID"
        );
  
  
      error.statusCode =
        400;
  
  
      throw error;
  
    }
  
  
    /* =========================
       2. CHECK CUSTOMER
    ========================= */
  
    const client =
      await checkOzonDeliveryClient(
        phone
      );
  
  
    if (
      !client.canBeDelivered
    ) {
  
      const error =
        new Error(
          "Ozon Delivery is not available for this customer"
        );
  
  
      error.statusCode =
        400;
  
  
      throw error;
  
    }
  
  
    /* =========================
       3. LOAD REAL PVZ FROM OZON
    ========================= */
  
    const points =
      await getOzonDeliveryPointInfo(
        [
          numericDeliveryPointId,
        ]
      );
  
  
    const point =
      points[0];
  
  
    if (
      !point ||
      point.is_active !== true
    ) {
  
      const error =
        new Error(
          "Ozon delivery point is not available"
        );
  
  
      error.statusCode =
        400;
  
  
      throw error;
  
    }
  
  
    /* =========================
       4. CHECK PARCEL AVAILABILITY
    ========================= */
  
    const availability =
      await checkOzonDeliveryPointAvailability({
        deliveryPointId:
          numericDeliveryPointId,
  
        declaredValue,
      });
  
  
    if (
      !availability.available
    ) {
  
      const error =
        new Error(
          availability.error?.message ||
          "Order cannot be delivered to this Ozon pickup point"
        );
  
  
      error.statusCode =
        400;
  
  
      throw error;
  
    }
  
  
    /* =========================
       5. CUTOFF
    ========================= */
  
    /*
    TEMPORARY MVP RULE:
  
    We assume La De Parfum will hand
    the parcel to Ozon approximately
    24 hours from now.
  
    Later this should use the real
    production / drop-off schedule.
    */
  
    const cutoffAt =
      new Date(
        Date.now() +
        24 * 60 * 60 * 1000
      ).toISOString();
  
  
    /* =========================
       6. OZON CHECKOUT
    ========================= */
  
    const checkout =
      await checkoutOzonDelivery({
        phone,
  
        deliveryPointId:
          numericDeliveryPointId,
  
        declaredValue,
  
        cutoffAt,
      });
  
  
    if (
      !checkout.available
    ) {
  
      const error =
        new Error(
          checkout.error?.message ||
          "Ozon Delivery checkout failed"
        );
  
  
      error.statusCode =
        400;
  
  
      throw error;
  
    }
  
  
    /* =========================
       7. NORMALIZED RESULT
    ========================= */
  
    return {
  
      provider:
        "ozon",
  
      deliveryType:
        "pvz",
  
      deliveryPointId:
        String(
          numericDeliveryPointId
        ),
  
      deliveryPointName:
        point.name || null,
  
      deliveryPointAddress:
        point.full_address || null,
  
      estimatedDeliveryDays:
        checkout.estimatedDeliveryDays,
  
      deliveryCost:
        checkout.deliveryCost,
  
      insuranceCost:
        checkout.insuranceCost,
  
      /*
      Current La De Parfum model:
      customer delivery is free.
      */
  
      customerDeliveryPrice:
        0,
  
      cutoffAt:
        checkout.cutoffAt,
  
    };
  
  }