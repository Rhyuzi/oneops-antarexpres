/**
 * Browser E2E: global language switching (headless Chrome via DevTools
 * Protocol, no dependencies — Node >= 22).
 *
 *   npm run build
 *   EMAIL_TRANSPORT=mock node server/index.js            # serves dist/
 *   node tests/e2e-i18n.mjs                              # BASE_URL / CHROME_PATH / SCREENSHOT_DIR
 *
 * Mixed-language detection: after switching to Indonesian, the visible text
 * of each page (and key dialogs) must not contain any English-only UI string
 * from the dictionary (whole-word match, values ≥ 4 chars without
 * placeholders). Historical audit descriptions are excluded by design.
 * Read-only apart from login/logout and one rejected role creation.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const BASE = process.env.BASE_URL || 'http://localhost:3001'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9336
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- dictionaries -> English-only phrases to hunt for ---------------------------
function loadDicts() {
  const out = esbuild.buildSync({
    stdin: { contents: "export { en } from './src/i18n/locales/en'\nexport { id } from './src/i18n/locales/id'", resolveDir: ROOT, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  })
  const mod = { exports: {} }
  new Function('module', 'exports', out.outputFiles[0].text)(mod, mod.exports)
  return mod.exports
}
const { en, id } = loadDicts()
const leaves = (o, p = '', acc = {}) => {
  for (const [k, v] of Object.entries(o)) typeof v === 'string' ? (acc[p + k] = v) : leaves(v, `${p}${k}.`, acc)
  return acc
}
const EN = leaves(en)
const ID = leaves(id)
const idText = Object.values(ID).join('\n')
// English UI phrases that must disappear in Indonesian (skip error catalog,
// placeholder templates, short words and anything also present in id text).
const ENGLISH_ONLY = [...new Set(Object.entries(EN)
  .filter(([k, v]) => !k.startsWith('errors.') && !k.startsWith('permissions.keys.') && v !== ID[k])
  .map(([, v]) => v.replace(/[…:.]+$/, '').trim())
  .filter((v) => v.length >= 4 && !v.includes('{') && !idText.includes(v)))]

// --- CDP plumbing ----------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'oneops-i18n-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-extensions', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' })
let ws, seq = 0
const pend = new Map()
const requests = []
const send = (method, params = {}) => { const i = ++seq; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pend.set(i, { res, rej })) }
async function connect() {
  let url
  for (let i = 0; i < 50 && !url; i++) {
    try { url = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch {}
    if (!url) await sleep(200)
  }
  ws = new WebSocket(url)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) }
    else if (d.method === 'Network.requestWillBeSent') {
      const u = new URL(d.params.request.url)
      if (u.pathname.startsWith('/api/')) requests.push({ method: d.params.request.method, path: u.pathname })
    }
  })
  await send('Network.enable'); await send('Page.enable'); await send('Runtime.enable')
}
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
const waitFor = async (e, label, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(e).catch(() => false)) return; await sleep(100) } throw new Error('timeout: ' + label) }
const navigate = async (path) => { await send('Page.navigate', { url: BASE + path }); await waitFor(`document.readyState === 'complete' && !!document.querySelector('#app *')`, 'load ' + path); await sleep(600) }
const shot = async (name) => { if (!process.env.SCREENSHOT_DIR) return; const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(process.env.SCREENSHOT_DIR, `i18n-${name}.png`), Buffer.from(data, 'base64')) }
const typeInto = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
const clickLang = (code) => ev(`[...document.querySelectorAll('button[aria-pressed]')].find((b) => b.getAttribute('lang') === '${code}').click()`)
const bodyText = (scope = 'document.body') => ev(`(${scope}).innerText`)
/** Visible text of the page, skipping text inside elements matching `selector`. */
const visibleTextExcept = (selector) => ev(`(() => {
  const parts = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let n
  while ((n = walker.nextNode())) {
    const el = n.parentElement
    if (!el || el.closest(${JSON.stringify(selector)})) continue
    if (el.tagName !== 'OPTION' && el.offsetParent === null) continue
    parts.push(n.textContent)
  }
  return parts.join('\\n')
})()`)

let passed = 0, failed = 0
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok    ${name}`) } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`) } }
const assert = (c, m) => { if (!c) throw new Error(m) }

/** English-only UI phrases visible in `text` (whole-word, case-sensitive). */
function englishLeftovers(text, ignore = []) {
  const hay = ignore.reduce((s, x) => s.split(x).join(' '), text)
  return ENGLISH_ONLY.filter((p) => new RegExp(`(^|[^A-Za-z])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`).test(hay))
}
/** Buttons/links whose label overflows their box (layout check for longer text). */
const OVERFLOWING = `[...document.querySelectorAll('button, a.btn')].filter((b) => b.offsetParent && b.scrollWidth > b.clientWidth + 1).map((b) => b.innerText.trim().slice(0, 40))`

async function main() {
  await connect()
  console.log(`i18n browser E2E against ${BASE} (${ENGLISH_ONLY.length} English-only phrases tracked)\n`)

  await navigate('/login')
  await test('default is English when no preference exists', async () => {
    assert((await ev(`localStorage.getItem('oneops.locale')`)) === null, 'preference already set')
    assert((await ev(`document.documentElement.lang`)) === 'en', 'html lang not en')
    assert((await bodyText()).includes(EN['auth.signIn']), 'English sign-in missing')
    assert((await ev('document.title')).startsWith(EN['titles.login']), 'title not English')
  })

  await test('switching to Bahasa Indonesia on the login page applies instantly and persists', async () => {
    const m = requests.length
    await clickLang('id'); await sleep(200)
    const txt = await bodyText()
    assert(txt.includes(ID['auth.signIn']) && txt.includes(ID['auth.forgotPasswordLink']), 'login not Indonesian')
    assert((await ev(`localStorage.getItem('oneops.locale')`)) === 'id', 'not persisted')
    assert((await ev(`document.documentElement.lang`)) === 'id', 'html lang not id')
    assert(requests.length === m, 'switch triggered network requests')
    assert(englishLeftovers(txt).length === 0, `English left: ${englishLeftovers(txt)}`)
    await shot('01-login-id')
  })

  await test('server error on failed login is shown in Indonesian', async () => {
    await typeInto('#username', 'superadmin'); await typeInto('#password', 'wrong-password')
    await ev(`document.querySelector('form').requestSubmit()`)
    await waitFor(`document.body.innerText.includes(${JSON.stringify(ID['errors.server.invalidCredentials'])})`, 'localized login error')
  })

  await test('sign in while Indonesian is active; sidebar + title localized', async () => {
    await typeInto('#password', 'admin123')
    await ev(`document.querySelector('form').requestSubmit()`)
    await waitFor(`location.pathname.startsWith('/ops/')`, 'login')
    await sleep(600)
    const side = await bodyText(`document.querySelector('aside')`)
    for (const k of ['nav.dataCenter', 'nav.numberRechecking', 'nav.accountManagement', 'nav.auditTrail', 'nav.collapse']) {
      assert(side.includes(ID[k]), `sidebar missing ${ID[k]}`)
    }
    assert((await ev('document.title')).startsWith(ID['nav.dataWarrior']), 'title not localized')
  })

  await test('refresh keeps Indonesian and keeps the session', async () => {
    await navigate('/ops/data-warrior')
    assert((await ev(`location.pathname`)) === '/ops/data-warrior', 'redirected to login after refresh')
    assert((await bodyText()).includes(ID['storage.subtitle']), 'not Indonesian after refresh')
  })

  const pages = [
    ['/ops/data-warrior', 'storage.subtitle'],
    ['/ops/number-rechecking', 'rechecker.subtitle'],
    ['/ops/number-rechecking/settings', 'rechecker.settingsSubtitle'],
    ['/ops/access-management/roles', 'access.subtitle'],
    ['/ops/access-management/accounts', 'accounts.subtitle'],
    ['/ops/audit-trail', 'audit.subtitle'],
    ['/ops/kodepos-loader', 'loader.subtitle'],
  ]
  for (const [path, key] of pages) {
    await test(`${path}: fully Indonesian, labels fit`, async () => {
      await navigate(path)
      await waitFor(`document.body.innerText.includes(${JSON.stringify(ID[key])})`, 'page text')
      await sleep(800)
      // Data/identifiers shown as recorded are excluded structurally:
      //  audit = description cells, action codes (<code>), Action filter options.
      // (Built-in role descriptions are translated; nothing skipped on roles.)
      const skip = path.includes('audit')
        ? 'table tbody tr td:nth-child(6), code, select option[value*="."]'
        : ''
      const left = englishLeftovers(skip ? await visibleTextExcept(skip) : await bodyText())
      assert(left.length === 0, `English left: ${left.join(' | ')}`)
      const over = await ev(OVERFLOWING)
      assert(over.length === 0, `overflowing labels: ${over.join(' | ')}`)
      await shot(path.replace(/\W+/g, '-'))
    })
  }

  await test('Roles tabs (folders / users) and New role dialog are Indonesian', async () => {
    await navigate('/ops/access-management/roles')
    await waitFor(`document.body.innerText.includes(${JSON.stringify(ID['access.tabFolders'])})`, 'tabs')
    for (const k of ['access.tabFolders', 'access.tabUsers']) {
      await ev(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === ${JSON.stringify(ID[k])}).click()`)
      await sleep(500)
      const left = englishLeftovers(await bodyText())
      assert(left.length === 0, `${k}: English left: ${left.join(' | ')}`)
    }
    await ev(`[...document.querySelectorAll('button')].find((b) => b.innerText.includes(${JSON.stringify(ID['access.newRole'])})).click()`)
    await waitFor(`!!document.querySelector('#role-name')`, 'dialog')
    const left = englishLeftovers(await bodyText(`document.querySelector('#role-name').closest('.fixed')`))
    assert(left.length === 0, `dialog English left: ${left.join(' | ')}`)
  })

  await test('error toast from the server is Indonesian (duplicate role, rejected — no data change)', async () => {
    await typeInto('#role-name', 'super_admin')
    await ev(`[...document.querySelector('#role-name').closest('.fixed').querySelectorAll('button')].pop().click()`)
    await waitFor(`document.body.innerText.includes(${JSON.stringify(ID['errors.server.roleExists'])})`, 'localized toast')
    await ev(`[...document.querySelector('#role-name').closest('.fixed').querySelectorAll('button')][0].click()`)
  })

  await test('account dialogs are Indonesian', async () => {
    await navigate('/ops/access-management/accounts')
    await ev(`[...document.querySelectorAll('button')].find((b) => b.innerText.includes(${JSON.stringify(ID['accounts.newAccount'])})).click()`)
    await waitFor(`!!document.querySelector('#na-name')`, 'create dialog')
    const txt = await bodyText(`document.querySelector('#na-name').closest('.fixed')`)
    const left = englishLeftovers(txt)
    assert(left.length === 0, `English left: ${left.join(' | ')}`)
    assert(txt.includes(ID['statuses.pending_activation']), 'status label not localized')
    await shot('dialog-new-account')
  })

  await test('Audit Trail: UI localized, history unchanged (descriptions = API values)', async () => {
    await navigate('/ops/audit-trail')
    await waitFor(`document.querySelectorAll('table tbody tr').length > 0`, 'rows')
    const api = await ev(`fetch('/api/audit-trail?pageSize=25').then((r) => r.json())`)
    const shown = await ev(`[...document.querySelectorAll('table tbody tr')].map((tr) => tr.children[5].innerText.trim())`)
    assert(shown.length === api.records.length, 'row count mismatch')
    assert(shown.every((s, i) => s === api.records[i].description), 'descriptions were altered')
    const modules = await ev(`[...document.querySelectorAll('table tbody tr td:nth-child(4)')].map((td) => td.innerText.trim())`)
    assert(modules.some((m) => m === ID['audit.modules.authentication']), `module chips not localized: ${[...new Set(modules)]}`)
    await ev(`document.querySelector('table tbody tr').click()`)
    await waitFor(`!!document.querySelector('[role=dialog]') && !document.body.innerText.includes(${JSON.stringify(ID['audit.loadingDetails'])})`, 'drawer')
    const drawer = await bodyText(`document.querySelector('[role=dialog]')`)
    const desc = api.records[0].description
    assert(drawer.includes(ID['audit.timestamp']) && drawer.includes(ID['audit.readOnlyNote']), 'drawer labels not localized')
    assert(drawer.includes(desc), 'drawer description altered')
    const left = englishLeftovers(drawer, [desc])
    assert(left.length === 0, `drawer English left: ${left.join(' | ')}`)
    await shot('audit-drawer')
  })

  await test('validation messages are localized (activation form)', async () => {
    await navigate('/activate-account?token=dummy')
    // Logged-in users are redirected away from public pages except activation.
    await typeInto('#new-password', 'short'); await typeInto('#confirm-password', 'short')
    await ev(`document.querySelector('form').requestSubmit()`)
    await waitFor(`document.body.innerText.includes(${JSON.stringify(ID['auth.pwMinLength'])})`, 'validation')
  })

  await test('sidebar switch back to English updates everything immediately', async () => {
    await navigate('/ops/access-management/accounts')
    const m = requests.length
    await ev(`[...document.querySelector('aside').querySelectorAll('button[aria-pressed]')].find((b) => b.getAttribute('lang') === 'en').click()`)
    await sleep(300)
    const txt = await bodyText()
    assert(txt.includes(EN['accounts.subtitle']) && txt.includes(EN['nav.dataCenter']), 'not English')
    assert(!txt.includes(ID['accounts.subtitle']), 'Indonesian left')
    assert((await ev(`localStorage.getItem('oneops.locale')`)) === 'en', 'not persisted')
    assert(!requests.slice(m).some((r) => r.path.startsWith('/api/auth')), 'switch touched auth endpoints')
    assert((await ev('document.title')).startsWith(EN['nav.accountManagement']), 'title not updated')
  })

  await test('collapsed sidebar toggle switches language', async () => {
    await ev(`[...document.querySelectorAll('aside button')].find((b) => b.innerText.includes(${JSON.stringify(EN['nav.collapse'])})).click()`)
    await sleep(300)
    await ev(`document.querySelector('aside button[title*="Bahasa"]').click()`)
    await sleep(300)
    assert((await ev(`localStorage.getItem('oneops.locale')`)) === 'id', 'collapsed toggle did not switch')
    await ev(`[...document.querySelectorAll('aside button')].pop().click()`) // expand again
    await sleep(300)
  })

  await test('logout keeps the language preference; login page in Indonesian', async () => {
    await ev(`document.querySelector('aside button[title="${ID['nav.signOut']}"]').click()`)
    await waitFor(`location.pathname === '/login'`, 'logout')
    await sleep(300)
    assert((await bodyText()).includes(ID['auth.signIn']), 'login not Indonesian after logout')
    assert((await ev(`localStorage.getItem('oneops.locale')`)) === 'id', 'preference lost')
    assert(!(await ev(`Object.keys(localStorage).join(',')`)).match(/token|session/i), 'auth data in localStorage')
  })

  await test('invalid stored locale falls back to English', async () => {
    await ev(`localStorage.setItem('oneops.locale', 'xx')`)
    await navigate('/login')
    assert((await ev(`document.documentElement.lang`)) === 'en', 'no fallback')
    assert((await bodyText()).includes(EN['auth.signIn']), 'not English')
    await ev(`localStorage.removeItem('oneops.locale')`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
}

main().catch((e) => { console.error(e); failed++ }).finally(async () => {
  try { ws?.close() } catch {}
  chrome.kill(); await sleep(500)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
})
