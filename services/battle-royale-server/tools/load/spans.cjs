// Per-function timings for probe.cjs, on when PROBE_DETAIL is 1 or 2.
//
// Wraps named methods of the built server (dist/) in a span: calls, inclusive
// ms and self ms (inclusive minus the wrapped spans it called), kept on a
// stack so nested spans add up. No source change. Level 1 wraps phases and
// per-object methods; level 2 adds the tiny per-candidate helpers too, which
// costs more than it measures for some of them: read level 2 for call counts,
// level 1 for time.
//
// The wrapper's own cost is calibrated at load (`wrapNs`) and reported as
// `overheadMs`: calls x wrapNs, per tick, so a reader can see how much of a
// window's world ms the probe added. Nothing corrects the numbers for it.
//
// Also counts socket.io emits and their bytes (Buffer arguments only), since
// the cost of a send is split between the emit inside the tick and the socket
// write the event loop does after it.
const path = require('path')
const { performance } = require('perf_hooks')

const now = () => performance.now()
let spans = new Map()
const stack = []
const missing = []
const counters = { emits: 0, emitBytes: 0, emitsInTick: 0, sockWrites: 0, sockWritevs: 0 }
let inTick = false

function span (name) {
  let s = spans.get(name)
  if (s === undefined) { s = { calls: 0, incl: 0, self: 0 }; spans.set(name, s) }
  return s
}

// `name` is a string, or a function of (this, args) that returns one, for a
// span split by argument (Multiplayer.update by object type).
function wrap (owner, method, name) {
  const orig = owner?.[method]
  if (typeof orig !== 'function') { missing.push(typeof name === 'string' ? name : method); return }
  const named = typeof name === 'string' ? () => name : name
  owner[method] = function (...args) {
    const t = now()
    stack.push(0)
    try {
      return orig.apply(this, args)
    } finally {
      const dt = now() - t
      const child = stack.pop()
      const s = span(named(this, args))
      s.calls++; s.incl += dt; s.self += dt - child
      if (stack.length > 0) stack[stack.length - 1] += dt
    }
  }
}

// ns per wrapped call: a wrapped no-op against a bare one.
function calibrate () {
  const o = { f (x) { return x } }
  const N = 2e6
  let t = now(); for (let i = 0; i < N; i++) o.f(i); const bare = now() - t
  wrap(o, 'f', '__calibrate')
  t = now(); for (let i = 0; i < N; i++) o.f(i); const wrapped = now() - t
  spans.delete('__calibrate')
  return Math.max(0, (wrapped - bare) / N * 1e6)
}

function install (dist, level) {
  const wrapNs = calibrate()
  const req = (p) => require(path.join(dist, p))
  const World = req('objects/world.js').default
  const Multiplayer = req('network/multiplayer.js').default
  const { StandingsBoard } = req('network/multiplayer.js')
  const Player = req('objects/player.js').default
  const { Unit } = req('objects/unit.js')
  const Mob = req('objects/mob.js').default
  const { GameObject } = req('objects/gameobject.js')
  const Throwable = req('objects/throwable.js').default
  const Timers = req('objects/timers.js').default
  const Area = req('area/area.js').default
  const SectorArea = req('area/sectorarea.js').default
  const GuardPosition = req('ai/guardposition.js').default
  const UseSkillOnTarget = req('ai/useskillontarget.js').default
  const { CellIndex } = req('utils/cellindex.js')
  const { Path } = req('utils/path.js')
  const { Hex } = req('utils/hex.js')

  const KIND = { 2: 'loot', 4: 'player', 16: 'projectile', 32: 'mob', 128: 'item' }
  // [owner, method, name, level]
  const P = (cls) => cls.prototype
  const list = [
    // The tick's phases.
    [P(World), 'update', 'World.update', 1],
    [Timers, 'run', 'Timers.run', 1],
    [World, 'evictFinished', 'World.evictFinished', 1],
    [P(World), 'refillLayer', 'World.refillLayer', 1],
    [P(World), 'createLootFrom', 'World.createLootFrom', 1],
    [P(World), 'createItemsFrom', 'World.createItemsFrom', 1],
    [P(World), 'getUnobstructedPosition', 'World.getUnobstructedPosition', 1],
    [P(World), 'getRockPosition', 'World.getRockPosition', 1],
    [P(World), 'spawnMob', 'World.spawnMob', 1],
    [World, 'gateKeepOut', 'World.gateKeepOut', 1],
    [World, 'updateProjectiles', 'World.updateProjectiles', 1],
    [World, 'dropCells', 'World.dropCells', 1],
    // Units.
    [P(Player), 'update', 'Player.update', 1],
    [P(Player), 'pickUp', 'Player.pickUp', 1],
    [P(Player), 'channelExtract', 'Player.channelExtract', 1],
    [P(Player), 'hopPortal', 'Player.hopPortal', 1],
    [P(Player), 'tryExecuteSkill', 'Player.tryExecuteSkill', 1],
    [P(Player), 'tryUseItem', 'Player.tryUseItem', 1],
    [P(Mob), 'update', 'Mob.update', 1],
    [P(Mob), 'touch', 'Mob.touch', 1],
    [P(Unit), 'update', 'Unit.update', 1],
    [P(Unit), 'walkPath', 'Unit.walkPath', 1],
    [P(Unit), 'step', 'Unit.step', 1],
    [P(Unit), 'chooseStep', 'Unit.chooseStep', 1],
    [P(Unit), 'followPath', 'Unit.followPath', 1],
    [P(Unit), 'repath', 'Unit.repath', 1],
    [P(Unit), 'setWaypoints', 'Unit.setWaypoints', 1],
    [P(Unit), 'endAtPortal', 'Unit.endAtPortal', 1],
    [P(Unit), 'hit', 'Unit.hit', 1],
    [P(GuardPosition), 'update', 'GuardPosition.update', 1],
    [P(UseSkillOnTarget), 'update', 'UseSkillOnTarget.update', 1],
    [P(Area), 'update', 'Area.update', 1],
    [P(SectorArea), 'currentCells', 'SectorArea.currentCells', 1],
    [P(Throwable), 'update', 'Throwable.update', 1],
    [P(Throwable), 'findHit', 'Throwable.findHit', 1],
    [Path, 'find', 'Path.find', 1],
    [Hex, 'line', 'Hex.line', 1],
    // Spatial lookups.
    [World, 'interestCandidates', 'World.interestCandidates', 1],
    [World, 'FIND_IN_CELLS', 'World.FIND_IN_CELLS', 1],
    [World, 'NEAREST_IN_CELLS', 'World.NEAREST_IN_CELLS', 1],
    [World, 'FIRST_ON_LINE', 'World.FIRST_ON_LINE', 1],
    [World, 'forKeysWithin', 'World.forKeysWithin', 1],
    [P(CellIndex), 'sync', 'CellIndex.sync', 1],
    [P(CellIndex), 'moved', 'CellIndex.moved', 2],
    [P(CellIndex), 'at', 'CellIndex.at', 2],
    [World, 'mobCanEnter', 'World.mobCanEnter', 2],
    [World, 'mobHolds', 'World.mobHolds', 2],
    [World, 'UNITS_ON', 'World.UNITS_ON', 2],
    [World, 'isBlocked', 'World.isBlocked', 2],
    [Hex, 'toCell', 'Hex.toCell', 2],
    [Hex, 'distance', 'Hex.distance', 2],
    // Broadcast and send.
    [P(GameObject), 'update', 'GameObject.update (pickups)', 1],
    [P(GameObject), 'serialiseBinary', 'GameObject.serialiseBinary', 1],
    // Split by what is being broadcast: pickups never move, units do.
    [P(Multiplayer), 'update', (_, [obj]) => `Multiplayer.update[${KIND[obj?.type] ?? obj?.type}]`, 1],
    [P(Multiplayer), 'create', 'Multiplayer.create', 1],
    [P(Multiplayer), 'destroy', 'Multiplayer.destroy', 1],
    [P(Multiplayer), 'effect', 'Multiplayer.effect', 1],
    [P(Multiplayer), 'effectAt', 'Multiplayer.effectAt', 1],
    [P(Multiplayer), 'switchLayer', 'Multiplayer.switchLayer', 1],
    [P(Multiplayer), 'flushAll', 'Multiplayer.flushAll', 1],
    [P(Multiplayer), 'flush', 'Multiplayer.flush', 1],
    [Multiplayer, 'packRecords', 'Multiplayer.packRecords', 1],
    [Multiplayer, 'rankStandings', 'Multiplayer.rankStandings', 1],
    [P(StandingsBoard), 'bufferFor', 'StandingsBoard.bufferFor', 1],
    [Multiplayer, 'sees', 'Multiplayer.sees', 2],
    [P(Multiplayer), 'viewerOf', 'Multiplayer.viewerOf', 2],
    [P(Multiplayer), 'outbox', 'Multiplayer.outbox', 2],
    // Outside the tick.
    [P(Multiplayer), 'onConnect', 'Multiplayer.onConnect', 1],
    [P(Multiplayer), 'onStart', 'Multiplayer.onStart', 1],
    [P(Multiplayer), 'admit', 'Multiplayer.admit', 1],
    [P(Multiplayer), 'onDisconnect', 'Multiplayer.onDisconnect', 1],
    [P(Multiplayer), 'onPointer', 'Multiplayer.onPointer', 1],
    [P(Multiplayer), 'onSkill', 'Multiplayer.onSkill', 1],
    [P(Multiplayer), 'onUseItem', 'Multiplayer.onUseItem', 1]
  ]
  for (const [owner, method, name, l] of list) if (l <= level) wrap(owner, method, name)

  // socket.io's server Socket, resolved from the server package.
  const sio = require(require.resolve('socket.io', { paths: [path.dirname(dist)] }))
  wrap(sio.Socket.prototype, 'emit', 'socket.emit')
  const emit = sio.Socket.prototype.emit
  sio.Socket.prototype.emit = function (ev, ...args) {
    counters.emits++
    if (inTick) counters.emitsInTick++
    for (const a of args) if (Buffer.isBuffer(a)) counters.emitBytes += a.length
    return emit.call(this, ev, ...args)
  }
  // Every write that reaches a TCP socket: one syscall each (a writev carries
  // several chunks). This is the cost the emit count doesn't show.
  const net = require('net')
  const w = net.Socket.prototype._write
  net.Socket.prototype._write = function (...a) { counters.sockWrites++; return w.apply(this, a) }
  const wv = net.Socket.prototype._writev
  net.Socket.prototype._writev = function (...a) { counters.sockWritevs++; return wv.apply(this, a) }
  // Marks the tick, for emitsInTick.
  const upd = World.prototype.update
  World.prototype.update = function (...a) { inTick = true; try { return upd.apply(this, a) } finally { inTick = false } }
  const fa = Multiplayer.prototype.flushAll
  Multiplayer.prototype.flushAll = function (...a) { inTick = true; try { return fa.apply(this, a) } finally { inTick = false } }

  if (missing.length > 0) console.error('probe: not wrapped (not found):', missing.join(', '))
  return wrapNs
}

// One window's spans, per tick, sorted by self time; resets the window.
function take (ticks, wrapNs) {
  const t = ticks || 1
  const out = {}
  let calls = 0
  for (const [name, s] of [...spans].sort((a, b) => b[1].self - a[1].self)) {
    calls += s.calls
    out[name] = { calls: +(s.calls / t).toFixed(1), incl: +(s.incl / t).toFixed(3), self: +(s.self / t).toFixed(3) }
  }
  const c = { ...counters }
  spans = new Map()
  for (const k in counters) counters[k] = 0
  return {
    spans: out,
    overheadMs: +(calls / t * wrapNs / 1e6).toFixed(3),
    wrapNs: +wrapNs.toFixed(1),
    emitsPerTick: +(c.emits / t).toFixed(1),
    emitsOutsideTickPerTick: +((c.emits - c.emitsInTick) / t).toFixed(1),
    emitKBPerTick: +(c.emitBytes / t / 1024).toFixed(1),
    sockWritesPerTick: +((c.sockWrites + c.sockWritevs) / t).toFixed(1),
    sockWritevsPerTick: +(c.sockWritevs / t).toFixed(1)
  }
}

module.exports = { install, take }
