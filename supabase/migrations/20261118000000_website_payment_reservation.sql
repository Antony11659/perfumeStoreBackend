BEGIN;

ALTER TABLE public.website_orders
  ADD COLUMN payment_state text DEFAULT NULL,
  ADD COLUMN ozon_payment_id text UNIQUE,
  ADD COLUMN payment_link text,
  ADD CONSTRAINT website_orders_payment_state_check
    CHECK (payment_state IN ('reserved', 'unknown', 'ready', 'confirmed')),
  ADD CONSTRAINT website_orders_payment_fields_check CHECK (
    CASE
      WHEN payment_state = 'ready' THEN
        NULLIF(btrim(ozon_payment_id), '') IS NOT NULL
        AND NULLIF(btrim(payment_link), '') IS NOT NULL
      WHEN payment_state = 'confirmed' THEN
        NULLIF(btrim(ozon_payment_id), '') IS NOT NULL
        AND (payment_link IS NULL OR NULLIF(btrim(payment_link), '') IS NOT NULL)
      ELSE ozon_payment_id IS NULL AND payment_link IS NULL
    END
  );

-- Only a successfully completed call returning one row grants the claim.
-- Zero rows or an uncertain result must never authorize an external call.
CREATE FUNCTION public.reserve_website_order_payment_v1(p_order_id bigint)
RETURNS TABLE (id bigint, order_number text, total numeric, payment_state text)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  UPDATE public.website_orders AS o
  SET payment_state = 'reserved'
  WHERE o.id = p_order_id
    AND o.status = 'new'
    AND o.payment_state IS NULL
  RETURNING o.id, o.order_number, o.total, o.payment_state;
$$;

REVOKE ALL ON FUNCTION public.reserve_website_order_payment_v1(bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_website_order_payment_v1(bigint)
  TO service_role;

CREATE FUNCTION public.save_website_order_payment_v1(
  p_order_id bigint, p_ozon_payment_id text, p_payment_link text
)
RETURNS TABLE (
  id bigint, order_number text, total numeric, payment_state text,
  ozon_payment_id text, payment_link text
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  UPDATE public.website_orders AS o
  SET payment_state = 'ready',
      ozon_payment_id = p_ozon_payment_id,
      payment_link = p_payment_link
  WHERE o.id = p_order_id
    AND o.status = 'new'
    AND o.payment_state = 'reserved'
    AND (o.ozon_payment_id IS NULL OR o.ozon_payment_id = p_ozon_payment_id)
    AND (o.payment_link IS NULL OR o.payment_link = p_payment_link)
    AND p_ozon_payment_id ~ '[^[:space:]]'
    AND p_payment_link ~ '[^[:space:]]'
  RETURNING o.id, o.order_number, o.total, o.payment_state,
            o.ozon_payment_id, o.payment_link;
$$;

REVOKE ALL ON FUNCTION public.save_website_order_payment_v1(bigint, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_website_order_payment_v1(bigint, text, text)
  TO service_role;

-- The caller must verify authoritative provider status before invoking this RPC.
CREATE FUNCTION public.confirm_website_order_payment_v1(
  p_order_id bigint, p_ozon_payment_id text, p_order_number text,
  p_amount_kopecks bigint
)
RETURNS TABLE (
  id bigint, order_number text, total numeric, status text,
  payment_state text, ozon_payment_id text
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
  UPDATE public.website_orders AS o
  SET status = 'paid',
      payment_state = 'confirmed',
      updated_at = now()
  WHERE o.id = p_order_id
    AND o.status = 'new'
    AND o.payment_state = 'ready'
    AND o.ozon_payment_id = p_ozon_payment_id
    AND o.order_number = p_order_number
    AND o.total > 0
    AND p_amount_kopecks > 0
    AND o.total * 100 = p_amount_kopecks
    AND p_ozon_payment_id ~ '[^[:space:]]'
    AND p_order_number ~ '[^[:space:]]'
  RETURNING o.id, o.order_number, o.total, o.status,
            o.payment_state, o.ozon_payment_id;
$$;

REVOKE ALL ON FUNCTION public.confirm_website_order_payment_v1(bigint, text, text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_website_order_payment_v1(bigint, text, text, bigint)
  TO service_role;

COMMIT;
