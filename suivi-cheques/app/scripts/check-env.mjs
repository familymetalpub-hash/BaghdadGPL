#!/usr/bin/env node
/**
 * Vérifie que l'environnement permet d'exécuter et de construire l'application.
 * N'installe rien : signale simplement ce qui manque.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const lines = [];

const major = Number(process.versions.node.split('.')[0]);
lines.push(`Node.js ${process.version}${major >= 22 ? ' ✔' : ' ✖ (22 ou plus requis)'}`);
if (major < 22) problems.push('Node.js 22+ requis');

const modules = ['better-sqlite3', 'zod', 'exceljs', 'pdfkit', 'adm-zip'];
for (const name of modules) {
  const present = existsSync(join(root, 'node_modules', name));
  lines.push(`Module ${name} ${present ? '✔' : '✖ (npm install requis)'}`);
  if (!present) problems.push(`module manquant : ${name}`);
}

const electronDist = join(root, 'node_modules', 'electron', 'dist');
const electronOk = existsSync(electronDist) && readdirSync(electronDist).length > 0;
lines.push(`Binaire Electron ${electronOk ? '✔' : '✖ (téléchargement postinstall incomplet)'}`);
if (!electronOk) problems.push('binaire Electron absent : npm install --ignore-scripts puis node node_modules/electron/install.js');

const fonts = ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'];
for (const font of fonts) {
  const present = existsSync(join(root, 'assets', 'fonts', font));
  lines.push(`Police ${font} ${present ? '✔' : '✖'}`);
  if (!present) problems.push(`police manquante : ${font}`);
}

const migrations = join(root, 'src', 'main', 'migrations');
const sql = existsSync(migrations) ? readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort() : [];
lines.push(`Migrations ${sql.length ? sql.join(', ') : '✖ aucune'}`);
if (!sql.length) problems.push('aucune migration SQL');

console.log(lines.join('\n'));
if (problems.length) {
  console.error(`\n${problems.length} problème(s) :`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log('\nEnvironnement prêt.');
