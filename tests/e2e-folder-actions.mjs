/**
 * Browser E2E: Data Warrior folder actions — "Folders from Excel" (bulk create
 * with duplicate notification) and "Download all" (empty folder message).
 * Headless Chrome via DevTools Protocol, no dependencies — Node >= 22.
 *
 *   npm run build && EMAIL_TRANSPORT=mock PORT=3011 node server/index.js
 *   BASE_URL=http://localhost:3011 node tests/e2e-folder-actions.mjs   # CHROME_PATH / SCREENSHOT_DIR
 *
 * Creates a temporary root folder (Super Admin) and removes it at the end.
 * No file is uploaded, so R2 is never used.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')

const BASE = process.env.BASE_URL || 'http://localhost:3001'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9344
const SUFFIX = Date.now().toString(36)
const ROOT_NAME = `e2e-folders-${SUFFIX}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const work = mkdtempSync(join(tmpdir(), 'oneops-folders-e2e-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, 'profile')}`, '--no-first-run', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' })

// Folder list: Garut, Subang, Tasik created; "garut" and "SUBANG" are duplicates in the file.
const LIST = join(work, 'daftar-folder.xlsx')
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Nama Folder'], ['Garut'], ['Subang'], ['garut'], ['Tasik'], ['SUBANG']]), 'Sheet1')
writeFileSync(LIST, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))

let ws, seq = 0
const pend = new Map()
const send = (method, params = {}) => { const i = ++seq; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pend.set(i, { res, rej })) }
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
const waitFor = async (e, label, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(e).catch(() => false)) return; await sleep(100) } throw new Error('timeout: ' + label) }
const type = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
const shot = async (n) => { if (!process.env.SCREENSHOT_DIR) return; const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(process.env.SCREENSHOT_DIR, `folders-${n}.png`), Buffer.from(data, 'base64')) }
const go = async (path, ready, label) => { await send('Page.navigate', { url: BASE + path }); await waitFor(ready, label) }
async function setFile(selector, filePath) {
  const { root } = await send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector })
  await send('DOM.setFileInputFiles', { nodeId, files: [filePath] })
}
const toasts = () => ev(`document.body.innerText`)

let passed = 0, failed = 0
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok    ${name}`) } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`) } }
const assert = (c, m) => { if (!c) throw new Error(m) }
let rootId = null

async function main() {
  let u = ''
  for (let i = 0; i < 50 && !u; i++) { try { u = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl || '' } catch {} if (!u) await sleep(200) }
  ws = new WebSocket(u)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) } })
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable')
  console.log(`Data Warrior folder actions browser E2E against ${BASE}\n`)

  await go('/login', `!!document.querySelector('#username')`, 'login page')
  await ev(`localStorage.setItem('oneops.locale', 'en')`)
  await type('#username', 'superadmin'); await type('#password', 'admin123')
  await ev(`document.querySelector('form').requestSubmit()`)
  await waitFor(`location.pathname.startsWith('/ops/')`, 'login')
  rootId = await ev(`(async () => (await (await fetch('/api/storage/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: ${JSON.stringify(ROOT_NAME)} }) })).json()).folder.id)()`)
  assert(rootId, 'temp root folder')

  await go('/ops/data-warrior', `[...document.querySelectorAll('p')].some((p) => p.innerText.trim() === ${JSON.stringify(ROOT_NAME)})`, 'data warrior')
  await ev(`[...document.querySelectorAll('p')].find((p) => p.innerText.trim() === ${JSON.stringify(ROOT_NAME)}).closest('.group').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`) // single click selects; double-click opens
  await waitFor(`!!document.querySelector('[data-testid="bulk-folders"]') && document.body.innerText.includes('This folder is empty') || !!document.querySelector('[data-testid="download-all-current"]')`, 'inside the temp folder')

  await test('Folders from Excel: 3 created, duplicates in the file skipped, red rows + notification', async () => {
    await ev(`document.querySelector('[data-testid="bulk-folders"]').click()`)
    await waitFor(`!!document.querySelector('[data-testid="bulk-dialog"]')`, 'dialog')
    const text = await ev(`document.querySelector('[data-testid="bulk-dialog"]').innerText`)
    assert(text.includes('Create folders from Excel') && text.includes(`Create in: ${ROOT_NAME}`), `dialog: ${text.slice(0, 200)}`)
    await setFile('[data-testid="bulk-input"]', LIST)
    await waitFor(`!!document.querySelector('[data-testid="bulk-summary"]')`, 'result', 30000)
    const summary = await ev(`document.querySelector('[data-testid="bulk-summary"]').innerText`)
    assert(summary.includes('3 folder(s) created, 2 skipped.'), `summary: ${summary}`)
    const skipped = await ev(`[...document.querySelectorAll('[data-testid="bulk-dialog"] tr[data-skipped]')].map((tr) => tr.innerText.replace(/\\s+/g, ' ').trim())`)
    assert(skipped.length === 2 && skipped[0].includes('garut') && skipped[0].includes('same as row 2') && skipped[1].includes('SUBANG') && skipped[1].includes('same as row 3'), `skipped rows: ${skipped}`)
    const all = await toasts()
    assert(all.includes('Duplicate folder names skipped (2): garut, SUBANG'), 'duplicate notification')
    await shot('bulk')
    await ev(`document.querySelector('[data-testid="bulk-dialog"] button[aria-label="Close"]').click()`)
    await waitFor(`['Garut', 'Subang', 'Tasik'].every((n) => [...document.querySelectorAll('p')].some((p) => p.innerText.trim() === n))`, 'new folders listed')
    const garuts = await ev(`[...document.querySelectorAll('main p')].filter((p) => p.innerText.trim().toLowerCase() === 'garut').length`)
    assert(garuts === 1, `"Garut" listed ${garuts} times`)
  })

  await test('Download all on a folder without files → clear message, no download', async () => {
    await waitFor(`!!document.querySelector('[data-testid="download-all-current"]')`, 'download all button')
    await ev(`document.querySelector('[data-testid="download-all-current"]').click()`)
    await waitFor(`document.body.innerText.includes(${JSON.stringify(`Folder "${ROOT_NAME}" has no files to download.`)})`, 'empty message')
  })

  await test('Indonesian UI: buttons, dialog and results translated', async () => {
    await ev(`[...document.querySelector('aside').querySelectorAll('button[aria-pressed]')].find((b) => b.getAttribute('lang') === 'id').click()`)
    await sleep(300)
    const t = await ev('document.body.innerText')
    assert(t.includes('Folder dari Excel') && t.includes('Unduh semua'), 'header buttons (id)')
    await ev(`document.querySelector('[data-testid="bulk-folders"]').click()`)
    await waitFor(`!!document.querySelector('[data-testid="bulk-dialog"]')`, 'dialog (id)')
    const d = await ev(`document.querySelector('[data-testid="bulk-dialog"]').innerText`)
    assert(d.includes('Buat folder dari Excel') && d.includes('Pilih file Excel'), `dialog (id): ${d.slice(0, 200)}`)
    await setFile('[data-testid="bulk-input"]', LIST)
    await waitFor(`!!document.querySelector('[data-testid="bulk-summary"]')`, 'result (id)', 30000)
    const s = await ev(`document.querySelector('[data-testid="bulk-dialog"]').innerText`)
    // Same file again: every name already exists now → nothing created.
    assert(s.includes('0 folder dibuat, 5 dilewati.') && s.includes('Sudah ada di folder ini'), `result (id): ${s.slice(0, 400)}`)
    await ev(`localStorage.setItem('oneops.locale', 'en')`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
}

main().catch((e) => { console.error(e); failed++ }).finally(async () => {
  try {
    if (rootId) {
      await ev(`(async () => { await fetch('/api/storage/folders/${rootId}', { method: 'DELETE' }) })()`)
    }
  } catch {}
  try { ws?.close() } catch {}
  chrome.kill(); await sleep(600)
  try { rmSync(work, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
})
