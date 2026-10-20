# Audit de l'application existante — « متابعة الشيكات – كل الشركات »

**Fichier audité :** `legacy/original-legacy.html`
**Empreinte SHA-256 :** `2f78c3f55faa1674e5b6018b4b3ac919868806a6513ef6cba6fa2e4b84ccd1e9`
**Date de l'audit :** 19/10/2026
**Méthode :** lecture intégrale du fichier (258 lignes, 35 194 octets), extraction du script (200 lignes, 28 124 octets), exécution mentale et reproductions ciblées des calculs. L'original est conservé intact dans `legacy/`.

---

## 1. Ce que l'application fait réellement

L'application est une page HTML autonome, en arabe, RTL, avec un état unique dans `localStorage` (clé `chq`). Elle propose :

| Fonction | Réalité constatée | Verdict |
|---|---|---|
| Tableau de bord | 5 cartes + flux 8 semaines + alertes | Conservé, calculs à refondre |
| Cheveux / chèques (Chèques) | Création, changement de statut libre, suppression | Conservé, workflow à refondre |
| Comptes bancaires | Comptes avec solde d'ouverture, solde calculé et prévisionnel | Conservé, modèle banque/compte à séparer |
| Transactions | Dépôt, retrait, frais, intérêts, prêt, virement | Conservé, virements à réparer |
| Relevé / rapprochement | Saisie manuelle d'un solde banque, écart avec le solde logiciel | Remplacé par import CSV/XLSX + rapprochement |
| Contreparties | Agrégation des noms saisis dans `party` | Remplacé par un référentiel |
| Chéquiers | Plages de numéros, reste calculé | Conservé, contrôle renforcé |
| Entre sociétés | « Dettes » déduites des virements | Requalifié en synthèse de transferts |
| Sociétés | Fiche enrichie (NIF, NIS, RC, AI…) | Conservé |
| Paramètres | Mot de passe global, délai de présentation, journal léger | Remplacé par comptes/sessions/audit |
| Sauvegarde | Zone de texte JSON copier/coller | Remplacé par sauvegarde SQLite vérifiée |
| Export | CSV dans un `<textarea>` | Remplacé par vrais fichiers CSV/XLSX/PDF |

---

## 2. Défauts confirmés

### 2.1 Bloquants — exactitude financière

**D-01 — Le solde « réel » n'est pas un solde bancaire.**
`bal(a) = a.open + Σ chèques réglés + Σ transactions` (ligne 36). Il est affiché « الرصيد الفعلي » (« solde réel/effectif ») et comparé à un solde bancaire saisi. C'est un solde comptable calculé, jamais un solde de banque. Libellé trompeur.

**D-02 — Les dates de règlement réelles sont ignorées.**
`eff(c)` (ligne 35) ne regarde que le statut (`cashed`/`paid`) ; le relevé utilise `c.due` comme date de mouvement (ligne 136). Un chèque encaissé le 20/10 avec échéance 01/12 est daté du 01/12. Les colonnes `collection_date` / `payment_date` n'existent pas. Un chèque payé ne porte aucune date d'encaissement. **Interdit par les règles 3 et 7.6 du cahier des charges.**

**D-03 — Aucune date d'ouverture de solde.**
`a.open` est un montant sans date (ligne 105). Impossible de calculer un solde à une date donnée ni de rapprocher un relevé daté.

**D-04 — Double comptage possible par construction.**
Le solde inclut les chèques réglés **et** toutes les transactions manuelles. Rien n'empêche de saisir un retrait manuel correspondant à un chèque payé : le même flux est compté deux fois. Aucun rapprochement, aucune liaison transaction ↔ chèque.

**D-05 — Virements entre sociétés non symétriques et dettes inventées.**
`txe(t,id)` (ligne 36) débite le compte source et crédite le compte cible, mais `delTx` (ligne 133) supprime la ligne unique : les deux comptes sont impactés, sans trace de la contrepartie. L'écran « بين الشركات » (lignes 162-164) transforme des virements bancaires en créances/dettes sans convention, sens juridique ni lettrage. **Requalifié en synthèse de transferts.**

**D-06 — `toISOString()` et dates UTC.**
`iso()` (ligne 4) utilise UTC. À Oran (UTC+1), toute action entre 00:00 et 01:00 locale est datée de la veille. Les dates d'échéance, d'alerte et de sauvegarde sont décalées.

**D-07 — Les montants sont des flottants.**
`+g('amt')`, `+a_open`, `+v` : additions de `Number` IEEE-754, sans arrondi ni précision monétaire. Les écarts de 0,01 DZD sont inévitables après quelques centaines d'opérations.

**D-08 — Aucune devise, aucun multi-devise cohérent.**
`fmt` ajoute « DA » en dur (ligne 7) ; les montants sont nus. La devise ne peut pas être contrôlée.

**D-09 — Chéquiers : usage surévalué.**
Le nombre utilisé compte tous les chèques émis dont le numéro est dans la plage, même annulés ou rejetés, et même si le numéro est non numérique (`+c.no` → `NaN`). Les chèques hors chéquier ne sont pas signalés et deux chéquiers peuvent se chevaucher (ligne 148, 160).

**D-10 — Flux prévisionnel approximatif.**
Le tableau de bord reporte les échéances dépassées dans la semaine 1 (`i===0&&c.due<T`), puis additionne des montants sans tenir compte des rejets/impayés futurs, des devises, ni du solde à la date. Il n'y a pas de courbe de trésorerie par date, seulement 8 colonnes hebdomadaires.

**D-11 — Un chèque « retourné » reste sans impact, et peut être « réglé » par un simple champ `rs`.**
`settle()` (ligne 165) écrit une date de règlement sans montant, sans écriture, sans statut. Le solde ne bouge pas, mais l'alerte disparaît. Faux règlement.

**D-12 — L'export CSV n'échappe pas l'injection de formules et ne contient pas de totaux.**
`csv()` (ligne 145) double les guillemets mais laisse les cellules commençant par `=`, `+`, `-`, `@` exécutables dans Excel. Aucun contrôle des permissions, aucune devise, aucun total.

### 2.2 Bloquants — sécurité et intégrité

**D-13 — Un mot de passe global, en clair dans `localStorage`.**
`S.pw` est un SHA-256 **non salé** (ligne 170) stocké dans le même JSON que les données. `lockUI()` (ligne 171) ne fait que poser un voile ; la console, les DevTools ou un simple `localStorage.removeItem('chq')` neutralisent tout. Ce n'est pas de l'authentification multi-utilisateur.

**D-14 — Aucun compte, rôle, permission ni affectation de société.**
Tous les utilisateurs voient toutes les sociétés et peuvent approuver, modifier, supprimer. Aucune séparation des tâches, aucun journal d'approbation.

**D-15 — Suppressions physiques immédiates.**
`delChq`, `delTx`, `delAcc`, `delCo`, `delBk` (lignes 96, 133, 108, 117, 161) retirent les objets du tableau. Aucune corbeille, aucun historique, aucune preuve. Les contreparties et les statuts passés disparaissent.

**D-16 — Journal tronqué à 300 lignes et modifiable.**
`lg()` (ligne 166) : `S.log = S.log.slice(-300)`. Il ne contient ni utilisateur, ni société, ni valeurs avant/après, ni identifiant d'enregistrement. Les lignes peuvent être altérées avec n'importe quel éditeur localStorage.

**D-17 — Pas de protection XSS systématique.**
`esc` protège `& < > "` mais n'est pas appliqué à toutes les valeurs injectées : par exemple les identifiants dans les attributs `onclick` (lignes 92-94, 155-160) sont concaténés sans échappement. Un nom de société ou de partie contenant une apostrophe casse le HTML / permet l'injection d'attribut. Les champs `input value="${esc(...)}"` ne protègent pas l'apostrophe dans un attribut simple quote.

**D-18 — Sauvegarde non vérifiée et restauration dangereuse.**
`impBk()` (ligne 199) remplace l'état complet sans validation, sans copie de sécurité, sans contrôle de totaux. `S.lastBk = T` est posé au clic, même si rien n'est sauvegardé (ligne 193). « Sauvegarde » ne produit aucun fichier.

**D-19 — Aucune protection contre les doublons sérieux.**
Les identifiants sont `Math.random().toString(36).slice(2,9)` (ligne 3) : collision possible, non stable. Les doublons de numéro de chèque ne sont détectés que pour les **chèques émis** (alerte), jamais bloqués, et ignorent le compte, la société et le sens. `setSt` permet de ressaisir le même numéro.

**D-20 — Identifiants non fiables / références orphelines.**
Les comptes et chèques référencent des IDs aléatoires. Aucune contrainte : `acc(id)` renvoie un objet factice `{name:'؟'}` (ligne 32), ce qui masque les orphelins au lieu de les signaler. Un chèque peut pointer un compte d'une autre société.

### 2.3 Fonctionnel

**D-21 — Transitions de statut libres.**
`setSt()` (ligne 95) accepte n'importe quelle valeur du `<select>`, y compris revenir de « payé » à « émis », sans motif, sans date, sans approbation. Aucune machine à états.

**D-22 — Suppression d'une société possible si un chèque a `co` mais pas de compte lié.**
Le contrôle de `delCo` (ligne 117) vérifie les comptes et les chèques de la société, mais pas les livres, transactions ou transferts entrants. Un compte d'une autre société peut recevoir un virement vers un compte supprimé.

**D-23 — « Rapprochement » = un seul champ.**
`setBank(v)` (ligne 147) stocke un solde saisi ; aucun relevé, aucune ligne, aucune date, aucun import, aucune trace. Un chiffre saisi il y a 6 mois reste « le solde banque ».

**D-24 — Pas d'import de relevé, pas de pièces jointes, pas de notifications persistantes, pas de rapports.**
Aucune fonctionnalité de fichiers, d'archivage ou d'export PDF.

**D-25 — Contreparties non normalisées.**
`pts()` (ligne 143) déduit les contreparties de chaînes libres (`زبون: ...`). « Zahar », « zahar » et « Zahar SARL » sont trois contreparties. Aucune fiche, aucun identifiant.

**D-26 — Interface arabe uniquement, sans équivalent français.**
Le cahier des charges impose le français par défaut. De plus, les libellés mélangent « solde réel » et « prévisionnel » sans définitions.

**D-27 — Aucune gestion des rôles, des sessions, de l'inactivité ni de la déconnexion.**
Le verrou est posé une fois au chargement, jamais expiré, et ne survit pas à un rechargement des données ; il n'y a pas de bouton de déconnexion.

**D-28 — Aucune validation des données héritées.**
`S = S || seed()` accepte n'importe quel JSON ; un `cheques` non tableau casse tout le rendu. Aucun contrôle des types, des montants, des devises, des dates, des relations.

**D-29 — Le jeu de démonstration est injecté silencieusement.**
`S = S || seed()` (ligne 26) crée 2 sociétés, 3 comptes et 7 chèques fictifs. Rien ne les distingue de vraies données. Une sauvegarde restaurée sans `companies` est remplacée par les données de démo. **Le cahier des charges l'interdit en production.**

**D-30 — Pas de tests, pas de versionnage du stockage, pas de migration.**
Aucun champ de version, aucun script de migration.

**D-31 — Fonctions dupliquées / ambiguës.**
`cos()` est définie deux fois (ligne 109 puis 180) ; la seconde écrase la première, ce qui rend l'ancien formulaire de création inopérant. `setLim` et `alerts` sont recâblés. L'objet `LB` journalise des actions en rejouant les fonctions avec `apply`, fragile.

**D-32 — Faux exports et fausses impressions.**
« تصدير » écrit du CSV dans un `<textarea>` (ligne 197) ; « نسخة احتياطية » ne crée aucun fichier. Le bouton d'impression imprime la page courante, pas le rapport.

---

## 3. Plan de correction (ordre d'exécution)

| Étape | Correction | Livrable |
|---|---|---|
| 1 | Modèle normalisé SQLite, montants en centimes, clés étrangères, index, migrations versionnées | `app/src/main/migrations/*.sql`, `db.js` |
| 2 | Comptes, rôles, permissions, affectations sociétés, scrypt + sel, sessions, verrouillage d'inactivité | `services/auth.js`, `users.js` |
| 3 | Machine à états par sens, dates réelles de règlement, motifs obligatoires, non-suppression | `shared/status.js`, `services/cheques.js` |
| 4 | Trois soldes distincts (comptable, relevé, prévisionnel), dates d'ouverture, transferts appariés | `services/finance.js` |
| 5 | Approbations atomiques, anti-auto-approbation, idempotence | `services/approvals.js` |
| 6 | Import CSV/XLSX, empreinte anti-doublon, mapping, propositions de rapprochement, confirmation explicite | `services/imports.js`, `reconciliation.js` |
| 7 | Audit structuré append-only (triggers SQL), historique de statut séparé | `0001_schema.sql`, `services/audit.js` |
| 8 | Sauvegarde SQLite vérifiée + pièces jointes, restauration avec aperçu et copie de sécurité | `services/backups.js` |
| 9 | Vrais exports CSV/XLSX/PDF, anti-injection, permissions, totaux | `services/reports.js` |
| 10 | Migration explicite du JSON `chq`, validée, réversible, source conservée | `services/migration.js` |
| 11 | Prototype HTML unique corrigé, adaptateur de stockage, données de démo étiquetées | `prototype/suivi-cheques-prototype.html` |
| 12 | Application Electron sécurisée (contexte isolé, IPC validé, CSP, fichiers contrôlés) | `app/main.js`, `preload.js`, `services/ipc.js` |
| 13 | Tests automatisés A à J + checklist manuelle | `tests/`, `docs/TEST_MANUEL.md` |
| 14 | Packaging Windows et documentation française | `package.json`, `docs/` |

## 4. Ce qui est conservé / remplacé

**Conservé et corrigé :** sociétés, banques/comptes, chèques émis/reçus, chéquiers, transactions, contreparties, alertes, tableau de bord, synthèse inter-sociétés, thème clair/sombre, export.

**Redessiné :** authentification (comptes individuels), persistance (SQLite), états des chèques (machine à états), soldes (trois notions), rapprochement (import + lignes), sauvegarde (fichiers vérifiés), journal (audit structuré), exports (PDF/XLSX/CSV réels), interface (français, ergonomie DG).

**Supprimé sans remplacement :** mot de passe global, `prompt()` pour les motifs, suppression physique, génération silencieuse de données fictives, champ unique « solde banque » sans date, calcul de dettes inter-sociétés non justifié.

**Non implémenté (déclaré explicitement) :** paiement fractionné / lettrage d'une ligne bancaire sur plusieurs chèques (bloqué volontairement, voir §7.8 du cahier des charges), chiffrement au repos de la base (hors périmètre ; recommandation BitLocker + permissions NTFS documentée), signature électronique des rapports.
