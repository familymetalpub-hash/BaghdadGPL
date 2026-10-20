'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestApp } = require('./helpers');

test('B — cycle de vie des chèques et détection des doublons', async (t) => {
  const app = await createTestApp({ openingBalanceCents: 10_000_000 });
  t.after(() => app.cleanup());
  const { dg, admin } = app.clients;
  const { companyA, accountA } = app.data;

  const base = {
    companyId: companyA.id,
    accountId: accountA.id,
    direction: 'RECU',
    chequeNumber: '7788991',
    partyName: 'Client Cycle',
    amountCents: 2_500_000,
    issueDate: '2026-02-01',
    receiptDate: '2026-02-02',
    dueDate: '2026-02-25',
  };

  const cheque = await dg('cheques.create', base);
  assert.match(cheque.reference, /^CHQ-2026-\d{6}$/);
  assert.equal(cheque.status, 'RECU');

  await t.test('doublon sur société + compte + sens + numéro', async () => {
    await assert.rejects(
      () => dg('cheques.create', { ...base, partyName: 'Autre partie', amountCents: 1 }),
      (err) => err.code === 'DUPLICATE_CHEQUE'
    );
    const account2 = await admin('accounts.create', {
      companyId: companyA.id,
      bankId: app.data.bank.id,
      label: 'Compte bis',
      accountNumber: 'BIS-0001',
      openingBalanceCents: 0,
      openingDate: '2026-01-01',
    });
    const sameNumberOtherAccount = await dg('cheques.create', {
      ...base,
      accountId: account2.id,
      partyName: 'Autre compte',
    });
    assert.ok(sameNumberOtherAccount.id);
    // Le sens fait partie de la clé : un chèque émis portant le même numéro est un autre document.
    const otherDirection = await dg('cheques.create', {
      ...base,
      direction: 'EMIS',
      chequeNumber: '7788991',
      receiptDate: undefined,
      partyName: 'Bénéficiaire',
    });
    assert.equal(otherDirection.direction, 'EMIS');
  });

  await t.test('transitions contrôlées : dépôt obligatoire avant encaissement', async () => {
    await assert.rejects(
      () => dg('cheques.changeStatus', { id: cheque.id, to: 'ENCAISSE', eventDate: '2026-02-20', reason: 'Trop tôt' }),
      (err) => err.code === 'VALIDATION'
    );
    const deposited = await dg('cheques.changeStatus', {
      id: cheque.id,
      to: 'DEPOSE',
      eventDate: '2026-02-10',
      reason: 'Remise en banque',
    });
    assert.equal(deposited.status, 'DEPOSE');
    assert.equal(deposited.depositDate, '2026-02-10');
    await assert.rejects(
      () => dg('cheques.changeStatus', { id: cheque.id, to: 'ENCAISSE', eventDate: '2026-02-09', reason: 'Antérieur au dépôt' }),
      (err) => err.code === 'VALIDATION'
    );
    const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await assert.rejects(
      () => dg('cheques.changeStatus', { id: cheque.id, to: 'ENCAISSE', eventDate: future, reason: 'Futur' }),
      (err) => err.code === 'VALIDATION',
      'une date future ne doit pas être acceptée'
    );
    const collected = await dg('cheques.changeStatus', {
      id: cheque.id,
      to: 'ENCAISSE',
      eventDate: '2026-02-20',
      reason: 'Encaissement confirmé',
    });
    assert.equal(collected.status, 'ENCAISSE');
    assert.equal(collected.collectionDate, '2026-02-20');
    assert.equal(collected.paymentDate, null);
  });

  await t.test('un chèque émis ne peut pas recevoir de date d’encaissement', async () => {
    const issued = await dg('cheques.create', {
      companyId: companyA.id,
      accountId: accountA.id,
      direction: 'EMIS',
      chequeNumber: 'EM-0001',
      partyName: 'Fournisseur Cycle',
      amountCents: 900_000,
      issueDate: '2026-02-03',
      dueDate: '2026-02-28',
    });
    assert.equal(issued.status, 'EMIS');
    await assert.rejects(
      () => dg('cheques.update', {
        id: issued.id,
        version: issued.version,
        changes: { collectionDate: '2026-02-15' },
        reason: 'Test interdit',
      }),
      (err) => err.code === 'VALIDATION'
    );
    const paid = await dg('cheques.changeStatus', {
      id: issued.id,
      to: 'PAYE',
      eventDate: '2026-02-28',
      reason: 'Paiement débité',
    });
    assert.equal(paid.status, 'PAYE');
    assert.equal(paid.paymentDate, '2026-02-28');
  });

  await t.test('le sens est immuable et les champs matériels protégés', async () => {
    const fresh = await dg('cheques.get', { id: cheque.id });
    await assert.rejects(
      () => dg('cheques.update', {
        id: cheque.id,
        version: fresh.version,
        changes: { direction: 'EMIS' },
        reason: 'Tentative',
      }),
      (err) => err.code === 'FORBIDDEN' || err.code === 'VALIDATION'
    );
  });

  await t.test('historique séparé et statut courant cohérents', async () => {
    const detail = await dg('cheques.get', { id: cheque.id });
    assert.equal(detail.events.length, 3);
    assert.deepEqual(detail.events.map((e) => e.toStatus), ['RECU', 'DEPOSE', 'ENCAISSE']);
    assert.ok(detail.events.every((e) => e.actorName === 'Directeur Général Test'));
    const history = await dg('cheques.history', { id: cheque.id });
    assert.equal(history.length, 3);
  });
});
