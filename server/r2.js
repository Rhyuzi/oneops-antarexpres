"use strict";

/**
 * Cloudflare R2 storage service (S3-compatible API).
 *
 * All credential handling lives here. Credentials are read from config
 * (environment variables), never accepted from requests, never logged,
 * and never included in API responses.
 *
 * Degrades gracefully: when R2 is not configured every method returns a
 * clean error, so the rest of the app can boot and report status.
 */

const crypto = require("crypto");
const {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { config, r2Configured } = require("./config");

let client = null;

function r2Error(message, status = 503) {
  const err = new Error(message);
  err.status = status;
  err.r2 = true;
  return err;
}

function getClient() {
  if (!r2Configured()) {
    throw r2Error("Cloudflare R2 is not configured on the server.");
  }
  if (!client) {
    client = new S3Client({
      region: config.r2.region,
      endpoint: config.r2.endpoint,
      forcePathStyle: config.r2.forcePathStyle,
      credentials: {
        accessKeyId: config.r2.accessKeyId,
        secretAccessKey: config.r2.secretAccessKey,
      },
    });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/**
 * Sanitizes a filename: strips path components (anything before the last
 * separator), removes control/reserved characters, collapses whitespace,
 * strips leading dots, caps length at 120 chars.
 */
function sanitizeFilename(name) {
  let base = String(name || "file");
  // Drop any directory components from all common separators.
  const lastSep = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"), base.lastIndexOf(":"));
  if (lastSep >= 0) base = base.slice(lastSep + 1);
  base = base
    .replace(/[\r\n\t\0]/g, " ")
    .replace(/[*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120);
  return base.length ? base : "file";
}

/** Builds `documents/{folderId}/{uuid}-{sanitized}` object keys. */
function buildObjectKey(folderId, originalName) {
  const uuid = crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
  return `documents/${folderId}/${uuid}-${sanitizeFilename(originalName)}`;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** HeadBucket + report. Never returns credentials. */
async function checkR2() {
  if (!r2Configured()) {
    return { ok: false, configured: false, reason: "R2 credentials not set" };
  }
  try {
    await getClient().send(new HeadBucketCommand({ Bucket: config.r2.bucketName }));
    return { ok: true, configured: true, bucket: config.r2.bucketName };
  } catch (err) {
    const name = err.name || "";
    let reason = err.message || "R2 unreachable";
    if (name === "403" || name.includes("Forbidden")) reason = "Access denied (403) — check R2 credentials/bucket policy";
    else if (name === "404" || name.includes("NotFound")) reason = "Bucket not found";
    return { ok: false, configured: true, reason };
  }
}

async function headObject(objectKey) {
  const out = await getClient().send(
    new HeadObjectCommand({ Bucket: config.r2.bucketName, Key: objectKey })
  );
  return {
    exists: true,
    contentLength: out.ContentLength,
    contentType: out.ContentType,
    etag: out.ETag ? String(out.ETag).replace(/"/g, "") : null,
    lastModified: out.LastModified,
  };
}

async function objectExists(objectKey) {
  try {
    const info = await headObject(objectKey);
    return { exists: true, info };
  } catch (err) {
    if (err && (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404)) {
      return { exists: false };
    }
    throw err;
  }
}

/**
 * Presigned PUT URL for direct browser→R2 upload.
 * The key is always server-generated; callers never supply one.
 */
async function presignUpload(objectKey, contentType) {
  const cmd = new PutObjectCommand({
    Bucket: config.r2.bucketName,
    Key: objectKey,
    ContentType: contentType || "application/octet-stream",
  });
  return getSignedUrl(getClient(), cmd, {
    expiresIn: config.r2.presignExpirySeconds,
  });
}

/**
 * Presigned GET URL for download (attachment) or preview (inline).
 * Authorization must already have happened before calling this.
 */
async function presignDownload(objectKey, opts = {}) {
  const cmd = new GetObjectCommand({
    Bucket: config.r2.bucketName,
    Key: objectKey,
    ...(opts.downloadName
      ? { ResponseContentDisposition: `attachment; filename="${sanitizeFilename(opts.downloadName).replace(/"/g, "")}"` }
      : {}),
    ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
    ...(opts.inline ? { ResponseContentDisposition: opts.downloadName
        ? `inline; filename="${sanitizeFilename(opts.downloadName).replace(/"/g, "")}"`
        : "inline" } : {}),
  });
  return getSignedUrl(getClient(), cmd, {
    expiresIn: config.r2.presignExpirySeconds,
  });
}

async function deleteObject(objectKey) {
  await getClient().send(
    new DeleteObjectCommand({ Bucket: config.r2.bucketName, Key: objectKey })
  );
  return true;
}

/** Deletes every object under a folder prefix (used by folder deletion). */
async function deletePrefix(prefix) {
  let continuationToken;
  let deleted = 0;
  do {
    const list = await getClient().send(
      new ListObjectsV2Command({
        Bucket: config.r2.bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    const keys = (list.Contents || []).map((o) => o.Key);
    for (const key of keys) {
      await deleteObject(key);
      deleted += 1;
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
  return deleted;
}

module.exports = {
  checkR2,
  headObject,
  objectExists,
  presignUpload,
  presignDownload,
  deleteObject,
  deletePrefix,
  buildObjectKey,
  sanitizeFilename,
  r2Error,
};
