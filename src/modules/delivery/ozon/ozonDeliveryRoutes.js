import crypto from "node:crypto";

import {
  buildOzonAuthorizationUrl,
  exchangeAuthorizationCode,
  saveOAuthTokens,
} from "./ozonDeliveryService.js";


function createOAuthState() {
  const secret = process.env.OZON_DELIVERY_CLIENT_SECRET;

  if (!secret) {
    throw new Error(
      "OZON_DELIVERY_CLIENT_SECRET is missing"
    );
  }

  const timestamp = Date.now().toString();
  const random = crypto.randomBytes(16).toString("hex");

  const payload = `${timestamp}.${random}`;

  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  return `${payload}.${signature}`;
}


function verifyOAuthState(state) {
  const secret = process.env.OZON_DELIVERY_CLIENT_SECRET;

  if (!secret || !state) {
    return false;
  }

  const parts = state.split(".");

  if (parts.length !== 3) {
    return false;
  }

  const [timestamp, random, receivedSignature] = parts;

  const payload = `${timestamp}.${random}`;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  const receivedBuffer =
    Buffer.from(receivedSignature, "hex");

  const expectedBuffer =
    Buffer.from(expectedSignature, "hex");

  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(
      receivedBuffer,
      expectedBuffer
    )
  ) {
    return false;
  }

  // OAuth state is valid for 10 minutes
  const age = Date.now() - Number(timestamp);

  return age >= 0 && age <= 10 * 60 * 1000;
}


export default async function ozonDeliveryRoutes(fastify) {

  // STEP 1 — Start OAuth
  fastify.get("/oauth/start", async (request, reply) => {

    const state = createOAuthState();

    const authorizationUrl =
      buildOzonAuthorizationUrl(state);

    return reply.redirect(authorizationUrl);
  });


  // STEP 2 — Ozon redirects back here
  fastify.get("/oauth/callback", async (request, reply) => {

    const { code, state } = request.query;

    if (!code) {
      return reply.code(400).send({
        success: false,
        message: "Authorization code is missing",
      });
    }

    if (!verifyOAuthState(state)) {
      return reply.code(400).send({
        success: false,
        message: "Invalid or expired OAuth state",
      });
    }

    const tokens =
      await exchangeAuthorizationCode(code);

    const oauth =
      await saveOAuthTokens(tokens);

    return {
      success: true,

      message: "Ozon Delivery OAuth connected",

      sellerId: oauth.seller_id,

      expiresAt: oauth.expires_at,

      scope: tokens.scope,

      hasAccessToken: Boolean(tokens.access_token),

      hasRefreshToken: Boolean(tokens.refresh_token),
    };
  });

}