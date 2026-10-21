import crypto from "node:crypto";


function getOzonPayCredentials() {

  const accessKey =
    process.env.OZON_PAY_ACCESS_KEY;

  const secretKey =
    process.env.OZON_PAY_SECRET_KEY;


  if (!accessKey) {
    throw new Error(
      "OZON_PAY_ACCESS_KEY is missing"
    );
  }


  if (!secretKey) {
    throw new Error(
      "OZON_PAY_SECRET_KEY is missing"
    );
  }


  return {
    accessKey,
    secretKey,
  };

}


export function createOzonPayCreateOrderSign({
  expiresAt = "",
  extId,
  fiscalizationType = "",
  paymentAlgorithm,
  currencyCode,
  amountValue,
}) {

  const {
    accessKey,
    secretKey,
  } = getOzonPayCredentials();


  const fingerprint =
    `${accessKey}` +
    `${expiresAt}` +
    `${extId}` +
    `${fiscalizationType}` +
    `${paymentAlgorithm}` +
    `${currencyCode}` +
    `${amountValue}` +
    `${secretKey}`;


  return crypto
    .createHash("sha256")
    .update(
      fingerprint,
      "utf8"
    )
    .digest("hex");

}

export async function createOzonPayOrder({
    extId,
    amountValue,
  }) {
  
    const {
      accessKey,
    } = getOzonPayCredentials();
  
  
    const expiresAt =
      new Date(
        Date.now() +
        30 * 60 * 1000
      ).toISOString();
  
  
    const fiscalizationType =
      "FISCAL_TYPE_SINGLE";
  
  
    const paymentAlgorithm =
      "PAY_ALGO_SMS";
  
  
    const currencyCode =
      "643";
  
  
    const requestSign =
      createOzonPayCreateOrderSign({
        expiresAt,
        extId,
        fiscalizationType,
        paymentAlgorithm,
        currencyCode,
        amountValue,
      });
  
  
    const payload = {
  
      accessKey,
  
      amount: {
        currencyCode,
        value:
          String(amountValue),
      },
  
      expiresAt,
  
      extId,
  
      fiscalizationType,
  
      paymentAlgorithm,
  
      mode:
        "MODE_SHORTENED",
  
      enableFiscalization:
        false,
  
      successUrl:
        "https://ladeparfume.ru/payment-success",
  
      failUrl:
        "https://ladeparfume.ru/payment-failed",
  
      requestSign,
  
    };
  
  
    const response =
      await fetch(
        "https://payapi.ozon.ru/v1/createOrder",
        {
          method: "POST",
  
          headers: {
            "Content-Type":
              "application/json",
          },
  
          body:
            JSON.stringify(
              payload
            ),
        }
      );
  
  
    let data = null;
  
  
    try {
  
      data =
        await response.json();
  
    } catch {
  
      data = null;
  
    }
  
  
    if (!response.ok) {
  
      console.error(
        "Ozon Pay createOrder error:",
        data
      );
  
  
      throw new Error(
        data?.message ||
        "Failed to create Ozon Pay order"
      );
  
    }
  
  
    return data;
  
  }

  // --------------------------------------------------
// Ozon Pay: get order status signature
// --------------------------------------------------

export function createOzonPayGetOrderStatusSign({
    id,
    extId = "",
  }) {
  
    const {
      accessKey,
      secretKey,
    } = getOzonPayCredentials();
  
  
    const fingerprint =
      `${id}` +
      `${extId}` +
      `${accessKey}` +
      `${secretKey}`;
  
  
    return crypto
      .createHash("sha256")
      .update(
        fingerprint,
        "utf8"
      )
      .digest("hex");
  
  }
  
  
  // --------------------------------------------------
  // Ozon Pay: get order status
  // --------------------------------------------------
  
  export async function getOzonPayOrderStatus({
    id,
  }) {
  
    const {
      accessKey,
    } = getOzonPayCredentials();
  
  
    const requestSign =
      createOzonPayGetOrderStatusSign({
        id,
      });
  
  
    const response =
      await fetch(
        "https://payapi.ozon.ru/v1/getOrderStatus",
        {
          method: "POST",
  
          headers: {
            "Content-Type":
              "application/json",
          },
  
          body:
            JSON.stringify({
              accessKey,
              id,
              requestSign,
            }),
        }
      );
  
  
    let data = null;
  
  
    try {
  
      data =
        await response.json();
  
    } catch {
  
      data = null;
  
    }
  
  
    if (!response.ok) {
  
      console.error(
        "Ozon Pay getOrderStatus error:",
        data
      );
  
  
      throw new Error(
        data?.message ||
        "Failed to get Ozon Pay order status"
      );
  
    }
  
  
    return data;
  
  }

  // --------------------------------------------------
// Ozon Pay: notification signature
// --------------------------------------------------

export function createOzonPayNotificationSign(
    notification
  ) {
  
    const notificationSecretKey =
      process.env
        .OZON_PAY_NOTIFICATION_SECRET_KEY;
  
  
    if (!notificationSecretKey) {
  
      throw new Error(
        "OZON_PAY_NOTIFICATION_SECRET_KEY is missing"
      );
  
    }
  
  
    const {
      orderID,
      transactionID,
      transactionUID,
      extOrderID,
      amount,
      currencyCode,
    } = notification;
  
  
    /*
      Ozon documentation:
  
      SHA256(
        accessKey |
        orderID |
        transactionID or transactionUID |
        extOrderID |
        amount |
        currencyCode |
        notificationSecretKey
      )
    */
  
  
    const {
      accessKey,
    } = getOzonPayCredentials();
  
  
    const transactionIdentifier =
      transactionID != null
        ? transactionID
        : transactionUID;
  
  
    const fingerprint =
      `${accessKey}|` +
      `${orderID || ""}|` +
      `${transactionIdentifier || ""}|` +
      `${extOrderID || ""}|` +
      `${amount}|` +
      `${currencyCode}|` +
      `${notificationSecretKey}`;
  
  
    return crypto
      .createHash("sha256")
      .update(
        fingerprint,
        "utf8"
      )
      .digest("hex");
  
  }
  
  
  export function verifyOzonPayNotification(
    notification
  ) {
  
    const receivedSign =
      notification?.requestSign;
  
  
    if (!receivedSign) {
  
      return false;
  
    }
  
  
    const expectedSign =
      createOzonPayNotificationSign(
        notification
      );
  
  
    const receivedBuffer =
      Buffer.from(
        receivedSign,
        "utf8"
      );
  
  
    const expectedBuffer =
      Buffer.from(
        expectedSign,
        "utf8"
      );
  
  
    if (
      receivedBuffer.length !==
      expectedBuffer.length
    ) {
  
      return false;
  
    }
  
  
    return crypto.timingSafeEqual(
      receivedBuffer,
      expectedBuffer
    );
  
  }