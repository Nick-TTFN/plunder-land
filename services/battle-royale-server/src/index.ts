import { Server } from 'socket.io'
import http from 'http'
import dotenv from 'dotenv'
import Multiplayer from './network/multiplayer'
import World from './objects/world'
dotenv.config()

startGame()

function startGame (): void {
  // Nothing downstream may assume this value: it is sent to the client in the
  // `hello` payload and echoed as a tick counter on every update packet.
  const tickLengthMs = parseInt(process.env.TICK_MS ?? '250')

  const multiplayer = new Multiplayer(tickLengthMs)

  const httpserver = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthcheck') {
      res.writeHead(200)
      res.end()
      return
    }

    if (req.method === 'GET' && req.url === '/stats') {
      multiplayer.getLeaderboard().then((data) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        })
        res.end(JSON.stringify(data))
      }).catch((e) => {
        console.error('stats', e)
        res.writeHead(500)
        res.end()
      })
      return
    }

    res.writeHead(404)
    res.end()
  })
  httpserver.listen(process.env.PORT, () => {
    console.log(`listening to ${process.env.PORT}..`)
  })

  // WebSocket compression (permessage-deflate; bandwidth review, 2026-09-27).
  // Off by default in ws and engine.io. The recorded traffic of one client
  // compressed to 48% at these settings: a 4 KB window (serverMaxWindowBits
  // 12) and memLevel 4 keep the zlib state near 24 KB a connection, against
  // 256 KB (and 44%) at zlib's defaults. engine.io's own threshold is 1024
  // bytes, above nearly every message this server sends (325 B on average).
  // ws warns that zlib under concurrency can fragment memory on Linux, so
  // WS_DEFLATE=0 turns it off without a build.
  const deflate = process.env.WS_DEFLATE === '0'
    ? false
    : { threshold: 32, serverMaxWindowBits: 12, zlibDeflateOptions: { memLevel: 4 } }
  const server = new Server(httpserver, { cors: { origin: '*' }, perMessageDeflate: deflate })

  server.on('connection', function (socket) {
    multiplayer.onConnect(socket)

    socket.on('disconnect', function () {
      multiplayer.onDisconnect(socket)
    })
  })

  const world = new World(4000)

  // timestamp of each loop
  let previousTick = Date.now()
  let tick = 0

  function gameLoop (): void {
    const now = Date.now()

    if (previousTick + tickLengthMs <= now) {
      const dt = (now - previousTick) / 1000
      previousTick = now

      // The world is held entirely in memory with no persistence, so an uncaught
      // throw in a single tick would take every player's run down with the process.
      // Log and keep ticking instead.
      try {
        tick++
        world.update(dt)
        multiplayer.flushAll(tick, dt * 1000)
      } catch (e) {
        console.error('tick', e)
      }
    }

    const dt = Date.now() - previousTick

    if (dt < tickLengthMs) {
      setTimeout(gameLoop, tickLengthMs - dt)
    } else {
      setImmediate(gameLoop)
    }
  }

  gameLoop()
}
