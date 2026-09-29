/*
 * motion-promo starter config. Edit this file only; never the page.
 * Everything in [square brackets] is a placeholder and blocks a final render until replaced.
 * Image paths are relative to THIS file. Full field reference: references/scenes.md.
 *
 * Claims: stat, quote and cta.offer need a `source`. Any text written as
 * { text: '...', source: '...' } is also listed as a claim to verify.
 * No numbers, ratings, reviews or offers here on purpose: add them only from the real page.
 */
window.PROMO_CONFIG = {
  format: '4:5', // '4:5' 1080x1350 | '9:16' 1080x1920 | '1:1' 1080x1080 | '16:9' 1920x1080
  topic: 'launch', // used in the output file name: <brand>-<topic>-<format>-vN.mp4
  fps: 30,

  brand: {
    name: '[Brand]',
    logo: null, // e.g. 'assets/logo.svg' (for light backgrounds)
    logoOnDark: null, // optional; otherwise the logo is recoloured white on dark surfaces
    url: '[yourdomain.com]',
  },

  colors: {
    background: '#F5F2EC',
    text: '#15151A',
    accent: '#3355FF',
  },

  font: {
    family: 'Inter',
    url: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=block',
    // offline machines: files: [{ src: 'fonts/Inter-Variable.woff2', weight: '100 900' }]
    weights: { body: 400, strong: 600, headline: 700 },
  },

  // safeZone: { top: 260, bottom: 420, left: 120, right: 120 }, // px; defaults per format

  scenes: [
    {
      type: 'title',
      duration: 2.2,
      kicker: '[Product name]',
      headline: '[Say the *one thing* it does]',
      subline: '[One sentence on who it is for and why it matters]',
    },
    {
      type: 'device',
      duration: 3.0,
      transition: 'slide',
      frame: 'phone', // phone | browser | laptop
      caption: '[What this screen shows]',
      image: null, // e.g. 'assets/app-screen.png' — tall screenshots scroll
      tap: { x: 585, y: 1650 }, // in screenshot pixels
    },
    {
      type: 'compare',
      duration: 2.8,
      transition: 'wipe',
      headline: '[From *input* to result]',
      from: null,
      to: null,
      // fromLabel: 'Input', toLabel: 'Output'  (neutral defaults; see SKILL.md policy)
    },
    {
      type: 'mosaic',
      duration: 2.0,
      transition: 'fade',
      headline: '[Made with it]',
      images: [], // 1+ real images; they repeat to fill the grid
    },
    {
      type: 'features',
      duration: 2.4,
      transition: { type: 'slide', direction: 'up' },
      headline: '[Why it is *better*]',
      items: ['[First benefit]', '[Second benefit]', '[Third benefit]'],
    },
    {
      type: 'cta',
      duration: 2.6,
      transition: 'iris',
      headline: '[Start *today*.]',
      button: '[Button label]',
      // offer: { text: '...', source: '...' }  — only a real, current offer
    },
  ],
};
