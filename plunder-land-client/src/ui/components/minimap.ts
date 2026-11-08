import { Graphics } from 'pixi.js'
import { Game } from '../../game'
import { Session } from '../../net/session'
import { Hex } from '../../utils/hex'

/** A hex row's height over its cell size (`Hex`'s private `ROW`). */
const ROW = Math.sqrt(3) / 2
/** The inset of the drawn layer inside the frame, px. */
const PAD = 6

/**
 * The minimap, kept as it was (decision #36). It draws only what the fog lets
 * the player see (`renderable`, set by `Game.applyFog`), or it would show
 * every unit the fog hides.
 *
 * Under the dots, the layer's ground: every cell that is not void
 * (`Game.VOIDS`, off-map included), walls darker. It is scaled to the
 * layer's ground, not to the map: a private world's layer 01 is a square
 * smaller than its map (server `PRIVATE_SIDES`), all void outside, and
 * `hello.map` differs per world (first run 1200, private 1400, shared 4000).
 * The ground is redrawn only when the layer, the map size or its void Set
 * (replaced at every `hello`) changes.
 */
export class MiniMap extends Graphics {
  mapWidth: number
  mapHeight: number
  updateRate: number
  _timeSinceRedraw: number = 0
  private readonly ground = new Graphics()
  private readonly dots = new Graphics()
  /** What the ground was drawn for; a change redraws it. */
  private drawnFor: { tag: number, size: number, voids: Set<number> | undefined, walls: Set<number> | undefined } | undefined
  /** World units across the drawn square: the layer's ground extent. */
  private side = 4000

  constructor (width: number, height: number, updateRate: number) {
    super()

    this.mapWidth = width
    this.mapHeight = height

    this.updateRate = updateRate

    // Opaque, so the border reads; the ground and the dots carry their own alpha.
    this.alpha = 1
    // Neutral dark ground, the HUD panels' fill and border, rounded corners
    // (Nick, 2026-11-05: no yellow tint; a rounded border).
    this
      .beginFill(0x0B1220, 0.35)
      .lineStyle(3, 0x3a6e7e, 1)
      .drawRoundedRect(0, 0, this.mapWidth, this.mapHeight, 14)
      .endFill()
    this.addChild(this.ground)
    this.addChild(this.dots)
    this.redraw()
  }

  update (dt: number): void {
    this._timeSinceRedraw += dt
    if (this._timeSinceRedraw > this.updateRate) {
      this.redraw()
    }
  }

  /** A world position to minimap px. */
  private at (x: number, y: number): [number, number] {
    const k = (Math.min(this.mapWidth, this.mapHeight) - 2 * PAD) / this.side
    return [PAD + x * k, PAD + y * k]
  }

  private dot (g: Graphics, x: number, y: number, radius: number): void {
    const [px, py] = this.at(x, y)
    g.drawCircle(px, py, radius)
  }

  private drawGround (tag: number): void {
    const size = Session.mapSize
    const voids = Game.VOIDS.get(tag)
    const walls = Game.WALLS.get(tag)
    const drawn = this.drawnFor
    if (drawn !== undefined && drawn.tag === tag && drawn.size === size && drawn.voids === voids && drawn.walls === walls) return
    this.drawnFor = { tag, size, voids, walls }

    // The extent of the ground, from the map's corner: a smaller layer is void
    // beyond its square.
    const cells = Hex.mapCells(size).filter((cell) => voids?.has(Hex.key(cell.x, cell.y)) !== true)
    let extent = 0
    for (const cell of cells) {
      const p = Hex.toPosition(cell)
      extent = Math.max(extent, p.x, p.y)
    }
    this.side = cells.length > 0 ? Math.min(size, extent + Hex.SIZE) : size

    const k = (Math.min(this.mapWidth, this.mapHeight) - 2 * PAD) / this.side
    const w = Hex.SIZE * k
    const h = Hex.SIZE * ROW * k
    const g = this.ground.clear()
    for (const [color, alpha, wall] of [[0x2E5566, 0.55, false], [0x0E1B26, 0.9, true]] as const) {
      g.beginFill(color, alpha)
      for (const cell of cells) {
        if ((walls?.has(Hex.key(cell.x, cell.y)) === true) !== wall) continue
        const p = Hex.toPosition(cell)
        const [x, y] = this.at(p.x, p.y)
        g.drawRect(x - w / 2, y - h / 2, w, h + 0.5)
      }
      g.endFill()
    }
  }

  redraw (): void {
    this._timeSinceRedraw = 0
    const dots = this.dots.clear()

    const ownPlayer = Game.PLAYER
    if (ownPlayer == null) {
      this.ground.clear()
      this.drawnFor = undefined
      return
    }
    if (ownPlayer.tag !== undefined) this.drawGround(ownPlayer.tag)

    dots.beginFill(0xFF6666, 0.7)
    for (const mob of Game.MOBS) {
      if (mob.tag === ownPlayer.tag && !mob.killed && mob.renderable) {
        this.dot(dots, mob.x, mob.y, mob.maxHP > 100 ? 3 : 1)
      }
    }
    dots.endFill()

    dots.beginFill(0xFFFF66, 0.7)
    for (const consumable of Game.CONSUMABLES) {
      if (consumable.tag === ownPlayer.tag && !consumable.killed && consumable.renderable) {
        this.dot(dots, consumable.x, consumable.y, 1)
      }
    }
    dots.endFill()

    for (const player of Game.PLAYERS) {
      if (player.tag === ownPlayer.tag && !player.killed && player.renderable) {
        dots.beginFill(player === ownPlayer ? 0x33FF99 : 0xFF00FF, 0.8)
        this.dot(dots, player.x, player.y, 3)
        dots.endFill()
      }
    }
  }
}
