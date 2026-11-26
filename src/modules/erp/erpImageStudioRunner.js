import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export function studioFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

function command(file, args, cwd, signal, cache, failure) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const child = spawn(file, args, {
      cwd, signal, killSignal: "SIGKILL", stdio: "ignore", windowsHide: true,
      env: { PATH: "/usr/bin:/bin", NUMBA_CACHE_DIR: cache, PYTHONNOUSERSITE: "1" },
    });
    let spawnError;
    child.on("error", error => { spawnError = error; });
    // Wait for close after abort so cleanup never races with a running worker.
    child.once("close", code => {
      if (signal.aborted) reject(signal.reason);
      else if (spawnError || code !== 0) reject(failure);
      else resolve();
    });
  });
}

export function createStudioRunner(workerRoot) {
  const python = join(workerRoot, ".venv/bin/python");
  const preprocessing = join(workerRoot, "preprocess/remove_background.py");
  const compositor = join(workerRoot, "src/cli.js");

  return async function run({ dir, sourceSha256, signal, setStatus, cache }) {
    const prepared = join(dir, "prepared");
    const output = join(dir, "candidate.webp");
    const report = join(dir, "composition.json");
    setStatus("preprocessing");
    await command(python, ["-B", preprocessing, "--approved", "--input", join(dir, "reference"),
      "--out-dir", prepared], workerRoot, signal, cache,
      studioFailure("ERP_STUDIO_PREPROCESS_FAILED", "Could not prepare this reference. Check the file and use a clean, fully framed image."));
    setStatus("composing");
    await command(process.execPath, [compositor, "compose", "--approved", "--input", join(prepared, "cutout.png"),
      "--output", output, "--report", report], workerRoot, signal, cache,
      studioFailure("ERP_STUDIO_COMPOSE_FAILED", "The compositor could not produce a master within the required limits."));
    setStatus("validating");

    const [pre, composition, candidateSize] = await Promise.all([
      readFile(join(prepared, "validation.json"), "utf8").then(JSON.parse),
      readFile(report, "utf8").then(JSON.parse),
      stat(output),
    ]);
    const candidate = composition.output;
    if (pre.status !== "technical-validation-passed" || pre.source?.sha256 !== sourceSha256 ||
        pre.output?.sha256 !== composition.input?.sha256 ||
        !["existing-alpha", "segmented"].includes(pre.method) ||
        !["PNG", "JPEG", "WEBP"].includes(pre.source?.format) ||
        composition.status !== "passed" || composition.product?.clipped !== false ||
        composition.preset?.version !== "parfuma-master-v1" || candidate?.format !== "webp" ||
        candidate.colourspace !== "srgb" || candidate.aspectRatio !== "3:4" || candidate.opaque !== true ||
        candidate.width !== 900 || candidate.height !== 1200 || candidate.bytes !== candidateSize.size ||
        candidate.bytes < 80000 || candidate.bytes > 200000 || !Number.isFinite(pre.processingMs) ||
        !Number.isFinite(composition.processingMs) || !Number.isInteger(candidate.quality) ||
        !Number.isSafeInteger(pre.output.width) || !Number.isSafeInteger(pre.output.height)) {
      throw studioFailure("ERP_STUDIO_VALIDATION_FAILED", "The worker output did not meet the master image requirements.");
    }
    if (digest(await readFile(output)) !== candidate.sha256) {
      throw studioFailure("ERP_STUDIO_VALIDATION_FAILED", "The candidate checksum did not match the worker report.");
    }
    return {
      preset: composition.preset.version, method: pre.method,
      sourceSha256, cutoutSha256: pre.output.sha256, candidateSha256: candidate.sha256,
      sourceFormat: pre.source.format, sourceWidth: pre.output.width, sourceHeight: pre.output.height,
      width: candidate.width, height: candidate.height, bytes: candidate.bytes, format: candidate.format,
      aspectRatio: candidate.aspectRatio, opaque: candidate.opaque, clipped: false, quality: candidate.quality,
      preprocessingMs: pre.processingMs, compositionMs: composition.processingMs,
    };
  };
}
