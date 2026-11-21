BEGIN;

ALTER TABLE public.website_order_deliveries
  ADD COLUMN parcel jsonb,
  ADD COLUMN creation_key uuid UNIQUE,
  ADD COLUMN creation_body text,
  ADD COLUMN creation_state text,
  ADD COLUMN creation_updated_at timestamptz,
  ADD COLUMN creation_error text,
  ADD CONSTRAINT website_order_deliveries_one_per_order UNIQUE (order_id),
  ADD CONSTRAINT website_delivery_creation_state_check CHECK (
    (creation_state IS NULL AND creation_key IS NULL AND creation_body IS NULL)
    OR (creation_state IS NOT NULL
      AND creation_state IN ('creating', 'unknown', 'retryable', 'created')
      AND creation_key IS NOT NULL AND creation_body IS NOT NULL)
  );

-- An exact replay body contains recipient data. The migration must not
-- inherit browser-role access through pre-existing table-level grants.
DO $$
DECLARE
  browser_role text;
  creation_column text;
BEGIN
  FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF pg_catalog.has_table_privilege(browser_role, 'public.website_order_deliveries', 'DELETE, TRUNCATE') THEN
      RAISE EXCEPTION 'Unsafe effective delete or truncate privilege for % on website_order_deliveries', browser_role;
    END IF;
    FOREACH creation_column IN ARRAY ARRAY[
      'parcel', 'creation_key', 'creation_body', 'creation_state',
      'creation_updated_at', 'creation_error'
    ] LOOP
      IF pg_catalog.has_column_privilege(browser_role, 'public.website_order_deliveries',
           creation_column, 'SELECT, INSERT, UPDATE, REFERENCES') THEN
        RAISE EXCEPTION 'Unsafe effective privilege for % on website_order_deliveries.%', browser_role, creation_column
          USING HINT = 'Preserve any required legacy column grants while removing browser access to shipment creation columns.';
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

GRANT SELECT (parcel, creation_key, creation_body, creation_state, creation_updated_at, creation_error),
      UPDATE (parcel, creation_key, creation_body, creation_state, creation_updated_at, creation_error,
              external_order_number, external_posting_number)
  ON public.website_order_deliveries TO service_role;

CREATE FUNCTION public.protect_website_delivery_claim_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.creation_key IS NOT NULL AND (
    NEW.parcel IS DISTINCT FROM OLD.parcel
    OR NEW.creation_key IS DISTINCT FROM OLD.creation_key
    OR NEW.creation_body IS DISTINCT FROM OLD.creation_body
  ) THEN
    RAISE EXCEPTION 'A claimed website delivery parcel, request and key are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_website_delivery_claim_v1
  BEFORE UPDATE ON public.website_order_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.protect_website_delivery_claim_v1();

REVOKE ALL ON FUNCTION public.protect_website_delivery_claim_v1()
  FROM PUBLIC, anon, authenticated;

-- Only a confirmed, committed claim authorizes outbound shipment creation.
CREATE FUNCTION public.claim_website_delivery_creation_v1(
  p_order_id bigint, p_key uuid, p_body text, p_retry boolean
)
RETURNS TABLE (creation_key uuid, creation_body text, previous_state text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  delivery public.website_order_deliveries%ROWTYPE;
  website_order public.website_orders%ROWTYPE;
  request jsonb;
  posting jsonb;
  parcel_snapshot jsonb;
BEGIN
  SELECT o.* INTO website_order FROM public.website_orders AS o
    WHERE o.id = p_order_id AND o.status = 'paid' AND o.payment_state = 'confirmed'
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT d.* INTO delivery FROM public.website_order_deliveries AS d
    WHERE d.order_id = p_order_id AND d.provider = 'ozon' AND d.delivery_type = 'pvz'
      AND d.status = 'calculated'
      AND d.external_order_number IS NULL AND d.external_posting_number IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF p_retry THEN
    IF delivery.creation_state IS NULL OR delivery.creation_state NOT IN ('unknown', 'retryable')
      OR delivery.creation_key IS DISTINCT FROM p_key
      OR delivery.creation_body IS DISTINCT FROM p_body
    THEN RETURN; END IF;
    parcel_snapshot := delivery.parcel;
  ELSIF delivery.creation_state IS NOT NULL OR p_key IS NULL OR p_body IS NULL THEN
    RETURN;
  ELSE
    -- Reject a stale request if shipping inputs changed between validation and claim.
    request := p_body::jsonb;
    posting := request #> '{postings,0}';
    IF jsonb_typeof(posting->'dimensions') IS DISTINCT FROM 'object'
      OR jsonb_typeof(posting->'description') IS DISTINCT FROM 'string'
      OR btrim(posting->>'description') = ''
    THEN RETURN; END IF;
    parcel_snapshot := (posting->'dimensions')
      || jsonb_build_object('description', posting->>'description');
    IF request->>'order_external_id' IS DISTINCT FROM website_order.order_number
      OR request #>> '{recipient,full_name}' IS DISTINCT FROM btrim(website_order.customer_name)
      OR request #>> '{recipient,phone_number}' IS DISTINCT FROM
        '+' || regexp_replace(website_order.phone, '[^0-9]', '', 'g')
      OR request #>> '{delivery,delivery_point,delivery_point_id}' IS DISTINCT FROM delivery.delivery_point_id::text
      OR (posting #>> '{declared_value,amount}')::numeric IS DISTINCT FROM website_order.subtotal
      OR (posting->>'cutoff_at')::timestamptz IS DISTINCT FROM delivery.cutoff_at::timestamptz
      OR (delivery.parcel IS NOT NULL AND delivery.parcel IS DISTINCT FROM parcel_snapshot)
    THEN RETURN; END IF;
  END IF;

  RETURN QUERY
    UPDATE public.website_order_deliveries AS d
    SET parcel = parcel_snapshot, creation_key = p_key, creation_body = p_body, creation_state = 'creating',
        creation_updated_at = now(), creation_error = NULL
    WHERE d.order_id = p_order_id
    RETURNING d.creation_key, d.creation_body, delivery.creation_state;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_website_delivery_creation_v1(bigint, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_website_delivery_creation_v1(bigint, uuid, text, boolean)
  TO service_role;

COMMIT;
