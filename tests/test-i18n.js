"use strict";

/**
 * i18n completeness checks — run with: npm test
 *
 * vue-tsc already guarantees that every t('key') exists and that the
 * Indonesian dictionary has exactly the English keys. This file covers what
 * typing cannot see:
 *   1. No hard-coded user-visible text in .vue templates (text nodes and
 *      static placeholder/title/aria-label/label/loading-text attributes),
 *      using Vue's own template compiler (devDependency already present).
 *   2. Every message the server can send (server/**) is recognised by the
 *      display-time localizer, so Indonesian users never see raw English.
 *   3. Every system message produced in the frontend (Excel parser, rechecker
 *      worker, stores, upload) is recognised as well.
 *   4. Dictionary quality: no empty values, placeholders identical per key.
 *
 * TypeScript sources are bundled on the fly with esbuild (shipped with Vite).
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const esbuild = require("esbuild");
const { parse: parseSfc } = require("@vue/compiler-sfc");

const ROOT = path.join(__dirname, "..");
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

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(p);
  }
  return out;
}

// --- load the real i18n modules (TS) --------------------------------------------
// ONE bundle for everything, so the locale ref is shared (separate bundles
// would each get their own copy of index.ts and its state).
function loadI18n() {
  const out = esbuild.buildSync({
    stdin: {
      contents: [
        "export * from './src/i18n/index'",
        "export { localizeMessage, apiErrorMessage, localizeRoleDescription } from './src/i18n/systemMessages'",
        "export { en } from './src/i18n/locales/en'",
        "export { id } from './src/i18n/locales/id'",
      ].join("\n"),
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    target: "node14",
    logLevel: "silent",
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
const i18n = loadI18n();
const sys = i18n;
const { en, id } = i18n;

function leaves(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") out[prefix + k] = v;
    else leaves(v, `${prefix}${k}.`, out);
  }
  return out;
}

// =============================================================================
console.log("i18n dictionaries");
const enLeaves = leaves(en);
const idLeaves = leaves(id);

test("English and Indonesian have identical key sets", () => {
  const a = Object.keys(enLeaves).sort();
  const b = Object.keys(idLeaves).sort();
  assert.deepStrictEqual(b, a);
});
test("no empty translations", () => {
  const empty = Object.entries(idLeaves).filter(([, v]) => !v.trim()).map(([k]) => k);
  assert.deepStrictEqual(empty, []);
});
test("placeholders match per key ({name} in English ⇔ in Indonesian)", () => {
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
  const bad = Object.keys(enLeaves).filter((k) => ph(enLeaves[k]) !== ph(idLeaves[k]));
  assert.deepStrictEqual(bad, []);
});
test("untranslated (identical) values are only product names / technical terms", () => {
  // Values allowed to be identical in both languages.
  const ALLOWED = new Set([
    "OneOps", "AntarXpress", "OneOps — AntarXpress", "Data Warrior", "—", "Status", "Email",
    "Bearer Token", "X-Permission-Token", "User ID", "AWB", "Total AWB", "Super Admin", "Root",
    "{name}: {status}.", '"{name}": {error}', "User agent", ", ", "Folder", "{count} folder",
    // Loader business terms used as-is in Indonesian operations
    "Cust ID Non-COD (N)", "Cust ID COD (Y)", "COD (Y)", "Non-COD (N)", "master",
    "Template", "Mode", "manual", "Kota_Tujuan", "Kota_Tujuan → wilayah",
    // Result 3PL column names (Data Warrior JNE headers) are the same in both languages.
    "Gerai / HUB → KOTA PENERIMA", "HUB", "KOTA PENERIMA", "NAMA PENGIRIM",
    // Master Data: module name and reference column names, identical in both languages.
    "MASTER DATA", "Master Data", "Kota_Tujuan → Wilayah", "Wilayah", "Kecamatan", "Kodepos", "Data",
    // Wilayah master (migration 014): JNE sender column + domain term.
    "Kota", "KOTA PENGIRIM",
    // Resi issue notes: list separator, the same in both languages.
    "; ",
  ]);
  const same = Object.keys(enLeaves).filter((k) => enLeaves[k] === idLeaves[k] && !ALLOWED.has(enLeaves[k]));
  assert.deepStrictEqual(same, [], `identical values need translation or an ALLOWED entry: ${same.join(", ")}`);
});

// =============================================================================
console.log("templates (no hard-coded user-visible text)");
const TEXT_ATTRS = new Set(["placeholder", "title", "aria-label", "label", "loading-text", "alt"]);
// Text that is legitimately literal in templates (symbols, technical ids).
const ALLOWED_TEXT = [/^[\s·—•%#@()\-→.,:/|✓…]*$/, /^super_admin$/];

function scanTemplate(file) {
  const src = fs.readFileSync(file, "utf8");
  const { descriptor } = parseSfc(src, { filename: file });
  if (!descriptor.template) return [];
  const problems = [];
  const visit = (node) => {
    if (node.type === 2 /* TEXT */) {
      const text = node.content.replace(/&nbsp;|&amp;/g, " ").trim();
      if (/[A-Za-z]/.test(text) && !ALLOWED_TEXT.some((re) => re.test(text))) {
        problems.push(`${path.relative(ROOT, file)}:${node.loc.start.line} text "${text.slice(0, 60)}"`);
      }
    }
    if (node.type === 1 /* ELEMENT */) {
      for (const p of node.props || []) {
        if (p.type === 6 /* static ATTRIBUTE */ && TEXT_ATTRS.has(p.name) && p.value && /[A-Za-z]/.test(p.value.content)) {
          problems.push(`${path.relative(ROOT, file)}:${p.loc.start.line} ${p.name}="${p.value.content.slice(0, 60)}"`);
        }
      }
    }
    for (const child of node.children || []) visit(child);
    if (node.branches) node.branches.forEach(visit);
  };
  visit(descriptor.template.ast);
  return problems;
}

const vueFiles = walk(path.join(ROOT, "src"), [".vue"]);
test(`all ${vueFiles.length} .vue templates use translations`, () => {
  const problems = vueFiles.flatMap(scanTemplate);
  assert.deepStrictEqual(problems, []);
});

// =============================================================================
console.log("server messages are localizable");
i18n.setLocale("id");

/** Static strings from server `message:` fields + thrown Errors meant for users. */
function serverMessages() {
  const files = walk(path.join(ROOT, "server"), [".js"]).filter((f) => !f.includes(`${path.sep}scripts${path.sep}`));
  const out = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const re = /message:\s*\n?\s*"((?:[^"\\]|\\.)+)"/g;
    let m;
    while ((m = re.exec(src))) out.add(m[1].replace(/\\"/g, '"'));
  }
  return [...out];
}
// Admin-only / operator diagnostics that never reach the OneOps UI.
const SERVER_EXEMPT = new Set([
  "Mock transport active (test mode).", // /api/admin/email (no UI)
  "SMTP connection and authentication verified.", // /api/admin/email (no UI)
  "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD.", // /api/admin/email (no UI)
]);
const DYNAMIC_SAMPLES = [
  "Cannot delete: 3 user(s) are still assigned to this role. Reassign them first.",
  "File exceeds the 50 MB limit.",
  "File type .exe is not allowed. Allowed: pdf, png",
  "MIME type application/x-msdownload is not allowed.",
  "Renaming to .exe is not allowed.",
  "Invitation sent to a@b.co.",
  "Password reset email sent to a@b.co.",
  "Unknown role: ghost",
  "Account created, but the invitation email could not be sent (ETIMEDOUT). You can resend it later.",
  "Account created, but SMTP is not configured — invitation not sent.",
  "SiCepat server error (HTTP 502).",
  "Request failed (HTTP 418).",
  "Password must contain at least 8 characters, an uppercase letter, a symbol.",
  "Start date is after end date.",
  "Invalid pageSize.",
  // Kodepos loader (thrown LoaderInputError / badRequest messages)
  "The 3PL template is missing required columns: Berat Asli, Biaya.",
  "The 3PL template has no data rows.",
  "Both cust IDs (COD and Non-COD) are required.",
  "Cust ID must be a number (digits only, max 15).",
  "The COD and Non-COD cust IDs must be different.",
  "The kodepos reference (kebutuhan_loader) is empty. Import the master file first.",
  'The file "x.xlsx" could not be read as Excel.',
  'No sheet in "x.xlsx" has the required columns: Resi, No HP Penerima.',
  "The template file is required.",
  "The rechecked file must be an .xlsx or .xls file.",
  "The master file is empty.",
  "The template file exceeds the 10 MB limit.",
  "No kecamatan/kodepos rows were found. Each sheet needs a header row: Kecamatan | Kode Pos.",
  // Loader jobs / settings (thrown via httpError/badRequest or settings module)
  "You already have a loader recheck job running. Wait for it to finish or cancel it.",
  "Too many AWBs for one job (max 3000). Split the template.",
  "Kota_Tujuan must be at least 3 characters.",
  "Unknown wilayah — it must exist in the kodepos reference.",
  "Authorization failed — token is invalid or expired.",
];

test("every static server message is recognised", () => {
  const msgs = serverMessages().filter((m) => !SERVER_EXEMPT.has(m));
  assert.ok(msgs.length > 80, `only ${msgs.length} server messages found — extraction broken?`);
  const unmapped = msgs.filter((m) => sys.localizeMessage(m) === m);
  assert.deepStrictEqual(unmapped, []);
});
test("dynamic server messages are recognised (with parameters kept)", () => {
  const unmapped = DYNAMIC_SAMPLES.filter((m) => sys.localizeMessage(m) === m);
  assert.deepStrictEqual(unmapped, []);
  assert.ok(sys.localizeMessage("Invitation sent to a@b.co.").includes("a@b.co"));
  assert.ok(sys.localizeMessage("Cannot delete: 3 user(s) are still assigned to this role. Reassign them first.").includes("3"));
});

console.log("frontend system messages are localizable");
test("Excel parser, rechecker worker, stores and upload messages are recognised", () => {
  const sources = {
    "src/lib/excel.ts": /new Error\(\s*['`]([^'`]+)['`]/g,
    "src/lib/queue.ts": /(?:error =|message:)\s*\n?\s*['`]([^'`]+)['`]/g,
    "src/store.ts": /authError =\s*\n?\s*['`]([^'`]+)['`]/g,
    "src/stores/storage.ts": /(?:Error =|error =)[^\n]*?\|\|\s*['`]([^'`]+)['`]/g,
    "src/stores/auth.ts": /state\.error =[^\n]*?['`]([^'`]+)['`]/g,
    "src/lib/storageApi.ts": /new Error\(\s*\n?\s*['`]([^'`]+)['`]/g,
  };
  const unmapped = [];
  let count = 0;
  for (const [file, re] of Object.entries(sources)) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    let m;
    while ((m = re.exec(src))) {
      count++;
      const sample = m[1].replace(/\$\{[^}]+\}/g, (expr) => (/sheet|name/i.test(expr) ? "Sheet1" : "500"));
      if (sys.localizeMessage(sample) === sample) unmapped.push(`${file}: ${m[1]}`);
    }
  }
  assert.ok(count >= 15, `only ${count} frontend messages found — extraction broken?`);
  assert.deepStrictEqual(unmapped, []);
});

test("built-in role descriptions: translated only while identical to the migration seed", () => {
  const sql = fs.readFileSync(path.join(ROOT, "database/migrations/001_create_users_roles.sql"), "utf8");
  for (const [role, text] of Object.entries(en.seedRoles)) {
    assert.ok(sql.includes(`('${role}',`) && sql.includes(`'${text}'`), `seed text drifted for ${role}`);
  }
  i18n.setLocale("id");
  assert.strictEqual(sys.localizeRoleDescription(en.seedRoles.finance), id.seedRoles.finance);
  assert.strictEqual(sys.localizeRoleDescription("Edited by an admin"), "Edited by an admin");
  i18n.setLocale("en");
});

console.log("locale behaviour");
test("invalid stored/selected locale falls back to English", () => {
  i18n.setLocale("fr");
  assert.strictEqual(i18n.locale.value, "en");
  i18n.setLocale("id");
  assert.strictEqual(i18n.locale.value, "id");
});
test("interpolation, plural and formatting follow the locale", () => {
  i18n.setLocale("id");
  assert.strictEqual(i18n.t("auth.signedInAs", { name: "Ana" }), "Masuk sebagai Ana");
  assert.strictEqual(i18n.tn(1, "audit.recordsOne", "audit.recordsOther"), "1 catatan");
  assert.strictEqual(i18n.formatDate(new Date(2026, 10, 19)), "19 November 2026");
  assert.strictEqual(i18n.formatNumber(1234567), "1.234.567");
  i18n.setLocale("en");
  assert.strictEqual(i18n.formatDate(new Date(2026, 10, 19)), "November 19, 2026");
  assert.strictEqual(i18n.tn(2, "audit.recordsOne", "audit.recordsOther"), "2 records");
  assert.strictEqual(i18n.formatNumber(1234567), "1,234,567");
});
test("unknown messages pass through unchanged (never dropped)", () => {
  i18n.setLocale("id");
  assert.strictEqual(sys.localizeMessage("Some brand-new server text."), "Some brand-new server text.");
  assert.strictEqual(sys.localizeMessage(""), "");
  i18n.setLocale("en");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
