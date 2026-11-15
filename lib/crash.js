/**
 * lib/crash.js —— 脚本崩了时的统一出口
 *
 * 为什么有它（2026-11-14 第 160 轮）：
 *   学员脚本的「最后兜底」原来各写各的，而且多数直接打 e.stack：
 *       ❌ <一坨英文行号>
 *       FAIL <stack>          ← ad-set-bid-budget.js，前缀还是英文
 *       ERR: <stack>          ← verify-published.js，前缀还是英文
 *   学员看到只会以为装坏了，而这句话真正要传达的是两件事：
 *     ① 出错了，但不是你操作错（中文说明）
 *     ② 把细节发给管理员（英文栈是给管理员看的，不是给你看的）
 *
 * 用法：
 *   .catch((e) => require('./lib/crash').crash(e));        // 根层脚本
 *   .catch((e) => require('../lib/crash').crash(e));       // tools/ 下的
 *   .catch((e) => crash(e, 2));                            // 要自定义退出码时
 *
 * ⚠️ 这个文件自己必须极简：它是所有脚本的兜底，它一炸就全炸。
 *    只用 console + process，不要 require 任何本项目的东西。
 */
function crash(e, code) {
  const msg = String((e && e.message) || e);
  console.log('❌ 脚本出错了：' + msg);
  console.log('   把这几行发给管理员就行；下面是细节，看不懂可以忽略：');
  const stack = String((e && e.stack) || '').split('\n').slice(0, 4);
  stack.forEach((l) => console.log('   ' + l));
  process.exit(code == null ? 1 : code);
}

module.exports = { crash };
