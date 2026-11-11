/**
 * Typesets the sample agreements as PDFs, so the demo uploads a real document: the model reads the
 * PDF, and code checks its quotes against the PDF's own text layer.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument, type PDFFont, rgb, StandardFonts } from 'pdf-lib';

const DIR = new URL('./contracts/', import.meta.url);
const PAGE = { width: 612, height: 792, margin: 72 };
const SIZE = 10.5;
const LEADING = 15;

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

async function build(name: string): Promise<void> {
  const text = readFileSync(new URL(name, DIR), 'utf8').replace(/×/g, 'x');
  const pdf = await PDFDocument.create();
  pdf.setTitle(name.replace('.txt', ''));
  const body = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const width = PAGE.width - 2 * PAGE.margin;
  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.margin;
  let pageNo = 1;
  const footer = () =>
    page.drawText(`Page ${pageNo}`, {
      x: PAGE.width / 2 - 14,
      y: 40,
      size: 8,
      font: body,
      color: rgb(0.4, 0.4, 0.4),
    });
  footer();
  const paragraphs = text.split(/\n\s*\n/);
  paragraphs.forEach((para, i) => {
    const heading =
      i === 0 || /^[0-9]+\.\s+[A-Z][A-Z ,&]+$/.test(para.trim()) || /^SCHEDULE /.test(para.trim());
    const font = heading ? bold : body;
    const size = i === 0 ? 14 : heading ? 11.5 : SIZE;
    for (const line of wrap(para.trim(), font, size, width)) {
      if (y < PAGE.margin) {
        page = pdf.addPage([PAGE.width, PAGE.height]);
        pageNo++;
        footer();
        y = PAGE.height - PAGE.margin;
      }
      page.drawText(line, { x: PAGE.margin, y, size, font, color: rgb(0.08, 0.09, 0.12) });
      y -= i === 0 ? 20 : LEADING;
    }
    y -= heading ? 6 : 8;
  });
  writeFileSync(new URL(name.replace('.txt', '.pdf'), DIR), await pdf.save());
}

for (const f of readdirSync(DIR).filter((f) => f.endsWith('.txt'))) await build(f);
console.log('built sample PDFs');
