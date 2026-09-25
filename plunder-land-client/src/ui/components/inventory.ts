import { Container, Text } from 'pixi.js'
import { Game } from '../../game'
import { Aim } from '../../skills/aim'
import { Hex } from '../../utils/hex'
import { Vector } from '../../utils/vector'
import { INVENTORY_SLOTS, itemInSlot } from '../../utils/items'
import { TextEffect } from '../elements/texteffect'

/**
 * The inventory, as small as it can be until `hud-rebuild`: one line per slot
 * that has a kind (`1 MEDKIT x2`), and keys 1-5 to use one.
 *
 * Slots are fixed per kind (utils/items.ts), so key 1 is always the medkit and
 * key 2 always the bomb, whether or not one is carried.
 */
export class Inventory extends Container {
  private _counts: number[] = new Array<number>(INVENTORY_SLOTS).fill(0)
  private readonly _lines: Text[] = []

  constructor () {
    super()
    for (let slot = 0; slot < INVENTORY_SLOTS; slot++) {
      if (itemInSlot(slot) === undefined) continue
      const line = new Text('', {
        fontFamily: 'Lilliput Steps',
        fontSize: 24,
        fill: '0xA39171',
        stroke: 'black',
        strokeThickness: 6
      })
      line.y = this._lines.length * 28
      this._lines[slot] = line
      this.addChild(line)
    }
    this.redraw()
  }

  /** The `inventory` field, as the server sent it: a count per slot. */
  update (counts: number[]): void {
    this._counts = counts.slice(0, INVENTORY_SLOTS)
    this.redraw()
  }

  private redraw (): void {
    for (let slot = 0; slot < INVENTORY_SLOTS; slot++) {
      const info = itemInSlot(slot)
      const line = this._lines[slot]
      if (info === undefined || line === undefined) continue
      const count = this._counts[slot] ?? 0
      line.text = `${slot + 1} ${info.label} x${count}`
      line.alpha = count > 0 ? 1 : 0.45
    }
  }

  /**
   * Use the item in a 0-based slot: the `use_item` message, in the same bytes
   * as a skill press (`Aim.message`). An item that aims sends the cell under
   * the mouse, or no aim (the server then throws along facing). An aim the
   * client can already see is out of range is not sent; the server checks
   * again against its own position, and may still refuse one at the edge.
   */
  use (slot: number): void {
    const info = itemInSlot(slot)
    if (info === undefined || (this._counts[slot] ?? 0) <= 0 || Game.PLAYER === undefined) return

    let cell: Vector | undefined
    if (info.aimRange !== null) {
      cell = Aim.cell()
      if (cell !== undefined) {
        const own = Hex.toCell(new Vector(Game.LOCAL.x, Game.LOCAL.y))
        if (Hex.distance(own, cell) > info.aimRange) {
          new TextEffect('TOO FAR', Game.CONTAINER, Game.LOCAL.x, Game.LOCAL.y - 40, 24, 'orange', 300) // eslint-disable-line no-new
          return
        }
      }
    }

    Game.socket.emit('use_item', Aim.message(slot, cell))
  }
}
