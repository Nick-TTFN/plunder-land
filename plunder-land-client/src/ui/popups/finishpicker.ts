import {
  type Finish, type FinishGroup, FINISH_GROUPS, FINISH_PRESETS, PALETTE, PATTERNS,
  finishFromBytes, finishToBytes, patternById
} from '../../utils/finishes'

const FINISH_KEY = 'plunderland_player_finish'

/**
 * The robot finish picker on the enter screen (robot-finishes, #41): a preset
 * button that cycles the drop's six presets, then per group (head, body,
 * limbs) the palette's swatches and a button that cycles the patterns.
 * Placeholder looks, like the name field it sits above: DOM laid over the
 * canvas, because pixi has no form controls, and restyled when the enter
 * screen gets its art (the robot-preview milestone). Every finish is free
 * until meta-progression exists (Nick, 2026-09-30).
 *
 * The choice is remembered in localStorage as its wire bytes, and anything
 * unreadable there (or storage that throws) is the default finish.
 */
export class FinishPicker {
  readonly element: HTMLDivElement
  private finish: Finish
  private presetIndex = -1
  private readonly swatches: Record<FinishGroup, HTMLButtonElement[]> = { head: [], body: [], limbs: [] }
  private readonly patternButtons: Partial<Record<FinishGroup, HTMLButtonElement>> = {}
  private readonly presetButton: HTMLButtonElement

  constructor (private readonly onChange: (finish: Finish) => void) {
    this.finish = FinishPicker.remembered()

    const root = document.createElement('div')
    const style = root.style
    style.position = 'fixed'
    style.left = '50%'
    style.transform = 'translate(-50%, -50%)'
    style.display = 'flex'
    style.flexDirection = 'column'
    style.alignItems = 'center'
    style.gap = '3px'
    style.fontFamily = '"Lilliput Steps", monospace'
    style.fontSize = '10px'
    style.color = '#e8dcc0'
    style.zIndex = '10'
    style.userSelect = 'none'
    // Skill keys are bound on window; none of this is game input.
    root.addEventListener('keydown', (e) => { e.stopPropagation() })
    root.addEventListener('keyup', (e) => { e.stopPropagation() })

    this.presetButton = FinishPicker.button('', 150)
    this.presetButton.addEventListener('click', () => { this.nextPreset() })
    root.appendChild(this.presetButton)

    for (const group of FINISH_GROUPS) {
      const row = document.createElement('div')
      row.style.display = 'flex'
      row.style.alignItems = 'center'
      row.style.gap = '2px'

      const label = document.createElement('span')
      label.textContent = group.toUpperCase()
      label.style.width = '38px'
      row.appendChild(label)

      for (const colour of PALETTE) {
        const swatch = document.createElement('button')
        swatch.type = 'button'
        swatch.title = colour.label
        const s = swatch.style
        s.width = '14px'
        s.height = '14px'
        s.padding = '0'
        s.cursor = 'pointer'
        s.background = `rgb(${colour.rgb.join(',')})`
        swatch.addEventListener('click', () => { this.set(group, { colour: colour.id }) })
        this.swatches[group].push(swatch)
        row.appendChild(swatch)
      }

      const pattern = FinishPicker.button('', 58)
      pattern.style.marginLeft = '4px'
      pattern.addEventListener('click', () => {
        const at = PATTERNS.findIndex((p) => p.id === this.finish[group].pattern)
        this.set(group, { pattern: PATTERNS[(at + 1) % PATTERNS.length].id })
      })
      this.patternButtons[group] = pattern
      row.appendChild(pattern)

      root.appendChild(row)
    }

    this.element = root
    this.presetIndex = FINISH_PRESETS.findIndex((p) => FinishPicker.same(p.finish, this.finish))
    this.refresh()
  }

  get value (): Finish {
    return this.finish
  }

  /** `offsetY` is from the viewport's centre, like the name field's. */
  place (offsetY: number): void {
    this.element.style.top = `calc(50% + ${Math.round(offsetY)}px)`
  }

  /** Remembers the choice; called on start, like the name. */
  remember (): void {
    try {
      localStorage.setItem(FINISH_KEY, JSON.stringify(finishToBytes(this.finish)))
    } catch (e) {
      // Not remembered past this page; the join goes ahead.
    }
  }

  private static remembered (): Finish {
    try {
      const raw = localStorage.getItem(FINISH_KEY)
      return finishFromBytes(raw === null ? undefined : JSON.parse(raw))
    } catch (e) {
      return finishFromBytes(undefined)
    }
  }

  private static same (a: Finish, b: Finish): boolean {
    return FINISH_GROUPS.every((g) => a[g].colour === b[g].colour && a[g].pattern === b[g].pattern)
  }

  private static button (text: string, width: number): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = text
    const s = button.style
    s.width = `${width}px`
    s.height = '16px'
    s.padding = '0'
    s.cursor = 'pointer'
    s.font = 'inherit'
    s.color = 'inherit'
    s.background = 'rgba(0, 0, 0, 0.35)'
    s.border = '1px solid #A39171'
    return button
  }

  private nextPreset (): void {
    this.presetIndex = (this.presetIndex + 1) % FINISH_PRESETS.length
    this.finish = FINISH_PRESETS[this.presetIndex].finish
    this.changed()
  }

  private set (group: FinishGroup, change: { colour?: number, pattern?: number }): void {
    this.finish = { ...this.finish, [group]: { ...this.finish[group], ...change } }
    this.presetIndex = FINISH_PRESETS.findIndex((p) => FinishPicker.same(p.finish, this.finish))
    this.changed()
  }

  private changed (): void {
    this.refresh()
    this.onChange(this.finish)
  }

  private refresh (): void {
    const preset = FINISH_PRESETS[this.presetIndex]
    this.presetButton.textContent = `finish: ${preset !== undefined ? preset.label.toLowerCase() : 'custom'}`
    for (const group of FINISH_GROUPS) {
      const { colour, pattern } = this.finish[group]
      PALETTE.forEach((c, i) => {
        const selected = c.id === colour
        this.swatches[group][i].style.border = selected ? '2px solid #ffffff' : '1px solid rgba(0, 0, 0, 0.6)'
      })
      this.patternButtons[group]!.textContent = (patternById(pattern)?.label ?? '').toLowerCase()
    }
  }
}
