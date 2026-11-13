// Stand-ins for the few Node features the folder-module tests use, so those tests can run in a Chrome page
// on a PC without Node (see run-in-chrome.ps1). Only what documents-folder.test.js, document-exceptions.test.js
// and library-layout.test.js need: assert, Buffer, createHash('sha256'), fs.existsSync, path.join.
(() => {
  const lines = [];
  const log = (...a) => { lines.push(a.map(x => typeof x === 'string' ? x : String(x)).join(' ')); document.getElementById('out').textContent = lines.join('\n'); };

  // --- synchronous SHA-256 (crypto.subtle is asynchronous; Node's createHash is not)
  const K = new Uint32Array(64); { let n = 0; for (let c = 2; n < 64; c++) { let prime = true; for (let d = 2; d * d <= c; d++) if (c % d === 0) { prime = false; break; } if (prime) K[n++] = (Math.cbrt(c) % 1) * 4294967296; } }
  function sha256(bytes) {
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const size = bytes.length, total = ((size + 9 + 63) >> 6) << 6, m = new Uint8Array(total), view = new DataView(m.buffer), w = new Uint32Array(64);
    m.set(bytes); m[size] = 0x80; view.setUint32(total - 8, Math.floor(size / 536870912)); view.setUint32(total - 4, (size << 3) >>> 0);
    const rot = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < total; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) { const a = w[i - 15], b = w[i - 2]; w[i] = (w[i - 16] + (rot(a, 7) ^ rot(a, 18) ^ (a >>> 3)) + w[i - 7] + (rot(b, 17) ^ rot(b, 19) ^ (b >>> 10))) >>> 0; }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return Array.from(H, x => x.toString(16).padStart(8, '0')).join('');
  }

  class Buffer extends Uint8Array {
    static from(x) { return typeof x === 'string' ? new Buffer(new TextEncoder().encode(x)) : x instanceof ArrayBuffer ? new Buffer(new Uint8Array(x)) : new Buffer(x); }
    static concat(list) { const b = new Buffer(list.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of list) { b.set(x, o); o += x.length; } return b; }
    toString(encoding) {
      if (encoding === 'base64') { let s = ''; for (const c of this) s += String.fromCharCode(c); return btoa(s); }
      if (encoding === 'hex') return Array.from(this, b => b.toString(16).padStart(2, '0')).join('');
      return new TextDecoder().decode(this);
    }
  }

  // Chrome prints the page as soon as it has loaded, without waiting for work that happens off the page's own
  // thread. Real Blobs and crypto.subtle work that way, so the tests get stand-ins that answer at once.
  const bytesOf = data => data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  Object.defineProperty(crypto.subtle, 'digest', { value: async (algorithm, data) => {
    const hex = sha256(bytesOf(data)), out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out.buffer;
  } });
  if (sha256(new TextEncoder().encode('abc')) !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') log('ERROR the runner\'s SHA-256 is wrong');
  class MemoryBlob {
    constructor(parts = []) { this.bytes = Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p) : bytesOf(p))); }
    get size() { return this.bytes.length; }
    slice(start = 0, end = this.size) { const b = new MemoryBlob(); b.bytes = this.bytes.slice(start, end); return b; }
    async arrayBuffer() { return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength); }
    async text() { return new TextDecoder().decode(this.bytes); }
  }

  const show = v => { try { return JSON.stringify(v) ?? String(v); } catch (_) { return String(v); } };
  function same(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k]));
  }
  const matches = (e, expected) => !expected || (expected instanceof RegExp ? expected.test(e.message) : typeof expected === 'function' ? expected(e) !== false : true);
  function assert(value, message) { if (!value) throw new Error(message || 'expected a true value, got ' + show(value)); }
  assert.ok = assert;
  assert.equal = assert.strictEqual = (a, b, m) => { if (!Object.is(a, b)) throw new Error(m || `expected ${show(a)} to equal ${show(b)}`); };
  assert.notEqual = assert.notStrictEqual = (a, b, m) => { if (Object.is(a, b)) throw new Error(m || `expected ${show(a)} to differ`); };
  assert.deepEqual = assert.deepStrictEqual = (a, b, m) => { if (!same(a, b)) throw new Error(m || `expected ${show(a)} to deep-equal ${show(b)}`); };
  assert.match = (s, re, m) => { if (!re.test(s)) throw new Error(m || `expected ${show(s)} to match ${re}`); };
  assert.throws = (fn, expected) => { let error; try { fn(); } catch (e) { error = e; } if (!error) throw new Error('expected a throw'); if (!matches(error, expected)) throw new Error(`threw "${error.message}", expected ${expected}`); };
  assert.rejects = async (p, expected) => { let error; try { await (typeof p === 'function' ? p() : p); } catch (e) { error = e; } if (!error) throw new Error('expected a rejection'); if (!matches(error, expected)) throw new Error(`rejected with "${error.message}", expected ${expected}`); };

  const modules = {
    'node:assert/strict': assert, 'assert': assert,
    'node:crypto': { webcrypto: crypto, createHash: () => { const parts = []; const h = { update(x) { parts.push(typeof x === 'string' ? Buffer.from(x) : x); return h; }, digest: () => sha256(Buffer.concat(parts)) }; return h; } },
    'node:buffer': { Blob: MemoryBlob, Buffer }, 'node:fs': { existsSync: () => true }, 'node:path': { join: (...a) => a.join('/') }
  };
  const key = name => name.replace(/^(\.\.?\/)+/, '').replace(/\.js$/, '');
  const require = name => {
    if (modules[name]) return modules[name];
    const k = key(name), globals = { 'index-csv': 'TIPSIndexCsv', 'documents-client': 'TIPSDocumentsClient', 'documents-folder': 'TIPSDocumentsFolder' };
    if (modules[k]) return modules[k];
    if (globals[k] && globalThis[globals[k]]) return globalThis[globals[k]];
    throw new Error('This browser runner has no stand-in for require("' + name + '")');
  };
  const process = { exitCode: 0, exit(code) { if (code) log('ERROR the test ended with exit code ' + code); } };
  const consoleLike = { log, warn: log, error: log };
  // A CommonJS file, wrapped in a function by run-in-chrome.ps1 so its top-level names stay its own.
  window.__define = (name, body) => { const module = { exports: {} }; body(module, module.exports, require, process, consoleLike, '', Buffer); modules[key(name)] = module.exports; };
  window.__run = body => {
    window.addEventListener('unhandledrejection', e => log('ERROR unhandled rejection: ' + (e.reason?.stack || e.reason)));
    try { body({ exports: {} }, {}, require, process, consoleLike, '', Buffer); } catch (e) { log('ERROR ' + (e.stack || e)); }
  };
})();
