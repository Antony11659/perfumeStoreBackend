BEGIN;

CREATE TABLE public.website_delivery_jobs (
  order_id bigint PRIMARY KEY REFERENCES public.website_orders(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'completed', 'blocked', 'failed')),
  failure_reason text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  shipment_key uuid,
  shipment_claimed_at timestamptz,
  CHECK ((shipment_key IS NULL) = (shipment_claimed_at IS NULL)),
  CHECK ((state = 'processing' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
      OR (state <> 'processing' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK ((state IN ('blocked', 'failed')) = (failure_reason IS NOT NULL))
);

CREATE INDEX website_delivery_jobs_poll_idx ON public.website_delivery_jobs (enqueued_at, order_id)
  WHERE state IN ('pending', 'processing');

ALTER TABLE public.website_delivery_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.website_delivery_jobs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.website_delivery_jobs TO service_role;

CREATE FUNCTION public.website_delivery_auto_eligible_v1(p_order_id bigint, p_start_at timestamptz)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  SELECT p_order_id NOT IN (12, 15)
    AND p_start_at IS NOT NULL AND pg_catalog.isfinite(p_start_at)
    AND EXISTS (
      SELECT 1 FROM public.website_orders AS o
      JOIN public.website_order_deliveries AS d ON d.order_id = o.id
      WHERE o.id = p_order_id AND o.status = 'paid' AND o.payment_state = 'confirmed'
        AND o.created_at >= p_start_at
        AND d.provider = 'ozon' AND d.delivery_type = 'pvz' AND d.status = 'calculated'
    )
    AND (
      SELECT count(*) = 1 AND bool_and(coalesce(i.variant_id::text = '422' AND i.quantity = 1, false))
      FROM public.website_order_items AS i WHERE i.order_id = p_order_id
    );
$$;

-- The existing settlement RPC retains all payment guards. Only its fresh
-- transition can insert a job, in the same database transaction.
CREATE FUNCTION public.confirm_website_order_payment_and_queue_delivery_v1(
  p_order_id bigint, p_ozon_payment_id text, p_order_number text,
  p_amount_kopecks bigint, p_start_at timestamptz
)
RETURNS TABLE (
  id bigint, order_number text, total numeric, status text,
  payment_state text, ozon_payment_id text
)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  confirmed record;
BEGIN
  SELECT * INTO confirmed FROM public.confirm_website_order_payment_v1(
    p_order_id, p_ozon_payment_id, p_order_number, p_amount_kopecks
  );
  IF NOT FOUND THEN RETURN; END IF;

  IF public.website_delivery_auto_eligible_v1(p_order_id, p_start_at) AND EXISTS (
    SELECT 1 FROM public.website_order_deliveries AS d WHERE d.order_id = p_order_id
      AND d.creation_state IS NULL AND d.external_order_number IS NULL AND d.external_posting_number IS NULL
  ) THEN
    INSERT INTO public.website_delivery_jobs (order_id) VALUES (p_order_id)
      ON CONFLICT (order_id) DO NOTHING;
  END IF;

  RETURN QUERY SELECT confirmed.id, confirmed.order_number, confirmed.total, confirmed.status,
                      confirmed.payment_state, confirmed.ozon_payment_id;
END;
$$;

-- Finish from authoritative delivery state. Match the exact automatic claim
-- so a manual same-key retry already in flight remains independently owned.
CREATE FUNCTION public.finish_website_delivery_job_v1(
  p_order_id bigint, p_lease_token uuid, p_reason text
)
RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET lock_timeout = '2s'
AS $$
DECLARE
  job public.website_delivery_jobs%ROWTYPE;
  delivery public.website_order_deliveries%ROWTYPE;
  final_state text := 'failed';
  reason text := p_reason;
BEGIN
  SELECT j.* INTO job FROM public.website_delivery_jobs AS j
    WHERE j.order_id = p_order_id AND j.order_id NOT IN (12, 15)
      AND j.state = 'processing' AND j.lease_token = p_lease_token
    FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT d.* INTO delivery FROM public.website_order_deliveries AS d
    WHERE d.order_id = p_order_id FOR UPDATE;

  IF delivery.creation_state = 'created'
    AND nullif(btrim(delivery.external_order_number), '') IS NOT NULL
    AND nullif(btrim(delivery.external_posting_number), '') IS NOT NULL THEN
    final_state := 'completed';
    reason := NULL;
  ELSIF delivery.creation_state = 'creating' AND job.shipment_key = delivery.creation_key
    AND job.shipment_claimed_at = delivery.creation_updated_at THEN
    UPDATE public.website_order_deliveries
      SET creation_state = 'unknown', creation_error = 'CREATE_OUTCOME_UNKNOWN', creation_updated_at = now()
      WHERE order_id = p_order_id;
    final_state := 'blocked';
    reason := 'CREATE_OUTCOME_UNKNOWN';
  ELSIF delivery.creation_state = 'unknown' THEN
    final_state := 'blocked';
    reason := 'CREATE_OUTCOME_UNKNOWN';
  ELSIF delivery.creation_state = 'creating' THEN
    final_state := 'blocked';
    reason := 'EXISTING_SHIPMENT_CLAIM';
  ELSIF reason IN ('FULFILLMENT_BLOCKED', 'SHIPMENT_CONFLICT', 'ORDER_NOT_FOUND', 'CUTOFF_EXPIRED') THEN
    final_state := 'blocked';
  ELSE
    reason := CASE WHEN reason IN ('CHECKOUT_FAILED', 'CREATE_NOT_SENT', 'DELIVERY_UNAVAILABLE',
      'LEASE_EXHAUSTED') THEN reason ELSE 'SHIPMENT_NOT_RECORDED' END;
  END IF;

  UPDATE public.website_delivery_jobs
    SET state = final_state, failure_reason = reason, updated_at = now(), lease_token = NULL, lease_until = NULL
    WHERE order_id = p_order_id;
  RETURN final_state;
END;
$$;

CREATE FUNCTION public.claim_website_delivery_job_v1(p_lease_token uuid, p_start_at timestamptz)
RETURNS TABLE (order_id text, lease_until timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET lock_timeout = '2s'
AS $$
DECLARE
  job public.website_delivery_jobs%ROWTYPE;
BEGIN
  IF p_lease_token IS NULL OR p_start_at IS NULL OR NOT pg_catalog.isfinite(p_start_at) THEN RETURN; END IF;

  SELECT j.* INTO job FROM public.website_delivery_jobs AS j
    JOIN public.website_orders AS o ON o.id = j.order_id
    WHERE j.order_id NOT IN (12, 15) AND o.created_at >= p_start_at
      AND (j.state = 'pending' OR (j.state = 'processing' AND j.lease_until <= clock_timestamp()))
    ORDER BY j.enqueued_at, j.order_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;

  IF job.state = 'processing' AND (job.shipment_key IS NOT NULL OR job.attempts >= 3) THEN
    PERFORM public.finish_website_delivery_job_v1(job.order_id, job.lease_token, 'LEASE_EXHAUSTED');
    RETURN;
  END IF;

  RETURN QUERY UPDATE public.website_delivery_jobs AS j
    SET state = 'processing', lease_token = p_lease_token, lease_until = clock_timestamp() + interval '2 minutes',
        updated_at = now(), attempts = j.attempts + 1
    WHERE j.order_id = job.order_id
    RETURNING j.order_id::text, j.lease_until;
END;
$$;

-- Bind the automatic job lease to the existing immutable delivery claim in a
-- single transaction. A reclaimed worker cannot claim a delivery with a stale token.
CREATE FUNCTION public.claim_website_delivery_for_job_v1(
  p_order_id bigint, p_lease_token uuid, p_start_at timestamptz, p_key uuid, p_body text
)
RETURNS TABLE (creation_key uuid, creation_body text, previous_state text, claimed_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET lock_timeout = '2s'
AS $$
DECLARE
  shipment record;
BEGIN
  PERFORM 1 FROM public.website_delivery_jobs AS j
    WHERE j.order_id = p_order_id AND j.state = 'processing' AND j.lease_token = p_lease_token
      AND j.lease_until > clock_timestamp() AND j.shipment_key IS NULL
    FOR UPDATE;
  IF NOT FOUND OR NOT public.website_delivery_auto_eligible_v1(p_order_id, p_start_at) THEN RETURN; END IF;

  SELECT * INTO shipment FROM public.claim_website_delivery_creation_v1(p_order_id, p_key, p_body, false);
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.website_delivery_jobs SET shipment_key = p_key, shipment_claimed_at = now(),
    updated_at = now() WHERE order_id = p_order_id;
  RETURN QUERY SELECT shipment.creation_key, shipment.creation_body, shipment.previous_state, now();
END;
$$;

REVOKE ALL ON FUNCTION
  public.website_delivery_auto_eligible_v1(bigint, timestamptz),
  public.confirm_website_order_payment_and_queue_delivery_v1(bigint, text, text, bigint, timestamptz),
  public.finish_website_delivery_job_v1(bigint, uuid, text),
  public.claim_website_delivery_job_v1(uuid, timestamptz),
  public.claim_website_delivery_for_job_v1(bigint, uuid, timestamptz, uuid, text)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.website_delivery_auto_eligible_v1(bigint, timestamptz),
  public.confirm_website_order_payment_and_queue_delivery_v1(bigint, text, text, bigint, timestamptz),
  public.finish_website_delivery_job_v1(bigint, uuid, text),
  public.claim_website_delivery_job_v1(uuid, timestamptz),
  public.claim_website_delivery_for_job_v1(bigint, uuid, timestamptz, uuid, text)
TO service_role;

COMMIT;
