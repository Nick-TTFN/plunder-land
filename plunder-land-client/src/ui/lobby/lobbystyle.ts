/**
 * The lobby's DOM chrome (lobby-rework, #42): placeholder look in the HUD's
 * colours (`ui/theme.ts`) after the mockup, until the screen gets its art.
 * Everything is `lb-` prefixed; the root ignores the pointer so the canvas
 * under it (the robots) shows through, and each control takes it back.
 * Sections share document flow; the canvas robot fits a measured preview slot.
 * Narrow screens stack the sections and scroll the content above a persistent READY footer.
 */
export const LOBBY_CSS = `
.lb { position: fixed; inset: 0; z-index: 10; display: flex; flex-direction: column; overflow: hidden;
  color: #E6EEF5; font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace; user-select: none; }
.lb button, .lb input, .lb label { pointer-events: auto; font-family: inherit; }
.lb button { cursor: pointer; }
.lb-top { flex: 0 0 auto; min-height: 64px; display: flex; align-items: center; gap: 16px;
  padding: 0 max(24px, env(safe-area-inset-right)) 0 max(24px, env(safe-area-inset-left)); border-bottom: 1px solid rgba(61,224,208,.12);
  background: linear-gradient(rgba(4,7,13,.85), rgba(4,7,13,0)); }
.lb-brand { font-size: 20px; letter-spacing: .24em; font-weight: 700; display: flex; align-items: center; gap: 12px; margin-right: auto; }
.lb-logo { width: 26px; height: 26px; border-radius: 50%; border: 3px solid #3DE0D0; box-shadow: 0 0 12px rgba(61,224,208,.6); }
.lb-tabs { display: flex; gap: 24px; font-size: 15px; letter-spacing: .12em; margin: 0 auto; }
.lb-tab { padding: 20px 4px; }
.lb-on { color: #fff; border-bottom: 3px solid #3DE0D0; }
.lb-off { color: #6b7d8f; pointer-events: auto; cursor: default; }
.lb-heading { min-width: 0; }
.lb-heading h1 { margin: 0; font-size: clamp(22px, 2.3vw, 34px); letter-spacing: .06em; font-weight: 700; }
.lb-heading p { margin: 6px 0 0; color: #a9bccd; font-size: 17px; }
.lb-pill { display: flex; align-items: center; justify-content: center; gap: 12px;
  padding: 8px 16px; max-width: 100%; border-radius: 24px; background: rgba(11,18,32,.85); border: 1px solid #2A4A5E; }
.lb-dot { width: 12px; height: 12px; border-radius: 50%; background: #39E08A; box-shadow: 0 0 8px #39E08A; }
.lb-name { width: 150px; background: transparent; border: 0; outline: none; color: #fff; font-size: 18px;
  letter-spacing: .12em; text-align: center; text-transform: uppercase; }
.lb-name::placeholder { color: #6b7d8f; }
.lb-pencil { color: #a9bccd; }
.lb-level { position: relative; padding: 2px 8px 4px; border-radius: 10px; font-size: 13px; letter-spacing: .1em; color: #3DE0D0;
  border: 1px solid #2A4A5E; white-space: nowrap; }
.lb-level::after { content: ''; position: absolute; left: 8px; bottom: 2px; height: 2px; width: calc((100% - 16px) * var(--lb-level-fill, 0));
  background: #3DE0D0; }
.lb-level[hidden] { display: none; }
.lb-season { display: flex; flex-direction: column; align-items: center; gap: 4px;
  font-size: 11px; line-height: 1.5; letter-spacing: .08em; color: #a9bccd; text-align: center; overflow-wrap: anywhere; }
.lb-season-notice { padding: 3px 10px; border-radius: 6px; color: #0b1622; background: #3DE0D0; }
.lb-season[hidden], .lb-season-notice[hidden] { display: none; }
.lb-arrow { position: absolute; top: 50%; transform: translateY(-50%); width: 48px; height: 48px; border-radius: 50%; font-size: 30px; line-height: 1;
  color: #E6EEF5; background: rgba(11,18,32,.75); border: 1px solid #2A4A5E; }
.lb-arrow:hover { border-color: #3DE0D0; }
.lb-plate { text-align: center; min-width: 0; }
.lb-kind { font-size: 13px; letter-spacing: .4em; color: #a9bccd; }
.lb-namerow { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 10px; margin: 6px 0; }
.lb-robot { font-size: clamp(28px, 3vw, 42px); font-weight: 800; letter-spacing: .02em; }
.lb-edit { padding: 6px 12px; font-size: 14px; letter-spacing: .1em; color: #E6EEF5; background: rgba(11,18,32,.85);
  border: 1px solid #3DE0D0; border-radius: 4px; }
.lb-tagline { color: #c9d6e2; font-size: 16px; }
.lb-stats { align-self: center; padding: 14px 16px; border-radius: 8px;
  background: rgba(11,18,32,.80); border: 1px solid #2A4A5E; display: grid; gap: 9px; min-width: 0; }
.lb-stat { display: grid; grid-template-columns: 64px minmax(20px, 1fr) 72px; align-items: center; gap: 10px; font-size: 12px; letter-spacing: .08em; }
.lb-label { color: #8FA3B5; }
.lb-track { height: 8px; border-radius: 4px; background: #1A2533; overflow: hidden; }
.lb-fill { height: 100%; background: linear-gradient(90deg, #2fb8ab, #3DE0D0); transition: width .25s; }
.lb-value { text-align: right; color: #E6EEF5; }
.lb-cards { display: flex; justify-content: center; gap: 14px; padding: 10px 4px; overflow-x: auto; min-width: 0; max-width: 100%; }
.lb-card { position: relative; flex: 0 0 112px; height: 136px; border-radius: 10px; color: #E6EEF5;
  background: rgba(11,18,32,.88); border: 2px solid #2A4A5E; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; padding: 0 4px 10px; }
.lb-card:hover:not(:disabled) { border-color: #6fbfb7; }
.lb-picked { border-color: #3DE0D0; box-shadow: 0 0 18px rgba(61,224,208,.45); }
.lb-thumb { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 40px; color: #3b4e60; }
.lb-thumb img { max-width: 86px; max-height: 86px; }
.lb-cardname { font-size: 12px; letter-spacing: .1em; }
.lb-locked { cursor: default; opacity: .55; }
.lb-soon { position: absolute; top: 8px; right: 8px; font-size: 10px; letter-spacing: .12em; padding: 2px 6px;
  border-radius: 3px; background: #1A2533; color: #8FA3B5; }
.lb-custom { position: absolute; top: 76px; right: 24px; width: min(440px, calc(100% - 32px)); max-height: calc(100% - 92px); overflow-y: auto;
  padding: 18px 20px; border-radius: 10px; background: rgba(11,18,32,.98); border: 1px solid #3a6e7e;
  box-shadow: 0 0 24px rgba(61,224,208,.18); pointer-events: auto; z-index: 2; }
.lb-hidden { display: none; }
.lb-lock { position: absolute; left: 50%; bottom: 2px; transform: translateX(-50%); font-size: 9px; letter-spacing: .06em; padding: 0 3px;
  border-radius: 3px; background: #1A2533; color: #8FA3B5; white-space: nowrap; pointer-events: none; }
.lb-small .lb-lock { bottom: -10px; font-size: 8px; }
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
.lb-lo-tabs { display: flex; gap: 8px; padding: 14px 0 10px; }
.lb-lo-tabs .lb-chip { min-width: 52px; padding: 6px 10px; font-size: 13px; }
.lb-lo-tabs .lb-chip:disabled { opacity: .45; cursor: default; }
.lb-lo-slots { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding-bottom: 14px; border-bottom: 1px solid #1E3344; }
.lb-lo-slot { position: relative; height: 84px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  color: #E6EEF5; background: #101A28; border: 2px solid #2A4A5E; border-radius: 8px; padding: 18px 4px 6px; }
.lb-lo-key { position: absolute; top: 4px; left: 6px; font-size: 11px; color: #a9bccd; }
.lb-lo-icon { width: 30px; height: 30px; object-fit: contain; font-size: 20px; color: #3b4e60; line-height: 30px; text-align: center; }
.lb-lo-name { font-size: 9px; letter-spacing: .06em; text-align: center; line-height: 1.2; }
.lb-lo-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 14px 0; }
.lb-lo-skill { position: relative; height: 70px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  color: #E6EEF5; background: #101A28; border: 1px solid #2A4A5E; border-radius: 8px; font-size: 11px; letter-spacing: .08em; padding: 4px; }
.lb-lo-skill:hover:not(:disabled) { border-color: #3DE0D0; }
.lb-lo-skill:disabled { cursor: default; }
.lb-lo-locked { opacity: .4; }
.lb-lo-badge { position: absolute; top: 3px; right: 4px; font-size: 9px; padding: 1px 4px; border-radius: 3px; background: #1A2533; color: #a9bccd; }
.lb-lo-on { background: #3DE0D0; color: #0B1220; }
.lb-lo-status { font-size: 12px; letter-spacing: .1em; color: #a9bccd; }
.lb-stash { overflow-y: auto; }
.lb-st-count { font-size: 13px; letter-spacing: .08em; color: #a9bccd; }
.lb-st-kit { display: grid; grid-template-columns: repeat(4, 1fr) 6px repeat(2, 1.2fr); gap: 6px; padding: 14px 0; border-bottom: 1px solid #1E3344; }
.lb-st-kit > :nth-child(5) { grid-column: 6; }
.lb-st-key { position: relative; height: 54px; display: flex; align-items: center; justify-content: center; color: #E6EEF5;
  background: #101A28; border: 1px solid #1E3344; border-radius: 8px; padding: 12px 2px 4px; opacity: .7; }
.lb-st-bring { height: 54px; border: 2px dashed #2A4A5E; opacity: 1; }
.lb-st-bring:disabled { cursor: default; }
.lb-st-bring.lb-locked { opacity: .55; }
.lb-st-plus { font-size: 22px; color: #3b4e60; }
.lb-st-warn { margin-top: 10px; padding: 6px 8px; border-radius: 6px; font-size: 11px; letter-spacing: .08em; line-height: 1.4;
  color: #1a1206; background: #ffc45e; }
.lb-st-warn[hidden], .lb-st-over[hidden], .lb-st-grid[hidden] { display: none; }
.lb-st-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; padding-top: 12px; }
.lb-st-cell { position: relative; height: 66px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  color: #E6EEF5; background: #101A28; border: 2px solid #2A4A5E; border-radius: 8px; padding: 4px; }
.lb-st-cell:hover:not(:disabled) { filter: brightness(1.25); }
.lb-st-empty { border-style: dashed; border-color: #1E3344; cursor: default; }
.lb-st-tier { font-size: 10px; letter-spacing: .08em; color: #a9bccd; }
.lb-st-over { padding-top: 12px; font-size: 11px; letter-spacing: .12em; color: #ffc45e; }
.lb-st-detail { min-height: 58px; margin-top: 14px; padding-top: 12px; border-top: 1px solid #1E3344; }
.lb-st-hint { font-size: 12px; letter-spacing: .1em; color: #6b7d8f; text-align: center; padding: 18px 0; }
.lb-st-card { display: flex; gap: 12px; align-items: flex-start; padding: 10px; border: 2px solid #2A4A5E; border-radius: 8px; background: #101A28; }
.lb-st-lines { font-size: 12px; line-height: 1.5; color: #c9d6e2; }
.lb-st-name { font-size: 14px; letter-spacing: .08em; color: #fff; }
.lb-st-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 10px; }
.lb-st-actions .lb-chip { padding: 8px 12px; font-size: 12px; }
.lb-st-actions .lb-chip:disabled { cursor: default; opacity: .6; }
.lb-st-tools { display: flex; align-items: center; gap: 10px; padding-top: 12px; }
.lb-st-tools .lb-chip { padding: 8px 14px; font-size: 12px; }
.lb-st-tools .lb-chip:disabled { cursor: default; opacity: .45; }
.lb-st-toolhint { font-size: 11px; letter-spacing: .1em; color: #a9bccd; }
.lb-st-pickno { position: absolute; top: 3px; left: 4px; min-width: 16px; height: 16px; border-radius: 50%; font-size: 10px; line-height: 16px;
  text-align: center; background: #3DE0D0; color: #0B1220; font-weight: 700; }
.lb-st-dim { opacity: .35; }
.lb-st-mslots { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.lb-st-mslot { position: relative; height: 66px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  color: #E6EEF5; background: #101A28; border: 2px solid #2A4A5E; border-radius: 8px; padding: 4px; }
.lb-st-mslot .lb-st-tier { font-size: 9px; text-align: center; line-height: 1.2; }
.lb-st-keep { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 10px; }
.lb-st-keep .lb-chip { padding: 8px 12px; font-size: 12px; }
.lb-st-keeplabel { font-size: 11px; letter-spacing: .1em; color: #a9bccd; }
.lb-st-preview { padding-top: 10px; font-size: 12px; letter-spacing: .08em; color: #c9d6e2; }
.lb-st-why { color: #ffc45e; }
.lb-st-go { color: #0B1220 !important; background: #3DE0D0 !important; border-color: #3DE0D0 !important; font-weight: 700; }
.lb-st-danger { color: #ff9a8a; border-color: #6e3a3a; }
.lb-st-yes { color: #fff; background: #a8352a; border-color: #d4554a; }
.lb-st-confirm { align-items: center; }
.lb-st-ask { flex-basis: 100%; font-size: 12px; letter-spacing: .08em; color: #ff9a8a; }
.lb-st-result { padding-bottom: 8px; font-size: 15px; letter-spacing: .12em; font-weight: 700; color: #3DE0D0; }
.lb-st-surprise { color: #ffc45e; }
.lb-st-notice { padding-top: 10px; font-size: 11px; letter-spacing: .08em; color: #a9bccd; }
.lb-st-notice.lb-st-bad { color: #ff9a8a; }
.lb-st-notice[hidden] { display: none; }
.lb-ready { padding: 14px 32px; font-size: 24px; font-weight: 800; letter-spacing: .14em;
  color: #1a1206; background: linear-gradient(#ffc45e, #f2a12e); border: 2px solid #ffd58a; border-radius: 10px;
  box-shadow: 0 0 22px rgba(255,181,71,.45); white-space: nowrap; }
.lb-ready:hover { filter: brightness(1.08); }
.lb-ready-sub { display: block; margin-top: 4px; font-size: 11px; font-weight: 600; letter-spacing: .12em; }
.lb-ready-sub[hidden] { display: none; }
.lb-ready:disabled { filter: grayscale(1) brightness(.7); box-shadow: none; cursor: not-allowed; }
.lb-keys { font-size: 11px; letter-spacing: .06em; line-height: 2.5; color: #a9bccd; }
.lb-privacy { font-size: 10px; letter-spacing: .12em; color: #7f95a8; text-decoration: none; pointer-events: auto; }
.lb-privacy:hover { color: #5fe0cf; }
.lb-invite { order: 2; flex-shrink: 0; padding: 8px 14px; font-size: 13px; letter-spacing: .12em;
  color: #5fe0cf; background: rgba(61,224,208,.08); border: 1px solid #3a6e7e; border-radius: 6px; cursor: pointer; }
.lb-invite:hover { background: rgba(61,224,208,.16); }
.lb-settings { order: 1; }
.lb-join { display: flex; align-items: center; gap: 10px; max-width: 100%;
  padding: 6px 8px 6px 14px; font-size: 12px; letter-spacing: .08em; color: #0b1622; background: #5fe0cf; border-radius: 6px;
  pointer-events: auto; }
.lb-full { background: #ffc45e; }
.lb-join-x { border: 0; background: transparent; color: #0b1622; font-size: 14px; cursor: pointer; padding: 0 4px; }
.lb-keys kbd { display: inline-block; min-width: 18px; padding: 3px 6px; margin: 0 4px 0 8px; border: 1px solid #3a5266; border-radius: 4px;
  font-family: inherit; color: #E6EEF5; text-align: center; }
/* Shared flow owns spacing; only the canvas art and overlay panels are positioned. */
.lb, .lb * { box-sizing: border-box; }
.lb-content { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }
.lb-main { width: 100%; max-width: 1480px; min-height: 100%; margin: 0 auto; padding: 24px 32px 12px;
  display: flex; flex-direction: column; gap: 16px; }
.lb-intro { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 1fr); align-items: start; gap: 24px; }
.lb-identity { display: flex; flex-direction: column; align-items: center; gap: 8px; min-width: 0; }
.lb-name { min-width: 0; }
.lb-dot { flex-shrink: 0; }
.lb-showcase { flex: 1; display: grid; grid-template-columns: 280px minmax(0, 1fr) 280px; align-items: center; gap: 24px; }
.lb-hero { min-width: 0; }
.lb-preview { position: relative; height: clamp(180px, 28vh, 320px); }
.lb-prev { left: 0; }
.lb-next { right: 0; }
.lb-edit { min-height: 36px; }
.lb-tagline { font-size: 14px; line-height: 1.5; }
.lb-footer { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 20px;
  padding: 12px max(32px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(32px, env(safe-area-inset-left));
  background: rgba(4,7,13,.8); border-top: 1px solid rgba(61,224,208,.12); }
.lb-hints { min-width: 0; }
.lb-action { display: flex; flex-direction: column; align-items: stretch; gap: 8px; }
.lb-join[hidden] { display: none; }
@media (max-width: 1200px) {
  .lb-showcase { grid-template-columns: 260px minmax(0, 1fr); }
  .lb-hero { width: 100%; max-width: 640px; justify-self: center; }
  .lb-tabs { gap: 16px; font-size: 13px; }
  .lb-brand { font-size: 17px; }
  .lb-keys { display: none; }
}
@media (max-width: 900px) {
  .lb-tabs { display: none; }
  .lb-main { padding: 20px 24px 12px; }
  .lb-intro { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .lb-heading { display: none; }
  .lb-showcase { grid-template-columns: 240px minmax(0, 1fr); gap: 20px; }
  .lb-stats { padding: 12px; }
  .lb-stat { grid-template-columns: 56px minmax(20px, 1fr) 64px; gap: 8px; font-size: 11px; }
  .lb-robot { flex-basis: 100%; }
  .lb-edit { font-size: 12px; padding: 6px 10px; }
}
@media (max-width: 640px) {
  .lb-top { min-height: 56px; padding-left: max(12px, env(safe-area-inset-left)); padding-right: max(12px, env(safe-area-inset-right)); gap: 8px; }
  .lb-brand { font-size: 13px; letter-spacing: .12em; gap: 8px; }
  .lb-logo { width: 20px; height: 20px; border-width: 2px; }
  .lb-invite { padding: 8px; font-size: 11px; letter-spacing: .06em; min-height: 36px; }
  .lb-main { padding: 14px 16px 10px; gap: 12px; }
  .lb-showcase { display: flex; flex-direction: column; gap: 16px; }
  .lb-hero { order: -1; }
  .lb-preview { height: 200px; }
  .lb-plate { width: 100%; }
  .lb-kind { font-size: 11px; }
  .lb-robot { font-size: 30px; }
  .lb-tagline { font-size: 12px; }
  .lb-stats { width: 100%; gap: 6px; }
  .lb-stat { grid-template-columns: 64px minmax(20px, 1fr) 72px; }
  .lb-cards { justify-content: flex-start; gap: 10px; flex-shrink: 0; }
  .lb-card { flex-basis: 88px; height: 112px; }
  .lb-thumb img { max-width: 64px; max-height: 64px; }
  .lb-cardname { font-size: 10px; }
  .lb-footer { flex-direction: column; gap: 6px; padding: 10px 16px max(8px, env(safe-area-inset-bottom)); }
  .lb-action { order: -1; width: 100%; }
  .lb-ready { width: 100%; font-size: 20px; padding: 12px; }
  .lb-custom { top: auto; bottom: 0; left: 0; right: 0; width: 100%; border-radius: 14px 14px 0 0; max-height: 85%; }
  .lb-swatch { width: 44px; height: 44px; }
  .lb-st-actions .lb-chip, .lb-st-keep .lb-chip, .lb-st-tools .lb-chip { min-height: 40px; }
}
@media (max-width: 380px) {
  .lb-logo { display: none; }
  .lb-brand { font-size: 11px; letter-spacing: .04em; }
  .lb-top { gap: 6px; }
  .lb-pill { gap: 8px; padding: 8px 12px; }
  .lb-name { width: 130px; }
}
@media (max-height: 500px) and (min-width: 641px) {
  .lb-top { min-height: 48px; }
  .lb-tabs, .lb-heading { display: none; }
  .lb-tab { padding: 12px 4px; }
  .lb-main { padding-top: 12px; }
  .lb-intro { grid-template-columns: 1fr; }
  .lb-preview { height: 180px; }
  .lb-footer { padding-top: 8px; padding-bottom: max(8px, env(safe-area-inset-bottom)); }
  .lb-ready { font-size: 18px; padding: 8px 24px; }
  .lb-custom { top: 56px; bottom: 8px; max-height: none; }
}
`
