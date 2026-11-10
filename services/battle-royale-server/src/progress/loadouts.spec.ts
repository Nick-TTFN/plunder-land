import test from 'node:test'
import assert from 'node:assert/strict'
import { type Account } from '../db/accounts'
import { SELECTABLE_ROBOTS } from '../utils/archetypes'
import {
  LOADOUT_SIZE, LOADOUT_SLOTS, MAX_LOADOUTS, PLAYER_SKILLS, SKILL_INFO, SKILL_LIST, START_KIT,
  checkLoadout, loadoutLevel, loadoutSlotsAt, skillById
} from '../utils/skills'
import { kitFor, loadoutsFor, parseSave } from './loadouts'
import { xpToReach } from './xp'
import {
  LEGACY_KEYS, LEGACY_SLOTS, SKILL_KEYS, canClear, clear, helloSkills, loadoutOf, mergeSaved, parseLoadouts,
  parseRemembered, parseSaved, rememberedIndex, skillLocked, slotsFor, swap, tabLabel, tabLocked, withLoadout
} from '../../../../plunder-land-client/src/net/loadout'

/**
 * Skill loadouts' numbers and pure rules (decision #48 step 4): the mirrored
 * table pinned against Dez's v1 (`ideas/meta-progression-numbers.md` section
 * 3, accepted as a draft 2026-10-02), the one validation rule, the server's
 * `kitFor` / `parseSave` / `loadoutsFor`, and the client's pixi-free half
 * (`net/loadout.ts`). The socket-level rules are network/loadouts.spec.ts.
 */

function account (xp: number, loadouts: Account['loadouts'] = []): Account {
  return { publicId: '0123456789abcdef', persisted: true, xp, loadouts, energy: null }
}

/** The total XP at the start of `level`. */
const at = (level: number): number => xpToReach(level)

// --- the numbers ---------------------------------------------------------------

// DELIBERATE CHANGE (#58 addendum 2, Q7): Melee 1 -> 2, Defend 2 -> 3.
// DELIBERATE CHANGE (Nick 2026-11-10, melee retired, unlocks one step earlier): was Defend 3, Stone Wall 6,
// Fireball 4, Icicle 9, Ice Breath 11, and Melee a player skill.
test('SKILL_INFO: ids, keys and unlock levels; Melee retired, Defend at 2, Fireball 3, Stone Wall 5, Icicle 8, Ice Breath 10', () => {
  assert.deepEqual(SKILL_LIST.map((s) => [s.id, s.key, s.unlockLevel]), [
    [1, 'dash', 1],
    [2, 'melee', 2],
    [3, 'ranged', 1],
    [4, 'defend', 2],
    [5, 'stoneWall', 5],
    [6, 'fireball', 3],
    [7, 'icicle', 8],
    [8, 'iceBreath', 10]
  ])
  assert.deepEqual(SKILL_LIST.filter((s) => s.retired === true).map((s) => s.key), ['melee'])
  for (const info of SKILL_LIST) assert.equal(SKILL_INFO[info.key], info)
  assert.equal(skillById(0), undefined)
  assert.equal(skillById(9), undefined)
  assert.equal(skillById('1'), undefined)
  assert.equal(skillById(6)?.key, 'fireball')
})

// DELIBERATE CHANGE (#58 addendum 2, Q7): was Q Dash, W Melee, E Ranged.
// DELIBERATE CHANGE (#59, 2026-11-05): was Q Dash, W Ranged
test('START_KIT is Q Ranged, W Dash, E and R empty; 4 slots; loadouts 1/2/3/4 at levels 1/10/15/20', () => {
  assert.deepEqual([...START_KIT], [3, 1, 0, 0])
  assert.ok(Object.isFrozen(START_KIT))
  assert.equal(LOADOUT_SIZE, 4)
  assert.deepEqual(LOADOUT_SLOTS.map((r) => [r.level, r.slots]), [[1, 1], [10, 2], [15, 3], [20, 4]])
  assert.equal(MAX_LOADOUTS, 4)
  const expected: Array<[number, number]> = [[1, 1], [9, 1], [10, 2], [14, 2], [15, 3], [19, 3], [20, 4], [99, 4]]
  for (const [level, slots] of expected) assert.equal(loadoutSlotsAt(level), slots, `level ${level}`)
  assert.deepEqual([0, 1, 2, 3, 4].map(loadoutLevel), [1, 10, 15, 20, undefined])
  // The start kit is valid at level 1: everyone can play it.
  // DELIBERATE CHANGE (#59, 2026-11-05): was Q Dash, W Ranged
  assert.deepEqual(checkLoadout(START_KIT, 1), [3, 1, 0, 0])
})

// --- checkLoadout -----------------------------------------------------------------

test('checkLoadout: the one rule, and it returns a fresh copy', () => {
  const ok = [1, 3, 0, 0]
  const copy = checkLoadout(ok, 1)
  assert.deepEqual(copy, ok)
  assert.notEqual(copy, ok)
  // DELIBERATE CHANGE (Nick 2026-11-10, melee retired, unlocks one step earlier): was Melee at 2, Defend at 3, IceBreath at 11,
  // and the malformed rows below padded with Melee (2), now refused for Melee alone.
  assert.deepEqual(checkLoadout([4, 1, 3, 0], 2), [4, 1, 3, 0], 'Defend at level 2')
  assert.deepEqual(checkLoadout([6, 1, 3, 4], 3), [6, 1, 3, 4], 'Fireball at level 3')
  assert.deepEqual(checkLoadout([8, 0, 0, 0], 10), [8, 0, 0, 0])
  const refused: Array<[unknown, number, string]> = [
    [[4, 1, 3, 0], 1, 'Defend at level 1'],
    [[6, 1, 3, 0], 2, 'Fireball at level 2'],
    [[2, 1, 3, 0], 1, 'Melee at level 1'],
    [[2, 1, 3, 0], 99, 'Melee (retired) at level 99'],
    [[8, 6, 4, 1], 9, 'IceBreath at level 9'],
    [[1, 1, 3, 0], 99, 'a duplicate'],
    [[9, 0, 0, 1], 99, 'an unknown id'],
    [[255, 0, 0, 1], 99, 'an unknown id'],
    [[1, 4, 3], 99, '3 entries'],
    [[1, 4, 3, 0, 0], 99, '5 entries'],
    [[1.5, 4, 3, 0], 99, 'a non-integer'],
    [['1', 4, 3, 0], 99, 'a string'],
    [[-1, 4, 3, 0], 99, 'a negative'],
    [[0, 0, 0, 0], 99, 'all empty'],
    [[null, 4, 3, 0], 99, 'a null'],
    [{ 0: 1, 1: 4, 2: 3, 3: 0, length: 4 }, 99, 'an array-like'],
    ['1,4,3,0', 99, 'a string'],
    [undefined, 99, 'nothing']
  ]
  for (const [skills, level, why] of refused) assert.equal(checkLoadout(skills, level), undefined, why)
})

test('Melee (2) is retired: checkLoadout refuses it at levels 1, 2 and 50; PLAYER_SKILLS leaves it out; skillById still reads it', () => {
  // Nick 2026-11-10, "remove melee": the id stays reserved and readable (ids are append-only).
  for (const level of [1, 2, 50]) {
    assert.equal(checkLoadout([2, 0, 0, 0], level), undefined, `Melee alone at level ${level}`)
    assert.equal(checkLoadout([3, 1, 2, 0], level), undefined, `Melee beside Ranged and Dash at level ${level}`)
  }
  assert.deepEqual(checkLoadout([3, 1, 0, 0], 50), [3, 1, 0, 0], 'the same kit without Melee is valid')
  assert.ok(!PLAYER_SKILLS.some((info) => info.id === 2), 'PLAYER_SKILLS holds Melee')
  assert.deepEqual(PLAYER_SKILLS.map((info) => info.id), [1, 3, 4, 5, 6, 7, 8])
  assert.equal(skillById(2), SKILL_INFO.melee)
  assert.equal(skillById(2)?.key, 'melee')
  assert.equal(skillById(2)?.retired, true)
})

// --- kitFor --------------------------------------------------------------------------

test('kitFor: the stored row checked at the account\'s level now, else the whole start kit', () => {
  const row = (robot: string, index: number, skills: unknown): Account['loadouts'][number] => ({ robot, index, skills: skills as number[] })
  // DELIBERATE CHANGE (#59, 2026-11-05): was Q Dash, W Ranged
  const KIT = [3, 1, 0, 0]
  assert.deepEqual(kitFor(undefined, 'peep', 0), KIT, 'no account')
  // DELIBERATE CHANGE (Nick 2026-11-10, melee retired, unlocks one step earlier): the row was [4, 1, 2, 3] (Defend, Melee), now
  // [4, 1, 3, 6]: Fireball keeps it locked below level 3.
  assert.deepEqual(kitFor({ ...account(at(20), [row('peep', 0, [4, 1, 3, 6])]), persisted: false }, 'peep', 0), KIT, 'offline')
  assert.deepEqual(kitFor(account(at(3), [row('peep', 0, [4, 1, 3, 6])]), 'peep', 0), [4, 1, 3, 6])
  assert.deepEqual(kitFor(account(at(3) - 1, [row('peep', 0, [4, 1, 3, 6])]), 'peep', 0), KIT, 'locked again one XP short')
  assert.deepEqual(kitFor(account(at(3), [row('peep', 0, [4, 1, 3, 6])]), 'magnet', 0), KIT, 'another robot\'s row')
  assert.deepEqual(kitFor(account(at(20), [row('peep', 1, [4, 1, 3, 6])]), 'peep', 1), [4, 1, 3, 6])
  assert.deepEqual(kitFor(account(at(9), [row('peep', 1, [4, 1, 3, 6])]), 'peep', 1), KIT, 'index 1 at level 9')
  for (const index of [-1, 1.5, '0', 99, null, undefined, {}]) {
    assert.deepEqual(kitFor(account(at(20), [row('peep', 0, [4, 1, 3, 6])]), 'peep', index), KIT, `index ${JSON.stringify(index)}`)
  }
  const kit = kitFor(undefined, 'peep', 0)
  kit[0] = 99
  assert.deepEqual([...START_KIT], KIT, 'kitFor handed out START_KIT itself')
})

// DELIBERATE CHANGE (Nick 2026-11-10, melee retired, unlocks one step earlier): was "Melee plays itself from level 2;
// Defend's from 3". Melee is refused at every level now and Defend opens at 2.
test('a stored row holding retired Melee plays the whole start kit at every level and stays stored; Defend\'s plays from 2 (#58 Q7)', () => {
  // Rows saved when Melee was a player skill and Defend a level-3 one. The
  // whole row fails (48-4: never a partly kept loadout) and stays stored:
  // a Defend row plays again once the account reaches 2; a Melee row never.
  const melee = { robot: 'peep', index: 0, skills: [1, 2, 3, 0] }
  const defend = { robot: 'peep', index: 0, skills: [1, 3, 4, 0] }
  assert.deepEqual(kitFor(account(0, [melee]), 'peep', 0), [...START_KIT], 'Melee at level 1')
  assert.deepEqual(kitFor(account(at(2), [melee]), 'peep', 0), [...START_KIT], 'Melee at level 2')
  assert.deepEqual(kitFor(account(at(50), [melee]), 'peep', 0), [...START_KIT], 'Melee at level 50')
  assert.deepEqual(kitFor(account(at(2) - 1, [defend]), 'peep', 0), [...START_KIT], 'Defend one XP short of 2')
  assert.deepEqual(kitFor(account(at(2), [defend]), 'peep', 0), [1, 3, 4, 0], 'Defend at level 2')
  assert.deepEqual(loadoutsFor(account(0, [melee])).peep, [[...START_KIT]], 'the lobby is told what the join plays')
  assert.deepEqual(loadoutsFor(account(at(2), [defend])).peep, [[1, 3, 4, 0]])
  const kept = account(at(50), [melee])
  kitFor(kept, 'peep', 0)
  loadoutsFor(kept)
  assert.deepEqual(kept.loadouts, [melee], 'the Melee row was changed or dropped')
})

test('parseSave: a selectable robot the level has unlocked, an index the level has, and checkLoadout', () => {
  assert.deepEqual(parseSave({ robot: 'peep', index: 0, skills: [4, 1, 3, 6] }, 3), { robot: 'peep', index: 0, skills: [4, 1, 3, 6] })
  // DELIBERATE CHANGE (Nick 2026-11-10, melee retired, unlocks one step earlier): was "Melee opens at 2 and Defend
  // at 3 (#58 addendum 2, Q7)". Melee is refused at every level, Defend opens at 2 and Fireball at 3.
  assert.equal(parseSave({ robot: 'peep', index: 0, skills: [1, 2, 3, 0] }, 1), undefined, 'Melee at level 1')
  assert.equal(parseSave({ robot: 'peep', index: 0, skills: [1, 2, 3, 0] }, 2), undefined, 'Melee at level 2')
  assert.equal(parseSave({ robot: 'peep', index: 0, skills: [1, 3, 4, 0] }, 1), undefined, 'Defend at level 1')
  assert.deepEqual(parseSave({ robot: 'peep', index: 0, skills: [1, 3, 4, 0] }, 2), { robot: 'peep', index: 0, skills: [1, 3, 4, 0] })
  assert.equal(parseSave({ robot: 'peep', index: 0, skills: [1, 3, 6, 0] }, 2), undefined, 'Fireball at level 2')
  assert.deepEqual(parseSave({ robot: 'peep', index: 0, skills: [1, 3, 6, 0] }, 3), { robot: 'peep', index: 0, skills: [1, 3, 6, 0] })
  assert.deepEqual(parseSave({ robot: 'waddle', index: 3, skills: [8, 7, 6, 5] }, 20), { robot: 'waddle', index: 3, skills: [8, 7, 6, 5] })
  // Each refused for its own reason: the skills were [1, 2, 3, 0] and the like, which Melee alone refuses now.
  const refused: Array<[unknown, number]> = [
    [null, 20], ['x', 20], [[1, 4, 3, 0], 20],
    [{ robot: 'grunt', index: 0, skills: [1, 4, 3, 0] }, 20],
    [{ robot: 'Peep', index: 0, skills: [1, 4, 3, 0] }, 20],
    [{ robot: 5, index: 0, skills: [1, 4, 3, 0] }, 20],
    [{ robot: 'peep', index: 1, skills: [1, 4, 3, 0] }, 9],
    [{ robot: 'peep', index: -1, skills: [1, 4, 3, 0] }, 20],
    [{ robot: 'peep', index: '0', skills: [1, 4, 3, 0] }, 20],
    [{ robot: 'peep', index: 0, skills: [4, 1, 3, 0] }, 1],
    [{ robot: 'peep', index: 0, skills: [1, 1, 4, 3] }, 20]
  ]
  for (const [data, level] of refused) assert.equal(parseSave(data, level), undefined, JSON.stringify(data))
  // A robot the level hasn't unlocked (#48 step 5): Hopper opens at 7, Waddle at 11.
  // DELIBERATE CHANGE (Nick 2026-11-10, melee retired, unlocks one step earlier): was Hopper 8 (refused at 7), Waddle 12 (refused at 11)
  assert.equal(parseSave({ robot: 'hopper', index: 0, skills: [5, 4, 0, 1] }, 6), undefined, 'Hopper at level 6')
  assert.deepEqual(parseSave({ robot: 'hopper', index: 0, skills: [5, 4, 0, 1] }, 7), { robot: 'hopper', index: 0, skills: [5, 4, 0, 1] })
  assert.equal(parseSave({ robot: 'waddle', index: 0, skills: [1, 4, 3, 0] }, 10), undefined, 'Waddle at level 10')
  assert.deepEqual(parseSave({ robot: 'waddle', index: 0, skills: [1, 4, 3, 0] }, 11), { robot: 'waddle', index: 0, skills: [1, 4, 3, 0] })
})

test('loadoutsFor: every selectable robot, as many loadouts as the level has, each kitFor\'s answer', () => {
  const saved = account(at(10), [
    { robot: 'peep', index: 1, skills: [4, 6, 0, 1] },
    // DELIBERATE CHANGE (Nick 2026-11-10, melee retired, unlocks one step earlier): was [8, 0, 0, 0],
    // IceBreath locked at 10; it opens at 10 now and no player skill is locked there, so the refused row is Melee's.
    { robot: 'magnet', index: 0, skills: [2, 0, 0, 0] } // retired Melee: plays the start kit
  ])
  const out = loadoutsFor(saved)
  assert.deepEqual(Object.keys(out), [...SELECTABLE_ROBOTS])
  for (const robot of SELECTABLE_ROBOTS) assert.equal(out[robot].length, 2)
  // DELIBERATE CHANGE (#59, 2026-11-05): was Q Dash, W Ranged
  assert.deepEqual(out.peep, [[3, 1, 0, 0], [4, 6, 0, 1]])
  assert.deepEqual(out.magnet, [[3, 1, 0, 0], [3, 1, 0, 0]])
  assert.deepEqual(loadoutsFor(account(0)).hopper, [[3, 1, 0, 0]])
  // Locked robots stay, with their stored rows (#48 step 5): at level 1 all
  // five, and a Waddle row saved before locks is what Waddle will play once
  // it opens, not the start kit.
  // Ranged and Dash: a row valid at level 1 (Melee no longer is, #58).
  const early = loadoutsFor(account(0, [{ robot: 'waddle', index: 0, skills: [3, 1, 0, 0] }]))
  assert.deepEqual(Object.keys(early), [...SELECTABLE_ROBOTS])
  assert.deepEqual(early.waddle, [[3, 1, 0, 0]])
})

// --- the client's half (net/loadout.ts) --------------------------------------------------

test('client slotsFor: a kit is Q W E R in its order; no kit is the legacy eight on Q to I', () => {
  assert.deepEqual(slotsFor([8, 6, 4, 1]), { ids: [8, 6, 4, 1], keys: ['q', 'w', 'e', 'r'] })
  assert.deepEqual(slotsFor(undefined), { ids: [1, 2, 3, 4, 5, 6, 7, 8], keys: ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i'] })
  assert.deepEqual([...SKILL_KEYS], ['q', 'w', 'e', 'r'])
  assert.deepEqual([...LEGACY_SLOTS], [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual([...LEGACY_KEYS], ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i'])
  assert.deepEqual(helloSkills([1, 2, 3, 0]), [1, 2, 3, 0])
  for (const bad of [undefined, null, [1, 2, 3], [1, 2, 3, 0, 0], [1, 2, 3, 0.5], [1, 2, 3, -1], ['1', 2, 3, 0], {}]) {
    assert.equal(helloSkills(bad), undefined, JSON.stringify(bad))
  }
})

test('client picker: swap, clear and canClear never make a loadout checkLoadout refuses', () => {
  // DELIBERATE CHANGE (Nick 2026-11-10, melee retired, unlocks one step earlier): the loadouts held Melee (2), which no
  // loadout may now; Fireball (6, level 3) and Defend (4, level 2) play its parts, and the
  // exhaustive levels follow the new unlocks (1, 2, 3, 5, 10; were 1, 2, 3, 6, 11).
  // Put a skill into a slot; one already equipped swaps with what was there.
  assert.deepEqual(swap([1, 6, 3, 0], 3, 4, 3), [1, 6, 3, 4])
  assert.deepEqual(swap([1, 6, 3, 4], 0, 3, 3), [3, 6, 1, 4], 'a swap')
  assert.deepEqual(swap([1, 6, 3, 0], 3, 1, 3), [0, 6, 3, 1], 'moving into the empty slot leaves its old one empty')
  assert.deepEqual(swap([1, 6, 3, 0], 3, 5, 3), [1, 6, 3, 0], 'a locked skill changes nothing')
  assert.deepEqual(swap([1, 3, 0, 0], 2, 4, 1), [1, 3, 0, 0], 'Defend at level 1 changes nothing')
  assert.deepEqual(swap([1, 3, 0, 0], 2, 4, 2), [1, 3, 4, 0])
  assert.deepEqual(swap([1, 3, 0, 0], 2, 2, 99), [1, 3, 0, 0], 'retired Melee changes nothing at any level')
  assert.deepEqual(swap([1, 6, 3, 0], 3, 9, 99), [1, 6, 3, 0], 'an unknown skill changes nothing')
  assert.deepEqual(swap([1, 6, 3, 0], 4, 1, 99), [1, 6, 3, 0], 'a slot out of range changes nothing')
  assert.equal(canClear([1, 0, 0, 0], 0), false, 'the last skill')
  assert.deepEqual(clear([1, 0, 0, 0], 0), [1, 0, 0, 0])
  assert.equal(canClear([1, 4, 0, 0], 2), false, 'an empty slot')
  assert.equal(canClear([1, 4, 0, 0], 1), true)
  assert.deepEqual(clear([1, 4, 0, 0], 1), [1, 0, 0, 0])
  // Exhaustive at a few levels: every move from every valid loadout stays valid.
  for (const level of [1, 2, 3, 5, 10]) {
    const valid = [[1, 4, 3, 0], [1, 3, 0, 0], [3, 0, 0, 0], [4, 1, 0, 3], [6, 4, 1, 3]].map((l) => checkLoadout(l, level)).filter((l): l is number[] => l !== undefined)
    for (const loadout of valid) {
      for (let slot = 0; slot < 4; slot++) {
        for (const info of SKILL_LIST) assert.ok(checkLoadout(swap(loadout, slot, info.id, level), level) !== undefined)
        assert.ok(checkLoadout(clear(loadout, slot), level) !== undefined)
      }
    }
  }
  // DELIBERATE CHANGE (Nick 2026-11-10, melee retired, unlocks one step earlier): was Defend locked at 2 and open at 3,
  // Melee locked at 1 and open at 2.
  assert.equal(skillLocked(4, 1), true)
  assert.equal(skillLocked(4, 2), false)
  assert.equal(skillLocked(6, 2), true)
  assert.equal(skillLocked(6, 3), false)
  assert.equal(skillLocked(0, 99), true)
})

test('client tabs and the remembered index: locked tabs say the level, and a locked index plays 0', () => {
  assert.deepEqual([0, 1, 2, 3].map((i) => tabLabel(i, 1)), ['1', 'LV 10', 'LV 15', 'LV 20'])
  assert.deepEqual([0, 1, 2, 3].map((i) => tabLabel(i, 15)), ['1', '2', '3', 'LV 20'])
  assert.equal(tabLocked(1, 9), true)
  assert.equal(tabLocked(1, 10), false)
  assert.deepEqual(parseRemembered('{"peep":1,"magnet":"2","hopper":9,"waddle":-1,"periscope":3}'), { peep: 1, periscope: 3 })
  for (const raw of [null, '', 'not json', '[1]', 'null', '5']) assert.deepEqual(parseRemembered(raw), {}, String(raw))
  assert.equal(rememberedIndex({ peep: 1 }, 'peep', 10), 1)
  assert.equal(rememberedIndex({ peep: 1 }, 'peep', 9), 0, 'a tab locked again by a curve change')
  assert.equal(rememberedIndex({}, 'peep', 20), 0)
})

test('client account.loadouts and loadout_saved: parse, read, merge; busy changes nothing', () => {
  const loadouts = parseLoadouts({ peep: [[4, 1, 2, 3], 'bad'], magnet: 'bad' })
  // DELIBERATE CHANGE (#59, 2026-11-05): was Q Dash, W Ranged (every start-kit literal in this test)
  assert.deepEqual(loadouts, { peep: [[4, 1, 2, 3], [3, 1, 0, 0]] })
  assert.equal(parseLoadouts(undefined), undefined)
  assert.equal(parseLoadouts([]), undefined)
  assert.deepEqual(loadoutOf(loadouts, 'peep', 0), [4, 1, 2, 3])
  assert.deepEqual(loadoutOf(loadouts, 'peep', 3), [3, 1, 0, 0], 'a missing loadout is the start kit')
  assert.deepEqual(loadoutOf(loadouts, 'hopper', 0), [3, 1, 0, 0], 'a missing robot is the start kit')
  assert.deepEqual(withLoadout(undefined, 'hopper', 2, [3, 0, 0, 0]), { hopper: [[3, 1, 0, 0], [3, 1, 0, 0], [3, 0, 0, 0]] })

  const answer = parseSaved({ robot: 'peep', index: 0, ok: false, skills: [1, 2, 3, 0] })
  assert.deepEqual(answer, { robot: 'peep', index: 0, ok: false, busy: false, skills: [1, 2, 3, 0] })
  assert.deepEqual(mergeSaved(loadouts, answer as NonNullable<typeof answer>).peep, [[1, 2, 3, 0], [3, 1, 0, 0]], 'a refusal snaps back')
  const busy = parseSaved({ robot: 'peep', index: 0, ok: false, busy: true, skills: [1, 2, 3, 0] })
  assert.deepEqual(mergeSaved(loadouts, busy as NonNullable<typeof busy>), loadouts, 'busy moved a loadout')
  for (const bad of [null, {}, { robot: 'peep', index: 0, ok: true }, { robot: 'peep', index: -1, ok: true, skills: [1, 2, 3, 0] }]) {
    assert.equal(parseSaved(bad), undefined, JSON.stringify(bad))
  }
})
