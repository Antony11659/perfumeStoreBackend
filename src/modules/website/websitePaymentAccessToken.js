import { createHmac, timingSafeEqual } from "node:crypto";

const PURPOSE = "website_order_payment";
const LIFETIME_SECONDS = 60 * 60;
// Allow a 30-second clock difference between issuing and verifying servers.
const CLOCK_SKEW_SECONDS = 30;

function tokenError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function requireWebsitePaymentTokenSecret() {
  const hex = process.env.WEBSITE_PAYMENT_TOKEN_SECRET;
  if (typeof hex !== "string" || !/^[a-f0-9]{64}$/i.test(hex) || hex.length !== 64) {
    throw tokenError(503, "Website payment authorization is unavailable");
  }
  const secret = Buffer.from(hex, "hex");
  if (new Set(secret).size < 16) {
    throw tokenError(503, "Website payment authorization is unavailable");
  }
  return secret;
}

function isOrderId(orderId) {
  return Number.isSafeInteger(orderId) && orderId > 0;
}

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload, "ascii").digest();
}

export function issueWebsitePaymentAccessToken(orderId, secret = requireWebsitePaymentTokenSecret()) {
  if (!isOrderId(orderId)) {
    throw tokenError(503, "Website payment authorization is unavailable");
  }
  const iat = Math.floor(Date.now() / 1000);
  const claims = { v: 1, orderId, purpose: PURPOSE, iat, exp: iat + LIFETIME_SECONDS };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(payload, secret).toString("base64url")}`;
}

export function verifyWebsitePaymentAccessToken(token, orderId) {
  const invalid = () => tokenError(401, "Valid website payment token required");
  const secret = requireWebsitePaymentTokenSecret();
  if (!isOrderId(orderId) || typeof token !== "string" || token.length > 512) {
    throw invalid();
  }

  const parts = token.split(".");
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
    throw invalid();
  }

  const [payload, encodedSignature] = parts;
  const signature = Buffer.from(encodedSignature, "base64url");
  const expected = sign(payload, secret);
  if (signature.length !== expected.length ||
      signature.toString("base64url") !== encodedSignature ||
      !timingSafeEqual(signature, expected)) {
    throw invalid();
  }

  let claims;
  try {
    const decoded = Buffer.from(payload, "base64url");
    if (decoded.toString("base64url") !== payload) throw invalid();
    claims = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw invalid();
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    claims?.v !== 1 ||
    claims.purpose !== PURPOSE ||
    !isOrderId(claims.orderId) ||
    !Number.isSafeInteger(claims.iat) ||
    claims.iat < 0 ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= now ||
    claims.iat > now + CLOCK_SKEW_SECONDS ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > LIFETIME_SECONDS
  ) {
    throw invalid();
  }
  if (claims.orderId !== orderId) {
    throw tokenError(403, "Website payment token is for another order");
  }
}
