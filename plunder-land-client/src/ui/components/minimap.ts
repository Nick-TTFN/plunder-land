import { Graphics } from 'pixi.js'
import { Game } from '../../game'

/**
 * The minimap, kept as it was (decision #36). It draws only what the fog lets
 * the player see (`renderable`, set by `Game.applyFog`), or it would show
 * every unit the fog hides.
 */
export class MiniMap extends Graphics {
  mapWidth: number
  mapHeight: number
  updateRate: number
  _timeSinceRedraw: number = 0
  constructor (width: number, height: number, updateRate: number) {
    super()

    this.mapWidth = width
    this.mapHeight = height

    this.updateRate = updateRate

    // Opaque, so the border reads; the ground and the dots carry their own alpha.
    this.alpha = 1
    this.redraw()
  }

  update (dt: number): void {
    this._timeSinceRedraw += dt
    if (this._timeSinceRedraw > this.updateRate) {
      this.redraw()
    }
  }

  redraw (): void {
    this._timeSinceRedraw = 0
    this
      .clear()
      // Neutral dark ground, the HUD panels' fill and border, rounded corners
      // (Nick, 2026-11-05: no yellow tint; a rounded border).
      .beginFill(0x0B1220, 0.35)
      .lineStyle(3, 0x3a6e7e, 1)
      .drawRoundedRect(0, 0, this.mapWidth, this.mapHeight, 14)
      .endFill()
      .lineStyle(0)

    const ownPlayer = Game.PLAYER
    if (ownPlayer == null) { return }

    this.beginFill(0xFF6666, 0.7)
    for (const mob of Game.MOBS) {
      if (mob.tag === ownPlayer.tag && !mob.killed && mob.renderable) {
        this.drawCircle(mob.x * this.mapWidth / 4000, mob.y * this.mapHeight / 4000, mob.maxHP > 100 ? 3 : 1)
      }
    }
    this.endFill()

    this.beginFill(0xFFFF66, 0.7)
    for (const consumable of Game.CONSUMABLES) {
      if (consumable.tag === ownPlayer.tag && !consumable.killed && consumable.renderable) {
        this.drawCircle(consumable.x * this.mapWidth / 4000, consumable.y * this.mapHeight / 4000, 1)
      }
    }
    this.endFill()

    for (const player of Game.PLAYERS) {
      if (player.tag === ownPlayer.tag && !player.killed && player.renderable) {
        this.beginFill(player === ownPlayer ? 0x33FF99 : 0xFF00FF, 0.8)
        this.drawCircle(player.x * this.mapWidth / 4000, player.y * this.mapHeight / 4000, 3)
        this.endFill()
      }
    }
  }
}
