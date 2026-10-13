/**
 * Sound effects (L3, the minimal pass before the itch soft launch, #56).
 * Every sound is a named slot; the files behind a slot are Nick's picks from
 * Kenney's CC0 packs (`assets/res/sfx/LICENSE.txt`), and swapping a sound is
 * a change to `BANK` only. A slot with several files plays one at random,
 * never the same twice running, so repeats don't sound mechanical.
 *
 * - Web Audio, no library. Browsers start audio only after a user gesture,
 *   so the context is made on the first pointer or key press and the files
 *   load then; anything played before that is dropped, not queued.
 * - Ogg Vorbis where the browser plays it, else MP3 (older Safari). Paths
 *   are relative (`./res/sfx/`), so the build also runs from a portal's
 *   subfolder (itch).
 * - Positional only by distance: a sound `at` a point fades out between
 *   `NEAR` and `FAR` from the listener (your robot, or the one you
 *   spectate) and isn't played beyond. No panning.
 * - The volume is its own setting (`SOUND_KEY`), not part of `Settings`:
 *   OFF, LOW, MID, HIGH. Hidden tabs are silent (the context is suspended).
 */

/** The slots. Append freely; the names are only read here and at the call sites. */
export type SfxName =
  | 'shot_ranged' | 'skill_heavy' | 'melee_swing' | 'hit_landed' | 'damage_taken'
  | 'kill' | 'death' | 'death_sting' | 'blast'
  | 'loot_pickup' | 'gear_pickup'
  | 'extract_loop' | 'extract_tick' | 'extract_done' | 'portal' | 'low_hp'
  | 'compactor_windup' | 'compactor_slam' | 'kiln_launch' | 'kiln_land'
  | 'broodling_fuse' | 'broodling_blast' | 'reactor_windup' | 'coil_pulse'
  | 'level_up' | 'ready'
  | 'ui_click' | 'ui_hover' | 'ui_toggle' | 'ui_back' | 'ui_error'

interface Slot {
  /** File names in `res/sfx/`, without the extension. */
  files: string[]
  /** Its level against the others, 0-1 (the files' loudness differs a lot). */
  gain: number
  /** Not again within this, ms: keeps a burst of hits from stacking up. */
  gapMs?: number
  /** Played at a random rate within ±this, for variety (impacts, shots). */
  vary?: number
}

/** Nick's picks, 2026-10-13 (the audition page); `blast` is the player skills' blasts, reusing the Kiln's. */
const BANK: Record<SfxName, Slot> = {
  shot_ranged: { files: ['laserSmall_000', 'laserSmall_003', 'laserSmall_004'], gain: 0.45, gapMs: 40, vary: 0.05 },
  skill_heavy: { files: ['laserLarge_003', 'laserLarge_001'], gain: 0.5, gapMs: 60, vary: 0.04 },
  melee_swing: { files: ['impactPunch_heavy_004', 'impactPunch_heavy_000'], gain: 0.5, gapMs: 60, vary: 0.05 },
  hit_landed: { files: ['impactPlate_light_001', 'impactPlate_light_002', 'impactPlate_light_000'], gain: 0.6, gapMs: 70, vary: 0.08 },
  damage_taken: { files: ['impactPlate_heavy_001', 'impactPlate_heavy_004'], gain: 0.6, gapMs: 120, vary: 0.05 },
  kill: { files: ['explosionCrunch_004'], gain: 0.55, gapMs: 80 },
  death: { files: ['explosionCrunch_004'], gain: 0.7 },
  death_sting: { files: ['jingles_HIT11'], gain: 0.7 },
  blast: { files: ['explosionCrunch_000', 'explosionCrunch_004'], gain: 0.45, gapMs: 80, vary: 0.06 },
  loot_pickup: { files: ['chips-stack-4', 'chips-stack-5', 'chips-handle-1', 'chips-stack-1'], gain: 0.8, gapMs: 60 },
  gear_pickup: { files: ['glass_002'], gain: 0.7, gapMs: 60 },
  extract_loop: { files: ['forceField_001'], gain: 0.3 },
  extract_tick: { files: ['tick_004'], gain: 0.6 },
  extract_done: { files: ['jingles_HIT01'], gain: 0.7 },
  portal: { files: ['doorClose_001', 'doorClose_002'], gain: 0.6 },
  low_hp: { files: ['tick_002'], gain: 0.6 },
  compactor_windup: { files: ['spaceEngineLow_000'], gain: 0.3 },
  compactor_slam: { files: ['impactPlate_heavy_001'], gain: 0.7, vary: 0.04 },
  kiln_launch: { files: ['thrusterFire_001'], gain: 0.5 },
  kiln_land: { files: ['explosionCrunch_004'], gain: 0.6, gapMs: 60, vary: 0.05 },
  broodling_fuse: { files: ['slime_000'], gain: 0.9, gapMs: 80 },
  broodling_blast: { files: ['explosionCrunch_000'], gain: 0.6, gapMs: 60, vary: 0.06 },
  reactor_windup: { files: ['spaceEngineLarge_002'], gain: 0.3 },
  coil_pulse: { files: ['forceField_003'], gain: 0.3, gapMs: 200 },
  level_up: { files: ['jingles_STEEL08'], gain: 0.7 },
  ready: { files: ['confirmation_001'], gain: 0.5 },
  ui_click: { files: ['click1'], gain: 0.5, gapMs: 40 },
  ui_hover: { files: ['rollover2'], gain: 0.25, gapMs: 60 },
  ui_toggle: { files: ['switch1'], gain: 0.5, gapMs: 40 },
  ui_back: { files: ['back_004'], gain: 0.5, gapMs: 40 },
  ui_error: { files: ['error_002'], gain: 0.5, gapMs: 150 }
}

/** Full volume within this of the listener, world px. */
const NEAR = 200
/** Silent from this far, world px (about a robot's vision and a bit). */
const FAR = 800

export type SoundLevel = 0 | 1 | 2 | 3
/** The master gain at each level: OFF, LOW, MID, HIGH. */
const LEVEL_GAIN = [0, 0.35, 0.65, 1]
export const SOUND_KEY = 'plunderland_sound'
const DEFAULT_LEVEL: SoundLevel = 2

/** What `SOUND_KEY` holds, read back; anything else is the default. */
export function parseLevel (raw: string | null): SoundLevel {
  const n = Number(raw)
  return raw !== null && (n === 0 || n === 1 || n === 2 || n === 3) ? n : DEFAULT_LEVEL
}

/** How loud a sound at `distance` from the listener plays, 0-1. */
export function falloff (distance: number): number {
  if (distance <= NEAR) return 1
  if (distance >= FAR) return 0
  return 1 - (distance - NEAR) / (FAR - NEAR)
}

export interface Point { x: number, y: number }

export interface PlayOptions {
  /** Where it happens, world px; omitted, it plays at full volume (your own events, the UI). */
  at?: Point
  /** Multiplies the slot's gain. */
  gain?: number
  /** Playback rate (pitch), before the slot's variety. */
  rate?: number
  /** Repeats until stopped. */
  loop?: boolean
}

/** A sound playing, which can be faded out. */
export interface Voice { stop: (fadeMs?: number) => void }

const SILENT: Voice = { stop: () => {} }

function storage (): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export class Sfx {
  /** Where the listener is, world px; set by `Game`. Undefined: positional sounds are dropped. */
  static listener: () => Point | undefined = () => undefined

  private static ctx: AudioContext | undefined
  private static master: GainNode | undefined
  private static readonly buffers = new Map<string, AudioBuffer>()
  private static readonly lastAt = new Map<SfxName, number>()
  private static readonly lastFile = new Map<SfxName, string>()
  private static _level: SoundLevel = DEFAULT_LEVEL

  static get level (): SoundLevel { return Sfx._level }

  /** Reads the stored volume and waits for the first gesture to start audio. Once, at boot. */
  static init (): void {
    let raw: string | null = null
    try {
      raw = storage()?.getItem(SOUND_KEY) ?? null
    } catch {
      // Not remembered: the default.
    }
    Sfx._level = parseLevel(raw)
    const unlock = (): void => {
      Sfx.start()
      if (Sfx.ctx?.state === 'running') {
        window.removeEventListener('pointerdown', unlock, true)
        window.removeEventListener('keydown', unlock, true)
      }
    }
    window.addEventListener('pointerdown', unlock, true)
    window.addEventListener('keydown', unlock, true)
    document.addEventListener('visibilitychange', () => {
      if (Sfx.ctx === undefined) return
      if (document.hidden) void Sfx.ctx.suspend().catch(() => {})
      else void Sfx.ctx.resume().catch(() => {})
    })
  }

  static setLevel (level: SoundLevel): void {
    Sfx._level = level
    if (Sfx.master !== undefined) Sfx.master.gain.value = LEVEL_GAIN[level]
    try {
      storage()?.setItem(SOUND_KEY, String(level))
    } catch {
      // Not remembered: in force for this page only.
    }
  }

  /** Makes (or resumes) the context inside a gesture, and loads the files the first time. */
  private static start (): void {
    if (Sfx.ctx !== undefined) {
      if (Sfx.ctx.state === 'suspended' && !document.hidden) void Sfx.ctx.resume().catch(() => {})
      return
    }
    const Ctor: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (Ctor === undefined) return
    const ctx = Sfx.ctx = new Ctor()
    const master = Sfx.master = ctx.createGain()
    master.gain.value = LEVEL_GAIN[Sfx._level]
    master.connect(ctx.destination)
    void Sfx.load(ctx)
  }

  private static async load (ctx: AudioContext): Promise<void> {
    const ext = new Audio().canPlayType('audio/ogg; codecs="vorbis"') !== '' ? 'ogg' : 'mp3'
    const names = new Set<string>()
    for (const slot of Object.values(BANK)) slot.files.forEach((f) => names.add(f))
    let failed = 0
    await Promise.all(Array.from(names).map(async (name) => {
      try {
        const res = await fetch(`./res/sfx/${name}.${ext}`)
        if (!res.ok) throw new Error(String(res.status))
        const data = await res.arrayBuffer()
        // The callback form: older Safari has no promise from decodeAudioData.
        const buffer = await new Promise<AudioBuffer>((resolve, reject) => { void ctx.decodeAudioData(data, resolve, reject) })
        Sfx.buffers.set(name, buffer)
      } catch {
        failed++
      }
    }))
    // One line for the lot, not one per play: a slot whose files are missing stays silent.
    if (failed > 0) console.warn(`sfx: ${failed} of ${names.size} sounds did not load`)
  }

  /** Plays a slot; returns a voice to stop it (a loop, a wind-up cut at its impact). */
  static play (name: SfxName, options: PlayOptions = {}): Voice {
    const ctx = Sfx.ctx
    const master = Sfx.master
    if (ctx === undefined || master === undefined || ctx.state !== 'running' || Sfx._level === 0) return SILENT
    const slot = BANK[name]

    let gain = slot.gain * (options.gain ?? 1)
    if (options.at !== undefined) {
      const at = Sfx.listener()
      if (at === undefined) return SILENT
      gain *= falloff(Math.hypot(options.at.x - at.x, options.at.y - at.y))
    }
    if (gain <= 0.01) return SILENT

    const now = performance.now()
    if (slot.gapMs !== undefined && now - (Sfx.lastAt.get(name) ?? -Infinity) < slot.gapMs) return SILENT

    const file = Sfx.pick(name, slot)
    const buffer = file === undefined ? undefined : Sfx.buffers.get(file)
    if (buffer === undefined) return SILENT
    Sfx.lastAt.set(name, now)

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = options.loop === true
    const vary = slot.vary ?? 0
    source.playbackRate.value = (options.rate ?? 1) * (1 + (Math.random() * 2 - 1) * vary)
    const level = ctx.createGain()
    level.gain.value = gain
    // Two calls, not a chain: older Safari's connect returns nothing.
    source.connect(level)
    level.connect(master)
    source.start()

    let stopped = false
    return {
      stop: (fadeMs = 60) => {
        if (stopped) return
        stopped = true
        const t = ctx.currentTime
        level.gain.setValueAtTime(level.gain.value, t)
        level.gain.linearRampToValueAtTime(0, t + fadeMs / 1000)
        try {
          source.stop(t + fadeMs / 1000 + 0.01)
        } catch {
          // Already ended.
        }
      }
    }
  }

  /** A random file of the slot, not the one it played last. */
  private static pick (name: SfxName, slot: Slot): string | undefined {
    const { files } = slot
    if (files.length <= 1) return files[0]
    const last = Sfx.lastFile.get(name)
    const choices = files.filter((f) => f !== last)
    const file = choices[Math.floor(Math.random() * choices.length)]
    Sfx.lastFile.set(name, file)
    return file
  }

  /**
   * Clicks for the DOM menus (lobby, settings, stash, loadout), by delegation,
   * so a new button needs no wiring: anything with an `onclick` handler.
   * Closing buttons sound `ui_back`, choices and chips `ui_toggle`, the rest
   * `ui_click`; READY is the lobby's own (`ready`). Hover on a mouse only.
   */
  static bindDom (root: Document): void {
    // A button or link, or a card with a handler (a robot card, a stash slot).
    // An element with a handler that holds buttons is a backdrop (settings'
    // closes on a click on itself only): it counts only when it is the target.
    const clickable = (target: EventTarget | null): HTMLElement | undefined => {
      let el = target instanceof HTMLElement ? target : null
      while (el !== null) {
        if (el.tagName === 'BUTTON' || el.tagName === 'A') return el
        if (el.onclick !== null) return el.querySelector('button') === null || el === target ? el : undefined
        el = el.parentElement
      }
      return undefined
    }
    root.addEventListener('click', (e) => {
      const el = clickable(e.target)
      if (el === undefined || el.classList.contains('lb-ready') || (el as HTMLButtonElement).disabled === true) return
      const c = typeof el.className === 'string' ? el.className : ''
      const backdrop = el.tagName !== 'BUTTON' && el.querySelector('button') !== null
      if (backdrop || /close|done|-x\b|cancel/.test(c)) Sfx.play('ui_back')
      else if (/st-opt|st-key|chip|tab|jarrow|lo-skill/.test(c)) Sfx.play('ui_toggle')
      else Sfx.play('ui_click')
    }, true)
    let hovered: HTMLElement | undefined
    root.addEventListener('pointerover', (e) => {
      if (e.pointerType !== 'mouse') return
      const el = clickable(e.target)
      if (el === hovered) return
      hovered = el
      if (el !== undefined && el.tagName === 'BUTTON' && !(el as HTMLButtonElement).disabled) Sfx.play('ui_hover')
    }, true)
  }
}
