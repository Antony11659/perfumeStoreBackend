# Image publication migration review

This replaces the earlier draft. The owner reported valid production indexes for one primary per perfume, unique storage keys, unique perfume and sort order, and the primary key. The live database also has validated master format and metadata checks and the existing perfume foreign key. The draft checks the audited index shape and constraint status and reuses them. It revokes mutation, trigger, reference and applicable maintenance rights only on `public.perfume_images`, including column-level INSERT, UPDATE and REFERENCES. SELECT and effective service-role access are compared before and after in the same transaction. Remaining inherited browser grants or a changed service-role grant abort the draft. The migration neither changes RLS nor adds a policy.

## Protected dependencies

The website and ERP catalog embed or count images via the backend's server-side Supabase client. The shop processing catalog and SKU mapping callers use existing backend perfume routes. The import utility writes `shop_products` only. The existing dependency RPC uses a service-role read to count images and guarded deletion checks the perfume and variant FK graph. The image FK and cascade are preserved. The publication audit stores the image ID without a new FK to any existing relation, so it cannot add a restriction to existing cascades. Replay still verifies that the original image is registered with the expected key and primary flag. Existing routine definitions and permissions are untouched.

Repository review found no protected writer targeting `perfume_images` directly. Live audit evidence showed no directly dependent views or non-internal image-table triggers. The reviewed publication change touches no packaging, sticking, labels, printers, Telegram, SKU, marketplace matching, Raspiv, orders, variants, checkout, payment or delivery schema or application code. External integrations and untracked privileged writers still require owner confirmation before installation.

## Migration history

The missing Supabase ledger is a rollout blocker for automated migrations. Retain the reviewed object inventory and any evidence of prior manual installation. Separately identify which historical files correspond to actual deployed objects, behavior and grants. Use an owner-approved ledger baseline or repair procedure only for independently verified versions. Do not create or populate the ledger from this draft, infer that all existing migrations ran, or rerun historical files against the live database. Keep this SQL outside the automated migration directory until that review is complete.

## Verification after an approved installation

Run [the read-only catalog checks](erp-image-publication-verify.sql) and compare with the live pre-install audit. Expect the same legacy image indexes, constraints and read grants. Expect browser roles to have no effective image writes or publication execute access, service_role to retain image access and dependency routine execution, and the Creed image count to remain zero at installation. The new publication RPC should be callable only by its owner and service_role. Compare routine execution grants and image table/catalog behavior with the baseline.

From the backend repository, using the exact same environment and service credentials as the intended backend process, run this **no-write** call only after approved installation and schema-cache refresh:

```sh
node --input-type=module - <<'JS'
import { supabase } from './src/lib/supabase.js'
const { data, error } = await supabase.rpc('erp_publish_master_v1', {
  p_perfume_id: null, p_job_id: null, p_staff_id: null,
  p_candidate_sha256: null, p_source_sha256: null,
  p_storage_key: null, p_image_url: null, p_size_bytes: null, p_commit: false,
}).abortSignal(AbortSignal.timeout(8000))
if (error || data?.state !== 'isolation_verified' || data?.transaction_isolation !== 'read committed') {
  console.error('Publication RPC isolation could not be verified.', error?.code ?? '')
  process.exitCode = 1
} else {
  console.log(data.transaction_isolation)
}
JS
```

This mode returns before taking locks or writing. Both publication phases also fail before writes under another isolation level. The live RPC is absent until installation, so a SQL Editor isolation result cannot close the backend gate. Keep publication disabled until the backend probe and other production gates pass.

## Rollback considerations

Disable publication entry points and drain in-flight requests first. A failure inside the deployment transaction rolls back grants and newly created objects. Before approved installation, capture exact image table and column ACLs, grantors and grant options. After installation, restore only specific ACLs from the reviewed baseline if rollback requires them. Do not re-grant broad browser mutation access automatically.

After any publication reservation or commit, reconcile the audit, registered image and S3 object before removing the new RPC or audit table. Keep pending and published audit evidence. A lost response can hide a committed registration. Leave public masters and image metadata in place unless individually reviewed. Existing indexes and constraints require no rollback because the draft reuses them. Keep the current ERP rollout gates in effect.
