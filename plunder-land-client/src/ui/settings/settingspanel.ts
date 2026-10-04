import {
  type Density, DEFAULT_SETTINGS, SETTINGS, type Settings, bindKey, bindable, keyLabel, setSettings
} from '../../net/settings'
import { localTokenStorage } from '../../net/account'

/**
 * The settings panel (L3, without sound): key bindings, graphics and the
 * performance overlay, with a greyed SOUND row until there are sounds. DOM
 * over the canvas, like the lobby, in the same placeholder chrome (`st-`
 * classes). Opened from the lobby's SETTINGS button and with Escape in game;
 * Escape or DONE closes it. While it is open every key is its own: a key
 * meant for a binding must not also cast a skill.
 *
 * Every change is in force and stored at once (`setSettings`); there is no
 * apply step. Shadows apply from the next run (each robot's shadow is built
 * with the robot).
 */
const STYLE = `
.st { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center;
  background: rgba(4,7,13,.55); color: #E6EEF5; font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace; user-select: none; }
.st-panel { width: min(460px, calc(100% - 32px)); max-height: calc(100% - 32px); overflow-y: auto; padding: 18px 20px; border-radius: 10px;
  background: rgba(11,18,32,.96); border: 1px solid #3a6e7e; box-shadow: 0 0 24px rgba(61,224,208,.18); }
.st-head { display: flex; justify-content: space-between; align-items: center; font-size: 22px; letter-spacing: .18em;
  padding-bottom: 12px; border-bottom: 1px solid #1E3344; }
.st-close { background: none; border: 0; color: #E6EEF5; font-size: 28px; cursor: pointer; }
.st-section { padding: 12px 0 4px; font-size: 13px; letter-spacing: .16em; color: #7f95a8; }
.st-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 7px 0; font-size: 14px; letter-spacing: .08em; }
.st-row.st-off { color: #55687a; }
.st-keys { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.st-key { min-width: 38px; padding: 6px 8px; font: inherit; font-size: 14px; color: #E6EEF5; background: #121d2c;
  border: 1px solid #3a5266; border-radius: 5px; cursor: pointer; text-align: center; }
.st-key small { display: block; font-size: 9px; color: #7f95a8; letter-spacing: .06em; }
.st-key.st-wait { border-color: #3DE0D0; color: #3DE0D0; }
.st-choice { display: flex; gap: 6px; }
.st-opt { padding: 5px 10px; font: inherit; font-size: 13px; color: #a9bccd; background: transparent; border: 1px solid #3a5266; border-radius: 5px; cursor: pointer; }
.st-opt.st-on { color: #0B1220; background: #3DE0D0; border-color: #3DE0D0; }
.st-hint { font-size: 11px; color: #7f95a8; letter-spacing: .06em; padding: 4px 0 8px; }
.st-foot { display: flex; justify-content: space-between; padding-top: 14px; border-top: 1px solid #1E3344; margin-top: 10px; }
.st-reset { padding: 8px 14px; font: inherit; font-size: 13px; letter-spacing: .12em; color: #a9bccd; background: none; border: 1px solid #3a5266; border-radius: 6px; cursor: pointer; }
.st-done { padding: 10px 36px; font: inherit; font-size: 17px; letter-spacing: .14em; font-weight: 700; color: #0B1220; background: #3DE0D0; border: 0; border-radius: 6px; cursor: pointer; }
`

function el<K extends keyof HTMLElementTagNameMap> (tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const SKILL_SLOT_NAMES = ['SLOT 1', 'SLOT 2', 'SLOT 3', 'SLOT 4']
const ITEM_SLOT_NAMES = ['MEDKIT', 'BOMB', 'ITEM 3', 'ITEM 4', 'ITEM 5']

export class SettingsPanel {
  /** The one open panel, if any. */
  static open: SettingsPanel | undefined

  private readonly root: HTMLDivElement
  private readonly body: HTMLDivElement
  /** The binding waiting for a key, if any. */
  private waiting: { group: 'skillKeys' | 'itemKeys', index: number } | undefined
  private readonly onKey = (e: KeyboardEvent): void => { this.key(e) }

  /** Open it (once; a second call while open does nothing). `onClose` runs when it closes. */
  static show (onClose?: () => void): void {
    if (SettingsPanel.open !== undefined) return
    SettingsPanel.open = new SettingsPanel(onClose)
  }

  /** Escape in game: open it, or close it if open. */
  static toggle (): void {
    if (SettingsPanel.open !== undefined) SettingsPanel.open.close()
    else SettingsPanel.show()
  }

  private constructor (private readonly onClose?: () => void) {
    if (document.getElementById('settings-style') === null) {
      const style = el('style')
      style.id = 'settings-style'
      style.textContent = STYLE
      document.head.append(style)
    }
    this.root = el('div', 'st')
    this.root.onclick = (e) => { if (e.target === this.root) this.close() }
    const panel = el('div', 'st-panel')
    const head = el('div', 'st-head')
    const close = el('button', 'st-close', '×')
    close.onclick = () => { this.close() }
    head.append(el('span', undefined, 'SETTINGS'), close)
    this.body = el('div')
    const foot = el('div', 'st-foot')
    const reset = el('button', 'st-reset', 'RESET')
    reset.onclick = () => { this.change({ ...DEFAULT_SETTINGS, skillKeys: [...DEFAULT_SETTINGS.skillKeys], itemKeys: [...DEFAULT_SETTINGS.itemKeys] }) }
    const done = el('button', 'st-done', 'DONE')
    done.onclick = () => { this.close() }
    foot.append(reset, done)
    panel.append(head, this.body, foot)
    this.root.append(panel)
    document.body.append(this.root)
    window.addEventListener('keydown', this.onKey, true)
    this.render()
  }

  close (): void {
    window.removeEventListener('keydown', this.onKey, true)
    this.root.remove()
    if (SettingsPanel.open === this) SettingsPanel.open = undefined
    this.onClose?.()
  }

  private change (value: Settings): void {
    setSettings(value, localTokenStorage())
    this.render()
  }

  private key (e: KeyboardEvent): void {
    // Every key is the panel's while it is open.
    e.stopImmediatePropagation()
    if (this.waiting !== undefined) {
      e.preventDefault()
      if (e.key !== 'Escape' && bindable(e.key)) this.change(bindKey(SETTINGS.value, this.waiting.group, this.waiting.index, e.key))
      this.waiting = undefined
      this.render()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      this.close()
    }
  }

  private render (): void {
    const s = SETTINGS.value
    this.body.replaceChildren()
    this.body.append(el('div', 'st-section', 'CONTROLS'))
    this.body.append(this.keyRow('SKILLS', 'skillKeys', SKILL_SLOT_NAMES))
    this.body.append(this.keyRow('ITEMS', 'itemKeys', ITEM_SLOT_NAMES))
    this.body.append(el('div', 'st-hint', 'Click a key, then press the new one. A key already in use swaps places. Movement is click to move.'))

    this.body.append(el('div', 'st-section', 'GRAPHICS'))
    const density = el('div', 'st-row')
    density.append(el('span', undefined, 'RESOLUTION'), this.choice<Density>([['auto', 'AUTO'], ['1', '1X'], ['2', '2X']], s.density, (density) => { this.change({ ...SETTINGS.value, density }) }))
    this.body.append(density)
    const shadows = el('div', 'st-row')
    shadows.append(el('span', undefined, 'ROBOT SHADOWS'), this.choice<boolean>([[true, 'ON'], [false, 'OFF']], s.shadows, (shadows) => { this.change({ ...SETTINGS.value, shadows }) }))
    this.body.append(shadows)
    this.body.append(el('div', 'st-hint', '1X is lighter on slow machines. Shadows change from the next run.'))
    const perf = el('div', 'st-row')
    perf.append(el('span', undefined, 'PERFORMANCE OVERLAY'), this.choice<boolean>([[true, 'ON'], [false, 'OFF']], s.perfOverlay, (perfOverlay) => { this.change({ ...SETTINGS.value, perfOverlay }) }))
    this.body.append(perf)

    this.body.append(el('div', 'st-section', 'SOUND'))
    this.body.append(el('div', 'st-row st-off', 'VOLUME  ·  COMING WITH SOUNDS'))
  }

  private keyRow (label: string, group: 'skillKeys' | 'itemKeys', names: string[]): HTMLDivElement {
    const row = el('div', 'st-row')
    const keys = el('div', 'st-keys')
    SETTINGS.value[group].forEach((key, index) => {
      const wait = this.waiting?.group === group && this.waiting.index === index
      const button = el('button', wait ? 'st-key st-wait' : 'st-key', wait ? '?' : keyLabel(key))
      button.append(el('small', undefined, names[index] ?? ''))
      button.title = `${names[index] ?? ''}: click, then press a key`
      button.onclick = () => {
        this.waiting = wait ? undefined : { group, index }
        this.render()
      }
      keys.append(button)
    })
    row.append(el('span', undefined, label), keys)
    return row
  }

  private choice<T> (options: Array<[T, string]>, current: T, pick: (value: T) => void): HTMLDivElement {
    const box = el('div', 'st-choice')
    for (const [value, text] of options) {
      const b = el('button', value === current ? 'st-opt st-on' : 'st-opt', text)
      b.onclick = () => { pick(value) }
      box.append(b)
    }
    return box
  }
}
