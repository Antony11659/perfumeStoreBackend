export const getPricesSchema = {
    tags: ["Pricing"],
    summary: "Get prices by volume",
    description:
      "Returns website, discount and wholesale prices for each perfume volume.",
  
    response: {
      200: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: {
              type: "integer",
            },
            volume_ml: {
              type: "integer",
            },
            website_price: {
              type: ["number", "null"],
            },
            discount_price: {
              type: ["number", "null"],
            },
            wholesale_price: {
              type: ["number", "null"],
            },
            created_at: {
              type: "string",
            },
            updated_at: {
              type: "string",
            },
          },
        },
      },
  
      500: {
        type: "object",
        properties: {
          message: {
            type: "string",
          },
        },
      },
    },
  };