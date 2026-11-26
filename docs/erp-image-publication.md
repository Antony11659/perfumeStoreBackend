# ERP Image Studio publication

## Audit

The live Supabase API exposes `perfume_images` and its foreign key to `perfumes`. The registration uses the existing fields `perfume_id`, `image_url`, `sort_order`, `is_primary`, `storage_key`, `image_type`, `width_px`, `height_px`, `size_bytes`, and `mime_type`. The bigint image ID is returned as a string. The API metadata does not expose the live unique indexes, so the one-primary and unique-storage-key constraints require catalog inspection by an authorized database owner. The approved five rows have distinct keys and distinct primary perfumes.

The five registered masters were Imagination (7), Althair (61), Gaba (151), Guidance (187), and Blue Talisman (226). Each uses `perfume-library/perfumes/<id>/master-v1.webp` in the same Timeweb bucket. All five public URLs returned `200 image/webp` with `Cache-Control: max-age=0`. Absolu Aventus (229) was active and had no image rows when inspected. No reusable S3 uploader or S3 environment configuration was present in the backend. The adapter uses Timeweb's path-style S3 endpoint and a separate set of server-side credentials.

The storefront API returns an active perfume's images sorted by `sort_order` and sends `Cache-Control: no-store` for catalog and detail reads. The storefront chooses the first usable primary URL, falling back to sort order if there is no primary. No storefront change is required. Actual production proxy behavior still needs verification.

## Local enablement and API

Set `NODE_ENV=development`, `ERP_IMAGE_STUDIO_ENABLED=true`, and `ERP_IMAGE_PUBLICATION_ENABLED=true` on the backend with the standalone worker path set through `ERP_IMAGE_WORKER_ROOT`. The development server binds to loopback. Use isolated Supabase-compatible fixtures and a loopback S3 service during local validation. Configure these server-side names in the local environment:

- `ERP_IMAGE_S3_ENDPOINT`
- `ERP_IMAGE_S3_BUCKET`
- `ERP_IMAGE_S3_REGION`
- `ERP_IMAGE_S3_ACCESS_KEY_ID`
- `ERP_IMAGE_S3_SECRET_ACCESS_KEY`

Enable `VITE_ERP_IMAGE_STUDIO_ENABLED=true` and `VITE_ERP_IMAGE_PUBLICATION_ENABLED=true` on the Vite development server. The action also requires a completed job reporting publication capability and a loaded, validated candidate. See [Studio startup](erp-image-studio-local.md) for the base development commands.

`POST /erp/image-studio/jobs/{jobId}/publish` requires a staff bearer token, the job owner, and the `X-Candidate-Approved: true` header. It returns the image ID, perfume ID, storage key, public URL, and candidate SHA-256. The endpoint appears in Swagger only when publication is configured. An unavailable or expired job returns 404. An archived perfume, existing primary, or competing reservation returns 409. Candidate integrity failure returns 422. Unconfirmed storage or registration returns a retryable 503.

Publication decodes the unchanged WebP in the isolated Sharp worker and verifies its checksum. It reserves the intended publication through a service-role-only RPC before any S3 write. The same validated bytes are uploaded to `perfume-library/perfumes/<id>/master-v1-<sha256>.webp` using a conditional put. The public URL must return the expected unmodified bytes and WebP metadata before final registration. This lets the storefront cache each content-addressed URL as immutable. An existing exact object is verified on retry. The final RPC locks the perfume row, rechecks active status and competing primary images, and registers the master and its approved/published audit record transactionally.

A failed or uncertain upload or registration can leave a reservation and an unregistered object. The service does not issue an automatic object deletion, since registration may already have committed. Resubmit the same unexpired job. After restart or expiry, the same staff account can recompose the same source and candidate bytes and explicitly approve the new job to reconcile the existing reservation. Different bytes return a conflict. If those bytes cannot be reproduced, an operator must reconcile the reservation, database row and object before releasing it. Pending rows are retained for audit. Publication success from a completed transaction is replayed using the same image ID.

## Owner review before the first real publication

1. Run the [read-only database audit](migration-drafts/erp-image-publication-audit.sql) using an authorized SQL session. Confirm existing indexes, constraints and grants, and identify any prior image writers affected by the draft's browser-role write revocation. The [database draft](migration-drafts/erp-image-publication.sql) remains outside automated migrations. Reconcile equivalent indexes and any duplicates before approving its application to a shared database.
2. Verify the service RPC is unavailable to browser roles and the storage credential is limited to the intended publication bucket or prefix. In a separately approved isolated Timeweb bucket, verify conditional writes reject an existing key, and verify the intended anonymous public read policy and byte checks. The local S3 fixture does not establish Timeweb implementation behavior. Use the provider's signing-region configuration.
3. Resolve the [standing production rollout gates](erp-stage-2-checkpoint.md), including legacy write-route authorization, effective grants and migration history, archive-aware checkout, and gateway cache behavior.
4. Review the active Creed perfume's source rights, exact candidate checksum and technical report. Require explicit authorization for the database rollout and the first real publication.
