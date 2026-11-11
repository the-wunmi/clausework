import { DomainError } from '@clausework/core';

/**
 * The text layer of a PDF, which is what clause quotes are checked against and highlighted in.
 * The model reads the PDF itself (layout, tables, scans); code only needs the words.
 */
export async function pdfText(base64: string): Promise<{ text: string; pages: number }> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(Buffer.from(base64, 'base64'));
  const task = getDocument({ data, useSystemFonts: true });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch {
    throw new DomainError('invalid', 'That file is not a readable PDF');
  }
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let line = '';
    const lines: string[] = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line.trimEnd());
        line = '';
      }
    }
    if (line) lines.push(line.trimEnd());
    pages.push(lines.join('\n'));
  }
  await task.destroy();
  const text = pages
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length < 40) {
    throw new DomainError(
      'invalid',
      'This PDF has no text layer (it may be a scan). Upload a text PDF or paste the text.',
    );
  }
  return { text, pages: doc.numPages };
}
