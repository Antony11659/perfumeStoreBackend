-- Read-only checks for the owner before reviewing the publication draft.
SELECT indexname, indexdef FROM pg_catalog.pg_indexes
WHERE schemaname = 'public' AND tablename = 'perfume_images';

SELECT conname, pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint
WHERE conrelid = 'public.perfume_images'::regclass;

SELECT perfume_id, count(*) FROM public.perfume_images WHERE is_primary
GROUP BY perfume_id HAVING count(*) > 1;

SELECT storage_key, count(*) FROM public.perfume_images
GROUP BY storage_key HAVING count(*) > 1;

SELECT grantee, privilege_type FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'perfume_images';
