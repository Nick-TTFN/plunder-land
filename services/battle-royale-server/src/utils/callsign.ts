/**
 * Callsigns (decision #62, g2-9): nobody types a name. Every player and every
 * bot is shown as a word and a three-digit number, e.g. `ROOK-421`.
 *
 * Mirrored byte for byte in both packages (`mirror.spec.ts`): the server names
 * every run with it (`Player.displayNameFor`, `BotFill.spawn`), and the
 * client's lobby shows the player their own from the account id without
 * asking the server. A drifted copy shows the player one callsign in the lobby
 * and everyone else another in the run.
 *
 * 64 words x 900 numbers is 57,600 callsigns. Two players sharing one is
 * possible (about 2% for some pair among 50 players) and only cosmetic:
 * nothing identifies a player by name, stats and the season board are keyed
 * by id. Every word, with any number, passes the server's name filter
 * (`names.spec.ts`).
 */
export const CALLSIGN_WORDS: readonly string[] = Object.freeze([
  'NOVA', 'ROOK', 'VOLT', 'ECHO', 'FLUX', 'GRIT', 'HAWK', 'JINX',
  'KITE', 'LYNX', 'MOTH', 'ONYX', 'PIKE', 'QUILL', 'RUST', 'SABLE',
  'TALON', 'UMBRA', 'VIPER', 'WREN', 'ZINC', 'BOLT', 'COG', 'DRIFT',
  'EMBER', 'FANG', 'GEAR', 'HEX', 'IRON', 'JOLT', 'KNOX', 'LUMEN',
  'ANVIL', 'BLAZE', 'CHROME', 'DELTA', 'FROST', 'GLINT', 'HALO', 'ION',
  'JADE', 'KESTREL', 'LANCE', 'MANTIS', 'NEON', 'ORBIT', 'PRISM', 'QUARTZ',
  'RAVEN', 'SPARK', 'TITAN', 'VECTOR', 'WISP', 'XENON', 'YETI', 'ZEPHYR',
  'BADGER', 'COMET', 'DYNAMO', 'FALCON', 'GLITCH', 'HERON', 'OTTER', 'STORM'
])

/** The number runs from 100 to 999, so every callsign's number has three digits. */
export const CALLSIGN_NUMBERS = 900

/** A 32-bit FNV-1a hash of `id`'s UTF-16 units. */
export function callsignHash (id: string): number {
  let hash = 0x811c9dc5
  const text = String(id)
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** The callsign for a 32-bit number: the word from its low bits, the number from the rest. */
export function callsignOf (hash: number): string {
  const h = hash >>> 0
  const word = CALLSIGN_WORDS[h % CALLSIGN_WORDS.length]
  const number = 100 + Math.floor(h / CALLSIGN_WORDS.length) % CALLSIGN_NUMBERS
  return `${word}-${number}`
}

/**
 * The callsign of a player id (the account's public id): deterministic, so
 * the same account always gets the same callsign, in every run and world.
 */
export function callsign (id: string): string {
  return callsignOf(callsignHash(id))
}
