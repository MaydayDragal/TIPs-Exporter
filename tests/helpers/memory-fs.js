const { Blob } = require('node:buffer');
const fail = name => Object.assign(new Error(name), { name });
function directory(name = 'LI archive', state = { permission: 'granted', failClose: false, writes: [], clock: 1 }) {
  const children = new Map();
  const dir = { kind: 'directory', name, children, state,
    queryPermission: async () => state.permission,
    requestPermission: async () => (state.permission = 'granted'),
    async *values() { yield* children.values(); },
    async *entries() { yield* children.entries(); },
    async getDirectoryHandle(n, o = {}) {
      if (!children.has(n)) { if (!o.create) throw fail('NotFoundError'); children.set(n, directory(n, state)); }
      const c = children.get(n); if (c.kind !== 'directory') throw fail('TypeMismatchError'); return c;
    },
    async getFileHandle(n, o = {}) {
      if (!children.has(n)) {
        if (!o.create) throw fail('NotFoundError');
        const f = { kind: 'file', name: n, bytes: new Uint8Array(), modified: state.clock++,
          async getFile() { const b = new Blob([f.bytes]); Object.defineProperties(b, { name: { value: n }, lastModified: { value: f.modified } }); return b; },
          async createWritable() { if (state.failOpen) throw fail('NoModificationAllowedError'); let parts = []; return {
            async write(data) { if (state.permission !== 'granted') throw fail('NotAllowedError'); parts.push(new Uint8Array(data)); },
            async close() { if (state.failClose) throw fail('NoModificationAllowedError'); f.bytes = new Uint8Array(Buffer.concat(parts.map(x => Buffer.from(x)))); f.modified = state.clock++; state.writes.push(n); },
            async abort() { parts = []; }
          }; }
        }; children.set(n, f);
      }
      const c = children.get(n); if (c.kind !== 'file') throw fail('TypeMismatchError'); return c;
    },
    async removeEntry(n) { children.delete(n); },
    async put(path, data) { const bits = path.split('/'), n = bits.pop(); let d = dir; for (const p of bits) d = await d.getDirectoryHandle(p, { create: true }); const f = await d.getFileHandle(n, { create: true }); f.bytes = new Uint8Array(typeof data === 'string' ? Buffer.from(data) : data); return f; },
    async read(path) { const bits = path.split('/'), n = bits.pop(); let d = dir; for (const p of bits) d = await d.getDirectoryHandle(p); return Buffer.from((await d.getFileHandle(n)).bytes).toString(); }
  }; return dir;
}
module.exports = { directory };
