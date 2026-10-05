import test from 'node:test'
import assert from 'node:assert/strict'
import { type Bring, HOLDER_SHAPE, MemoryAccountStore, RECONCILE_AFTER_MS, type Spent } from '../db/accounts'
import { GearLedger, GearTimeoutError, type LedgerStore } from './ledger'
import { tagsFor } from '../errors'
import { type GearInstance } from '../utils/gear'

/**
 * The per-process gear ledger (decision #49, task 49-3) with a fake clock,
 * against fake stores (call order, hung writes) and the memory store (what
 * a heartbeat's reconcile returns).
 */

const T1: GearInstance = { tier: 1, skill: 3, rolls: [{ stat: 1, q: 500 }] }
const T2: GearInstance = { tier: 2, skill: 5, rolls: [{ stat: 2, q: 0 }, { stat: 4, q: 1000 }] }

/** A promise and the functions that settle it. */
function deferred<T> (): { promise: Promise<T>, resolve: (value: T) => void, reject: (e: unknown) => void } {
  let resolve: (value: T) => void = () => {}
  let reject: (e: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** A store whose heartbeat and release are recorded, and answered when the spec says. */
class FakeStore implements LedgerStore {
  readonly calls: string[] = []
  readonly beats: Array<{ held: string[], answer: ReturnType<typeof deferred<number>> }> = []
  autoAnswer = true
  failBeats = false

  async heartbeat (_holder: string, held: readonly string[]): Promise<number> {
    this.calls.push(`heartbeat ${held.join(',')}`)
    const answer = deferred<number>()
    this.beats.push({ held: [...held], answer })
    if (this.failBeats) answer.reject(new Error('heartbeat failed'))
    else if (this.autoAnswer) answer.resolve(0)
    return await answer.promise
  }

  async releaseHolder (): Promise<number> {
    this.calls.push('release')
    return 0
  }
}

function clock (start = Date.parse('2026-10-05T12:00:00.000Z')): { now: () => number, advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

/** A spend answer that carried `ids`. */
function spentWith (ids: string[]): Spent {
  return { ok: true, energy: { stock: 5, asOfMs: 0 }, carried: ids.map((rowId) => ({ ...T1, rowId })) }
}

const carriedOf = (s: Spent): Spent['carried'] => s.carried

test('ledger: a boot id per ledger, shaped as the store wants', () => {
  const a = new GearLedger(new FakeStore())
  const b = new GearLedger(new FakeStore())
  assert.match(a.holder, HOLDER_SHAPE)
  assert.notEqual(a.holder, b.holder)
})

test('ledger: no carry before the first heartbeat lands, nor after heartbeats stop landing', async () => {
  const store = new FakeStore()
  store.autoAnswer = false
  const time = clock()
  const ledger = new GearLedger(store, { now: time.now })
  const asked: Array<Bring | undefined> = []
  const issue = async (bring: Bring | undefined): Promise<Spent> => { asked.push(bring); return spentWith(bring === undefined ? [] : [...bring.ids]) }

  assert.equal(ledger.canCarry, false)
  await ledger.carry(['1'], issue, carriedOf)
  assert.deepEqual(asked, [undefined], 'a carry before any heartbeat')
  // A heartbeat issued but not yet landed: still none.
  const beat = ledger.beat()
  await ledger.carry(['1'], issue, carriedOf)
  assert.deepEqual(asked, [undefined, undefined], 'a carry while the first heartbeat is unanswered')
  assert.deepEqual(ledger.heldIds(), [])
  store.beats[0].answer.resolve(0)
  await beat
  assert.equal(ledger.canCarry, true)
  await ledger.carry(['1'], issue, carriedOf)
  assert.deepEqual(asked[2], { ids: ['1'], holder: ledger.holder })
  assert.deepEqual(ledger.heldIds(), ['1'])

  // Heartbeats that fail: carries stop once the last landed one is FRESH_MS old.
  store.failBeats = true
  const reported: unknown[] = []
  const failing = new GearLedger(store, { now: time.now, report: (e) => { reported.push(e) } })
  await failing.beat()
  assert.equal(reported.length, 1, 'a failed heartbeat was not reported')
  assert.equal(failing.canCarry, false, 'a failed first heartbeat allowed carries')
  time.advance(GearLedger.FRESH_MS - 1)
  assert.equal(ledger.canCarry, true)
  time.advance(1)
  assert.equal(ledger.canCarry, false, 'carries go on with no heartbeat landed for FRESH_MS')
  store.failBeats = false
  store.autoAnswer = true
  await ledger.beat()
  assert.equal(ledger.canCarry, true)
})

test('ledger rule 1: ids are claimed before the carry is issued, and only what was carried stays claimed', async () => {
  const ledger = new GearLedger(new FakeStore())
  await ledger.beat()
  let seenInside: boolean[] = []
  const answer = await ledger.carry(['7', '8', 'junk', '7'], async (bring) => {
    seenInside = ['7', '8'].map((id) => ledger.holds(id))
    assert.deepEqual(bring?.ids, ['7', '8'], 'junk and repeats reached the store')
    return spentWith(['8'])
  }, carriedOf)
  assert.deepEqual(seenInside, [true, true], 'an id was not claimed before the carry was issued')
  assert.deepEqual(answer.carried?.map((c) => c.rowId), ['8'])
  assert.deepEqual(ledger.heldIds(), ['8'], 'an id the carry did not get stayed claimed')

  // Counted: another start asking for 8 and not getting it leaves 8 claimed.
  await ledger.carry(['8', '9'], async () => spentWith(['9']), carriedOf)
  assert.deepEqual(ledger.heldIds().sort(), ['8', '9'], 'a second asker released the first carrier\'s claim')
  // A refused spend (carried []) lets every asked id go.
  await ledger.carry(['10'], async () => ({ ok: false, energy: { stock: 0, asOfMs: 0 }, carried: [] }), carriedOf)
  assert.equal(ledger.holds('10'), false)
})

test('ledger rule 1: a carry that fails or times out lets its ids go and rejects', async () => {
  const ledger = new GearLedger(new FakeStore(), { timeoutMs: 30 })
  await ledger.beat()
  await assert.rejects(ledger.carry(['1', '2'], async () => { throw new Error('store down') }, carriedOf), /store down/)
  assert.deepEqual(ledger.heldIds(), [])
  const hung = deferred<Spent>()
  await assert.rejects(ledger.carry(['3'], async () => await hung.promise, carriedOf), GearTimeoutError)
  assert.deepEqual(ledger.heldIds(), [], 'a timed-out carry kept its claim')
  // It lands late: nothing is re-claimed (the reconcile returns it later).
  hung.resolve(spentWith(['3']))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(ledger.heldIds(), [])
})

test('ledger rule 1: a resolving write lets its ids go when it settles, fails or times out', async () => {
  const ledger = new GearLedger(new FakeStore(), { timeoutMs: 30 })
  await ledger.beat()
  await ledger.carry(['1', '2', '3', '4'], async () => spentWith(['1', '2', '3', '4']), carriedOf)

  const settle = deferred<number>()
  const settling = ledger.resolve(['1'], async () => await settle.promise, 'settle')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ledger.holds('1'), true, 'released before the write settled')
  settle.resolve(1)
  assert.equal(await settling, 1)
  assert.equal(ledger.holds('1'), false)

  await assert.rejects(ledger.resolve(['2'], async () => { throw new Error('store down') }, 'settle'), /store down/)
  assert.equal(ledger.holds('2'), false, 'a failed write kept its claim')

  const hung = deferred<number>()
  await assert.rejects(ledger.resolve(['3'], async () => await hung.promise, 'settle'), GearTimeoutError)
  assert.equal(ledger.holds('3'), false, 'a timed-out settle kept its claim')
  assert.deepEqual(ledger.heldIds(), ['4'])
  hung.resolve(1)
})

test('ledger rule 2: the heartbeat sends held as it was when issued; reconcile spares held ids and fresh carries', async () => {
  const time = clock()
  const memory = new MemoryAccountStore({ clock: time.now })
  // The heartbeat waits for the spec, so a carry can land between its snapshot and its statement.
  let gate: ReturnType<typeof deferred<void>> | undefined
  const sent: string[][] = []
  const store: LedgerStore = {
    heartbeat: async (holder, held) => {
      sent.push([...held])
      if (gate !== undefined) await gate.promise
      return await memory.heartbeat(holder, held)
    },
    releaseHolder: async (holder) => await memory.releaseHolder(holder)
  }
  const ledger = new GearLedger(store, { now: time.now })
  const { account } = await memory.create()
  const ids = (await memory.settleGear(account.publicId, ledger.holder, [], [T1, T2, T1, T2])).stash.map((r) => r.rowId)
  const [x, y, z, w] = ids
  const spend = async (want: string[]): Promise<Spent> => await ledger.carry(want, async (bring) => await memory.spend(account.publicId, time.now(), bring), carriedOf)
  const carried = async (): Promise<string[]> => (await memory.loadStash(account.publicId)).filter((r) => r.carried).map((r) => r.rowId)

  await ledger.beat()
  assert.deepEqual((await spend([x, y])).carried?.map((c) => c.rowId), [x, y])
  // Held ids are never returned, however old.
  time.advance(10 * RECONCILE_AFTER_MS)
  await ledger.beat()
  assert.deepEqual(await carried(), [x, y], 'a held id was returned')

  // A carry issued after the heartbeat's snapshot is spared by the 2-minute guard.
  gate = deferred<void>()
  const beat = ledger.beat()
  assert.deepEqual(sent[sent.length - 1].sort(), [x, y].sort())
  assert.deepEqual((await spend([z])).carried?.map((c) => c.rowId), [z])
  gate.resolve()
  await beat
  gate = undefined
  assert.deepEqual(await carried(), [x, y, z], 'a carry made after the snapshot was returned')

  // A settle that times out lets its ids go; a later heartbeat returns them to the owner,
  // while the ids still held stay carried.
  const slow = new GearLedger(store, { now: time.now, timeoutMs: 20 })
  await slow.beat()
  await slow.carry([w], async (bring) => await memory.spend(account.publicId, time.now(), bring), carriedOf)
  const hung = deferred<void>()
  await assert.rejects(slow.resolve([w], async () => await hung.promise, 'settle'), GearTimeoutError)
  assert.equal(slow.holds(w), false)
  time.advance(RECONCILE_AFTER_MS + 1)
  await slow.beat()
  await ledger.beat()
  assert.deepEqual(await carried(), [x, y, z], 'a timed-out settle\'s row stayed carried, or a held one was returned')
  hung.resolve()
})

test('ledger rule 3: close waits for gear writes in flight, then releases the holder, then stops', async () => {
  const store = new FakeStore()
  const ledger = new GearLedger(store)
  ledger.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ledger.canCarry, true)
  await ledger.carry(['1', '2'], async () => spentWith(['1', '2']), carriedOf)
  const settle = deferred<number>()
  const settling = ledger.resolve(['1'], async () => await settle.promise, 'settle')
  const closing = ledger.close()
  assert.equal(ledger.canCarry, false, 'a carry allowed while closing')
  // A carry asked now spends without gear.
  const late = await ledger.carry(['5'], async (bring) => { assert.equal(bring, undefined); return spentWith([]) }, carriedOf)
  assert.deepEqual(late.carried, [])
  // A write issued while close waits is waited for too.
  const discard = deferred<number>()
  const discarding = ledger.resolve(['2'], async () => await discard.promise, 'discard')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.calls.includes('release'), false, 'released before the writes in flight settled')
  settle.resolve(1)
  await settling
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.calls.includes('release'), false, 'released before a write issued during close settled')
  discard.resolve(1)
  await discarding
  await closing
  assert.equal(store.calls.filter((c) => c === 'release').length, 1)
  // No heartbeat after the release.
  const beats = store.calls.filter((c) => c.startsWith('heartbeat')).length
  await ledger.beat()
  assert.equal(store.calls.filter((c) => c.startsWith('heartbeat')).length, beats, 'a heartbeat after close')
  assert.equal(store.calls[store.calls.length - 1], 'release')
})

test('ledger rule 3: close returns what the holder carries to the stash (memory store)', async () => {
  const time = clock()
  const memory = new MemoryAccountStore({ clock: time.now })
  const ledger = new GearLedger(memory, { now: time.now })
  const { account } = await memory.create()
  const ids = (await memory.settleGear(account.publicId, ledger.holder, [], [T1, T2])).stash.map((r) => r.rowId)
  await ledger.beat()
  await ledger.carry(ids, async (bring) => await memory.spend(account.publicId, time.now(), bring), carriedOf)
  assert.equal((await memory.loadStash(account.publicId)).filter((r) => r.carried).length, 2)
  await ledger.close()
  assert.equal((await memory.loadStash(account.publicId)).filter((r) => r.carried).length, 0)
})

test('ledger: a heartbeat in flight is shared, and a failing one never rejects', async () => {
  const store = new FakeStore()
  store.autoAnswer = false
  const ledger = new GearLedger(store)
  const one = ledger.beat()
  const two = ledger.beat()
  assert.equal(store.beats.length, 1, 'two heartbeats in flight at once')
  store.beats[0].answer.reject(new Error('down'))
  await one
  await two
  assert.equal(ledger.canCarry, false)
})

test('a timeout names its write (decision #50): beat, carry, each resolve call, close, in the message, the property and the Sentry tags', async () => {
  const reports: unknown[] = []
  const store = new FakeStore()
  const hungRelease = deferred<number>()
  store.releaseHolder = async () => await hungRelease.promise
  const ledger = new GearLedger(store, { timeoutMs: 20, report: (e) => { reports.push(e) } })
  await ledger.beat()
  assert.equal(ledger.canCarry, true)

  const hung = deferred<Spent>()
  const opOf = async (pending: Promise<unknown>): Promise<string> => {
    try {
      await pending
    } catch (e) {
      assert.ok(e instanceof GearTimeoutError, String(e))
      assert.equal(e.message, `gear: store write timed out (${e.op})`)
      assert.deepEqual(tagsFor('accounts', e), { where: 'accounts', gear_op: e.op })
      return e.op
    }
    throw new Error('did not time out')
  }
  assert.equal(await opOf(ledger.carry(['1'], async () => await hung.promise, carriedOf)), 'carry')
  assert.equal(await opOf(ledger.resolve(['1'], async () => await hung.promise, 'settle')), 'resolve:settle')
  assert.equal(await opOf(ledger.resolve(['1'], async () => await hung.promise, 'discard')), 'resolve:discard')
  assert.equal(await opOf(ledger.resolve(['1'], async () => await hung.promise, 'uncarry')), 'resolve:uncarry')
  // close waits for the writes in flight: let them land.
  hung.resolve(spentWith([]))

  // The heartbeat and the release report what they swallow.
  store.autoAnswer = false
  await ledger.beat()
  await ledger.close()
  assert.deepEqual(reports.map((e) => (e as GearTimeoutError).op), ['beat', 'close:release'])
  assert.ok(reports.every((e) => e instanceof GearTimeoutError))
  hungRelease.resolve(0)
})

test('Sentry tags: where, plus an error\'s own string reportTags; where always wins', () => {
  assert.deepEqual(tagsFor('loop', new Error('x')), { where: 'loop' })
  assert.deepEqual(tagsFor('loop', 'a string'), { where: 'loop' })
  assert.deepEqual(tagsFor('loop', null), { where: 'loop' })
  assert.deepEqual(tagsFor('loop', { reportTags: { where: 'forged', a: 'b', n: 3 } }), { where: 'loop', a: 'b' })
  assert.deepEqual(tagsFor('accounts', new GearTimeoutError('beat')), { where: 'accounts', gear_op: 'beat' })
})
