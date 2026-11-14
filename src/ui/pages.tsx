import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "./button"
import { Card, CardAction, CardHeader, CardTitle, CardContent } from "./card"
import { Input } from "./input"
import { Switch } from "./switch"
import { HelpTip } from "./help-tip"
import { Badge } from "./badge"

function Panel({title, help, titleAfter, collapseId, children}: {title: string; help?: string; titleAfter?: React.ReactNode; collapseId?: string; children: React.ReactNode}) {
  return <Card><CardHeader><CardTitle className="title-with-help">{title}{help && <HelpTip title={title}>{help}</HelpTip>}</CardTitle>{titleAfter && <CardAction className="row-span-1 self-center max-md:col-span-2 max-md:col-start-1 max-md:row-start-2 max-md:justify-self-start">{titleAfter}</CardAction>}{collapseId && <CardAction className="row-span-1 self-center"><Button type="button" size="sm" variant="ghost" data-panel-toggle={collapseId} aria-controls={collapseId} aria-expanded="false">展开</Button></CardAction>}</CardHeader><CardContent id={collapseId} hidden={!!collapseId}>{children}</CardContent></Card>
}

function Option({id, label, checked = false}: {id: string; label: string; checked?: boolean}) {
  return <div className="bar"><Switch id={id} data-local-switch="" defaultChecked={checked} className="p-0" /><label htmlFor={id}>{label}</label></div>
}

export function giftCodesPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="礼包兑换" help="每个账号独立排队，兑换请求逐个发送。账号登录失败或结果未知只停止该账号；任一账号遇到服务器限频时，同批尚未发送的账号全部停止，之后可重新提交。"><label htmlFor="gift-code-input">礼包码（换行或逗号分隔）</label>
      <textarea id="gift-code-input" rows={3} maxLength={12000} className="w-full" placeholder="每批最多100个" />
      <div className="bar"><Button type="button" variant="outline" size="sm" id="gift-load-initial">载入初始码</Button><span id="gift-code-initial-note" className="dim" role="status" /></div>
      <fieldset className="gift-accounts"><legend>兑换账号</legend>
        <div className="bar"><Button variant="outline" size="sm" id="gift-select-all">全选</Button><Button variant="outline" size="sm" id="gift-select-none">清空</Button><span id="gift-selected-count" className="dim" /></div>
        <div id="gift-account-list" className="gift-account-list" />
        <p className="dim">未连接的账号会自动登录，可能把正在玩的游戏顶下线，兑换后保持连接。已暂停的账号不能选择。</p>
      </fieldset>
      <div className="bar"><Button id="gift-code-start">开始兑换</Button><span id="gift-code-state" role="status" /></div></Panel>
    <Panel title="兑换记录"><div className="bar"><label htmlFor="gift-record-account">查看账号</label><select id="gift-record-account" /></div><div className="overflow-auto"><table><thead><tr>{['礼包码','状态','结果','时间'].map(t=><th key={t}>{t}</th>)}</tr></thead><tbody id="gift-code-history" /></table></div>
      <div className="bar"><Button variant="outline" id="gift-prev">上一页</Button><span id="gift-page" /><Button variant="outline" id="gift-next">下一页</Button></div></Panel>
  </div>)
}

export function overviewPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="运行概览" help="按功能分别查看当前进度与当前条件。这里只读展示；开关仍在挂机页设置。">
      <div className="bar overview-task-filter"><Input id="overview-task-search" type="search" aria-label="查找运行状态" placeholder="功能名称或状态" /><label htmlFor="overview-task-filter">显示</label><select id="overview-task-filter" defaultValue="enabled"><option value="enabled">已开启</option><option value="issues">异常 / 受总控限制</option><option value="all">全部项目</option></select></div>
      <p id="overview-task-summary" className="dim" role="status">等待读取运行状态</p>
      <div id="overview-task-groups" />
    </Panel>
    <Panel title="活动统计" collapseId="activity-stats-content" help="活动名称取游戏当前期数配置。福利与达标奖励分别核对；“已达成已领”不表示所有档位都已完成，未同步不会记为已领取。时间使用北京时间MM-DD。">
      <div className="bar"><Button id="activity-stats-refresh" variant="outline" size="sm">刷新统计</Button><span id="activity-stats-status" className="dim" role="status">连接后读取</span></div>
      <div id="activity-stats-table" className="activity-statistics-scroll" aria-label="活动统计表格" tabIndex={0} />
    </Panel>
    <Panel title="活动排行榜" collapseId="activity-rank-content" help="只读查看游戏返回的玩家排行，不领取奖励或发起挑战。按页签切换，未开放与未上榜会单独说明。">
      <div className="bar"><Button id="activity-rank-refresh" variant="outline" size="sm">刷新排行</Button><span id="activity-rank-status" className="dim" role="status">连接后读取</span></div>
      <div id="activity-rank-tabs" className="config-subtabs" role="tablist" aria-label="活动排行榜" />
      <div id="activity-rank-panel" role="tabpanel"><p id="activity-rank-mine" className="dim" /><div id="activity-rank-table" className="activity-rank-table" /></div>
      <div className="bar"><Button id="activity-rank-prev" variant="outline" size="sm" disabled>上一页</Button><span id="activity-rank-page" className="dim" /><Button id="activity-rank-next" variant="outline" size="sm" disabled>下一页</Button></div>
    </Panel>
    <Panel title="世界概览" help="只读地图。移动位置按已同步起终点和行军时间推算。自动刷新仅影响本模块，不改挂机间隔；可设5–300秒。" titleAfter={<div className="world-refresh-controls"><Button id="world-map-auto-refresh" size="sm" variant="outline" aria-pressed="true">自动刷新：开</Button><label className="world-refresh-setting">每<input id="world-map-refresh-seconds" aria-label="世界概览刷新秒数" type="number" min="5" max="300" step="1" defaultValue="10" />秒</label></div>}>
      <div id="world-map-fleets" className="fleet-summary" aria-label="我的舰队" />
      <details className="world-map-stats"><summary>城战与货轮详情</summary><div id="world-map-wars" /><div id="world-map-treasures" /></details>
      <details className="world-map-stats"><summary>汽油用量</summary><div id="world-map-resources" /></details>
      <div className="bar world-map-toolbar"><Button id="world-map-refresh" variant="outline" size="sm">刷新地图</Button><Button id="world-map-pan" variant="outline" size="sm" aria-pressed="false">移动地图</Button><Button id="world-map-reset" variant="outline" size="sm">全图</Button><Button id="world-map-home" variant="outline" size="sm">定位舰队</Button><label htmlFor="world-map-zoom">缩放</label><input id="world-map-zoom" type="range" min="1" max="8" step="0.25" defaultValue="1" /><span id="world-map-time" role="status">尚未读取</span></div>
      <div id="world-map-layers" className="bar" />
      <div className="world-map-layout"><div id="world-map-scroll" className="world-map-scroll"><svg id="world-map" role="group" aria-label="只读世界地图" /></div><div id="world-map-legend" className="world-map-legend" /><div id="world-map-state-legend" className="world-map-state-legend" /><p className="world-map-help"><span className="for-mouse">拖动平移 · Ctrl+滚轮缩放 · </span><span className="for-touch">点「移动地图」后单指拖动 · 用缩放滑块放大 · </span>放大查看舰队名和攻守优先+排队数</p><aside id="world-map-detail" className="world-map-detail" hidden /></div>
      <p id="world-map-notes" className="dim" />
    </Panel>
  </div>)
}

export function activitiesPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <div className="activity-toolbar"><p className="dim">选择活动，单独执行或设置自动运行。</p><Button id="activities-refresh" variant="outline" size="sm">刷新活动</Button></div>
    <div id="activities-status" className="dim" role="status" />
    <div className="activity-shell">
      <div id="activity-tabs" className="activity-tabs" role="tablist" aria-label="选择活动" />
      <section id="activity-panel" role="tabpanel" tabIndex={0} hidden>
        <Card><CardHeader><div className="activity-heading"><CardTitle id="activity-title" /><span id="activity-kind" /></div><p id="activity-end" className="dim" /></CardHeader>
          <CardContent className="activity-content">
            <div id="activity-pirates" hidden><div id="pirate-board-view" className="pirate-board" aria-live="polite" /></div>
            <div id="activity-detail"><div id="activities-list" className="activity-body" /><div id="activities-order" /></div>
          </CardContent>
        </Card>
      </section>
    </div>
    <Panel title="材料来源查询"><label htmlFor="source-query">游戏材料名称</label><Input id="source-query" placeholder="例如：有机土壤" /><div id="source-results" aria-live="polite" /></Panel>
    <template id="ui-event-switch"><Switch className="p-0" /></template>
  </div>)
}

export function manualPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="一键领取" help="领取主线、成就、邮件、挂机收益，以及已拥有英雄的技能展示首领奖励，不花钻石。逐项结果见运行日志。"><div className="bar"><Button id="loot-run">领取现在能领的</Button><span id="loot-hint" role="status" /></div></Panel>
    <Panel title="任务奖励" help="检查或领取主线、支线、成就和每日订单档位奖励。无法确认目标值的任务会跳过，结果见运行日志。"><div className="bar"><Button id="tasks-plan" variant="outline">检查可领</Button><Button id="tasks-run">领取任务奖励</Button><span id="tasks-hint" role="status" /></div></Panel>
    <Panel title="海面" help="收成品 → 竣工 → 交单 → 按订单缺口排产 → 余料升级建筑。本轮是否允许使用加速器、拒单重刷，由下方本次开关决定。">
    <div className="bar">
      <Option id="world-speedup" label="本轮允许花加速器" />
      <Option id="world-reroll" label="本轮拒单重刷" />
      <Button id="world-plan" variant="outline">刷新数据</Button>
      <Button id="world-run" variant="default">执行一轮</Button>
      <span id="world-hint" className="warn"></span>
    </div>
    <div id="world-view" role="status" />
    <div id="world-factories"></div>
    <div id="world-orders"></div>
    </Panel>
    <Panel title="资源田"><div id="world-fields" /></Panel>
  </div>)
}

export function inventoryPage() {
  return renderToStaticMarkup(<div className="grid gap-3"><Panel title="仓库">
    <div className="bar"><Button id="inventory-refresh" variant="outline">刷新库存</Button><span id="inventory-status" className="dim" role="status">尚未读取</span></div>
    <div className="bar inventory-search"><label htmlFor="inventory-query">资源名称</label><Input id="inventory-query" type="search" placeholder="搜索资源名称" /><span id="inventory-match-count" className="dim" /></div>
    <details id="world-stock-panel"><summary>展开分类库存</summary><div id="world-stock" /></details>
  </Panel></div>)
}

export function heroesPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="主力英雄"><div className="icons" id="hero-strip"><span className="dim">连接后显示</span></div></Panel>
    <Panel title="英雄养成" help="升级、升星、升技能的条件取自游戏客户端的红点逻辑；执行前会先算一遍计划。">
<div className="bar">
      <Button id="hero-plan" variant="outline">计算计划</Button>
      <Button id="hero-run" variant="default">执行养成</Button>
      <span id="hero-hint" className="warn"></span>
    </div>
    <pre id="hero-view">尚未计算</pre>
    <div id="hero-table"></div>
    </Panel>
    <Panel title="英雄任命" help="按游戏内的职位优先顺序自动分配英雄，已有任命可能调整。">
    <div className="bar">
      <Button id="appoint-view" variant="outline">查看职位</Button>
      <Button id="appoint-run" variant="default">一键任命</Button>
    </div>
    <div id="appoint-table" className="dim">尚未查看职位</div></Panel>
    <Panel title="英雄装备">
      <div className="bar"><Button id="equipment-refresh" variant="outline">刷新装备</Button></div>
      <div id="equipment-view" className="progression-view" aria-live="polite" />
    </Panel>
    <Panel title="装备制造"><div className="bar"><Button id="crafting-refresh" variant="outline">刷新装备厂</Button></div><div id="crafting-view" className="progression-view" aria-live="polite" /></Panel>
    <Panel title="推荐阵容"><div className="bar"><Button id="lineup-refresh" variant="outline">刷新推荐</Button></div><div id="lineup-view" className="progression-view" aria-live="polite" /></Panel>
    <Panel title="远征舰队编队" help="保留空编队的初始化入口。已有编队不会自动重排；舰队状态在总览查看，首杀连续推进在挂机页开启。"><div id="formation-view" className="progression-view" aria-live="polite" /></Panel>
  </div>)
}

export function dailiesPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="每日任务" help="先“探测”查看当前能做哪些任务及不能执行的原因。点金与折扣店默认跳过，勾选允许花钻石才会消费。">
<div className="bar">
      <Button id="dailies-plan" variant="outline">探测</Button>
      <Button id="dailies-run" variant="default">一键完成</Button>
      <Option id="dailies-paid" label="允许花钻石（默认关闭）" />
      <span id="dailies-hint" className="warn"></span>
    </div>

    <div id="dailies-table"></div></Panel>

  </div>)
}

export function accountPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="账号" help="导出的账号备份含登录凭证，请妥善保管。账号切换与暂停状态分别保存。">
    <div className="bar"><Button id="export-accounts" variant="outline">导出全部账号</Button><span className="dim">备份含登录凭证</span></div>
    <div id="accounts"></div>

    <div id="account-detail-home" hidden><div id="account-details">
      <h4>角色概况</h4><div className="who" id="who">等待连接</div>
      <h4>资源</h4><div className="resource-strip" id="res">连接后显示</div>
      <h4>凭证</h4>    <div className="bar">
      <Button id="cred-show" variant="outline">显示凭证</Button>
      <Button id="cred-hide" variant="outline">收起</Button>
      <span className="dim">仅限本机使用</span>
    </div>
    <div id="cred"></div>

      <h4>区服</h4>    <div className="bar">
      <Button id="load-worlds" variant="outline">加载区服</Button>
      <Input id="world-input" aria-label="区服 ID" placeholder="区服 ID" className="w-32" />
      <Button id="enter-world" variant="outline">进入该区服</Button>
      <span id="worlds-hint" className="warn"></span>
    </div>
    <div id="worlds"></div>

    </div></div></Panel>
    <Panel title="手机号登录" help="使用益世界/APP 的账号密码或短信验证码登录。密码只用于本次请求，不保存。登录后先核对 openId 是否对应已有角色，再保存。">
    <div className="bar">
      <Input id="phone-account" placeholder="手机号或账号" autoComplete="username" />
      <Input id="phone-password" type="password" placeholder="登录密码" autoComplete="current-password" />
      <Button id="phone-login" variant="default">账号登录并预览</Button>
      <Button id="phone-save" variant="outline" disabled>保存为账号</Button>
      <span id="phone-hint" className="warn" role="status"></span>
    </div>
    <div className="bar">
      <Input id="phone-code" placeholder="短信验证码" inputMode="numeric" autoComplete="one-time-code" />
      <Button id="phone-send-code" variant="outline">发送验证码</Button>
      <Button id="phone-sms-login" variant="default">验证码登录并预览</Button>
    </div>
    <div id="phone-result"></div>
</Panel>
    <Panel title="添加账号">
    <div className="bar">
      <Button id="cap-start" variant="default">从电脑微信添加</Button>
      <Button id="cap-douyin" variant="outline">从电脑抖音添加</Button>
      <Button id="cap-stop" variant="destructive">停止抓包</Button>
      <span id="cap-hint" className="warn"></span>
    </div>
    <div id="cap-box"></div>
</Panel>
  </div>)
}

/**
 * Per-account login recovery settings.  The page deliberately only renders
 * controls and stable IDs; page.mjs owns loading/saving so the same controls
 * can be reused when the active account changes.
 */
export function loginSettingsPage() {
  return renderToStaticMarkup(<div id="login-settings-root" className="login-settings-page">
    <div className="login-settings-heading">
      <div className="login-settings-heading-copy">
        <div><h2 className="text-xl font-semibold">登录设置</h2><p className="dim mt-1">账号被顶号后自动重新连接</p></div>
      </div>
      <Badge id="login-settings-state" className="login-settings-state" variant="outline" role="status" aria-live="polite">尚未载入</Badge>
    </div>
    <form id="login-settings-form" noValidate>
      <Card className="login-settings-card">
        <CardHeader><CardTitle>顶号重连延迟时间</CardTitle><p className="dim">账号在执行任务时被顶号，等待一段时间后再重新登录。</p></CardHeader>
        <CardContent>
          <div className="login-settings-toggle-row">
            <div><strong>启用被顶号后自动重连</strong><span className="dim">仅在检测到“账号在别处登录”时触发。</span></div>
            <Switch id="login-reconnect-enabled" data-login-setting="reconnectEnabled" aria-label="启用被顶号后自动重连" />
          </div>
          <div className="login-settings-grid">
            <label htmlFor="login-reconnect-delay"><span>基础重连间隔</span><span className="login-settings-field"><Input id="login-reconnect-delay" data-login-setting="baseDelaySeconds" type="number" min="1" max="86400" step="1" defaultValue="900" /><span>秒</span></span></label>
            <label htmlFor="login-reconnect-jitter"><span>间隔抖动</span><span className="login-settings-field"><Input id="login-reconnect-jitter" data-login-setting="jitterSeconds" type="number" min="0" max="86400" step="1" defaultValue="0" /><span>秒</span></span></label>
          </div>
          <p className="dim login-settings-note">实际等待时间会在基础间隔上下随机调整，避免固定时间重复登录。</p>
        </CardContent>
      </Card>

      <Card className="login-settings-card">
        <CardHeader><CardTitle>深夜空窗期</CardTitle><p className="dim">在指定时间段内使用独立的短延迟，适合凌晨自动恢复连接。</p></CardHeader>
        <CardContent>
          <div className="login-settings-toggle-row">
            <div><strong>启用深夜空窗期</strong><span className="dim">跨午夜的时间段也可以使用，例如 23:00–06:00。</span></div>
            <Switch id="login-deep-enabled" data-login-setting="deep.enabled" aria-label="启用深夜空窗期" />
          </div>
          <div className="login-settings-grid login-settings-time-grid">
            <label htmlFor="login-deep-start"><span>开始时间</span><Input id="login-deep-start" data-login-setting="deep.start" type="time" defaultValue="02:00" /></label>
            <label htmlFor="login-deep-end"><span>结束时间</span><Input id="login-deep-end" data-login-setting="deep.end" type="time" defaultValue="07:00" /></label>
            <label htmlFor="login-deep-delay"><span>空窗期重连延迟</span><span className="login-settings-field"><Input id="login-deep-delay" data-login-setting="deep.delaySeconds" type="number" min="1" max="86400" step="1" defaultValue="60" /><span>秒</span></span></label>
          </div>
        </CardContent>
      </Card>

      <Card className="login-settings-card">
        <CardHeader><CardTitle>重试限制</CardTitle><p className="dim">顶号重连连续失败达到上限后停止本轮重试，并在运行日志中记录原因。</p></CardHeader>
        <CardContent>
          <div className="login-settings-grid login-settings-retry-grid">
            <label htmlFor="login-reconnect-max-retries"><span>最大重试次数</span><span className="login-settings-field"><Input id="login-reconnect-max-retries" data-login-setting="maxRetries" type="number" min="1" max="1000" step="1" defaultValue="5" /><span>次</span></span></label>
          </div>
          <p id="login-reconnect-log" className="dim login-settings-log" role="status">超过上限后自动停止重试，详情见运行日志。</p>
        </CardContent>
      </Card>

      <div className="login-settings-actions">
        <Button id="login-settings-reset" type="button" variant="outline">恢复已保存设置</Button>
        <Button id="login-settings-save" type="submit">保存设置</Button>
      </div>
    </form>
  </div>)
}


export function guildPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="联盟福利">
      <div className="bar"><Button id="guild-refresh" variant="outline">刷新联盟</Button></div>
      <div id="guild-view" className="progression-view" aria-live="polite" />
    </Panel>
    <Panel title="联盟求助"><div id="guild-aid-view" className="progression-view" /></Panel>
    <Panel title="联盟科技" help="当前角色的科技等级与加成。升级只执行一级，扣除对应科技点；发送前重新核对等级、阶段、前置科技和费用。"><div className="bar"><Button id="guild-tech-refresh" variant="outline" size="sm">刷新科技</Button></div><div id="guild-tech-view" className="progression-view" aria-live="polite" /></Panel>
  </div>)
}
