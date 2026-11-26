BEGIN;
SET LOCAL search_path TO public, pg_catalog;

-- The marketplace comparison derives unmatched products from absent mappings.
-- Keep detached identities here so the same list can include unsynced or invisible products
-- without exposing incomplete mappings to the existing fulfillment queries.
CREATE TABLE public.erp_unmatched_skus (
  id uuid PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT
);
ALTER TABLE public.erp_unmatched_skus ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_unmatched_skus FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON public.erp_unmatched_skus TO service_role;

CREATE FUNCTION public.erp_detach_skus_v1(p_perfume_id bigint, p_volume integer, p_sku_id uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  detached bigint;
  sku_key text;
BEGIN
  LOCK TABLE public.shop_products IN ROW EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE contype = 'f' AND confrelid = 'public.shop_products'::regclass
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Unreviewed SKU foreign key prevents detaching mappings';
  END IF;

  FOR sku_key IN
    SELECT sku FROM public.shop_products
    WHERE perfume_id = p_perfume_id
      AND (p_volume IS NULL OR volume_ml = p_volume)
      AND (p_sku_id IS NULL OR id = p_sku_id)
    ORDER BY sku FOR UPDATE
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('erp-sku:' || sku_key, 0));
  END LOOP;

  WITH removed AS (
    DELETE FROM public.shop_products
    WHERE perfume_id = p_perfume_id
      AND (p_volume IS NULL OR volume_ml = p_volume)
      AND (p_sku_id IS NULL OR id = p_sku_id)
    RETURNING id, sku, shop_id
  )
  INSERT INTO public.erp_unmatched_skus (id, sku, shop_id)
    SELECT id, sku, shop_id FROM removed;
  GET DIAGNOSTICS detached = ROW_COUNT;
  RETURN detached;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_detach_skus_v1(bigint,integer,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_detach_skus_v1(bigint,integer,uuid) TO service_role;

CREATE FUNCTION public.erp_guard_detached_sku_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  reserved public.erp_unmatched_skus%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.sku = NEW.sku THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('erp-sku:' || NEW.sku, 0));
  SELECT * INTO reserved FROM public.erp_unmatched_skus WHERE sku = NEW.sku;
  IF FOUND THEN
    IF TG_OP = 'UPDATE' OR reserved.shop_id <> NEW.shop_id THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'SKU is reserved in unmatched mappings';
    END IF;
    NEW.id := reserved.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION public.erp_consume_detached_sku_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.erp_unmatched_skus WHERE sku = NEW.sku AND id = NEW.id AND shop_id = NEW.shop_id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_guard_detached_sku_v1(), public.erp_consume_detached_sku_v1()
FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER erp_guard_detached_sku
BEFORE INSERT OR UPDATE OF sku ON public.shop_products
FOR EACH ROW EXECUTE FUNCTION public.erp_guard_detached_sku_v1();
CREATE TRIGGER erp_consume_detached_sku
AFTER INSERT ON public.shop_products
FOR EACH ROW EXECUTE FUNCTION public.erp_consume_detached_sku_v1();

-- Keep the existing composite FK and deletion rule. Volume correction cascades
-- through the mapping, while the order's variant ID and financial facts stay intact.
DO $$
DECLARE
  fk name;
BEGIN
  SELECT conname INTO STRICT fk FROM pg_constraint
  WHERE conrelid = 'public.shop_products'::regclass
    AND confrelid = 'public.perfume_variants'::regclass AND contype = 'f'
    AND pg_get_constraintdef(oid) = 'FOREIGN KEY (perfume_id, volume_ml) REFERENCES perfume_variants(perfume_id, volume_ml) ON DELETE RESTRICT';
  EXECUTE format('ALTER TABLE public.shop_products DROP CONSTRAINT %I,
    ADD CONSTRAINT %I FOREIGN KEY (perfume_id, volume_ml)
    REFERENCES public.perfume_variants(perfume_id, volume_ml) ON UPDATE CASCADE ON DELETE RESTRICT', fk, fk);
END;
$$;


CREATE OR REPLACE FUNCTION public.erp_update_perfume_v1(p_id bigint, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  perfume public.perfumes%ROWTYPE;
  target_brand uuid;
  target_name text;
BEGIN
  IF p_patch ? 'brand_id' THEN
    target_brand := (p_patch->>'brand_id')::uuid;
    PERFORM id FROM public.brands WHERE id = target_brand FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Brand does not exist';
    END IF;
  END IF;

  SELECT * INTO perfume FROM public.perfumes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Perfume does not exist';
  END IF;
  target_brand := COALESCE(target_brand, perfume.brand_id);
  target_name := COALESCE(p_patch->>'name', perfume.name);

  UPDATE public.perfumes
  SET name = target_name,
      brand_id = target_brand,
      gender = CASE WHEN p_patch ? 'gender' THEN p_patch->>'gender' ELSE perfume.gender END,
      fragrance_family = CASE WHEN p_patch ? 'fragrance_family' THEN p_patch->>'fragrance_family' ELSE perfume.fragrance_family END,
      updated_at = clock_timestamp()
  WHERE id = p_id RETURNING * INTO perfume;

  RETURN to_jsonb(perfume) || jsonb_build_object('id', perfume.id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_change_variant_v1(p_perfume_id bigint, p_variant_id bigint, p_volume_ml integer)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  result public.perfume_variants%ROWTYPE;
  has_orders boolean;
BEGIN
  -- The dependency reads must see children committed while this call waits for the row lock.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = '0A000', MESSAGE = 'Variant changes require READ COMMITTED isolation';
  END IF;

  SELECT * INTO result FROM public.perfume_variants
  WHERE id = p_variant_id AND perfume_id = p_perfume_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Variant not found for this perfume';
  END IF;

  IF p_volume_ml IS NOT DISTINCT FROM result.volume_ml THEN
    RETURN jsonb_build_object('id', result.id::text, 'volume_ml', result.volume_ml, 'updated_at', result.updated_at);
  END IF;

  -- Both child FKs acquire key-share locks on this variant. The lock above waits
  -- for in-flight references and holds off new references until this transaction ends.
  SELECT EXISTS (SELECT 1 FROM public.website_order_items WHERE variant_id = result.id) INTO has_orders;

  IF p_volume_ml IS NULL AND has_orders THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Variant is referenced',
      DETAIL = jsonb_build_object('websiteOrders', has_orders, 'marketplaceMappings', false)::text;
  END IF;

  IF p_volume_ml IS NULL THEN
    PERFORM public.erp_detach_skus_v1(p_perfume_id, result.volume_ml, NULL);
    DELETE FROM public.perfume_variants WHERE id = result.id;
  ELSE
    PERFORM volume_ml FROM public.volumes WHERE volume_ml = p_volume_ml FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Volume is not registered';
    END IF;

    UPDATE public.perfume_variants SET volume_ml = p_volume_ml, updated_at = clock_timestamp()
    WHERE id = p_variant_id RETURNING * INTO result;

    UPDATE public.shop_products
    SET updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
    WHERE perfume_id = p_perfume_id AND volume_ml = p_volume_ml;
  END IF;

  RETURN jsonb_build_object('id', result.id::text, 'volume_ml', result.volume_ml, 'updated_at', result.updated_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_perfume_dependencies_v1(p_perfume_id bigint)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  variants bigint;
  mappings bigint;
  order_items bigint;
  images bigint;
  unverified_keys bigint;
  reserved_image boolean := false;
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

  IF images = 0 AND to_regclass('public.erp_master_publications') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.erp_master_publications WHERE perfume_id = $1)'
      INTO reserved_image USING p_perfume_id;
  END IF;

  RETURN jsonb_build_object(
    'variants', variants, 'skuMappings', mappings, 'websiteOrderItems', order_items,
    'images', images + reserved_image::integer, 'unverifiedForeignKeys', unverified_keys,
    'canDelete', order_items = 0 AND images = 0 AND NOT reserved_image AND unverified_keys = 0
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_delete_perfume_v1(p_perfume_id bigint)
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

  PERFORM public.erp_detach_skus_v1(p_perfume_id, NULL, NULL);
  DELETE FROM public.perfumes WHERE id = p_perfume_id;
  RETURN jsonb_build_object('id', p_perfume_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_create_sku_v1(
  p_perfume_id bigint, p_shop_id uuid, p_volume_ml integer, p_sku text,
  p_active boolean, p_archived boolean, p_allow_replay boolean
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  mapping public.shop_products%ROWTYPE;
  shop_code text;
  registered boolean;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = '0A000', MESSAGE = 'SKU changes require READ COMMITTED isolation';
  END IF;

  SELECT code INTO shop_code FROM public.shops WHERE id = p_shop_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'PT404', MESSAGE = 'Shop not found';
  END IF;

  PERFORM id FROM public.perfume_variants
  WHERE perfume_id = p_perfume_id AND volume_ml = p_volume_ml FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Target perfume and volume do not form a registered variant';
  END IF;

  IF p_sku IS NULL OR length(p_sku) NOT BETWEEN 1 AND 200 OR p_sku <> btrim(p_sku) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid SKU';
  END IF;

  SELECT * INTO mapping FROM public.shop_products WHERE sku = p_sku FOR KEY SHARE;
  IF NOT FOUND THEN
    IF lower(shop_code) = 'raspiv' AND p_active AND NOT p_archived AND EXISTS (
      SELECT 1 FROM public.shop_products
      WHERE shop_id = p_shop_id AND perfume_id = p_perfume_id AND volume_ml = p_volume_ml
        AND is_active AND NOT is_archived
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'This Raspiv variant already has an eligible mapping';
    END IF;

    INSERT INTO public.shop_products (perfume_id, shop_id, volume_ml, sku, is_active, is_archived, updated_at)
    VALUES (p_perfume_id, p_shop_id, p_volume_ml,
            p_sku, p_active, p_archived, clock_timestamp())
    ON CONFLICT (sku) DO NOTHING RETURNING * INTO mapping;
    registered := FOUND;
    IF NOT registered THEN
      SELECT * INTO mapping FROM public.shop_products WHERE sku = p_sku FOR KEY SHARE;
    END IF;
  ELSE
    registered := false;
  END IF;

  IF NOT registered AND NOT (
    COALESCE(p_allow_replay, false) AND mapping.id IS NOT NULL AND mapping.perfume_id = p_perfume_id
      AND mapping.shop_id = p_shop_id AND mapping.volume_ml = p_volume_ml
      AND mapping.is_active = p_active AND mapping.is_archived = p_archived
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'SKU already registered';
  END IF;

  RETURN to_jsonb(mapping) || jsonb_build_object('perfume_id', mapping.perfume_id::text, 'replayed', NOT registered);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_update_sku_v1(
  p_perfume_id bigint, p_sku_id uuid, p_expected_updated_at timestamptz, p_patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  mapping public.shop_products%ROWTYPE;
  shop_code text;
  marketplace_name text;
  target_perfume bigint;
  target_shop uuid;
  target_volume integer;
  target_sku text;
  active boolean;
  archived boolean;
BEGIN
  SELECT * INTO mapping FROM public.shop_products
  WHERE id = p_sku_id AND perfume_id = p_perfume_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'PT404', MESSAGE = 'Mapping not found for this perfume';
  END IF;
  IF mapping.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Mapping changed since it was loaded';
  END IF;

  target_perfume := coalesce((p_patch->>'perfume_id')::bigint, mapping.perfume_id);
  target_shop := coalesce((p_patch->>'shop_id')::uuid, mapping.shop_id);
  target_volume := coalesce((p_patch->>'volume_ml')::integer, mapping.volume_ml);
  target_sku := coalesce(p_patch->>'sku', mapping.sku);
  active := coalesce((p_patch->>'is_active')::boolean, mapping.is_active);
  archived := coalesce((p_patch->>'is_archived')::boolean, mapping.is_archived);

  SELECT code, marketplace INTO shop_code, marketplace_name FROM public.shops WHERE id = target_shop FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'PT404', MESSAGE = 'Shop not found';
  END IF;
  IF (active, archived) IS DISTINCT FROM (mapping.is_active, mapping.is_archived)
     AND (lower(shop_code) = 'raspiv' OR lower(marketplace_name) <> 'ozon') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'This shop does not support status corrections';
  END IF;

  PERFORM id FROM public.perfume_variants
  WHERE perfume_id = target_perfume AND volume_ml = target_volume FOR UPDATE;
  IF NOT FOUND OR length(target_sku) NOT BETWEEN 1 AND 200 OR target_sku <> btrim(target_sku) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid variant or SKU';
  END IF;

  IF lower(shop_code) = 'raspiv' AND active AND NOT archived AND EXISTS (
    SELECT 1 FROM public.shop_products
    WHERE shop_id = target_shop AND perfume_id = target_perfume AND volume_ml = target_volume
      AND is_active AND NOT is_archived AND id <> mapping.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'This Raspiv variant already has an eligible mapping';
  END IF;

  UPDATE public.shop_products
  SET perfume_id = target_perfume, shop_id = target_shop, volume_ml = target_volume,
      sku = target_sku, is_active = active, is_archived = archived,
      updated_at = greatest(clock_timestamp(), mapping.updated_at + interval '1 microsecond')
  WHERE id = mapping.id RETURNING * INTO mapping;
  RETURN to_jsonb(mapping) || jsonb_build_object('perfume_id', mapping.perfume_id::text);
END;
$$;

CREATE FUNCTION public.erp_unmatch_sku_v1(
  p_perfume_id bigint, p_sku_id uuid, p_expected_updated_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  version timestamptz;
BEGIN
  SELECT updated_at INTO version FROM public.shop_products
  WHERE id = p_sku_id AND perfume_id = p_perfume_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'PT404', MESSAGE = 'Mapping not found for this perfume';
  END IF;
  IF p_expected_updated_at IS NOT NULL AND version IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Mapping changed since it was loaded';
  END IF;
  PERFORM public.erp_detach_skus_v1(p_perfume_id, NULL, p_sku_id);
  RETURN jsonb_build_object('id', p_sku_id);
END;
$$;
REVOKE ALL ON FUNCTION public.erp_unmatch_sku_v1(bigint,uuid,timestamptz)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.erp_unmatch_sku_v1(bigint,uuid,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.erp_delete_sku_v1(p_perfume_id bigint, p_sku_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
  SELECT public.erp_unmatch_sku_v1(p_perfume_id, p_sku_id, NULL);
$$;

COMMIT;
