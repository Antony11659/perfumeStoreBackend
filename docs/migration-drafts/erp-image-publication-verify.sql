-- Owner verification after an approved installation. One read-only statement.
-- The backend isolation proof is a separate no-write call through Supabase REST.
WITH target AS (
  SELECT oid, relrowsecurity, relforcerowsecurity, relowner
  FROM pg_catalog.pg_class WHERE oid IN (
    to_regclass('public.perfume_images'), to_regclass('public.erp_master_publications')
  )
), routines AS (
  SELECT oid, proowner, proacl, prosecdef, proconfig
  FROM pg_catalog.pg_proc WHERE oid IN (
    to_regprocedure('public.erp_publish_master_v1(bigint,uuid,uuid,text,text,text,text,integer,boolean)'),
    to_regprocedure('public.erp_perfume_dependencies_v1(bigint)')
  )
), roles AS (
  SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated','service_role','authenticator')
)
SELECT jsonb_build_object(
  'tables', coalesce((SELECT jsonb_agg(jsonb_build_object(
    'table', t.oid::regclass::text, 'rls_enabled', t.relrowsecurity, 'rls_forced', t.relforcerowsecurity,
    'owner', pg_get_userbyid(t.relowner),
    'policy_count', (SELECT count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid=t.oid),
    'effective_access', (SELECT jsonb_object_agg(r.rolname, jsonb_build_object(
      'select', has_table_privilege(r.oid,t.oid,'SELECT'),
      'write_or_trigger', has_table_privilege(r.oid,t.oid,'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      'column_write_or_reference', has_any_column_privilege(r.oid,t.oid,'INSERT, UPDATE, REFERENCES'),
      'maintain', CASE WHEN current_setting('server_version_num')::integer >= 170000
        THEN has_table_privilege(r.oid,t.oid,'MAINTAIN') END))
      FROM roles r)
    ) ORDER BY t.oid::regclass::text) FROM target t), '[]'),
  'image_indexes', coalesce((SELECT jsonb_agg(jsonb_build_object(
    'name', i.indexrelid::regclass::text, 'definition', pg_get_indexdef(i.indexrelid),
    'valid', i.indisvalid, 'ready', i.indisready, 'live', i.indislive)
    ORDER BY i.indexrelid::regclass::text)
    FROM pg_catalog.pg_index i WHERE i.indrelid=to_regclass('public.perfume_images')), '[]'),
  'image_constraints_and_inbound_fks', coalesce((SELECT jsonb_agg(jsonb_build_object(
    'name', c.conname, 'relation', c.conrelid::regclass::text, 'definition', pg_get_constraintdef(c.oid),
    'validated', c.convalidated) ORDER BY c.conname) FROM pg_catalog.pg_constraint c
    WHERE c.conrelid=to_regclass('public.perfume_images') OR
          (c.contype='f' AND c.confrelid=to_regclass('public.perfume_images'))), '[]'),
  'routine_permissions', coalesce((SELECT jsonb_agg(jsonb_build_object(
    'routine', f.oid::regprocedure::text, 'owner', pg_get_userbyid(f.proowner), 'security_definer', f.prosecdef,
    'search_path', (SELECT value FROM unnest(f.proconfig) u(value) WHERE value LIKE 'search_path=%'),
    'public_execute', EXISTS (SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a
                              WHERE a.grantee=0 AND a.privilege_type='EXECUTE'),
    'execute', (SELECT jsonb_object_agg(r.rolname, has_function_privilege(r.oid,f.oid,'EXECUTE')) FROM roles r))
    ORDER BY f.oid::regprocedure::text) FROM routines f), '[]'),
  'duplicate_primary_groups', (SELECT count(*) FROM (
    SELECT perfume_id FROM public.perfume_images WHERE is_primary GROUP BY perfume_id HAVING count(*)>1
  ) duplicates),
  'duplicate_storage_key_groups', (SELECT count(*) FROM (
    SELECT storage_key FROM public.perfume_images GROUP BY storage_key HAVING count(*)>1
  ) duplicates),
  'creed_229', (SELECT jsonb_build_object('archived', p.is_archived,
     'image_count', (SELECT count(*) FROM public.perfume_images i WHERE i.perfume_id=p.id))
     FROM public.perfumes p WHERE p.id=229),
  'migration_ledger_exists', to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
) AS publication_verification;
