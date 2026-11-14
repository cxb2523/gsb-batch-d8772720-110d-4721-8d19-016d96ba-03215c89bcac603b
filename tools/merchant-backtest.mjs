// 只读离线回放：不导入 GameClient，不连接游戏，不自动选取或输出账号资料。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { readMerchantJournal, merchantJournalSummary, replayMerchantJournal } from '../src/merchant-journal.mjs';

const HELP = `海商王离线历史回放（不连接游戏）
用法：
  node tools/merchant-backtest.mjs --file <automation-usage.json> --account <账号标识> [--variants <参数组.json>] [--config-pack <配置包>] [--json]
  node tools/merchant-backtest.mjs --file <观察日志.json> [--variants <参数组.json>] [--json]
  node tools/merchant-backtest.mjs --file <automation-usage.json> --account <账号标识> --summary
观察日志格式：{ entries: [...], config?: { tables: {...} } }。
参数组格式：[{ name: "保守", settings: { estimateDiscountPercent: 20 } }]。
仅历史真实匹配回执计入可验证成交收益；未知目的港的反事实收益保留为空。`;

export function readMerchantReplayFile(file, account) {
  const text = fs.readFileSync(path.resolve(file), 'utf8');
  let document;
  try { document = JSON.parse(text); } catch { throw Error('回放文件不是有效 JSON；未修改原文件'); }
  if (Array.isArray(document?.entries)) return { entries: document.entries, config: document.config, summaries: [] };
  if (document?.version !== 1 || !document.accounts || typeof document.accounts !== 'object' || Array.isArray(document.accounts))
    throw Error('仅支持观察日志或用量账本文件；未修改原文件');
  if (typeof account !== 'string' || !account || !Object.hasOwn(document.accounts, account))
    throw Error('用量账本必须显式指定其中一个账号标识；不会列出其他账号');
  const keys = document.accounts[account]?.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw Error('所选账号日志格式损坏；未修改原文件');
  const ledger = { keyRecords: () => keys };
  return { entries: readMerchantJournal(ledger), summaries: merchantJournalSummary(ledger) };
}

export function runMerchantBacktest(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (['--help', '-h', '--json', '--summary'].includes(argument)) options[argument.replace(/^--?/, '')] = true;
    else if (['--file', '--account', '--variants', '--config-pack'].includes(argument)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(argument + ' 缺少参数');
      options[argument.slice(2)] = args[++i];
    } else throw Error('未知参数：' + argument);
  }
  if (options.help || options.h) return HELP;
  if (!options.file) throw Error('请用 --file 显式指定只读日志文件；不会自动读取账号或连接游戏');
  const input = readMerchantReplayFile(options.file, options.account);
  let replay = null;
  if (!options.summary) {
    const config = input.config ?? loadConfig(options['config-pack'] ? { file: path.resolve(options['config-pack']) } : {});
    const variants = options.variants ? JSON.parse(fs.readFileSync(path.resolve(options.variants), 'utf8')) :
      [{ name: '记录参数', settings: null }, { name: '估价折扣20%', settings: { estimateDiscountPercent: 20 } }];
    replay = replayMerchantJournal(config, input.entries, { variants });
  }
  const result = { readOnly: true, connectedToGame: false, summaries: input.summaries, replay };
  if (options.json) return JSON.stringify(result, null, 2);
  const lines = ['海商王离线回放：只读文件，未连接游戏。'];
  for (const summary of input.summaries) lines.push('期次 ' + summary.event.period + '：已确认买卖 ' + summary.confirmedTrades +
    ' 笔，实际采购成本 ' + summary.buyCost + '，出售回款 ' + summary.sellProceeds + '，已实现净利润 ' + summary.realizedProfit +
    '，未知动作 ' + summary.unknownActions + (summary.limited ? '（日志达到保留上限，统计不完整）' : ''));
  for (const variant of replay?.variants ?? []) lines.push(variant.name + '：观察点 ' + variant.decisions.length +
    '，匹配真实回执 ' + variant.verifiedDecisions + '，可验证成交净利润 ' + variant.verifiedRealizedProfit +
    '，未验证反事实决策 ' + variant.unverifiedDecisions + '；全程策略收益未知');
  if (replay) lines.push(replay.warning);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(runMerchantBacktest()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
