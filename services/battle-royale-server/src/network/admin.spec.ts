import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
// Enter the module graph through multiplayer, as index.ts does.
import './multiplayer'
import { Admin, ADMIN_BODY_MAX, ADMIN_KEY_MIN, ADMIN_XP_MAX, adminGearItems, adminGearOf, adminKeyUsable } from './admin'
import { GEAR_SOURCE, MemoryAccountStore } from '../db/accounts'
import { levelOf } from '../progress/xp'
import { energyView } from '../progress/energy'
import { GEAR_STATS, STASH_MAX } from '../utils/gear'

/**
 * `/admin` behind a key (decision #50) over real HTTP on an ephemeral port:
 * fail closed (no key, a short key, a missing or wrong `Authorization` all
 * answer byte for byte as an unknown route does), the key never in a log line
 * or a response, one log line per call, and each route's validation and
 * store effect on the memory store. The server here falls through to the same
 * bare 404 as index.ts's `createServer` handler.
 */

const KEY = 'k'.repeat(ADMIN_KEY_MIN - 8) + 'Zq9-x_Y2'
const NOW = Date.parse('2026-10-05T12:00:00.000Z')

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

interface Harness {
  admin: Admin
  store: MemoryAccountStore
  logs: string[]
  request: (method: string, path: string, options?: { auth?: string, body?: string }) => Promise<Reply>
  close: () => Promise<void>
}

async function harness (key: string | undefined): Promise<Harness> {
  const store = new MemoryAccountStore()
  const logs: string[] = []
  const admin = new Admin({ key, store, now: () => NOW, log: (line) => { logs.push(line) } })
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthcheck') {
      res.writeHead(200)
      res.end()
      return
    }
    if (admin.handle(req, res)) return
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  const request = async (method: string, path: string, options: { auth?: string, body?: string } = {}): Promise<Reply> =>
    await new Promise((resolve, reject) => {
      const headers: Record<string, string> = {}
      if (options.auth !== undefined) headers.authorization = options.auth
      if (options.body !== undefined) headers['content-type'] = 'application/json'
      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }) })
      })
      req.on('error', reject)
      if (options.body !== undefined) req.write(options.body)
      req.end()
    })
  const close = async (): Promise<void> => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
  return { admin, store, logs, request, close }
}

/** What matters of a reply for "the same as an unknown route": status, body and every header but the date. */
function shape (reply: Reply): unknown {
  const { date: _date, ...headers } = reply.headers
  return { status: reply.status, body: reply.body, headers }
}

const bearer = `Bearer ${KEY}`

test('admin: the key turns it on only from 32 characters; the boot line never holds the key', () => {
  assert.equal(adminKeyUsable(undefined), false)
  assert.equal(adminKeyUsable(''), false)
  assert.equal(adminKeyUsable('x'.repeat(ADMIN_KEY_MIN - 1)), false)
  assert.equal(adminKeyUsable('x'.repeat(ADMIN_KEY_MIN)), true)
  const store = new MemoryAccountStore()
  assert.equal(new Admin({ key: undefined, store }).bootLine, 'admin: off')
  assert.equal(new Admin({ key: 'x'.repeat(ADMIN_KEY_MIN - 1), store }).bootLine, 'admin: off')
  const on = new Admin({ key: KEY, store })
  assert.equal(on.bootLine, 'admin: on')
  assert.equal(on.enabled, true)
})

for (const [label, key] of [['no ADMIN_KEY', undefined], ['an empty ADMIN_KEY', ''], ['a 31-character ADMIN_KEY', KEY.slice(1)]] as const) {
  test(`admin: with ${label} every /admin path, even with that key, answers as an unknown route`, async () => {
    const h = await harness(key)
    try {
      const { account } = await h.store.create()
      const unknownRoute = shape(await h.request('GET', '/no-such-route'))
      const auth = `Bearer ${key ?? KEY}`
      for (const [method, path, body] of [
        ['GET', `/admin/account/${account.publicId}`, undefined],
        ['POST', `/admin/account/${account.publicId}/xp`, '{"xp":100}'],
        ['POST', `/admin/account/${account.publicId}/energy`, '{"stock":50}'],
        ['POST', `/admin/account/${account.publicId}/gear`, '{"items":[{"tier":1,"skill":0,"rolls":[]}]}'],
        ['GET', '/admin'],
        ['GET', '/admin/'],
        ['DELETE', '/admin/anything']
      ] as Array<[string, string, string | undefined]>) {
        assert.deepEqual(shape(await h.request(method, path, { auth, body })), unknownRoute, `${method} ${path}`)
      }
      assert.equal((await h.store.adminRead(account.publicId))?.xp, 0, 'a write went through while off')
      assert.equal((await h.store.adminRead(account.publicId))?.stashed, 0)
      assert.deepEqual(h.logs, [], 'admin logged while off')
    } finally {
      await h.close()
    }
  })
}

test('admin: on, a missing, wrong or malformed Authorization answers as an unknown route, writes nothing, and the key is never logged', async () => {
  const h = await harness(KEY)
  try {
    const { account } = await h.store.create()
    const unknownRoute = shape(await h.request('GET', '/no-such-route'))
    const path = `/admin/account/${account.publicId}/xp`
    for (const auth of [undefined, '', 'Bearer', 'Bearer ', KEY, `Basic ${KEY}`, `Bearer ${KEY}x`, `Bearer ${KEY.slice(0, -1)}`, `Bearer  ${KEY}`, `Bearer ${KEY.toUpperCase()}`]) {
      assert.deepEqual(shape(await h.request('POST', path, { auth, body: '{"xp":100}' })), unknownRoute, String(auth))
      assert.deepEqual(shape(await h.request('GET', `/admin/account/${account.publicId}`, { auth })), unknownRoute, String(auth))
    }
    assert.equal((await h.store.adminRead(account.publicId))?.xp, 0)
    // Denials are noted at most once a minute (the clock here is fixed), never with the key.
    assert.equal(h.logs.length, 1)
    assert.match(h.logs[0], /^admin: denied 1 request/)
    assert.ok(!h.logs.some((line) => line.includes(KEY)))
  } finally {
    await h.close()
  }
})

test('admin: read an account, and an unknown or malformed id', async () => {
  const h = await harness(KEY)
  try {
    const { account, token } = await h.store.create()
    const id = account.publicId
    await h.store.grant(id, 300)
    await h.store.saveLoadout(id, 'peep', 0, [1, 2, 3, 0])
    await h.store.adminGrantGear(id, [{ tier: 1, skill: 0, rolls: [] }, { tier: 1, skill: 0, rolls: [] }])
    const reply = await h.request('GET', `/admin/account/${id}`, { auth: bearer })
    assert.equal(reply.status, 200)
    assert.equal(reply.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(reply.body), {
      id, xp: 300, level: levelOf(300), energy: energyView(null, NOW), loadouts: 1, stash: { items: 2, away: 0 }
    })
    assert.ok(token.length > 0)

    const unknown = await h.request('GET', '/admin/account/0123456789abcdef', { auth: bearer })
    assert.deepEqual([unknown.status, JSON.parse(unknown.body)], [404, { error: 'unknown account' }])
    for (const bad of ['XYZ', '0123', 'g123456789abcdef', '%20', '0'.repeat(33)]) {
      const r = await h.request('GET', `/admin/account/${bad}`, { auth: bearer })
      assert.deepEqual([r.status, JSON.parse(r.body)], [400, { error: 'malformed id' }], bad)
    }
    const route = await h.request('GET', `/admin/account/${id}/nope`, { auth: bearer })
    assert.deepEqual([route.status, JSON.parse(route.body)], [404, { error: 'unknown route' }])
    const method = await h.request('POST', `/admin/account/${id}`, { auth: bearer, body: '{}' })
    assert.equal(method.status, 404)

    // One line per call: method, route, target, status, outcome; never the key.
    assert.deepEqual(h.logs, [
      `admin: GET /admin/account/:id ${id} 200 ok`,
      'admin: GET /admin/account/:id 0123456789abcdef 404 unknown account',
      'admin: GET /admin/account/:id - 400 malformed id',
      'admin: GET /admin/account/:id - 400 malformed id',
      'admin: GET /admin/account/:id - 400 malformed id',
      'admin: GET /admin/account/:id - 400 malformed id',
      'admin: GET /admin/account/:id - 400 malformed id',
      'admin: GET unknown route - 404 unknown route',
      'admin: POST unknown route - 404 unknown route'
    ])
  } finally {
    await h.close()
  }
})

test('admin: set XP and energy; the next join reads them; bad bodies are 400 and write nothing', async () => {
  const h = await harness(KEY)
  try {
    const { account, token } = await h.store.create()
    const id = account.publicId
    const xp = await h.request('POST', `/admin/account/${id}/xp`, { auth: bearer, body: '{"xp":5000}' })
    assert.deepEqual([xp.status, JSON.parse(xp.body)], [200, { id, xp: 5000, level: levelOf(5000) }])
    assert.equal((await h.store.resolve(token))?.xp, 5000)
    const down = await h.request('POST', `/admin/account/${id}/xp`, { auth: bearer, body: '{"xp":0}' })
    assert.deepEqual(JSON.parse(down.body), { id, xp: 0, level: 1 })
    const max = await h.request('POST', `/admin/account/${id}/xp`, { auth: bearer, body: JSON.stringify({ xp: ADMIN_XP_MAX }) })
    assert.equal(max.status, 200)
    for (const body of ['{"xp":-1}', '{"xp":1.5}', '{"xp":"5"}', '{}', '[]', 'null', '5', JSON.stringify({ xp: ADMIN_XP_MAX + 1 }), '{"xp":1e400}', '{"xp":', '']) {
      const r = await h.request('POST', `/admin/account/${id}/xp`, { auth: bearer, body })
      assert.equal(r.status, 400, body)
    }
    assert.equal((await h.store.resolve(token))?.xp, ADMIN_XP_MAX, 'a refused body wrote')

    const energy = await h.request('POST', `/admin/account/${id}/energy`, { auth: bearer, body: '{"stock":42}' })
    assert.deepEqual([energy.status, JSON.parse(energy.body)], [200, { id, energy: energyView({ stock: 42, asOfMs: NOW }, NOW) }])
    assert.deepEqual((await h.store.resolve(token))?.energy, { stock: 42, asOfMs: NOW })
    for (const body of ['{"stock":-1}', '{"stock":100}', '{"stock":2.5}', '{"stock":null}', '{"xp":3}']) {
      const r = await h.request('POST', `/admin/account/${id}/energy`, { auth: bearer, body })
      assert.equal(r.status, 400, body)
    }
    assert.equal((await h.request('POST', `/admin/account/${id}/energy`, { auth: bearer, body: '{"stock":0}' })).status, 200)
    assert.equal((await h.request('POST', `/admin/account/${id}/energy`, { auth: bearer, body: '{"stock":99}' })).status, 200)
    assert.deepEqual((await h.store.resolve(token))?.energy, { stock: 99, asOfMs: NOW })

    const unknown = await h.request('POST', '/admin/account/0123456789abcdef/xp', { auth: bearer, body: '{"xp":10}' })
    assert.equal(unknown.status, 404)
    assert.ok(!h.logs.some((line) => line.includes(KEY)))
    assert.ok(h.logs.every((line) => !line.includes('{')), 'a body reached the log')
  } finally {
    await h.close()
  }
})

const hp = GEAR_STATS.hp.id
const armor = GEAR_STATS.armor.id
const reach = GEAR_STATS.reach.id

test('admin gear: exactly the shapes a found or merged item has; anything else is refused whole', () => {
  // Valid: a part per tier, a T1 skill item (1 roll), T2 and T3 (2 rolls on different stats; reach only at T3).
  for (const item of [
    { tier: 1, skill: 0, rolls: [] },
    { tier: 3, skill: 0, rolls: [] },
    { tier: 1, skill: 4, rolls: [[hp, 0]] },
    { tier: 2, skill: 5, rolls: [[hp, 1000], [armor, 3]] },
    { tier: 3, skill: 8, rolls: [[reach, 500], [armor, 1000]] }
  ]) assert.ok(adminGearOf(item) !== undefined, JSON.stringify(item))
  assert.deepEqual(adminGearOf({ tier: 2, skill: 5, rolls: [[hp, 7], [armor, 3]] }), { tier: 2, skill: 5, rolls: [{ stat: hp, q: 7 }, { stat: armor, q: 3 }] })
  for (const item of [
    null, [], 'x', {},
    { tier: 0, skill: 0, rolls: [] },
    { tier: 4, skill: 0, rolls: [] },
    { tier: 1.5, skill: 0, rolls: [] },
    { tier: '1', skill: 0, rolls: [] },
    { tier: 1, skill: 200, rolls: [[hp, 1]] },
    { tier: 1, skill: -1, rolls: [[hp, 1]] },
    { tier: 1, skill: 0, rolls: [[hp, 1]] },
    { tier: 1, skill: 4, rolls: [] },
    { tier: 1, skill: 4, rolls: [[hp, 1], [armor, 1]] },
    { tier: 2, skill: 4, rolls: [[hp, 1]] },
    { tier: 2, skill: 4, rolls: [[hp, 1], [hp, 2]] },
    { tier: 2, skill: 4, rolls: [[hp, 1], [reach, 2]] },
    { tier: 1, skill: 4, rolls: [[99, 1]] },
    { tier: 1, skill: 4, rolls: [[hp, 1001]] },
    { tier: 1, skill: 4, rolls: [[hp, -1]] },
    { tier: 1, skill: 4, rolls: [[hp, 1.5]] },
    { tier: 1, skill: 4, rolls: [[hp]] },
    { tier: 1, skill: 4, rolls: [[hp, 1, 2]] },
    { tier: 1, skill: 4, rolls: [{ stat: hp, q: 1 }] },
    { tier: 1, skill: 4 }
  ]) assert.equal(adminGearOf(item), undefined, JSON.stringify(item))
  assert.equal(adminGearItems({ items: [] }), undefined, 'no items')
  assert.equal(adminGearItems({ items: Array(STASH_MAX + 1).fill({ tier: 1, skill: 0, rolls: [] }) }), undefined, 'over STASH_MAX')
  assert.equal(adminGearItems({ items: [{ tier: 1, skill: 0, rolls: [] }, { tier: 9, skill: 0, rolls: [] }] }), undefined, 'one bad item')
  assert.equal(adminGearItems([{ tier: 1, skill: 0, rolls: [] }]), undefined, 'a bare array')
})

test('admin gear: inserted stashed as source 3, all or none within STASH_MAX; a bad item writes nothing; a body over 16 KB is 413', async () => {
  const h = await harness(KEY)
  try {
    const { account } = await h.store.create()
    const id = account.publicId
    const path = `/admin/account/${id}/gear`
    const items = [{ tier: 2, skill: 5, rolls: [[hp, 1000], [armor, 3]] }, { tier: 1, skill: 0, rolls: [] }]
    const ok = await h.request('POST', path, { auth: bearer, body: JSON.stringify({ items }) })
    assert.deepEqual([ok.status, JSON.parse(ok.body)], [200, { id, inserted: 2, stash: { items: 2, away: 0 } }])
    const stash = await h.store.loadStash(id)
    assert.deepEqual(stash.map((r) => [r.tier, r.skill, r.rolls, r.source, r.carried]), [
      [2, 5, [{ stat: hp, q: 1000 }, { stat: armor, q: 3 }], GEAR_SOURCE.admin, false],
      [1, 0, [], GEAR_SOURCE.admin, false]
    ])

    const bad = await h.request('POST', path, { auth: bearer, body: JSON.stringify({ items: [items[1], { tier: 1, skill: 4, rolls: [[reach, 1]] }] }) })
    assert.equal(bad.status, 400)
    assert.equal((await h.store.loadStash(id)).length, 2, 'a refused grant wrote')

    // 2 rows; 97 more fit, then 2 don't and 1 does.
    const part = { tier: 1, skill: 0, rolls: [] }
    assert.equal((await h.request('POST', path, { auth: bearer, body: JSON.stringify({ items: Array(STASH_MAX - 3).fill(part) }) })).status, 200)
    const full = await h.request('POST', path, { auth: bearer, body: JSON.stringify({ items: [part, part] }) })
    assert.deepEqual([full.status, JSON.parse(full.body)], [409, { error: 'stash full', room: 1 }])
    assert.equal((await h.store.loadStash(id)).length, STASH_MAX - 1)
    assert.equal((await h.request('POST', path, { auth: bearer, body: JSON.stringify({ items: [part] }) })).status, 200)
    assert.equal((await h.store.loadStash(id)).length, STASH_MAX)

    const huge = JSON.stringify({ items: [part], pad: 'x'.repeat(ADMIN_BODY_MAX) })
    const tooBig = await h.request('POST', `/admin/account/${id}/xp`, { auth: bearer, body: huge })
    assert.equal(tooBig.status, 413)
    assert.equal((await h.store.adminRead(id))?.xp, 0)
    assert.equal(h.logs.at(-1), `admin: POST /admin/account/:id/xp ${id} 413 body too large`)
    assert.ok(!h.logs.some((line) => line.includes(KEY)))
  } finally {
    await h.close()
  }
})

test('admin: a key in a response or a log line never appears, whatever the call', async () => {
  const h = await harness(KEY)
  try {
    const { account } = await h.store.create()
    const replies = await Promise.all([
      h.request('GET', `/admin/account/${account.publicId}`, { auth: bearer }),
      h.request('POST', `/admin/account/${account.publicId}/xp`, { auth: bearer, body: JSON.stringify({ xp: KEY }) }),
      h.request('GET', `/admin/account/${KEY}`, { auth: bearer }),
      h.request('GET', `/admin/${KEY}`, { auth: bearer })
    ])
    for (const reply of replies) assert.ok(!reply.body.includes(KEY) && !JSON.stringify(reply.headers).includes(KEY))
    assert.ok(!h.logs.some((line) => line.includes(KEY)), h.logs.join('\n'))
  } finally {
    await h.close()
  }
})
