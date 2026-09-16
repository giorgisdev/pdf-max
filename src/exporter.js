import {
  PDFDocument, PDFName, PDFRawStream, PDFArray, PDFRef, PDFString,
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

// Some chars can't be encoded by every font (esp. custom embedded resume
// fonts, which often lack a bullet glyph). pdf-lib doesn't reliably throw for
// this: a custom (fontkit) font commonly substitutes a silent .notdef glyph
// instead of raising, so the exception-based fallback below never triggers
// and a bullet bakes in as a broken glyph that PDF viewers show as "?". Try
// the plain-ASCII substitution FIRST, since it's safe in every font, rather
// than trusting a successful draw of the original as proof it rendered right.
function drawTextSafe(page, text, opts, font) {
  const substituted = text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/•/g, '*')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');
  const attempts = [substituted, text];
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

// URLs and emails worth making clickable in a resume: explicit http(s),
// www.-prefixed, emails, or bare domains like linkedin.com/in/name.
const LINK_RE = /(https?:\/\/[^\s|•]+|www\.[^\s|•]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|me|co|ca|ai|app|sh|gg|xyz|edu)(?:\/[^\s|•]*)?)/gi;

function findLinks(str) {
  const out = [];
  for (const m of str.matchAll(LINK_RE)) {
    let text = m[0].replace(/[.,;:)\]}>'"]+$/, ''); // trailing punctuation isn't part of the link
    if (!text) continue;
    let uri;
    if (/^[\w.+-]+@/.test(text) && !/^https?:\/\//i.test(text)) uri = `mailto:${text}`;
    else if (/^https?:\/\//i.test(text)) uri = text;
    else uri = `https://${text}`;
    out.push({ start: m.index, end: m.index + text.length, uri });
  }
  return out;
}

function widthOf(font, text, size, fullStr, fullWidth) {
  try {
    return font.widthOfTextAtSize(text, size);
  } catch {
    // Unencodable chars: fall back to a proportional share of the run's width.
    return fullStr.length ? (text.length / fullStr.length) * fullWidth : 0;
  }
}

function addLinkAnnotation(doc, page, rect, uri) {
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: rect,
    Border: [0, 0, 0], // no visible border — text looks unchanged
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(uri) },
  });
  const ref = doc.context.register(annot);
  const existing = page.node.lookup(PDFName.of('Annots'));
  if (existing instanceof PDFArray) {
    existing.push(ref);
  } else {
    page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
  }
}

// Add invisible link annotations over every URL/email in a text run.
// `estWidth` is the best known rendered width of the full run (for fallback).
async function linkifyRun(doc, page, pool, run, str, x, y, estWidth) {
  const links = findLinks(str);
  if (!links.length) return 0;
  const font = await pool.get(run.fontId, run.bold, run.italic);
  const size = run.size;
  let added = 0;
  for (const { start, end, uri } of links) {
    const xStart = x + widthOf(font, str.slice(0, start), size, str, estWidth);
    const w = widthOf(font, str.slice(start, end), size, str, estWidth);
    if (w <= 0) continue;
    // y is the text baseline; pad down to the descender and up past the ascender.
    addLinkAnnotation(doc, page, [xStart, y - size * 0.25, xStart + w, y + size * 0.95], uri);
    added++;
  }
  return added;
}

// Greedy word-wrap a single paragraph (no literal newlines) to fit maxWidth,
// measured with the actual export font/size — mirrors the editor's live
// wrapping closely enough that resizing the box on screen matches export.
function wrapText(font, text, size, maxWidth) {
  if (!maxWidth || maxWidth <= 0) return [text];
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    let w;
    try { w = font.widthOfTextAtSize(candidate, size); } catch { w = 0; }
    if (w > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines;
}

// A new text box's raw '\n'-separated paragraphs, each word-wrapped to the
// box's width.
function wrapBoxLines(font, box) {
  const lines = [];
  for (const para of box.str.split('\n')) {
    if (!para.trim()) { lines.push(''); continue; }
    lines.push(...wrapText(font, para, box.size, box.width));
  }
  return lines;
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
 * @param options        { linkify, pageOrder } — linkify adds invisible
 *   clickable link annotations over any URLs/emails found in the text (no
 *   visual change). pageOrder, if given, is the final list of original
 *   (0-based) page indices to keep, in the desired output order — pages
 *   omitted are deleted, and the rest are reordered to match.
 * Returns { bytes, fallbacks, warnings, linkCount }
 */
export async function exportPdf(originalBytes, pagesState, options = {}) {
  const { linkify = false, pageOrder = null } = options;
  const doc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
  doc.registerFontkit(fontkit);
  const pool = new FontPool(doc);
  const warnings = [];
  let linkCount = 0;
  const pages = doc.getPages();

  for (let p = 0; p < pages.length; p++) {
    if (pageOrder && !pageOrder.includes(p)) continue; // deleted page — skip entirely
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
      const lines = wrapBoxLines(font, box);
      lines.forEach((line, li) => {
        if (!line.trim()) return;
        drawTextSafe(page, line, {
          x: box.x, y: box.y - li * box.size * 1.25,
          size: box.size, font, color: hexToRgb(box.color),
        }, font);
      });
    }

    if (linkify) {
      for (const it of state.items) {
        if (it.deleted || !it.str) continue;
        linkCount += await linkifyRun(doc, page, pool, it, it.str, it.x, it.y, it.width || 0);
      }
      for (const box of state.newBoxes) {
        if (box.deleted || !box.str) continue;
        const font = await pool.get(box.fontId, box.bold, box.italic);
        const lines = wrapBoxLines(font, box);
        for (let li = 0; li < lines.length; li++) {
          if (!lines[li].trim()) continue;
          linkCount += await linkifyRun(doc, page, pool, box, lines[li], box.x, box.y - li * box.size * 1.25, box.width || 0);
        }
      }
    }
  }

  if (pageOrder) {
    // Detach every page from the tree, then reattach the kept ones in the
    // requested order — reordering/deleting doesn't touch page content or
    // annotations, since it's the same PDFPage objects moving, not copies.
    for (let i = pages.length - 1; i >= 0; i--) doc.removePage(i);
    pageOrder.forEach((origIdx, i) => doc.insertPage(i, pages[origIdx]));
  }

  const bytes = await doc.save();
  return { bytes, fallbacks: pool.fallbacks, warnings, linkCount };
}
