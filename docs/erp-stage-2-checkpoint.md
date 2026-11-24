# PARFUMA ERP Stage 2 checkpoint

The staff-only ERP catalog includes searchable, filterable and paginated perfume records, brand and perfume creation and updates, variant management, internal SKU registration and permitted status editing, reversible archiving and restoration, and guarded perfume deletion. Perfume details include General, Variants, SKUs and Images. The Images tab renders registered master images and links to the central Image library. The central library continues to display its initial snapshot.

Marketplace matching reads visible Ozon primary SKUs, suggests perfume and registered volume matches, and requires explicit per-record approval before batch registration. Batches report individual outcomes and replay identical active mappings without overwriting existing rows. Sync snapshots live in the API process and clear on restart.

## Final catalog UI

The checkpoint snapshot contains **375 perfumes** with **365 active** and **10 archived**, as reported after the Supabase installation. These are catalog counts. The Image library still displays the separate pilot snapshot.

All perfumes fits its desktop content width and switches to cards when space is limited. Brand appears below the perfume name, gender stays visible, and four 34 px actions fit in one row. Active badges are green, Archived badges are grey, and Delete buttons are red. View and Edit retain violet, and Archive and Restore use neutral styling.

Search applies automatically after 350 ms. Clearing the field or using the X removes `q` from the URL immediately. Search changes reset to page 1 while preserving brand, gender, shop, archive status and sorting. Refresh and browser history restore the URL's search state. Older requests cannot replace results for the current query.

## Current safety restrictions

- Existing SKU strings, shop assignments, perfume assignments, volume assignments and permanent SKU deletion remain locked because historical use cannot be verified.
- Raspiv status changes and new competing eligible Raspiv mappings remain blocked. Existing ambiguities stay intact. Non-Raspiv Ozon status changes do not remove mappings from packaging SKU lookup.
- Variant changes and deletions are blocked by dependent order items and SKU mappings. Perfume deletion also checks all SKU statuses, registered images and unexpected inbound foreign-key definitions. Only unused variants cascade.
- Image uploads, image processing, storage deletion, external marketplace card creation and product coverage remain outside Stage 2.

## Production rollout gates

The legacy catalog authorization blocker remains open. The checked-in legacy writers lack a staff guard and live method-specific gateway enforcement is unverified. Existing packaging and employee workflows still use those routes. Their migration to individually authenticated interfaces is deferred.

Before any production rollout, confirm legacy write protection and caller readiness on each origin, check the deployed role and routine grants, and verify that the ERP write sessions run at READ COMMITTED. Run the [read-only RPC inventory](migration-drafts/public-rpc-inventory.sql) and review any unexpected SECURITY DEFINER routine before approving changes. See the [legacy authorization and privilege proposal](erp-catalog-least-privilege-proposal.md) for the outstanding decisions.

Before enabling ERP writes or archive controls, confirm the deployed checkout writer uses the expected role and the production CDN or gateway honors `Cache-Control: no-store`. Invalidate previously cached catalog responses and complete the archive-aware backend rollout. Database installation and production feature enablement are separate approvals.

## Database installation and migration history

The project owner reported that the combined Stage 2 installer was applied successfully in the Supabase SQL Editor. Its transaction installed the five ERP migration bodies and activated the checkout archive guard. The browser least-privilege draft was excluded.

**Reconcile migration history before the next automated migration run.** Compare deployed objects and effective grants with the canonical files below, then verify the migration ledger records all five original ERP versions. If entries are missing, use the approved migration history repair procedure to mark only verified, already-applied versions as applied. Keep the original files as the canonical migrations. Do not rerun them or put the combined installer in the automated migration directory.

### Canonical execution order

The existing website order, payment and delivery schema is the prerequisite baseline. Confirm these migrations in production history and apply any missing prerequisite only through its own approved release procedure.

1. `20261116000000_website_order_idempotency.sql`
2. `20261118000000_website_payment_reservation.sql`
3. `20261120000000_website_delivery_creation.sql`
4. `20261123000000_website_delivery_jobs.sql`

The combined install used the following five files in order. The separate [browser-privilege proposal](migration-drafts/20261123235959_erp_catalog_browser_privileges.sql) remains an unapplied draft.

1. [20261124000000_erp_catalog_writes.sql](../supabase/migrations/20261124000000_erp_catalog_writes.sql)
2. [20261124010000_erp_variant_writes.sql](../supabase/migrations/20261124010000_erp_variant_writes.sql)
3. [20261124020000_erp_sku_writes.sql](../supabase/migrations/20261124020000_erp_sku_writes.sql)
4. [20261124030000_erp_perfume_delete.sql](../supabase/migrations/20261124030000_erp_perfume_delete.sql)
5. [20261124040000_erp_perfume_archive.sql](../supabase/migrations/20261124040000_erp_perfume_archive.sql)

## Perfume archiving and storefront visibility

Existing perfumes start active. The ERP catalog offers **Active**, **Archived**, and **All** filters and shows counts for both statuses. Active is the default for catalog selection. Staff can archive or restore a perfume from the catalog and General tab, bulk archive up to 50 selected records, and view archived details with their variants, mappings and registered images. Single and bulk operations are idempotent. A bulk request with any missing ID rolls back in full. A status change updates `updated_at` and sets or clears `archived_at`.

- `GET /perfumes/` supplies the public catalog, homepage selections, search and storefront product details. It excludes archived perfumes. `GET /perfumes/:id` returns 404 for archived records. Both public reads send `Cache-Control: no-store`.
- `POST /orders` and `POST /website/orders` reject new orders containing archived perfumes with `409 WEBSITE_PERFUME_ARCHIVED`, including orders from stale carts. The archive RPC and order-item insert trigger lock perfume rows in ID order. When archiving commits first, checkout rolls back. When checkout commits first, the order remains valid.
- Archive changes preserve variants, existing SKU mapping statuses, registered images, S3 objects and historical orders. Completed order replays, payment settlement, receipts and delivery continue to use the existing order data.
- SKU suggestions use active perfumes while reconciliation retains existing mappings. **Stage 3 image generation must exclude archived perfumes from its default queue.** Future product creation and required marketplace coverage must also use the active assortment.

## Swagger

The backend publishes OpenAPI at `/documentation/json`. All ERP operations below use `erpBearer`.

| Method and path | Contract |
| --- | --- |
| `GET /erp/perfumes` | `status=active\|archived\|all` defaults to active. Returns whole-catalog active and archived counts and a matching total for the current filters. |
| `GET /erp/perfumes/:id` | Staff can open archived details by ID. Returns archive status and timestamp. |
| `POST /erp/perfumes/:id/archive` | Archives one perfume and returns the number of records changed. |
| `POST /erp/perfumes/:id/restore` | Restores one perfume and returns the number of records changed. |
| `POST /erp/perfumes/bulk-archive` | Accepts 1–50 distinct decimal-string IDs and returns the number of records changed. |

Public perfume read schemas describe active-only visibility. Both checkout schemas document the archived-item conflict.

## Local validation commands

Run backend Node regressions with `node --test tests/*.test.js`. Enable the optional Docker-backed payment regression with `RUN_PAYMENT_POSTGREST_TEST=1 node --test tests/websitePaymentPostgrest.test.js`. The dedicated ERP PostgreSQL tests are `erpCatalogPrivileges.test.py`, `erpCatalogWrites.test.py`, `erpVariantWrites.test.py`, `erpSkuWrites.test.py`, `erpPerfumeDelete.test.py`, and `erpPerfumeArchive.test.py`. They create socket-only disposable clusters.

Run frontend checks with `npm run lint`, `npm run build`, and `node --test tests/*.test.js`. Run `git diff --check` in both repositories.

The test results below come from local runs. The installation status and count snapshot above were reported by the project owner.

## Final local validation

- Backend Node regression suite passed 314 tests. The opt-in PostgREST payment regression passed in a separate run.
- Six disposable PostgreSQL suites passed 52 tests, including both archive/checkout race outcomes and preservation of order items, variants, mappings and images. The four website prerequisites, browser-privilege draft and five ERP migrations ran in order in one disposable cluster. The integrated lifecycle and execution grants for all 13 ERP RPCs passed.
- The combined installer passed 22 additional disposable PostgreSQL tests, including checkout, payment, delivery and packaging access. Preflight rejection and full rollback were verified for partial state, missing writer privileges, lock contention and a failed final grant check.
- The earlier checkpoint verified all 25 Stage 2 ERP operations in generated Swagger. Stage 2.6.1 added three documented archive operations and verified staff-only access and the updated list and detail behavior in Fastify fixtures.
- All 23 ERP frontend tests, lint and the production build passed. Both repositories passed whitespace checks, including untracked files.
- Local Chrome fixtures verified desktop and mobile ERP flows, archived detail access, both archive search terms, and storefront exclusion from the homepage, catalog, search and old product links. These checks used local fixtures.
- The compact catalog passed local Chrome checks at 1440, 1280, 1024, 768, 390 and 320 px. The search correction passed typing, rapid input, clearing, combined filters, pagination reset, refresh, back/forward navigation and a delayed-response check.
- The final production build completed with a Vite warning for a main JavaScript chunk of about 503 kB minified. Bundle optimization is deferred.
