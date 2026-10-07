import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as crawler from '../../../../plunder-land-client/src/npcs/crawler/rig'
import * as broodling from '../../../../plunder-land-client/src/npcs/broodling/rig'
import { NPC_RIGS, type NpcDrawList, type NpcRig } from '../../../../plunder-land-client/src/npcs/npcrig'
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
 */

type Leaf = number | string | boolean
type Image = [string, number[] | null, ...number[]]
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

/** The draw list in the fixture's terms: its images, and its shapes as fill and stroke marks. */
function drawn (list: NpcDrawList, arts: NpcRig['arts']): { images: Image[], marks: Mark[] } {
  const images: Image[] = []
  const marks: Mark[] = []
  for (const item of [...list.ground, ...list.items]) {
    if (item.kind === 'image') {
      const { w, h } = arts[item.art]
      const m = item.m
      const at = (u: number, v: number): number[] => [m.a * u + m.c * v + m.x, m.b * u + m.d * v + m.y]
      const clip = item.clip === undefined ? null : [item.clip.x, item.clip.y, item.clip.w, item.clip.h]
      images.push([item.art, clip, ...at(0, 0), ...at(w, 0), ...at(0, h)])
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
  // An attack is held to the clip's own event of that name.
  if (rig.roles.attack !== undefined) assert.ok(rig.clips[rig.roles.attack.clip].events.some((e) => e.time === rig.roles.attack!.event), 'attack event')
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
