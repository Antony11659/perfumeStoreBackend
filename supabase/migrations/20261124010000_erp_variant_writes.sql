BEGIN;

CREATE FUNCTION public.erp_create_variant_v1(p_perfume_id bigint, p_volume_ml integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  result public.perfume_variants%ROWTYPE;
BEGIN
  PERFORM id FROM public.perfumes WHERE id = p_perfume_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Perfume not found';
  END IF;

  PERFORM volume_ml FROM public.volumes WHERE volume_ml = p_volume_ml FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Volume is not registered';
  END IF;

  INSERT INTO public.perfume_variants (perfume_id, volume_ml, updated_at)
  VALUES (p_perfume_id, p_volume_ml, clock_timestamp())
  RETURNING * INTO result;

  RETURN jsonb_build_object('id', result.id::text, 'volume_ml', result.volume_ml, 'updated_at', result.updated_at);
END;
$$;

-- A null volume is an explicit delete request from the trusted backend.
CREATE FUNCTION public.erp_change_variant_v1(p_perfume_id bigint, p_variant_id bigint, p_volume_ml integer)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  result public.perfume_variants%ROWTYPE;
  has_orders boolean;
  has_mappings boolean;
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
  SELECT EXISTS (SELECT 1 FROM public.website_order_items WHERE variant_id = result.id),
         EXISTS (SELECT 1 FROM public.shop_products
                 WHERE perfume_id = result.perfume_id AND volume_ml = result.volume_ml)
  INTO has_orders, has_mappings;

  IF has_orders OR has_mappings THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Variant is referenced',
      DETAIL = jsonb_build_object('websiteOrders', has_orders, 'marketplaceMappings', has_mappings)::text;
  END IF;

  IF p_volume_ml IS NULL THEN
    DELETE FROM public.perfume_variants WHERE id = result.id;
  ELSE
    PERFORM volume_ml FROM public.volumes WHERE volume_ml = p_volume_ml FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Volume is not registered';
    END IF;

    UPDATE public.perfume_variants SET volume_ml = p_volume_ml, updated_at = clock_timestamp()
    WHERE id = p_variant_id RETURNING * INTO result;
  END IF;

  RETURN jsonb_build_object('id', result.id::text, 'volume_ml', result.volume_ml, 'updated_at', result.updated_at);
END;
$$;

REVOKE EXECUTE ON FUNCTION
  public.erp_create_variant_v1(bigint, integer),
  public.erp_change_variant_v1(bigint, bigint, integer)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.erp_create_variant_v1(bigint, integer),
  public.erp_change_variant_v1(bigint, bigint, integer)
TO service_role;

COMMIT;
