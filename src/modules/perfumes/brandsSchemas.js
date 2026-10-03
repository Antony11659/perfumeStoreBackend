export const brandSchema = {
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
  
      country: {
        anyOf: [
          { type: "string" },
          { type: "null" },
        ],
      },
  
      created_at: {
        type: "string",
        format: "date-time",
      },
  
      updated_at: {
        type: "string",
        format: "date-time",
      },
    },
  
    required: [
      "id",
      "name",
      "country",
      "created_at",
      "updated_at",
    ],
  };
  
  
  export const getBrandsSchema = {
    tags: ["Brands"],
  
    summary: "Get all brands",
  
    response: {
      200: {
        type: "array",
        items: brandSchema,
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
  
  
  export const createBrandSchema = {
    tags: ["Brands"],
  
    summary: "Create brand",
  
    body: {
      type: "object",
      additionalProperties: false,
  
      properties: {
        name: {
          type: "string",
          minLength: 1,
        },
  
        country: {
          anyOf: [
            { type: "string" },
            { type: "null" },
          ],
        },
      },
  
      required: ["name"],
    },
  
    response: {
      201: brandSchema,
  
      400: {
        type: "object",
        properties: {
          message: {
            type: "string",
          },
        },
      },
  
      409: {
        type: "object",
        properties: {
          message: {
            type: "string",
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

  