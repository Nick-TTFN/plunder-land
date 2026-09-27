import { Graphics } from 'pixi.js'
import { Vector } from '../../utils/vector'
import { Hex } from '../../utils/hex'
import { type ArchetypeInfo } from '../../utils/archetypes'
import { type Cell, discCells, threatRingsOf } from '../../vfx/cells'

/** The mockup's red. */
const COLOUR = 0xFF4A4A

/** Corner distance of a pointy-top cell whose centres are `Hex.SIZE` apart. */
const CORNER = Hex.SIZE / Math.sqrt(3)

/**
 * Corner i of a cell, relative to its centre, pointy-top: i = 0 is lower
 * right, then clockwise (y grows downward). The edge from corner i to corner
 * i + 1 faces `Hex.DIRECTIONS[(i + 1) % 6]`.
 */
const CORNERS: Array<[number, number]> = []
for (let i = 0; i < 6; i++) {
  const a = (Math.PI / 3) * i + Math.PI / 6
  CORNERS.push([Math.cos(a) * CORNER, Math.sin(a) * CORNER])
}

/** How far this mob's attack reaches, in rings, or 0 (`threatRingsOf`). */
export function threatRings (archetype: ArchetypeInfo | undefined): number {
  if (archetype === undefined) return 0
  return threatRingsOf(archetype.key, archetype.kind, archetype.rangedCells)
}

/** One threatening mob: its cell and reach. */
export interface Threat { cell: Cell, rings: number }

/**
 * Red cells under the mobs that can hurt you from a distance (world-markers,
 * M2): the union of every threat's disc, filled faintly, with its outline
 * drawn where the union ends. The union, so two gunners side by side read as
 * one danger zone rather than a tangle of rings.
 *
 * One per game, re-parented to the player's plane like the route marker.
 * Redraws only when a threat changes cell. Placeholder look (decision #36).
 */
export class ThreatMarker extends Graphics {
  private _drawn = ''

  constructor () {
    super()
    this.eventMode = 'none'
    // Over the ground (-1000), under the route (-1) and the cell telegraphs.
    this.zIndex = -2
  }

  setThreats (threats: Threat[]): void {
    const signature = threats.map((t) => `${t.cell.x},${t.cell.y},${t.rings}`).join(';')
    if (signature === this._drawn) return
    this._drawn = signature

    this.clear()
    if (threats.length === 0) return

    // The union: a key set for membership, a list to walk (the client's
    // tsconfig target can't iterate a Map).
    const inside = new Set<number>()
    const cells: Cell[] = []
    for (const threat of threats) {
      for (const cell of discCells(threat.cell, threat.rings)) {
        const key = Hex.key(cell.x, cell.y)
        if (inside.has(key)) continue
        inside.add(key)
        cells.push(cell)
      }
    }

    this.beginFill(COLOUR, 0.16)
    for (const cell of cells) {
      const c = Hex.toPosition(new Vector(cell.x, cell.y))
      const points: number[] = []
      for (const [x, y] of CORNERS) points.push(c.x + x, c.y + y)
      this.drawPolygon(points)
    }
    this.endFill()

    this.lineStyle(2, COLOUR, 0.85)
    for (const cell of cells) {
      const c = Hex.toPosition(new Vector(cell.x, cell.y))
      for (let i = 0; i < 6; i++) {
        const n = Hex.neighbour(new Vector(cell.x, cell.y), (i + 1) % 6)
        if (inside.has(Hex.key(n.x, n.y))) continue
        const [ax, ay] = CORNERS[i]
        const [bx, by] = CORNERS[(i + 1) % 6]
        this.moveTo(c.x + ax, c.y + ay).lineTo(c.x + bx, c.y + by)
      }
    }
    this.lineStyle(0)
  }
}
