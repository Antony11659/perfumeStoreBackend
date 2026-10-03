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

export const createPerfumeSchema = {
  tags: ["Perfumes"],

  summary: "Create perfume",

  description:
    "Creates a new perfume and its standard 1, 3, 5, 10, 20, 30 and 50 ml variants.",

  body: {
    type: "object",
    additionalProperties: false,

    properties: {
      name: {
        type: "string",
        minLength: 1,
      },

      brand_id: {
        type: "string",
        format: "uuid",
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

    required: [
      "name",
      "brand_id",
      "gender",
    ],
  },

  response: {
    201: {
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
        "brand",
        "variants",
        "images",
      ],
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

    409: {
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

export const getPerfumeShopProductsSchema = {
  tags: ["Perfumes"],

  summary: "Get marketplace SKUs for perfume",

  params: {
    type: "object",
    additionalProperties: false,

    properties: {
      id: {
        type: "integer",
        minimum: 1,
      },
    },

    required: ["id"],
  },

  response: {
    200: {
      type: "array",

      items: {
        type: "object",
        additionalProperties: false,

        properties: {
          id: {
            type: "string",
            format: "uuid",
          },

          volume_ml: {
            type: "integer",
          },

          sku: {
            type: "string",
          },

          is_active: {
            type: "boolean",
          },

          is_archived: {
            type: "boolean",
          },

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
        },

        required: [
          "id",
          "volume_ml",
          "sku",
          "is_active",
          "is_archived",
          "shop",
        ],
      },
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

export const createPerfumeShopProductSchema = {
  tags: ["Perfumes"],

  summary: "Add marketplace SKU to perfume",

  params: {
    type: "object",
    additionalProperties: false,

    properties: {
      id: {
        type: "integer",
        minimum: 1,
      },
    },

    required: ["id"],
  },

  body: {
    type: "object",
    additionalProperties: false,

    properties: {
      shop_id: {
        type: "string",
        format: "uuid",
      },

      volume_ml: {
        type: "integer",
        minimum: 1,
      },

      sku: {
        type: "string",
        minLength: 1,
      },
    },

    required: [
      "shop_id",
      "volume_ml",
      "sku",
    ],
  },

  response: {
    201: {
      type: "object",
      additionalProperties: false,

      properties: {
        id: {
          type: "string",
          format: "uuid",
        },

        perfume_id: {
          type: "integer",
        },

        volume_ml: {
          type: "integer",
        },

        sku: {
          type: "string",
        },

        is_active: {
          type: "boolean",
        },

        is_archived: {
          type: "boolean",
        },

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
      },

      required: [
        "id",
        "perfume_id",
        "volume_ml",
        "sku",
        "is_active",
        "is_archived",
        "shop",
      ],
    },

    400: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    },

    404: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    },

    409: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    },

    500: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    },
  },
};