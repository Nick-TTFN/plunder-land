import test from 'node:test'
import assert from 'node:assert/strict'
// See world.spec.ts: enter the module graph through multiplayer (bomb.ts needs it).
import '../network/multiplayer'
import { NPC_EFFECT } from './npceffects'
import { BOMB_BLAST_EFFECT, BOMB_FUSE_EFFECT } from '../items/bomb'
// The client's copy imports nothing, so it loads here.
import { NPC_EFFECT as CLIENT_NPC_EFFECT } from '../../../../plunder-land-client/src/vfx/npceffects'

/**
 * The NPC effect type numbers (task l1-1, decision #51) are a wire contract:
 * the server sends them in the `effect` record's type byte and the client
 * draws by them. Both tables must agree, and the numbers are the ones
 * assigned centrally for every L1 lane: 9-19, append-only.
 */

test('the client\'s NPC effect table equals the server\'s, name for name', () => {
  assert.deepEqual({ ...CLIENT_NPC_EFFECT }, { ...NPC_EFFECT })
})

test('the NPC effect types are the assigned 9-19, in order, each once', () => {
  assert.deepEqual(Object.entries(NPC_EFFECT), [
    ['kilnLob', 9],
    ['kilnBlast', 10],
    ['reactorTell', 11],
    ['reactorRelease', 12],
    ['coilPulse', 13],
    ['compactorShockwave', 14],
    ['knockback', 15],
    ['slowed', 16],
    ['broodlingPrimed', 17],
    ['broodlingBlast', 18],
    ['broodRelease', 19]
  ])
})

test('no NPC effect type reuses one already on the wire (0-6 skills and blasts, 7-8 bomb)', () => {
  assert.deepEqual([BOMB_FUSE_EFFECT, BOMB_BLAST_EFFECT], [7, 8])
  for (const [name, type] of Object.entries(NPC_EFFECT)) assert.ok(type > BOMB_BLAST_EFFECT && type <= 255, name)
})
