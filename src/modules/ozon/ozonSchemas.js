const errorSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      error: {
        type: "string",
      },
    },
    required: ["error"],
  };
  
  
  const packagingProductSchema = {
    type: "object",
    additionalProperties: false,
  
    properties: {
      sku: {
        type: "string",
      },
  
      name: {
        anyOf: [
          { type: "string" },
          { type: "null" },
        ],
      },
  
      volume: {
        anyOf: [
          { type: "integer" },
          { type: "null" },
        ],
      },
  
      quantity: {
        type: "integer",
        minimum: 1,
      },
  
      unknown: {
        type: "boolean",
      },
    },
  
    required: [
      "sku",
      "name",
      "volume",
      "quantity",
      "unknown",
    ],
  };
  
  
  const packagingOrderSchema = {
    type: "object",
    additionalProperties: false,
  
    properties: {
      ii: {
        type: "string",
      },
  
      orderNumber: {
        type: "string",
      },
  
      displayedNum: {
        type: "string",
      },
  
      products: {
        type: "array",
        items: packagingProductSchema,
      },
  
      shop: {
        type: "string",
      },
    },
  
    required: [
      "ii",
      "orderNumber",
      "displayedNum",
      "products",
      "shop",
    ],
  };
  
  
  const packagingPageSchema = {
    type: "object",
    additionalProperties: false,
  
    properties: {
      startIndex: {
        type: "integer",
        minimum: 0,
      },
  
      nextIndex: {
        type: "integer",
        minimum: 0,
      },
  
      limit: {
        type: "integer",
        minimum: 1,
      },
  
      hasNext: {
        type: "boolean",
      },
  
      totalOrders: {
        type: "integer",
        minimum: 0,
      },
  
      orders: {
        type: "array",
        items: packagingOrderSchema,
      },
    },
  
    required: [
      "startIndex",
      "nextIndex",
      "limit",
      "hasNext",
      "totalOrders",
      "orders",
    ],
  };
  
  
  const rawOzonOrderSchema = {
    type: "object",
  
    // Ozon can add/change fields in its raw response,
    // so we only strictly describe fields our application cares about.
    additionalProperties: true,
  
    properties: {
      scanit: {
        type: "string",
        description: "Ozon II/ScanIt identifier used during packaging.",
      },
  
      status: {
        type: "string",
      },
  
      substatus: {
        type: "string",
      },
  
      order_id: {
        type: "integer",
      },
  
      order_number: {
        type: "string",
      },
  
      posting_number: {
        type: "string",
      },
  
      in_process_at: {
        type: "string",
        format: "date-time",
      },
  
      shipment_date: {
        type: "string",
        format: "date-time",
      },
  
      products: {
        type: "array",
        description: "Raw products returned by Ozon.",
      },
  
      barcodes: {
        type: "object",
        additionalProperties: true,
  
        properties: {
          lower_barcode: {
            type: "string",
          },
  
          upper_barcode: {
            type: "string",
          },
        },
      },
  
      delivery_schema: {
        type: "string",
      },
  
      tpl_integration_type: {
        type: "string",
      },
  
      is_multibox: {
        type: "boolean",
      },
  
      multi_box_qty: {
        type: "integer",
        minimum: 0,
      },
    },
  
    required: [
      "status",
      "order_id",
      "order_number",
      "posting_number",
      "products",
    ],
  };
  
  
  const ozonShopSessionSchema = {
    type: "object",
    additionalProperties: false,
  
    properties: {
      shop: {
        type: "string",
        description: "Internal shop code.",
      },
  
      orders: {
        type: "array",
        items: rawOzonOrderSchema,
      },
    },
  
    required: [
      "shop",
      "orders",
    ],
  };
  
  
  const ozonSessionSchema = {
    type: "object",
    additionalProperties: false,
  
    properties: {
      id: {
        type: "integer",
      },
  
      updated_at: {
        type: "string",
        format: "date-time",
      },
  
      shops: {
        type: "array",
        items: ozonShopSessionSchema,
      },
    },
  
    required: [
      "id",
      "updated_at",
      "shops",
    ],
  };
  
  
  export const createOzonSessionSchema = {
    tags: ["Ozon"],
  
    summary: "Create Ozon session",
  
    description:
      "Loads current orders from all configured Ozon shops, creates a unified processing session and saves it.",
  
    response: {
      201: {
        description: "Ozon session created successfully",
        ...ozonSessionSchema,
      },
  
      500: {
        ...errorSchema,
        description: "Failed to create Ozon session",
      },
    },
  };
  
  
  export const getOzonSessionSchema = {
    tags: ["Ozon"],
  
    summary: "Get current Ozon session",
  
    description:
      "Returns the currently saved unified Ozon processing session containing raw orders grouped by shop.",
  
    response: {
      200: {
        description: "Ozon session retrieved successfully",
        ...ozonSessionSchema,
      },
  
      500: {
        ...errorSchema,
        description: "Failed to load Ozon session",
      },
    },
  };
  
  
  export const getPrintStickingLabelsSchema = {
    tags: ["Ozon"],

    summary: "Get sticking labels",

    description:
  "Returns the printer-ready sticking label sequence for the current saved Ozon session. Perfumes with total quantity greater than one are returned first, sorted by total quantity descending. Single-bottle perfumes are grouped by volume and emitted as unique-volume print blocks. Each unique block starts with an empty-name separator label, followed by an 'ОДИНОЧНЫЕ {volume} МЛ' header and the perfume labels. A final empty-name separator closes the last unique block. Unknown products are excluded from labels and returned separately, aggregated by shop and SKU.",

    response: {
      200: {
        description: "Printable sticking labels retrieved successfully",
        type: "object",
        additionalProperties: false,
        properties: {
          labels: {
            type: "array",
            description:
            "Printer-ready label sequence. An empty name is a separator used by the local printer service to delimit unique-volume print jobs.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: {
                  type: "string",
                },
                quantity: {
                  type: "integer",
                  minimum: 1,
                },
              },
              required: ["name", "quantity"],
            },
          },
          unknownProducts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                sku: {
                  type: "string",
                },
                offer_id: {
                  type: "string",
                },
                quantity: {
                  type: "integer",
                  minimum: 1,
                },
                shop: {
                  type: "string",
                },
              },
              required: ["sku", "offer_id", "quantity", "shop"],
            },
          },
        },
        required: ["labels", "unknownProducts"],
      },

      500: {
        ...errorSchema,
        description: "Failed to load sticking labels",
      },
    },
  };


  export const getStickingSchema = {
    tags: ["Ozon"],
    summary: "Get sticking plan",
    description:
      "Uses the existing saved Ozon session and batch Supabase SKU resolution without fetching Ozon orders or creating a session. Regular perfumes have total quantity greater than one and follow the print-label order (total descending). Single bottles are grouped by volume in unique. Unknown products are excluded and aggregated by shop and SKU.",
    response: {
      200: {
        description: "Sticking plan retrieved successfully",
        type: "object",
        additionalProperties: false,
        properties: {
          updatedAt: {
            type: "string",
            format: "date-time",
            description: "The saved session's updated_at timestamp.",
          },
          regular: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                bottles: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      volume: { type: "number" },
                      quantity: { type: "integer", minimum: 1 },
                    },
                    required: ["volume", "quantity"],
                  },
                },
                total: { type: "integer", minimum: 2 },
              },
              required: ["name", "bottles", "total"],
            },
          },
          unique: {
            type: "object",
            description: "Canonical perfume names grouped by volume in ml.",
            additionalProperties: {
              type: "array",
              items: { type: "string" },
            },
          },
          unknownProducts: getPrintStickingLabelsSchema.response[200].properties.unknownProducts,
        },
        required: ["updatedAt", "regular", "unique", "unknownProducts"],
      },
      500: {
        ...errorSchema,
        description: "Failed to load the saved session or prepare the sticking plan",
      },
    },
  };


  export const getPackagingSchema = {
    tags: ["Ozon"],
  
    summary: "Get packaging orders",
  
    description:
      "Transforms orders from the current Ozon session into the application's packaging format and returns a paginated page.",
  
    querystring: {
      type: "object",
      additionalProperties: false,
  
      properties: {
        startNum: {
          type: "string",
          description:
            "Displayed order number used to find the starting order.",
        },
  
        startIndex: {
          type: "integer",
          minimum: 0,
          description:
            "Zero-based index from which packaging should continue.",
        },
  
        limit: {
          type: "integer",
          minimum: 1,
          description:
            "Maximum number of orders to return.",
        },
      },
    },
  
    response: {
      200: {
        description: "Packaging orders retrieved successfully",
        ...packagingPageSchema,
      },
  
      404: {
        ...errorSchema,
        description: "Order not found",
      },
  
      500: {
        ...errorSchema,
        description: "Failed to load packaging orders",
      },
    },
  };
