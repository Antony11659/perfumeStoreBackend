export const addressSuggestionsSchema = {
    tags: ["Website Delivery"],
  
    summary: "Suggest delivery addresses",
  
    description:
      "Returns address suggestions for the La De Parfum website checkout.",
  
    querystring: {
      type: "object",
  
      required: [
        "query",
      ],
  
      additionalProperties: false,
  
      properties: {
        query: {
          type: "string",
          minLength: 2,
          maxLength: 200,
        },
      },
    },
  
    response: {
      200: {
        type: "object",
  
        properties: {
          success: {
            type: "boolean",
          },
  
          suggestions: {
            type: "array",
  
            items: {
              type: "object",
  
              properties: {
                address: {
                  type: ["string", "null"],
                },
  
                city: {
                  type: ["string", "null"],
                },
  
                street: {
                  type: ["string", "null"],
                },
  
                house: {
                  type: ["string", "null"],
                },
  
                latitude: {
                  type: ["number", "null"],
                },
  
                longitude: {
                  type: ["number", "null"],
                },
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
  
  
  export const checkDeliveryClientSchema = {
    tags: ["Website Delivery"],
  
    summary: "Check Ozon Delivery customer",
  
    description:
      "Checks whether Ozon Delivery is available for the customer's phone number.",
  
    body: {
      type: "object",
  
      required: [
        "phone",
      ],
  
      additionalProperties: false,
  
      properties: {
        phone: {
          type: "string",
          minLength: 1,
        },
      },
    },
  
    response: {
      200: {
        type: "object",
  
        properties: {
          success: {
            type: "boolean",
          },
  
          canBeDelivered: {
            type: "boolean",
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
  
  
  export const verifyDeliveryPointSchema = {
    tags: ["Website Delivery"],
  
    summary: "Verify Ozon pickup point",
  
    description:
      "Checks whether an active Ozon pickup point exists near the selected address coordinates.",
  
    body: {
      type: "object",
  
      required: [
        "latitude",
        "longitude",
      ],
  
      additionalProperties: false,
  
      properties: {
        latitude: {
          type: "number",
          minimum: -90,
          maximum: 90,
        },
  
        longitude: {
          type: "number",
          minimum: -180,
          maximum: 180,
        },
      },
    },
  
    response: {
      200: {
        type: "object",
  
        properties: {
          success: {
            type: "boolean",
          },
  
          found: {
            type: "boolean",
          },
  
          point: {
            anyOf: [
              {
                type: "object",
  
                properties: {
                  deliveryPointId: {
                    type: "integer",
                  },
  
                  name: {
                    type: ["string", "null"],
                  },
  
                  address: {
                    type: ["string", "null"],
                  },
  
                  type: {
                    type: ["string", "null"],
                  },
  
                  latitude: {
                    type: "number",
                  },
  
                  longitude: {
                    type: "number",
                  },
  
                  distanceMeters: {
                    type: "integer",
                  },
  
                  storagePeriodDays: {
                    type: ["integer", "null"],
                  },
                },
              },
  
              {
                type: "null",
              },
            ],
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
  
  
  export const deliveryCheckoutSchema = {
    tags: ["Website Delivery"],
  
    summary: "Calculate Ozon delivery",
  
    description:
      "Checks parcel availability for the selected Ozon pickup point and calculates delivery conditions.",
  
    body: {
      type: "object",
  
      required: [
        "phone",
        "deliveryPointId",
        "declaredValue",
      ],
  
      additionalProperties: false,
  
      properties: {
        phone: {
          type: "string",
          minLength: 1,
        },
  
        deliveryPointId: {
          type: "integer",
          minimum: 1,
        },
  
        declaredValue: {
          type: "number",
          exclusiveMinimum: 0,
        },
      },
    },
  
    response: {
      200: {
        type: "object",
  
        properties: {
          success: {
            type: "boolean",
          },
  
          available: {
            type: "boolean",
          },
  
          delivery: {
            anyOf: [
              {
                type: "object",
  
                properties: {
                  deliveryCost: {
                    type: "number",
                  },
  
                  insuranceCost: {
                    type: "number",
                  },
  
                  estimatedDeliveryDays: {
                    type: ["integer", "null"],
                  },
  
                  cutoffAt: {
                    type: ["string", "null"],
                  },
  
                  customerDeliveryPrice: {
                    type: "number",
                  },
                },
              },
  
              {
                type: "null",
              },
            ],
          },
  
          error: {
            type: ["object", "null"],
            additionalProperties: true,
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