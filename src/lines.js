import { OPS } from 'pdfjs-dist';

// Detect simple horizontal decorative lines/rules drawn as vector graphics
// (not text) in a PDF page — e.g. the divider under a resume section header.
// PDF generators draw these either as a thin stroked segment or a thin
// filled rectangle; either way they're just graphics operators in the
// content stream, invisible to pdf.js's text extraction. We walk the page's
// operator list and replay the CTM ourselves (save/restore/transform), the
// same bookkeeping the renderer does, so detected coordinates land in the
// same page-space (PDF points, y-up) as extracted text items.

function multiply(m1, m2) {
  // Combined matrix for "apply m1, then m2" (PDF row-vector convention).
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function matrixScale(m) {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

function cmykToRgb255(c, m, y, k) {
  return [
    255 * (1 - Math.min(1, c + k)),
    255 * (1 - Math.min(1, m + k)),
    255 * (1 - Math.min(1, y + k)),
  ];
}

function toHex(rgb255) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[rgb255[0], rgb255[1], rgb255[2]].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`;
}

// Expand a constructPath's sub-ops into transformed (x,y) points. Rejects
// paths containing curves — decorative dividers are always straight.
function buildPath(ops, args, ctm) {
  const points = [];
  let hasCurve = false;
  let isRectOp = false;
  let j = 0;
  for (const op of ops) {
    switch (op) {
      case OPS.rectangle: {
        const x = args[j++], y = args[j++], w = args[j++], h = args[j++];
        points.push(applyMatrix(ctm, x, y), applyMatrix(ctm, x + w, y), applyMatrix(ctm, x + w, y + h), applyMatrix(ctm, x, y + h));
        isRectOp = true;
        break;
      }
      case OPS.moveTo:
      case OPS.lineTo: {
        const x = args[j++], y = args[j++];
        points.push(applyMatrix(ctm, x, y));
        break;
      }
      case OPS.curveTo: j += 6; hasCurve = true; break;
      case OPS.curveTo2: j += 4; hasCurve = true; break;
      case OPS.curveTo3: j += 4; hasCurve = true; break;
      default: break; // closePath etc. — doesn't add a point
    }
  }
  return { points, hasCurve, isRectOp };
}

function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 0.01 || Math.abs(last[1] - p[1]) > 0.01) out.push(p);
  }
  return out;
}

const MIN_LENGTH = 20; // pt — long enough to be a divider, not a dash/glyph mark
const MAX_STROKE_THICKNESS = 3; // pt
const MAX_FILL_THICKNESS = 4; // pt

// Pure (or near-) white is never a meaningfully visible divider on a white
// page — it's exactly what our own export masking draws when covering a
// moved/deleted line's old spot. We don't just ignore these though: we track
// them as "occluders" (see below) so a stale, now-covered original line
// underneath doesn't get re-detected as a real one when the file reopens.
function isNearWhite(rgb255) {
  return rgb255[0] >= 250 && rgb255[1] >= 250 && rgb255[2] >= 250;
}

// Geometric line/rule shape check, independent of color.
function classifyShape(path, paintedStroke, paintedFill, effLineWidth) {
  if (path.hasCurve) return null;
  const pts = dedupe(path.points);
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const w = xmax - xmin;
  const h = ymax - ymin;

  if (paintedStroke && pts.length === 2 && w >= MIN_LENGTH && h <= Math.max(MAX_STROKE_THICKNESS, effLineWidth)) {
    const thickness = Math.max(effLineWidth, 0.75);
    return { xmin, xmax, ymin: (ymin + ymax) / 2 - thickness / 2, ymax: (ymin + ymax) / 2 + thickness / 2, fromFill: false };
  }
  if (paintedFill && (path.isRectOp || pts.length === 4 || pts.length === 5) && w >= MIN_LENGTH && h > 0 && h <= MAX_FILL_THICKNESS) {
    return { xmin, xmax, ymin, ymax: ymin + Math.max(h, 0.75), fromFill: true };
  }
  return null;
}

// Does a later near-white occluder fully cover (with a little slack) this
// shape's bounding box? If so, it was painted over and isn't really visible.
function isCovered(shape, occluders, afterIndex) {
  const pad = 1.5;
  return occluders.some((o) => (
    o.index > afterIndex &&
    o.xmin - pad <= shape.xmin && o.xmax + pad >= shape.xmax &&
    o.ymin - pad <= shape.ymin && o.ymax + pad >= shape.ymax
  ));
}

const STROKE_PAINT_OPS = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke]);
const FILL_PAINT_OPS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke]);

export async function extractLines(page) {
  const { fnArray, argsArray } = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let strokeColor = [0, 0, 0];
  let fillColor = [0, 0, 0];
  let lineWidth = 1;
  let lastPath = null;
  const candidates = []; // { ...bbox, color, index, fromFill }
  const occluders = []; // near-white paints that can cover earlier candidates

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() || ctm;
        break;
      case OPS.transform:
        ctm = multiply(args, ctm);
        break;
      case OPS.setLineWidth:
        lineWidth = args[0];
        break;
      case OPS.setStrokeRGBColor:
        strokeColor = [args[0], args[1], args[2]];
        break;
      case OPS.setFillRGBColor:
        fillColor = [args[0], args[1], args[2]];
        break;
      case OPS.setStrokeGray:
        strokeColor = [args[0], args[0], args[0]];
        break;
      case OPS.setFillGray:
        fillColor = [args[0], args[0], args[0]];
        break;
      case OPS.setStrokeCMYKColor:
        strokeColor = cmykToRgb255(args[0], args[1], args[2], args[3]);
        break;
      case OPS.setFillCMYKColor:
        fillColor = cmykToRgb255(args[0], args[1], args[2], args[3]);
        break;
      case OPS.constructPath: {
        const [ops, pathArgs] = args;
        lastPath = buildPath(ops, pathArgs, ctm);
        break;
      }
      case OPS.stroke:
      case OPS.closeStroke:
      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke: {
        if (lastPath) {
          const isStroke = STROKE_PAINT_OPS.has(fn);
          const isFill = FILL_PAINT_OPS.has(fn);
          const effLineWidth = lineWidth * matrixScale(ctm);
          const shape = classifyShape(lastPath, isStroke, isFill, effLineWidth);
          if (shape) {
            const color = shape.fromFill ? fillColor : strokeColor;
            if (isNearWhite(color)) {
              occluders.push({ ...shape, index: i });
            } else {
              candidates.push({ ...shape, color: toHex(color), index: i });
            }
          }
        }
        lastPath = null;
        break;
      }
      case OPS.endPath:
        lastPath = null; // clip-only path or no-op paint — nothing visible
        break;
      default:
        break;
    }
  }

  return candidates
    .filter((c) => !isCovered(c, occluders, c.index))
    .map((c) => ({ x: c.xmin, y: c.ymin, width: c.xmax - c.xmin, height: c.ymax - c.ymin, color: c.color }));
}
