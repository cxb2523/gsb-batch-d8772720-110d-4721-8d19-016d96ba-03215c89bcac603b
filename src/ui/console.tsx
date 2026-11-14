import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "./button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "./card"
import { Input } from "./input"
import { Switch } from "./switch"
import { HelpTip } from "./help-tip"

type AutoTask = { key: string; label: string; group: string; help?: string; idleGroup?: string; configTarget?: string; idleLabel?: string }

export function idlePanel(tasks: AutoTask[]) {
  const modules=tasks.filter(t=>t.idleGroup);
  const groups=["基地","世界","英雄","日常与活动"];
  return renderToStaticMarkup(<div className="grid gap-3">
    <Card className="idle-schedule">
      <CardHeader>
        <CardTitle className="title-with-help">定时挂机<HelpTip title="定时挂机">轮数填 0 表示持续运行。每轮只执行当前账号已开启的任务。关闭网页后继续在后台运行，日志同步输出到启动窗口；请保持启动窗口打开。</HelpTip><span className="dim heading-status" id="loop-hint" role="status" /></CardTitle>
      </CardHeader>
      <CardContent>
        <div className="loop-form">
          <label htmlFor="loop-rounds">轮数<Input id="loop-rounds" type="number" min="0" defaultValue="0" /></label>
          <label htmlFor="loop-every">间隔（秒）<Input id="loop-every" type="number" min="1" max="86400" defaultValue="60" /></label>
          <Button id="loop-start" disabled>开始挂机</Button>
          <Button id="loop-stop" variant="outline" disabled>暂停挂机</Button>
        </div>
        <p className="dim">关闭网页后继续挂机，日志同步显示在启动窗口。持续运行请将轮数设为 0，并保持启动窗口打开。</p>
      </CardContent>
    </Card>
    <Card className="idle-notes">
      <CardContent>
        <p className="dim">推关与试炼、海盗讨伐开启并配置后，每轮自动执行。失败达到上限后停止对应玩法，暂停后重新开始挂机可重试。</p>
        <p className="dim" id="challenge-run-state" role="status">推关与讨伐尚无执行记录</p>
        <p className="dim" id="single-task-status">手动主线、试炼和首杀推进在挑战页开始；联盟互助仍需单独启动。</p>
        <div className="bar"><Button id="single-go-pirate" variant="outline" size="sm">配置海盗讨伐</Button><Button id="single-go-stages" variant="outline" size="sm">配置推关与试炼</Button><Button id="single-go-mutual" variant="outline" size="sm">前往联盟互助</Button></div>
        <details className="idle-more"><summary>使用说明</summary>
          <p className="dim">这里只控制模块开启；建造、收取、换单、招募与活动领奖等细项在<button id="idle-go-settings" type="button" className="inline-link">游戏配置</button>设置。</p>
          <p className="dim">当前进度和条件统一在<button id="idle-go-overview" type="button" className="inline-link">总览 → 运行概览</button>查看。</p>
          <p className="dim" id="runtime-version" />
        </details>
      </CardContent>
    </Card>
    <div className="bar idle-filter-bar"><Input id="idle-search" type="search" aria-label="查找功能" placeholder="查找功能名称" /><label htmlFor="idle-filter">显示</label><select id="idle-filter" defaultValue="all"><option value="all">全部</option><option value="enabled">已开启</option></select><span id="idle-filter-count" role="status" /></div>
    <nav className="config-subtabs" aria-label="挂机设置分组" role="tablist">
      {groups.map((group,index) => <button type="button" key={group} role="tab" id={'idle-tab-'+index} data-idle-group={index} aria-selected={index===0} aria-controls={'idle-group-'+index}>{group}</button>)}
    </nav>
    {groups.map((group,index) => <section key={group} id={'idle-group-'+index} data-idle-panel={index} role="tabpanel" aria-labelledby={'idle-tab-'+index} hidden={index!==0}>
      <Card><CardHeader><CardTitle>{group}</CardTitle></CardHeader>
      <CardContent className="task-grid idle-module-grid">
        {modules.filter(t => t.idleGroup === group).map(t => <div className="task-setting" key={t.key}>
          <div className="task-label-block"><div className="task-label-line"><label htmlFor={'auto-' + t.key}>{t.idleLabel||t.label}</label>{t.help && t.key !== 'gather.enabled' && <HelpTip title={t.label}>{t.help}</HelpTip>}</div></div>
          <div className="idle-module-actions"><a href={"#config-group-"+t.configTarget} aria-label={"配置"+(t.idleLabel||t.label)}>配置</a><Switch id={'auto-' + t.key} data-auto-task={t.key} data-setting-control="" className="p-0" disabled /></div>
        </div>)}
      </CardContent></Card>
    </section>)}
  </div>)
}

export function action(id: string, label: string, variant: React.ComponentProps<typeof Button>["variant"] = "outline", disabled = false) {
  return renderToStaticMarkup(<Button id={id} variant={variant} disabled={disabled}>{label}</Button>)
}

export function stagePanel() {
  return renderToStaticMarkup(
    <div className="grid gap-3">
    <Card>
      <CardHeader>
        <CardTitle className="title-with-help">主线 / 闯关<HelpTip title="主线 / 闯关">点击开始后连续挑战，每场间隔5秒，同一关连续战败达到本页设置后停止，通关清零。这里的手动参数独立于挂机配置，不会开启每轮挂机。</HelpTip><span id="stage-view" className="heading-status" role="status" aria-live="polite">未同步</span></CardTitle>
      </CardHeader>
      <CardContent>
        <div className="bar">
          <label htmlFor="stage-failures">失败停止次数</label>
          <Input id="stage-failures" aria-label="主线手动挑战失败停止次数" className="w-20" type="number" min="1" defaultValue="3" />
          <Button id="stage-start" disabled>开始连续挑战</Button>
          <Button id="stage-stop" variant="outline" disabled>停止挑战</Button>
        </div>

      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle className="title-with-help">试炼副本<HelpTip title="试炼副本">“挑战一次”只挑战下一关；“开始连续挑战”由你手动开始，达到本页设置的失败停止次数后停止。手动参数与挂机配置独立，扫荡次数另计。</HelpTip></CardTitle><CardAction className="row-span-1 self-center"><Button id="trial-refresh" variant="outline" size="sm">刷新试炼进度</Button></CardAction></CardHeader>
      <CardContent>
        <div id="trial-view" className="progression-view" aria-live="polite" />
      </CardContent>
    </Card>
    <Card><CardHeader><CardTitle>海盗首杀手动推进</CardTitle></CardHeader><CardContent>
      <p className="dim">手动开始本次连续推进，达到失败停止次数或条件不足时停止；不会开启挂机自动讨伐。舰队、目标和汽油限制沿用海盗配置。</p>
      <div className="bar"><a href="#config-group-pirate-hunt">设置舰队、目标与预算</a><label htmlFor="pirate-manual-failures">失败停止次数</label><Input id="pirate-manual-failures" aria-label="海盗手动推进失败停止次数" className="w-20" type="number" min="1" max="100" defaultValue="1" /><Button id="pirate-advance-start" disabled>开始首杀推进</Button><Button id="pirate-advance-stop" variant="outline" disabled>停止首杀推进</Button></div>
      <p id="pirate-advance-state" role="status">尚未开启</p>
    </CardContent></Card>
    </div>
  )
}
export * from "./layout"
export * from "./pages"
export * from "./settings"
