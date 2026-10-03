export const shopSchema = {
    type: "object",
    additionalProperties: false,
  
    properties: {
      id: {
        type: "string",
        format: "uuid",
      },
  
      name: {
        type: "string",
      },
  
      code: {
        type: "string",
      },
  
      marketplace: {
        type: "string",
      },
  
      is_active: {
        type: "boolean",
      },
    },
  
    required: [
      "id",
      "name",
      "code",
      "marketplace",
      "is_active",
    ],
  };
  
  
  export const getShopsSchema = {
    tags: ["Shops"],
  
    summary: "Get active shops",
  
    response: {
      200: {
        type: "array",
        items: shopSchema,
      },
  
      500: {
        type: "object",
  
        properties: {
          message: {
            type: "string",
          },
        },
  
        required: ["message"],
      },
    },
  };

  export const missingShopProductSchema = {
    type: "object",
    additionalProperties: false,
  
    properties: {
      sku: {
        type: "string",
      },
  
      offer_id: {
        type: "string",
      },
    },
  
    required: [
      "sku",
      "offer_id",
    ],
  };
  
  
  export const getMissingShopProductsSchema = {
    tags: ["Shops"],
  
    summary: "Get unmapped Ozon products for a shop",
  
    description:
      "Loads visible products from Ozon and returns products whose SKU does not exist in shop_products for this shop.",
  
    params: {
      type: "object",
  
      properties: {
        id: {
          type: "string",
          format: "uuid",
        },
      },
  
      required: ["id"],
    },
  
    response: {
  
      200: {
        type: "object",
        additionalProperties: false,
  
        properties: {
  
          shop: {
            type: "object",
            additionalProperties: false,
  
            properties: {
              id: {
                type: "string",
                format: "uuid",
              },
  
              name: {
                type: "string",
              },
  
              code: {
                type: "string",
              },
  
              marketplace: {
                type: "string",
              },
            },
  
            required: [
              "id",
              "name",
              "code",
              "marketplace",
            ],
          },
  
  
          stats: {
            type: "object",
            additionalProperties: false,
  
            properties: {
              ozonProducts: {
                type: "integer",
              },
  
              mappedProducts: {
                type: "integer",
              },
  
              missingProducts: {
                type: "integer",
              },
            },
  
            required: [
              "ozonProducts",
              "mappedProducts",
              "missingProducts",
            ],
          },
  
  
          missingProducts: {
            type: "array",
            items: missingShopProductSchema,
          },
        },
  
        required: [
          "shop",
          "stats",
          "missingProducts",
        ],
      },
  
  
      400: {
        type: "object",
  
        properties: {
          message: {
            type: "string",
          },
        },
  
        required: ["message"],
      },
  
  
      404: {
        type: "object",
  
        properties: {
          message: {
            type: "string",
          },
        },
  
        required: ["message"],
      },
  
  
      500: {
        type: "object",
  
        properties: {
          message: {
            type: "string",
          },
        },
  
        required: ["message"],
      },
    },
  };