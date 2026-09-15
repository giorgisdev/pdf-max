import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  FONTS, DEFAULT_FONT_ID, detectFont, cleanFontName, checkFontAvailability, styleKey,
} from './fonts.js';
import { exportPdf } from './exporter.js';
import { saveDraft, loadDraft, clearDraft } from './draft.js';
import { inject } from '@vercel/analytics';


pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

inject();

// ---------- state ----------

const state = {
  fileName: null,
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
};
let lastClickedPage = null; // shift-click range anchor for the pages panel

const $ = (id) => document.getElementById(id);
const els = {
  dropzone: $('dropzone'), pages: $('pages'), fileInput: $('file-input'),
  btnOpen: $('btn-open'), btnAddText: $('btn-add-text'), btnExport: $('btn-export'),
  controls: $('text-controls'), ctlFont: $('ctl-font'), ctlSize: $('ctl-size'),
  ctlBold: $('ctl-bold'), ctlItalic: $('ctl-italic'), ctlColor: $('ctl-color'),
  ctlDelete: $('ctl-delete'), fontReport: $('font-report'), statusBar: $('status-bar'),
  btnUndo: $('btn-undo'), btnRedo: $('btn-redo'),
  btnZoomIn: $('btn-zoom-in'), btnZoomOut: $('btn-zoom-out'), zoomLabel: $('zoom-label'),
  ctlDuplicate: $('ctl-duplicate'), ctlLinks: $('ctl-links'), ctlFormatPainter: $('ctl-format-painter'),
  pagesGrid: $('pages-grid'), pagesPanelHint: $('pages-panel-hint'), btnDeletePages: $('btn-delete-pages'),
  confirmModal: $('confirm-modal'), confirmText: $('confirm-modal-text'),
  confirmCancel: $('confirm-cancel'), confirmOk: $('confirm-ok'),
  autosaveIndicator: $('autosave-indicator'),
  restoreBanner: $('restore-banner'), restoreBannerText: $('restore-banner-text'),
  btnDiscardDraft: $('btn-discard-draft'),
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
  // Set before any await: blocks the async draft check (still in flight from
  // startup) from re-showing the banner after the user has already moved on.
  draftPromptSuppressed = true;
  if (!file || !/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    status('Please choose a PDF file.', true);
    return;
  }
  status(`Loading ${file.name}…`);
  hideRestoreBanner();
  const bytes = new Uint8Array(await file.arrayBuffer());
  state.fileName = file.name;
  state.pdfBytes = bytes;
  state.pages = [];
  state.detectedFonts = new Map();
  state.selected = null;
  history.undo.length = 0;
  history.redo.length = 0;
  updateUndoButtons();
  state.clipboard = null;
  stopFormatPainter();
  state.pageOrder = [];
  state.selectedPages.clear();
  lastClickedPage = null;
  els.pages.innerHTML = '';
  els.pagesGrid.innerHTML = '';
  els.btnDeletePages.disabled = true;

  try {
    // pdf.js transfers the buffer to its worker, so hand it a copy.
    state.pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  } catch (err) {
    status(`Could not open PDF: ${err.message}`, true);
    return;
  }

  els.dropzone.classList.add('hidden');
  els.pagesPanelHint.hidden = true;
  for (let p = 1; p <= state.pdfDoc.numPages; p++) {
    await renderPage(p);
  }
  els.btnExport.disabled = false;
  els.btnAddText.disabled = false;
  els.btnZoomIn.disabled = state.zoomIdx === ZOOM_LEVELS.length - 1;
  els.btnZoomOut.disabled = state.zoomIdx === 0;
  renderFontReport();
  status(`Loaded ${file.name} — click any text to edit it.`);
}

// ---------- text extraction ----------

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

  return merged
    .filter((m) => m.str.trim().length > 0)
    .map((m) => {
      const det = detectFont(m.fontRaw);
      const rec = state.detectedFonts.get(cleanFontName(m.fontRaw)) || { ...det, count: 0 };
      rec.count++;
      state.detectedFonts.set(cleanFontName(m.fontRaw), rec);
      return {
        id: state.nextId++,
        str: m.str, original: m.str,
        x: m.x, y: m.y, ox: m.x, oy: m.y, osize: m.size, owidth: m.width,
        size: m.size, width: m.width,
        fontId: det.fontId, bold: det.bold, italic: det.italic,
        fontRaw: cleanFontName(m.fontRaw),
        color: '#000000',
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
    items: [], newBoxes: [],
  };
  state.pages[pageNum - 1] = pageState;

  await applyViewport(pageState);
  pageState.items = await extractItems(page);
  for (const item of pageState.items) mountItem(pageState, item);

  overlay.addEventListener('mousedown', (e) => {
    if (e.target !== overlay) return;
    if (state.formatPainter) {
      stopFormatPainter();
    } else if (state.addTextMode) {
      e.preventDefault();
      addTextBoxAt(pageState, e);
    } else {
      selectItem(null);
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
  'fontId', 'bold', 'italic', 'color', 'edited', 'deleted', 'isNew', 'fontRaw',
];

function serializeItem(it) {
  const out = {};
  for (const k of ITEM_FIELDS) if (k in it) out[k] = it[k];
  return out;
}

function buildDraftSnapshot() {
  return {
    fileName: state.fileName,
    pdfBytes: state.pdfBytes,
    pageOrder: state.pageOrder.slice(),
    pages: state.pages.map((ps) => ({
      items: ps.items.map(serializeItem),
      newBoxes: ps.newBoxes.map(serializeItem),
    })),
    savedAt: Date.now(),
  };
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

// True once the user has taken any action (loaded a file or discarded a
// draft) that makes the startup draft check's result stale.
let draftPromptSuppressed = false;
let restoredBannerTimer = null;

function hideRestoreBanner() {
  els.restoreBanner.hidden = true;
  clearTimeout(restoredBannerTimer);
}

// Shown briefly after an automatic restore, purely as an FYI — restoring
// already happened, this just offers a quick way to bail out of it.
function showRestoredNotice(draft) {
  const when = new Date(draft.savedAt).toLocaleString();
  els.restoreBannerText.textContent = `Restored your previous session for "${draft.fileName}" (autosaved ${when}).`;
  els.restoreBanner.hidden = false;
  clearTimeout(restoredBannerTimer);
  restoredBannerTimer = setTimeout(hideRestoreBanner, 8000);
}

// Undo an automatic restore: wipe the stored draft and go back to the empty
// dropzone, as if the app had just opened with no prior session.
function discardDraftAndStartOver() {
  draftPromptSuppressed = true;
  hideRestoreBanner();
  clearDraft().catch((err) => console.warn('Could not clear draft', err));
  state.fileName = null;
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
  state.pageOrder = [];
  state.selectedPages.clear();
  lastClickedPage = null;
  els.pages.innerHTML = '';
  els.pagesGrid.innerHTML = '';
  els.btnDeletePages.disabled = true;
  els.pagesPanelHint.hidden = false;
  els.dropzone.classList.remove('hidden');
  els.btnExport.disabled = true;
  els.btnAddText.disabled = true;
  els.fontReport.hidden = true;
  status('Discarded — start fresh whenever you\'re ready.');
}

// Auto-restore on startup, Google-Docs style: no confirmation click needed.
// If the user has already started loading their own file by the time this
// resolves, draftPromptSuppressed blocks it from clobbering their choice.
async function checkForDraft() {
  try {
    const draft = await loadDraft();
    if (draftPromptSuppressed || !draft?.pdfBytes || !draft.fileName) return;
    await restoreDraft(draft);
    if (draftPromptSuppressed) return; // user loaded something else mid-restore
    showRestoredNotice(draft);
  } catch (err) {
    console.warn('Could not restore the saved draft', err);
  }
}

async function restoreDraft(draft) {
  status(`Restoring ${draft.fileName}…`);
  const bytes = draft.pdfBytes instanceof Uint8Array ? draft.pdfBytes : new Uint8Array(draft.pdfBytes);
  state.fileName = draft.fileName;
  state.pdfBytes = bytes;
  state.pages = [];
  state.detectedFonts = new Map();
  state.selected = null;
  history.undo.length = 0;
  history.redo.length = 0;
  updateUndoButtons();
  state.clipboard = null;
  stopFormatPainter();
  state.pageOrder = [];
  state.selectedPages.clear();
  lastClickedPage = null;
  els.pages.innerHTML = '';
  els.pagesGrid.innerHTML = '';
  els.btnDeletePages.disabled = true;

  try {
    state.pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  } catch (err) {
    status(`Could not restore draft: ${err.message}`, true);
    return;
  }

  els.dropzone.classList.add('hidden');
  els.pagesPanelHint.hidden = true;
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
  el.style.minWidth = `${Math.max(item.width * pageState.scale, fontPx)}px`;
  el.style.minHeight = `${fontPx * 1.1}px`;
  el.style.fontFamily = cssFontFor(item);
  el.style.fontWeight = item.bold ? '700' : '400';
  el.style.fontStyle = item.italic ? 'italic' : 'normal';
  el.style.color = item.color;
}

function mountItem(pageState, item) {
  const el = document.createElement('div');
  el.className = 'text-item' + (item.isNew ? ' new-box' : '');
  el.dataset.id = item.id;
  positionEl(pageState, item, el);
  pageState.overlay.appendChild(el);
  item.el = el;
  item.pageState = pageState;

  // Mousedown starts a potential drag; a "click" (no real movement) edits.
  el.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    if (state.formatPainter) {
      e.preventDefault();
      applyFormatPainter(item);
      return;
    }
    if (state.addTextMode) return;
    if (el.classList.contains('editing')) return; // let text selection work
    e.preventDefault();
    if (state.selected && state.selected !== item) commitEdit(state.selected);
    selectItem(item);
    startDragMove(item, e);
  });
  refreshItemView(item);
}

// ---------- undo / redo ----------

const history = { undo: [], redo: [] };
const SNAP_PROPS = ['str', 'x', 'y', 'size', 'fontId', 'bold', 'italic', 'color', 'edited', 'deleted'];

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
function pushHistory(item, before, kind) {
  const after = snapshot(item);
  if (sameSnapshot(before, after)) return;
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

function restore(item, snap) {
  Object.assign(item, snap);
  positionEl(item.pageState, item, item.el);
  refreshItemView(item);
  if (state.selected === item && !item.deleted) selectItem(item); // sync toolbar
  else if (state.selected === item) selectItem(null);
  updateHandle();
  markDirty();
}

function undo() {
  const entry = history.undo.pop();
  if (!entry) return;
  restore(entry.item, entry.before);
  history.redo.push(entry);
  updateUndoButtons();
}

function redo() {
  const entry = history.redo.pop();
  if (!entry) return;
  restore(entry.item, entry.after);
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
  for (const it of [...pageState.items, ...pageState.newBoxes]) {
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
    positionEl(item.pageState, item, item.el);
    updateHandle();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    item.el.classList.remove('dragging');
    hideGuides(item.pageState);
    if (dragging) {
      if (!item.isNew) item.edited = true;
      refreshItemView(item);
      updateHandle();
      pushHistory(item, before);
    } else {
      beginEdit(item);
    }
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
    refreshItemView(item);
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

// Single floating resize handle, attached to whichever item is selected.
let handleEl = null;

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
  if (!item || item.deleted || item.el.classList.contains('editing')) {
    handleEl.remove();
    return;
  }
  const el = item.el;
  item.pageState.overlay.appendChild(handleEl);
  handleEl.style.left = `${el.offsetLeft + el.offsetWidth - 5}px`;
  handleEl.style.top = `${el.offsetTop + el.offsetHeight - 5}px`;
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
  item.maskEl.style.height = `${fontPx * 1.25}px`;
}

// Reflect the item's committed state in the overlay (covering the canvas text
// once the item diverges from what the canvas shows).
function refreshItemView(item) {
  const el = item.el;
  if (item.deleted) {
    el.classList.add('masked');
    el.textContent = '';
    el.classList.remove('editing');
    return;
  }
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
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !item.isNew) { e.preventDefault(); el.blur(); }
      if (e.key === 'Escape') {
        e.preventDefault();
        el.textContent = item.str;
        el.blur();
      }
    });
  }
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

function selectItem(item) {
  if (state.selected?.el) state.selected.el.classList.remove('selected');
  state.selected = item;
  els.controls.hidden = !item;
  updateHandle();
  if (!item) return;
  item.el.classList.add('selected');
  els.ctlFont.value = item.fontId;
  els.ctlSize.value = +item.size.toFixed(1);
  els.ctlBold.classList.toggle('active', item.bold);
  els.ctlItalic.classList.toggle('active', item.italic);
  els.ctlColor.value = item.color;
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

// ---------- format painter ----------

// Copy the selected item's style (font, size, bold, italic, color) and apply
// it to whatever's clicked next — like Word/Docs' paintbrush. A plain click
// on the toolbar button is a one-shot painter; double-click makes it sticky
// (keeps painting until toggled off or Escape).
function startFormatPainter(sticky) {
  const src = state.selected;
  if (!src) return;
  state.formatPainter = {
    fontId: src.fontId, size: src.size, bold: src.bold, italic: src.italic, color: src.color,
    sticky,
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
function duplicateFrom(snap, pageState, offsetSteps = 1) {
  const item = {
    id: state.nextId++,
    str: snap.str, original: '',
    x: snap.x, y: snap.y - snap.size * 1.4 * offsetSteps,
    size: snap.size, width: snap.width || 60,
    fontId: snap.fontId, bold: snap.bold, italic: snap.italic, color: snap.color,
    edited: false, deleted: false, isNew: true,
  };
  pageState.newBoxes.push(item);
  mountItem(pageState, item);
  selectItem(item);
  // Creation as a history entry: undo marks it deleted (hides it).
  history.undo.push({ item, before: { ...snapshot(item), deleted: true }, after: snapshot(item), at: Date.now() });
  history.redo.length = 0;
  updateUndoButtons();
  markDirty();
  return item;
}

function copySelected() {
  const it = state.selected;
  if (!it || it.deleted) return;
  state.clipboard = { ...snapshot(it), width: it.el.offsetWidth / it.pageState.scale, pageState: it.pageState };
  state.pasteCount = 0;
  status('Copied — Cmd/Ctrl+V to paste.');
}

function pasteClipboard() {
  const clip = state.clipboard;
  if (!clip) return;
  state.pasteCount++;
  duplicateFrom(clip, clip.pageState, state.pasteCount);
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
  if (!item.isNew) item.edited = true;
  positionEl(item.pageState, item, item.el);
  refreshItemView(item);
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
    x: px, y: py, size: 11, width: 60,
    fontId: els.ctlFont.value || DEFAULT_FONT_ID,
    bold: false, italic: false, color: '#000000',
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

async function doExport() {
  if (!state.pdfBytes) return;
  if (state.selected) commitEdit(state.selected);
  status('Exporting…');
  els.btnExport.disabled = true;
  try {
    const pagesState = state.pages.map((p) => ({
      items: p.items, newBoxes: p.newBoxes,
    }));
    const { bytes, fallbacks, warnings, linkCount } = await exportPdf(state.pdfBytes, pagesState, {
      linkify: els.ctlLinks.checked,
      pageOrder: state.pageOrder,
    });
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
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
  const dz = els.dropzone;
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
  els.confirmCancel.addEventListener('click', closeConfirmModal);
  els.confirmOk.addEventListener('click', () => {
    const cb = confirmCallback;
    closeConfirmModal();
    cb?.();
  });
  els.confirmModal.addEventListener('click', (e) => {
    if (e.target === els.confirmModal) closeConfirmModal();
  });

  els.btnDiscardDraft.addEventListener('click', discardDraftAndStartOver);
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
  els.ctlDelete.addEventListener('click', () => {
    const it = state.selected;
    if (!it) return;
    const before = snapshot(it);
    it.deleted = true;
    it.edited = true;
    refreshItemView(it);
    selectItem(null);
    pushHistory(it, before);
  });

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
    if (state.selected) { copySelected(); pasteClipboard(); }
  });

  document.addEventListener('keydown', (e) => {
    if (!els.confirmModal.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeConfirmModal(); }
      return;
    }
    const active = document.activeElement;
    // Inside a text edit or toolbar field, leave all keys to the browser
    // (native text undo, cursor movement, copy/paste of characters).
    if (active?.isContentEditable || active?.tagName === 'INPUT' || active?.tagName === 'SELECT') return;

    if (e.key === 'Escape' && state.formatPainter) { e.preventDefault(); stopFormatPainter(); return; }

    if (e.metaKey || e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
      else if (k === 'z') { e.preventDefault(); undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      else if (k === 'c') { if (state.selected) { e.preventDefault(); copySelected(); } }
      else if (k === 'v') { if (state.clipboard) { e.preventDefault(); pasteClipboard(); } }
      else if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(state.zoomIdx + 1); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(state.zoomIdx - 1); }
      return;
    }

    if (NUDGE_KEYS[e.key] && nudgeSelected(e.key, e.shiftKey)) e.preventDefault();
  });
}

init();
checkForDraft();
