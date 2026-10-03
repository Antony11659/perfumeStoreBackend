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