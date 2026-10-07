# PDF Max

A free, in-browser PDF editor for résumés. Live at
[pdfmax.giorgis.dev](https://pdfmax.giorgis.dev).

Most free PDF editors flatten your edits into images or leave junk behind, and
applicant tracking systems (ATS) then can't read the file. PDF Max keeps
exported text as real, selectable text with embedded fonts, so the résumé you
export is the résumé a recruiter's software actually parses.

## What it does

- Click any line of text to edit it in place, with the font, size, bold,
  italic and color detected from the original.
- Wraps text automatically and snaps to a grid when you move things around.
- Add new text boxes anywhere on the page.
- Reorder or delete pages, and your work autosaves in the browser.
- Runs a check before export so you catch problems first.
- Nothing is rasterized: pages you didn't touch are passed through unchanged.

## How it works

Pages are rendered with [pdf.js](https://mozilla.github.io/pdf.js/) and edited
and exported with [pdf-lib](https://pdf-lib.js.org/). On a page you edited, the
original text is removed from the page's content stream and all of that page's
text is drawn again at the original baselines, with a matching font embedded
through fontkit. There's no backend, so your PDF stays in your browser.

## Run it locally

```bash
npm install
npm start    # http://localhost:3000
```

Fonts live in `public/fonts/`. See [`public/fonts/README.md`](public/fonts/README.md)
for which ones are bundled. Anything missing falls back to the closest standard
PDF font.

## AI assistance

I built this with help from generative AI (Anthropic's Claude) for code
suggestions and debugging.
