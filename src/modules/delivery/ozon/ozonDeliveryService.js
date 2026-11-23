const OZON_AUTH_URL =
  "https://xapi.ozon.ru/oauth/token";

const OZON_DELIVERY_API_URL =
  "https://api-delivery.ozon.ru";

const OZON_DELIVERY_SCOPES = [
  "delivery-api.all",
];


// --------------------------------------------------
// Website delivery configuration
// --------------------------------------------------

export const OZON_WEBSITE_SHIPMENT_METHOD_ID =
  1020005033142790;

export const OZON_DEFAULT_PARCEL_DIMENSIONS = Object.freeze({
  weight_g: 60,
  length_mm: 100,
  width_mm: 50,
  height_mm: 20,
});

export const OZON_STANDARD_PARCEL_DESCRIPTION = "Perfume";


// --------------------------------------------------
// OAuth
// --------------------------------------------------

/**
 * Get a fresh Ozon Delivery access token.
 *
 * Ozon Delivery uses OAuth client_credentials.
 */
export async function getOzonDeliveryAccessToken({ signal, diagnostics } = {}) {
  const clientId =
    process.env.OZON_DELIVERY_CLIENT_ID;

  const clientSecret =
    process.env.OZON_DELIVERY_CLIENT_SECRET;


  if (!clientId) {
    throw new Error(
      "OZON_DELIVERY_CLIENT_ID is missing"
    );
  }


  if (!clientSecret) {
    throw new Error(
      "OZON_DELIVERY_CLIENT_SECRET is missing"
    );
  }


  const response = await fetch(
    OZON_AUTH_URL,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body: JSON.stringify({
        client_id:
          clientId,

        client_secret:
          clientSecret,

        grant_type:
          "client_credentials",

        scope:
          OZON_DELIVERY_SCOPES,
      }),

      redirect:
        "follow",
      signal,
    }
  );


  if (diagnostics) diagnostics.response = response;

  if (!response.ok) {
    if (diagnostics) throw new Error("Ozon Delivery OAuth failed");
    const body =
      await response.text();

    throw new Error(
      `Ozon Delivery OAuth failed (${response.status}): ${body}`
    );
  }


  const data =
    await response.json();


  if (!data.access_token) {
    throw new Error(
      "Ozon Delivery did not return access_token"
    );
  }


  return data.access_token;
}


// --------------------------------------------------
// Base Ozon Delivery request
// --------------------------------------------------

/**
 * Make an authenticated request to Ozon Delivery API.
 *
 * Ozon Delivery may respond with 302/307 and
 * challenge cookies. Node fetch does not persist cookies
 * automatically, so redirects are handled manually.
 */
export async function ozonDeliveryRequest(
  path,
  {
    method = "POST",
    body,
    signal,
    idempotencyKey,
    diagnostics,
    beforeRequest,
  } = {}
) {
  if (diagnostics) {
    diagnostics.phase = "oauth";
    diagnostics.sensitiveValues.push(process.env.OZON_DELIVERY_CLIENT_SECRET);
  }
  const token =
    await getOzonDeliveryAccessToken({ signal, diagnostics });
  if (diagnostics) {
    diagnostics.phase = "delivery";
    diagnostics.response = undefined;
    diagnostics.sensitiveValues.push(token);
  }


  // Creation claims store the serialized body so replays are byte-identical.
  const originalBody = idempotencyKey ? body : JSON.stringify(body);


  let url =
    `${OZON_DELIVERY_API_URL}${path}`;

  let cookie =
    null;


  for (
    let attempt = 0;
    attempt < 5;
    attempt++
  ) {

    const headers = {
      Authorization:
        `Bearer ${token}`,

      "Content-Type":
        "application/json",
    };


    if (cookie) {
      headers.Cookie =
        cookie;
    }
    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }


    if (beforeRequest) {
      beforeRequest();
      signal?.throwIfAborted();
    }
    if (diagnostics) {
      diagnostics.response = undefined;
      diagnostics.requestStarted = true;
    }
    const response =
      await fetch(
        url,
        {
          method,
          headers,
          body:
            originalBody,

          redirect:
            "manual",
          signal,
        }
      );


    if (diagnostics) diagnostics.response = response;

    if (
      response.status !== 302 &&
      response.status !== 307
    ) {
      return response;
    }


    const location =
      response.headers.get(
        "location"
      );

    const setCookie =
      response.headers.get(
        "set-cookie"
      );


    if (setCookie) {
      cookie =
        setCookie
          .split(",")
          .map(
            (item) =>
              item.split(";")[0]
          )
          .join("; ");
    }


    if (diagnostics && setCookie) {
      for (const pair of cookie.split("; ")) {
        diagnostics.sensitiveValues.push(pair.slice(pair.indexOf("=") + 1));
      }
    }

    if (!location) {
      if (diagnostics) diagnostics.redirectReason = "missing_location";
      throw new Error(
        `Ozon Delivery returned ${response.status} without Location header`
      );
    }


    let nextUrl;
    try {
      nextUrl = new URL(location, url);
    } catch (error) {
      if (diagnostics) diagnostics.redirectReason = "invalid_location";
      throw error;
    }
    let redirectReason;
    if (nextUrl.origin !== OZON_DELIVERY_API_URL) redirectReason = "cross_origin";
    else if (nextUrl.username || nextUrl.password) redirectReason = "url_credentials";
    else if (idempotencyKey && nextUrl.pathname !== path) redirectReason = "path_changed";
    else if (idempotencyKey && response.status === 302 && !/(?:^|,\s*)testcookie=/.test(setCookie || "")) {
      redirectReason = "missing_testcookie";
    }
    if (redirectReason) {
      if (diagnostics) diagnostics.redirectReason = redirectReason;
      throw new Error("Unsafe Ozon Delivery redirect");
    }
    await response.body?.cancel();
    url = nextUrl.toString();
  }


  if (diagnostics) diagnostics.redirectReason = "limit_exceeded";
  throw new Error(
    "Ozon Delivery redirect limit exceeded"
  );
}


// --------------------------------------------------
// Customer eligibility
// --------------------------------------------------

export async function checkOzonDeliveryClient(
  phone
) {
  const normalizedPhone =
    String(
      phone || ""
    ).replace(
      /\D/g,
      ""
    );


  if (
    !/^7\d{10}$/.test(
      normalizedPhone
    )
  ) {
    const error =
      new Error(
        "Invalid phone number"
      );

    error.statusCode =
      400;

    throw error;
  }


  const response =
    await ozonDeliveryRequest(
      "/v1/delivery/check-client",
      {
        body: {
          phone_number:
            `+${normalizedPhone}`,
        },
      }
    );


  const data =
    await response.json();


  if (!response.ok) {
    throw new Error(
      `Ozon Delivery check-client failed (${response.status}): ${JSON.stringify(data)}`
    );
  }


  return {
    canBeDelivered:
      data.can_be_delivered ===
      true,
  };
}


// --------------------------------------------------
// Delivery point list
// --------------------------------------------------

export async function getOzonDeliveryPoints(
  {
    limit = 100,
    cursor,
  } = {}
) {
  const pagination = {
    limit,
  };


  if (cursor) {
    pagination.cursor =
      cursor;
  }


  const response =
    await ozonDeliveryRequest(
      "/v1/delivery-point/list",
      {
        body: {
          pagination,
        },
      }
    );


  const data =
    await response.json();


  if (!response.ok) {
    throw new Error(
      `Failed to load Ozon delivery points (${response.status}): ${JSON.stringify(data)}`
    );
  }


  return data;
}


// --------------------------------------------------
// Delivery point information
// --------------------------------------------------

export async function getOzonDeliveryPointInfo(
  deliveryPointIds,
  { signal, strictResponse = false } = {}
) {
  if (
    !Array.isArray(
      deliveryPointIds
    ) ||
    deliveryPointIds.length ===
      0
  ) {
    return [];
  }


  if (
    deliveryPointIds.length >
    100
  ) {
    throw new Error(
      "Ozon delivery-point/info accepts maximum 100 IDs"
    );
  }


  const response =
    await ozonDeliveryRequest(
      "/v1/delivery-point/info",
      {
        signal,
        body: {
          delivery_point_ids:
            deliveryPointIds,
        },
      }
    );


  const data =
    await response.json();


  if (!response.ok) {
    throw new Error(
      `Failed to load Ozon delivery point info (${response.status}): ${JSON.stringify(data)}`
    );
  }


  if (!Array.isArray(data?.delivery_points)) {
    if (strictResponse) {
      throw new Error("Invalid Ozon delivery point info response");
    }
    return [];
  }

  return data.delivery_points;
}


// --------------------------------------------------
// Distance calculation
// --------------------------------------------------

export function calculateDistanceMeters(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const earthRadiusMeters =
    6371000;


  const toRadians =
    (degrees) =>
      degrees *
      Math.PI /
      180;


  const dLat =
    toRadians(
      lat2 - lat1
    );

  const dLon =
    toRadians(
      lon2 - lon1
    );


  const a =
    Math.sin(
      dLat / 2
    ) *
      Math.sin(
        dLat / 2
      ) +
    Math.cos(
      toRadians(lat1)
    ) *
      Math.cos(
        toRadians(lat2)
      ) *
      Math.sin(
        dLon / 2
      ) *
      Math.sin(
        dLon / 2
      );


  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(
        Math.max(0, 1 - a)
      )
    );


  return (
    earthRadiusMeters *
    c
  );
}


// --------------------------------------------------
// Find an Ozon PVZ at selected address coordinates
// --------------------------------------------------

export async function findOzonDeliveryPointAtLocation(
  latitude,
  longitude,
  {
    radiusMeters = 150,
  } = {}
) {
  let cursor;


  while (true) {

    const list =
      await getOzonDeliveryPoints({
        limit: 100,
        cursor,
      });


    const availablePoints =
      Array.isArray(
        list.delivery_points
      )
        ? list.delivery_points
        : [];


    const ids =
      availablePoints.map(
        (point) =>
          point.delivery_point_id
      );


    if (
      ids.length >
      0
    ) {

      const points =
        await getOzonDeliveryPointInfo(
          ids
        );


      for (
        const point
        of points
      ) {

        if (
          !point.is_active
        ) {
          continue;
        }


        const pointLatitude =
          point
            .coordinates
            ?.latitude;

        const pointLongitude =
          point
            .coordinates
            ?.longitude;


        if (
          typeof pointLatitude !==
            "number" ||
          typeof pointLongitude !==
            "number"
        ) {
          continue;
        }


        const distanceMeters =
          calculateDistanceMeters(
            latitude,
            longitude,
            pointLatitude,
            pointLongitude
          );


        if (
          distanceMeters <=
          radiusMeters
        ) {
          return {
            deliveryPointId:
              point
                .delivery_point_id,

            name:
              point.name,

            address:
              point.full_address,

            type:
              point.type,

            latitude:
              pointLatitude,

            longitude:
              pointLongitude,

            distanceMeters:
              Math.round(
                distanceMeters
              ),

            storagePeriodDays:
              point
                .storage_period_days ??
              null,
          };
        }
      }
    }


    if (
      !list.next_cursor
    ) {
      break;
    }


    cursor =
      list.next_cursor;
  }


  return null;
}


// --------------------------------------------------
// Check whether a parcel can be delivered to a PVZ
// --------------------------------------------------

export async function checkOzonDeliveryPointAvailability({
  deliveryPointId,
  declaredValue,
  dimensions =
    OZON_DEFAULT_PARCEL_DIMENSIONS,
}) {

  const numericDeclaredValue =
    Number(
      declaredValue
    );


  if (
    !Number.isFinite(
      numericDeclaredValue
    ) ||
    numericDeclaredValue <= 0
  ) {
    const error =
      new Error(
        "Invalid declared value"
      );

    error.statusCode =
      400;

    throw error;
  }


  const response =
    await ozonDeliveryRequest(
      "/v1/delivery-point/check-availability",
      {
        body: {
          delivery_point_ids: [
            deliveryPointId,
          ],

          shipment_method_id:
            OZON_WEBSITE_SHIPMENT_METHOD_ID,

          postings: [
            {
              request_id:
                1,

              declared_value: {
                amount:
                  numericDeclaredValue
                    .toFixed(2),

                currency_code:
                  "RUB",
              },

              dimensions,
            },
          ],
        },
      }
    );


  const data =
    await response.json();


  if (!response.ok) {
    throw new Error(
      `Ozon Delivery availability check failed (${response.status}): ${JSON.stringify(data)}`
    );
  }


  const result =
    data.results?.[0];


  if (!result) {
    throw new Error(
      "Ozon Delivery returned no availability result"
    );
  }


  if (result.error) {
    return {
      available:
        false,

      error:
        result.error,
    };
  }


  return {
    available:
      true,

    deliveryPointId:
      result.delivery_point_id,

    cutoffAt:
      result.cutoff_at,
  };
}


// --------------------------------------------------
// Calculate Ozon delivery conditions
// --------------------------------------------------

export async function checkoutOzonDelivery({
  phone,
  deliveryPointId,
  declaredValue,
  cutoffAt,
  dimensions =
    OZON_DEFAULT_PARCEL_DIMENSIONS,
}) {

  const normalizedPhone =
    String(
      phone || ""
    ).replace(
      /\D/g,
      ""
    );


  if (
    !/^7\d{10}$/.test(
      normalizedPhone
    )
  ) {
    const error =
      new Error(
        "Invalid phone number"
      );

    error.statusCode =
      400;

    throw error;
  }


  const numericDeclaredValue =
    Number(
      declaredValue
    );


  if (
    !Number.isFinite(
      numericDeclaredValue
    ) ||
    numericDeclaredValue <= 0
  ) {
    const error =
      new Error(
        "Invalid declared value"
      );

    error.statusCode =
      400;

    throw error;
  }


  if (!cutoffAt) {
    const error =
      new Error(
        "cutoffAt is required"
      );

    error.statusCode =
      400;

    throw error;
  }


  const response =
    await ozonDeliveryRequest(
      "/v1/order/checkout",
      {
        body: {
          recipient: {
            phone_number:
              `+${normalizedPhone}`,
          },

          postings: [
            {
              request_id:
                1,

              shipment_method_id:
                OZON_WEBSITE_SHIPMENT_METHOD_ID,

              cutoff_at:
                cutoffAt,

              declared_value: {
                amount:
                  numericDeclaredValue
                    .toFixed(2),

                currency_code:
                  "RUB",
              },

              dimensions,
            },
          ],

          delivery: {
            delivery_point: {
              delivery_point_id:
                deliveryPointId,
            },
          },
        },
      }
    );


  const data =
    await response.json();


  if (!response.ok) {
    throw new Error(
      `Ozon Delivery checkout failed (${response.status}): ${JSON.stringify(data)}`
    );
  }


  const result =
    data.results?.[0];


  if (!result) {
    throw new Error(
      "Ozon Delivery returned no checkout result"
    );
  }


  if (result.error) {
    return {
      available:
        false,

      error:
        result.error,
    };
  }


  const posting =
    result.posting;


  return {
    available:
      true,

    deliveryCost:
      Number(
        posting
          ?.estimated_delivery_cost
          ?.amount ??
        0
      ),

    insuranceCost:
      Number(
        posting
          ?.estimated_insurance_cost
          ?.amount ??
        0
      ),

    estimatedDeliveryDays:
      posting
        ?.estimated_delivery_days ??
      null,

    cutoffAt:
      posting
        ?.cutoff_at ??
      null,
  };
}  