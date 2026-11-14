import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { createUsageLedger, defaultSettings } from '../../src/automation-settings.mjs';
import { automationWireId } from '../../src/automation-policy.mjs';
import path from 'node:path';

let serial=1000;
export const asset=(id,num)=>({type:0,id,num});
export const config={tables:{
  ModuleOpenCfg:{data:[{moduleId:'联盟',playerLevel:16},{moduleId:'联盟商船',playerLevel:18}]},
  CargoUnlockCfg:{data:[{index:1,playerLevel:9}]},
  GuildShipParamCfg:{data:[{season:1,shipNum:2,duration:30,time:[8,11,14,17,20,23]},{season:6,shipNum:2,duration:30,time:[8,9,11,12,14,15,17,18,20,21,23]}]},
  GuildShipCfg:{data:[{shipId:1,quality:'PURPLE',num:2,time:150},{shipId:2,quality:'ORANGE',num:4,time:300},{shipId:3,quality:'RED',num:6,time:540}]},
  FortSeasonUnlockCfg:{data:[{season:3,level:1,fortIdList:['挖沙船']}]},
  WorldFortCfg:{data:[{fortId:'挖沙船',donateCost:[['耐火砖',100],['高温合金',100]]}]},
  FortDonateMaterialCfg:{data:[{id:'耐火砖',res:['功勋',4000]},{id:'高温合金',res:['功勋',4000]}]},
},materialName:id=>id};

export function guildShipFixture(protocol,dir,{hour=8,minute=0,worldId='3000001'}={}){
  const now=Math.floor(Date.parse(`2026-11-14T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+08:00`)/1000);
  const player={playerId:String(9007199254741000n+BigInt(++serial)),worldId,guildId:'9007199254742000',level:30};
  const settings=defaultSettings();settings.alliance.enabled=true;Object.assign(settings.guildShip,{enabled:true,crew:true,captain:true});settings.guildFort={enabled:true,materials:['耐火砖'],reserve:0,dailyLimit:0};
  const state={now,calls:[],writes:[],ships:[],ownRun:[],heroes:[{heroId:'英雄A',star:3,exclusive:{star:2}}],stock:{耐火砖:50,高温合金:50,橡胶圈:50},period:3,enabled:true,hook:async()=>{},writeHook:async()=>{},fort:{cityId:1,type:'挖沙船',state:0,process:[{itemId:'耐火砖',num:0},{itemId:'高温合金',num:0}]},dailyDonateNum:0,
    workerOrder:[],cargo:[],week:{activityTime:[]}};
  function ship({id=1,type=3,captain=true,coins=80,material='橡胶圈',num=5,reward='抽卡券',heroStar=5}={}){
    const cfg=config.tables.GuildShipCfg.data.find(row=>row.shipId===type);
    return {shipId:id,type,state:1,pos:0,leaderCond:[{heroId:'英雄A',star:heroStar,exStar:0}],leader:captain?{playerId:'9007199254742222',nickname:'盟友'}:null,
      cabin:Array.from({length:cfg.num},(_,i)=>({crewId:i+1,order:[asset(material,num)],player:null})),reward:{asset:[asset('水姆币',coins),asset(reward,1)]},preparedEndTime:captain?state.now+1800:0,mvEndTime:0};
  }
  state.ships=[ship()];
  const client=new EventEmitter();client.connected=true;client.serverClockOffsetMs=now*1000-Date.now();
  function encode(name,body){assert.equal(typeof protocol[name]?.encode,'function',name+'必须是实际游戏协议');const bytes=protocol[name].encode(body).finish();protocol[name].decode(bytes);}
  client.request=async(name,body,response)=>{
    encode(name,body);assert.equal(typeof protocol[response]?.decode,'function');state.calls.push({name,body});await state.hook(name,body);
    if(name==='DonateFortRequest'){
      state.writes.push({name,body});await state.writeHook(name,body);
      const row=state.fort.process.find(row=>row.itemId===body.item.itemId);row.num+=body.item.num;state.stock[body.item.itemId]-=body.item.num;state.dailyDonateNum+=body.item.num;
      return {process:structuredClone(state.fort.process),reward:{asset:[asset('功勋',body.item.num*4000)]}};
    }
    const replies={GuildInfoRequest:{guild:{guildId:player.guildId}},GuildShipRequest:{period:state.period,ship:state.ships,ownRun:state.ownRun,worldShip:[]},AllHeroRequest:{heroes:state.heroes},
      AllItemRequest:{items:Object.entries(state.stock).map(([itemId,num])=>({itemId,num}))},OnWaterRequest:{workerOrder:state.workerOrder},CargoShipsRequest:{ship:state.cargo},WeekInfoRequest:state.week,
      GuildCityInfoRequest:{cities:[{cityId:1,recommended:true,defenceNum:1,fort:state.fort}]},CityFortInfoRequest:{fort:state.fort,dailyDonateNum:state.dailyDonateNum}};
    if(!Object.hasOwn(replies,name))throw new Error('意外请求 '+name);return structuredClone(replies[name]);
  };
  client.sendWatch=async(name,body)=>{
    encode(name,body);state.calls.push({name,body});state.writes.push({name,body});await state.writeHook(name,body);
    const chosen=state.ships.find(row=>row.shipId===body.shipId);assert(chosen);
    if(name==='GuildShipOrderRequest'){
      const cabin=chosen.cabin.find(row=>row.crewId===body.crewId);assert.equal(cabin.player,null);cabin.player={playerId:player.playerId};for(const row of cabin.order)state.stock[row.id]-=row.num;
    }else if(name==='GuildShipSeekRequest'){assert.equal(chosen.leader,null);chosen.leader={playerId:player.playerId};chosen.preparedEndTime=state.now+1800;}
    else throw new Error('意外写入 '+name);
    return {};
  };
  const file=path.join(dir,'ledger-'+serial+'.json'),ledger=createUsageLedger('qa',{file,now:()=>state.now*1000});
  const options={player,getSettings:()=>settings,enabled:()=>state.enabled&&client.connected,ledger};
  const advance=seconds=>{state.now+=seconds;client.serverClockOffsetMs=state.now*1000-Date.now();};
  const roundtripShip=raw=>{const copy=structuredClone(raw);if(copy.leader)copy.leader.playerId=automationWireId(copy.leader.playerId);for(const cabin of copy.cabin)if(cabin.player)cabin.player.playerId=automationWireId(cabin.player.playerId);return protocol.DispGuildShip.decode(protocol.DispGuildShip.encode(copy).finish());};
  return {client,player,state,settings,options,ledger,file,ship,advance,roundtripShip};
}
