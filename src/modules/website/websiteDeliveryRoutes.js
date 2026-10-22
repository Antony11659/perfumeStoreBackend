import {
    addressSuggestionsSchema,
    checkDeliveryClientSchema,
    verifyDeliveryPointSchema,
    deliveryCheckoutSchema,
  } from "./websiteDeliverySchemas.js";
  
  import {
    suggestAddress,
  } from "../delivery/dadata/dadataService.js";
  
  import {
    checkOzonDeliveryClient,
    findOzonDeliveryPointAtLocation,
    checkOzonDeliveryPointAvailability,
    checkoutOzonDelivery,
  } from "../delivery/ozon/ozonDeliveryService.js";
  
  
  export default async function websiteDeliveryRoutes(
    fastify
  ) {
  
    // --------------------------------------------------
    // Address autocomplete
    // --------------------------------------------------
  
    fastify.get(
      "/address-suggestions",
      {
        schema:
          addressSuggestionsSchema,
      },
      async (request, reply) => {
  
        try {
  
          const {
            query,
          } = request.query;
  
  
          const suggestions =
            await suggestAddress(
              query,
              {
                count: 5,
              }
            );
  
  
          return {
            success: true,
            suggestions,
          };
  
        } catch (error) {
  
          request.log.error(
            error
          );
  
  
          return reply
            .code(500)
            .send({
              success: false,
              message:
                "Failed to load address suggestions",
            });
        }
      }
    );
  
  
    // --------------------------------------------------
    // Check customer
    // --------------------------------------------------
  
    fastify.post(
      "/check-client",
      {
        schema:
          checkDeliveryClientSchema,
      },
      async (request, reply) => {
  
        try {
  
          const {
            phone,
          } = request.body;
  
  
          const result =
            await checkOzonDeliveryClient(
              phone
            );
  
  
          return {
            success: true,
  
            canBeDelivered:
              result.canBeDelivered,
          };
  
        } catch (error) {
  
          request.log.error(
            error
          );
  
  
          const statusCode =
            error.statusCode ||
            500;
  
  
          return reply
            .code(statusCode)
            .send({
              success: false,
  
              message:
                statusCode === 500
                  ? "Failed to check Ozon Delivery customer"
                  : error.message,
            });
        }
      }
    );
  
  
    // --------------------------------------------------
    // Verify selected Ozon PVZ
    // --------------------------------------------------
  
    fastify.post(
      "/verify-pvz",
      {
        schema:
          verifyDeliveryPointSchema,
      },
      async (request, reply) => {
  
        try {
  
          const {
            latitude,
            longitude,
          } = request.body;
  
  
          const point =
            await findOzonDeliveryPointAtLocation(
              latitude,
              longitude
            );
  
  
          return {
            success: true,
  
            found:
              Boolean(point),
  
            point:
              point || null,
          };
  
        } catch (error) {
  
          request.log.error(
            {
              message: error?.message,
              cause: error?.cause,
              stack: error?.stack,
            },
            "VERIFY PVZ FAILED"
          );
  
  
          return reply
            .code(500)
            .send({
              success: false,
  
              message:
                "Failed to verify Ozon pickup point",
            });
        }
      }
    );
  
  
    // --------------------------------------------------
    // Calculate delivery
    // --------------------------------------------------
  
    fastify.post(
      "/checkout",
      {
        schema:
          deliveryCheckoutSchema,
      },
      async (request, reply) => {
  
        try {
  
          const {
            phone,
            deliveryPointId,
            declaredValue,
          } = request.body;
  
  
          // First make sure this parcel can be
          // delivered to the selected Ozon PVZ.
  
          const availability =
            await checkOzonDeliveryPointAvailability({
              deliveryPointId,
              declaredValue,
            });
  
  
          if (
            !availability.available
          ) {
            return {
              success: true,
  
              available: false,
  
              delivery: null,
  
              error:
                availability.error ||
                null,
            };
          }
  
  
          // TEMPORARY MVP RULE:
          //
          // We currently assume that La De Parfum
          // will hand the parcel to Ozon approximately
          // 24 hours from now.
          //
          // Later this should be replaced with our
          // real production / drop-off schedule.
  
          const cutoffAt =
            new Date(
              Date.now() +
              24 * 60 * 60 * 1000
            ).toISOString();
  
  
          const checkout =
            await checkoutOzonDelivery({
              phone,
              deliveryPointId,
              declaredValue,
              cutoffAt,
            });
  
  
          if (
            !checkout.available
          ) {
            return {
              success: true,
  
              available: false,
  
              delivery: null,
  
              error:
                checkout.error ||
                null,
            };
          }
  
  
          return {
            success: true,
  
            available: true,
  
            delivery: {
              deliveryCost:
                checkout.deliveryCost,
  
              insuranceCost:
                checkout.insuranceCost,
  
              estimatedDeliveryDays:
                checkout.estimatedDeliveryDays,
  
              cutoffAt:
                checkout.cutoffAt,
  
              // Delivery is free for the customer
              // in the current La De Parfum model.
              customerDeliveryPrice:
                0,
            },
  
            error:
              null,
          };
  
        } catch (error) {
  
          request.log.error(
            error
          );
  
  
          const statusCode =
            error.statusCode ||
            500;
  
  
          return reply
            .code(statusCode)
            .send({
              success: false,
  
              message:
                statusCode === 500
                  ? "Failed to calculate Ozon delivery"
                  : error.message,
            });
        }
      }
    );
  
  }