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
const ATLASES = ['assets/res/atlas.json', 'assets/res/hex.json', 'assets/res/ground.json', 'assets/res/arena.json', 'assets/res/blasts.json', 'assets/res/peep.json', 'assets/res/magnet.json', 'assets/res/peep-lobby.json', 'assets/res/magnet-lobby.json'].map((f) => join(CLIENT, f))

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
