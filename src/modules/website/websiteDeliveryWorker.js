import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { supabase } from "../../lib/supabase.js";
import { createWebsiteDeliveryOrder } from "./websiteDeliveryCreationService.js";
import { getWebsiteDeliveryAutoStartAt } from "./websiteOrdersService.js";

const pollIntervalMs = 5000;
// Start the budget before acquiring the two-minute database lease. Leave room
// for provider requests and outcome persistence before another worker recovers it.
const dispatchBudgetMs = 60000;
const expectedReasons = new Set([
  "FULFILLMENT_BLOCKED", "SHIPMENT_CONFLICT", "ORDER_NOT_FOUND", "CUTOFF_EXPIRED",
  "CHECKOUT_FAILED", "CREATE_NOT_SENT", "CREATE_OUTCOME_UNKNOWN", "DELIVERY_UNAVAILABLE",
]);

async function processJob(log, startAt) {
  const deadline = performance.now() + dispatchBudgetMs;
  const token = randomUUID();
  const { data, error } = await supabase.rpc("claim_website_delivery_job_v1", {
    p_lease_token: token,
    p_start_at: startAt,
  }).abortSignal(AbortSignal.timeout(10000));
  if (error || !Array.isArray(data) || data.length > 1) throw new Error("Job claim failed");
  if (!data.length) return;

  const orderId = data[0].order_id;
  if (typeof orderId !== "string" || !/^[1-9]\d*$/.test(orderId) || ["12", "15"].includes(orderId)) {
    throw new Error("Unexpected claimed order");
  }

  let reason = null;
  try {
    await createWebsiteDeliveryOrder(orderId, false, {
      token, startAt,
      assertActive() {
        if (performance.now() >= deadline) throw new Error("Job dispatch budget elapsed");
      },
    });
  } catch (error) {
    reason = expectedReasons.has(error?.code) ? error.code : "SHIPMENT_NOT_RECORDED";
  }

  const outcome = await supabase.rpc("finish_website_delivery_job_v1", {
    p_order_id: orderId,
    p_lease_token: token,
    p_reason: reason,
  }).abortSignal(AbortSignal.timeout(10000));
  if (outcome.error || !["completed", "blocked", "failed"].includes(outcome.data)) {
    log.warn({ event: "website_delivery_job_finish_unconfirmed", orderId });
    return;
  }
  log.info({ event: "website_delivery_job_finished", orderId, state: outcome.data, reason });
}

export default async function websiteDeliveryWorker(fastify) {
  const startAt = getWebsiteDeliveryAutoStartAt();
  if (!startAt) {
    if (process.env.WEBSITE_OZON_DELIVERY_AUTO_CREATE_ENABLED === "true") {
      fastify.log.warn({ event: "website_delivery_auto_invalid_configuration" });
    }
    return;
  }

  let stopped = false;
  let timer;
  let running;

  function schedule(delay) {
    if (stopped) return;
    timer = setTimeout(() => {
      running = processJob(fastify.log, startAt)
        .catch(() => fastify.log.warn({ event: "website_delivery_job_poll_failed" }))
        .finally(() => schedule(pollIntervalMs));
    }, delay);
    timer.unref();
  }

  fastify.addHook("onListen", async () => schedule(0));
  fastify.addHook("preClose", async () => {
    stopped = true;
    clearTimeout(timer);
  });
  fastify.addHook("onClose", async () => {
    await running;
  });
}
