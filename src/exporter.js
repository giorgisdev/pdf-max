import {
  PDFDocument, PDFName, PDFRawStream, PDFArray, PDFRef,
  decodePDFRawStream, rgb,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { FONTS, styleKey, fetchFontFile } from './fonts.js';
import { stripTextOperators } from './strip.js';

// Resolves and caches embedded PDFFonts for the export document.
class FontPool {
  constructor(doc) {
    this.doc = doc;
    this.cache = new Map();
    this.fallbacks = []; // { requested, used }
  }

  async get(fontId, bold, italic) {
    const entry = FONTS[fontId] || FONTS.helvetica;
    const key = `${fontId}:${styleKey(bold, italic)}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const style = styleKey(bold, italic);
    let font = null;
    let usedDesc = null;

    // Preferred: the real font file for the exact style
    const tryStyles = [style];
    if (style !== 'regular') tryStyles.push('regular');
    for (const s of tryStyles) {
      const bytes = await fetchFontFile(entry.files?.[s]);
      if (bytes) {
        font = await this.doc.embedFont(bytes, { subset: true });
        usedDesc = s === style ? null : `${entry.label} (${s} file, requested ${style})`;
        break;
      }
    }

    // Fallback: pdf-lib standard font (always embeds valid, selectable text)
    if (!font) {
      const stdName = entry.std?.[style] || entry.std?.regular;
      font = await this.doc.embedFont(stdName);
      usedDesc = `standard ${stdName}`;
    }

    if (usedDesc) {
      this.fallbacks.push({ requested: `${entry.label} ${style}`, used: usedDesc });
    }
    this.cache.set(key, font);
    return font;
  }
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#000000');
  const v = parseInt(m ? m[1] : '000000', 16);
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

// Some chars can't be encoded by every font (esp. standard WinAnsi fonts).
// Try as-is, then with common substitutions, then strip unencodable chars.
function drawTextSafe(page, text, opts, font) {
  const attempts = [
    text,
    text
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”‟]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/•/g, '*')
      .replace(/ /g, ' '),
  ];
  for (const t of attempts) {
    try {
      page.drawText(t, opts);
      return t === text;
    } catch { /* try next */ }
  }
  let cleaned = '';
  for (const ch of text) {
    try { font.widthOfTextAtSize(ch, 10); cleaned += ch; } catch { cleaned += '?'; }
  }
  try { page.drawText(cleaned, opts); } catch { /* give up on this run */ }
  return false;
}

function collectContentBytes(doc, page) {
  const contentsRef = page.node.get(PDFName.of('Contents'));
  const resolved = contentsRef instanceof PDFRef ? doc.context.lookup(contentsRef) : contentsRef;
  const streams = [];
  if (resolved instanceof PDFRawStream) {
    streams.push(resolved);
  } else if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i++) {
      const s = doc.context.lookup(resolved.get(i));
      if (s instanceof PDFRawStream) streams.push(s);
    }
  }
  const parts = streams.map((s) => decodePDFRawStream(s).decode());
  let total = 0;
  for (const p of parts) total += p.length + 1;
  const joined = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    joined.set(p, off);
    off += p.length;
    joined[off++] = 0x0a; // streams must be joined with whitespace
  }
  return joined;
}

function replacePageContent(doc, page, newBytes) {
  const stream = doc.context.flateStream(newBytes);
  const ref = doc.context.register(stream);
  page.node.set(PDFName.of('Contents'), ref);
}

/**
 * @param originalBytes  Uint8Array of the loaded PDF
 * @param pagesState     per-page: { items: [...], newBoxes: [...] }
 *   item: { str, x, y (PDF-space baseline), size, fontId, bold, italic,
 *           color, edited, deleted }
 * Returns { bytes, fallbacks, warnings }
 */
export async function exportPdf(originalBytes, pagesState) {
  const doc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
  doc.registerFontkit(fontkit);
  const pool = new FontPool(doc);
  const warnings = [];
  const pages = doc.getPages();

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const state = pagesState[p];
    if (!state) continue;

    const anyEdit = state.items.some((it) => it.edited || it.deleted);

    if (anyEdit) {
      // Strip every original text object, then redraw ALL text (edited and
      // untouched alike) as fresh, selectable text operators.
      try {
        const content = collectContentBytes(doc, page);
        const stripped = stripTextOperators(content);
        replacePageContent(doc, page, stripped);
      } catch (err) {
        warnings.push(`Page ${p + 1}: could not rewrite content stream (${err.message}); edited text drawn on top of original.`);
      }

      for (const it of state.items) {
        if (it.deleted) continue;
        const text = it.str;
        if (!text || !text.trim()) continue;
        const font = await pool.get(it.fontId, it.bold, it.italic);
        const ok = drawTextSafe(page, text, {
          x: it.x, y: it.y, size: it.size, font, color: hexToRgb(it.color),
        }, font);
        if (!ok) warnings.push(`Page ${p + 1}: some characters in "${text.slice(0, 30)}…" were substituted (not supported by the export font).`);
      }
    }

    for (const box of state.newBoxes) {
      if (box.deleted || !box.str || !box.str.trim()) continue;
      const font = await pool.get(box.fontId, box.bold, box.italic);
      const lines = box.str.split('\n');
      lines.forEach((line, li) => {
        if (!line.trim()) return;
        drawTextSafe(page, line, {
          x: box.x, y: box.y - li * box.size * 1.25,
          size: box.size, font, color: hexToRgb(box.color),
        }, font);
      });
    }
  }

  const bytes = await doc.save();
  return { bytes, fallbacks: pool.fallbacks, warnings };
}
