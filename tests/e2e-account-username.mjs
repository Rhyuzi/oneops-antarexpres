/**
 * Browser E2E: username "already exists" checks in Account Management.
 *   - Create Account: an existing username (any case) shows "Username already
 *     exists" and disables Create; a free one shows "available"
 *   - Admin Reset Password dialog: the username field (prefilled) is checked
 *     against other accounts; the own username is fine; taken → Send disabled
 *   - Forgot Password page (user): email field only, no username
 * Nothing is submitted (no account / username is changed).
 * Node >= 22, local Chrome.
 *
 *   npm run build && EMAIL_TRANSPORT=mock PORT=3011 node server/index.js
 *   BASE_URL=http://localhost:3011 node tests/e2e-account-username.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE_URL || 'http://localhost:3001'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9348
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const work = mkdtempSync(join(tmpdir(), 'oneops-username-e2e-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, 'profile')}`, '--no-first-run', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' })

let ws, seq = 0
const pend = new Map()
const send = (method, params = {}) => { const i = ++seq; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pend.set(i, { res, rej })) }
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
const waitFor = async (e, label, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(e).catch(() => false)) return; await sleep(80) } throw new Error('timeout: ' + label) }
const type = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
const go = async (path, ready, label) => { await send('Page.navigate', { url: BASE + path }); await waitFor(ready, label) }
const status = (testid) => ev(`document.querySelector('[data-testid="${testid}"]')?.dataset.status || null`)
const statusText = (testid) => ev(`document.querySelector('[data-testid="${testid}"]')?.innerText.trim() || ''`)
const waitStatus = (testid, s) => waitFor(`document.querySelector('[data-testid="${testid}"]')?.dataset.status === ${JSON.stringify(s)}`, `${testid} = ${s}`)

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
  console.log(`Account username checks browser E2E against ${BASE}\n`)

  await test('Forgot Password (user): email only, no username input', async () => {
    await go('/forgot-password', `!!document.querySelector('#email')`, 'forgot page')
    assert(await ev(`document.querySelector('#email').type === 'email'`), 'email field')
    assert(!(await ev(`!!document.querySelector('#username, input[name="username"], input[autocomplete="username"]')`)), 'no username field')
  })

  await go('/login', `!!document.querySelector('#username')`, 'login page')
  await ev(`localStorage.setItem('oneops.locale', 'en')`)
  await type('#username', 'superadmin'); await type('#password', 'admin123')
  await ev(`document.querySelector('form').requestSubmit()`)
  await waitFor(`location.pathname.startsWith('/ops/')`, 'login')
  await go('/ops/access-management/accounts', `[...document.querySelectorAll('button')].some((b) => b.innerText.includes('New account'))`, 'accounts page')

  await test('Create Account: existing username → "already exists" + Create disabled; free username → available', async () => {
    await ev(`[...document.querySelectorAll('button')].find((b) => b.innerText.includes('New account')).click()`)
    await waitFor(`!!document.querySelector('#na-username')`, 'create dialog')
    await type('#na-name', 'E2E Username Check'); await type('#na-email', 'e2e.username.check@example.test')
    await ev(`document.querySelector('input[type="checkbox"]')?.click()`) // one role
    await type('#na-username', 'FINANCE')
    await waitStatus('create-username-status', 'taken')
    assert((await statusText('create-username-status')) === 'Username already exists — choose another one.', await statusText('create-username-status'))
    const createBtn = `[...document.querySelectorAll('button')].find((b) => b.innerText.includes('Create & invite'))`
    assert(await ev(`${createBtn}.disabled`), 'Create disabled while the username is taken')
    await type('#na-username', 'Bad Name')
    await waitStatus('create-username-status', 'invalid')
    await type('#na-username', `free_${Date.now().toString(36)}`)
    await waitStatus('create-username-status', 'available')
    assert(!(await ev(`${createBtn}.disabled`)), 'Create enabled for a free username')
    await ev(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Cancel').click()`)
  })

  await test('Admin Reset Password: username prefilled; another account\'s username → taken, Send disabled; own → ok', async () => {
    await ev(`(() => { const row = [...document.querySelectorAll('tr')].find((tr) => tr.innerText.includes('@hr ')); row.querySelector('button[title="Send password reset email"]').click() })()`)
    await waitFor(`!!document.querySelector('#reset-username')`, 'reset dialog')
    assert((await ev(`document.querySelector('#reset-username').value`)) === 'hr', 'prefilled with the current username')
    await type('#reset-username', 'Operational')
    await waitStatus('reset-username-status', 'taken')
    const sendBtn = `[...document.querySelectorAll('button')].find((b) => b.innerText.includes('Send reset email'))`
    assert(await ev(`${sendBtn}.disabled`), 'Send disabled')
    await type('#reset-username', 'HR')
    await waitFor(`!document.querySelector('[data-testid="reset-username-status"]')`, 'own username → no error')
    assert(!(await ev(`${sendBtn}.disabled`)), 'Send enabled with the own username')
    await ev(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Cancel').click()`)
  })

  await test('Indonesian: "Nama pengguna sudah ada"', async () => {
    await ev(`localStorage.setItem('oneops.locale', 'id')`)
    await send('Page.reload')
    await waitFor(`[...document.querySelectorAll('button')].some((b) => b.innerText.includes('Akun baru'))`, 'accounts page (id)')
    await ev(`[...document.querySelectorAll('button')].find((b) => b.innerText.includes('Akun baru')).click()`)
    await waitFor(`!!document.querySelector('#na-username')`, 'create dialog')
    await type('#na-username', 'finance')
    await waitStatus('create-username-status', 'taken')
    assert((await statusText('create-username-status')).startsWith('Nama pengguna sudah ada'), await statusText('create-username-status'))
    await ev(`localStorage.setItem('oneops.locale', 'en')`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
}

main().catch((e) => { console.error(e); failed++ }).finally(async () => {
  try { ws?.close() } catch {}
  chrome.kill(); await sleep(600)
  try { rmSync(work, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
})
