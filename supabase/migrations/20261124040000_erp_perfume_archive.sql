BEGIN;

ALTER TABLE public.perfumes
  ADD COLUMN is_archived boolean NOT NULL DEFAULT false,
  ADD COLUMN archived_at timestamptz,
  ADD CONSTRAINT perfumes_archive_status_consistent
    CHECK (is_archived = (archived_at IS NOT NULL));

CREATE FUNCTION public.erp_set_perfume_archive_v1(p_perfume_ids bigint[], p_archived boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  locked_count integer;
  changed_count integer;
  change_time timestamptz;
BEGIN
  IF p_archived IS NULL OR p_perfume_ids IS NULL OR cardinality(p_perfume_ids) NOT BETWEEN 1 AND 50
     OR EXISTS (SELECT 1 FROM unnest(p_perfume_ids) AS value(id) WHERE id IS NULL OR id < 1)
     OR cardinality(p_perfume_ids) <> (SELECT count(DISTINCT id) FROM unnest(p_perfume_ids) AS value(id)) THEN
    RAISE SQLSTATE '22023' USING MESSAGE = 'Invalid perfume archive request';
  END IF;

  -- Match the lock ordering used when persisting checkout items.
  PERFORM p.id FROM public.perfumes AS p
    WHERE p.id = ANY(p_perfume_ids) ORDER BY p.id FOR NO KEY UPDATE;
  GET DIAGNOSTICS locked_count = ROW_COUNT;
  IF locked_count <> cardinality(p_perfume_ids) THEN
    RAISE SQLSTATE 'PT404' USING MESSAGE = 'One or more perfumes were not found';
  END IF;

  change_time := clock_timestamp();
  UPDATE public.perfumes
    SET is_archived = p_archived,
        archived_at = CASE WHEN p_archived THEN change_time END,
        updated_at = change_time
    WHERE id = ANY(p_perfume_ids) AND is_archived IS DISTINCT FROM p_archived;
  GET DIAGNOSTICS changed_count = ROW_COUNT;

  RETURN jsonb_build_object('changed', changed_count);
END;
$$;

REVOKE ALL ON FUNCTION public.erp_set_perfume_archive_v1(bigint[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_set_perfume_archive_v1(bigint[], boolean) TO service_role;

CREATE FUNCTION public.check_website_order_perfume_availability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  perfume record;
BEGIN
  -- This statement trigger runs inside order persistence. Locks stay held
  -- through commit, and a failure rolls back the entire new order.
  FOR perfume IN
    SELECT p.is_archived
    FROM public.perfumes AS p
    WHERE p.id IN (
      SELECT v.perfume_id FROM new_order_items AS item
      JOIN public.perfume_variants AS v ON v.id = item.variant_id
    )
    ORDER BY p.id
    FOR SHARE OF p
  LOOP
    IF perfume.is_archived THEN
      RAISE SQLSTATE 'PT409' USING MESSAGE = 'WEBSITE_PERFUME_ARCHIVED';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.check_website_order_perfume_availability() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_website_order_perfume_availability() TO service_role;

CREATE TRIGGER website_order_items_check_perfume_availability
AFTER INSERT ON public.website_order_items
REFERENCING NEW TABLE AS new_order_items
FOR EACH STATEMENT EXECUTE FUNCTION public.check_website_order_perfume_availability();

COMMIT;
