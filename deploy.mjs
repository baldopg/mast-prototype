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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SITE = 'https://mast-prototype.netlify.app';
const ASSET = 'public/index.html';
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

// 3. The file on disk must be the file in the commit.
const onDisk = readFileSync(ASSET);
const inCommit = execFileSync('git', ['show', `HEAD:${ASSET}`], { maxBuffer: 32 * 1024 * 1024 });
sha(onDisk) === sha(inCommit)
  ? ok(`${ASSET} en disco coincide con el commit`)
  : bad(`${ASSET} en disco difiere del commit`);

// In --check mode the point is to inspect production, so a dirty tree is reported
// but does not stop the run. Before a real deploy it does.
if (failed && !checkOnly) {
  console.log('\nAbortado. No se ha desplegado nada.\n');
  process.exit(1);
}

if (!checkOnly) {
  console.log('\nDesplegando\n');
  try {
    const out = execFileSync('netlify', ['deploy', '--prod', '--no-build'], { encoding: 'utf8' });
    const url = out.match(/Unique deploy URL:\s*<?(\S+?)>?\s/);
    console.log('  ok    desplegado' + (url ? ` (${url[1]})` : ''));
  } catch (e) {
    console.log('  FALLO el despliegue falló\n' + (e.stdout || e.message));
    process.exit(1);
  }
}

// 4. Production must serve those same bytes. This is the check that actually proves it.
console.log('\nVerificando producción\n');
const res = await fetch(`${SITE}/index.html`, { cache: 'no-store' });
if (!res.ok) {
  console.log(`  FALLO ${SITE} devolvió ${res.status}`);
  process.exit(1);
}
const live = Buffer.from(await res.arrayBuffer());
const expected = sha(onDisk);
const actual = sha(live);

if (expected === actual) {
  console.log(`  ok    producción sirve el commit ${head.slice(0, 8)}`);
  console.log(`        sha256 ${expected}`);
  console.log(`        ${live.length} bytes\n`);
} else {
  console.log('  FALLO producción NO sirve esta versión');
  console.log(`        esperado ${expected}`);
  console.log(`        recibido ${actual}\n`);
  process.exit(1);
}

// The README is deliberately gitignored; make sure it never leaks.
const readme = await fetch(`${SITE}/README.md`, { cache: 'no-store' });
readme.status === 404
  ? console.log('  ok    README.md no está expuesto (404)\n')
  : console.log(`  FALLO README.md accesible (${readme.status})\n`);
