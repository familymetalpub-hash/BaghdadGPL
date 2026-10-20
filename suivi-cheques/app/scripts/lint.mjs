#!/usr/bin/env node
/**
 * Contrôle statique minimal, sans dépendance : syntaxe de tous les fichiers
 * JavaScript et présence des garde-fous de sécurité dans le processus principal.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (['node_modules', 'release', 'dist', '.git'].includes(entry)) continue;
      walk(full);
    } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
      files.push(full);
    }
  }
}
walk(join(root, 'src'));
walk(join(root, 'scripts'));

let failures = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures += 1;
    console.error(`✖ syntaxe : ${relative(root, file)}`);
    console.error(String(error.stderr || error.message));
  }
}
console.log(`${files.length - failures}/${files.length} fichiers JavaScript valides`);

const mainSource = readFileSync(join(root, 'src', 'main', 'main.js'), 'utf8');
const required = [
  ['contextIsolation: true', /contextIsolation:\s*true/],
  ['nodeIntegration: false', /nodeIntegration:\s*false/],
  ['sandbox: true', /sandbox:\s*true/],
  ['webSecurity non désactivée', /webSecurity:\s*true/],
];
for (const [label, pattern] of required) {
  if (pattern.test(mainSource)) {
    console.log(`✔ ${label}`);
  } else {
    failures += 1;
    console.error(`✖ ${label} absent de src/main/main.js`);
  }
}

const preload = readFileSync(join(root, 'src', 'preload', 'preload.js'), 'utf8');
if (/contextBridge\.exposeInMainWorld/.test(preload) && /Object\.freeze/.test(preload)) {
  console.log('✔ preload isolé et API figée');
} else {
  failures += 1;
  console.error('✖ le preload doit exposer une API figée via contextBridge');
}

if (failures) {
  console.error(`\n${failures} contrôle(s) en échec.`);
  process.exit(1);
}
console.log('\nContrôles statiques réussis.');
