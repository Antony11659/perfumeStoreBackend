import {
    verifyOzonPayNotification,
  } from "../payment/ozon/ozonPayService.js";

import {
  createWebsiteOrderPayment,
  markWebsiteOrderPaidFromOzon,
  } from "./websiteOrdersService.js";
  
  
  export default async function websitePaymentRoutes(
    fastify
  ) {

      // --------------------------------------------------
  // Create Ozon Pay payment for website order
  // --------------------------------------------------

  fastify.post(
    "/website/orders/:orderId/payment",
    async function (
      request,
      reply
    ) {

      const orderId =
        Number(
          request.params.orderId
        );


      if (
        !Number.isInteger(orderId) ||
        orderId < 1
      ) {

        return reply
          .code(400)
          .send({
            success: false,
            message:
              "Invalid website order ID",
          });

      }


      try {

        const payment =
          await createWebsiteOrderPayment(
            orderId
          );


        return reply
          .code(200)
          .send({
            success: true,
            payment,
          });


      } catch (error) {

        request.log.error(
          {
            errorMessage:
              error?.message,

            orderId,
          },
          "Failed to create website order payment"
        );


        return reply
          .code(
            error?.statusCode ||
            500
          )
          .send({
            success: false,

            message:
              error?.message ||
              "Failed to create payment",
          });

      }

    }
  );
  
    /*
      Ozon Pay sends this request automatically
      after a payment attempt.
  
      IMPORTANT:
      This route does NOT trust the incoming JSON
      until requestSign has been verified.
    */
  
    fastify.post(
      "/website/payments/ozon/notification",
      async function (
        request,
        reply
      ) {
  
        const notification =
          request.body;
  
  
        /*
          1. Verify that this notification
          really came from Ozon Pay.
        */
  
        let isValid = false;
  
  
        try {
  
          isValid =
            verifyOzonPayNotification(
              notification
            );
  
        } catch (error) {
  
          request.log.error(
            error,
            "Failed to verify Ozon Pay notification"
          );
  
  
          return reply
            .code(500)
            .send({
              success: false,
            });
  
        }
  
  
        /*
          2. Reject fake / invalid notifications.
        */
  
        if (!isValid) {
  
          request.log.warn(
            {
              orderID:
                notification?.orderID,
  
              extOrderID:
                notification?.extOrderID,
            },
            "Invalid Ozon Pay notification signature"
          );
  
  
          return reply
            .code(401)
            .send({
              success: false,
            });
  
        }
  
  
      /*
        3. Signature is valid.

        Now connect the verified Ozon payment
        to our website order.
      */

        request.log.info(
          {
            orderID:
              notification.orderID,
  
            extOrderID:
              notification.extOrderID,
  
            transactionUID:
              notification.transactionUID,
  
            amount:
              notification.amount,
  
            currencyCode:
              notification.currencyCode,
  
            status:
              notification.status,
  
            operationType:
              notification.operationType,
  
            paymentMethod:
              notification.paymentMethod,
  
            testMode:
              notification.testMode,
          },
          "VALID OZON PAY NOTIFICATION"
        );
  
  
        /*
          4. Update our website order.
  
          This function independently checks:
          - Completed payment
          - Payment operation
          - RUB currency
          - website order exists
          - amount exactly matches order total
        */
  
        try {
  
          const result =
            await markWebsiteOrderPaidFromOzon(
              notification
            );
  
  
          request.log.info(
            {
              paymentResult:
                result,
            },
            "OZON PAY NOTIFICATION PROCESSED"
          );
  
  
        } catch (error) {
  
          request.log.error(
            {
              errorMessage:
                error?.message,
  
              extOrderID:
                notification?.extOrderID,
            },
            "Failed to process Ozon Pay notification"
          );
  
  
          return reply
            .code(
              error?.statusCode ||
              500
            )
            .send({
              success: false,
            });
  
        }
  
  
        /*
          5. Tell Ozon that the notification
          was successfully processed.
        */
  
        return reply
          .code(200)
          .send({
            success: true,
          });
  
      }
    );
  
  }