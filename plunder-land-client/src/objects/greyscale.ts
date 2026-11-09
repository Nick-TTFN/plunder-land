import { BaseTexture, Texture } from 'pixi.js'

/**
 * Greyscale (mostly: `DESATURATE`) copies of a sheet, so a layer's tint reads as that colour: a tint
 * is a multiply, and a multiply cannot turn red art green (Nick 2026-11-09:
 * "mobs are still red, desaturate the textures first", then "similar
 * treatment for tiles"). Used by the NPC body parts (`NpcSprite`, under
 * `MOB_LAYER_TINT`) and the ground faces and fades (`Game.createLayer`, under
 * `LAYER_TINT`; walls wear the same faces).
 *
 * And highlight masks (`highlightOf`): white, opaque where the art is bright.
 * A multiply tint pulls a highlight down to the tint's colour; `NpcSprite`
 * draws this mask over each tinted part so its highlights read white again
 * (Nick 2026-11-09: "a separate overlay for tinted mobs to have highlights
 * more white").
 *
 * Built in the browser on first use, one canvas per sheet's base texture and
 * kind, never downloaded. Luminance (Rec. 601), lifted by `LIFT` so dark art
 * doesn't turn near-black under a tint. Glow and emission layers keep their
 * colour (`NpcSprite.drawList` asks only for body parts).
 *
 * The maps hold one entry per sheet / per distinct frame drawn, per kind:
 * finite and never evicted, by decision (as `NpcSprite.cuts`).
 */
type Kind = 'grey' | 'highlight'
const bases: Record<Kind, Map<BaseTexture, BaseTexture | null>> = { grey: new Map(), highlight: new Map() }
const textures: Record<Kind, Map<Texture, Texture>> = { grey: new Map(), highlight: new Map() }

/** Applied after the desaturation, capped at 255 (Nick, palette lab 2026-11-09). */
const LIFT = 1.35

/**
 * How far toward greyscale the copy goes: 1 is full luminance, 0 the art as
 * drawn. 0.65 keeps a trace of the art's own colour under the tint (Nick,
 * palette lab 2026-11-09).
 */
const DESATURATE = 0.65

/**
 * Where a highlight starts, as a share of full luminance: below it the mask
 * is clear, above it ramps to opaque white at full brightness. PROVISIONAL.
 */
const HIGHLIGHT_FROM = 0.55

/** `texture`'s frame on its sheet's greyscale copy; `texture` itself if its sheet can't be read yet. */
export function greyOf (texture: Texture): Texture {
  return derived(texture, 'grey') ?? texture
}

/** `texture`'s frame on its sheet's highlight mask; undefined if its sheet can't be read yet. */
export function highlightOf (texture: Texture): Texture | undefined {
  return derived(texture, 'highlight')
}

function derived (texture: Texture, kind: Kind): Texture | undefined {
  const known = textures[kind].get(texture)
  if (known !== undefined) return known
  const base = derivedBase(texture.baseTexture, kind)
  if (base === null) return undefined
  // The sheet's anchor too: the terrain and walls place every face by it (`defaultAnchor`).
  const copy = new Texture(base, texture.frame.clone(), texture.orig.clone(), texture.trim?.clone(), texture.rotate, texture.defaultAnchor.clone())
  textures[kind].set(texture, copy)
  return copy
}

function derivedBase (base: BaseTexture, kind: Kind): BaseTexture | null {
  const known = bases[kind].get(base)
  if (known !== undefined) return known
  const source = (base.resource as { source?: CanvasImageSource } | undefined)?.source
  const w = base.realWidth
  const h = base.realHeight
  // Not loaded yet: try again next draw (not cached).
  if (source === undefined || !base.valid || w === 0 || h === 0) return null
  let out: BaseTexture | null = null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (ctx !== null) {
      ctx.drawImage(source, 0, 0, w, h)
      const image = ctx.getImageData(0, 0, w, h)
      const px = image.data
      for (let i = 0; i < px.length; i += 4) {
        const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
        if (kind === 'grey') {
          for (let c = 0; c < 3; c++) {
            const v = (px[i + c] + (y - px[i + c]) * DESATURATE) * LIFT
            px[i + c] = v > 255 ? 255 : Math.round(v)
          }
        } else {
          const t = Math.max(0, Math.min(1, (y / 255 - HIGHLIGHT_FROM) / (1 - HIGHLIGHT_FROM)))
          px[i] = 255
          px[i + 1] = 255
          px[i + 2] = 255
          px[i + 3] = Math.round(px[i + 3] * t * t * (3 - 2 * t))
        }
      }
      ctx.putImageData(image, 0, 0)
      out = BaseTexture.from(canvas, { resolution: base.resolution, scaleMode: base.scaleMode, mipmap: base.mipmap })
    }
  } catch (err) {
    // A tainted canvas (cross-origin sheet) or no 2D context: keep the colour art for good.
    console.warn(`${kind} sheet copy unavailable`, err)
  }
  bases[kind].set(base, out)
  return out
}
