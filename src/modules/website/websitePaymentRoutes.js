import {
    verifyOzonPayNotification,
  } from "../payment/ozon/ozonPayService.js";
  
  
  export default async function websitePaymentRoutes(
    fastify
  ) {
  
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
  
          For this FIRST test we intentionally
          do not update Supabase yet.
  
          We only want to prove that Ozon can
          automatically reach this endpoint.
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
          4. Tell Ozon we received it.
        */
  
        return reply
          .code(200)
          .send({
            success: true,
          });
  
      }
    );
  
  }