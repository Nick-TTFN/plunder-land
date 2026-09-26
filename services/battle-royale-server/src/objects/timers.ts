/** One scheduled callback. Opaque to callers except as a handle for `cancel`. */
export interface Timer {
  readonly due: number
  readonly owner: object | undefined
  readonly fn: () => void
  /** Set when it has run or been cancelled; either way it never runs again. */
  done: boolean
}

/**
 * The world's delayed work: skill lifetimes, cooldowns, freed ids.
 *
 * Everything here used to be a `setTimeout`, and a Node timer callback runs on
 * its own turn of the event loop, outside the try/catch in `index.ts` that
 * exists so one bad tick cannot take every in-flight run down with the process.
 * These run from `World.update` instead, so they are inside that boundary, and
 * each one is caught on its own so a throwing expiry cannot skip the rest of
 * the tick either.
 *
 * **Timing.** A timer runs at the first tick whose clock has reached `due`. A
 * `setTimeout` fired between ticks at exactly `due`, and nothing could observe
 * the world before the next tick, so the two are the same to every client.
 * The clock is `Date.now()`, the same one `Skill.cooldown` and buff expiry read.
 *
 * **Owners.** A timer's owner is the object whose state it changes: a
 * projectile owns its lifetime, a stone its own, a caster its Defend and a mob
 * its attack cooldown. `cancelOwner` is called from `GameObject.destroy` and
 * `Player.exit`, so a dead or departed object's pending work goes with it.
 * A timer that must run whatever happens to anyone (a breath's area removal,
 * a freed id) has no owner. **Never give a cleanup timer an owner that can die
 * before the thing it cleans up**, or the cleanup is cancelled and it leaks.
 *
 * Eviction: an entry leaves `pending` when it runs, or at the first `run`
 * after it is cancelled that has something due (a run with nothing due returns
 * without looking at the list); `byOwner` loses a key when that owner's last timer runs or
 * is cancelled. Process-global, like every other piece of world state.
 */
export default class Timers {
  private static pending: Timer[] = []
  /**
   * No pending timer is due before this; Infinity when none is pending. `run`
   * returns at once while the clock is short of it, instead of rebuilding the
   * list every tick (server-cpu-trim: that rebuild was 0.66 ms of a 400-player
   * tick). Lowered by `schedule`, recomputed by each `run` that scans. A
   * cancelled timer can leave it early, which costs one scan, never a late run.
   */
  private static nextDue = Infinity
  private static readonly byOwner = new Map<object, Set<Timer>>()

  /** Run `fn` at the first tick at least `delayMs` from now. */
  static schedule (delayMs: number, fn: () => void, owner?: object): Timer {
    const timer: Timer = { due: Date.now() + delayMs, owner, fn, done: false }
    Timers.pending.push(timer)
    if (timer.due < Timers.nextDue) Timers.nextDue = timer.due
    if (owner !== undefined) {
      let set = Timers.byOwner.get(owner)
      if (set === undefined) {
        set = new Set()
        Timers.byOwner.set(owner, set)
      }
      set.add(timer)
    }
    return timer
  }

  /** Harmless on a timer that has already run or been cancelled. */
  static cancel (timer: Timer | undefined): void {
    if (timer === undefined || timer.done) return
    timer.done = true
    Timers.release(timer)
  }

  /** Cancel everything `owner` has pending. */
  static cancelOwner (owner: object): void {
    const set = Timers.byOwner.get(owner)
    if (set === undefined) return
    for (const timer of set) timer.done = true
    Timers.byOwner.delete(owner)
  }

  /**
   * Run every timer due by `now`, in due order (scheduling order on a tie, as
   * `setTimeout` does). Timers scheduled while this runs wait for a later call,
   * even if already due; a timer cancelled by an earlier one in the same batch
   * does not run.
   */
  static run (now: number): void {
    if (Timers.pending.length === 0 || now < Timers.nextDue) return

    const due: Timer[] = []
    const later: Timer[] = []
    let nextDue = Infinity
    for (const timer of Timers.pending) {
      if (timer.done) continue
      if (timer.due <= now) due.push(timer)
      else {
        later.push(timer)
        if (timer.due < nextDue) nextDue = timer.due
      }
    }
    Timers.pending = later
    // Before running them: one that schedules another lowers it from here.
    Timers.nextDue = nextDue
    if (due.length === 0) return

    // Array.prototype.sort is stable, so equal dues keep scheduling order.
    due.sort((a, b) => a.due - b.due)
    for (const timer of due) {
      if (timer.done) continue
      timer.done = true
      Timers.release(timer)
      try {
        timer.fn()
      } catch (e) {
        console.error('timer', e)
      }
    }
  }

  /** How many timers are waiting. For tests and diagnostics. */
  static get size (): number {
    let n = 0
    for (const timer of Timers.pending) if (!timer.done) n++
    return n
  }

  /** Drop everything. The world never resets, so this is for tests. */
  static clear (): void {
    for (const timer of Timers.pending) timer.done = true
    Timers.pending = []
    Timers.nextDue = Infinity
    Timers.byOwner.clear()
  }

  private static release (timer: Timer): void {
    if (timer.owner === undefined) return
    const set = Timers.byOwner.get(timer.owner)
    if (set === undefined) return
    set.delete(timer)
    if (set.size === 0) Timers.byOwner.delete(timer.owner)
  }
}
