'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestApp } = require('./helpers');

test('D — exactitude financière : dates réelles, soldes distincts, transferts', async (t) => {
  const app = await createTestApp({ openingBalanceCents: 1_000_000 });
  t.after(() => app.cleanup());
  const { dg } = app.clients;
  const { companyA, accountA, accountB } = app.data;

  await dg('transactions.create', {
    accountId: accountA.id,
    type: 'DEPOT',
    amountCents: 100_000,
    effectiveDate: '2026-02-05',
    description: 'Dépôt espèces',
  });
  await dg('transactions.create', {
    accountId: accountA.id,
    type: 'FRAIS',
    amountCents: 10_000,
    effectiveDate: '2026-02-06',
    description: 'Frais de tenue de compte',
  });
  await dg('transactions.transfer', {
    accountId: accountA.id,
    toAccountId: accountB.id,
    amountCents: 50_000,
    effectiveDate: '2026-02-07',
    description: 'Virement interne',
  });

  const received = await dg('cheques.create', {
    companyId: companyA.id,
    accountId: accountA.id,
    direction: 'RECU',
    chequeNumber: 'FIN-1001',
    partyName: 'Client Finance',
    amountCents: 200_000,
    issueDate: '2026-02-01',
    receiptDate: '2026-02-02',
    dueDate: '2026-03-10',
  });
  const issued = await dg('cheques.create', {
    companyId: companyA.id,
    accountId: accountA.id,
    direction: 'EMIS',
    chequeNumber: 'FIN-2002',
    partyName: 'Fournisseur Finance',
    amountCents: 300_000,
    issueDate: '2026-02-03',
    dueDate: '2026-03-15',
  });
  await dg('cheques.changeStatus', { id: received.id, to: 'DEPOSE', eventDate: '2026-03-05', reason: 'Remise banque' });

  const positions = async (asOf) => {
    const result = await dg('finance.accounts', { asOf });
    return Object.fromEntries(result.accounts.map((a) => [a.accountId, a]));
  };

  const february = await positions('2026-03-01');
  assert.equal(february[accountA.id].bookBalanceCents, 1_040_000, 'ouverture + dépôt − frais − transfert sortant');
  assert.equal(february[accountB.id].bookBalanceCents, 5_050_000, 'le transfert entrant est compté une seule fois');
  assert.equal(february[accountA.id].pendingIncomingCents, 200_000);
  assert.equal(february[accountA.id].pendingOutgoingCents, 300_000);
  assert.equal(february[accountA.id].forecastBalanceCents, 940_000);

  await t.test('l’échéance n’est pas une date de règlement', async () => {
    // Après l'échéance du 10 mars mais avant l'encaissement réel du 12.
    const beforeCollection = await positions('2026-03-11');
    assert.equal(beforeCollection[accountA.id].bookBalanceCents, 1_040_000);
    assert.equal(beforeCollection[accountA.id].pendingIncomingCents, 200_000);
    await dg('cheques.changeStatus', { id: received.id, to: 'ENCAISSE', eventDate: '2026-03-12', reason: 'Crédit constaté' });
    const afterCollection = await positions('2026-03-11');
    assert.equal(afterCollection[accountA.id].bookBalanceCents, 1_040_000, 'un encaissement du 12 ne modifie pas le solde au 11');
    const afterRealDate = await positions('2026-03-12');
    assert.equal(afterRealDate[accountA.id].bookBalanceCents, 1_240_000);
    assert.equal(afterRealDate[accountA.id].pendingIncomingCents, 0);
  });

  await t.test('le paiement effectif réduit le solde à sa date réelle', async () => {
    const beforePayment = await positions('2026-03-15');
    assert.equal(beforePayment[accountA.id].bookBalanceCents, 1_240_000);
    await dg('cheques.changeStatus', { id: issued.id, to: 'PAYE', eventDate: '2026-03-16', reason: 'Débit constaté' });
    const beforeDate = await positions('2026-03-15');
    assert.equal(beforeDate[accountA.id].bookBalanceCents, 1_240_000);
    const afterDate = await positions('2026-03-16');
    assert.equal(afterDate[accountA.id].bookBalanceCents, 940_000);
  });

  await t.test('solde de relevé distinct du solde comptable', async () => {
    await dg('imports.manualBalance', {
      accountId: accountA.id,
      statementDate: '2026-03-31',
      closingBalanceCents: 900_000,
      reason: 'Solde constaté sur relevé papier',
    });
    const positionsNow = await positions('2026-03-31');
    assert.equal(positionsNow[accountA.id].bookBalanceCents, 940_000);
    assert.equal(positionsNow[accountA.id].statement.closingBalanceCents, 900_000);
    assert.equal(positionsNow[accountA.id].statement.differenceCents, -40_000);
    const dash = await dg('finance.dashboard', { asOf: '2026-03-31' });
    assert.equal(dash.totals.bookBalanceCents, 940_000 + 5_050_000);
    assert.equal(dash.totals.statementBalanceCents, 900_000, 'seuls les comptes couverts par un relevé sont inclus');
    assert.equal(dash.totals.statementAccountsCount, 1);
    assert.equal(dash.totals.accountsWithoutStatement, 1);
  });

  await t.test('transferts équilibrés et absence de double comptage', async () => {
    const all = await positions('2026-03-31');
    const totalBook = all[accountA.id].bookBalanceCents + all[accountB.id].bookBalanceCents;
    assert.equal(totalBook, 5_990_000, 'ouverture + dépôt − frais + encaissement − paiement, transfert neutre');
    const summary = await dg('finance.transfers', { asOf: '2026-03-31' });
    assert.equal(summary.transfers.length, 1);
    assert.equal(summary.transfers[0].amountCents, 50_000);
    assert.equal(summary.netByPair.length, 1);
    assert.match(summary.disclaimer || '', /transfert/i);
  });

  await t.test('les dates futures et les transferts invalides sont refusés', async () => {
    await assert.rejects(
      () => dg('transactions.create', {
        accountId: accountA.id,
        type: 'DEPOT',
        amountCents: 1000,
        effectiveDate: '2099-01-01',
      }),
      (err) => err.code === 'VALIDATION'
    );
    await assert.rejects(
      () => dg('transactions.transfer', {
        accountId: accountA.id,
        toAccountId: accountA.id,
        amountCents: 1000,
        effectiveDate: '2026-02-10',
      }),
      (err) => err.code === 'VALIDATION'
    );
  });
});
