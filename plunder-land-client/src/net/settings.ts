/**
 * The player's settings (L3, without sound): key bindings for the 4 skill
 * slots and the 5 item slots, the render density, robot cast shadows and the
 * performance overlay. Pixi-free, so the server's specs run it
 * (`network/settings.spec.ts` there). Kept in localStorage
 * (`plunderland_settings`) as JSON; anything unreadable in it falls back to
 * the default for that field, never to a broken binding.
 */

export type Density = 'auto' | '1' | '2'

export interface Settings {
  /** The key for each skill slot, Q W E R by default; lowercase single characters. */
  skillKeys: string[]
  /** The key for each item slot, 1 to 5 by default. */
  itemKeys: string[]
  /** Render density: the screen's (capped at 2), or 1x or 2x whatever the screen. */
  density: Density
  /** Robots' cast shadows in game (a render pass per robot on screen). Applies from the next run. */
  shadows: boolean
  /** The fps and socket-bytes overlay (also `?stats=1`). */
  perfOverlay: boolean
}

export const SETTINGS_KEY = 'plunderland_settings'

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  skillKeys: ['q', 'w', 'e', 'r'],
  itemKeys: ['1', '2', '3', '4', '5'],
  density: 'auto',
  shadows: true,
  perfOverlay: false
})

/**
 * Keys that can't be bound: Enter and Space are the run card's PLAY AGAIN,
 * Escape opens and closes settings. Anything longer than one character
 * (Shift, the arrows, F-keys) isn't offered either: the game reads keys by
 * `KeyboardEvent.key`, and a single character reads the same on every layout
 * that types it.
 */
const RESERVED = new Set([' ', 'enter', 'escape'])

/** A key as it is stored and compared: lowercase. */
export function normaliseKey (key: string): string {
  return key.toLowerCase()
}

/** Whether `key` (a `KeyboardEvent.key`) can be bound. */
export function bindable (key: string): boolean {
  const k = normaliseKey(key)
  // Array.from, not a spread: the client's tsconfig targets ES5 for typechecking.
  return Array.from(k).length === 1 && !RESERVED.has(k)
}

/** How a key is shown: upper case. */
export function keyLabel (key: string): string {
  return key.toUpperCase()
}

function keysOf (value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length !== fallback.length) return [...fallback]
  if (!value.every((k) => typeof k === 'string' && bindable(k))) return [...fallback]
  return value.map((k: string) => normaliseKey(k))
}

/** Settings from storage's JSON; every field that doesn't read falls back to its default, and so do clashing keys. */
export function parseSettings (raw: string | null): Settings {
  let data: Record<string, unknown> = {}
  try {
    const parsed: unknown = raw === null ? {} : JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') data = parsed as Record<string, unknown>
  } catch {
    // Unreadable: all defaults.
  }
  let skillKeys = keysOf(data.skillKeys, DEFAULT_SETTINGS.skillKeys)
  let itemKeys = keysOf(data.itemKeys, DEFAULT_SETTINGS.itemKeys)
  if (new Set([...skillKeys, ...itemKeys]).size !== skillKeys.length + itemKeys.length) {
    skillKeys = [...DEFAULT_SETTINGS.skillKeys]
    itemKeys = [...DEFAULT_SETTINGS.itemKeys]
  }
  return {
    skillKeys,
    itemKeys,
    density: data.density === '1' || data.density === '2' || data.density === 'auto' ? data.density : DEFAULT_SETTINGS.density,
    shadows: typeof data.shadows === 'boolean' ? data.shadows : DEFAULT_SETTINGS.shadows,
    perfOverlay: typeof data.perfOverlay === 'boolean' ? data.perfOverlay : DEFAULT_SETTINGS.perfOverlay
  }
}

/**
 * `key` on slot `index` of `group`. A key already bound elsewhere (in either
 * group) swaps with the key it replaces, so no key ever does two things and
 * no slot is left without one. An unbindable key changes nothing.
 */
export function bindKey (settings: Settings, group: 'skillKeys' | 'itemKeys', index: number, key: string): Settings {
  if (!bindable(key) || index < 0 || index >= settings[group].length) return settings
  const k = normaliseKey(key)
  const next = { ...settings, skillKeys: [...settings.skillKeys], itemKeys: [...settings.itemKeys] }
  const old = next[group][index]
  for (const g of ['skillKeys', 'itemKeys'] as const) {
    const at = next[g].indexOf(k)
    if (at >= 0) next[g][at] = old
  }
  next[group][index] = k
  return next
}

/** The render resolution for a setting and the screen's devicePixelRatio. */
export function densityFor (density: Density, devicePixelRatio: number): number {
  if (density === '1') return 1
  if (density === '2') return 2
  return Math.min(2, Math.max(1, devicePixelRatio || 1))
}

/** What this page needs of localStorage; a failure means "not remembered". */
export interface SettingsStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** The settings in force, and who wants to hear when they change (the HUD, the renderer). */
export const SETTINGS: { value: Settings, listeners: Set<() => void> } = { value: parseSettings(null), listeners: new Set() }

/** Read the stored settings into `SETTINGS` (once, at boot). */
export function loadSettings (storage: SettingsStorage | undefined): void {
  let raw: string | null = null
  try {
    raw = storage?.getItem(SETTINGS_KEY) ?? null
  } catch {
    // Not remembered: defaults.
  }
  SETTINGS.value = parseSettings(raw)
}

/** Put `value` in force, store it, and tell the listeners. */
export function setSettings (value: Settings, storage: SettingsStorage | undefined): void {
  SETTINGS.value = value
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(value))
  } catch {
    // Not remembered: in force for this page only.
  }
  SETTINGS.listeners.forEach((listener) => {
    try {
      listener()
    } catch {
      // One broken listener must not stop the others.
    }
  })
}
