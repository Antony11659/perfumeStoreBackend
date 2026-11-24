BEGIN;

CREATE FUNCTION public.erp_create_brand_v1(p_name text, p_country text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  brand public.brands%ROWTYPE;
BEGIN
  INSERT INTO public.brands (name, country) VALUES (p_name, p_country)
  RETURNING * INTO brand;
  RETURN to_jsonb(brand);
END;
$$;

CREATE FUNCTION public.erp_create_perfume_v1(
  p_name text, p_brand_id uuid, p_gender text, p_fragrance_family text, p_volumes integer[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  perfume public.perfumes%ROWTYPE;
BEGIN
  IF COALESCE(cardinality(p_volumes), 0) = 0 OR EXISTS (
    SELECT 1
    FROM unnest(p_volumes) AS choice(volume_ml)
    LEFT JOIN public.volumes AS allowed USING (volume_ml)
    WHERE allowed.volume_ml IS NULL
  ) OR cardinality(p_volumes) <> (
    SELECT count(DISTINCT volume_ml) FROM unnest(p_volumes) AS choice(volume_ml)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid initial volumes';
  END IF;

  INSERT INTO public.perfumes (name, brand_id, gender, fragrance_family)
  VALUES (p_name, p_brand_id, p_gender, p_fragrance_family)
  RETURNING * INTO perfume;

  INSERT INTO public.perfume_variants (perfume_id, volume_ml)
  SELECT perfume.id, volume_ml FROM unnest(p_volumes) AS choice(volume_ml);

  RETURN to_jsonb(perfume) || jsonb_build_object('id', perfume.id::text);
END;
$$;

-- Callers hold a FOR UPDATE lock on the perfume before taking variant locks.
-- The referenced-key locks used by FK inserts conflict with these locks.
CREATE FUNCTION public.erp_assert_perfume_identity_unused_v1(p_id bigint)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  PERFORM id FROM public.perfume_variants WHERE perfume_id = p_id ORDER BY id FOR UPDATE;
  IF EXISTS (
    SELECT 1
    FROM public.website_order_items AS item
    JOIN public.perfume_variants AS variant ON variant.id = item.variant_id
    WHERE variant.perfume_id = p_id
  ) OR EXISTS (
    SELECT 1 FROM public.shop_products WHERE perfume_id = p_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Catalog identity has order or marketplace dependencies';
  END IF;
END;
$$;

CREATE FUNCTION public.erp_update_perfume_v1(p_id bigint, p_patch jsonb)
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

  IF target_name IS DISTINCT FROM perfume.name OR target_brand IS DISTINCT FROM perfume.brand_id THEN
    PERFORM public.erp_assert_perfume_identity_unused_v1(p_id);
  END IF;

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

CREATE FUNCTION public.erp_update_brand_v1(p_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  brand public.brands%ROWTYPE;
  perfume_id bigint;
  target_name text;
BEGIN
  SELECT * INTO brand FROM public.brands WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Brand does not exist';
  END IF;

  target_name := COALESCE(p_patch->>'name', brand.name);
  IF target_name IS DISTINCT FROM brand.name THEN
    FOR perfume_id IN SELECT id FROM public.perfumes WHERE brand_id = p_id ORDER BY id FOR UPDATE LOOP
      PERFORM public.erp_assert_perfume_identity_unused_v1(perfume_id);
    END LOOP;
  END IF;

  UPDATE public.brands
  SET name = target_name,
      country = CASE WHEN p_patch ? 'country' THEN p_patch->>'country' ELSE brand.country END,
      updated_at = clock_timestamp()
  WHERE id = p_id RETURNING * INTO brand;

  RETURN to_jsonb(brand);
END;
$$;

REVOKE EXECUTE ON FUNCTION
  public.erp_create_brand_v1(text, text),
  public.erp_create_perfume_v1(text, uuid, text, text, integer[]),
  public.erp_assert_perfume_identity_unused_v1(bigint),
  public.erp_update_perfume_v1(bigint, jsonb),
  public.erp_update_brand_v1(uuid, jsonb)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.erp_create_brand_v1(text, text),
  public.erp_create_perfume_v1(text, uuid, text, text, integer[]),
  public.erp_assert_perfume_identity_unused_v1(bigint),
  public.erp_update_perfume_v1(bigint, jsonb),
  public.erp_update_brand_v1(uuid, jsonb)
TO service_role;

COMMIT;
