// Runs every tests/*.test.js (jsdom simulations of the TIPS Reader) and fails if any check fails.
const { spawnSync } = require('child_process');
const fs = require('fs'), path = require('path');
const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
let pass = 0, fail = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', timeout: 15 * 60 * 1000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const p = (out.match(/^PASS /gm) || []).length, bad = out.split('\n').filter(l => /^(FAIL|ERROR)\b/.test(l));
  pass += p; fail += bad.length + (r.status && !bad.length ? 1 : 0);
  console.log(`${bad.length || r.status ? '✗' : '✓'} ${f.padEnd(26)} ${p} passed${bad.length ? ', ' + bad.length + ' failed' : ''}`);
  bad.forEach(l => console.log('    ' + l));
}
console.log(`\n${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
