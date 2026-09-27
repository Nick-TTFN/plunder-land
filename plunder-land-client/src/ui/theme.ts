/**
 * The HUD's look, in one place (hud-rebuild, M2). Everything here is a
 * placeholder for the art pass (decision #36): panel frames are drawn with
 * `Graphics` from these colours, and the font is a system monospace stack.
 * When real art arrives, the swap happens here and in `Panel`, not in every
 * component.
 */
export const THEME = {
  /** A system monospace stack; the mockup's mono face goes here when it exists. */
  font: '"JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',

  panelFill: 0x0B1220,
  panelAlpha: 0.88,
  panelBorder: 0x2A4A5E,
  panelRadius: 8,
  /** The divider under a panel's title. */
  rule: 0x1E3344,

  text: 0xE6EEF5,
  muted: 0x8FA3B5,
  accent: 0x3DE0D0,
  loot: 0xFFB547,
  hp: 0x39E08A,
  armor: 0x3AA0FF,
  danger: 0xFF5A5A,
  ready: 0x3DE0D0,
  barTrack: 0x1A2533,

  pad: 14,
  gap: 10,
  titleSize: 20,
  bodySize: 16,
  smallSize: 13
}

/** Zero-padded to two digits, as the mockup writes ranks and layers ("01"). */
export function two (n: number): string {
  return String(n).padStart(2, '0')
}
