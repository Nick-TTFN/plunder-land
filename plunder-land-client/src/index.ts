import TWEEN from '@tweenjs/tween.js'
import * as io from 'socket.io-client'
import { framedParser } from './net/framedparser'
import Stats from 'stats.js'
import { PopupManager } from './ui/popups/popupmanager'
import { Game } from './game'
import { HUD } from './ui/components/hud'
import { Application, Assets, Point, Rectangle, type Renderer, SCALE_MODES, settings } from 'pixi.js'
import FontFaceObserver from 'fontfaceobserver'
import { LoaderOverlay } from './ui/components/loaderoverlay'
import { Leaderboard } from './ui/components/leaderboard'
import { SERVER_URL } from './config'
import { Aim } from './skills/aim'

import firebase from 'firebase/app'
import 'firebase/analytics'

// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: 'AIzaSyAour2Kj7Ndc1QDamwRCHQ1h1vIQBiFRF4',
  authDomain: 'plunderland.firebaseapp.com',
  projectId: 'plunderland',
  storageBucket: 'plunderland.appspot.com',
  messagingSenderId: '98543229635',
  appId: '1:98543229635:web:bd34f12c66d8b0b88c2076',
  measurementId: 'G-LYBPE5YNNW'
}

// Initialize Firebase
firebase.analytics(firebase.initializeApp(firebaseConfig))

const stats = new Stats()
/**
 * The screen's device pixels per CSS pixel, capped at 2: a 3x phone would
 * otherwise fill 9x the pixels of a 1x screen for little visible gain.
 */
function density (): number {
  return Math.min(2, Math.max(1, window.devicePixelRatio || 1))
}

// Render at the screen's density. With pixi's default resolution of 1 a Retina
// screen got a half-resolution canvas stretched 2x by the browser, and every
// sprite, line and label looked soft. `autoDensity` keeps the canvas's CSS size
// at the window's, so layout, pointer coordinates and `renderer.screen` all
// stay in CSS pixels; only the backing store grows. Text follows the
// renderer's resolution on its own.
const app = new Application({ resolution: density(), autoDensity: true })
const socketPanel = stats.addPanel(new Stats.Panel('b/s', '#ff8', '#221'))

settings.ROUND_PIXELS = true

const font = new FontFaceObserver('Lilliput Steps')

/** True for the one press that should extend the route rather than replace it. */
let _appendNext = false

// JetBrains Mono is the HUD's face (THEME.font). pixi draws text into a
// canvas once, so a face that arrives after the first Text is never used by
// it; wait for it too, but start without it if it fails (a system monospace
// is in THEME.font's stack behind it). Lilliput is still required, as before.
const hudFont = new FontFaceObserver('JetBrains Mono').load().catch(() => {
  console.warn('JetBrains Mono did not load; the HUD uses a system monospace')
})

void Promise.all([font.load(), hudFont]).then(function () {
  start()
})

function start (): void {
  Game.socketBytes = 0
  stats.showPanel(3) // 0: fps, 1: ms, 2: mb, 3+: custom
  // A developer overlay: only with ?stats=1. It sat on top of the HUD's
  // status panel for every player (hud-rebuild, M2). It still measures either way.
  if (new URLSearchParams(window.location.search).get('stats') === '1') document.body.appendChild(stats.dom)

  document.body.appendChild(app.view as any)

  if (app.view.style !== undefined) {
    app.view.style.width = '100%'
    app.view.style.height = '100%'
  }

  Game.RENDERER = app.renderer as Renderer
  // app.renderer.backgroundColor = 0

  // Five sheets: the original character atlas, the hex props, the ground
  // pads, and the arena's props, effects and icons with its blasts. Kept apart
  // because all but the first are generated (`tools/bake-hex-atlas.py`,
  // `bake-ground-atlas.py`, `bake-arena-atlas.py`) and the first comes out of
  // TexturePacker. The generated painted sheets keep the default linear
  // filtering: they are art at 2x, not pixel art, and a 1x screen draws them
  // at half size.
  void Assets.load(['./res/atlas.json', './res/hex.json', './res/ground.json', './res/arena.json', './res/blasts.json']).then((sheets) => {
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
  Game.socket = io.connect(SERVER_URL, { transports: ['websocket'], parser: framedParser, query: { frames: '1' } })

  Game.socket.on('connect', () => {
    onConnect()
  })
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

    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 's') Game.simulate = !Game.simulate
      },
      false
    )

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

  Game.simulate = true

  onResize()
}

function onPointerDown (event: { shiftKey?: boolean, target?: unknown, data: { buttons: number, global: { x: number, y: number } } }): void {
  // Only a press that landed on the world is a move order. pixi dispatches to
  // whatever is under the pointer and then bubbles up to the stage, so a press
  // on a skill button arrived here too and walked the player in under the HUD -
  // one tap, two unrelated things. The stage is the target only when nothing
  // interactive was hit, which is exactly the world.
  if (event.target !== undefined && event.target !== app.stage) return

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
  stats.begin()
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
  stats.end()

  if (now > _socketDump + 1000) {
    maxSocketBytes = Math.max(Game.socketBytes, maxSocketBytes)
    socketPanel.update(Game.socketBytes, maxSocketBytes)
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
