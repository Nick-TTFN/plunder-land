import type { PortalContext, PortalDevice, PortalSdk } from './adapter'

/**
 * The game's side of the portal's platform members (g2-6f, decision #62),
 * as rules the browser code calls: the starting input mode from the portal's
 * device type, the feedback context, and an offline launch. Off a portal the
 * adapter answers undefined/false and every rule here does nothing.
 *
 * Pixi-free and `window`-free.
 */

/**
 * The input mode a portal's device type starts in: touch for a phone or a
 * tablet, desktop for a desktop, undefined (keep the browser's guess) for
 * anything else. CrazyGames: "Don't rely on touch detection ... to show
 * mobile controls" (requirements/technical, read 2026-11-13).
 */
export function touchForDevice (device: PortalDevice | undefined): boolean | undefined {
  if (device === 'mobile' || device === 'tablet') return true
  if (device === 'desktop') return false
  return undefined
}

/**
 * Once the SDK is ready, seed the input mode from its device type (`seed` is
 * `seedTouchMode`, which a press made before then outranks). Resolves to the
 * mode seeded, or undefined for none.
 */
export async function seedInputMode (sdk: PortalSdk, seed: (touch: boolean) => void): Promise<boolean | undefined> {
  await sdk.ready
  const touch = touchForDevice(sdk.deviceType())
  if (touch !== undefined) seed(touch)
  return touch
}

/** What the feedback context is built from; anything unknown is left out. */
export interface ContextFacts {
  /** The layer number (1 = layer 01). */
  layer?: number
  robot?: string
  /** The account's level. */
  level?: number
  protocol: number
  build: string
}

/** One value as the context carries it: a finite number or a non-empty string, else nothing. */
function put (out: PortalContext, key: string, value: number | string | undefined): void {
  if (typeof value === 'number' && Number.isFinite(value)) out[key] = String(value)
  else if (typeof value === 'string' && value.trim() !== '') out[key] = value
}

/** A run's context: `{ layer, robot, level, protocol, build }`, strings only, unknowns left out. */
export function runContext (facts: ContextFacts): PortalContext {
  const out: PortalContext = {}
  put(out, 'layer', facts.layer)
  put(out, 'robot', facts.robot)
  put(out, 'level', facts.level)
  put(out, 'protocol', facts.protocol)
  put(out, 'build', facts.build)
  return out
}

/** The lobby's context: `{ protocol, build, level }`. */
export function lobbyContext (facts: ContextFacts): PortalContext {
  const out: PortalContext = {}
  put(out, 'protocol', facts.protocol)
  put(out, 'build', facts.build)
  put(out, 'level', facts.level)
  return out
}

/** The part of the socket.io client an offline launch touches. */
export interface OfflineSocket {
  io: { reconnection: (on: boolean) => unknown }
  disconnect: () => unknown
}

/**
 * An offline launch (the portal's app playing a downloaded copy): the game
 * needs the server for everything, so once the SDK says so the socket stops
 * trying (no reconnection; the attempt already made is the only one) and
 * `showLobby` puts the lobby up without a server, where READY says why it
 * can't start. Resolves true if it was offline.
 */
export async function applyOfflineMode (sdk: PortalSdk, socket: OfflineSocket, showLobby: () => void): Promise<boolean> {
  await sdk.ready
  if (!sdk.offline()) return false
  socket.io.reconnection(false)
  socket.disconnect()
  showLobby()
  return true
}

/** What the lobby shows in READY's place on an offline launch. */
export const OFFLINE_LINE = 'Plunderbots needs an internet connection'
