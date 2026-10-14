import { supabase } from "../../../lib/supabase.js";

const OZON_AUTH_URL =
  "https://seller.ozon.ru/app/appstore/oauth/authorize";


export function buildOzonAuthorizationUrl(state) {
  const clientId = process.env.OZON_DELIVERY_CLIENT_ID;
  const redirectUri = process.env.OZON_DELIVERY_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    throw new Error(
      "OZON_DELIVERY_CLIENT_ID or OZON_DELIVERY_REDIRECT_URI is missing"
    );
  }

  const params = new URLSearchParams({
    response_type: "code",
    access_type: "offline",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "seller-api.ozon-logistics",
    state,
    prompt: "select_company",
  });

  return `${OZON_AUTH_URL}?${params.toString()}`;
}


function getSellerIdFromAccessToken(accessToken) {
  const parts = accessToken.split(".");

  if (parts.length !== 3) {
    throw new Error("Invalid Ozon access token format");
  }

  const payload = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8")
  );

  if (!payload.sub) {
    throw new Error(
      "Seller ID is missing from Ozon access token"
    );
  }

  return String(payload.sub);
}


export async function exchangeAuthorizationCode(code) {
  const clientId = process.env.OZON_DELIVERY_CLIENT_ID;
  const clientSecret = process.env.OZON_DELIVERY_CLIENT_SECRET;
  const redirectUri = process.env.OZON_DELIVERY_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Ozon Delivery OAuth environment variables are missing"
    );
  }

  const response = await fetch(
    "https://xapi.ozon.ru/oauth/oauth/token",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    }
  );

  const contentType = response.headers.get("content-type");

  const rawBody = await response.text();
  
  console.log("Ozon OAuth response:", {
    status: response.status,
    contentType,
    responseUrl: response.url,
  });
  
  let data;
  
  try {
    data = JSON.parse(rawBody);
  } catch {
    console.log(
      "Ozon OAuth non-JSON body preview:",
      rawBody.slice(0, 1000)
    );
  
    throw new Error(
      `Ozon OAuth returned non-JSON response. HTTP ${response.status}, Content-Type: ${contentType}`
    );
  }
  }

  if (!response.ok) {
    throw new Error(
      `Ozon OAuth token exchange failed: ${JSON.stringify(data)}`
    );
  }

  return data;
}


export async function saveOAuthTokens(tokens) {
  const sellerId =
    getSellerIdFromAccessToken(tokens.access_token);

  const expiresAt = new Date(
    Date.now() + tokens.expires_in * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from("ozon_delivery_oauth")
    .upsert(
      {
        seller_id: sellerId,

        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,

        token_type: tokens.token_type,
        scope: tokens.scope,

        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "seller_id",
      }
    )
    .select()
    .single();

  if (error) {
    throw new Error(
      `Failed to save Ozon OAuth tokens: ${error.message}`
    );
  }

  return data;
}