/**
 * The server is full (burst-capacity): pixi-free, so the server's specs run it
 * (`network/full.spec.ts` there).
 *
 * A start on a process at its `MAX_PLAYERS` is sent `full { retryMs }` and its
 * transport is closed; socket.io reconnects on its own (perhaps to another
 * worker or replica) and the page lands back in the lobby. The lobby then
 * shows "SERVER FULL · RETRYING IN Ns" and presses READY by itself when the
 * wait is over. Each refusal in a row waits longer (`retryDelay`: doubling
 * from 1 s, at most 15 s, never under the server's `retryMs`, plus or minus
 * 30% so a crowd refused together doesn't come back together). A run that
 * starts (`hello`) or a READY the player cancels clears it.
 */
export const RETRY = Object.freeze({ baseMs: 1000, capMs: 15_000, jitter: 0.3 })

/** The wait before retry number `attempt` (0 for the first), at least `serverMs`. `rand` in [0, 1). */
export function retryDelay (attempt: number, serverMs: number, rand: number): number {
  const backoff = Math.min(RETRY.capMs, RETRY.baseMs * Math.pow(2, Math.max(0, attempt)))
  const wait = Math.max(serverMs, backoff)
  return Math.round(wait * (1 - RETRY.jitter + 2 * RETRY.jitter * rand))
}

/** Refusals in a row, and when the next try is due (undefined: none pending). */
export const FULL: { attempt: number, retryAt: number | undefined } = { attempt: 0, retryAt: undefined }

/** A `full` event: the next try is due after `retryDelay`. */
export function onFull (data: unknown, now: number, rand: number = Math.random()): void {
  const raw = data !== null && typeof data === 'object' ? (data as { retryMs?: unknown }).retryMs : undefined
  const serverMs = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 60_000) : 0
  FULL.retryAt = now + retryDelay(FULL.attempt, serverMs, rand)
  FULL.attempt++
}

/** A run started, or the player gave up waiting: nothing pending, and the next refusal starts from 1 s. */
export function clearFull (): void {
  FULL.attempt = 0
  FULL.retryAt = undefined
}

/** The lobby's banner, or undefined with nothing pending. */
export function fullLine (now: number): string | undefined {
  if (FULL.retryAt === undefined) return undefined
  const s = Math.max(0, Math.ceil((FULL.retryAt - now) / 1000))
  return s > 0 ? `SERVER FULL · RETRYING IN ${s}S` : 'SERVER FULL · RETRYING…'
}

/** Whether the lobby should press READY now. */
export function retryDue (now: number): boolean {
  return FULL.retryAt !== undefined && now >= FULL.retryAt
}
