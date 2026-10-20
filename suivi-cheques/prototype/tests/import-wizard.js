const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync(require('node:path').join(__dirname, '..', 'suivi-cheques-prototype.html'), 'utf8');
const errs=[];
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'https://demo.local/',beforeParse(w){w.structuredClone=w.structuredClone||((v)=>JSON.parse(JSON.stringify(v)));w.print=()=>{};w.addEventListener('error',e=>errs.push(String(e.error&&e.error.stack||e.message)));}});
const w=dom.window;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const q=(s)=>w.document.querySelector(s);
const qa=(s)=>[...w.document.querySelectorAll(s)];
async function wait(fn,label,t=4000){const s=Date.now();while(Date.now()-s<t){try{if(fn())return true}catch{}await sleep(30)}throw new Error('timeout '+label)}

(async()=>{
  await sleep(400);
  w.location.hash='#reconciliation'; w.dispatchEvent(new w.HashChangeEvent('hashchange')); await sleep(350);
  q('#importStatement').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  await sleep(150);
  const csv='Date;Valeur;Libellé;Débit;Crédit;Solde;Référence\r\n'
    +'05/10/2026;05/10/2026;REMISE CHEQUE 4451299;0,00;2 000,00;12 000,00;W-1\r\n'
    +'06/10/2026;;COMMISSION;25,00;0,00;11 975,00;W-2\r\n';
  const file=new w.File([csv],'releve-octobre.csv',{type:'text/csv'});
  const input=q('#wzFile');
  Object.defineProperty(input,'files',{value:[file],configurable:true});
  input.dispatchEvent(new w.Event('change',{bubbles:true}));
  await wait(()=>q('#wzFileName') && q('#wzFileName').textContent.includes('releve-octobre.csv'),'file read');
  const results=[['fichier lu', true]];
  q('#wzAccount').value='1';
  qa('.modal footer .btn').find(b=>b.textContent==='Continuer').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  await wait(()=>q('#mapDate'),'step2');
  results.push(['étape colonnes', Boolean(q('#mapDate') && q('#wzDateFormat'))]);
  qa('.modal footer .btn').find(b=>b.textContent==='Continuer').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  await wait(()=>q('#wzConfirm'),'step3');
  results.push(['étape confirmation', Boolean(q('#wzClosing') && q('#wzUseful')===null)]);
  results.push(['résumé lignes', q('.modal').textContent.includes('Lignes valides')]);
  const closing=q('#wzClosing');
  closing.value='11 975,00';
  q('#wzConfirm').checked=true;
  qa('.modal footer .btn').find(b=>b.textContent==='Importer').dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
  await wait(()=>!q('.modal'),'import close');
  await sleep(400);
  results.push(['import effectué', q('#view').textContent.includes('Historique des imports') || q('#view').textContent.includes('IMP-')]);
  const imported = await w.eval("api.call('imports.list', {})");
  results.push(['deux lignes importées', imported[0] && imported[0].importedCount===2]);
  const reconcile = await w.eval("api.call('reconciliation.list',{matchStatus:'ALL'})");
  results.push(['lignes visibles', reconcile.items.some(i=>i.description==='REMISE CHEQUE 4451299')]);
  let failed=0;
  for(const [n,ok] of results){if(!ok)failed++;console.log((ok?'ok   ':'FAIL ')+n)}
  console.log('ERRORS',errs.length);
  errs.slice(0,3).forEach(e=>console.log(e));
  console.log(failed?'\nWIZARD FAILED':'\nWIZARD OK');
  process.exit(failed||errs.length?1:0);
})().catch(e=>{console.error('FATAL',e);process.exit(1)});
