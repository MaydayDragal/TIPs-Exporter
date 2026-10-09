// Regression fixtures for font state and font decoding; these exercise real PDF streams.
const assert = require('node:assert/strict');
const L = require('../vendor/pdf-lib.min.js');
const scrubber = require('../pdf-scrubber.js')(L);
const { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } = L;
async function test(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ': ' + e.message); process.exitCode = 1; } }
async function fixture(content, fonts) {
  const d = await PDFDocument.create(), c = d.context, p = d.addPage([300, 200]);
  p.node.set(PDFName.of('Resources'), c.obj({ Font: fonts(c) }));
  p.node.set(PDFName.of('Contents'), c.register(c.flateStream(content)));
  return d.save();
}
const standard = c => c.register(c.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
async function stream(bytes) {
  const d = await PDFDocument.load(bytes, { updateMetadata: false });
  const contents = d.getPages()[0].node.Contents();
  const parts = contents instanceof L.PDFArray ? contents.asArray().map(x => d.context.lookup(x)) : [contents];
  return parts.map(x => Buffer.from(decodePDFRawStream(x).decode()).toString('latin1')).join('\n');
}
(async () => {
  await test('removing a matching text block preserves inherited font and text state for later body text', async () => {
    const original = await fixture('BT /F1 16 Tf 1 Tc 90 Tz 20 TL 20 160 Td (D7MASALL) Tj ET BT 20 120 Td (Diagnostic body) Tj ET', c => ({ F1: standard(c) }));
    const out = await scrubber.scrub(original, { strings: ['D7MASALL'] }), s = await stream(out.bytes);
    assert.equal(out.report.removedText.length, 1); assert(!s.includes('D7MASALL')); assert(s.includes('Diagnostic body'));
    assert(s.includes('/F1 16 Tf') && s.includes('1 Tc') && s.includes('90 Tz') && s.includes('20 TL'), 'body must inherit the original font/spacing/scale/leading');
  });
  await test('simple-font Differences are decoded before matching custom text', async () => {
    const original = await fixture('BT /F1 12 Tf 20 160 Td (ABCDEFGH) Tj ET BT /F2 12 Tf 20 120 Td (Body) Tj ET', c => ({
      F1: c.register(c.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [65, 'D', 'seven', 'M', 'A', 'S', 'A', 'L', 'L'] } })), F2: standard(c)
    }));
    const out = await scrubber.scrub(original, { strings: ['D7MASALL'] });
    assert.equal(out.report.removedText.length, 1); assert(!(await stream(out.bytes)).includes('ABCDEFGH'));
  });
  await test('graphics-state restore restores the font used for matching later text', async () => {
    const original = await fixture('BT /F1 16 Tf 20 160 Td (Body text) Tj ET q BT /F2 10 Tf 20 130 Td (D) Tj ET Q BT 20 100 Td (D7MASALL) Tj ET', c => ({
      F1: standard(c), F2: c.register(c.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica',
        ToUnicode: c.register(c.flateStream('1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <44> <0058> endbfchar')) }))
    }));
    const out = await scrubber.scrub(original, { strings: ['D7MASALL'] });
    assert.equal(out.report.removedText.length, 1); assert(!(await stream(out.bytes)).includes('D7MASALL'));
  });
  await test('two-byte ToUnicode mappings remove a timestamp and preserve unrelated text', async () => {
    const word = '02-10-2026 13:55:18';
    const chars = [...new Set(word)], codes = new Map(chars.map((x, i) => [x, i + 1]));
    const hex = x => x.toString(16).padStart(4, '0');
    const cmap = `1 begincodespacerange <0000> <FFFF> endcodespacerange ${chars.length} beginbfchar ` + chars.map(x => `<${hex(codes.get(x))}> <${hex(x.charCodeAt(0))}>`).join(' ') + ' endbfchar';
    const content = `BT /F1 10 Tf 20 20 Td <${[...word].map(x => hex(codes.get(x))).join('')}> Tj ET BT /F2 10 Tf 20 120 Td (Body) Tj ET`;
    const original = await fixture(content, c => ({ F1: c.register(c.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'Test', Encoding: 'Identity-H', ToUnicode: c.register(c.flateStream(cmap)) })), F2: standard(c) }));
    const out = await scrubber.scrub(original, { timestamp: true });
    assert.equal(out.report.removedText.length, 1); assert((await stream(out.bytes)).includes('(Body)'));
  });
  await test('unknown used custom glyph mappings fail explicitly instead of silently retaining text', async () => {
    const original = await fixture('BT /F1 12 Tf 20 100 Td (A) Tj ET', c => ({
      F1: c.register(c.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'CustomFont', Encoding: { Differences: [65, 'unrecognizableCustomGlyph'] } }))
    }));
    await assert.rejects(() => scrubber.scrub(original, { strings: ['D7MASALL'] }), /font|glyph|encoding/i);
  });
  await test('unreadable ToUnicode streams fail cleanup instead of retaining encoded user IDs', async () => {
    const original = await fixture('BT /F1 12 Tf 20 100 Td <00440037004d004100530041004c004c> Tj ET', c => ({
      F1: c.register(c.obj({Type:'Font',Subtype:'Type0',BaseFont:'Test',Encoding:'Identity-H',
        ToUnicode:c.register(L.PDFRawStream.of(c.obj({Filter:'FlateDecode',Length:3}),new Uint8Array([1,2,3])))}))
    }));
    await assert.rejects(()=>scrubber.scrub(original,{strings:['D7MASALL'],timestamp:true}),/compression|unicode|font|encoding/i);
  });
  await test('missing, partial and truncated Type0 mappings cannot silently retain text', async () => {
    for (const [cmap, content] of [
      [null, '<0044>'],
      ['1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0044> <0044> endbfchar', '<00440037>'],
      ['1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0044> <0044> endbfchar', '<004400>']
    ]) {
      const original = await fixture(`BT /F1 12 Tf 20 100 Td ${content} Tj ET`,c=>({
        F1:c.register(c.obj({Type:'Font',Subtype:'Type0',BaseFont:'Test',Encoding:'Identity-H',...(cmap?{ToUnicode:c.register(c.flateStream(cmap))}:{})}))
      }));
      await assert.rejects(()=>scrubber.scrub(original,{strings:['D7MASALL'],timestamp:true}),/unicode|font|mapping|encoding/i);
    }
  });
  await test('encrypted PDFs are rejected', async () => {
    const d = await PDFDocument.create(); d.addPage(); d.context.trailerInfo.Encrypt = d.context.register(d.context.obj({ Filter: 'Standard', V: 1, R: 2 }));
    const b = await d.save(); await assert.rejects(() => scrubber.scrub(b, {}), /encrypt/i);
  });
})().catch(e => { console.error('ERROR ' + e.stack); process.exitCode = 1; });
