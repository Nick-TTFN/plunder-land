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
 * - **The name in the lobby** (`shownName`): for an account the server says
 *   is linked, the name the server sends (`account.name`, exactly what other
 *   players will see) and the portal user's picture; else the callsign.
 */

/**
 * The link offer being answered: its account id while the modal is open, the
 * id this page agreed to link, the ids this page declined, and who wants to
 * hear (the lobby's READY).
 */
export const LINK: { open: string | undefined, accepted: string | undefined, declined: Set<string>, listeners: Set<() => void> } = {
  open: undefined,
  accepted: undefined,
  declined: new Set(),
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
 *
 * An offer this page already declined (`LINK.declined`; any "no", a modal
 * error included) is declined again at once, without the modal: the server
 * remembers a decline per connection only, so a reconnect before READY
 * offers the same account again, and the player must not be asked twice.
 * An accepted id offered again (a link the store failed to write) asks
 * again: the player said yes, and a yes needs the modal.
 */
export async function answerLinkOffer (id: string, sdk: Pick<PortalSdk, 'linkPrompt'>, emit: (accept: boolean) => void): Promise<void> {
  if (LINK.open !== undefined) return
  if (LINK.declined.has(id)) {
    emit(false)
    return
  }
  LINK.open = id
  tell(LINK.listeners)
  let accept = false
  try {
    accept = await sdk.linkPrompt()
  } catch {
    accept = false
  }
  if (accept) LINK.accepted = id
  else LINK.declined.add(id)
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
  /** The server's name for a linked account (true: shown in its own case) or the callsign. */
  portal: boolean
}

/**
 * The lobby's name (Q1): for an account the server has announced as linked
 * to the portal (so it verified the token: before `CRAZYGAMES_GAME_ID` is
 * set it never does, and the player is a guest under a callsign), the name
 * the server sent with it (`info.name`), **never the portal's raw username**:
 * the server cuts it to 16 and swaps a filtered one for the callsign, and the
 * pill shows exactly what other players see. A linked account without a
 * `name` (an older server) shows the callsign. The picture only when linked
 * and the portal user is known. Otherwise the account's callsign; undefined
 * before the account is announced.
 */
export function shownName (info: AccountInfo | undefined, user: PortalUser | null): ShownName | undefined {
  if (info === undefined) return undefined
  if (info.portal !== undefined && !info.offline) {
    const avatar = user !== null ? user.avatar : undefined
    if (info.name !== undefined) return { text: info.name, avatar, portal: true }
    return { text: callsign(info.id), avatar, portal: false }
  }
  return { text: callsign(info.id), avatar: undefined, portal: false }
}
