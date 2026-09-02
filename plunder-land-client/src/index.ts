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

function onPointerDown (event: { data: { buttons: number, global: { x: number, y: number } } }): void {
  _pointerDown = true
  updatePointer(event)
}

function updatePointer (event: { data: { buttons: number, global: { x: number, y: number } } }): void {
  if (Game.PLAYER === undefined) return

  if (!_pointerDown) return

  if ((Game.hud.joystick?.pointerDown) ?? false) return

  const globalpos = Game.PLAYER.toGlobal(new Point(0, 0))

  Game.socket.emit('pointer', {
    x: event.data.global.x - globalpos.x,
    y: event.data.global.y - globalpos.y
  })
}

function onPointerUp (): void {
  _pointerDown = false
  Game.socket.emit('pointer', { x: 0, y: 0 })
}

let _prevTime = 0
let _socketDump = 0

let maxSocketBytes = 1

function frame (): void {
  stats.begin()
  const now = Date.now()
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
