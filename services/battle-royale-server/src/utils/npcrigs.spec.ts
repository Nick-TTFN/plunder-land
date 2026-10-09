import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Entered through the server's usual first module, so the archetype table loads (l1-9's timing tests).
import Multiplayer from '../network/multiplayer'
import { ARCHETYPES, type RoutineSpec } from '../archetypes/archetypes'
import { type Unit } from '../objects/unit'
import { type Shockwave } from '../mobskills/shockwave'
import * as crawler from '../../../../plunder-land-client/src/npcs/crawler/rig'
import * as broodling from '../../../../plunder-land-client/src/npcs/broodling/rig'
import * as reactor from '../../../../plunder-land-client/src/npcs/reactor/rig'
import * as compactor from '../../../../plunder-land-client/src/npcs/compactor/rig'
import * as kiln from '../../../../plunder-land-client/src/npcs/kiln/rig'
import * as coil from '../../../../plunder-land-client/src/npcs/coil/rig'
import * as brood from '../../../../plunder-land-client/src/npcs/brood/rig'
import { COIL_PULSE } from '../../../../plunder-land-client/src/vfx/coilfield'
import { NPC_RIGS, attackLead, gaitClock, gaitDirection, gaitPace, yieldsToMovement, type NpcDrawList, type NpcImage, type NpcRig } from '../../../../plunder-land-client/src/npcs/npcrig'
import { PEEP_RIG } from '../../../../plunder-land-client/src/robots/robotrig'
import { Hex } from '../../../../plunder-land-client/src/utils/hex'
import { ARCHETYPE_INFO } from '../../../../plunder-land-client/src/utils/archetypes'

/**
 * Every NPC rig (`src/npcs/<key>/rig.ts`) is a hand port of its Codex
 * package's JavaScript, which is the authority (l1-8, decision #51). The
 * fixtures, `npcrigs/<key>.fixtures.json`, come from
 * `plunder-land-client/tools/npc-rig-sync.mjs <key>`: every pose sample the
 * package exports (`rig/pose-samples.json`) and a few the game needs, with
 * the package's own evaluator result and what its own Canvas drawing did.
 *
 * Checked here, because the client has no test runner (specs aren't typechecked):
 * - the evaluator's whole `state` (and the Crawler's region list), every
 *   path and value, numbers within the package's `tolerance` (1e-9);
 * - the draw list `NpcSprite` draws from (`NpcRig.draw`): every image's art,
 *   clip and corners in order, and every shape the package fills or strokes
 *   (shadows, fuse, ember, sparks, blast, socket, the Crawler's charge and
 *   hit marks), to 1e-5. The Crawler's sensor (Canvas gradients) and its
 *   shot streak (the game's beam) are not compared;
 * - the clip table against the package's `animation-manifest.json`.
 *
 * The Reactor and the Compactor (l1-9, PROVISIONAL: their packages await
 * Nick's art review, so a re-sync is expected) draw only images: their image
 * entries carry the opacity and a tag ('' drawn, 'in' seen through the mask,
 * 'mask' the Reactor's aperture), and a sample's `base` says how to make the
 * pose an action starts from.
 *
 * The Kiln, the Coil and the Brood (l1-9, PROVISIONAL likewise): the Kiln's
 * flame and the Brood's lamps, baked to atlases in their packages, are
 * recorded as the package's own code that baked each frame and drawn by the
 * ports as shapes (the Kiln's curves flattened as the sync tool does:
 * `flattening`); the Coil's bloom is tagged 'screen'.
 */

type Leaf = number | string | boolean
type Image = [string, number[] | null, ...Array<number | string>]
type Mark = [string, string, number, number, number, ...number[]]

interface Sample {
  name: string
  time: number
  options: Record<string, unknown>
  shape: number
  values: Leaf[]
  regions?: string
  images: Image[]
  marks: Mark[]
}

interface Fixtures {
  package: string
  flattening?: { arc: number, cubic: number, quad: number }
  tolerance: number
  manifest: Record<string, { duration: number, loop: boolean, events: Array<{ time: number, name: string }> }>
  deathHolds: boolean
  paths: string[][]
  samples: Sample[]
}

// The fixtures round values to 1e-10 and drawing to 1e-5.
const ROUNDING = 1e-10
const DRAW_EPS = 2e-5

function load (key: string): Fixtures {
  return JSON.parse(readFileSync(join(__dirname, 'npcrigs', `${key}.fixtures.json`), 'utf8')) as Fixtures
}

/** As the sync tool's `flatten`: dotted paths, keys sorted, undefined left out. */
function flatten (value: unknown, prefix = '', out: [string[], Leaf[]] = [[], []]): [string[], Leaf[]] {
  if (value !== null && typeof value === 'object') {
    const keys = Array.isArray(value) ? value.map((_, i) => String(i)) : Object.keys(value).sort()
    for (const k of keys) flatten((value as Record<string, unknown>)[k], prefix === '' ? k : prefix + '.' + k, out)
  } else if (value !== undefined) {
    out[0].push(prefix)
    out[1].push(typeof value === 'number' && !Number.isFinite(value) ? String(value) : value as Leaf)
  }
  return out
}

function checkState (got: unknown, f: Fixtures, s: Sample, where: string): void {
  const [paths, values] = flatten(got)
  assert.deepEqual(paths, f.paths[s.shape], `${where}: state paths`)
  const eps = f.tolerance + ROUNDING
  values.forEach((v, i) => {
    const want = s.values[i]
    if (typeof v === 'number' && typeof want === 'number') assert.ok(Math.abs(v - want) <= eps, `${where} ${paths[i]}: ${v} vs ${want}`)
    else assert.equal(v, want, `${where} ${paths[i]}`)
  })
}

/** Thinned as the sync tool's `thin`. */
function thin (points: readonly number[]): number[] {
  const n = points.length / 2
  if (n <= 9) return [...points]
  const out: number[] = []
  for (let i = 0; i < n; i++) if (i % 8 === 0 || i === n - 1) out.push(points[2 * i], points[2 * i + 1])
  return out
}

/** The draw list in the fixture's terms: its images (with their opacity and tag), and its shapes as fill and stroke marks. */
function drawn (list: NpcDrawList, arts: NpcRig['arts']): { images: Image[], marks: Mark[] } {
  const images: Image[] = []
  const marks: Mark[] = []
  const image = (item: NpcImage, tag: string): void => {
    const { w, h } = arts[item.art]
    const m = item.m
    const at = (u: number, v: number): number[] => [m.a * u + m.c * v + m.x, m.b * u + m.d * v + m.y]
    const clip = item.clip === undefined ? null : [item.clip.x, item.clip.y, item.clip.w, item.clip.h]
    images.push([item.art, clip, ...at(0, 0), ...at(w, 0), ...at(0, h), item.alpha ?? 1, tag])
  }
  for (const item of [...list.ground, ...list.items]) {
    if (item.kind === 'image') {
      // An image the package composites differently carries it as its tag (the Coil's bloom, 'screen').
      image(item, item.blend ?? '')
      continue
    }
    if (item.kind === 'masked') {
      for (const inner of item.items) image(inner, 'in')
      image(item.mask, 'mask')
      continue
    }
    if (item.approx === true) continue
    if (item.kind === 'ellipse') {
      marks.push([item.stroke === undefined ? 'f' : 's', 'e', item.color, item.alpha, item.stroke ?? 0, item.x, item.y, item.rx, item.ry])
    } else if (item.kind === 'line') {
      marks.push(['s', 'o', item.color, item.alpha, item.width, item.points.length / 2, ...thin(item.points)])
    } else {
      marks.push(['f', 'c', item.color, item.alpha, 0, item.points.length / 2, ...thin(item.points)])
      if (item.stroke !== undefined) marks.push(['s', 'c', item.stroke.color, item.alpha, item.stroke.width, item.points.length / 2, ...thin(item.points)])
    }
  }
  return { images, marks }
}

function sameMark (a: Mark, b: Mark): boolean {
  if (a.length !== b.length || a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return false
  for (let i = 3; i < a.length; i++) if (Math.abs(a[i] as number - (b[i] as number)) > DRAW_EPS) return false
  return true
}

function checkDrawing (list: NpcDrawList, arts: NpcRig['arts'], s: Sample, where: string): void {
  const { images, marks } = drawn(list, arts)
  assert.equal(images.length, s.images.length, `${where}: image count`)
  images.forEach((img, i) => {
    const want = s.images[i]
    assert.equal(img[0], want[0], `${where} image ${i} art`)
    assert.deepEqual(img[1], want[1], `${where} image ${i} clip`)
    for (let k = 2; k < 8; k++) assert.ok(Math.abs((img[k] as number) - (want[k] as number)) <= DRAW_EPS, `${where} image ${i} (${img[0]}) corner[${k - 2}]: ${img[k] as number} vs ${want[k] as number}`)
    // The image-only packages (l1-9) also record each image's opacity and tag.
    if (want.length > 8) {
      assert.ok(Math.abs((img[8] as number) - (want[8] as number)) <= DRAW_EPS, `${where} image ${i} (${img[0]}) alpha: ${img[8]} vs ${want[8]}`)
      assert.equal(img[9], want[9], `${where} image ${i} (${img[0]}) tag`)
    }
  })
  // Shapes as a set: the port draws shadows under everything, the package in turn.
  const left = [...marks]
  for (const want of s.marks) {
    const at = left.findIndex((m) => sameMark(m, want))
    assert.ok(at >= 0, `${where}: the package draws ${JSON.stringify(want)}, the port doesn't`)
    left.splice(at, 1)
  }
  assert.deepEqual(left, [], `${where}: the port draws shapes the package doesn't`)
}

function checkManifest (rig: NpcRig, f: Fixtures): void {
  assert.deepEqual(Object.keys(rig.clips).sort(), Object.keys(f.manifest).sort())
  for (const [name, clip] of Object.entries(f.manifest)) {
    assert.equal(rig.clips[name].duration, clip.duration, name)
    assert.equal(rig.clips[name].loop, clip.loop, name)
    assert.deepEqual(rig.clips[name].events, clip.events, name)
  }
  assert.equal(rig.deathHolds, f.deathHolds)
  for (const role of [rig.roles.idle, rig.roles.move, rig.roles.attack?.clip, rig.roles.hit, rig.roles.death?.clip, rig.roles.spawn?.clip, rig.roles.prime?.clip]) {
    if (role !== undefined) assert.ok(rig.clips[role] !== undefined, `role clip ${role}`)
  }
  // An attack is held to the clip's own event of that name. The Coil's charge
  // names none (its package invents none): its moment is the hold's end, held
  // to the package's phases in its own test below.
  if (rig.roles.attack !== undefined && rig.key !== 'coil') assert.ok(rig.clips[rig.roles.attack.clip].events.some((e) => e.time === rig.roles.attack!.event), 'attack event')
}

test('crawler: the clip table is the package manifest\'s', () => {
  checkManifest(crawler.CRAWLER_RIG, load('crawler'))
})

test('crawler: the port matches the package on every sampled pose', () => {
  const f = load('crawler')
  assert.ok(f.samples.length > 271, 'every package sample and the extras')
  for (const name of ['reference', 'idle', 'run', 'fire', 'hit', 'fall_apart']) assert.ok(f.samples.some((s) => s.name === name), name)
  let regions = ''
  for (const s of f.samples) {
    const where = `crawler ${s.name} t=${s.time}`
    const pose = crawler.animationPose(s.name, s.time, s.options as crawler.CrawlerOptions)
    checkState(pose.state, f, s, where)
    if (s.regions !== undefined && s.regions !== '=') regions = s.regions
    const got = pose.regions.map((r) => [r.name, r.bone, r.art, r.group ?? '', r.sensor === true ? 1 : 0, r.clip === undefined ? '' : [r.clip.x, r.clip.y, r.clip.w, r.clip.h].join(':')].join(',')).join(' ')
    assert.equal(got, regions, `${where}: regions`)
    checkDrawing(crawler.draw(pose), crawler.CRAWLER_RIG.arts, s, where)
  }
})

test('broodling: the clip table is the package manifest\'s', () => {
  checkManifest(broodling.BROODLING_RIG, load('broodling'))
})

test('broodling: the port matches the package on every sampled pose', () => {
  const f = load('broodling')
  assert.ok(f.samples.length > 228, 'every package sample and the extras')
  for (const name of ['idle', 'walk', 'emerge', 'detonate']) assert.ok(f.samples.some((s) => s.name === name), name)
  assert.ok(f.samples.some((s) => s.name === 'detonate' && s.time > 1.35), 'a sample after the blast')
  for (const s of f.samples) {
    const where = `broodling ${s.name} t=${s.time} ${JSON.stringify(s.options)}`
    const state = broodling.sample(s.name, s.time, s.options as { direction?: { x: number, y: number }, fuseLength?: number })
    checkState(state, f, s, where)
    checkDrawing(broodling.draw(state), broodling.BROODLING_RIG.arts, s, where)
  }
})

test('reactor: the clip table is the package manifest\'s', () => {
  checkManifest(reactor.REACTOR_RIG, load('reactor'))
})

/** How a sample's `base` is made by the port: idle or walk, or the activation from an idle clock. */
function reactorBase (b: { clip: string, time: number, direction?: { x: number, y: number }, startTime?: number }): reactor.ReactorState {
  return b.clip === 'activate' ? reactor.activationPose(b.time, { startTime: b.startTime }) : reactor.pose(b.time, b.clip === 'walk' ? { direction: b.direction } : {})
}

test('reactor: the port matches the package on every sampled pose', () => {
  const f = load('reactor')
  assert.ok(f.samples.length >= 163, 'the package samples kept and the extras')
  for (const name of ['idle', 'walk', 'activate', 'hit', 'fall_apart']) assert.ok(f.samples.some((s) => s.name === name), name)
  assert.ok(f.samples.some((s) => s.name === 'fall_apart' && s.time > 0.5 && (s.options.base as { clip?: string } | undefined)?.clip === 'activate'), 'a death from the activation')
  for (const s of f.samples) {
    const where = `reactor ${s.name} t=${s.time} ${JSON.stringify(s.options)}`
    const { base, ...rest } = s.options as { base?: Parameters<typeof reactorBase>[0] } & reactor.ReactorOptions
    const state = reactor.sampleClip(s.name, s.time, base === undefined ? rest : { ...rest, basePose: reactorBase(base) })
    checkState(state, f, s, where)
    checkDrawing(reactor.draw(state), reactor.REACTOR_RIG.arts, s, where)
  }
})

test('compactor: the clip table is the package manifest\'s', () => {
  checkManifest(compactor.COMPACTOR_RIG, load('compactor'))
})

test('compactor: the port matches the package on every sampled pose', () => {
  const f = load('compactor')
  assert.ok(f.samples.length >= 220, 'the package samples kept and the extras')
  for (const name of ['idle', 'run', 'fire', 'hit', 'fall_apart']) assert.ok(f.samples.some((s) => s.name === name), name)
  // The shaft's crop and the front legs' roots are clipped images.
  assert.ok(f.samples.some((s) => s.images.some((i) => i[0] === 'shaft' && i[1] !== null)), 'a cropped shaft')
  for (const s of f.samples) {
    const where = `compactor ${s.name} t=${s.time} ${JSON.stringify(s.options)}`
    const { base, ...rest } = s.options as { base?: { clip: string, time: number, options: compactor.CompactorOptions } } & compactor.CompactorOptions
    const pose = compactor.animationPose(s.name, s.time, base === undefined ? rest : { ...rest, basePose: compactor.animationPose(base.clip, base.time, base.options) })
    checkState(pose.state, f, s, where)
    checkDrawing(compactor.draw(pose), compactor.COMPACTOR_RIG.arts, s, where)
  }
})

// l1-9: the clips' events are the server's moments. The Compactor's strike
// starts on its shockwave (effect 14, sent `impactMs` before the impact) and
// its `attack` event, the shoe on the floor, is the impact; the Reactor's
// activation starts on its tell (11, `activateMs` before the release) and
// release_start/release_end are the release (12) and its end. The wire
// floors an effect's lifetime to tenths (`effectLifetime`); `attackLead`
// takes the clip's own event when it falls inside that tenth.
test('the Compactor\'s strike lands on the server\'s impact, and the Reactor\'s release on its release', () => {
  const wire = (ms: number): number => Multiplayer.effectLifetime(ms) * 100
  const shockwave = new ARCHETYPES.compactor.skills[0].skill({} as unknown as Unit) as Shockwave
  const strike = compactor.COMPACTOR_RIG.roles.attack!
  assert.equal(strike.clip, 'fire')
  assert.equal(strike.event * 1000, shockwave.impactMs, 'the clip\'s attack event is the server\'s impactMs')
  assert.deepEqual(compactor.CLIPS.fire.events, [{ time: strike.event, name: 'attack' }])
  // 1215 ms goes out as 1200: the lead is still the event, so the clip starts at its 0.
  assert.equal(wire(shockwave.impactMs), 1200)
  assert.equal(attackLead(strike.event, wire(shockwave.impactMs)), shockwave.impactMs / 1000)

  const burst = ARCHETYPES.reactor.routines.find((r) => r.kind === 'reactorBurst') as Extract<RoutineSpec, { kind: 'reactorBurst' }>
  const release = reactor.REACTOR_RIG.roles.attack!
  assert.equal(release.clip, 'activate')
  const events = Object.fromEntries(reactor.CLIPS.activate.events.map((e) => [e.name, e.time]))
  assert.equal(release.event, events.release_start)
  assert.equal(events.release_start * 1000, burst.activateMs, 'release_start is the tell\'s length')
  assert.equal((events.release_end - events.release_start) * 1000, burst.releaseMs, 'the release is as long on both')
  assert.equal(attackLead(release.event, wire(burst.activateMs)), burst.activateMs / 1000)
  // Effect 12 brings it back in step: lead 0 puts the clip on release_start.
  assert.equal(attackLead(release.event, 0), 0)
  // A retuned server (outside the tenth) is taken as sent.
  assert.equal(attackLead(1.215, 1500), 1.5)
  assert.equal(attackLead(1.215, 1100), 1.1)
})

// Both fall apart from any pose, the attack's included. (Their packages'
// asks about a hit over the attack and the gait during a hit are moot since
// decision #52: a hit is an overlay, never a clip.)
test('the Reactor and the Compactor die from the attack\'s pose', () => {
  for (const rig of [reactor.REACTOR_RIG, compactor.COMPACTOR_RIG]) {
    assert.equal(rig.roles.death?.fromAction, true, rig.key)
    assert.equal(rig.roles.death?.from, 0, rig.key)
  }
  // The rigs' own pose functions take a strike's or an activation's pose as a death's base.
  const strike = compactor.COMPACTOR_RIG.pose('fire', 1.3, { x: 0, y: 1 }, { x: 1, y: 0 })
  const dead = compactor.COMPACTOR_RIG.pose('fall_apart', 2.8, { x: 0, y: 1 }, undefined, strike).state as compactor.CompactorPose
  assert.equal(dead.state.death?.settled, true)
  const charge = reactor.REACTOR_RIG.pose('activate', 1.5, { x: 0, y: 1 })
  const wreck = reactor.REACTOR_RIG.pose('fall_apart', 2.6, { x: 0, y: 1 }, undefined, charge).state as reactor.ReactorState
  assert.equal(wreck.death?.parts.length, 12)
  // The port: a hit ends exactly on the pose it began from (the clip is no longer played).
  const idle = reactor.REACTOR_RIG.pose('idle', 0.7, { x: 0, y: 1 })
  assert.deepEqual(reactor.REACTOR_RIG.pose('hit', 0.68, { x: 0, y: 1 }, undefined, idle).state, idle.state)
  // The Compactor's rig never throws for a hit over the strike (the sprite never asks; a frame must not die).
  assert.doesNotThrow(() => compactor.COMPACTOR_RIG.pose('hit', 0.3, { x: 0, y: 1 }, undefined, strike))
})

test('the Reactor\'s activation rides the idle clock it started from', () => {
  const idle = reactor.REACTOR_RIG.pose('idle', 2.25, { x: 0, y: 1 })
  const charge = reactor.REACTOR_RIG.pose('activate', 0, { x: 0, y: 1 }, undefined, idle).state as reactor.ReactorState
  assert.ok(Math.abs(charge.bob - (idle.state as reactor.ReactorState).bob) < 1e-12)
  assert.equal(charge.time, 2.25)
})

test('kiln: the clip table is the package manifest\'s', () => {
  checkManifest(kiln.KILN_RIG, load('kiln'))
})

test('kiln: the port matches the package on every sampled pose, its flame included', () => {
  const f = load('kiln')
  assert.ok(f.samples.length >= 157, 'every package sample and the extras')
  for (const name of ['reference', 'idle', 'run', 'fire', 'hit', 'fall_apart']) assert.ok(f.samples.some((s) => s.name === name), name)
  // The port flattens curves as the sync tool recorded them.
  assert.deepEqual(f.flattening, { arc: kiln.ARC_STEPS, cubic: kiln.CUBIC_STEPS, quad: kiln.QUAD_STEPS })
  // Flames from both banks are in the fixtures (the hit's and the death's have no embers).
  assert.ok(f.samples.some((s) => s.name === 'idle' && s.marks.length > 8), 'an idle flame')
  assert.ok(f.samples.some((s) => s.name === 'fall_apart' && s.time >= 0.42 && s.marks.length === 0), 'a furnace out')
  // Embers in the ember window from the idle's bank, never from the hit's and the death's (v3's clean bank).
  const embers = (s: Sample): boolean => s.marks.some((m) => m[2] === 0xffa342 || m[2] === 0xffd97b)
  assert.ok(f.samples.some((s) => s.name === 'idle' && embers(s)), 'an idle with embers')
  assert.ok(f.samples.some((s) => s.name === 'hit' && (s.options.base as { time?: number } | undefined)?.time === 4.4), 'a hit in the ember window')
  assert.ok(!f.samples.some((s) => (s.name === 'hit' || s.name === 'fall_apart') && embers(s)), 'no embers on a hit or a death')
  for (const s of f.samples) {
    const where = `kiln ${s.name} t=${s.time} ${JSON.stringify(s.options)}`
    const { base, ...rest } = s.options as { base?: { clip: string, time: number, options: kiln.KilnOptions } } & kiln.KilnOptions
    const pose = kiln.animationPose(s.name, s.time, base === undefined ? rest : { ...rest, basePose: kiln.animationPose(base.clip, base.time, base.options) })
    checkState(pose.state, f, s, where)
    checkDrawing(kiln.draw(pose), kiln.KILN_RIG.arts, s, where)
  }
})

test('coil: the clip table is the package manifest\'s', () => {
  checkManifest(coil.COIL_RIG, load('coil'))
})

test('coil: the port matches the package on every sampled pose', () => {
  const f = load('coil')
  assert.ok(f.samples.length >= 159, 'every package sample and the extras')
  for (const name of ['idle', 'move', 'charge', 'hit', 'fall_apart']) assert.ok(f.samples.some((s) => s.name === name), name)
  assert.ok(f.samples.some((s) => s.images.some((i) => i[9] === 'screen')), 'a bloom drawn with screen')
  assert.ok(f.samples.some((s) => s.images.some((i) => i[0] === 'dark' && (i[8] as number) > 0 && (i[8] as number) < 1)), 'a cooled body mixed over the body')
  for (const s of f.samples) {
    const where = `coil ${s.name} t=${s.time} ${JSON.stringify(s.options)}`
    const { base, mode } = s.options as { base?: { time: number, options: coil.CoilOptions }, mode?: string } & coil.CoilOptions
    const state = base === undefined
      ? coil.basePose(s.time, s.options as coil.CoilOptions)
      : coil.actionPose(mode as 'hit' | 'fall_apart', s.time, coil.basePose(base.time, base.options))
    checkState(state, f, s, where)
    checkDrawing(coil.draw(state), coil.COIL_RIG.arts, s, where)
  }
})

test('brood: the clip table is the package manifest\'s', () => {
  checkManifest(brood.BROOD_RIG, load('brood'))
})

test('brood: the port matches the package on every sampled pose, its lamps included', () => {
  const f = load('brood')
  assert.ok(f.samples.length >= 134, 'every package sample and the extras')
  for (const name of ['idle', 'move', 'spawn', 'hit', 'death']) assert.ok(f.samples.some((s) => s.name === name), name)
  // A lamp's core shows only above 0.6 (the release lights them all).
  assert.ok(f.samples.some((s) => s.marks.some((m) => m[2] === 0xfff8c2)), 'a lamp at full')
  for (const s of f.samples) {
    const where = `brood ${s.name} t=${s.time} ${JSON.stringify(s.options)}`
    const { base, ...rest } = s.options as { base?: { clip: string, time: number, options: brood.BroodOptions } } & brood.BroodOptions
    const state = brood.evaluatePose(s.name, s.time, base === undefined ? rest : { ...rest, fromPose: brood.sample(base.clip, base.time, base.options) })
    checkState(state, f, s, where)
    checkDrawing(brood.draw(state), brood.BROOD_RIG.arts, s, where)
  }
})

// l1-9: the Kiln's lob, the Coil's charge and the Brood's release against
// their effects. The Kiln's 9 comes at the server's cast (the launch): the
// clip starts on its `attack` event. The Coil's 13 comes at the charge's
// start with tell + hold as its lifetime: the clip starts at 0, the hold
// ending with the server's field. The Brood's 19 comes with the release, on
// which the Broodling emerges: the clip starts on its `spawn` event.
test('the Kiln launches on effect 9, the Coil holds its field with the server\'s and the Brood launches on effect 19', () => {
  const wire = (ms: number): number => Multiplayer.effectLifetime(ms) * 100
  const lob = kiln.KILN_RIG.roles.attack!
  assert.equal(lob.clip, 'fire')
  assert.equal(lob.event, kiln.LAUNCH)
  assert.deepEqual(kiln.CLIPS.fire.events, [{ time: kiln.LAUNCH, name: 'attack' }])
  assert.equal(lob.event - attackLead(lob.event, 0), kiln.LAUNCH, 'started on the launch')
  const k = ARCHETYPES.kiln
  assert.ok(k.skills.length > 0)

  const field = ARCHETYPES.coil.routines.find((r) => r.kind === 'coilField') as Extract<RoutineSpec, { kind: 'coilField' }>
  const charge = coil.COIL_RIG.roles.attack!
  assert.equal(charge.clip, 'charge')
  assert.equal(charge.event * 1000, field.tellMs + field.holdMs, 'the hold ends with the field')
  assert.equal(COIL_PULSE.tellMs + COIL_PULSE.holdMs, field.tellMs + field.holdMs)
  // The package's own phases: the tell (gather and release) to 1.5 s, the hold to 3.0 s.
  assert.equal(coil.basePose(field.tellMs / 1000 - 0.001, { mode: 'charge' }).phaseName, 'Release')
  assert.equal(coil.basePose(field.tellMs / 1000, { mode: 'charge' }).phaseName, 'Hold / white-hot')
  assert.equal(coil.basePose(charge.event - 0.001, { mode: 'charge' }).phaseName, 'Hold / white-hot')
  assert.equal(coil.basePose(charge.event, { mode: 'charge' }).phaseName, 'Cool / settle')
  // 3000 ms arrives as 3000: the clip starts at 0.
  assert.equal(charge.event - attackLead(charge.event, wire(field.tellMs + field.holdMs)), 0)
  // The clip (4.2 s) outlasts the plant (tell + hold + cool, 3.7 s) only by its idle tail.
  assert.equal(coil.basePose(field.tellMs / 1000 + field.holdMs / 1000 + field.coolMs / 1000, { mode: 'charge' }).phaseName, 'Idle')

  const release = ARCHETYPES.brood.routines.find((r) => r.kind === 'brood') as Extract<RoutineSpec, { kind: 'brood' }>
  const spawn = brood.BROOD_RIG.roles.attack!
  assert.equal(spawn.clip, 'spawn')
  assert.equal(spawn.event, brood.SPAWN_EVENT)
  assert.deepEqual(brood.CLIPS.spawn.events, [{ name: 'spawn', time: brood.SPAWN_EVENT }])
  assert.equal(brood.CLIPS.spawn.duration * 1000, release.releaseMs, 'effect 19\'s lifetime is the clip')
  assert.equal(spawn.event - attackLead(spawn.event, 0), brood.SPAWN_EVENT, 'started on the launch')
})

// All three fall apart from the pose shown. (Hits are an overlay since #52.)
test('the Kiln, the Coil and the Brood die from the pose shown', () => {
  for (const rig of [kiln.KILN_RIG, coil.COIL_RIG, brood.BROOD_RIG]) {
    assert.equal(rig.roles.death?.fromAction, true, rig.key)
    assert.equal(rig.roles.death?.from, 0, rig.key)
  }
  const down = { x: 0, y: 1 }
  // Deaths from an attack's pose.
  const lob = kiln.KILN_RIG.pose('fire', 0.6, down, { x: 1, y: 0 })
  assert.equal((kiln.KILN_RIG.pose('fall_apart', 2.8, down, undefined, lob).state as kiln.KilnPose).state.detached, true)
  const hold = coil.COIL_RIG.pose('charge', 2.1, down)
  assert.equal((coil.COIL_RIG.pose('fall_apart', 2.8, down, undefined, hold).state as coil.CoilState).settled, true)
  const spawn = brood.BROOD_RIG.pose('spawn', 0.3, down)
  assert.equal((brood.BROOD_RIG.pose('death', 2.8, down, undefined, spawn).state as brood.BroodState).settled, true)
  // The ports: a hit ends on the pose it began from (the clip is no longer played).
  const idle = kiln.KILN_RIG.pose('idle', 0.7, down)
  assert.deepEqual((kiln.KILN_RIG.pose('hit', 0.7, down, undefined, idle).state as kiln.KilnPose).state.legs, (idle.state as kiln.KilnPose).state.legs)
  const move = coil.COIL_RIG.pose('move', 0.4, { x: -0.6, y: 0.8 })
  const coilHit = (t: number): coil.CoilState => coil.COIL_RIG.pose('hit', t, down, undefined, move).state as coil.CoilState
  assert.deepEqual(coilHit(0.72).legs.map((l) => l.knee), (move.state as coil.CoilState).legs.map((l) => l.knee))
  // A Coil dying during a hit starts from the hit's source, exactly.
  assert.deepEqual(coil.hitSource(coilHit(0.3)), move.state)
  // The rigs never throw for a hit over their attack (nothing asks; a frame must not die).
  assert.doesNotThrow(() => kiln.KILN_RIG.pose('hit', 0.3, down, undefined, lob))
  assert.doesNotThrow(() => coil.COIL_RIG.pose('hit', 0.3, down, undefined, hold))
  assert.doesNotThrow(() => brood.BROOD_RIG.pose('hit', 0.3, down, undefined, spawn))
})

// The Kiln's furnace and the Brood's lamps run on the sprite's clock
// (`NpcPoseOptions.clock`), not the clip's, as their packages ask.
test('the Kiln\'s furnace and the Brood\'s lamps run on the clock they are given', () => {
  const down = { x: 0, y: 1 }
  const furnace = (clip: string, clock?: number): number => (kiln.KILN_RIG.pose(clip, 0.5, down, undefined, undefined, clock === undefined ? undefined : { clock }).state as kiln.KilnPose).state.fireTime
  // The idle's own seconds, wrapped to its 8.4 s loop.
  assert.ok(Math.abs(furnace('idle') - 0.5) < 1e-12)
  assert.equal(furnace('idle', 37.25), 37.25)
  assert.equal(furnace('run', 37.25), 37.25)
  assert.equal(furnace('fire', 37.25), 37.25)
  // The hit and the death carry on from the pose they start from.
  const idle = kiln.KILN_RIG.pose('idle', 0.5, down, undefined, undefined, { clock: 20 })
  assert.equal((kiln.KILN_RIG.pose('hit', 0.3, down, undefined, idle).state as kiln.KilnPose).state.fireTime, 20.3)
  // A different clock is a different flame frame.
  const frame = (clock: number): number => kiln.furnaceFrame(kiln.KILN_RIG.pose('idle', 0.5, down, undefined, undefined, { clock }).state as kiln.KilnPose).frame
  assert.notEqual(frame(1), frame(3))
  const lights = (clock?: number): number[] => (brood.BROOD_RIG.pose('idle', 0.5, down, undefined, undefined, clock === undefined ? undefined : { clock }).state as brood.BroodState).lights
  assert.deepEqual(lights(), brood.sample('idle', 0.5).lights)
  assert.deepEqual(lights(81.5), brood.sample('idle', 0.5, { clock: 81.5 }).lights)
  assert.notDeepEqual(lights(81.5), lights())
})

test('every NPC rig is keyed by a mob in the mirror, with a sheet name the bake writes', () => {
  for (const [key, rig] of Object.entries(NPC_RIGS)) {
    assert.equal(rig!.key, key)
    assert.equal(ARCHETYPE_INFO[key as keyof typeof ARCHETYPE_INFO]?.kind, 'mob', key)
  }
})

test('every image an NPC draws is a frame of its sheet', () => {
  for (const rig of Object.values(NPC_RIGS)) {
    const file = join(__dirname, '..', '..', '..', '..', 'plunder-land-client', 'assets', 'res', `npc-${rig!.key}.json`)
    const sheet = JSON.parse(readFileSync(file, 'utf8')) as { frames: Record<string, unknown> }
    const names = new Set<string>()
    for (const art of Object.keys(rig!.arts)) names.add(`npc-${rig!.key}/${art}.png`)
    // `NpcSprite.place`: a clipped image is the band of its art from the clip's top row.
    if (rig!.key === 'crawler') for (const [, top] of crawler.SHELLS) names.add(`npc-crawler/body-${top}.png`)
    for (const name of names) assert.ok(sheet.frames[name] !== undefined, name)
  }
})

test('in place (the game), a Broodling emerging draws no socket and stays on its cell', () => {
  const state = broodling.sample('emerge', 3.6)
  const inPlace = broodling.draw(state, { inPlace: true })
  const full = broodling.draw(state)
  // The socket: two filled outlines and two rims, only in the package's own drawing.
  assert.equal(full.items.length - inPlace.items.length, 4)
  const body = (list: NpcDrawList): { x: number, y: number } => {
    const img = list.items.find((i) => i.kind === 'image' && i.art === 'body')!
    return img.kind === 'image' ? { x: img.m.x, y: img.m.y } : { x: 0, y: 0 }
  }
  // The package moves it 64 units forward out of its socket; in place it doesn't move.
  assert.ok(Math.abs(body(full).y - body(inPlace).y - 64 * broodling.CFG.tilt * broodling.CFG.renderScale) < 1e-9)
})

// l1-7 F5: the Broodling's tell (effect 17, 500 ms on the server) is the end
// of its detonate, timed so that the death (the blast) carries straight on:
// prime.from + the tell = death.from = the package's detonation event.
test('the Broodling\'s prime is its detonate from 0.85 s, so the server\'s 500 ms tell ends on the blast at 1.35 s', () => {
  const roles = broodling.BROODLING_RIG.roles
  assert.deepEqual(roles.prime, { clip: 'detonate', from: 0.85 })
  assert.equal(roles.death?.clip, roles.prime?.clip, 'the death must carry on the prime\'s clip')
  assert.ok(Math.abs((roles.prime?.from ?? 0) + 0.5 - (roles.death?.from ?? 0)) < 1e-9)
  const event = broodling.CLIPS.detonate.events.find((e) => e.name === 'detonate')
  assert.equal(event?.time, roles.death?.from)
})

// l1-7 F4: the rig's pose passes its cord length through (`NpcPoseOptions`),
// which `Mob` sets from the fuse left; undefined is the package's default.
test('the Broodling rig\'s pose takes the cord length, clamped to the package\'s 0.25-2, and defaults to 1', () => {
  const pose = (fuseLength?: number): number =>
    (broodling.BROODLING_RIG.pose('idle', 1, { x: 1, y: 0 }, undefined, undefined, fuseLength === undefined ? undefined : { fuseLength }).state as broodling.BroodlingState).fuseLength
  assert.equal(pose(), 1)
  assert.equal(pose(0.5), 0.5)
  assert.equal(pose(0.1), 0.25)
  assert.equal(pose(5), 2)
  // And it reaches the drawing: a shorter cord ends nearer the collar.
  const tip = (fuseLength: number): number => {
    const pts = broodling.fusePoints(broodling.BROODLING_RIG.pose('idle', 1, { x: 1, y: 0 }, undefined, undefined, { fuseLength }).state as broodling.BroodlingState)
    const a = pts[0]
    const b = pts[pts.length - 1]
    return Math.hypot(b.x - a.x, b.y - a.y)
  }
  assert.ok(tip(0.5) < tip(2))
  // The Crawler has no such parameter and ignores it.
  const crawlerPose = (o?: { fuseLength: number }): unknown => crawler.CRAWLER_RIG.pose('idle', 1, { x: 1, y: 0 }, undefined, undefined, o).state
  assert.deepEqual(crawlerPose({ fuseLength: 0.5 }), crawlerPose())
})

// l1-7 F7: `NpcSprite` holds a prime just short of `death.from` until the
// death arrives (`PRIME_HOLD_S`, 1 ms), because from `death.from` on the rig
// already draws the Broodling dead with its blast.
test('the Broodling is whole 1 ms before its death\'s start and blown up at it, which is why a prime holds short of it', () => {
  const from = broodling.BROODLING_RIG.roles.death?.from ?? 0
  assert.equal(broodling.sample('detonate', from - 0.001).dead, false)
  assert.equal(broodling.sample('detonate', from).dead, true)
})

// Decision #52 A1: an attack clip past the moment it exists for gives way to
// movement (`NpcSprite.update`), as the Broodling's emerge does once ready.
// The moment is each rig's `attack.event`, checked here against the clip's own
// named event where the package names one.
test('an attack clip yields to movement from its event on, never before; a death and a prime never', () => {
  const moments: Record<string, { clip: string, event: number, named?: string }> = {
    crawler: { clip: 'fire', event: 0.34, named: 'fire' },
    kiln: { clip: 'fire', event: kiln.LAUNCH },
    brood: { clip: 'spawn', event: brood.SPAWN_EVENT, named: 'spawn' },
    coil: { clip: 'charge', event: coil.CHARGE.holdEnd },
    reactor: { clip: 'activate', event: 1, named: 'release_start' },
    compactor: { clip: 'fire', event: compactor.IMPACT_TIME }
  }
  for (const [key, want] of Object.entries(moments)) {
    const rig = NPC_RIGS[key]!
    assert.equal(rig.roles.attack?.clip, want.clip, key)
    assert.equal(rig.roles.attack?.event, want.event, key)
    if (want.named !== undefined) {
      const named = rig.clips[want.clip].events.find((e) => e.name === want.named)
      assert.equal(named?.time, want.event, `${key}: ${want.named}`)
    }
    assert.equal(yieldsToMovement(rig.roles, 'attack', want.event - 0.001), false, key)
    assert.equal(yieldsToMovement(rig.roles, 'attack', want.event), true, key)
    assert.equal(yieldsToMovement(rig.roles, 'death', 99), false, key)
    // The event lies inside the clip, so the yield can come before its end.
    assert.ok(want.event < rig.clips[want.clip].duration, key)
  }
  const roles = broodling.BROODLING_RIG.roles
  assert.equal(yieldsToMovement(roles, 'spawn', roles.spawn!.ready - 0.001), false)
  assert.equal(yieldsToMovement(roles, 'spawn', roles.spawn!.ready), true)
  assert.equal(yieldsToMovement(roles, 'prime', 99), false)
  assert.equal(yieldsToMovement(roles, 'attack', 99), false, 'no attack, nothing to yield')
})

// Decision #52: no rig names the retired hit flags, and every rig still names its hit clip as data.
test('no NPC role carries refusesHit or holdGaitOnHit any more', () => {
  for (const rig of Object.values(NPC_RIGS)) {
    assert.equal('holdGaitOnHit' in rig!.roles, false, rig!.key)
    assert.equal(rig!.roles.attack !== undefined && 'refusesHit' in rig!.roles.attack, false, rig!.key)
  }
})

// Decision #52 lane 3 (PROVISIONAL, the Crawler's foot-slide trial): the game
// runs the Crawler at a 3x stride (`GAIT.stride`) and its own gait rate, pace
// floor and ground squash (`NpcGait`). `RobotSprite` and `objects/tilt.ts` are
// pixi modules, so their numbers are read from the source, as
// `tools/foot-slide.cjs` does.
const SPRITE = (() => {
  const src = readFileSync(join(__dirname, '../../../../plunder-land-client/src/robots/robotsprite.ts'), 'utf8')
  const num = (re: RegExp): number => {
    const m = src.match(re)
    assert.ok(m !== null, `robotsprite.ts no longer has ${String(re)}`)
    return Number(m[1])
  }
  const tilt = readFileSync(join(__dirname, '../../../../plunder-land-client/src/objects/tilt.ts'), 'utf8')
  assert.match(tilt, /ROW_SCREEN = Math\.round\(ROW \* 0\.93\)/)
  assert.match(tilt, /TILT = ROW_SCREEN \/ ROW/)
  const row = Hex.SIZE * Math.sqrt(3) / 2
  return {
    RUN_RATE: num(/static readonly RUN_RATE = ([\d.]+)/),
    STRIDE_SPEED: num(/static readonly STRIDE_SPEED = ([\d.]+)/),
    MIN_PACE: num(/static readonly MIN_PACE = ([\d.]+)/),
    MAX_PACE: num(/static readonly MAX_PACE = ([\d.]+)/),
    SCALE: num(/static readonly PEEP_HEIGHT = ([\d.]+)/) / PEEP_RIG.referenceUnits,
    TILT: Math.round(row * 0.93) / row
  }
})()

test('crawler: the fixtures\' game-stride runs are the game\'s stride, and the game\'s pose draws them', () => {
  const f = load('crawler')
  const runs = f.samples.filter((s) => s.options.stride !== undefined)
  assert.ok(runs.length >= 20, 'game-stride samples')
  for (const s of runs) {
    assert.equal(s.options.stride, crawler.GAIT.stride, 'tools/npc-rig-sync.mjs GAME_STRIDE is GAIT.stride')
    const where = `crawler game ${s.name} t=${s.time} ${JSON.stringify(s.options)}`
    // Through the game's path, which passes its own stride: a wrong `GAIT.stride` fails here.
    const pose = crawler.CRAWLER_RIG.pose(s.name, s.time, { x: s.options.directionX as number, y: s.options.directionY as number })
    checkState((pose.state as crawler.CrawlerPose).state, f, s, where)
    checkDrawing(crawler.CRAWLER_RIG.draw(pose), crawler.CRAWLER_RIG.arts, s, where)
  }
})

test('kiln: the fixtures\' game-stride runs are the game\'s stride, and the game\'s pose draws them', () => {
  const f = load('kiln')
  const runs = f.samples.filter((s) => s.name === 'run' && s.options.stride !== undefined)
  assert.ok(runs.length >= 20, 'game-stride samples')
  // A lob, a hit and a death from a game-stride run (the port's own test above evaluates them).
  assert.ok(['fire', 'hit', 'fall_apart'].every((n) => f.samples.some((s) => s.name === n && (s.options.base as { options?: { stride?: number } } | undefined)?.options?.stride === kiln.GAIT.stride)), 'actions from a game-stride run')
  for (const s of runs) {
    assert.equal(s.options.stride, kiln.GAIT.stride, 'tools/npc-rig-sync.mjs GAME_STRIDE (kiln) is GAIT.stride')
    const where = `kiln game ${s.name} t=${s.time} ${JSON.stringify(s.options)}`
    // Through the game's path, which passes its own stride: a wrong `GAIT.stride` fails here.
    const pose = kiln.KILN_RIG.pose(s.name, s.time, { x: s.options.directionX as number, y: s.options.directionY as number })
    checkState((pose.state as kiln.KilnPose).state, f, s, where)
    checkDrawing(kiln.KILN_RIG.draw(pose), kiln.KILN_RIG.arts, s, where)
  }
})

test('kiln: at the game\'s stride no knee goes straighter than 0.9 of its reach and the feet stay apart', () => {
  const reach = kiln.CONFIG.upperLength + kiln.CONFIG.lowerLength
  let most = 0
  let closest = Infinity
  for (let k = 0; k < 16; k++) {
    const a = k * Math.PI / 8
    for (let i = 0; i < 144; i++) {
      const legs = kiln.animationPose('run', kiln.CLIPS.run.duration * i / 144, { directionX: Math.cos(a), directionY: Math.sin(a), stride: kiln.GAIT.stride }).state.legs
      for (const l of legs) most = Math.max(most, l.knee.reach / reach)
      for (let p = 0; p < legs.length; p++) for (let q = p + 1; q < legs.length; q++) closest = Math.min(closest, Math.hypot(legs[p].foot.x - legs[q].foot.x, legs[p].foot.y - legs[q].foot.y))
    }
  }
  // Measured 0.898 and 117 rig units at stride 26; the package's own walk (20) reaches 0.874, and 0.80 at rest.
  assert.ok(most < 0.9, `the longest leg reaches ${most.toFixed(3)} of its length`)
  assert.ok(closest > 100, `two feet come within ${closest.toFixed(1)} rig units`)
})

/** The rigs with a gait of their own (decision #52 lanes 3 and 4); the rest run as before. */
const GAITED = ['crawler', 'kiln', 'compactor', 'reactor']

/** A package's own draw scale on top of `sizeScale` (the Broodling's `renderScale`): its feet are drawn that much larger. */
const DRAWN: Readonly<Record<string, number>> = { broodling: broodling.CFG.renderScale }

interface GaitLeg { foot: { x: number, y: number, z?: number }, worldFoot?: { x: number, y: number, z?: number }, contact?: boolean }

/** A move pose's legs, whatever the port calls them (`state.legs`, the Crawler's `state.state.legs`). */
function legsOf (pose: { state: unknown }): GaitLeg[] {
  const s = pose.state as { legs?: GaitLeg[], state?: { legs: GaitLeg[] } }
  return s.legs ?? s.state!.legs
}

/**
 * A planted foot's mean world velocity at ground speed `v` along world
 * direction `dir`, as `NpcSprite` plays the move loop: direction and stretch
 * from `gaitDirection`, clip rate from `gaitClock` at the pace `gaitPace`
 * keeps. Foot offsets go to world units as the screen shows them (x; package
 * ground y x 0.68, over TILT), at the rig's `sizeScale` (and its own draw
 * scale). Zero means planted.
 */
function plantedVelocity (rig: NpcRig, v: number, dir: { x: number, y: number }): { x: number, y: number } {
  const ppu = SPRITE.SCALE * rig.sizeScale * (DRAWN[rig.key] ?? 1)
  const g = gaitDirection(rig.gait, dir.x, dir.y, SPRITE.TILT)
  const pace = gaitPace(rig.gait, v / SPRITE.STRIDE_SPEED, SPRITE.MIN_PACE, SPRITE.MAX_PACE)
  const rate = gaitClock(rig, pace, g.stretch, SPRITE)
  const feet = (t: number): Array<{ x: number, y: number, contact: boolean }> =>
    legsOf(rig.pose(rig.roles.move, t, { x: g.x, y: g.y }, undefined, undefined, { clock: t })).map((l) => {
      const f = l.worldFoot ?? l.foot
      return { x: f.x * ppu, y: (f.y * 0.68 - (f.z ?? 0)) * ppu / SPRITE.TILT, contact: l.contact === true }
    })
  const h = 1e-4
  let sx = 0
  let sy = 0
  let n = 0
  const period = rig.clips[rig.roles.move].duration
  for (let i = 0; i < 400; i++) {
    const t = period * i / 400
    const [lo, hi] = [feet(t - h), feet(t + h)]
    lo.forEach((a, k) => {
      if (!a.contact || !hi[k].contact) return
      sx += v * dir.x + rate * (hi[k].x - a.x) / (2 * h)
      sy += v * dir.y + rate * (hi[k].y - a.y) / (2 * h)
      n++
    })
  }
  assert.ok(n > 0)
  return { x: sx / n, y: sy / n }
}

/** The share of the ground speed a planted foot should slide at `v`: none below the rig's step cap, the rest above it. */
function cappedSlide (rig: NpcRig, v: number): number {
  const gait = rig.gait!
  const pace = gaitPace(gait, v / SPRITE.STRIDE_SPEED, SPRITE.MIN_PACE, SPRITE.MAX_PACE)
  const planted = pace * SPRITE.STRIDE_SPEED / (gait.groundSpeed * SPRITE.SCALE * rig.sizeScale)
  return Math.max(0, 1 - gait.maxSteps * gait.period / planted)
}

const chaseSpeed = (key: string): number => (ARCHETYPES[key].routines.find((r) => r.kind === 'guard') as Extract<RoutineSpec, { kind: 'guard' }>).chaseSpeed
const R2 = Math.SQRT1_2
const GAIT_DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }, { x: R2, y: -R2 }, { x: -R2, y: R2 }, { x: 0.8, y: 0.6 }]

test('every NPC with a gait plants its feet at idle wander and chase, any way it goes, up to its step cap; past it they slide only along the motion', () => {
  assert.deepEqual(Object.values(NPC_RIGS).filter((r) => r!.gait !== undefined).map((r) => r!.key).sort(), [...GAITED].sort(), 'the rigs with a gait')
  for (const key of GAITED) {
    const rig = NPC_RIGS[key]!
    for (const v of [30, chaseSpeed(key)]) {
      const want = cappedSlide(rig, v)
      for (const dir of GAIT_DIRS) {
        const w = plantedVelocity(rig, v, dir)
        const d = Math.hypot(dir.x, dir.y)
        const along = (w.x * dir.x + w.y * dir.y) / d
        const across = (w.y * dir.x - w.x * dir.y) / d
        const where = `${key} at ${v} u/s along ${dir.x.toFixed(2)},${dir.y.toFixed(2)}: a planted foot moves ${w.x.toFixed(2)},${w.y.toFixed(2)} u/s, want ${(want * 100).toFixed(1)}% along`
        // 1% of the ground speed: the derivative is numerical.
        assert.ok(Math.abs(along - want * v) < 0.01 * v && Math.abs(across) < 0.01 * v, where)
      }
    }
  }
  // The Crawler, at the chase speed Nick saw (lane 3), is under its cap: planted.
  assert.equal(cappedSlide(crawler.CRAWLER_RIG, chaseSpeed('crawler')), 0)
})

test('a gait follows its rig\'s size: resized 1.25x, the feet stay planted and the legs take 0.8x the steps', () => {
  for (const key of GAITED) {
    const rig = NPC_RIGS[key]!
    const big: NpcRig = { ...rig, sizeScale: rig.sizeScale * 1.25 }
    // Idle wander: under every rig's step cap at either size.
    const v = 30
    assert.equal(cappedSlide(big, v), 0, key)
    for (const dir of GAIT_DIRS) {
      const w = plantedVelocity(big, v, dir)
      assert.ok(Math.hypot(w.x, w.y) < 0.01 * v, `${key} resized, along ${dir.x.toFixed(2)},${dir.y.toFixed(2)}: a planted foot moves ${w.x.toFixed(2)},${w.y.toFixed(2)} u/s`)
    }
    const pace = gaitPace(rig.gait, v / SPRITE.STRIDE_SPEED, SPRITE.MIN_PACE, SPRITE.MAX_PACE)
    const ratio = gaitClock(big, pace, 1, SPRITE) / gaitClock(rig, pace, 1, SPRITE)
    assert.ok(Math.abs(ratio - 0.8) < 1e-12, `${key}: steps x${ratio}`)
  }
  // The Crawler at chase too (under its cap at both sizes): 4.84 steps a second per leg east-west, 3.87 resized.
  const rig = crawler.CRAWLER_RIG
  const big: NpcRig = { ...rig, sizeScale: rig.sizeScale * 1.25 }
  const pace = 90 / SPRITE.STRIDE_SPEED
  assert.ok(Math.abs(gaitClock(rig, pace, 1, SPRITE) / rig.gait!.period - 4.84) < 0.01)
  assert.ok(Math.abs(gaitClock(big, pace, 1, SPRITE) / rig.gait!.period - 3.87) < 0.01)
  const w = plantedVelocity(big, 90, { x: 1, y: 0 })
  assert.ok(Math.hypot(w.x, w.y) < 0.9, `resized at 90 u/s: ${w.x.toFixed(2)},${w.y.toFixed(2)}`)
})

test('gaitClock: RUN_RATE x pace without a gait; with one, the planted rate, capped at maxSteps east-west, then stretched', () => {
  const sprite = { RUN_RATE: 2, STRIDE_SPEED: 140, SCALE: 0.5 }
  assert.equal(gaitClock({ sizeScale: 3 }, 0.7, 1.3, sprite), 1.4)
  const gait = { groundSpeed: 40, period: 0.5, maxSteps: 6, minPace: 0.2 }
  // 70 u/s over (40 x 0.5 x 2) = 1.75 clip seconds a second, 3.5 steps: under the cap (6 steps x 0.5 s = 3 clip seconds a second).
  assert.ok(Math.abs(gaitClock({ gait, sizeScale: 2 }, 0.5, 1, sprite) - 1.75) < 1e-12)
  assert.ok(Math.abs(gaitClock({ gait, sizeScale: 2 }, 0.5, 1.36, sprite) - 1.75 * 1.36) < 1e-12)
  // 280 u/s would need 7 a second, 14 steps: capped at 6 steps x 0.5 s = 3, and the stretch still applies.
  assert.ok(Math.abs(gaitClock({ gait, sizeScale: 2 }, 2, 1, sprite) - 3) < 1e-12)
  assert.ok(Math.abs(gaitClock({ gait, sizeScale: 2 }, 2, 1.36, sprite) - 3 * 1.36) < 1e-12)
})

test('crawler: at the game\'s stride the knees never go straight and no foot meets its neighbour', () => {
  const reach = crawler.CONFIG.upperLength + crawler.CONFIG.lowerLength
  let most = 0
  let closest = Infinity
  for (let k = 0; k < 16; k++) {
    const a = k * Math.PI / 8
    for (let i = 0; i < 144; i++) {
      const legs = crawler.animationPose('run', 0.72 * i / 144, { directionX: Math.cos(a), directionY: Math.sin(a), stride: crawler.GAIT.stride }).state.legs
      for (const l of legs) most = Math.max(most, l.knee.reach / reach)
      for (const side of [-1, 1]) {
        const row = legs.filter((l) => l.side === side).sort((p, q) => p.row - q.row)
        for (let j = 0; j + 1 < row.length; j++) closest = Math.min(closest, Math.hypot(row[j].foot.x - row[j + 1].foot.x, row[j].foot.y - row[j + 1].foot.y))
      }
    }
  }
  // Measured 0.85 and 18.9 rig units at stride 60 (49.7 at the package's 20).
  assert.ok(most < 0.9, `the longest leg reaches ${most.toFixed(3)} of its length`)
  assert.ok(closest > 15, `neighbouring feet come within ${closest.toFixed(1)} rig units`)
})

test('gaitDirection: without groundTilt the direction is kept; with it the stride points along the motion as drawn', () => {
  assert.deepEqual(gaitDirection(undefined, 0.3, -2, 0.92), { x: 0.3, y: -2, stretch: 1 })
  assert.deepEqual(gaitDirection({ groundSpeed: 1, period: 1, maxSteps: 6, minPace: 0.1 }, 0.3, -2, 0.92), { x: 0.3, y: -2, stretch: 1 })
  const gait = { groundSpeed: 1, period: 1, maxSteps: 6, minPace: 0.5, groundTilt: 0.68 }
  const tilt = SPRITE.TILT
  assert.equal(gaitDirection(gait, 5, 0, tilt).stretch, 1)
  assert.ok(Math.abs(gaitDirection(gait, 0, -3, tilt).stretch - tilt / 0.68) < 1e-12)
  for (const [x, y] of [[1, 1], [-0.3, 0.9], [2, -0.5]]) {
    const g = gaitDirection(gait, x, y, tilt)
    // The package's sweep along (g.x, g.y), drawn (x, y x 0.68) and read as world (y / tilt), times the stretch, is the unit world direction.
    const wx = g.x * g.stretch
    const wy = g.y * 0.68 / tilt * g.stretch
    const d = Math.hypot(x, y)
    assert.ok(Math.abs(wx - x / d) < 1e-12 && Math.abs(wy - y / d) < 1e-12, `${x},${y}`)
  }
  assert.equal(gaitPace(undefined, 0.2, 0.5, 3), 0.5)
  assert.equal(gaitPace({ groundSpeed: 1, period: 1, maxSteps: 6, minPace: 0.2 }, 0.1, 0.5, 3), 0.2)
  assert.equal(gaitPace({ groundSpeed: 1, period: 1, maxSteps: 6, minPace: 0.2 }, 0.3, 0.5, 3), 0.3)
  assert.equal(gaitPace({ groundSpeed: 1, period: 1, maxSteps: 6, minPace: 0.2 }, 9, 0.5, 3), 3)
})
