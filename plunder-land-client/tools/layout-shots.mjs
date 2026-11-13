#!/usr/bin/env node
/**
 * Layout screenshots and an overlap/clipping audit of the lobby and the run
 * HUD (task g2-4; reused by g2-7's visual QA). Measurement only: it changes
 * no game code.
 *
 * It drives a **development** client (webpack-dev-server: it reaches the
 * game's modules through the webpack chunk array, which a production build
 * minifies away) against a local server with the admin endpoints on, and:
 *
 * 1. makes a guest account over socket.io, levels it through the admin
 *    endpoints (XP, energy, stashed gear), saves a four-skill loadout and
 *    remembers two stash items to bring on keys 3-4;
 * 2. per input mode (desktop: CrazyGames' ten frames at DPR 1; touch:
 *    `hasTouch` + `isMobile`, so `(pointer: coarse)` starts touch mode),
 *    opens the lobby and its panels, starts a run, opens the hot slot's fan,
 *    the phone leaderboard and settings, walks to an exit and captures the
 *    run card. Each state is captured at every size of that mode by
 *    re-emulating the viewport (CDP `setDeviceMetricsOverride`, so the DPR
 *    changes too) in the same page;
 * 3. at each shot measures the elements' rectangles in CSS px (pixi bounds
 *    for the HUD, DOM rects for the lobby) and writes overlaps, parts outside
 *    the screen or the safe area, and text under 10 CSS px to
 *    `<out>/report.json` and `<out>/report.tsv`.
 *
 * Usage (from plunder-land-client/, servers on spare ports, never 6379/8000):
 *
 *   ADMIN_KEY_FILE=/path/to/key node tools/layout-shots.mjs \
 *     --client http://localhost:3093 --server http://localhost:8093 \
 *     --out outputs/layout-g2 [--modes desktop,touch] [--only 844x390,750x340]
 *
 * The server must run with ADMIN_KEY (32+ chars, the same as the file's
 * content) and FIRST_RUN_CAP=0 (a fresh account otherwise gets the first run,
 * whose strip has no exit to walk to). Playwright is not a dependency of this
 * package: it is loaded from `PLAYWRIGHT_DIR` (a folder holding
 * node_modules/playwright), else from the npx cache
 * (`npx -y playwright@1.63.0 --version` fills it), with its Chromium.
 *
 * Known limits: Chromium only (not WebKit/iOS Safari); safe-area insets are
 * emulated (`Emulation.setSafeAreaInsetsOverride`) with assumed values, not
 * read from a device; medkit and bomb counts are set client-side for the
 * picture (`HUD.updateInventory`), the gear on keys 3-4 is real.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

// ---------------------------------------------------------------- arguments

const args = Object.fromEntries(process.argv.slice(2).reduce((out, a, i, all) => {
  if (a.startsWith('--')) out.push([a.slice(2), all[i + 1] !== undefined && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'])
  return out
}, []))
const CLIENT = args.client ?? 'http://localhost:3093'
const SERVER = args.server ?? 'http://localhost:8093'
const OUT = resolve(args.out ?? 'outputs/layout-g2')
const MODES = (args.modes ?? 'desktop,touch').split(',')
const ONLY = args.only !== undefined ? new Set(args.only.split(',')) : undefined
const KEY_FILE = process.env.ADMIN_KEY_FILE
if (KEY_FILE === undefined) throw new Error('ADMIN_KEY_FILE must name a file holding the server\'s ADMIN_KEY')
const ADMIN_KEY = readFileSync(KEY_FILE, 'utf8').trim()
for (const port of [6379, 8000]) {
  for (const url of [CLIENT, SERVER]) if (new URL(url).port === String(port)) throw new Error(`refusing port ${port} (Nick's local stack)`)
}

function loadPlaywright () {
  const tries = []
  if (process.env.PLAYWRIGHT_DIR !== undefined) tries.push(join(process.env.PLAYWRIGHT_DIR, 'node_modules', 'playwright'))
  tries.push('playwright')
  const npx = join(homedir(), '.npm', '_npx')
  if (existsSync(npx)) for (const d of readdirSync(npx)) tries.push(join(npx, d, 'node_modules', 'playwright'))
  for (const t of tries) {
    try { return require(t) } catch {}
  }
  throw new Error('playwright not found: set PLAYWRIGHT_DIR or run `npx -y playwright@1.63.0 --version` once')
}
const { chromium } = loadPlaywright()
const { io } = require('socket.io-client')

// ---------------------------------------------------------------- sizes

/**
 * `name` is the file stem. CrazyGames' ten frames (docs.crazygames.com/requirements/gameplay,
 * read 2026-11-13) at DPR 1; phones at their DPR; "+toolbar" sizes are Playwright's
 * landscape device descriptors (Safari/Chrome with their bars), "+notch" adds assumed
 * iPhone landscape safe-area insets (47 left/right, 21 bottom; not measured on a device).
 */
const NOTCH = { top: 0, left: 47, right: 47, bottom: 21 }
const SIZES = {
  desktop: [
    { name: 'cg-desktop-907x510', w: 907, h: 510, dpr: 1 },
    { name: 'cg-desktop-1216x684', w: 1216, h: 684, dpr: 1 },
    { name: 'cg-desktop-1077x606', w: 1077, h: 606, dpr: 1 },
    { name: 'cg-desktop-821x462', w: 821, h: 462, dpr: 1 },
    { name: 'cg-full-1366x768', w: 1366, h: 768, dpr: 1 },
    { name: 'cg-full-1920x1080', w: 1920, h: 1080, dpr: 1 },
    { name: 'cg-full-1536x864', w: 1536, h: 864, dpr: 1 },
    { name: 'cg-full-1280x720', w: 1280, h: 720, dpr: 1 },
    { name: 'cg-mobile-800x450', w: 800, h: 450, dpr: 1 },
    { name: 'cg-tablet-1080x607', w: 1080, h: 607, dpr: 1 }
  ],
  touch: [
    { name: 'cg-mobile-800x450-touch', w: 800, h: 450, dpr: 1 },
    { name: 'cg-tablet-1080x607-touch', w: 1080, h: 607, dpr: 1 },
    { name: 'iphone-667x375', w: 667, h: 375, dpr: 3 },
    { name: 'iphone-844x390', w: 844, h: 390, dpr: 3 },
    { name: 'iphone-932x430', w: 932, h: 430, dpr: 3 },
    { name: 'iphone-844x390-notch', w: 844, h: 390, dpr: 3, insets: NOTCH },
    { name: 'iphone-932x430-notch', w: 932, h: 430, dpr: 3, insets: NOTCH },
    { name: 'iphone14-750x340-toolbar', w: 750, h: 340, dpr: 3 },
    { name: 'iphone14-750x340-toolbar-notch', w: 750, h: 340, dpr: 3, insets: NOTCH },
    { name: 'iphone15pro-734x343-toolbar-notch', w: 734, h: 343, dpr: 3, insets: NOTCH },
    { name: 'iphone15promax-814x380-toolbar-notch', w: 814, h: 380, dpr: 3, insets: NOTCH },
    { name: 'android-740x360', w: 740, h: 360, dpr: 2.625 },
    { name: 'android-915x412', w: 915, h: 412, dpr: 2.625 },
    { name: 'pixel7-863x360-toolbar', w: 863, h: 360, dpr: 2.625 },
    { name: 'iphone-portrait-390x844', w: 390, h: 844, dpr: 3, portrait: true },
    { name: 'android-portrait-412x915', w: 412, h: 915, dpr: 2.625, portrait: true }
  ]
}
const pick = (list) => list.filter((s) => ONLY === undefined || ONLY.has(s.name) || ONLY.has(`${s.w}x${s.h}`))

// ---------------------------------------------------------------- account

function admin (path, body) {
  return fetch(`${SERVER}/admin/account/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async (res) => {
    if (!res.ok) throw new Error(`admin ${path}: ${res.status} (is ADMIN_KEY on and the same?)`)
    return res.json()
  })
}

function connect (token) {
  return io(SERVER, { transports: ['websocket'], auth: token === undefined ? {} : { token }, reconnection: false })
}

function once (socket, event, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error(`no ${event} within ${ms} ms`)) }, ms)
    socket.once(event, (data) => { clearTimeout(t); resolve(data) })
  })
}

/** A levelled guest account: { id, token, bring: [rowId, rowId] }. */
async function makeAccount () {
  // A new player has no account until a start: the first start makes one.
  const s1 = connect()
  await once(s1, 'connect')
  const got = once(s1, 'account')
  s1.emit('start_requested', { name: 'LAYOUT', robot: 'peep', loadout: 0 })
  const account = await got
  s1.close()
  if (typeof account.token !== 'string') throw new Error('the server gave no token (offline account?)')
  // Level 14 (xpToReach(14) = 11440 with the curve 40/140), part way to 15:
  // everything in the journey open, a bar half full.
  await admin(`${account.id}/xp`, { xp: 12000 })
  await admin(`${account.id}/energy`, { stock: 99 })
  // Two skill items to bring on keys 3-4, and parts for the stash grid.
  await admin(`${account.id}/gear`, {
    items: [
      { tier: 3, skill: 6, rolls: [[1, 600], [4, 400]] },
      { tier: 2, skill: 7, rolls: [[2, 500], [6, 700]] },
      { tier: 1, skill: 0, rolls: [] },
      { tier: 2, skill: 0, rolls: [] },
      { tier: 4, skill: 0, rolls: [] },
      { tier: 1, skill: 5, rolls: [[6, 300]] }
    ]
  })
  // Reconnect with the token: the stash's row ids, and a four-skill loadout.
  const s2 = connect(account.token)
  const stash = once(s2, 'stash')
  await once(s2, 'connect')
  const view = await stash
  s2.emit('save_loadout', { robot: 'peep', index: 0, skills: [3, 1, 4, 6] })
  await once(s2, 'loadout_saved').catch(() => { console.warn('no loadout_saved: the run plays the start kit') })
  s2.close()
  const rows = (view.items ?? []).filter((r) => r.skill !== 0)
  return { id: account.id, token: account.token, bring: [rows[0]?.id ?? null, rows[1]?.id ?? null] }
}

// ---------------------------------------------------------------- in-page probes

/** Installed in every page: game module access and the measurements. Runs in the browser. */
function pageHelpers () {
  window.__ls = {
    req () {
      if (window.__lsReq === undefined) {
        const chunks = window.webpackChunkplunder_land_client
        if (chunks === undefined) throw new Error('no webpack chunk array: run a development client')
        chunks.push([[Symbol('layout-shots')], {}, (r) => { window.__lsReq = r }])
      }
      return window.__lsReq
    },
    mod (path) { return this.req()(path) },
    get Game () { return this.mod('./src/game.ts').Game },
    inRun () { const G = this.Game; return G.PLAYER !== undefined && G.hud?.status !== undefined },
    card () { return this.Game.Instance?.runCard },

    /** Every HUD element worth checking, as { name, x, y, w, h } in CSS px; invisible ones left out. */
    hudRects () {
      const G = this.Game
      const hud = G.hud
      const out = []
      const shown = (c) => {
        let n = c
        while (n !== null && n !== undefined) {
          if (!n.visible || !n.renderable || n.alpha === 0) return false
          n = n.parent
        }
        return true
      }
      const add = (name, c, box) => {
        if (c === undefined || c === null || !shown(c)) return
        const b = box ?? c.getBounds()
        if (b.width === 0 || b.height === 0) return
        out.push({ name, x: b.x, y: b.y, w: b.width, h: b.height })
      }
      // Boxes from known sizes where children can draw past the frame.
      const frame = (c, w, h) => {
        if (c === undefined) return undefined
        const p = c.getGlobalPosition()
        return { x: p.x, y: p.y, width: w * c.worldTransform.a, height: h * c.worldTransform.d }
      }
      add('status panel', hud.status, hud.status && frame(hud.status, hud.status.panelWidth, hud.status.panelHeight))
      add('status inventory', hud.status?.inventory)
      add('clock', hud.clock, hud.clock && frame(hud.clock, hud.clock.panelWidth, hud.clock.panelHeight))
      add('minimap', hud.map, hud.map && frame(hud.map, 200, 200))
      add('layer badge', hud.badge, hud.badge && frame(hud.badge, hud.badge.panelWidth, hud.badge.panelHeight))
      add('layers panel', hud.layers, hud.layers && frame(hud.layers, hud.layers.panelWidth, hud.layers.panelHeight))
      add('fog legend', hud.legend)
      add('settings button', hud.settings)
      add('fullscreen button', hud.fullscreen)
      add('skill row', hud.skills)
      const board = this.mod('./src/ui/components/leaderboard.ts').Leaderboard.Instance
      add('leaderboard', board, board && frame(board, board.panelWidth, board.panelHeight))
      const r = hud.radial
      if (r.visible) {
        r._skills.forEach((b) => { add(b.size >= 92 ? 'radial primary' : `radial skill ${r._cards.indexOf(b.card) + 1}`, b, frame(b, b.size, b.size)) })
        const names = ['medkit', 'bomb', 'gear 3', 'gear 4']
        r._items.forEach((b, i) => { add(i === r._current ? `hot slot (${names[i] ?? i})` : `fan ${names[i] ?? i}`, b, frame(b, b.size, b.size)) })
        add('hot slot toggle', r._toggle, frame(r._toggle, r._toggle.size, r._toggle.size))
      }
      if (hud.joystick.visible) {
        // The ghost: the stick's base where it rests.
        const j = hud.joystick
        add('joystick', j)
      }
      const card = this.card()
      if (card !== undefined && card.visible) add('run card', card)
      const spectate = G.popups?.children?.find((c) => c.constructor?.name === 'SpectateBar')
      if (spectate !== undefined) add('spectate bar', spectate)
      return out
    },

    /** Pixi text under `min` CSS px (font size times the world scale), by its nearest named ancestor. */
    smallPixiText (min) {
      const G = this.Game
      const out = []
      const walk = (c) => {
        if (!c.visible || !c.renderable) return
        if (c.text !== undefined && c.style !== undefined && typeof c.text === 'string' && c.text.trim() !== '') {
          const px = Number(c.style.fontSize) * Math.abs(c.worldTransform.d)
          if (px < min) out.push({ text: c.text.slice(0, 24), px: Math.round(px * 10) / 10 })
        }
        for (const k of c.children ?? []) walk(k)
      }
      walk(G.hud)
      const board = this.mod('./src/ui/components/leaderboard.ts').Leaderboard.Instance
      if (board !== undefined) walk(board)
      if (G.popups !== undefined) walk(G.popups)
      return out
    },

    /** The lobby's blocks, the open panel and the settings panel, as rects; plus overflow and small text. */
    domRects () {
      const out = []
      const rect = (name, el) => {
        if (el === null || el === undefined) return
        const st = getComputedStyle(el)
        if (st.display === 'none' || st.visibility === 'hidden' || el.closest('.lb-hidden') !== null || el.hidden) return
        const b = el.getBoundingClientRect()
        if (b.width === 0 || b.height === 0) return
        out.push({ name, x: b.x, y: b.y, w: b.width, h: b.height })
      }
      const q = (s) => document.querySelector(s)
      const qa = (s) => [...document.querySelectorAll(s)]
      // The rotate prompt covers everything: only its own pieces count then.
      const rp = q('.rp.rp-on')
      if (rp !== null) {
        rect('rotate prompt', rp)
        rect('rotate icon', rp.querySelector('.rp-icon'))
        rect('rotate title', rp.querySelector('.rp-title'))
        rect('rotate hint', rp.querySelector('.rp-hint'))
        return out
      }
      rect('header', q('.lb-top'))
      rect('wordmark', q('.lb-wordmark'))
      rect('header actions', q('.lb-topactions'))
      rect('menu button', q('.lb-menu'))
      rect('callsign', q('.lb-callsign'))
      rect('robot plate', q('.lb-plate'))
      rect('choose plunderbot', q('.lb-change'))
      rect('READY', q('.lb-ready'))
      rect('plays line', q('.lb-ready-sub'))
      rect('progress', q('.lb-progress'))
      rect('journey', q('.lb-journey'))
      qa('.lb-act').forEach((e, i) => { rect(`row ${e.querySelector('.lb-actlabel')?.textContent ?? i}`, e) })
      rect('season row', q('.lb-season'))
      rect('build tag', q('.lb-build'))
      // The lobby's open panel (all four are .lb-custom; the second class names it).
      for (const el of qa('.lb-custom:not(.lb-hidden)')) rect(`panel ${el.classList[1] ?? 'stats & paint'}`, el)
      rect('settings panel', q('.st-panel'))
      return out
    },

    domOverflow () {
      const root = document.querySelector('.lb-root') ?? document.querySelector('[class^="lb-"]')?.closest('div')
      const scrollers = [...document.querySelectorAll('*')].filter((e) => {
        const st = getComputedStyle(e)
        return (st.overflowY === 'auto' || st.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 1 && e.clientHeight > 0
      }).map((e) => ({ el: e.className.toString().split(' ')[0] || e.tagName, hidden: e.scrollHeight - e.clientHeight }))
      return { zoom: root !== null && root !== undefined ? getComputedStyle(root).zoom : null, scrollers, pageX: document.documentElement.scrollWidth - innerWidth, pageY: document.documentElement.scrollHeight - innerHeight }
    },

    smallDomText (min) {
      const out = []
      const rp = document.querySelector('.rp.rp-on')
      for (const el of (rp ?? document.body).querySelectorAll('*')) {
        if (el.children.length > 0 && [...el.childNodes].every((n) => n.nodeType !== 3 || n.textContent.trim() === '')) continue
        const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim()
        if (text === '') continue
        const b = el.getBoundingClientRect()
        if (b.width === 0 || b.height === 0 || el.closest('.lb-hidden') !== null) continue
        const st = getComputedStyle(el)
        if (st.visibility === 'hidden' || st.display === 'none') continue
        // Effective size: computed font size times every ancestor's CSS zoom.
        let zoom = 1
        for (let n = el; n !== null; n = n.parentElement) { const z = parseFloat(getComputedStyle(n).zoom); if (Number.isFinite(z) && z > 0) zoom *= z }
        const px = parseFloat(st.fontSize) * zoom
        if (px < min) out.push({ text: text.slice(0, 24), px: Math.round(px * 10) / 10, cls: el.className.toString().split(' ')[0] })
      }
      return out
    }
  }
}

// ---------------------------------------------------------------- geometry

function overlap (a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0.5 && h > 0.5 ? { w: Math.round(w), h: Math.round(h) } : undefined
}

/** Pairs that sit on each other by design (not defects). */
const BY_DESIGN = [
  ['layer badge', 'minimap'], // the badge is drawn in the minimap's corner (Nick, 2026-11-05)
  ['status inventory', 'status panel'], // the inventory is inside the panel
  ['header actions', 'header'], ['wordmark', 'header'], ['menu button', 'header'], ['menu button', 'header actions'],
  ['plays line', 'READY'], ['choose plunderbot', 'robot plate']
]
const designed = (a, b) => BY_DESIGN.some(([x, y]) => (a === x && b === y) || (a === y && b === x))
const isPanel = (n) => n.startsWith('panel') || n === 'settings panel' || n === 'rotate prompt' || n === 'run card'

function findings (rects, size, screen) {
  const rows = []
  const W = size.w
  const H = size.h
  const ins = size.insets ?? { top: 0, left: 0, right: 0, bottom: 0 }
  // Overlaps. A modal (open panel, run card, rotate prompt) is expected to cover things: listed once as "covers".
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]
      const b = rects[j]
      if (designed(a.name, b.name) || a.name === 'rotate prompt' || b.name === 'rotate prompt') continue
      if (a.name.startsWith('fan ') && b.name.startsWith('fan ')) continue
      const o = overlap(a, b)
      if (o === undefined) continue
      // Two round buttons overlap only if their circles do, not their boxes.
      const round = (r) => r.name.startsWith('radial') || r.name.startsWith('hot slot') || r.name.startsWith('fan ')
      if (round(a) && round(b) && Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2) >= (a.w + b.w) / 2) continue
      const modal = isPanel(a.name) || isPanel(b.name)
      rows.push({ kind: modal ? 'covered by modal' : 'overlap', a: a.name, b: b.name, px: `${o.w}x${o.h}` })
    }
  }
  // Off screen, and inside the screen but outside the safe area.
  for (const r of rects) {
    const off = [r.x < 0 ? `left ${Math.round(-r.x)}` : '', r.y < 0 ? `top ${Math.round(-r.y)}` : '', r.x + r.w > W ? `right ${Math.round(r.x + r.w - W)}` : '', r.y + r.h > H ? `bottom ${Math.round(r.y + r.h - H)}` : ''].filter(Boolean)
    if (off.length > 0) rows.push({ kind: 'off screen', a: r.name, b: '(screen edge)', px: off.join(', ') })
    else if (size.insets !== undefined) {
      const unsafe = [r.x < ins.left ? `left ${Math.round(ins.left - r.x)}` : '', r.y < ins.top ? `top ${Math.round(ins.top - r.y)}` : '', r.x + r.w > W - ins.right ? `right ${Math.round(r.x + r.w - (W - ins.right))}` : '', r.y + r.h > H - ins.bottom ? `bottom ${Math.round(r.y + r.h - (H - ins.bottom))}` : ''].filter(Boolean)
      if (unsafe.length > 0 && !isPanel(r.name) && r.name !== 'header') rows.push({ kind: 'outside safe area', a: r.name, b: '(safe-area edge)', px: unsafe.join(', ') })
    }
  }
  // The badge belongs inside the minimap's corner: report what spills out.
  const badge = rects.find((r) => r.name === 'layer badge')
  const map = rects.find((r) => r.name === 'minimap')
  if (badge !== undefined && map !== undefined) {
    const spill = [badge.x < map.x ? `left ${Math.round(map.x - badge.x)}` : '', badge.y < map.y ? `top ${Math.round(map.y - badge.y)}` : '', badge.x + badge.w > map.x + map.w ? `right ${Math.round(badge.x + badge.w - map.x - map.w)}` : '', badge.y + badge.h > map.y + map.h ? `bottom ${Math.round(badge.y + badge.h - map.y - map.h)}` : ''].filter(Boolean)
    if (spill.length > 0) rows.push({ kind: 'spills out of', a: 'layer badge', b: 'minimap', px: spill.join(', ') })
  }
  // Clearance between the minimap and the item buttons under it (the candidate
  // "inventory carousel"): negative is an overlap. Only where both are shown.
  if (map !== undefined) {
    for (const r of rects.filter((x) => x.name.startsWith('hot slot') || x.name.startsWith('fan ') || x.name === 'hot slot toggle')) {
      const dx = Math.max(map.x - (r.x + r.w), r.x - (map.x + map.w))
      const dy = Math.max(map.y - (r.y + r.h), r.y - (map.y + map.h))
      if (dx < 0) rows.push({ kind: 'clearance', a: r.name, b: 'minimap', px: `${Math.round(dy)} vertical` })
    }
  }
  return rows.map((r) => ({ screen, size: size.name, ...r }))
}

// ---------------------------------------------------------------- driving

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Re-size the page to `size`. Playwright owns the device metrics (a raw CDP
 * `setDeviceMetricsOverride` is undone by its next screenshot), so the size
 * goes through `setViewportSize` and the DPR is the context's: `runMode` makes
 * one context per DPR. The safe-area insets are CDP's (Playwright doesn't
 * manage them). The page's own innerWidth/innerHeight and `SAFE_AREA` are
 * read back and checked, so a size that didn't take fails loudly.
 */
async function emulate (page, cdp, size) {
  await page.setViewportSize({ width: size.w, height: size.h })
  try {
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: size.insets ?? { top: 0, left: 0, right: 0, bottom: 0 } })
  } catch (e) {
    if (size.insets !== undefined) throw new Error(`this Chromium can't emulate safe-area insets: ${e.message}`)
  }
  // Insets are read on resize; nudge one after the override, then let the lobby's fit (next frame) settle.
  await page.evaluate(() => { window.dispatchEvent(new Event('resize')) })
  await sleep(450)
  const seen = await page.evaluate(() => {
    let safe = null
    try { safe = { ...window.__ls.mod('./src/ui/safearea.ts').SAFE_AREA } } catch {}
    return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, safe }
  })
  const want = size.insets ?? { top: 0, left: 0, right: 0, bottom: 0 }
  if (seen.w !== size.w || seen.h !== size.h || Math.abs(seen.dpr - size.dpr) > 0.01) throw new Error(`${size.name}: the page is ${seen.w}x${seen.h} at DPR ${seen.dpr}`)
  if (seen.safe !== null && ['top', 'left', 'right', 'bottom'].some((k) => seen.safe[k] !== want[k])) throw new Error(`${size.name}: SAFE_AREA reads ${JSON.stringify(seen.safe)}`)
  return seen
}

const report = []

async function shoot (page, cdp, mode, sizes, screen, opts = {}) {
  for (const size of sizes) {
    if (opts.landscapeOnly === true && size.portrait === true) continue
    if (opts.phoneOnly === true && Math.min(size.w, size.h) >= 520) continue
    await emulate(page, cdp, size)
    if (opts.before !== undefined) await opts.before(size)
    const file = `${screen}__${size.name}.jpg`
    await page.screenshot({ path: join(OUT, file), type: 'jpeg', quality: 82 })
    const dom = await page.evaluate(() => window.__ls.domRects())
    const prompt = dom.some((r) => r.name === 'rotate prompt')
    // The lobby's DOM covers the canvas: pixi objects left on the stage under it (the leaderboard) aren't seen.
    const lobby = dom.some((r) => r.name === 'READY')
    const hud = prompt || lobby ? [] : await page.evaluate(() => { try { return window.__ls.hudRects() } catch { return [] } })
    const rects = [...dom, ...hud]
    const rows = findings(rects, size, screen)
    const smallDom = await page.evaluate(() => window.__ls.smallDomText(10))
    const smallPixi = prompt ? [] : await page.evaluate(() => { try { return window.__ls.smallPixiText(10) } catch { return [] } })
    // Small text: one row per shot (count, smallest, a few examples); every string is in report.json.
    const small = [...smallDom, ...smallPixi].sort((a, b) => a.px - b.px)
    if (small.length > 0) {
      const examples = [...new Set(small.map((t) => `"${t.text}"${t.cls !== undefined && t.cls !== '' ? ` .${t.cls}` : ''} ${t.px}`))].slice(0, 4).join('; ')
      rows.push({ screen, size: size.name, kind: 'text < 10 px', a: `${small.length} strings`, b: examples, px: `min ${small[0].px} px` })
    }
    const overflow = await page.evaluate(() => window.__ls.domOverflow())
    for (const s of overflow.scrollers) rows.push({ screen, size: size.name, kind: 'scrolls', a: s.el, b: '(own scroll box)', px: `${s.hidden} hidden` })
    if (overflow.pageX > 0) rows.push({ screen, size: size.name, kind: 'page scrolls sideways', a: 'document', b: '', px: `${overflow.pageX}` })
    report.push({ screen, size, file, rects, small, rows })
    for (const r of rows) r.file = file
    console.log(`${file}: ${rows.filter((r) => r.kind === 'overlap' || r.kind === 'off screen' || r.kind === 'outside safe area').length} overlap/clip, ${rows.length} rows`)
  }
}

async function waitFor (page, fn, ms, what) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await page.evaluate(fn).catch(() => false)) return true
    await sleep(250)
  }
  console.warn(`timed out waiting for ${what}`)
  return false
}

async function runMode (browser, mode, account, sizes) {
  if (sizes.length === 0) return
  const first = sizes.find((s) => s.portrait !== true) ?? sizes[0]
  const context = await browser.newContext({
    viewport: { width: first.w, height: first.h },
    deviceScaleFactor: first.dpr,
    hasTouch: mode === 'touch',
    isMobile: mode === 'touch'
  })
  await context.addInitScript(({ token, id, bring }) => {
    try {
      localStorage.setItem('plunderland_token', token)
      localStorage.setItem('plunderland_bring', JSON.stringify({ [id]: bring }))
      localStorage.setItem('plunderland_sound', '0')
    } catch {}
  }, account)
  await context.addInitScript(pageHelpers)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => { errors.push(e.message) })
  const cdp = await context.newCDPSession(page)
  await page.goto(`${CLIENT}/?server=${encodeURIComponent(SERVER)}`)
  await waitFor(page, () => document.querySelector('.lb-ready') !== null && /Level 1[0-9]/.test(document.querySelector('.lb-levelhead')?.textContent ?? ''), 20000, 'the lobby with the account')
  await sleep(800)

  // Lobby, then each panel (closed again before the next).
  await shoot(page, cdp, mode, sizes, `${mode}-lobby`)
  for (const [screen, open] of [['lobby-pick', -1], ['lobby-loadout', 0], ['lobby-paint', 1], ['lobby-stash', 2]]) {
    await page.evaluate((i) => { (i < 0 ? document.querySelector('.lb-change') : document.querySelectorAll('.lb-act')[i]).click() }, open)
    await sleep(300)
    await shoot(page, cdp, mode, sizes, `${mode}-${screen}`, { landscapeOnly: true })
    await page.keyboard.press('Escape')
    await sleep(200)
  }
  await page.evaluate(() => { [...document.querySelectorAll('.lb-settings')].find((e) => /settings/i.test(e.textContent))?.click() })
  await sleep(300)
  await shoot(page, cdp, mode, sizes, `${mode}-lobby-settings`, { landscapeOnly: true })
  await page.keyboard.press('Escape')
  await sleep(300)

  // A run, from the lobby's READY at the first landscape size.
  await emulate(page, cdp, first)
  const startRun = async () => {
    await page.evaluate(() => {
      const card = window.__ls.card()
      if (card !== undefined && card.parent) card.again?.()
    })
    await sleep(1200)
    // The card's button may lead back to the lobby: READY from there.
    await page.evaluate(() => { if (!window.__ls.inRun()) document.querySelector('.lb-ready')?.click() })
    const ok = await waitFor(page, () => window.__ls.inRun(), 30000, 'a run')
    await sleep(1500)
    // Medkits and bombs for the picture (display only; the gear on 3-4 is real).
    await page.evaluate(() => { window.__ls.Game.hud.updateInventory([2, 1, 0, 0, 0]) })
    return ok
  }
  if (await startRun()) {
    const alive = async () => {
      if (await page.evaluate(() => window.__ls.inRun())) return
      // Died (or extracted by accident): the card is captured once, then play again.
      if (!report.some((r) => r.screen.startsWith(`${mode}-card`))) await shoot(page, cdp, mode, sizes.slice(0, 1), `${mode}-card-early`)
      await startRun()
    }
    await shoot(page, cdp, mode, sizes, `${mode}-run`, { before: alive })
    if (mode === 'touch') {
      const blocked = []
      await shoot(page, cdp, mode, sizes, `${mode}-run-fan-open`, {
        landscapeOnly: true,
        before: async (size) => {
          await alive()
          // Closed first, so every size's toggle is tapped for real (the fan stays open across a resize).
          await page.evaluate(() => { window.__ls.Game.hud.radial.setOpen(false) })
          await sleep(400)
          const b = await page.evaluate(() => { const g = window.__ls.Game.hud.radial._toggle.getBounds(); return { x: g.x + g.width / 2, y: g.y + g.height / 2 } })
          await page.touchscreen.tap(b.x, b.y)
          await sleep(300)
          // A tap on the toggle's centre that didn't open the fan means something
          // covers the toggle: recorded, then the fan is opened directly for the picture.
          const opened = await page.evaluate(() => window.__ls.Game.hud.radial._open)
          if (!opened) {
            const top = await page.evaluate(({ x, y }) => {
              const G = window.__ls.Game
              const hit = G.RENDERER?.events?.rootBoundary?.hitTest?.(x, y)
              let n = hit
              const names = []
              while (n !== null && n !== undefined && names.length < 4) { names.push(n.constructor?.name); n = n.parent }
              G.hud.radial.setOpen(true)
              return names.join(' < ')
            }, b)
            blocked.push({ size: size.name, top })
            await sleep(300)
          }
        }
      })
      for (const x of blocked) {
        const row = { screen: `${mode}-run-fan-open`, size: x.size, kind: 'tap blocked', a: 'hot slot toggle', b: `a tap at its centre hit: ${x.top || 'nothing'}`, px: '', file: `${mode}-run-fan-open__${x.size}.jpg` }
        report.find((r) => r.file === row.file)?.rows.push(row)
        console.log(`toggle tap blocked at ${x.size}: ${x.top}`)
      }
      // Close the fan (a tap anywhere does), then the phone's leaderboard from the clock.
      await page.evaluate(() => { window.__ls.Game.hud.radial.setOpen(false) })
      await shoot(page, cdp, mode, sizes, `${mode}-run-board-open`, {
        landscapeOnly: true,
        phoneOnly: true,
        before: async () => {
          await alive()
          await page.evaluate(() => { const h = window.__ls.Game.hud; if (!h.boardOpen) h.toggleBoard() })
          await sleep(200)
        }
      })
      await page.evaluate(() => { const h = window.__ls.Game.hud; if (h.boardOpen) h.toggleBoard() })
    }
    await alive()
    await page.keyboard.press('Escape')
    await sleep(300)
    await shoot(page, cdp, mode, sizes, `${mode}-run-settings`, { landscapeOnly: true })
    await page.keyboard.press('Escape')
    await sleep(300)

    // The run card: walk to the nearest exit and channel it. A death on the
    // way is captured as the death card, and the walk is tried once more.
    const cards = new Set()
    for (let attempt = 0; attempt < 3 && !cards.has('extracted'); attempt++) {
      await emulate(page, cdp, first)
      await alive()
      const walking = await page.evaluate(() => {
        const ls = window.__ls
        const G = ls.Game
        const Exit = ls.mod('./src/objects/exit.ts').Exit
        const me = G.PLAYER
        if (me === undefined) return false
        const exits = Object.values(G.Instance.LOOKUP).filter((o) => o instanceof Exit && o.tag === me.tag)
        exits.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))
        if (exits[0] === undefined) return false
        window.__lsExit = { x: exits[0].x, y: exits[0].y }
        G.LOCAL.setDestination(exits[0].x, exits[0].y)
        return true
      })
      if (!walking) { console.warn('no exit in view on this layer'); break }
      const ended = await waitFor(page, () => {
        if (window.__ls.card() !== undefined) return true
        // Re-issue the order now and then (a route can stall on a mob).
        if (Math.random() < 0.1 && window.__ls.Game.PLAYER !== undefined) window.__ls.Game.LOCAL.setDestination(window.__lsExit.x, window.__lsExit.y)
        return false
      }, 120000, 'the run card')
      if (!ended) break
      await sleep(2500) // the GEAR line settles
      const outcome = await page.evaluate(() => window.__ls.card()?._panel?._title?.text === 'DESTROYED' ? 'dead' : 'extracted')
      if (!cards.has(outcome)) await shoot(page, cdp, mode, sizes, `${mode}-card-${outcome}`, { landscapeOnly: true })
      cards.add(outcome)
    }
  }
  if (errors.length > 0) console.warn(`${mode}: page errors:\n  ${[...new Set(errors)].join('\n  ')}`)
  await context.close()
}

// ---------------------------------------------------------------- main

mkdirSync(OUT, { recursive: true })
const account = await makeAccount()
console.log(`account ${account.id}, bring ${account.bring.join(', ')}`)
const browser = await chromium.launch()
try {
  for (const mode of MODES) {
    // One context (and one run) per DPR: see `emulate`.
    const sizes = pick(SIZES[mode])
    for (const dpr of [...new Set(sizes.map((x) => x.dpr))]) await runMode(browser, mode, account, sizes.filter((x) => x.dpr === dpr))
  }
} finally {
  await browser.close()
}
const rows = report.flatMap((r) => r.rows)
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1))
writeFileSync(join(OUT, 'report.tsv'), ['screen\tsize\tkind\telement A\telement B\tpx\tfile', ...rows.map((r) => [r.screen, r.size, r.kind, r.a, r.b, r.px, r.file].join('\t'))].join('\n') + '\n')
console.log(`${report.length} shots, ${rows.length} rows: ${join(OUT, 'report.tsv')}`)
