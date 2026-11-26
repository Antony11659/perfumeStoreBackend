import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { digest, studioFailure } from "./erpImageStudioRunner.js";

const execute = promisify(execFile);
const unavailable = () => studioFailure("ERP_STUDIO_REGISTRATION_UNAVAILABLE",
  "Registration could not be confirmed. Retry this candidate to resume the same publication.");
const invalidCandidate = () => studioFailure("ERP_STUDIO_CANDIDATE_INVALID",
  "Candidate integrity could not be verified. Compose a new candidate.");

async function candidateBytes(path, validation, verifyBytes) {
  const file = await open(path, "r").catch(() => { throw invalidCandidate(); });
  let body;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 80000 || info.size > 200000 || info.size !== validation.bytes) throw invalidCandidate();
    body = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < body.length) {
      const { bytesRead } = await file.read(body, length, body.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size) throw invalidCandidate();
    body = body.subarray(0, length);
  } finally {
    await file.close();
  }
  if (digest(body) !== validation.candidateSha256) throw invalidCandidate();
  await verifyBytes(body, validation.candidateSha256).catch(() => { throw invalidCandidate(); });
  return body;
}

function verifyWithWorker(workerRoot, body, sha) {
  const verification = execute(process.execPath, [join(workerRoot, "src/validateCandidate.js"), sha], {
    timeout: 10000, killSignal: "SIGKILL", maxBuffer: 4096, env: { PATH: "/usr/bin:/bin" },
  });
  verification.child.stdin.on("error", () => {});
  verification.child.stdin.end(body);
  return verification;
}

export function createImagePublisher({ db, storage, workerRoot, verifyBytes = (body, sha) => verifyWithWorker(workerRoot, body, sha) }) {
  async function register(args, commit) {
    let result;
    try {
      result = await db.rpc("erp_publish_master_v1", { ...args, p_commit: commit })
        .abortSignal(AbortSignal.timeout(8000));
    } catch { throw unavailable(); }
    if (result.error || !result.data) throw unavailable();
    const { state, image_id: imageId } = result.data;
    if (state === "published" && typeof imageId === "string" && /^[1-9][0-9]*$/.test(imageId)) return imageId;
    if (state === "archived") throw studioFailure("ERP_STUDIO_ARCHIVED", "Select an active perfume.");
    if (state === "not_found") throw studioFailure("ERP_STUDIO_NOT_FOUND", "Perfume not found.");
    if (state === "primary_exists") {
      throw studioFailure("ERP_STUDIO_PRIMARY_EXISTS", "This perfume already has a primary image.");
    }
    if (state === "publication_conflict") {
      throw studioFailure("ERP_STUDIO_PUBLICATION_CONFLICT", "Another candidate reserved publication for this perfume. Reconcile that attempt before continuing.");
    }
    if (state !== "ready" || commit) throw unavailable();
    return null;
  }

  return async job => {
    const validation = job.validation;
    const body = await candidateBytes(join(job.dir, "candidate.webp"), validation, verifyBytes);
    const sha = validation.candidateSha256;
    const storageKey = `perfume-library/perfumes/${job.perfumeId}/master-v1-${sha}.webp`;
    const imageUrl = storage.url(storageKey);
    const args = {
      p_perfume_id: job.perfumeId, p_job_id: job.id, p_staff_id: job.owner,
      p_candidate_sha256: sha, p_source_sha256: job.sourceSha256, p_storage_key: storageKey,
      p_image_url: imageUrl, p_size_bytes: body.length,
    };
    let imageId = await register(args, false);
    if (!imageId) {
      try {
        await storage.putAndVerify(storageKey, body, sha);
      } catch {
        throw studioFailure("ERP_STUDIO_STORAGE_UNAVAILABLE", "Storage could not be verified. Retry this candidate to resume the same publication.");
      }
      imageId = await register(args, true);
    }
    return { imageId, perfumeId: job.perfumeId, storageKey, imageUrl, candidateSha256: sha };
  };
}
