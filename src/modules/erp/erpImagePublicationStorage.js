import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { digest } from "./erpImageStudioRunner.js";

export function createMasterStorage({ endpoint, bucket, region, accessKeyId, secretAccessKey }, fetcher = fetch) {
  const origin = new URL(endpoint);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      !(origin.origin === "https://s3.twcstorage.ru" || (loopback && origin.protocol === "http:")) ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? "") || !region || !accessKeyId || !secretAccessKey) {
    throw new Error("Image publication requires valid Timeweb or loopback S3 configuration.");
  }
  const client = new S3Client({
    endpoint: origin.origin, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
  });
  const url = key => new URL(`/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`, origin).href;

  return {
    url,
    async putAndVerify(key, body, sha) {
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: body, ContentLength: body.length, ContentType: "image/webp",
          CacheControl: "public, max-age=31536000, immutable", Metadata: { sha256: sha }, IfNoneMatch: "*",
        }), { abortSignal: AbortSignal.timeout(12000) });
      } catch (error) {
        if (error?.$metadata?.httpStatusCode !== 412) throw error;
      }
      // Verify the exact public object that the storefront will read, including a retry's existing object.
      const response = await fetcher(url(key), { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(12000) });
      if (!response.ok || response.headers.get("content-type") !== "image/webp" || !response.body ||
          Number(response.headers.get("content-length")) !== body.length) {
        await response.body?.cancel();
        throw new Error("Published object metadata did not match.");
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > body.length) throw new Error("Published object exceeds the expected length.");
        chunks.push(chunk);
      }
      if (size !== body.length || digest(Buffer.concat(chunks)) !== sha) throw new Error("Published object checksum did not match.");
    },
  };
}
