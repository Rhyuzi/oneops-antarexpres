"use strict";

/**
 * Server-side recheck queue (loader API mode): looks up many AWBs one by one
 * through the shared SiCepat client, with bounded concurrency, a delay
 * between requests per worker, and retry with exponential backoff for
 * temporary failures (429 / 5xx / network). Mirrors src/lib/queue.ts.
 *
 * A token rejection (401/403) stops the WHOLE queue immediately — every
 * further call would fail too — and leaves the remaining AWBs pending so the
 * job can be resumed with a fresh token from the rechecker settings.
 *
 * Everything external (client, sleep, clock) is injectable for unit tests.
 */

const { lookupAwb, isRetryableStatus, isAuthStatus } = require("./sicepatClient");
const { normalizePhone } = require("./phone");

const DEFAULTS = { concurrency: 2, delayMs: 400, maxRetries: 3 };
const LIMITS = { concurrency: [1, 3], delayMs: [0, 60000], maxRetries: [0, 5] };

function clampOptions(opts = {}) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = Number(opts[k]);
    const [min, max] = LIMITS[k];
    out[k] = Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : DEFAULTS[k];
  }
  return out;
}

function backoffDelay(attempt, status) {
  const base = status === 429 ? 5000 : 1000;
  return Math.min(30000, base * Math.pow(2, attempt - 1));
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} p
 * @param {string[]} p.awbs                 AWBs still to look up (unique)
 * @param {{bearerToken: string, permissionToken: string, userId: string}} p.credentials
 * @param {(awb: string, result: object) => void} p.onResult
 *        result: { status: "success", phone } |
 *                { status: "failed", code: "invalid_phone"|"not_found"|"upstream", httpStatus, message }
 * @param {() => boolean} [p.shouldStop]   cancellation check
 * @returns {Promise<{ stopped: null | "auth" | "cancelled", authStatus?: number, authMessage?: string }>}
 */
async function runRecheckQueue({
  awbs,
  credentials,
  onResult,
  shouldStop = () => false,
  options = {},
  client = lookupAwb,
  sleep = realSleep,
}) {
  const opts = clampOptions(options);
  let next = 0;
  let stop = null;

  async function lookupWithRetry(awb) {
    for (let attempt = 1; ; attempt++) {
      const res = await client({ awb, ...credentials });
      if (res.ok) {
        const phone = normalizePhone(res.value);
        return phone.valid
          ? { status: "success", phone: phone.value }
          : { status: "failed", code: "invalid_phone", httpStatus: res.status, message: "Empty or invalid phone number in API response" };
      }
      if (isAuthStatus(res.status)) return { auth: true, status: res.status, message: res.message };
      if (isRetryableStatus(res.status) && attempt <= opts.maxRetries) {
        await sleep(backoffDelay(attempt, res.status));
        if (stop || shouldStop()) return null;
        continue;
      }
      return {
        status: "failed",
        code: res.status === 404 ? "not_found" : "upstream",
        httpStatus: res.status,
        message: res.message,
      };
    }
  }

  async function worker() {
    while (!stop) {
      if (shouldStop()) {
        stop = stop || { stopped: "cancelled" };
        return;
      }
      if (next >= awbs.length) return;
      const awb = awbs[next++];
      const result = await lookupWithRetry(awb);
      if (result === null) return; // stopped during backoff — AWB stays pending
      if (result.auth) {
        stop = stop || { stopped: "auth", authStatus: result.status, authMessage: result.message };
        return; // this AWB stays pending (not reported) → resumable
      }
      onResult(awb, result);
      if (opts.delayMs > 0 && next < awbs.length) await sleep(opts.delayMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(opts.concurrency, Math.max(1, awbs.length)) }, worker));
  if (!stop && shouldStop()) stop = { stopped: "cancelled" };
  return stop || { stopped: null };
}

module.exports = { runRecheckQueue, clampOptions, backoffDelay, DEFAULTS };
