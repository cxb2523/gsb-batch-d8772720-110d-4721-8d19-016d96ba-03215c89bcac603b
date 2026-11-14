// 地图坐标和区域结构验证；不连接游戏或发送动作。
import assert from 'node:assert/strict';
import {loadMapAsset} from '../src/world.mjs';
import {mapDimensions,mapPosition,mapRegions} from '../src/world-map-geometry.mjs';
let count=0;const test=async(name,fn)=>{await fn();count++;console.log('通过：'+name);};
await test('真实100×75错列格投影为接近正方形地图',async()=>{const m=await loadMapAsset(1);assert.deepEqual(mapDimensions(m),{width:240.5,height:240.375});assert.deepEqual(mapPosition(m,7692),{x:12.5,y:12.75});assert.deepEqual(mapPosition(m,240),{x:1,y:1.125});assert.equal(mapPosition(m,-1),null);assert.equal(mapPosition(m,153600),null);});
await test('每座真实城池对应原格子的所属区域，不由点位推测领地',async()=>{const m=await loadMapAsset(1),regions=mapRegions(m);assert.equal(regions.length,Object.keys(m.cityInfo).length);for(const[id,city]of Object.entries(m.cityInfo)){assert.equal(m.cityAt(city.gridIdx),Number(id));assert(regions.some(r=>r.cityId===Number(id)&&r.path.startsWith('M')&&r.path.endsWith('Z')));}assert.strictEqual(mapRegions(m),regions);assert(regions.reduce((n,r)=>n+r.path.length,0)<40000);});
await test('未提供区域格子时不编造区域，标记坐标仍可只读显示',()=>{const m={width:10,height:10,tileWidth:100,tileHeight:75};assert.deepEqual(mapRegions(m),[]);assert.deepEqual(mapPosition(m,11),{x:2,y:1.125});});
await test('不同区域边界各自闭合且不改变地图格子内容',()=>{const cells=Array.from({length:64},(_,i)=>i%8<4?1:2),before=JSON.stringify(cells),m={width:8,height:8,tileWidth:100,tileHeight:75,cityAt:i=>cells[i]};const r=mapRegions(m);assert.equal(r.length,2);assert(r.every(v=>v.path.endsWith('Z')&&!/NaN|undefined/.test(v.path)));assert.equal(JSON.stringify(cells),before);});
console.log('地图结构专项 '+count+'/'+count+' 通过');
