/**
 * Browser E2E: Master Data module + read-only 3PL Loader references
 * (headless Chrome via DevTools Protocol, no dependencies — Node >= 22).
 *
 *   npm run build && EMAIL_TRANSPORT=mock PORT=3011 node server/index.js
 *   BASE_URL=http://localhost:3011 node tests/e2e-master-data.mjs   # CHROME_PATH / SCREENSHOT_DIR
 *
 * Creates, edits and deletes one Kota_Tujuan → wilayah mapping through the UI
 * (removed again at the end) and checks the audit tab, the sidebar group,
 * both languages, and that the loader page has no edit controls left.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE_URL || 'http://localhost:3001'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9342
const SUFFIX = Date.now().toString(36)
const KOTA = `Kab. Uitest ${SUFFIX}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'oneops-md-e2e-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' })

let ws, seq = 0
const pend = new Map()
const send = (method, params = {}) => { const i = ++seq; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pend.set(i, { res, rej })) }
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
const waitFor = async (e, label, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(e).catch(() => false)) return; await sleep(100) } throw new Error('timeout: ' + label) }
const text = () => ev('document.body.innerText')
// Lower-cased page text: table headers are CSS-uppercased in innerText.
const lowerText = async () => (await text()).toLowerCase()
const type = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) })()`)
const clickText = (t, scope = 'button, a') => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => x.innerText.trim().includes(${JSON.stringify(t)})); if (!b) throw new Error('no element: ' + ${JSON.stringify(t)}); b.click() })()`)
const shot = async (n) => { if (!process.env.SCREENSHOT_DIR) return; const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(process.env.SCREENSHOT_DIR, `md-${n}.png`), Buffer.from(data, 'base64')) }
const go = async (path, ready, label) => { await send('Page.navigate', { url: BASE + path }); await waitFor(ready, label) }

let passed = 0, failed = 0
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok    ${name}`) } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`) } }
const assert = (c, m) => { if (!c) throw new Error(m) }

async function main() {
  let u = ''
  for (let i = 0; i < 50 && !u; i++) { try { u = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl || '' } catch {} if (!u) await sleep(200) }
  ws = new WebSocket(u)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) } })
  await send('Page.enable'); await send('Runtime.enable')
  // Confirm dialogs (delete) are accepted automatically.
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }) })
  console.log(`Master Data browser E2E against ${BASE}\n`)

  await go('/login', `!!document.querySelector('#username')`, 'login page')
  await ev(`localStorage.setItem('oneops.locale', 'en')`)
  await type('#username', 'superadmin'); await type('#password', 'admin123')
  await ev(`document.querySelector('form').requestSubmit()`)
  await waitFor(`location.pathname.startsWith('/ops/')`, 'login')

  await test('sidebar: MASTER DATA group with the 3 references + audit trail', async () => {
    const nav = await ev(`[...document.querySelectorAll('aside a')].map((a) => a.innerText.trim())`)
    for (const s of ['Gerai / HUB → KOTA PENERIMA', 'Kota_Tujuan → Wilayah', 'Kodepos Reference', 'Master Data Audit Trail']) assert(nav.includes(s), `nav item "${s}" missing: ${nav.join(' | ')}`)
    assert((await text()).includes('MASTER DATA'), 'group label')
  })

  await test('3PL Loader references are read-only (no inputs/import/delete), link to Master Data', async () => {
    await go('/ops/kodepos-loader', `/[0-9]+ kecamatan in the reference/.test(document.body.innerText)`, 'loader page')
    await waitFor(`document.body.innerText.includes('Subang Sukamelang LM')`, 'hub list')
    const t = await text()
    assert(!t.includes('Import master Excel') && !t.includes('Import DATAHUB.xlsx'), 'import buttons still on the loader page')
    assert(await ev(`!document.querySelector('#map-kota') && !document.querySelector('#map-wilayah')`), 'kota mapping form still present')
    assert(await ev(`![...document.querySelectorAll('button')].some((b) => (b.getAttribute('aria-label') || '').startsWith('Delete'))`), 'delete buttons still present')
    assert((t.match(/Read-only here\./g) || []).length >= 3, 'read-only notice on the 3 reference cards')
    const links = await ev(`[...document.querySelectorAll('a')].filter((a) => a.innerText.includes('Manage in Master Data')).map((a) => a.getAttribute('href'))`)
    assert(links.includes('/ops/master-data/hubs') && links.includes('/ops/master-data/kota-wilayah') && links.includes('/ops/master-data/kodepos'), `links ${links}`)
    await ev(`(() => { const el = document.querySelector('input[aria-label^="Look up"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'cibogo'); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await waitFor(`document.body.innerText.includes('41285')`, 'read-only kodepos lookup')
    await shot('loader-readonly')
  })

  await test('Master Data: create a Kota_Tujuan → wilayah mapping through the form', async () => {
    await go('/ops/master-data/kota-wilayah', `document.body.innerText.includes('Kab. Ciamis')`, 'kota tab')
    await clickText('Add')
    await waitFor(`!!document.querySelector('#md-kota')`, 'form')
    await type('#md-kota', KOTA)
    await type('#md-wilayah', 'GARUT')
    await ev(`document.querySelector('form[role=dialog]').requestSubmit()`)
    await waitFor(`document.body.innerText.includes('Record created.')`, 'created')
    await type('input[aria-label="Search…"]', SUFFIX)
    await waitFor(`document.body.innerText.includes(${JSON.stringify(KOTA)}) && document.body.innerText.includes('1 record(s)')`, 'search finds it')
    await shot('created')
  })

  await test('Master Data: edit, then delete (with confirmation)', async () => {
    await ev(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(`Edit — ${KOTA}`)}).click()`)
    await waitFor(`document.querySelector('#md-wilayah')?.value === 'GARUT'`, 'edit form prefilled')
    await type('#md-wilayah', 'SUBANG')
    await ev(`document.querySelector('form[role=dialog]').requestSubmit()`)
    await waitFor(`document.body.innerText.includes('Record updated.')`, 'updated')
    await waitFor(`[...document.querySelectorAll('tbody tr')].some((r) => r.innerText.includes(${JSON.stringify(KOTA)}) && r.innerText.includes('SUBANG'))`, 'row shows SUBANG')
    await ev(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(`Delete — ${KOTA}`)}).click()`)
    await waitFor(`document.body.innerText.includes('deleted.') && document.body.innerText.includes('0 record(s)')`, 'deleted')
  })

  await test('Master Data audit trail tab: CREATE / UPDATE / DELETE with before → after', async () => {
    await go('/ops/master-data/audit', `document.body.innerText.includes('Master Data Audit Trail')`, 'audit tab')
    await type('input[aria-label="Search record or user…"]', SUFFIX)
    await waitFor(`[...document.querySelectorAll('tbody tr')].filter((r) => r.innerText.includes(${JSON.stringify(KOTA)})).length === 3`, 'three audit rows')
    const rows = await ev(`[...document.querySelectorAll('tbody tr')].filter((r) => r.innerText.includes(${JSON.stringify(KOTA)})).map((r) => r.innerText)`)
    assert(rows[0].includes('Deleted') && rows[1].includes('Updated') && rows[2].includes('Created'), rows.join(' / '))
    await ev(`[...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes('Updated') && r.innerText.includes(${JSON.stringify(KOTA)})).click()`)
    await waitFor(`document.body.innerText.includes('Before') && document.body.innerText.includes('GARUT') && document.body.innerText.includes('SUBANG')`, 'diff GARUT → SUBANG')
    await type('select[aria-label="Action"]', 'DELETE')
    // search + action together → exactly this record's DELETE (the total must
    // not include other runs' deletions: guards the stale-response race).
    await waitFor(`document.body.innerText.includes('1 record(s)') && [...document.querySelectorAll('tbody tr')].filter((r) => r.innerText.includes(${JSON.stringify(KOTA)})).length === 1`, 'search + action filter')
    await sleep(800)
    assert(await ev(`document.body.innerText.includes('1 record(s)')`), 'a stale response replaced the filtered result')
    await shot('audit')
  })

  await test('Indonesian UI: menu, tabs, table and audit labels translated', async () => {
    await ev(`[...document.querySelector('aside').querySelectorAll('button[aria-pressed]')].find((b) => b.getAttribute('lang') === 'id').click()`)
    await sleep(300)
    let t = await lowerText()
    for (const s of ['Referensi Kodepos', 'Jejak Audit Master Data', 'Semua aksi', 'Semua data', 'Waktu', 'Pengguna']) assert(t.includes(s.toLowerCase()), `missing "${s}"`)
    await go('/ops/master-data/kodepos', `document.body.innerText.toLowerCase().includes('kecamatan')`, 'kodepos tab (id)')
    t = await lowerText()
    for (const s of ['Tambah', 'Impor Excel', 'Semua wilayah', 'Halaman 1 dari', 'Diperbarui', 'Aksi']) assert(t.includes(s.toLowerCase()), `missing "${s}"`)
    for (const s of ['Import Excel', 'All wilayah', 'Page 1 of', 'Updated', 'Actions']) assert(!t.includes(s.toLowerCase()), `untranslated "${s}"`)
    await go('/ops/kodepos-loader', `document.body.innerText.includes('Kelola di Master Data')`, 'loader page (id)')
    assert((await text()).includes('Hanya baca di sini.'), 'read-only notice (id)')
    await shot('id')
    await ev(`localStorage.setItem('oneops.locale', 'en')`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
}

main().catch((e) => { console.error(e); failed++ }).finally(async () => {
  // Safety net: remove the test mapping even if a step failed.
  try {
    const r = await ev(`(async () => { const list = await (await fetch('/api/master-data/kota-wilayah?search=${SUFFIX}')).json(); for (const row of list.rows || []) await fetch('/api/master-data/kota-wilayah/' + row.id, { method: 'DELETE' }); return (list.rows || []).length })()`)
    if (r) console.log(`cleanup: removed ${r} leftover mapping(s)`)
  } catch {}
  try { ws?.close() } catch {}
  chrome.kill(); await sleep(600)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
})
