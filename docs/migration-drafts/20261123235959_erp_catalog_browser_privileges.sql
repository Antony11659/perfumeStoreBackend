-- REVIEW ONLY until the application consumer and effective-grant inventory is approved.
-- Apply after the existing website order/payment/delivery migrations and before ERP catalog writes.
BEGIN;
SET LOCAL search_path = pg_catalog;


DO $review$
DECLARE
  target regclass;
  sequence_target regclass;
  role_name text;
  table_operations text[] := ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
  column_operations CONSTANT text[] := ARRAY['SELECT','INSERT','UPDATE','REFERENCES'];
  sequence_operations CONSTANT text[] := ARRAY['USAGE','SELECT','UPDATE'];
  service_table_before boolean[];
  service_columns_before jsonb;
  service_sequence_before boolean[];
  service_columns_after jsonb;
  signature text;
  routine regprocedure;
BEGIN
  IF current_setting('server_version_num')::integer >= 170000 THEN
    table_operations := array_append(table_operations, 'MAINTAIN');
  END IF;

  FOREACH target IN ARRAY ARRAY[
    'public.brands', 'public.perfumes', 'public.perfume_variants', 'public.volumes',
    'public.shops', 'public.shop_products', 'public.perfume_images', 'public.prices',
    'public.website_orders', 'public.website_order_items'
  ]::regclass[] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = target AND relrowsecurity)
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = target) THEN
      RAISE EXCEPTION 'RLS or policy drift on %; review the planned revocation', target;
    END IF;

    SELECT ARRAY(SELECT has_table_privilege('service_role', target, op) FROM unnest(table_operations) AS op)
      INTO service_table_before;
    SELECT COALESCE(jsonb_agg(has_column_privilege('service_role', target, a.attnum, p.op)
                             ORDER BY a.attnum, p.op), '[]'::jsonb)
      INTO service_columns_before
    FROM pg_catalog.pg_attribute AS a
    CROSS JOIN unnest(column_operations) AS p(op)
    WHERE a.attrelid = target AND a.attnum > 0 AND NOT a.attisdropped;

    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC, anon, authenticated', target);

    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM unnest(table_operations) AS op WHERE has_table_privilege(role_name, target, op))
         OR EXISTS (SELECT 1 FROM unnest(column_operations) AS op WHERE has_any_column_privilege(role_name, target, op)) THEN
        RAISE EXCEPTION 'Residual effective privileges for % on %; review membership or other grantors', role_name, target;
      END IF;
    END LOOP;

    SELECT COALESCE(jsonb_agg(has_column_privilege('service_role', target, a.attnum, p.op)
                             ORDER BY a.attnum, p.op), '[]'::jsonb)
      INTO service_columns_after
    FROM pg_catalog.pg_attribute AS a
    CROSS JOIN unnest(column_operations) AS p(op)
    WHERE a.attrelid = target AND a.attnum > 0 AND NOT a.attisdropped;

    IF service_table_before IS DISTINCT FROM
         ARRAY(SELECT has_table_privilege('service_role', target, op) FROM unnest(table_operations) AS op)
       OR service_columns_before IS DISTINCT FROM service_columns_after THEN
      RAISE EXCEPTION 'Effective service_role privileges changed on %; review dependent grants', target;
    END IF;

    FOR sequence_target IN
      SELECT DISTINCT seq.oid::regclass
      FROM pg_catalog.pg_depend AS d
      JOIN pg_catalog.pg_class AS seq ON seq.oid = d.objid
      WHERE d.classid = 'pg_catalog.pg_class'::regclass
        AND d.refclassid = 'pg_catalog.pg_class'::regclass
        AND d.refobjid = target
        AND d.refobjsubid > 0
        AND d.deptype IN ('a', 'i')
        AND seq.relkind = 'S'
    LOOP
      SELECT ARRAY(SELECT has_sequence_privilege('service_role', sequence_target, op) FROM unnest(sequence_operations) AS op)
        INTO service_sequence_before;
      EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM PUBLIC, anon, authenticated', sequence_target);
      FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM unnest(sequence_operations) AS op WHERE has_sequence_privilege(role_name, sequence_target, op)) THEN
          RAISE EXCEPTION 'Residual effective privileges for % on sequence %', role_name, sequence_target;
        END IF;
      END LOOP;
      IF service_sequence_before IS DISTINCT FROM
         ARRAY(SELECT has_sequence_privilege('service_role', sequence_target, op) FROM unnest(sequence_operations) AS op) THEN
        RAISE EXCEPTION 'Effective service_role privileges changed on sequence %', sequence_target;
      END IF;
    END LOOP;
  END LOOP;

  -- Assert known workflow RPCs. Inspect unexpected routines separately before rollout.
  -- Grant corrections for preexisting functions require independently reviewed changes.
  FOREACH signature IN ARRAY ARRAY[
    'public.persist_website_order_v1(uuid,text,jsonb)',
    'public.reserve_website_order_payment_v1(bigint)',
    'public.save_website_order_payment_v1(bigint,text,text)',
    'public.confirm_website_order_payment_v1(bigint,text,text,bigint)',
    'public.claim_website_delivery_creation_v1(bigint,uuid,text,boolean)',
    'public.website_delivery_auto_eligible_v1(bigint,timestamptz)',
    'public.confirm_website_order_payment_and_queue_delivery_v1(bigint,text,text,bigint,timestamptz)',
    'public.finish_website_delivery_job_v1(bigint,uuid,text)',
    'public.claim_website_delivery_job_v1(uuid,timestamptz)',
    'public.claim_website_delivery_for_job_v1(bigint,uuid,timestamptz,uuid,text)',
    'public.protect_website_delivery_claim_v1()'
  ] LOOP
    routine := to_regprocedure(signature);
    IF routine IS NULL THEN
      RAISE EXCEPTION 'Expected routine missing: %', signature;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid = routine AND prosecdef)
       OR has_function_privilege('anon', routine, 'EXECUTE')
       OR has_function_privilege('authenticated', routine, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc AS p
         CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
         WHERE p.oid = routine AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
       )
       OR (signature <> 'public.protect_website_delivery_claim_v1()'
           AND NOT has_function_privilege('service_role', routine, 'EXECUTE')) THEN
      RAISE EXCEPTION 'Unexpected execution privileges or security mode on %', signature;
    END IF;
  END LOOP;
END
$review$;

COMMIT;
