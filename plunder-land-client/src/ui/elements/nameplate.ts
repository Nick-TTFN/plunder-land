import { Container, Graphics, Text } from 'pixi.js'
import { THEME } from '../theme'

/**
 * A small label in a dark box with a thin border, centred on x = 0 with its
 * top at y = 0: the mockup's name under a unit, "LAYER 0N" under a portal,
 * "EXTRACT" under an exit (world-markers, M2). Placeholder look until the art
 * pass (decision #36); every in-world label goes through here so the swap is
 * one place.
 */
export function namePlate (value: string, fill: number, border: number, size = 11): Container {
  const plate = new Container()
  plate.eventMode = 'none'
  const text = new Text(value, { fontFamily: THEME.font, fontSize: size, fontWeight: 'bold', fill })
  const padX = 4
  const padY = 1
  const w = Math.ceil(text.width) + 2 * padX
  const h = Math.ceil(text.height) + 2 * padY
  const bg = new Graphics()
    .beginFill(THEME.panelFill, 0.8)
    .lineStyle(1, border, 0.9)
    .drawRoundedRect(-w / 2, 0, w, h, 3)
    .endFill()
  text.x = -w / 2 + padX
  text.y = padY
  plate.addChild(bg, text)
  return plate
}
