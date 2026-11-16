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

      const expiresAtMs =
        payload?.exp * 1000;

      if (
        typeof payload?.exp === "number" &&
        Number.isFinite(payload.exp) &&
        Number.isFinite(expiresAtMs) &&
        Number.isFinite(new Date(expiresAtMs).getTime())
      ) {
        return new Date(expiresAtMs).toISOString();
      }
    } catch {
      // Missing or malformed JWT expiration is not safe to use.
    }
  }

  throw new Error(
    "Unable to determine Ozon Seller token expiration: missing or invalid JWT exp"
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
      `Ozon Seller OAuth token exchange failed (${response.status})`
    );
  }

  return data;
}


// --------------------------------------------------
// Save tokens
// --------------------------------------------------

export async function saveOzonSellerTokens(
  tokens,
  { signal } = {}
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
      .abortSignal(signal || AbortSignal.timeout(10000))
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

export async function getStoredOzonSellerOAuth({ signal } = {}) {
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
      .abortSignal(signal || AbortSignal.timeout(10000))
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
  refreshToken,
  { signal } = {}
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
        signal,
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
      `Ozon Seller token refresh failed (${response.status})`
    );
  }

  return data;
}


// --------------------------------------------------
// Get valid access token
// --------------------------------------------------

export async function getOzonSellerAccessToken({ signal } = {}) {
  const stored =
    await getStoredOzonSellerOAuth({ signal });

  let expiresAt = NaN;

  try {
    expiresAt = new Date(
      getExpiresAt({ access_token: stored.access_token })
    ).getTime();
  } catch {
    // Refresh tokens whose actual expiration cannot be verified.
  }

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
      stored.refresh_token,
      { signal }
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
    refreshed,
    { signal }
  );

  return refreshed.access_token;
}