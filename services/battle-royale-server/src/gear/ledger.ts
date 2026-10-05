import { randomUUID } from 'node:crypto'
import { type Bring, rowIdsOf, STALE_CARRY_MS } from '../db/accounts'

/**
 * What the ledger needs of the store (`GearStore`, db/accounts.ts): its
 * heartbeat and its clean exit. The run's writes (spend with `bring`,
 * `settleGear`, `discardGear`, `uncarry`) are issued by the caller through
 * `carry` and `resolve`, which track them.
 */
export interface LedgerStore {
  heartbeat: (holder: string, held: readonly string[]) => Promise<number>
  releaseHolder: (holder: string) => Promise<number>
}

export interface GearLedgerOptions {
  /** Every failure the ledger swallows (a heartbeat, the release): Sentry in the server. */
  report?: (e: unknown) => void
  /** The ledger's clock, for `canCarry`'s freshness test. */
  now?: () => number
  /** How long a gear write may take before the ledger gives it up: `Worlds`' `accountTimeoutMs`, 3 s. */
  timeoutMs?: number
  /** The boot id; a fresh random UUID unless a spec names one. */
  holder?: string
}

/**
 * Which gear write timed out (decision #50, after the unattributed timeout of
 * 2026-10-05): the heartbeat, a run's carry (the spend with `bring`), the
 * three writes `resolve` issues, named by their store call, and `close`'s
 * `releaseHolder`.
 */
export type GearOp = 'beat' | 'carry' | 'resolve:settle' | 'resolve:discard' | 'resolve:uncarry' | 'close:release'

/** The store call behind a `resolve`. */
export type ResolveCall = 'settle' | 'discard' | 'uncarry'

/**
 * A gear write the ledger gave up on after `timeoutMs`. It may still land.
 * `op` names the write, in the message (so the throttled log line says it)
 * and in `reportTags` (so the Sentry event carries it as the `gear_op` tag,
 * `errors.ts` `tagsFor`).
 */
export class GearTimeoutError extends Error {
  readonly op: GearOp

  constructor (op: GearOp) {
    super(`gear: store write timed out (${op})`)
    this.name = 'GearTimeoutError'
    this.op = op
  }

  get reportTags (): Record<string, string> {
    return { gear_op: this.op }
  }
}

/**
 * The per-process gear ledger (decision #49, task 49-3): one per process
 * (per worker under `WORKERS`). It names this boot (`holder`, a random UUID)
 * to the store, keeps the row ids this process's worlds may hold in-world
 * copies of (`held`), and heartbeats so the store knows the holder is alive
 * and can return what nobody holds.
 *
 * Store work, not world work: a plain unref'd timer like `SeasonPayer`,
 * never `Timers`, and nothing here touches a `World`.
 *
 * The rules it enforces (49-3):
 * 1. A row id enters `held` **before** the carry statement is issued
 *    (`carry`), and leaves only when the write that resolves it (settle,
 *    discard, uncarry: `resolve`) has settled or timed out. A carry that
 *    fails, times out, or comes back without an id lets that id go at once.
 *    Counted, not a set: two starts in this process asking for one row must
 *    not let the one that didn't get it release the one that did.
 * 2. `heartbeat` sends a snapshot of `held` taken when it is issued; the
 *    store's 2-minute guard (`RECONCILE_AFTER_MS`) covers a carry issued
 *    after the snapshot. A carry still unanswered after `timeoutMs` was given
 *    up and its run plays without gear, so returning it later is correct.
 * 3. `close` on a drain: wait for the gear writes in flight, then
 *    `releaseHolder`, then stop the timer. SIGINT skips it; the store's stale
 *    return (`STALE_CARRY_MS` after the last heartbeat) covers a crash.
 *
 * **No carry before the first heartbeat lands** (`canCarry`): a holder
 * missing from `gear_holders` reads as dead, and another connection's
 * `loadStash` would return its rows at once. Stricter than the task, on
 * purpose: a carry also needs a heartbeat landed within `FRESH_MS` (5 min,
 * a third of `STALE_CARRY_MS`), so a process whose heartbeats have been
 * failing for a while stops carrying before others could think it dead.
 */
export class GearLedger {
  /** How often the heartbeat runs (60 s). */
  static HEARTBEAT_MS = 60_000
  /** A carry needs a heartbeat that landed within this long (issued-at time, the conservative end). */
  static FRESH_MS = STALE_CARRY_MS / 3

  readonly holder: string
  /** Row id -> how many open claims (carries asked or landed, not yet resolved). */
  private readonly held = new Map<string, number>()
  /** When the last heartbeat that succeeded was issued; undefined until one has. */
  private lastBeat: number | undefined
  private timer: NodeJS.Timeout | undefined
  private beating: Promise<void> | undefined
  /** Gear writes in flight (the raw store promises, not the timeouts): `close` waits for them. */
  private readonly writes = new Set<Promise<unknown>>()
  private closing = false
  private releasing = false
  private readonly store: LedgerStore
  private readonly report: (e: unknown) => void
  private readonly now: () => number
  private readonly timeoutMs: number

  constructor (store: LedgerStore, options: GearLedgerOptions = {}) {
    this.store = store
    this.report = options.report ?? (() => {})
    this.now = options.now ?? (() => Date.now())
    this.timeoutMs = options.timeoutMs ?? 3000
    this.holder = options.holder ?? randomUUID()
  }

  /** The first heartbeat now, then one every `HEARTBEAT_MS`. */
  start (): void {
    this.stop()
    void this.beat()
    this.timer = setInterval(() => { void this.beat() }, GearLedger.HEARTBEAT_MS)
    this.timer.unref()
  }

  stop (): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Whether a start may bring gear now: a recent heartbeat has landed and the ledger isn't closing. */
  get canCarry (): boolean {
    return !this.closing && this.lastBeat !== undefined && this.now() - this.lastBeat < GearLedger.FRESH_MS
  }

  /** Whether `rowId` has an open claim. */
  holds (rowId: string): boolean {
    return (this.held.get(rowId) ?? 0) > 0
  }

  /** The row ids with open claims, for the heartbeat and for specs. */
  heldIds (): string[] {
    return [...this.held.keys()]
  }

  /**
   * One heartbeat, with `held` as it is now (rule 2). Never rejects; one in
   * flight is shared, not doubled. None after `close` has begun releasing.
   */
  async beat (): Promise<void> {
    if (this.beating !== undefined) return await this.beating
    if (this.releasing) return
    const issuedAt = this.now()
    const snapshot = this.heldIds()
    this.beating = (async () => {
      try {
        await this.within(this.store.heartbeat(this.holder, snapshot), 'beat')
        this.lastBeat = issuedAt
      } catch (e) {
        this.safeReport(e)
      } finally {
        this.beating = undefined
      }
    })()
    return await this.beating
  }

  /**
   * A carry: `issue` is the spend, given `{ ids, holder }` when gear may be
   * brought (else undefined, and it should spend without gear). The asked
   * ids are claimed before `issue` runs (rule 1); once it answers, those not
   * in `carriedOf(answer)` are let go. A failure or a timeout lets every one
   * go and rejects (`GearTimeoutError` for the timeout): the run should play
   * without gear, and a carry that lands later is returned by the reconcile.
   */
  async carry<R>(ids: readonly string[], issue: (bring: Bring | undefined) => Promise<R>, carriedOf: (answer: R) => ReadonlyArray<{ rowId?: string }> | undefined): Promise<R> {
    const asked = rowIdsOf(ids)
    if (asked.length === 0 || !this.canCarry) return await issue(undefined)
    for (const id of asked) this.claim(id)
    let answer: R
    try {
      answer = await this.within(this.track(issue({ ids: asked, holder: this.holder })), 'carry')
    } catch (e) {
      for (const id of asked) this.unclaim(id)
      throw e
    }
    const got = new Set<string>()
    for (const item of carriedOf(answer) ?? []) if (item.rowId !== undefined) got.add(item.rowId)
    for (const id of asked) if (!got.has(id)) this.unclaim(id)
    return answer
  }

  /**
   * A write that resolves `ids` (`settleGear`'s keeps, `discardGear`,
   * `uncarry`), given this holder. The ids are let go once it settles, fails
   * or times out (rule 1), whichever comes first; it rejects as the write
   * does (`GearTimeoutError` for the timeout, its `op` naming `call`).
   */
  async resolve<R>(ids: readonly string[], issue: (holder: string) => Promise<R>, call: ResolveCall): Promise<R> {
    const claimed = rowIdsOf(ids)
    try {
      return await this.within(this.track(issue(this.holder)), `resolve:${call}`)
    } finally {
      for (const id of claimed) this.unclaim(id)
    }
  }

  /**
   * A clean exit (rule 3): no new carry, wait for every gear write in flight
   * (including ones issued while waiting) and a heartbeat in flight, then
   * `releaseHolder`, then stop the timer. Never rejects.
   */
  async close (): Promise<void> {
    this.closing = true
    while (this.writes.size > 0) await Promise.allSettled([...this.writes])
    this.releasing = true
    if (this.beating !== undefined) await this.beating
    try {
      await this.within(this.store.releaseHolder(this.holder), 'close:release')
    } catch (e) {
      this.safeReport(e)
    }
    this.stop()
  }

  private claim (id: string): void {
    this.held.set(id, (this.held.get(id) ?? 0) + 1)
  }

  private unclaim (id: string): void {
    const n = this.held.get(id) ?? 0
    if (n <= 1) this.held.delete(id)
    else this.held.set(id, n - 1)
  }

  private track<T>(pending: Promise<T>): Promise<T> {
    this.writes.add(pending)
    const done = (): void => { this.writes.delete(pending) }
    pending.then(done, done)
    return pending
  }

  /** `pending`, or a `GearTimeoutError` naming `op` after `timeoutMs`; the timer never holds the process open. */
  private async within<T>(pending: Promise<T>, op: GearOp): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new GearTimeoutError(op)) }, this.timeoutMs)
      timer.unref()
    })
    try {
      return await Promise.race([pending, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private safeReport (e: unknown): void {
    try { this.report(e) } catch {}
  }
}
