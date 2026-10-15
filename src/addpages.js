import { PDFDocument } from 'pdf-lib';

// Appends pages to a PDF's bytes: a blank page, or the pages of other PDFs /
// images. Existing pages keep their indices (new ones go on the end), so edits
// already made to them stay attached to the right page.

const LETTER = [612, 792];

export async function appendBlankPage(bytes, size) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  doc.addPage(size || LETTER);
  return { bytes: await doc.save(), added: 1 };
}

export async function appendFiles(bytes, files) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  let added = 0;
  const skipped = [];
  for (const file of files) {
    const data = new Uint8Array(await file.arrayBuffer());
    try {
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        const src = await PDFDocument.load(data, { ignoreEncryption: true });
        const pages = await doc.copyPages(src, src.getPageIndices());
        pages.forEach((p) => doc.addPage(p));
        added += pages.length;
      } else if (/\.(png)$/i.test(file.name) || file.type === 'image/png' || /\.(jpe?g)$/i.test(file.name) || file.type === 'image/jpeg') {
        const img = /png/i.test(file.type) || /\.png$/i.test(file.name) ? await doc.embedPng(data) : await doc.embedJpg(data);
        const [pw, ph] = LETTER;
        const scale = Math.min(pw / img.width, ph / img.height, 1);
        const w = img.width * scale, h = img.height * scale;
        const page = doc.addPage(LETTER);
        page.drawImage(img, { x: (pw - w) / 2, y: ph - h - (ph - h) / 2, width: w, height: h });
        added += 1;
      } else {
        skipped.push(file.name);
      }
    } catch {
      skipped.push(file.name);
    }
  }
  return { bytes: added ? await doc.save() : bytes, added, skipped };
}
