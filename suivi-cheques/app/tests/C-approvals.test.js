'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestApp } = require('./helpers');

const HIGH_VALUE = 60_000_000; // 600 000,00 DZD, au-dessus du seuil par défaut

test('C — approbations : aucune écriture avant décision, pas d’auto-approbation', async (t) => {
  const app = await createTestApp({ secondDg: true, responsable: true, openingBalanceCents: 10_000_000 });
  t.after(() => app.cleanup());
  const { dg, dg2, responsable } = app.clients;
  const { companyA, accountA } = app.data;

  const payload = {
    companyId: companyA.id,
    accountId: accountA.id,
    direction: 'RECU',
    chequeNumber: 'AP-1001',
    partyName: 'Client Approbation',
    amountCents: HIGH_VALUE,
    issueDate: '2026-02-01',
    receiptDate: '2026-02-02',
    dueDate: '2026-03-01',
  };

  const result = await responsable('cheques.create', payload);
  assert.equal(result.pendingApproval, true);
  assert.ok(result.approval && result.approval.id);
  const afterSubmit = await dg('cheques.list', { page: 1, pageSize: 100 });
  assert.equal(afterSubmit.total, 0, 'aucun chèque ne doit exister avant approbation');

  await t.test('le responsable ne peut pas décider', async () => {
    await assert.rejects(
      () => responsable('approvals.decide', { id: result.approval.id, decision: 'APPROVED' }),
      (err) => err.code === 'FORBIDDEN'
    );
  });

  await t.test('le DG approuve : l’opération est appliquée atomiquement', async () => {
    const decision = await dg('approvals.decide', {
      id: result.approval.id,
      decision: 'APPROVED',
      reason: 'Vérification des pièces effectuée',
    });
    assert.equal(decision.status, 'APPROVED');
    const list = await dg('cheques.list', { page: 1, pageSize: 100 });
    assert.equal(list.total, 1);
    const created = list.items[0];
    assert.equal(created.amountCents, HIGH_VALUE);
    assert.equal(created.status, 'RECU');
    const request = await dg('approvals.get', { id: result.approval.id });
    assert.equal(request.status, 'APPROVED');
    assert.ok(request.appliedAt);
    assert.ok(request.events.some((e) => e.action === 'APPLY'));
  });

  await t.test('une demande déjà traitée ne peut pas être traitée deux fois', async () => {
    await assert.rejects(
      () => dg('approvals.decide', { id: result.approval.id, decision: 'APPROVED' }),
      (err) => err.code === 'CONFLICT'
    );
  });

  await t.test('auto-approbation interdite pour un DG demandeur', async () => {
    const own = await dg2('cheques.create', { ...payload, chequeNumber: 'AP-2002', amountCents: HIGH_VALUE + 100 });
    assert.equal(own.pendingApproval, true);
    await assert.rejects(
      () => dg2('approvals.decide', { id: own.approval.id, decision: 'APPROVED' }),
      (err) => err.code === 'FORBIDDEN'
    );
    const approvedByOther = await dg('approvals.decide', { id: own.approval.id, decision: 'APPROVED' });
    assert.equal(approvedByOther.status, 'APPROVED');
  });

  await t.test('le rejet ne crée aucune écriture', async () => {
    const before = await dg('cheques.list', { page: 1, pageSize: 100 });
    const rejected = await responsable('cheques.create', {
      ...payload,
      chequeNumber: 'AP-3003',
      amountCents: HIGH_VALUE + 200,
    });
    const decision = await dg('approvals.decide', {
      id: rejected.approval.id,
      decision: 'REJECTED',
      reason: 'Justificatif manquant',
    });
    assert.equal(decision.status, 'REJECTED');
    const after = await dg('cheques.list', { page: 1, pageSize: 100 });
    assert.equal(after.total, before.total);
  });

  await t.test('annulation d’un chèque finalisé soumise à approbation', async () => {
    const approved = await dg('cheques.list', { page: 1, pageSize: 100 });
    const target = approved.items.find((c) => c.amountCents === HIGH_VALUE);
    // Le chèque est encore RECU : une annulation directe est possible pour le DG.
    const direct = await dg('cheques.cancel', { id: target.id, reason: 'Annulation avant remise' });
    assert.equal(direct.status, 'ANNULE');
  });
});

test('C bis — DG unique : pas de demande sans approbateur possible', async (t) => {
  const app = await createTestApp({ openingBalanceCents: 1_000_000 });
  t.after(() => app.cleanup());
  const { dg } = app.clients;
  await assert.rejects(
    () => dg('cheques.create', {
      companyId: app.data.companyA.id,
      accountId: app.data.accountA.id,
      direction: 'EMIS',
      chequeNumber: 'SOLO-1',
      partyName: 'Fournisseur',
      amountCents: HIGH_VALUE,
      issueDate: '2026-02-01',
      dueDate: '2026-03-01',
    }),
    (err) => err.code === 'FORBIDDEN' && /Aucun autre Directeur Général/.test(err.message)
  );
});
