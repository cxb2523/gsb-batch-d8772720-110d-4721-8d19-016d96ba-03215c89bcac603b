// 从游戏发布清单下载并验证配置与地图，不需要微信资源缓存或账号登录。
import { createResourceUpdater } from '../src/resource-updater.mjs';
const updater = createResourceUpdater({ onEvent: ({ message }) => console.log(message) });
try {
  const result = await updater.check();
  if (result.status === 'error') process.exitCode = 1;
  else if (result.status === 'current') console.log('资源已是当前客户端版本的最新发布：' + result.version);
  else if (result.status === 'disabled') console.log('未执行资源更新：' + result.reason);
} finally { await updater.stop(); }
