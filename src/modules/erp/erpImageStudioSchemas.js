const string = { type: "string" };
const integer = { type: "integer", minimum: 0 };
const number = { type: "number", minimum: 0 };
const uuid = { type: "string", format: "uuid" };
const bool = { type: "boolean" };
const sha = { type: "string", pattern: "^[a-f0-9]{64}$" };
export const studioPerfumeId = { type: "string", pattern: "^[1-9][0-9]{0,18}$" };
const uploadTypes = ["application/octet-stream", "image/png", "image/jpeg", "image/webp"];
export const studioMaxBytes = 20 * 1024 * 1024;
const object = properties => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
const problem = object({ code: string, message: string });
const job = object({
  id: uuid, perfumeId: studioPerfumeId, status: {
    type: "string", enum: ["queued", "preprocessing", "composing", "validating", "completed", "failed"],
  },
  error: { ...problem, nullable: true },
  publicationEnabled: bool,
});
const validation = object({
  preset: { type: "string", enum: ["parfuma-master-v1"] },
  method: { type: "string", enum: ["existing-alpha", "segmented"] },
  sourceSha256: sha, cutoutSha256: sha, candidateSha256: sha,
  sourceFormat: { type: "string", enum: ["PNG", "JPEG", "WEBP"] },
  sourceWidth: integer, sourceHeight: integer, width: integer, height: integer, bytes: integer,
  format: { type: "string", enum: ["webp"] }, aspectRatio: { type: "string", enum: ["3:4"] },
  opaque: bool, clipped: bool, quality: integer, preprocessingMs: number, compositionMs: number,
});
const errors = {
  422: "Candidate bytes, decode, or checksum failed verification",
  400: "Malformed request or missing explicit approval or usage permission",
  401: "Valid ERP bearer authentication required",
  403: "ERP staff access required",
  404: "Perfume or job unavailable, expired, or owned by another account",
  409: "Perfume archived or candidate unavailable in this job state",
  413: "Reference exceeds 20 MiB",
  415: "Unrecognized or unsupported image bytes",
  429: "Local job or retention capacity reached",
  503: "Authentication, catalog, or private job storage unavailable",
};
function schema(summary, status, result, errorStatuses, extra = {}) {
  return {
    tags: ["ERP"], summary, security: [{ erpBearer: [] }], ...extra,
    response: {
      [status]: result,
      ...Object.fromEntries(errorStatuses.map(code => [code, { ...problem, description: errors[code] }])),
    },
  };
}
const jobParams = object({ jobId: uuid });
const binary = { type: "string", format: "binary" };
export const studioSchemas = {
  publish: schema("Approve and publish the submitting staff account’s validated master", 200,
    object({ imageId: studioPerfumeId, perfumeId: studioPerfumeId, storageKey: string,
      imageUrl: { type: "string", format: "uri" }, candidateSha256: sha }),
    [400, 401, 403, 404, 409, 422, 503], {
      params: jobParams,
      description: "Development-only when explicitly configured. Retries reuse the same immutable object and image row. A primary image already on the perfume is protected.",
      headers: { type: "object", required: ["x-candidate-approved"], properties: {
        "x-candidate-approved": { type: "string", enum: ["true"] },
      } },
    }),

  submit: schema("Queue a local master composition for an active perfume", 202, job, [400, 401, 403, 404, 409, 413, 415, 429, 503], {
    description: "Development only. Send raw image bytes (20 MiB, 16 megapixels, 6000 px per side). Use application/octet-stream or an image media type. The filename and declared media type do not determine the format. Unrecognized signatures return 415. The worker decodes and validates recognized references asynchronously and reports corruption in job status. An identical submission for this staff account and perfume returns the existing active or completed job.",
    params: object({ perfumeId: studioPerfumeId }),
    headers: {
      type: "object",
      required: ["x-source-approved", "x-source-usage-permitted"],
      properties: {
        "x-source-approved": { type: "string", enum: ["true"], description: "Source approved by the owner for this perfume" },
        "x-source-usage-permitted": { type: "string", enum: ["true"], description: "Permission to use and adapt the source image" },
      },
    },
    consumes: uploadTypes,
  }),
  status: schema("Read the submitting account's local composition status", 200, job, [400, 401, 403, 404, 503], { params: jobParams }),
  preview: schema("Read the submitting account's private WebP candidate", 200, { content: { "image/webp": { schema: binary } } },
    [400, 401, 403, 404, 409, 503], { params: jobParams }),
  validation: schema("Read validated master metadata and SHA-256 checksums", 200, validation,
    [400, 401, 403, 404, 409, 503], { params: jobParams }),
};
export const documentedStudioSubmit = { ...studioSchemas.submit, body: binary };
