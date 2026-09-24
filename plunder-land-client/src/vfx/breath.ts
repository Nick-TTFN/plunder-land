import { type Container } from 'pixi.js'
import { Vector } from '../utils/vector'
import { Hex } from '../utils/hex'
import { type GameObject } from '../objects/gameobject'
import { type Cell, coneCells, directionToward } from './cells'
import { CellHighlight, cellOf, facingOf, layerOf } from './cellhighlight'

/**
 * The shared half of FireBreath and IceBreath: light the cone the server is
 * damaging, for as long as it damages it, and spray particles over its cells.
 *
 * The cone is `coneCells` from the caster's *current* cell, like
 * `SectorArea`, so it moves with the caster. Its direction is fixed at cast
 * from the effect's tip cell when the breath was aimed, and otherwise follows
 * the caster's reported hex facing, which is what the server does too.
 */
export function playBreath (
  owner: GameObject,
  lifetime: number,
  aimCell: Vector | undefined,
  rings: number,
  colour: number,
  particle: (layer: Container, at: Vector, toward: Vector, duration: number) => void
): void {
  const fixed = aimCell !== undefined ? directionToward(cellOf(owner), aimCell) : undefined
  const cells = (): Cell[] => coneCells(cellOf(owner), fixed ?? facingOf(owner), rings)

  CellHighlight.flash(owner.tag, cells(), colour, lifetime, cells)

  const particleLifetime = 450
  const count = rings * 5
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      if (owner.parent == null) return
      const layer = layerOf(owner.tag)
      if (layer === undefined) return
      const now = cells()
      if (now.length === 0) return
      const pick = now[Math.floor(Math.random() * now.length)]
      const target = Hex.toPosition(new Vector(pick.x, pick.y))
      particle(layer, new Vector(owner.x, owner.y), target, particleLifetime)
    }, Math.max(0, lifetime - particleLifetime) * (i / count))
  }
}
