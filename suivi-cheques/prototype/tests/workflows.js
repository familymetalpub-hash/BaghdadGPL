const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync(require('node:path').join(__dirname, '..', 'suivi-cheques-prototype.html'), 'utf8');
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'https://demo.local/',beforeParse(w){w.structuredClone=w.structuredClone||((v)=>JSON.parse(JSON.stringify(v)));w.print=()=>{};}});
const w=dom.window;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

const script = `
(async () => {
  const out = [];
  const eq = (name, actual, expected) => out.push([name, JSON.stringify(actual) === JSON.stringify(expected), actual, expected]);
  const ok = (name, cond, detail) => out.push([name, Boolean(cond), detail]);

  // --- Données de départ
  const dash0 = await api.call('finance.dashboard', { asOf: todayISO() });
  const accountId = 1;
  const book0 = dash0.perAccount.find(a => a.accountId === accountId).bookBalanceCents;
  const pending0 = dash0.perAccount.find(a => a.accountId === accountId).pendingIncomingCents;

  // --- Création d'un chèque reçu
  const created = await api.call('cheques.create', {
    companyId: 1, accountId, direction: 'RECU', chequeNumber: 'SMOKE-1', partyName: 'Client Smoke',
    amountCents: 120000, issueDate: '2026-10-01', receiptDate: '2026-10-02', dueDate: '2026-10-20',
  });
  ok('création chèque reçu', created.reference && created.status === 'RECU', created.reference);

  // Doublon
  let dupError = null;
  try { await api.call('cheques.create', { companyId: 1, accountId, direction: 'RECU', chequeNumber: 'SMOKE 1', partyName: 'X', amountCents: 100, issueDate: '2026-10-01', receiptDate: '2026-10-02', dueDate: '2026-10-20' }); }
  catch (e) { dupError = e.code; }
  eq('doublon détecté', dupError, 'DUPLICATE_CHEQUE');

  // Le solde comptable ne bouge pas, l'en-cours oui
  const dash1 = await api.call('finance.dashboard', { asOf: todayISO() });
  const acc1 = dash1.perAccount.find(a => a.accountId === accountId);
  eq('solde comptable inchangé', acc1.bookBalanceCents, book0);
  eq('en-cours +120000', acc1.pendingIncomingCents, pending0 + 120000);

  // Dépôt puis encaissement à date réelle
  const deposited = await api.call('cheques.changeStatus', { id: created.id, to: 'DEPOSE', eventDate: '2026-10-10', reason: 'Remise en banque' });
  eq('dépôt', deposited.status, 'DEPOSE');
  const collected = await api.call('cheques.changeStatus', { id: created.id, to: 'ENCAISSE', eventDate: '2026-10-15', reason: 'Crédit constaté' });
  eq('encaissement', collected.status, 'ENCAISSE');
  eq('date réelle stockée', collected.collectionDate, '2026-10-15');
  const before15 = await api.call('finance.accounts', { asOf: '2026-10-14' });
  const after15 = await api.call('finance.accounts', { asOf: '2026-10-15' });
  eq('pas d’effet avant la date réelle', before15.accounts.find(a => a.accountId === accountId).bookBalanceCents, book0);
  eq('effet à la date réelle', after15.accounts.find(a => a.accountId === accountId).bookBalanceCents, book0 + 120000);

  // Transition interdite
  let transError = null;
  try { await api.call('cheques.changeStatus', { id: created.id, to: 'DEPOSE', eventDate: todayISO(), reason: 'Retour arrière' }); }
  catch (e) { transError = e.message; }
  ok('transition interdite', /non autorisée/.test(transError), transError);

  // --- Import CSV
  const csv = 'Date;Valeur;Libellé;Débit;Crédit;Solde;Référence\\n'
    + '10/10/2026;10/10/2026;REMISE SMOKE;0,00;1 200,00;9 000,00;S-1\\n'
    + '12/10/2026;;FRAIS;15,00;0,00;8 985,00;S-2\\n';
  const preview = await api.call('imports.preview', { text: csv, filename: 'smoke.csv', accountId, hasHeader: true });
  eq('séparateur détecté', preview.delimiter, ';');
  const mapping = preview.suggestedMapping;
  const analysis = await api.call('imports.analyze', { text: csv, filename: 'smoke.csv', accountId, mapping, hasHeader: true, dateFormat: 'DD/MM/YYYY', decimalSeparator: ',' });
  eq('lignes valides', analysis.validRows, 2);
  eq('total crédits', analysis.totals.creditCents, 120000);
  eq('total débits', analysis.totals.debitCents, 1500);
  const committed = await api.call('imports.commit', { batchId: analysis.batchId, accountId, statementDate: '2026-10-31', closingBalanceCents: 898500, reason: 'Smoke test' });
  eq('import commit', committed.importedCount, 2);
  let dupFile = null;
  try {
    const again = await api.call('imports.analyze', { text: csv, filename: 'smoke.csv', accountId, mapping, hasHeader: true, dateFormat: 'DD/MM/YYYY', decimalSeparator: ',' });
    await api.call('imports.commit', { batchId: again.batchId, accountId, statementDate: '2026-10-31', closingBalanceCents: 898500 });
  } catch (e) { dupFile = e.message; }
  ok('fichier déjà importé refusé', /déjà été importé/.test(dupFile), dupFile);

  // Rapprochement : un chèque en cours, une ligne de même montant, confirmation par le DG
  const reconCheque = await api.call('cheques.create', {
    companyId: 1, accountId, direction: 'RECU', chequeNumber: 'SMOKE-REC', partyName: 'Client Rapprochement',
    amountCents: 120000, issueDate: '2026-10-01', receiptDate: '2026-10-02', dueDate: '2026-10-18',
  });
  const lines = await api.call('reconciliation.list', { matchStatus: 'ALL' });
  const line = lines.items.find(l => l.creditCents === 120000 && l.description === 'REMISE SMOKE');
  ok('ligne de relevé présente', Boolean(line));
  const candidates = await api.call('reconciliation.candidates', { transactionId: line.id });
  ok('candidat chèque', candidates.some(c => c.id === reconCheque.id), candidates.map(c => c.reference));
  const proposed = await api.call('reconciliation.propose', { transactionId: line.id, chequeId: reconCheque.id, reason: 'Smoke' });
  eq('proposition', proposed.status, 'PROPOSE');
  const chequeAfterProposal = await api.call('cheques.get', { id: reconCheque.id });
  eq('proposition ne change pas le statut', chequeAfterProposal.status, 'RECU');
  const bookBeforeConfirm = (await api.call('finance.accounts', { asOf: '2026-10-31' })).accounts.find(a => a.accountId === accountId).bookBalanceCents;
  let confirmError = null;
  try { await api.call('reconciliation.confirm', { matchId: proposed.id, settleCheque: true, settlementDate: '2026-10-10', reason: 'Smoke confirm' }); }
  catch (e) { confirmError = e.message; }
  ok('dépôt obligatoire avant règlement', /dépôt/i.test(confirmError || ''), confirmError);
  const confirmed = await api.call('reconciliation.confirm', { matchId: proposed.id, settleCheque: true, settlementDate: '2026-10-10', depositDate: '2026-10-05', reason: 'Smoke confirm' });
  eq('confirmation applique le règlement', confirmed.settlementApplied, true);
  const chequeAfterConfirm = await api.call('cheques.get', { id: reconCheque.id });
  eq('statut encaissé après rapprochement', chequeAfterConfirm.status, 'ENCAISSE');
  eq('date de règlement réelle', chequeAfterConfirm.collectionDate, '2026-10-10');
  eq('date de dépôt réelle', chequeAfterConfirm.depositDate, '2026-10-05');
  const bookAfterConfirm = (await api.call('finance.accounts', { asOf: '2026-10-31' })).accounts.find(a => a.accountId === accountId).bookBalanceCents;
  eq('un seul crédit comptable', bookAfterConfirm - bookBeforeConfirm, 120000);
  const lineAfter = (await api.call('reconciliation.list', { matchStatus: 'ALL' })).items.find(l => l.id === line.id);
  eq('ligne rapprochée', lineAfter.matchStatus, 'MATCHED');

  // --- Approbation
  state.role = 'RESPONSABLE';
  setRoleContext();
  const high = await api.call('cheques.create', {
    companyId: 1, accountId, direction: 'EMIS', chequeNumber: 'SMOKE-HIGH', partyName: 'Fournisseur Smoke',
    amountCents: 70000000, issueDate: '2026-10-01', dueDate: '2026-11-01',
  });
  ok('demande créée au-dessus du seuil', high.pendingApproval === true, high.approval && high.approval.reference);
  // Le DG (autre utilisateur que la demandeuse) approuve
  state.role = 'DG';
  setRoleContext();
  const decided = await api.call('approvals.decide', { id: high.approval.id, decision: 'APPROVED', reason: 'Contrôle OK' });
  eq('approbation appliquée', decided && decided.status, 'APPROVED');
  const created2 = (await api.call('cheques.list', { search: 'SMOKE-HIGH' })).items[0];
  ok('chèque créé après approbation', created2 && created2.amountCents === 70000000, created2 && created2.reference);
  let doubleError = null;
  try { await api.call('approvals.decide', { id: high.approval.id, decision: 'APPROVED' }); } catch (e) { doubleError = e.message; }
  ok('double traitement refusé', /déjà été traitée/.test(doubleError), doubleError);

  // Auto-approbation : le DG demande l'annulation d'un chèque encaissé
  const cancelRequest = await api.call('cheques.changeStatus', { id: 5, to: 'ANNULE', eventDate: todayISO(), reason: 'Annulation demandée par le DG' });
  ok('annulation finalisée soumise à approbation', cancelRequest.pendingApproval === true, cancelRequest.approval && cancelRequest.approval.reference);
  let selfError = null;
  try { await api.call('approvals.decide', { id: cancelRequest.approval.id, decision: 'APPROVED', reason: 'Tentative' }); } catch (e) { selfError = e.message; }
  ok('auto-approbation refusée', /Auto-approbation/.test(selfError), selfError);
  const cancelledRequest = await api.call('approvals.cancel', { id: cancelRequest.approval.id, reason: 'Test terminé' });
  eq('demande retirée', cancelledRequest.status, 'CANCELLED');

  // --- Migration héritée
  state.role = 'ADMIN';
  setRoleContext();
  const legacy = JSON.stringify({
    companies: [{ id: 'c1', name: 'Société Héritée', code: 'HER' }],
    accounts: [{ id: 'a1', companyId: 'c1', label: 'Compte hérité', bank: 'BNA', number: '001 123', balance: 5000 }],
    cheques: [{ id: 'ch1', acc: 'a1', dir: 'in', num: 'H-1', party: 'Client Hérité', amount: 2500, due: '2026-09-30', status: 'paid' }],
    tx: [{ id: 't1', acc: 'a1', amount: 1000, date: '2026-09-01', description: 'Apport' }],
    pw: 'secret',
  });
  const mig = await api.call('migration.analyze', { rawText: legacy, sourceName: 'smoke.json' });
  eq('analyse migration chèques', mig.summary.cheques, 1);
  ok('mot de passe signalé', mig.issues.some(i => i.code === 'MOT_DE_PASSE_IGNORE'));
  let commitError = null;
  try { await api.call('migration.commit', { token: mig.token, confirmation: 'NON' }); } catch (e) { commitError = e.message; }
  ok('confirmation exigée', /MIGRER/.test(commitError), commitError);
  const migResult = await api.call('migration.commit', { token: mig.token, confirmation: 'MIGRER', skipInvalid: true });
  eq('migration sociétés', migResult.importedCompanies, 1);
  eq('migration chèques', migResult.importedCheques, 1);
  state.role = 'DG';
  setRoleContext();
  const allCheques = await api.call('cheques.list', { pageSize: 200 });
  const imported = allCheques.items.find(c => c.chequeNumber === 'H-1');
  ok('chèque hérité à régulariser', imported && imported.status === 'A_REGULARISER', imported && imported.status);

  // --- Paramètres : seuil modifiable par DG seulement
  state.role = 'DG';
  setRoleContext();
  await api.call('settings.update', { changes: { 'approval.high_value_threshold_cents': 60000000 } });
  eq('seuil mis à jour', db.appSettings['approval.high_value_threshold_cents'], 60000000);
  state.role = 'ADMIN';
  setRoleContext();
  let settingsError = null;
  try { await api.call('settings.update', { changes: { 'approval.high_value_threshold_cents': 1 } }); } catch (e) { settingsError = e.code; }
  eq('admin ne modifie pas les règles', settingsError, 'FORBIDDEN');

  // --- Audit
  const audit = await api.call('audit.list', { pageSize: 200 });
  ok('audit alimenté', audit.total > 10, audit.total);
  const actions = new Set(db.auditLogs.map(l => l.action));
  ok('actions clés journalisées', actions.has('CHEQUE_CREATE') && actions.has('IMPORT_COMMITTED') && actions.has('APPROVAL_APPROVED') && actions.has('MATCH_CONFIRMED'));

  return out;
})()
`;

(async()=>{
  await sleep(400);
  const results = await w.eval(script);
  let failed = 0;
  for (const [name, pass, actual, expected] of results) {
    if (!pass) failed += 1;
    console.log((pass ? 'ok   ' : 'FAIL ') + name + (pass ? '' : ` — reçu ${JSON.stringify(actual)} attendu ${JSON.stringify(expected)}`));
  }
  console.log(failed ? `\nWORKFLOW FAILED (${failed}/${results.length})` : `\nWORKFLOW OK (${results.length})`);
  process.exit(failed ? 1 : 0);
})().catch(e=>{console.error('FATAL', e); process.exit(1);});
