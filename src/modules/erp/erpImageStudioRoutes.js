import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, studioFailure } from "./erpImageStudioRunner.js";
import { documentedStudioSubmit, studioMaxBytes, studioSchemas } from "./erpImageStudioSchemas.js";

const prefix = "/image-studio";
const retentionMs = 30 * 60 * 1000;
const maxJobs = 24;
const maxInFlight = 4;
const terminal = new Set(["completed", "failed"]);
const workerFailures = new Set([
  "ERP_STUDIO_PREPROCESS_FAILED", "ERP_STUDIO_COMPOSE_FAILED", "ERP_STUDIO_VALIDATION_FAILED", "ERP_STUDIO_TIMEOUT",
]);

function problem(reply, status, code, message) {
  return reply.code(status).send({ code, message });
}

function imageType(body) {
  if (!Buffer.isBuffer(body)) return null;
  if (body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (body.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  if (body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export default async function erpImageStudioRoutes(app, { db, runner, publisher, timeoutMs = 180000 }) {
  const root = await mkdtemp(join(tmpdir(), "parfuma-studio-"));
  const cache = join(root, "numba");
  await mkdir(cache, { mode: 0o700 });
  const jobs = new Map();
  let active;
  let closed = false;
  const publicJob = ({ id, perfumeId, status, error }) =>
    ({ id, perfumeId, status, error, publicationEnabled: Boolean(publisher) });

  function cleanup(path) {
    return rm(path, { recursive: true, force: true }).catch(() => app.log.warn("Image Studio temporary cleanup failed"));
  }

  function sweep() {
    for (const job of jobs.values()) {
      if (!job.publication && job.expiresAt && job.expiresAt <= Date.now()) {
        jobs.delete(job.id);
        void cleanup(job.dir);
      }
    }
  }

  async function processJob(job, controller) {
    const timer = setTimeout(() => controller.abort(studioFailure(
      "ERP_STUDIO_TIMEOUT", "The local worker timed out. Try again with a smaller reference.",
    )), timeoutMs);
    try {
      job.validation = await runner({
        dir: job.dir, sourceSha256: job.sourceSha256, signal: controller.signal, cache,
        setStatus: status => { job.status = status; },
      });
      controller.signal.throwIfAborted();
      await Promise.all(["reference", "prepared", "composition.json"].map(file => cleanup(join(job.dir, file))));
      job.status = "completed";
    } catch (error) {
      await cleanup(job.dir);
      job.error = workerFailures.has(error.code)
        ? { code: error.code, message: error.message }
        : { code: "ERP_STUDIO_WORKER_FAILED", message: "The local image worker failed. Try again." };
      job.status = "failed";
      app.log.warn({ jobId: job.id, code: job.error.code }, "Image Studio job failed");
    } finally {
      clearTimeout(timer);
      job.expiresAt = Date.now() + retentionMs;
    }
  }

  function drain() {
    if (closed || active) return;
    const next = [...jobs.values()].find(job => job.ready && job.status === "queued");
    if (!next) return;
    const controller = new AbortController();
    active = { controller, done: processJob(next, controller).finally(() => {
      active = undefined;
      drain();
    }) };
  }

  const expiry = setInterval(sweep, 60000);
  expiry.unref();
  app.addHook("onClose", async () => {
    closed = true;
    clearInterval(expiry);
    active?.controller.abort(studioFailure("ERP_STUDIO_WORKER_FAILED", "The local worker stopped."));
    await active?.done;
    await cleanup(root);
    jobs.clear();
  });
  // Within this plugin the upload is always bytes, even if a client declares JSON or text.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: studioMaxBytes }, (_request, body, done) => done(null, body));
  app.setErrorHandler((error, _request, reply) => {
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return problem(reply, 413, "ERP_STUDIO_TOO_LARGE", "Choose an image of 20 MiB or less.");
    }
    if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return problem(reply, 415, "ERP_STUDIO_FORMAT", "Use a PNG, JPEG or WebP image.");
    }
    if (error.statusCode === 400) {
      return problem(reply, 400, "ERP_STUDIO_INVALID_REQUEST", "Check the identifiers and confirm source approval and usage permission.");
    }
    app.log.warn("Image Studio request failed");
    return problem(reply, 503, "ERP_STUDIO_UNAVAILABLE", "The local Image Studio is unavailable.");
  });

  app.post(`${prefix}/perfumes/:perfumeId/jobs`, {
    bodyLimit: studioMaxBytes,
    schema: studioSchemas.submit,
    config: { swaggerTransform: ({ url }) => ({ url, schema: documentedStudioSubmit }) },
  }, async (request, reply) => {
    const { perfumeId } = request.params;
    if (BigInt(perfumeId) > 9223372036854775807n) {
      return problem(reply, 400, "ERP_STUDIO_INVALID_REQUEST", "Invalid perfume ID.");
    }
    if (!imageType(request.body)) {
      return problem(reply, 415, "ERP_STUDIO_FORMAT", "The reference must contain PNG, JPEG or WebP image data.");
    }
    const { data, error } = await db.from("perfumes").select("is_archived").eq("id", perfumeId).maybeSingle();
    if (error) return problem(reply, 503, "ERP_STUDIO_UNAVAILABLE", "Could not verify the perfume.");
    if (!data) return problem(reply, 404, "ERP_STUDIO_NOT_FOUND", "Perfume not found.");
    if (data.is_archived !== false) return problem(reply, 409, "ERP_STUDIO_ARCHIVED", "Select an active perfume.");

    sweep();
    const sourceSha256 = digest(request.body);
    const owner = request.erpStaff.id;
    const duplicate = [...jobs.values()].find(job => job.owner === owner && job.perfumeId === perfumeId &&
      job.sourceSha256 === sourceSha256 && job.status !== "failed");
    if (duplicate) return reply.code(202).send(publicJob(duplicate));
    const inFlight = [...jobs.values()].filter(job => !terminal.has(job.status)).length;
    if (inFlight >= maxInFlight || jobs.size >= maxJobs) {
      return problem(reply, 429, "ERP_STUDIO_BUSY", "The local job queue is full. Try again later.");
    }

    const id = randomUUID();
    const job = { id, owner, perfumeId, sourceSha256, status: "queued", error: null, dir: join(root, id) };
    jobs.set(id, job);
    try {
      await mkdir(job.dir, { mode: 0o700 });
      await writeFile(join(job.dir, "reference"), request.body, { mode: 0o600, flag: "wx" });
    } catch {
      // Keep a pollable failure if a concurrent duplicate already got this ID.
      await cleanup(job.dir);
      job.status = "failed";
      job.error = { code: "ERP_STUDIO_UNAVAILABLE", message: "Could not store the approved reference locally." };
      job.expiresAt = Date.now() + retentionMs;
      return problem(reply, 503, job.error.code, job.error.message);
    }
    job.ready = true;
    setImmediate(drain);
    return reply.code(202).send(publicJob(job));
  });

  if (publisher) {
    app.post(`${prefix}/jobs/:jobId/publish`, { schema: studioSchemas.publish }, async (request, reply) => {
      sweep();
      const job = jobs.get(request.params.jobId);
      if (!job || job.owner !== request.erpStaff.id || (job.expiresAt && job.expiresAt <= Date.now())) {
        return problem(reply, 404, "ERP_STUDIO_NOT_FOUND", "Job unavailable or expired.");
      }
      if (job.status !== "completed" || !job.validation) {
        return problem(reply, 409, "ERP_STUDIO_NOT_READY", "Publish a validated candidate.");
      }
      const publication = job.publication ??= publisher(job);
      try {
        return await publication;
      } catch (error) {
        const status = {
          ERP_STUDIO_NOT_FOUND: 404, ERP_STUDIO_ARCHIVED: 409, ERP_STUDIO_PRIMARY_EXISTS: 409,
          ERP_STUDIO_PUBLICATION_CONFLICT: 409, ERP_STUDIO_CANDIDATE_INVALID: 422,
          ERP_STUDIO_STORAGE_UNAVAILABLE: 503, ERP_STUDIO_REGISTRATION_UNAVAILABLE: 503,
        }[error.code];
        if (status) return problem(reply, status, error.code, error.message);
        return problem(reply, 503, "ERP_STUDIO_PUBLICATION_UNAVAILABLE", "Could not confirm publication. Retry this candidate.");
      } finally {
        if (job.publication === publication) job.publication = undefined;
      }
    });
  }

  for (const [suffix, schema] of [["", studioSchemas.status], ["/preview", studioSchemas.preview], ["/validation", studioSchemas.validation]]) {
    app.get(`${prefix}/jobs/:jobId${suffix}`, { schema }, async (request, reply) => {
      sweep();
      const job = jobs.get(request.params.jobId);
      if (!job || job.owner !== request.erpStaff.id) {
        return problem(reply, 404, "ERP_STUDIO_NOT_FOUND", "Job unavailable or expired.");
      }
      if (!suffix) return publicJob(job);
      if (job.status !== "completed") {
        return problem(reply, 409, "ERP_STUDIO_NOT_READY", "This job has no validated candidate yet.");
      }
      if (suffix === "/validation") return job.validation;
      const image = await readFile(join(job.dir, "candidate.webp"));
      return reply.type("image/webp").header("X-Content-Type-Options", "nosniff").send(image);
    });
  }
}
