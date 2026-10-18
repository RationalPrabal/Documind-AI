// Builds a minimal, valid PDF in memory: one array of text lines per page.
// Lets tests use known content without committing binary fixtures.
export function makePdf(pages) {
  const escape = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects = [];
  const add = (body) => objects.push(body) && objects.length; // returns object number

  const catalog = add(null); // placeholders, filled once page ids are known
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageIds = pages.map((lines) => {
    const stream = `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((l) => `(${escape(l)}) Tj T*`).join(' ')} ET`;
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    return add(
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
    );
  });

  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = Buffer.byteLength(out);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
