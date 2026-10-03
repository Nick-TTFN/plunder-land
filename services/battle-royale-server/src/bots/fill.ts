import World from '../objects/world'
import type Player from '../objects/player'
import { FINISH_PRESETS, finishToBytes } from '../utils/finishes'
import { SELECTABLE_ROBOTS } from '../utils/archetypes'
import BotBrain, { botKit } from './brain'

/**
 * Keeps one world's humans + bots at `target` (decision #47), and only while
 * it has a human: an empty world's bots head out. At most one bot joins per
 * `spawnEveryMs`. A human over the target displaces a bot, which **leaves by
 * extracting** (`BotBrain.leaving`); one that hasn't made it out after
 * `LEAVE_GRACE_MS` exits where it stands, so the count can't stay over for
 * long. `BOT_TARGET` in the environment (0 turns bots off).
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
    readonly target: number,
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

    const staying = BotFill.staying()
    if (humans === 0) {
      for (const bot of staying) this.leave(bot, now)
      return
    }
    if (humans + staying.length > this.target && staying.length > 0) {
      // The one with least to lose.
      this.leave(staying.reduce((a, b) => (a.loot <= b.loot ? a : b)), now)
      return
    }
    if (humans + staying.length < this.target && now - this.lastSpawnAt >= this.spawnEveryMs) {
      this.lastSpawnAt = now
      this.spawn(now)
    }
  }

  private leave (bot: Player, now: number): void {
    if (bot.bot === undefined || bot.bot.leaving) return
    bot.bot.leaving = true
    this.leavingSince.set(bot, now)
  }

  spawn (now: number = Date.now()): Player {
    const pick = <T>(list: readonly T[]): T => list[Math.floor(this.random() * list.length)]
    let name = pick(NAMES)
    if (this.random() < 0.4) name += String(10 + Math.floor(this.random() * 90))
    // Not hex, so never a real player's id (Multiplayer.ID_SHAPE); bots write no stats anyway.
    const id = `bot-${++this.seq}`
    const player = World.createPlayer(id, name, finishToBytes(pick(FINISH_PRESETS).finish), pick(SELECTABLE_ROBOTS), botKit(this.random))
    player.bot = new BotBrain(player, now, this.random)
    player.addAIRoutine(player.bot)
    return player
  }
}
