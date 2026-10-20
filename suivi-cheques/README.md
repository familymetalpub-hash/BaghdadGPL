# Suivi des chèques bancaires — refonte

Application de suivi des chèques pour un groupe de 5 à 10 sociétés (Algérie, DZD, poste Windows partagé). Ce dépôt contient deux livrables distincts :

| Dossier | Rôle |
|---|---|
| `AUDIT.md` | Audit de l’application d’origine : défauts confirmés, plan de correction, fonctionnalités conservées ou redessinées |
| `prototype/suivi-cheques-prototype.html` | **Mode A** — prototype autonome, fichier HTML unique, données fictives |
| `app/` | **Mode B** — application Electron de production (SQLite, IPC, services, interface) |
| `legacy/original-legacy.html` | Copie de l’application d’origine, jamais modifiée |

## Mode A — prototype autonome

Fichier unique : `prototype/suivi-cheques-prototype.html` (HTML + CSS + JavaScript en ligne, sans réseau).

- 11 pages : tableau de bord, sociétés, banques & comptes, chèques, approbations, rapprochement, rapports, audit, documents, sauvegardes, paramètres.
- Données fictives clairement signalées ; stockage `localStorage` ; réinitialisation depuis les paramètres.
- Sélecteur de rôle simulé (DG / Responsable / Administrateur) reproduisant les permissions du backend.
- Trois soldes distincts, dates de règlement réelles, transitions contrôlées, doublons, approbations sans auto-approbation, import CSV, rapprochement, audit, migration héritée.
- Tests jsdom : **83 vérifications réussies** (32 interface, 44 métier, 7 assistant d’import).

Détails et limites : `prototype/README.md`.

> Le prototype n’est ni sécurisé, ni une persistance de production. Il ne doit recevoir aucune donnée réelle.

## Mode B — application Electron

```bash
cd app
npm install
npm test        # tests Node du backend (répartiteur IPC réel)
npm start       # nécessite un affichage graphique
```

- Base SQLite hors dossier d’installation, 29 tables, migrations `0001_schema.sql` / `0002_seed.sql`.
- Trois rôles (DG, Responsable de Suivi, Administrateur), permissions côté backend, sessions, scrypt, verrouillage.
- Répartiteur IPC à liste fermée de méthodes, schémas zod, préchargement isolé (`contextIsolation: true`, `nodeIntegration: false`).
- Services : chèques, approbations, import, rapprochement, finances, rapports, audit, sauvegardes, migration, pièces jointes.
- Interface française : mêmes 11 sections que le prototype.
- Tests backend exécutés le 20/10/2026 : **32/32 réussis** — `A-isolation` (6), `B-cheque-workflow` (6), `C-approvals` (8), `D-finance` (6), `E-import-reconciliation` (6).
- Contrôles statiques : `npm run lint` → 45/45 fichiers JavaScript valides, isolation du contexte, `nodeIntegration` désactivé, API du preload figée.
- Tests F à J (persistance, sauvegarde/restauration, rapports, migration, sécurité Electron) : **non encore écrits**.
- Exécution Electron réelle et packaging Windows : **non vérifiés** dans cet environnement (pas d’affichage graphique, pas de Windows).

## Ce qui n’est pas encore livré

- Tests F–J et liste de contrôle manuelle.
- Documentation utilisateur/administrateur complète en français.
- Validation du packaging Windows (`electron-builder`) et test d’installation réelle.
- Vérification visuelle du prototype dans un navigateur réel (les tests jsdom valident le DOM et les parcours, pas le rendu graphique).

## Principe financier retenu

Le **solde comptable** additionne le solde d’ouverture et les mouvements réglés à leur **date réelle** (encaissement ou paiement constaté). Le **solde de relevé** provient du dernier import ou de la dernière saisie manuelle. Le **solde prévisionnel** ajoute les chèques en cours. Une échéance n’est jamais une date de règlement ; un chèque en retard reste en cours tant qu’aucun règlement réel n’est constaté.
