BEGIN;

CREATE FUNCTION public.erp_perfume_dependencies_v1(p_perfume_id bigint)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  variants bigint;
  mappings bigint;
  order_items bigint;
  images bigint;
  unverified_keys bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.perfumes WHERE id = p_perfume_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'PT404', MESSAGE = 'Perfume not found';
  END IF;

  -- Refuse to rely on the verified cascade rules when the inbound FK graph
  -- differs from the reviewed schema, even if the extra table appears empty.
  WITH expected(child, parent, child_columns, parent_columns, delete_action, validated) AS (
    VALUES
      ('public.perfume_variants'::regclass, 'public.perfumes'::regclass, ARRAY['perfume_id'], ARRAY['id'], 'c', true),
      ('public.perfume_images'::regclass, 'public.perfumes'::regclass, ARRAY['perfume_id'], ARRAY['id'], 'c', true),
      ('public.shop_products'::regclass, 'public.perfume_variants'::regclass,
       ARRAY['perfume_id','volume_ml'], ARRAY['perfume_id','volume_ml'], 'r', true),
      ('public.website_order_items'::regclass, 'public.perfume_variants'::regclass,
       ARRAY['variant_id'], ARRAY['id'], 'a', true)
  ), actual AS (
    SELECT c.conrelid::regclass, c.confrelid::regclass,
           ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(num,pos)
                 JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.pos),
           ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(num,pos)
                 JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.pos),
           c.confdeltype::text, c.convalidated
    FROM pg_catalog.pg_constraint AS c
    WHERE c.contype = 'f'
      AND c.confrelid IN ('public.perfumes'::regclass, 'public.perfume_variants'::regclass)
  ), differences AS (
    (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
    UNION ALL
    (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
  )
  SELECT count(*) INTO unverified_keys FROM differences;

  SELECT count(*) INTO variants FROM public.perfume_variants WHERE perfume_id = p_perfume_id;
  SELECT count(*) INTO mappings FROM public.shop_products WHERE perfume_id = p_perfume_id;
  SELECT count(*) INTO order_items FROM public.website_order_items AS item
    JOIN public.perfume_variants AS variant ON variant.id = item.variant_id
    WHERE variant.perfume_id = p_perfume_id;
  SELECT count(*) INTO images FROM public.perfume_images WHERE perfume_id = p_perfume_id;

  RETURN jsonb_build_object(
    'variants', variants, 'skuMappings', mappings, 'websiteOrderItems', order_items,
    'images', images, 'unverifiedForeignKeys', unverified_keys,
    'canDelete', mappings = 0 AND order_items = 0 AND images = 0 AND unverified_keys = 0
  );
END;
$$;

CREATE FUNCTION public.erp_delete_perfume_v1(p_perfume_id bigint)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  dependencies jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = '0A000', MESSAGE = 'Perfume deletion requires READ COMMITTED isolation';
  END IF;

  -- Keep DDL from changing inbound FK definitions during this check.
  LOCK TABLE public.perfumes, public.perfume_variants IN ROW EXCLUSIVE MODE;

  -- Child FK checks acquire key-share on the parent or a variant. These
  -- row locks wait for in-flight references and prevent new ones until commit.
  PERFORM id FROM public.perfumes WHERE id = p_perfume_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'PT404', MESSAGE = 'Perfume not found';
  END IF;
  PERFORM id FROM public.perfume_variants WHERE perfume_id = p_perfume_id ORDER BY id FOR UPDATE;

  dependencies := public.erp_perfume_dependencies_v1(p_perfume_id);
  IF NOT (dependencies->>'canDelete')::boolean THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'Perfume deletion is blocked', DETAIL = dependencies::text;
  END IF;

  DELETE FROM public.perfumes WHERE id = p_perfume_id;
  RETURN jsonb_build_object('id', p_perfume_id::text);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.erp_perfume_dependencies_v1(bigint), public.erp_delete_perfume_v1(bigint)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.erp_perfume_dependencies_v1(bigint), public.erp_delete_perfume_v1(bigint)
TO service_role;

COMMIT;
