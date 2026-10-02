/**
 * Invite links (decision #47), pixi-free so the server's specs run it.
 *
 * Every browser has a random party code (localStorage `plunderland_party`),
 * never its player id. INVITE copies `?join=<code>&from=<name>`; a page opened
 * from it remembers the invite for the tab (sessionStorage `plunderland_join`)
 * and every run it starts carries the inviter's code, so the server puts it in
 * the inviter's world (`Worlds.choose`). Free-for-all all the same.
 */
export const PARTY_KEY = 'plunderland_party'
export const JOIN_KEY = 'plunderland_join'

/** As the server checks it (`Multiplayer.PARTY_SHAPE`). */
export const PARTY_SHAPE = /^[0-9a-z]{6,12}$/
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
/** The longest inviter name shown: the server's NAME_MAX. */
const FROM_MAX = 16

export interface Invite { code: string, from: string }

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
  // Shown as text only (textContent); cut to the server's name length.
  const from = Array.from((params.get('from') ?? '').trim()).slice(0, FROM_MAX).join('')
  return { code, from }
}

/** A stored invite, or undefined if there is none or it is unreadable. */
export function parseStoredInvite (raw: string | null): Invite | undefined {
  if (raw === null) return undefined
  try {
    const invite = JSON.parse(raw)
    return typeof invite?.code === 'string' && PARTY_SHAPE.test(invite.code) && typeof invite?.from === 'string' ? invite : undefined
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
