export const getPerfumesSchema = {
  tags: ["Perfumes"],
  summary: "Get all perfumes",
  description: "Returns all perfumes in the catalogue",
  response: {
    200: {
      description: "Perfumes retrieved successfully",
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          gender: {
            type: "string",
            enum: ["M", "W", "U"],
          },
          fragrance_family: {
            anyOf: [{ type: "string" }, { type: "null" }],
          },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
          brand: {
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
            },
            required: ["id", "name", "country"],
          },
        },
        required: [
          "id",
          "name",
          "gender",
          "fragrance_family",
          "created_at",
          "updated_at",
          "brand",
        ],
      },
    },
    500: {
      description: "Database error",
      type: "object",
      additionalProperties: false,
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    },
  },
};


export const getPerfumeByIdSchema = {
  tags: ["Perfumes"],
  summary: "Get one perfume",
  description: "Returns one perfume by its ID",

  params: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: {
        type: "integer",
        minimum: 1,
        description: "Perfume ID",
      },
    },
    required: ["id"],
  },
  response: {
    200: getPerfumesSchema.response[200].items,
    400: {
      ...getPerfumesSchema.response[500],
      description: "Invalid perfume ID",
    },
    404: {
      ...getPerfumesSchema.response[500],
      description: "Perfume not found",
    },
    500: {
      ...getPerfumesSchema.response[500],
      description: "Database error",
    },
  },
};
