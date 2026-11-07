import World from '../objects/world'
import type Player from '../objects/player'
import { FINISH_GROUPS, FINISH_PRESETS, type Finish, PALETTE, PATTERNS, finishToBytes } from '../utils/finishes'
import BotBrain, { botCargo, botLayer, humanOn, kitOf, pickTemperament } from './brain'

/**
 * Keeps one world's humans + bots at `target` (decision #47), and only while
 * it has a human: an empty world's bots head out, and so does a bot on a
 * layer with no human (#60, Q8), so the fill tops up where the humans are.
 * At most one bot joins per `spawnEveryMs`. A human over the target
 * displaces a bot, which **leaves by extracting** (`BotBrain.leaving`); one
 * that hasn't made it out after `LEAVE_GRACE_MS` exits where it stands, so
 * the count can't stay over for long. `BOT_TARGET` in the environment (0
 * turns bots off).
 */
export const LEAVE_GRACE_MS = 90_000

/** Names a player might pick. Not callsigns: those mark an empty or refused name. */
const NAMES = [
  'Zed', 'mira', 'KOBALT', 'tinker', 'ghostbyte', 'Nyx', 'pixelfox', 'Juno', 'scrapjack', 'Vex',
  'orbit', 'Kip', 'ash', 'Wisp', 'Rivet', 'Moss', 'Tango', 'Sprocket', 'Dune', 'Fable',
  'bitwise', 'Loki', 'nimbus', 'Pip', 'ferrous', 'Echo7', 'quark', 'Sol', 'Bramble', 'Vanta'
]

export default class BotFill {
  private lastSpawnAt = -Infinity
  private seq = 0
  private readonly leavingSince = new Map<Player, number>()

  constructor (
    /** Humans + bots. A private world's follows its human's layer, set before each `update` (`Worlds.tickAll`). */
    public target: number,
    readonly spawnEveryMs: number = 2000,
    private readonly random: () => number = Math.random
  ) {}

  /** Bots in the current world still playing: not dead, not out, not leaving. */
  static staying (): Player[] {
    return World.PLAYERS.filter((p) => p.bot !== undefined && !p.destroyed && !p.exited && !p.bot.leaving)
  }

  /** One pass, in the current world (`World.run`). `humans`: its active humans. */
  update (humans: number, now: number = Date.now()): void {
    for (const [bot, since] of this.leavingSince) {
      if (bot.destroyed || bot.exited) this.leavingSince.delete(bot)
      else if (now - since >= LEAVE_GRACE_MS) bot.exit()
    }

    let staying = BotFill.staying()
    if (humans === 0) {
      for (const bot of staying) this.leave(bot, now)
      return
    }
    // Bots follow the humans (decision #60, Q8): one on a layer with no human
    // in play (its human moved on) heads out, and the fill tops up where the
    // humans are (`layerFor`). Every world: a layer nobody plays keeps no
    // bots. A bot doesn't head down to such a layer itself (`humanOn` in
    // `BotBrain.think`): without that, 3 bots in 4 did and were sent out (the
    // ten-minute spec in bots.spec.ts, task private-4).
    let strayed = false
    for (const bot of staying) {
      if (humanOn(bot.tag)) continue
      this.leave(bot, now)
      strayed = true
    }
    if (strayed) staying = BotFill.staying()
    if (humans + staying.length > this.target && staying.length > 0) {
      // The one with least to lose.
      this.leave(staying.reduce((a, b) => (a.loot <= b.loot ? a : b)), now)
      return
    }
    if (humans + staying.length < this.target && now - this.lastSpawnAt >= this.spawnEveryMs) {
      const tag = BotFill.layerFor()
      if (tag === undefined) return
      this.lastSpawnAt = now
      this.spawn(now, tag)
    }
  }

  /**
   * The layer the next bot joins on (#58 addendum 2, Q6): of the layers with
   * a human in play, the one with the fewest staying bots per human, ties to
   * the higher layer. Undefined when no layer has a human: a layer with no
   * humans gets no bots. The target stays per world (`update`).
   */
  static layerFor (): number | undefined {
    let best: number | undefined
    let bestShare = Infinity
    for (const tag of World.TAGS) {
      let humans = 0
      let bots = 0
      for (const p of World.PLAYERS) {
        if (p.tag !== tag || p.destroyed || p.exited) continue
        if (p.bot === undefined) humans++
        else if (!p.bot.leaving) bots++
      }
      if (humans === 0) continue
      if (bots / humans < bestShare) {
        best = tag
        bestShare = bots / humans
      }
    }
    return best
  }

  private leave (bot: Player, now: number): void {
    if (bot.bot === undefined || bot.bot.leaving) return
    bot.bot.leaving = true
    this.leavingSince.set(bot, now)
  }

  /**
   * The handicap of the layer `bot` joins on (decision #60, Q7; `BOT_SKILL`'s
   * `hpScale` and `damageScale`): its robot's max HP and max armor scaled,
   * rounded, at least 1, and full; its damage through `Player.botDamage`.
   * Once, at the join: a bot that changes layer keeps it. It holds because a
   * bot never equips gear (`Player.addGear`), and `applyGear`, which rebuilds
   * max HP and armor from the archetype, runs only on an equip. Read by the
   * layer the bot is on, which `createPlayer` may have moved to the top held
   * layer.
   */
  static handicap (bot: Player): void {
    const row = botLayer(bot.tag)
    if (row.hpScale !== 1) {
      bot.maxHp = Math.max(1, Math.round(bot.maxHp * row.hpScale))
      bot.hp = bot.maxHp
      if (bot.maxArmor > 0) {
        bot.maxArmor = Math.max(1, Math.round(bot.maxArmor * row.hpScale))
        bot.armor = bot.maxArmor
      }
    }
    bot.botDamage = row.damageScale
  }

  /**
   * A bot on layer `tag` (by default `layerFor`'s, else the top one the
   * world holds, `World.topLayer`), as one of that layer's robots and
   * temperaments, with its cargo (`BOT_SKILL`).
   */
  spawn (now: number = Date.now(), tag: number = BotFill.layerFor() ?? World.current.topLayer): Player {
    const pick = <T>(list: readonly T[]): T => list[Math.floor(this.random() * list.length)]
    const row = botLayer(tag)
    let name = pick(NAMES)
    if (this.random() < 0.4) name += String(10 + Math.floor(this.random() * 90))
    // Not hex, so never a real player's id (Multiplayer.ID_SHAPE); bots write no stats anyway.
    const id = `bot-${++this.seq}`
    // A temperament (brain.ts) sets its kit and how it plays; a preset finish,
    // or a third of the time any colour and pattern per group, as MIX would.
    const temperament = pickTemperament(this.random, row.temperaments)
    const finish: Finish = this.random() < 0.33
      ? Object.fromEntries(FINISH_GROUPS.map((g) => [g, { colour: pick(PALETTE).id, pattern: pick(PATTERNS).id }])) as unknown as Finish
      : pick(FINISH_PRESETS).finish
    const player = World.createPlayer(id, name, finishToBytes(finish), pick(row.robots), kitOf(temperament, this.random), tag)
    player.bot = new BotBrain(player, now, this.random, temperament)
    player.addAIRoutine(player.bot)
    BotFill.handicap(player)
    // Some carry one item, by the layer (49-6, #58). After `bot` is set, so it goes in the bag.
    const cargo = botCargo(this.random, row.cargo)
    if (cargo !== undefined) player.addGear(cargo)
    return player
  }
}
