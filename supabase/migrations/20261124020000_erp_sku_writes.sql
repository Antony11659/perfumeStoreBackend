BEGIN;

CREATE FUNCTION public.erp_create_sku_v1(
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
    VALUES (p_perfume_id, p_shop_id, p_volume_ml, p_sku, p_active, p_archived, clock_timestamp())
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

CREATE FUNCTION public.erp_update_sku_v1(
  p_perfume_id bigint, p_sku_id uuid, p_expected_updated_at timestamptz, p_patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  mapping public.shop_products%ROWTYPE;
  shop_code text;
  marketplace_name text;
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

  -- Packaging resolves historical and current items by global SKU without status filters.
  -- There is no mapping-level historical reference or proof of non-use.
  IF (p_patch ? 'sku' AND p_patch->>'sku' IS DISTINCT FROM mapping.sku)
     OR (p_patch ? 'perfume_id' AND (p_patch->>'perfume_id')::bigint IS DISTINCT FROM mapping.perfume_id)
     OR (p_patch ? 'shop_id' AND (p_patch->>'shop_id')::uuid IS DISTINCT FROM mapping.shop_id)
     OR (p_patch ? 'volume_ml' AND (p_patch->>'volume_ml')::integer IS DISTINCT FROM mapping.volume_ml) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Existing SKU identity cannot be changed safely';
  END IF;

  active := COALESCE((p_patch->>'is_active')::boolean, mapping.is_active);
  archived := COALESCE((p_patch->>'is_archived')::boolean, mapping.is_archived);
  IF active IS DISTINCT FROM mapping.is_active OR archived IS DISTINCT FROM mapping.is_archived THEN
    SELECT code, marketplace INTO shop_code, marketplace_name FROM public.shops WHERE id = mapping.shop_id FOR SHARE;
    IF NOT FOUND OR lower(shop_code) = 'raspiv' OR lower(marketplace_name) <> 'ozon' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Existing fulfillment cannot safely exclude this status change';
    END IF;

    UPDATE public.shop_products
    SET is_active = active, is_archived = archived,
        updated_at = greatest(clock_timestamp(), mapping.updated_at + interval '1 microsecond')
    WHERE id = mapping.id RETURNING * INTO mapping;
  END IF;

  RETURN to_jsonb(mapping) || jsonb_build_object('perfume_id', mapping.perfume_id::text);
END;
$$;

-- A permanent delete is surfaced as a blocked operation until historical
-- marketplace use can be established independently of status.
CREATE FUNCTION public.erp_delete_sku_v1(p_perfume_id bigint, p_sku_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  PERFORM id FROM public.shop_products WHERE id = p_sku_id AND perfume_id = p_perfume_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'PT404', MESSAGE = 'Mapping not found for this perfume';
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Historical use of this SKU cannot be ruled out';
END;
$$;

REVOKE EXECUTE ON FUNCTION
  public.erp_create_sku_v1(bigint,uuid,integer,text,boolean,boolean,boolean),
  public.erp_update_sku_v1(bigint,uuid,timestamptz,jsonb),
  public.erp_delete_sku_v1(bigint,uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.erp_create_sku_v1(bigint,uuid,integer,text,boolean,boolean,boolean),
  public.erp_update_sku_v1(bigint,uuid,timestamptz,jsonb),
  public.erp_delete_sku_v1(bigint,uuid)
TO service_role;

COMMIT;
