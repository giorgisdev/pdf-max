import { StandardFonts } from 'pdf-lib';

// Font library. `files` point into /public/fonts — drop matching .ttf/.otf files
// there (see public/fonts/README.md). Missing files fall back to the pdf-lib
// standard font in `std`, and the fallback is reported in the UI.
export const FONTS = {
  helvetica: {
    label: 'Arial / Helvetica',
    css: "Arial, Helvetica, sans-serif",
    files: {
      regular: '/fonts/Arial.ttf',
      bold: '/fonts/Arial-Bold.ttf',
      italic: '/fonts/Arial-Italic.ttf',
      boldItalic: '/fonts/Arial-BoldItalic.ttf',
    },
    std: {
      regular: StandardFonts.Helvetica,
      bold: StandardFonts.HelveticaBold,
      italic: StandardFonts.HelveticaOblique,
      boldItalic: StandardFonts.HelveticaBoldOblique,
    },
    match: [/arial/i, /helvetica/i],
  },
  times: {
    label: 'Times New Roman',
    css: "'Times New Roman', 'TNR-local', Times, serif",
    files: {
      regular: '/fonts/TimesNewRoman.ttf',
      bold: '/fonts/TimesNewRoman-Bold.ttf',
      italic: '/fonts/TimesNewRoman-Italic.ttf',
      boldItalic: '/fonts/TimesNewRoman-BoldItalic.ttf',
    },
    std: {
      regular: StandardFonts.TimesRoman,
      bold: StandardFonts.TimesRomanBold,
      italic: StandardFonts.TimesRomanItalic,
      boldItalic: StandardFonts.TimesRomanBoldItalic,
    },
    match: [/times/i, /\btnr\b/i],
  },
  georgia: {
    label: 'Georgia',
    css: "Georgia, 'Times New Roman', serif",
    files: {
      regular: '/fonts/Georgia.ttf',
      bold: '/fonts/Georgia-Bold.ttf',
      italic: '/fonts/Georgia-Italic.ttf',
      boldItalic: '/fonts/Georgia-BoldItalic.ttf',
    },
    std: {
      regular: StandardFonts.TimesRoman,
      bold: StandardFonts.TimesRomanBold,
      italic: StandardFonts.TimesRomanItalic,
      boldItalic: StandardFonts.TimesRomanBoldItalic,
    },
    match: [/georgia/i],
  },
  calibri: {
    label: 'Calibri',
    css: "Calibri, 'Segoe UI', Arial, sans-serif",
    files: {
      regular: '/fonts/Calibri.ttf',
      bold: '/fonts/Calibri-Bold.ttf',
      italic: '/fonts/Calibri-Italic.ttf',
      boldItalic: '/fonts/Calibri-BoldItalic.ttf',
    },
    std: {
      regular: StandardFonts.Helvetica,
      bold: StandardFonts.HelveticaBold,
      italic: StandardFonts.HelveticaOblique,
      boldItalic: StandardFonts.HelveticaBoldOblique,
    },
    match: [/calibri/i],
  },
  garamond: {
    label: 'Garamond',
    css: "Garamond, 'EB Garamond', 'Times New Roman', serif",
    files: {
      regular: '/fonts/Garamond.ttf',
      bold: '/fonts/Garamond-Bold.ttf',
      italic: '/fonts/Garamond-Italic.ttf',
      boldItalic: '/fonts/Garamond-BoldItalic.ttf',
    },
    std: {
      regular: StandardFonts.TimesRoman,
      bold: StandardFonts.TimesRomanBold,
      italic: StandardFonts.TimesRomanItalic,
      boldItalic: StandardFonts.TimesRomanBoldItalic,
    },
    match: [/garamond/i],
  },
  ibarra: {
    label: 'Ibarra Real Nova',
    css: "'Ibarra Real Nova', 'Times New Roman', serif",
    files: {
      regular: '/fonts/IbarraRealNova-Regular.ttf',
      bold: '/fonts/IbarraRealNova-Bold.ttf',
      italic: '/fonts/IbarraRealNova-Italic.ttf',
      boldItalic: '/fonts/IbarraRealNova-BoldItalic.ttf',
    },
    std: {
      regular: StandardFonts.TimesRoman,
      bold: StandardFonts.TimesRomanBold,
      italic: StandardFonts.TimesRomanItalic,
      boldItalic: StandardFonts.TimesRomanBoldItalic,
    },
    match: [/ibarra/i],
  },
  caslon: {
    label: 'Libre Caslon Text',
    css: "'Libre Caslon Text', 'Times New Roman', serif",
    files: {
      regular: '/fonts/LibreCaslonText-Regular.ttf',
      bold: '/fonts/LibreCaslonText-Bold.ttf',
      italic: '/fonts/LibreCaslonText-Italic.ttf',
      boldItalic: null,
    },
    std: {
      regular: StandardFonts.TimesRoman,
      bold: StandardFonts.TimesRomanBold,
      italic: StandardFonts.TimesRomanItalic,
      boldItalic: StandardFonts.TimesRomanBoldItalic,
    },
    match: [/caslon/i],
  },
  symbol: {
    label: 'Symbol',
    css: "Symbol, serif",
    files: { regular: '/fonts/Symbol.ttf' },
    std: { regular: StandardFonts.Symbol },
    match: [/symbol/i],
  },
};

export const DEFAULT_FONT_ID = 'helvetica';

// Strip the "ABCDEF+" subset prefix pdf producers add to embedded font names.
export function cleanFontName(name) {
  return String(name || '').replace(/^[A-Z]{6}\+/, '');
}

// Map an embedded PDF font name to our library + style flags.
export function detectFont(pdfFontName) {
  const raw = cleanFontName(pdfFontName);
  let fontId = null;
  for (const [id, entry] of Object.entries(FONTS)) {
    if (entry.match.some((re) => re.test(raw))) { fontId = id; break; }
  }
  if (!fontId) {
    // Unknown font: guess serif vs sans from common name fragments.
    fontId = /serif|roman|book|caslon|garamond|georgia|minion|palatino|cambria/i.test(raw)
      ? 'times'
      : DEFAULT_FONT_ID;
  }
  const bold = /bold|black|heavy|semib|demib|[-_ ]700|[-_ ]800|[-_ ]900/i.test(raw);
  const italic = /italic|oblique/i.test(raw);
  return { fontId, bold, italic, raw, exact: fontId !== null };
}

export function styleKey(bold, italic) {
  if (bold && italic) return 'boldItalic';
  if (bold) return 'bold';
  if (italic) return 'italic';
  return 'regular';
}

function looksLikeFont(bytes) {
  if (!bytes || bytes.length < 4) return false;
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  return (
    tag === 'OTTO' || tag === 'true' || tag === 'ttcf' || tag === 'wOFF' ||
    (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)
  );
}

const fileCache = new Map(); // url -> Uint8Array | null

// Fetch a font file from /public/fonts; returns null if missing/invalid.
export async function fetchFontFile(url) {
  if (!url) return null;
  if (fileCache.has(url)) return fileCache.get(url);
  let result = null;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (looksLikeFont(bytes)) result = bytes;
    }
  } catch { /* missing file */ }
  fileCache.set(url, result);
  return result;
}

// Which real font files are present on disk, per font id.
export async function checkFontAvailability() {
  const availability = {};
  await Promise.all(Object.entries(FONTS).map(async ([id, entry]) => {
    const styles = {};
    await Promise.all(Object.entries(entry.files).map(async ([style, url]) => {
      styles[style] = url ? (await fetchFontFile(url)) !== null : false;
    }));
    availability[id] = styles;
  }));
  return availability;
}
