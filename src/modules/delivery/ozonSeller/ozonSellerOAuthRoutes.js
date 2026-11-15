import crypto from "node:crypto";

import {
  buildOzonSellerAuthorizationUrl,
  exchangeOzonSellerAuthorizationCode,
  saveOzonSellerTokens,
} from "./ozonSellerOAuthService.js";


// --------------------------------------------------
// OAuth state
// --------------------------------------------------

function createOAuthState() {
  const secret =
    process.env.OZON_SELLER_LOGISTICS_CLIENT_SECRET;

  if (!secret) {
    throw new Error(
      "OZON_SELLER_LOGISTICS_CLIENT_SECRET is missing"
    );
  }

  const timestamp =
    Date.now().toString();

  const random =
    crypto.randomBytes(16).toString("hex");

  const payload =
    `${timestamp}.${random}`;

  const signature =
    crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

  return `${payload}.${signature}`;
}


function verifyOAuthState(state) {
  const secret =
    process.env.OZON_SELLER_LOGISTICS_CLIENT_SECRET;

  if (!secret || !state) {
    return false;
  }

  const parts =
    state.split(".");

  if (parts.length !== 3) {
    return false;
  }

  const [
    timestamp,
    random,
    receivedSignature,
  ] = parts;

  const payload =
    `${timestamp}.${random}`;

  const expectedSignature =
    crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

  const receivedBuffer =
    Buffer.from(
      receivedSignature,
      "hex"
    );

  const expectedBuffer =
    Buffer.from(
      expectedSignature,
      "hex"
    );

  if (
    receivedBuffer.length !==
      expectedBuffer.length ||
    !crypto.timingSafeEqual(
      receivedBuffer,
      expectedBuffer
    )
  ) {
    return false;
  }

  // OAuth state is valid for 10 minutes.
  const age =
    Date.now() - Number(timestamp);

  return (
    Number.isFinite(age) &&
    age >= 0 &&
    age <= 10 * 60 * 1000
  );
}


// --------------------------------------------------
// Routes
// --------------------------------------------------

export default async function ozonSellerOAuthRoutes(
  fastify
) {

  // ------------------------------------------------
  // STEP 1 — Start Seller OAuth
  // ------------------------------------------------

  fastify.get(
    "/oauth/start",
    {
      schema: {
        tags: [
          "Ozon Seller Logistics",
        ],

        summary:
          "Start Ozon Seller Logistics OAuth",

        description:
          "Redirects the administrator to Ozon Seller authorization. Used to connect the seller account with the seller-api.ozon-logistics scope.",

        response: {
          401: {
            type: "object",
            properties: {
              success: {
                type: "boolean",
              },

              message: {
                type: "string",
              },
            },
          },

          302: {
            type: "null",
            description:
              "Redirect to Ozon Seller authorization",
          },

          500: {
            type: "object",
            properties: {
              success: {
                type: "boolean",
              },

              message: {
                type: "string",
              },
            },
          },
        },
      },
    },

    async (request, reply) => {
      try {
        const adminKey =
          process.env.OZON_SELLER_OAUTH_ADMIN_KEY;

        const receivedKey =
          request.headers["x-admin-oauth-key"];

        const expectedBuffer =
          Buffer.from(adminKey || "", "utf8");

        const receivedBuffer =
          Buffer.from(
            typeof receivedKey === "string"
              ? receivedKey
              : "",
            "utf8"
          );

        if (
          !adminKey ||
          !receivedKey ||
          receivedBuffer.length !== expectedBuffer.length ||
          !crypto.timingSafeEqual(
            receivedBuffer,
            expectedBuffer
          )
        ) {
          return reply
            .code(401)
            .send({
              success: false,
              message: "Unauthorized",
            });
        }

        const state =
          createOAuthState();

        const authorizationUrl =
          buildOzonSellerAuthorizationUrl(
            state
          );

        return reply.redirect(
          authorizationUrl
        );
      } catch (error) {
        request.log.error(
          error,
          "OZON SELLER OAUTH START FAILED"
        );

        return reply
          .code(500)
          .send({
            success: false,
            message:
              error?.message ||
              "Failed to start Ozon Seller OAuth",
          });
      }
    }
  );


  // ------------------------------------------------
  // STEP 2 — OAuth callback
  // ------------------------------------------------

  fastify.get(
    "/oauth/callback",
    {
      schema: {
        tags: [
          "Ozon Seller Logistics",
        ],

        summary:
          "Ozon Seller Logistics OAuth callback",

        description:
          "Receives the authorization code from Ozon, validates OAuth state, exchanges the code for tokens and stores the Seller OAuth authorization in Supabase.",

        querystring: {
          type: "object",

          properties: {
            code: {
              type: "string",
            },

            state: {
              type: "string",
            },
          },

          required: [
            "code",
            "state",
          ],
        },

        response: {
          200: {
            type: "object",

            properties: {
              success: {
                type: "boolean",
              },

              message: {
                type: "string",
              },

              sellerId: {
                type: "string",
              },

              expiresAt: {
                type: "string",
              },

              scope: {
                type: "array",
                items: {
                  type: "string",
                },
              },

              hasAccessToken: {
                type: "boolean",
              },

              hasRefreshToken: {
                type: "boolean",
              },
            },
          },

          400: {
            type: "object",

            properties: {
              success: {
                type: "boolean",
              },

              message: {
                type: "string",
              },
            },
          },

          500: {
            type: "object",

            properties: {
              success: {
                type: "boolean",
              },

              message: {
                type: "string",
              },
            },
          },
        },
      },
    },

    async (request, reply) => {
      try {
        const {
          code,
          state,
        } = request.query;

        if (!code) {
          return reply
            .code(400)
            .send({
              success: false,
              message:
                "Authorization code is missing",
            });
        }

        if (
          !verifyOAuthState(state)
        ) {
          return reply
            .code(400)
            .send({
              success: false,
              message:
                "Invalid or expired OAuth state",
            });
        }

        const tokens =
          await exchangeOzonSellerAuthorizationCode(
            code
          );

        const oauth =
          await saveOzonSellerTokens(
            tokens
          );

        return {
          success: true,

          message:
            "Ozon Seller Logistics OAuth connected",

          sellerId:
            oauth.seller_id,

          expiresAt:
            oauth.expires_at,

          scope:
            tokens.scope || [],

          hasAccessToken:
            Boolean(
              tokens.access_token
            ),

          hasRefreshToken:
            Boolean(
              tokens.refresh_token
            ),
        };
      } catch (error) {
        request.log.error(
          error,
          "OZON SELLER OAUTH CALLBACK FAILED"
        );

        return reply
          .code(500)
          .send({
            success: false,
            message:
              error?.message ||
              "Failed to connect Ozon Seller OAuth",
          });
      }
    }
  );
}