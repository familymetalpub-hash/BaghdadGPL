'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestApp } = require('./helpers');

function writeCsv(root, name, lines) {
  const file = path.join(root, name);
  fs.writeFileSync(file, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
  return file;
}

async function stageAndAnalyze(app, file, accountId, mapping = {}) {
  app.runtime.queueOpenFile(file);
  const stage = await app.clients.dg('imports.stage');
  assert.ok(stage.token);
  const analysis = await app.clients.dg('imports.analyze', {
    token: stage.token,
    accountId,
    mapping: {
      date: 0,
      valueDate: 1,
      description: 2,
      debit: 3,
      credit: 4,
      balance: 5,
      reference: 6,
      amount: null,
      currency: null,
      ...mapping,
    },
    options: { hasHeader: true, headerRow: 1, dateFormat: 'DD/MM/YYYY', decimalSeparator: 'auto', amountDirection: 'NEGATIVE_IS_DEBIT' },
  });
  return { stage, analysis };
}

test('E — import bancaire, propositions et finalisation par le DG', async (t) => {
  const app = await createTestApp({ openingBalanceCents: 1_000_000 });
  t.after(() => app.cleanup());
  const { dg } = app.clients;
  const { companyA, accountA } = app.data;

  const cheque = await dg('cheques.create', {
    companyId: companyA.id,
    accountId: accountA.id,
    direction: 'RECU',
    chequeNumber: 'IMP-1001',
    partyName: 'Client Relevé',
    amountCents: 150_000,
    issueDate: '2026-02-01',
    receiptDate: '2026-02-02',
    dueDate: '2026-03-10',
  });

  const header = 'Date;Valeur;Libellé;Débit;Crédit;Solde;Référence';
  const file = writeCsv(app.root, 'releve-mars.csv', [
    header,
    '10/03/2026;10/03/2026;Chèque 998877;0,00;1 500,00;11 500,00;REF-1',
    '12/03/2026;;Frais de tenue;25,00;0,00;11 475,00;REF-2',
  ]);

  const { analysis } = await stageAndAnalyze(app, file, accountA.id);
  assert.equal(analysis.validRows, 2);
  assert.equal(analysis.invalidRows, 0);
  assert.equal(analysis.totals.creditCents, 150_000);
  assert.equal(analysis.totals.debitCents, 2_500);

  const committed = await dg('imports.commit', {
    batchId: analysis.batchId,
    accountId: accountA.id,
    statementDate: '2026-03-31',
    closingBalance: '11 475,00',
    reason: 'Relevé de mars',
  });
  assert.equal(committed.importedCount, 2);
  assert.equal(committed.duplicateCount, 0);
  assert.equal(committed.closingBalanceCents, 1_147_500);

  await t.test('un même fichier ne peut pas être importé deux fois', async () => {
    const second = await stageAndAnalyze(app, file, accountA.id);
    await assert.rejects(
      () => dg('imports.commit', {
        batchId: second.analysis.batchId,
        accountId: accountA.id,
        statementDate: '2026-03-31',
        closingBalance: '11 475,00',
      }),
      (err) => err.code === 'CONFLICT'
    );
  });

  await t.test('le montant seul ne finalise jamais un rapprochement', async () => {
    const list = await dg('reconciliation.list', { matchStatus: 'ALL' });
    assert.equal(list.total, 2);
    const creditLine = list.items.find((x) => x.creditCents === 150_000);
    assert.ok(creditLine);
    const before = await dg('cheques.get', { id: cheque.id });
    assert.equal(before.status, 'RECU');
    assert.ok(creditLine.matches.length >= 1);
    assert.ok(creditLine.matches.every((m) => m.status === 'PROPOSE'));
    assert.equal(creditLine.matchStatus, 'PROPOSED');
  });

  await t.test('le DG confirme : date réelle, statut et solde comptable', async () => {
    const list = await dg('reconciliation.list', { matchStatus: 'ALL' });
    const creditLine = list.items.find((x) => x.creditCents === 150_000);
    const proposal = creditLine.matches.find((m) => m.status === 'PROPOSE');
    // Aucun dépôt n'a été enregistré : la confirmation doit le refuser plutôt
    // que d'inventer une date de dépôt.
    await assert.rejects(
      () => dg('reconciliation.confirm', {
        matchId: proposal.id,
        settleCheque: true,
        settlementDate: '2026-03-10',
        reason: 'Crédit identifié sur relevé',
      }),
      (err) => err.code === 'VALIDATION' && /dépôt/i.test(err.message)
    );
    const confirmed = await dg('reconciliation.confirm', {
      matchId: proposal.id,
      settleCheque: true,
      settlementDate: '2026-03-10',
      depositDate: '2026-03-05',
      reason: 'Crédit identifié sur relevé',
    });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.settlementApplied, true);
    const after = await dg('cheques.get', { id: cheque.id });
    assert.equal(after.status, 'ENCAISSE');
    assert.equal(after.collectionDate, '2026-03-10');
    assert.equal(after.depositDate, '2026-03-05');
    const positions = await dg('finance.accounts', { asOf: '2026-03-10' });
    const pos = positions.accounts.find((a) => a.accountId === accountA.id);
    assert.equal(pos.bookBalanceCents, 1_150_000);
    assert.equal(pos.statement, null, 'un relevé daté du 31 mars ne doit pas être utilisé au 10 mars');
    const atStatement = await dg('finance.accounts', { asOf: '2026-03-31' });
    const posStatement = atStatement.accounts.find((a) => a.accountId === accountA.id);
    assert.equal(posStatement.bookBalanceCents, 1_150_000);
    assert.equal(posStatement.statement.closingBalanceCents, 1_147_500);
    assert.equal(posStatement.statement.differenceCents, -2_500);
    const statementLine = await dg('reconciliation.list', { matchStatus: 'ALL' });
    assert.equal(statementLine.items.find((x) => x.creditCents === 150_000).matchStatus, 'MATCHED');
  });

  await t.test('lignes invalides : import partiel uniquement sur confirmation explicite', async () => {
    const invalidFile = writeCsv(app.root, 'releve-invalide.csv', [
      header,
      '10/04/2026;;Ligne correcte;10,00;0,00;11 465,00;REF-3',
      'date-invalide;;Ligne invalide;5,00;0,00;11 460,00;REF-4',
    ]);
    const { analysis } = await stageAndAnalyze(app, invalidFile, accountA.id);
    assert.equal(analysis.validRows, 1);
    assert.equal(analysis.invalidRows, 1);
    await assert.rejects(
      () => dg('imports.commit', {
        batchId: analysis.batchId,
        accountId: accountA.id,
        statementDate: '2026-04-30',
        closingBalance: '11 460,00',
      }),
      (err) => err.code === 'IMPORT_INVALID'
    );
    const partial = await dg('imports.commit', {
      batchId: analysis.batchId,
      accountId: accountA.id,
      statementDate: '2026-04-30',
      closingBalance: '11 460,00',
      allowPartial: true,
      reason: 'Import partiel explicitement confirmé',
    });
    assert.equal(partial.importedCount, 1);
    assert.equal(partial.rejectedCount, 1);
    const detail = await dg('imports.detail', { id: partial.importId });
    assert.ok(detail.issues.some((i) => i.severity === 'ERROR'));
  });

  await t.test('le journal conserve l’historique des imports et leurs empreintes', async () => {
    const imports = await dg('imports.list');
    assert.ok(imports.length >= 2);
    assert.ok(imports.every((i) => i.sourceType === 'CSV' || i.sourceType === 'XLSX'));
    const detail = await dg('imports.detail', { id: imports[0].id });
    assert.ok(detail.sourceFilename);
    assert.ok(detail.sourceSha256 || detail.sha256);
  });
});
