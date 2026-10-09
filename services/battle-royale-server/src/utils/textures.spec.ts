import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Every sprite name the client asks for by string literal must exist in one of
 * its atlases.
 *
 * `Texture.from('name')` with a name that is in no loaded sheet does not fail:
 * pixi treats it as a URL, fetches it, gets a 404 and raises an uncaught error
 * event. That is how Defend (`shield.png`) and IceBreath
 * (`UI/controls/snowflake.png`) threw on every press until 2026-09-25 - the
 * dev server's full-screen error overlay, a silent console error in
 * production. `new AnimationClip('name')` with an unknown name is worse: it
 * iterates `animations[name]`, which is undefined, and throws at once.
 *
 * Only literal names are checked. A name built at run time (a template, a
 * variable) is invisible here; the count of such calls is printed so a new one
 * is at least noticed.
 */

const CLIENT = join(__dirname, '..', '..', '..', '..', 'plunder-land-client')
const SRC = join(CLIENT, 'src')
const ATLASES = ['assets/res/atlas.json', 'assets/res/hex.json', 'assets/res/ground.json', 'assets/res/arena.json', 'assets/res/blasts.json', 'assets/res/peep.json', 'assets/res/magnet.json', 'assets/res/peep-lobby.json', 'assets/res/magnet-lobby.json', 'assets/res/periscope.json', 'assets/res/periscope-lobby.json', 'assets/res/npc-crawler.json', 'assets/res/npc-broodling.json', 'assets/res/npc-reactor.json', 'assets/res/npc-compactor.json', 'assets/res/npc-fx.json', 'assets/res/npc-kiln.json', 'assets/res/npc-coil.json', 'assets/res/npc-brood.json'].map((f) => join(CLIENT, f))

/**
 * Files nothing imports, whose names are known to be missing. Each must say
 * why, and should go when it is deleted or given art.
 */
const UNREACHABLE = new Set<string>([])

function sourceFiles (dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (name.endsWith('.ts')) out.push(path)
  }
  return out
}

function atlasNames (): { frames: Set<string>, animations: Set<string> } {
  const frames = new Set<string>()
  const animations = new Set<string>()
  for (const file of ATLASES) {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const f = data.frames ?? {}
    for (const key of Array.isArray(f) ? f.map((x: { filename: string }) => x.filename) : Object.keys(f)) frames.add(key)
    for (const key of Object.keys(data.animations ?? {})) animations.add(key)
  }
  return { frames, animations }
}

const TEXTURE_CALL = /(?:Texture|Sprite)\.from\(\s*(['"])([^'"]+)\1/g
const CLIP_CALL = /new AnimationClip\(\s*(['"])([^'"]+)\1/g
const DYNAMIC_CALL = /(?:(?:Texture|Sprite)\.from|new AnimationClip)\(\s*(?!['"])/g

test('every literal sprite and animation name the client uses is in an atlas', () => {
  const { frames, animations } = atlasNames()
  assert.ok(frames.size > 0 && animations.size > 0, 'atlases did not load')

  const missing: string[] = []
  let checked = 0
  let dynamic = 0
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file)
    if (UNREACHABLE.has(rel)) continue
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(TEXTURE_CALL)) {
      checked++
      if (!frames.has(m[2])) missing.push(`${rel}: texture '${m[2]}'`)
    }
    for (const m of text.matchAll(CLIP_CALL)) {
      checked++
      if (!animations.has(m[2])) missing.push(`${rel}: animation '${m[2]}'`)
    }
    dynamic += [...text.matchAll(DYNAMIC_CALL)].length
  }

  console.log(`textures.spec: ${checked} literal names checked, ${dynamic} built at run time (not checked)`)
  assert.ok(checked > 0, 'found no sprite names at all - the scan is broken')
  assert.deepEqual(missing, [])
})

/**
 * A clip named as a quoted `'fx/<id>'` anywhere in the client: the arena clips
 * (`new AnimationClip('fx/...')`, `playBlast`'s argument) and every NPC effect
 * clip, which `vfx/npcfx.ts` takes by name (`new FxSprite`, `stampCells`,
 * `standAt`, `warnCells`, `burstCells`: task l1-11). `FxSprite` throws on a
 * name the sheet lacks, at the moment the effect plays.
 */
const FX_NAME = /(['"])(fx\/[A-Za-z0-9_-]+)\1/g

test('every quoted fx clip name in the client is an animation in an atlas', () => {
  const { animations } = atlasNames()
  const missing: string[] = []
  let checked = 0
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file)
    if (UNREACHABLE.has(rel)) continue
    for (const m of readFileSync(file, 'utf8').matchAll(FX_NAME)) {
      checked++
      if (!animations.has(m[2])) missing.push(`${rel}: '${m[2]}'`)
    }
  }
  assert.ok(checked >= 20, `only ${checked} fx names found - the scan is broken`)
  assert.deepEqual(missing, [])
})

/**
 * The NPC effects sheet (`tools/bake-npc-fx-atlas.py`, task l1-11): every clip
 * carries the fps and loop `FxSprite` plays it at and whether it lies on the
 * ground, every frame its pivot, and the ground clips are exactly the
 * package's per-cell decals and the lob's shadow (its `plane: "ground"`):
 * `FxSprite` marks those `onGround`, so a standing burst flagged ground would
 * be squashed by the tilt, and a decal not flagged would stand up. A new clip
 * fails here until it is placed in one list or the other.
 */
test('the NPC effects sheet carries each clip\'s fps, loop, plane and pivots', () => {
  const data = JSON.parse(readFileSync(join(CLIENT, 'assets/res/npc-fx.json'), 'utf8'))
  assert.equal(data.meta.scale, '2')
  const clips: Record<string, { fps: unknown, loop: unknown, ground: unknown }> = data.meta.clips
  assert.deepEqual(Object.keys(clips).sort(), Object.keys(data.animations).sort())
  const ground: string[] = []
  for (const [name, clip] of Object.entries(clips)) {
    assert.ok(typeof clip.fps === 'number' && clip.fps > 0, `${name}: fps ${String(clip.fps)}`)
    assert.equal(typeof clip.loop, 'boolean', `${name}: loop`)
    assert.equal(typeof clip.ground, 'boolean', `${name}: ground`)
    if (clip.ground === true) ground.push(name)
    for (const frame of data.animations[name] as string[]) {
      const anchor = data.frames[frame]?.anchor
      assert.ok(anchor !== undefined && anchor.x >= 0 && anchor.x <= 1 && anchor.y >= 0 && anchor.y <= 1, `${frame}: anchor`)
    }
  }
  assert.deepEqual(ground.sort(), [
    'fx/broodling-scorch-cell', 'fx/coil-pulse-cell', 'fx/compactor-wave-cell', 'fx/kiln-impact-cell',
    'fx/kiln-lob-shadow', 'fx/landing-center', 'fx/landing-ring', 'fx/reactor-release-cell'
  ])
  assert.equal(data.meta.clips['fx/compactor-wave-cell'].chain?.cellDelay, 0.25, 'the wave chain delay the shockwave reads')
})

test('the unreachable list is still unreachable', () => {
  for (const rel of UNREACHABLE) {
    const stem = rel.replace(/\.ts$/, '').split('/').pop() as string
    const importers = sourceFiles(SRC).filter((file) => {
      if (relative(SRC, file) === rel) return false
      return new RegExp(`from ['"][./]+(?:[\\w/]*/)?${stem}['"]`).test(readFileSync(file, 'utf8'))
    })
    assert.deepEqual(importers.map((f) => relative(SRC, f)), [], `${rel} is imported now; check its sprite names`)
  }
})
