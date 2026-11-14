import * as Sentry from '@sentry/node'
import { type Socket } from 'socket.io'
import type Redis from 'ioredis'
import Multiplayer, { type Connection, type Join, type Start, ThrottledLog } from './multiplayer'
import World from '../objects/world'
import { PROTOCOL } from '../utils/protocol'
import { captureError, reportError } from '../errors'
import BotFill from '../bots/fill'
import { humanOn } from '../bots/brain'
import { type Account, type AccountStore, adRefillStoreOf, type FirstRunStore, firstRunStoreOf, MemoryAccountStore, offlineAccount, type PortalStore, portalStoreOf, tokenOf } from '../db/accounts'
import Analytics, { type RunInfo } from '../analytics'
import { buildFirstRun, FIRST_RUN } from '../firstrun/scenario'
import { carryKills } from '../progress/run'
import { NotReadyError } from '../db/pgstore'
// A value import (g2-6c, `runName`), safe here and only here: `Player` is
// already loaded by `./multiplayer` and `../objects/world` above, and no
// module but the server's `index.ts` imports this one, so it sits on no
// cycle. Never import `Player` as a value in `multiplayer.ts` or
// `displayname.ts` (network/displayname.ts says why).
import Player from '../objects/player'
import { levelOf, standingOf } from '../progress/xp'
import { kitFor, loadoutsFor, parseSave } from '../progress/loadouts'
import { creditOf } from '../progress/seasons'
import { adRefillCheck, adRefillView, type EnergyRecord, type EnergyView, energyView } from '../progress/energy'
import { joinLevel } from '../progress/unlocks'
import type { GearLedger } from '../gear/ledger'
import { type GearCounts, gearStoreOf, lineageOf, stashEvent, type StashRunResult } from '../gear/stash'
import type { GearStore, Spent, StashEdits, StashItem } from '../db/accounts'
import { mergedItem, mergeOutcome, parseMerge, parseScrap, stashEditsOf } from '../gear/merge'
import { BRING_LEVEL, type GearInstance } from '../utils/gear'
import { PORTALS, Visit, energyOut, portalOf, visitEnd, visitStart } from './visits'
import { PRIVATE_MAP, PRIVATE_MAP_SIZE } from '../objects/privatemap'
import { type PortalIdentity, type PortalVerifier, portalTokenOf, portalVerifierFromEnv } from './portaltoken'
import { displayNameFor, setPortalName } from './displayname'

/** The one portal whose users are linked to accounts (g2-6b): its handshake name and `account_links.portal`. */
export const LINKED_PORTAL = 'crazygames'

/** What `portal_link { result }` (GA, `src/analytics.ts`) reports. Append-only. */
type PortalLinkResult = 'linked' | 'declined' | 'taken' | 'auto'

/** A connection with a verified CrazyGames token (g2-6b). */
interface PortalState {
  identity: PortalIdentity
  /** Rule 4b: the guest account offered for linking, until `portal_link` or READY answers. */
  pending?: Account
  /** The player said no (or pressed READY first): the account made at READY is not `auto`. */
  declined: boolean
}

/** The `account` event (decision #48; `portal` and `linkable` since g2-6b). */
interface AccountMessage {
  id: string
  token?: string
  offline?: boolean
  portal?: string
  /** With `portal` only (g2-6c): the name this connection's next run is shown under (`Worlds.runName`). */
  name?: string
  linkable?: boolean
  xp?: number
  level?: number
  levelAt?: number
  nextAt?: number
  loadouts?: Record<string, number[][]>
  energy?: EnergyView
}

export interface WorldsOptions {
  /** The tick, sent to every client in `hello`. */
  tickLengthMs: number
  /** Active players a world takes before a run goes to another (`WORLD_CAP`). */
  cap: number
  /** How long a world with no active players stays open (`WORLD_IDLE_MS`). */
  idleMs: number
  /** Shared by every world: stats only (`Multiplayer.connectRedis`). */
  redis: Redis
  mapSize?: number
  /** Humans + bots each world is topped up to (decision #47, `BOT_TARGET`). 0 or absent: no bots. */
  bots?: number
  /** The clock for idle closing. Specs pass their own. */
  now?: () => number
  /** Guest accounts (decision #48). Absent: a `MemoryAccountStore`. */
  accounts?: AccountStore
  /** How long a lookup or creation may take before the connection plays offline. */
  accountTimeoutMs?: number
  /**
   * Active human runs this process takes across all its worlds
   * (`MAX_PLAYERS`, burst-capacity). A start over it is sent `full` and its
   * transport closed, so the client reconnects, perhaps to another worker or
   * replica. Absent or 0: no cap.
   */
  maxPlayers?: number
  /**
   * This process's gear ledger (decision #49, 49-3/49-4), already started:
   * one per process, shared by every world. Absent, or a store without the
   * gear half (`gearStoreOf`): no stash, so nothing is carried in and a run's
   * end writes nothing. Give it the same timeout as `accountTimeoutMs`: its
   * carries and settles are bounded by it, not by `bounded`.
   */
  ledger?: GearLedger
  /**
   * First-run worlds this process keeps open at once (`FIRST_RUN_CAP`,
   * decision #58, provisional). Over it a start plays a normal run and the
   * account stays not done. Absent: `FIRST_RUN_CAP_DEFAULT`.
   */
  firstRunCap?: number
  /**
   * Private worlds this process keeps open at once (`PRIVATE_CAP`, decision
   * #60 Q11, provisional): a start over it is sent `full`. Absent:
   * `PRIVATE_CAP_DEFAULT`; 0 or less: no cap.
   */
  privateCap?: number
  /**
   * Bots a private world is topped up with while its human is on each
   * private layer, top first (`PRIVATE_BOTS`, decision #60 addendum
   * 2026-11-07: 2 on layer 01, 3 on layer 02; `PRIVATE_BOTS_DEFAULT`). Bots,
   * not humans + bots as `bots` counts. A layer past the list's end gets
   * its last value. Absent, empty or all 0: no bots.
   */
  privateBots?: readonly number[]
  /** Starts let through to private worlds per tick (`PRIVATE_OPENS_PER_TICK`); absent: `PRIVATE_OPENS_PER_TICK_DEFAULT`. */
  privateOpensPerTick?: number
  /** A queued start's longest wait before `full` (`PRIVATE_QUEUE_MAX_MS`); absent: `PRIVATE_QUEUE_MAX_MS_DEFAULT`. */
  privateQueueMaxMs?: number
  /** The clock `tickAll` times itself with, in ms (the load signal); absent: `performance.now`. Specs pass their own. */
  tickClock?: () => number
  /**
   * `false`: no layer is private, so every run plays in a shared world holding
   * every layer, as before decision #60 (`privateRuns`). For specs of the
   * shared-world rules (world choice, parties, bot fill, idle, drain). Absent
   * or `true`: the `LAYERS` rows' `owned` flags decide.
   */
  privateRuns?: boolean
  /**
   * CrazyGames token verification (g2-6b). Absent: `portalVerifierFromEnv`
   * (`CRAZYGAMES_GAME_ID`; unset, every token is ignored). Specs pass their own.
   */
  portal?: PortalVerifier
  /**
   * The portals whose players are offered the rewarded-video refill (g2-6d,
   * `AD_REFILL_PORTALS`). Absent: `adRefillPortalsFrom(process.env.AD_REFILL_PORTALS)`,
   * which is empty (off everywhere) when unset.
   */
  adRefillPortals?: readonly string[]
}

/**
 * `AD_REFILL_PORTALS` from the environment (g2-6d): a comma list of portal
 * names as the handshake says them (`PORTALS`, e.g. `crazygames`). Unset or
 * empty: none, so no connection anywhere is offered the refill. **Off until
 * CrazyGames' Full Launch** (R3, g2-10): a rewarded button with no effect
 * during Basic Launch, where CrazyGames disables ads, is a rejection reason.
 * Names that aren't portals are dropped; `other` (any unknown name) never
 * counts.
 */
export function adRefillPortalsFrom (value: string | undefined): readonly string[] {
  if (value === undefined) return []
  return value.split(',').map((part) => part.trim()).filter((part) => part !== 'other' && PORTALS.includes(part))
}

/** The ad outcomes a client may report (`ad_result { result }`, GA). Append-only. */
export const AD_RESULTS: readonly string[] = ['rewarded', 'unavailable', 'adblock', 'failed']

/** `ad_result` reports one connection may send to GA; more are dropped. */
export const AD_RESULTS_PER_CONNECTION = 20

/** The shortest gap between two `energy_ad` requests of one connection; one sooner is refused `busy`. */
export const AD_REQUEST_GAP_MS = 2000

/** What `energy_ad`'s acknowledgement says (g2-6d). */
export interface EnergyAdAnswer {
  ok: boolean
  /**
   * When refused: a limit (`plays_left`, `cooldown`, `daily_cap`), or `off`
   * (not offered to this connection: its portal isn't in the switch, an
   * offline account, a store that can't refill), `in_run`, `busy` (one in
   * flight or too soon), `error` (the store failed or timed out).
   */
  reason?: string
}

/** What `full` suggests the client wait before asking again; it adds its own backoff and jitter. */
export const FULL_RETRY_MS = 2000

/** `FIRST_RUN_CAP` when unset (decision #58, retest-4; provisional). */
export const FIRST_RUN_CAP_DEFAULT = 50

/**
 * Mob clearance, in cells, of the one spawn a first run's handoff joins on
 * (decision #58 addendum 2, Q10): the first real NPC just outside vision.
 * Every other join keeps `World.SPAWN_CLEARANCE`.
 */
export const HANDOFF_CLEARANCE = 6

/**
 * `PRIVATE_OPENS_PER_TICK` when unset (private-15): starts let through to a
 * private world per tick; the rest wait in the queue. See `Worlds.admitOrQueue`.
 */
export const PRIVATE_OPENS_PER_TICK_DEFAULT = 150

/** `PRIVATE_QUEUE_MAX_MS` when unset (private-15, Q-E): a queued start waits this long at most, then gets `full`. */
export const PRIVATE_QUEUE_MAX_MS_DEFAULT = 5000

/**
 * The load levels (private-15, Nick's Q-E 2026-11-07): the smoothed share of
 * the tick `tickAll` takes. Warm from `LOAD_WARM_AT`, hot from `LOAD_HOT_AT`,
 * each falling back only `LOAD_HYSTERESIS` lower. Simulation time only:
 * sending, GC and I/O share the thread, hence the low thresholds.
 */
export const LOAD_COOL = 0
export const LOAD_WARM = 1
export const LOAD_HOT = 2
export const LOAD_WARM_AT = 0.4
export const LOAD_HOT_AT = 0.6
export const LOAD_HYSTERESIS = 0.1
/** The moving average's weight on the newest tick (about five ticks' memory). */
export const LOAD_SMOOTHING = 0.2
/**
 * Ticks a level holds before it may step down (10 s); stepping up is at
 * once. Shedding takes more off the tick than `LOAD_HYSTERESIS`, so without
 * it a world at the edge flapped warm/hot every few ticks (measured at 3000
 * private humans, 2026-11-09), each flip sending bots out and back in.
 */
export const LOAD_HOLD_TICKS = 40

/** A start waiting for a private world (private-15): nothing spent yet. */
interface QueuedStart {
  readonly connection: Connection
  readonly start: Start
  readonly data: unknown
  readonly at: number
}

/**
 * `PRIVATE_CAP` when unset: an emergency stop, not a planning number (#60 Q11,
 * then Q-F and private-15, 2026-11-09). Measured with privatebench
 * `MODE=real` on an M4 Max: with load shedding at hot, the tick reached 89% of
 * 250 ms at ~4900 private humans (223 ms; 293 ms at ~6800). Halved for
 * Railway's slower vCPUs (an assumption, not measured), which also has to
 * cover sending, not in that bench. Below it, a spike waits in the start
 * queue instead of being refused.
 */
export const PRIVATE_CAP_DEFAULT = 2500

/**
 * `PRIVATE_BOTS` when unset (decision #60 addendum 2026-11-07, Nick: "a
 * couple in layer 1, 3-4 on layer 2"; overrides Dez's flat 4 per world;
 * 2026-11-09, Nick: "layer 01 is too busy. definitely less bots", after the
 * map shrink made it a 1000 square, then "do PRIVATE_BOTS=0,2"):
 * bots per private layer, top first, by the layer the human is on.
 */
export const PRIVATE_BOTS_DEFAULT: readonly number[] = Object.freeze([0, 2])

/**
 * `PRIVATE_BOTS` from the environment: a comma list of whole numbers, top
 * layer first ("2,3"), each at least 0. Unset, empty, or any entry not a
 * whole number: `PRIVATE_BOTS_DEFAULT`.
 */
export function privateBotsFrom (value: string | undefined): readonly number[] {
  if (value === undefined || value.trim() === '') return PRIVATE_BOTS_DEFAULT
  const parts = value.split(',').map((part) => part.trim())
  if (!parts.every((part) => /^\d+$/.test(part))) return PRIVATE_BOTS_DEFAULT
  return parts.map((part) => parseInt(part, 10))
}

/** Every private world's map size: the one private map's (`PRIVATE_MAP`, `privatemap.ts`). */
export { PRIVATE_MAP_SIZE }

/**
 * How many dt-0 updates a new private world gets before its human joins, at
 * most (`Worlds.prefill`): the refill places at most one mob, pack and pickup
 * of each kind a tick, so a fresh world is empty, and its spawn clearance
 * would measure nothing. Enough for today's largest count (10 natural loot).
 */
export const PREFILL_TICKS = 32

/**
 * A first-run or private world's one run (`Worlds.firstRunOf`,
 * `Worlds.privateOf`): one human each.
 */
interface OwnRun {
  readonly connection: Connection
  /**
   * The start that began the run: each handoff begins the next world's run
   * with it (robot, loadout, party).
   */
  readonly start: Start
  readonly data: unknown
  /** Its player, once joined. */
  player: Player | undefined
  /** The player stood on the gate this tick: hand off once the tick is done. */
  due: boolean
}

/**
 * Every world in this process (worlds-per-process, decision #39), and the one
 * socket.io server's connections to them.
 *
 * **Every run starts private** (decision #60): in a world of its own holding
 * the private layers (`LayerSpec.owned`: 01-02), with NPCs and bots and no
 * other human (`privates`, `openPrivate`). A pad on its deepest layer hands
 * the run off into a shared world (`padHandoff`), which holds the other
 * layers (03 down) and is picked as below; there humans meet. Three lists,
 * then: `worlds` (shared), `privates` and `firstRuns`, and every reader of
 * one decides about the other two.
 *
 * **A shared world is picked per run, not per connection** (Nick, 2026-09-28): on
 * every pad's handoff (before #60, every `start_requested`), the fullest world with fewer than `cap` active
 * players, ties to the oldest, or a new world when every open one is full.
 * Fill-first keeps worlds lively at low player counts. A connection between
 * runs (on its run card) belongs to no world for assignment; it stays in its
 * last world's Multiplayer, which sends it nothing without a player, until its
 * next run goes elsewhere or the world closes. Moving it detaches it
 * completely (`Multiplayer.release`): it leaves the old Multiplayer and every
 * old object's `knownBy`, so nothing from the old world reaches it again.
 *
 * **Worlds open on demand and close when idle.** There is always at least one.
 * One with no active players for `idleMs` is closed and dropped (`closeIdle`,
 * once a tick), newest first, never the last one open.
 *
 * **The player id is the connection's guest account's** (decision #48). The
 * handshake's `auth.token` is looked up on connect (`accountReady`), so READY
 * doesn't wait on the database; a connection with no or an unknown token gets
 * a new account on its first `start_requested` and is sent `account { id,
 * token }` before that run's `hello`. A store that fails or takes longer than
 * `accountTimeoutMs` gives an offline account instead (fail open, no grants):
 * the run plays, no stats are written and no token is sent, so a returning
 * player's stored token survives the outage. A connection left offline tries
 * again at each later start (`retryAccount`), so one blip doesn't cost a long
 * session on one socket its progress.
 *
 * **XP is granted here at each run's end** (decision #48 step 3, `grant`):
 * once per run, whatever ended it, to a persisted account only (an offline
 * run and a bot earn nothing), and the client is told in a `progress` event.
 * The run's season credit (#48 step 6, `creditOf`) rides in the same store
 * call, so it lands exactly when the XP does; a `season` event follows.
 *
 * **A run costs a play** (decision #48 step 7, `admit`), spent before it
 * begins; an extraction or a server cut-off gives it back (`refundRun`).
 *
 * **Everything runs inside `World.run`** for the world it belongs to: each
 * world's tick and flush, and every socket handler, inside `guarded`. The
 * server sets `World.strict`, so between those no world is current and a stray
 * `World.X` throws a `WrongWorldError` rather than reaching some world.
 */
export default class Worlds {
  /** Open worlds, oldest first. */
  readonly worlds: World[] = []
  /** The loop's tick counter, shared by every world: each client's clock is monotonic. */
  tick = 0
  /**
   * Set by `drain` when the host asks this process to stop (SIGTERM, a
   * deploy): no run starts here any more, the live ones play out.
   */
  draining = false

  private readonly tickLengthMs: number
  private readonly cap: number
  private readonly idleMs: number
  private readonly redis: Redis
  private readonly mapSize: number
  private readonly now: () => number
  private readonly botTarget: number
  /** Each open world's bot fill, when bots are on. */
  private readonly fills = new Map<World, BotFill>()
  /** Each connection's current world: the one whose Multiplayer holds it. */
  private readonly worldOf = new Map<Connection, World>()
  /** When each open world was last seen with no active players. */
  private readonly emptySince = new Map<World, number>()
  /** Every open connection, in a world or not: `drain` reaches the lobby ones too. */
  private readonly connections = new Set<Connection>()
  readonly accounts: AccountStore
  private readonly accountTimeoutMs: number
  private readonly maxPlayers: number
  /** Each connection's account creation while it may still land (`create`). */
  private readonly creating = new WeakMap<Connection, Promise<{ account: Account, token?: string }>>()
  /** CrazyGames token checks (g2-6b). */
  private readonly portal: PortalVerifier
  /** Each connection whose handshake carried a verified CrazyGames token (g2-6b). */
  private readonly portalStates = new WeakMap<Connection, PortalState>()
  /** Connections with a loadout save in flight (`saveLoadout`): at most one each. */
  private readonly saving = new WeakSet<Connection>()
  /** Portals whose players are offered the rewarded refill (`AD_REFILL_PORTALS`, g2-6d). */
  private readonly adRefillPortals: readonly string[]
  /** Each connection's last `energy_ad` (when it arrived) and whether its answer is pending. */
  private readonly adRequests = new WeakMap<Connection, { at: number, pending: boolean }>()
  /** `ad_result` reports sent to GA per connection (`AD_RESULTS_PER_CONNECTION`). */
  private readonly adResults = new WeakMap<Connection, number>()
  /** Runs that spent a play (`admit`), and the account that paid; an extraction gives it back (`refundRun`). */
  private readonly paid = new WeakMap<Player, Account>()
  /** The store's gear half (`gearStoreOf`); undefined: no stash. */
  private readonly gear: (AccountStore & GearStore) | undefined
  private readonly ledger: GearLedger | undefined
  /** The store's merge and scrap (`stashEditsOf`), only beside a gear half; undefined: every merge and scrap answers `store`. */
  private readonly edits: (AccountStore & StashEdits) | undefined
  /** Connections with a merge or scrap in flight (`merge`, `scrap`): at most one each. */
  private readonly stashWriting = new WeakSet<Connection>()
  /** The merge's random; specs replace it. */
  static mergeRandom: () => number = Math.random
  /** Each run's stash rows equipped at its start (`admit`), for `run_end`'s `gear_brought`. */
  private readonly brought = new WeakMap<Player, string[]>()
  /**
   * Each connection's run-end settle while it is in flight (`gearEnded`):
   * the next start waits for it (race 3). Never rejects; bounded by the
   * ledger's timeout.
   */
  private readonly settling = new WeakMap<Connection, Promise<void>>()
  /**
   * Private first-run worlds (decision #58, task retest-4), one player each,
   * **apart from `worlds`**, so nothing that picks, fills or idles a shared
   * world ever sees one: `choose`, bot fill and `closeIdle` read `worlds`
   * only. `activeRuns`, `drained` (and so `full` and a drain) count both.
   * Ticked after the shared ones; each closes once its player hands off or
   * leaves (`tickAll`, the disconnect handler).
   */
  readonly firstRuns: World[] = []
  /** Each open first-run world's run. */
  private readonly firstRunOf = new Map<World, OwnRun>()
  private readonly firstRunCap: number
  /**
   * Private worlds (decision #60), one human each with its bots, holding the
   * private layers (`LayerSpec.owned`) on the one private map. **Apart from
   * `worlds`, like `firstRuns`**: `choose` and `closeIdle` read `worlds`
   * only; `activeRuns`, `drained` (and so `full` and a drain) count these
   * too. Ticked after the shared worlds, each with its own bot fill; each
   * closes once its human has gone (a death, an extraction, a disconnect) or
   * has taken the pad into a shared world (`padHandoff`).
   */
  readonly privates: World[] = []
  /** Each open private world's run. */
  private readonly privateOf = new Map<World, OwnRun>()
  private readonly privateCap: number
  private readonly privateBots: readonly number[]
  /** The layers a private world holds (`LayerSpec.owned`), top first. */
  private readonly privateTags: readonly number[]
  /** The layers a shared world holds: every other one. */
  private readonly sharedTags: readonly number[]
  /** The store's first-run half (`firstRunStoreOf`); undefined: no first runs at all. */
  private readonly firstRunStore: (AccountStore & FirstRunStore) | undefined
  /**
   * Starts waiting for a private world, oldest first (private-15): before
   * `admit`, so nothing is spent while one waits. See `admitOrQueue`.
   */
  private readonly queue: QueuedStart[] = []
  private readonly opensPerTick: number
  private readonly queueMaxMs: number
  /** Private starts let through this tick (reset by `tickAll`). */
  private admittedThisTick = 0
  private readonly tickClock: () => number
  /** The smoothed share of the tick `tickAll` took (`LOAD_SMOOTHING`). */
  private tickShare = 0
  /** `LOAD_COOL`, `LOAD_WARM` or `LOAD_HOT`; see `setLoad`. */
  load = LOAD_COOL
  /** The tick the level last changed (`LOAD_HOLD_TICKS`). */
  private loadSince = 0
  /** Counters for specs and benches: starts queued, refused after the wait, and the longest wait let through, in ms. */
  readonly queueStats = { queued: 0, refused: 0, longestWaitMs: 0 }

  /** Account store failures, throttled; the store is a side channel, like Redis. */
  static ACCOUNTS_LOG = new ThrottledLog('accounts', 60_000)
  /**
   * Sentry hears of account failures once per stretch of them, not once per
   * connection: a database outage fails every join, and Sentry's budget is
   * 30 events per 10 min (errors.ts). The first failure after a success is
   * sent; while failures go on, one more every `ACCOUNTS_REPORT_MS`. The
   * console log above still sees each one, throttled.
   */
  static ACCOUNTS_REPORT_MS = 10 * 60_000
  /** Where those reports go; specs replace it. */
  static accountReport: (e: unknown) => void = (e) => { captureError('accounts', e) }
  /** The clock for `ACCOUNTS_REPORT_MS`; specs replace it. */
  static accountClock: () => number = () => Date.now()
  /** When the current stretch of failures was last sent to Sentry; undefined after a success. */
  private static accountReportedAt: number | undefined

  constructor (options: WorldsOptions) {
    this.tickLengthMs = options.tickLengthMs
    this.cap = options.cap
    this.idleMs = options.idleMs
    // One error listener for every world: one per Multiplayer would pile up
    // with each world ever opened.
    this.redis = Multiplayer.shareRedis(options.redis)
    this.mapSize = options.mapSize ?? 4000
    this.now = options.now ?? (() => Date.now())
    this.botTarget = options.bots ?? 0
    this.accounts = options.accounts ?? new MemoryAccountStore()
    this.portal = options.portal ?? portalVerifierFromEnv()
    this.adRefillPortals = options.adRefillPortals ?? adRefillPortalsFrom(process.env.AD_REFILL_PORTALS)
    this.accountTimeoutMs = options.accountTimeoutMs ?? 3000
    this.maxPlayers = options.maxPlayers ?? 0
    this.gear = gearStoreOf(this.accounts)
    this.ledger = this.gear !== undefined ? options.ledger : undefined
    this.edits = this.gear !== undefined ? stashEditsOf(this.accounts) : undefined
    this.firstRunCap = options.firstRunCap ?? FIRST_RUN_CAP_DEFAULT
    this.firstRunStore = firstRunStoreOf(this.accounts)
    this.privateCap = options.privateCap ?? PRIVATE_CAP_DEFAULT
    this.privateBots = options.privateBots ?? []
    this.opensPerTick = Math.max(1, options.privateOpensPerTick ?? PRIVATE_OPENS_PER_TICK_DEFAULT)
    this.queueMaxMs = options.privateQueueMaxMs ?? PRIVATE_QUEUE_MAX_MS_DEFAULT
    this.tickClock = options.tickClock ?? (() => performance.now())
    // Read here, not at import: a bench may cut `World.LAYERS` first.
    this.privateTags = options.privateRuns === false ? [] : World.LAYERS.filter((layer) => layer.owned === true).map((layer) => layer.tag)
    this.sharedTags = World.TAGS.filter((tag) => !this.privateTags.includes(tag))
    World.strict = true
    this.open()
  }

  /**
   * Runs start private (decision #60): some layers are private and some
   * shared. Otherwise (no row flagged, or every one) every run plays in a
   * shared world holding every layer, as before #60.
   */
  get privateRuns (): boolean {
    return this.privateTags.length > 0 && this.sharedTags.length > 0
  }

  /**
   * A Multiplayer whose runs end through this: XP, the refund and the gear.
   * A first-run world's too, so a run there that ever ended as a run would
   * show (it never should: `Player.runOver` is set first, `handoff`).
   */
  private multiplayer (): Multiplayer {
    const multiplayer = new Multiplayer(this.tickLengthMs, this.redis)
    multiplayer.runEnded = (connection, player, xp) => {
      this.grant(connection, player, xp)
      this.refundRun(connection, player)
    }
    multiplayer.gearEnded = (connection, player) => this.gearEnded(connection, player)
    return multiplayer
  }

  /**
   * A new shared world with its own Multiplayer, not left current. With
   * private runs it holds only the shared layers: its top one (layer 03) has
   * no pads back up (#60 Q3, `WorldOptions.padsUp` off).
   */
  open (): World {
    const world = World.build(this.mapSize, { multiplayer: this.multiplayer(), ...(this.privateRuns ? { layers: this.sharedTags } : {}) })
    world.gearExpired = (item) => { this.discard([item]) }
    this.worlds.push(world)
    return world
  }

  /**
   * A new private world (decision #60) for `run`, in `privates`, never in
   * `worlds`: the private layers on the one private map (private-5; never
   * with `firstRun` or `empty`, which would ignore the map), filled before
   * anyone joins (`prefill`). Its pads (layer 02's down count) mark its run
   * due for `padHandoff`.
   */
  private openPrivate (run: OwnRun): World {
    const world = World.build(PRIVATE_MAP_SIZE, { multiplayer: this.multiplayer(), layers: this.privateTags, map: PRIVATE_MAP, sleepFar: true })
    this.shed(world)
    world.gearExpired = (item) => { this.discard([item]) }
    world.handoff = (player) => {
      const state = this.privateOf.get(world)
      if (state !== undefined && state.player === player) state.due = true
    }
    this.privates.push(world)
    this.privateOf.set(world, run)
    Worlds.prefill(world)
    return world
  }

  /**
   * Top a world up before its first join: dt-0 updates until a pass adds no
   * object (at most `PREFILL_TICKS`), so its mobs and pickups are where the
   * refill puts them and the join's spawn clearance means something. Nothing
   * moves and nothing is sent (no connection yet).
   */
  static prefill (world: World): void {
    World.run(world, () => {
      let count = -1
      for (let i = 0; i < PREFILL_TICKS; i++) {
        world.update(0)
        const now = world.MOBS.length + world.CONSUMABLES.length + world.ITEMS.length + world.GEAR.length
        if (now === count) break
        count = now
      }
    })
  }

  /**
   * A new private first-run world (decision #58): the scenario's small map
   * (`firstrun/scenario.ts`), in `firstRuns`, never in `worlds`. Its gate
   * marks its run due for `handoff`.
   */
  private openFirstRun (): World {
    const world = World.build(FIRST_RUN.mapSize, { multiplayer: this.multiplayer(), firstRun: true })
    World.run(world, () => { buildFirstRun(world) })
    world.handoff = (player) => {
      const state = this.firstRunOf.get(world)
      if (state !== undefined && state.player === player) state.due = true
    }
    this.firstRuns.push(world)
    return world
  }

  /**
   * Humans in `world` whose run is in progress: not dead, not extracted, not a
   * bot. Bots (decision #47) count nowhere this does: world choice and its cap,
   * idle closing, draining.
   */
  static activePlayers (world: World): number {
    let n = 0
    for (const player of world.PLAYERS) if (!player.destroyed && !player.exited && player.bot === undefined) n++
    return n
  }

  /**
   * Where the next run goes. With a party code (an invite, decision #47): the
   * world of a human in a run with the same code, if it is under the cap.
   * Otherwise the fullest world under the cap, ties to the oldest; else a new one.
   */
  choose (party?: string): World {
    if (party !== undefined) {
      for (const world of this.worlds) {
        if (Worlds.activePlayers(world) >= this.cap) continue
        for (const player of world.PLAYERS) {
          if (player.bot === undefined && !player.destroyed && !player.exited && player.connection?.party === party) return world
        }
      }
    }
    let best: World | undefined
    let bestCount = -1
    for (const world of this.worlds) {
      const count = Worlds.activePlayers(world)
      if (count < this.cap && count > bestCount) {
        best = world
        bestCount = count
      }
    }
    return best ?? this.open()
  }

  /** The world a connection is in, if any. */
  worldFor (connection: Connection): World | undefined {
    return this.worldOf.get(connection)
  }

  /** A new socket. It joins no world until it asks for a run. */
  onConnection (socket: Socket): Connection {
    const connection = Multiplayer.connectionFor(socket)
    this.connections.add(connection)
    // The protocol before anything else, so a stale client reloads at the
    // lobby (utils/protocol.ts).
    socket.emit('welcome', { protocol: PROTOCOL })
    const auth = socket.handshake?.auth
    const visit = connection.visit = new Visit(portalOf(auth), Date.now(), tokenOf(auth) === undefined)
    // At once, while the player is still in the lobby: READY doesn't wait on it.
    // A portal token is read only from a client that says it runs on CrazyGames.
    const portalToken = portalOf(auth) === LINKED_PORTAL ? portalTokenOf(auth) : undefined
    const ready = connection.accountReady = this.lookup(connection, tokenOf(auth), portalToken)
    void ready.then((account) => { visitStart(visit, account, this.redis) })
    if (this.draining) Worlds.redirect(connection)
    socket.on('start_requested', (data) => {
      Multiplayer.guarded(() => { this.start(connection, data) })
    })
    // In the lobby or mid-run; needs no world, and takes effect at the next join.
    socket.on('save_loadout', (data) => {
      Multiplayer.guarded(() => { this.saveLoadout(connection, data) })
    })
    // Stash edits (49-5): in the lobby or mid-run, stashed rows only.
    socket.on('merge', (data) => {
      Multiplayer.guarded(() => { this.merge(connection, data) })
    })
    socket.on('scrap', (data) => {
      Multiplayer.guarded(() => { this.scrap(connection, data) })
    })
    // The answer to a `linkable` account (g2-6b rule 4b).
    socket.on('portal_link', (data) => {
      Multiplayer.guarded(() => { this.portalLink(connection, data) })
    })
    // The rewarded-video refill (g2-6d): a request after the client's ad
    // said `rewarded`, answered through its acknowledgement; and every ad's
    // outcome, for GA. Lobby only; the server checks everything.
    socket.on('energy_ad', (_data: unknown, ack?: unknown) => {
      Multiplayer.guarded(() => { this.energyAd(connection, ack) })
    })
    socket.on('ad_result', (data) => {
      Multiplayer.guarded(() => { this.adResult(connection, data) })
    })
    // The HUD's latency readout (client net/latency.ts): answered at once,
    // in no world. A probe without an ack is ignored.
    socket.on('latency', (ack: unknown) => {
      Multiplayer.guarded(() => { if (typeof ack === 'function') ack() })
    })
    // Applied on arrival, as with one world (`Multiplayer.onConnect`).
    socket.on('pointer', (data) => {
      this.inWorld(connection, (mp) => { mp.onPointer(connection, data) })
    })
    socket.on('skill', (data) => {
      this.inWorld(connection, (mp) => { mp.onSkill(connection, data) })
    })
    socket.on('use_item', (data) => {
      this.inWorld(connection, (mp) => { mp.onUseItem(connection, data) })
    })
    socket.on('disconnect', () => {
      visitEnd(visit, connection.account, connection.started ? 'run' : this.draining ? 'drain' : 'lobby')
      connection.closed = true
      // Inside a first run: it ends free and not done (before the release
      // below destroys the player, which would end it as a run). Inside a
      // private world it ends as any run left halfway does (the release).
      const world = this.worldOf.get(connection)
      Multiplayer.guarded(() => { this.leaveFirstRun(connection) })
      this.inWorld(connection, (mp) => { mp.release(connection) })
      this.worldOf.delete(connection)
      this.connections.delete(connection)
      if (world !== undefined && (this.firstRunOf.has(world) || this.privateOf.has(world))) Multiplayer.guarded(() => { this.close(world) })
    })
    return connection
  }

  /** `fn` with the connection's world current, inside `guarded`; nothing if it is in none. */
  private inWorld (connection: Connection, fn: (multiplayer: Multiplayer) => void): void {
    Multiplayer.guarded(() => {
      const world = this.worldOf.get(connection)
      if (world === undefined) return
      World.run(world, () => { fn(world.multiplayer as Multiplayer) })
    })
  }

  /**
   * The account for `token`, or null for none or an unknown one, or an
   * offline account if the store failed. Never rejects. A found (or offline)
   * account is set on the connection and its client told (`account { id }`).
   *
   * With a `portalToken` that verifies (g2-6b), the portal rules instead
   * (`portalLookup`). Without one, or one that doesn't verify, today's rules,
   * **except rule 4d**: a guest token whose account is linked to a portal
   * user counts as no token (a new guest at READY), so a logged-out sibling
   * on the same device never gets the CrazyGames user's account.
   */
  private async lookup (connection: Connection, token: string | undefined, portalToken?: string): Promise<Account | null> {
    if (portalToken !== undefined) {
      const store = portalStoreOf(this.accounts)
      if (store !== undefined && this.portal.enabled) {
        const identity = await this.portal.verify(portalToken)
        if (identity !== null) return await this.portalLookup(connection, store, token, identity)
      }
    }
    if (token === undefined) return null
    try {
      const found = await this.bounded(this.accounts.resolve(token))
      Worlds.accountSuccess()
      // Rule 4d: a linked account is never played through a guest token.
      const account = found?.portal === undefined ? found : null
      if (account !== null) this.setAccount(connection, account)
      return account
    } catch (e) {
      Worlds.accountFailure(e)
      const account = offlineAccount()
      this.setAccount(connection, account)
      return account
    }
  }

  /**
   * The portal rules for a connection whose CrazyGames token verified (g2-6b,
   * docs/accounts.md "Portal accounts"); `auth.token` is consulted only for 4b:
   *
   * - 4a: the user is linked: that account, at once.
   * - 4b: not linked, and `token` resolves to an unlinked guest account: that
   *   account is offered (`account { ..., linkable: true }`, nothing set on
   *   the connection) until `portal_link { accept }` answers; READY first is
   *   a decline.
   * - 4c: not linked, no usable guest token: nothing now, a new linked
   *   account at the first READY (`create`), as a guest's is.
   *
   * The runs are named after the token's username from here on (`setPortalName`).
   * A store that fails gives an offline account, as `lookup` does. Never rejects.
   */
  private async portalLookup (connection: Connection, store: PortalStore, token: string | undefined, identity: PortalIdentity): Promise<Account | null> {
    const state: PortalState = { identity, declined: false }
    this.portalStates.set(connection, state)
    setPortalName(connection, identity.username)
    try {
      const linked = await this.bounded(store.resolvePortal(LINKED_PORTAL, identity.userId))
      Worlds.accountSuccess()
      if (linked !== null) {
        this.setAccount(connection, linked)
        return linked
      }
      if (token !== undefined) {
        const guest = await this.bounded(this.accounts.resolve(token))
        Worlds.accountSuccess()
        if (guest !== null && guest.portal === undefined && !connection.closed) {
          state.pending = guest
          // Not set on the connection: the answer decides which account plays.
          connection.socket.emit('account', { ...this.accountMessage(guest), linkable: true })
        }
      }
      return null
    } catch (e) {
      Worlds.accountFailure(e)
      const account = offlineAccount()
      this.setAccount(connection, account)
      return account
    }
  }

  /**
   * `portal_link { accept }` (g2-6b rule 4b), sent by the client after
   * CrazyGames' own link prompt. Only answers a pending offer; anything but
   * `accept: true` declines. Accepting links the offered guest account to the
   * user (no merge: the guest account becomes theirs); a READY meanwhile
   * waits for it (`accountReady`). Declining leaves the connection to get a
   * new linked account at READY.
   */
  private portalLink (connection: Connection, data: unknown): void {
    const state = this.portalStates.get(connection)
    const guest = state?.pending
    const store = portalStoreOf(this.accounts)
    if (state === undefined || guest === undefined || store === undefined || connection.account !== undefined) return
    state.pending = undefined
    const accept = data !== null && typeof data === 'object' && (data as { accept?: unknown }).accept === true
    if (!accept) {
      state.declined = true
      this.portalEvent(connection, 'declined')
      return
    }
    connection.accountReady = this.linkGuest(connection, store, state.identity, guest)
  }

  /** Rule 4b accepted: the link, then the account it gives (the guest's, or the user's if it was linked meanwhile). Never rejects. */
  private async linkGuest (connection: Connection, store: PortalStore, identity: PortalIdentity, guest: Account): Promise<Account | null> {
    try {
      const result = await this.bounded(store.linkPortal(LINKED_PORTAL, identity.userId, guest.publicId))
      Worlds.accountSuccess()
      let account: Account | null
      if (result === 'linked') {
        account = { ...guest, portal: LINKED_PORTAL }
      } else {
        // Another tab linked this user, or this guest to another user, first.
        account = await this.bounded(store.resolvePortal(LINKED_PORTAL, identity.userId))
        Worlds.accountSuccess()
      }
      Multiplayer.guarded(() => {
        if (account !== null && !connection.closed && connection.account === undefined) this.setAccount(connection, account)
        this.portalEvent(connection, result)
      })
      return account
    } catch (e) {
      // Nothing set: READY makes a new linked account (or plays offline).
      Worlds.accountFailure(e)
      return null
    }
  }

  /** GA `portal_link { result }` (g2-6b), under the connection's account if it has one. */
  private portalEvent (connection: Connection, result: PortalLinkResult): void {
    const visit = connection.visit
    if (visit === undefined) return
    Analytics.send(visit.info(connection.account), 'portal_link', { result })
  }

  /** `promise`, or a rejection after `accountTimeoutMs`. */
  private async bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(`accounts: no answer in ${this.accountTimeoutMs} ms`)) }, this.accountTimeoutMs)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Play under `account` from now on, and tell the client its id (plus the
   * token, for a new account; `offline` for an offline one). An id that
   * isn't `ID_SHAPE` (it becomes a Redis key) is never played under: the
   * connection gets an offline account instead.
   */
  private setAccount (connection: Connection, account: Account, token?: string): void {
    if (!Multiplayer.ID_SHAPE.test(account.publicId)) {
      Worlds.accountFailure(new Error('accounts: an issued id has the wrong shape'))
      account = offlineAccount()
      token = undefined
    }
    connection.account = account
    connection.socket.emit('account', this.accountMessage(account, token, connection))
    if (account.persisted) {
      this.sendSeason(connection, account)
      this.sendStash(connection, account)
    }
  }

  /**
   * The name `connection`'s next run under `account` is shown under, to
   * everyone: what `Multiplayer.startRequested` passes the `Player`
   * constructor (`displayNameFor` with the account's id), through the same
   * `Player.displayName` the constructor applies (the cut to `NAME_MAX`, the
   * profanity and reserved-name filter, the callsign fallback).
   */
  static runName (account: Account, connection: Connection): string {
    return Player.displayName(displayNameFor(account.publicId, connection), account.publicId)
  }

  /**
   * The `account` event for `account`. A linked account (g2-6b) carries
   * `portal` and **never a token**: it is reached through the portal's token,
   * and a stored guest token must not lead back to it (rule 4d). With
   * `connection` it also carries `name`, the name the connection's next run
   * gets (g2-6c: the lobby shows exactly what other players will see).
   */
  private accountMessage (account: Account, token?: string, connection?: Connection): AccountMessage {
    const message: AccountMessage = { id: account.publicId }
    if (!account.persisted) message.offline = true
    else {
      if (account.portal !== undefined) {
        message.portal = account.portal
        if (connection !== undefined) message.name = Worlds.runName(account, connection)
      } else if (token !== undefined) message.token = token
      // The account's standing, for the lobby (decision #48 step 3). An
      // offline account has none: it earns nothing.
      Object.assign(message, standingOf(account.xp))
      // Every robot's loadouts as a join would play them now (#48 step 4).
      // Only here: the mid-run `account` from `grant` carries none, and the
      // client keeps the last ones it had for the same id.
      message.loadouts = loadoutsFor(account)
      // Plays left and when the next comes back (#48 step 7). Only here and
      // in `energy`: an offline account spends nothing and is sent none.
      message.energy = this.energyFor(account, account.energy, connection)
    }
    return message
  }

  /**
   * `stash { items, away }` (decision #49, 49-4) from `loadStash`, which first
   * returns rows a dead process held (the stale return): after `account` on
   * connect and creation, and after a start's carry. Bounded; a failure is an
   * account failure and sends nothing. Never for an offline account, never
   * without a stash, never to a closed socket or one now on another account.
   */
  private sendStash (connection: Connection, account: Account): void {
    const gear = this.gear
    if (gear === undefined || !account.persisted) return
    this.bounded(gear.loadStash(account.publicId)).then((rows) => {
      Worlds.accountSuccess()
      Multiplayer.guarded(() => { this.emitStash(connection, account, rows) })
    }).catch((e) => { Worlds.accountFailure(e) })
  }

  private emitStash (connection: Connection, account: Account, rows: readonly StashItem[], run?: StashRunResult): void {
    if (connection.closed || connection.account !== account) return
    connection.socket.emit('stash', stashEvent(rows, run))
  }

  /**
   * `season` (decision #48 step 6): the account's view of the current season
   * (`SeasonView`), after `account` on connect or creation and after each
   * grant's `progress`. Read like every store call, bounded; a failure is an
   * account failure and sends nothing (the lobby hides the line). Only for a
   * persisted account still on this connection, and never to a closed socket.
   */
  private sendSeason (connection: Connection, account: Account): void {
    this.bounded(this.accounts.season(account.publicId, this.now())).then((view) => {
      Worlds.accountSuccess()
      Multiplayer.guarded(() => {
        if (connection.closed || connection.account !== account) return
        connection.socket.emit('season', view)
      })
    }).catch((e) => { Worlds.accountFailure(e) })
  }

  /**
   * The account again, for a start on a connection whose account is offline
   * (its lookup or creation failed earlier; PLAY AGAIN reuses the socket):
   * the handshake's token is looked up again, with the same timeout, and an
   * account is created only if the store answered that it doesn't know it,
   * or there was none, as on a first play (through `create`, so a creation
   * that timed out earlier is waited on again, not repeated). A stored token
   * is never replaced while its lookup is unanswered. Still failing: the
   * connection keeps its offline account and this run plays offline. Never
   * rejects.
   */
  private async retryAccount (connection: Connection): Promise<void> {
    const token = tokenOf(connection.socket.handshake?.auth)
    const portal = this.portalStates.get(connection)
    const store = portalStoreOf(this.accounts)
    try {
      if (portal !== undefined && store !== undefined) {
        // A verified portal user: their linked account, else a new linked one (no offer on a retry).
        const linked = await this.bounded(store.resolvePortal(LINKED_PORTAL, portal.identity.userId))
        Worlds.accountSuccess()
        if (linked !== null) {
          if (!connection.closed) this.setAccount(connection, linked)
          return
        }
      } else if (token !== undefined) {
        const resolved = await this.bounded(this.accounts.resolve(token))
        Worlds.accountSuccess()
        // Rule 4d, as at connect.
        const found = resolved?.portal === undefined ? resolved : null
        if (found !== null) {
          if (!connection.closed) this.setAccount(connection, found)
          return
        }
      }
      if (connection.closed || this.draining) return
      const created = await this.create(connection)
      Worlds.accountSuccess()
      this.setAccount(connection, created.account, created.token)
    } catch (e) {
      Worlds.accountFailure(e)
    }
  }

  /**
   * A new account for `connection`, or a rejection after `accountTimeoutMs`.
   * **At most one creation per connection is in flight:** one the timeout
   * gave up on is kept, and the next try (`retryAccount`, at PLAY AGAIN)
   * waits on that same creation instead of starting another, and takes its
   * account if it landed meanwhile. So a slow store commits one row per
   * connection, not one per try. A creation that fails is forgotten, and the
   * next try creates anew.
   */
  private async create (connection: Connection): Promise<{ account: Account, token?: string }> {
    let pending = this.creating.get(connection)
    if (pending === undefined) {
      const portal = this.portalStates.get(connection)
      const store = portalStoreOf(this.accounts)
      // A verified portal user gets an account linked to them (rules 4b
      // declined, 4c), with no token; anyone else a guest account and its token.
      const created: Promise<{ account: Account, token?: string }> = portal !== undefined && store !== undefined
        ? store.createLinked(LINKED_PORTAL, portal.identity.userId).then((account) => ({ account }))
        : this.accounts.create()
      pending = created
      this.creating.set(connection, created)
      created.catch(() => { if (this.creating.get(connection) === created) this.creating.delete(connection) })
    }
    const result = await this.bounded(pending)
    this.creating.delete(connection)
    return result
  }

  /**
   * A run ended (`Multiplayer.destroy`: a death, an extraction, a disconnect,
   * a drain's cut-off) and earned `xp` (`earnedXp`, 0 for an offline run).
   * Called once per run (`Player.runOver`); granted only to the persisted
   * account the run was played under, never to a bot; one atomic add. Then
   * `progress { gained, xp, level, levelAt, nextAt, levelUp }` goes to the
   * client, unless its socket closed, or it has started another run since:
   * that card is gone, so the new standing goes as `account { id, xp,
   * level, levelAt, nextAt }` instead (a linked account's also `portal` and
   * `name`, g2-6c), which moves the lobby's badge only.
   * A failed or slow grant is logged and reported like any account failure
   * and is not retried: no `progress` is sent, and the card says the XP is
   * unavailable.
   */
  grant (connection: Connection, player: Player, xp: number): void {
    const account = connection.account
    if (player.bot !== undefined || account === undefined || !account.persisted || account.publicId !== player.playerId) return
    // The run's season credit rides in the same statement (decision #48 step
    // 6): its end time picks the season; `player.extracted`, `loot` and the
    // sanitised `name` are still the run's here.
    this.bounded(this.accounts.grant(account.publicId, xp, creditOf(player, xp, this.now()))).then((total) => {
      Worlds.accountSuccess()
      account.xp = total
      Multiplayer.guarded(() => {
        if (connection.closed) return
        const standing = standingOf(total)
        if (connection.player !== undefined && connection.player !== player) {
          // The next run has begun and this run's card is gone, so no
          // `progress` (the client would put it on the new run). The lobby's
          // standing still moves: `account` carries it, mid-run too.
          // A linked account keeps `portal` and `name` (g2-6c): the lobby's
          // name pill reads them from the last `account`.
          const linked = account.portal === undefined ? {} : { portal: account.portal, name: Worlds.runName(account, connection) }
          connection.socket.emit('account', { id: account.publicId, ...linked, ...standing })
        } else {
          connection.socket.emit('progress', { gained: xp, ...standing, levelUp: standing.level > standingOf(total - xp).level })
        }
        this.sendSeason(connection, account)
      })
    }).catch((e) => { Worlds.accountFailure(e) })
  }

  /**
   * `save_loadout { robot, index, skills }` (decision #48 step 4), answered
   * with `loadout_saved { robot, index, ok, skills, busy? }`. Written only for
   * a persisted account, a selectable robot the account's level has unlocked
   * (#48 step 5), a loadout index the account's
   * level has, and skills that pass `checkLoadout` at that level
   * (`parseSave`); anything else is refused and nothing is written. On ok,
   * `skills` is what was stored; on a refusal or a failed write, what a join
   * would play for that robot and index now (`kitFor`), so the lobby snaps
   * back to the truth.
   *
   * **One write in flight per connection**: a save meanwhile is answered
   * `busy` at once and writes nothing; the lobby sends its newest state again
   * when the answer to the first lands. The write is bounded like every store
   * call and a failure is reported as one (`accountFailure`). **The account in
   * memory changes only once the write has resolved**, so a failed write never
   * plays. A write that resolves after the timeout is in the store but not in
   * this connection's account: its next connection reads it.
   */
  saveLoadout (connection: Connection, data: unknown): void {
    const account = connection.account
    const { robot, index } = (data !== null && typeof data === 'object' ? data : {}) as { robot?: unknown, index?: unknown }
    const robotKey = typeof robot === 'string' ? robot.slice(0, 16) : ''
    const indexValue = typeof index === 'number' && Number.isFinite(index) ? index : -1
    const answer = (ok: boolean, skills: number[], busy = false): void => {
      if (connection.closed) return
      connection.socket.emit('loadout_saved', { robot: robotKey, index: indexValue, ok, skills, ...(busy ? { busy: true } : {}) })
    }
    if (this.saving.has(connection)) {
      answer(false, kitFor(account, robotKey, indexValue), true)
      return
    }
    if (account === undefined || !account.persisted) {
      answer(false, kitFor(account, robotKey, indexValue))
      return
    }
    const save = parseSave(data, levelOf(account.xp))
    if (save === undefined) {
      answer(false, kitFor(account, robotKey, indexValue))
      return
    }
    this.saving.add(connection)
    this.bounded(this.accounts.saveLoadout(account.publicId, save.robot, save.index, save.skills)).then(() => {
      Worlds.accountSuccess()
      const i = account.loadouts.findIndex((l) => l.robot === save.robot && l.index === save.index)
      const row = { robot: save.robot, index: save.index, skills: [...save.skills] }
      if (i >= 0) account.loadouts[i] = row
      else account.loadouts.push(row)
      this.saving.delete(connection)
      Multiplayer.guarded(() => { answer(true, [...save.skills]) })
    }, (e) => {
      Worlds.accountFailure(e)
      // Known race (48-4 review N2): when `bounded` gives up after its 3 s the
      // write may still land later, and clearing the mark here lets a retry
      // race it in Postgres, so the stored row can end up older than what
      // this connection plays. It needs a database stall over 3 s; accepted.
      this.saving.delete(connection)
      Multiplayer.guarded(() => { answer(false, kitFor(account, save.robot, save.index)) })
    })
  }

  /**
   * `merge { ids: [a, b, c], keep? }` (decision #49, task 49-5), answered with
   * `merged { ok, item?, reason? }` and then, when the store answered, the
   * account's `stash` read in the same transaction. `item` is the new row in
   * the `stash` event's item shape. Reasons:
   * - `busy`: a merge or scrap of this connection is in flight, or its start
   *   is (`starting`: the start's carry); nothing is written, no `stash`.
   * - `invalid`: malformed (`parseMerge`), no account yet, or the store
   *   refused it (a row missing, another account's, carried, or the rule
   *   said no: `mergeOutcome`); a `stash` follows when the store answered.
   * - `store`: offline, no stash, or the store failed or took over
   *   `accountTimeoutMs`; a fresh `stash` is asked for (it may fail too). A
   *   merge given up on at the timeout may still land: its rows are then
   *   gone and a retry of the same ids is refused `invalid`, never doubled.
   *
   * In the lobby or mid-run: only stashed rows are touched, never anything a
   * run carries. Persisted accounts only.
   */
  merge (connection: Connection, data: unknown): void {
    const answer = (reply: { ok: boolean, item?: ReturnType<typeof mergedItem>, reason?: 'busy' | 'invalid' | 'store' }): void => {
      if (!connection.closed) connection.socket.emit('merged', reply)
    }
    if (this.stashWriting.has(connection) || connection.starting) {
      answer({ ok: false, reason: 'busy' })
      return
    }
    const account = connection.account
    const request = parseMerge(data)
    if (account === undefined || request === undefined) {
      answer({ ok: false, reason: 'invalid' })
      return
    }
    const edits = this.edits
    if (edits === undefined || !account.persisted) {
      answer({ ok: false, reason: 'store' })
      return
    }
    const random = Worlds.mergeRandom
    this.stashWriting.add(connection)
    this.bounded(edits.mergeGear(account.publicId, request.ids, (inputs) => mergeOutcome(inputs, request.keep, random))).then((merged) => {
      Worlds.accountSuccess()
      this.stashWriting.delete(connection)
      Multiplayer.guarded(() => {
        answer(merged.item !== null ? { ok: true, item: mergedItem(merged.item) } : { ok: false, reason: 'invalid' })
        this.emitStash(connection, account, merged.stash)
      })
    }, (e) => {
      Worlds.accountFailure(e)
      this.stashWriting.delete(connection)
      Multiplayer.guarded(() => {
        answer({ ok: false, reason: 'store' })
        this.sendStash(connection, account)
      })
    })
  }

  /**
   * `scrap { id }` (49-5), answered with `scrapped { id, ok, reason? }` (`id`
   * as sent when it was a string, cut to 20 characters, else null; `reason`
   * as for `merged`), then `stash` as after a merge. Deletes the row only if
   * it is this account's and stashed; nothing is paid for it (loot isn't a
   * currency, #48/#49). Same gates as `merge`.
   */
  scrap (connection: Connection, data: unknown): void {
    const raw = data !== null && typeof data === 'object' ? (data as { id?: unknown }).id : undefined
    const echo = typeof raw === 'string' ? raw.slice(0, 20) : null
    const answer = (ok: boolean, reason?: 'busy' | 'invalid' | 'store'): void => {
      if (!connection.closed) connection.socket.emit('scrapped', { id: echo, ok, ...(reason !== undefined ? { reason } : {}) })
    }
    if (this.stashWriting.has(connection) || connection.starting) {
      answer(false, 'busy')
      return
    }
    const account = connection.account
    const id = parseScrap(data)
    if (account === undefined || id === undefined) {
      answer(false, 'invalid')
      return
    }
    const edits = this.edits
    if (edits === undefined || !account.persisted) {
      answer(false, 'store')
      return
    }
    this.stashWriting.add(connection)
    this.bounded(edits.scrapGear(account.publicId, id)).then((scrapped) => {
      Worlds.accountSuccess()
      this.stashWriting.delete(connection)
      Multiplayer.guarded(() => {
        answer(scrapped.ok, scrapped.ok ? undefined : 'invalid')
        this.emitStash(connection, account, scrapped.stash)
      })
    }, (e) => {
      Worlds.accountFailure(e)
      this.stashWriting.delete(connection)
      Multiplayer.guarded(() => {
        answer(false, 'store')
        this.sendStash(connection, account)
      })
    })
  }

  /** Never the token: errors from the store carry none, and nothing here adds it. */
  static accountFailure (e: unknown): void {
    Worlds.ACCOUNTS_LOG.report(e)
    // Not migrated yet is a state the store reports itself (open.ts), once.
    if (e instanceof NotReadyError) return
    const now = Worlds.accountClock()
    const last = Worlds.accountReportedAt
    if (last !== undefined && now - last < Worlds.ACCOUNTS_REPORT_MS) return
    Worlds.accountReportedAt = now
    Worlds.accountReport(e)
  }

  /** The store answered: the next failure starts a new stretch, and is reported. */
  static accountSuccess (): void {
    Worlds.accountReportedAt = undefined
  }

  /**
   * The connection's account once the handshake's lookup is done, creating
   * one if it found none (creation is on first play, decision #48, so lobby
   * bounces and crawlers make no rows). At most one creation per connection:
   * after this the account is set, and `starting` keeps a second start out
   * meanwhile. Never rejects; leaves the account unset only for a connection
   * that closed or a server that started draining while it waited.
   */
  private async accountFor (connection: Connection): Promise<void> {
    await connection.accountReady
    if (connection.account !== undefined || connection.closed || this.draining) return
    const portal = this.portalStates.get(connection)
    if (portal?.pending !== undefined) {
      // Rule 4b: READY before an answer is a decline.
      portal.pending = undefined
      portal.declined = true
      this.portalEvent(connection, 'declined')
    }
    let created: { account: Account, token?: string }
    try {
      created = await this.create(connection)
    } catch (e) {
      Worlds.accountFailure(e)
      this.setAccount(connection, offlineAccount())
      return
    }
    Worlds.accountSuccess()
    this.setAccount(connection, created.account, created.token)
    // Rule 4c: linked without a prompt.
    if (portal !== undefined && !portal.declined && created.account.portal !== undefined) this.portalEvent(connection, 'auto')
  }

  /**
   * `start_requested`. A malformed one, or one while a run is in progress or
   * waiting on the account, moves nothing. Otherwise, once the connection has
   * an account (`accountFor`; at once on its later runs, unless the account
   * is offline, when `retryAccount` tries the store again first) and, for a
   * persisted account, once its play is spent (`admit`, #48 step 7), it goes
   * to `choose()`'s world, leaving its old one first if that is another, and
   * the run starts there.
   *
   * Asynchronous around the account. After the wait no world is current, so
   * the rest runs in `guarded` and `World.run` as on arrival, and checks again
   * that the socket is still open and the server isn't draining.
   */
  /**
   * Whether this start plays a first run (decision #58, retest-4): the client
   * asked (`firstRun`), the account is persisted and has explicitly not done
   * it (`firstRunDone === false`; anything else fails closed to a normal run),
   * the store can record it, no drain, and under `firstRunCap`.
   */
  private firstRunFor (connection: Connection, start: Start): boolean {
    const account = connection.account
    return start.firstRun === true && account !== undefined && account.persisted && account.firstRunDone === false &&
      this.firstRunStore !== undefined && !this.draining && this.firstRuns.length < this.firstRunCap
  }

  start (connection: Connection, data: unknown): void {
    if (connection.started || connection.starting) return
    const start = Multiplayer.parseStart(data)
    if (start === undefined) return
    if (this.draining) {
      // To the next server: the client reconnects and lands in the lobby.
      Worlds.redirect(connection)
      return
    }
    if (this.full || this.privateFull) {
      Worlds.refuseFull(connection)
      return
    }
    if (connection.account?.persisted === true) {
      this.admitOrQueue(connection, start, data)
      return
    }
    connection.starting = true
    // No account yet (the first play), or an offline one to try again.
    const ready = connection.account === undefined ? this.accountFor(connection) : this.retryAccount(connection)
    ready.then(() => {
      Multiplayer.guarded(() => {
        connection.starting = false
        if (connection.closed) return
        if (this.draining) {
          Worlds.redirect(connection)
          return
        }
        this.admitOrQueue(connection, start, data)
      })
    }).catch((e) => {
      connection.starting = false
      reportError('accounts', e)
    })
  }

  /**
   * private-15: a start bound for a private world (not a first run, which
   * opens its own kind of world) is let through to `admit` while fewer than
   * `opensPerTick` have been this tick and nobody is queued ahead of it;
   * otherwise it waits in `queue`, with `starting` set so a repeat start is
   * ignored, and nothing spent: no energy, no carry, no hello. `releaseQueue`
   * lets the queue through at the start of each tick, in order. A first
   * run's pad handoff never comes here (`beginPrivate` with a `join`): that
   * player is mid-run.
   *
   * It bounds the starts let through a tick, not the opens themselves: a
   * persisted account's world opens when its spend comes back, a moment
   * later, so with a slow store the opens of one tick's starts spread out.
   */
  private admitOrQueue (connection: Connection, start: Start, data: unknown): void {
    if (!this.privateRuns || this.firstRunFor(connection, start)) {
      this.admit(connection, start, data)
      return
    }
    if (this.queue.length === 0 && this.admittedThisTick < this.opensPerTick) {
      this.admittedThisTick++
      this.admit(connection, start, data)
      return
    }
    connection.starting = true
    this.queue.push({ connection, start, data, at: this.now() })
    this.queueStats.queued++
  }

  /**
   * Lets queued starts through, oldest first, up to `opensPerTick` a tick.
   * A closed connection is dropped; one waiting past `queueMaxMs`, or one
   * that reaches the front with `privateCap` reached, is sent `full` as
   * today (nothing was spent); a drain redirects every one.
   */
  private releaseQueue (): void {
    const now = this.now()
    while (this.queue.length > 0) {
      const entry = this.queue[0]
      const connection = entry.connection
      if (connection.closed) {
        this.queue.shift()
        continue
      }
      if (this.draining) {
        this.queue.shift()
        connection.starting = false
        Worlds.redirect(connection)
        continue
      }
      if (now - entry.at > this.queueMaxMs || this.privateFull) {
        this.queue.shift()
        connection.starting = false
        this.queueStats.refused++
        Worlds.refuseFull(connection)
        continue
      }
      if (this.admittedThisTick >= this.opensPerTick) break
      this.queue.shift()
      connection.starting = false
      this.admittedThisTick++
      this.queueStats.longestWaitMs = Math.max(this.queueStats.longestWaitMs, now - entry.at)
      Multiplayer.guarded(() => { this.admit(connection, entry.start, entry.data) })
    }
  }

  /** Starts waiting for a private world now (closed ones not yet dropped included). */
  get queued (): number {
    return this.queue.length
  }

  /**
   * The load level from this tick's share of `tickLengthMs`: smoothed, then
   * up a level from `LOAD_WARM_AT`/`LOAD_HOT_AT`, down only below them minus
   * `LOAD_HYSTERESIS`.
   */
  private measureLoad (ms: number): void {
    this.tickShare += LOAD_SMOOTHING * (ms / this.tickLengthMs - this.tickShare)
    const share = this.tickShare
    const up = share >= LOAD_HOT_AT ? LOAD_HOT : share >= LOAD_WARM_AT ? LOAD_WARM : LOAD_COOL
    const down = share >= LOAD_HOT_AT - LOAD_HYSTERESIS ? LOAD_HOT : share >= LOAD_WARM_AT - LOAD_HYSTERESIS ? LOAD_WARM : LOAD_COOL
    const held = this.tick - this.loadSince >= LOAD_HOLD_TICKS
    const next = up > this.load ? up : down < this.load && held ? down : this.load
    if (next !== this.load) this.setLoad(next)
  }

  /**
   * Sheds private-world work by level (private-15, Q-E's order after the
   * queue): warm and hot, far bots think `FAR_THINK_FACTOR` x 2; hot, one
   * private bot fewer per layer (`privateBotsFor`; the extra ones leave by
   * the fill's usual path) and the wake margin at 0. Each knob goes back as
   * the level falls. Shared worlds are never touched. One log line and a
   * Sentry breadcrumb per change.
   */
  setLoad (level: number): void {
    if (level === this.load) return
    const from = this.load
    this.load = level
    this.loadSince = this.tick
    for (const world of this.privates) this.shed(world)
    const names = ['cool', 'warm', 'hot']
    const message = `load: ${names[from]} -> ${names[level]} (tick ${Math.round(this.tickShare * 100)}% of ${this.tickLengthMs} ms, ${this.privates.length} private worlds, ${this.queue.length} queued)`
    console.log(message)
    Sentry.addBreadcrumb({ category: 'load', message, level: level === LOAD_HOT ? 'warning' : 'info' })
  }

  /** `world`'s knobs at the current load level (`setLoad`). */
  private shed (world: World): void {
    world.farThinkFactor = World.FAR_THINK_FACTOR * (this.load >= LOAD_WARM ? 2 : 1)
    world.wakeMargin = this.load >= LOAD_HOT ? 0 : World.WAKE_MARGIN_RINGS
  }

  /**
   * Energy (decision #48 step 7), between the account and the run: a
   * persisted account spends one play first, in one atomic check-and-spend
   * (`AccountStore.spend`), and the run begins only once it is spent. With
   * none left the client is sent `start_refused { reason: 'energy', energy }`
   * and nothing else happens: the connection can ask again. A spent play is
   * remembered with the run (`paid`) and announced in `energy`.
   *
   * **Fail open (Nick, #48 build call 9):** an offline account, or a store
   * that fails or takes longer than `accountTimeoutMs`, plays the run free.
   * (A spend the timeout gave up on may still land; that play is then lost,
   * as a grant's XP is. It needs a database stall over 3 s.) A play spent for
   * a run that then doesn't start (the socket closed, a drain began, the join
   * threw) is given back.
   */
  private admit (connection: Connection, start: Start, data: unknown): void {
    const account = connection.account
    if (account === undefined || !account.persisted) {
      // Offline: no stash, so `bring` is ignored.
      this.begin(connection, start, data)
      return
    }
    connection.starting = true
    // Race 3 (49-3): the last run's settle may still be writing. Its rows are
    // still carried, so a carry now would skip them; wait (bounded by the
    // ledger's timeout) so what it returns can come in again.
    const settle = this.settling.get(connection)
    if (settle === undefined) {
      this.spendAndBegin(connection, account, start, data)
      return
    }
    settle.then(() => {
      Multiplayer.guarded(() => {
        if (connection.closed) {
          connection.starting = false
          return
        }
        if (this.draining) {
          connection.starting = false
          Worlds.redirect(connection)
          return
        }
        this.spendAndBegin(connection, account, start, data)
      })
    }).catch((e) => {
      connection.starting = false
      reportError('accounts', e)
    })
  }

  /**
   * The rows `start.bring` may carry in (decision #49, 49-4), in slot order:
   * none without a stash or below `BRING_LEVEL`. The ledger also refuses to
   * carry before its first heartbeat lands (`GearLedger.canCarry`), and the
   * spend then goes alone.
   */
  private bringFor (account: Account, bring: Array<string | null> | undefined): string[] {
    if (bring === undefined || this.ledger === undefined || this.gear === undefined) return []
    if (joinLevel(account) < BRING_LEVEL) return []
    return bring.filter((id): id is string => id !== null)
  }

  /**
   * The spend (and, with `bring`, the carry in the same transaction), then
   * the run; see `admit`. A carry's answer equips each item in the slot it
   * was asked for. Anything carried that doesn't end up on a live run's
   * player (the run didn't begin, the socket closed, a drain began, an item
   * `equipGear` refused) goes back to the stash (`uncarry`). A store failure
   * or a timeout plays free and with no gear (fail open, as energy).
   */
  private spendAndBegin (connection: Connection, account: Account, start: Start, data: unknown): void {
    // A first run brings nothing in (its private world has no stash to
    // settle into, and it ends without a run's end).
    const ids = this.firstRunFor(connection, start) ? [] : this.bringFor(account, start.bring)
    const ledger = this.ledger
    const gear = this.gear
    const spending: Promise<Spent> = ids.length > 0 && ledger !== undefined && gear !== undefined
      // The ledger bounds a carry itself (and lets its claims go on a
      // timeout); a spend it sends alone (no fresh heartbeat) is bounded here.
      ? ledger.carry(ids, async (bring) => bring === undefined
        ? await this.bounded(this.accounts.spend(account.publicId, this.now()))
        : await gear.spend(account.publicId, this.now(), bring), (spent) => spent.carried)
      : this.bounded(this.accounts.spend(account.publicId, this.now()))
    spending.then((spent) => {
      Worlds.accountSuccess()
      account.energy = spent.energy
      const carried = spent.carried ?? []
      Multiplayer.guarded(() => {
        connection.starting = false
        if (!spent.ok) {
          // A refused spend carries nothing (store contract); return anything all the same.
          this.uncarry(carried)
          if (!connection.closed) connection.socket.emit('start_refused', { reason: 'energy', energy: this.energyFor(account, spent.energy, connection) })
          if (connection.visit !== undefined) energyOut(connection.visit, account)
          return
        }
        if (connection.closed || this.draining || connection.account !== account) {
          this.refund(account)
          this.uncarry(carried)
          if (!connection.closed && this.draining) Worlds.redirect(connection)
          return
        }
        // Each carried item in the slot it was asked for; a slot whose row
        // didn't come back (another tab took it, it was merged) stays empty.
        const slots = (start.bring ?? []).map((id) => id === null ? undefined : carried.find((item) => item.rowId === id))
        let player: Player | undefined
        try {
          this.begin(connection, start, data, carried.length > 0 ? slots : undefined)
          if (connection.started && connection.player?.playerId === account.publicId) player = connection.player
        } finally {
          if (player !== undefined) {
            this.paid.set(player, account)
            connection.socket.emit('energy', this.energyFor(account, spent.energy, connection))
            const equipped = lineageOf(player.gear)
            if (equipped.length > 0) this.brought.set(player, equipped)
            this.uncarry(carried.filter((item) => item.rowId === undefined || !equipped.includes(item.rowId)))
          } else {
            this.refund(account, connection)
            this.uncarry(carried)
          }
          // The lobby's `away` count moved.
          if (carried.length > 0) this.sendStash(connection, account)
        }
      })
    }, (e) => {
      Worlds.accountFailure(e)
      Multiplayer.guarded(() => {
        connection.starting = false
        if (connection.closed) return
        if (this.draining) {
          Worlds.redirect(connection)
          return
        }
        this.begin(connection, start, data)
      })
    })
  }

  /**
   * The energy view of `record` (the account's stock as just read or
   * written) for `connection`, with the rewarded refill's part (`adRefill`,
   * g2-6d) only where it may be offered (`adRefillOn`). Without a
   * connection, none.
   */
  private energyFor (account: Account, record: EnergyRecord | null, connection?: Connection): EnergyView {
    const view = energyView(record, this.now())
    if (connection !== undefined && this.adRefillOn(connection, account)) {
      view.adRefill = adRefillView(record, account.adRefill ?? null, this.now())
    }
    return view
  }

  /**
   * Whether `connection` may be offered the rewarded refill at all (g2-6d):
   * its portal (the handshake's claim; nothing verifies it, the limits are
   * the defence) is in `AD_REFILL_PORTALS`, its account is persisted (an
   * offline one plays free), and the store can refill (`adRefillStoreOf`).
   * Guests count as accounts (decision #62 Q7).
   */
  private adRefillOn (connection: Connection, account: Account | undefined): boolean {
    const portal = connection.visit?.portal
    return portal !== undefined && this.adRefillPortals.includes(portal) &&
      account !== undefined && account.persisted && adRefillStoreOf(this.accounts) !== undefined
  }

  /**
   * `energy_ad` (g2-6d): the client's rewarded ad finished, so it asks for
   * the refill. **The server can't verify the ad was watched** (CrazyGames
   * documents no receipt), so any client can send this; the store grants
   * only within `AD_REFILL` (no play left, one per 30 min, three per UTC
   * day, per account; `adRefillAt`), atomically. Also refused: not offered
   * here (`adRefillOn`), in a run (lobby only: a run started or starting),
   * one already in flight or within `AD_REQUEST_GAP_MS` of the last, one
   * the connection's own view of the account already refuses (`adRefillCheck`
   * on `account.energy`/`account.adRefill`, no store call), and a store that
   * fails or times out (nothing granted; the ad was watched for nothing,
   * which the client says plainly).
   *
   * The answer is the acknowledgement (`EnergyAdAnswer`), and after any store
   * answer an `energy` event with the view as it now stands (the readout,
   * and the limit's timer on a refusal). GA: `energy_ad_granted`, or
   * `energy_ad_refused { reason }` for the store's refusals and failures
   * (the checks before it, the in-memory limits included, are a misbehaving
   * client's noise and send none; the in-memory refusal still emits `energy`).
   */
  private energyAd (connection: Connection, ack: unknown): void {
    const answer = (reply: EnergyAdAnswer): void => {
      if (typeof ack === 'function') ack(reply)
    }
    const account = connection.account
    const store = adRefillStoreOf(this.accounts)
    if (store === undefined || account === undefined || !this.adRefillOn(connection, account)) {
      answer({ ok: false, reason: 'off' })
      return
    }
    if (connection.started || connection.starting) {
      answer({ ok: false, reason: 'in_run' })
      return
    }
    const now = this.now()
    const last = this.adRequests.get(connection)
    if (last !== undefined && (last.pending || now - last.at < AD_REQUEST_GAP_MS)) {
      answer({ ok: false, reason: 'busy' })
      return
    }
    const request = { at: now, pending: false }
    this.adRequests.set(connection, request)
    // Refused by the connection's own view first, so spam costs no store
    // transaction (g2-6d review). The view can only be behind the store
    // towards allowing a refill (refills elsewhere), except a play spent in
    // another tab: then this connection's view shows plays and no button,
    // and its own next READY refreshes it. The store still decides grants.
    const early = adRefillCheck(account.energy, account.adRefill ?? null, now)
    if (!early.ok) {
      connection.socket.emit('energy', this.energyFor(account, account.energy, connection))
      answer({ ok: false, reason: early.reason ?? 'plays_left' })
      return
    }
    request.pending = true
    const visit = connection.visit
    this.bounded(store.adRefill(account.publicId, now)).then((result) => {
      Worlds.accountSuccess()
      account.energy = result.energy
      if (result.adRefill !== null) account.adRefill = result.adRefill
      Multiplayer.guarded(() => {
        request.pending = false
        if (visit !== undefined) {
          if (result.ok) Analytics.send(visit.info(account), 'energy_ad_granted', {})
          else Analytics.send(visit.info(account), 'energy_ad_refused', { reason: result.reason ?? 'plays_left' })
        }
        if (connection.closed || connection.account !== account) return
        connection.socket.emit('energy', this.energyFor(account, result.energy, connection))
        answer(result.ok ? { ok: true } : { ok: false, reason: result.reason ?? 'plays_left' })
      })
    }, (e) => {
      Worlds.accountFailure(e)
      Multiplayer.guarded(() => {
        request.pending = false
        if (visit !== undefined) Analytics.send(visit.info(account), 'energy_ad_refused', { reason: 'error' })
        if (!connection.closed) answer({ ok: false, reason: 'error' })
      })
    })
  }

  /**
   * `ad_result { result }` (g2-6d): how one rewarded-ad request ended on the
   * client (`AD_RESULTS`), to GA as `ad_result { result }` with the visit's
   * `portal`. Only from a connection the refill is offered to, and at most
   * `AD_RESULTS_PER_CONNECTION`; anything else is dropped.
   */
  private adResult (connection: Connection, data: unknown): void {
    if (!this.adRefillOn(connection, connection.account)) return
    const result = data !== null && typeof data === 'object' ? (data as { result?: unknown }).result : undefined
    if (typeof result !== 'string' || !AD_RESULTS.includes(result)) return
    const sent = this.adResults.get(connection) ?? 0
    if (sent >= AD_RESULTS_PER_CONNECTION) return
    this.adResults.set(connection, sent + 1)
    const visit = connection.visit
    if (visit !== undefined) Analytics.send(visit.info(connection.account), 'ad_result', { result })
  }

  /**
   * A run ended: give its play back if it spent one (`admit`) and it
   * extracted, or the server cut it short (`closeAll`: a drain's deadline,
   * Nick's #48 build call 8). A death or the player's own disconnect keeps
   * it spent: only a loss costs a play. Once per run (`runEnded` is).
   */
  refundRun (connection: Connection, player: Player): void {
    const account = this.paid.get(player)
    if (account === undefined) return
    this.paid.delete(player)
    if (player.extracted || connection.cutOff) this.refund(account, connection)
  }

  /**
   * One play back to `account`, then `energy` to `connection` while it is
   * open and still on that account. Bounded and reported like every store
   * call; a failed refund is not retried.
   */
  private refund (account: Account, connection?: Connection): void {
    this.bounded(this.accounts.refund(account.publicId, this.now())).then((record) => {
      Worlds.accountSuccess()
      account.energy = record
      Multiplayer.guarded(() => {
        if (connection === undefined || connection.closed || connection.account !== account) return
        connection.socket.emit('energy', this.energyFor(account, record, connection))
      })
    }).catch((e) => { Worlds.accountFailure(e) })
  }

  /**
   * The run itself: `start` once the connection has its account and, if it
   * pays, its play (`admit`). A start that gets a first run (`firstRunFor`,
   * and no gear) goes to a new first-run world; any other, with private runs
   * (#60), to a new private world of its own, whatever its party code (Q5:
   * the private layers are solo; the code is kept on the connection for the
   * pad); without them, to `choose()`'s shared world.
   */
  private begin (connection: Connection, start: Start, data: unknown, gear?: ReadonlyArray<GearInstance | undefined>): void {
    connection.party = start.party
    if (gear === undefined && this.firstRunFor(connection, start)) {
      this.beginFirstRun(connection, start, data)
      return
    }
    if (this.privateRuns) {
      this.beginPrivate(connection, start, data, gear)
      return
    }
    this.joinIn(connection, this.choose(start.party), data, gear)
  }

  /** The run joins `target` (`startRequested`), the connection leaving its old world first. */
  private joinIn (connection: Connection, target: World, data: unknown, gear?: ReadonlyArray<GearInstance | undefined>, join?: Join): void {
    this.moveTo(connection, target)
    World.run(target, () => { target.multiplayer?.startRequested(connection, data, gear, join) })
  }

  /**
   * A new private world (#60), and the run in it: a start's, or a first
   * run's handoff's (`join`, at `HANDOFF_CLEARANCE`, Q15). A join that throws
   * leaves the world with no human, and the next tick closes it.
   */
  private beginPrivate (connection: Connection, start: Start, data: unknown, gear?: ReadonlyArray<GearInstance | undefined>, join?: Join): void {
    const state: OwnRun = { connection, start, data, player: undefined, due: false }
    const world = this.openPrivate(state)
    this.joinIn(connection, world, data, gear, join)
    if (connection.started) state.player = connection.player
  }

  /** `connection` leaves its world, if it is in another, for `target`. */
  private moveTo (connection: Connection, target: World): void {
    const from = this.worldOf.get(connection)
    if (from === target) return
    if (from !== undefined) World.run(from, () => { from.multiplayer?.release(connection) })
    World.run(target, () => { target.multiplayer?.adopt(connection) })
    this.worldOf.set(connection, target)
  }

  /** The first run (decision #58): a new private world, and the run in it. */
  private beginFirstRun (connection: Connection, start: Start, data: unknown): void {
    const world = this.openFirstRun()
    const state: OwnRun = { connection, start, data, player: undefined, due: false }
    this.firstRunOf.set(world, state)
    this.moveTo(connection, world)
    // A join that throws leaves the world empty, and the next tick closes it.
    World.run(world, () => { world.multiplayer?.startRequested(connection, data) })
    if (connection.started) state.player = connection.player
  }

  /** What a first run's or a private world's analytics events need: its player's run. */
  private static runInfo (player: Player, connection: Connection): RunInfo {
    return { playerId: player.playerId, startedAt: player.createdAt, offline: Multiplayer.isOffline(player), portal: connection.visit?.portal }
  }

  /**
   * The account has done its first run: at once in memory, so no later start
   * on this connection plays another, then in the store, bounded and not
   * waited for. A failed write is reported, not retried: the next connection
   * plays the first run once more (accepted, retest-3).
   */
  private finishFirstRun (account: Account): void {
    account.firstRunDone = true
    const store = this.firstRunStore
    if (store === undefined || !account.persisted) return
    this.bounded(store.finishFirstRun(account.publicId, this.now())).then(() => { Worlds.accountSuccess() }, (e) => { Worlds.accountFailure(e) })
  }

  /**
   * "A single teleport into a regular layer" (decision #58): the first run's
   * player stood on the gate. In order:
   *
   * 1. Its run ends **not as a run**: `runOver` first, so the release below
   *    (which destroys the player) grants no XP, refunds nothing, writes no
   *    Redis stats, sends no `run_end` and settles no gear. A spec drops this
   *    line and sees all of them fire.
   * 2. The account is done (`finishFirstRun`); `first_run_done` to GA.
   * 3. `handoff` to the client, before the new world's `hello`: socket.io
   *    keeps one socket's events in order, so the client resets its world
   *    before any record of the new one arrives (ids from two worlds collide).
   * 4. The run begins in a new private world (decision #60 Q15,
   *    `beginPrivate`; with no private runs, `choose()`'s shared world),
   *    with the start's robot and loadout, on its top layer (01) at a spawn
   *    `HANDOFF_CLEARANCE` from every mob, and carrying the first run's loot,
   *    kills and kill credit (so its XP is paid at the run's end). HP, armor,
   *    time alive and items start fresh. Its `run_start` is this run's one.
   * 5. The play spent at the start moves to the new player (`paid`), so the
   *    run's extraction refunds it as any run's would.
   *
   * Draining, or a `begin` that fails: the client is redirected as a drain
   * does, the account stays done and the play is refunded. Either way the
   * private world closes.
   */
  private handoff (world: World, state: OwnRun): void {
    const { connection, start, data } = state
    const player = state.player
    state.due = false
    try {
      if (player === undefined || player.runOver || player.destroyed || connection.closed || connection.player !== player) return
      player.runOver = true
      const paid = this.paid.get(player)
      this.paid.delete(player)
      const account = connection.account
      if (account !== undefined) this.finishFirstRun(account)
      Analytics.send(Worlds.runInfo(player, connection), 'first_run_done', { seconds: Math.round((Date.now() - player.createdAt) / 1000) })
      connection.socket.emit('handoff', {})
      connection.started = false

      let next: Player | undefined
      if (!this.draining) {
        const join: Join = {
          clearance: HANDOFF_CLEARANCE,
          prepare: (into) => {
            into.loot = player.loot
            into.kills = player.kills
            carryKills(player, into)
          }
        }
        try {
          if (this.privateRuns) this.beginPrivate(connection, start, data, undefined, join)
          else this.joinIn(connection, this.choose(start.party), data, undefined, join)
          if (connection.started && connection.player !== player) next = connection.player
        } catch (e) {
          reportError('handoff', e)
        }
      }
      if (next === undefined) {
        if (paid !== undefined) this.refund(paid, connection)
        if (!connection.closed) Worlds.redirect(connection)
        return
      }
      if (paid !== undefined) this.paid.set(next, paid)
    } finally {
      this.close(world)
    }
  }

  /**
   * A private world's pad (decision #60): its player stood on a pad out of
   * the world, into the shared layers. The run goes on in a shared world, in
   * the first run's order (`handoff`) but with none of its side effects (no
   * `finishFirstRun`, no `first_run_done`):
   *
   * 1. `runOver` first, so the release below (which destroys the player)
   *    grants no XP, refunds nothing, writes no Redis stats, sends no
   *    `run_end` and settles no gear: the run hasn't ended.
   * 2. `private_done { seconds }` to GA (Q16).
   * 3. `handoff` to the client, before the shared world's `hello`.
   * 4. The run joins `choose(start.party)`'s shared world (Q5: a friend's
   *    under the cap, else the fullest), on its top layer (03) at the usual
   *    `SPAWN_CLEARANCE`, carrying **the whole run** (Q6, task private-7):
   *    loot, kills and kill credit; the gear slots, bag and item stacks,
   *    every instance unchanged (`Player.takeCarried`/`giveCarried`); HP and
   *    armor (max values are the robot's with that gear); the run's clock
   *    (`createdAt`, so `run_end.seconds`, the XP time term and the stats'
   *    lifetime count the private part) and `firstLootAt`. Not buffs,
   *    statuses, cooldowns, a heal in progress, routes or spectators. No
   *    `run_start` (`Join.continues`: it is the same run).
   *    **The gear comes off the old player before the join**, in this same
   *    synchronous step: the move destroys the old player (`release`, its
   *    `runOver` already set, so no `gearEnded`) and `close` below discards
   *    whatever gear is still on a player in the world, which deleted the
   *    stash rows a run had brought in before private-7.
   * 5. The play moves to the new player (`paid`), and so does the list of
   *    stash rows brought in at the start (`brought`, for `run_end`'s
   *    `gear_brought` and `gear_found`).
   *
   * **Always hands off, a drain included** (Q10: the run is live, and a
   * drain plays live runs out), and over `maxPlayers`, `PRIVATE_CAP` and
   * `cap` alike (`choose` opens a world): a refused handoff would leave the
   * player on the pad, where the client ignores every click until its layer
   * changes (`LocalPlayer.awaitingHop`). Only a join that throws redirects
   * the client (and refunds the play), as the first run's does, and returns
   * the carried stash rows to the stash (`uncarry`; found items are lost).
   * The private world closes either way.
   */
  private padHandoff (world: World, state: OwnRun): void {
    const { connection, start, data } = state
    const player = state.player
    state.due = false
    try {
      if (player === undefined || player.runOver || player.destroyed || player.exited || connection.closed || connection.player !== player) return
      player.runOver = true
      const paid = this.paid.get(player)
      this.paid.delete(player)
      const brought = this.brought.get(player)
      this.brought.delete(player)
      Analytics.send(Worlds.runInfo(player, connection), 'private_done', { seconds: Math.round((Date.now() - player.createdAt) / 1000) })
      connection.socket.emit('handoff', {})
      connection.started = false

      // Read and taken now, before the move destroys the old player.
      const { hp, armor, createdAt, firstLootAt } = player
      const carried = player.takeCarried()
      let left: GearInstance[] = []
      let next: Player | undefined
      const join: Join = {
        continues: true,
        prepare: (into) => {
          into.loot = player.loot
          into.kills = player.kills
          carryKills(player, into)
          left = into.giveCarried(carried)
          into.hp = Math.min(hp, into.maxHp)
          into.armor = Math.min(armor, into.maxArmor)
          into.createdAt = createdAt
          into.firstLootAt = firstLootAt
        }
      }
      try {
        this.joinIn(connection, this.choose(start.party), data, undefined, join)
        if (connection.started && connection.player !== player) next = connection.player
      } catch (e) {
        reportError('handoff', e)
      }
      if (next === undefined) {
        // The carried gear is on no player in any world (a join that threw
        // took its player back out): its stash rows go back to the stash, as
        // for a run that didn't begin.
        this.uncarry([...carried.slots.filter((item): item is GearInstance => item !== null), ...carried.bag])
        if (paid !== undefined) this.refund(paid, connection)
        if (!connection.closed) Worlds.redirect(connection)
        return
      }
      if (paid !== undefined) this.paid.set(next, paid)
      if (brought !== undefined) this.brought.set(next, brought)
      // None for the same robot, which a handoff always plays.
      if (left.length > 0) this.uncarry(left)
    } finally {
      this.close(world)
    }
  }

  /**
   * The connection is leaving (its disconnect) while in a first run: the run
   * ends free (`runOver` first, so the release that follows ends nothing, and
   * its play back) and the account stays not done, so its next start plays
   * the first run again (decision #58 addendum 5). `first_run_left` to GA.
   */
  private leaveFirstRun (connection: Connection): void {
    const world = this.worldOf.get(connection)
    const player = connection.player
    if (world === undefined || !this.firstRunOf.has(world) || player === undefined || player.runOver) return
    player.runOver = true
    const paid = this.paid.get(player)
    this.paid.delete(player)
    if (paid !== undefined) this.refund(paid, connection)
    Analytics.send(Worlds.runInfo(player, connection), 'first_run_left', { seconds: Math.round((Date.now() - player.createdAt) / 1000) })
  }

  /**
   * A run ended (`Multiplayer.gearEnded`: once per run, every player, bots
   * too; decision #49, task 49-4). What the run takes out of the world:
   *
   * - An extraction, or a drain's cut-off (`connection.cutOff`), on the
   *   persisted account the run was played under: every item carried comes
   *   off the player and goes to `settleGear` (brought-in and picked-up stash
   *   rows kept or transferred, found items inserted up to `STASH_MAX`). One
   *   settle per run; the next start on the connection waits for it (race 3).
   * - The same ending offline, under another account, or for a bot: the
   *   items come off the player; found ones are lost, stash rows deleted
   *   (`discardGear`).
   * - A death or the player's own disconnect: nothing written, nothing
   *   taken; the death sweep (`World.createItemsFrom`) drops everything, each
   *   stash row's instance keeping its `rowId`.
   *
   * Keeps and discards take the gear off the player **synchronously, before
   * any write**, so a cut-off player's disconnect sweep drops nothing (race
   * 9). No XP for kept items (spec Q12). Returns the counts for `run_end`.
   */
  private gearEnded (connection: Connection | undefined, player: Player): GearCounts {
    const carried: GearInstance[] = []
    for (const item of player.gear) if (item !== null) carried.push(item)
    carried.push(...player.bag)
    const brought = this.brought.get(player) ?? []
    this.brought.delete(player)
    const counts: GearCounts = {
      brought: brought.length,
      found: carried.filter((item) => item.rowId === undefined || !brought.includes(item.rowId)).length,
      kept: 0
    }
    if (!player.extracted && connection?.cutOff !== true) return counts
    const taken = player.takeGear()
    if (taken.length === 0) return counts
    const account = connection?.account
    const gear = this.gear
    const ledger = this.ledger
    if (connection === undefined || player.bot !== undefined || account === undefined || !account.persisted ||
      account.publicId !== player.playerId || gear === undefined || ledger === undefined) {
      this.discard(taken)
      return counts
    }
    counts.kept = taken.length
    const keep = lineageOf(taken)
    const found = taken.filter((item) => item.rowId === undefined)
    const done = ledger.resolve(keep, async (holder) => await gear.settleGear(account.publicId, holder, keep, found), 'settle').then((settled) => {
      Worlds.accountSuccess()
      Multiplayer.guarded(() => {
        this.emitStash(connection, account, settled.stash, { kept: settled.kept.length + settled.inserted, full: found.length - settled.inserted })
      })
    }, (e) => { Worlds.accountFailure(e) })
    this.settling.set(connection, done)
    void done.then(() => { if (this.settling.get(connection) === done) this.settling.delete(connection) })
    return counts
  }

  /**
   * Stash rows among `items` leave the game for good (`discardGear`): a
   * bot's or an offline extraction, a dropped one expiring, a world closing.
   * Found items need nothing: they have no row.
   */
  private discard (items: ReadonlyArray<GearInstance | null | undefined>): void {
    const ids = lineageOf(items)
    const gear = this.gear
    const ledger = this.ledger
    if (ids.length === 0 || gear === undefined || ledger === undefined) return
    ledger.resolve(ids, async (holder) => await gear.discardGear(holder, ids), 'discard').then(() => { Worlds.accountSuccess() }, (e) => { Worlds.accountFailure(e) })
  }

  /** Back to the stash (`uncarry`): carried for a run that didn't begin, or that didn't equip them. */
  private uncarry (items: readonly GearInstance[]): void {
    const ids = lineageOf(items)
    const gear = this.gear
    const ledger = this.ledger
    if (ids.length === 0 || gear === undefined || ledger === undefined) return
    ledger.resolve(ids, async (holder) => await gear.uncarry(holder, ids), 'uncarry').then(() => { Worlds.accountSuccess() }, (e) => { Worlds.accountFailure(e) })
  }

  /**
   * One pass of the loop: every open world's tick and flush, each in its own
   * `World.run` and its own try/catch (one world's throw costs only that
   * world's tick), then the idle check.
   */
  tickAll (dtMs: number): void {
    const startedAt = this.tickClock()
    this.tick++
    this.admittedThisTick = 0
    this.releaseQueue()
    const dt = dtMs / 1000
    for (const world of this.worlds) {
      World.run(world, () => {
        try {
          if (this.botTarget > 0) this.fillOf(world, this.botTarget).update(this.draining ? 0 : Worlds.activePlayers(world))
          world.update(dt)
          world.multiplayer?.flushAll(this.tick, dtMs)
        } catch (e) {
          reportError('tick', e)
        }
      })
    }
    // Private worlds after the shared ones: their own bot target; the pad's
    // handoff once the tick is flushed; closed once their human has gone (so
    // a death watches nobody, #60 Q9: `close` ends the spectate at once).
    for (const world of [...this.privates]) {
      World.run(world, () => {
        try {
          if (this.privateBots.some((n) => n > 0)) {
            const humans = Worlds.activePlayers(world)
            const fill = this.fillOf(world, 0)
            // The target follows the human's layer (#60 Q8 and its 2026-11-07
            // addendum): one more bot joins on a descent.
            fill.target = humans + this.privateBotsFor(world)
            fill.update(this.draining ? 0 : humans)
            Worlds.exitLeaving()
          }
          world.update(dt)
          world.multiplayer?.flushAll(this.tick, dtMs)
        } catch (e) {
          reportError('tick', e)
        }
      })
      const state = this.privateOf.get(world)
      if (state?.due === true) Multiplayer.guarded(() => { this.padHandoff(world, state) })
      else if (Worlds.activePlayers(world) === 0) Multiplayer.guarded(() => { this.close(world) })
    }
    // First runs after those: no bots; a handoff once its tick is flushed;
    // closed once their player has gone.
    for (const world of [...this.firstRuns]) {
      World.run(world, () => {
        try {
          world.update(dt)
          world.multiplayer?.flushAll(this.tick, dtMs)
        } catch (e) {
          reportError('tick', e)
        }
      })
      const state = this.firstRunOf.get(world)
      if (state?.due === true) Multiplayer.guarded(() => { this.handoff(world, state) })
      else if (Worlds.activePlayers(world) === 0) Multiplayer.guarded(() => { this.close(world) })
    }
    this.closeIdle()
    this.measureLoad(this.tickClock() - startedAt)
  }

  /** Close every world idle for `idleMs`, newest first, keeping at least one open. */
  closeIdle (): void {
    const now = this.now()
    for (let i = this.worlds.length - 1; i >= 0; i--) {
      const world = this.worlds[i]
      if (Worlds.activePlayers(world) > 0) {
        this.emptySince.delete(world)
        continue
      }
      const since = this.emptySince.get(world)
      if (since === undefined) {
        this.emptySince.set(world, now)
        continue
      }
      if (now - since >= this.idleMs && this.worlds.length > 1) this.close(world)
    }
  }

  /**
   * Close `world` and drop every reference this holds to it. Its connections
   * (all between runs: it has no active players) are released and belong to
   * no world until their next run. A world already closed is left alone (a
   * first run's handoff that redirects closes it from the disconnect too).
   */
  close (world: World): void {
    if (world.closed) return
    // Stash rows still in it (decision #49, 49-4): dropped on the ground, or
    // carried by a bot or a corpse not yet swept. The world won't come back,
    // so they are gone (`discardGear`). A world closes only with no human in
    // a run.
    World.run(world, () => {
      const left: GearInstance[] = []
      for (const pickup of world.GEAR) if (!pickup.destroyed) left.push(pickup.instance)
      for (const player of world.PLAYERS) {
        for (const item of player.gear) if (item !== null) left.push(item)
        left.push(...player.bag)
      }
      this.discard(left)
    })
    for (const [connection, of] of this.worldOf) {
      if (of !== world) continue
      // One watching someone here (a death in a private world, #60 Q9, or an
      // idle shared world's bot) is told there is nobody left to watch,
      // before the release forgets it, which sends nothing.
      if (connection.spectating !== undefined && !connection.closed) connection.socket.emit('spectate', { id: null })
      World.run(world, () => { world.multiplayer?.release(connection) })
      this.worldOf.delete(connection)
    }
    world.close()
    this.emptySince.delete(world)
    this.fills.delete(world)
    const i = this.worlds.indexOf(world)
    if (i >= 0) this.worlds.splice(i, 1)
    const f = this.firstRuns.indexOf(world)
    if (f >= 0) this.firstRuns.splice(f, 1)
    this.firstRunOf.delete(world)
    const p = this.privates.indexOf(world)
    if (p >= 0) this.privates.splice(p, 1)
    this.privateOf.delete(world)
  }

  /**
   * Stop taking runs (decision #46): the host is replacing this process.
   * Connections with no run behind them, which have only ever seen the lobby,
   * go to the next server now; one on its run card goes when it asks for its
   * next run (`start`), so the card stays up. Live runs play out; the caller
   * ends the process once `drained`, or at its deadline.
   */
  drain (): void {
    this.draining = true
    for (const connection of this.connections) {
      if (!connection.started && !this.worldOf.has(connection)) Worlds.redirect(connection)
    }
  }

  /** Open connections, in a world or not. */
  get connectionCount (): number {
    return this.connections.size
  }

  /**
   * A private world's bots that its fill sent out (`BotBrain.leaving`) and
   * that stand on a layer with no human exit at once, in the current world
   * (Archie's private-4 review): nobody sees them go, and walking out would
   * keep the old layer's bots up to `LEAVE_GRACE_MS` beside the new layer's
   * after a descent (about 6 bots, not 3). One on its human's layer (a
   * drain's, or over the target) still walks to an exit, as everywhere.
   */
  private static exitLeaving (): void {
    for (const player of World.PLAYERS) {
      if (player.bot?.leaving === true && !player.destroyed && !player.exited && !humanOn(player.tag)) player.exit()
    }
  }

  /**
   * The bots a private world wants now: `privateBots`' value for the layer
   * its human is on (the last value past the list's end), 0 with no human
   * in play.
   */
  private privateBotsFor (world: World): number {
    const human = world.PLAYERS.find((p) => p.bot === undefined && !p.destroyed && !p.exited)
    if (human === undefined || this.privateBots.length === 0) return 0
    const i = this.privateTags.indexOf(human.tag)
    const bots = this.privateBots[Math.min(Math.max(i, 0), this.privateBots.length - 1)]
    // Hot (private-15): one fewer per layer, 2/3 -> 1/2.
    return this.load >= LOAD_HOT ? Math.max(0, bots - 1) : bots
  }

  /** `world`'s bot fill, made at `target` on first use: `botTarget` for a shared world; a private world's is set every tick (`privateBotsFor`). */
  private fillOf (world: World, target: number): BotFill {
    let fill = this.fills.get(world)
    if (fill === undefined) {
      fill = new BotFill(target)
      this.fills.set(world, fill)
    }
    return fill
  }

  /**
   * This process has `maxPlayers` runs in progress (none: no cap). Checked
   * when a start arrives, so it is soft by the starts already waiting on the
   * account or their play (a database round trip each).
   */
  get full (): boolean {
    return this.maxPlayers > 0 && Worlds.activeRuns(this) >= this.maxPlayers
  }

  /**
   * `privateCap` private worlds are open (decision #60 Q11): a start is sent
   * `full` (`refuseFull`), nothing spent, rather than put on a shared world's
   * layer 03. Soft like `full`, by the starts already waiting on the account
   * or their play; never checked at a handoff (a first run's pad opens one
   * over it), so nobody is left on a pad.
   */
  get privateFull (): boolean {
    return this.privateRuns && this.privateCap > 0 && this.privates.length >= this.privateCap
  }

  /**
   * `full { retryMs }`, then the transport closed as `redirect` does: the
   * client reconnects (a new connection is the only way to reach another
   * worker or replica) and asks again after `retryMs` plus its own backoff
   * (`net/full.ts`). An older client has no handler and simply lands back in
   * the lobby. Nothing is spent: the check comes before the account and the play.
   */
  static refuseFull (connection: Connection): void {
    connection.socket.emit('full', { retryMs: FULL_RETRY_MS })
    Worlds.redirect(connection)
  }

  /** Runs in progress across every world, first runs and private worlds included (a burst cap must count them). */
  static activeRuns (worlds: Worlds): number {
    let n = 0
    for (const world of worlds.worlds) n += Worlds.activePlayers(world)
    for (const world of worlds.firstRuns) n += Worlds.activePlayers(world)
    for (const world of worlds.privates) n += Worlds.activePlayers(world)
    return n
  }

  /** No run in progress in any world, first runs and private worlds included (a drain plays them out): a draining process can stop. */
  get drained (): boolean {
    const idle = (world: World): boolean => Worlds.activePlayers(world) === 0
    return this.worlds.every(idle) && this.firstRuns.every(idle) && this.privates.every(idle)
  }

  /**
   * Close every connection the way a dying server would, live runs included:
   * each one's disconnect handler runs (stats writes, the player destroyed as
   * on any disconnect) and its client reconnects to the next server.
   */
  closeAll (): void {
    for (const connection of [...this.connections]) {
      // Not the player's loss: a run cut here gets its play back (`refundRun`).
      connection.cutOff = true
      Worlds.redirect(connection)
    }
  }

  /**
   * Close the connection's transport, not the socket.io session: a client
   * told to disconnect by the server (`socket.disconnect()`) does not
   * reconnect, one whose transport closed does, which lands it on whatever
   * server the host routes new connections to.
   */
  static redirect (connection: Connection): void {
    connection.socket.conn.close()
  }

  private _leaderboard: Record<string, Record<string, string>> = {}
  private _leaderboardAt = 0

  /**
   * `/stats`: every `stats-*` hash, cached for 3 s, as `Multiplayer.getLeaderboard`
   * does for one world. Global (Redis), not per world, and outside every world:
   * it reads only the shared Redis client.
   */
  async getLeaderboard (): Promise<Record<string, Record<string, string>>> {
    if (Date.now() - this._leaderboardAt < 3000) return this._leaderboard
    const redis = this.redis
    const keys = await redis.keys('stats-*')
    const data: Record<string, Record<string, string>> = {}
    for (const key of keys) data[key] = await redis.hgetall(key)
    this._leaderboard = data
    this._leaderboardAt = Date.now()
    return data
  }
}
