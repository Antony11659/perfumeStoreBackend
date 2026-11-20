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
    receipt,
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
      receipt ? "FISCAL_TYPE_DOUBLE" : "FISCAL_TYPE_SINGLE";
  
  
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
        receipt ? "MODE_FULL" : "MODE_SHORTENED",
  
      enableFiscalization:
        Boolean(receipt),
      ...(receipt && { fiscalizationPhone: receipt.phone, items: receipt.items }),
  
      successUrl:
        "https://ladeparfume.ru/payment-success",
  
      failUrl:
        "https://ladeparfume.ru/payment-failed",
  
      requestSign,
  
    };
  
  
    const signal = AbortSignal.timeout(5000);
    const unavailable = (code, status) => {
      console.error("Ozon Pay createOrder failed", { code, ...(status === undefined ? {} : { status }) });
      return Object.assign(new Error("Ozon Pay creation could not be confirmed"), { code });
    };

    let response;
    try {
      response = await fetch("https://payapi.ozon.ru/v1/createOrder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal,
      });
    } catch {
      throw unavailable(signal.aborted ? "OZON_PAY_TIMEOUT" : "OZON_PAY_NETWORK_ERROR");
    }

    if (!response.ok) {
      throw unavailable("OZON_PAY_HTTP_ERROR", response.status);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw unavailable(signal.aborted ? "OZON_PAY_TIMEOUT" : "OZON_PAY_INVALID_RESPONSE", response.status);
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw unavailable("OZON_PAY_INVALID_RESPONSE", response.status);
    }
    return data;
  }

  // --------------------------------------------------
// Ozon Pay: get order status signature
// --------------------------------------------------

export function createOzonPayGetOrderStatusSign({
    id = "",
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
  
function isOrderIdentifier(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export async function getOzonPayOrderStatus({ id, extId } = {}) {
  const identifier = id === undefined ? { extId } : { id };
  if (
    (id !== undefined && extId !== undefined) ||
    !isOrderIdentifier(id ?? extId)
  ) {
    throw new Error("Ozon Pay status lookup requires exactly one order identifier");
  }

  const { accessKey } = getOzonPayCredentials();
  const requestSign = createOzonPayGetOrderStatusSign(identifier);
  const signal = AbortSignal.timeout(5000);
  let response;
  try {
    response = await fetch("https://payapi.ozon.ru/v1/getOrderStatus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey, ...identifier, requestSign }),
      redirect: "error",
      signal,
    });
  } catch {
    if (signal.aborted) throw new Error("Ozon Pay status lookup timed out");
    throw new Error("Ozon Pay status lookup failed");
  }

  if (!response.ok) {
    throw new Error(`Ozon Pay status lookup failed (HTTP ${response.status})`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    if (signal.aborted) throw new Error("Ozon Pay status lookup timed out");
    throw new Error("Invalid Ozon Pay status response");
  }

  if (data && Object.hasOwn(data, "code")) {
    throw new Error("Ozon Pay status lookup returned a provider error");
  }
  if (
    !isOrderIdentifier(data?.id) ||
    !isOrderIdentifier(data.status) ||
    (id !== undefined ? data.id !== id : data.extId !== extId)
  ) {
    throw new Error("Invalid Ozon Pay status response");
  }

  return data;
}

export function validateOzonPaySettlement(data, {
  id, extId, amountKopecks, currencyCode, environment,
}) {
  if (!isOrderIdentifier(id) || !isOrderIdentifier(extId) ||
      !Number.isSafeInteger(amountKopecks) || amountKopecks <= 0 ||
      currencyCode !== "643" || !["production", "test"].includes(environment)) {
    return { valid: false, reason: "INVALID_EXPECTATIONS" };
  }

  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.hasOwn(data, "code")) {
    return { valid: false, reason: "INVALID_RESPONSE" };
  }
  if (data.id !== id || data.extId !== extId) {
    return { valid: false, reason: "ORDER_MISMATCH" };
  }
  if (data.status !== "STATUS_PAID") {
    return { valid: false, reason: "NOT_PAID" };
  }
  if (data.isTestMode !== (environment === "test")) {
    return { valid: false, reason: "MODE_MISMATCH" };
  }
  if (data.originalAmount?.currencyCode !== currencyCode) {
    return { valid: false, reason: "CURRENCY_MISMATCH" };
  }
  // Ozon documents a decimal string in minor units. Comparing to a validated
  // safe integer's decimal representation avoids parsing or rounding provider data.
  if (data.originalAmount.value !== String(amountKopecks)) {
    return { valid: false, reason: "AMOUNT_MISMATCH" };
  }

  return { valid: true };
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
      transactionUid,
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
        : (transactionUID ?? transactionUid);
  
  
    const fingerprint =
      `${accessKey}|` +
      `${orderID || ""}|` +
      `${transactionIdentifier ?? ""}|` +
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
  
  
    if (typeof receivedSign !== "string" || !/^[a-f0-9]{64}$/.test(receivedSign)) {
  
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
