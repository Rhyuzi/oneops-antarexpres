"use strict";

/**
 * Phone rule contract test — run with: npm test
 * The server rule (server/recheck/phone.js, used by the loader and the server
 * recheck queue) and the browser rule (src/lib/phone.ts, used by the
 * Number Rechecking queue) must give identical results for every vector in
 * tests/fixtures/phone-cases.json.
 */

const path = require("path");
const assert = require("assert");
const esbuild = require("esbuild");
const server = require("../server/recheck/phone");
const { cases } = require("./fixtures/phone-cases.json");

function loadTs(contents) {
  const out = esbuild.buildSync({
    stdin: { contents, resolveDir: path.join(__dirname, ".."), loader: "ts" },
    bundle: true, platform: "node", format: "cjs", write: false, target: "node14", logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const browser = loadTs(
  "export { normalizePhone } from './src/lib/phone'\nexport { normalizePhone as queueNormalize } from './src/lib/queue'"
);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}

console.log("shared phone rule");
for (const c of cases) {
  test(`${JSON.stringify(c.input)} → ${c.valid ? c.value : `invalid (${c.issue})`}`, () => {
    for (const [label, impl] of [["server", server.normalizePhone], ["browser", browser.normalizePhone]]) {
      const r = impl(c.input);
      assert.strictEqual(r.valid, c.valid, `${label} valid`);
      assert.strictEqual(r.value, c.value, `${label} value`);
      if (c.issue) assert.strictEqual(r.issue, c.issue, `${label} issue`);
    }
    // Rechecker queue: valid → normalized 628…, otherwise '' (record fails).
    assert.strictEqual(browser.queueNormalize(c.input === null ? "" : String(c.input)), c.valid ? c.value : "");
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
