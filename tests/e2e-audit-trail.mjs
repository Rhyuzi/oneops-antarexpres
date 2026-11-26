/**
 * Browser E2E: Audit Trail page (headless Chrome via DevTools Protocol,
 * no dependencies — Node >= 22). Requires the built app served by the
 * backend (npm run build; EMAIL_TRANSPORT=mock node server/index.js) and the
 * seed users. Read-only: creates no data besides login/logout audit events.
 *
 *   node tests/e2e-audit-trail.mjs        # BASE_URL, CHROME_PATH, SCREENSHOT_DIR optional
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE_URL || 'http://localhost:3001'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9334
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profileDir = mkdtempSync(join(tmpdir(), 'oneops-audit-e2e-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  '--no-first-run', '--disable-extensions', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' })

let ws, seq = 0
const pending = new Map()
const requests = []
const send = (method, params = {}) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
async function connect() {
  let url
  for (let i = 0; i < 50 && !url; i++) {
    try { url = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch {}
    if (!url) await sleep(200)
  }
  ws = new WebSocket(url)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
    else if (m.method === 'Network.requestWillBeSent') {
      const u = new URL(m.params.request.url)
      if (u.pathname.startsWith('/api/')) requests.push({ method: m.params.request.method, path: u.pathname, search: u.search })
    }
  })
  await send('Network.enable'); await send('Page.enable'); await send('Runtime.enable')
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
async function waitFor(expr, label, timeout = 15000) {
  const t = Date.now()
  while (Date.now() - t < timeout) { if (await evaluate(expr).catch(() => false)) return; await sleep(100) }
  throw new Error(`timeout: ${label}`)
}
async function navigate(path) {
  await send('Page.navigate', { url: BASE + path })
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#app *')`, `load ${path}`)
  await sleep(500)
}
async function shot(name) {
  if (!process.env.SCREENSHOT_DIR) return
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(process.env.SCREENSHOT_DIR, `audit-${name}.png`), Buffer.from(data, 'base64'))
}
async function loginAs(u, p) {
  await navigate('/login')
  await evaluate(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) };
    set(document.querySelector('#username'), '${u}'); set(document.querySelector('#password'), '${p}'); document.querySelector('form').requestSubmit() })()`)
  await waitFor(`location.pathname.startsWith('/ops/') || location.pathname === '/no-access'`, 'after login')
}
async function logout() {
  await evaluate(`fetch('/api/auth/logout', { method: 'POST' })`)
}

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`) } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`) }
}
const assert = (c, m) => { if (!c) throw new Error(m) }
// Exact label: "Master Data Audit Trail" (master_data.audit) is a different menu item.
const navHasAudit = `[...document.querySelectorAll('aside a, nav a')].some((a) => a.textContent.trim() === 'Audit Trail')`
const rowCount = `document.querySelectorAll('table tbody tr').length`

async function main() {
  await connect()
  console.log(`Audit Trail browser E2E against ${BASE}\n`)

  await loginAs('superadmin', 'admin123')
  await test('Super Admin sees the Audit Trail menu without any grant and the page lists records', async () => {
    assert(await evaluate(navHasAudit), 'menu item missing')
    await navigate('/ops/audit-trail')
    await waitFor(`${rowCount} > 0`, 'rows')
    assert(await evaluate(`document.body.textContent.includes('Timestamp') && document.body.textContent.includes('IP address')`), 'columns missing')
    await shot('01-list')
  })

  await test('module filter: one request, only Authentication rows', async () => {
    const m = requests.length
    await evaluate(`(() => { const s = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'authentication'));
      s.value = 'authentication'; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await waitFor(`!document.querySelector('[aria-busy="true"]') && ${rowCount} > 0`, 'filtered rows')
    await sleep(400)
    const calls = requests.slice(m).filter((r) => r.path === '/api/audit-trail')
    assert(calls.length === 1, `list requests = ${calls.length}`)
    assert(calls[0].search.includes('module=authentication'), calls[0].search)
    const chips = await evaluate(`[...document.querySelectorAll('table tbody tr td:nth-child(4)')].map((td) => td.textContent.trim())`)
    assert(chips.every((c) => c === 'Authentication'), `foreign modules: ${[...new Set(chips)]}`)
  })

  await test('pagination: Next loads page 2 from the server', async () => {
    const first = await evaluate(`document.querySelector('table tbody tr td').textContent`)
    const m = requests.length
    await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Next')).click()`)
    await waitFor(`document.body.textContent.includes('page 2 of')`, 'page 2')
    const call = requests.slice(m).find((r) => r.path === '/api/audit-trail')
    assert(call && call.search.includes('page=2'), 'no page=2 request')
    void first
  })

  await test('search + detail drawer shows before/after comparison', async () => {
    await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Clear filters')).click()`)
    await sleep(300)
    await evaluate(`(() => { const s = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'account.profile_updated'));
      if (!s) throw new Error('no profile_updated action in filter'); s.value = 'account.profile_updated'; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await waitFor(`${rowCount} > 0 && [...document.querySelectorAll('table tbody tr')].every((tr) => tr.textContent.includes('account.profile_updated'))`, 'profile rows')
    await evaluate(`document.querySelector('table tbody tr').click()`)
    await waitFor(`!!document.querySelector('[role=dialog]') && document.querySelector('[role=dialog]').textContent.includes('Before') && document.querySelector('[role=dialog]').textContent.includes('After')`, 'diff table')
    const txt = await evaluate(`document.querySelector('[role=dialog]').textContent`)
    assert(txt.includes('User agent') && txt.includes('IP address'), 'detail fields missing')
    assert(!/\\$2[aby]\\$/.test(txt), 'hash in drawer')
    await shot('02-detail')
    await evaluate(`document.querySelector('[role=dialog] button[aria-label=Close]').click()`)
  })

  await test('mobile width: page usable, table scrolls horizontally instead of overflowing', async () => {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await navigate('/ops/audit-trail')
    await waitFor(`${rowCount} > 0`, 'rows (mobile)')
    const overflow = await evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)
    assert(overflow <= 1, `page overflows horizontally by ${overflow}px`)
    await shot('03-mobile')
    await send('Emulation.clearDeviceMetricsOverride')
  })

  await logout()
  await loginAs('finance', 'admin123')
  await test('role without audit_trail.view: no menu item, direct URL is redirected away', async () => {
    assert(!(await evaluate(navHasAudit)), 'menu item visible to finance')
    const m = requests.length
    await navigate('/ops/audit-trail')
    await sleep(500)
    assert(await evaluate(`location.pathname !== '/ops/audit-trail'`), 'audit page rendered for finance')
    assert(!requests.slice(m).some((r) => r.path === '/api/audit-trail'), 'audit API called without permission')
  })
  await logout()

  console.log(`\n${passed} passed, ${failed} failed`)
}

main().catch((e) => { console.error(e); failed++ }).finally(async () => {
  try { ws?.close() } catch {}
  chrome.kill(); await sleep(500)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
})
