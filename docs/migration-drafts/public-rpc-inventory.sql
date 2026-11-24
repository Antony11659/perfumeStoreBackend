-- Read-only production preflight. Does not return function bodies or business rows.
SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
  p.proowner::regrole::text AS owner,
  p.prosecdef AS security_definer,
  p.prorettype::regtype::text AS return_type,
  (SELECT value FROM unnest(p.proconfig) AS value WHERE value LIKE 'search_path=%') AS search_path,
  EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS acl
    WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ) AS public_execute,
  pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
  pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS d
    WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
  ) AS extension_owned
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f'
ORDER BY p.prosecdef DESC, p.proname, arguments;
