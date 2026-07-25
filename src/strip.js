// Removes all text objects (BT ... ET blocks) from a PDF content stream while
// leaving graphics (lines, fills, images, clipping) untouched. The edited page
// then gets its full text redrawn as real text operators, so nothing is ever
// rasterized and no stale text hides under the new text.

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMS = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

export function stripTextOperators(bytes) {
  const out = [];
  const n = bytes.length;
  let i = 0;
  let inText = false; // inside BT..ET

  const emit = (start, end) => { if (!inText) out.push(bytes.subarray(start, end)); };

  while (i < n) {
    const c = bytes[i];

    if (c === 0x25) { // % comment to end of line
      const start = i;
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      emit(start, i);
      continue;
    }

    if (c === 0x28) { // ( literal string, with \ escapes and nested parens
      const start = i;
      i++;
      let depth = 1;
      while (i < n && depth > 0) {
        if (bytes[i] === 0x5c) i += 2;
        else {
          if (bytes[i] === 0x28) depth++;
          else if (bytes[i] === 0x29) depth--;
          i++;
        }
      }
      emit(start, i);
      continue;
    }

    if (c === 0x3c) { // <hex string> or << dict >>
      if (bytes[i + 1] === 0x3c) { emit(i, i + 2); i += 2; continue; }
      const start = i;
      i++;
      while (i < n && bytes[i] !== 0x3e) i++;
      i++;
      emit(start, i);
      continue;
    }

    if (WHITESPACE.has(c) || DELIMS.has(c)) {
      emit(i, i + 1);
      i++;
      continue;
    }

    // Regular token (operator, number, or keyword)
    const start = i;
    while (i < n && !WHITESPACE.has(bytes[i]) && !DELIMS.has(bytes[i])) i++;
    const tok = String.fromCharCode(...bytes.subarray(start, i));

    if (tok === 'BT') { inText = true; continue; }
    if (tok === 'ET') { inText = false; out.push(new Uint8Array([0x0a])); continue; }

    if (tok === 'BI' && !inText) {
      // Inline image: binary data between ID and EI could contain fake tokens.
      // Copy through verbatim until an EI delimited by whitespace.
      let j = i;
      let idEnd = -1;
      while (j < n - 1) {
        if (bytes[j] === 0x49 && bytes[j + 1] === 0x44 &&
            (j === 0 || WHITESPACE.has(bytes[j - 1]))) { idEnd = j + 2; break; }
        j++;
      }
      if (idEnd === -1) { emit(start, i); continue; }
      let k = idEnd;
      while (k < n - 1) {
        if (bytes[k] === 0x45 && bytes[k + 1] === 0x49 &&
            WHITESPACE.has(bytes[k - 1]) &&
            (k + 2 >= n || WHITESPACE.has(bytes[k + 2]) || DELIMS.has(bytes[k + 2]))) {
          k += 2;
          break;
        }
        k++;
      }
      emit(start, k);
      i = k;
      continue;
    }

    emit(start, i);
  }

  // Concatenate segments
  let total = 0;
  for (const seg of out) total += seg.length;
  const result = new Uint8Array(total);
  let off = 0;
  for (const seg of out) { result.set(seg, off); off += seg.length; }
  return result;
}
