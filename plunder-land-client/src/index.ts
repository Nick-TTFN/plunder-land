import TWEEN from '@tweenjs/tween.js'
import * as io from 'socket.io-client'
import Stats from 'stats.js'
import { PopupManager } from './ui/popups/popupmanager'
import { Game } from './game'
import { HUD } from './ui/components/hud'
import { Application, Assets, Point, type Renderer, settings } from 'pixi.js'
import FontFaceObserver from 'fontfaceobserver'
import { LoaderOverlay } from './ui/components/loaderoverlay'
import { Leaderboard } from './ui/components/leaderboard'
import { SERVER_URL } from './config'

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
const app = new Application()
const socketPanel = stats.addPanel(new Stats.Panel('b/s', '#ff8', '#221'))

settings.ROUND_PIXELS = true

const font = new FontFaceObserver('Lilliput Steps')

let _pointerDown = false
/** True for the one press that should extend the route rather than replace it. */
let _appendNext = false

void font.load().then(function () {
  start()
})

function start (): void {
  Game.socketBytes = 0
  stats.showPanel(3) // 0: fps, 1: ms, 2: mb, 3+: custom
  document.body.appendChild(stats.dom)

  document.body.appendChild(app.view as any)

  if (app.view.style !== undefined) {
    app.view.style.width = '100%'
    app.view.style.height = '100%'
  }

  Game.RENDERER = app.renderer as Renderer
  // app.renderer.backgroundColor = 0

  void Assets.load('./res/atlas.json').then(setup)
}

function setup (): void {
  // websocket only: the default starts on HTTP long-polling and merely tries to
  // upgrade, which adds latency to every early message of a run.
  Game.socket = io.connect(SERVER_URL, { transports: ['websocket'] })

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

    app.stage.on('pointermove', updatePointer)
    app.stage.on('pointerdown', onPointerDown)
    app.stage.on('pointerup', onPointerUp)

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

function onPointerDown (event: { shiftKey?: boolean, data: { buttons: number, global: { x: number, y: number } } }): void {
  _pointerDown = true

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

  if (!_pointerDown) return

  if ((Game.hud.joystick?.pointerDown) ?? false) return

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

function onPointerUp (): void {
  // Releasing no longer stops you. A destination is a commitment rather than a
  // key being held down, which is the whole difference between click-to-move
  // and the joystick it replaces.
  _pointerDown = false
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
  app.renderer.resize(window.innerWidth, window.innerHeight)
  Game.loader.resize(window.innerWidth, window.innerHeight)

  Game.popups.position = new Point(window.innerWidth / 2, window.innerHeight / 2)
  Game.Instance.position = new Point(window.innerWidth / 2, window.innerHeight / 2)
}
