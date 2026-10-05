// First, so errors from everything after it are reported (src/errors.ts).
import { initErrorReporting } from './errors'
import TWEEN from '@tweenjs/tween.js'
import * as io from 'socket.io-client'
import { framedParser } from './net/framedparser'
import type Stats from 'stats.js'
import { PopupManager } from './ui/popups/popupmanager'
import { Game } from './game'
import { HUD } from './ui/components/hud'
import { Application, Assets, Point, Rectangle, type Renderer, SCALE_MODES, settings } from 'pixi.js'
import { LoaderOverlay } from './ui/components/loaderoverlay'
import { Leaderboard } from './ui/components/leaderboard'
import { SERVER_URL } from './config'
import { Aim } from './skills/aim'
import { TouchAim } from './skills/touchaim'
import { SkillCard } from './ui/components/skillpanel'
import { decideWelcome, KEY, readPending } from './net/protocol'
import { ACCOUNT, applyProgress, applySaved, handshakeAuth, localTokenStorage, onAccount, onProgress, setAccountInfo } from './net/account'
import { onSeason, setSeason } from './net/season'
import { onEnergy, setEnergy } from './net/energy'
import { onStash, setStash } from './net/stash'
import { parseSaved, slotsFor } from './net/loadout'
import { SETTINGS, densityFor, loadSettings } from './net/settings'
import { Session } from './net/session'

initErrorReporting()
// Before anything reads them: the renderer's density, the HUD's keys.
loadSettings(localTokenStorage())

// The stats.js developer overlay (fps, socket bytes), with ?stats=1 or the
// settings' PERFORMANCE OVERLAY. It sat on top of the HUD's status panel for
// every player (hud-rebuild, M2), so it is loaded on demand and is not in the
// main bundle.
let stats: Stats | undefined
let socketPanel: Stats.Panel | undefined
let statsLoading = false
const statsByQuery = new URLSearchParams(window.location.search).get('stats') === '1'
function showStats (show: boolean): void {
  if (stats !== undefined) {
    stats.dom.style.display = show ? '' : 'none'
    return
  }
  if (!show || statsLoading) return
  statsLoading = true
  void import('stats.js').then(({ default: StatsJs }) => {
    stats = new StatsJs()
    socketPanel = stats.addPanel(new StatsJs.Panel('b/s', '#ff8', '#221'))
    stats.showPanel(3) // 0: fps, 1: ms, 2: mb, 3+: custom
    document.body.appendChild(stats.dom)
    stats.dom.style.display = statsByQuery || SETTINGS.value.perfOverlay ? '' : 'none'
  })
}
showStats(statsByQuery || SETTINGS.value.perfOverlay)

/**
 * The render density: the screen's device pixels per CSS pixel, capped at 2
 * (a 3x phone would otherwise fill 9x the pixels of a 1x screen for little
 * visible gain), or 1x or 2x as the settings say.
 */
function density (): number {
  return densityFor(SETTINGS.value.density, window.devicePixelRatio)
}

// A change in settings is in force at once: density, the overlay, the HUD's skill keys.
SETTINGS.listeners.add(() => {
  onResize()
  showStats(statsByQuery || SETTINGS.value.perfOverlay)
  if (Session.skills !== undefined) Game.hud?.rekey(slotsFor(Session.skills, SETTINGS.value.skillKeys).keys)
})

// Render at the screen's density. With pixi's default resolution of 1 a Retina
// screen got a half-resolution canvas stretched 2x by the browser, and every
// sprite, line and label looked soft. `autoDensity` keeps the canvas's CSS size
// at the window's, so layout, pointer coordinates and `renderer.screen` all
// stay in CSS pixels; only the backing store grows. Text follows the
// renderer's resolution on its own.
const app = new Application({ resolution: density(), autoDensity: true })

settings.ROUND_PIXELS = true

/** True for the one press that should extend the route rather than replace it. */
let _appendNext = false

// pixi draws text into a canvas once, so a face that arrives after the first
// Text is never used by it: wait for both faces (declared in index.html), but
// start without one that fails. JetBrains Mono is the HUD's (THEME.font, a
// system monospace behind it); Lilliput Steps the older labels'. Until
// 2026-10-02 a failed Lilliput (fontfaceobserver's 3 s timeout) never started
// the game at all.
function loadFont (family: string): Promise<unknown> {
  return document.fonts.load(`16px "${family}"`).catch(() => {
    console.warn(`${family} did not load; text falls back to the next face`)
  })
}

void Promise.all([loadFont('Lilliput Steps'), loadFont('JetBrains Mono')]).then(function () {
  start()
})

function start (): void {
  Game.socketBytes = 0

  document.body.appendChild(app.view as any)

  if (app.view.style !== undefined) {
    app.view.style.width = '100%'
    app.view.style.height = '100%'
  }

  Game.RENDERER = app.renderer as Renderer
  // app.renderer.backgroundColor = 0

  // Fifteen sheets: the original character atlas, the hex props, the ground
  // pads, the arena's props, effects and icons with its blasts, and the five
  // robots' rig parts, each also at the lobby's 2.75x. Kept
  // apart because all but the first are generated
  // (`tools/bake-hex-atlas.py`, `bake-ground-atlas.py`, `bake-arena-atlas.py`,
  // `bake-peep-atlas.py`) and the first comes out of
  // TexturePacker. The generated painted sheets keep the default linear
  // filtering: they are art at 2x, not pixel art, and a 1x screen draws them
  // at half size.
  void Assets.load(['./res/atlas.json', './res/hex.json', './res/ground.json', './res/arena.json', './res/blasts.json', './res/peep.json', './res/magnet.json', './res/periscope.json', './res/hopper.json', './res/waddle.json', './res/peep-lobby.json', './res/magnet-lobby.json', './res/periscope-lobby.json', './res/hopper-lobby.json', './res/waddle-lobby.json']).then((sheets) => {
    // Props are baked to their exact on-screen size, so at the default cell size
    // they draw one texel to one pixel and this changes nothing. It is here for
    // the case where they do not: a scaled-up pixel-art prop should get bigger
    // pixels rather than a blur.
    sheets['./res/hex.json'].baseTexture.scaleMode = SCALE_MODES.NEAREST
    setup()
  })
}

function setup (): void {
  // websocket only: the default starts on HTTP long-polling and merely tries to
  // upgrade, which adds latency to every early message of a run.
  // `frames=1` asks for one binary message per tick; see net/framedparser.ts.
  // `auth` is a function so socket.io reads the stored token again on every
  // reconnect: a token issued during the first run is used from the next
  // connection on (guest accounts, decision #48; net/account.ts).
  Game.socket = io.connect(SERVER_URL, { transports: ['websocket'], parser: framedParser, query: { frames: '1' }, auth: handshakeAuth(localTokenStorage) })

  Game.socket.on('connect', () => {
    // A new connection announces its own account: the last one's is stale
    // (its standing too) until it does. Nothing arrives before `connect`.
    setAccountInfo(undefined)
    setSeason(undefined, Date.now())
    setEnergy(undefined, Date.now())
    setStash(undefined)
    onConnect()
  })
  Game.socket.on('welcome', onWelcome)
  // Here, not per run: it can arrive on connect, before any start.
  Game.socket.on('account', (data: unknown) => {
    const info = onAccount(data, localTokenStorage())
    if (info !== undefined) setAccountInfo(info)
    // Plays left (decision #48 step 7): only on connect and creation; the
    // grant's mid-run `account` carries none, and `energy` follows each change.
    const energy = onEnergy((data as { energy?: unknown } | null)?.energy)
    if (energy !== undefined) setEnergy(energy, Date.now())
  })
  // After each spend (the run began) and each refund (an extraction, a run
  // the server cut short), a database round trip later.
  Game.socket.on('energy', (data: unknown) => {
    const energy = onEnergy(data)
    if (energy !== undefined) setEnergy(energy, Date.now())
  })
  // Every loadout save's answer, here rather than in the lobby's panel: one
  // that lands after READY's wait gave up (the panel is gone by then) must
  // still reach the account info, or the next lobby shows the old loadout
  // while the server plays the new one (48-4 review N1).
  Game.socket.on('loadout_saved', (data: unknown) => {
    const answer = parseSaved(data)
    if (answer !== undefined) applySaved(answer)
  })
  // A run's XP (decision #48 step 3), a database round trip after its end.
  // The server never sends one after the next run's `hello`, so it is always
  // the run `Game.RUN` holds (before or after its card opened).
  Game.socket.on('progress', (data: unknown) => {
    const progress = onProgress(data)
    if (progress === undefined) return
    // Before the standing moves: the run card names what the level-up opened.
    const levelBefore = ACCOUNT.info?.standing?.level
    applyProgress(progress)
    Game.RUN.setProgress(progress, levelBefore)
  })
  // This account's season (decision #48 step 6, net/season.ts): after
  // `account`, and after each run's `progress`. A malformed one is ignored.
  Game.socket.on('season', (data: unknown) => {
    const view = onSeason(data)
    if (view !== undefined) setSeason(view, Date.now())
  })
  // The stash (decision #49, net/stash.ts): after `account` for a persisted
  // account, after a start that carried gear, and after an extraction's
  // settle, that one with `run` (what was kept), for the run card. It can
  // land before or after the own destroy; `Game.RUN` keeps it either way. The
  // server sends none after a death, offline or when the settle failed.
  Game.socket.on('stash', (data: unknown) => {
    const view = onStash(data)
    if (view === undefined) return
    setStash(view)
    if (view.run !== undefined) Game.RUN.setStashRun(view.run)
  })
}

/**
 * The server's protocol number, first thing on every connection (net/protocol.ts).
 * A page from another release reloads, but never in the middle of a run.
 */
function onWelcome (data: unknown): void {
  let raw: string | null
  try {
    raw = window.sessionStorage.getItem(KEY)
  } catch {
    // Without storage a reload can't be counted, so it could loop: play on.
    console.warn('protocol check skipped: no sessionStorage')
    return
  }
  const welcome = decideWelcome(data, readPending(raw))
  try {
    if (welcome.action === 'match') {
      window.sessionStorage.removeItem(KEY)
    } else if (welcome.action === 'reload') {
      window.sessionStorage.setItem(KEY, JSON.stringify(welcome.next))
      console.warn(`server protocol ${welcome.next.protocol}, this client's differs: reloading`)
      const reload = (): void => {
        if (Game.PLAYER !== undefined) setTimeout(reload, 5000)
        else window.location.reload()
      }
      setTimeout(reload, welcome.delayMs)
    } else {
      console.warn(`server protocol ${welcome.protocol}: still not this client's after reloading; playing on`)
    }
  } catch {
    console.warn('protocol check skipped: sessionStorage refused a write')
  }
}

// socket.io fires `connect` again after every reconnect. Everything that
// registers a listener, starts a render loop or spins up a poller has to run
// exactly once for the life of the page - a second requestAnimationFrame loop
// made the whole game run at double speed.
let _initialised = false

function onConnect (): void {
  app.stage.eventMode = 'static'

  if (!_initialised) {
    _initialised = true

    Game.Instance = new Game()
    app.stage.addChild(Game.Instance)

    Game.hud = new HUD()
    app.stage.addChild(Game.hud)

    app.stage.addChild(new Leaderboard())

    Game.loader = new LoaderOverlay()
    app.stage.addChild(Game.loader)

    // No routing on 'pointermove', on purpose. Re-routing while the pointer is
    // held meant a full search per mouse-move event, which with the temporary
    // map-wide window can sweep 130,000 cells - and click-to-move does not need
    // it. A click is a route.
    app.stage.on('pointerdown', onPointerDown)
    app.stage.on('pointerup', onPointerUp)
    // The move handler only records where the mouse is, for aiming skills
    // (decision #21). It must never route.
    app.stage.on('pointermove', onPointerMove)
    app.stage.on('pointerleave', () => { Aim.clear() })

    window.addEventListener('resize', onResize)

    window.requestAnimationFrame(frame)
  }

  // per-connection state: the popup stack is rebuilt so a reconnect drops the
  // player back on the enter screen.
  if (Game.popups !== undefined) {
    Game.popups.removeChildren()
    app.stage.removeChild(Game.popups)
  }
  Game.popups = new PopupManager()
  app.stage.addChild(Game.popups)

  Game.Instance.start()

  onResize()
}

function onPointerDown (event: { shiftKey?: boolean, target?: unknown, data: { buttons: number, global: { x: number, y: number } } }): void {
  // Only a press that landed on the world is a move order. pixi dispatches to
  // whatever is under the pointer and then bubbles up to the stage, so a press
  // on a skill button arrived here too and walked the player in under the HUD -
  // one tap, two unrelated things. The stage is the target only when nothing
  // interactive was hit, which is exactly the world.
  if (event.target !== undefined && event.target !== app.stage) return

  // A skill armed on touch (`TouchAim`) takes this tap as its target, not a move.
  const armed = TouchAim.take(performance.now())
  if (armed instanceof SkillCard && Game.CONTAINER !== undefined) {
    armed.invoke({ cell: Aim.cellAt(Game.CONTAINER.toLocal(new Point(event.data.global.x, event.data.global.y))) })
    return
  }

  // Shift-click appends a leg instead of replacing the route, so a way round
  // something can be built up click by click. Only on the press: dragging with
  // shift held would append a leg every frame. pixi normalises the modifier keys
  // onto the event itself, so there is no need to reach into originalEvent.
  _appendNext = event.shiftKey ?? false

  updatePointer(event)
  _appendNext = false
}

function updatePointer (event: { data: { buttons: number, global: { x: number, y: number } } }): void {
  if (Game.PLAYER === undefined) return

  // Click-to-move. The click names a cell and the client routes to it with the
  // same bounded search the server will run, so both derive the same path.
  // toLocal rather than arithmetic against the player's global position: the
  // container carries the camera and any scale with it.
  const world = Game.CONTAINER.toLocal(
    new Point(event.data.global.x, event.data.global.y)
  )

  // Record the intent only. Sending happens on a fixed cadence in frame().
  if (_appendNext) Game.LOCAL.appendDestination(world.x, world.y)
  else Game.LOCAL.setDestination(world.x, world.y)
}

function onPointerMove (event: { target?: unknown, pointerType?: string, global: { x: number, y: number } }): void {
  // Over the world only when nothing interactive is under the pointer - the
  // same test onPointerDown uses. On the HUD, a skill press sends no aim.
  Aim.track(event.global.x, event.global.y, event.pointerType, event.target === app.stage)
}

function onPointerUp (): void {
  // Nothing to do. Releasing does not stop you - a destination is a commitment
  // rather than a key being held down, which is the whole difference between
  // click-to-move and the joystick it replaced. Kept as a handler so the stage
  // still consumes the event.
}

let _prevTime = 0
let _socketDump = 0

let maxSocketBytes = 1

function frame (): void {
  stats?.begin()
  const now = Date.now()

  // One input per server tick, four bytes, instead of one JSON object per
  // pointermove against a reader that samples once a tick.
  if (Game.PLAYER !== undefined) {
    const input = Game.LOCAL.sample(performance.now())
    if (input !== null) Game.socket.emit('pointer', input)
  }

  if (_prevTime !== 0) {
    const dt = now - _prevTime
    Game.Instance.update(dt / 1000)
    Game.hud.update(dt / 1000)
  }
  _prevTime = now
  TWEEN.update()
  stats?.end()

  if (now > _socketDump + 1000) {
    maxSocketBytes = Math.max(Game.socketBytes, maxSocketBytes)
    socketPanel?.update(Game.socketBytes, maxSocketBytes)
    Game.socketBytes = 0
    _socketDump = now
  }

  requestAnimationFrame(frame)
}

function onResize (): void {
  // Moving the window to a screen of another density fires a resize too.
  if (app.renderer.resolution !== density()) app.renderer.resolution = density()
  app.renderer.resize(window.innerWidth, window.innerHeight)
  Game.loader.resize(window.innerWidth, window.innerHeight)

  // The stage has to be its own hit target, or a click on bare ground reaches
  // nothing and no route is built.
  //
  // pixi dispatches to the innermost thing under the pointer and bubbles up
  // from there; with no hit at all there is no event and the stage's own
  // listener never runs. That used to be invisible because the ground was one
  // TilingSprite stretched over the whole map, so every click in the world
  // landed on *something*. Drawing the ground as hex pads with `eventMode:
  // 'none'` took that away, and click-to-move started working only where a
  // mob, a rock or a pickup happened to be under the pointer.
  app.stage.hitArea = new Rectangle(0, 0, window.innerWidth, window.innerHeight)

  Game.popups.position = new Point(window.innerWidth / 2, window.innerHeight / 2)
  // Whole pixels: the camera is snapped to device pixels under it (Game.update).
  Game.Instance.position = new Point(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2))
}
