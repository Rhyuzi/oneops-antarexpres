"use strict";

/**
 * Data Warrior multi-select rules (src/lib/selection.ts) — unit tests.
 * The TS module is bundled on the fly with esbuild (as in test-i18n.js).
 *
 *   node tests/test-selection.js
 */

const path = require("path");
const assert = require("assert");
const esbuild = require("esbuild");

const out = esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "lib", "selection.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  target: "node14",
  logLevel: "silent",
});
const mod = { exports: {} };
new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
const S = mod.exports;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(err.message).split("\n").join("\n       ")}`);
  }
}
const section = (t) => console.log(t);

// Display order: 2 folders, then 4 files.
const KEYS = ["folder:1", "folder:2", "file:10", "file:11", "file:12", "file:13"];
const sel = (s) => S.selectedInOrder(s, KEYS);
const state = (s) => ({ selected: sel(s), anchor: s.anchor, active: s.active, all: S.selectAllState(s, KEYS) });
const click = (s, i, m) => S.clickItem(s, KEYS, i, m);
const key = (s, k, m) => S.moveActive(s, KEYS, k, m);
const E = S.emptySelection();

section("Click");
test("plain click selects only that item; anchor = active = it", () => {
  let s = click(E, 2);
  assert.deepStrictEqual(state(s), { selected: ["file:10"], anchor: 2, active: 2, all: "some" });
  s = click(s, 4);
  assert.deepStrictEqual(state(s), { selected: ["file:12"], anchor: 4, active: 4, all: "some" });
});
test("Ctrl/Cmd+click toggles without clearing the others; anchor/active move", () => {
  let s = click(E, 1);
  s = click(s, 3, { ctrl: true });
  s = click(s, 5, { ctrl: true });
  assert.deepStrictEqual(state(s), { selected: ["folder:2", "file:11", "file:13"], anchor: 5, active: 5, all: "some" });
  s = click(s, 3, { ctrl: true }); // toggle off
  assert.deepStrictEqual(state(s), { selected: ["folder:2", "file:13"], anchor: 3, active: 3, all: "some" });
});
test("Cmd (metaKey) counts as Ctrl", () => {
  assert.deepStrictEqual(S.modifiersOf({ metaKey: true }), { shift: false, ctrl: true });
  assert.deepStrictEqual(S.modifiersOf({ ctrlKey: true, shiftKey: true }), { shift: true, ctrl: true });
});
test("Shift+click downward selects anchor…target", () => {
  let s = click(E, 1);
  s = click(s, 4, { shift: true });
  assert.deepStrictEqual(state(s), { selected: ["folder:2", "file:10", "file:11", "file:12"], anchor: 1, active: 4, all: "some" });
});
test("Shift+click upward selects target…anchor; a new Shift+click replaces the previous range", () => {
  let s = click(E, 4);
  s = click(s, 1, { shift: true });
  assert.deepStrictEqual(sel(s), ["folder:2", "file:10", "file:11", "file:12"]);
  assert.deepStrictEqual([s.anchor, s.active], [4, 1]);
  s = click(s, 5, { shift: true }); // same anchor, other direction
  assert.deepStrictEqual(sel(s), ["file:12", "file:13"]);
});
test("Ctrl+click then Shift+click keeps the Ctrl picks outside the range", () => {
  let s = click(E, 0); // folder:1
  s = click(s, 3, { ctrl: true }); // + file:11 (anchor 3)
  s = click(s, 5, { shift: true }); // range 3…5
  assert.deepStrictEqual(state(s), { selected: ["folder:1", "file:11", "file:12", "file:13"], anchor: 3, active: 5, all: "some" });
  s = click(s, 2, { shift: true }); // range 2…3 instead; folder:1 still kept
  assert.deepStrictEqual(sel(s), ["folder:1", "file:10", "file:11"]);
});
test("Ctrl+Shift+click adds the range to the current selection", () => {
  let s = click(E, 0);
  s = click(s, 2, { shift: true }); // 0…2
  s = click(s, 4, { ctrl: true }); // + file:12, anchor 4
  s = click(s, 5, { ctrl: true, shift: true });
  assert.deepStrictEqual(sel(s), ["folder:1", "folder:2", "file:10", "file:12", "file:13"]);
});
test("Shift+click without an anchor behaves like a plain click", () => {
  const s = click(E, 3, { shift: true });
  assert.deepStrictEqual(state(s), { selected: ["file:11"], anchor: 3, active: 3, all: "some" });
});

section("Keyboard");
test("Shift+ArrowDown extends the range from the anchor, inside the list bounds", () => {
  let s = click(E, 3);
  s = key(s, "ArrowDown", { shift: true });
  s = key(s, "ArrowDown", { shift: true });
  assert.deepStrictEqual(state(s), { selected: ["file:11", "file:12", "file:13"], anchor: 3, active: 5, all: "some" });
  s = key(s, "ArrowDown", { shift: true }); // already last
  assert.strictEqual(s.active, 5);
});
test("Shift+ArrowUp extends upward; moving back across the anchor shrinks / flips the range", () => {
  let s = click(E, 3);
  s = key(s, "ArrowUp", { shift: true });
  s = key(s, "ArrowUp", { shift: true });
  assert.deepStrictEqual(sel(s), ["folder:2", "file:10", "file:11"]);
  s = key(s, "ArrowDown", { shift: true });
  s = key(s, "ArrowDown", { shift: true });
  s = key(s, "ArrowDown", { shift: true });
  assert.deepStrictEqual(sel(s), ["file:11", "file:12"]);
  assert.deepStrictEqual([s.anchor, s.active], [3, 4]);
  for (let i = 0; i < 10; i++) s = key(s, "ArrowUp", { shift: true });
  assert.strictEqual(s.active, 0, "stops at the first item");
});
test("Ctrl/Cmd+ArrowUp/Down moves the focus only; Space then toggles the focused item", () => {
  let s = click(E, 1);
  s = key(s, "ArrowDown", { ctrl: true });
  s = key(s, "ArrowDown", { ctrl: true });
  assert.deepStrictEqual(state(s), { selected: ["folder:2"], anchor: 1, active: 3, all: "some" });
  s = S.toggleActive(s, KEYS);
  assert.deepStrictEqual(sel(s), ["folder:2", "file:11"]);
  s = key(s, "ArrowUp", { ctrl: true });
  assert.deepStrictEqual([sel(s), s.active], [["folder:2", "file:11"], 2]);
  // Shift+Arrow after Ctrl moves: range from the new anchor (3), Ctrl picks kept.
  s = key(s, "ArrowDown", { ctrl: true });
  s = key(s, "ArrowDown", { ctrl: true });
  s = key(s, "ArrowDown", { shift: true });
  assert.deepStrictEqual(sel(s), ["folder:2", "file:11", "file:12", "file:13"]);
});
test("plain ArrowUp/Down selects the next item only (new anchor); first press starts at the edge", () => {
  let s = key(E, "ArrowDown");
  assert.deepStrictEqual(state(s), { selected: ["folder:1"], anchor: 0, active: 0, all: "some" });
  s = key(s, "ArrowDown");
  assert.deepStrictEqual(state(s), { selected: ["folder:2"], anchor: 1, active: 1, all: "some" });
  assert.strictEqual(key(E, "ArrowUp").active, 5);
});
test("Shift+ArrowDown with nothing selected starts the range at the first item", () => {
  let s = key(E, "ArrowDown", { shift: true });
  s = key(s, "ArrowDown", { shift: true });
  assert.deepStrictEqual(sel(s), ["folder:1", "folder:2"]);
});
test("Shift+End / Shift+Home select to the last / first item", () => {
  let s = click(E, 2);
  s = key(s, "End", { shift: true });
  assert.deepStrictEqual(sel(s), ["file:10", "file:11", "file:12", "file:13"]);
  s = key(s, "Home", { shift: true });
  assert.deepStrictEqual(sel(s), ["folder:1", "folder:2", "file:10"]);
});

section("Select all + list changes");
test("Select all checkbox: none → all → none; indeterminate in between", () => {
  let s = E;
  assert.strictEqual(S.selectAllState(s, KEYS), "none");
  s = S.toggleAll(s, KEYS);
  assert.strictEqual(S.selectAllState(s, KEYS), "all");
  s = click(s, 2, { ctrl: true });
  assert.strictEqual(S.selectAllState(s, KEYS), "some");
  s = S.toggleAll(s, KEYS);
  assert.strictEqual(S.selectAllState(s, KEYS), "all");
  s = S.toggleAll(s, KEYS);
  assert.deepStrictEqual(sel(s), []);
  assert.strictEqual(S.selectAllState(S.emptySelection(), []), "none");
});
test("Shift+click after Select all + Ctrl deselect keeps the rest", () => {
  let s = S.selectAll(E, KEYS);
  s = click(s, 1, { ctrl: true }); // deselect folder:2, anchor 1
  s = click(s, 3, { shift: true }); // range 1…3 added back
  assert.strictEqual(S.selectAllState(s, KEYS), "all");
});
test("list change (navigation / delete / paging) drops missing keys and clamps the indexes", () => {
  let s = click(E, 4);
  s = click(s, 5, { ctrl: true });
  const shorter = ["folder:1", "file:10", "file:12"];
  s = S.syncSelection(s, shorter);
  assert.deepStrictEqual(S.selectedInOrder(s, shorter), ["file:12"]);
  assert.deepStrictEqual([s.anchor, s.active], [2, 2]);
  assert.deepStrictEqual(S.syncSelection(s, []).active, null);
});
test("Esc clears the selection but keeps the focus", () => {
  let s = click(E, 3);
  s = S.clearSelection(s);
  assert.deepStrictEqual(state(s), { selected: [], anchor: null, active: 3, all: "none" });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
