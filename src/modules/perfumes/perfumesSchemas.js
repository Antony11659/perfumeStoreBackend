const errorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string" },
  },
  required: ["message"],
};


const brandSchema = {
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
};


const variantSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "integer",
    },
    volume_ml: {
      type: "integer",
      minimum: 1,
    },
  },
  required: ["id", "volume_ml"],
};


const imageSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "integer",
    },
    image_url: {
      type: "string",
    },
    sort_order: {
      type: "integer",
    },
    is_primary: {
      type: "boolean",
    },
  },
  required: [
    "id",
    "image_url",
    "sort_order",
    "is_primary",
  ],
};


const shopSchema = {
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
};


const shopProductSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      format: "uuid",
    },
    sku: {
      type: "string",
    },
    volume_ml: {
      type: "integer",
      minimum: 1,
    },
    is_active: {
      type: "boolean",
    },
    is_archived: {
      type: "boolean",
    },
    shop: shopSchema,
  },
  required: [
    "id",
    "sku",
    "volume_ml",
    "is_active",
    "is_archived",
    "shop",
  ],
};


const perfumeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "integer",
    },
    name: {
      type: "string",
    },
    gender: {
      type: "string",
      enum: ["M", "W", "U"],
    },
    fragrance_family: {
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

    brand: brandSchema,

    variants: {
      type: "array",
      items: variantSchema,
    },

    images: {
      type: "array",
      items: imageSchema,
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
    "variants",
    "images",
  ],
};


const perfumeDetailsSchema = {
  ...perfumeSchema,

  properties: {
    ...perfumeSchema.properties,

    shop_products: {
      type: "array",
      items: shopProductSchema,
    },
  },

  required: [
    ...perfumeSchema.required,
    "shop_products",
  ],
};


export const getPerfumesSchema = {
  tags: ["Perfumes"],

  summary: "Get all perfumes",

  description:
    "Returns the complete canonical perfume catalogue with brand information, volume variants and website images.",

  response: {
    200: {
      description: "Perfumes retrieved successfully",
      type: "array",
      items: perfumeSchema,
    },

    500: {
      ...errorSchema,
      description: "Database error",
    },
  },
};



export const getPerfumeByIdSchema = {
  tags: ["Perfumes"],

  summary: "Get one perfume",

  description:
    "Returns one perfume by ID with brand information, volume variants, website images and all marketplace SKU mappings.",

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
    200: {
      description: "Perfume retrieved successfully",
      ...perfumeDetailsSchema,
    },

    400: {
      ...errorSchema,
      description: "Invalid perfume ID",
    },

    404: {
      ...errorSchema,
      description: "Perfume not found",
    },

    500: {
      ...errorSchema,
      description: "Database error",
    },
  },
};


export const updatePerfumeSchema = {
  tags: ["Perfumes"],

  summary: "Update perfume",

  description:
    "Updates the basic information of an existing perfume.",

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

  body: {
    type: "object",
    additionalProperties: false,

    properties: {
      name: {
        type: "string",
        minLength: 1,
      },

      gender: {
        type: "string",
        enum: ["M", "W", "U"],
      },

      fragrance_family: {
        anyOf: [
          { type: "string" },
          { type: "null" },
        ],
      },
    },

    minProperties: 1,
  },

  response: {
    200: {
      description: "Perfume updated successfully",

      type: "object",
      additionalProperties: false,

      properties: {
        id: {
          type: "integer",
        },

        name: {
          type: "string",
        },

        gender: {
          type: "string",
          enum: ["M", "W", "U"],
        },

        fragrance_family: {
          anyOf: [
            { type: "string" },
            { type: "null" },
          ],
        },

        updated_at: {
          type: "string",
          format: "date-time",
        },
      },

      required: [
        "id",
        "name",
        "gender",
        "fragrance_family",
        "updated_at",
      ],
    },

    400: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: {
          type: "string",
        },
      },
      required: ["message"],
    },

    404: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: {
          type: "string",
        },
      },
      required: ["message"],
    },

    500: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: {
          type: "string",
        },
      },
      required: ["message"],
    },
  },
};