// Loaded into the console page alongside its shared account, table and log helpers.
const progressionViews = [
  { id:'guild-tech',tab:'guild',path:'/api/guild/tech',render:renderGuildTech },
  { id: 'trial', tab: 'stages', path: '/api/trials', render: renderTrialProgress },
  { id: 'equipment', tab: 'heroes', path: '/api/equipment', render: renderEquipment },
  { id: 'crafting', tab: 'heroes', path: '/api/equipment/crafting', render: renderCrafting },
  { id: 'lineup', tab: 'heroes', path: '/api/lineups', render: renderLineups },
  { id: 'pirate-board', tab: 'activities', path: '/api/pirates/board', render: renderPirateBoard },
  { id: 'guild', tab: 'guild', path: '/api/guild', render: renderGuild },
  { id: 'formation', tab: 'heroes', path: '/api/fleets/formation', render: renderFormations },
];
const pendingProgression = new Set();
const trialFailureOptions = new Map();
const viewVersions = new Map();
let trialTaskVersion = 0;
async function refreshProgression(only) {
  const account=current;
  const views=progressionViews.filter(v=>(!only||only===v.id)&&!$('tab-'+v.tab).classList.contains('hidden'));
  await Promise.all(views.map(async view=>{
    const box=$(view.id+'-view'),version=(viewVersions.get(view.id)||0)+1;
    viewVersions.set(view.id,version);
    const valid=()=>version===viewVersions.get(view.id)&&account===current;
    const same=box.dataset.owner===account;
    if(!same||!account||snapshot.paused||disconnected.has(account)){
      clear(box);delete box.progressSnapshot;
      if(view.id==='guild')clear($('guild-aid-view'));
    }
    box.dataset.owner=account||'';
    if(!account||snapshot.paused||disconnected.has(account)){
      box.textContent=!account?'请先选择账号':snapshot.paused?'账号已暂停':'请先连接账号';return;
    }
    if(!box.childNodes.length)box.textContent='正在读取…';
    box.setAttribute('aria-busy','true');
    try {
      const data=await call(view.path);
      if(!valid())return;
      const signature=JSON.stringify(data);
      if(box.progressSnapshot===signature)return;
      const keep=view.id==='trial'&&[...box.children].some(item=>item.trialControls?.account===account);
      if(keep)view.render(box,data,account);
      else{
        const next=el('div');view.render(next,data,account);
        if(view.id==='guild-tech'&&same&&box.querySelector('details')&&next.querySelector('details')){
          const oldGroups=[...box.querySelectorAll('details')],newGroups=[...next.querySelectorAll('details')];
          if(oldGroups.length===newGroups.length&&oldGroups.every((g,i)=>g.firstChild.textContent===newGroups[i].firstChild.textContent)){
            for(const [i,group] of newGroups.entries()){
              const oldBody=oldGroups[i].querySelector('tbody'),rows=[...group.querySelectorAll('tbody tr')];
              rows.forEach((r,j)=>{const old=oldBody.rows[j];if(!old)oldBody.append(r);else if(old.outerHTML!==r.outerHTML||old.dataset.techState!==r.dataset.techState){const focused=old.contains(document.activeElement);old.replaceWith(r);if(focused)r.querySelector('button:enabled')?.focus({preventScroll:true});}});
              while(oldBody.rows.length>rows.length)oldBody.deleteRow(-1);
            }
            [...next.querySelectorAll(':scope > p')].forEach((p,i)=>{box.children[i].textContent=p.textContent;});
            box.progressSnapshot=signature;return;
          }
        }
        const focused=box.contains(document.activeElement)?document.activeElement.getAttribute('aria-label'):null;
        box.replaceChildren(...next.childNodes);
        if(focused)[...box.querySelectorAll('[aria-label]')].find(e=>e.getAttribute('aria-label')===focused)?.focus({preventScroll:true});
      }
      box.progressSnapshot=signature;
    }catch(error){if(valid()){reportError(error);if(!box.progressSnapshot)box.textContent='读取失败，详情见运行日志';}}
    finally{if(valid())box.removeAttribute('aria-busy');}
  }));
}
for(const id of ['trial','guild','guild-tech','equipment','crafting','lineup'])$(id+'-refresh').onclick=()=>refreshProgression(id);

function progressionAction(label, path, payload, account, reason, group) {
  const key = JSON.stringify(group ? [account, group] : [account, path, payload]);
  const button = smallButton(pendingProgression.has(key) ? '执行中…' : label);
  button.disabled = Boolean(reason) || pendingProgression.has(key);
  if (reason) button.title = reason;
  button.onclick = async () => {
    if (current !== account || snapshot.paused || disconnected.has(account) || button.disabled || pendingProgression.has(key)) return;
    pendingProgression.add(key);
    button.disabled = true;
    button.textContent = '执行中…';
    try {
      await call(path, { method: 'POST', body: JSON.stringify({ ...payload, confirm: true }) });
    } catch (error) { if (account === current) reportError(error); }
    finally {
      pendingProgression.delete(key);
      if (account === current) {
        const view=path.includes('/lineups/')?'lineup':path.includes('/crafting/')?'crafting':path.includes('/pirates/')?'pirate-board':path.includes('/guild/')?'guild':path.includes('/equipment/')?'equipment':path.includes('/fleets/')?'formation':'trial';
        button.disabled=Boolean(reason);button.textContent=label;await refreshProgression(view);
      }
    }
  };
  return button;
}

function choice(bar, title, options) {
  const label = el('label', 'choice-field');
  label.appendChild(el('span', 'dim', title));
  const control = component('ui-select');
  const select = control.querySelector('select');
  select.setAttribute('aria-label', title);
  for (const item of options) {
    const option = new Option(item.text, item.value);
    option.disabled = Boolean(item.disabled);
    select.add(option);
  }
  const first = options.find(item => !item.disabled);
  if (first) select.value = first.value;
  else select.disabled = true;
  label.appendChild(control);
  bar.appendChild(label);
  return select;
}

function renderTrialProgress(box, rows, account) {
  for (const row of rows) {
    const previous=[...box.children].find(item=>item.trialControls?.account===account&&item.trialControls.row.raidId===row.raidId);
    const item=previous||el('div','progression-row');
    const body = el('div');
    const heading=el('div','title-with-help');heading.append(el('strong','',row.name));
    const help=['手动挑战的失败停止次数在本页设置，指同一关连续战败的停止上限，与挂机配置独立。','首轮免费、钻石和免广告扫荡分别计数。',row.sweepRewards?'扫荡掉落：'+row.sweepRewards:'',row.next?.rewards?'下一关奖励：'+row.next.rewards:''].filter(Boolean).join('\n');
    heading.append(makeHelpTip(row.name,help));body.append(heading);
    if (row.sweeps) {
      const state = row.sweeps, actions = el('div','bar');
      body.appendChild(el('p','dim trial-counts','剩余：免费 '+(row.freeLeft??'未同步')+' 次 · 钻石 '+(state.normalLeft??'未同步')+' 次 · 免广告 '+(state.adLeft??'未同步')+' 次'));
      for (const mode of ['paid','ad']) {
        const option = state[mode];
        const label = mode === 'paid' ? '钻石扫荡' + (option.cost > 0 ? ' · '+option.cost+'钻' : '') : '免广告扫荡';
        const reason = row.task?.running ? '该副本正在连续推关，请先停止' : option.allowed ? '' : option.reason;
        actions.appendChild(progressionAction(label, '/api/trials/sweep', { raidId:row.raidId,mode,
          expected:{passedStage:state.passedStage,buyUsed:state.buyUsed,adUsed:state.adUsed,cost:option.cost,day:state.day} }, account, reason));
        if(reason)heading.querySelector('[data-help-text]').dataset.helpText+='\n'+label+'限制：'+reason;
      }
      body.appendChild(actions);
    }
    if (row.next) body.appendChild(el('p','dim trial-next','下一关 '+row.next.level+' · 参考战力 '+fmt(row.next.power)));
    if (row.reason) body.appendChild(el('p', 'dim', row.failed ? '进度读取失败，详情见运行日志' : row.reason));
    const manual=el('span','trial-single-action');
    if (row.next && !row.reason) manual.appendChild(progressionAction('挑战一次', '/api/trials/challenge',
      { raidId: row.raidId, stageId: row.next.id }, account, row.task?.running ? '正在连续推关' : ''));
    if(manual.firstElementChild)manual.firstElementChild.setAttribute('aria-label',row.name+'挑战一次');
    if(previous){
      const controls=previous.trialControls;
      controls.details.replaceWith(body);controls.details=body;
      heading.append(controls.status);
      controls.manual.replaceWith(manual);controls.manual=manual;controls.row=row;
      paintTrialTask(controls,row.task??{});continue;
    }
    const content=el('div');content.append(body);
    const bar = el('div', 'bar trial-run-controls');
    const label = el('label', '', '失败停止次数');
    const input = el('input', 'config-input'); input.type = 'number'; input.min = '1'; input.step = '1'; input.value = trialFailureOptions.get(account + ':' + row.raidId) || '3';
    input.setAttribute('aria-label', row.name + '手动挑战失败停止次数'); input.oninput = () => trialFailureOptions.set(account + ':' + row.raidId, input.value); label.append(input);
    const start = smallButton('开始连续挑战'), stop = smallButton('停止挑战'), status = el('span', 'dim trial-task-status heading-status');
    status.setAttribute('role','status');heading.append(status);
    start.setAttribute('aria-label', row.name+'开始连续挑战');stop.setAttribute('aria-label',row.name+'停止挑战');
    start.disabled = !!row.reason || !row.next || row.task?.running; stop.disabled = !row.task?.running;
    const command=async(run)=>{
      const controls=item.trialControls;
      if(current!==account||snapshot.paused||disconnected.has(account)||controls.pending)return;
      if(run&&(!input.reportValidity()||!Number.isSafeInteger(Number(input.value))||Number(input.value)<1))return;
      const wasRunning=!!controls.row.task?.running;let refreshProgress=false;
      ++trialTaskVersion;controls.pending=true;paintTrialTask(controls,controls.row.task??{});
      try{
        const state=await call('/api/trials/'+(run?'start':'stop'),{method:'POST',body:JSON.stringify({confirm:true,raidId:row.raidId,...(run?{maxFailures:Number(input.value)}:{})})});
        if(account===current&&item.isConnected){refreshProgress=wasRunning&&!state.running;controls.row.task=state;paintTrialTask(controls,state);}
      }catch(error){if(account===current)reportError(error);}
      finally{controls.pending=false;if(account===current&&item.isConnected){paintTrialTask(controls,controls.row.task??{});await refreshTrialTasks();if(refreshProgress&&account===current)await refreshProgression('trial');}}
    };
    start.onclick=()=>command(true);stop.onclick=()=>command(false);
    status.dataset.trialTask = row.raidId;
    status.textContent = (row.task?.running ? '推关中 · ' : '未推关 · ') + (row.task?.reason || '尚未开启');
    item.trialControls = { start, stop, input, row, account,status,details:body,manual,pending:false };
    bar.append(label,start,manual,stop);content.append(bar);item.append(content);
    paintTrialTask(item.trialControls,row.task??{});box.appendChild(item);
  }
  for(const item of [...box.children])if(item.trialControls&&!rows.some(row=>row.raidId===item.trialControls.row.raidId))item.remove();
}

function paintTrialTask(controls,state){
  for(const button of [...controls.details.querySelectorAll('button:not([data-help-text])'),...controls.manual.querySelectorAll('button')]){button.trialRestDisabled??=button.disabled;button.disabled=button.trialRestDisabled||controls.pending||!!state.running;}
  controls.start.disabled=controls.pending||!!state.running||!controls.row.next||!!controls.row.reason;
  controls.stop.disabled=controls.pending||!state.running||!!state.stopping;
  controls.input.disabled=controls.pending||!!state.running;
  if(state.running&&Number.isSafeInteger(state.maxFailures))controls.input.value=String(state.maxFailures);
  controls.status.textContent=(controls.pending?'正在提交':state.running?state.stopping?'正在停止':'自动挑战中':state.reason&&state.reason!=='尚未开启'?state.reason:'未开启')+(state.running||state.wins||state.failures?' · 已过 '+(state.wins??0)+' 关 / 连败 '+(state.failures??0)+' 次':'');
}

async function refreshTrialTasks() {
  if (document.hidden||!current||snapshot.paused||disconnected.has(current)||$('tab-stages').classList.contains('hidden')) return;
  const account = current,version=++trialTaskVersion;
  try {
    const tasks = await call('/api/trials/tasks'); if (account !== current||version!==trialTaskVersion) return;
    let finished = false;
    for (const status of document.querySelectorAll('[data-trial-task]')) {
      const state = tasks[status.dataset.trialTask]; if (!state) continue;
      const controls = status.closest('.progression-row').trialControls;
      if (!controls || controls.account !== account||controls.pending) continue;
      if (controls.row.task?.running && !state.running) finished = true;
      controls.row.task = state;
      paintTrialTask(controls,state);
    }
    if (finished) await refreshProgression('trial');
  } catch { /* 请求错误由统一日志展示，保留现有状态。 */ }
}
setInterval(refreshTrialTasks, 3000);

const equipmentHeroSelection=new Map();
function renderEquipment(box, data, account) {
  if (data.locked) { box.textContent = '英雄装备在角色 ' + data.requiredLevel + ' 级开放'; return; }
  box.appendChild(el('p', null, '持有装备 ' + data.items.length + ' 件 · ' + data.ironName + ' ' + fmt(data.iron)));
  if (!data.items.length) { box.appendChild(el('p', 'dim', '装备仓库为空。获得装备后可在这里穿戴和强化。')); return; }
  const heroNames = new Map(data.heroes.map(h => [h.heroId, h.name]));
  const bar = el('div', 'bar');
  const equipped = el('div');
  if (data.heroes.length) {
    const select = choice(bar, '选择英雄', data.heroes.map(h => ({ value: h.heroId, text: h.name })));
    const draw = () => {
      const hero = data.heroes.find(h => h.heroId === select.value);
      clear(equipped);
      if (!hero) return;
      equipped.appendChild(table(['部位', '已穿戴', '可补空槽'], hero.slots.map(s => [s.type, s.item?.name || '空槽', s.suggested?.name || '—'])));
      if (hero.slots.some(s => s.suggested)) equipped.appendChild(progressionAction('为' + hero.name + '补齐空槽', '/api/equipment/wear', { heroId: hero.heroId }, account));
    };
    const remembered=equipmentHeroSelection.get(account);
    if(data.heroes.some(h=>h.heroId===remembered))select.value=remembered;
    select.onchange=()=>{equipmentHeroSelection.set(account,select.value);draw();};
    draw();
    box.append(bar, equipped);
  }
  box.appendChild(table(['装备', '部位', '穿戴者', '等级', '升一级'], data.items.map(item => {
    const cost = item.nextCost;
    return [item.name, item.type || '未知', item.owner ? heroNames.get(item.owner) || '已穿戴' : '闲置',
      fmt(item.level), cost == null ? '已达上限或不可强化' : progressionAction('强化 · ' + fmt(cost) + ' ' + data.ironName,
        '/api/equipment/enhance', { uid: item.uid, expectedLevel: item.level, maxCost: cost }, account,
        cost > data.iron ? data.ironName + '不足' : '')];
  })));
}

const guildSelections = new Map(),guildPages=new Map();
const mutualDrafts = new Map(), mutualWidgets = new Map();
let mutualPollSerial = 0;
function renderGuildMutual(box, state = {}, account) {
  let draft=mutualDrafts.get(account);
  if(!draft){draft={target:20,mode:'all',memberIds:[],askEnabled:false,askTarget:20,askItemId:'',...state.options,data:null,loading:false};mutualDrafts.set(account,draft);}
  const root=el('section','guild-mutual-panel');root.setAttribute('aria-label','单次联盟互助');
  const heading=el('div','title-with-help');heading.append(el('h4','','单次联盟互助'),makeHelpTip('单次联盟互助','手动开启后逐条处理，不加入常驻挂机。游戏的20次是发起求助上限；赠送目标统计本工具今日记录，不含游戏内手动赠送，未知结果会预占次数。无合适请求或缺料时15秒后再查，不自动备料。达到赠送目标后不再送，必要时等最后一份回赠。跨日、断开或重启后不自动继续。'));
  root.append(heading,el('p','dim','每次送1份，先收回赠。'));
  const fields=el('div','guild-mutual-fields');
  function field(title,control){const label=el('label','guild-mutual-field');label.append(el('span','',title),control);fields.append(label);return label;}
  const mode=el('select','config-select');mode.setAttribute('aria-label','互助赠送对象');mode.add(new Option('全部盟友','all'));mode.add(new Option('仅指定盟友','selected'));mode.value=draft.mode;field('赠送对象',mode);
  const target=el('input','config-input');target.type='number';target.min='0';target.max='20';target.step='1';target.required=true;target.value=draft.target;target.setAttribute('aria-label','本工具今日赠送目标');field('本工具今日赠送目标（0–20）',target);
  const memberPanel=el('details','config-multi');memberPanel.hidden=draft.mode!=='selected';const summary=el('summary','','指定盟友');memberPanel.append(summary);
  const memberBody=el('div','config-multi-panel'),search=el('input','config-input');search.type='search';search.placeholder='搜索盟友名称或ID';search.setAttribute('aria-label','搜索互助盟友');const list=el('div','config-option-list');memberBody.append(search,list);memberPanel.append(memberBody);
  const ask=el('input');ask.type='checkbox';ask.checked=draft.askEnabled;ask.setAttribute('aria-label','发起同材料求助');field('发起同材料求助并循环互赠',ask);
  const askFields=el('div','guild-mutual-ask');askFields.hidden=!draft.askEnabled;
  const material=el('select','config-select');material.setAttribute('aria-label','互赠求助材料');material.add(new Option('请选择材料，例如橡胶圈',''));
  const materialLabel=el('label','guild-mutual-field');materialLabel.append(el('span','','求助材料'),material);
  const askTarget=el('input','config-input');askTarget.type='number';askTarget.min='0';askTarget.max='20';askTarget.step='1';askTarget.required=true;askTarget.value=draft.askTarget;askTarget.setAttribute('aria-label','游戏今日发起求助目标');const askLabel=el('label','guild-mutual-field');askLabel.append(el('span','','游戏今日发起求助目标（含手动）'),askTarget);
  const askStatus=el('p','dim');askFields.append(materialLabel,askLabel,askStatus,el('p','dim','求助全盟可见，赠送限所选对象。'));
  const refresh=smallButton('刷新盟友与材料'),message=el('p','bad'),status=el('p','dim');status.setAttribute('role','status');const start=smallButton('开始本次互助'),stop=smallButton('停止互助');start.setAttribute('aria-label','开始本次联盟互助');stop.setAttribute('aria-label','停止本次联盟互助');
  const actions=el('div','bar');actions.append(start,stop,refresh);root.append(fields,memberPanel,askFields,actions,message,status);box.append(root);
  let currentState=state;
  function paintMembers(){
    const query=search.value.trim().toLocaleLowerCase(),members=[...(draft.data?.members??[])];
    for(const id of draft.memberIds)if(!members.some(m=>m.id===id))members.push({id,name:'未在最新名单中的角色 '+id});
    clear(list);
    for(const m of members.filter(m=>(m.name+' '+m.id).toLocaleLowerCase().includes(query))){
      const label=el('label','config-option'),check=el('input');check.type='checkbox';check.checked=draft.memberIds.includes(m.id);check.disabled=!!currentState.running;
      check.setAttribute('aria-label','互助盟友 '+m.name+' '+m.id);check.onchange=()=>{draft.memberIds=check.checked?[...new Set([...draft.memberIds,m.id])]:draft.memberIds.filter(id=>id!==m.id);paint(currentState);};
      label.append(check,el('span','',m.name+' · '+m.id));list.append(label);
    }
    if(!members.length)list.append(el('p','dim',draft.loading?'正在读取盟友…':'请先读取盟友名单'));
  }
  function paint(data){
    const wasRunning=!!currentState.running;
    currentState=data||{};
    if(currentState.running&&currentState.options){Object.assign(draft,currentState.options);mode.value=draft.mode;target.value=draft.target;ask.checked=draft.askEnabled;askTarget.value=draft.askTarget;material.value=draft.askItemId;}
    memberPanel.hidden=draft.mode!=='selected';askFields.hidden=!draft.askEnabled;summary.textContent='指定盟友 · 已选 '+draft.memberIds.length+' 位';
    for(const control of [mode,target,ask,material,askTarget])control.disabled=!!currentState.running;
    for(const control of list.querySelectorAll('input'))control.disabled=!!currentState.running;
    start.disabled=!!currentState.running||draft.loading||snapshot.paused||disconnected.has(account)||(draft.mode==='selected'&&Number(target.value)>0&&!draft.memberIds.length)||(draft.askEnabled&&!draft.askItemId);
    stop.disabled=!currentState.running||currentState.stopping;refresh.disabled=draft.loading||!!currentState.running;
    const used=currentState.dailyUsed??0,pending=currentState.pendingGifts??0;
    status.textContent=(currentState.running?(currentState.stopping?'正在停止':'运行中'):'未运行')+' · '+(currentState.reason||'尚未开启')+'；本工具今日已计入'+used+'次'+(pending?'（含待确认'+pending+'次）':'')+'；本轮发起'+(currentState.published??0)+'条，确认赠送'+(currentState.sent??0)+'次，领取'+(currentState.received??0)+'份。';
    askStatus.textContent='游戏今日已发起 '+(currentState.askUsed??draft.data?.askUsed??'待核对')+' / '+(currentState.askLimit??draft.data?.askLimit??'待核对')+' 次。'+(draft.data?.askReason||'')+' 赠送目标为0时只做发起和领取检查。';
    return wasRunning&&!currentState.running;
  }
  async function load(){
    if(draft.loading)return;draft.loading=true;message.textContent='';paint(currentState);
    try{const data=await call('/api/guild/mutual/options');if(account!==current||!root.isConnected)return;draft.data=data;clear(material);material.add(new Option('请选择材料，例如橡胶圈',''));for(const item of data.materials??[])material.add(new Option(item.name,item.id));material.value=draft.askItemId;paintMembers();}
    catch(error){if(account===current&&root.isConnected)message.textContent=error.message;}
    finally{draft.loading=false;if(account===current&&root.isConnected)paint(currentState);}
  }
  mode.onchange=()=>{draft.mode=mode.value;paint(currentState);if(draft.mode==='selected'&&!draft.data)void load();};
  target.oninput=()=>{draft.target=Number(target.value);paint(currentState);};
  ask.onchange=()=>{draft.askEnabled=ask.checked;paint(currentState);if(ask.checked&&!draft.data)void load();};
  askTarget.oninput=()=>{draft.askTarget=Number(askTarget.value);};material.onchange=()=>{draft.askItemId=material.value;paint(currentState);};
  search.oninput=paintMembers;memberPanel.ontoggle=()=>{if(memberPanel.open&&!draft.data)void load();};refresh.onclick=load;
  start.onclick=async()=>{
    if(current!==account||snapshot.paused||disconnected.has(account)||!target.reportValidity()||(ask.checked&&!askTarget.reportValidity()))return;
    const options={target:Number(target.value),mode:draft.mode,memberIds:[...draft.memberIds],askEnabled:ask.checked,askItemId:draft.askItemId,askTarget:Number(askTarget.value)};
    message.textContent='';paint({...currentState,running:true,reason:'正在开启'});
    try{await call('/api/guild/mutual/start',{method:'POST',body:JSON.stringify({...options,confirm:true})});}
    catch(error){if(account===current)message.textContent=error.message;}
    finally{if(account===current)await refreshGuildMutualState();}
  };
  stop.onclick=async()=>{if(account!==current)return;stop.disabled=true;try{await call('/api/guild/mutual/stop',{method:'POST',body:JSON.stringify({confirm:true})});}catch(error){message.textContent=error.message;}finally{if(account===current)await refreshGuildMutualState();}};
  mutualWidgets.set(account,{root,paint});
  if(draft.data){for(const item of draft.data.materials??[])material.add(new Option(item.name,item.id));material.value=draft.askItemId;}
  paintMembers();paint(state);
  if((draft.mode==='selected'||draft.askEnabled)&&!draft.data)void load();
}
async function refreshGuildMutualState(){
  if(!current||$('tab-guild').classList.contains('hidden'))return;
  const account=current,serial=++mutualPollSerial;
  try{const state=await call('/api/guild/mutual');if(account!==current||serial!==mutualPollSerial)return;const widget=mutualWidgets.get(account);if(widget?.root.isConnected&&widget.paint(state))await refreshProgression('guild');}catch{/*统一请求处理已记录错误。*/}
}
setInterval(refreshGuildMutualState,3000);
function renderGuild(box, data, account) {
  if (data.state !== 'member') { box.textContent = data.reason; $('guild-aid-view').textContent=data.reason;return; }
  box.appendChild(el('strong', null, data.name + ' · ' + fmt(data.level) + ' 级 · ' + fmt(data.memberCount) + ' 人'));
  const welfare=el('section','guild-welfare');box.append(welfare);
  welfare.appendChild(el('p', null, data.welfareCount == null ? '福利领取记录待确认' : '待领福利礼包 ' + data.welfareCount + ' 份'));
  if (data.welfareCount > 0) welfare.appendChild(progressionAction('领取联盟福利礼包', '/api/guild/welfare', {}, account));
  box=$('guild-aid-view');
  const oldWidget=mutualWidgets.get(account);
  if(!oldWidget?.root.isConnected){clear(box);renderGuildMutual(box,data.mutualAid,account);}
  else oldWidget.paint(data.mutualAid||{});
  for(const e of box.querySelectorAll(':scope > .guild-tabs,:scope > [role=tabpanel]'))e.remove();
  const tabs = el('div', 'log-filter guild-tabs'), panel = el('div');
  tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '联盟求助');
  panel.id = 'guild-aid-panel'; panel.setAttribute('role', 'tabpanel');
  const buttons = [];
  const draw = selected => {
    guildSelections.set(account, selected);
    buttons.forEach((button, index) => {
      button.setAttribute('aria-selected', String(index === selected)); button.tabIndex = index === selected ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', buttons[selected].id);
    clear(panel);
    const entries=(selected?data.myRequests:data.requests)||[],key=account+':'+selected;
    const pages=Math.max(1,Math.ceil(entries.length/10));
    const page=Math.min(guildPages.get(key)||1,pages);guildPages.set(key,page);
    const visible=entries.slice((page-1)*10,page*10);
    function pager(){
      if(pages===1)return;
      const bar=el('div','bar'),prev=smallButton('上一页'),next=smallButton('下一页');
      prev.disabled=page<=1;next.disabled=page>=pages;
      prev.onclick=()=>{guildPages.set(key,page-1);draw(selected)};
      next.onclick=()=>{guildPages.set(key,page+1);draw(selected)};
      bar.append(prev,el('span','dim',page+' / '+pages+' 页 · '+entries.length+' 条'),next);panel.append(bar);
    }
    if (!selected) {
      if (data.requests.length) panel.appendChild(table(['求助成员', '所需材料', '需要数量'], visible.map(r => [r.requester, r.material, fmt(r.quantity)])));
      else panel.appendChild(el('p', 'dim', data.aidError ? '成员求助读取失败，请刷新重试' : '目前没有成员求助'));
      pager();return;
    }
    if (data.myAidError) { panel.appendChild(el('p', 'bad', '我的求助读取失败：' + data.myAidError)); return; }
    if (data.myAidPending) panel.appendChild(el('p', 'dim', '上次领取结果待确认，请稍后刷新'));
    if (data.myAidCount > 0) panel.appendChild(progressionAction('领取待领物资（' + data.myAidCount + '）', '/api/guild/aid/claim', {}, account,
      data.myAidPending ? '上次领取结果仍待确认' : ''));
    if (data.myRequests?.length) panel.appendChild(table(['所需材料', '数量', '状态', '协助者'], visible.map(r => [r.material, fmt(r.quantity), r.status, r.helper || '—'])));
    else panel.appendChild(el('p', 'dim', '目前没有自己的求助记录'));
    pager();
  };
  ['成员求助', '我的求助'].forEach((label, index) => {
    const button = smallButton(label); button.id = 'guild-aid-tab-' + index;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panel.id);
    if (index && (data.myAidCount > 0 || data.myAidCount == null)) {
      const count = el('span', 'guild-tab-count', data.myAidCount == null ? '待确认' : String(data.myAidCount));
      count.setAttribute('aria-label', data.myAidCount == null ? '待领数量未知' : data.myAidCount + ' 份待领取'); button.appendChild(count);
    }
    button.onclick = () => draw(index);
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      draw(next); buttons[next].focus();
    };
    buttons.push(button); tabs.appendChild(button);
  });
  box.append(tabs, panel); draw(guildSelections.get(account) || 0);
}

function renderFormations(box, data, account) {
  if (data.locked) return;
  box.appendChild(el('strong', null, '远征舰队编队'));
  if (!data.docks.length) { box.appendChild(el('p', 'dim', '尚未建成远征舰队')); return; }
  for (const dock of data.docks) {
    const row = el('div', 'progression-row'), detail = el('div');
    detail.appendChild(el('strong', null, dock.name));
    if (dock.heroes.length) detail.appendChild(el('p', null, (dock.saved ? '已编队' : '首次编队预览') + ' · ' + dock.heroes.map(h => h.name).join('、')));
    detail.appendChild(el('p', 'dim', dock.reason || (dock.visible ? '已在世界舰队列表' : '世界地图尚未列出这支舰队')));
    row.appendChild(detail);
    if (!dock.saved && !dock.reason && dock.previewKey) row.appendChild(progressionAction('保存这套首次编队',
      '/api/fleets/formation', { buildingId: dock.buildingId, previewKey: dock.previewKey }, account));
    box.appendChild(row);
  }
}

function renderGuildTech(box,data,account){
 if(data.state!=='member'){box.textContent=data.reason||'科技信息未同步';return;}
 box.append(el('p','',data.balances.map(b=>b.name+' '+(b.value==null?'未同步':fmt(b.value))).join(' · ')),el('p','dim','已研究 '+data.learned+'/'+data.total+' 项 · 累计 '+data.totalLevels+' 级 · '+(data.stage?'赛季阶段 '+data.stage:'赛季阶段已全部开放')));
 const groups=[...new Set(data.rows.map(r=>r.type))];
 for(const type of groups){const group=el('details','guild-tech-group');group.open=type==='世界';group.append(el('summary','',type+'科技'));
 const wrap=el('div','guild-tech-table');wrap.append(table(['科技 / 效果','等级','升级费用','操作'],data.rows.filter(r=>r.type===type).map(row=>{
  const name=el('div','',row.name);name.append(el('span','dim',row.effect));const action=el('div'),button=smallButton('升级');button.disabled=!row.canUpgrade;button.setAttribute('aria-label','升级'+row.name);
  if(row.reason)button.title=row.reason;
  button.onclick=()=>{if(current!==account||button.disabled)return;const body=el('div');body.append(el('p','',row.name+'：'+row.level+' → '+(row.level+1)+'级'),el('p','',row.itemName+'消耗 '+fmt(row.cost)),el('p','',row.nextEffect||''));openConfirm('升级科技',[body],async()=>{if(current!==account||snapshot.paused||disconnected.has(account))throw Error('账号状态已变化，请刷新后再试');button.disabled=true;try{await call('/api/guild/tech/upgrade',{method:'POST',body:JSON.stringify({techId:row.id,expectedLevel:row.level,maxCost:row.cost,confirm:true})});}finally{if(current===account){button.disabled=!row.canUpgrade;await refreshProgression('guild-tech');}}});};
  action.append(button);if(row.reason)action.append(el('span','dim',row.reason));return[name,row.level+'/'+(row.maxLevel??'?'),row.level>=row.totalMax?'—':fmt(row.cost)+' '+row.itemName,action];
 })));[...wrap.querySelectorAll('tbody tr')].forEach((r,i)=>{r.dataset.techState=JSON.stringify(data.rows.filter(row=>row.type===type)[i]);});group.append(wrap);box.append(group);}
}

function craftingCosts(costs) {
  return table(['材料', { label: '需要', num: true }, { label: '库存', num: true }, '备料', '来源'], costs.map(c => {
    const missing = c.need - c.have;
    return [c.name, { text: fmt(c.need), num: true }, { text: fmt(c.have), num: true },
      el('span', missing > 0 ? 'warn' : 'ok', missing > 0 ? '缺 ' + fmt(missing) : '已备齐'),
      c.sources.join('、') || '—'];
  }));
}

function renderCrafting(box, data, account) {
  const { state, job, recipes, buildingId } = data;
  const labels = { locked: '尚未开放', unbuilt: '待建', building: '建造中', idle: '空闲', making: '制作中', ready: '成品待领' };
  box.appendChild(el('strong', null, '装备厂 · ' + labels[state]));
  if (data.reason) box.appendChild(el('p', 'dim', data.reason));
  if (state === 'locked' || state === 'unbuilt' || state === 'building') {
    if (data.buildFinishTime) box.appendChild(el('p', null, '建造完成时间 · ' + when(data.buildFinishTime * 1000)));
    if (state !== 'building' && data.buildCosts.length) {
      box.appendChild(craftingCosts(data.buildCosts));
      if (state === 'unbuilt') box.appendChild(el('p', 'dim', '材料备齐后，可在「挂机 → 海面」开启空位建造。'));
    }
    return;
  }

  const base = '/api/equipment/crafting';
  if (job) {
    const detail = el('div');
    const product = job.equipId && job.equipName && job.equipName !== job.equipId ? job.equipName : job.name;
    detail.appendChild(el('strong', null, product));
    if (job.equipId && job.star != null) detail.appendChild(el('span', 'dim', ' · ' + fmt(job.star) + ' 星'));
    if (job.finishTime) detail.appendChild(el('p', 'dim', '制作完成时间 · ' + when(job.finishTime * 1000)));
    box.appendChild(detail);
    if (state === 'ready') box.appendChild(progressionAction('领取成品', base + '/collect',
      { buildingId, previewKey: job.previewKey }, account, job.previewKey ? '' : data.reason || '请刷新并确认当前成品', 'crafting'));
  }
  if (!recipes.length) {
    box.appendChild(el('p', 'dim', '当前没有可查看的制作配方。'));
    return;
  }

  const bar = el('div', 'bar');
  const select = choice(bar, '制作配方', recipes.map(r => ({
    value: String(r.makeId), text: r.name + (r.canStart ? ' · 可制造' : ''),
  })));
  const available = recipes.find(r => r.canStart);
  if (available) select.value = String(available.makeId);
  const preview = el('div', 'progression-view');
  const draw = () => {
    const recipe = recipes.find(r => String(r.makeId) === select.value);
    clear(preview).appendChild(el('p', null, recipe.type + ' · 基础工时 ' + fmt(recipe.seconds / 60) + ' 分钟'));
    preview.appendChild(craftingCosts(recipe.costs));
    if (recipe.reason && recipe.reason !== data.reason) preview.appendChild(el('p', 'dim', recipe.reason));
    if (state === 'idle') preview.appendChild(progressionAction('制作一件' + recipe.name, base + '/start',
      { buildingId, makeId: recipe.makeId, previewKey: recipe.previewKey }, account,
      recipe.canStart && recipe.previewKey ? '' : recipe.reason || '当前无法制造', 'crafting'));
  };
  select.onchange = draw;
  draw();
  box.append(bar, preview);
}


function pirateSection(box, title) {
  const section = el('section', 'pirate-section');
  section.appendChild(el('h3', null, title));
  box.appendChild(section);
  return section;
}

function formationGrid(heroes) {
  const cols = Math.max(4, ...heroes.map(h => h.x ?? 0)), rows = Math.max(5, ...heroes.map(h => h.y ?? 0));
  const grid = el('div', 'formation-grid');
  grid.style.setProperty('--cols', cols);
  for (let y = 1; y <= rows; y++) {
    for (let x = 1; x <= cols; x++) {
      const hero = heroes.find(h => h.x === x && h.y === y);
      grid.appendChild(el('div', hero ? 'formation-cell filled' : 'formation-cell', hero?.name ?? ''));
    }
  }
  return grid;
}

function renderPirateFleets(box, data, account) {
  const section = pirateSection(box, '1. 舰队布局');
  const { formation, hunt } = data;
  if (formation.error) { section.appendChild(el('p', 'dim', '舰队读取失败，详情见运行日志')); return; }
  if (formation.locked) { section.appendChild(el('p', 'dim', '世界在角色 ' + formation.requiredLevel + ' 级开放')); return; }
  if (!formation.docks.length) { section.appendChild(el('p', 'dim', '尚未建成远征舰队')); return; }
  for (const dock of formation.docks) {
    const fleet = hunt.fleets?.find(row => row.name === dock.name);
    section.appendChild(el('strong', null, dock.name));
    const meta = el('div', 'pirate-meta');
    if (fleet) meta.append(el('span', null, '战力 ' + fmt(fleet.power)), el('span', null, '耐久 ' + fmt(fleet.durability)), el('span', fleet.reason ? 'warn' : 'ok', fleet.reason || '可出征'));
    else meta.appendChild(el('span', 'dim', dock.reason || '世界地图尚未列出这支舰队'));
    section.appendChild(meta);
    if (dock.heroes.length) section.appendChild(formationGrid(dock.heroes));
    if (!dock.saved && !dock.reason && dock.previewKey) section.appendChild(progressionAction('保存这套首次编队',
      '/api/fleets/formation', { buildingId: dock.buildingId, previewKey: dock.previewKey }, account));
  }
}

function renderPirateTargets(box, data, account) {
  const section = pirateSection(box, '2. 下一档目标');
  const { tracker, hunt } = data;
  if (tracker.error) { section.appendChild(el('p', 'dim', '目标读取失败，详情见运行日志')); return; }
  const meta = el('div', 'pirate-meta');
  meta.appendChild(el('span', null, '第 ' + tracker.season + ' 赛季'));
  if (hunt.fuel != null) meta.appendChild(el('span', null, '汽油 ' + fmt(hunt.fuel) + ' · 单队出征 ' + fmt(hunt.fuelPerFleet)));
  section.appendChild(meta);
  if (hunt.reason) section.appendChild(el('p', 'warn', hunt.reason));
  const fleets = (hunt.fleets ?? []).filter(row => !row.reason);
  let fleetSelect;
  if (fleets.length > 1) {
    const bar = el('div', 'bar');
    fleetSelect = choice(bar, '出征舰队', fleets.map(row => ({ value: row.key, text: row.name + ' · 战力 ' + fmt(row.power) })));
    section.appendChild(bar);
  }
  const cards = el('div', 'pirate-targets');
  const cardsDraw = [];
  for (const row of tracker.targets) {
    const card = el('article', 'pirate-target');
    card.appendChild(el('h4', null, row.name + ' ' + row.level + ' 级'));
    card.appendChild(el('span', 'dim', row.finished ? '全部首杀已完成' : '已击败至 ' + (row.cleared ?? '?') + ' 级 · 地图上 ' + (row.visible ?? '?') + ' 个'));
    card.appendChild(el('span', null, '建议战力 ' + fmt(row.power)));
    card.appendChild(el('span', 'dim', '首杀奖励 · ' + (row.materials || '无')));
    const matches = (hunt.targets ?? []).filter(target => target.name === row.name && target.level === row.level);
    const available = matches.filter(target => !target.reason);
    const holder = el('div', 'pirate-section');
    card.appendChild(holder);
    let location;
    if (available.length > 1) {
      const bar = el('div');
      location = choice(bar, '选择地点', available.map(target => ({ value: target.targetKey, text: target.location })));
      card.insertBefore(bar, holder);
    }
    const draw = () => {
      clear(holder);
      if (!available.length) {
        holder.appendChild(el('span', 'dim', matches[0]?.reason || hunt.reason || '地图上暂无可派遣的目标'));
        return;
      }
      const fleet = fleets.find(item => item.key === fleetSelect?.value) ?? fleets[0];
      if (!fleet) { holder.appendChild(el('span', 'dim', '没有可出征的舰队')); return; }
      const ratio = row.power > 0 ? Math.round(num(fleet.power) / row.power * 100) : 100;
      if (ratio < 100) holder.appendChild(el('span', 'warn', '舰队战力只有建议战力的 ' + ratio + '%，很可能失败，仍会消耗汽油和耐久'));
      holder.appendChild(progressionAction(ratio < 100 ? '仍然派遣' : '派遣', '/api/pirates/hunt',
        { targetKey: location?.value ?? available[0].targetKey, fleetKey: fleet.key }, account));
    };
    if (location) location.onchange = draw;
    cardsDraw.push(draw);
    draw();
    cards.appendChild(card);
  }
  if (fleetSelect) fleetSelect.onchange = () => cardsDraw.forEach(draw => draw());
  section.appendChild(cards);
}

function renderPirateProgress(box, data) {
  const section = pirateSection(box, '3. 战况与排行');
  const list = el('ul', 'pirate-list');
  for (const flight of data.flights ?? []) list.appendChild(el('li', null, flight.label));
  for (const row of data.reports.pirates ?? []) {
    list.appendChild(el('li', row.win ? 'ok' : 'bad', when(row.time * 1000) + ' · ' + row.name + ' · ' + (row.win ? '胜利' : '失败')
      + (row.rewards ? ' · ' + (row.received ? '已领 ' : '待领 ') + row.rewards : '')));
  }
  if (list.childElementCount) section.appendChild(list);
  else section.appendChild(el('p', 'dim', data.reports.error ? '战报读取失败，详情见运行日志' : '还没有海盗战报'));
  section.appendChild(el('p', 'dim', '地图上的海盗和其他玩家共享，可能先被别人打掉，刷新后再选其他地点。'));
  const rank = data.rank;
  if (rank.error) section.appendChild(el('p', 'dim', '排行读取失败，详情见运行日志'));
  else if (rank.open && rank.top.length) {
    section.appendChild(el('p', 'dim', '剿匪冲榜是全服排名，排名奖励在活动结束后结算，前排含联盟福利礼包。'));
    const board = el('ul', 'pirate-list');
    for (const row of rank.top) board.appendChild(el('li', null, '第 ' + row.rank + ' 名 · ' + row.nickname + ' · ' + fmt(row.value) + ' 分'));
    if (rank.me) board.appendChild(el('li', 'ok', '我 · ' + (rank.me.rank ? '第 ' + rank.me.rank + ' 名' : '未上榜') + ' · ' + fmt(rank.me.value ?? rank.progress) + ' 分'));
    section.appendChild(board);
  }
}

function renderPirateBoard(box, data, account) {
  renderPirateFleets(box, data, account);
  renderPirateTargets(box, data, account);
  renderPirateProgress(box, data);
}

const lineupSelection = new Map();

function lineupHeroes(rec) {
  return rec.heroes.map(h => h.role ? h.name + '（' + h.role + '）' : h.name).join('、');
}

function lineupPower(rec) {
  const box = el('div');
  box.appendChild(el('div', null, fmt(rec.power)));
  if (rec.isCurrent) return box;
  box.appendChild(el('small', rec.delta < 0 ? 'warn' : 'ok', (rec.delta < 0 ? '比当前低 ' : '比当前高 ') + fmt(Math.abs(rec.delta))));
  return box;
}

function lineupName(rec) {
  const box = el('div');
  box.appendChild(el('strong', null, rec.label));
  box.appendChild(el('div', 'dim', rec.presetName));
  if (rec.note) box.appendChild(el('div', 'warn', rec.note));
  if (rec.pet) box.appendChild(el('div', 'dim', rec.pet));
  return box;
}

function renderLineupTarget(box, target, account) {
  if (target.reason) box.appendChild(el('p', 'dim', target.reason));
  if (target.hint) box.appendChild(el('p', 'dim', target.hint));
  if (target.current) {
    const names = target.current.heroes.map(h => h.name).join('、');
    box.appendChild(el('p', null, names
      ? '当前阵容 · ' + target.current.presetName + ' · 总战力 ' + fmt(target.current.power) + ' · ' + names
      : '当前阵容为空'));
  }
  if (!target.current) return;
  if (target.recommended.length) {
    box.appendChild(table(['推荐阵容', '英雄与分工', '总战力', '操作'], target.recommended.map(rec => [
      lineupName(rec), lineupHeroes(rec), lineupPower(rec),
      rec.isCurrent ? el('span', 'ok', '正在使用') : progressionAction('换成这套', '/api/lineups/apply',
        { targetKey: target.key, previewKey: rec.previewKey }, account, target.reason, 'lineup'),
    ])));
  } else {
    box.appendChild(el('p', 'dim', '现有英雄凑不齐完整的攻略阵容。'));
  }
  if (target.near.length) {
    box.appendChild(table(['差一点能凑齐', '还差', '被占用'], target.near.map(rec => [
      rec.label, rec.missing.join('、') || '—', rec.blocked.join('、') || '—',
    ])));
  }
}

function renderLineups(box, data, account) {
  box.appendChild(el('p', 'dim', '阵容来自游戏内的英雄攻略，只选你能凑齐的，同类阵容按总战力排序。攻略没有按玩法分类，玩法适配是本工具的判断，也没有针对具体关卡，换阵不保证过关。'));
  const bar = el('div', 'bar');
  const select = choice(bar, '玩法和队伍', data.targets.map(t => ({ value: t.key, text: t.title })));
  const saved = lineupSelection.get(account);
  if (data.targets.some(t => t.key === saved)) select.value = saved;
  const detail = el('div', 'progression-view');
  const draw = () => {
    lineupSelection.set(account, select.value);
    renderLineupTarget(clear(detail), data.targets.find(t => t.key === select.value), account);
  };
  select.onchange = draw;
  draw();
  box.append(bar, detail);
}

setInterval(() => { if (!document.hidden && !$('tab-heroes').classList.contains('hidden')) void refreshProgression('crafting'); }, 15000);
