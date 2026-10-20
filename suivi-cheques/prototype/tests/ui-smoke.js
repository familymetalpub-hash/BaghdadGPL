const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'suivi-cheques-prototype.html'), 'utf8');
const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://demo.local/',
  beforeParse(window) {
    window.structuredClone = window.structuredClone || ((v) => JSON.parse(JSON.stringify(v)));
    window.print = () => { window.__printed = true; };
    window.addEventListener('error', (e) => errors.push('window.error: ' + (e.error ? e.error.stack : e.message)));
  },
});
const { window } = dom;
window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + (e.reason && e.reason.stack || e.reason)));

function q(sel) { return window.document.querySelector(sel); }
function qa(sel) { return Array.from(window.document.querySelectorAll(sel)); }
function text() { return q('#view') ? q('#view').textContent : ''; }
function click(el) {
  if (!el) throw new Error('click: element missing');
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (fn()) return true; } catch {}
    await sleep(25);
  }
  throw new Error('timeout waiting: ' + label);
}

(async () => {
  await waitFor(() => q('#nav') && q('#nav').children.length > 2, 'nav');
  await waitFor(() => text().includes('Solde comptable'), 'dashboard');
  const results = [];
  results.push(['dashboard KPI', text().includes('Solde comptable') && text().includes('Solde prévisionnel')]);
  results.push(['demo banner', window.document.body.textContent.includes('MODE DÉMONSTRATION')]);

  for (const route of ['companies', 'accounts', 'cheques', 'approvals', 'reconciliation', 'reports', 'audit', 'documents', 'settings']) {
    window.location.hash = '#' + route;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await sleep(150);
    results.push(['route ' + route, text().length > 80]);
  }

  // Retour aux chèques
  window.location.hash = '#cheques';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(200);
  results.push(['cheques table rows', qa('#chequesTable tbody tr').length > 3]);

  // Ouverture du formulaire de chèque
  click(q('#newCheque'));
  await sleep(80);
  results.push(['cheque modal open', Boolean(q('.modal'))]);
  // remplissage
  q('#cfNumber').value = 'TEST-999';
  q('#cfParty').value = 'Client Test';
  q('#cfAmount').value = '125 000,00';
  q('#cfIssue').value = '2026-10-01';
  q('#cfReceipt').value = '2026-10-02';
  q('#cfDue').value = '2026-10-20';
  const saveBtn = qa('.modal footer .btn').find((b) => b.textContent.includes('Enregistrer'));
  click(saveBtn);
  await sleep(300);
  results.push(['cheque created', !q('.modal') && text().includes('CHQ-2026-')]);

  // rôle Responsable : ajout d'un chèque au-dessus du seuil -> approbation
  q('#roleSwitch').value = 'RESPONSABLE';
  q('#roleSwitch').dispatchEvent(new window.Event('change'));
  await sleep(200);
  window.location.hash = '#cheques';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(200);
  click(q('#newCheque'));
  await sleep(100);
  q('#cfNumber').value = 'TEST-1000';
  q('#cfParty').value = 'Client Seuil';
  q('#cfAmount').value = '650 000,00';
  q('#cfIssue').value = '2026-10-01';
  q('#cfReceipt').value = '2026-10-02';
  q('#cfDue').value = '2026-11-20';
  click(qa('.modal footer .btn').find((b) => b.textContent.includes('Enregistrer')));
  await sleep(400);
  results.push(['high value goes to approvals', text().includes('Approbations') || text().includes('demande')]);
  const pendingText = q('#view').textContent;
  results.push(['no immediate creation', !pendingText.includes('CHQ-2026-000027')]);

  // Retour DG, approbations
  q('#roleSwitch').value = 'DG';
  q('#roleSwitch').dispatchEvent(new window.Event('change'));
  await sleep(200);
  window.location.hash = '#approvals';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(250);
  results.push(['approvals list', qa('[data-approval]').length >= 3]);
  click(qa('[data-approval]')[0]);
  await sleep(150);
  results.push(['approval detail', Boolean(q('.modal')) && q('.modal').textContent.includes('Valeurs avant / après')]);
  const closeBtn = qa('.modal footer .btn').find((b) => b.textContent === 'Fermer');
  click(closeBtn);
  await sleep(60);

  // Rapprochement
  window.location.hash = '#reconciliation';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(400);
  results.push(['recon lines', text().includes('Lignes de relevé') && qa('[data-line]').length > 0]);
  click(qa('[data-line]')[0]);
  await sleep(200);
  results.push(['recon line modal', Boolean(q('.modal'))]);
  click(qa('.modal footer .btn').find((b) => b.textContent === 'Fermer'));
  await sleep(60);

  // Import wizard step 1 visible
  click(q('#importStatement'));
  await sleep(120);
  results.push(['import wizard', Boolean(q('#wzAccount')) && Boolean(q('#wzPick'))]);
  click(qa('.modal footer .btn').find((b) => b.textContent === 'Annuler'));
  await sleep(60);

  // Rapports + export
  window.location.hash = '#reports';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(300);
  results.push(['reports preview', text().includes('Synthèse par société') || text().includes('Position des comptes')]);
  q('#rType').value = 'cheques_received';
  q('#rType').dispatchEvent(new window.Event('change'));
  await sleep(250);
  results.push(['report switch', text().includes('Chèques reçus')]);

  // Audit
  window.location.hash = '#audit';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(300);
  results.push(['audit entries', qa('[data-audit]').length > 0]);
  click(qa('[data-audit]')[0]);
  await sleep(120);
  results.push(['audit modal', Boolean(q('.modal')) && q('.modal').textContent.includes('Entrée d’audit')]);
  click(qa('.modal footer .btn').find((b) => b.textContent === 'Fermer'));

  // Documents
  window.location.hash = '#documents';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(250);
  results.push(['documents list', text().includes('bordereau-remise')]);

  // Paramètres
  window.location.hash = '#settings';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(250);
  results.push(['settings general', text().includes('Organisation')]);
  click(qa('[data-tab]').find((b) => b.textContent.includes('Approbations')));
  await sleep(150);
  results.push(['approval rules tab', text().includes('Seuil d’approbation')]);
  click(qa('[data-tab]').find((b) => b.textContent.includes('Migration')));
  await sleep(150);
  results.push(['migration tab', text().includes('Analyser une sauvegarde héritée')]);
  results.push(['migration gated for DG', q('#migLocal').disabled === true]);
  q('#roleSwitch').value = 'ADMIN';
  q('#roleSwitch').dispatchEvent(new window.Event('change'));
  await sleep(250);
  click(qa('[data-tab]').find((b) => b.textContent.includes('Migration')));
  await sleep(150);
  click(q('#migLocal'));
  await waitFor(() => q('#migResult') && /Aucune sauvegarde|JSON invalide/.test(q('#migResult').textContent), 'migration error handled');
  results.push(['migration missing source handled', /Aucune sauvegarde/.test(q('#migResult').textContent)]);
  // Sauvegarde accessible à l'administrateur
  window.location.hash = '#backup';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await sleep(250);
  results.push(['backup page admin', text().includes('Sauvegardes') && text().includes('Historique des sauvegardes')]);

  const failed = results.filter(([, ok]) => !ok);
  console.log(results.map(([name, ok]) => (ok ? 'ok   ' : 'FAIL ') + name).join('\n'));
  console.log('\nERRORS:', errors.length);
  errors.slice(0, 5).forEach((e) => console.log(e));
  console.log(failed.length ? `\nSMOKE FAILED (${failed.length})` : '\nPROTOTYPE SMOKE OK');
  process.exit(failed.length || errors.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
