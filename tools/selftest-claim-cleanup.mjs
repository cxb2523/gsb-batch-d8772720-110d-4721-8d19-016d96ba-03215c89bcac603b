import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {loadProtocol} from '../src/proto.mjs';
import {getConfig} from '../src/config.mjs';
import {automationWireId,exactAutomationId} from '../src/automation-policy.mjs';
import {createUsageLedger,defaultSettings,validateSettings,importAutomationSettings,exportAutomationSettings} from '../src/automation-settings.mjs';
import {cleanupAfterClaim} from '../src/claim-cleanup.mjs';
import {fishOnce} from '../src/fishing.mjs';
import {runtimeProgress} from '../src/runtime-progress.mjs';
const protocol=loadProtocol(),config=getConfig(),settings=defaultSettings(),folder=fs.mkdtempSync(path.join(os.tmpdir(),'cw-claim-'));
const uid=n=>automationWireId((9007199254740992n+BigInt(n)).toString());
for(const kind of ['forge','pet']){
  const equip=kind==='forge',group=settings[kind],toggle=equip?'decompose':'release',choice=equip?'decomposeQualities':'releaseQualities';
  const ledger=createUsageLedger('fixture',{file:path.join(folder,kind+'.json')});
  const ids=[1,2,3,4,5,6];let allowRemove=true,sent=[],disabled=false;
  const table=config.tables[equip?'EquipCfg':'PetBreedCfg'].data;
  const value=idx=>table.find(r=>r.quality===(idx===4?'ORANGE':'BLUE'))[equip?'id':'petId'];
  const rows=ids.map(i=>({uid:uid(i),[equip?'equipId':'petId']:value(i),level:i===3?4:1,star:i===5?3:0,grade:0,refineLv:0}));
  const client={connected:true,async request(n,b,resp){
    const reply=n==='AllHeroRequest'?{heroes:[{equips:[{uid:uid(2),equipId:value(2)}]}]}:
      n==='EquipsRequest'?{equip:rows}:n==='AllPetRequest'?{pets:rows}:
      n==='OnWaterRequest'?{building:[{buildingId:'1海兽值守',level:1,petServe:{petUid:uid(2)}}]}:
      n==='GetFormationRequest'?{formation:{}}:n==='LeagueInfoRequest'?{dan:1,settleTime:0,bonusItemNum:0,nextPointTime:0,predictDan:0,maxPage:0,roomDan:1,ownFormations:[]}:null;
    if(reply)return protocol[resp].decode(protocol[resp].encode(reply).finish());
    assert.equal(n,'DecomposeEquipRequest');apply(n,b);return {};
  },async sendWatch(n,b){assert.equal(n,'FreePetRequest');apply(n,b)}};
  function apply(n,b){const x=protocol[n].decode(protocol[n].encode(b).finish());const picked=(x.uid??x.petUid).map(exactAutomationId);sent.push(picked);if(allowRemove)for(let i=rows.length-1;i>=0;i--)if(picked.includes(exactAutomationId(rows[i].uid)))rows.splice(i,1);}
  const go=()=>cleanupAfterClaim(client,config,settings,ledger,kind,()=>!disabled);
  assert.equal(await go(),null);group[toggle]=true;assert.throws(()=>validateSettings(settings));
  group[choice]=['BLUE'];disabled=true;assert.equal(await go(),null);disabled=false;
  if(!equip)allowRemove=false;
  const result=await go();assert.ok(result?.status,JSON.stringify({kind,result}));
  assert.deepEqual(sent,[equip?[1,5,6].map(n=>exactAutomationId(uid(n))):[1,6].map(n=>exactAutomationId(uid(n)))]);
  assert.equal(result.status,equip?'confirmed':'unknown');await go();assert.equal(sent.length,1);
}
const now=Date.UTC(2026,10,5,8);
for(const key of ['schedule.freeRecruit','schedule.freeAntiqueRecruit']){
 const value=Math.floor(Date.UTC(2026,10,5,10,53,28)/1000);
 assert.equal(runtimeProgress({key,enabled:true},{text:'2/2 · 今日目标已完成'},{counters:{}},{connected:true,running:true,now,freeTimes:{hero:value,antique:value}}).progress,'下次 18:53:28');
}
const catalog=config.tables.FishBaseCfg.data.map(x=>x.fishId);let fishIds=catalog.slice(1),casts=0,closed=0;
const c={async request(n){switch(n){case 'OnWaterRequest':return {building:[{buildingId:'1钓鱼椅',level:1}],fishingLevel:{level:10}};case 'GameEffectRequest':return {effects:[{id:16,value:100}]};case 'AllItemRequest':return {items:[{itemId:'鱼',num:100}]};case 'FishEncyclopediaRequest':return {fishList:fishIds,rewardId:0};case 'StartFishingRequest':casts++;return {fishId:catalog[0]};case 'GainBigFishRequest':fishIds=catalog;return {isNew:true};default:throw Error(n);}}};
await fishOnce(c,config,()=>true);assert.equal(casts,0);
await fishOnce(c,config,()=>true,{fishBook:true,dryRun:true});assert.equal(casts,0);
await fishOnce(c,config,()=>true,{fishBook:true,onBookComplete:()=>closed++});assert.equal(casts,1);assert.equal(closed,1);
await fishOnce(c,config,()=>true,{fishBook:true,dryRun:true,onBookComplete:()=>closed++});assert.equal(casts,1);assert.equal(closed,1);
const old=exportAutomationSettings(defaultSettings());delete old.settings.pet.release;delete old.settings.pet.releaseQualities;delete old.settings.forge.decompose;delete old.settings.forge.decomposeQualities;delete old.settings.gather.fishBook;
assert.equal(importAutomationSettings(old).forge.decompose,false);
console.log('通过：双招募时间、旧配置、满仓开拓及集齐停用、预览只读、精确品质/UID、占用和养成保护、未知结果不重发。');
