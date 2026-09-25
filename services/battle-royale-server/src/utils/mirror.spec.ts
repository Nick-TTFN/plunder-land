import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `hex.ts` and `path.ts` exist twice, once per package, the way `vector.ts`
 * already does. That duplication is deliberate - the two packages do not share a
 * build - but it only works while the copies are identical.
 *
 * The client predicts its own route by running the same search over the same
 * window, and the whole reason a destination-cell input model needs no
 * correction traffic is that both sides derive the same path from the same
 * integers. A single divergent constant, a reordered DIRECTIONS entry, or a
 * one-cell difference in WINDOW breaks that silently: the game keeps running and
 * players rubber-band near obstacles, with nothing in any log to explain it.
 */
// archetypes.ts: the archetype ids on the wire and the flags both sides will
// simulate (Hopper's passesObstacles, Periscope's vision). A drifted id draws
// the wrong sprite; a drifted flag makes prediction fight the server.
// items.ts: the item ids on the wire and the fixed slot each kind lives in. A
// drifted slot makes a key use a different item than the readout shows.
const MIRRORED = ['hex.ts', 'path.ts', 'archetypes.ts', 'items.ts']

const SERVER = __dirname
const CLIENT = join(__dirname, '..', '..', '..', '..', 'plunder-land-client', 'src', 'utils')

for (const file of MIRRORED) {
  test(`${file} is identical in both packages`, () => {
    const server = readFileSync(join(SERVER, file), 'utf8')
    const client = readFileSync(join(CLIENT, file), 'utf8')

    assert.equal(
      client,
      server,
      `${file} has drifted between the server and the client. They must stay ` +
      'byte identical - copy one over the other rather than patching both.'
    )
  })
}
