/**
 * Browser E2E: Switch Role (account menu) + Account Settings page
 * (headless Chrome via DevTools Protocol — Node >= 22).
 *
 *   npm run build && EMAIL_TRANSPORT=mock PORT=3011 node server/index.js
 *   BASE_URL=http://localhost:3011 node tests/e2e-account-self.mjs   # CHROME_PATH / SCREENSHOT_DIR
 *
 * Creates a temporary user with two temporary roles (3PL Loader role and a
 * Master Data + Audit Trail role) directly in the DB and removes them again.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { query, pool } = require('../server/db.js')

const BASE = process.env.BASE_URL || 'http://localhost:3001'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9343
const SUFFIX = Date.now().toString(36)
const OPS = `ops_${SUFFIX}`
const MD = `md_${SUFFIX}`
const USERNAME = `ui_${SUFFIX}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'oneops-acc-e2e-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' })

let ws, seq = 0
const pend = new Map()
const send = (method, params = {}) => { const i = ++seq; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pend.set(i, { res, rej })) }
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
const waitFor = async (e, label, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(e).catch(() => false)) return; await sleep(100) } throw new Error('timeout: ' + label) }
const text = () => ev('document.body.innerText')
const navText = () => ev(`document.querySelector('aside nav').innerText`)
const type = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
const shot = async (n) => { if (!process.env.SCREENSHOT_DIR) return; const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(process.env.SCREENSHOT_DIR, `acc-${n}.png`), Buffer.from(data, 'base64')) }
const go = async (path, ready, label) => { await send('Page.navigate', { url: BASE + path }); await waitFor(ready, label) }
const openMenu = async () => { await ev(`document.querySelector('[aria-haspopup="menu"]').click()`); await waitFor(`!!document.querySelector('[role="menu"]')`, 'account menu') }
const pickRole = (label) => ev(`(() => { const b = [...document.querySelectorAll('[role="menu"] [role="radio"]')].find((x) => x.innerText.trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())})); if (!b) throw new Error('no role option ' + ${JSON.stringify(label)}); b.click() })()`)
const roleLabel = (r) => r.replace(/_/g, ' ')

let passed = 0, failed = 0
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok    ${name}`) } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`) } }
const assert = (c, m) => { if (!c) throw new Error(m) }
const created = { roles: [], userId: null }

async function fixtures() {
  const grants = { [OPS]: ['loader.view', 'loader.run'], [MD]: ['master_data.view', 'audit_trail.view'] }
  for (const [name, keys] of Object.entries(grants)) {
    const id = (await query("INSERT INTO roles (name, description, is_active) VALUES (?, 'e2e', 1)", [name])).insertId
    created.roles.push(id)
    await query(`INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE permission_key IN (${keys.map(() => '?').join(',')})`, [id, ...keys])
  }
  const [{ password_hash }] = await query("SELECT password_hash FROM users WHERE username = 'superadmin'")
  created.userId = (await query("INSERT INTO users (username, email, full_name, password_hash, is_active, status) VALUES (?, ?, 'Ui Tester', ?, 1, 'active')", [USERNAME, `${USERNAME}@test.local`, password_hash])).insertId
  for (const id of created.roles) await query('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [created.userId, id])
}

async function main() {
  await fixtures()
  let u = ''
  for (let i = 0; i < 50 && !u; i++) { try { u = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl || '' } catch {} if (!u) await sleep(200) }
  ws = new WebSocket(u)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) } })
  await send('Page.enable'); await send('Runtime.enable')
  console.log(`Switch Role / Account Settings browser E2E against ${BASE}\n`)

  await go('/login', `!!document.querySelector('#username')`, 'login page')
  await ev(`localStorage.setItem('oneops.locale', 'en')`)
  await type('#username', USERNAME); await type('#password', 'admin123')
  await ev(`document.querySelector('form').requestSubmit()`)
  await waitFor(`location.pathname.startsWith('/ops/')`, 'login')

  await test('all roles: sidebar shows 3PL Loader, Master Data and Audit Trail; account block lists both roles', async () => {
    await go('/ops/master-data/hubs', `document.body.innerText.includes('Gerai / HUB')`, 'master data page')
    const nav = await navText()
    for (const s of ['3PL Loader', 'MASTER DATA', 'Audit Trail']) assert(nav.toLowerCase().includes(s.toLowerCase()), `nav missing ${s}: ${nav}`)
    const line = (await ev(`document.querySelector('[data-testid="active-role"]').innerText`)).toLowerCase()
    assert(line.includes(roleLabel(OPS)) && line.includes(roleLabel(MD)), `role line: ${line}`)
  })

  await test('account menu: Account settings + Switch role with "All my roles" and the assigned roles only', async () => {
    await openMenu()
    const menu = await ev(`document.querySelector('[role="menu"]').innerText`)
    for (const s of ['Account settings', 'SWITCH ROLE', 'All my roles', roleLabel(OPS), roleLabel(MD)]) assert(menu.toLowerCase().includes(s.toLowerCase()), `menu missing ${s}: ${menu}`)
    assert(!menu.toLowerCase().includes('super admin'), 'unassigned role listed')
    assert(await ev(`document.querySelectorAll('[role="menu"] [role="radio"]').length`) === 3, 'exactly 3 options')
    await shot('menu')
  })

  await test('switch to the 3PL role while on Master Data: page left, menus refreshed, notice shown', async () => {
    await pickRole(roleLabel(OPS))
    await waitFor(`location.pathname === '/ops/kodepos-loader'`, 'redirect to the loader')
    await waitFor(`document.body.innerText.includes('You are now working as')`, 'notice')
    const nav = await navText()
    assert(nav.includes('3PL Loader'), '3PL Loader still visible')
    assert(!nav.toLowerCase().includes('master data') && !nav.includes('Audit Trail'), `nav not refreshed: ${nav}`)
    const line = (await ev(`document.querySelector('[data-testid="active-role"]').innerText`)).toLowerCase()
    assert(line === roleLabel(OPS), `active role line: ${line}`)
    await shot('ops')
  })

  await test('active role survives a reload; direct URL to Master Data is redirected', async () => {
    await go('/ops/master-data/hubs', `location.pathname === '/ops/kodepos-loader'`, 'guard redirect')
    assert(!(await navText()).includes('Audit Trail'), 'still restricted after reload')
  })

  await test('switch to the Master Data role: Master Data + Audit Trail back, 3PL Loader hidden', async () => {
    await openMenu()
    await pickRole(roleLabel(MD))
    await waitFor(`!document.querySelector('aside nav').innerText.includes('3PL Loader')`, 'nav refresh')
    const nav = await navText()
    assert(nav.toLowerCase().includes('master data') && nav.includes('Audit Trail'), nav)
    await waitFor(`location.pathname !== '/ops/kodepos-loader'`, 'left the loader page')
  })

  await test('Account Settings: roles read-only, name change syncs the sidebar, validation messages', async () => {
    await go('/ops/account', `document.body.innerText.includes('Account information')`, 'account page')
    const t = await text()
    for (const s of ['Account Settings', 'Roles and permissions are managed by an administrator', 'Change password', 'All my roles']) assert(t.includes(s), `missing ${s}`)
    assert(await ev(`document.querySelector('#acc-username').readOnly`), 'username read-only')
    await type('#acc-name', 'A')
    await ev(`document.querySelector('#acc-name').form.requestSubmit()`)
    await waitFor(`document.body.innerText.includes('Full name must be 2–150 characters.')`, 'name validation')
    await type('#acc-name', 'Ui Tester Renamed')
    await ev(`document.querySelector('#acc-name').form.requestSubmit()`)
    await waitFor(`document.body.innerText.includes('Account information updated.')`, 'saved')
    await waitFor(`document.querySelector('aside').innerText.includes('Ui Tester Renamed')`, 'sidebar name synced')
    const [row] = await query('SELECT full_name FROM users WHERE id = ?', [created.userId])
    assert(row.full_name === 'Ui Tester Renamed', 'stored')
  })

  await test('Change password: wrong current password shows the server message and keeps the session', async () => {
    await type('#acc-pw-current', 'wrong-password')
    await type('#acc-pw-next', 'Valid!Pass9x')
    await type('#acc-pw-confirm', 'Valid!Pass9x')
    await ev(`document.querySelector('#acc-pw-current').form.requestSubmit()`)
    await waitFor(`document.body.innerText.includes('Current password is incorrect.')`, 'server error shown')
    assert((await ev('location.pathname')) === '/ops/account', 'still on the page (not signed out)')
    await shot('account')
  })

  await test('Indonesian: account menu and settings page translated', async () => {
    await ev(`localStorage.setItem('oneops.locale', 'id')`)
    await go('/ops/account', `document.body.innerText.includes('Informasi akun')`, 'account page (id)')
    const t = await text()
    for (const s of ['Pengaturan Akun', 'Ganti kata sandi', 'Semua role saya', 'Nama lengkap', 'Alamat email']) assert(t.includes(s), `missing ${s}`)
    for (const s of ['Account information', 'Change password', 'All my roles']) assert(!t.includes(s), `untranslated ${s}`)
    await openMenu()
    const menu = await ev(`document.querySelector('[role="menu"]').innerText`)
    assert(menu.includes('Pengaturan akun') && menu.toLowerCase().includes('ganti role'), menu)
    await ev(`localStorage.setItem('oneops.locale', 'en')`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
}

main().catch((e) => { console.error(e); failed++ }).finally(async () => {
  try {
    if (created.userId) {
      await query('DELETE FROM user_roles WHERE user_id = ?', [created.userId])
      await query('DELETE FROM users WHERE id = ?', [created.userId])
    }
    for (const id of created.roles) {
      await query('DELETE FROM role_permissions WHERE role_id = ?', [id])
      await query('DELETE FROM roles WHERE id = ?', [id])
    }
    await pool.end()
  } catch (e) { console.log('cleanup:', e.message) }
  try { ws?.close() } catch {}
  chrome.kill(); await sleep(600)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
})
