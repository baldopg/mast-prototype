#!/usr/bin/env node
// Deploy with a guarantee that what goes live is exactly what is committed and pushed.
//
// Netlify is not linked to GitHub, so `git push` publishes nothing and
// `netlify deploy` publishes whatever happens to be on disk. The two can drift
// silently. This refuses to deploy unless they agree, and verifies afterwards
// that production is serving the exact bytes that are in the commit.
//
//   node deploy.mjs          deploy and verify
//   node deploy.mjs --check  verify only, change nothing

import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SITE = 'https://mast-prototype.netlify.app';
const ASSETS = [
  ['public/index.html', '/index.html'],       // presentation page
  ['public/try/index.html', '/try/index.html'], // the prototype itself
];
const checkOnly = process.argv.includes('--check');

const sh = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

let failed = false;
const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg) => { failed = true; console.log(`  FALLO ${msg}`); };

console.log('\nComprobaciones previas\n');

// 1. Nothing uncommitted. Otherwise you publish code that exists nowhere in git.
const dirty = sh('git', ['status', '--porcelain']);
dirty ? bad(`hay cambios sin commitear:\n${dirty.split('\n').map(l => '          ' + l).join('\n')}`)
      : ok('árbol de trabajo limpio');

// 2. HEAD must already be on the remote, or GitHub ends up behind production.
const head = sh('git', ['rev-parse', 'HEAD']);
let remote = '';
try {
  remote = sh('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
} catch {
  bad('no se pudo consultar el remoto');
}
head === remote
  ? ok(`HEAD y origin/main coinciden (${head.slice(0, 8)})`)
  : bad(`HEAD ${head.slice(0, 8)} no está en el remoto (${remote.slice(0, 8) || 'sin respuesta'}). Haz push primero.`);

// 3. Each file on disk must be the file in the commit.
const disk = new Map();
for (const [path] of ASSETS) {
  const onDisk = readFileSync(path);
  disk.set(path, onDisk);
  const inCommit = execFileSync('git', ['show', `HEAD:${path}`], { maxBuffer: 32 * 1024 * 1024 });
  sha(onDisk) === sha(inCommit)
    ? ok(`${path} en disco coincide con el commit`)
    : bad(`${path} en disco difiere del commit`);
}

// In --check mode the point is to inspect production, so a dirty tree is reported
// but does not stop the run. Before a real deploy it does.
if (failed && !checkOnly) {
  console.log('\nAbortado. No se ha desplegado nada.\n');
  process.exit(1);
}

if (!checkOnly) {
  console.log('\nDesplegando\n');
  try {
    // execSync with a fixed string: on Windows `netlify` is a .cmd shim that
    // execFileSync cannot resolve, and passing args alongside shell:true is deprecated.
    const out = execSync('netlify deploy --prod --no-build', { encoding: 'utf8' });
    const url = out.match(/Unique deploy URL:\s*<?(\S+?)>?\s/);
    console.log('  ok    desplegado' + (url ? ` (${url[1]})` : ''));
  } catch (e) {
    console.log('  FALLO el despliegue falló\n' + (e.stdout || e.message));
    process.exit(1);
  }
}

// 4. Production must serve those same bytes. This is the check that actually proves it.
console.log('\nVerificando producción\n');
let mismatch = false;
for (const [path, url] of ASSETS) {
  const res = await fetch(`${SITE}${url}`, { cache: 'no-store' });
  if (!res.ok) {
    mismatch = true;
    console.log(`  FALLO ${url} devolvió ${res.status}`);
    continue;
  }
  const live = Buffer.from(await res.arrayBuffer());
  const expected = sha(disk.get(path));
  if (expected === sha(live)) {
    console.log(`  ok    ${url} coincide (${live.length} bytes, ${expected.slice(0, 12)}…)`);
  } else {
    mismatch = true;
    console.log(`  FALLO ${url} NO coincide`);
    console.log(`        esperado ${expected}`);
    console.log(`        recibido ${sha(live)}`);
  }
}
if (mismatch) process.exit(1);
console.log(`  ok    producción sirve el commit ${head.slice(0, 8)}\n`);

// The README is deliberately gitignored; make sure it never leaks.
const readme = await fetch(`${SITE}/README.md`, { cache: 'no-store' });
readme.status === 404
  ? console.log('  ok    README.md no está expuesto (404)\n')
  : console.log(`  FALLO README.md accesible (${readme.status})\n`);
