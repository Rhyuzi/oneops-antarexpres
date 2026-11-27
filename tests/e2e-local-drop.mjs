/**
 * Browser E2E: Data Warrior drag & drop / paste from the local file manager,
 * and Set Permission visibility (Super Admin only).
 *   - drop a folder tree (sub-folders, empty folder, loose file) onto the open
 *     folder: a same-named folder is merged (notification), the rest created,
 *     every file uploaded into its folder (source "drop")
 *   - dropping the same tree again creates nothing (no twins)
 *   - Ctrl/Cmd+V with files → uploaded into the current folder (source "paste");
 *     paste inside an input is ignored
 *   - loose files dropped on Root are refused (files live inside folders)
 *   - Super Admin: Set Permission visible; the modal lists no super_admin role and
 *     no "Manage" column. A non-Super Admin (finance) sees no Set Permission and
 *     gets 403 from the permissions API.
 *
 * The R2 transfer is intercepted (CDP Fetch: upload-url / PUT / complete-upload),
 * so nothing is written to the bucket; folders are created for real (removed at the end).
 * Node >= 22, local Chrome.
 *
 *   npm run build && EMAIL_TRANSPORT=mock PORT=3011 node server/index.js
 *   BASE_URL=http://localhost:3011 node tests/e2e-local-drop.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE_URL || 'http://localhost:3001'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9347
const SUFFIX = Date.now().toString(36)
const ROOT_NAME = `e2e-drop-${SUFFIX}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const work = mkdtempSync(join(tmpdir(), 'oneops-drop-e2e-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, 'profile')}`, '--no-first-run', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' })

let ws, seq = 0
const pend = new Map()
const send = (method, params = {}) => { const i = ++seq; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pend.set(i, { res, rej })) }
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
const waitFor = async (e, label, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(e).catch(() => false)) return; await sleep(80) } throw new Error('timeout: ' + label) }
const type = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
const shot = async (n) => { if (!process.env.SCREENSHOT_DIR) return; const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(process.env.SCREENSHOT_DIR, `drop-${n}.png`), Buffer.from(data, 'base64')) }
const go = async (path, ready, label) => { await send('Page.navigate', { url: BASE + path }); await waitFor(ready, label) }
const bodyHas = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`

// ---- R2 transfer interception -------------------------------------------------------
const uploads = [] // { folderId, fileName, token }
const completes = [] // { uploadToken, source }
let fakeSeq = 0
const b64 = (s) => Buffer.from(s).toString('base64')
async function onPaused(p) {
  const { requestId, request } = p
  const json = (obj) => send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: b64(JSON.stringify(obj)) })
  try {
    if (request.url.includes('/api/storage/files/upload-url')) {
      const body = JSON.parse(request.postData || '{}')
      const n = ++fakeSeq
      uploads.push({ folderId: body.folderId, fileName: body.fileName, token: `tok.${n}` })
      return await json({ ok: true, uploadUrl: `${BASE}/__e2e_fake_r2/${n}`, objectKey: `fake/${n}`, uploadToken: `tok.${n}`, expiresIn: 600 })
    }
    if (request.url.includes('/__e2e_fake_r2/')) return await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [], body: '' })
    if (request.url.includes('/api/storage/files/complete-upload')) {
      const body = JSON.parse(request.postData || '{}')
      completes.push(body)
      return await json({ ok: true, file: { id: 0, file_name: 'x' } })
    }
    await send('Fetch.continueRequest', { requestId })
  } catch (e) { console.log('intercept error', e.message) }
}

// Fake dropped items (FileSystem entries API) built inside the page.
const ENTRY_HELPERS = `
  const mkFile = (name) => new File(['hello ' + name], name, { type: 'text/plain' })
  const fileEntry = (name) => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(mkFile(name)) })
  const dirEntry = (name, children) => ({ isFile: false, isDirectory: true, name, createReader: () => { let done = false; return { readEntries: (ok) => { const batch = done ? [] : children; done = true; setTimeout(() => ok(batch), 0) } } } })
  const drop = (entries) => {
    const zone = document.querySelector('[data-testid="drop-zone"]')
    const dt = { items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })), files: [] }
    for (const type of ['dragover', 'drop']) {
      const evt = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(evt, 'dataTransfer', { value: dt })
      zone.dispatchEvent(evt)
    }
  };`

let passed = 0, failed = 0
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok    ${name}`) } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`) } }
const assert = (c, m) => { if (!c) throw new Error(m) }
let rootId = null
let financeRoleId = null

const api = (method, url, body) => ev(`(async () => { const r = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, ${body ? `body: JSON.stringify(${JSON.stringify(body)})` : ''} }); return { status: r.status, json: await r.json().catch(() => null) } })()`)
const children = async (parentId) => (await api('GET', '/api/storage/folders')).json.folders.filter((f) => f.parent_id === parentId)

async function login(user, pass) {
  await send('Network.clearBrowserCookies')
  await go('/login', `!!document.querySelector('#username')`, 'login page')
  await ev(`localStorage.setItem('oneops.locale', 'en')`)
  await type('#username', user); await type('#password', pass)
  await ev(`document.querySelector('form').requestSubmit()`)
  await waitFor(`location.pathname.startsWith('/ops/')`, `login ${user}`)
}
async function openRoot() {
  await go('/ops/data-warrior', `[...document.querySelectorAll('p')].some((p) => p.innerText.trim() === ${JSON.stringify(ROOT_NAME)})`, 'data warrior')
  await ev(`[...document.querySelectorAll('[data-item-key]')].find((el) => el.querySelector('p')?.innerText.trim() === ${JSON.stringify(ROOT_NAME)}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await waitFor(`[...document.querySelectorAll('[data-item-key]')].some((el) => el.querySelector('p')?.innerText.trim() === 'Invoices')`, 'inside the test folder')
}

async function main() {
  let u = ''
  for (let i = 0; i < 50 && !u; i++) { try { u = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl || '' } catch {} if (!u) await sleep(200) }
  ws = new WebSocket(u)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data)
    if (d.method === 'Fetch.requestPaused') return void onPaused(d.params)
    if (d.method === 'Runtime.exceptionThrown') console.log('        [page error]', d.params.exceptionDetails?.exception?.description?.split(String.fromCharCode(10))[0])
    if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) }
  })
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/storage/files/upload-url*' }, { urlPattern: '*/__e2e_fake_r2/*' }, { urlPattern: '*/api/storage/files/complete-upload*' }] })
  console.log(`Data Warrior drag & drop / paste / permissions browser E2E against ${BASE}\n`)

  await test('login form: one field for username or email', async () => {
    await go('/login', `!!document.querySelector('#username')`, 'login page')
    await ev(`localStorage.setItem('oneops.locale', 'en')`)
    await send('Page.reload'); await sleep(300); await waitFor(`!!document.querySelector('label[for="username"]')`, 'reload')
    assert((await ev(`document.querySelector('label[for="username"]').innerText.trim()`)) === 'Username or email', 'label')
    assert((await ev(`document.querySelector('#username').placeholder`)) === 'Username or email', 'placeholder')
  })

  await login('superadmin', 'admin123')
  rootId = await ev(`(async () => {
    const post = async (body) => (await (await fetch('/api/storage/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()).folder.id
    const root = await post({ name: ${JSON.stringify(ROOT_NAME)} })
    await post({ name: 'Invoices', parentId: root })
    return root
  })()`)
  await openRoot()

  let invoicesId, y2026Id
  await test('drop a folder tree: existing "Invoices" merged (notification), new folders created, files uploaded into their folders', async () => {
    await ev(`(() => { ${ENTRY_HELPERS}
      drop([dirEntry('invoices', [fileEntry('a.txt'), dirEntry('2026', [fileEntry('b.txt'), fileEntry('c.txt')])]), dirEntry('Reports', []), fileEntry('loose.txt')])
    })()`)
    await waitFor(bodyHas('already existed and were merged'), 'merged notification')
    assert(await ev(bodyHas('1 folder(s) already existed and were merged (no duplicate created): invoices')), 'names the merged folder')
    await waitFor(bodyHas('Upload finished: 4 file(s) uploaded, 2 new folder(s) created.'), 'summary notification')
    await shot('dropped')
    const kids = await children(rootId)
    assert(kids.filter((f) => f.name.toLowerCase() === 'invoices').length === 1, 'still ONE Invoices folder')
    assert(kids.some((f) => f.name === 'Reports'), 'empty folder created')
    invoicesId = kids.find((f) => f.name === 'Invoices').id
    y2026Id = (await children(invoicesId)).find((f) => f.name === '2026')?.id
    assert(y2026Id, 'sub-folder 2026 inside the existing Invoices')
    const where = Object.fromEntries(uploads.map((x) => [x.fileName, x.folderId]))
    assert(where['a.txt'] === invoicesId, `a.txt → Invoices (${where['a.txt']})`)
    assert(where['b.txt'] === y2026Id && where['c.txt'] === y2026Id, 'b/c → Invoices/2026')
    assert(where['loose.txt'] === rootId, 'loose file → the open folder')
    assert(completes.length === 4 && completes.every((c) => c.source === 'drop'), `sources ${JSON.stringify(completes.map((c) => c.source))}`)
  })

  await test('dropping the same tree again creates no twin folders', async () => {
    const before = (await api('GET', '/api/storage/folders')).json.folders.length
    await ev(`(() => { ${ENTRY_HELPERS} drop([dirEntry('Invoices', [dirEntry('2026', [])]), dirEntry('REPORTS', [])]) })()`)
    await waitFor(bodyHas('3 folder(s) already existed and were merged'), 'merged notification (3)')
    await sleep(300)
    assert((await api('GET', '/api/storage/folders')).json.folders.length === before, 'no new folders')
  })

  await test('Ctrl/Cmd+V with files → uploaded into the current folder (source "paste"); paste in an input is ignored', async () => {
    const n = uploads.length
    await ev(`(() => {
      const f = new File(['pasted'], 'pasted.png', { type: 'image/png' })
      const evt = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(evt, 'clipboardData', { value: { items: [{ kind: 'file' }], files: [f] } })
      document.body.dispatchEvent(evt)
    })()`)
    await waitFor(bodyHas('Upload finished: 1 file(s) uploaded, 0 new folder(s) created.'), 'paste summary')
    assert(uploads.length === n + 1 && uploads[n].fileName === 'pasted.png' && uploads[n].folderId === rootId, 'pasted into the open folder')
    assert(completes[completes.length - 1].source === 'paste', 'source paste')
    await ev(`(() => {
      const input = document.querySelector('input[type="search"], input[placeholder]')
      const evt = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(evt, 'clipboardData', { value: { items: [{ kind: 'file' }], files: [new File(['x'], 'ignored.png')] } })
      input.dispatchEvent(evt)
    })()`)
    await sleep(500)
    assert(uploads.length === n + 1, 'paste inside an input does not upload')
  })

  await test('Super Admin: Set Permission visible; modal without super_admin role and without the Manage column', async () => {
    assert(await ev(`!!document.querySelector('[data-testid="permission-bar"]')`), 'permission bar in the folder')
    await ev(`[...document.querySelectorAll('[data-item-key]')].find((el) => el.querySelector('p')?.innerText.trim() === 'Invoices').querySelector('[data-testid="item-menu"]').click()`)
    await waitFor(`!!document.querySelector('[data-testid="menu-permissions"]')`, 'menu entry')
    await ev(`document.querySelector('[data-testid="menu-permissions"]').click()`)
    await waitFor(`!!document.querySelector('[data-testid="permission-modal"] tbody tr')`, 'permission modal rows')
    const rows = await ev(`[...document.querySelectorAll('[data-testid="permission-modal"] tbody tr')].map((tr) => tr.innerText.split('\\n')[0].trim().toLowerCase())`)
    assert(!rows.some((r) => r === 'super admin'), `no super admin row: ${rows}`)
    const heads = await ev(`[...document.querySelectorAll('[data-testid="permission-modal"] thead th')].map((th) => th.innerText.trim())`)
    assert(!heads.includes('Manage'), `no Manage column: ${heads}`)
    await ev(`document.querySelector('[data-testid="permission-modal"] [aria-label="Close"]').click()`)
  })

  await test('loose files dropped on Root are refused (files must be inside a folder)', async () => {
    await ev(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Root').click()`)
    await waitFor(`[...document.querySelectorAll('p')].some((p) => p.innerText.trim() === ${JSON.stringify(ROOT_NAME)})`, 'root')
    const n = uploads.length
    await ev(`(() => { ${ENTRY_HELPERS} drop([fileEntry('root-file.txt')]) })()`)
    await waitFor(bodyHas('must be placed inside a folder'), 'refused')
    assert(uploads.length === n, 'nothing uploaded')
  })

  await test('non-Super Admin (finance, even with a can_manage_permissions row): no Set Permission, API 403', async () => {
    const roles = (await api('GET', `/api/storage/folders/${rootId}/permissions`)).json.roles
    const fin = roles.find((r) => r.name === 'finance')
    assert(fin, 'finance role exists')
    financeRoleId = fin.id
    assert(!roles.some((r) => r.name === 'super_admin'), 'super_admin not listed')
    assert((await api('PUT', `/api/storage/folders/${rootId}/permissions`, { permissions: [{ role_id: fin.id, can_view: true, can_manage_permissions: true }] })).status === 200, 'grant view')
    await login('finance', 'admin123')
    await openRoot()
    assert(!(await ev(`!!document.querySelector('[data-testid="permission-bar"]')`)), 'no permission bar')
    await ev(`[...document.querySelectorAll('[data-item-key]')].find((el) => el.querySelector('p')?.innerText.trim() === 'Invoices').querySelector('[data-testid="item-menu"]').click()`)
    await waitFor(`!!document.querySelector('[data-testid="menu-select"]')`, 'menu open')
    assert(!(await ev(`!!document.querySelector('[data-testid="menu-permissions"]')`)), 'no Set Permission entry')
    const r = await api('GET', `/api/storage/folders/${rootId}/permissions`)
    assert(r.status === 403 && r.json.code === 'SUPER_ADMIN_ONLY', `API ${r.status}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
}

main().catch((e) => { console.error(e); failed++ }).finally(async () => {
  try {
    if (rootId) {
      await send('Network.clearBrowserCookies')
      await ev(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'superadmin', password: 'admin123' }) })`)
      // A row with no capability removes the finance grant (PUT only touches listed roles).
      if (financeRoleId) await api('PUT', `/api/storage/folders/${rootId}/permissions`, { permissions: [{ role_id: financeRoleId }] })
      await api('DELETE', `/api/storage/folders/${rootId}`)
    }
  } catch (e) { console.log('cleanup', e.message) }
  try { ws?.close() } catch {}
  chrome.kill(); await sleep(600)
  try { rmSync(work, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
})
