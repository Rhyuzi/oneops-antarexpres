"use strict";

/**
 * R2 connectivity check — run manually: npm run r2:check
 * Verifies credentials + bucket access + a round-trip upload/verify/delete.
 * Never prints credential values.
 */

const r2 = require("../r2");
const { config } = require("../config");

async function main() {
  console.log("OneOps R2 check");
  console.log("  endpoint:  ", config.r2.endpoint || "(not set)");
  console.log("  bucket:    ", config.r2.bucketName);
  console.log("  configured:", Boolean(config.r2.accessKeyId && config.r2.secretAccessKey));

  console.log("\n[1/4] HeadBucket…");
  const check = await r2.checkR2();
  console.log("  ", JSON.stringify(check));
  if (!check.ok) {
    console.error("\nFAILED: bucket not reachable. Fix the issue above and retry.");
    process.exit(1);
  }

  const key = `documents/_healthcheck/${Date.now()}-probe.txt`;
  console.log("\n[2/4] Presigned upload URL…");
  try {
    const url = await r2.presignUpload(key, "text/plain");
    console.log("   presign OK (url length", url.length + ")");

    console.log("\n[3/4] Uploading probe object via presigned URL…");
    const https = require("https");
    const http = url.startsWith("http:") ? http : undefined;
    const lib = url.startsWith("http:") ? require("http") : https;
    await new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        { method: "PUT", headers: { "Content-Type": "text/plain" } },
        (res) => {
          res.resume();
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`PUT returned HTTP ${res.statusCode}`));
        }
      );
      req.on("error", reject);
      req.end("oneops r2 healthcheck probe");
    });
    console.log("   upload OK");
  } catch (err) {
    console.error("   FAILED:", err.message);
    console.error("\nIf the PUT failed with CORS/403, check:");
    console.error("  - R2 CORS rules allow your origin with PUT (see docs/R2-SETUP.md)");
    console.error("  - Token has Object Read + Object Write on this bucket");
    process.exit(1);
  }

  console.log("\n[4/4] HeadObject + cleanup…");
  try {
    const { exists, info } = await r2.objectExists(key);
    console.log("   exists:", exists, "| size:", info && info.contentLength);
    await r2.deleteObject(key);
    console.log("   deleted probe object");
    console.log("\nALL CHECKS PASSED — R2 is fully operational.");
  } catch (err) {
    console.error("   FAILED:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err.message);
  process.exit(1);
});
