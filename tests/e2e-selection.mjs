/**
 * Browser E2E (component level): Data Warrior multi-select with real mouse and
 * keyboard events (Chrome DevTools Input domain, modifiers Ctrl / Cmd / Shift).
 *   click, Ctrl+click, Cmd+click, Shift+click (down / up), Ctrl+click → Shift+click,
 *   Shift+↑/↓, Ctrl+↑/↓ (+ Space), Select all (checked / indeterminate / unchecked),
 *   bulk action bar (Delete, Move), Enter / double-click to open.
 * Node >= 22, local Chrome.
 *
 *   npm run build && EMAIL_TRANSPORT=mock PORT=3011 node server/index.js
 *   BASE_URL=http://localhost:3011 node tests/e2e-selection.mjs   # CHROME_PATH / SCREENSHOT_DIR
 *
 * Works in a temporary root folder with 5 sub-folders (no files → R2 unused),
 * removed at the end.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE_URL || 'http://localhost:3001'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9345
const SUFFIX = Date.now().toString(36)
const ROOT_NAME = `e2e-select-${SUFFIX}`
const NAMES = ['A1', 'A2', 'A3', 'A4', 'A5']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const work = mkdtempSync(join(tmpdir(), 'oneops-select-e2e-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, 'profile')}`, '--no-first-run', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' })

let ws, seq = 0
const pend = new Map()
const send = (method, params = {}) => { const i = ++seq; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pend.set(i, { res, rej })) }
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value }
const waitFor = async (e, label, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(e).catch(() => false)) return; await sleep(80) } throw new Error('timeout: ' + label) }
const type = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
const shot = async (n) => { if (!process.env.SCREENSHOT_DIR) return; const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(process.env.SCREENSHOT_DIR, `select-${n}.png`), Buffer.from(data, 'base64')) }
const go = async (path, ready, label) => { await send('Page.navigate', { url: BASE + path }); await waitFor(ready, label) }

// CDP modifier bits: Alt 1, Ctrl 2, Meta(Cmd) 4, Shift 8.
const MOD = { ctrl: 2, meta: 4, shift: 8 }
const bits = (m = {}) => (m.ctrl ? MOD.ctrl : 0) | (m.meta ? MOD.meta : 0) | (m.shift ? MOD.shift : 0)
const itemSel = (name) => `[...document.querySelectorAll('[data-item-key^="folder:"]')].find((el) => el.innerText.trim().split('\\n')[0].trim() === ${JSON.stringify(name)} || el.querySelector('p')?.innerText.trim() === ${JSON.stringify(name)})`
async function clickItem(name, m = {}, clickCount = 1) {
  const box = await ev(`(() => { const el = ${itemSel(name)}; const p = el.querySelector('p'); const r = (p || el).getBoundingClientRect(); return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 } })()`)
  for (const t of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type: t, x: box.x, y: box.y, button: 'left', clickCount, modifiers: bits(m) })
  }
  await sleep(60)
}
const KEYCODES = { ArrowUp: 38, ArrowDown: 40, ' ': 32, Enter: 13, a: 65, Escape: 27 }
async function press(key, m = {}) {
  const code = key === ' ' ? 'Space' : key === 'a' ? 'KeyA' : key
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: KEYCODES[key], modifiers: bits(m) })
  if (key === ' ') await send('Input.dispatchKeyEvent', { type: 'char', text: ' ', key, code, modifiers: bits(m) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: KEYCODES[key], modifiers: bits(m) })
  await sleep(60)
}
const selected = () => ev(`[...document.querySelectorAll('[data-item-key][data-selected="true"]')].map((el) => el.querySelector('p').innerText.trim())`)
const focused = () => ev(`document.activeElement?.closest('[data-item-key]')?.querySelector('p')?.innerText.trim() || null`)
const selectAllState = () => ev(`(() => { const c = document.querySelector('[data-testid="select-all"]'); return c.indeterminate ? 'some' : c.checked ? 'all' : 'none' })()`)
const countText = () => ev(`document.querySelector('[data-testid="selected-count"]')?.innerText.trim() || ''`)
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

let passed = 0, failed = 0
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok    ${name}`) } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`) } }
const assert = (c, m) => { if (!c) throw new Error(m) }
let rootId = null

async function openRoot() {
  await go('/ops/data-warrior', `[...document.querySelectorAll('p')].some((p) => p.innerText.trim() === ${JSON.stringify(ROOT_NAME)})`, 'data warrior')
  await ev(`[...document.querySelectorAll('[data-item-key]')].find((el) => el.querySelector('p')?.innerText.trim() === ${JSON.stringify(ROOT_NAME)}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await waitFor(`${JSON.stringify(NAMES)}.every((n) => [...document.querySelectorAll('[data-item-key]')].some((el) => el.querySelector('p')?.innerText.trim() === n))`, 'sub-folders listed')
}

async function main() {
  let u = ''
  for (let i = 0; i < 50 && !u; i++) { try { u = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl || '' } catch {} if (!u) await sleep(200) }
  ws = new WebSocket(u)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result) } })
  await send('Page.enable'); await send('Runtime.enable')
  console.log(`Data Warrior multi-select browser E2E against ${BASE}\n`)

  await go('/login', `!!document.querySelector('#username')`, 'login page')
  await ev(`localStorage.setItem('oneops.locale', 'en')`)
  await type('#username', 'superadmin'); await type('#password', 'admin123')
  await ev(`document.querySelector('form').requestSubmit()`)
  await waitFor(`location.pathname.startsWith('/ops/')`, 'login')
  rootId = await ev(`(async () => {
    const post = async (body) => (await (await fetch('/api/storage/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()).folder.id
    const root = await post({ name: ${JSON.stringify(ROOT_NAME)} })
    for (const n of ${JSON.stringify(NAMES)}) await post({ name: n, parentId: root })
    return root
  })()`)
  await openRoot()

  await test('plain click selects only that item; Select all becomes indeterminate; bulk bar shows', async () => {
    await clickItem('A2')
    assert(eq(await selected(), ['A2']), `selected ${await selected()}`)
    assert((await countText()) === '1 selected', await countText())
    assert((await selectAllState()) === 'some', 'indeterminate')
    assert(await ev(`!!document.querySelector('[data-testid="bulk-actions"]')`), 'bulk bar')
    assert((await focused()) === 'A2', 'focus on the clicked item')
    await clickItem('A4')
    assert(eq(await selected(), ['A4']), 'second plain click replaces the selection')
  })

  await test('Ctrl+click and Cmd+click add / toggle without clearing the others', async () => {
    await clickItem('A2')
    await clickItem('A4', { ctrl: true })
    await clickItem('A5', { meta: true })
    assert(eq(await selected(), ['A2', 'A4', 'A5']), `selected ${await selected()}`)
    await clickItem('A4', { ctrl: true })
    assert(eq(await selected(), ['A2', 'A5']), `toggle off: ${await selected()}`)
    assert((await countText()) === '2 selected')
  })

  await test('Shift+click selects a range downward and upward', async () => {
    await clickItem('A2')
    await clickItem('A4', { shift: true })
    assert(eq(await selected(), ['A2', 'A3', 'A4']), `down: ${await selected()}`)
    await clickItem('A5')
    await clickItem('A3', { shift: true })
    assert(eq(await selected(), ['A3', 'A4', 'A5']), `up: ${await selected()}`)
    assert((await ev('window.getSelection().toString()')) === '', 'no text selected by Shift+click')
  })

  await test('Ctrl+click then Shift+click keeps the Ctrl pick outside the range', async () => {
    await clickItem('A1')
    await clickItem('A3', { ctrl: true })
    await clickItem('A5', { shift: true })
    assert(eq(await selected(), ['A1', 'A3', 'A4', 'A5']), `selected ${await selected()}`)
    await clickItem('A2', { shift: true })
    assert(eq(await selected(), ['A1', 'A2', 'A3']), `new range replaces the old one, A1 kept: ${await selected()}`)
  })

  await test('Shift+ArrowDown / Shift+ArrowUp extend and shrink the range; focus follows', async () => {
    await clickItem('A2')
    await press('ArrowDown', { shift: true })
    await press('ArrowDown', { shift: true })
    assert(eq(await selected(), ['A2', 'A3', 'A4']), `down: ${await selected()}`)
    assert((await focused()) === 'A4', `focus ${await focused()}`)
    await press('ArrowUp', { shift: true })
    await press('ArrowUp', { shift: true })
    await press('ArrowUp', { shift: true })
    assert(eq(await selected(), ['A1', 'A2']), `up past the anchor: ${await selected()}`)
    assert((await focused()) === 'A1')
    await press('ArrowUp', { shift: true })
    assert((await focused()) === 'A1', 'stays at the first item')
  })

  await test('Ctrl+ArrowDown / Ctrl+ArrowUp move the focus only; Space toggles the focused item', async () => {
    await clickItem('A1')
    await press('ArrowDown', { ctrl: true })
    await press('ArrowDown', { ctrl: true })
    assert(eq(await selected(), ['A1']), `selection unchanged: ${await selected()}`)
    assert((await focused()) === 'A3', `focus ${await focused()}`)
    const ring = await ev(`getComputedStyle(document.activeElement).boxShadow`)
    assert(ring && ring !== 'none', 'visible focus ring on the active item')
    await press(' ')
    assert(eq(await selected(), ['A1', 'A3']), `space: ${await selected()}`)
    await press('ArrowUp', { meta: true })
    assert((await focused()) === 'A2' && eq(await selected(), ['A1', 'A3']), 'Cmd+ArrowUp moves the focus only')
    await shot('keyboard')
  })

  await test('Select all: checked → unchecked; Ctrl/Cmd+A; Esc clears', async () => {
    await ev(`document.querySelector('[data-testid="select-all"]').click()`)
    assert(eq(await selected(), NAMES) && (await selectAllState()) === 'all', 'all')
    assert((await countText()) === '5 selected')
    await clickItem('A3', { ctrl: true })
    assert((await selectAllState()) === 'some', 'indeterminate after Ctrl+click')
    await ev(`document.querySelector('[data-testid="select-all"]').click()`)
    assert((await selectAllState()) === 'all', 'indeterminate → all')
    await ev(`document.querySelector('[data-testid="select-all"]').click()`)
    assert(eq(await selected(), []) && (await selectAllState()) === 'none', 'none')
    assert(!(await ev(`!!document.querySelector('[data-testid="bulk-actions"]')`)), 'bulk bar hidden')
    await clickItem('A1')
    await press('a', { ctrl: true })
    assert(eq(await selected(), NAMES), 'Ctrl+A')
    await press('Escape')
    assert(eq(await selected(), []), 'Esc')
  })

  await test('bulk Delete: selected folders deleted, list + bar updated', async () => {
    await clickItem('A4')
    await clickItem('A5', { shift: true })
    await ev(`document.querySelector('[data-testid="bulk-delete"]').click()`)
    await waitFor(`!!document.querySelector('[data-testid="bulk-delete-dialog"]')`, 'confirm')
    assert((await ev(`document.querySelector('[data-testid="bulk-delete-dialog"]').innerText`)).includes('Delete 2 item(s)?'), 'title')
    await ev(`document.querySelector('[data-testid="bulk-delete-confirm"]').click()`)
    await waitFor(`![...document.querySelectorAll('[data-item-key]')].some((el) => ['A4', 'A5'].includes(el.querySelector('p')?.innerText.trim()))`, 'deleted')
    await waitFor(`document.body.innerText.includes('2 item(s) deleted.')`, 'toast')
    assert(eq(await selected(), []) && (await selectAllState()) === 'none', 'selection cleared')
  })

  await test('bulk Move: A1 moved into A2', async () => {
    await clickItem('A1')
    await ev(`document.querySelector('[data-testid="bulk-move"]').click()`)
    await waitFor(`!!document.querySelector('[data-testid="bulk-move-dialog"]')`, 'move dialog')
    const options = await ev(`[...document.querySelectorAll('#bulk-move-target option')].map((o) => o.text)`)
    assert(!options.includes('A1'), 'cannot move into itself')
    await ev(`(() => { const el = document.querySelector('#bulk-move-target'); const o = [...el.options].find((x) => x.text === 'A2'); el.value = o.value; el.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await ev(`document.querySelector('[data-testid="bulk-move-confirm"]').click()`)
    await waitFor(`![...document.querySelectorAll('[data-item-key]')].some((el) => el.querySelector('p')?.innerText.trim() === 'A1')`, 'moved out of the list')
    await waitFor(`document.body.innerText.includes('1 item(s) moved.')`, 'toast')
  })

  await test('Enter opens the focused folder; list view works the same', async () => {
    await ev(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'List view').click()`)
    await waitFor(`!!document.querySelector('[data-item-key^="folder:"]')`, 'list view')
    await clickItem('A3')
    await clickItem('A2', { shift: true })
    assert(eq(await selected(), ['A2', 'A3']), `list view range: ${await selected()}`)
    await clickItem('A2')
    await press('Enter')
    await waitFor(`[...document.querySelectorAll('[data-item-key]')].some((el) => el.querySelector('p')?.innerText.trim() === 'A1')`, 'inside A2 (contains the moved A1)')
    assert(eq(await selected(), []), 'selection reset after navigation')
    await ev(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Grid view').click()`)
  })

  await test('Indonesian labels', async () => {
    await ev(`[...document.querySelector('aside').querySelectorAll('button[aria-pressed]')].find((b) => b.getAttribute('lang') === 'id').click()`)
    await sleep(300)
    assert((await ev(`document.querySelector('[data-testid="selection-bar"]').innerText`)).includes('Pilih semua'), 'select all (id)')
    await clickItem('A1')
    assert((await countText()) === '1 dipilih', await countText())
    await ev(`localStorage.setItem('oneops.locale', 'en')`)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
}

main().catch((e) => { console.error(e); failed++ }).finally(async () => {
  try { if (rootId) await ev(`fetch('/api/storage/folders/${rootId}', { method: 'DELETE' })`) } catch {}
  try { ws?.close() } catch {}
  chrome.kill(); await sleep(600)
  try { rmSync(work, { recursive: true, force: true }) } catch {}
  process.exit(failed ? 1 : 0)
})
