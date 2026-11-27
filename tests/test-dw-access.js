"use strict";

/**
 * Unit tests (no DB, no browser) for:
 *  - Data Warrior selection mode (src/lib/selection.ts: startsSelection / focusItem / pickItem)
 *  - drag & drop / paste planning (src/lib/localDrop.ts: planLocalUpload / normalizeDir / collectDataTransfer)
 *  - folder tree normalization on the server (server/folderTreeUpload.js normalizeTreePaths)
 *  - username form check (src/composables/useUsernameCheck.ts localUsernameStatus)
 *  - permission engine: can_manage_permissions is Super Admin only (server/permissions.js)
 *
 *   node tests/test-dw-access.js
 */

const path = require("path");
const assert = require("assert");
const esbuild = require("esbuild");

function loadTs(rel, external = []) {
  const out = esbuild.buildSync({
    entryPoints: [path.join(__dirname, "..", rel)],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    target: "node14",
    logLevel: "silent",
    external,
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const S = loadTs("src/lib/selection.ts");
const D = loadTs("src/lib/localDrop.ts");
const U = loadTs("src/composables/useUsernameCheck.ts", ["vue", "axios"]);
const { normalizeTreePaths, TreeError, MAX_DEPTH } = require("../server/folderTreeUpload");
const { computeFolderPermissions } = require("../server/permissions");

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) {
  queue.push(async () => {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.log(`  FAIL ${name}\n       ${String(err.message).split("\n").join("\n       ")}`); }
  });
}
const section = (t) => queue.push(async () => console.log(t));
const keys = ["folder:1", "folder:2", "file:7", "file:8"];
const sel = (s) => [...s.selected].sort();
const file = (name) => ({ name, size: 3 });

section("Selection mode (checkboxes hidden until Select)");
test("a plain click does not start selecting; Ctrl/Cmd or Shift does", () => {
  assert.strictEqual(S.startsSelection({}), false);
  assert.strictEqual(S.startsSelection({ ctrl: true }), true);
  assert.strictEqual(S.startsSelection({ shift: true }), true);
  assert.strictEqual(S.startsSelection(S.modifiersOf({ metaKey: true })), true, "Cmd counts as Ctrl");
});
test("focusItem (mode off) moves the focus only — nothing gets selected", () => {
  const s = S.focusItem(S.emptySelection(), keys, 2);
  assert.deepStrictEqual(sel(s), []);
  assert.strictEqual(s.active, 2);
  // A following Shift+click ranges from the focused item.
  const r = S.clickItem(s, keys, 3, { shift: true });
  assert.deepStrictEqual(sel(r), ["file:7", "file:8"]);
});
test("⋮ → Select adds the item (never toggles it off) and keeps earlier picks", () => {
  let s = S.pickItem(S.emptySelection(), keys, 1);
  assert.deepStrictEqual(sel(s), ["folder:2"]);
  s = S.pickItem(s, keys, 3);
  assert.deepStrictEqual(sel(s), ["file:8", "folder:2"]);
  s = S.pickItem(s, keys, 3);
  assert.deepStrictEqual(sel(s), ["file:8", "folder:2"], "picking again keeps it selected");
  assert.strictEqual(s.active, 3);
  // Shift+click after a menu pick: range from that item, earlier picks kept.
  const r = S.clickItem(s, keys, 2, { shift: true });
  assert.deepStrictEqual(sel(r), ["file:7", "file:8", "folder:2"]);
});
test("Select all / Ctrl+click / clear still work in selection mode", () => {
  let s = S.selectAll(S.emptySelection(), keys);
  assert.strictEqual(S.selectAllState(s, keys), "all");
  s = S.clickItem(s, keys, 0, { ctrl: true });
  assert.strictEqual(S.selectAllState(s, keys), "some");
  assert.strictEqual(S.selectAllState(S.clearSelection(s), keys), "none");
});
test("out-of-range indexes are ignored", () => {
  const e = S.emptySelection();
  assert.strictEqual(S.pickItem(e, keys, -1), e);
  assert.strictEqual(S.focusItem(e, keys, 9), e);
});

section("Drag & drop / paste planning (lib/localDrop.ts)");
test("files + nested folders → every folder path (parents first) and files grouped per folder", () => {
  const a = file("a.pdf"), b = file("b.pdf"), c = file("c.pdf"), loose = file("loose.txt");
  const plan = D.planLocalUpload([
    { dir: "Invoices", file: null },
    { dir: "Invoices", file: a },
    { dir: "Invoices/2026/Nov", file: b },
    { dir: "Invoices/2026/Nov", file: c },
    { dir: "Invoices/Empty", file: null },
    { dir: "", file: loose },
  ]);
  assert.deepStrictEqual(plan.folderPaths, ["Invoices", "Invoices/2026", "Invoices/Empty", "Invoices/2026/Nov"]);
  assert.deepStrictEqual(plan.groups.map((g) => [g.dir, g.files.map((f) => f.name)]), [
    ["", ["loose.txt"]],
    ["Invoices", ["a.pdf"]],
    ["Invoices/2026/Nov", ["b.pdf", "c.pdf"]],
  ]);
  assert.strictEqual(plan.fileCount, 4);
});
test("paths are normalized (backslashes, spaces) and compared case-insensitively", () => {
  assert.strictEqual(D.normalizeDir(" Invoices \\  2026 / "), "Invoices/2026");
  const plan = D.planLocalUpload([
    { dir: "Garut", file: file("x") },
    { dir: "GARUT", file: file("y") },
  ]);
  assert.deepStrictEqual(plan.folderPaths, ["Garut"]);
  assert.strictEqual(plan.groups.length, 1);
  assert.strictEqual(D.dirKey("GARUT / Nov"), "garut/nov");
});
test("plain pasted files → no folders, one group for the current folder", () => {
  const plan = D.planLocalUpload([{ dir: "", file: file("a.png") }, { dir: "", file: file("b.png") }]);
  assert.deepStrictEqual(plan.folderPaths, []);
  assert.deepStrictEqual(plan.groups.map((g) => g.dir), [""]);
});
test("collectDataTransfer walks dropped folders recursively (webkitGetAsEntry, batched readEntries)", async () => {
  const fileEntry = (name) => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(file(name)) });
  const dirEntry = (name, children) => ({
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      // readEntries returns children in batches of 2, then [].
      let i = 0;
      return { readEntries: (ok) => { const batch = children.slice(i, i + 2); i += 2; ok(batch); } };
    },
  });
  const tree = dirEntry("Docs", [fileEntry("1.pdf"), fileEntry("2.pdf"), fileEntry("3.pdf"), dirEntry("Sub", [fileEntry("4.pdf")]), dirEntry("Empty", [])]);
  const dt = { items: [{ kind: "file", webkitGetAsEntry: () => tree }, { kind: "file", webkitGetAsEntry: () => fileEntry("top.txt") }], files: [] };
  const entries = await D.collectDataTransfer(dt);
  const plan = D.planLocalUpload(entries);
  assert.deepStrictEqual(plan.folderPaths, ["Docs", "Docs/Empty", "Docs/Sub"]);
  assert.deepStrictEqual(plan.groups.map((g) => [g.dir, g.files.map((f) => f.name).sort()]), [
    ["", ["top.txt"]],
    ["Docs", ["1.pdf", "2.pdf", "3.pdf"]],
    ["Docs/Sub", ["4.pdf"]],
  ]);
});
test("collectDataTransfer falls back to plain files (paste) and keeps webkitRelativePath folders", async () => {
  const a = { name: "a.png", size: 1 };
  const b = { name: "b.pdf", size: 1, webkitRelativePath: "Scans/2026/b.pdf" };
  const entries = await D.collectDataTransfer({ items: [{ kind: "file" }, { kind: "string" }], files: [a, b] });
  assert.deepStrictEqual(entries.map((e) => [e.dir, e.file.name]), [["", "a.png"], ["Scans/2026", "b.pdf"]]);
  assert.deepStrictEqual(await D.collectDataTransfer(null), []);
});

section("Folder tree normalization (server/folderTreeUpload.js)");
test("ancestors added, duplicates merged case-insensitively, parents before children", () => {
  const out = normalizeTreePaths(["A/B/C", "a/b", " A / D ", "A\\B\\E", "", null]);
  assert.deepStrictEqual(out.map((x) => x.path), ["A", "A/B", "A/D", "A/B/C", "A/B/E"]);
});
test("invalid names, too deep paths and a missing list are rejected", () => {
  assert.throws(() => normalizeTreePaths("A"), (e) => e instanceof TreeError && e.code === "PATHS_REQUIRED");
  assert.throws(() => normalizeTreePaths(["A/../B"]), (e) => e.code === "INVALID_NAME");
  assert.throws(() => normalizeTreePaths(["x".repeat(192)]), (e) => e.code === "INVALID_NAME");
  assert.throws(() => normalizeTreePaths([Array.from({ length: MAX_DEPTH + 1 }, (_, i) => `d${i}`).join("/")]), (e) => e.code === "PATH_TOO_DEEP");
});

section("Username check (Create Account / Admin Reset Password)");
test("local status: empty → idle, own current username → unchanged, bad format → invalid, else ask the server", () => {
  assert.strictEqual(U.localUsernameStatus("  "), "idle");
  assert.strictEqual(U.localUsernameStatus("Budi.S", "budi.s"), "unchanged");
  assert.strictEqual(U.localUsernameStatus("ab"), "invalid");
  assert.strictEqual(U.localUsernameStatus("bad name"), "invalid");
  assert.strictEqual(U.localUsernameStatus("New.User"), null, "upper case is lower-cased, then checked by the server");
});

section("Permission engine: managing permissions is Super Admin only");
test("a role row with can_manage_permissions no longer grants it; Super Admin always has everything", () => {
  const rolesById = { 1: "super_admin", 2: "finance" };
  const rows = [{ folder_id: 10, role_id: 2, can_view: 1, can_upload: 1, can_manage_permissions: 1 }];
  const fin = computeFolderPermissions(["finance"], [10], rows, rolesById);
  assert.strictEqual(fin.can_view, true);
  assert.strictEqual(fin.can_upload, true);
  assert.strictEqual(fin.can_manage_permissions, false);
  const sa = computeFolderPermissions(["super_admin"], [10], [], rolesById);
  assert.ok(Object.keys(sa).filter((k) => k.startsWith("can_")).every((k) => sa[k] === true), "super admin: full access");
});

section("Config: EMAIL_TRANSPORT=mock really mocks (no real mail from tests)");
test("mockTransport is true only for EMAIL_TRANSPORT=mock", () => {
  const { execFileSync } = require("child_process");
  const run = (v) => execFileSync(process.execPath, ["-e", "process.stdout.write(String(require(\"./server/config\").config.smtp.mockTransport))"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, EMAIL_TRANSPORT: v },
  }).toString();
  assert.strictEqual(run("mock"), "true");
  assert.strictEqual(run("MOCK "), "true");
  assert.strictEqual(run("smtp"), "false");
  assert.strictEqual(run(""), "false");
});

(async () => {
  for (const job of queue) await job();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
