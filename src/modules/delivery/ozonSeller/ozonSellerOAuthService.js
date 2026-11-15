import { supabase } from "../../../lib/supabase.js";

const OZON_SELLER_AUTHORIZATION_URL =
  "https://seller.ozon.ru/app/appstore/oauth/authorize";

const OZON_SELLER_TOKEN_URL =
  "https://xapi.ozon.ru/oauth/token";

const OZON_SELLER_LOGISTICS_SCOPE =
  "seller-api.ozon-logistics";


// --------------------------------------------------
// Helpers
// --------------------------------------------------

function getSellerIdFromAccessToken(accessToken) {
  const parts = String(accessToken || "").split(".");

  if (parts.length !== 3) {
    throw new Error(
      "Invalid Ozon Seller access token format"
    );
  }

  const payload = JSON.parse(
    Buffer.from(
      parts[1],
      "base64url"
    ).toString("utf8")
  );

  if (!payload.sub) {
    throw new Error(
      "Seller ID is missing from Ozon Seller access token"
    );
  }

  return String(payload.sub);
}


function getExpiresAt(tokens) {
  const expiresIn =
    Number(tokens.expires_in);

  if (
    Number.isFinite(expiresIn) &&
    expiresIn > 0
  ) {
    return new Date(
      Date.now() + expiresIn * 1000
    ).toISOString();
  }

  const accessToken =
    tokens.access_token;

  const parts =
    String(accessToken || "").split(".");

  if (parts.length === 3) {
    try {
      const payload =
        JSON.parse(
          Buffer.from(
            parts[1],
            "base64url"
          ).toString("utf8")
        );

      if (payload.exp) {
        return new Date(
          Number(payload.exp) * 1000
        ).toISOString();
      }
    } catch {
      // Ignore JWT parsing here.
    }
  }

  throw new Error(
    "Unable to determine Ozon Seller token expiration"
  );
}


// --------------------------------------------------
// Authorization URL
// --------------------------------------------------

export function buildOzonSellerAuthorizationUrl(
  state
) {
  const clientId =
    process.env.OZON_SELLER_LOGISTICS_CLIENT_ID;

  const redirectUri =
    process.env.OZON_SELLER_LOGISTICS_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    throw new Error(
      "OZON_SELLER_LOGISTICS_CLIENT_ID or OZON_SELLER_LOGISTICS_REDIRECT_URI is missing"
    );
  }

  const params =
    new URLSearchParams({
      response_type:
        "code",

      access_type:
        "offline",

      client_id:
        clientId,

      redirect_uri:
        redirectUri,

      scope:
        OZON_SELLER_LOGISTICS_SCOPE,

      state,

      prompt:
        "select_company",
    });

  return (
    `${OZON_SELLER_AUTHORIZATION_URL}?` +
    params.toString()
  );
}


// --------------------------------------------------
// Exchange authorization code
// --------------------------------------------------

export async function exchangeOzonSellerAuthorizationCode(
  code
) {
  const clientId =
    process.env.OZON_SELLER_LOGISTICS_CLIENT_ID;

  const clientSecret =
    process.env.OZON_SELLER_LOGISTICS_CLIENT_SECRET;

  const redirectUri =
    process.env.OZON_SELLER_LOGISTICS_REDIRECT_URI;

  if (
    !clientId ||
    !clientSecret ||
    !redirectUri
  ) {
    throw new Error(
      "Ozon Seller OAuth environment variables are missing"
    );
  }

  const response =
    await fetch(
      OZON_SELLER_TOKEN_URL,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            grant_type:
              "authorization_code",

            client_id:
              clientId,

            client_secret:
              clientSecret,

            redirect_uri:
              redirectUri,

            code,
          }),
      }
    );

  const rawBody =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(rawBody);
  } catch {
    throw new Error(
      `Ozon Seller OAuth returned non-JSON response. HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Ozon Seller OAuth token exchange failed (${response.status}): ${JSON.stringify(data)}`
    );
  }

  return data;
}


// --------------------------------------------------
// Save tokens
// --------------------------------------------------

export async function saveOzonSellerTokens(
  tokens
) {
  if (!tokens?.access_token) {
    throw new Error(
      "Ozon Seller access_token is missing"
    );
  }

  const sellerId =
    getSellerIdFromAccessToken(
      tokens.access_token
    );

  const expiresAt =
    getExpiresAt(tokens);

  const { data, error } =
    await supabase
      .from("ozon_delivery_oauth")
      .upsert(
        {
          seller_id:
            sellerId,

          access_token:
            tokens.access_token,

          refresh_token:
            tokens.refresh_token || "",

          token_type:
            tokens.token_type || "bearer",

          scope:
            Array.isArray(tokens.scope)
              ? tokens.scope
              : [OZON_SELLER_LOGISTICS_SCOPE],

          expires_at:
            expiresAt,

          updated_at:
            new Date().toISOString(),
        },
        {
          onConflict:
            "seller_id",
        }
      )
      .select()
      .single();

  if (error) {
    throw new Error(
      `Failed to save Ozon Seller OAuth tokens: ${error.message}`
    );
  }

  return data;
}


// --------------------------------------------------
// Load stored Seller OAuth
// --------------------------------------------------

export async function getStoredOzonSellerOAuth() {
  const sellerId =
    process.env.OZON_SELLER_LOGISTICS_SELLER_ID;

  if (!sellerId) {
    throw new Error(
      "OZON_SELLER_LOGISTICS_SELLER_ID is missing"
    );
  }

  const { data, error } =
    await supabase
      .from("ozon_delivery_oauth")
      .select("*")
      .eq(
        "seller_id",
        sellerId
      )
      .maybeSingle();

  if (error) {
    throw new Error(
      `Failed to load Ozon Seller OAuth tokens: ${error.message}`
    );
  }

  if (!data) {
    throw new Error(
      `Ozon Seller OAuth is not connected for seller ${sellerId}`
    );
  }

  return data;
}


// --------------------------------------------------
// Refresh token
// --------------------------------------------------

export async function refreshOzonSellerAccessToken(
  refreshToken
) {
  const clientId =
    process.env.OZON_SELLER_LOGISTICS_CLIENT_ID;

  const clientSecret =
    process.env.OZON_SELLER_LOGISTICS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Ozon Seller OAuth client credentials are missing"
    );
  }

  if (!refreshToken) {
    throw new Error(
      "Ozon Seller refresh token is missing"
    );
  }

  const response =
    await fetch(
      OZON_SELLER_TOKEN_URL,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            grant_type:
              "refresh_token",

            client_id:
              clientId,

            client_secret:
              clientSecret,

            refresh_token:
              refreshToken,
          }),
      }
    );

  const rawBody =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(rawBody);
  } catch {
    throw new Error(
      `Ozon Seller token refresh returned non-JSON response. HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Ozon Seller token refresh failed (${response.status}): ${JSON.stringify(data)}`
    );
  }

  return data;
}


// --------------------------------------------------
// Get valid access token
// --------------------------------------------------

export async function getOzonSellerAccessToken() {
  const stored =
    await getStoredOzonSellerOAuth();

  const expiresAt =
    new Date(
      stored.expires_at
    ).getTime();

  const refreshBeforeMs =
    5 * 60 * 1000;

  const tokenStillValid =
    Number.isFinite(expiresAt) &&
    expiresAt - Date.now() >
      refreshBeforeMs;

  if (tokenStillValid) {
    return stored.access_token;
  }

  const refreshed =
    await refreshOzonSellerAccessToken(
      stored.refresh_token
    );

  /*
   * Some OAuth providers rotate refresh tokens,
   * while others may omit a new refresh_token.
   *
   * Preserve the current one when Ozon does not
   * return another.
   */
  if (!refreshed.refresh_token) {
    refreshed.refresh_token =
      stored.refresh_token;
  }

  await saveOzonSellerTokens(
    refreshed
  );

  return refreshed.access_token;
}