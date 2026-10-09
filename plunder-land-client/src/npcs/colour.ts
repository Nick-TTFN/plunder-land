/**
 * A Canvas colour as the NPC packages write them ('#rrggbb', '#rrggbbaa' or
 * 'rgba(r,g,b,a)') as a pixi colour and alpha.
 */
export function cssColour (css: string): { color: number, alpha: number } {
  if (css.startsWith('rgba(')) {
    const [r, g, b, a] = css.slice(5, -1).split(',').map(Number)
    return { color: (r << 16) | (g << 8) | b, alpha: a }
  }
  const hex = css.slice(1)
  const color = parseInt(hex.slice(0, 6), 16)
  const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
  return { color, alpha }
}
