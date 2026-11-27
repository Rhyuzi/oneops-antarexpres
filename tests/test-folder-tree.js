"use strict";

/**
 * Data Warrior Move dialog — folder tree rules (src/lib/folderTree.ts), unit tests.
 *   node tests/test-folder-tree.js
 */

const path = require("path");
const assert = require("assert");
const esbuild = require("esbuild");

const out = esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "lib", "folderTree.ts")],
  bundle: true, platform: "node", format: "cjs", write: false, target: "node14", logLevel: "silent",
});
const mod = { exports: {} };
new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
const T = mod.exports;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}\n       ${String(err.message).split("\n").join("\n       ")}`); }
}

// Root
//  ├─ 2025 (1)
//  │   └─ Garut (11)
//  ├─ 2026 (2)
//  │   ├─ November (21)
//  │   │   └─ Garut (211)
//  │   └─ Desember (22)
//  └─ Arsip (3)          ← no create-folder / upload right
const P = { can_create_folder: true, can_upload: true };
const FOLDERS = [
  { id: 2, parent_id: null, name: "2026", permissions: P },
  { id: 1, parent_id: null, name: "2025", permissions: P },
  { id: 3, parent_id: null, name: "Arsip", permissions: { can_create_folder: false, can_upload: false } },
  { id: 11, parent_id: 1, name: "Garut", permissions: P },
  { id: 21, parent_id: 2, name: "November", permissions: P },
  { id: 22, parent_id: 2, name: "Desember", permissions: P },
  { id: 211, parent_id: 21, name: "Garut", permissions: P },
];
const ctx = (over = {}) => ({ folders: FOLDERS, movingFolderIds: [], movingFiles: false, sourceParentIds: [], isSuperAdmin: true, ...over });
const names = (rows) => rows.map((r) => `${"  ".repeat(r.depth)}${r.name}`);

console.log("Tree + expand / collapse");
test("on open everything is collapsed — only the Root row is shown", () => {
  const rows = T.visibleRows(ctx(), new Set());
  assert.deepStrictEqual(names(rows), ["Root"]);
  assert.deepStrictEqual([rows[0].key, rows[0].expanded, rows[0].hasChildren, rows[0].depth], ["root", false, true, 0]);
});
test("expanding Root shows level 1 (sorted, numeric-aware); deeper levels stay collapsed", () => {
  const rows = T.visibleRows(ctx(), new Set(["root"]));
  assert.deepStrictEqual(names(rows), ["Root", "  2025", "  2026", "  Arsip"]);
  assert.ok(rows.slice(1).every((r) => r.depth === 1 && !r.expanded));
  assert.deepStrictEqual(rows.map((r) => r.hasChildren), [true, true, true, false]);
});
test("expanding level by level; collapsing a parent hides its whole sub-tree", () => {
  let open = T.toggleNode(new Set(), "root");
  open = T.toggleNode(open, 2);
  open = T.toggleNode(open, 21);
  assert.deepStrictEqual(names(T.visibleRows(ctx(), open)), ["Root", "  2025", "  2026", "    Desember", "    November", "      Garut", "  Arsip"]);
  open = T.toggleNode(open, 2);
  assert.deepStrictEqual(names(T.visibleRows(ctx(), open)), ["Root", "  2025", "  2026", "  Arsip"]);
  assert.ok(open.has(21), "the inner state is remembered (re-opening 2026 shows November open again)");
  open = T.toggleNode(open, "root");
  assert.deepStrictEqual(names(T.visibleRows(ctx(), open)), ["Root"]);
});
test("toggleNode is immutable", () => {
  const a = new Set();
  const b = T.toggleNode(a, "root");
  assert.ok(!a.has("root") && b.has("root"));
});

console.log("Full path preview");
test("path of the chosen destination: Root / 2026 / November / Garut", () => {
  assert.strictEqual(T.pathText(211, FOLDERS), "Root / 2026 / November / Garut");
  assert.strictEqual(T.pathText(11, FOLDERS), "Root / 2025 / Garut");
  assert.strictEqual(T.pathText("root", FOLDERS), "Root");
  assert.strictEqual(T.pathText(22, FOLDERS, "Akar"), "Akar / 2026 / Desember", "localized Root label");
});
test("a folder whose parent is not visible hangs under Root", () => {
  const partial = [{ id: 5, parent_id: 999, name: "Shared" }];
  assert.deepStrictEqual(names(T.visibleRows({ ...ctx(), folders: partial }, new Set(["root"]))), ["Root", "  Shared"]);
});

console.log("Search");
test("same name under different parents: both shown with their parent path; ancestors expanded", () => {
  const rows = T.visibleRows(ctx(), new Set(), "garut");
  assert.deepStrictEqual(names(rows), ["Root", "  2025", "    Garut", "  2026", "    November", "      Garut"]);
  const matches = rows.filter((r) => r.match);
  assert.deepStrictEqual(matches.map((r) => [r.key, r.parentPath]), [[11, "Root / 2025"], [211, "Root / 2026 / November"]]);
  assert.ok(rows.filter((r) => !r.match && r.key !== "root").every((r) => r.expanded), "ancestors auto-expanded");
  assert.ok(!names(rows).some((n) => n.includes("Arsip") || n.includes("Desember")), "non-matching branches hidden");
});
test("search ignores case and spaces around; empty query → normal collapsed tree", () => {
  assert.deepStrictEqual(names(T.visibleRows(ctx(), new Set(), "  NOVEM ")), ["Root", "  2026", "    November"]);
  assert.deepStrictEqual(names(T.visibleRows(ctx(), new Set(), "   ")), ["Root"]);
  assert.deepStrictEqual(names(T.visibleRows(ctx(), new Set(), "zzz")), ["Root"]);
});

console.log("Disabled targets");
test("moving a folder: itself and every descendant are disabled; its current parent too", () => {
  const c = ctx({ movingFolderIds: [2], sourceParentIds: [null] });
  assert.strictEqual(T.blockedReason(2, c), "moving");
  assert.strictEqual(T.blockedReason(21, c), "inside");
  assert.strictEqual(T.blockedReason(211, c), "inside");
  assert.strictEqual(T.blockedReason(22, c), "inside");
  assert.strictEqual(T.blockedReason("root", c), "source", "already at Root");
  assert.strictEqual(T.blockedReason(1, c), null);
  assert.strictEqual(T.blockedReason(11, c), null);
});
test("moving November (inside 2026): 2026 is the source; November + its Garut blocked; Root allowed for Super Admin", () => {
  const c = ctx({ movingFolderIds: [21], sourceParentIds: [2] });
  const open = new Set(["root", 2, 21]);
  const rows = Object.fromEntries(T.visibleRows(c, open).map((r) => [r.key, r.blocked]));
  assert.deepStrictEqual(rows, { root: null, 1: null, 2: "source", 22: null, 21: "moving", 211: "inside", 3: "no_permission" });
});
test("moving files: Root is not a target (files live in folders); upload right needed", () => {
  const c = ctx({ movingFiles: true, sourceParentIds: [22] });
  assert.strictEqual(T.blockedReason("root", c), "root_files");
  assert.strictEqual(T.blockedReason(22, c), "source");
  assert.strictEqual(T.blockedReason(3, c), "no_permission");
  assert.strictEqual(T.blockedReason(211, c), null);
});
test("Root is Super Admin only for folders; folders need the create-folder right", () => {
  const c = ctx({ movingFolderIds: [11], sourceParentIds: [1], isSuperAdmin: false });
  assert.strictEqual(T.blockedReason("root", c), "root_admin");
  assert.strictEqual(T.blockedReason(3, c), "no_permission");
  assert.strictEqual(T.blockedReason(22, c), null);
});
test("multi-selection: several moved folders, each with its sub-tree", () => {
  const set = T.descendantsOf([1, 21], FOLDERS);
  assert.deepStrictEqual([...set].sort((a, b) => a - b), [11, 211]);
  const c = ctx({ movingFolderIds: [1, 21], movingFiles: true, sourceParentIds: [2] });
  assert.deepStrictEqual([1, 11, 21, 211, 2, 22].map((k) => T.blockedReason(k, c)), ["moving", "inside", "moving", "inside", "source", null]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
