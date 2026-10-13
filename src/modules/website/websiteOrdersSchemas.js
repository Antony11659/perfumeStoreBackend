export const createWebsiteOrderSchema = {
    tags: ["Website"],
  
    summary: "Create website order",
  
    description:
      "Creates a new order from the LaDePurfum website. Prices and totals are calculated by the backend.",
  
    body: {
      type: "object",
  
      required: [
        "customer",
        "items",
      ],
  
      additionalProperties: false,
  
      properties: {
  
        customer: {
          type: "object",
  
          required: [
            "name",
            "phone",
            "city",
            "address",
          ],
  
          additionalProperties: false,
  
          properties: {
  
            name: {
              type: "string",
              minLength: 1,
            },
  
            phone: {
              type: "string",
              minLength: 1,
            },
  
            messenger: {
              type: ["string", "null"],
            },
  
            city: {
              type: "string",
              minLength: 1,
            },
  
            address: {
              type: "string",
              minLength: 1,
            },
  
            comment: {
              type: ["string", "null"],
            },
  
          },
        },
  
  
        promoCode: {
          type: ["string", "null"],
        },
  
  
        items: {
          type: "array",
  
          minItems: 1,
  
          items: {
            type: "object",
  
            required: [
              "variantId",
              "quantity",
            ],
  
            additionalProperties: false,
  
            properties: {
  
              variantId: {
                type: "integer",
                minimum: 1,
              },
  
              quantity: {
                type: "integer",
                minimum: 1,
              },
  
            },
          },
        },
  
      },
    },
  
  
    response: {
  
      201: {
        type: "object",
  
        properties: {
  
          success: {
            type: "boolean",
          },
  
          order: {
            type: "object",
  
            properties: {
  
              id: {
                type: "integer",
              },
  
              orderNumber: {
                type: "string",
              },
  
              pricingMode: {
                type: "string",
              },
  
              subtotal: {
                type: "number",
              },
  
              deliveryPrice: {
                type: "number",
              },
  
              total: {
                type: "number",
              },
  
              status: {
                type: "string",
              },
  
            },
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