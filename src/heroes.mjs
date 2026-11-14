// 英雄养成：升级、升星、技能升级的判定与执行。
//
// 这里的判定条件逐条对齐游戏客户端自己的红点逻辑（HeroUtil / HeroSkillUtil）：
//   升级  level < maxHeroLevel 且 英雄经验 >= HeroUpgradeCfg[level+1].exp 且 玩家等级 >= reqPlayerLv
//   升星  HeroStarCfg[star+1] 存在，且 该英雄碎片 + 万能碎片 >= 品质对应的消耗
//         HeroStarUpRequest 一次只涨一星（响应里的 nextStar），所以一颗星一条请求
//   技能  当前等级非 0、未达 HeroStarCfg[最大星级].maxSkillLevel[槽位]，
//         且 英雄星级 >= heroStarBySkillLv(槽位, 目标等级)——面板上那个"未解锁"的条件
//         且 HeroSkillUpCfg[品质_目标等级].costArr[槽位] 的道具够
// 服务端是否接受仍以实际回包为准，这里只保证"发出去的一定是客户端也会发的"。

export const HERO_EXP_ITEM = '英雄经验';

const QUALITY_CONSUME = {
  BLUE: 'consumeBlue',
  PURPLE: 'consumePur',
  ORANGE: 'consumeOra',
  RED: 'consumeRed',
};

function buildIndex(config) {
  const rows = (name) => config.tables[name]?.data ?? [];
  const byLevel = new Map();
  for (const row of rows('HeroUpgradeCfg')) byLevel.set(row.level, row);
  const starByStar = new Map();
  for (const row of rows('HeroStarCfg')) starByStar.set(row.star, row);
  const heroById = new Map();
  for (const row of rows('HeroCfg')) heroById.set(row.id, row);
  const skillUp = new Map();
  for (const row of rows('HeroSkillUpCfg')) skillUp.set(`${row.quality}_${row.level}`, row);
  return { byLevel, starByStar, heroById, skillUp };
}

// 英雄等级不能超过玩家等级对应的上限（HeroUpgradeCfg 里 reqPlayerLv 的第一处断点）。
export function maxHeroLevelFor(playerLevel, config) {
  const rows = config.tables.HeroUpgradeCfg?.data ?? [];
  let max = 1;
  for (const row of rows) {
    if (row.reqPlayerLv > playerLevel) break;
    max = row.level;
  }
  return max;
}

export function maxHeroStar(config) {
  const rows = config.tables.HeroStarCfg?.data ?? [];
  return rows.length ? rows[rows.length - 1].star : 0;
}

// HeroUtil.heroStarBySkillLv(槽位, 目标等级)：升到该技能等级需要的最低星级，
// 也就是 HeroStarCfg 里第一条 maxSkillLevel[槽位] >= 目标等级 的记录的 star。
export function skillLevelMinStar(config, slot, targetLevel) {
  const rows = config.tables.HeroStarCfg?.data ?? [];
  for (const row of rows) {
    const cap = row.maxSkillLevel?.[slot];
    if (cap && cap >= targetLevel) return row.star;
  }
  return null;
}

// itemNum: (itemId) => number，直接吃 AllItemRequest 的结果。
export function planHeroes({ config, heroes, itemNum, playerLevel, allowUniversal = true, heroIds = null, settings = null }) {
  const { byLevel, starByStar, heroById, skillUp } = buildIndex(config);
  const pref = settings?.heroes;
  if (pref) { allowUniversal = pref.universal; heroIds = pref.heroIds.length ? pref.heroIds : null; }
  const maxLevel = Math.min(maxHeroLevelFor(playerLevel, config), pref?.targetLevel || Infinity);
  const maxStar = maxHeroStar(config);
  const steps = [];
  const notes = [];
  let expLeft = Math.max(0, itemNum(HERO_EXP_ITEM) - (pref?.keepExp ?? 0));
  if (pref && !pref.enabled) return { steps, notes: ['英雄养成总开关已关闭'], maxLevel, maxStar };

  const picked = heroes.filter((hero) => !heroIds || heroIds.includes(hero.heroId));
  // 升星优先给战力最高的英雄，万能碎片有限时这个顺序更划算。
  const byPower = [...picked].sort((a, b) => (b.power ?? 0) - (a.power ?? 0));

  for (const hero of pref && !pref.level ? [] : picked) {
    const cfg = heroById.get(hero.heroId);
    if (!cfg) {
      notes.push(`${hero.heroId}: HeroCfg 里没有这个英雄，跳过`);
      continue;
    }
    const level = hero.level ?? 1;
    if (level >= maxLevel) {
      notes.push(`${hero.heroId}: 已到玩家等级允许的上限 lv${maxLevel}`);
      continue;
    }
    let cost = 0;
    let count = 0;
    for (let target = level + 1; target <= maxLevel; target += 1) {
      const row = byLevel.get(target);
      if (!row) break;
      if (row.reqPlayerLv > playerLevel) break;
      if (cost + row.exp > expLeft) break;
      cost += row.exp;
      count += 1;
    }
    if (count > 0) {
      steps.push({ kind: 'level', heroId: hero.heroId, from: level, to: level + count, count, exp: cost,
        levelCosts: Array.from({ length: count }, (_, index) => byLevel.get(level + index + 1).exp), costs: [{ id: HERO_EXP_ITEM, num: cost }] });
      expLeft -= cost;
    }
  }

  // 碎片是全局库存，多个英雄抢同一批万能碎片，所以预算要在英雄之间共享。
  const fragBudget = new Map();
  const fragLeft = (item) => (fragBudget.has(item) ? fragBudget.get(item) : itemNum(item));

  for (const hero of pref && !pref.star ? [] : byPower) {
    const cfg = heroById.get(hero.heroId);
    if (!cfg) continue;
    const key = QUALITY_CONSUME[cfg.quality];
    if (!key) {
      notes.push(`${hero.heroId}: 未知品质 ${cfg.quality}，跳升星`);
      continue;
    }
    const ownItem = `${hero.heroId}碎片`;
    const universalItem = allowUniversal ? cfg.universalItemId : null;
    let star = hero.star ?? 0;
    let total = 0;
    let usedUniversal = false;
    let ownUsed = 0;
    let universalUsed = 0;
    const sameItem = universalItem === ownItem;
    const gained = [];
    while (star < Math.min(maxStar, pref?.targetStar || Infinity)) {
      const row = starByStar.get(star + 1);
      if (!row) break;
      const need = row[key] ?? 0;
      const ownAvailable = fragLeft(ownItem) - ownUsed;
      const fromOwn = Math.min(ownAvailable, need);
      const fromUniversal = need - fromOwn;
      if (fromUniversal > 0) {
        if (!universalItem) break;
        const universalAvailable = fragLeft(universalItem) - (sameItem ? ownUsed : 0) - universalUsed;
        if (universalAvailable < fromUniversal) break;
        universalUsed += fromUniversal;
        usedUniversal = true;
      }
      ownUsed += fromOwn;
      total += need;
      star += 1;
      gained.push({ to: star, fragments: need, own: fromOwn });
    }
    if (gained.length) {
      if (ownUsed > 0) fragBudget.set(ownItem, fragLeft(ownItem) - ownUsed);
      if (universalUsed > 0) fragBudget.set(universalItem, fragLeft(universalItem) - universalUsed);
      // 一次升星只涨一星，所以每颗星都是一条独立请求，执行时也会一条一条发。
      for (const entry of gained) {
        // universal=true 表示允许用万能碎片补差额，和客户端里那个"自动兑换"开关等价。
        steps.push({
          kind: 'star',
          heroId: hero.heroId,
          from: entry.to - 1,
          to: entry.to,
          count: 1,
          fragments: entry.fragments,
          own: entry.own,
          total,
          universal: entry.own < entry.fragments,
          costs: [{ id: ownItem, num: entry.own }, ...(entry.own < entry.fragments ? [{ id: universalItem, num: entry.fragments - entry.own }] : [])].filter(item => item.num > 0),
        });
      }
      if (usedUniversal) notes.push(`${hero.heroId}: 升星共用掉 ${universalUsed} 个万能碎片`);
    }
  }

  // 技能：升星会抬升技能等级上限，所以升星计划先执行，这里按升星后的星级算。
  const starAfter = new Map();
  for (const hero of heroes) starAfter.set(hero.heroId, hero.star ?? 0);
  for (const step of steps) if (step.kind === 'star') starAfter.set(step.heroId, step.to);

  const bookBudget = new Map();
  const bookLeft = (item) => (bookBudget.has(item) ? bookBudget.get(item) : itemNum(item));

  for (const hero of pref && !pref.skill ? [] : picked) {
    const cfg = heroById.get(hero.heroId);
    if (!cfg) continue;
    const levels = hero.skillLevels ?? [];
    const star = starAfter.get(hero.heroId) ?? 0;
    for (let slot = 0; slot < Math.max(levels.length, 4); slot += 1) {
      let cur = levels[slot] ?? 0;
      // 等级 0 表示这个技能还没解锁，面板上直接不给升，这里也不排。
      if (cur === 0) continue;
      // 上限取自最高星级那一行（面板用的是 maxStarCfg），不是当前星级那一行。
      const cap = starByStar.get(maxStar)?.maxSkillLevel?.[slot] ?? 0;
      // 每次只升一级：目标是 cur+1，消耗取 HeroSkillUpCfg[品质_目标等级].costArr[槽位]
      while (cur < cap) {
        const target = cur + 1;
        // 面板条件：英雄星级 >= heroStarBySkillLv(槽位, 目标等级)，不满足就点不动。
        const needStar = skillLevelMinStar(config, slot, target);
        if (needStar === null || star < needStar) {
          notes.push(`${hero.heroId} 技能${slot + 1}: 升到 ${target} 级需要 ${needStar ?? '?'} 星，当前 ${star} 星`);
          break;
        }
        const row = skillUp.get(`${cfg.quality}_${target}`);
        const cost = row?.costArr?.[slot];
        if (!cost || !cost.length) break;
        const [item, num] = cost;
        if (bookLeft(item) < num) {
          notes.push(`${hero.heroId} 技能${slot + 1}: 还差 ${item} ${num - bookLeft(item)}`);
          break;
        }
        bookBudget.set(item, bookLeft(item) - num);
        steps.push({ kind: 'skill', heroId: hero.heroId, slot, from: cur, to: target, item, num, costs: [{ id: item, num }] });
        cur = target;
      }
    }
  }

  return { steps, notes, maxLevel, maxStar };
}

// 逐条执行。HeroLevelUpRequest 一次只升一级，服务端没有批量接口，所以英雄升级会被展开成多次请求。
export async function runHeroPlan(client, protocol, plan, { allowMutate = false, timeout = 15000, onStep, enabled = () => true, getSettings, beforeAction, afterAction, cancelAction } = {}) {
  if (!allowMutate) throw new Error('英雄养成会改变账号状态，需要 --yes');
  const results = [];
  // 同一英雄的同一类操作一旦被服务端拒了，后面的同类步骤必然同样被拒，直接跳过不再骚扰服务端。
  const blocked = new Set();
  for (const step of plan.steps) {
    if (!enabled()) break;
    const key = `${step.kind}|${step.heroId}`;
    if (blocked.has(key)) {
      const entry = { step, targetLevel: step.kind === 'level' ? step.from + 1 : undefined,
        ok: false, skipped: true, error: '同类操作已被服务端拒绝，跳过' };
      results.push(entry);
      onStep?.(entry);
      continue;
    }
    const calls = step.kind === 'level' ? step.count : 1;
    for (let i = 0; i < calls; i += 1) {
      if (!enabled()) break;
      const pref = getSettings?.()?.heroes;
      if (pref && (!pref.enabled || !pref[step.kind] || (pref.heroIds.length && !pref.heroIds.includes(step.heroId)) ||
        (step.kind === 'level' && pref.targetLevel > 0 && step.from + i + 1 > pref.targetLevel) ||
        (step.kind === 'star' && ((pref.targetStar > 0 && step.to > pref.targetStar) || (step.universal && !pref.universal))))) break;
      const body = buildHeroBody(step);
      const targetLevel = step.kind === 'level' ? step.from + i + 1 : undefined;
      const request = step.kind === 'level' ? 'HeroLevelUpRequest' : step.kind === 'star' ? 'HeroStarUpRequest' : 'HeroSkillLevelUpRequest';
      const budgetStep = { ...step, request, body, targetLevel, scope: 'hero', setting: `heroes.${step.kind}`, label: `${step.heroId}养成`,
        costs: step.kind === 'level' ? [{ id: HERO_EXP_ITEM, num: step.levelCosts?.[i] }] : step.costs };
      let ticket = null, prepared = false, sent = false, writePending = false;
      try {
        ticket = await beforeAction?.(budgetStep); prepared = true;
        if (!enabled()) { await cancelAction?.(budgetStep, ticket, { notSent: true }); break; }
        sent = writePending = true;
        const outcome = await sendHero(client, protocol, step, body, timeout);
        writePending = false;
        const entry = { step, targetLevel, ok: true, ...outcome };
        results.push(entry);
        onStep?.(entry);
        await afterAction?.(budgetStep, ticket, outcome.response ? entry : { ...entry, sent: true });
      } catch (error) {
        const notSent = !sent || (writePending && error.notSent === true);
        if (prepared && (notSent || error.prompt && error.request === request)) await cancelAction?.(budgetStep, ticket, { notSent, error });
        blocked.add(key);
        const entry = { step, targetLevel, ok: false, ...(error.code === 'AUTOMATION_SKIP' ? { skipped: true } : {}), error: error.message };
        results.push(entry);
        onStep?.(entry);
        break;
      }
      // sendWatch 自己就有观察窗口，这里只留一点间隔，避免连发太密。
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
  return results;
}

function buildHeroBody(step) {
  if (step.kind === 'level') return { heroId: step.heroId };
  if (step.kind === 'star') return { heroId: step.heroId, universal: step.universal !== false };
  if (step.kind === 'skill') return { heroId: step.heroId, skillIdx: step.slot + 1 };
  throw new Error(`unknown hero step: ${step.kind}`);
}

// 只有 HeroStarUpRequest 在协议表里有配套的 Response，升级和技能走推送（SCUpdateHero），
// 成功时服务端一声不吭，被拒时只推 PromptResponse，所以用 sendWatch 守一小段时间。
async function sendHero(client, protocol, step, body, timeout) {
  const request = step.kind === 'level'
    ? 'HeroLevelUpRequest'
    : step.kind === 'star'
      ? 'HeroStarUpRequest'
      : 'HeroSkillLevelUpRequest';
  if (!protocol[request]) throw Object.assign(new Error(`protocol has no type ${request}`), { notSent: true });
  if (request === 'HeroStarUpRequest') {
    const response = await client.request(request, body, 'HeroStarUpResponse', timeout);
    return { response: 'HeroStarUpResponse', body: response };
  }
  const watched = await client.sendWatch(request, body, { window: 300 });
  return { response: null, body: watched };
}

export function formatHeroPlan(plan) {
  const lines = [];
  for (const step of plan.steps) {
    if (step.kind === 'level') lines.push(`升级 ${step.heroId} lv${step.from} -> lv${step.to} (${step.count} 级, ${step.exp} 经验)`);
    else if (step.kind === 'star') lines.push(`升星 ${step.heroId} ${step.from} -> ${step.to} 星 (${step.fragments} 碎片${step.universal ? '，含万能' : ''})`);
    else lines.push(`技能 ${step.heroId} 第${step.slot + 1}技能 ${step.from} -> ${step.to} (${step.item} x${step.num})`);
  }
  return lines.length ? lines.join('\n') : '当前没有可升级、升星或提升技能的英雄。';
}
