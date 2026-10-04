import cluster, { type Worker } from 'node:cluster'

/**
 * Several servers in one container (burst-capacity, `WORKERS`): the primary
 * forks `count` workers, each the whole server of `index.ts` (its own worlds,
 * Redis client and account pool) on the one shared port, and does nothing
 * else. Node hands each new TCP connection to a worker; the client is
 * websocket-only, so a connection never needs to come back to the same one
 * (no sticky sessions). `WORLD_CAP`, `MAX_PLAYERS` and `/stats`' cache are per
 * worker; `/season` and the season payer work from any (the store pays each
 * season once however many check).
 *
 * A worker that exits is forked again, after `RESTART_DELAY_MS` if it lived
 * less than `QUICK_EXIT_MS` (a crash loop must not spin a core). SIGTERM (a
 * deploy) is passed to every worker, each drains as a lone server does, and
 * the primary exits once the last has gone; nothing is re-forked meanwhile.
 * SIGINT reaches the workers from the terminal on its own.
 *
 * Each worker costs about 70 MB before any player (Node, V8, the socket.io
 * server and the pools; derived from the 2026-09-27 memory breakdown, not
 * measured per worker). `WORKERS` is never derived from the core count: in
 * a container `os.availableParallelism()` can report the host's cores, not
 * the container's CPU quota.
 */
export const QUICK_EXIT_MS = 10_000
export const RESTART_DELAY_MS = 5_000

export function runPrimary (count: number, log: (line: string) => void = console.log): void {
  let stopping = false
  const born = new Map<Worker, number>()

  const fork = (): void => {
    const worker = cluster.fork()
    born.set(worker, Date.now())
  }

  cluster.on('exit', (worker, code, signal) => {
    const lived = Date.now() - (born.get(worker) ?? Date.now())
    born.delete(worker)
    if (stopping) {
      log(`cluster: worker ${worker.process.pid} stopped (${signal ?? code}); ${Object.keys(cluster.workers ?? {}).length} left`)
      if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0)
      return
    }
    const delay = lived < QUICK_EXIT_MS ? RESTART_DELAY_MS : 0
    log(`cluster: worker ${worker.process.pid} exited (${signal ?? code}) after ${Math.round(lived / 1000)} s; forking another${delay > 0 ? ` in ${delay / 1000} s` : ''}`)
    setTimeout(fork, delay)
  })

  process.on('SIGTERM', () => {
    if (stopping) return
    stopping = true
    log(`cluster: SIGTERM, draining ${Object.keys(cluster.workers ?? {}).length} workers`)
    for (const worker of Object.values(cluster.workers ?? {})) worker?.process.kill('SIGTERM')
  })
  // Ctrl-C reaches the workers from the terminal; the primary just goes when they have.
  process.on('SIGINT', () => { stopping = true })

  log(`cluster: primary ${process.pid}, ${count} workers`)
  for (let i = 0; i < count; i++) fork()
}
