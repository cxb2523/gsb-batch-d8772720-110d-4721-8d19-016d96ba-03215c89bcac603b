import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Boxes, Building2, CircleUserRound, LayoutDashboard, LogIn, ScrollText, Settings2, Ship, Swords, Timer, X } from "lucide-react"
import { Button } from "./button"
import { Badge } from "./badge"
import { DialogFooter, DialogHeader, DialogTitle } from "./dialog"
import { NativeSelect } from "./native-select"
import { Input } from "./input"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./table"
import { LOG_CATEGORIES, LOG_GROUPS } from "../log-categories.mjs"

// 手机底栏只有约 55px 宽，所以另备短名。
const tabs = [
  ["overview", "总览", "总览", LayoutDashboard], ["idle", "挂机", "挂机", Timer],
  ["settings", "游戏配置", "配置", Settings2], ["manual", "建筑一览", "建筑", Building2],
  ["stages", "挑战", "挑战", Swords], ["resources", "资源与玩法", "资源", Boxes],
  ["account", "账号", "账号", CircleUserRound], ["login-settings", "登录设置", "登录", LogIn],
] as const

export function chrome() {
  return renderToStaticMarkup(<header>
    <div className="headline">
      <div className="mast"><span className="mast-icon"><Ship aria-hidden="true" /></span><h1>疯狂水世界</h1><span className="brand-label">航行控制台</span></div>
      <div className="connection">
        <Badge id="busy" variant="outline" className="status-pill" data-state="off" role="status">未连接</Badge>
        <label className="account-label" htmlFor="account">当前账号</label>
        <NativeSelect id="account" title="选择账号" />
        <Button id="connect" size="sm">连接</Button><Button id="disconnect" size="sm" variant="outline">断开</Button>
        <Button id="account-pause" size="sm" variant="outline" title="暂停后断开游戏连接，方便自行上号">暂停托管</Button>
        <Button id="logs-open" size="sm" variant="outline" aria-haspopup="dialog" aria-controls="journal-dialog"><ScrollText aria-hidden="true" />日志 <span id="log-top-count">0</span></Button>
        <span id="hint" className="warn" />
      </div>
    </div>
    <nav id="tabs" aria-label="功能导航">{tabs.map(([key, title, short, Icon]) =>
      <button type="button" key={key} className="nav-tab" data-tab={key} aria-current={key === "overview" ? "page" : undefined}><Icon aria-hidden="true" /><span className="nav-full">{title}</span><span className="nav-short" aria-hidden="true">{short}</span></button>
    )}</nav>
    <div id="page-progress" aria-hidden="true" />
  </header>)
}

export function journal() {
  return renderToStaticMarkup(<dialog id="journal-dialog" aria-label="运行日志"><aside id="journal" aria-label="运行日志">
    <DialogHeader><DialogTitle className="journal-title">运行日志<Badge id="log-count">0</Badge></DialogTitle></DialogHeader>
    <Button id="logs-close" size="icon-sm" variant="ghost" aria-label="关闭运行日志"><X aria-hidden="true" /></Button>
    <div className="log-toolbar">
      <label className="log-category-label" htmlFor="log-category">功能<select id="log-category" aria-label="日志功能分类" defaultValue="all"><option value="all">全部功能</option>{Object.entries(LOG_GROUPS).map(([group, keys]) => <optgroup key={group} label={group}>{keys.map(key => <option key={key} value={key}>{LOG_CATEGORIES[key]}</option>)}</optgroup>)}</select></label>
      <div className="log-filter" role="group" aria-label="日志筛选">
        <button type="button" id="log-all" aria-pressed="true">全部</button>
        <button type="button" id="log-issues" aria-pressed="false">警告与错误</button>
      </div>
      <Button id="log-clear" size="sm" variant="outline" title="清空当前账号的运行日志">清空日志</Button>
    </div>
    <div id="log" role="log" aria-live="polite" aria-label="操作记录" />
    <p id="log-empty">还没有运行记录</p>
  </aside></dialog>)
}

export function dialogs() {
  return renderToStaticMarkup(<>
    <dialog id="modal" aria-labelledby="m-title">
      <DialogHeader><DialogTitle id="m-title" /></DialogHeader>
      <div id="m-body" />
      <DialogFooter><Button id="m-ok">确认</Button><Button id="m-cancel" variant="outline">取消</Button></DialogFooter>
    </dialog>
    <dialog id="account-dialog" aria-labelledby="account-title"><form method="dialog">
      <DialogHeader><DialogTitle id="account-title" /><p id="account-message" className="dim" /></DialogHeader>
      <Input id="account-label-input" aria-label="账号备注" />
      <DialogFooter><Button value="ok">确认</Button><Button value="cancel" variant="outline">取消</Button></DialogFooter>
    </form></dialog>
    <div id="ui-help-popover" className="help-popover" role="dialog" aria-modal="false" aria-labelledby="ui-help-title" tabIndex={-1} hidden>
      <div className="help-popover-head"><strong id="ui-help-title">说明</strong><Button id="ui-help-close" size="icon-xs" variant="ghost" aria-label="关闭说明"><X aria-hidden="true" /></Button></div>
      <div id="ui-help-body" />
    </div>
  </>)
}

// Clone these rendered components for data that arrives after the initial page.
export function templates() {
  return renderToStaticMarkup(<>
    <template id="ui-table"><Table><TableHeader><TableRow><TableHead /></TableRow></TableHeader><TableBody><TableRow><TableCell /></TableRow></TableBody></Table></template>
    <template id="ui-button"><Button variant="outline" size="sm" /></template>
    <template id="ui-select"><NativeSelect size="sm" /></template>
    <template id="ui-number"><Input type="number" /></template>
    <template id="ui-delete"><Button variant="destructive" size="sm" /></template>
    <template id="ui-badge"><Badge variant="outline" /></template>
  </>)
}
