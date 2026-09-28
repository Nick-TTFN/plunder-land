import { Server } from 'socket.io'
import http from 'http'
import dotenv from 'dotenv'
import Multiplayer from './network/multiplayer'
import Worlds from './network/worlds'
dotenv.config()

startGame()

function startGame (): void {
  // Nothing downstream may assume this value: it is sent to the client in the
  // `hello` payload and echoed as a tick counter on every update packet.
  const tickLengthMs = parseInt(process.env.TICK_MS ?? '250')

  // Several worlds in this one process (worlds-per-process, decision #39): a
  // run goes to the fullest world with fewer than WORLD_CAP active players,
  // and a world with none for WORLD_IDLE_MS closes (one always stays open).
  const worlds = new Worlds({
    tickLengthMs,
    cap: parseInt(process.env.WORLD_CAP ?? '200'),
    idleMs: parseInt(process.env.WORLD_IDLE_MS ?? '300000'),
    // One Redis client for every world: stats only.
    redis: Multiplayer.connectRedis()
  })

  const httpserver = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthcheck') {
      res.writeHead(200)
      res.end()
      return
    }

    if (req.method === 'GET' && req.url === '/stats') {
      worlds.getLeaderboard().then((data) => {
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
  // 12) and memLevel 4. Measured 2026-09-27 that is about 140 KB of zlib
  // state per connection once it has written (24 KB before its first write),
  // against 256 KB+ (and 44%) at zlib's defaults. engine.io's own threshold is
  // 1024 bytes, above nearly every message this server sends (325 B on
  // average). ws warns that zlib under concurrency can fragment memory on
  // Linux, so WS_DEFLATE=0 turns it off without a build.
  const deflate = process.env.WS_DEFLATE === '0'
    ? false
    : { threshold: 32, serverMaxWindowBits: 12, zlibDeflateOptions: { memLevel: 4 } }
  const server = new Server(httpserver, { cors: { origin: '*' }, perMessageDeflate: deflate })

  server.on('connection', function (socket) {
    worlds.onConnection(socket)
  })

  // timestamp of each loop
  let previousTick = Date.now()

  function gameLoop (): void {
    const now = Date.now()

    if (previousTick + tickLengthMs <= now) {
      const dtMs = now - previousTick
      previousTick = now

      // The worlds are held entirely in memory with no persistence, so an
      // uncaught throw in a single tick would take every player's run down with
      // the process. Each world's tick has its own catch (`Worlds.tickAll`);
      // this one is for the loop's own bookkeeping.
      try {
        worlds.tickAll(dtMs)
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
