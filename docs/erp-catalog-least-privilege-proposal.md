# ERP catalog privilege and legacy-write rollout proposal

This is a review proposal. It is separate from the Stage 2.3 catalog write migration.

The supplied production catalog export shows RLS enabled with no policies for the inspected tables. The browser roles nonetheless have broad grants, including privileges outside row-level policy checks. The trusted backend uses service_role. ERP browser sessions use Supabase Auth and send a staff access token to Fastify. ERP catalog and website order queries run in Fastify with its server-side Supabase client.

The inspected La De Parfum clients read the catalog through the existing HTTP API. Website orders, payments, delivery and packaging access the database through Fastify. The perfume import script uses a server-side Supabase secret for shop mappings. The packaging browser uses legacy Fastify catalog reads and writes, including endpoints in `addProduct.js`, `editProduct.js`, and `skuMapping.js`. Those writes send JSON without a bearer token, so adding a mandatory staff guard in place would break the current client. Inventory other scripts, direct PostgREST consumers, and any inherited grants before approving revocation.

## Proposed grants migration

Apply in a separate reviewed change and test first against a copy of the production schema. Freeze the relation list to verified consumers. For tables confirmed to have no direct browser readers, remove all direct table grants from PUBLIC, anon and authenticated. If a browser read is verified, retain only its minimal SELECT grant and review its RLS policy independently. Remove any explicit column-level write privileges and inspect inherited grants. Preserve service_role privileges needed by the import, Fastify, and existing RPCs.

Candidate table-level revocation after that inventory:

```sql
REVOKE ALL PRIVILEGES ON TABLE
  public.brands, public.perfumes, public.perfume_variants, public.volumes,
  public.shops, public.shop_products, public.perfume_images, public.prices,
  public.website_orders, public.website_order_items
FROM PUBLIC, anon, authenticated;
```

Review the related order delivery, request and job tables separately against the already restricted grants. Capture exact grants and role membership before the change so rollback restores only the recorded privileges. Verify effective table and column permissions afterward, plus sequence access, function execute grants, and schema default privileges. Regress public catalog reads, checkout, payment, delivery, packaging and server-side import without sending live business mutations.

## Compatible legacy-write remediation

1. Migrate the packaging browser to a verified staff session and attach its bearer token to legacy writes. Preserve existing paths, response shapes, and the legacy default-variant behavior while migrating consumers.
2. Gate the legacy perfume, brand and SKU mapping mutations behind the reusable staff middleware. Keep public catalog reads as they are. Route identity mutations through the same guarded catalog transaction or retire the legacy operations after callers migrate so they cannot bypass the dependency rule.
3. Confirm method-specific gateway protections on every production origin, including the direct Timeweb origin, and verify old unauthenticated clients receive 401 or 403 through a fixture or controlled authorization probe. Document the gateway configuration as evidence before production rollout.

Both deployed origins returned public Swagger documentation with legacy write operations lacking a declared security scheme. The checked-in Fastify routes have no write authorization hook and the inspected packaging callers send no bearer token. Read-only gateway checks cannot establish whether the gateway blocks those methods. Treat this as a production rollout blocker.

## Stage 2.4 decision

Legacy catalog authorization work is deferred. Packaging, sticking, printing, Telegram bots, and employee workflows stay on their current paths until they migrate to separate Russian-language ERP employee interfaces with individual sign-in. The production rollout blocker above still applies to ERP catalog and variant writes.

Review the browser-privilege draft first, the Stage 2.3 catalog migration second, and the Stage 2.4 variant migration third. The variant migration restricts execution to the backend role and rejects changes outside READ COMMITTED isolation. These migrations are for local validation and review pending production approval.

## Stage 2.5 decision

The legacy authorization blocker still applies. Ozon packaging reads the global SKU mapping without status filters. Website fulfillment considers only active, non-archived Raspiv mappings, and its existing selection remains unchanged. ERP locks existing SKU, shop, perfume and volume fields and blocks permanent deletion while historical use cannot be verified. Raspiv status edits and new competing eligible Raspiv mappings are blocked. Non-Raspiv Ozon status edits are explicit internal changes and do not remove a mapping from packaging lookup.

Review the SKU RPC migration after Stage 2.4. Matching loads the primary SKU of each visible Ozon listing, enriches it with read-only product information, and retains sync snapshots in the API process. Restarting the process clears snapshots. Batch approvals are explicit, record-level, and retry-safe for the same active mapping. No marketplace product cards are written.

## Stage 2.6 decision

The existing legacy authorization and production rollout blockers still apply. Review the perfume deletion RPC migration after Stage 2.5. The RPC requires READ COMMITTED and checks the verified inbound foreign-key rules before allowing the existing unused-variant cascade. Registered image records block deletion. The operation does not remove Timeweb S3 objects.
