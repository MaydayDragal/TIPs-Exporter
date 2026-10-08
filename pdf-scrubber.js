/* PDF scrub engine adapted from the supplied LI PDF Scrub.html.
 * Runs in the extension isolated world with the bundled pdf-lib; no network calls. */
(function (root) {
"use strict";
function makeScrubber(L) {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream, PDFStream, PDFNumber, PDFString, PDFHexString, decodePDFRawStream } = L;

  /* ---- byte <-> binary string ---- */
  function b2s(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return s; }
  function s2b(s) { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; }

  /* ---- content stream tokenizer ---- */
  const WS = c => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
  const DELIM = c => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
  function tokenize(s) {
    const toks = []; let i = 0; const n = s.length;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (WS(c)) { i++; continue; }
      if (c === 37) { while (i < n && s[i] !== "\n" && s[i] !== "\r") i++; continue; }
      const start = i;
      if (c === 40) { // literal string
        let depth = 0, out = "";
        i++;
        for (; i < n; i++) {
          const ch = s[i];
          if (ch === "\\") {
            const nx = s[++i];
            if (nx === "n") out += "\n"; else if (nx === "r") out += "\r"; else if (nx === "t") out += "\t";
            else if (nx === "b") out += "\b"; else if (nx === "f") out += "\f";
            else if (nx >= "0" && nx <= "7") { let o = nx; while (o.length < 3 && s[i + 1] >= "0" && s[i + 1] <= "7") o += s[++i]; out += String.fromCharCode(parseInt(o, 8) & 255); }
            else if (nx === "\r") { if (s[i + 1] === "\n") i++; }
            else if (nx === "\n") { }
            else out += nx;
          } else if (ch === "(") { depth++; out += ch; }
          else if (ch === ")") { if (depth === 0) { i++; break; } depth--; out += ch; }
          else out += ch;
        }
        toks.push({ t: "str", v: out, s: start, e: i }); continue;
      }
      if (c === 60 && s[i + 1] === "<") { toks.push({ t: "<<", s: i, e: i + 2 }); i += 2; continue; }
      if (c === 62 && s[i + 1] === ">") { toks.push({ t: ">>", s: i, e: i + 2 }); i += 2; continue; }
      if (c === 60) { // hex string
        const j = s.indexOf(">", i); const hex = s.slice(i + 1, j < 0 ? n : j).replace(/[^0-9a-fA-F]/g, "");
        const h = hex.length % 2 ? hex + "0" : hex; let out = "";
        for (let k = 0; k < h.length; k += 2) out += String.fromCharCode(parseInt(h.substr(k, 2), 16));
        i = j < 0 ? n : j + 1; toks.push({ t: "str", v: out, s: start, e: i }); continue;
      }
      if (c === 91 || c === 93 || c === 123 || c === 125) { toks.push({ t: s[i], s: i, e: i + 1 }); i++; continue; }
      if (c === 47) { i++; while (i < n && !WS(s.charCodeAt(i)) && !DELIM(s.charCodeAt(i))) i++; toks.push({ t: "name", v: s.slice(start + 1, i).replace(/#([\da-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), s: start, e: i }); continue; }
      while (i < n && !WS(s.charCodeAt(i)) && !DELIM(s.charCodeAt(i))) i++;
      if (i === start) { i++; continue; }
      const w = s.slice(start, i);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) { toks.push({ t: "num", v: +w, s: start, e: i }); continue; }
      toks.push({ t: "op", v: w, s: start, e: i });
      if (w === "ID") { // inline image data: skip to EI
        let j = i + 1;
        while (j < n) { const k = s.indexOf("EI", j); if (k < 0) { j = n; break; } if (WS(s.charCodeAt(k - 1)) && (k + 2 >= n || WS(s.charCodeAt(k + 2)))) { j = k; break; } j = k + 2; }
        i = j;
      }
    }
    return toks;
  }

  /* ---- ToUnicode CMap parsing ---- */
  function hexToUni(h) { let out = ""; for (let k = 0; k + 4 <= h.length; k += 4) out += String.fromCharCode(parseInt(h.substr(k, 4), 16)); if (h.length === 2) out = String.fromCharCode(parseInt(h, 16)); return out; }
  function parseCMap(text) {
    const map = new Map(); let bytes = 1;
    const cs = text.match(/begincodespacerange\s*<([0-9a-fA-F]+)>/); if (cs) bytes = cs[1].length / 2;
    for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
      for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), hexToUni(m[2]));
    for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]*)>|\[([^\]]*)\])/g; let m;
      while ((m = re.exec(blk[1]))) {
        const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
        if (m[4] != null) { const base = m[4]; const last = parseInt(base.slice(-4) || base, 16); const pre = base.length > 4 ? hexToUni(base.slice(0, -4)) : "";
          for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, pre + String.fromCharCode(last + (c - lo))); }
        else { const arr = [...m[5].matchAll(/<([0-9a-fA-F]*)>/g)].map(x => hexToUni(x[1])); for (let c = lo; c <= hi; c++) map.set(c, arr[c - lo] || ""); }
      }
    }
    return { map, bytes };
  }

  function streamBytes(obj) {
    if (obj instanceof PDFRawStream) return decodePDFRawStream(obj).decode();
    if (obj && typeof obj.getContents === "function") return obj.getContents();
    return new Uint8Array(0);
  }

  // Common Adobe glyph names used by export-user IDs and timestamps, plus explicit Unicode names.
  const GLYPHS = Object.fromEntries([
    ...'zero one two three four five six seven eight nine'.split(' ').map((n, i) => [n, String(i)]),
    ...'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash'.split(' ').map((n, i) => [n, String.fromCharCode(32 + i)]),
    ...'colon semicolon less equal greater question at'.split(' ').map((n, i) => [n, String.fromCharCode(58 + i)]),
    ...'bracketleft backslash bracketright asciicircum underscore grave'.split(' ').map((n, i) => [n, String.fromCharCode(91 + i)]),
    ...'braceleft bar braceright asciitilde'.split(' ').map((n, i) => [n, String.fromCharCode(123 + i)])
  ]);
  function glyphText(name) {
    name = name.split('.')[0];
    if (/^[A-Za-z]$/.test(name)) return name;
    if (Object.prototype.hasOwnProperty.call(GLYPHS, name)) return GLYPHS[name];
    if (/^uni(?:[\da-f]{4})+$/i.test(name)) return hexToUni(name.slice(3));
    if (/^u[\da-f]{4,6}$/i.test(name) && parseInt(name.slice(1), 16) <= 0x10ffff) return String.fromCodePoint(parseInt(name.slice(1), 16));
    return null;
  }
  function simpleDecoder(ctx, fontDict) {
    const enc = ctx.lookup(fontDict.get(PDFName.of('Encoding')));
    const diffs = enc instanceof PDFDict ? ctx.lookup(enc.get(PDFName.of('Differences'))) : null;
    const map = new Map();
    if (diffs instanceof PDFArray) {
      let code = 0;
      for (const value of diffs.asArray()) {
        if (value instanceof PDFNumber) code = value.asNumber();
        else if (value instanceof PDFName) map.set(code++, glyphText(value.decodeText()));
      }
    }
    return s => {
      let text = '';
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (!map.has(code)) { text += ch; continue; }
        const glyph = map.get(code);
        if (glyph == null) throw new Error('Unsupported custom font glyph encoding');
        text += glyph;
      }
      return text;
    };
  }

  function fontDecoder(ctx, fontDict, cache) {
    if (!fontDict) return s => s;
    const key = fontDict; if (cache.has(key)) return cache.get(key);
    let dec;
    const tu = ctx.lookup(fontDict.get(PDFName.of("ToUnicode")));
    const sub = String(fontDict.get(PDFName.of("Subtype")) || "");
    const twoByte = sub === "/Type0";
    if (tu && (tu instanceof PDFRawStream || tu instanceof PDFStream)) {
      let cm; try { cm = parseCMap(b2s(streamBytes(tu))); } catch { cm = { map: new Map(), bytes: twoByte ? 2 : 1 }; }
      const w = twoByte ? 2 : cm.bytes;
      dec = s => { let o = ""; for (let i = 0; i + w <= s.length; i += w) { const code = w === 2 ? (s.charCodeAt(i) << 8) | s.charCodeAt(i + 1) : s.charCodeAt(i); const u = cm.map.get(code); o += u != null ? u : (w === 1 ? s[i] : ""); } return o; };
    } else if (twoByte) dec = s => { let o = ""; for (let i = 0; i + 1 < s.length; i += 2) o += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1)); return o; };
    else dec = simpleDecoder(ctx, fontDict);
    cache.set(key, dec); return dec;
  }

  /* ---- find & drop matching text blocks in one content stream ---- */
  function scrubContent(bytes, fonts, decode, rules, report, xobjHandler) {
    const s = b2s(bytes);
    const toks = tokenize(s);
    const drop = [];
    let inBT = false, btStart = 0, text = "", font = null, operands = [], blockTokens = [];
    const fontStack = [];
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (inBT) blockTokens.push(t);
      if (t.t !== "op") { operands.push(t); continue; }
      const op = t.v;
      if (op === "BT") { inBT = true; btStart = t.s; text = ""; blockTokens = [t]; }
      else if (op === "ET" && inBT) {
        inBT = false;
        const clean = text.replace(/\s+/g, " ").trim();
        const hit = matchRule(clean, rules);
        if (hit) {
          // Text/graphics state (especially Tf) survives ET and may be used by a later block.
          // Clear every string in the matched block, including marked-content strings, while
          // retaining its operators. Rebuilding from tokens also discards comments/old bytes.
          const empty = blockTokens.map(x => x.t === 'str' ? '()' : s.slice(x.s, x.e)).join(' ');
          drop.push([btStart, t.e, empty]); report.push({ text: clean, rule: hit });
        }
      } else if (op === 'q') { fontStack.push(font); }
      else if (op === 'Q') { font = fontStack.pop() || null;
      } else if (op === "Tf") { const nm = operands.find(o => o.t === "name"); font = nm ? fonts(nm.v) : null; }
      else if (op === "Tj" || op === "'" || op === "\"") { const st = operands.filter(o => o.t === "str").pop(); if (st) text += decode(font, st.v); }
      else if (op === "TJ") {
        let j = operands.length - 1; while (j >= 0 && operands[j].t !== "[") j--;
        for (let q = j + 1; q < operands.length; q++) { const o = operands[q]; if (o.t === "str") text += decode(font, o.v); else if (o.t === "num" && o.v < -200) text += " "; }
      } else if ((op === "Td" || op === "TD" || op === "T*" || op === "Tm") && inBT && text && !/\s$/.test(text)) text += " ";
      else if (op === "Do" && xobjHandler) { const nm = operands.find(o => o.t === "name"); if (nm) xobjHandler(nm.v); }
      operands = [];
    }
    if (!drop.length) return null;
    let out = "", last = 0;
    for (const [a, b, replacement] of drop) { out += s.slice(last, a) + replacement; last = b; }
    out += s.slice(last);
    return s2b(out);
  }
  function matchRule(text, rules) {
    if (!text) return null;
    for (const r of rules.strings) if (r && text.toUpperCase().includes(r.toUpperCase())) return r;
    if (rules.timestamp && /^\d{2}[-./]\d{2}[-./]\d{4}\s+\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i.test(text)) return "print timestamp";
    return null;
  }

  async function deflate(u8) {
    const cs = new CompressionStream("deflate");
    const buf = await new Response(new Blob([u8]).stream().pipeThrough(cs)).arrayBuffer();
    return new Uint8Array(buf);
  }
  function newStreamDict(ctx, oldDict, len) {
    const d = ctx.obj({});
    if (oldDict) for (const [k, v] of oldDict.entries()) { const n = k.asString(); if (n === "/Filter" || n === "/DecodeParms" || n === "/Length" || n === "/DL") continue; d.set(k, v); }
    d.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
    d.set(PDFName.of("Length"), PDFNumber.of(len));
    return d;
  }

  const META_KEYS = ["Metadata", "PieceInfo", "LastModified"];

  async function scrub(bytes, opts = {}) {
    const report = { removedText: [], metadata: [], errors: [] };
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: true });
    if (!doc.getPageCount()) throw new Error("PDF has no pages");
    const ctx = doc.context;

    // --- document metadata ---
    const ti = ctx.trailerInfo;
    if (ti.Info) {
      const info = ctx.lookup(ti.Info);
      if (info instanceof PDFDict) for (const [k, v] of info.entries()) report.metadata.push(k.asString().slice(1) + ": " + pdfVal(v));
      ti.Info = undefined;
    }
    if (ti.ID) { report.metadata.push("File ID"); ti.ID = undefined; }

    // --- text removal ---
    const rules = { strings: opts.strings || [], timestamp: !!opts.timestamp };
    const decCache = new Map();
    const decode = (fontDict, str) => fontDecoder(ctx, fontDict, decCache)(str);
    const doneForms = new Set();

    async function processStream(contentBytes, resources) {
      const fontsDict = resources ? ctx.lookup(resources.get(PDFName.of("Font"))) : null;
      const xoDict = resources ? ctx.lookup(resources.get(PDFName.of("XObject"))) : null;
      const fonts = nm => fontsDict instanceof PDFDict ? ctx.lookup(fontsDict.get(PDFName.of(nm))) : null;
      const forms = [];
      const res = scrubContent(contentBytes, fonts, decode, rules, report.removedText, nm => {
        if (!(xoDict instanceof PDFDict)) return;
        const ref = xoDict.get(PDFName.of(nm));
        if (ref instanceof PDFRef && !doneForms.has(ref.toString())) forms.push(ref);
      });
      for (const ref of forms) {
        if (doneForms.has(ref.toString())) continue;
        doneForms.add(ref.toString());
        const x = ctx.lookup(ref);
        if (!x || !x.dict || String(x.dict.get(PDFName.of("Subtype"))) !== "/Form") continue;
        const res2 = ctx.lookup(x.dict.get(PDFName.of("Resources"))) || resources;
        const out = await processStream(streamBytes(x), res2 instanceof PDFDict ? res2 : resources);
        if (out) { const z = await deflate(out); ctx.assign(ref, PDFRawStream.of(newStreamDict(ctx, x.dict, z.length), z)); }
      }
      return res;
    }

    if (rules.strings.length || rules.timestamp) {
      for (const page of doc.getPages()) {
        const node = page.node;
        const cRaw = node.get(PDFName.of("Contents"));
        if (!cRaw) continue;
        const c = ctx.lookup(cRaw);
        let refs = [];
        if (c instanceof PDFArray) refs = c.asArray();
        else refs = [cRaw];
        const parts = refs.map(r => streamBytes(ctx.lookup(r)));
        const joined = new Uint8Array(parts.reduce((s, p) => s + p.length + 1, 0));
        let o = 0; for (const p of parts) { joined.set(p, o); o += p.length; joined[o++] = 10; }
        const res = node.Resources();
        const out = await processStream(joined, res);
        if (out) {
          const z = await deflate(out);
          const st = PDFRawStream.of(newStreamDict(ctx, null, z.length), z);
          node.set(PDFName.of("Contents"), ctx.register(st));
        }
      }
    }

    // --- XMP / app data on catalog, pages, and any other object ---
    let metaStrips = 0;
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      const dict = obj instanceof PDFDict ? obj : (obj && obj.dict instanceof PDFDict ? obj.dict : null);
      if (!dict) continue;
      for (const k of META_KEYS) if (dict.has(PDFName.of(k))) { dict.delete(PDFName.of(k)); metaStrips++; }
    }
    if (metaStrips) report.metadata.push("Embedded XMP / application data (" + metaStrips + ")");

    // --- drop anything no longer reachable (old Info, XMP streams, replaced content) ---
    const keep = new Set();
    const stack = [ti.Root];
    while (stack.length) {
      const v = stack.pop();
      if (!v) continue;
      if (v instanceof PDFRef) { const k = v.toString(); if (keep.has(k)) continue; keep.add(k); stack.push(ctx.lookup(v)); continue; }
      if (v instanceof PDFDict) { for (const [, x] of v.entries()) stack.push(x); continue; }
      if (v instanceof PDFArray) { for (const x of v.asArray()) stack.push(x); continue; }
      if (v.dict instanceof PDFDict) stack.push(v.dict);
    }
    let dropped = 0;
    for (const [ref] of ctx.enumerateIndirectObjects()) if (!keep.has(ref.toString())) { ctx.delete(ref); dropped++; }
    report.orphans = dropped;

    const out = await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
    return { bytes: out, report };
  }
  function pdfVal(v) {
    try { if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText(); } catch {}
    return String(v);
  }
  return { scrub };
}

if (typeof module === "object" && module.exports) module.exports = makeScrubber;
else if (root.PDFLib) root.TIPSPdfScrubber = makeScrubber(root.PDFLib);
})(globalThis);
