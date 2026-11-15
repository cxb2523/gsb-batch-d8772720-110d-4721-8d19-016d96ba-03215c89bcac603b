// 探针：先打一发 /api/poster/make，把响应结构摸清楚（键名/长度），再决定怎么批量生成
const http = require('http');
const { SVC } = require('../lib/env');   // 【密钥外置】由 tools/dedupe-api-key.js 插入
const KEY = SVC.apiKey;

const body = JSON.stringify({
  city: '广州', star: '孙燕姿', source: 'damai_official',
  templateId: 'xuliang-v1', ratio: '3:4',
});

const req = http.request({
  host: '127.0.0.1', port: 8093, path: '/api/poster/make', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-api-key': KEY },
  timeout: 180000,
}, (res) => {
  let b = '';
  res.on('data', (c) => (b += c));
  res.on('end', () => {
    console.log('HTTP', res.statusCode, 'bytes=' + b.length);
    let j; try { j = JSON.parse(b); } catch (e) { console.log('非 JSON:', b.slice(0, 400)); return; }
    console.log('顶层键:', Object.keys(j).join(', '));
    for (const k of Object.keys(j)) {
      const v = j[k];
      if (typeof v === 'string') console.log('  ' + k + ' : string, len=' + v.length + ', 前40=' + JSON.stringify(v.slice(0, 40)));
      else if (typeof v === 'object' && v) console.log('  ' + k + ' : ' + (Array.isArray(v) ? 'array[' + v.length + ']' : 'object{' + Object.keys(v).join(',') + '}'));
      else console.log('  ' + k + ' : ' + JSON.stringify(v));
    }
  });
});
req.on('timeout', () => { console.log('TIMEOUT'); req.destroy(); });
req.on('error', (e) => console.log('ERR', e.message));
req.write(body);
req.end();
