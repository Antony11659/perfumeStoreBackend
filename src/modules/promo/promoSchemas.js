export const activatePromoSchema = {
    tags: ["Promo"],
    summary: "Activate promo code",
    description:
      "Validates a promo code and activates discount pricing when the code is valid.",
  
    body: {
      type: "object",
      required: ["code"],
      additionalProperties: false,
      properties: {
        code: {
          type: "string",
          minLength: 1,
        },
      },
    },
  
    response: {
      200: {
        type: "object",
        properties: {
          success: {
            type: "boolean",
          },
          pricingMode: {
            type: "string",
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
  };