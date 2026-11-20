/**
 * Browser E2E: Kodepos Loader page (headless Chrome via DevTools Protocol,
 * no dependencies — Node >= 22). Requires the built app served by the
 * backend, migration 010 + reference imported, seed users, and ./tmp samples.
 *
 *   npm run build && SICEPAT_BASE_URL=http://localhost:39191/ LOADER_RECHECK_DELAY_MS=0  *     EMAIL_TRANSPORT=mock node server/index.js
 *   node tests/e2e-loader.mjs          # BASE_URL / CHROME_PATH / SCREENSHOT_DIR
 *
 * The API-mode test talks to a MOCK SiCepat started here (MOCK_SICEPAT_PORT,
 * default 39191); it is skipped when the backend is not pointed at it.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx')
const ExcelJS = require('exceljs')
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const BASE = process.env.BASE_URL || 'http://localhost:3001'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9338
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TEMPLATE = join(ROOT, 'tmp', 'TEMPLATE 3PL - 2026-11-20T124928.943.xlsx')
const work = mkdtempSync(join(tmpdir(), 'oneops-loader-e2e-'))
const downloads = join(work, 'downloads')
const profile = join(work, 'profile')

// Rechecked file built from the template's own resi (local temp only).
const tpl = XLSX.utils.sheet_to_json(XLSX.readFile(TEMPLATE).Sheets.Sheet1, { defval: '' })
const recWb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(recWb, XLSX.utils.aoa_to_sheet([['Resi', 'Penerima', 'No HP Penerima'],
  ...tpl.map((r, i) => [Number(r.Resi), r.Penerima, `0812${String(5000000 + i)}`])]), 'Sheet2')
const RECHECKED = join(work, 'rechecked-e2e.xlsx')
writeFileSync(RECHECKED, XLSX.write(recWb, { type: 'buffer', bookType: 'xlsx' }))

// Mock SiCepat awbDetail: every AWB gets a number, records the forwarded token.
const MOCK_PORT = Number(process.env.MOCK_SICEPAT_PORT || 39191)
const mockCalls = []
const mock = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const awb = JSON.parse(body || '{}').awb_number
    mockCalls.push({ awb, bearer: req.headers.authorization })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ value: `0813${String(awb).slice(-8)}` }))
  })
})
await new Promise((r) => mock.listen(MOCK_PORT, r))

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-extensions', '--window-size=1400,1100', 'about:blank'], { stdio: 'ignore' })
let ws, seq = 0
const pend = new Map()
const requests = []
const send = (method, params = {}) => { const i = ++seq; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pend.set(i, { res, rej })) }
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
const waitFor = async (e, l, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(e).catch(() => false)) return; await sleep(100) } throw new Error('timeout: ' + l) }
const shot = async (n) => { if (!process.env.SCREENSHOT_DIR) return; const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(process.env.SCREENSHOT_DIR, `loader-${n}.png`), Buffer.from(data, 'base64')) }
const type = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
async function setFile(index, filePath) {
  const { root } = await send('DOM.getDocument', { depth: -1 })
  const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' })
  await send('DOM.setFileInputFiles', { nodeId: nodeIds[index], files: [filePath] })
}
const clickText = (text) => ev(`[...document.querySelectorAll('button')].find((b) => b.innerText.includes(${JSON.stringify(text)})).click()`)

let passed = 0, failed = 0
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok    ${name}`) } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`) } }
const assert = (c, m) => { if (!c) throw new Error(m) }

async function main() {
  for (let i = 0; i < 50 && !ws; i++) { try { const u = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; if (u) ws = new WebSocket(u) } catch {} if (!ws) await sleep(200) }
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) }
    else if (d.method === 'Network.requestWillBeSent') { const u = new URL(d.params.request.url); if (u.pathname.startsWith('/api/')) requests.push(u.pathname) }
  })
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('DOM.enable')
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true })
  console.log(`3PL Loader browser E2E against ${BASE}\n`)

  await send('Page.navigate', { url: BASE + '/login' })
  await waitFor(`!!document.querySelector('#username')`, 'login page')
  await ev(`localStorage.setItem('oneops.locale', 'en')`)
  await type('#username', 'superadmin'); await type('#password', 'admin123')
  await ev(`document.querySelector('form').requestSubmit()`)
  await waitFor(`location.pathname.startsWith('/ops/')`, 'login')

  await test('sidebar shows the loader; page loads reference summary', async () => {
    assert(await ev(`[...document.querySelectorAll('aside a')].some((a) => a.innerText.includes('Kodepos Loader'))`), 'nav item missing')
    await send('Page.navigate', { url: BASE + '/ops/kodepos-loader' })
    await waitFor(`document.body.innerText.includes('162 kecamatan in the reference')`, 'summary')
  })

  await test('client validation: files + two different cust ids required (no request sent)', async () => {
    const m = requests.length
    await clickText('Process & download')
    await waitFor(`document.body.innerText.includes('Choose both Excel files first.')`, 'files required')
    await setFile(0, TEMPLATE); await setFile(1, RECHECKED)
    await waitFor(`document.body.innerText.includes('rechecked-e2e.xlsx')`, 'files picked')
    await type('#cust-noncod', '82220303'); await type('#cust-cod', '82220303')
    await clickText('Process & download')
    await waitFor(`document.body.innerText.includes('The COD and Non-COD cust IDs must be different.')`, 'same ids')
    assert(!requests.slice(m).includes('/api/loader/process'), 'request sent despite invalid form')
  })

  await test('process → automatic download of the styled .xlsx + result summary', async () => {
    await type('#cust-cod', '82220300')
    await clickText('Process & download')
    await waitFor(`document.body.innerText.includes('No warnings') || document.body.innerText.includes('Needs attention')`, 'result', 60000)
    let file = ''
    for (let i = 0; i < 100 && !file; i++) { file = existsSync(downloads) ? (readdirSync(downloads).find((f) => f.endsWith('.xlsx')) || '') : ''; if (!file) await sleep(100) }
    assert(file === 'LOADER - TEMPLATE 3PL - 2026-11-20T124928.943.xlsx', `download missing: ${file}`)
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(readFileSync(join(downloads, file)))
    const sheet = wb.worksheets[0]
    assert(sheet.rowCount === 120, `rows ${sheet.rowCount}`)
    assert(sheet.getRow(1).getCell(7).value === 'KODEPOS', 'KODEPOS column')
    assert(sheet.getRow(1).getCell(3).value === 'Berat Asli', 'Berat Asli right of Berat')
    assert(typeof sheet.getRow(2).getCell(14).value === 'number', 'CUST ID numeric')
    const txt = await ev('document.body.innerText')
    assert(txt.includes('No warnings — the file is ready to upload.'), 'expected no warnings')
    assert(/119\s*\/\s*119/.test(txt), 'kodepos / phones counts')
    await shot('result-en')
  })

  await test('Indonesian UI', async () => {
    await ev(`[...document.querySelector('aside').querySelectorAll('button[aria-pressed]')].find((b) => b.getAttribute('lang') === 'id').click()`)
    await sleep(300)
    const txt = await ev('document.body.innerText')
    for (const s of ['Loader Kodepos', 'Proses & unduh', 'Unduh lagi', 'Tidak ada peringatan', 'Referensi kodepos', 'Berat dinormalisasi']) assert(txt.includes(s), `missing "${s}"`)
    await shot('result-id')
    await ev(`localStorage.setItem('oneops.locale', 'en')`)
  })

  await test('"Download again" re-downloads the same file', async () => {
    const before = readdirSync(downloads).length
    await ev(`[...document.querySelectorAll('aside button[aria-pressed]')].find((b) => b.getAttribute('lang') === 'en').click()`)
    await clickText('Download again')
    for (let i = 0; i < 100 && readdirSync(downloads).length === before; i++) await sleep(100)
    assert(readdirSync(downloads).length > before, 'no second download')
  })

  await test('API mode: rechecker token from Settings → pre-check → job progress → automatic download', async () => {
    await send('Page.navigate', { url: BASE + '/ops/kodepos-loader' })
    await waitFor(`document.body.innerText.includes('162 kecamatan in the reference')`, 'page')
    await ev(`[...document.querySelectorAll('button[aria-pressed]')].find((b) => b.innerText.includes('Recheck automatically')).click()`)
    await waitFor(`document.body.innerText.includes('No rechecker token set')`, 'token missing notice')
    // The existing rechecker token system (localStorage), picked up on window focus.
    await ev(`localStorage.setItem('sicepat.bearerToken', 'e2e-bearer'); localStorage.setItem('sicepat.permissionToken', 'e2e-perm'); localStorage.setItem('sicepat.userId', 'e2e-user'); window.dispatchEvent(new Event('focus'))`)
    await waitFor(`document.body.innerText.includes('The active rechecker token')`, 'token ready')
    await setFile(0, TEMPLATE)
    await type('#cust-noncod', '82220303'); await type('#cust-cod', '82220300')
    const before = existsSync(downloads) ? readdirSync(downloads).length : 0
    mockCalls.length = 0
    await clickText('Check & start recheck')
    await waitFor(`document.body.innerText.includes('Numbers from SiCepat')`, 'job finished + result', 90000)
    if (!mockCalls.length) throw new Error('backend is not pointed at the mock SiCepat (SICEPAT_BASE_URL)')
    assert(mockCalls.length === 119, `lookups ${mockCalls.length}`)
    assert(mockCalls.every((c) => c.bearer === 'Bearer e2e-bearer'), 'token not forwarded')
    let n = before
    for (let i = 0; i < 150 && n === before; i++) { await sleep(100); n = readdirSync(downloads).length }
    assert(n > before, 'no automatic download')
    assert(await ev(`document.body.innerText.includes('Loader history')`), 'history card missing')
    await shot('api-done')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
}

main().catch((e) => { console.error(e); failed++ }).finally(async () => {
  try { ws?.close() } catch {}
  chrome.kill(); mock.close(); await sleep(600)
  try { rmSync(work, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
})
