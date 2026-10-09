/**
 * The lobby's DOM chrome (lobby-rework #42, relaid after Nick's 2026-10-09
 * mockup): placeholder look in the HUD's colours (`ui/theme.ts`) until the
 * screen gets its art. Everything is `lb-` prefixed; the root ignores the
 * pointer so the canvas under it (the robot) shows through, and each control
 * takes it back.
 *
 * Desktop: one grid, the hero (canvas robot, name, CHANGE SCAVENGER) spanning
 * the left column, progression, journey, the three action rows, the season
 * row and READY on the right. Under 760 px the grid is one column
 * (progression, journey, hero, rows), READY sticks to the bottom of the
 * scroll, and INVITE / settings / PRIVACY fold into the header's menu. The
 * panels (STATS & PAINT, SCAVENGERS, LOADOUT, STASH) keep the mono look and
 * become a bottom sheet under 760 px.
 */
export const LOBBY_CSS = `
.lb, .lb * { box-sizing: border-box; }
.lb { position: fixed; inset: 0; z-index: 10; display: flex; flex-direction: column; overflow: hidden;
  color: #E6EEF5; font-family: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; user-select: none; }
.lb button, .lb input, .lb label, .lb a { pointer-events: auto; font-family: inherit; }
.lb button { cursor: pointer; }
.lb button:disabled { cursor: default; }
.lb svg { display: block; flex-shrink: 0; }
.lb [hidden] { display: none !important; }
.lb-mono, .lb-eyebrow, .lb-xprow, .lb-actstatus, .lb-season-line, .lb-ready-sub, .lb-custom, .lb-name { font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace; }

/* Header */
.lb-top { position: relative; flex: 0 0 auto; min-height: 68px; display: flex; align-items: center; gap: 16px;
  padding: 0 max(28px, env(safe-area-inset-right)) 0 max(28px, env(safe-area-inset-left));
  border-bottom: 1px solid rgba(61,224,208,.12); background: rgba(4,8,14,.72); }
.lb-brand { font-size: 20px; letter-spacing: .32em; font-weight: 600; display: flex; align-items: center; gap: 14px; white-space: nowrap; }
.lb-logo { width: 28px; height: 28px; border-radius: 50%; border: 3px solid #3DE0D0; box-shadow: 0 0 12px rgba(61,224,208,.55); flex-shrink: 0; }
.lb-tabs { display: flex; gap: 36px; font-size: 16px; margin: 0 auto; align-self: stretch; }
.lb-tab { display: flex; align-items: center; padding: 0 18px; border-bottom: 3px solid transparent; }
.lb-on { color: #fff; font-weight: 600; border-bottom-color: #3DE0D0; }
.lb-off { color: #8193a5; pointer-events: auto; cursor: default; }
.lb-topactions { display: flex; align-items: center; gap: 12px; }
.lb-invite { display: inline-flex; align-items: center; justify-content: center; gap: 10px; min-height: 40px; padding: 0 26px;
  font-size: 15px; font-weight: 600; color: #5fe0cf; background: rgba(61,224,208,.06); border: 1px solid #2f7f80; border-radius: 6px; }
.lb-invite:hover { background: rgba(61,224,208,.14); }
.lb-settings { padding: 0 12px; color: #E6EEF5; border-color: #2A4A5E; background: rgba(11,18,32,.6); }
.lb-settings svg { width: 20px; height: 20px; }
.lb-menu-label { display: none; }
.lb-menu, .lb-menu-only { display: none !important; }
.lb-menu { width: 44px; height: 44px; align-items: center; justify-content: center; color: #E6EEF5; background: none; border: 0; margin-left: auto; }

/* The grid */
.lb-content { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }
.lb-main { width: 100%; max-width: 1280px; min-height: 100%; margin: 0 auto; padding: 28px 40px 28px;
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(380px, 560px); column-gap: 56px; row-gap: 18px;
  grid-template-areas: "hero name" "hero prog" "hero journey" "hero acts" "hero season" "hero action";
  grid-template-rows: auto auto auto auto auto 1fr; }
.lb-hero { grid-area: hero; display: flex; flex-direction: column; align-items: center; min-width: 0; min-height: 0;
  padding-right: 56px; margin-right: -28px; border-right: 1px solid rgba(61,224,208,.12); }
.lb-preview { position: relative; width: 100%; flex: 1; min-height: 280px; }
.lb-plate { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 0 12px; text-align: center; }
.lb-robot { font-size: clamp(30px, 3vw, 40px); font-weight: 700; }
.lb-kind { font-size: 14px; letter-spacing: .28em; color: #a9bccd; }
.lb-change { display: inline-flex; align-items: center; gap: 10px; margin-top: 14px; min-height: 44px; padding: 0 22px;
  font-size: 16px; font-weight: 500; color: #E6EEF5; background: rgba(11,18,32,.7); border: 1px solid #2A4A5E; border-radius: 6px; }
.lb-change:hover { border-color: #3DE0D0; }
.lb-change svg { width: 18px; height: 18px; }

.lb-callsign { grid-area: name; justify-self: start; display: flex; align-items: center; gap: 10px; max-width: 100%;
  padding: 6px 14px; border-radius: 20px; background: rgba(11,18,32,.6); border: 1px solid #1f3646; cursor: text; }
.lb-dot { width: 10px; height: 10px; border-radius: 50%; background: #39E08A; box-shadow: 0 0 8px #39E08A; flex-shrink: 0; }
.lb-name { width: 170px; min-width: 0; background: transparent; border: 0; outline: none; color: #fff; font-size: 14px;
  letter-spacing: .12em; text-transform: uppercase; }
.lb-name::placeholder { color: #6b7d8f; }
.lb-pencil { color: #8FA3B5; font-size: 13px; }

.lb-eyebrow { font-size: 13px; color: #a9bccd; margin-bottom: 8px; }
.lb-progress { grid-area: prog; padding-bottom: 20px; border-bottom: 1px solid rgba(61,224,208,.12); }
.lb-levelhead { font-size: clamp(34px, 3.4vw, 46px); font-weight: 700; line-height: 1.1; margin-bottom: 14px; }
.lb-xpbar { height: 16px; border-radius: 8px; background: #16222f; border: 1px solid #1f3343; overflow: hidden; }
.lb-xpfill { height: 100%; width: 0; border-radius: 8px; background: linear-gradient(90deg, #22c7b8, #3DE0D0); box-shadow: 0 0 14px rgba(61,224,208,.6); transition: width .4s; }
.lb-xprow { display: flex; justify-content: space-between; gap: 12px; margin-top: 10px; font-size: 13px; color: #c9d6e2; }

.lb-journey { grid-area: journey; }
.lb-jstrip { display: flex; align-items: flex-start; gap: 8px; }
.lb-jarrow { flex: 0 0 auto; width: 40px; height: 40px; margin-top: 4px; border-radius: 50%; font-size: 24px; line-height: 1;
  color: #E6EEF5; background: rgba(11,18,32,.7); border: 1px solid #2A4A5E; }
.lb-jarrow:hover:not(:disabled) { border-color: #3DE0D0; }
.lb-jarrow:disabled { opacity: .35; }
.lb-jstops { flex: 1; min-width: 0; display: flex; justify-content: space-between; position: relative; }
.lb-jstops::before { content: ''; position: absolute; left: 10%; right: 10%; top: 24px; height: 2px; background: #1f3646; }
.lb-jstop { position: relative; flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 0; }
.lb-jring { position: relative; width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-size: 17px; font-weight: 600; color: #E6EEF5; background: #0d1824; border: 2px solid #2A4A5E; }
.lb-jring svg { width: 22px; height: 22px; }
.lb-jring img { max-width: 38px; max-height: 38px; }
.lb-jnow .lb-jring { border-color: #3DE0D0; box-shadow: 0 0 0 4px rgba(61,224,208,.12), 0 0 16px rgba(61,224,208,.5); }
.lb-jdone .lb-jring { color: #3DE0D0; border-color: #24585a; }
.lb-jempty .lb-jring { color: #4f6273; border-color: #1c2b39; }
.lb-jstop:not(.lb-jnow):not(.lb-jdone):not(.lb-jempty) .lb-jring { color: #ffc45e; }
.lb-jlock { position: absolute; top: -4px; right: -4px; width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  color: #c9d6e2; background: #0d1824; }
.lb-jlock svg { width: 12px; height: 12px; }
.lb-jlevel { font-size: 13px; color: #c9d6e2; }
.lb-jnow .lb-jlevel { color: #fff; font-weight: 600; }
.lb-jempty .lb-jlevel { color: #4f6273; }
.lb-jkind { font-size: 12px; color: #8FA3B5; min-height: 15px; }

.lb-acts { grid-area: acts; display: flex; flex-direction: column; gap: 10px; }
.lb-act { display: flex; align-items: center; gap: 16px; width: 100%; min-height: 64px; padding: 10px 14px 10px 18px; text-align: left;
  color: #E6EEF5; background: rgba(11,18,32,.72); border: 1px solid #1f3646; border-radius: 8px; }
.lb-act:hover { border-color: #2f7f80; background: rgba(14,24,38,.85); }
.lb-acticon { color: #E6EEF5; }
.lb-acticon svg { width: 24px; height: 24px; }
.lb-actwords { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.lb-actlabel { font-size: 15px; font-weight: 600; }
.lb-actstatus { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12px; color: #a9bccd; }
.lb-acttext { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb-actdot { width: 8px; height: 8px; border-radius: 50%; background: #3DE0D0; box-shadow: 0 0 6px #3DE0D0; flex-shrink: 0; }
.lb-actverb { flex-shrink: 0; min-width: 88px; padding: 7px 16px; text-align: center; font-size: 15px; font-weight: 600;
  color: #5fe0cf; border: 1px solid #2f7f80; border-radius: 6px; }
.lb-act:hover .lb-actverb { background: rgba(61,224,208,.12); }
.lb-actchev { color: #a9bccd; }
.lb-actchev svg { width: 20px; height: 20px; }

.lb-season { grid-area: season; display: flex; align-items: flex-start; gap: 16px; padding: 14px 4px 0 18px; border-top: 1px solid rgba(61,224,208,.12); }
.lb-season .lb-acticon { color: #a9bccd; }
.lb-seasonwords { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.lb-seasonwords .lb-actlabel { font-size: 14px; font-weight: 500; color: #c9d6e2; }
.lb-season-line { font-size: 11px; line-height: 1.5; letter-spacing: .06em; color: #8FA3B5; overflow-wrap: anywhere; }
.lb-season-notice { align-self: flex-start; padding: 3px 10px; border-radius: 6px; font-size: 11px; color: #0b1622; background: #3DE0D0; }

.lb-action { grid-area: action; align-self: end; display: flex; flex-direction: column; align-items: stretch; gap: 10px; padding-top: 8px; }
.lb-ready { display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 64px; padding: 0 32px;
  font-size: 26px; font-weight: 700; color: #1a1206; background: linear-gradient(#ffc45e, #f2a12e); border: 2px solid #ffd58a; border-radius: 10px;
  box-shadow: 0 0 26px rgba(255,181,71,.45); white-space: nowrap; }
.lb-ready svg { width: 24px; height: 24px; stroke-width: 2.6; }
.lb-ready:hover { filter: brightness(1.08); }
.lb-ready:disabled { filter: grayscale(1) brightness(.7); box-shadow: none; cursor: not-allowed; }
.lb-ready-sub { text-align: center; font-size: 13px; letter-spacing: .06em; color: #c9d6e2; }
.lb-privacy { align-self: center; font-size: 11px; letter-spacing: .12em; color: #6f8496; text-decoration: none; }
.lb-privacy:hover { color: #5fe0cf; }
.lb-join { display: flex; align-items: center; gap: 10px; max-width: 100%;
  padding: 6px 8px 6px 14px; font-size: 12px; letter-spacing: .08em; color: #0b1622; background: #5fe0cf; border-radius: 6px; pointer-events: auto; }
.lb-full { background: #ffc45e; }
.lb-join-text { flex: 1; min-width: 0; }
.lb-join-x { border: 0; background: transparent; color: #0b1622; font-size: 14px; cursor: pointer; padding: 0 4px; }

/* Panels (mono, placeholder chrome) */
.lb-custom { position: absolute; top: 80px; right: 24px; width: min(440px, calc(100% - 32px)); max-height: calc(100% - 92px); overflow-y: auto;
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
.lb-stats { display: grid; gap: 9px; padding: 14px 0; border-bottom: 1px solid #1E3344; }
.lb-stat { display: grid; grid-template-columns: 64px minmax(20px, 1fr) 72px; align-items: center; gap: 10px; font-size: 12px; letter-spacing: .08em; }
.lb-label { color: #8FA3B5; }
.lb-track { height: 8px; border-radius: 4px; background: #1A2533; overflow: hidden; }
.lb-fill { height: 100%; background: linear-gradient(90deg, #2fb8ab, #3DE0D0); transition: width .25s; }
.lb-value { text-align: right; color: #E6EEF5; }
.lb-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 10px; padding: 14px 0; }
.lb-card { position: relative; height: 132px; border-radius: 10px; color: #E6EEF5;
  background: #101A28; border: 2px solid #2A4A5E; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; padding: 0 4px 10px; }
.lb-card:hover:not(:disabled) { border-color: #6fbfb7; }
.lb-picked { border-color: #3DE0D0; box-shadow: 0 0 18px rgba(61,224,208,.45); }
.lb-thumb { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 40px; color: #3b4e60; }
.lb-thumb img { max-width: 80px; max-height: 80px; }
.lb-cardname { font-size: 12px; letter-spacing: .1em; }
.lb-locked { cursor: default; opacity: .55; }
.lb-soon { position: absolute; top: 8px; right: 8px; font-size: 10px; letter-spacing: .12em; padding: 2px 6px;
  border-radius: 3px; background: #1A2533; color: #8FA3B5; }
.lb-tagline { padding: 4px 0 2px; color: #c9d6e2; font-size: 13px; line-height: 1.5; }
.lb-picker .lb-customfoot .lb-lo-status { font-size: 11px; }

@media (max-width: 1100px) {
  .lb-main { column-gap: 40px; padding: 24px 28px; grid-template-columns: minmax(0, 1fr) minmax(340px, 480px); }
  .lb-hero { padding-right: 40px; margin-right: -20px; }
  .lb-tabs { gap: 16px; }
  .lb-brand { font-size: 17px; letter-spacing: .24em; }
}
@media (max-width: 760px) {
  .lb-top { min-height: 60px; padding: 0 max(12px, env(safe-area-inset-right)) 0 max(16px, env(safe-area-inset-left)); }
  .lb-brand { font-size: 16px; letter-spacing: .22em; gap: 12px; }
  .lb-logo { width: 24px; height: 24px; }
  .lb-tabs, .lb-desk-only { display: none !important; }
  .lb-menu { display: flex !important; }
  .lb-topactions { display: none; position: absolute; top: calc(100% + 6px); right: 12px; z-index: 3; min-width: 200px;
    flex-direction: column; align-items: stretch; gap: 8px; padding: 10px; border-radius: 10px;
    background: rgba(11,18,32,.98); border: 1px solid #2A4A5E; box-shadow: 0 12px 30px rgba(0,0,0,.5); }
  .lb-menu-open .lb-topactions { display: flex; }
  .lb-menu-open .lb-menu-only { display: block !important; }
  .lb-topactions .lb-privacy { padding: 8px 4px 2px; text-align: center; }
  .lb-settings { justify-content: center; }
  .lb-menu-label { display: inline; font-size: 15px; }
  .lb-main { grid-template-columns: minmax(0, 1fr); column-gap: 0; row-gap: 14px; padding: 16px 16px 0;
    grid-template-areas: "prog" "journey" "hero" "name" "acts" "season" "action"; grid-template-rows: none; }
  .lb-hero { padding: 0; margin: 0; border: 0; }
  .lb-preview { flex: none; height: 170px; min-height: 0; }
  .lb-plate { padding: 0; gap: 4px; }
  .lb-robot { font-size: 22px; }
  .lb-kind { font-size: 11px; }
  .lb-change { margin-top: 6px; min-height: 36px; font-size: 13px; padding: 0 14px; }
  .lb-callsign { justify-self: center; }
  .lb-progress { padding-bottom: 14px; }
  .lb-eyebrow { font-size: 12px; margin-bottom: 6px; }
  .lb-levelhead { font-size: 32px; margin-bottom: 10px; }
  .lb-xpbar { height: 12px; }
  .lb-xprow { font-size: 11px; }
  .lb-jstop:nth-child(5) { display: none; }
  .lb-jarrow { width: 32px; height: 32px; font-size: 20px; margin-top: 6px; }
  .lb-jring { width: 40px; height: 40px; font-size: 15px; }
  .lb-jring img { max-width: 30px; max-height: 30px; }
  .lb-jstops::before { top: 20px; }
  .lb-jlevel { font-size: 11px; }
  .lb-jkind { font-size: 10px; }
  .lb-acts { gap: 8px; }
  .lb-act { min-height: 54px; gap: 12px; padding: 8px 8px 8px 14px; }
  .lb-acticon svg { width: 20px; height: 20px; }
  .lb-actlabel { font-size: 13px; }
  .lb-actstatus { font-size: 11px; }
  .lb-actverb { min-width: 72px; padding: 6px 10px; font-size: 13px; }
  .lb-season { padding: 10px 4px 0 14px; }
  .lb-action { position: sticky; bottom: 0; z-index: 1; margin: 0 -16px; padding: 14px 16px max(12px, env(safe-area-inset-bottom));
    background: linear-gradient(rgba(4,8,14,0), rgba(4,8,14,.92) 28%); }
  .lb-ready { min-height: 52px; font-size: 21px; }
  .lb-ready-sub { font-size: 12px; }
  .lb-custom { top: auto; bottom: 0; left: 0; right: 0; width: 100%; border-radius: 14px 14px 0 0; max-height: 85%; }
  .lb-swatch { width: 44px; height: 44px; }
  .lb-st-actions .lb-chip, .lb-st-keep .lb-chip, .lb-st-tools .lb-chip { min-height: 40px; }
}
@media (max-width: 360px) {
  .lb-brand { font-size: 13px; letter-spacing: .14em; gap: 8px; }
  .lb-actverb { display: none; }
}
@media (max-height: 520px) and (min-width: 761px) {
  .lb-top { min-height: 52px; }
  .lb-main { padding-top: 14px; padding-bottom: 14px; row-gap: 10px; }
  .lb-preview { min-height: 160px; }
  .lb-levelhead { font-size: 28px; margin-bottom: 8px; }
  .lb-progress { padding-bottom: 12px; }
  .lb-act { min-height: 48px; padding-top: 6px; padding-bottom: 6px; }
  .lb-ready { min-height: 48px; font-size: 20px; }
  .lb-custom { top: 60px; bottom: 8px; max-height: none; }
}
`
