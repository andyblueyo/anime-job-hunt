// The halftone design system, as CSS strings. One source for the lock
// overlay (injected into its shadow root) and the popup (injected into
// <head>), so tokens, keyframes, and the dot-field technique can't drift
// between the two surfaces. Design source: design/Next_Ep_Lock_Soft_dc.html.
//
// Nothing here is an image: the tone blooms, paper grain, and sparkles are
// all radial-gradient dot fields, mask-images, and clip-paths, which is why
// the restyle adds a font file and roughly zero asset weight.

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

/**
 * Font family names as registered by `fontFaceCss()`. Prefixed so a host
 * page's own `Archivo` @font-face (plausible on a job board) can't shadow
 * ours inside the overlay.
 */
export const FONT_MONO = "'NEL VCR OSD Mono'";
export const FONT_DISPLAY = "'NEL Archivo Black'";
export const FONT_BODY = "'NEL Archivo'";

export const FONT_MONO_STACK = `${FONT_MONO}, ui-monospace, "Courier New", monospace`;
export const FONT_DISPLAY_STACK = `${FONT_DISPLAY}, Impact, "Arial Black", sans-serif`;
export const FONT_BODY_STACK = `${FONT_BODY}, Arial, Helvetica, sans-serif`;

/**
 * @font-face rules pointing at the bundled TTFs through
 * chrome.runtime.getURL(), so they resolve to chrome-extension:// URLs and
 * never touch the network (a remote font from a content script is a CSP
 * violation on most pages and a Chrome Web Store review flag).
 *
 * IMPORTANT: this must be appended to the LIGHT DOM (document.head), not the
 * shadow root. Chrome ignores @font-face declared inside a shadow tree; the
 * families are then usable from shadow styles by name.
 *
 * VCR OSD Mono is a single weight (family VCRosdNEUE, subfamily Medium). We
 * register it at 400 only and set `font-synthesis: none` wherever it's used,
 * so a stray `font-weight: 700` can't smear a fake bold over the pixels.
 */
export function fontFaceCss(): string {
  const url = (file: string) => chrome.runtime.getURL(`fonts/${file}`);
  return `
    @font-face {
      font-family: ${FONT_MONO};
      src: url("${url("VCROSDMono.ttf")}") format("truetype");
      font-weight: 400;
      font-style: normal;
      font-display: block;
    }
    @font-face {
      font-family: ${FONT_DISPLAY};
      src: url("${url("ArchivoBlack-Regular.ttf")}") format("truetype");
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: ${FONT_BODY};
      src: url("${url("Archivo-Regular.ttf")}") format("truetype");
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: ${FONT_BODY};
      src: url("${url("Archivo-Italic.ttf")}") format("truetype");
      font-weight: 400;
      font-style: italic;
      font-display: swap;
    }
  `;
}

const FONT_FACE_STYLE_ID = "next-ep-lock-fonts";

/** Idempotently installs the @font-face rules in the current document's <head>. */
export function ensureFontFaces(doc: Document = document): void {
  if (doc.getElementById(FONT_FACE_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = FONT_FACE_STYLE_ID;
  style.textContent = fontFaceCss();
  (doc.head ?? doc.documentElement).appendChild(style);
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Custom-property declarations, to be placed inside whatever selector roots the surface. */
export const TOKEN_DECLARATIONS = `
  --tone: 6px;
  --spot: #B3122B;
  --line: rgba(26, 26, 24, 0.82);
  --line-soft: rgba(26, 26, 24, 0.34);
  --ink: #1A1A18;
  --ink-2: #141412;
  --paper: #F7F5EF;
  --paper-2: #F2EFE8;
  --paper-3: #EDEAE2;
  --shell: #E8E4DB;
  --muted: #6B6760;
  --muted-2: #9C988F;
  --muted-3: #B9B5AD;
  --font-mono: ${FONT_MONO_STACK};
  --font-display: ${FONT_DISPLAY_STACK};
  --font-body: ${FONT_BODY_STACK};
`;

// ---------------------------------------------------------------------------
// Sparkles
// ---------------------------------------------------------------------------

/** Four-point sparkle. Tighter waist percentages give longer spikes. */
export const SPARKLE_4 =
  "polygon(50% 0, 55% 45%, 100% 50%, 55% 55%, 50% 100%, 45% 55%, 0 50%, 45% 45%)";

/** Five-point star with a slight waist, from the export's --s5. */
export const SPARKLE_5 =
  "polygon(50.0% 0.0%,54.6% 35.7%,55.9% 41.9%,62.1% 41.2%,97.6% 34.5%,65.0% 50.0%,59.5% 53.1%,62.1% 58.8%,79.4% 90.5%,54.6% 64.3%,50.0% 60.0%,45.4% 64.3%,20.6% 90.5%,37.9% 58.8%,40.5% 53.1%,35.0% 50.0%,2.4% 34.5%,37.9% 41.2%,44.1% 41.9%,45.4% 35.7%)";

// ---------------------------------------------------------------------------
// Keyframes + shared technique classes
// ---------------------------------------------------------------------------

/**
 * Keyframes and the reusable dot-field classes. Class names are prefixed
 * `nel-` so they can't collide with a host page's classes even outside a
 * shadow root (the popup is its own document, but the prefix keeps the two
 * surfaces grep-able together).
 */
export const TECHNIQUE_CSS = `
  @keyframes nel-twk {
    0%, 100% { transform: scale(1) rotate(0deg); opacity: 0.9; }
    50% { transform: scale(0.5) rotate(24deg); opacity: 0.28; }
  }
  @keyframes nel-drift {
    0% { transform: translate3d(0, 0, 0); }
    100% { transform: translate3d(-1.6%, -2.2%, 0); }
  }
  @keyframes nel-bloom {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 0.9; }
  }
  @keyframes nel-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  /* Layer 1: a dot field masked into soft blooms. The stepped alpha stops in
     the mask are what make the dots thin out instead of cutting off; each
     surface supplies its own --nel-mask (comma-separated radial gradients). */
  .nel-tone {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image: radial-gradient(circle, var(--nel-dot, var(--paper)) 1.5px, transparent 1.9px);
    background-size: var(--tone) var(--tone);
    filter: blur(0.4px);
    mask-image: var(--nel-mask);
    -webkit-mask-image: var(--nel-mask);
    animation: nel-drift 30s ease-in-out infinite alternate;
  }
  .nel-tone.nel-tone-dark {
    --nel-dot: var(--ink);
    opacity: 0.34;
  }

  /* Soft light wash behind the dots on dark panels. */
  .nel-wash {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: radial-gradient(ellipse 60% 55% at 34% 34%, rgba(247, 245, 239, 0.1), transparent 72%);
    animation: nel-bloom 11s ease-in-out infinite;
  }

  /* Layer 2: paper grain, a finer field over everything. */
  .nel-grain {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image: radial-gradient(circle, var(--ink) 0.5px, transparent 0.8px);
    background-size: 3px 3px;
    opacity: 0.09;
  }
  .nel-grain.nel-grain-light {
    background-image: radial-gradient(circle, var(--paper) 0.5px, transparent 0.8px);
    opacity: 0.1;
  }

  /* Layer 3: sparkles. Positioned per surface; never over text. */
  .nel-sparkle {
    position: absolute;
    pointer-events: none;
    background: var(--paper);
    clip-path: ${SPARKLE_4};
    animation: nel-twk 5s ease-in-out infinite;
  }
  .nel-sparkle.nel-sparkle-5 { clip-path: ${SPARKLE_5}; }
  .nel-sparkle.nel-sparkle-spot { background: var(--spot); }

  /* Segmented progress row. Filled slots solid; the current slot blinks. */
  .nel-slots { display: flex; gap: 7px; }
  .nel-slot {
    position: relative;
    overflow: hidden;
    flex: 1;
    border: 1px solid var(--nel-slot-line, var(--line));
  }
  .nel-slot[data-on="true"]::before {
    content: "";
    position: absolute;
    inset: 0;
    background: var(--nel-slot-fill, var(--ink));
  }
  .nel-slot[data-cur="true"]::before {
    content: "";
    position: absolute;
    inset: 2px;
    background: var(--spot);
    animation: nel-blink 2.4s ease-in-out infinite;
  }

  /* Placeholder marker: appended to anything with no backend behind it yet.
     Remove the data-demo attribute and the tag disappears — no other change. */
  [data-demo]::after {
    content: "DEMO";
    display: inline-block;
    margin-left: 8px;
    vertical-align: middle;
    font: 400 10px/1 var(--font-mono);
    font-synthesis: none;
    letter-spacing: 0.12em;
    color: var(--muted-2);
  }

  @media (prefers-reduced-motion: reduce) {
    .nel-tone, .nel-wash, .nel-sparkle, .nel-slot[data-cur="true"]::before {
      animation: none !important;
    }
  }
`;
