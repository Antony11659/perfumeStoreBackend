import { randomUUID } from "node:crypto";
import { supabase } from "../../lib/supabase.js";
import {
  OZON_DEFAULT_PARCEL_DIMENSIONS,
  OZON_STANDARD_PARCEL_DESCRIPTION,
  OZON_WEBSITE_SHIPMENT_METHOD_ID,
  ozonDeliveryRequest,
} from "../delivery/ozon/ozonDeliveryService.js";

// Approve a variant only after verifying one packed unit fits the standard parcel.
const approvedVariantIds = new Set(
  (process.env.OZON_WEBSITE_STANDARD_PARCEL_VARIANT_IDS ?? "")
    .split(",").map((id) => id.trim()).filter((id) => /^[1-9]\d*$/.test(id))
);

function deliveryError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

const unavailable = () => deliveryError(503, "DELIVERY_UNAVAILABLE", "Shipment storage is unavailable");
const blocked = (message) => deliveryError(422, "FULFILLMENT_BLOCKED", message);
const conflict = () => deliveryError(409, "SHIPMENT_CONFLICT", "Shipment already exists or creation is in progress. Reconcile unresolved attempts before proceeding.");

function decimalKopecks(value) {
  const match = typeof value === "string" && /^(\d+)(?:\.(\d{1,2})0*)?$/.exec(value);
  if (!match || match[0] !== value) return null;
  return BigInt(match[1] + (match[2] || "").padEnd(2, "0"));
}

function futureCutoff(value) {
  return typeof value === "string" && Date.parse(value) > Date.now();
}

async function prepareDeliveryBody(order, delivery) {
  const point = String(delivery.delivery_point_id ?? "");
  if (!/^[1-9]\d*$/.test(point) || !Number.isSafeInteger(Number(point))) {
    throw blocked("The saved Ozon pickup point ID is missing or invalid");
  }
  const phone = typeof order.phone === "string" && order.phone.trim();
  const digits = phone && phone.replace(/\D/g, "");
  if (!phone || !/^\+?[\d\s()-]+$/.test(phone) || !/^7\d{10}$/.test(digits)) {
    throw blocked("The saved customer phone is invalid");
  }
  const name = typeof order.customer_name === "string" && order.customer_name.trim();
  if (!name || typeof order.order_number !== "string" || !order.order_number.trim()) {
    throw blocked("The saved recipient name or order reference is missing");
  }
  if (!futureCutoff(delivery.cutoff_at)) throw blocked("The saved delivery cutoff is missing or expired");
  if (!Number.isSafeInteger(OZON_WEBSITE_SHIPMENT_METHOD_ID) || OZON_WEBSITE_SHIPMENT_METHOD_ID <= 0) {
    throw blocked("The Web Site Shop shipment method is unavailable");
  }

  const subtotal = decimalKopecks(order.subtotal);
  if (!subtotal || subtotal <= 0n) throw blocked("The saved merchandise subtotal cannot be used as declared value");
  const { data: items, error } = await supabase.from("website_order_items")
    .select("variant_id::text,quantity,unit_price::text,line_total::text").eq("order_id", order.id)
    .abortSignal(AbortSignal.timeout(10000));
  if (error || !Array.isArray(items)) throw unavailable();
  if (items.length !== 1 || items[0].quantity !== 1 || !approvedVariantIds.has(items[0].variant_id)) {
    throw blocked("This order has no verified fit for the standard parcel. Review it manually.");
  }
  let sum = 0n;
  for (const item of items) {
    const price = decimalKopecks(item.unit_price);
    const line = decimalKopecks(item.line_total);
    if (price === null || line === null || !Number.isSafeInteger(item.quantity) ||
        item.quantity <= 0 || price * BigInt(item.quantity) !== line) {
      throw blocked("Saved order item amounts are invalid");
    }
    sum += line;
  }
  if (sum !== subtotal) throw blocked("Saved order item amounts do not match the merchandise subtotal");

  return {
    order_external_id: order.order_number,
    recipient: { phone_number: `+${digits}`, full_name: name },
    delivery: { delivery_point: { delivery_point_id: Number(point) } },
    postings: [{
      request_id: 1,
      posting_external_id: `${order.order_number}-1`,
      shipment_method_id: OZON_WEBSITE_SHIPMENT_METHOD_ID,
      description: OZON_STANDARD_PARCEL_DESCRIPTION,
      declared_value: { amount: `${subtotal / 100n}.${String(subtotal % 100n).padStart(2, "0")}`, currency_code: "RUB" },
      cutoff_at: delivery.cutoff_at,
      dimensions: OZON_DEFAULT_PARCEL_DIMENSIONS,
    }],
  };
}

async function recordOutcome(orderId, key, state, errorCode, identifiers = {}) {
  const { data, error } = await supabase.from("website_order_deliveries")
    .update({ ...identifiers, creation_state: state, creation_error: errorCode, creation_updated_at: new Date().toISOString() })
    .eq("order_id", orderId).eq("creation_key", key).eq("creation_state", "creating")
    .select("creation_key").abortSignal(AbortSignal.timeout(10000)).maybeSingle();
  if (error || data?.creation_key !== key) {
    throw deliveryError(503, "SHIPMENT_OUTCOME_UNCONFIRMED", "Shipment outcome could not be saved. Reconcile before retrying.");
  }
}

export async function createWebsiteDeliveryOrder(orderId, retry = false) {
  const { data: order, error: orderError } = await supabase.from("website_orders")
    .select("id,order_number,customer_name,phone,subtotal::text,status,payment_state")
    .eq("id", orderId).abortSignal(AbortSignal.timeout(10000)).maybeSingle();
  if (orderError) throw unavailable();
  if (!order) throw deliveryError(404, "ORDER_NOT_FOUND", "Website order not found");
  if (order.status !== "paid" || order.payment_state !== "confirmed") {
    throw blocked("Website order payment is not confirmed");
  }

  const { data: delivery, error: deliveryErrorResult } = await supabase.from("website_order_deliveries")
    .select("provider,delivery_type,delivery_point_id,cutoff_at,status,external_order_number,external_posting_number,creation_key,creation_body,creation_state")
    .eq("order_id", orderId).abortSignal(AbortSignal.timeout(10000)).maybeSingle();
  if (deliveryErrorResult) throw unavailable();
  if (!delivery || delivery.provider !== "ozon" || delivery.delivery_type !== "pvz") {
    throw blocked("The saved Ozon pickup-point delivery is missing");
  }
  if (delivery.status !== "calculated" || delivery.external_order_number || delivery.external_posting_number) {
    throw conflict();
  }
  if (retry ? !["unknown", "retryable"].includes(delivery.creation_state) : delivery.creation_state !== null) {
    throw conflict();
  }
  const key = retry ? delivery.creation_key : randomUUID();
  const body = retry ? delivery.creation_body : JSON.stringify(await prepareDeliveryBody(order, delivery));
  const payload = JSON.parse(body);
  const [posting] = payload.postings;
  if (!futureCutoff(posting.cutoff_at)) throw blocked("The saved attempt has an expired cutoff. Reconcile with Ozon before proceeding.");

  const { data: claim, error: claimError } = await supabase.rpc("claim_website_delivery_creation_v1", {
    p_order_id: orderId, p_key: key, p_body: body, p_retry: retry,
  }).abortSignal(AbortSignal.timeout(10000));
  if (claimError || !Array.isArray(claim)) throw unavailable();
  if (!claim.length) throw conflict();
  if (claim.length !== 1 || claim[0].creation_key !== key || claim[0].creation_body !== body) throw unavailable();

  const { posting_external_id, description, ...checkoutPosting } = posting;
  try {
    const response = await ozonDeliveryRequest("/v1/order/checkout", {
      body: {
        recipient: { phone_number: payload.recipient.phone_number },
        delivery: payload.delivery,
        postings: [checkoutPosting],
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw unavailable();
    const { results } = await response.json();
    const result = Array.isArray(results) && results.length === 1 && results[0];
    if (result?.error) throw blocked("Ozon checkout rejected the saved shipment parameters");
    if (!result?.posting || typeof result.posting !== "object" || Array.isArray(result.posting) ||
        (result.request_id !== undefined && result.request_id !== posting.request_id)) throw unavailable();
    if (!futureCutoff(posting.cutoff_at)) throw blocked("The saved delivery cutoff expired during checkout");
  } catch (error) {
    await recordOutcome(orderId, key, claim[0].previous_state === "unknown" ? "unknown" : "retryable", "CHECKOUT_FAILED");
    if (error?.code === "FULFILLMENT_BLOCKED") throw error;
    throw deliveryError(502, "CHECKOUT_FAILED", "Ozon shipment checkout could not be confirmed");
  }

  let identifiers;
  try {
    const response = await ozonDeliveryRequest("/v1/order/create", {
      body,
      idempotencyKey: key,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw unavailable();
    const result = await response.json();
    const returnedPosting = Array.isArray(result?.postings) && result.postings.length === 1 && result.postings[0];
    if (result?.order_external_id !== payload.order_external_id || typeof result.order_number !== "string" ||
        !result.order_number.trim() || returnedPosting?.request_id !== posting.request_id ||
        returnedPosting.posting_external_id !== posting_external_id ||
        typeof returnedPosting.posting_number !== "string" || !returnedPosting.posting_number.trim()) {
      throw unavailable();
    }
    identifiers = { external_order_number: result.order_number, external_posting_number: returnedPosting.posting_number };
  } catch {
    await recordOutcome(orderId, key, "unknown", "CREATE_OUTCOME_UNKNOWN");
    throw deliveryError(502, "CREATE_OUTCOME_UNKNOWN", "Ozon creation outcome is unknown. Reconcile before an explicit same-request retry.");
  }

  await recordOutcome(orderId, key, "created", null, identifiers);
  return { orderNumber: identifiers.external_order_number, postingNumber: identifiers.external_posting_number };
}
