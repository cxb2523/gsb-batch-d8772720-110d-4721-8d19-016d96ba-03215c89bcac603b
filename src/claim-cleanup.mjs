import { exactAutomationId, automationWireId } from './automation-policy.mjs';

const zero = n => n === 0 || n === '0' || (n?.low === 0 && n?.high === 0);
const baseLevel = n => n === 0 || n === 1;
function markUsed(used, uid) {
  if (zero(uid)) return;
  const id = exactAutomationId(uid);
  if (!id) throw Error('占用标识未同步');
  used.add(id);
}
function inventoryMap(rows) {
  if (!Array.isArray(rows)) throw Error('库存未同步');
  const map = new Map();
  for (const row of rows) {
    const id = exactAutomationId(row.uid);
    if (!id || map.has(id)) throw Error('库存标识不完整');
    map.set(id,row);
  }
  return map;
}

async function eligibleItems(client,config,equipment,qualities) {
  const read = (n,b={}) => client.request(n+'Request',b,n+'Response',8000);
  const used = new Set();
  let all, definitions;
  if (equipment) {
    const heroes = (await read('AllHero')).heroes;
    if (!Array.isArray(heroes)||!heroes.length) throw Error('英雄列表未同步');
    for (const hero of heroes) {
      if (!Array.isArray(hero.equips)) throw Error('装备归属未同步');
      for (const item of hero.equips) markUsed(used,item.uid);
    }
    all=inventoryMap((await read('Equips')).equip);
    definitions=new Map(config.tables.EquipCfg.data.map(row=>[row.id,row.quality]));
  } else {
    const buildings=(await read('OnWater')).building;
    if (!Array.isArray(buildings)||!buildings.length) throw Error('海兽值守未同步');
    for (const b of buildings) {
      if (b.petServe) markUsed(used,b.petServe.petUid);
      if (b.fleet?.formation) markUsed(used,b.fleet.formation.petUid);
    }
    const main=(await read('GetFormation',{module:1})).formation;
    if (main) markUsed(used,main.petUid);
    // 当前协议没有 LeagueFormationRequest；LeagueInfoResponse.ownFormations 才是本人编队。
    const teams=(await read('LeagueInfo')).ownFormations;
    if (!Array.isArray(teams)) throw Error('积分赛编队未同步');
    for(const team of teams)markUsed(used,team.petUid);
    all=inventoryMap((await read('AllPet')).pets);
    definitions=new Map(config.tables.PetBreedCfg.data.map(row=>[row.petId,row.quality]));
  }
  return [...all].filter(([id,item])=>{
    // 装备星级由锻造随机决定，不代表养成；海兽星级和等级才表示已投入养成。
    if (used.has(id)||!baseLevel(item.level)||(!equipment&&!baseLevel(item.star))||item.rerollAttrs?.length) return false;
    const untouched=equipment ? item.refineLv===0 && !(item.attr??[]).some(a=>a.rating>0)
      : item.grade===0 && !item.extAttrs?.length && !item.extAttrs2?.length && !item.profFeed?.some(p=>p.attrFeed?.some(a=>a.times>0));
    return untouched && qualities.includes(definitions.get(equipment?item.equipId:item.petId));
  }).map(([id])=>id);
}

// 只在领取确认后调用；持久记录精确UID，未知结果跨重连不会重发。
export async function cleanupAfterClaim(client,config,settings,ledger,kind,enabled) {
  const equipment=kind==='forge',prefix=equipment?'equip-dispose:':'pet-release:';
  const group=settings[kind],on=equipment?group.decompose:group.release;
  const qualities=equipment?group.decomposeQualities:group.releaseQualities;
  if (!on||!qualities?.length||!ledger||!enabled()) return null;
  const label=equipment?'装备自动分解':'海兽自动放生';
  try {
    const candidates=await eligibleItems(client,config,equipment,qualities);
    if (!candidates.length||!enabled())return null;
    const fresh=new Set(await eligibleItems(client,config,equipment,qualities));
    const ids=candidates.filter(id=>fresh.has(id)&&!ledger.hasKey(prefix+id));
    if (!ids.length||!enabled())return null;
    const tickets=[];
    try {for(const id of ids)tickets.push(ledger.reserve({},{},{},{uniqueKey:prefix+id}));}
    catch(error){for(const t of tickets)ledger.cancel(t);throw error;}
    if(!enabled()){for(const t of tickets)ledger.cancel(t);return null;}
    const name=equipment?'DecomposeEquipRequest':'FreePetRequest';
    try {
      if(equipment)await client.request(name,{uid:ids.map(automationWireId)},'DecomposeEquipResponse',8000);
      else await client.sendWatch(name,{petUid:ids.map(automationWireId)},{window:600});
      const reply=await client.request(equipment?'EquipsRequest':'AllPetRequest',{},equipment?'EquipsResponse':'AllPetResponse');
      const remaining=inventoryMap(equipment?reply.equip:reply.pets);
      let confirmed=0;
      for(const [i,id] of ids.entries())if(!remaining.has(id)){ledger.confirm(tickets[i]);confirmed++;}
      return {label,ok:confirmed===ids.length,status:confirmed===ids.length?'confirmed':'unknown',note:'库存核对 '+confirmed+'/'+ids.length};
    }catch(error){
      if(error.prompt&&error.request===name){for(const t of tickets)ledger.cancel(t);return {label,ok:false,status:'rejected',error:error.message};}
      return {label,ok:false,status:'unknown',error:'结果待确认，保留记录'};
    }
  }catch(error){return {label,ok:false,error:error.message};}
}
