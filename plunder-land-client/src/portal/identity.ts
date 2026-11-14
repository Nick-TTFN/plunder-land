import type { PortalSdk, PortalUser } from './adapter'
import type { AccountInfo } from '../net/account'
import { callsign } from '../utils/callsign'

/**
 * A portal's login against our accounts, client side (g2-6c; server g2-6b,
 * docs/accounts.md "Portal accounts"; decision #62 Q1, Q3, Q4). Pixi-free and
 * `window`-free, so the server's specs run it with a fake adapter.
 *
 * - **The link offer** (rule 4b): the server offers the guest account this
 *   browser holds (`account { ..., linkable: true }`); the portal's own modal
 *   asks, and the answer goes back as `portal_link { accept }`. While the
 *   modal is open READY is **held** (`LINK.open`), because a start before the
 *   answer is a decline on the server. Nothing ever waits for an offer: an
 *   old server never sends one.
 * - **A login while the page is open** (`Relogin`): in the lobby the socket
 *   reconnects at once (a new handshake with the token); in a run, once the
 *   lobby is back after the run card. The game never opens the login modal by
 *   itself: only the lobby's "Log in" button does (`loginButtonShown`).
 * - **The name in the lobby** (`shownName`): the portal username and picture
 *   for an account the server says is linked, else the callsign.
 */

/** The link offer being answered: its account id while the modal is open, and who wants to hear (the lobby's READY). */
export const LINK: { open: string | undefined, accepted: string | undefined, listeners: Set<() => void> } = {
  open: undefined,
  accepted: undefined,
  listeners: new Set()
}

function tell (listeners: Set<() => void>): void {
  listeners.forEach((listener) => {
    try {
      listener()
    } catch {
      // One broken listener must not stop the others.
    }
  })
}

/**
 * Answer a link offer for account `id`: the portal's modal, then `emit(accept)`
 * (`portal_link`). A modal error or a "no" is a decline. An offer arriving
 * while one is open is ignored: the open one's answer goes out on the same
 * socket, which is the newer connection's after a reconnect, and the server
 * applies it to whatever offer that connection holds. `LINK.accepted` keeps
 * the id agreed to, so the `account { portal }` that confirms it can drop the
 * stored guest token (`onAccount`).
 */
export async function answerLinkOffer (id: string, sdk: Pick<PortalSdk, 'linkPrompt'>, emit: (accept: boolean) => void): Promise<void> {
  if (LINK.open !== undefined) return
  LINK.open = id
  tell(LINK.listeners)
  let accept = false
  try {
    accept = await sdk.linkPrompt()
  } catch {
    accept = false
  }
  if (accept) LINK.accepted = id
  try {
    emit(accept)
  } finally {
    LINK.open = undefined
    tell(LINK.listeners)
  }
}

/**
 * A portal login while the page is open. `reconnect` starts a new connection
 * (whose handshake carries the token). In the lobby it runs at once; anywhere
 * else (a run, its card) it waits for the next lobby. The lobby says when it
 * is up (`lobbyShown`) and when it is left (`lobbyLeft`: READY pressed, or
 * taken down).
 */
export class Relogin {
  private inLobby = false
  private pending = false

  constructor (private readonly reconnect: () => void) {}

  login (): void {
    if (this.inLobby) {
      this.inLobby = false
      this.reconnect()
    } else {
      this.pending = true
    }
  }

  lobbyShown (): void {
    if (this.pending) {
      this.pending = false
      this.inLobby = false
      this.reconnect()
      return
    }
    this.inLobby = true
  }

  lobbyLeft (): void {
    this.inLobby = false
  }
}

let reconnectHook: () => void = () => {}

/** How the page reconnects (`index.ts`, once). */
export function setReconnect (reconnect: () => void): void {
  reconnectHook = reconnect
}

/** The page's one `Relogin`: `index.ts` feeds it the portal's logins, the lobby its comings and goings. */
export const RELOGIN = new Relogin(() => { reconnectHook() })

/** The lobby's "Log in" button (Q4): only where the portal has accounts and nobody is logged in. */
export function loginButtonShown (sdk: Pick<PortalSdk, 'accountsAvailable'>, user: PortalUser | null): boolean {
  return sdk.accountsAvailable() && user === null
}

/** What the lobby's name pill shows: a text and, for a portal user, their picture. */
export interface ShownName {
  text: string
  avatar: string | undefined
  /** The portal username (true) or the callsign. */
  portal: boolean
}

/**
 * The lobby's name (Q1): the portal username and picture when the server has
 * announced an account linked to the portal (so it verified the token: before
 * `CRAZYGAMES_GAME_ID` is set it never does, and the player is a guest under
 * a callsign, as other players see them); otherwise the account's callsign;
 * undefined before the account is announced.
 */
export function shownName (info: AccountInfo | undefined, user: PortalUser | null): ShownName | undefined {
  if (info === undefined) return undefined
  if (info.portal !== undefined && !info.offline && user !== null) return { text: user.username, avatar: user.avatar, portal: true }
  return { text: callsign(info.id), avatar: undefined, portal: false }
}
