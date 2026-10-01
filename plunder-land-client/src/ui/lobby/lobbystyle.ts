/**
 * The lobby's DOM chrome (lobby-rework, #42): placeholder look in the HUD's
 * colours (`ui/theme.ts`) after the mockup, until the screen gets its art.
 * Everything is `lb-` prefixed; the root ignores the pointer so the canvas
 * under it (the robots) shows through, and each control takes it back.
 * Narrow screens (under 720 px) drop the heading, the arrows and the hints,
 * shrink the cards to a scrolling row and turn customize into a bottom sheet.
 */
export const LOBBY_CSS = `
.lb { position: fixed; inset: 0; z-index: 10; pointer-events: none; color: #E6EEF5;
  font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace; user-select: none; }
.lb button, .lb input, .lb label { pointer-events: auto; font-family: inherit; }
.lb button { cursor: pointer; }
.lb-top { position: absolute; top: 0; left: 0; right: 0; height: 64px; display: flex; align-items: center;
  padding: 0 32px; border-bottom: 1px solid rgba(61,224,208,.12);
  background: linear-gradient(rgba(4,7,13,.85), rgba(4,7,13,0)); }
.lb-brand { font-size: 22px; letter-spacing: .32em; font-weight: 700; display: flex; align-items: center; gap: 14px; }
.lb-logo { width: 26px; height: 26px; border-radius: 50%; border: 3px solid #3DE0D0; box-shadow: 0 0 12px rgba(61,224,208,.6); }
.lb-tabs { position: absolute; left: 50%; transform: translateX(-50%); display: flex; gap: 40px; font-size: 18px; letter-spacing: .12em; }
.lb-tab { padding: 20px 4px; }
.lb-on { color: #fff; border-bottom: 3px solid #3DE0D0; }
.lb-off { color: #6b7d8f; pointer-events: auto; cursor: default; }
.lb-heading { position: absolute; top: 92px; left: 52px; }
.lb-heading h1 { margin: 0; font-size: 34px; letter-spacing: .06em; font-weight: 700; }
.lb-heading p { margin: 6px 0 0; color: #a9bccd; font-size: 17px; }
.lb-pill { position: absolute; top: 14%; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 12px;
  padding: 8px 18px; border-radius: 24px; background: rgba(11,18,32,.85); border: 1px solid #2A4A5E; }
.lb-dot { width: 12px; height: 12px; border-radius: 50%; background: #39E08A; box-shadow: 0 0 8px #39E08A; }
.lb-name { width: 150px; background: transparent; border: 0; outline: none; color: #fff; font-size: 18px;
  letter-spacing: .12em; text-align: center; text-transform: uppercase; }
.lb-name::placeholder { color: #6b7d8f; }
.lb-pencil { color: #a9bccd; }
.lb-arrow { position: absolute; top: 44%; width: 60px; height: 60px; border-radius: 50%; font-size: 34px; line-height: 1;
  color: #E6EEF5; background: rgba(11,18,32,.75); border: 1px solid #2A4A5E; }
.lb-arrow:hover { border-color: #3DE0D0; }
.lb-plate { position: absolute; left: 50%; transform: translateX(-50%); text-align: center; }
.lb-kind { font-size: 13px; letter-spacing: .4em; color: #a9bccd; }
.lb-namerow { display: flex; align-items: center; justify-content: center; gap: 16px; margin: 4px 0; }
.lb-robot { font-size: 48px; font-weight: 800; letter-spacing: .02em; }
.lb-edit { padding: 6px 12px; font-size: 14px; letter-spacing: .1em; color: #E6EEF5; background: rgba(11,18,32,.85);
  border: 1px solid #3DE0D0; border-radius: 4px; }
.lb-tagline { color: #c9d6e2; font-size: 16px; }
.lb-stats { position: absolute; left: 52px; top: 42%; width: 280px; padding: 14px 16px; border-radius: 8px;
  background: rgba(11,18,32,.80); border: 1px solid #2A4A5E; display: grid; gap: 9px; }
.lb-stat { display: grid; grid-template-columns: 64px 1fr 72px; align-items: center; gap: 10px; font-size: 12px; letter-spacing: .08em; }
.lb-label { color: #8FA3B5; }
.lb-track { height: 8px; border-radius: 4px; background: #1A2533; overflow: hidden; }
.lb-fill { height: 100%; background: linear-gradient(90deg, #2fb8ab, #3DE0D0); transition: width .25s; }
.lb-value { text-align: right; color: #E6EEF5; }
.lb-cards { position: absolute; bottom: 104px; left: 50%; transform: translateX(-50%); display: flex; gap: 14px; }
.lb-card { position: relative; width: 132px; height: 158px; border-radius: 10px; color: #E6EEF5;
  background: rgba(11,18,32,.88); border: 2px solid #2A4A5E; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; padding-bottom: 12px; }
.lb-card:hover:not(:disabled) { border-color: #6fbfb7; }
.lb-picked { border-color: #3DE0D0; box-shadow: 0 0 18px rgba(61,224,208,.45); }
.lb-thumb { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 40px; color: #3b4e60; }
.lb-thumb img { max-width: 104px; max-height: 104px; }
.lb-cardname { font-size: 15px; letter-spacing: .12em; }
.lb-locked { cursor: default; opacity: .55; }
.lb-soon { position: absolute; top: 8px; right: 8px; font-size: 10px; letter-spacing: .12em; padding: 2px 6px;
  border-radius: 3px; background: #1A2533; color: #8FA3B5; }
.lb-custom { position: absolute; top: 88px; right: 28px; width: 400px; padding: 18px 20px; border-radius: 10px;
  background: rgba(11,18,32,.94); border: 1px solid #3a6e7e; box-shadow: 0 0 24px rgba(61,224,208,.18); pointer-events: auto; z-index: 2; }
.lb-hidden { display: none; }
.lb-customhead { display: flex; justify-content: space-between; align-items: center; font-size: 22px; letter-spacing: .18em;
  padding-bottom: 12px; border-bottom: 1px solid #1E3344; }
.lb-close { background: none; border: 0; color: #E6EEF5; font-size: 28px; }
.lb-row { padding: 14px 0; border-bottom: 1px solid #1E3344; }
.lb-rowtitle { display: flex; gap: 14px; font-size: 15px; letter-spacing: .12em; margin-bottom: 10px; }
.lb-current { color: #a9bccd; letter-spacing: 0; }
.lb-swatches { display: flex; flex-wrap: wrap; gap: 8px; }
.lb-swatch { width: 52px; height: 52px; border-radius: 9px; border: 2px solid #2A4A5E; padding: 0; position: relative; }
.lb-swatch.lb-small { width: 28px; height: 28px; border-radius: 6px; }
.lb-sel { border-color: #3DE0D0 !important; box-shadow: 0 0 10px rgba(61,224,208,.6); }
.lb-swatch.lb-sel::after { content: "\\2713"; position: absolute; right: -6px; bottom: -6px; width: 16px; height: 16px; border-radius: 50%;
  background: #3DE0D0; color: #0B1220; font-size: 11px; line-height: 16px; text-align: center; }
.lb-colours { display: flex; flex-wrap: wrap; gap: 6px; }
.lb-patterns { display: flex; gap: 6px; margin-top: 8px; }
.lb-chip { padding: 4px 8px; font-size: 11px; letter-spacing: .08em; color: #E6EEF5; background: #1A2533; border: 1px solid #2A4A5E; border-radius: 4px; }
.lb-customfoot { display: flex; justify-content: space-between; align-items: center; padding-top: 14px; }
.lb-mix { background: none; border: 0; color: #a9bccd; font-size: 13px; text-decoration: underline; }
.lb-done { padding: 10px 36px; font-size: 17px; letter-spacing: .14em; font-weight: 700; color: #0B1220; background: #3DE0D0; border: 0; border-radius: 6px; }
.lb-ready { position: absolute; right: 44px; bottom: 44px; padding: 18px 40px; font-size: 26px; font-weight: 800; letter-spacing: .14em;
  color: #1a1206; background: linear-gradient(#ffc45e, #f2a12e); border: 2px solid #ffd58a; border-radius: 10px;
  box-shadow: 0 0 22px rgba(255,181,71,.45); }
.lb-ready:hover { filter: brightness(1.08); }
.lb-keys { position: absolute; left: 44px; bottom: 50px; font-size: 13px; letter-spacing: .1em; color: #a9bccd; }
.lb-keys kbd { display: inline-block; min-width: 18px; padding: 3px 6px; margin: 0 4px 0 8px; border: 1px solid #3a5266; border-radius: 4px;
  font-family: inherit; color: #E6EEF5; text-align: center; }
@media (max-width: 1100px) {
  .lb-stats { left: 24px; width: 240px; }
  .lb-heading { left: 24px; }
  .lb-card { width: 108px; height: 138px; }
  .lb-thumb img { max-width: 84px; max-height: 84px; }
}
@media (max-width: 720px) {
  .lb-top { padding: 0 16px; height: 52px; }
  .lb-brand { font-size: 15px; letter-spacing: .2em; }
  .lb-tabs { display: none; }
  .lb-heading, .lb-arrow, .lb-keys { display: none; }
  .lb-pill { top: 64px; }
  .lb-plate { width: 100%; }
  .lb-robot { font-size: 34px; }
  .lb-tagline { font-size: 14px; }
  .lb-stats { left: 16px; right: 16px; width: auto; top: auto; bottom: 222px; padding: 8px 12px; gap: 5px; }
  .lb-stat { font-size: 11px; }
  .lb-cards { left: 16px; right: 16px; transform: none; bottom: 96px; overflow-x: auto; }
  .lb-card { flex: 0 0 auto; width: 84px; height: 112px; }
  .lb-thumb img { max-width: 64px; max-height: 64px; }
  .lb-cardname { font-size: 11px; }
  .lb-ready { left: 16px; right: 16px; bottom: 20px; padding: 14px; font-size: 20px; }
  .lb-custom { top: auto; bottom: 0; left: 0; right: 0; width: auto; border-radius: 14px 14px 0 0; max-height: 70%; overflow-y: auto; }
  .lb-swatch { width: 44px; height: 44px; }
  .lb-editing .lb-ready { display: none; }
}
`
