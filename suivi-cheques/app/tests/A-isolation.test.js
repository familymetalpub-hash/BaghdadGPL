'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestApp } = require('./helpers');

test('A — isolation multi-sociétés et contrôle des identifiants', async (t) => {
  const app = await createTestApp({ responsable: true });
  t.after(() => app.cleanup());
  const { dg, admin, responsable } = app.clients;
  const { companyA, companyB, accountA, accountB } = app.data;

  assert.ok(companyB, 'la seconde société doit exister');

  const chequeB = await dg('cheques.create', {
    companyId: companyB.id,
    accountId: accountB.id,
    direction: 'RECU',
    chequeNumber: 'B-1001',
    partyName: 'Client Bêta',
    amountCents: 5_000_00,
    issueDate: '2026-02-01',
    receiptDate: '2026-02-02',
    dueDate: '2026-03-01',
  });
  const chequeA = await dg('cheques.create', {
    companyId: companyA.id,
    accountId: accountA.id,
    direction: 'RECU',
    chequeNumber: 'A-1001',
    partyName: 'Client Alpha',
    amountCents: 7_000_00,
    issueDate: '2026-02-01',
    receiptDate: '2026-02-02',
    dueDate: '2026-03-01',
  });

  await t.test('le responsable ne voit que ses sociétés', async () => {
    const companies = await responsable('companies.list');
    assert.deepEqual(companies.map((c) => c.id), [companyA.id]);
    const accounts = await responsable('accounts.list');
    assert.ok(accounts.every((a) => a.companyId === companyA.id));
    const cheques = await responsable('cheques.list', { page: 1, pageSize: 100 });
    assert.ok(cheques.items.length >= 1);
    assert.ok(cheques.items.every((c) => c.companyId === companyA.id));
    assert.ok(!cheques.items.some((c) => c.id === chequeB.id));
  });

  await t.test('un identifiant d’une autre société est refusé', async () => {
    await assert.rejects(
      () => responsable('cheques.get', { id: chequeB.id }),
      (err) => err.code === 'FORBIDDEN',
      'lecture directe par identifiant doit être refusée'
    );
    await assert.rejects(
      () => responsable('cheques.create', {
        companyId: companyB.id,
        accountId: accountB.id,
        direction: 'RECU',
        chequeNumber: 'B-9999',
        partyName: 'Intrusion',
        amountCents: 1000,
        issueDate: '2026-02-01',
        receiptDate: '2026-02-02',
        dueDate: '2026-03-01',
      }),
      (err) => err.code === 'FORBIDDEN'
    );
    await assert.rejects(
      () => responsable('accounts.update', { id: accountB.id, label: 'Détourné' }),
      (err) => err.code === 'FORBIDDEN'
    );
  });

  await t.test('les tableaux de bord sont consolidés selon le périmètre', async () => {
    const respDash = await responsable('finance.dashboard', { asOf: '2026-02-10' });
    const dgDash = await dg('finance.dashboard', { asOf: '2026-02-10' });
    assert.equal(respDash.counts.companies, 1);
    assert.equal(dgDash.counts.companies, 2);
    assert.ok(dgDash.totals.bookBalanceCents > respDash.totals.bookBalanceCents);
  });

  await t.test('le DG voit toutes les sociétés et le responsable ne peut pas administrer les comptes', async () => {
    const all = await dg('cheques.list', { page: 1, pageSize: 100 });
    assert.ok(all.items.some((c) => c.id === chequeA.id));
    assert.ok(all.items.some((c) => c.id === chequeB.id));
    await assert.rejects(
      () => responsable('accounts.create', {
        companyId: companyA.id,
        bankId: app.data.bank.id,
        label: 'Compte interdit',
        accountNumber: 'INTERDIT-1',
        openingBalanceCents: 0,
        openingDate: '2026-01-01',
      }),
      (err) => err.code === 'FORBIDDEN'
    );
    const adminClients = await admin('companies.list');
    assert.equal(adminClients.length, 2);
  });

  await t.test('une méthode IPC inconnue ou une charge malformée est rejetée', async () => {
    await assert.rejects(
      () => dg('sql.raw', { query: 'SELECT * FROM users' }),
      (err) => err.code === 'IPC_INVALID'
    );
    await assert.rejects(
      () => dg('companies.create', { name: 'Sans code' }),
      (err) => err.code === 'IPC_INVALID'
    );
  });
});
