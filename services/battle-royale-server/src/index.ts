import { flushErrors, initErrorReporting, reportError } from './errors'
import { Server } from 'socket.io'
import http from 'http'
import Multiplayer from './network/multiplayer'
import Worlds from './network/worlds'
import { openAccountStore } from './db/open'
import { NotReadyError } from './db/pgstore'
import { BOARD_SIZE, type SeasonBoard, SeasonPayer } from './progress/seasons'
import cluster from 'node:cluster'
import { runPrimary } from './cluster'
import { GearLedger } from './gear/ledger'
import { gearStoreOf } from './gear/stash'
import { Admin } from './network/admin'
// The environment is the whole config: Railway and docker compose inject it.
// Locally without docker: node --env-file=.env dist/index.js

initErrorReporting()

// WORKERS > 1: a primary that forks that many servers sharing the port, one
// core each (burst-capacity, src/cluster.ts). Unset or 1: this process is the
// server, exactly as before.
const workers = parseInt(process.env.WORKERS ?? '1') || 1
if (workers > 1 && cluster.isPrimary) runPrimary(workers)
else startGame()

function startGame (): void {
  // Nothing downstream may assume this value: it is sent to the client in the
  // `hello` payload and echoed as a tick counter on every update packet.
  const tickLengthMs = parseInt(process.env.TICK_MS ?? '250')

  // One Redis client for every world: stats only.
  const redis = Multiplayer.connectRedis()

  // Guest accounts (decision #48): Postgres when DATABASE_URL is set, migrated
  // in the background (boot never waits for it), else in memory.
  const accounts = openAccountStore()

  // Weekly seasons (decision #48 step 6): every server checks for a season to
  // pay (30 s after boot, then every 5 min); the store pays each once however
  // many check. Store work, not world work, so a plain unref'd timer. A store
  // not migrated yet is not a failure; anything else is an account failure.
  const payer = new SeasonPayer(accounts, (e) => { if (!(e instanceof NotReadyError)) Worlds.accountFailure(e) })
  payer.start()

  // The gear ledger (decision #49, 49-3/49-4): one per process (per worker
  // under WORKERS), naming this boot to the stash and heartbeating every
  // minute. No start carries gear until its first heartbeat lands. Its
  // timeout is the account timeout, which bounds every other store call.
  const accountTimeoutMs = 3000
  const gearStore = gearStoreOf(accounts)
  const ledger = gearStore === undefined
    ? undefined
    : new GearLedger(gearStore, { timeoutMs: accountTimeoutMs, report: (e) => { if (!(e instanceof NotReadyError)) Worlds.accountFailure(e) } })
  ledger?.start()
  // Both shipped stores implement GearStore; without it every run plays with
  // no stash and nothing else would say so.
  if (ledger === undefined) console.warn('gear: the account store has no stash methods; runs play without a stash')

  // Several worlds in this one process (worlds-per-process, decision #39): a
  // run goes to the fullest world with fewer than WORLD_CAP active players,
  // and a world with none for WORLD_IDLE_MS closes (one always stays open).
  const worlds = new Worlds({
    tickLengthMs,
    cap: parseInt(process.env.WORLD_CAP ?? '200'),
    idleMs: parseInt(process.env.WORLD_IDLE_MS ?? '300000'),
    // Bots top each world with a human up to this many players (decision #47).
    bots: parseInt(process.env.BOT_TARGET ?? '8'),
    redis,
    accounts,
    accountTimeoutMs,
    ledger,
    // Runs this process takes before it sends `full` (burst-capacity); unset, no cap.
    maxPlayers: parseInt(process.env.MAX_PLAYERS ?? '0') || 0
  })

  // A deploy (decision #46): the host starts the new server, routes new
  // connections to it, then sends this one SIGTERM and kills it
  // `drainingSeconds` later (railway.json: 600). Draining, it takes no new
  // runs and plays out the live ones, then stops; at DRAIN_MAX_MS (default
  // 570 s, inside the host's window) it closes whatever is left, so the
  // disconnect handlers still write their stats. SIGINT (Ctrl-C) stays an
  // immediate stop.
  const drainMaxMs = parseInt(process.env.DRAIN_MAX_MS ?? '570000')
  let drainDeadline: number | undefined
  let stopping = false
  process.on('SIGTERM', () => {
    if (drainDeadline !== undefined) return
    drainDeadline = Date.now() + drainMaxMs
    worlds.drain()
    console.log(`SIGTERM: draining, ${Worlds.activeRuns(worlds)} runs live, at most ${Math.round(drainMaxMs / 1000)} s`)
  })

  function stop (reason: string): void {
    stopping = true
    console.log(`stopping: ${reason}`)
    worlds.closeAll()
    // The disconnect handlers (and their stats writes) run a moment after the
    // transports close, not inside closeAll: wait for them, then `quit`, which
    // waits for the commands already queued. Quitting at once lost every
    // write. The timer is the fallback if Redis or a handler hangs.
    setTimeout(() => process.exit(0), 5000).unref()
    const quitWhenClosed = (): void => {
      if (worlds.connectionCount > 0) {
        setTimeout(quitWhenClosed, 50)
        return
      }
      // The account pool and Sentry's queue too, inside the same 5 s. The
      // payer first, so no payout starts as the pool closes; one in flight is
      // waited for by `close`. The gear ledger before the pool (49-3 rule 3):
      // it waits for the run ends' settles (issued by the disconnects above),
      // then hands every row this boot still carries back to the stash.
      payer.stop()
      const stash = ledger === undefined ? Promise.resolve() : ledger.close()
      Promise.allSettled([redis.quit(), stash.then(async () => { await accounts.close() }), flushErrors(2000)]).finally(() => process.exit(0))
    }
    quitWhenClosed()
  }

  // Admin endpoints behind a key (decision #50, network/admin.ts). Off, and
  // every /admin path a plain 404, unless ADMIN_KEY holds 32+ characters.
  // The key itself is never logged.
  const admin = new Admin({ key: process.env.ADMIN_KEY, store: accounts })
  console.log(admin.bootLine)

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

    if (req.method === 'GET' && req.url === '/season') {
      seasonBoard().then((data) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        })
        res.end(JSON.stringify(data))
      }).catch((e) => {
        console.error('season', e)
        res.writeHead(500)
        res.end()
      })
      return
    }

    // Answers only an authorised /admin request; anything else (admin off, no
    // key, a wrong one) falls through to the same 404 as an unknown route.
    if (admin.handle(req, res)) return

    res.writeHead(404)
    res.end()
  })

  // `/season` (decision #48 step 6): the current season's top `BOARD_SIZE`
  // (rank, sanitised name, public id, banked), its ranked count and places,
  // read from the store outside every world and cached 30 s. `endsInMs` is
  // re-derived per answer, so a cached board doesn't count down wrong.
  let boardCache: { at: number, board: Promise<SeasonBoard> } | undefined
  async function seasonBoard (): Promise<SeasonBoard> {
    const now = Date.now()
    if (boardCache === undefined || now - boardCache.at >= 30_000) {
      const board = accounts.seasonBoard(now, BOARD_SIZE)
      boardCache = { at: now, board }
      // A failure isn't cached: the next request asks again.
      board.catch(() => { if (boardCache?.board === board) boardCache = undefined })
    }
    const at = boardCache.at
    const board = await boardCache.board
    return { ...board, endsInMs: Math.max(0, board.endsInMs - (now - at)) }
  }
  httpserver.listen(process.env.PORT, () => {
    console.log(`listening to ${process.env.PORT}..${cluster.isWorker ? ` (worker ${process.pid})` : ''}`)
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
        reportError('loop', e)
      }

      if (drainDeadline !== undefined && !stopping) {
        if (worlds.drained) stop('every run has ended')
        else if (Date.now() >= drainDeadline) stop(`drain deadline, ${Worlds.activeRuns(worlds)} runs cut short`)
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
