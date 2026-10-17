export const createWebsiteOrderSchema = {
  tags: ["Website"],

  summary: "Create website order",

  description:
    "Creates a new order from the LaDePurfum website. Prices, totals and delivery details are calculated by the backend.",


  body: {
    type: "object",

    required: [
      "customer",
      "delivery",
      "items",
    ],

    additionalProperties: false,

    properties: {

      /* =========================
         CUSTOMER
      ========================= */

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


      /* =========================
         DELIVERY
      ========================= */

      delivery: {
        type: "object",

        required: [
          "provider",
          "deliveryPointId",
        ],

        additionalProperties: false,

        properties: {

          provider: {
            type: "string",
            enum: [
              "ozon",
            ],
          },

          deliveryPointId: {
            type: "string",
            minLength: 1,
          },

        },
      },


      /* =========================
         PROMO
      ========================= */

      promoCode: {
        type: ["string", "null"],
      },


      /* =========================
         ITEMS
      ========================= */

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


  /* =========================
     RESPONSES
  ========================= */

  response: {

    /* =========================
       201
    ========================= */

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


    /* =========================
       400
    ========================= */

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


    /* =========================
       500
    ========================= */

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