import { websiteOzonPayEnabled } from "./websitePaymentFeature.js";
import { verifyWebsitePaymentAccessToken } from "./websitePaymentAccessToken.js";

import {
    verifyOzonPayNotification,
  } from "../payment/ozon/ozonPayService.js";

import {
  createWebsiteOrderPayment,
  getWebsiteOrderPaymentStatus,
  markWebsiteOrderPaidFromOzon,
  } from "./websiteOrdersService.js";
  
  
  export default async function websitePaymentRoutes(
    fastify
  ) {

      // --------------------------------------------------
  // Create Ozon Pay payment for website order
  // --------------------------------------------------

  const paymentInitiationError = {
    type: "object",
    required: ["success", "message"],
    properties: { success: { type: "boolean", enum: [false] }, message: { type: "string" } },
  };
  fastify.post("/website/orders/:orderId/payment", {
    schema: {
      tags: ["Website Payments"],
      summary: "Create Ozon Pay payment for website order",
      description: "Initiates payment when backend payment initiation is enabled. Send an empty request body. " +
        "The backend requires a valid, expiring, order-scoped payment token, reserves payment creation atomically, " +
        "and stores the provider result before returning the link. A link does not confirm payment. " +
        "When initiation is disabled, a valid order ID returns HTTP 503.",
      params: {
        type: "object",
        required: ["orderId"],
        properties: {
          orderId: {
            type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
            description: "Positive safe-integer website order ID.",
          },
        },
      },
      headers: {
        type: "object",
        required: ["x-website-payment-token"],
        properties: {
          "x-website-payment-token": {
            type: "string",
            description: "Signed, expiring, order-scoped payment token required when payment initiation is enabled.",
          },
        },
      },
      response: {
        200: {
          type: "object",
          required: ["success", "payment"],
          properties: {
            success: { type: "boolean", enum: [true] },
            payment: {
              type: "object",
              required: ["orderId", "orderNumber", "amount", "ozonPayOrderId", "payLink", "isTestMode"],
              properties: {
                orderId: { type: "integer" },
                orderNumber: { type: "string" },
                amount: { type: "number", description: "Website order total in rubles." },
                ozonPayOrderId: { type: "string", description: "Saved Ozon order ID." },
                ozonPayStatus: { type: "string", description: "Provider-reported order status, when supplied." },
                payLink: { type: "string", description: "Provider-issued checkout link." },
                isTestMode: { type: "boolean", description: "Ozon order mode verified against the configured expected mode." },
              },
            },
          },
        },
        ...Object.fromEntries(Object.entries({
          400: "Invalid or already-paid order",
          401: "Missing, invalid, or expired payment token",
          403: "Token belongs to another order",
          404: "Order not found",
          409: "Payment reservation denied for the current order or payment state",
          500: "Unexpected payment initialization failure",
          502: "Ozon returned an invalid order or an unexpected payment environment",
          503: "Payment initiation is disabled, required payment configuration is invalid, " +
            "or the provider or database outcome could not be confirmed",
        }).map(([code, description]) => [code, { ...paymentInitiationError, description }])),
      },
    },
    async preValidation(request, reply) {
      const rawId = request.params.orderId;
      const orderId = Number(rawId);
      if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(orderId) || orderId < 1) {
        return reply.code(400).send({ success: false, message: "Invalid website order ID" });
      }

      // This gate controls only new payment initiation, including requests with older tokens.
      if (!websiteOzonPayEnabled) {
        return reply.code(503).send({ success: false, message: "Website payments are temporarily unavailable" });
      }

      try {
        verifyWebsitePaymentAccessToken(request.headers["x-website-payment-token"], orderId);
      } catch (error) {
        const statusCode = [401, 403, 503].includes(error?.statusCode) ? error.statusCode : 503;
        const message = {
          401: "Valid website payment token required",
          403: "Website payment token is for another order",
          503: "Website payment authorization is unavailable",
        }[statusCode];
        return reply.code(statusCode).send({ success: false, message });
      }
    },
  }, async (request, reply) => {
    const orderId = Number(request.params.orderId);
    try {
      const payment = await createWebsiteOrderPayment(orderId);
      return reply.code(200).send({ success: true, payment });
    } catch (error) {
      request.log.error({ errorMessage: error?.message, orderId }, "Failed to create website order payment");
      return reply.code(error?.statusCode || 500).send({
        success: false,
        message: error?.message || "Failed to create payment",
      });
    }
  });

  const paymentStatusErrors = {
    400: "Invalid website order ID",
    401: "Valid website payment token required",
    403: "Website payment token is for another order",
    404: "Website order not found",
    409: "Payment does not match an eligible order",
    503: "Website payment status is temporarily unavailable",
  };
  const orderIdSchema = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };

  fastify.get("/website/orders/:orderId/payment-status", {
    exposeHeadRoute: false,
    schema: {
      tags: ["Website Payments"],
      summary: "Get website order payment status",
      description: "Checks the saved Ozon Pay payment status for an authorized website order and can reconcile a verified successful payment using the atomic settlement RPC.",
      params: {
        type: "object",
        required: ["orderId"],
        properties: { orderId: { ...orderIdSchema, description: "Positive website order ID" } },
      },
      headers: {
        type: "object",
        required: ["x-website-payment-token"],
        properties: {
          "x-website-payment-token": { type: "string", description: "Signed order-scoped payment capability" },
        },
      },
      response: {
        200: {
          type: "object",
          required: ["success", "orderId", "paymentStatus"],
          properties: {
            success: { type: "boolean", enum: [true] },
            orderId: orderIdSchema,
            paymentStatus: {
              type: "string",
              enum: ["paid", "not_started", "pending", "processing", "recovery_required", "unavailable"],
            },
          },
        },
        ...Object.fromEntries(Object.entries(paymentStatusErrors).map(([code, description]) => [
          code, {
            description: code === "503" ? "Authorization, provider, or database temporarily unavailable" : description,
            type: "object",
            required: ["success", "message"],
            properties: { success: { type: "boolean", enum: [false] }, message: { type: "string" } },
          },
        ])),
      },
    },
    async preValidation(request, reply) {
      reply.header("Cache-Control", "no-store");
      const rawId = request.params.orderId;
      const orderId = Number(rawId);
      if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(orderId) || orderId < 1) {
        return reply.code(400).send({ success: false, message: paymentStatusErrors[400] });
      }

      // Authorize before schema validation so a missing required header returns 401.
      try {
        verifyWebsitePaymentAccessToken(request.headers["x-website-payment-token"], orderId);
      } catch (error) {
        const code = [401, 403].includes(error?.statusCode) ? error.statusCode : 503;
        const message = code === 503 ? "Website payment authorization is unavailable" : paymentStatusErrors[code];
        return reply.code(code).send({ success: false, message });
      }
    },
  }, async (request, reply) => {
    const orderId = Number(request.params.orderId);
    try {
      const paymentStatus = await getWebsiteOrderPaymentStatus(orderId);
      return { success: true, orderId, paymentStatus };
    } catch (error) {
      const code = [404, 409].includes(error?.statusCode) ? error.statusCode : 503;
      return reply.code(code).send({ success: false, message: paymentStatusErrors[code] });
    }
  });

  const notificationTransactionId = {
    type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
    deprecated: true,
    description: "Deprecated Ozon transaction ID. A non-null value takes precedence over either UID.",
  };
  const notificationUid = { type: "string", minLength: 1 };
  const notificationSchema = {
    tags: ["Website Payments"],
    summary: "Receive Ozon Pay transaction notification",
    description: "Receives a signed Ozon Acquiring notification from Ozon Pay. The backend matches the saved " +
      "website payment, verifies authenticated Ozon order status, and atomically confirms an eligible successful " +
      "payment. Unsigned notification status, operation type, and mode do not prove payment. " +
      "No customer payment token is required. Settlement does not create shipments.",
    body: {
      type: "object",
      required: ["orderID", "extOrderID", "amount", "currencyCode", "requestSign"],
      anyOf: [
        { required: ["transactionID"], properties: { transactionID: notificationTransactionId } },
        {
          required: ["transactionUID"],
          properties: { transactionID: { type: "integer", nullable: true, enum: [null] }, transactionUID: notificationUid },
        },
        {
          required: ["transactionUid"],
          properties: {
            transactionID: { type: "integer", nullable: true, enum: [null] },
            transactionUID: { type: "string", nullable: true, enum: [null] },
            transactionUid: notificationUid,
          },
        },
      ],
      properties: {
        orderID: { type: "string", minLength: 1, description: "Ozon order ID matching the saved provider payment." },
        extOrderID: { type: "string", minLength: 1, description: "Merchant order reference matching the website order." },
        transactionID: { ...notificationTransactionId, nullable: true },
        transactionUID: { ...notificationUid, nullable: true, description: "Ozon transaction UID used when transactionID is absent or null." },
        transactionUid: { ...notificationUid, nullable: true, description: "Alternate UID spelling used when transactionID and transactionUID are absent or null." },
        amount: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Signed payment amount in kopecks." },
        currencyCode: { type: "string", enum: ["643"], description: "Signed currency code. Website settlement requires RUB." },
        status: { type: "string", description: "Optional provider transaction status. Not used as proof of payment." },
        operationType: { type: "string", description: "Optional provider operation type. Not used as proof of payment." },
        testMode: { type: "integer", enum: [0, 1], description: "Optional provider mode indicator. 0 is live and 1 is test." },
        requestSign: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Lowercase hexadecimal SHA-256 notification signature." },
      },
    },
    response: Object.fromEntries(Object.entries({
      200: "Current local acknowledgement for a confirmed payment or matching durable replay.",
      400: "Malformed notification or signed amount or currency mismatch.",
      401: "Missing or invalid notification signature.",
      404: "Website order not found.",
      409: "Saved provider ID mismatch or conflicting local payment state.",
      503: "Provider verification or settlement remains unresolved. Redelivery is not guaranteed.",
    }).map(([code, description]) => [code, {
      description,
      type: "object",
      required: ["success"],
      properties: { success: { type: "boolean", enum: [code === "200"] } },
    }])),
  };

  fastify.post("/website/payments/ozon/notification", {
    // Keep notification typing out of Fastify validation and coercion. The handler
    // verifies the original signed fields and owns the existing error envelopes.
    config: { swaggerTransform: ({ url }) => ({ url, schema: notificationSchema }) },
  }, async (request, reply) => {
    const notification = request.body;
    const isIdentifier = (value) =>
      typeof value === "string" && value.trim().length > 0 && !value.includes("|");

    if (!notification || typeof notification !== "object" || Array.isArray(notification)) {
      return reply.code(400).send({ success: false });
    }

    const { orderID, extOrderID, amount, currencyCode, transactionID } = notification;
    const transactionUID = notification.transactionUID ?? notification.transactionUid;
    const hasTransaction = transactionID == null
      ? isIdentifier(transactionUID)
      : Number.isSafeInteger(transactionID) && transactionID >= 0;

    if (!isIdentifier(orderID) || !isIdentifier(extOrderID) || !hasTransaction ||
        !Number.isSafeInteger(amount) || amount <= 0 || !isIdentifier(currencyCode)) {
      return reply.code(400).send({ success: false });
    }

    try {
      if (!verifyOzonPayNotification(notification)) {
        return reply.code(401).send({ success: false });
      }

      await markWebsiteOrderPaidFromOzon({ orderID, extOrderID, amount, currencyCode });
      return reply.code(200).send({ success: true });
    } catch (error) {
      const statusCode = [400, 404, 409, 503].includes(error?.statusCode)
        ? error.statusCode : 503;
      if (statusCode >= 500) {
        request.log.warn("Ozon Pay notification settlement could not be confirmed");
      }
      return reply.code(statusCode).send({ success: false });
    }
  });
}
