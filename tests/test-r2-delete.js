"use strict";

/**
 * R2 batch delete (server/r2.js deleteObjects) — unit tests with a fake S3 client.
 *   node tests/test-r2-delete.js
 */

const assert = require("assert");
const r2 = require("../server/r2");

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) {
  queue.push(async () => {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.log(`  FAIL ${name}\n       ${String(err.message).split("\n").join("\n       ")}`); }
  });
}

/** Fake client: records DeleteObjects inputs; `fail(keys)` decides per-object errors. */
function fakeClient({ errorsFor = () => [], throwOn = () => false } = {}) {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      const input = cmd.input;
      const keys = input.Delete.Objects.map((o) => o.Key);
      calls.push({ name: cmd.constructor.name, bucket: input.Bucket, quiet: input.Delete.Quiet, keys });
      if (throwOn(calls.length)) {
        const e = new Error("socket hang up");
        e.name = "NetworkingError";
        throw e;
      }
      return { Errors: errorsFor(keys).map((Key) => ({ Key, Code: "AccessDenied", Message: "Access Denied" })) };
    },
  };
}

console.log("R2 batch delete");
test("2,500 keys → 3 DeleteObjects requests (1000 / 1000 / 500), quiet, duplicates removed", async () => {
  const c = fakeClient();
  r2.setClientForTests(c);
  const keys = Array.from({ length: 2500 }, (_, i) => `documents/1/k${i}`);
  const out = await r2.deleteObjects([...keys, keys[0], "", null]);
  assert.deepStrictEqual(c.calls.map((x) => x.keys.length), [1000, 1000, 500]);
  assert.ok(c.calls.every((x) => x.name === "DeleteObjectsCommand" && x.quiet === true));
  assert.strictEqual(out.deleted.length, 2500);
  assert.deepStrictEqual(out.failed, []);
});
test("per-object errors are reported with their code; the rest counts as deleted", async () => {
  const c = fakeClient({ errorsFor: (keys) => keys.filter((k) => k.endsWith("bad")) });
  r2.setClientForTests(c);
  const out = await r2.deleteObjects(["a", "b-bad", "c"]);
  assert.deepStrictEqual(out.deleted, ["a", "c"]);
  assert.deepStrictEqual(out.failed, [{ key: "b-bad", code: "AccessDenied", message: "Access Denied" }]);
});
test("a failed request marks only that batch as failed — other batches still go through", async () => {
  const c = fakeClient({ throwOn: (n) => n === 2 });
  r2.setClientForTests(c);
  const keys = Array.from({ length: 1500 }, (_, i) => `k${i}`);
  const out = await r2.deleteObjects(keys);
  assert.strictEqual(out.deleted.length, 1000);
  assert.strictEqual(out.failed.length, 500);
  assert.ok(out.failed.every((f) => f.code === "NetworkingError"));
});
test("no keys → no request; never throws", async () => {
  const c = fakeClient();
  r2.setClientForTests(c);
  assert.deepStrictEqual(await r2.deleteObjects([]), { deleted: [], failed: [] });
  assert.strictEqual(c.calls.length, 0);
});
test("R2 not configured (no client): every key reported failed, no exception", async () => {
  r2.setClientForTests(null);
  const { config } = require("../server/config");
  const saved = { ...config.r2 };
  Object.assign(config.r2, { accountId: "", accessKeyId: "", secretAccessKey: "", bucketName: "", endpoint: "" });
  try {
    const out = await r2.deleteObjects(["x", "y"]);
    assert.strictEqual(out.deleted.length, 0);
    assert.strictEqual(out.failed.length, 2);
  } finally {
    Object.assign(config.r2, saved);
  }
});

(async () => {
  for (const job of queue) await job();
  r2.setClientForTests(null);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
