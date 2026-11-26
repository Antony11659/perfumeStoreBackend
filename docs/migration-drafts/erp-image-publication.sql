-- OWNER REVIEW DRAFT. Run erp-image-publication-audit.sql first. Do not add to automated migrations as-is.
BEGIN;

-- Reuse the audited indexes and constraints. Fail closed if their definitions drift.
DO $review$
DECLARE
  image_table regclass := 'public.perfume_images'::regclass;
  before_access jsonb;
  after_access jsonb;
  snapshot_sql text := $snapshot$
    SELECT jsonb_object_agg(role_name || ':' || scope, allowed)
    FROM (
      SELECT role_name, privilege AS scope,
             has_table_privilege(role_name, 'public.perfume_images', privilege) AS allowed
      FROM unnest(ARRAY['anon','authenticated','service_role']) AS roles(role_name)
      CROSS JOIN unnest(CASE WHEN role_name = 'service_role'
        THEN ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
        ELSE ARRAY['SELECT'] END) AS privileges(privilege)
      UNION ALL
      SELECT role_name, a.attnum || ':' || privilege,
             has_column_privilege(role_name, a.attrelid, a.attnum, privilege)
      FROM pg_catalog.pg_attribute a
      CROSS JOIN unnest(ARRAY['anon','authenticated','service_role']) AS roles(role_name)
      CROSS JOIN unnest(CASE WHEN role_name = 'service_role'
        THEN ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] ELSE ARRAY['SELECT'] END) AS privileges(privilege)
      WHERE a.attrelid = 'public.perfume_images'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    ) access
  $snapshot$;
  columns text;
  browser_role text;
  maintain_supported boolean := current_setting('server_version_num')::integer >= 170000;
  service_maintain boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = image_table AND c.relname = 'perfume_images_one_primary_idx'
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
      AND i.indnkeyatts = 1 AND i.indexprs IS NULL AND a.attname = 'perfume_id'
      AND regexp_replace(lower(pg_get_expr(i.indpred, i.indrelid)), '[[:space:]()]', '', 'g')
        IN ('is_primary','is_primaryistrue','is_primary=true','true=is_primary')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = image_table AND c.relname = 'perfume_images_storage_key_unique'
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
      AND i.indnkeyatts = 1 AND i.indexprs IS NULL AND i.indpred IS NULL AND a.attname = 'storage_key'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    JOIN pg_catalog.pg_attribute b ON b.attrelid = i.indrelid AND b.attnum = i.indkey[1]
    WHERE i.indrelid = image_table AND c.relname = 'perfume_images_perfume_id_sort_order_key'
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
      AND i.indnkeyatts = 2 AND i.indexprs IS NULL AND i.indpred IS NULL
      AND a.attname = 'perfume_id' AND b.attname = 'sort_order'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = image_table AND c.relname = 'perfume_images_pkey'
      AND i.indisprimary AND i.indisvalid AND i.indisready AND i.indislive
  ) OR (SELECT count(*) FROM pg_catalog.pg_constraint
        WHERE conrelid = image_table AND convalidated AND
          ((contype = 'c' AND conname IN ('perfume_images_master_standard_check','perfume_images_metadata_check','perfume_images_image_type_check'))
           OR (contype = 'f' AND conname = 'perfume_images_perfume_id_fkey' AND confrelid = 'public.perfumes'::regclass))) <> 4 THEN
    RAISE EXCEPTION 'Audited perfume_images indexes or constraints differ. Review before applying.';
  END IF;

  EXECUTE snapshot_sql INTO before_access;
  IF maintain_supported THEN
    service_maintain := has_table_privilege('service_role', image_table, 'MAINTAIN');
  END IF;
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO columns
  FROM pg_catalog.pg_attribute WHERE attrelid = image_table AND attnum > 0 AND NOT attisdropped;

  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON public.perfume_images FROM PUBLIC, anon, authenticated RESTRICT;
  EXECUTE format('REVOKE INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)
                  ON public.perfume_images FROM PUBLIC, anon, authenticated RESTRICT', columns);
  IF maintain_supported THEN
    EXECUTE 'REVOKE MAINTAIN ON public.perfume_images FROM PUBLIC, anon, authenticated RESTRICT';
  END IF;

  EXECUTE snapshot_sql INTO after_access;
  IF before_access IS DISTINCT FROM after_access OR
     (maintain_supported AND service_maintain IS DISTINCT FROM has_table_privilege('service_role', image_table, 'MAINTAIN')) THEN
    RAISE EXCEPTION 'Permission changes would affect catalog reads or service_role access. Review grants before applying.';
  END IF;

  FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF has_table_privilege(browser_role, image_table, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       OR has_any_column_privilege(browser_role, image_table, 'INSERT, UPDATE, REFERENCES')
       OR (maintain_supported AND has_table_privilege(browser_role, image_table, 'MAINTAIN')) THEN
      RAISE EXCEPTION 'Role % retains effective image-table write or maintenance privileges. Review inherited grants.', browser_role;
    END IF;
  END LOOP;
END;
$review$;

CREATE TABLE public.erp_master_publications (
  perfume_id bigint PRIMARY KEY,
  approval_job_id uuid NOT NULL UNIQUE,
  staff_id uuid NOT NULL,
  candidate_sha256 text NOT NULL CHECK (candidate_sha256 ~ '^[a-f0-9]{64}$'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  storage_key text NOT NULL UNIQUE,
  image_url text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 80000 AND 200000),
  approved_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  -- Keep audit IDs without adding a foreign key that could change existing image deletion or perfume cascades.
  image_id bigint UNIQUE,
  CHECK ((image_id IS NULL) = (published_at IS NULL))
);
ALTER TABLE public.erp_master_publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_master_publications FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.erp_publish_master_v1(
  p_perfume_id bigint, p_job_id uuid, p_staff_id uuid, p_candidate_sha256 text,
  p_source_sha256 text, p_storage_key text, p_image_url text, p_size_bytes integer, p_commit boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  archived boolean;
  attempt public.erp_master_publications%ROWTYPE;
  saved_id bigint;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = '0A000', MESSAGE = 'Image publication requires READ COMMITTED isolation';
  END IF;

  -- Call the existing service-role RPC with all data arguments NULL and p_commit=false to
  -- verify the actual gateway transaction. Return before taking locks or writing rows.
  IF p_perfume_id IS NULL AND p_job_id IS NULL AND p_staff_id IS NULL AND
     p_candidate_sha256 IS NULL AND p_source_sha256 IS NULL AND p_storage_key IS NULL AND
     p_image_url IS NULL AND p_size_bytes IS NULL AND p_commit IS FALSE THEN
    RETURN jsonb_build_object('state', 'isolation_verified', 'transaction_isolation',
                              current_setting('transaction_isolation'));
  END IF;

  IF p_perfume_id IS NULL OR p_perfume_id <= 0 OR p_job_id IS NULL OR p_staff_id IS NULL OR
     p_candidate_sha256 IS NULL OR p_candidate_sha256 !~ '^[a-f0-9]{64}$' OR
     p_source_sha256 IS NULL OR p_source_sha256 !~ '^[a-f0-9]{64}$' OR
     p_storage_key IS DISTINCT FROM ('perfume-library/perfumes/' || p_perfume_id || '/master-v1-' || p_candidate_sha256 || '.webp') OR
     p_image_url IS NULL OR right(p_image_url, length(p_storage_key) + 1) <> '/' || p_storage_key OR
     p_image_url !~ '^https?://' OR p_size_bytes IS NULL OR p_size_bytes NOT BETWEEN 80000 AND 200000 OR p_commit IS NULL THEN
    RAISE EXCEPTION 'Invalid master publication arguments' USING ERRCODE = '22023';
  END IF;

  -- Serialize reservation/registration and block archive/delete while this transaction decides.
  SELECT is_archived INTO archived FROM public.perfumes WHERE id = p_perfume_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('state', 'not_found'); END IF;
  IF archived THEN RETURN jsonb_build_object('state', 'archived'); END IF;

  SELECT * INTO attempt FROM public.erp_master_publications WHERE perfume_id = p_perfume_id;
  IF FOUND THEN
    IF attempt.staff_id <> p_staff_id OR attempt.candidate_sha256 <> p_candidate_sha256 OR
       attempt.source_sha256 <> p_source_sha256 OR attempt.storage_key <> p_storage_key OR
       attempt.image_url <> p_image_url OR attempt.size_bytes <> p_size_bytes THEN
      RETURN jsonb_build_object('state', CASE WHEN attempt.image_id IS NULL THEN 'publication_conflict' ELSE 'primary_exists' END);
    END IF;
    IF attempt.image_id IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM public.perfume_images WHERE id = attempt.image_id AND perfume_id = p_perfume_id
                 AND is_primary AND image_type = 'master' AND storage_key = p_storage_key AND image_url = p_image_url) THEN
        RETURN jsonb_build_object('state', 'published', 'image_id', attempt.image_id::text);
      END IF;
      RETURN jsonb_build_object('state', 'publication_conflict');
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.perfume_images WHERE perfume_id = p_perfume_id AND is_primary) THEN
    RETURN jsonb_build_object('state', 'primary_exists');
  END IF;
  IF EXISTS (SELECT 1 FROM public.perfume_images WHERE storage_key = p_storage_key) THEN
    RETURN jsonb_build_object('state', 'publication_conflict');
  END IF;

  IF NOT p_commit THEN
    IF attempt.perfume_id IS NULL THEN
      INSERT INTO public.erp_master_publications
        (perfume_id, approval_job_id, staff_id, candidate_sha256, source_sha256, storage_key, image_url, size_bytes)
      VALUES (p_perfume_id, p_job_id, p_staff_id, p_candidate_sha256, p_source_sha256, p_storage_key, p_image_url, p_size_bytes);
    END IF;
    RETURN jsonb_build_object('state', 'ready');
  END IF;
  IF attempt.perfume_id IS NULL THEN RETURN jsonb_build_object('state', 'publication_conflict'); END IF;

  INSERT INTO public.perfume_images
    (perfume_id, image_url, sort_order, is_primary, storage_key, image_type, width_px, height_px, size_bytes, mime_type)
  VALUES (p_perfume_id, p_image_url,
    (SELECT coalesce(max(sort_order), 0) + 1 FROM public.perfume_images WHERE perfume_id = p_perfume_id),
    true, p_storage_key, 'master', 900, 1200, p_size_bytes, 'image/webp')
  ON CONFLICT DO NOTHING RETURNING id INTO saved_id;
  IF saved_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.perfume_images WHERE perfume_id = p_perfume_id AND is_primary) THEN
      RETURN jsonb_build_object('state', 'primary_exists');
    END IF;
    RETURN jsonb_build_object('state', 'publication_conflict');
  END IF;
  UPDATE public.erp_master_publications SET image_id = saved_id, published_at = now() WHERE perfume_id = p_perfume_id;
  RETURN jsonb_build_object('state', 'published', 'image_id', saved_id::text);
END;
$$;
REVOKE ALL ON FUNCTION public.erp_publish_master_v1(bigint, uuid, uuid, text, text, text, text, integer, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_publish_master_v1(bigint, uuid, uuid, text, text, text, text, integer, boolean)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
