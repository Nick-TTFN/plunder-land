import { BaseTexture, Sprite, Texture, type Container } from 'pixi.js'

/**
 * Contact shading ("AO") where a standing thing meets the ground, the BTFC
 * town's approach (its study page "How the town is drawn", D-032), at the
 * sizes that page's world px come to on screen at its 0.5 zoom, since this
 * game draws at 1:1:
 *
 * - the **wall half**, on the object: its pixels darken linearly toward the
 *   contact line (each column's lowest opaque pixel), over `length` px;
 * - the **floor half**, outside the silhouette only: a brush from the contact
 *   line falling off as (1 - d/r)^3, so the two halves meet with no seam;
 * - a faint **halo** all round the silhouette, weighted `HALO_TOP` above its
 *   middle so it reads as light from above, not as an outline.
 *
 * Never cavity AO: colour edges inside the art are not darkened (BTFC tried
 * and reverted it). Cast shadows are separate (`shadow.ts`) and unchanged.
 *
 * Computed once per texture from its alpha, on the CPU, and cached forever
 * (a handful of textures: the wall cell, portal, exit pad, StoneWall crate).
 */
export const CONTACT = {
  /** The shade's colour: the void's navy rather than pure black. */
  COLOUR: 0x050912,
  /** The floor brush: radius in screen px and peak alpha at the contact line. */
  BRUSH_RADIUS: 13,
  BRUSH_ALPHA: 0.9,
  /** The wall gradient's peak alpha, at the contact line. */
  WALL_ALPHA: 0.9,
  /** The halo: a wide soft ring and a tight one, px and alpha. */
  HALO_WIDE: 7,
  HALO_WIDE_ALPHA: 0.5,
  HALO_TIGHT: 1.5,
  HALO_TIGHT_ALPHA: 0.7,
  /** The halo's weight above the silhouette's middle (1 below it). */
  HALO_TOP: 0.2
}

export interface Contact {
  /** The wall half, the size of the source and drawn over it (or under its top face). */
  wall: Texture
  /** The floor half and the halo, `pad` px bigger all round than the source. */
  floor: Texture
  /** The floor half below the contact line only, in the source's own columns (`floor`'s size). */
  under: Texture
  /** How much bigger `floor` and `under` are on each side, CSS px. */
  pad: number
}

const CACHE = new Map<string, Contact>()

/**
 * Shade a prop sprite `main` (a child of `parent`, at scale 1) where it meets
 * the ground: the floor half just under it, the wall half just over it.
 */
export function shadeContact (parent: Container, main: Sprite, length: number): void {
  const contact = contactOf(main.texture, length)
  const left = main.x - main.anchor.x * main.texture.width
  const top = main.y - main.anchor.y * main.texture.height
  const floor = new Sprite(contact.floor)
  floor.position.set(left - contact.pad, top - contact.pad)
  const wall = new Sprite(contact.wall)
  wall.position.set(left, top)
  const at = parent.getChildIndex(main)
  parent.addChildAt(wall, at + 1)
  parent.addChildAt(floor, at)
}

/**
 * The contact shading of a texture standing on its lowest pixels, whose wall
 * gradient runs `length` px up from them. Textures are at the source's
 * resolution, so a sprite of one at scale 1 lines up with the source's.
 */
export function contactOf (texture: Texture, length: number): Contact {
  const key = `${texture.baseTexture.uid}@${texture.frame.x}:${texture.frame.y}:${length}`
  let contact = CACHE.get(key)
  if (contact === undefined) {
    const res = texture.baseTexture.resolution
    const { x, y, width, height } = texture.frame
    const w = Math.round(width * res)
    const h = Math.round(height * res)
    const ctx = canvas(w, h)
    const source = (texture.baseTexture.resource as unknown as { source: CanvasImageSource }).source
    ctx.drawImage(source, Math.round(x * res), Math.round(y * res), w, h, 0, 0, w, h)
    contact = shade(ctx.getImageData(0, 0, w, h).data, w, h, res, length)
    CACHE.set(key, contact)
  }
  return contact
}

/**
 * The contact shading of a shape drawn by `draw` into a canvas of `width` x
 * `height` CSS px at resolution `res` (the context is already scaled), cached
 * under `key`. For shapes made in code, like a wall cell's.
 */
export function contactOfShape (key: string, width: number, height: number, res: number, length: number, draw: (ctx: CanvasRenderingContext2D) => void): Contact {
  let contact = CACHE.get(key)
  if (contact === undefined) {
    const w = Math.ceil(width * res)
    const h = Math.ceil(height * res)
    const ctx = canvas(w, h)
    ctx.scale(res, res)
    draw(ctx)
    contact = shade(ctx.getImageData(0, 0, w, h).data, w, h, res, length)
    CACHE.set(key, contact)
  }
  return contact
}

/** The three textures from an RGBA source of `w` x `h` device px at `res`. */
function shade (rgba: Uint8ClampedArray, w: number, h: number, res: number, length: number): Contact {
  const C = CONTACT
  const inside = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) inside[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0

  // The contact line: each column's lowest opaque pixel.
  const base = new Int32Array(w).fill(-1)
  let top = h
  let bottom = -1
  for (let x = 0; x < w; x++) {
    for (let y = h - 1; y >= 0; y--) {
      if (inside[y * w + x] === 1) { base[x] = y; break }
    }
    for (let y = 0; y < h; y++) {
      if (inside[y * w + x] === 1) { top = Math.min(top, y); break }
    }
    bottom = Math.max(bottom, base[x])
  }

  const [r, g, b] = [C.COLOUR >> 16 & 255, C.COLOUR >> 8 & 255, C.COLOUR & 255]

  // The wall half: over the source's own pixels, in proportion to their alpha.
  const wall = new Uint8ClampedArray(w * h * 4)
  for (let x = 0; x < w; x++) {
    if (base[x] < 0) continue
    for (let y = base[x]; y >= 0; y--) {
      const d = (base[x] - y) / res
      if (d >= length) break
      const i = y * w + x
      const a = C.WALL_ALPHA * (1 - d / length) * rgba[i * 4 + 3] / 255
      wall.set([r, g, b, Math.round(a * 255)], i * 4)
    }
  }

  // The floor half and the halo, from the nearest contact pixel and the
  // nearest edge pixel, in a canvas `pad` bigger all round.
  const pad = Math.ceil(Math.max(C.BRUSH_RADIUS, C.HALO_WIDE) * res) + 1
  const W = w + 2 * pad
  const H = h + 2 * pad
  const toContact = new Float32Array(W * H).fill(Infinity)
  const toEdge = new Float32Array(W * H).fill(Infinity)
  const nearest = (into: Float32Array, sx: number, sy: number, radius: number): void => {
    const reach = Math.ceil(radius)
    for (let y = Math.max(0, sy - reach); y <= Math.min(H - 1, sy + reach); y++) {
      for (let x = Math.max(0, sx - reach); x <= Math.min(W - 1, sx + reach); x++) {
        const d = Math.hypot(x - sx, y - sy)
        if (d < into[y * W + x]) into[y * W + x] = d
      }
    }
  }
  for (let x = 0; x < w; x++) {
    if (base[x] >= 0) nearest(toContact, x + pad, base[x] + pad, C.BRUSH_RADIUS * res)
  }
  const at = (x: number, y: number): number => x < 0 || y < 0 || x >= w || y >= h ? 0 : inside[y * w + x]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (inside[y * w + x] === 1 && (at(x - 1, y) === 0 || at(x + 1, y) === 0 || at(x, y - 1) === 0 || at(x, y + 1) === 0)) {
        nearest(toEdge, x + pad, y + pad, C.HALO_WIDE * res)
      }
    }
  }

  const middle = (top + bottom) / 2 + pad
  const band = Math.max(1, (bottom - top) / 4)
  const floor = new Uint8ClampedArray(W * H * 4)
  const under = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = x - pad
      const sy = y - pad
      if (at(sx, sy) === 1) continue
      const dc = toContact[y * W + x] / res
      const de = toEdge[y * W + x] / res
      const brush = dc < C.BRUSH_RADIUS ? C.BRUSH_ALPHA * (1 - dc / C.BRUSH_RADIUS) ** 3 : 0
      const wide = de < C.HALO_WIDE ? C.HALO_WIDE_ALPHA * (1 - de / C.HALO_WIDE) ** 2 : 0
      const tight = de < C.HALO_TIGHT ? C.HALO_TIGHT_ALPHA * (1 - de / C.HALO_TIGHT) ** 2 : 0
      const weight = C.HALO_TOP + (1 - C.HALO_TOP) * smoothstep(middle - band, middle + band, y)
      const halo = (1 - (1 - wide) * (1 - tight)) * weight
      const a = Math.round((1 - (1 - brush) * (1 - halo)) * 255)
      if (a === 0) continue
      floor.set([r, g, b, a], (y * W + x) * 4)
      if (sx >= 0 && sx < w && base[sx] >= 0 && sy > base[sx]) under.set([r, g, b, Math.round(brush * 255)], (y * W + x) * 4)
    }
  }

  return { wall: texture(wall, w, h, res), floor: texture(floor, W, H, res), under: texture(under, W, H, res), pad: pad / res }
}

function smoothstep (from: number, to: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

function canvas (w: number, h: number): CanvasRenderingContext2D {
  const element = document.createElement('canvas')
  element.width = w
  element.height = h
  const ctx = element.getContext('2d', { willReadFrequently: true })
  if (ctx === null) throw new Error('contact: no 2d canvas')
  return ctx
}

function texture (rgba: Uint8ClampedArray, w: number, h: number, res: number): Texture {
  const ctx = canvas(w, h)
  const image = ctx.createImageData(w, h)
  image.data.set(rgba)
  ctx.putImageData(image, 0, 0)
  return new Texture(BaseTexture.from(ctx.canvas, { resolution: res }))
}
