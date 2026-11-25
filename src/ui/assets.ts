/**
 * Built-in UI visual assets embedded directly as TypeScript constants so
 * `bun build --compile` produces a completely self-contained single binary
 * with zero external static file dependencies.
 */

export interface SvgImageAsset {
  readonly mime: 'image/svg+xml';
  readonly svg: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export type WelcomeLogoAsset = SvgImageAsset;

/**
 * Display size (px) of the Welcome lockup logo (`omp.welcome.logo`), sized to
 * fit cleanly inside Tern's `52px`-tall `omp.welcome.lockup` row while matching
 * the exact aspect ratio (`21 : 19.6 ≈ 48 : 45`) of the Antigravity A-mark and
 * aligning vertically with the `oma` / `v0.1.0` wordmark stack.
 */
export const WELCOME_LOGO_WIDTH = 48;
export const WELCOME_LOGO_HEIGHT = 45;

/** Display size (px) for the HUD pill swarm bee button (`oma.bee.hud`). */
export const BEE_HUD_SIZE = 16;

/** Display size (px) for each orbiting bee around the composer (`oma.swarm.bee.img`). */
export const BEE_ORBIT_SIZE = 16;

/** Maximum simultaneous orbiting bees rendered around the composer perimeter. */
export const MAX_ORBIT_BEES = 12;

/** Display size (px) for each pixel bee avatar inside the Swarm Board roster cards (2x crisp 16x16 grid). */
export const BEE_CARD_SIZE = 32;

/**
 * Official Google Antigravity curved floating "A" glyph path.
 * Bounding box: x ∈ [2.23, 21.77] (w = 19.55), y ∈ [3.00, 21.00] (h = 18.00).
 */
export const ANTIGRAVITY_LOGO_PATH =
  'M19.94 20.59c1.09.82 2.73.27 1.23-1.23C16.67 15 17.62 3 12.03 3S7.39 15 2.89 19.36c-1.64 1.64.14 2.05 1.23 1.23c4.23-2.86 3.95-7.91 7.91-7.91s3.68 5.05 7.91 7.91Z';

/**
 * Dark-theme Google Antigravity A-mark SVG (`image/svg+xml`).
 */
export const ANTIGRAVITY_LOGO_SVG_DARK =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${WELCOME_LOGO_WIDTH}" height="${WELCOME_LOGO_HEIGHT}" viewBox="1.5 2.2 21 19.6">` +
  '<defs>' +
  '<linearGradient id="ag-dark" x1="8%" y1="18%" x2="92%" y2="86%">' +
  '<stop offset="0%" stop-color="#5B9BFF"/>' +
  '<stop offset="36%" stop-color="#38C66D"/>' +
  '<stop offset="70%" stop-color="#FFCA28"/>' +
  '<stop offset="100%" stop-color="#FF5E54"/>' +
  '</linearGradient>' +
  '</defs>' +
  `<path fill="url(#ag-dark)" d="${ANTIGRAVITY_LOGO_PATH}"/>` +
  '</svg>';

/**
 * Light-theme Google Antigravity A-mark SVG (`image/svg+xml`).
 */
export const ANTIGRAVITY_LOGO_SVG_LIGHT =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${WELCOME_LOGO_WIDTH}" height="${WELCOME_LOGO_HEIGHT}" viewBox="1.5 2.2 21 19.6">` +
  '<defs>' +
  '<linearGradient id="ag-light" x1="8%" y1="18%" x2="92%" y2="86%">' +
  '<stop offset="0%" stop-color="#1A73E8"/>' +
  '<stop offset="36%" stop-color="#1E8E3E"/>' +
  '<stop offset="70%" stop-color="#EA8600"/>' +
  '<stop offset="100%" stop-color="#D93025"/>' +
  '</linearGradient>' +
  '</defs>' +
  `<path fill="url(#ag-light)" d="${ANTIGRAVITY_LOGO_PATH}"/>` +
  '</svg>';

// ---------------------------------------------------------------------------
// Multi-Color Pixel-Art Swarm Bee Palette (1:1 aligned with native `agy` Roster)
// ---------------------------------------------------------------------------

export const BEE_PALETTE_IDS = [
  'gold',
  'violet',
  'sky',
  'indigo',
  'orange',
  'mint',
  'emerald',
  'rose',
] as const;

export type BeePaletteId = (typeof BEE_PALETTE_IDS)[number];

const WORKER_PALETTE_IDS: readonly BeePaletteId[] = [
  'violet',
  'sky',
  'indigo',
  'orange',
  'mint',
  'emerald',
  'rose',
];

export interface BeeColorSpec {
  readonly id: BeePaletteId;
  readonly outline: string;
  readonly body: string;
  readonly highlight: string;
  readonly shadow: string;
  readonly stripe: string;
  readonly labelDark: string;
  readonly labelLight: string;
}

export const BEE_COLOR_SPECS: Readonly<Record<BeePaletteId, BeeColorSpec>> = {
  gold: {
    id: 'gold',
    outline: '#24170B',
    body: '#E5B23E',
    highlight: '#FDE067',
    shadow: '#B57B1C',
    stripe: '#3A230F',
    labelDark: '#E5B84B',
    labelLight: '#B47B0A',
  },
  violet: {
    id: 'violet',
    outline: '#260E2E',
    body: '#C048D6',
    highlight: '#F08CF7',
    shadow: '#7E22A8',
    stripe: '#371247',
    labelDark: '#D946EF',
    labelLight: '#A21CAF',
  },
  sky: {
    id: 'sky',
    outline: '#0D2233',
    body: '#38A3D8',
    highlight: '#8CE0FA',
    shadow: '#1B6B9B',
    stripe: '#14334C',
    labelDark: '#38BDF8',
    labelLight: '#0284C7',
  },
  indigo: {
    id: 'indigo',
    outline: '#10183D',
    body: '#4B6BF5',
    highlight: '#93AAFF',
    shadow: '#2A40B5',
    stripe: '#192459',
    labelDark: '#6382FF',
    labelLight: '#3B5BDB',
  },
  orange: {
    id: 'orange',
    outline: '#2E1308',
    body: '#DB7538',
    highlight: '#FBB474',
    shadow: '#9E4218',
    stripe: '#451C0C',
    labelDark: '#E5894A',
    labelLight: '#C25914',
  },
  mint: {
    id: 'mint',
    outline: '#0A2926',
    body: '#2EC4B6',
    highlight: '#7EF2E4',
    shadow: '#117A72',
    stripe: '#123C38',
    labelDark: '#2DD4BF',
    labelLight: '#0D9488',
  },
  emerald: {
    id: 'emerald',
    outline: '#0B2915',
    body: '#34C759',
    highlight: '#86EFAC',
    shadow: '#15803D',
    stripe: '#133D20',
    labelDark: '#4ADE80',
    labelLight: '#15803D',
  },
  rose: {
    id: 'rose',
    outline: '#300E1B',
    body: '#EC5B7E',
    highlight: '#FDA4AF',
    shadow: '#BE185D',
    stripe: '#4A1329',
    labelDark: '#FB7185',
    labelLight: '#E11D48',
  },
};

/**
 * Deterministic member-name -> bee palette mapping:
 * - `coordinator` is always warm `gold` (and wears the pixel crown).
 * - Other members hash stably across the vibrant worker palette.
 */
export function getBeePaletteIdForMember(name: string, role?: string): BeePaletteId {
  const normalized = name.trim().toLowerCase();
  if (role === 'coordinator' || normalized === 'coordinator') {
    return 'gold';
  }
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const idx = (hash >>> 0) % WORKER_PALETTE_IDS.length;
  return WORKER_PALETTE_IDS[idx] ?? 'sky';
}

export function getBeeMemberColorHex(paletteId: BeePaletteId, dark = true): string {
  const spec = BEE_COLOR_SPECS[paletteId];
  return dark ? spec.labelDark : spec.labelLight;
}

export type BeeVisualState = 'active' | 'sleep';

/**
 * Canonical lookup key for `state.beeBlobs` (uploaded via `session.blob()`).
 * Example: `'gold:active:crown'`, `'violet:active'`, `'sky:sleep'`.
 */
export function getSwarmBeeBlobKey(
  paletteId: BeePaletteId,
  visualState: BeeVisualState,
  hasCrown = false
): string {
  return hasCrown ? `${paletteId}:${visualState}:crown` : `${paletteId}:${visualState}`;
}

interface WingAndAccentColors {
  readonly wingEdge: string;
  readonly wingFill: string;
  readonly wingShine: string;
  readonly zzz: string;
  readonly crownBright: string;
  readonly crownBase: string;
}

function getThemeAccents(dark: boolean): WingAndAccentColors {
  return dark
    ? {
        wingEdge: '#64748B',
        wingFill: '#CBD5E1',
        wingShine: '#F8FAFC',
        zzz: '#94A3B8',
        crownBright: '#FDE047',
        crownBase: '#D97706',
      }
    : {
        wingEdge: '#475569',
        wingFill: '#94A3B8',
        wingShine: '#E2E8F0',
        zzz: '#64748B',
        crownBright: '#F59E0B',
        crownBase: '#B45309',
      };
}

/**
 * Renders a crisp 16x16 left-facing pixel-art bee closely matching native `agy`
 * Swarm Roster sprites:
 * - `active`: puffy raised wings, bright twin eyes, lively legs
 * - `sleep`: folded low wings, closed eyes, crisp upper-left `z` marker
 * - `hasCrown`: tiny golden pixel crown atop the coordinator bee's head
 */
export function buildColoredBeeSvg(
  paletteId: BeePaletteId,
  visualState: BeeVisualState,
  dark: boolean,
  options?: { readonly size?: number; readonly hasCrown?: boolean }
): string {
  const p = BEE_COLOR_SPECS[paletteId];
  const a = getThemeAccents(dark);
  const size = options?.size ?? BEE_CARD_SIZE;
  const hasCrown = options?.hasCrown ?? false;
  const isSleep = visualState === 'sleep';

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" shape-rendering="crispEdges">`,
  ];

  // 1. Sleeping upper-left pixel `z` indicator
  if (isSleep) {
    parts.push(
      `<rect x="1" y="1" width="3" height="1" fill="${a.zzz}"/>`,
      `<rect x="2" y="2" width="1" height="1" fill="${a.zzz}"/>`,
      `<rect x="1" y="3" width="3" height="1" fill="${a.zzz}"/>`
    );
  }

  // 2. Wings (raised fluffy cloud wing when working; tucked calm wing when waiting)
  if (!isSleep) {
    parts.push(
      `<rect x="8" y="2" width="3" height="1" fill="${a.wingEdge}"/>`,
      `<rect x="7" y="3" width="5" height="2" fill="${a.wingFill}"/>`,
      `<rect x="8" y="3" width="2" height="1" fill="${a.wingShine}"/>`,
      `<rect x="12" y="3" width="1" height="2" fill="${a.wingEdge}"/>`,
      `<rect x="7" y="5" width="5" height="1" fill="${a.wingEdge}"/>`
    );
  } else {
    parts.push(
      `<rect x="8" y="5" width="4" height="1" fill="${a.wingEdge}" opacity="0.85"/>`,
      `<rect x="9" y="6" width="3" height="1" fill="${a.wingFill}" opacity="0.85"/>`
    );
  }

  // 3. Tiny golden pixel crown for coordinator OR cute antennae for workers
  if (hasCrown) {
    parts.push(
      `<rect x="3" y="4" width="1" height="1" fill="${a.crownBright}"/>`,
      `<rect x="5" y="4" width="1" height="1" fill="${a.crownBright}"/>`,
      `<rect x="7" y="4" width="1" height="1" fill="${a.crownBright}"/>`,
      `<rect x="3" y="5" width="5" height="1" fill="${a.crownBase}"/>`
    );
  } else if (!isSleep) {
    parts.push(
      `<rect x="3" y="4" width="1" height="1" fill="${p.outline}"/>`,
      `<rect x="4" y="5" width="1" height="1" fill="${p.outline}"/>`,
      `<rect x="6" y="5" width="1" height="1" fill="${p.outline}"/>`
    );
  }

  // 4. Rounded left-facing pixel bee body silhouette (x=2..13, y=6..13)
  parts.push(
    `<rect x="4" y="6" width="8" height="1" fill="${p.outline}"/>`,
    `<rect x="3" y="7" width="1" height="1" fill="${p.outline}"/>`,
    `<rect x="12" y="7" width="1" height="1" fill="${p.outline}"/>`,
    `<rect x="2" y="8" width="1" height="3" fill="${p.outline}"/>`,
    `<rect x="13" y="8" width="1" height="3" fill="${p.outline}"/>`,
    // Tiny tail stinger on right
    `<rect x="14" y="9" width="1" height="1" fill="${p.outline}"/>`,
    `<rect x="3" y="11" width="1" height="1" fill="${p.outline}"/>`,
    `<rect x="12" y="11" width="1" height="1" fill="${p.outline}"/>`,
    `<rect x="4" y="12" width="8" height="1" fill="${p.outline}"/>`
  );

  // 5. Shaded colored body fill
  parts.push(
    `<rect x="4" y="7" width="8" height="1" fill="${p.highlight}"/>`,
    `<rect x="3" y="8" width="10" height="3" fill="${p.body}"/>`,
    `<rect x="4" y="11" width="8" height="1" fill="${p.shadow}"/>`
  );

  // 6. Two crisp vertical dark stripes
  parts.push(
    `<rect x="7" y="7" width="2" height="5" fill="${p.stripe}"/>`,
    `<rect x="10" y="7" width="2" height="5" fill="${p.stripe}"/>`
  );

  // 7. Face highlight + eyes (left-facing)
  parts.push(`<rect x="4" y="7" width="2" height="1" fill="${p.highlight}"/>`);
  if (!isSleep) {
    parts.push(
      `<rect x="3" y="9" width="1" height="1" fill="${p.outline}"/>`,
      `<rect x="5" y="9" width="1" height="1" fill="${p.outline}"/>`
    );
  } else {
    parts.push(
      `<rect x="3" y="10" width="2" height="1" fill="${p.outline}"/>`,
      `<rect x="5" y="10" width="1" height="1" fill="${p.outline}"/>`
    );
  }

  // 8. Cute pixel legs
  parts.push(
    `<rect x="5" y="13" width="1" height="1" fill="${p.outline}"/>`,
    `<rect x="9" y="13" width="1" height="1" fill="${p.outline}"/>`,
    `<rect x="11" y="13" width="1" height="1" fill="${p.outline}"/>`,
    '</svg>'
  );

  return parts.join('');
}

function buildBeeHudSvg(dark: boolean): string {
  const p = BEE_COLOR_SPECS.gold;
  const a = getThemeAccents(dark);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BEE_HUD_SIZE}" height="${BEE_HUD_SIZE}" viewBox="0 0 16 16" shape-rendering="crispEdges">` +
    // High-contrast puffy wing optimized for 15-16px HUD capsule button
    `<rect x="7" y="1" width="5" height="3" fill="${a.wingFill}"/>` +
    `<rect x="8" y="1" width="3" height="1" fill="${a.wingShine}"/>` +
    `<rect x="7" y="4" width="5" height="1" fill="${a.wingEdge}"/>` +
    // Bold silhouette
    `<rect x="3" y="5" width="10" height="1" fill="${p.outline}"/>` +
    `<rect x="2" y="6" width="1" height="1" fill="${p.outline}"/>` +
    `<rect x="13" y="6" width="1" height="1" fill="${p.outline}"/>` +
    `<rect x="1" y="7" width="1" height="5" fill="${p.outline}"/>` +
    `<rect x="14" y="7" width="1" height="5" fill="${p.outline}"/>` +
    `<rect x="15" y="9" width="1" height="1" fill="${p.outline}"/>` +
    `<rect x="2" y="12" width="1" height="1" fill="${p.outline}"/>` +
    `<rect x="13" y="12" width="1" height="1" fill="${p.outline}"/>` +
    `<rect x="3" y="13" width="10" height="1" fill="${p.outline}"/>` +
    // Vivid amber fill
    `<rect x="3" y="6" width="10" height="1" fill="${p.highlight}"/>` +
    `<rect x="2" y="7" width="12" height="5" fill="${p.body}"/>` +
    `<rect x="3" y="12" width="10" height="1" fill="${p.shadow}"/>` +
    // Bold vertical stripes
    `<rect x="7" y="6" width="2" height="7" fill="${p.stripe}"/>` +
    `<rect x="10" y="6" width="2" height="7" fill="${p.stripe}"/>` +
    // Crisp left-facing eyes
    `<rect x="3" y="8" width="1" height="2" fill="${p.outline}"/>` +
    `<rect x="5" y="8" width="1" height="2" fill="${p.outline}"/>` +
    '</svg>'
  );
}

/** Default active working pixel bee SVG (warm gold, dark-theme default). */
export const BEE_ACTIVE_SVG_DARK = buildColoredBeeSvg('gold', 'active', true);
export const BEE_ACTIVE_SVG_LIGHT = buildColoredBeeSvg('gold', 'active', false);
export const BEE_ACTIVE_SVG = BEE_ACTIVE_SVG_DARK;

/** Default sleeping/waiting pixel bee SVG with z marker (warm gold, dark-theme default). */
export const BEE_SLEEP_SVG_DARK = buildColoredBeeSvg('gold', 'sleep', true);
export const BEE_SLEEP_SVG_LIGHT = buildColoredBeeSvg('gold', 'sleep', false);
export const BEE_SLEEP_SVG = BEE_SLEEP_SVG_DARK;

/** Compact 16px pixel bee SVG for the HUD capsule button (dark-theme default). */
export const BEE_HUD_SVG_DARK = buildBeeHudSvg(true);
export const BEE_HUD_SVG_LIGHT = buildBeeHudSvg(false);
export const BEE_HUD_SVG = BEE_HUD_SVG_DARK;

// ---------------------------------------------------------------------------
// Tern Surface Stylesheets (strictly Tern CSS allowlist compliant:
// NO url(), NO position: fixed, NO @font-face, NO @import)
// ---------------------------------------------------------------------------

/**
 * Base Tern surface stylesheet installed when the terminal advertises the
 * `styles` capability. Strips the default `.sf-img-frame` border shadow & corner
 * radius on transparent embedded SVG marks and adds native `agy`-style member
 * name colors + clean borderless Roster card styling.
 */
export const WELCOME_LOGO_STYLESHEET = [
  ".sf-image[data-role='omp.welcome.logo'],",
  ".sf-image[data-role='oma.bee.hud'],",
  ".sf-image[data-role='oma.swarm.card.bee'],",
  ".sf-image[data-role='oma.swarm.bee.img'] {",
  '  pointer-events: none;',
  '}',
  ".sf-image[data-role='omp.welcome.logo'] .sf-img-frame {",
  '  border-radius: 0;',
  '  box-shadow: none;',
  '  object-fit: contain;',
  '  pointer-events: none;',
  '}',
  ".sf-chat-spine .sf-image[data-role='omp.welcome.logo'] .sf-img-frame {",
  '  width: 16px;',
  '  height: 15px;',
  '}',
  ".sf-image[data-role='oma.bee.hud'] .sf-img-frame,",
  ".sf-image[data-role='oma.swarm.card.bee'] .sf-img-frame,",
  ".sf-image[data-role='oma.swarm.bee.img'] .sf-img-frame {",
  '  border-radius: 0;',
  '  box-shadow: none;',
  '  object-fit: contain;',
  '  background: transparent;',
  '  pointer-events: none;',
  '}',
  "[data-role='oma.hud.bee.active'] {",
  '  color: #E5B84B;',
  '}',
  // Keep clean breathing room between top-right omp.hud pill and omp.composer.context meter total (e.g. 1M)
  "[data-role='omp.hud'] {",
  '  margin-bottom: 4px;',
  '}',
  // Keep oma's compaction banner, active turn header, and user-expanded turns crisp
  // against Tern's built-in pre-compaction blur filter on siblings before omp.compaction
  ".sf-main[data-surface='omp.session'] [data-role='omp.transcript'] > [data-role='omp.compaction.hidden'],",
  ".sf-main[data-surface='omp.session'] [data-role='omp.transcript'] > [data-role='omp.compaction.hidden'] *,",
  ".sf-main[data-surface='omp.session'] [data-role='omp.transcript'] > :has(~ [data-role='omp.compaction']),",
  ".sf-main[data-surface='omp.session'] [data-role='omp.transcript'] > :has(~ [data-role='omp.compaction']) *,",
  "[data-role='omp.transcript'] > [data-role='omp.compaction.hidden'],",
  "[data-role='omp.transcript'] > :has(~ [data-role='omp.compaction']) {",
  '  filter: none;',
  '}',
  ".sf-main[data-surface='omp.session'] [data-role='omp.transcript'] > [data-role='omp.compaction.hidden'],",
  "[data-role='omp.transcript'] > [data-role='omp.compaction.hidden'] {",
  '  opacity: 1;',
  '}',
  // Mirror semantic tone colors onto icons inside omp.composer.extras segments
  "[data-role='omp.composer.extras'] [data-tone='success'] .sf-ico,",
  "[data-role='omp.composer.extras'] [data-tone='success'] svg {",
  '  color: var(--sf-ok, #4ADE80);',
  '}',
  "[data-role='omp.composer.extras'] [data-tone='warning'] .sf-ico,",
  "[data-role='omp.composer.extras'] [data-tone='warning'] svg {",
  '  color: var(--sf-warn, #F59E0B);',
  '}',
  "[data-role='omp.composer.extras'] [data-tone='info'] .sf-ico,",
  "[data-role='omp.composer.extras'] [data-tone='info'] svg {",
  '  color: var(--sf-info, #38BDF8);',
  '}',
  // Clean borderless airy Roster cards matching native agy Swarm Board
  "[data-role='oma.swarm.roster.card'] {",
  '  border: 1px solid transparent;',
  '  border-radius: 8px;',
  '  padding: 4px 8px;',
  '  min-width: 188px;',
  '  max-width: 240px;',
  '  cursor: pointer;',
  '}',
  "[data-role='oma.swarm.roster.card']:hover {",
  '  background: rgba(148, 163, 184, 0.08);',
  '  border-color: rgba(148, 163, 184, 0.22);',
  '}',
  "[data-role='oma.swarm.roster.card.selected'] {",
  '  border: 1px solid rgba(229, 184, 75, 0.72);',
  '  background: rgba(229, 184, 75, 0.11);',
  '  border-radius: 8px;',
  '  padding: 4px 8px;',
  '  min-width: 188px;',
  '  max-width: 240px;',
  '  cursor: pointer;',
  '}',
  "[data-role='oma.swarm.retired'] {",
  '  opacity: 0.72;',
  '  padding: 2px 4px;',
  '}',
  // Centered Swarm Board dialog matching `omp.overlay.jobs` width (`min(960px, 100%)` with
  // `.sf-overlay.sz-lg[data-role=...] .sf-ov-card` specificity so it overrides Tern's 720px default)
  // and slightly taller height (`min(680px, 76vh)`) with single scrollbar per pane.
  ".sf-overlay.sz-lg[data-role='oma.overlay.swarm'] .sf-ov-card,",
  "[data-role='oma.overlay.swarm'].sf-ov-card,",
  "[data-role='oma.overlay.swarm'] .sf-ov-card {",
  '  width: min(960px, 100%);',
  '  height: min(680px, 76vh);',
  '  max-height: 84vh;',
  '}',
  "[data-role='oma.overlay.swarm'] .sf-ov-body {",
  '  display: flex;',
  '  flex-direction: column;',
  '  flex: 1 1 0px;',
  '  min-height: 0;',
  '  overflow: hidden;',
  '}',
  "[data-role='oma.swarm.body'] {",
  '  display: flex;',
  '  flex-direction: column;',
  '  flex: 1 1 0px;',
  '  min-height: 0;',
  '  overflow: hidden;',
  '}',
  "[data-role='oma.swarm.roster'] {",
  '  flex: none;',
  '  max-height: 36%;',
  '  overflow-y: auto;',
  '  scrollbar-width: thin;',
  '}',
  "[data-role='oma.swarm.split'] {",
  '  display: flex;',
  '  flex-direction: column;',
  '  flex: 1 1 0px;',
  '  min-height: 0;',
  '  overflow: hidden;',
  '}',
  "[data-role='oma.swarm.split'] > .sf-split-box {",
  '  flex: 1 1 0px;',
  '  min-height: 0;',
  '}',
  "[data-role='oma.swarm.split'] .sf-split-body {",
  '  overflow: hidden;',
  '}',
  "[data-role='oma.swarm.posts'],",
  "[data-role='oma.swarm.detail'],",
  "[data-role='oma.swarm.detail.inner'] {",
  '  display: flex;',
  '  flex-direction: column;',
  '  flex: 1 1 0px;',
  '  min-height: 0;',
  '  overflow: hidden;',
  '}',
  "[data-role='oma.swarm.posts'] > .sf-list {",
  '  display: flex;',
  '  flex-direction: column;',
  '  flex: 1 1 0px;',
  '  min-height: 0;',
  '  overflow: hidden;',
  '}',
  "[data-role='oma.swarm.posts'] > .sf-list > .sf-list-scroll {",
  '  flex: 1 1 0px;',
  '  min-height: 0;',
  '  overflow-y: auto;',
  '  overflow-x: hidden;',
  '  scrollbar-width: thin;',
  '}',
  "[data-role='oma.swarm.detail.scroll'] {",
  '  flex: 1 1 0px;',
  '  min-height: 0;',
  '  overflow-y: auto;',
  '  scrollbar-width: thin;',
  '}',
  // Fullscreen `omp.app.git` host overlay so Tern's preloaded `omp-apps.css` fills 100% cleanly
  "[data-role='oma.overlay.git'].sf-ov-card,",
  "[data-role='oma.overlay.git'] .sf-ov-card {",
  '  height: 100%;',
  '}',
  "[data-role='oma.overlay.git'] .sf-ov-body {",
  '  display: flex;',
  '  flex-direction: column;',
  '  flex: 1 1 0px;',
  '  min-height: 0;',
  '  padding: 0;',
  '  overflow: hidden;',
  '}',
  "[data-role='oma.overlay.git'] [data-role='omp.app.git'] {",
  '  flex: 1 1 0px;',
  '  min-height: 0;',
  '}',
  // Flowing multi-layer aurora glow + specular sheen on the Orchestrator mode pill
  '@keyframes oma-orch-glow {',
  '  0%, 100% {',
  '    background-position: 0% 50%;',
  '    border-color: rgba(167, 139, 250, 0.92);',
  '    box-shadow: 0 0 10px rgba(139, 92, 246, 0.55), 0 0 22px rgba(56, 189, 248, 0.24), inset 0 0 8px rgba(196, 181, 253, 0.28);',
  '  }',
  '  33% {',
  '    background-position: 55% 50%;',
  '    border-color: rgba(56, 189, 248, 0.96);',
  '    box-shadow: 0 0 14px rgba(56, 189, 248, 0.65), 0 0 26px rgba(139, 92, 246, 0.30), inset 0 0 10px rgba(125, 211, 252, 0.34);',
  '  }',
  '  66% {',
  '    background-position: 100% 50%;',
  '    border-color: rgba(45, 212, 191, 0.94);',
  '    box-shadow: 0 0 13px rgba(45, 212, 191, 0.58), 0 0 24px rgba(217, 70, 239, 0.28), inset 0 0 9px rgba(153, 246, 228, 0.30);',
  '  }',
  '}',
  '@keyframes oma-orch-sheen {',
  '  0% {',
  '    opacity: 0;',
  '    transform: translateX(-160%) skewX(-24deg);',
  '  }',
  '  16% {',
  '    opacity: 0.92;',
  '  }',
  '  52% {',
  '    opacity: 0.92;',
  '    transform: translateX(340%) skewX(-24deg);',
  '  }',
  '  56%, 100% {',
  '    opacity: 0;',
  '    transform: translateX(340%) skewX(-24deg);',
  '  }',
  '}',
  '@keyframes oma-orch-text {',
  '  0%, 100% {',
  '    color: #DDD6FE;',
  '    filter: drop-shadow(0 0 4px rgba(167, 139, 250, 0.58));',
  '  }',
  '  33% {',
  '    color: #7DD3FC;',
  '    filter: drop-shadow(0 0 6px rgba(56, 189, 248, 0.68));',
  '  }',
  '  66% {',
  '    color: #99F6E4;',
  '    filter: drop-shadow(0 0 5px rgba(45, 212, 191, 0.62));',
  '  }',
  '}',
  '@keyframes oma-orch-planner-pulse {',
  '  0%, 100% {',
  '    border-color: rgba(56, 189, 248, 0.52);',
  '    background-position: 0% 50%;',
  '    box-shadow: 0 0 5px rgba(56, 189, 248, 0.22), inset 0 0 4px rgba(56, 189, 248, 0.10);',
  '  }',
  '  50% {',
  '    border-color: rgba(125, 211, 252, 0.88);',
  '    background-position: 100% 50%;',
  '    box-shadow: 0 0 11px rgba(56, 189, 248, 0.46), inset 0 0 7px rgba(125, 211, 252, 0.22);',
  '  }',
  '}',
  '@keyframes oma-orch-executor-pulse {',
  '  0%, 100% {',
  '    border-color: rgba(45, 212, 191, 0.52);',
  '    background-position: 0% 50%;',
  '    box-shadow: 0 0 5px rgba(45, 212, 191, 0.22), inset 0 0 4px rgba(45, 212, 191, 0.10);',
  '  }',
  '  50% {',
  '    border-color: rgba(94, 234, 212, 0.88);',
  '    background-position: 100% 50%;',
  '    box-shadow: 0 0 11px rgba(45, 212, 191, 0.46), inset 0 0 7px rgba(153, 246, 228, 0.22);',
  '  }',
  '}',
  "[data-role='oma.composer.model.orchestrator'] {",
  '  position: relative;',
  '  overflow: hidden;',
  '  box-sizing: border-box;',
  '  display: inline-flex;',
  '  align-items: center;',
  '  flex: none;',
  '  gap: 4px;',
  '  height: 24px;',
  '  font-size: 11.5px;',
  '  line-height: 1.2;',
  '  border: 1px solid rgba(167, 139, 250, 0.92);',
  '  background: linear-gradient(120deg, rgba(139, 92, 246, 0.30), rgba(56, 189, 248, 0.24), rgba(45, 212, 191, 0.24), rgba(217, 70, 239, 0.28), rgba(139, 92, 246, 0.30));',
  '  background-size: 280% 100%;',
  '  box-shadow: 0 0 10px rgba(139, 92, 246, 0.55), 0 0 22px rgba(56, 189, 248, 0.24), inset 0 0 8px rgba(196, 181, 253, 0.28);',
  '  border-radius: 6px;',
  '  padding: 0 6px 0 8px;',
  '  cursor: pointer;',
  '  transition: border-color 0.16s ease, box-shadow 0.16s ease, color 0.16s ease, opacity 0.16s ease;',
  '  animation: oma-orch-glow 2.8s ease-in-out infinite;',
  '}',
  "[data-role='oma.composer.model.orchestrator']::before {",
  "  content: '';",
  '  position: absolute;',
  '  top: 0;',
  '  left: 10%;',
  '  right: 10%;',
  '  height: 1px;',
  '  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.62), transparent);',
  '  opacity: 0.78;',
  '  pointer-events: none;',
  '  transition: opacity 0.16s ease;',
  '}',
  "[data-role='oma.composer.model.orchestrator']::after {",
  "  content: '';",
  '  position: absolute;',
  '  top: -2px;',
  '  bottom: -2px;',
  '  left: 0;',
  '  width: 44%;',
  '  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.36) 44%, rgba(196, 181, 253, 0.48) 56%, transparent);',
  '  pointer-events: none;',
  '  animation: oma-orch-sheen 2.6s ease-in-out infinite;',
  '}',
  "[data-role='oma.composer.model.orchestrator'][data-mark='working'] {",
  '  animation-duration: 1.4s;',
  '  box-shadow: 0 0 14px rgba(139, 92, 246, 0.70), 0 0 28px rgba(56, 189, 248, 0.38), inset 0 0 11px rgba(221, 214, 254, 0.36);',
  '}',
  "[data-role='oma.composer.model.orchestrator'][data-mark='working']::after {",
  '  animation-duration: 1.35s;',
  '  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.50) 44%, rgba(125, 211, 252, 0.58) 56%, transparent);',
  '}',
  "[data-role='oma.composer.model.orchestrator']:hover {",
  '  animation: none;',
  '  border-color: rgba(221, 214, 254, 0.98);',
  '  background: linear-gradient(120deg, rgba(139, 92, 246, 0.44), rgba(56, 189, 248, 0.36), rgba(45, 212, 191, 0.34), rgba(217, 70, 239, 0.40));',
  '  box-shadow: 0 0 16px rgba(167, 139, 250, 0.72), 0 0 28px rgba(56, 189, 248, 0.36), inset 0 0 11px rgba(255, 255, 255, 0.28);',
  '}',
  "[data-role='oma.composer.model.orchestrator']:hover::before {",
  '  opacity: 1;',
  '}',
  "[data-role='oma.composer.model.orchestrator']:active {",
  '  animation: none;',
  '  box-shadow: 0 0 9px rgba(139, 92, 246, 0.54), inset 0 1px 4px rgba(15, 23, 42, 0.36);',
  '}',
  "[data-role='oma.composer.model.orchestrator.name'] {",
  '  color: #DDD6FE;',
  '  font-weight: 600;',
  '  transition: color 0.16s ease, opacity 0.16s ease;',
  '  animation: oma-orch-text 2.8s ease-in-out infinite;',
  '}',
  "[data-role='oma.composer.model.orchestrator'][data-mark='working'] [data-role='oma.composer.model.orchestrator.name'] {",
  '  animation-duration: 1.4s;',
  '}',
  "[data-role='oma.composer.model.orchestrator']:hover [data-role='oma.composer.model.orchestrator.name'] {",
  '  animation: none;',
  '  color: #F5F3FF;',
  '  filter: drop-shadow(0 0 6px rgba(196, 181, 253, 0.72));',
  '}',
  // Compact Sky-Blue Planner capsule placed right of Orchestrator pill (cascaded wave)
  "[data-role='oma.composer.planner'] {",
  '  position: relative;',
  '  overflow: hidden;',
  '  box-sizing: border-box;',
  '  display: inline-flex;',
  '  align-items: center;',
  '  flex: none;',
  '  gap: 4px;',
  '  height: 24px;',
  '  font-size: 11px;',
  '  line-height: 1.2;',
  '  border: 1px solid rgba(56, 189, 248, 0.54);',
  '  background: linear-gradient(120deg, rgba(56, 189, 248, 0.12), rgba(139, 92, 246, 0.14), rgba(56, 189, 248, 0.12));',
  '  background-size: 220% 100%;',
  '  border-radius: 6px;',
  '  padding: 0 5px 0 7px;',
  '  cursor: pointer;',
  '  transition: border-color 0.16s ease, box-shadow 0.16s ease, color 0.16s ease, opacity 0.16s ease;',
  '  animation: oma-orch-planner-pulse 2.8s ease-in-out 0.45s infinite;',
  '}',
  "[data-role='oma.composer.planner']::after {",
  "  content: '';",
  '  position: absolute;',
  '  top: -2px;',
  '  bottom: -2px;',
  '  left: 0;',
  '  width: 40%;',
  '  background: linear-gradient(90deg, transparent, rgba(125, 211, 252, 0.34) 50%, transparent);',
  '  pointer-events: none;',
  '  animation: oma-orch-sheen 2.6s ease-in-out 0.55s infinite;',
  '}',
  "[data-role='oma.composer.planner'][data-mark='working'] {",
  '  animation-duration: 1.4s;',
  '  animation-delay: 0.22s;',
  '}',
  "[data-role='oma.composer.planner'][data-mark='working']::after {",
  '  animation-duration: 1.35s;',
  '  animation-delay: 0.26s;',
  '}',
  "[data-role='oma.composer.planner']:hover {",
  '  animation: none;',
  '  border-color: rgba(125, 211, 252, 0.96);',
  '  background: linear-gradient(120deg, rgba(56, 189, 248, 0.24), rgba(139, 92, 246, 0.24), rgba(56, 189, 248, 0.24));',
  '  box-shadow: 0 0 12px rgba(56, 189, 248, 0.50), inset 0 0 8px rgba(125, 211, 252, 0.24);',
  '}',
  "[data-role='oma.composer.planner']:active {",
  '  animation: none;',
  '  box-shadow: 0 0 6px rgba(56, 189, 248, 0.36), inset 0 1px 4px rgba(15, 23, 42, 0.32);',
  '}',
  "[data-role='oma.composer.planner.tag'] {",
  '  font-size: 10px;',
  '  color: #38BDF8;',
  '  font-weight: 600;',
  '  opacity: 0.95;',
  '  transition: color 0.16s ease, opacity 0.16s ease;',
  '}',
  "[data-role='oma.composer.planner']:hover [data-role='oma.composer.planner.tag'] {",
  '  color: #7DD3FC;',
  '  opacity: 1;',
  '}',
  // Compact Mint-Green Executor capsule placed right of Planner capsule (cascaded wave)
  "[data-role='oma.composer.executor'] {",
  '  position: relative;',
  '  overflow: hidden;',
  '  box-sizing: border-box;',
  '  display: inline-flex;',
  '  align-items: center;',
  '  flex: none;',
  '  gap: 4px;',
  '  height: 24px;',
  '  font-size: 11px;',
  '  line-height: 1.2;',
  '  border: 1px solid rgba(45, 212, 191, 0.54);',
  '  background: linear-gradient(120deg, rgba(45, 212, 191, 0.12), rgba(56, 189, 248, 0.14), rgba(45, 212, 191, 0.12));',
  '  background-size: 220% 100%;',
  '  border-radius: 6px;',
  '  padding: 0 5px 0 7px;',
  '  cursor: pointer;',
  '  transition: border-color 0.16s ease, box-shadow 0.16s ease, color 0.16s ease, opacity 0.16s ease;',
  '  animation: oma-orch-executor-pulse 2.8s ease-in-out 0.9s infinite;',
  '}',
  "[data-role='oma.composer.executor']::after {",
  "  content: '';",
  '  position: absolute;',
  '  top: -2px;',
  '  bottom: -2px;',
  '  left: 0;',
  '  width: 40%;',
  '  background: linear-gradient(90deg, transparent, rgba(153, 246, 228, 0.34) 50%, transparent);',
  '  pointer-events: none;',
  '  animation: oma-orch-sheen 2.6s ease-in-out 1.1s infinite;',
  '}',
  "[data-role='oma.composer.executor'][data-mark='working'] {",
  '  animation-duration: 1.4s;',
  '  animation-delay: 0.44s;',
  '}',
  "[data-role='oma.composer.executor'][data-mark='working']::after {",
  '  animation-duration: 1.35s;',
  '  animation-delay: 0.52s;',
  '}',
  "[data-role='oma.composer.executor']:hover {",
  '  animation: none;',
  '  border-color: rgba(153, 246, 228, 0.96);',
  '  background: linear-gradient(120deg, rgba(45, 212, 191, 0.24), rgba(56, 189, 248, 0.24), rgba(45, 212, 191, 0.24));',
  '  box-shadow: 0 0 12px rgba(45, 212, 191, 0.50), inset 0 0 8px rgba(153, 246, 228, 0.24);',
  '}',
  "[data-role='oma.composer.executor']:active {",
  '  animation: none;',
  '  box-shadow: 0 0 6px rgba(45, 212, 191, 0.36), inset 0 1px 4px rgba(15, 23, 42, 0.32);',
  '}',
  "[data-role='oma.composer.executor.tag'] {",
  '  font-size: 10px;',
  '  color: #2DD4BF;',
  '  font-weight: 600;',
  '  opacity: 0.95;',
  '  transition: color 0.16s ease, opacity 0.16s ease;',
  '}',
  "[data-role='oma.composer.executor']:hover [data-role='oma.composer.executor.tag'] {",
  '  color: #5EEAD4;',
  '  opacity: 1;',
  '}',
  // Align chevron and effort controls inside Orchestrator capsules with Tern's composer pills
  "[data-role='oma.composer.model.orchestrator'] > .sf-icon:last-child,",
  "[data-role='oma.composer.planner'] > .sf-icon:last-child,",
  "[data-role='oma.composer.executor'] > .sf-icon:last-child {",
  '  width: 12px;',
  '  height: 12px;',
  '  opacity: 0.72;',
  '  transition: opacity 0.16s ease, color 0.16s ease;',
  '}',
  "[data-role='oma.composer.model.orchestrator'] > .sf-icon:last-child .ico,",
  "[data-role='oma.composer.planner'] > .sf-icon:last-child .ico,",
  "[data-role='oma.composer.executor'] > .sf-icon:last-child .ico {",
  '  width: 12px;',
  '  height: 12px;',
  '}',
  "[data-role='oma.composer.model.orchestrator']:hover > .sf-icon:last-child {",
  '  opacity: 1;',
  '  color: #EDE9FE;',
  '}',
  "[data-role='oma.composer.planner']:hover > .sf-icon:last-child {",
  '  opacity: 1;',
  '  color: #BAE6FD;',
  '}',
  "[data-role='oma.composer.executor']:hover > .sf-icon:last-child {",
  '  opacity: 1;',
  '  color: #CCFBF1;',
  '}',
  "[data-role='oma.composer.planner.effort'],",
  "[data-role='oma.composer.executor.effort'] {",
  '  width: 13px;',
  '  height: 13px;',
  '  border-radius: 50%;',
  '  cursor: pointer;',
  '  transition: box-shadow 0.15s ease;',
  '}',
  "[data-role='oma.composer.planner.effort']:hover {",
  '  box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.30);',
  '}',
  "[data-role='oma.composer.executor.effort']:hover {",
  '  box-shadow: 0 0 0 3px rgba(45, 212, 191, 0.30);',
  '}',
  '@media (prefers-reduced-motion: reduce) {',
  "  [data-role='oma.composer.model.orchestrator'],",
  "  [data-role='oma.composer.model.orchestrator']::after,",
  "  [data-role='oma.composer.model.orchestrator.name'],",
  "  [data-role='oma.composer.planner'],",
  "  [data-role='oma.composer.planner']::after,",
  "  [data-role='oma.composer.executor'],",
  "  [data-role='oma.composer.executor']::after {",
  '    animation: none;',
  '  }',
  '}',
  // Swarm Board real-time Overview panel (shown when terminal height >= 28 rows & plan.json present)
  "[data-role='oma.swarm.overview'] {",
  '  flex: none;',
  '  padding: 6px 10px;',
  '  border: 1px solid rgba(99, 130, 255, 0.36);',
  '  background: rgba(99, 130, 255, 0.07);',
  '  border-radius: 8px;',
  '}',
  "[data-role='oma.swarm.overview.threads'] {",
  '  padding-top: 2px;',
  '}',
  "[data-role='oma.swarm.overview.thread'] {",
  '  border: 1px solid rgba(148, 163, 184, 0.28);',
  '  background: rgba(148, 163, 184, 0.08);',
  '  border-radius: 6px;',
  '  padding: 2px 7px;',
  '  cursor: pointer;',
  '}',
  "[data-role='oma.swarm.overview.thread.working'] {",
  '  border: 1px solid rgba(56, 189, 248, 0.55);',
  '  background: rgba(56, 189, 248, 0.11);',
  '  border-radius: 6px;',
  '  padding: 2px 7px;',
  '  cursor: pointer;',
  '}',
  "[data-role='oma.swarm.overview.thread.done'] {",
  '  border: 1px solid rgba(74, 222, 128, 0.48);',
  '  background: rgba(74, 222, 128, 0.09);',
  '  border-radius: 6px;',
  '  padding: 2px 7px;',
  '  cursor: pointer;',
  '}',
  "[data-role='oma.swarm.overview.thread.blocked'] {",
  '  border: 1px solid rgba(251, 113, 133, 0.58);',
  '  background: rgba(251, 113, 133, 0.12);',
  '  border-radius: 6px;',
  '  padding: 2px 7px;',
  '  cursor: pointer;',
  '}',
  // Per-palette member name hues echoing each member's pixel bee sprite
  "[data-role='oma.swarm.name.gold'] { color: #E5B84B; font-weight: 600; }",
  "[data-role='oma.swarm.name.violet'] { color: #D946EF; font-weight: 600; }",
  "[data-role='oma.swarm.name.sky'] { color: #38BDF8; font-weight: 600; }",
  "[data-role='oma.swarm.name.indigo'] { color: #6382FF; font-weight: 600; }",
  "[data-role='oma.swarm.name.orange'] { color: #E5894A; font-weight: 600; }",
  "[data-role='oma.swarm.name.mint'] { color: #2DD4BF; font-weight: 600; }",
  "[data-role='oma.swarm.name.emerald'] { color: #4ADE80; font-weight: 600; }",
  "[data-role='oma.swarm.name.rose'] { color: #FB7185; font-weight: 600; }",
  // `/usage` quota cards polish (strictly Tern allowlist compliant)
  ".sf-overlay.sz-lg[data-role='omp.overlay.usage'] .sf-ov-card,",
  "[data-role='omp.overlay.usage'].sf-ov-card,",
  "[data-role='omp.overlay.usage'] .sf-ov-card {",
  '  width: min(760px, 100%);',
  '}',
  "[data-role='oma.usage.group'] {",
  '  border: 1px solid rgba(148, 163, 184, 0.24);',
  '  background: rgba(148, 163, 184, 0.05);',
  '  border-radius: 10px;',
  '}',
  "[data-role='oma.usage.models'] {",
  '  font-size: 11.5px;',
  '  line-height: 1.4;',
  '  opacity: 0.85;',
  '}',
  "[data-role='oma.usage.bucket'] {",
  '  padding: 6px 8px;',
  '  border-radius: 7px;',
  '  background: rgba(148, 163, 184, 0.05);',
  '}',
  "[data-role='oma.usage.bucket.head'] {",
  '  line-height: 1.25;',
  '}',
  "[data-role='oma.usage.reset'] {",
  '  font-size: 11.5px;',
  '}',
].join('\n');

export interface OrbitBeeSpec {
  readonly isWorking: boolean;
}

/**
 * Dynamically builds the `oma-swarm-fx` stylesheet for the exact number of
 * active swarm bees currently orbiting the composer (`1..MAX_ORBIT_BEES`).
 *
 * Strictly adheres to Tern's CSS security allowlist:
 * - Zero `url(...)`, zero `position: fixed`, zero `@font-face`, zero `@import`.
 * - NEVER animates or overrides `[data-role='omp.editor']` visuals/borders/shadows so typing
 *   remains rock-solid with zero flicker; only enables `overflow: visible` for perimeter bees.
 * - Evenly spaces all `N` bees around the composer perimeter (`delay = -(i / N) * duration`)
 *   and distinguishes `working` (11s brisk orbit) vs `waiting` (20s gentle idle drift).
 * - Automatically pauses animations under `@media (prefers-reduced-motion: reduce)`.
 */
export function buildSwarmBeeEffectCss(bees: readonly OrbitBeeSpec[]): string {
  const count = Math.max(0, Math.min(MAX_ORBIT_BEES, bees.length));
  if (count === 0) return '';

  const beeRoleSelectors: string[] = [];
  const slotRules: string[] = [];
  for (let i = 0; i < count; i++) {
    const idx = i + 1;
    const isWorking = bees[i]?.isWorking ?? false;
    const durationSec = isWorking ? 11 : 20;
    const delaySec = -((i / count) * durationSec);
    const delayFormatted = Number(delaySec.toFixed(2));
    beeRoleSelectors.push(`[data-role='oma.swarm.bee-${idx}']`);
    slotRules.push(
      `.oma-bee-${idx}, [data-role='oma.swarm.bee-${idx}'] {`,
      `  animation-duration: ${durationSec}s;`,
      `  animation-delay: ${delayFormatted}s;`,
      ...(isWorking ? [] : ['  opacity: 0.9;']),
      '}',
    );
  }

  return [
    // Bees are left-facing sprites: scaleX(-1) faces right along top edge, scaleX(1) faces left along bottom edge
    '@keyframes oma-bee-orbit {',
    '  0% {',
    '    left: 2%;',
    '    top: 0%;',
    '    transform: translateY(0px) scaleX(-1) rotate(-3deg);',
    '  }',
    '  12% {',
    '    left: 28%;',
    '    top: 0%;',
    '    transform: translateY(-1.5px) scaleX(-1) rotate(2deg);',
    '  }',
    '  24% {',
    '    left: 56%;',
    '    top: 0%;',
    '    transform: translateY(1.5px) scaleX(-1) rotate(-2deg);',
    '  }',
    '  36% {',
    '    left: 88%;',
    '    top: 0%;',
    '    transform: translateY(-1px) scaleX(-1) rotate(3deg);',
    '  }',
    '  41% {',
    '    left: 100%;',
    '    top: 12%;',
    '    transform: translateX(1.5px) scaleX(-1) rotate(10deg);',
    '  }',
    '  46% {',
    '    left: 100%;',
    '    top: 62%;',
    '    transform: translateX(-1px) scaleX(-1) rotate(5deg);',
    '  }',
    '  50% {',
    '    left: 98%;',
    '    top: 100%;',
    '    transform: translateY(0px) scaleX(1) rotate(-4deg);',
    '  }',
    '  62% {',
    '    left: 72%;',
    '    top: 100%;',
    '    transform: translateY(1.5px) scaleX(1) rotate(2deg);',
    '  }',
    '  74% {',
    '    left: 44%;',
    '    top: 100%;',
    '    transform: translateY(-1.5px) scaleX(1) rotate(-2deg);',
    '  }',
    '  86% {',
    '    left: 12%;',
    '    top: 100%;',
    '    transform: translateY(1.5px) scaleX(1) rotate(3deg);',
    '  }',
    '  91% {',
    '    left: 0%;',
    '    top: 86%;',
    '    transform: translateX(-1.5px) scaleX(1) rotate(-8deg);',
    '  }',
    '  96% {',
    '    left: 0%;',
    '    top: 34%;',
    '    transform: translateX(1px) scaleX(-1) rotate(-5deg);',
    '  }',
    '  100% {',
    '    left: 2%;',
    '    top: 0%;',
    '    transform: translateY(0px) scaleX(-1) rotate(-3deg);',
    '  }',
    '}',
    "[data-role='omp.editor'] {",
    '  overflow: visible;',
    '}',
    ".oma-swarm-fx, [data-role='oma.swarm.fx'] {",
    '  position: absolute;',
    '  top: -1px;',
    '  right: -1px;',
    '  bottom: -1px;',
    '  left: -1px;',
    '  pointer-events: none;',
    '  overflow: visible;',
    '  z-index: 6;',
    '}',
    `.oma-swarm-bee, ${beeRoleSelectors.join(', ')} {`,
    '  position: absolute;',
    '  left: 2%;',
    '  top: 0%;',
    '  width: 16px;',
    '  height: 16px;',
    '  margin-left: -8px;',
    '  margin-top: -8px;',
    '  pointer-events: none;',
    '  animation-name: oma-bee-orbit;',
    '  animation-timing-function: linear;',
    '  animation-iteration-count: infinite;',
    '}',
    ...slotRules,
    '@media (prefers-reduced-motion: reduce) {',
    `  .oma-swarm-bee, ${beeRoleSelectors.join(', ')} {`,
    '    animation: none;',
    '  }',
    '}',
  ].join('\n');
}

/**
 * Default 4-bee swarm perimeter animation stylesheet (kept as a convenience constant).
 */
export const SWARM_BEE_EFFECT_CSS = buildSwarmBeeEffectCss([
  { isWorking: true },
  { isWorking: true },
  { isWorking: true },
  { isWorking: true },
]);

// ---------------------------------------------------------------------------
// Pre-encoded Asset Singletons & Cached Getters
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function makeAsset(svg: string, width: number, height: number): SvgImageAsset {
  return {
    mime: 'image/svg+xml',
    svg,
    bytes: encoder.encode(svg),
    width,
    height,
  };
}

const DARK_ASSET = makeAsset(ANTIGRAVITY_LOGO_SVG_DARK, WELCOME_LOGO_WIDTH, WELCOME_LOGO_HEIGHT);
const LIGHT_ASSET = makeAsset(ANTIGRAVITY_LOGO_SVG_LIGHT, WELCOME_LOGO_WIDTH, WELCOME_LOGO_HEIGHT);

const BEE_ACTIVE_DARK_ASSET = makeAsset(BEE_ACTIVE_SVG_DARK, BEE_CARD_SIZE, BEE_CARD_SIZE);
const BEE_ACTIVE_LIGHT_ASSET = makeAsset(BEE_ACTIVE_SVG_LIGHT, BEE_CARD_SIZE, BEE_CARD_SIZE);

const BEE_SLEEP_DARK_ASSET = makeAsset(BEE_SLEEP_SVG_DARK, BEE_CARD_SIZE, BEE_CARD_SIZE);
const BEE_SLEEP_LIGHT_ASSET = makeAsset(BEE_SLEEP_SVG_LIGHT, BEE_CARD_SIZE, BEE_CARD_SIZE);

const BEE_HUD_DARK_ASSET = makeAsset(BEE_HUD_SVG_DARK, BEE_HUD_SIZE, BEE_HUD_SIZE);
const BEE_HUD_LIGHT_ASSET = makeAsset(BEE_HUD_SVG_LIGHT, BEE_HUD_SIZE, BEE_HUD_SIZE);

const coloredBeeCache = new Map<string, SvgImageAsset>();

/**
 * Returns the cached theme-adapted Google Antigravity A-mark logo asset ready
 * to upload via `session.blob(asset.bytes, asset.mime)`.
 */
export function getAntigravityLogoAsset(dark: boolean): WelcomeLogoAsset {
  return dark ? DARK_ASSET : LIGHT_ASSET;
}

/** Returns the cached theme-adapted default active/working pixel bee SVG asset. */
export function getBeeActiveAsset(dark: boolean): SvgImageAsset {
  return dark ? BEE_ACTIVE_DARK_ASSET : BEE_ACTIVE_LIGHT_ASSET;
}

/** Returns the cached theme-adapted default sleeping/waiting pixel bee SVG asset (with z). */
export function getBeeSleepAsset(dark: boolean): SvgImageAsset {
  return dark ? BEE_SLEEP_DARK_ASSET : BEE_SLEEP_LIGHT_ASSET;
}

/** Returns the cached theme-adapted 16px HUD capsule pixel bee SVG asset. */
export function getBeeHudAsset(dark: boolean): SvgImageAsset {
  return dark ? BEE_HUD_DARK_ASSET : BEE_HUD_LIGHT_ASSET;
}

/**
 * Returns a cached theme-adapted colored pixel bee SVG asset for a specific
 * palette, visual state (`active` | `sleep`), and optional coordinator crown.
 */
export function getColoredBeeAsset(
  paletteId: BeePaletteId,
  visualState: BeeVisualState,
  dark: boolean,
  hasCrown = false
): SvgImageAsset {
  const cacheKey = `${dark ? 'dark' : 'light'}:${getSwarmBeeBlobKey(paletteId, visualState, hasCrown)}`;
  const cached = coloredBeeCache.get(cacheKey);
  if (cached) return cached;
  const svg = buildColoredBeeSvg(paletteId, visualState, dark, {
    size: BEE_CARD_SIZE,
    hasCrown,
  });
  const asset = makeAsset(svg, BEE_CARD_SIZE, BEE_CARD_SIZE);
  coloredBeeCache.set(cacheKey, asset);
  return asset;
}

export interface SwarmBeeAssetBundle {
  readonly active: SvgImageAsset;
  readonly sleep: SvgImageAsset;
  readonly hud: SvgImageAsset;
}

/** Convenience helper returning the 3 core pixel bee SVG assets (active, sleep, hud). */
export function getSwarmBeeAssets(dark: boolean): SwarmBeeAssetBundle {
  return {
    active: getBeeActiveAsset(dark),
    sleep: getBeeSleepAsset(dark),
    hud: getBeeHudAsset(dark),
  };
}

export interface MemberBeeAssetPair {
  readonly paletteId: BeePaletteId;
  readonly hasCrown: boolean;
  readonly active: SvgImageAsset;
  readonly sleep: SvgImageAsset;
}

/**
 * Convenience helper returning the deterministic colored pixel bee asset pair
 * (`active` + `sleep`) for a swarm member name (coordinator gets warm gold + crown).
 */
export function getMemberBeeAssetPair(
  name: string,
  dark: boolean,
  role?: string
): MemberBeeAssetPair {
  const paletteId = getBeePaletteIdForMember(name, role);
  const hasCrown = role === 'coordinator' || name.trim().toLowerCase() === 'coordinator';
  return {
    paletteId,
    hasCrown,
    active: getColoredBeeAsset(paletteId, 'active', dark, hasCrown),
    sleep: getColoredBeeAsset(paletteId, 'sleep', dark, hasCrown),
  };
}

export interface SwarmBeeBlobSpec {
  readonly key: string;
  readonly paletteId: BeePaletteId;
  readonly visualState: BeeVisualState;
  readonly hasCrown: boolean;
  readonly asset: SvgImageAsset;
}

/**
 * Returns the full set of colored pixel bee sprite specs (8 palettes × active/sleep +
 * coordinator crown active/sleep = 18 tiny ~1KB SVGs) so `controller.ts` can upload
 * them once during handshake or lazily on first swarm sight.
 */
export function getAllSwarmBeeBlobSpecs(dark: boolean): readonly SwarmBeeBlobSpec[] {
  const specs: SwarmBeeBlobSpec[] = [];
  for (const paletteId of BEE_PALETTE_IDS) {
    for (const visualState of ['active', 'sleep'] as const) {
      specs.push({
        key: getSwarmBeeBlobKey(paletteId, visualState, false),
        paletteId,
        visualState,
        hasCrown: false,
        asset: getColoredBeeAsset(paletteId, visualState, dark, false),
      });
    }
  }
  for (const visualState of ['active', 'sleep'] as const) {
    specs.push({
      key: getSwarmBeeBlobKey('gold', visualState, true),
      paletteId: 'gold',
      visualState,
      hasCrown: true,
      asset: getColoredBeeAsset('gold', visualState, dark, true),
    });
  }
  return specs;
}
