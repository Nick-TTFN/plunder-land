import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import Multiplayer from './multiplayer'
import { type AccountStore, adminStoreOf, type AdminStore } from '../db/accounts'
import { NotReadyError } from '../db/pgstore'
import { levelOf } from '../progress/xp'
import { energyView } from '../progress/energy'
import { type GearInstance, type GearRoll, type GearTier, gearStatById, GEAR_TIERS, Q_MAX, rollCount, STASH_MAX } from '../utils/gear'
import { skillById } from '../utils/skills'

/**
 * Admin endpoints behind a key (decision #50, Nick 2026-10-05: "admin behind
 * key"), to test locked content on live. **Fail closed:** without
 * `ADMIN_KEY`, or with one shorter than `ADMIN_KEY_MIN` characters, every
 * `/admin` path is answered exactly as an unknown route (`handle` returns
 * false and the server's own 404 answers), and so is any request without the
 * right `Authorization: Bearer <key>`, so nothing says the routes exist.
 *
 * The key is never logged, reported or echoed: only its SHA-256 is kept, and
 * a presented key is hashed too and compared with `timingSafeEqual`, so
 * neither its length nor its bytes leak through timing. Every authorised
 * call logs one line: method, route, target public id, status and outcome;
 * no body. Store-only: nothing here touches a world, so a player in a run
 * sees a change at their next connect or run, like a season payout.
 *
 * Routes (JSON, the target a public account id, `Multiplayer.ID_SHAPE`):
 * - `GET  /admin/account/:id`: id, xp, level, energy (as of now), loadouts,
 *   stash items and away counts.
 * - `POST /admin/account/:id/xp { xp }`: set the total XP (0..`ADMIN_XP_MAX`).
 * - `POST /admin/account/:id/energy { stock }`: set the stock (0..99) as of now.
 * - `POST /admin/account/:id/gear { items: [{ tier, skill, rolls: [[stat, q]] }] }`:
 *   insert stashed items (source 3, admin), all or none within `STASH_MAX`.
 */

/** The shortest `ADMIN_KEY` that turns the routes on. */
export const ADMIN_KEY_MIN = 32
/** The most a request body may be. */
export const ADMIN_BODY_MAX = 16 * 1024
/** The most total XP an admin may set: about level 380 at today's curve, far past anything locked. */
export const ADMIN_XP_MAX = 10_000_000
/** The most plays an admin may set. */
export const ADMIN_STOCK_MAX = 99

/** Whether `key` turns admin on. */
export function adminKeyUsable (key: string | undefined): key is string {
  return typeof key === 'string' && key.length >= ADMIN_KEY_MIN
}

function sha256 (text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest()
}

/**
 * One item as `/admin/account/:id/gear` takes it, held to exactly the shape a
 * found or merged item has (`rollGear`): tier 1-`GEAR_TIERS` (4); skill 0 (a part) or a
 * skill this build knows; a part has no rolls, a skill item `rollCount(tier)`
 * rolls on different stats, each `[stat, q]` with a stat that can roll at
 * that tier and q an integer 0..1000. Undefined for anything else.
 */
export function adminGearOf (value: unknown): GearInstance | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { tier, skill, rolls } = value as { tier?: unknown, skill?: unknown, rolls?: unknown }
  if (typeof tier !== 'number' || !Number.isInteger(tier) || tier < 1 || tier > GEAR_TIERS) return undefined
  if (typeof skill !== 'number' || !Number.isInteger(skill) || (skill !== 0 && skillById(skill) === undefined)) return undefined
  if (!Array.isArray(rolls) || rolls.length !== (skill === 0 ? 0 : rollCount(tier))) return undefined
  const out: GearRoll[] = []
  for (const roll of rolls) {
    if (!Array.isArray(roll) || roll.length !== 2) return undefined
    const [stat, q] = roll as unknown[]
    if (typeof stat !== 'number' || !Number.isInteger(stat)) return undefined
    const range = gearStatById(stat)?.ranges[tier - 1]
    if (range === undefined || range === null) return undefined
    if (out.some((r) => r.stat === stat)) return undefined
    if (typeof q !== 'number' || !Number.isInteger(q) || q < 0 || q > Q_MAX) return undefined
    out.push({ stat, q })
  }
  return { tier: tier as GearTier, skill, rolls: out }
}

/** `{ items }` of a gear grant: 1..`STASH_MAX` valid items, or undefined. */
export function adminGearItems (body: unknown): GearInstance[] | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const { items } = body as { items?: unknown }
  if (!Array.isArray(items) || items.length === 0 || items.length > STASH_MAX) return undefined
  const out: GearInstance[] = []
  for (const value of items) {
    const item = adminGearOf(value)
    if (item === undefined) return undefined
    out.push(item)
  }
  return out
}

/** An integer field `name` of a JSON object body within `[min, max]`, or undefined. */
function intField (body: unknown, name: string, min: number, max: number): number | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const value = (body as Record<string, unknown>)[name]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined
}

/** A request body that broke a rule: answered with `status`. */
class BodyError extends Error {
  constructor (readonly status: number, readonly outcome: string) {
    super(outcome)
  }
}

/**
 * The body as JSON, at most `ADMIN_BODY_MAX` bytes kept (413 past it, 400
 * when not JSON). An oversized body is read to its end and dropped, so the
 * client gets the 413 rather than a reset; past `ADMIN_DRAIN_MAX` the
 * connection is cut instead.
 */
async function readJson (req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'])
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = Number.isFinite(declared) && declared > ADMIN_BODY_MAX
    let done = false
    const fail = (e: Error): void => {
      if (done) return
      done = true
      reject(e)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > ADMIN_BODY_MAX) over = true
      if (size > ADMIN_DRAIN_MAX) {
        fail(new BodyError(413, 'body too large'))
        req.destroy()
        return
      }
      if (!over) chunks.push(chunk)
    })
    req.on('error', fail)
    req.on('close', () => { fail(new BodyError(400, 'body cut short')) })
    req.on('end', () => {
      if (over) {
        fail(new BodyError(413, 'body too large'))
        return
      }
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        done = true
        resolve(body)
      } catch {
        fail(new BodyError(400, 'malformed json'))
      }
    })
  })
}

/** The most of an oversized body read and dropped before the connection is cut. */
const ADMIN_DRAIN_MAX = 64 * ADMIN_BODY_MAX

export interface AdminOptions {
  /** `process.env.ADMIN_KEY`. */
  key: string | undefined
  store: AccountStore
  now?: () => number
  /** Where the per-call line goes; `console.log` in the server. */
  log?: (line: string) => void
}

interface Answer {
  status: number
  outcome: string
  body: unknown
}

/**
 * The `/admin` routes. `handle` is called by the HTTP server for every
 * request before its 404: it returns false (and writes nothing) for any
 * request it doesn't take, which is every request while admin is off, every
 * path outside `/admin`, and every `/admin` request without the key.
 */
export class Admin {
  readonly enabled: boolean
  private readonly keyHash: Buffer | undefined
  private readonly store: (AccountStore & AdminStore) | undefined
  private readonly now: () => number
  private readonly log: (line: string) => void
  /** Denied requests are logged at most once a minute, with how many there were. */
  private deniedAt = -Infinity
  private denied = 0

  constructor (options: AdminOptions) {
    this.store = adminStoreOf(options.store)
    this.enabled = adminKeyUsable(options.key) && this.store !== undefined
    this.keyHash = this.enabled ? sha256(options.key as string) : undefined
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? console.log
  }

  /** The boot line: on or off, never the key. */
  get bootLine (): string {
    return this.enabled ? 'admin: on' : 'admin: off'
  }

  /** Whether `header` carries the key: both sides hashed, so the compare is over two 32-byte buffers. */
  authorised (header: string | undefined): boolean {
    if (this.keyHash === undefined) return false
    const match = typeof header === 'string' ? /^Bearer (.+)$/i.exec(header) : null
    const presented = sha256(match === null ? '' : match[1])
    return timingSafeEqual(presented, this.keyHash) && match !== null
  }

  handle (req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.enabled) return false
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/admin' && !path.startsWith('/admin/')) return false
    if (!this.authorised(req.headers.authorization)) {
      this.noteDenied()
      return false
    }
    const method = req.method ?? ''
    const read = /^\/admin\/account\/([^/]+)$/.exec(path)
    const write = /^\/admin\/account\/([^/]+)\/(xp|energy|gear)$/.exec(path)
    let route: string
    let id: string
    let run: () => Promise<Answer>
    if (method === 'GET' && read !== null) {
      route = '/admin/account/:id'
      id = read[1]
      run = async () => await this.readAccount(id)
    } else if (method === 'POST' && write !== null) {
      const what = write[2]
      route = `/admin/account/:id/${what}`
      id = write[1]
      run = async () => await this.writeAccount(id, what, await readJson(req))
    } else {
      this.answer(res, method, 'unknown route', '-', { status: 404, outcome: 'unknown route', body: { error: 'unknown route' } })
      return true
    }
    if (!Multiplayer.ID_SHAPE.test(id)) {
      this.answer(res, method, route, '-', { status: 400, outcome: 'malformed id', body: { error: 'malformed id' } })
      return true
    }
    run().then((answer) => { this.answer(res, method, route, id, answer) }, (e) => {
      if (e instanceof BodyError) {
        this.answer(res, method, route, id, { status: e.status, outcome: e.outcome, body: { error: e.outcome } })
      } else if (e instanceof NotReadyError) {
        this.answer(res, method, route, id, { status: 503, outcome: 'store not ready', body: { error: 'store not ready' } })
      } else {
        const name = e instanceof Error ? e.name : 'error'
        this.answer(res, method, route, id, { status: 500, outcome: `failed (${name})`, body: { error: 'store failed' } })
      }
    })
    return true
  }

  private async readAccount (id: string): Promise<Answer> {
    const store = this.store as AccountStore & AdminStore
    const account = await store.adminRead(id)
    if (account === null) return unknownAccount()
    return {
      status: 200,
      outcome: 'ok',
      body: {
        id: account.publicId,
        xp: account.xp,
        level: levelOf(account.xp),
        energy: energyView(account.energy, this.now()),
        loadouts: account.loadouts,
        stash: { items: account.stashed, away: account.away }
      }
    }
  }

  private async writeAccount (id: string, what: string, body: unknown): Promise<Answer> {
    const store = this.store as AccountStore & AdminStore
    if (what === 'xp') {
      const xp = intField(body, 'xp', 0, ADMIN_XP_MAX)
      if (xp === undefined) return malformed(`xp must be an integer 0..${ADMIN_XP_MAX}`)
      const total = await store.adminSetXp(id, xp)
      if (total === null) return unknownAccount()
      return { status: 200, outcome: `ok xp=${total}`, body: { id, xp: total, level: levelOf(total) } }
    }
    if (what === 'energy') {
      const stock = intField(body, 'stock', 0, ADMIN_STOCK_MAX)
      if (stock === undefined) return malformed(`stock must be an integer 0..${ADMIN_STOCK_MAX}`)
      const now = this.now()
      const record = await store.adminSetEnergy(id, stock, now)
      if (record === null) return unknownAccount()
      return { status: 200, outcome: `ok stock=${record.stock}`, body: { id, energy: energyView(record, now) } }
    }
    const items = adminGearItems(body)
    if (items === undefined) return malformed('items must be 1..100 valid gear items')
    const granted = await store.adminGrantGear(id, items)
    if (granted === null) return unknownAccount()
    if (granted.inserted < items.length) {
      return { status: 409, outcome: `stash full room=${granted.room}`, body: { error: 'stash full', room: granted.room } }
    }
    return {
      status: 200,
      outcome: `ok inserted=${granted.inserted}`,
      body: { id, inserted: granted.inserted, stash: { items: granted.stash.filter((r) => !r.carried).length, away: granted.stash.filter((r) => r.carried).length } }
    }
  }

  private answer (res: ServerResponse, method: string, route: string, id: string, answer: Answer): void {
    this.log(`admin: ${method} ${route} ${id} ${answer.status} ${answer.outcome}`)
    if (res.headersSent || res.writableEnded) return
    res.writeHead(answer.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(answer.body))
  }

  private noteDenied (): void {
    this.denied++
    const now = this.now()
    if (now - this.deniedAt < 60_000) return
    this.log(`admin: denied ${this.denied} request(s) without the key since the last note`)
    this.deniedAt = now
    this.denied = 0
  }
}

function unknownAccount (): Answer {
  return { status: 404, outcome: 'unknown account', body: { error: 'unknown account' } }
}

function malformed (why: string): Answer {
  return { status: 400, outcome: 'malformed body', body: { error: why } }
}
