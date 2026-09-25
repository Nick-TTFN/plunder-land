import { Container, Point, type Sprite, type Text, Texture } from 'pixi.js'
import { TapHandler } from '../elements/taphandler'
import AnimationClip from '../../animation/animationclip'
import { ToolKit } from '../components/toolkit'

const ID_KEY = 'plunderland_player_id'
const NAME_KEY = 'plunderland_player_name'

/**
 * The server's cap (server `Player.NAME_MAX`, 16 code points), as a typing
 * limit. Only a hint: the server sanitises and cuts whatever arrives, and
 * `maxLength` counts UTF-16 units, so an all-emoji name stops at 8 here.
 */
const NAME_MAX = 16

/**
 * localStorage can throw rather than return null: in some private windows, with
 * site data blocked, or in a sandboxed frame. None of that should stop a join,
 * so every access goes through these two and a failure means "not remembered".
 */
function readStorage (key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch (e) {
    return null
  }
}

function writeStorage (key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch (e) {
    // Not remembered past this page; the join goes ahead.
  }
}

/**
 * The id used when storage is unavailable, kept for the life of the page so a
 * reconnect (which rebuilds this popup) still joins as the same player and
 * keeps the same callsign.
 */
let _pageId: string | undefined

export default class GameEnterPopup extends Container {
  callback: (playerId: string, name: string) => Promise<void>
  bg: Sprite
  container: Container
  title: Text
  playerId: string = ''
  /**
   * pixi has no text input, so the name field is a DOM element laid over the
   * canvas while the popup is up, and removed with it.
   */
  nameInput: HTMLInputElement | undefined
  private _started = false

  constructor (callback: (playerId: string, name: string) => Promise<void>) {
    super()
    this.callback = callback

    this.container = new Container()
    this.addChild(this.container)
    this.bg = ToolKit.createSprite(Texture.from('UI/elements/bg.png'), new Point(0, 0), new Point(2, 2), ToolKit.TOP_LEFT_ANCHOR)
    this.container.addChild(this.bg)

    this.container.x = -this.bg.width / 2
    this.container.y = -this.bg.height / 2

    this.title = ToolKit.createText('PLUNDERLAND', new Point(this.bg.width / 2, 35))
    this.container.addChild(this.title)

    const playerPanel = new Container()
    playerPanel.position = new Point((this.bg.width - playerPanel.width) / 2, 110)

    playerPanel.addChild(ToolKit.createSprite(Texture.from('UI/elements/cell.png'), new Point(0, 0), new Point(2, 2)))

    const playerAnim = new AnimationClip('player/idle/idle', 0.2, true)
    playerAnim.play()
    playerPanel.addChild(playerAnim)

    this.container.addChild(playerPanel)

    // Removed from the stage by a start, or by a reconnect clearing the popups:
    // the DOM field has to go either way, or it floats over the game.
    this.on('removed', this.removeNameInput.bind(this))

    this.checkState()
  }

  genRanHex = (size: number): string => [...Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')

  checkState (): void {
    let playerId = readStorage(ID_KEY)

    if (playerId === null || playerId === '') {
      playerId = _pageId ?? this.genRanHex(6)
      writeStorage(ID_KEY, playerId)
    }
    _pageId = playerId
    this.playerId = playerId

    this.title.text = playerId

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    const startButton = new TapHandler(this.onStartClick.bind(this))

    startButton.addChild(ToolKit.createSprite(Texture.from('UI/elements/button.png'), new Point(0, 0), new Point(1, 1)))
    startButton.addChild(ToolKit.createText('start'))

    startButton.position = new Point((this.bg.width) / 2, (this.bg.height) - 45)
    this.container.addChild(startButton)

    // Between the robot and the start button: 70 above the button's centre.
    this.addNameInput(this.container.y + startButton.y - 70)
  }

  /** `offsetY` is from the popup's centre, which PopupManager keeps at the viewport's. */
  addNameInput (offsetY: number): void {
    if (typeof document === 'undefined') return

    const input = document.createElement('input')
    input.type = 'text'
    input.maxLength = NAME_MAX
    input.placeholder = 'name (optional)'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.value = readStorage(NAME_KEY) ?? ''

    const style = input.style
    style.position = 'fixed'
    style.left = '50%'
    style.top = `calc(50% + ${Math.round(offsetY)}px)`
    style.transform = 'translate(-50%, -50%)'
    style.width = '200px'
    style.padding = '6px 8px'
    style.fontFamily = '"Lilliput Steps", monospace'
    style.fontSize = '16px'
    style.textAlign = 'center'
    style.color = '#e8dcc0'
    style.background = 'rgba(0, 0, 0, 0.35)'
    style.border = '2px solid #A39171'
    style.outline = 'none'
    style.zIndex = '10'

    // Keys typed into the field are not game input: the HUD binds q-i to skills
    // and 's' toggles simulation, both on window. Enter starts.
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') this.onStartClick()
    })
    input.addEventListener('keyup', (e) => { e.stopPropagation() })

    document.body.appendChild(input)
    this.nameInput = input
  }

  removeNameInput (): void {
    this.nameInput?.remove()
    this.nameInput = undefined
  }

  onStartClick (): void {
    // Enter and a click can both land; a second start would register every
    // socket listener twice.
    if (this._started) return
    this._started = true

    const name = this.nameInput?.value.trim() ?? ''
    // An empty name is remembered too, so clearing the field sticks.
    writeStorage(NAME_KEY, name)

    void this.callback(this.playerId, name)
    this.parent?.removeChild(this)
  }
}
