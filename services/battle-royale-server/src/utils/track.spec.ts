import test from 'node:test'
import assert from 'node:assert/strict'
import { CatchUp, onCellCentre, sampleTrack, type TrackState } from '../../../../plunder-land-client/src/objects/track'
import { Hex } from './hex'
import { Vector } from './vector'

// The client's remote-unit interpolation (`Unit.update`), decision #52 lane 1:
// O1 (no overshoot past a stop on a cell centre) and S1 (catch-up on a
// planting effect). Server-shaped streams: a state per 250 ms tick, only
// while the position changes, floored as the wire floors it.

const TICK = 250
const LATENCY = 40

/** A walk east along row 0 at `speed` u/s from x 0 to `stopX`, as the client receives it. */
function walk (speed: number, stopX: number, ticks = 20): TrackState[] {
  const states: TrackState[] = []
  let sent: number | undefined
  for (let k = 0; k <= ticks; k++) {
    const x = Math.floor(Math.min(stopX, k * TICK / 1000 * speed))
    if (x !== sent) states.push({ t: k * TICK + LATENCY, x, y: 0 })
    sent = x
  }
  return states
}

/** Renders `states` at 60 fps over `ms` with `delay` and `cap`; the furthest x and where it rests. */
function play (states: TrackState[], delay: number, cap: number, ms = 6000): { max: number, rest: number } {
  let max = -Infinity
  let rest = 0
  for (let now = 0; now <= ms; now += 1000 / 60) {
    const x = sampleTrack(states, now - delay, cap).x
    max = Math.max(max, x)
    rest = x
  }
  return { max, rest }
}

const delay = (p95: number): number => Math.min(500, Math.max(60, p95 * 1.15 + 15))
const cap = (p95: number): number => Math.min(150, p95 * 0.6)

test('a wire position is a cell centre exactly when it is its cell\'s floored centre', () => {
  for (const cell of [new Vector(0, 0), new Vector(5, 0), new Vector(3, 7), new Vector(-2, 9)]) {
    const c = Hex.toPosition(cell)
    assert.equal(onCellCentre(Math.floor(c.x), Math.floor(c.y)), true, `${cell.x},${cell.y}`)
    assert.equal(onCellCentre(Math.floor(c.x) + 1, Math.floor(c.y)), false)
    assert.equal(onCellCentre(Math.floor(c.x), Math.floor(c.y) - 1), false)
  }
})

test('a remote unit stopping on a cell centre rests on it, never past it', () => {
  for (const [p95, speed] of [[250, 140], [250, 350], [250, 90], [100, 140]]) {
    const stop = Hex.toPosition(new Vector(6, 0)).x // 270
    const { max, rest } = play(walk(speed, stop), delay(p95), cap(p95))
    assert.equal(rest, stop, `p95 ${p95} speed ${speed}`)
    assert.equal(max, stop, `p95 ${p95} speed ${speed}: never drawn past it`)
  }
})

test('a late packet mid-walk (off a centre) is still extrapolated for a bounded time', () => {
  const states = walk(140, 1000).slice(0, 6) // the last state, x 175, is off a centre
  const last = states[states.length - 1]
  assert.equal(onCellCentre(last.x, last.y), false)
  const x = sampleTrack(states, last.t + 100, 150).x
  assert.ok(x > last.x + 10, `extrapolated to ${x}`)
  assert.ok(sampleTrack(states, last.t + 1000, 150).x <= last.x + 140 * 0.15 + 1e-9)
})

test('a catch-up eases a unit onto its newest state over CatchUp.MS, along its track and never back', () => {
  const states = walk(100, 315) // 7 cells, held at 315 from the tick it arrives
  const d = 300
  const newest = states[states.length - 1]
  // The planting effect arrives with the newest state.
  const at = newest.t
  const c = new CatchUp()
  const before = sampleTrack(states, at - d, 150).x
  assert.ok(newest.x - before > 10, `drawn ${newest.x - before} behind`)
  c.start(at, d, newest.t)
  let last = before
  for (let now = at; now <= at + CatchUp.MS; now += 1000 / 60) {
    const x = sampleTrack(states, c.renderTime(now, d, newest.t), 150).x
    assert.ok(x >= last - 1e-9, 'never back')
    last = x
  }
  assert.equal(sampleTrack(states, c.renderTime(at + CatchUp.MS, d, newest.t), 150).x, newest.x)
  // Held there while the lead is given back, and the lead is gone `delay` after the newest state arrived.
  for (let now = at + CatchUp.MS; now <= at + d + 50; now += 1000 / 60) {
    assert.equal(sampleTrack(states, c.renderTime(now, d, newest.t), 150).x, newest.x)
  }
  assert.equal(c.active, false)
  assert.equal(c.renderTime(at + d + 100, d, newest.t), at + 100, 'back on the shared clock')
})

test('a catch-up whose newest state is mid-step holds there, then walks the rest when it arrives', () => {
  const all = walk(100, 315)
  const mid = all.findIndex((s) => !onCellCentre(s.x, s.y) && s.x > 100)
  const states = all.slice(0, mid + 1)
  const d = 300
  const c = new CatchUp()
  const at = states[mid].t + 10
  c.start(at, d, states[mid].t)
  const x1 = sampleTrack(states, c.renderTime(at + CatchUp.MS, d, states[mid].t), 150).x
  assert.equal(x1, states[mid].x)
  // No extrapolation while it leads: it holds.
  assert.equal(sampleTrack(states, c.renderTime(at + 200, d, states[mid].t), 150).x, states[mid].x)
  // The next state arrives: it carries on from where it is, forward.
  const next = all[mid + 1]
  states.push(next)
  const x2 = sampleTrack(states, c.renderTime(next.t + 20, d, next.t), 150).x
  assert.ok(x2 >= states[mid].x && x2 <= next.x, `${x2}`)
})
