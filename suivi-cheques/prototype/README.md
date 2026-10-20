# Prototype autonome — Suivi des chèques (Mode A)

**Fichier unique : `suivi-cheques-prototype.html`** (HTML + CSS + JavaScript en ligne, aucune dépendance externe, aucune connexion réseau).

Ce prototype sert à valider l’interface, les parcours et les règles métier avant l’application Electron. Il ne remplace ni la base SQLite, ni l’authentification, ni les sauvegardes de production.

## Ouverture

Double-cliquez sur `suivi-cheques-prototype.html` ou ouvrez-le dans un navigateur récent (Chrome, Edge, Firefox). Aucun serveur n’est nécessaire.

- Langue : français.
- Devise : DZD (dinar algérien), montants en centimes en interne, saisie avec virgule ou point.
- Jeu de données fictif généré au premier lancement (3 sociétés, 4 comptes, 24 chèques, incidents, imports, demandes d’approbation).
- Les données sont conservées dans `localStorage` sous la clé `suivi_cheques_proto_v1`. Elles peuvent être réinitialisées depuis **Paramètres → À propos → Réinitialiser la démonstration**.

> **Aucune authentification réelle.** Le sélecteur « Rôle simulé » (en haut à droite) ne protège rien : il reproduit les permissions du backend pour vérifier les parcours. Ne saisissez jamais de données réelles dans ce fichier.

## Pages

| Page | Contenu |
|---|---|
| Tableau de bord | Solde comptable, en-cours, prévisionnel, retards, activité récente |
| Sociétés | Référentiel, comptes rattachés, contreparties, banques |
| Banques & comptes | Position par compte, solde de relevé, écart, chéquiers, transferts inter-sociétés |
| Chèques | Filtres, création reçu/émis, doublons, détail, historique, modification, changements de statut |
| Approbations | Demandes en attente/traitées, comparaison avant/après, approbation et rejet motivés |
| Rapprochement | Import CSV en 3 étapes, historique, lignes de relevé, propositions, confirmation DG, écarts |
| Rapports | 12 états, filtres, aperçu, export CSV, impression/PDF navigateur |
| Piste d’audit | Journal filtrable, détail avant/après, export CSV |
| Documents | Métadonnées de justificatifs, ajout et retrait logique |
| Sauvegardes | Historique simulé, export JSON réel des données de démonstration, procédure de restauration documentée |
| Paramètres | Général, règles d’approbation, utilisateurs, migration héritée, limites |

## Règles métier vérifiables dans le prototype

- **Trois soldes distincts** : comptable (ouverture + mouvements réglés à leur date réelle), relevé (dernier import ou saisie manuelle), prévisionnel (comptable + chèques en cours). Le solde comptable n’est jamais présenté comme un solde bancaire.
- **Date d’échéance ≠ date de règlement** : un chèque reste en cours après son échéance tant qu’aucun encaissement/paiement réel n’est constaté. Les soldes historiques utilisent la date réelle.
- **Transitions contrôlées** : `Reçu → Déposé → Encaissé`, `Émis → Remis → Payé`, transitions d’incident limitées ; aucun statut arbitraire. Une annulation, un impayé, un rejet, un litige ou une régularisation exigent un motif.
- **Doublons** : même société + même compte + même sens + même numéro normalisé. Dérogation motivée (10 caractères minimum) uniquement.
- **Approbations** : seuil paramétrable (500 000,00 DA par défaut), annulation d’un chèque finalisé, modifications matérielles, rapprochement. Aucune écriture avant décision ; rejet sans écriture ; auto-approbation refusée ; double traitement refusé.
- **Import** : séparateur et format de date détectés, contrôle ligne à ligne, doublons de fichier refusés (empreinte), import partiel uniquement sur confirmation explicite, historique et anomalies conservés.
- **Rapprochement** : propositions sur même compte, même sens et montant identique, jamais finalisées automatiquement ; confirmation réservée au DG ; une ligne bancaire ne règle qu’un seul chèque ; la confirmation applique la date réelle et un seul crédit comptable ; un chèque jamais déposé exige la date réelle de dépôt (jamais déduite de l’échéance).
- **Audit** : créations, modifications, statuts, imports, rapprochements, approbations, paramètres et migration sont journalisés avec avant/après et motif. Pas de suppression depuis l’interface.
- **Migration** : lecture de la clé héritée `chq`, rapport d’anomalies, confirmation `MIGRER`, chèques hérités marqués « À régulariser » faute de dates réelles, copie de la source conservée, mot de passe global non migré.

## Limites assumées du Mode A

- `localStorage` n’est ni une persistance de production, ni une protection contre la modification, ni un contrôle d’accès.
- Pas de chiffrement, pas d’isolation entre utilisateurs d’un même poste, pas de sessions.
- Les pièces jointes ne sont pas stockées : seules les métadonnées sont conservées.
- Les sauvegardes affichées sont simulées ; seul l’export JSON est réel.
- Pas d’import XLSX, pas de génération PDF native (impression navigateur uniquement), pas d’export XLSX.
- La migration est une démonstration : elle n’est pas transactionnelle comme la migration SQLite de l’application Electron.
- Certaines listes de référence (sociétés, comptes, contreparties) sont lues directement dans le magasin de démonstration ; les commandes et requêtes métier passent par `api.call(method, params)`.

## Point d’intégration avec Electron

Toutes les opérations passent par :

```js
api.call(method, params) // -> Promise<data>
```

Pour brancher le backend de production, remplacer le corps de `api.call` par un appel au pont préchargé :

```js
const response = await window.suivi.invoke({ method, params, requestId });
if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
return response.data;
```

Les noms de méthodes (`cheques.list`, `cheques.create`, `approvals.decide`, `imports.commit`, `reconciliation.confirm`, `reports.data`, `audit.list`, etc.) et les paramètres reprennent le contrat IPC de `app/src/shared/ipc-schema.js`. Les erreurs sont propagées avec un `code` (`FORBIDDEN`, `CONFLICT`, `DUPLICATE_CHEQUE`, `IMPORT_INVALID`, etc.).

## Tests exécutés

Les tests du prototype s’exécutent avec jsdom (aucun navigateur graphique requis) :

```bash
cd suivi-cheques/prototype
npm install
npm test
```

- `tests/ui-smoke.js` — 32 vérifications : rendu des 11 pages, création de chèque, seuil d’approbation, modales, rapprochement, assistant d’import, rapports, audit, paramètres, migration, sauvegardes.
- `tests/workflows.js` — 44 vérifications métier : doublons, dates réelles, transitions, dépôt obligatoire avant règlement, import, rapprochement, approbations, auto-approbation, migration, paramètres, audit.
- `tests/import-wizard.js` — 7 vérifications du parcours d’import complet (fichier réel, mapping, confirmation, lignes importées).

Résultat au 20/10/2026 : **83 vérifications réussies, 0 erreur JavaScript**. Ces tests ne remplacent pas les tests A–J de l’application Electron.
