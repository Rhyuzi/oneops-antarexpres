/**
 * Browser E2E: loading states + duplicate-action prevention.
 *
 * Drives the BUILT app (served by the backend from dist/) in headless Chrome
 * through the DevTools Protocol — no extra dependencies (Node 22: global
 * fetch + WebSocket). Every "rapid click" fires several click()/submit calls
 * inside ONE JavaScript task, i.e. before Vue can re-render the disabled
 * button — the worst case the in-flight guards must handle — and then counts
 * the API requests that actually left the browser.
 *
 * Prerequisites (local test DB with database/seeds/002_test_users.sql):
 *   npm run build
 *   EMAIL_TRANSPORT=mock node server/index.js          # serves dist on :3001
 *   node tests/e2e-duplicate-actions.mjs               # Node >= 22
 *
 * Env: BASE_URL (default http://localhost:3001), CHROME_PATH.
 * Creates and deletes its own test account / role / folder (prefix e2e).
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE_URL || 'http://localhost:3001'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9333
const SUFFIX = Date.now().toString(36)
const LATENCY_MS = 700 // slows every request so in-flight UI state is observable

// --- Chrome / CDP plumbing -----------------------------------------------------

const profileDir = mkdtempSync(join(tmpdir(), 'oneops-e2e-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1400,1000',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdpTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(200)
  }
  throw new Error('Chrome DevTools endpoint not reachable')
}

let ws
let seq = 0
const pending = new Map()
const requests = [] // { method, path }

function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function connect() {
  ws = new WebSocket(await cdpTarget())
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    } else if (msg.method === 'Network.requestWillBeSent') {
      const url = new URL(msg.params.request.url)
      if (url.pathname.startsWith('/api/')) requests.push({ method: msg.params.request.method, path: url.pathname })
    }
  })
  await send('Network.enable')
  await send('Page.enable')
  await send('Runtime.enable')
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(`page error: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`)
  return res.result.value
}

async function waitFor(expression, label, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await evaluate(expression).catch(() => false)) return
    await sleep(100)
  }
  throw new Error(`timeout waiting for: ${label}`)
}

async function navigate(path) {
  await send('Page.navigate', { url: BASE + path })
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#app *')`, `load ${path}`)
  await sleep(400)
}

async function setLatency(ms) {
  await send('Network.emulateNetworkConditions', {
    offline: false, latency: ms, downloadThroughput: -1, uploadThroughput: -1,
  })
}

/** Optional: SCREENSHOT_DIR=<dir> saves a PNG of each in-flight loading state. */
async function screenshot(name) {
  if (!process.env.SCREENSHOT_DIR) return
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(process.env.SCREENSHOT_DIR, `${String(++shotSeq).padStart(2, '0')}-${name}.png`), Buffer.from(data, 'base64'))
}
let shotSeq = 0

// In-page helpers (installed on every page load via addScriptToEvaluateOnNewDocument).
const HELPERS = `
window.__t = {
  visible(el) { return !!el && el.getClientRects().length > 0 },
  btn(text, root) {
    return [...(root || document).querySelectorAll('button')]
      .find((b) => this.visible(b) && b.textContent.replace(/\\s+/g, ' ').trim().includes(text)) || null
  },
  modal() {
    const m = [...document.querySelectorAll('.fixed.inset-0')].filter((el) => this.visible(el))
    return m[m.length - 1] || null
  },
  row(text) {
    return [...document.querySelectorAll('tr, li')].find((r) => this.visible(r) && r.textContent.includes(text)) || null
  },
  type(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  },
  rapid(el, n = 3) { for (let i = 0; i < n; i++) el.click() },
  busyCount() { return document.querySelectorAll('button[aria-busy="true"]').length },
  state(el) { return el ? { disabled: el.disabled, busy: el.getAttribute('aria-busy') === 'true' } : null },
}
`

// --- assertions -------------------------------------------------------------

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok    ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL  ${name}\n        ${err.message}`)
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

function mark() { return requests.length }
function count(since, method, pathRe) {
  return requests.slice(since).filter((r) => r.method === method && pathRe.test(r.path)).length
}

/** Rapid-clicks `selectorExpr` (in-page expr returning a button), checks the
 * in-flight UI state, waits for completion, returns the request count. */
async function rapidAndSettle(btnExpr, method, pathRe, { clicks = 3 } = {}) {
  const m = mark()
  const before = await evaluate(`(() => { const b = ${btnExpr}; if (!b) return null;
    window.__lastBtn = b; const r = b.getBoundingClientRect(); __t.rapid(b, ${clicks}); return { w: r.width, h: r.height } })()`)
  assert(before, `button not found: ${btnExpr}`)
  await sleep(150)
  const inflight = await evaluate(`__t.busyCount()`)
  const sized = await evaluate(`(() => { const b = window.__lastBtn; if (!b.isConnected || b.getAttribute('aria-busy') !== 'true') return null;
    const r = b.getBoundingClientRect(); return { w: r.width, h: r.height } })()`)
  if (sized) {
    assert(Math.abs(sized.w - before.w) < 0.5 && Math.abs(sized.h - before.h) < 0.5,
      `button resized while loading: ${JSON.stringify(before)} → ${JSON.stringify(sized)}`)
  }
  await screenshot(`${method}-${pathRe.source.replace(/[^a-z]+/gi, '_')}`)
  await waitFor(`__t.busyCount() === 0`, 'all loading states cleared')
  await sleep(300)
  return { n: count(m, method, pathRe), inflight }
}

// --- scenarios -----------------------------------------------------------------

async function main() {
  await connect()
  await send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS })
  console.log(`Browser E2E against ${BASE} (latency ${LATENCY_MS} ms)\n`)

  // 1. Login form: rapid button clicks + repeated Enter (requestSubmit) ------------
  await navigate('/login')
  await setLatency(LATENCY_MS)
  await test('Login: 3 clicks + 3 Enter submits → exactly 1 login request, button shows loading', async () => {
    await evaluate(`__t.type(document.querySelector('#username'), 'superadmin'); __t.type(document.querySelector('#password'), 'admin123')`)
    const m = mark()
    await evaluate(`(() => { const f = document.querySelector('form'); const b = __t.btn('Sign in');
      b.click(); b.click(); b.click(); f.requestSubmit(); f.requestSubmit(); f.requestSubmit() })()`)
    await sleep(150)
    const st = await evaluate(`__t.state(document.querySelector('button[type=submit]'))`)
    await waitFor(`location.pathname.startsWith('/ops/')`, 'redirect after login')
    const n = count(m, 'POST', /^\/api\/auth\/login$/)
    assert(n === 1, `login requests = ${n}`)
    assert(st && st.disabled && st.busy, `submit button not loading: ${JSON.stringify(st)}`)
  })

  // 2. Account Management ------------------------------------------------------------
  const user = `e2e_dup_${SUFFIX}`
  try {
    await navigate('/ops/access-management/accounts')
    await waitFor(`!!__t.row('@superadmin')`, 'accounts table')

    await test('Create account: rapid clicks → 1 POST, spinner while in flight, restored after', async () => {
      await evaluate(`__t.btn('New account').click()`)
      await waitFor(`!!document.querySelector('#na-name')`, 'create dialog')
      await evaluate(`__t.type(document.querySelector('#na-name'), 'E2E Dup Test');
        __t.type(document.querySelector('#na-email'), '${user}@test.local');
        __t.type(document.querySelector('#na-username'), '${user}');
        [...__t.modal().querySelectorAll('input[type=checkbox]')].find((c) => c.parentElement.textContent.includes('finance')).click()`)
      const r = await rapidAndSettle(`__t.btn('Create', __t.modal())`, 'POST', /^\/api\/accounts$/)
      assert(r.n === 1, `create requests = ${r.n}`)
      assert(r.inflight >= 1, 'no loading indicator while request in flight')
      await waitFor(`!!__t.row('@${user}')`, 'new row')
    })

    await test('Create duplicate (409): button restored after failure, retry sends a new request', async () => {
      await evaluate(`__t.btn('New account').click()`)
      await waitFor(`!!document.querySelector('#na-name')`, 'create dialog')
      await evaluate(`__t.type(document.querySelector('#na-name'), 'E2E Dup Test');
        __t.type(document.querySelector('#na-email'), 'other_${user}@test.local');
        __t.type(document.querySelector('#na-username'), '${user}');
        [...__t.modal().querySelectorAll('input[type=checkbox]')].find((c) => c.parentElement.textContent.includes('finance')).click()`)
      const first = await rapidAndSettle(`__t.btn('Create', __t.modal())`, 'POST', /^\/api\/accounts$/)
      assert(first.n === 1, `failed-create requests = ${first.n}`)
      const st = await evaluate(`__t.state(__t.btn('Create', __t.modal()))`)
      assert(st && !st.disabled && !st.busy, `button stuck after failure: ${JSON.stringify(st)}`)
      const toast = await evaluate(`document.body.textContent.includes('already taken')`)
      assert(toast, 'error notification missing')
      const retry = await rapidAndSettle(`__t.btn('Create', __t.modal())`, 'POST', /^\/api\/accounts$/, { clicks: 1 })
      assert(retry.n === 1, `retry requests = ${retry.n}`)
      await evaluate(`__t.btn('Cancel', __t.modal()).click()`)
    })

    await test('Row action: rapid Resend on one account → 1 request', async () => {
      const r = await rapidAndSettle(`__t.btn('Resend', __t.row('@${user}'))`, 'POST', /\/resend-invitation$/)
      assert(r.n === 1, `resend requests = ${r.n}`)
    })

    await test('Independent rows: Deactivate on two accounts in the same tick → 2 requests (not blocked)', async () => {
      try {
        const m = mark()
        await evaluate(`(() => { const a = __t.btn('Deactivate', __t.row('@hr')); const b = __t.btn('Deactivate', __t.row('@it'));
          a.click(); a.click(); b.click(); b.click() })()`)
        await sleep(150)
        const both = await evaluate(`[__t.row('@hr'), __t.row('@it')].map((r) => __t.state(r.querySelector('button[aria-busy="true"]'))?.busy === true)`)
        await waitFor(`__t.busyCount() === 0`, 'settle')
        await sleep(300)
        const n = count(m, 'PATCH', /\/api\/accounts\/\d+\/status$/)
        assert(n === 2, `status requests = ${n}`)
        assert(both[0] && both[1], `both rows should show their own spinner: ${JSON.stringify(both)}`)
      } finally {
        // Always restore the seed accounts, even when an assertion failed.
        await setLatency(0)
        await evaluate(`fetch('/api/accounts?status=inactive').then((r) => r.json()).then((d) => Promise.all((d.accounts || [])
          .filter((a) => a.username === 'hr' || a.username === 'it')
          .map((a) => fetch('/api/accounts/' + a.id + '/status', { method: 'PATCH',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'active' }) }))))`)
        await navigate('/ops/access-management/accounts')
        await setLatency(LATENCY_MS)
      }
    })

    // Setup (not under test): pending rows only offer Resend/Revoke, so activate
    // the e2e account through the API to get its Reset / Delete row actions.
    await setLatency(0)
    await evaluate(`fetch('/api/accounts?search=${user}').then((r) => r.json()).then((d) =>
      fetch('/api/accounts/' + d.accounts[0].id + '/status', { method: 'PATCH',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'active' }) }))`)
    await navigate('/ops/access-management/accounts')
    await waitFor(`!!__t.row('@${user}') && !!__t.row('@${user}').querySelector('button[title="Delete account"]')`, 'active e2e row')
    await setLatency(LATENCY_MS)

    await test('Reset-password confirm modal: rapid clicks → 1 POST, row Reset button shows loading', async () => {
      await evaluate(`__t.btn('Reset', __t.row('@${user}')).click()`)
      await waitFor(`!!__t.modal()`, 'reset dialog')
      const m = mark()
      await evaluate(`__t.rapid(__t.btn('Send reset email', __t.modal()), 3)`)
      await sleep(150)
      const rowBusy = await evaluate(`__t.state(__t.row('@${user}').querySelector('button[title="Send password reset email"]'))`)
      assert(rowBusy && rowBusy.busy, `row Reset not loading via the other UI path: ${JSON.stringify(rowBusy)}`)
      await waitFor(`__t.busyCount() === 0`, 'settle')
      await sleep(300)
      const n = count(m, 'POST', /\/reset-password$/)
      assert(n === 1, `reset requests = ${n}`)
    })

    await test('Delete confirm modal: rapid clicks → 1 DELETE, row removed', async () => {
      await evaluate(`__t.row('@${user}').querySelector('button[title="Delete account"]').click()`)
      await waitFor(`!!__t.modal()`, 'delete dialog')
      const r = await rapidAndSettle(`__t.btn('Delete', __t.modal())`, 'DELETE', /^\/api\/accounts\/\d+$/)
      assert(r.n === 1, `delete requests = ${r.n}`)
      assert(r.inflight >= 1, 'no loading indicator on Delete')
      await waitFor(`!__t.row('@${user}')`, 'row removed')
    })

  } finally {
    // Always remove the e2e account (also when a step above aborted).
    await setLatency(0)
    await evaluate(`fetch('/api/accounts?search=${user}').then((r) => r.json()).then((d) =>
      Promise.all((d.accounts || []).map((a) => fetch('/api/accounts/' + a.id, { method: 'DELETE' }))))`).catch(() => {})
    await setLatency(LATENCY_MS)
  }

  // 3. Access Management: role create + delete -----------------------------------------
  const role = `e2e_role_${SUFFIX}`
  await navigate('/ops/access-management/roles')
  await waitFor(`!!__t.btn('Save permissions') || !!__t.btn('New role')`, 'roles page')
  await test('Create role: rapid clicks → 1 POST', async () => {
    await evaluate(`__t.btn('New role').click()`)
    await waitFor(`!!__t.modal()`, 'create role dialog')
    await evaluate(`__t.type(__t.modal().querySelector('input'), '${role}')`)
    const r = await rapidAndSettle(`__t.btn('Create', __t.modal())`, 'POST', /^\/api\/access-management\/roles$/)
    assert(r.n === 1, `create role requests = ${r.n}`)
  })
  await test('Delete role confirm: rapid clicks → 1 DELETE', async () => {
    await waitFor(`document.body.textContent.includes('${role.replace(/_/g, ' ')}') || document.body.textContent.includes('${role}')`, 'role selected')
    await evaluate(`__t.btn('Delete').click()`)
    await waitFor(`!!__t.modal()`, 'delete dialog')
    const r = await rapidAndSettle(`__t.btn('Delete', __t.modal())`, 'DELETE', /^\/api\/access-management\/roles\/\d+$/)
    assert(r.n === 1, `delete role requests = ${r.n}`)
  })

  // 4. Data Warrior: create folder via repeated Enter, then delete ----------------------
  const folder = `e2e_folder_${SUFFIX}`
  await navigate('/ops/data-warrior')
  await waitFor(`!!__t.btn('New folder')`, 'data warrior')
  await test('Create folder: 3× Enter + click → 1 POST', async () => {
    await evaluate(`__t.btn('New folder').click()`)
    await waitFor(`!!document.querySelector('#new-folder-name')`, 'folder dialog')
    const m = mark()
    await evaluate(`(() => { const i = document.querySelector('#new-folder-name'); __t.type(i, '${folder}');
      for (let k = 0; k < 3; k++) i.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      __t.btn('Create', __t.modal()).click() })()`)
    await sleep(150)
    assert(await evaluate(`__t.busyCount() >= 1`), 'no loading state')
    await waitFor(`__t.busyCount() === 0`, 'settle')
    await sleep(300)
    const n = count(m, 'POST', /^\/api\/storage\/folders$/)
    assert(n === 1, `create folder requests = ${n}`)
  })
  await test('Delete folder confirm: rapid clicks → 1 DELETE', async () => {
    await waitFor(`[...document.querySelectorAll('.group')].some((c) => c.textContent.includes('${folder}'))`, 'folder card')
    await evaluate(`(() => { const card = [...document.querySelectorAll('.group')].find((c) => c.textContent.includes('${folder}'));
      card.querySelector('button').click() })()`)
    await waitFor(`!!__t.btn('Delete', [...document.querySelectorAll('.group')].find((c) => c.textContent.includes('${folder}')))`, 'folder menu')
    await evaluate(`__t.btn('Delete', [...document.querySelectorAll('.group')].find((c) => c.textContent.includes('${folder}'))).click()`)
    await waitFor(`!!__t.modal()`, 'delete folder dialog')
    const r = await rapidAndSettle(`__t.btn('Delete', __t.modal())`, 'DELETE', /^\/api\/storage\/folders\/\d+$/)
    assert(r.n === 1, `delete folder requests = ${r.n}`)
  })


  // 6. Logout: rapid clicks → 1 request ------------------------------------------------
  await navigate('/ops/data-warrior')
  await test('Logout: rapid clicks → 1 logout request, lands on login', async () => {
    const m = mark()
    await evaluate(`__t.rapid(document.querySelector('button[title="Sign out"]'), 3)`)
    await waitFor(`location.pathname === '/login'`, 'login page')
    const n = count(m, 'POST', /^\/api\/auth\/logout$/)
    assert(n === 1, `logout requests = ${n}`)
  })

  // 7. Forgot password form: rapid submit → 1 request -----------------------------------
  await navigate('/forgot-password')
  await test('Forgot password: 3 clicks + 2 Enter → 1 request', async () => {
    await evaluate(`__t.type(document.querySelector('#email'), 'nobody_${SUFFIX}@test.local')`)
    const m = mark()
    await evaluate(`(() => { const b = __t.btn('Send reset link'); const f = document.querySelector('form');
      b.click(); b.click(); b.click(); f.requestSubmit(); f.requestSubmit() })()`)
    await waitFor(`document.body.textContent.includes('If that email address belongs')`, 'sent state')
    const n = count(m, 'POST', /^\/api\/auth\/forgot-password$/)
    assert(n === 1, `forgot requests = ${n}`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
}

main()
  .catch((err) => { console.error(err); failed++ })
  .finally(async () => {
    try { ws?.close() } catch {}
    chrome.kill()
    await sleep(500)
    try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
    process.exit(failed ? 1 : 0)
  })
