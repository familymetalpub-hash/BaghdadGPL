'use strict';

/**
 * Régénère les INSERT de role_permissions dans 0002_seed.sql depuis
 * src/shared/permissions.js. À exécuter avant toute publication ; après la
 * première mise en production, créer une nouvelle migration au lieu de
 * modifier un fichier déjà appliqué (le contrôle de somme l'interdit).
 */
const fs = require('node:fs');
const path = require('node:path');
const { ROLES, ROLE_PERMISSIONS } = require('../src/shared/permissions');

const seedPath = path.join(__dirname, '..', 'src', 'main', 'migrations', '0002_seed.sql');
let sql = fs.readFileSync(seedPath, 'utf8');

for (const role of Object.keys(ROLES)) {
  const codes = [...ROLE_PERMISSIONS[role]].sort();
  const list = codes.map((code) => `'${code}'`).join(',');
  const re = new RegExp(
    `(INSERT INTO role_permissions\\(role_id,permission_id\\)\\nSELECT r.id,p.id FROM roles r, permissions p WHERE r.code='${role}' AND p.code IN \\()([^)]*)(\\);)`
  );
  if (!re.test(sql)) {
    throw new Error(`Bloc role_permissions introuvable pour ${role}`);
  }
  sql = sql.replace(re, (m, start, _old, end) => `${start}${list}${end}`);
}
fs.writeFileSync(seedPath, sql, 'utf8');
console.log(`Seed synchronisé : ${Object.keys(ROLES).map((r) => `${r}=${ROLE_PERMISSIONS[r].length}`).join(', ')}`);
