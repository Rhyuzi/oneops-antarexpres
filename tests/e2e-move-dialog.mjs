/**
 * Browser E2E (component level): Data Warrior Move dialog with the folder tree.
 *   - opens collapsed from Root; expand / collapse level by level (indentation)
 *   - live full-path preview of the destination
 *   - search: same name under different parents, parent paths, auto-expanded ancestors
 *   - disabled: the moved folder, its sub-folders, the current location
 *   - move succeeds; the audit row holds the source and destination paths
 * Node >= 22, local Chrome, local DB (audit check).
 *
 *   npm run build && EMAIL_TRANSPORT=mock PORT=3011 node server/index.js
 *   BASE_URL=http://localhost:3011 node tests/e2e-move-dialog.mjs   # CHROME_PATH / SCREENSHOT_DIR
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
const PORT = 9346
const SUFFIX = Date.now().toString(36)
const R = `e2e-move-${SUFFIX}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const work = mkdtempSync(join(tmpdir(), 'oneops-move-e2e-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, 'profile')}`, '--no-first-run', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' })

let ws, seq = 0
const pend = new Map()
const send = (method, params = {}) => { const i = ++seq; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pend.set(i, { res, rej })) }
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
const waitFor = async (e, label, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(e).catch(() => false)) return; await sleep(80) } throw new Error('timeout: ' + label) }
const type = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
const shot = async (n) => { if (!process.env.SCREENSHOT_DIR) return; const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(process.env.SCREENSHOT_DIR, `move-${n}.png`), Buffer.from(data, 'base64')) }
const go = async (path, ready, label) => { await send('Page.navigate', { url: BASE + path }); await waitFor(ready, label) }

// Tree helpers (rows of the picker)
const rows = () => ev(`[...document.querySelectorAll('[data-testid="move-dialog"] [data-tree-key]')].map((li) => ({
  name: li.querySelector('[data-testid="tree-name"]').innerText,
  depth: Number(li.dataset.depth),
  pad: parseInt(li.style.paddingLeft, 10),
  expanded: li.getAttribute('aria-expanded'),
  blocked: li.dataset.blocked || null,
  parentPath: li.querySelector('[data-testid="tree-parent-path"]')?.innerText || null,
  selected: li.getAttribute('aria-selected') === 'true',
}))`)
const rowSel = (name, nth = 0) => `[...document.querySelectorAll('[data-testid="move-dialog"] [data-tree-key]')].filter((li) => li.querySelector('[data-testid="tree-name"]').innerText === ${JSON.stringify(name)})[${nth}]`
const toggleRow = (name) => ev(`${rowSel(name)}.querySelector('[data-testid="tree-toggle"]').click()`)
const clickRow = (name, nth = 0) => ev(`${rowSel(name, nth)}.click()`)
const preview = () => ev(`document.querySelector('[data-testid="move-preview"]').innerText.trim()`)
const confirmDisabled = () => ev(`document.querySelector('[data-testid="move-confirm"]').disabled`)
const names = (list) => list.map((r) => `${'  '.repeat(r.depth)}${r.name}`)

let passed = 0, failed = 0
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok    ${name}`) } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`) } }
const assert = (c, m) => { if (!c) throw new Error(m) }
let rootId = null
const ids = {}

async function openFolderMenuMove(name) {
  await ev(`[...document.querySelectorAll('[data-item-key^="folder:"]')].find((el) => el.querySelector('p')?.innerText.trim() === ${JSON.stringify(name)}).querySelector('button.absolute').click()`)
  await waitFor(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Move' || b.innerText.trim() === 'Pindahkan')`, 'folder menu')
  await ev(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Move' || b.innerText.trim() === 'Pindahkan').click()`)
  await waitFor(`!!document.querySelector('[data-testid="move-dialog"]')`, 'move dialog')
}

async function main() {
  let u = ''
  for (let i = 0; i < 50 && !u; i++) { try { u = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl || '' } catch {} if (!u) await sleep(200) }
  ws = new WebSocket(u)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) } })
  await send('Page.enable'); await send('Runtime.enable')
  console.log(`Data Warrior Move dialog browser E2E against ${BASE}\n`)

  await go('/login', `!!document.querySelector('#username')`, 'login page')
  await ev(`localStorage.setItem('oneops.locale', 'en')`)
  await type('#username', 'superadmin'); await type('#password', 'admin123')
  await ev(`document.querySelector('form').requestSubmit()`)
  await waitFor(`location.pathname.startsWith('/ops/')`, 'login')

  // R / 2025 / Garut ; R / 2026 / { November / Garut, Desember } ; R / Arsip
  Object.assign(ids, await ev(`(async () => {
    const post = async (name, parentId) => (await (await fetch('/api/storage/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parentId }) })).json()).folder.id
    const r = await post(${JSON.stringify(R)}, null)
    const y25 = await post('2025', r); const g25 = await post('Garut', y25)
    const y26 = await post('2026', r); const nov = await post('November', y26); const gNov = await post('Garut', nov); const des = await post('Desember', y26)
    const arsip = await post('Arsip', r)
    return { r, y25, g25, y26, nov, gNov, des, arsip }
  })()`))
  rootId = ids.r

  // Open R / 2026 and the Move dialog of "November".
  await go('/ops/data-warrior', `[...document.querySelectorAll('[data-item-key]')].some((el) => el.querySelector('p')?.innerText.trim() === ${JSON.stringify(R)})`, 'data warrior')
  await ev(`[...document.querySelectorAll('[data-item-key]')].find((el) => el.querySelector('p')?.innerText.trim() === ${JSON.stringify(R)}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await waitFor(`[...document.querySelectorAll('[data-item-key]')].some((el) => el.querySelector('p')?.innerText.trim() === '2026')`, 'inside R')
  await ev(`[...document.querySelectorAll('[data-item-key]')].find((el) => el.querySelector('p')?.innerText.trim() === '2026').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await waitFor(`[...document.querySelectorAll('[data-item-key]')].some((el) => el.querySelector('p')?.innerText.trim() === 'November')`, 'inside 2026')
  await openFolderMenuMove('November')

  await test('opens collapsed from Root: one Root row, nothing chosen, Move disabled', async () => {
    const r = await rows()
    assert(r.length === 1 && r[0].name === 'Root' && r[0].expanded === 'false', `rows ${JSON.stringify(r)}`)
    assert((await preview()) === 'choose a folder in the tree', await preview())
    assert(await confirmDisabled(), 'Move disabled without a target')
    assert((await ev(`document.querySelector('[data-testid="move-subject"]').innerText`)).includes('November'), 'subject')
  })

  await test('expand / collapse level by level with indentation; blocked rows marked', async () => {
    await toggleRow('Root')
    let r = await rows()
    assert(r.some((x) => x.name === R && x.depth === 1), `level 1: ${names(r)}`)
    await toggleRow(R)
    r = await rows()
    const level2 = r.filter((x) => x.depth === 2).map((x) => x.name)
    assert(JSON.stringify(level2) === JSON.stringify(['2025', '2026', 'Arsip']), `level 2: ${level2}`)
    await toggleRow('2026')
    r = await rows()
    const by = Object.fromEntries(r.filter((x) => x.depth === 3).map((x) => [x.name, x]))
    assert(by.November.blocked === 'moving' && by.Desember.blocked === null, `level 3: ${JSON.stringify(by)}`)
    assert(r.find((x) => x.name === '2026').blocked === 'source', '2026 = current location')
    assert(by.November.pad > r.find((x) => x.name === '2026').pad && r.find((x) => x.name === '2026').pad > r.find((x) => x.name === R).pad, 'indentation grows per level')
    await toggleRow('November')
    r = await rows()
    assert(r.find((x) => x.name === 'Garut' && x.depth === 4)?.blocked === 'inside', 'sub-folder of the moved folder disabled')
    const reason = await ev(`${rowSel('2026')}.querySelector('[data-testid="tree-blocked-reason"]').innerText`)
    assert(reason === 'current location', reason)
    await shot('tree')
    await toggleRow(R) // collapse R: its whole sub-tree hides
    r = await rows()
    assert(!r.some((x) => x.depth >= 2), `collapsed: ${names(r)}`)
  })

  await test('disabled rows cannot be chosen; preview shows the full path and updates live', async () => {
    await toggleRow(R)
    await clickRow('2026') // source → ignored
    assert((await preview()) === 'choose a folder in the tree' && (await confirmDisabled()), 'blocked row not selectable')
    await clickRow('Desember')
    assert((await preview()) === `Root / ${R} / 2026 / Desember`, await preview())
    assert(!(await confirmDisabled()), 'Move enabled')
    await clickRow('2025')
    assert((await preview()) === `Root / ${R} / 2025`, `live update: ${await preview()}`)
  })

  await test('search: two "Garut" folders with their parent paths, ancestors expanded, moved branch still disabled', async () => {
    await type('[data-testid="tree-search"]', 'garut')
    await waitFor(`[...document.querySelectorAll('[data-testid="tree-parent-path"]')].length === 2`, 'two matches')
    const r = await rows()
    const garuts = r.filter((x) => x.name === 'Garut')
    assert(JSON.stringify(garuts.map((g) => g.parentPath)) === JSON.stringify([`Root / ${R} / 2025`, `Root / ${R} / 2026 / November`]), `paths ${JSON.stringify(garuts)}`)
    assert(garuts[1].blocked === 'inside' && garuts[0].blocked === null, 'the Garut inside November stays disabled')
    assert(r.filter((x) => x.name !== 'Garut').every((x) => x.expanded === 'true'), 'ancestors expanded')
    assert(!r.some((x) => x.name === 'Arsip' || x.name === 'Desember'), 'non-matching branches hidden')
    await clickRow('Garut', 0)
    assert((await preview()) === `Root / ${R} / 2025 / Garut`, await preview())
    await shot('search')
  })

  await test('Move: November (with its Garut) lands in 2025 / Garut; audit has both paths', async () => {
    await ev(`document.querySelector('[data-testid="move-confirm"]').click()`)
    await waitFor(`!document.querySelector('[data-testid="move-dialog"]')`, 'dialog closed')
    await waitFor(`![...document.querySelectorAll('[data-item-key]')].some((el) => el.querySelector('p')?.innerText.trim() === 'November')`, 'gone from 2026')
    const [{ parent_id }] = await query('SELECT parent_id FROM storage_folders WHERE id = ?', [ids.nov])
    assert(Number(parent_id) === ids.g25, `parent ${parent_id}`)
    const [a] = await query("SELECT metadata FROM storage_audit_logs WHERE action = 'folder.move' AND entity_id = ? ORDER BY id DESC LIMIT 1", [ids.nov])
    const m = typeof a.metadata === 'string' ? JSON.parse(a.metadata) : a.metadata
    assert(m.details.from_path === `Root / ${R} / 2026` && m.details.to_path === `Root / ${R} / 2025 / Garut`, JSON.stringify(m.details))
    assert(m.before.path === `Root / ${R} / 2026 / November` && m.after.path === `Root / ${R} / 2025 / Garut / November`, 'before/after paths')
  })

  await test('Indonesian: title, search, Root, preview and reasons translated', async () => {
    await ev(`[...document.querySelector('aside').querySelectorAll('button[aria-pressed]')].find((b) => b.getAttribute('lang') === 'id').click()`)
    await sleep(300)
    await openFolderMenuMove('Desember')
    const text = await ev(`document.querySelector('[data-testid="move-dialog"]').innerText`)
    for (const s of ['Dipindahkan: Desember', 'Tujuan', 'pilih folder di pohon', 'Root']) assert(text.includes(s), `missing "${s}": ${text.slice(0, 300)}`)
    assert((await ev(`document.querySelector('[data-testid="tree-search"]').placeholder`)) === 'Cari folder…', 'search placeholder')
    await toggleRow('Root'); await toggleRow(R); await toggleRow('2026')
    assert((await ev(`${rowSel('2026')}.querySelector('[data-testid="tree-blocked-reason"]').innerText`)) === 'lokasi saat ini', 'reason (id)')
    await ev(`localStorage.setItem('oneops.locale', 'en')`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
}

main().catch((e) => { console.error(e); failed++ }).finally(async () => {
  try { if (rootId) await ev(`fetch('/api/storage/folders/${rootId}', { method: 'DELETE' })`) } catch {}
  try { await pool.end() } catch {}
  try { ws?.close() } catch {}
  chrome.kill(); await sleep(600)
  try { rmSync(work, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
})
