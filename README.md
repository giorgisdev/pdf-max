# PDF Resume Editor

Localhost PDF editor focused on ATS-safe resume editing. Renders with
**pdf.js**, edits/exports with **pdf-lib** — exported text is always real,
selectable, copy-pasteable text with embedded fonts. Nothing is ever
rasterized.

## Setup

```bash
npm install
npm start        # → http://localhost:3000
```

## Usage

1. Drag a PDF onto the drop zone (or click **Select file**).
2. Click any text line to edit it inline. A toolbar appears with the
   auto-detected font, size, bold/italic, and color — change any of them.
   Enter or click away commits; Esc cancels.
3. **+ Add text**, then click anywhere on a page to place a new text box
   (multi-line supported with Enter).
4. **Export PDF** downloads `<name>-edited.pdf`.

## How text integrity is preserved

- Pages you didn't touch are passed through byte-for-byte.
- On an edited page, the original text operators (`BT…ET` blocks) are removed
  from the content stream — graphics and layout stay — and *all* text on that
  page is re-drawn as fresh text operators at the original baselines, with the
  matched font embedded (subset) via fontkit. No hidden duplicate text, no
  images, fully parseable by ATS scanners.

## Fonts

Drop `.ttf`/`.otf` files into `public/fonts/` — see
[`public/fonts/README.md`](public/fonts/README.md) for the exact filenames
(Ibarra Real Nova, Libre Caslon Text, Times New Roman, Symbol, plus the
standard set). On load, the app parses the PDF's embedded font names and maps
each text region to the matching family/weight automatically; a banner lists
every detected font and whether it will use a bundled file or fall back to the
closest standard font (Helvetica / Times Roman / Symbol).
