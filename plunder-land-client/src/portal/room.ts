import type { PortalRoom, PortalSdk } from './adapter'
import { PARTY_SHAPE } from '../ui/lobby/party'

/**
 * The portal's room (g2-6e, decision #62 Q2 A): CrazyGames' Join/Invite
 * show friends where a player can be joined. **The room is the party code the
 * next run carries** (`ui/lobby/party.ts`): the inviter's after an invite,
 * else this browser's own. It survives runs (the next run carries the same
 * code, so `Worlds.choose` finds the friend again: "keep rooms across
 * rounds") and both handoffs of a run (nothing here runs during a run). Every
 * run still starts solo on the private layers 01-02; friends with one code
 * meet in the shared world from 03 (the pad picks it by the code).
 *
 * Only the lobby reports it. Pixi-free and `window`-free, so the server's
 * specs run it with a fake adapter.
 */

/** What an invite carries, and what a friend's page is launched with: the party code under `join`, as our own links. */
export function inviteParamsFor (code: string): Record<string, string> {
  return { join: code }
}

/** The room for a party code. */
export function roomFor (code: string, joinable: boolean): PortalRoom {
  return { roomId: code, isJoinable: joinable, inviteParams: inviteParamsFor(code) }
}

/** The party code in a portal invite's params, if it is well formed (the server's `PARTY_SHAPE`); a bad one is ignored. */
export function inviteCodeOf (params: Record<string, string> | null | undefined): string | undefined {
  const code = params?.join
  return typeof code === 'string' && PARTY_SHAPE.test(code) ? code : undefined
}

/**
 * Sends the room only when it changes (the lobby asks on every redraw of its
 * full banner), and never on an offline launch (g2-6f's `isJoinable: false`
 * stands; the adapter drops it too).
 */
export class RoomReporter {
  private last: string | undefined

  constructor (private readonly sdk: Pick<PortalSdk, 'updateRoom' | 'offline'>) {}

  /** `joinable` is false while the server refuses starts (`full`). */
  report (code: string, joinable: boolean): void {
    if (this.sdk.offline()) return
    const key = `${code} ${String(joinable)}`
    if (key === this.last) return
    this.last = key
    this.sdk.updateRoom(roomFor(code, joinable))
  }
}

/**
 * The party code a portal invite brought (g2-6e): the launch params once the
 * SDK is ready, then any join while the page is open. The latest stays for
 * the page (`latest`), so a lobby made later, after a run, carries it; a lobby
 * that is up hears it at once (`listeners`).
 */
export class JoinInbox {
  latest: string | undefined
  readonly listeners = new Set<(code: string) => void>()

  /** Reads the launch's params and listens for joins; once a page. */
  listen (sdk: Pick<PortalSdk, 'inviteParams' | 'onJoinRoom'>): void {
    sdk.onJoinRoom((params) => { this.receive(params) })
    void sdk.inviteParams().then((params) => { this.receive(params) })
  }

  receive (params: Record<string, string> | null): void {
    const code = inviteCodeOf(params)
    if (code === undefined) return
    this.latest = code
    this.listeners.forEach((listener) => {
      try {
        listener(code)
      } catch (e) {
        console.warn(`portal room: a join listener failed: ${String(e)}`)
      }
    })
  }

  /** The player cancelled the invite in the lobby: later lobbies play their own code. */
  clear (): void {
    this.latest = undefined
  }
}
