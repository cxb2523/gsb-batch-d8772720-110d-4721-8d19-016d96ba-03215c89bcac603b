const giftLabels={queued:'待兑换',sending:'兑换中',success:'兑换成功',used:'已兑换',rejected:'服务器拒绝',unknown:'待确认',skipped:'未发送'};
const giftBatchLabels={success:'成功',used:'已兑换',rejected:'拒绝',unknown:'待确认',skipped:'未发送'};
let giftPage=1,giftRows=[],giftAccounts=[],giftSelected=new Set(),giftChosen=false,giftViewed='',giftStarting=false,giftNote='';
let giftInitial=null,giftInitialBatch=0;
function paintGiftPage(){
  const last=Math.max(1,Math.ceil(giftRows.length/10));
  giftPage=Math.min(last,Math.max(1,giftPage));
  $('gift-prev').disabled=giftPage===1;$('gift-next').disabled=giftPage===last;
  $('gift-page').textContent=giftPage+' / '+last+' 页，共 '+giftRows.length+' 条';
  const body=$('gift-code-history'),visible=giftRows.slice((giftPage-1)*10,giftPage*10);
  const key=JSON.stringify([giftViewed,giftPage,visible]);
  if(body.pageKey===key)return;
  body.pageKey=key;clear(body);
  for(const r of visible){
    const tr=el('tr');
    for(const value of [r.code,giftLabels[r.status]||r.status,r.detail,when(r.at)])tr.append(el('td','',value));
    body.append(tr);
  }
}
$('gift-prev').onclick=()=>{giftPage--;paintGiftPage()};
$('gift-next').onclick=()=>{giftPage++;paintGiftPage()};
function giftCanStart(a){return !a.paused&&!a.running&&!a.error;}
function giftTargets(){return giftAccounts.filter(a=>giftSelected.has(a.id)&&giftCanStart(a)).map(a=>a.id);}
function giftAccountNote(a){
  if(a.error)return a.error;
  if(a.paused)return '已暂停';
  if(a.running)return '兑换中 '+(a.total-(a.counts.queued??0)-(a.counts.sending??0))+' / '+a.total;
  const last=Object.entries(giftBatchLabels).filter(([status])=>a.counts[status]).map(([status,label])=>label+' '+a.counts[status]);
  return (a.connected?'已连接':'未连接')+(last.length?' · 上批：'+last.join('，'):'');
}
function paintGiftState(){
  const running=giftAccounts.filter(a=>a.running).length;
  $('gift-code-state').textContent=[running?'正在兑换，剩余 '+running+' 个账号':'',giftNote].filter(Boolean).join('；');
}
function paintGiftInitial(){
  const button=$('gift-load-initial'),note=$('gift-code-initial-note');
  if(!giftInitial){button.disabled=true;note.textContent='初始码读取中';return;}
  const batches=giftInitial.batches??[];
  button.disabled=!batches.length;
  const batchCount=batches.length;
  const current=batchCount?giftInitialBatch%batchCount:0;
  button.textContent=batchCount>1?'载入初始码（第'+(current+1)+'/'+batchCount+'批）':'载入初始码';
  const updated=giftInitial.updatedAt?.slice(0,10);
  note.textContent='来源更新 '+(updated||'未知')+'；列表 '+giftInitial.total+' 条，去重 '+giftInitial.unique+' 条；已知过期 '+giftInitial.expired+' 条；单批最多100条';
}
async function refreshGiftInitial(){
  if(giftInitial)return;
  try{giftInitial=await call('/api/gift-codes/initial');paintGiftInitial();}
  catch(error){$('gift-code-initial-note').textContent='初始码读取失败：'+error.message;$('gift-load-initial').disabled=true;}
}
$('gift-load-initial').onclick=()=>{
  const batches=giftInitial?.batches??[];
  if(!batches.length)return;
  const batchIndex=giftInitialBatch%batches.length;
  $('gift-code-input').value=batches[batchIndex].join('\n');
  giftInitialBatch=(batchIndex+1)%batches.length;
  paintGiftInitial();
};
function paintGiftAccounts(){
  const box=$('gift-account-list'),key=giftAccounts.map(a=>a.id+'\n'+a.title).join('\n');
  if(box.accountsKey!==key){
    box.accountsKey=key;clear(box);
    for(const a of giftAccounts){
      const input=el('input');input.type='checkbox';
      input.onchange=()=>{giftChosen=true;if(input.checked)giftSelected.add(a.id);else giftSelected.delete(a.id);paintGiftAccounts();};
      const row=el('label','gift-account');row.append(input,el('span','',a.title),el('span','dim'));
      box.append(row);
    }
  }
  giftAccounts.forEach((a,index)=>{
    const row=box.children[index];
    row.firstChild.checked=giftSelected.has(a.id);row.firstChild.disabled=!giftCanStart(a);
    row.lastChild.textContent=giftAccountNote(a);
  });
  const ready=giftTargets().length;
  $('gift-selected-count').textContent='已选 '+ready+' / '+giftAccounts.length;
  $('gift-code-start').disabled=giftStarting||!ready;
  const picker=$('gift-record-account'),choices=giftAccounts.map(a=>[a.id,a.title]);
  if(picker.options.length!==choices.length||choices.some(([id,title],index)=>picker.options[index]?.value!==id||picker.options[index]?.text!==title)){
    picker.replaceChildren(...choices.map(([id,title])=>new Option(title,id)));
  }
  picker.value=giftViewed;
}
$('gift-select-all').onclick=()=>{giftChosen=true;giftSelected=new Set(giftAccounts.filter(giftCanStart).map(a=>a.id));paintGiftAccounts();};
$('gift-select-none').onclick=()=>{giftChosen=true;giftSelected=new Set();paintGiftAccounts();};
$('gift-record-account').onchange=()=>{giftViewed=$('gift-record-account').value;giftRows=[];giftPage=1;paintGiftPage();void refreshGiftCodes();};
let giftTimer, giftVersion=0;
function giftAccountChanged(){
  ++giftVersion;clearTimeout(giftTimer);
  giftViewed=current||'';giftNote='';
  if(!giftChosen)giftSelected=new Set(current?[current]:[]);
  giftRows=[];giftPage=1;paintGiftPage();
  $('gift-code-state').textContent='';
  if(!$('tab-giftcodes').classList.contains('hidden'))void refreshGiftCodes();
}
async function refreshGiftCodes(){
  const version=++giftVersion;
  clearTimeout(giftTimer);
  void refreshGiftInitial();
  if(!accounts.some(a=>a.id===giftViewed))giftViewed=current||'';
  if(!giftChosen)giftSelected=new Set(current?[current]:[]);
  const viewed=giftViewed;
  if(!viewed){$('gift-code-start').disabled=true;$('gift-code-state').textContent='请先添加账号';return;}
  try{
    const [list,data]=await Promise.all([call('/api/gift-codes/accounts'),call('/api/gift-codes?account='+encodeURIComponent(viewed))]);
    if(version!==giftVersion)return;
    giftAccounts=list.accounts;
    for(const id of [...giftSelected])if(!giftAccounts.some(a=>a.id===id&&!a.paused))giftSelected.delete(id);
    giftRows=data.rows;paintGiftPage();paintGiftAccounts();paintGiftState();
    if(giftAccounts.some(a=>a.running)&&!$('tab-giftcodes').classList.contains('hidden'))giftTimer=setTimeout(refreshGiftCodes,750);
  }catch(error){if(version===giftVersion)$('gift-code-state').textContent=error.message;}
}
$('gift-code-start').onclick=async()=>{
  const input=$('gift-code-input').value.trim(),targets=giftTargets();
  if(!input){$('gift-code-state').textContent='请先输入礼包码';return;}
  if(!targets.length){$('gift-code-state').textContent='请至少选择一个账号';return;}
  ++giftVersion;clearTimeout(giftTimer);giftStarting=true;giftNote='';$('gift-code-start').disabled=true;
  try{
    const data=await call('/api/gift-codes/redeem',{method:'POST',body:JSON.stringify({confirm:true,codes:input,accounts:targets})});
    if($('gift-code-input').value.trim()===input)$('gift-code-input').value='';
    const started=data.results.filter(r=>r.accepted),refused=data.results.filter(r=>!r.accepted);
    if(refused.length)giftNote='未开始：'+refused.map(r=>r.title+'（'+r.error+'）').join('、');
    if(!started.some(r=>r.id===giftViewed)){giftViewed=started[0].id;giftRows=[];giftPage=1;}
  }catch(error){giftNote=error.message;}
  giftStarting=false;
  await refreshGiftCodes();
};
