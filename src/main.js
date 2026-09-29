import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  FONTS, DEFAULT_FONT_ID, detectFont, cleanFontName, checkFontAvailability, styleKey,
} from './fonts.js';
import { exportPdf, preflightExport } from './exporter.js';
import { saveDraft, loadDraft, listDrafts, deleteDraft } from './draft.js';
import { extractLines } from './lines.js';
import { inject } from '@vercel/analytics';


pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

inject();

// ---------- state ----------

const state = {
  fileName: null,
  renamed: false,       // true once the user has renamed the document
  docId: null,          // autosave record key for the open document
  thumb: null,          // small page-1 preview stored with the draft
  pdfBytes: null,       // Uint8Array of the loaded file
  pdfDoc: null,         // pdf.js document
  pages: [],            // per page: { viewport, scale, items, newBoxes }
  fontAvailability: {},
  detectedFonts: new Map(), // raw embedded name -> {fontId, bold, italic, count}
  selected: null,       // currently selected item object
  addTextMode: false,
  nextId: 1,
  zoomIdx: 1,           // index into ZOOM_LEVELS; 1 = fit-width
  clipboard: null,      // copied item snapshot for paste/duplicate
  pasteCount: 0,
  pageOrder: [],         // original (0-based) page indices, in current display/export order
  selectedPages: new Set(), // original page indices selected in the pages panel
  formatPainter: null,   // { fontId, size, bold, italic, color, sticky } while active
  multiSelected: new Set(), // items rectangle-selected together (across items/newBoxes)
};
let lastClickedPage = null; // shift-click range anchor for the pages panel

const $ = (id) => document.getElementById(id);
const els = {
  startPage: $('start-page'), recentGrid: $('recent-grid'), recentEmpty: $('recent-empty'),
  btnHome: $('btn-home'), docName: $('doc-name'), startOpen: $('start-open'), pages: $('pages'), fileInput: $('file-input'),
  btnOpen: $('btn-open'), btnAddText: $('btn-add-text'), btnExport: $('btn-export'),
  controls: $('text-controls'), ctlFont: $('ctl-font'), ctlSize: $('ctl-size'),
  ctlBold: $('ctl-bold'), ctlItalic: $('ctl-italic'), ctlColor: $('ctl-color'),
  ctlAlignLeft: $('ctl-align-left'), ctlAlignCenter: $('ctl-align-center'), ctlAlignRight: $('ctl-align-right'),
  ctlDelete: $('ctl-delete'), fontReport: $('font-report'), statusBar: $('status-bar'),
  multiSelectLabel: $('multi-select-label'),
  btnUndo: $('btn-undo'), btnRedo: $('btn-redo'),
  btnZoomIn: $('btn-zoom-in'), btnZoomOut: $('btn-zoom-out'), zoomLabel: $('zoom-label'),
  ctlDuplicate: $('ctl-duplicate'), ctlAlignEdges: $('ctl-align-edges'), ctlMerge: $('ctl-merge'), ctlLinks: $('ctl-links'), ctlFormatPainter: $('ctl-format-painter'),
  pagesGrid: $('pages-grid'), pagesPanelHint: $('pages-panel-hint'), btnDeletePages: $('btn-delete-pages'),
  confirmModal: $('confirm-modal'), confirmText: $('confirm-modal-text'),
  confirmCancel: $('confirm-cancel'), confirmOk: $('confirm-ok'),
  preflightModal: $('preflight-modal'), preflightList: $('preflight-list'),
  preflightCancel: $('preflight-cancel'), preflightOk: $('preflight-ok'),
  autosaveIndicator: $('autosave-indicator'),
};

// ---------- helpers ----------

function status(msg, isError = false) {
  els.statusBar.textContent = msg;
  els.statusBar.classList.toggle('error', isError);
  if (msg) setTimeout(() => { if (els.statusBar.textContent === msg) els.statusBar.textContent = ''; }, 6000);
}

function cssFontFor(item) {
  return FONTS[item.fontId]?.css || FONTS[DEFAULT_FONT_ID].css;
}

// ---------- file loading ----------

async function loadFile(file) {
  if (!file || !/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    status('Please choose a PDF file.', true);
    return;
  }
  status(`Loading ${file.name}…`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  resetDocument();
  state.fileName = file.name;
  syncDocName();
  state.pdfBytes = bytes;
  state.docId = crypto.randomUUID();

  try {
    // pdf.js transfers the buffer to its worker, so hand it a copy.
    state.pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  } catch (err) {
    status(`Could not open PDF: ${err.message}`, true);
    return;
  }

  hideStartPage();
  for (let p = 1; p <= state.pdfDoc.numPages; p++) {
    await renderPage(p);
  }
  attachThumb();
  els.btnExport.disabled = false;
  els.btnAddText.disabled = false;
  els.btnZoomIn.disabled = state.zoomIdx === ZOOM_LEVELS.length - 1;
  els.btnZoomOut.disabled = state.zoomIdx === 0;
  renderFontReport();
  status(`Loaded ${file.name} — click any text to edit it.`);
}

// ---------- text extraction ----------

const BULLET_START = /^\s*(?:[•▪◦●·*\-–—]|\d{1,2}[.)])\s/;
const CONTINUATION_START = /^[a-z0-9(\[,;.)&]/;

// Join lines that were only split by word-wrap back into one paragraph item,
// so editing a wrapped bullet reflows instead of leaving stray half-boxes.
// Two stacked lines (same font/size, normal leading) belong together when the
// lower one doesn't start a new bullet, sits under the upper one's left edge
// (or, for a bullet, at its hanging indent), and reads as a continuation: it
// starts lowercase/with a digit, continues a bullet, or the upper line ran
// full-width. `lines` must be sorted top-to-bottom (as extractItems sorts).
function groupParagraphs(lines, pageWidth) {
  const rights = lines.filter((l) => l.width > pageWidth * 0.45).map((l) => l.x + l.width).sort((a, b) => a - b);
  const margin = rights.length ? rights[Math.floor((rights.length - 1) * 0.75)] : null;
  const next = new Map();
  const hasPrev = new Set();
  const bulletChain = new Set(); // lines belonging to a chain that started with a bullet

  for (const a of lines) {
    const aHead = !hasPrev.has(a);
    if (aHead && BULLET_START.test(a.str)) bulletChain.add(a);
    let best = null;
    let bestHanging = false;
    for (const b of lines) {
      if (b === a || hasPrev.has(b)) continue;
      const gap = a.y - b.y;
      if (gap < a.size * 0.95 || gap > a.size * 1.75) continue;
      if (b.fontRaw !== a.fontRaw || Math.abs(b.size - a.size) > 0.5) continue;
      if (BULLET_START.test(b.str)) continue;
      const dx = b.x - a.x;
      const aligned = Math.abs(dx) <= a.size * 0.6;
      const hanging = aHead && bulletChain.has(a) && dx > a.size * 0.3 && dx < a.size * 4;
      if (!aligned && !hanging) continue;
      if (!best || gap < a.y - best.y) { best = b; bestHanging = hanging && !aligned; }
    }
    if (!best) continue;
    const right = a.x + a.width;
    const firstWord = best.str.trim().split(/\s+/)[0];
    const wordW = best.width * (firstWord.length / Math.max(best.str.length, 1));
    const limit = margin ?? Math.max(right, best.x + best.width);
    const full = right >= limit - wordW - a.size * 0.6;
    if (!(bestHanging || bulletChain.has(a) || CONTINUATION_START.test(best.str.trim()) || full)) continue;
    next.set(a, best);
    hasPrev.add(best);
    if (bulletChain.has(a)) bulletChain.add(best);
  }

  const out = [];
  for (const line of lines) {
    if (hasPrev.has(line)) continue;
    if (!next.has(line)) { out.push(line); continue; }
    const chain = [line];
    while (next.has(chain[chain.length - 1])) chain.push(next.get(chain[chain.length - 1]));
    const leading = (line.y - chain[chain.length - 1].y) / (chain.length - 1);
    const indent = chain[1].x - line.x > line.size * 0.3 ? chain[1].x - line.x : 0;
    out.push({
      ...line,
      str: chain.map((c, i) => (i && !chain[i - 1].str.endsWith('-') ? ' ' : '') + c.str.trim()).join(''),
      width: Math.max(...chain.map((c) => c.x + c.width)) - line.x,
      para: {
        lines: chain.map((c) => c.str.trim()),
        leading,
        indent,
        height: (chain.length - 1) * leading + line.size * 1.25,
      },
    });
  }
  return out;
}

// Pull positioned text runs out of a pdf.js page and merge fragments that sit
// on the same baseline with the same font into editable line segments.
async function extractItems(page) {
  const textContent = await page.getTextContent();
  const raw = [];

  for (const item of textContent.items) {
    if (!item.str) continue;
    const t = item.transform; // [a b c d e f] in PDF user space
    const size = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 10;
    let fontRaw = item.fontName;
    try {
      const fontObj = page.commonObjs.get(item.fontName);
      if (fontObj?.name) fontRaw = fontObj.name;
    } catch { /* font obj not resolved yet; keep internal name */ }
    raw.push({
      str: item.str,
      x: t[4], y: t[5],
      size, width: item.width || 0,
      fontRaw,
    });
  }

  // Merge adjacent runs on the same baseline & font (pdf producers split lines
  // into many fragments; editing whole segments feels like Sejda).
  raw.sort((a, b) => (Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x));
  const merged = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (
      last &&
      Math.abs(last.y - r.y) < 1.5 &&
      last.fontRaw === r.fontRaw &&
      Math.abs(last.size - r.size) < 0.5 &&
      r.x - (last.x + last.width) < r.size * 0.9 &&
      r.x - (last.x + last.width) > -2
    ) {
      const gap = r.x - (last.x + last.width);
      const needsSpace = gap > r.size * 0.18 && !last.str.endsWith(' ') && !r.str.startsWith(' ');
      last.str += (needsSpace ? ' ' : '') + r.str;
      last.width = r.x + r.width - last.x;
    } else if (r.str.trim() || r.width > 0) {
      merged.push({ ...r });
    }
  }

  const pageWidth = page.getViewport({ scale: 1 }).width;
  return groupParagraphs(merged.filter((m) => m.str.trim().length > 0), pageWidth)
    .map((m) => {
      const det = detectFont(m.fontRaw);
      const rec = state.detectedFonts.get(cleanFontName(m.fontRaw)) || { ...det, count: 0 };
      rec.count++;
      state.detectedFonts.set(cleanFontName(m.fontRaw), rec);
      return {
        id: state.nextId++,
        str: m.str, original: m.str,
        x: m.x, y: m.y, ox: m.x, oy: m.y, osize: m.size, owidth: m.width,
        size: m.size, width: m.para ? m.width + m.size * 0.4 : m.width,
        ...(m.para ? {
          para: true, leading: m.para.leading, plines: m.para.lines,
          oheight: m.para.height, indent: m.para.indent, owrap: m.width + m.size * 0.4,
        } : {}),
        fontId: det.fontId, bold: det.bold, italic: det.italic,
        fontRaw: cleanFontName(m.fontRaw),
        color: '#000000', align: 'left',
        edited: false, deleted: false, isNew: false,
      };
    });
}

// ---------- rendering ----------

// Zoom: 100% / fit-width (default, ≈140% for letter) / 150%
const ZOOM_LEVELS = [
  { key: '100', label: '100%' },
  { key: 'fit', label: 'Fit' },
  { key: '150', label: '150%' },
];

function scaleFor(pageState) {
  const level = ZOOM_LEVELS[state.zoomIdx].key;
  if (level === 'fit') return Math.min(880 / pageState.baseWidth, 1.6);
  return Number(level) / 100;
}

// (Re-)render one page's canvas at the current zoom level.
async function applyViewport(pageState) {
  const scale = scaleFor(pageState);
  const viewport = pageState.page.getViewport({ scale });
  pageState.scale = scale;
  pageState.viewport = viewport;
  const dpr = window.devicePixelRatio || 1;
  const { wrap, canvas } = pageState;

  wrap.style.width = `${viewport.width}px`;
  wrap.style.height = `${viewport.height}px`;
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  pageState.renderTask?.cancel();
  pageState.renderTask = pageState.page.render({
    canvasContext: canvas.getContext('2d'),
    viewport: pageState.page.getViewport({ scale: scale * dpr }),
  });
  try { await pageState.renderTask.promise; } catch { /* cancelled by a newer zoom */ }
}

async function setZoom(idx) {
  const clamped = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx));
  if (clamped === state.zoomIdx || !state.pdfDoc) return;
  if (state.selected) commitEdit(state.selected);
  state.zoomIdx = clamped;
  els.zoomLabel.textContent = ZOOM_LEVELS[clamped].label;
  els.btnZoomOut.disabled = clamped === 0;
  els.btnZoomIn.disabled = clamped === ZOOM_LEVELS.length - 1;
  for (const ps of state.pages) {
    await applyViewport(ps);
    for (const item of [...ps.items, ...ps.newBoxes]) {
      positionEl(ps, item, item.el);
      if (item.maskEl) positionMask(item);
    }
  }
  updateHandle();
}

async function renderPage(pageNum) {
  const page = await state.pdfDoc.getPage(pageNum);

  const wrap = document.createElement('div');
  wrap.className = 'page';
  const canvas = document.createElement('canvas');
  wrap.appendChild(canvas);
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  wrap.appendChild(overlay);
  els.pages.appendChild(wrap);

  const pageState = {
    page, wrap, canvas, overlay, pageNum,
    baseWidth: page.getViewport({ scale: 1 }).width,
    viewport: null, scale: null,
    items: [], newBoxes: [], lines: [],
  };
  state.pages[pageNum - 1] = pageState;

  await applyViewport(pageState);
  pageState.items = await extractItems(page);
  for (const item of pageState.items) mountItem(pageState, item);
  try {
    const detected = await extractLines(page);
    pageState.lines = detected.map((ln) => ({
      id: state.nextId++,
      x: ln.x, y: ln.y, ox: ln.x, oy: ln.y,
      width: ln.width, height: ln.height, owidth: ln.width, oheight: ln.height,
      color: ln.color, deleted: false, isLine: true,
    }));
    for (const line of pageState.lines) mountLine(pageState, line);
  } catch (err) {
    console.warn('Could not detect decorative lines on this page', err);
  }

  overlay.addEventListener('mousedown', (e) => {
    if (e.target !== overlay) return;
    if (state.formatPainter) {
      stopFormatPainter();
    } else if (state.addTextMode) {
      e.preventDefault();
      addTextBoxAt(pageState, e);
    } else {
      e.preventDefault();
      startMarqueeSelect(pageState, e);
    }
  });

  state.pageOrder.push(pageNum - 1);
  await mountPageThumb(pageState);
}

// ---------- pages panel (thumbnails, reorder, delete) ----------

async function mountPageThumb(pageState) {
  const origIdx = pageState.pageNum - 1;
  const thumb = document.createElement('div');
  thumb.className = 'page-thumb';
  thumb.draggable = true;
  thumb.dataset.idx = String(origIdx);

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'page-thumb-canvas';
  thumb.appendChild(canvasWrap);

  const label = document.createElement('div');
  label.className = 'page-thumb-label';
  label.textContent = String(state.pageOrder.indexOf(origIdx) + 1);
  thumb.appendChild(label);

  els.pagesGrid.appendChild(thumb);
  pageState.thumbEl = thumb;
  pageState.thumbLabelEl = label;

  const THUMB_W = 168;
  const scale = THUMB_W / pageState.baseWidth;
  const dpr = window.devicePixelRatio || 1;
  const viewport = pageState.page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  canvasWrap.appendChild(canvas);
  try {
    await pageState.page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: pageState.page.getViewport({ scale: scale * dpr }),
    }).promise;
  } catch { /* ignore — thumbnail is non-critical */ }

  thumb.addEventListener('click', (e) => onThumbClick(origIdx, e));
  thumb.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(origIdx));
    e.dataTransfer.effectAllowed = 'move';
    thumb.classList.add('dragging');
  });
  thumb.addEventListener('dragend', () => thumb.classList.remove('dragging'));
  thumb.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    thumb.classList.add('drag-over');
  });
  thumb.addEventListener('dragleave', () => thumb.classList.remove('drag-over'));
  thumb.addEventListener('drop', (e) => {
    e.preventDefault();
    thumb.classList.remove('drag-over');
    const fromIdx = Number(e.dataTransfer.getData('text/plain'));
    reorderPage(fromIdx, origIdx);
  });
}

function onThumbClick(origIdx, e) {
  if (e.shiftKey && lastClickedPage != null) {
    const order = state.pageOrder;
    const a = order.indexOf(lastClickedPage);
    const b = order.indexOf(origIdx);
    if (a !== -1 && b !== -1) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) state.selectedPages.add(order[i]);
    }
  } else if (e.metaKey || e.ctrlKey) {
    if (state.selectedPages.has(origIdx)) state.selectedPages.delete(origIdx);
    else state.selectedPages.add(origIdx);
  } else {
    state.selectedPages.clear();
    state.selectedPages.add(origIdx);
    state.pages[origIdx]?.wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  lastClickedPage = origIdx;
  refreshPageSelectionUI();
}

function refreshPageSelectionUI() {
  for (const ps of state.pages) {
    ps?.thumbEl?.classList.toggle('selected', state.selectedPages.has(ps.pageNum - 1));
  }
  els.btnDeletePages.disabled = state.selectedPages.size === 0;
}

// Move `fromIdx` to just before `toIdx` in the display/export order, then
// re-sync the DOM (both the main workspace and the thumbnail grid) to match.
function reorderPage(fromIdx, toIdx) {
  if (Number.isNaN(fromIdx) || fromIdx === toIdx) return;
  const order = state.pageOrder;
  const fromPos = order.indexOf(fromIdx);
  if (fromPos === -1) return;
  order.splice(fromPos, 1);
  const toPos = order.indexOf(toIdx);
  order.splice(toPos === -1 ? order.length : toPos, 0, fromIdx);
  applyPageOrder();
  markDirty();
}

// Reflect state.pageOrder in the DOM: reorders both the editable page
// stack and the thumbnail grid, and renumbers the thumbnail labels.
function applyPageOrder() {
  state.pageOrder.forEach((origIdx, i) => {
    const ps = state.pages[origIdx];
    if (!ps) return;
    els.pages.appendChild(ps.wrap);
    els.pagesGrid.appendChild(ps.thumbEl);
    if (ps.thumbLabelEl) ps.thumbLabelEl.textContent = String(i + 1);
  });
}

function deleteSelectedPages() {
  const toDelete = [...state.selectedPages];
  if (!toDelete.length) return;
  if (toDelete.length >= state.pageOrder.length) {
    status("Can't delete every page — at least one page must remain.", true);
    return;
  }
  const n = toDelete.length;
  openConfirmModal(`Delete ${n} page${n > 1 ? 's' : ''}? This can't be undone.`, () => {
    for (const origIdx of toDelete) {
      const ps = state.pages[origIdx];
      if (!ps) continue;
      if (state.selected?.pageState === ps) selectItem(null);
      ps.wrap.remove();
      ps.thumbEl?.remove();
      const pos = state.pageOrder.indexOf(origIdx);
      if (pos !== -1) state.pageOrder.splice(pos, 1);
    }
    state.selectedPages.clear();
    applyPageOrder();
    refreshPageSelectionUI();
    markDirty();
    status(`Deleted ${n} page${n > 1 ? 's' : ''}.`);
  });
}

// ---------- confirm modal ----------

let confirmCallback = null;

function openConfirmModal(message, onConfirm) {
  els.confirmText.textContent = message;
  confirmCallback = onConfirm;
  els.confirmModal.hidden = false;
}

function closeConfirmModal() {
  els.confirmModal.hidden = true;
  confirmCallback = null;
}

// ---------- autosave / draft restore ----------

const ITEM_FIELDS = [
  'id', 'str', 'original', 'x', 'y', 'ox', 'oy', 'osize', 'owidth', 'size', 'width',
  'fontId', 'bold', 'italic', 'color', 'align', 'edited', 'deleted', 'isNew', 'fontRaw',
  'height', 'oheight', 'isLine', 'para', 'leading', 'plines', 'owrap', 'indent',
];

function serializeItem(it) {
  const out = {};
  for (const k of ITEM_FIELDS) if (k in it) out[k] = it[k];
  return out;
}

function buildDraftSnapshot() {
  return {
    docId: state.docId,
    fileName: state.fileName,
    renamed: state.renamed,
    pdfBytes: state.pdfBytes,
    thumb: state.thumb,
    pageOrder: state.pageOrder.slice(),
    pages: state.pages.map((ps) => ({
      items: ps.items.map(serializeItem),
      newBoxes: ps.newBoxes.map(serializeItem),
      lines: ps.lines.map(serializeItem),
    })),
    savedAt: Date.now(),
  };
}

// Render page 1 to a small JPEG for the start page card. Saved with the draft
// (a newly opened file shows up in Recent right away, even before any edit).
async function attachThumb() {
  const docId = state.docId;
  try {
    const page = await state.pdfDoc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 320 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    if (state.docId !== docId) return;
    state.thumb = canvas.toDataURL('image/jpeg', 0.7);
  } catch (err) {
    console.warn('Could not build thumbnail', err);
  }
  if (state.docId === docId) markDirty();
}

let autosaveDirty = false;

function markDirty() { autosaveDirty = true; }

async function flushAutosave() {
  if (!autosaveDirty || !state.pdfBytes) return;
  autosaveDirty = false;
  try {
    els.autosaveIndicator.textContent = 'Saving…';
    await saveDraft(buildDraftSnapshot());
    els.autosaveIndicator.textContent = 'Saved';
    clearTimeout(flushAutosave._fadeTimer);
    flushAutosave._fadeTimer = setTimeout(() => { els.autosaveIndicator.textContent = ''; }, 2500);
  } catch (err) {
    console.warn('Autosave failed', err);
    els.autosaveIndicator.textContent = '';
  }
}

setInterval(flushAutosave, 2000);
window.addEventListener('beforeunload', () => {
  if (state.selected) commitEdit(state.selected);
  flushAutosave();
});

// Clear all per-document state and the page DOM (used before opening a
// file, restoring a draft, or going back to the start page).
function resetDocument() {
  state.fileName = null;
  state.renamed = false;
  syncDocName();
  state.docId = null;
  state.thumb = null;
  state.pdfBytes = null;
  state.pdfDoc = null;
  state.pages = [];
  state.detectedFonts = new Map();
  state.selected = null;
  history.undo.length = 0;
  history.redo.length = 0;
  updateUndoButtons();
  state.clipboard = null;
  stopFormatPainter();
  state.multiSelected.clear();
  state.pageOrder = [];
  state.selectedPages.clear();
  lastClickedPage = null;
  els.pages.innerHTML = '';
  els.pagesGrid.innerHTML = '';
  els.btnDeletePages.disabled = true;
  els.btnExport.disabled = true;
  els.btnAddText.disabled = true;
  els.btnZoomIn.disabled = true;
  els.btnZoomOut.disabled = true;
  els.fontReport.hidden = true;
}

// ---------- rename ----------

function syncDocName() {
  els.docName.value = state.fileName ? state.fileName.replace(/\.pdf$/i, '') : '';
}

function commitRename() {
  const name = els.docName.value.replace(/[\\/:*?"<>|]/g, '').trim();
  if (!state.fileName || !name) { syncDocName(); return; }
  const fileName = `${name}.pdf`;
  if (fileName !== state.fileName) {
    state.fileName = fileName;
    state.renamed = true;
    markDirty();
  }
  syncDocName();
}

// ---------- start page ----------

function hideStartPage() {
  els.startPage.classList.add('hidden');
  $('toolbar').classList.remove('hidden');
  els.pagesPanelHint.hidden = true;
}

async function showStartPage() {
  els.startPage.classList.remove('hidden');
  $('toolbar').classList.add('hidden');
  els.pagesPanelHint.hidden = false;
  status('');
  await renderRecent();
}

async function renderRecent() {
  let drafts = [];
  try { drafts = await listDrafts(); } catch (err) { console.warn('Could not list drafts', err); }
  els.recentGrid.innerHTML = '';
  els.recentEmpty.hidden = drafts.length > 0;
  for (const d of drafts) {
    const item = document.createElement('div');
    item.className = 'recent-item';

    const card = document.createElement('button');
    card.className = 'start-card';
    const thumb = document.createElement('span');
    thumb.className = 'start-thumb';
    if (d.thumb) {
      const img = document.createElement('img');
      img.src = d.thumb;
      img.alt = '';
      thumb.appendChild(img);
    }
    const name = document.createElement('span');
    name.className = 'start-name';
    name.textContent = d.fileName;
    name.title = d.fileName;
    const meta = document.createElement('span');
    meta.className = 'start-meta';
    meta.textContent = `Edited ${new Date(d.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    card.append(thumb, name, meta);
    card.addEventListener('click', () => restoreDraft(d));

    const del = document.createElement('button');
    del.className = 'recent-delete';
    del.textContent = '✕';
    del.title = 'Remove from recent documents';
    del.addEventListener('click', () => {
      openConfirmModal(`Remove "${d.fileName}" and its autosaved edits?`, async () => {
        await deleteDraft(d.docId).catch((err) => console.warn('Could not delete draft', err));
        renderRecent();
      });
    });

    item.append(card, del);
    els.recentGrid.appendChild(item);
  }
}

async function goHome() {
  if (!state.pdfBytes) return;
  if (state.selected) commitEdit(state.selected);
  markDirty();
  await flushAutosave();
  resetDocument();
  await showStartPage();
}

async function restoreDraft(summary) {
  // Cards carry the whole record already, but reload in case it changed.
  const draft = await loadDraft(summary.docId) || summary;
  status(`Restoring ${draft.fileName}…`);
  const bytes = draft.pdfBytes instanceof Uint8Array ? draft.pdfBytes : new Uint8Array(draft.pdfBytes);
  resetDocument();
  state.fileName = draft.fileName;
  state.renamed = !!draft.renamed;
  syncDocName();
  state.pdfBytes = bytes;
  state.docId = draft.docId;
  state.thumb = draft.thumb || null;

  try {
    state.pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  } catch (err) {
    status(`Could not restore draft: ${err.message}`, true);
    resetDocument();
    showStartPage();
    return;
  }

  hideStartPage();
  for (let p = 1; p <= state.pdfDoc.numPages; p++) {
    await renderPage(p);
  }

  // Overlay the saved edits onto the freshly extracted (unedited) items.
  let maxId = state.nextId;
  state.pages.forEach((ps, idx) => {
    const saved = draft.pages?.[idx];
    if (!saved) return;
    if (saved.items?.length === ps.items.length) {
      ps.items.forEach((item, i) => {
        Object.assign(item, saved.items[i]);
        maxId = Math.max(maxId, item.id + 1);
        positionEl(ps, item, item.el);
        refreshItemView(item);
      });
    }
    for (const nb of saved.newBoxes || []) {
      const item = { ...nb };
      maxId = Math.max(maxId, item.id + 1);
      ps.newBoxes.push(item);
      mountItem(ps, item);
    }
    if (saved.lines?.length === ps.lines.length) {
      ps.lines.forEach((line, i) => {
        Object.assign(line, saved.lines[i]);
        maxId = Math.max(maxId, line.id + 1);
        refreshLineView(line);
      });
    }
  });
  state.nextId = maxId;

  state.pageOrder = Array.isArray(draft.pageOrder) && draft.pageOrder.length === state.pages.length
    ? draft.pageOrder.slice()
    : state.pages.map((_, i) => i);
  applyPageOrder();

  els.btnExport.disabled = false;
  els.btnAddText.disabled = false;
  els.btnZoomIn.disabled = state.zoomIdx === ZOOM_LEVELS.length - 1;
  els.btnZoomOut.disabled = state.zoomIdx === 0;
  renderFontReport();
  status(`Restored ${draft.fileName} — click any text to edit it.`);
}

// Position an item's editable div over its rendered text.
function positionEl(pageState, item, el) {
  const [vx, vy] = pageState.viewport.convertToViewportPoint(item.x, item.y);
  const fontPx = item.size * pageState.scale;
  el.style.left = `${vx}px`;
  el.style.top = `${vy - fontPx * 0.88}px`;
  el.style.fontSize = `${fontPx}px`;
  if (item.isNew) {
    // A real box with a set width, so long text wraps inside it instead of
    // running off in one line — resizable via the width handle.
    el.style.width = `${Math.max(item.width * pageState.scale, fontPx * 2)}px`;
    el.style.minWidth = '';
  } else {
    el.style.minWidth = `${Math.max(item.width * pageState.scale, fontPx)}px`;
    el.style.width = '';
  }
  el.style.minHeight = `${fontPx * 1.1}px`;
  el.classList.toggle('para-box', !!item.para);
  el.style.paddingLeft = '';
  el.style.textIndent = '';
  if (item.para) {
    // Wrapped paragraph: fixed width, original line spacing, and tall enough
    // to cover every original line so shrinking the text can't reveal them.
    const lead = item.leading * pageState.scale;
    el.style.width = `${item.width * pageState.scale}px`;
    el.style.minWidth = '';
    el.style.lineHeight = `${lead}px`;
    el.style.minHeight = `${item.oheight * pageState.scale}px`;
    el.style.top = `${vy - fontPx * 0.88 - (lead - fontPx * 1.1) / 2}px`;
    if (item.indent) {
      // Hanging indent: first line flush, wrapped lines pushed in.
      el.style.paddingLeft = `${item.indent * pageState.scale}px`;
      el.style.textIndent = `${-item.indent * pageState.scale}px`;
    }
  }
  el.style.fontFamily = cssFontFor(item);
  el.style.fontWeight = item.bold ? '700' : '400';
  el.style.fontStyle = item.italic ? 'italic' : 'normal';
  el.style.color = item.color;
  el.style.textAlign = item.align || 'left';
}

function mountItem(pageState, item) {
  const el = document.createElement('div');
  el.className = 'text-item' + (item.isNew ? ' new-box' : '') + (item.para ? ' para-box' : '');
  el.dataset.id = item.id;
  positionEl(pageState, item, el);
  pageState.overlay.appendChild(el);
  item.el = el;
  item.pageState = pageState;

  // Mousedown starts a potential drag; a "click" (no real movement) edits.
  el.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    if (item.deleted) return; // ghost mask over old canvas text — inert
    if (state.formatPainter) {
      e.preventDefault();
      applyFormatPainter(item);
      return;
    }
    if (state.addTextMode) return;
    if (el.classList.contains('editing')) return; // let text selection work

    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      if (state.selected) { commitEdit(state.selected); selectItem(null); }
      toggleMultiSelection(item);
      return;
    }
    if (state.multiSelected.has(item)) {
      // Part of an active group selection — drag moves the whole group.
      e.preventDefault();
      startGroupDrag(e);
      return;
    }
    if (state.multiSelected.size) clearMultiSelection();

    e.preventDefault();
    if (state.selected && state.selected !== item) commitEdit(state.selected);
    selectItem(item);
    startDragMove(item, e);
  });
  refreshItemView(item);
}

// ---------- decorative lines (section-divider rules) ----------

function positionLineEl(pageState, line, el) {
  const { viewport, scale } = pageState;
  const [vx1, vy1] = viewport.convertToViewportPoint(line.x, line.y + line.height);
  const [vx2] = viewport.convertToViewportPoint(line.x + line.width, line.y);
  el.style.left = `${vx1}px`;
  el.style.top = `${vy1}px`;
  el.style.width = `${Math.max(vx2 - vx1, 1)}px`;
  el.style.height = `${Math.max(line.height * scale, 1)}px`;
  // The canvas already renders the line at its ORIGINAL spot — painting our
  // own bar there too would just double up. Only materialize a visible bar
  // once it's diverged from that (moved to a new spot); deleted has nothing
  // to show at all (the old spot gets a white mask instead, like text).
  const moved = line.x !== line.ox || line.y !== line.oy;
  el.style.background = (!line.deleted && moved) ? line.color : 'transparent';
}

function ensureLineMask(line) {
  const moved = line.x !== line.ox || line.y !== line.oy;
  if (!line.deleted && !moved) {
    line.maskEl?.remove();
    line.maskEl = null;
    return;
  }
  if (!line.maskEl) {
    line.maskEl = document.createElement('div');
    line.maskEl.className = 'text-mask';
    line.pageState.overlay.prepend(line.maskEl);
  }
  const { viewport, scale } = line.pageState;
  const [vx, vy] = viewport.convertToViewportPoint(line.ox, line.oy + line.oheight);
  line.maskEl.style.left = `${vx - 1}px`;
  line.maskEl.style.top = `${vy - 1}px`;
  line.maskEl.style.width = `${line.owidth * scale + 2}px`;
  line.maskEl.style.height = `${Math.max(line.oheight * scale, 1) + 2}px`;
}

function refreshLineView(line) {
  positionLineEl(line.pageState, line, line.el);
  line.el.classList.toggle('deleted', line.deleted);
  ensureLineMask(line);
}

function mountLine(pageState, line) {
  const el = document.createElement('div');
  el.className = 'line-item';
  el.dataset.id = line.id;
  positionLineEl(pageState, line, el);
  pageState.overlay.appendChild(el);
  line.el = el;
  line.pageState = pageState;

  el.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    if (line.deleted) return;
    if (state.addTextMode || state.formatPainter) return;

    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      if (state.selected) { commitEdit(state.selected); selectItem(null); }
      toggleMultiSelection(line);
      return;
    }
    if (state.multiSelected.has(line)) {
      e.preventDefault();
      startGroupDrag(e);
      return;
    }
    if (state.multiSelected.size) clearMultiSelection();

    e.preventDefault();
    if (state.selected) commitEdit(state.selected);
    selectItem(line);
    startDragMove(line, e);
  });
}

// ---------- undo / redo ----------

const history = { undo: [], redo: [] };
const SNAP_PROPS = ['str', 'x', 'y', 'size', 'width', 'fontId', 'bold', 'italic', 'color', 'align', 'edited', 'deleted', 'para', 'leading', 'oheight', 'indent'];

function snapshot(item) {
  const s = {};
  for (const k of SNAP_PROPS) s[k] = item[k];
  return s;
}

function sameSnapshot(a, b) {
  return SNAP_PROPS.every((k) => a[k] === b[k]);
}

// Record a completed mutation of `item`; `before` was captured pre-mutation.
// kind 'nudge' coalesces rapid consecutive entries on the same item into one.
let historyBatch = null; // while set, pushHistory collects entries into one undo step

function pushHistory(item, before, kind) {
  const after = snapshot(item);
  if (sameSnapshot(before, after)) return;
  if (historyBatch) { historyBatch.push({ item, before, after }); return; }
  const top = history.undo[history.undo.length - 1];
  if (kind === 'nudge' && top?.kind === 'nudge' && top.item === item && Date.now() - top.at < 900) {
    top.after = after;
    top.at = Date.now();
  } else {
    history.undo.push({ item, before, after, kind, at: Date.now() });
  }
  history.redo.length = 0;
  updateUndoButtons();
  markDirty();
}

// Run fn, then record everything it pushed as a single undo step.
function inHistoryBatch(fn) {
  historyBatch = [];
  try { fn(); } finally {
    const batch = historyBatch;
    historyBatch = null;
    if (batch.length) {
      history.undo.push({ batch, at: Date.now() });
      history.redo.length = 0;
      updateUndoButtons();
      markDirty();
    }
  }
}

function restore(item, snap) {
  Object.assign(item, snap);
  if (item.isLine) refreshLineView(item);
  else { positionEl(item.pageState, item, item.el); refreshItemView(item); }
  if (state.selected === item && !item.deleted) selectItem(item); // sync toolbar
  else if (state.selected === item) selectItem(null);
  updateHandle();
  markDirty();
}

function undo() {
  const entry = history.undo.pop();
  if (!entry) return;
  if (entry.batch) for (const e of entry.batch) restore(e.item, e.before);
  else restore(entry.item, entry.before);
  history.redo.push(entry);
  updateUndoButtons();
}

function redo() {
  const entry = history.redo.pop();
  if (!entry) return;
  if (entry.batch) for (const e of entry.batch) restore(e.item, e.after);
  else restore(entry.item, entry.after);
  history.undo.push(entry);
  updateUndoButtons();
}

function updateUndoButtons() {
  els.btnUndo.disabled = history.undo.length === 0;
  els.btnRedo.disabled = history.redo.length === 0;
}

// ---------- move & resize ----------

const SNAP_PX = 6;

// All alignment lines (in overlay CSS px) a dragged box can snap to:
// other items' outer edges and center lines, plus the page's center lines.
function collectSnapTargets(pageState, exclude) {
  const v = [], h = [];
  for (const it of [...pageState.items, ...pageState.newBoxes, ...pageState.lines]) {
    if (it === exclude || it.deleted || !it.el) continue;
    const l = it.el.offsetLeft, t = it.el.offsetTop;
    const w = it.el.offsetWidth, hh = it.el.offsetHeight;
    v.push(l, l + w / 2, l + w);
    h.push(t, t + hh / 2, t + hh);
  }
  v.push(pageState.viewport.width / 2);
  h.push(pageState.viewport.height / 2);
  return { v, h };
}

// Best snap for a box edge/center set against target lines.
// Returns { delta, guide } or null.
function findSnap(pos, extent, targets) {
  let best = null;
  for (const anchor of [0, extent / 2, extent]) {
    for (const target of targets) {
      const diff = target - (pos + anchor);
      if (Math.abs(diff) <= SNAP_PX && (!best || Math.abs(diff) < Math.abs(best.delta))) {
        best = { delta: diff, guide: target };
      }
    }
  }
  return best;
}

function showGuide(pageState, axis, coord) {
  const key = axis === 'v' ? 'vGuideEl' : 'hGuideEl';
  if (!pageState[key]) {
    pageState[key] = document.createElement('div');
    pageState[key].className = `snap-guide ${axis === 'v' ? 'vertical' : 'horizontal'}`;
    pageState.overlay.appendChild(pageState[key]);
  }
  const g = pageState[key];
  if (coord == null) { g.style.display = 'none'; return; }
  g.style.display = 'block';
  g.style[axis === 'v' ? 'left' : 'top'] = `${coord}px`;
}

function hideGuides(pageState) {
  showGuide(pageState, 'v', null);
  showGuide(pageState, 'h', null);
}

function startDragMove(item, e) {
  const { scale } = item.pageState;
  const startX = e.clientX, startY = e.clientY;
  const origX = item.x, origY = item.y;
  const startLeft = item.el.offsetLeft, startTop = item.el.offsetTop;
  const before = snapshot(item);
  let targets = null; // collected lazily once a real drag starts
  let dragging = false;

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!dragging && Math.hypot(dx, dy) < 4) return;
    if (!dragging) targets = collectSnapTargets(item.pageState, item);
    dragging = true;
    item.el.classList.add('dragging');

    let left = startLeft + dx;
    let top = startTop + dy;

    if (ev.altKey) {
      hideGuides(item.pageState);
    } else {
      const w = item.el.offsetWidth, h = item.el.offsetHeight;
      const snapV = findSnap(left, w, targets.v);
      const snapH = findSnap(top, h, targets.h);
      if (snapV) left += snapV.delta;
      if (snapH) top += snapH.delta;
      showGuide(item.pageState, 'v', snapV ? snapV.guide : null);
      showGuide(item.pageState, 'h', snapH ? snapH.guide : null);
    }

    item.x = origX + (left - startLeft) / scale;
    item.y = origY - (top - startTop) / scale; // PDF y-axis points up
    if (item.isLine) positionLineEl(item.pageState, item, item.el);
    else positionEl(item.pageState, item, item.el);
    updateHandle();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    item.el.classList.remove('dragging');
    hideGuides(item.pageState);
    if (dragging) {
      if (item.isLine) refreshLineView(item);
      else {
        if (!item.isNew) item.edited = true;
        refreshItemView(item);
      }
      updateHandle();
      pushHistory(item, before);
    } else if (!item.isLine) {
      beginEdit(item);
    }
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Drag every multi-selected item together, keeping their relative layout.
function startGroupDrag(e) {
  const members = [...state.multiSelected].filter((it) => !it.deleted);
  const startX = e.clientX, startY = e.clientY;
  const starts = members.map((it) => ({ it, x: it.x, y: it.y, before: snapshot(it) }));
  let dragging = false;

  const place = (it) => {
    if (it.isLine) positionLineEl(it.pageState, it, it.el);
    else positionEl(it.pageState, it, it.el);
  };
  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!dragging && Math.hypot(dx, dy) < 4) return;
    dragging = true;
    for (const s of starts) {
      const { scale } = s.it.pageState;
      s.it.x = s.x + dx / scale;
      s.it.y = s.y - dy / scale; // PDF y-axis points up
      place(s.it);
    }
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!dragging) return;
    inHistoryBatch(() => {
      for (const s of starts) {
        if (s.it.isLine) refreshLineView(s.it);
        else {
          if (!s.it.isNew) s.it.edited = true;
          refreshItemView(s.it);
        }
        pushHistory(s.it, s.before);
      }
    });
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startResize(item, e) {
  e.stopPropagation();
  e.preventDefault();
  const startY = e.clientY;
  const startSize = item.size;
  const before = snapshot(item);
  const { scale } = item.pageState;

  const onMove = (ev) => {
    const dy = ev.clientY - startY; // drag down = bigger
    item.size = Math.min(96, Math.max(4, startSize + dy / scale));
    if (!item.isNew) item.edited = true;
    positionEl(item.pageState, item, item.el);
    // Mid-edit the box holds uncommitted text; re-rendering from item.str
    // would wipe it.
    if (!item.el.classList.contains('editing')) refreshItemView(item);
    updateHandle();
    els.ctlSize.value = +item.size.toFixed(1);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    pushHistory(item, before);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Drag the box wider/narrower (new text boxes only) — text rewraps live.
function startWidthResize(item, e) {
  e.stopPropagation();
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = item.width;
  const before = snapshot(item);
  const { scale } = item.pageState;

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    item.width = Math.max(30, startWidth + dx / scale);
    if (item.para) item.edited = true;
    positionEl(item.pageState, item, item.el);
    updateHandle();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    pushHistory(item, before);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Floating resize handles, attached to whichever item is selected: one for
// font size (bottom-right corner), one for box width (right edge, new boxes
// only — original single-line PDF text doesn't wrap so width is moot there).
let handleEl = null;
let widthHandleEl = null;

function updateHandle() {
  const item = state.selected;
  if (!handleEl) {
    handleEl = document.createElement('div');
    handleEl.className = 'resize-handle';
    handleEl.title = 'Drag to resize text';
    handleEl.addEventListener('mousedown', (e) => {
      if (state.selected) startResize(state.selected, e);
    });
  }
  if (!widthHandleEl) {
    widthHandleEl = document.createElement('div');
    widthHandleEl.className = 'resize-handle width-handle';
    widthHandleEl.title = 'Drag to resize box width';
    widthHandleEl.addEventListener('mousedown', (e) => {
      if (state.selected) startWidthResize(state.selected, e);
    });
  }
  if (!item || item.deleted || item.isLine) {
    handleEl.remove();
    widthHandleEl.remove();
    return;
  }
  const el = item.el;
  item.pageState.overlay.appendChild(handleEl);
  handleEl.style.left = `${el.offsetLeft + el.offsetWidth - 5}px`;
  handleEl.style.top = `${el.offsetTop + el.offsetHeight - 5}px`;

  if (item.isNew || item.para) {
    item.pageState.overlay.appendChild(widthHandleEl);
    widthHandleEl.style.left = `${el.offsetLeft + el.offsetWidth - 5}px`;
    widthHandleEl.style.top = `${el.offsetTop + el.offsetHeight / 2 - 5}px`;
  } else {
    widthHandleEl.remove();
  }
}

// Once an original item moves away from its extracted position, leave a white
// mask over the stale canvas rendering at the old spot.
function ensureMask(item) {
  if (item.isNew) return;
  const moved = item.x !== item.ox || item.y !== item.oy;
  // No mask needed once the item is back to unedited or unmoved (e.g. undo).
  if (!(item.edited || item.deleted) || !moved) {
    item.maskEl?.remove();
    item.maskEl = null;
    return;
  }
  if (!item.maskEl) {
    item.maskEl = document.createElement('div');
    item.maskEl.className = 'text-mask';
    item.pageState.overlay.prepend(item.maskEl);
    positionMask(item);
  }
}

function positionMask(item) {
  const { viewport, scale } = item.pageState;
  const [vx, vy] = viewport.convertToViewportPoint(item.ox, item.oy);
  const fontPx = item.osize * scale;
  item.maskEl.style.left = `${vx - 1}px`;
  item.maskEl.style.top = `${vy - fontPx * 0.92}px`;
  item.maskEl.style.width = `${item.owidth * scale + 3}px`;
  item.maskEl.style.height = `${item.para ? item.oheight * scale : fontPx * 1.25}px`;
}

// Reflect the item's committed state in the overlay (covering the canvas text
// once the item diverges from what the canvas shows).
function refreshItemView(item) {
  const el = item.el;
  if (item.deleted) {
    el.classList.add('masked', 'deleted');
    el.textContent = '';
    el.classList.remove('editing');
    el.contentEditable = 'false';
    return;
  }
  el.classList.remove('deleted');
  if (item.edited || item.isNew) {
    el.classList.add('masked');
    el.textContent = item.str;
  } else {
    el.classList.remove('masked');
    el.textContent = '';
  }
  ensureMask(item);
}

// ---------- editing ----------

function beginEdit(item) {
  if (item.deleted) return;
  if (state.selected && state.selected !== item) commitEdit(state.selected);
  selectItem(item);
  item.editSnapshot = snapshot(item);
  const el = item.el;
  el.classList.add('editing', 'masked');
  el.contentEditable = 'plaintext-only';
  if (!el.textContent) el.textContent = item.str;
  el.focus();
  updateHandle();

  if (!el.dataset.wired) {
    el.dataset.wired = '1';
    el.addEventListener('blur', () => commitEdit(item));
    el.addEventListener('input', updateHandle); // box grows/shrinks as you type
    el.addEventListener('keydown', (e) => {
      if (isBulletShortcut(e)) {
        e.preventDefault();
        el.textContent = toggleBulletText(el.textContent);
        const sel = window.getSelection();
        sel.selectAllChildren(el);
        sel.collapseToEnd();
        return;
      }
      if (e.key === 'Enter' && !item.isNew) { e.preventDefault(); el.blur(); }
      if (e.key === 'Escape') {
        e.preventDefault();
        el.textContent = item.str;
        el.blur();
      }
    });
  }
}

// Cmd/Ctrl+Shift+8: add a "• " to each non-empty line, or strip them if every
// line already has one.
const BULLET_RE = /^•\s/;
function toggleBulletText(text) {
  const lines = text.split('\n');
  const filled = lines.filter((l) => l.trim());
  const remove = filled.length > 0 && filled.every((l) => BULLET_RE.test(l));
  return lines.map((l) => {
    if (!l.trim()) return l;
    return remove ? l.replace(BULLET_RE, '') : (BULLET_RE.test(l) ? l : `• ${l}`);
  }).join('\n');
}

function isBulletShortcut(e) {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'Digit8';
}

// Toggle bullets on a selected (not currently being edited) text item.
function toggleBulletOnSelected() {
  const item = state.selected;
  if (!item || item.isLine || item.deleted) return;
  const snap = snapshot(item);
  const next = toggleBulletText(item.str);
  if (next === item.str) return;
  item.str = next;
  item.edited = true;
  refreshItemView(item);
  updateHandle();
  pushHistory(item, snap);
}

function commitEdit(item) {
  const el = item.el;
  if (!el.classList.contains('editing')) return;
  el.classList.remove('editing');
  el.contentEditable = 'false';
  const text = el.textContent;
  if (text !== item.str) {
    item.str = text;
    if (item.isNew || text !== item.original) item.edited = true;
  }
  if (item.isNew && !text.trim()) item.deleted = true;
  refreshItemView(item);
  updateHandle();
  if (item.editSnapshot) {
    pushHistory(item, item.editSnapshot);
    item.editSnapshot = null;
  }
}

function syncAlignButtons(align) {
  els.ctlAlignLeft.classList.toggle('active', align === 'left' || !align);
  els.ctlAlignCenter.classList.toggle('active', align === 'center');
  els.ctlAlignRight.classList.toggle('active', align === 'right');
}

// Controls that only make sense for a text item (font/size/bold/italic/
// align/format-painter) — hidden for a rectangle multi-selection or a line.
const TEXT_ONLY_CONTROLS = [
  'ctlFont', 'ctlSize', 'ctlBold', 'ctlItalic', 'ctlColor', 'ctlFormatPainter',
  'ctlAlignLeft', 'ctlAlignCenter', 'ctlAlignRight',
].map((k) => els[k]);

function selectItem(item) {
  if (state.selected?.el) state.selected.el.classList.remove('selected');
  state.selected = item;
  els.controls.hidden = !item;
  updateHandle();
  if (!item) return;
  item.el.classList.add('selected');
  if (item.isLine) {
    for (const el of TEXT_ONLY_CONTROLS) el.hidden = true;
    els.ctlDuplicate.hidden = true;
    els.multiSelectLabel.hidden = false;
    els.multiSelectLabel.textContent = 'Line';
    return;
  }
  for (const el of TEXT_ONLY_CONTROLS) el.hidden = false;
  els.ctlDuplicate.hidden = false;
  els.multiSelectLabel.hidden = true;
  els.ctlFont.value = item.fontId;
  els.ctlSize.value = +item.size.toFixed(1);
  els.ctlBold.classList.toggle('active', item.bold);
  els.ctlItalic.classList.toggle('active', item.italic);
  els.ctlColor.value = item.color;
  syncAlignButtons(item.align);
}

function applyStyleChange(mutate) {
  const item = state.selected;
  if (!item) return;
  const before = snapshot(item);
  mutate(item);
  item.edited = !item.isNew;
  positionEl(item.pageState, item, item.el);
  refreshItemView(item);
  updateHandle();
  pushHistory(item, before);
}

function deleteSelected() {
  if (state.multiSelected.size) {
    const items = [...state.multiSelected];
    clearMultiSelection();
    inHistoryBatch(() => {
      for (const it of items) {
        const before = snapshot(it);
        it.deleted = true;
        it.edited = true;
        if (it.isLine) refreshLineView(it); else refreshItemView(it);
        pushHistory(it, before);
      }
    });
    status(`Deleted ${items.length} item${items.length > 1 ? 's' : ''}.`);
    return;
  }
  const it = state.selected;
  if (!it) return;
  const before = snapshot(it);
  it.deleted = true;
  it.edited = true;
  if (it.isLine) refreshLineView(it); else refreshItemView(it);
  selectItem(null);
  pushHistory(it, before);
}

// ---------- rectangle multi-select ----------

function addToMultiSelection(item) {
  state.multiSelected.add(item);
  item.el?.classList.add('multi-selected');
}

function clearMultiSelection() {
  for (const it of state.multiSelected) it.el?.classList.remove('multi-selected');
  state.multiSelected.clear();
  updateMultiSelectUI();
}

function toggleMultiSelection(item) {
  if (state.multiSelected.has(item)) {
    state.multiSelected.delete(item);
    item.el?.classList.remove('multi-selected');
  } else {
    addToMultiSelection(item);
  }
  updateMultiSelectUI();
}

// Multi-select replaces the per-item style toolbar (font/size/bold/italic/
// color/format-painter don't make sense for a mixed group) with just a count
// plus Duplicate/Delete, which stay meaningful for any-sized selection.
function updateMultiSelectUI() {
  const n = state.multiSelected.size;
  if (n > 0) {
    els.controls.hidden = false;
    els.multiSelectLabel.hidden = false;
    els.multiSelectLabel.textContent = `${n} selected`;
    for (const el of TEXT_ONLY_CONTROLS) el.hidden = true;
    els.ctlAlignEdges.hidden = n < 2;
    els.ctlMerge.hidden = n < 2;
  } else {
    els.multiSelectLabel.hidden = true;
    els.ctlAlignEdges.hidden = true;
    els.ctlMerge.hidden = true;
    for (const el of TEXT_ONLY_CONTROLS) el.hidden = false;
    els.controls.hidden = !state.selected;
  }
}

// Merge the selected text boxes (top to bottom) into the topmost one, as a
// single paragraph that wraps to the widest box. The others are deleted.
function mergeSelected() {
  const items = [...state.multiSelected].filter((it) => !it.deleted && !it.isLine);
  if (items.length < 2) { status('Select at least two text boxes to merge.', true); return; }
  if (new Set(items.map((it) => it.pageState)).size > 1) {
    status('Boxes on different pages can\'t be merged.', true);
    return;
  }
  items.sort((a, b) => (Math.abs(b.y - a.y) > a.size * 0.5 ? b.y - a.y : a.x - b.x));
  const head = items[0];
  const rest = items.slice(1);
  const snaps = new Map(items.map((it) => [it, snapshot(it)]));

  inHistoryBatch(() => {
    const right = Math.max(...items.map((it) => it.x + it.width));
    head.str = items.map((it, i) => (i && !items[i - 1].str.trimEnd().endsWith('-') ? ' ' : '') + it.str.trim()).join('');
    head.width = right - head.x;
    if (!head.isNew) {
      if (!head.para) {
        const gap = head.y - rest[0].y;
        head.para = true;
        head.leading = gap >= head.size * 0.9 && gap <= head.size * 2 ? gap : head.size * 1.2;
        head.oheight = head.size * 1.25;
      }
      head.edited = true;
    }
    positionEl(head.pageState, head, head.el);
    refreshItemView(head);
    pushHistory(head, snaps.get(head));
    for (const it of rest) {
      it.deleted = true;
      it.edited = true;
      refreshItemView(it);
      pushHistory(it, snaps.get(it));
    }
  });

  clearMultiSelection();
  selectItem(head);
  status(`Merged ${items.length} text boxes into one.`);
}

// Snap the left edge of every multi-selected text box to the leftmost one on
// its page. Only x changes, so each box keeps its vertical position.
function alignLeftEdges() {
  const boxes = [...state.multiSelected].filter((it) => !it.deleted && !it.isLine);
  const byPage = new Map();
  for (const it of boxes) {
    if (!byPage.has(it.pageState)) byPage.set(it.pageState, []);
    byPage.get(it.pageState).push(it);
  }
  let moved = 0;
  inHistoryBatch(() => { for (const group of byPage.values()) {
    const left = Math.min(...group.map((it) => it.x));
    for (const it of group) {
      if (it.x === left) continue;
      const before = snapshot(it);
      it.x = left;
      if (!it.isNew) it.edited = true;
      positionEl(it.pageState, it, it.el);
      refreshItemView(it);
      pushHistory(it, before);
      moved++;
    }
  } });
  updateHandle();
  status(moved ? `Aligned ${moved} text box${moved > 1 ? 'es' : ''} to the left edge.` : 'Already aligned.');
}

// Click-drag on empty page space to select every item the rectangle touches.
// A plain click (no real movement) just clears the current selection.
function startMarqueeSelect(pageState, e) {
  const rect = pageState.overlay.getBoundingClientRect();
  const startX = e.clientX - rect.left;
  const startY = e.clientY - rect.top;
  const additive = e.metaKey || e.ctrlKey || e.shiftKey;
  let dragging = false;
  let marqueeEl = null;

  const onMove = (ev) => {
    const curX = ev.clientX - rect.left;
    const curY = ev.clientY - rect.top;
    if (!dragging && Math.hypot(curX - startX, curY - startY) < 4) return;
    dragging = true;
    if (!marqueeEl) {
      marqueeEl = document.createElement('div');
      marqueeEl.className = 'marquee-select';
      pageState.overlay.appendChild(marqueeEl);
    }
    const left = Math.min(startX, curX), top = Math.min(startY, curY);
    marqueeEl.style.left = `${left}px`;
    marqueeEl.style.top = `${top}px`;
    marqueeEl.style.width = `${Math.abs(curX - startX)}px`;
    marqueeEl.style.height = `${Math.abs(curY - startY)}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    // Cmd/Ctrl/Shift-drag adds to the current selection instead of replacing it.
    if (additive && !dragging) return;
    const prior = state.selected;
    if (state.selected) commitEdit(state.selected);
    selectItem(null);
    if (!additive) clearMultiSelection();
    else if (prior && !prior.deleted) addToMultiSelection(prior);
    if (dragging && marqueeEl) {
      const mLeft = parseFloat(marqueeEl.style.left);
      const mTop = parseFloat(marqueeEl.style.top);
      const mRight = mLeft + parseFloat(marqueeEl.style.width);
      const mBottom = mTop + parseFloat(marqueeEl.style.height);
      marqueeEl.remove();
      for (const it of [...pageState.items, ...pageState.newBoxes, ...pageState.lines]) {
        if (it.deleted || !it.el) continue;
        const l = it.el.offsetLeft, t = it.el.offsetTop;
        const r = l + it.el.offsetWidth, b = t + it.el.offsetHeight;
        if (l < mRight && r > mLeft && t < mBottom && b > mTop) addToMultiSelection(it);
      }
      updateMultiSelectUI();
    }
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ---------- format painter ----------

// Copy the selected item's style (font, size, bold, italic, color) and apply
// it to whatever's clicked next — like Word/Docs' paintbrush. A plain click
// on the toolbar button is a one-shot painter; double-click makes it sticky
// (keeps painting until toggled off or Escape).
function startFormatPainter(sticky) {
  const src = state.selected;
  if (!src || src.isLine) return;
  state.formatPainter = {
    fontId: src.fontId, size: src.size, bold: src.bold, italic: src.italic, color: src.color,
    align: src.align, sticky,
  };
  els.ctlFormatPainter.classList.add('active');
  document.body.classList.add('format-painter-cursor');
}

function stopFormatPainter() {
  if (!state.formatPainter) return;
  state.formatPainter = null;
  els.ctlFormatPainter.classList.remove('active');
  document.body.classList.remove('format-painter-cursor');
}

function applyFormatPainter(item) {
  const fp = state.formatPainter;
  if (!fp) return;
  const before = snapshot(item);
  item.fontId = fp.fontId;
  item.size = fp.size;
  item.bold = fp.bold;
  item.italic = fp.italic;
  item.color = fp.color;
  item.align = fp.align || 'left';
  item.edited = !item.isNew;
  positionEl(item.pageState, item, item.el);
  refreshItemView(item);
  if (state.selected === item) selectItem(item); // sync toolbar controls
  updateHandle();
  pushHistory(item, before);
  if (!fp.sticky) stopFormatPainter();
}

// ---------- duplicate & nudge ----------

// Clone an item (style + text) as a new text box slightly below the source.
// Does not change selection — callers decide how to select the result(s).
function duplicateFrom(snap, pageState, offsetSteps = 1) {
  const item = {
    id: state.nextId++,
    str: snap.str, original: '',
    x: snap.x, y: snap.y - snap.size * 1.4 * offsetSteps,
    // A few points of slack: the copied width is the source's rendered
    // offsetWidth, which (with box-sizing: border-box) leaves the new box's
    // content area zero slack — sub-pixel rounding alone can wrap text that
    // fit fine in the original.
    size: snap.size, width: (snap.width || 60) + 6,
    fontId: snap.fontId, bold: snap.bold, italic: snap.italic, color: snap.color,
    align: snap.align || 'left',
    edited: false, deleted: false, isNew: true,
  };
  pageState.newBoxes.push(item);
  mountItem(pageState, item);
  // Creation as a history entry: undo marks it deleted (hides it).
  history.undo.push({ item, before: { ...snapshot(item), deleted: true }, after: snapshot(item), at: Date.now() });
  history.redo.length = 0;
  updateUndoButtons();
  markDirty();
  return item;
}

// Copies every currently-selected item's full style + text — one or many.
function copySelected() {
  let items = [];
  if (state.multiSelected.size) items = [...state.multiSelected].filter((it) => !it.deleted && !it.isLine);
  else if (state.selected && !state.selected.deleted && !state.selected.isLine) items = [state.selected];
  if (!items.length) return;
  state.clipboard = items.map((it) => ({
    ...snapshot(it), width: it.el.offsetWidth / it.pageState.scale, pageState: it.pageState,
  }));
  state.pasteCount = 0;
  status(`Copied ${items.length} item${items.length > 1 ? 's' : ''} — Cmd/Ctrl+V to paste.`);
}

// Pastes the whole clipboard as a group, retaining each item's exact format
// (font, size, bold, italic, color) — a multi-item paste selects the new
// group together rather than dropping you into edit mode on one of them.
function pasteClipboard() {
  const clip = state.clipboard;
  if (!clip || !clip.length) return;
  state.pasteCount++;
  const newItems = clip.map((snap) => duplicateFrom(snap, snap.pageState, state.pasteCount));
  if (newItems.length === 1) {
    selectItem(newItems[0]);
  } else {
    selectItem(null);
    clearMultiSelection();
    for (const it of newItems) addToMultiSelection(it);
    updateMultiSelectUI();
  }
  status(`Pasted ${newItems.length} item${newItems.length > 1 ? 's' : ''}.`);
}

const NUDGE_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function nudgeSelected(key, big) {
  const item = state.selected;
  if (!item || item.deleted) return false;
  const [dx, dy] = NUDGE_KEYS[key];
  const step = (big ? 10 : 1) / item.pageState.scale; // 1 or 10 screen px
  const before = snapshot(item);
  item.x += dx * step;
  item.y -= dy * step; // PDF y-axis points up
  if (item.isLine) {
    refreshLineView(item);
  } else {
    if (!item.isNew) item.edited = true;
    positionEl(item.pageState, item, item.el);
    refreshItemView(item);
  }
  updateHandle();
  pushHistory(item, before, 'nudge');
  return true;
}

// ---------- new text boxes ----------

function addTextBoxAt(pageState, e) {
  const rect = pageState.overlay.getBoundingClientRect();
  const vx = e.clientX - rect.left;
  const vy = e.clientY - rect.top;
  const [px, py] = pageState.viewport.convertToPdfPoint(vx, vy);
  const item = {
    id: state.nextId++,
    str: '', original: '',
    x: px, y: py, size: 11, width: 180,
    fontId: els.ctlFont.value || DEFAULT_FONT_ID,
    bold: false, italic: false, color: '#000000', align: 'left',
    edited: false, deleted: false, isNew: true,
  };
  pageState.newBoxes.push(item);
  mountItem(pageState, item);
  setAddTextMode(false);
  beginEdit(item);
}

function setAddTextMode(on) {
  state.addTextMode = on;
  els.btnAddText.classList.toggle('active', on);
  document.body.classList.toggle('add-text-cursor', on);
}

// ---------- font report ----------

function renderFontReport() {
  const lines = [];
  for (const [rawName, det] of state.detectedFonts) {
    const entry = FONTS[det.fontId];
    const style = styleKey(det.bold, det.italic);
    const styles = state.fontAvailability[det.fontId] || {};
    const target = `${entry.label}${style !== 'regular' ? ` (${style})` : ''}`;
    const attr = `data-raw="${rawName.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
    if (styles[style]) {
      lines.push(`<li ${attr}><b>${rawName}</b> → ${target} <span class="ok">bundled font file</span></li>`);
    } else if (styles.regular) {
      lines.push(`<li ${attr}><b>${rawName}</b> → ${target} <span class="warn">no ${style} file — will export with the regular weight file</span></li>`);
    } else {
      const std = entry.std?.[style] || entry.std?.regular;
      lines.push(`<li ${attr}><b>${rawName}</b> → ${target} <span class="warn">no font file in /public/fonts — will export with standard ${std}</span></li>`);
    }
  }
  if (!lines.length) { els.fontReport.hidden = true; return; }
  els.fontReport.hidden = false;
  els.fontReport.innerHTML = `<strong>Detected fonts</strong><ul>${lines.join('')}</ul>`;
}

// Highlight every text box using `raw` (a cleaned embedded font name), or
// clear all highlights when raw is null.
function setFontHighlight(raw) {
  for (const ps of state.pages) {
    for (const it of ps.items) {
      it.el?.classList.toggle('font-hl', !!raw && !it.deleted && it.fontRaw === raw);
    }
  }
}

// ---------- export ----------

function exportPagesState() {
  return state.pages.map((p) => ({ items: p.items, newBoxes: p.newBoxes, lines: p.lines }));
}

// Pre-export check: if the export would change fonts or garble characters,
// list what will happen and let the user go back or export anyway.
async function doExport() {
  if (!state.pdfBytes) return;
  if (state.selected) commitEdit(state.selected);
  status('Checking export…');
  els.btnExport.disabled = true;
  let issues = [];
  try {
    issues = await preflightExport(state.pdfBytes, exportPagesState(), { pageOrder: state.pageOrder });
  } catch (err) {
    console.warn('Pre-export check failed', err); // don't block exporting on a checker bug
  }
  if (!issues.length) { await runExport(); return; }
  els.btnExport.disabled = false;
  status('');
  els.preflightList.innerHTML = '';
  for (const issue of issues) {
    const li = document.createElement('li');
    li.className = issue.level;
    li.textContent = issue.text;
    els.preflightList.appendChild(li);
  }
  els.preflightModal.hidden = false;
}

function closePreflight() { els.preflightModal.hidden = true; }

async function runExport() {
  status('Exporting…');
  els.btnExport.disabled = true;
  try {
    const pagesState = exportPagesState();
    const { bytes, fallbacks, warnings, linkCount } = await exportPdf(state.pdfBytes, pagesState, {
      linkify: els.ctlLinks.checked,
      pageOrder: state.pageOrder,
    });
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.fileName.replace(/\.pdf$/i, '') + (state.renamed ? '.pdf' : '-edited.pdf');
    a.click();
    URL.revokeObjectURL(a.href);

    const notes = [];
    for (const f of fallbacks) notes.push(`Font fallback: ${f.requested} → ${f.used}`);
    notes.push(...warnings);
    const linkNote = els.ctlLinks.checked ? ` ${linkCount} clickable link${linkCount === 1 ? '' : 's'} added.` : '';
    status(notes.length ? notes.join(' • ') + linkNote : `Exported — text is fully selectable.${linkNote}`);
    if (notes.length) console.warn(notes.join('\n'));
  } catch (err) {
    console.error(err);
    status(`Export failed: ${err.message}`, true);
  } finally {
    els.btnExport.disabled = false;
  }
}

// ---------- wiring ----------

function init() {
  for (const [id, entry] of Object.entries(FONTS)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = entry.label;
    els.ctlFont.appendChild(opt);
  }
  els.ctlFont.value = DEFAULT_FONT_ID;

  checkFontAvailability().then((a) => {
    state.fontAvailability = a;
    if (state.detectedFonts.size) renderFontReport();
  });

  els.btnOpen.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => loadFile(els.fileInput.files[0]));

  // Register drag & drop on body only — a drop on the dropzone bubbles up to
  // body, so listening on both fired loadFile twice (pages rendered twice).
  const dz = els.startPage;
  document.body.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragging'); });
  document.body.addEventListener('dragleave', () => dz.classList.remove('dragging'));
  document.body.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragging');
    const file = e.dataTransfer.files?.[0];
    if (file) loadFile(file);
  });

  els.fontReport.addEventListener('mouseover', (e) => {
    const li = e.target.closest('li[data-raw]');
    setFontHighlight(li ? li.dataset.raw : null);
  });
  els.fontReport.addEventListener('mouseleave', () => setFontHighlight(null));

  els.btnAddText.addEventListener('click', () => setAddTextMode(!state.addTextMode));
  els.btnExport.addEventListener('click', doExport);
  els.btnDeletePages.addEventListener('click', deleteSelectedPages);
  els.preflightCancel.addEventListener('click', closePreflight);
  els.preflightOk.addEventListener('click', () => { closePreflight(); runExport(); });
  els.confirmCancel.addEventListener('click', closeConfirmModal);
  els.confirmOk.addEventListener('click', () => {
    const cb = confirmCallback;
    closeConfirmModal();
    cb?.();
  });
  els.confirmModal.addEventListener('click', (e) => {
    if (e.target === els.confirmModal) closeConfirmModal();
  });

  els.btnHome.addEventListener('click', goHome);
  els.docName.addEventListener('blur', commitRename);
  els.docName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.docName.blur();
    else if (e.key === 'Escape') { syncDocName(); els.docName.blur(); }
  });
  els.startOpen.addEventListener('click', () => els.fileInput.click());
  els.ctlLinks.checked = localStorage.getItem('linkify') !== '0';
  els.ctlLinks.addEventListener('change', () => localStorage.setItem('linkify', els.ctlLinks.checked ? '1' : '0'));

  els.ctlFont.addEventListener('change', () => applyStyleChange((it) => { it.fontId = els.ctlFont.value; }));
  els.ctlSize.addEventListener('change', () => applyStyleChange((it) => { it.size = Math.max(4, parseFloat(els.ctlSize.value) || it.size); }));
  els.ctlBold.addEventListener('click', () => {
    applyStyleChange((it) => { it.bold = !it.bold; });
    els.ctlBold.classList.toggle('active', state.selected?.bold);
  });
  els.ctlItalic.addEventListener('click', () => {
    applyStyleChange((it) => { it.italic = !it.italic; });
    els.ctlItalic.classList.toggle('active', state.selected?.italic);
  });
  els.ctlColor.addEventListener('input', () => applyStyleChange((it) => { it.color = els.ctlColor.value; }));
  for (const btn of [els.ctlAlignLeft, els.ctlAlignCenter, els.ctlAlignRight]) {
    btn.addEventListener('click', () => {
      const align = btn.dataset.align;
      applyStyleChange((it) => { it.align = align; });
      syncAlignButtons(align);
    });
  }
  els.ctlDelete.addEventListener('click', deleteSelected);
  els.ctlAlignEdges.addEventListener('click', alignLeftEdges);
  els.ctlMerge.addEventListener('click', mergeSelected);

  els.btnUndo.addEventListener('click', undo);
  els.btnRedo.addEventListener('click', redo);
  els.btnZoomIn.addEventListener('click', () => setZoom(state.zoomIdx + 1));
  els.btnZoomOut.addEventListener('click', () => setZoom(state.zoomIdx - 1));
  els.ctlFormatPainter.addEventListener('click', () => {
    if (state.formatPainter) stopFormatPainter();
    else startFormatPainter(false);
  });
  els.ctlFormatPainter.addEventListener('dblclick', () => {
    startFormatPainter(true);
  });
  els.ctlDuplicate.addEventListener('click', () => {
    if (state.selected || state.multiSelected.size) { copySelected(); pasteClipboard(); }
  });

  document.addEventListener('keydown', (e) => {
    if (!els.preflightModal.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closePreflight(); }
      return;
    }
    if (!els.confirmModal.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeConfirmModal(); }
      return;
    }
    const active = document.activeElement;
    // Inside a text edit or toolbar field, leave all keys to the browser
    // (native text undo, cursor movement, copy/paste of characters).
    if (active?.isContentEditable || active?.tagName === 'INPUT' || active?.tagName === 'SELECT') return;

    if (e.key === 'Escape' && state.formatPainter) { e.preventDefault(); stopFormatPainter(); return; }
    if (e.key === 'Escape' && state.multiSelected.size) { e.preventDefault(); clearMultiSelection(); return; }

    if ((e.key === 'Delete' || e.key === 'Backspace') && (state.selected || state.multiSelected.size)) {
      e.preventDefault();
      deleteSelected();
      return;
    }

    if (isBulletShortcut(e) && state.selected) { e.preventDefault(); toggleBulletOnSelected(); return; }

    if (e.metaKey || e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
      else if (k === 'z') { e.preventDefault(); undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      else if (k === 'c') { if (state.selected || state.multiSelected.size) { e.preventDefault(); copySelected(); } }
      else if (k === 'v') { if (state.clipboard) { e.preventDefault(); pasteClipboard(); } }
      else if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(state.zoomIdx + 1); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(state.zoomIdx - 1); }
      return;
    }

    if (NUDGE_KEYS[e.key] && nudgeSelected(e.key, e.shiftKey)) e.preventDefault();
  });
}

init();
showStartPage();
