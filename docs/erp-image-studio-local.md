# Local ERP Image Studio

Image Studio uses the existing ERP staff bearer token and scopes every job read to the submitting account. The frontend requires Vite development mode and the explicit Studio switch. The backend requires both `NODE_ENV=development` and `ERP_IMAGE_STUDIO_ENABLED=true`. With the switch enabled, Fastify binds to loopback. The Studio routes are absent otherwise.

## Local startup

Prepare the [standalone worker](../../parfuma-image-worker/README.md) with its existing Sharp dependencies, Python virtual environment and pinned BiRefNet model. Configure the existing Supabase environment in the backend and frontend. Use the staff account authorized for the reference.

Backend terminal from `perfumeStoreBackend`:

```sh
NODE_ENV=development ERP_IMAGE_STUDIO_ENABLED=true \
  ERP_IMAGE_WORKER_ROOT="$(cd ../parfuma-image-worker && pwd)" \
  WEBSITE_OZON_DELIVERY_AUTO_CREATE_ENABLED=false npm start
```

Frontend terminal from `parfuma-ERP-frontend`:

```sh
VITE_ERP_IMAGE_STUDIO_ENABLED=true VITE_ERP_API_BASE_URL=http://127.0.0.1:3000 \
  npm run dev -- --host 127.0.0.1
```

Sign in, open **Image library → Image Studio**, select an active perfume, and provide a permitted reference for that perfume. The UI displays the uploaded source alongside the private master. Confirm the visual result separately from the technical validation. Publication controls are unavailable.

## API

Swagger lives at `http://127.0.0.1:3000/documentation` when the backend is running. Studio operations use the `erpBearer` security scheme.

| Operation | Response |
|---|---|
| `POST /erp/image-studio/perfumes/{perfumeId}/jobs` | `202` with job ID and status. Post raw PNG, JPEG or WebP bytes with `Content-Type: application/octet-stream`. The existing image media types also work. The decoder determines format from the file bytes. Send `X-Source-Approved: true` and `X-Source-Usage-Permitted: true`. |
| `GET /erp/image-studio/jobs/{jobId}` | Job state and structured error if failed. |
| `GET /erp/image-studio/jobs/{jobId}/preview` | Authenticated `image/webp` after completion. |
| `GET /erp/image-studio/jobs/{jobId}/validation` | Technical validation, timing, and SHA-256 for the approved source, prepared cutout, and candidate. |

Limits are 20 MiB, 16 megapixels, and 6000 px per side. The backend checks the byte limit and signature at submission. Actual decode, orientation, and pixel limits run in the preprocessor after acceptance. Decoder errors appear in the failed job state. Invalid declarations, archive status, and exhausted local capacity have structured HTTP errors.

## Jobs and storage

Each job progresses through queued, preprocessing, composing, validating, and then completed or failed. One job runs at a time in this process, with at most four queued or running and 24 tracked jobs total. The approval declarations are required on resubmission. Identical source bytes, perfume, and submitting account return the same queued, running or completed job within its lifetime. A failed job can be resubmitted as a new attempt.

Fastify starts the independent Python and Sharp CLIs as subprocesses using fixed scripts, arguments and private job paths. Python decodes and normalizes the reference, preserving suitable transparency and running local segmentation on opaque images. Sharp renders and validates the default preset. The backend checks the report chain and candidate checksum before making the preview available. Processing has a three-minute deadline. Preview responses are private and uncached.

State lives in memory. The process uses a private OS temporary directory for references, intermediary files and results. Work files are removed at job completion or failure. The candidate and status remain available for 30 minutes after completion, with periodic cleanup and cleanup on graceful shutdown. A process restart loses job state and deduplication. A forced kill may leave private `parfuma-studio-*` directories under the system temp folder. Remove abandoned folders only after all Studio processes have stopped. This mechanism is intended for a single local process. It provides no durable queue, cross-process concurrency control or crash recovery.

The browser keeps the reference and job in the current Studio view. After navigation or reload, selecting the same perfume and resubmitting the same bytes can reconnect to an unexpired job. Automatic masks require visual review, especially for translucent glass and white edge contamination.
