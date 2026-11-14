/**
 * Invite links (decision #47), pixi-free so the server's specs run it.
 *
 * Every browser has a random party code (localStorage `plunderland_party`),
 * never its player id. INVITE copies `?join=<code>&from=<name>`; a page opened
 * from it remembers the invite for the tab (sessionStorage `plunderland_join`)
 * and every run it starts carries the inviter's code, so the server puts it in
 * the inviter's world (`Worlds.choose`). Free-for-all all the same.
 *
 * `from` is shown to whoever opens the link, so it is shown only if it is a
 * callsign (g2-9b, decision #62): anything else reads "A FRIEND".
 */
import { CALLSIGN_WORDS } from '../../utils/callsign'

export const PARTY_KEY = 'plunderland_party'
export const JOIN_KEY = 'plunderland_join'

/** As the server checks it (`Multiplayer.PARTY_SHAPE`). */
export const PARTY_SHAPE = /^[0-9a-z]{6,12}$/
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export interface Invite { code: string, from: string }

/** A callsign exactly as `callsignOf` makes it: a word of the list, '-', 100 to 999. */
const CALLSIGN_SHAPE = /^([A-Z]+)-([1-9][0-9]{2})$/

/**
 * The inviter's name as the lobby may show it: `from` if it is a callsign,
 * else '' ("A FRIEND"). A link is anyone's to craft, so no free text gets
 * through. A CrazyGames username is not accepted here (g2-6b: CG invites go
 * through CG's own SDK, and a CG name would need verifying, not a URL).
 */
export function fromShown (from: unknown): string {
  if (typeof from !== 'string') return ''
  const match = CALLSIGN_SHAPE.exec(from)
  return match !== null && CALLSIGN_WORDS.includes(match[1]) ? from : ''
}

export function makeCode (random: () => number = Math.random): string {
  let code = ''
  for (let i = 0; i < 6; i++) code += ALPHABET[Math.floor(random() * ALPHABET.length)]
  return code
}

/** The invite in a page's query string, if it has a well-formed one. */
export function readInvite (search: string): Invite | undefined {
  const params = new URLSearchParams(search)
  const code = params.get('join')
  if (code === null || !PARTY_SHAPE.test(code)) return undefined
  // A bad `from` costs only the name: the code still joins the inviter's world.
  return { code, from: fromShown(params.get('from')) }
}

/** A stored invite, or undefined if there is none or it is unreadable. */
export function parseStoredInvite (raw: string | null): Invite | undefined {
  if (raw === null) return undefined
  try {
    const invite = JSON.parse(raw)
    // One stored by an older build may carry free text: checked like a link's.
    return typeof invite?.code === 'string' && PARTY_SHAPE.test(invite.code) ? { code: invite.code, from: fromShown(invite.from) } : undefined
  } catch {
    return undefined
  }
}

/** `search` without the invite's own params, keeping any other (a developer's ?server=). */
export function withoutInvite (search: string): string {
  const params = new URLSearchParams(search)
  params.delete('join')
  params.delete('from')
  const rest = params.toString()
  return rest === '' ? '' : `?${rest}`
}

/** The link INVITE copies: this page's address with the party code and the inviter's name. */
export function inviteUrl (origin: string, pathname: string, search: string, code: string, from: string): string {
  const params = new URLSearchParams(withoutInvite(search))
  params.set('join', code)
  if (from !== '') params.set('from', from)
  return `${origin}${pathname}?${params.toString()}`
}
