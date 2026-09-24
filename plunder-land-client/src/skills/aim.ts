import { Point } from 'pixi.js'
import { Game } from '../game'
import { Session } from '../net/session'
import { Hex } from '../utils/hex'
import { Vector } from '../utils/vector'

/**
 * Where the desktop mouse is aiming, for skills (decision #21).
 *
 * Only the pointer's **screen** position is kept, and it is turned into a cell
 * at the moment a skill fires. The camera follows the player, so a mouse held
 * still points at a different world cell every frame the player walks; a cell
 * worked out on the last mouse-move would be stale by the time the key is
 * pressed.
 *
 * This records and nothing else. It never routes the player: click-to-move
 * stays a press on the stage, and the stage has no route-building move handler
 * (see `index.ts`).
 */
export class Aim {
  /** Last mouse position over the world, in canvas coordinates; undefined for none. */
  private static _screen: Point | undefined

  /**
   * A mouse moved. `overWorld` is false when the pointer is on something
   * interactive (the HUD), which is the same "target is not the stage" rule
   * click-to-move uses. Touch is ignored: mobile aiming is a later design
   * (drag from the button, or auto-aim), and a finger's last position is the
   * last tap, not an aim.
   */
  static track (x: number, y: number, pointerType: string | undefined, overWorld: boolean): void {
    if (pointerType !== undefined && pointerType !== 'mouse') return
    Aim._screen = overWorld ? new Point(x, y) : undefined
  }

  /** The mouse left the canvas. */
  static clear (): void {
    Aim._screen = undefined
  }

  /**
   * The absolute cell under the mouse, or undefined for "no aim": no mouse over
   * the world, a cell off the map, or the player's own cell. The server treats
   * no aim as "fire along facing", and it applies the own-cell rule again
   * against its own position.
   */
  static cell (): Vector | undefined {
    if (Aim._screen === undefined || Game.CONTAINER === undefined || Game.PLAYER === undefined) return undefined

    // The same transform click-to-move uses: the container carries the camera.
    const world = Game.CONTAINER.toLocal(Aim._screen)
    const cell = Hex.toCell(new Vector(world.x, world.y))
    if (!Hex.onMap(cell.x, cell.y, Session.mapSize)) return undefined

    const own = Hex.toCell(new Vector(Game.LOCAL.x, Game.LOCAL.y))
    if (own.x === cell.x && own.y === cell.y) return undefined

    return cell
  }

  /**
   * The `skill` message: `[uint8 slot][int16 q][int16 r]`, big-endian (the
   * DataView default, and what the server reads), with (q, r) the absolute cell.
   * Without an aim it is the bare slot number, the message's original form,
   * which the server still reads as "no aim".
   */
  static message (slot: number, cell: Vector | undefined): number | ArrayBuffer {
    if (cell === undefined) return slot
    const buf = new ArrayBuffer(5)
    const view = new DataView(buf)
    view.setUint8(0, slot)
    view.setInt16(1, cell.x)
    view.setInt16(3, cell.y)
    return buf
  }
}
