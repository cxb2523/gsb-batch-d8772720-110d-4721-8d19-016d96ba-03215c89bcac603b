# 微信扫码登录：与 xyzw_web_helper 的源码对照

分析日期：2026-10-19。用户要求工具显示二维码，由已经登录的手机微信扫码确认，工具获得游戏登录信息；不登录电脑版微信。

## 参考项目确实实现了这条流程

参考仓库：[w1249178256/xyzw_web_helper](https://github.com/w1249178256/xyzw_web_helper)。
核对版本为 `b408faa88d425e90f01b14f135678dcff95ff893`。本地不保留副本，复核时按此提交重新克隆。
没有安装依赖、启动参考项目或调用其认证接口。

```text
原生 App 的微信授权二维码
  → 手机微信扫码确认
  → 微信 OAuth code
  → Hortor 发行商认证
  → combUser
  → 游戏 authuser 接口
  → 可供 WebSocket 登录使用的游戏 token
```

| 阶段 | 源码位置 | 实际行为 |
|---|---|---|
| 申请二维码 | [WxQrcodeForm.vue:324](https://github.com/w1249178256/xyzw_web_helper/blob/b408faa88d425e90f01b14f135678dcff95ff893/src/views/TokenImport/WxQrcodeForm.vue#L324) | 请求微信 `connect/app/qrconnect`，携带《咸鱼之王》原生 App 的微信 AppID 和包名 |
| 手机确认 | [WxQrcodeForm.vue:408](https://github.com/w1249178256/xyzw_web_helper/blob/b408faa88d425e90f01b14f135678dcff95ff893/src/views/TokenImport/WxQrcodeForm.vue#L408) | 用二维码 UUID 轮询，解析授权回跳地址中的 code |
| 发行商认证 | [WxQrcodeForm.vue:505](https://github.com/w1249178256/xyzw_web_helper/blob/b408faa88d425e90f01b14f135678dcff95ff893/src/views/TokenImport/WxQrcodeForm.vue#L505) | 请求 Hortor 原生 App 登录分支，返回 `combUser` |
| 游戏登录 | [token.ts:116](https://github.com/w1249178256/xyzw_web_helper/blob/b408faa88d425e90f01b14f135678dcff95ff893/src/utils/token.ts#L116) | 将发行商身份装入二进制请求，交给游戏 `/login/authuser`，使用服务器返回的登录数据 |

源码中的 `gameId=xyzwapp`、`gameTp=app`、`tp=app-we` 表明它走原生 App 渠道。
这为“已登录手机扫码获得游戏凭证”提供了具体实现证据；它没有模拟微信小游戏环境中的 `wx.login()`。
静态源码证明实现逻辑存在，不代表已验证该项目当前对真实账号可用。

参考项目的 [worker.js](https://github.com/w1249178256/xyzw_web_helper/blob/b408faa88d425e90f01b14f135678dcff95ff893/worker.js#L19)
和 `edge-functions/api/` 将请求转发到微信及 Hortor。已查看的认证链没有额外第三方换码服务，真正签发凭证的是发行商。

## 移到疯狂水世界需要核实什么

可借鉴二维码会话、手机确认、轮询和凭证兑换的分层。微信应用标识、包名、发行商请求格式、登录通道和游戏身份不能直接照搬。

| 必要信息 | 当前证据 |
|---|---|
| 接收扫码 OAuth code 的发行商登录通道 | 原生包包含第三方登录代码，但本次真机运行的登录配置和界面未开放微信入口；没有取得可用兑换请求 |
| 对应原生 App 的微信 AppID／包名 | 原生包名已确认；移动微信 AppID 未取得，小程序 AppID 不能替代 |
| 返回同一微信小游戏账号的映射 | 尚未证实；官方曾明确区分 App 与小游戏账号 |
| 得到网关要求的四个凭证字段 | 小游戏包已确认映射；扫码 OAuth 路线到这四个字段仍未闭合 |

小游戏 SDK 的公开 `login()` 接收回调，登录时内部调用 `wx.login`。
它在渠道认证成功后才读取 `EWORLAD_TOKEN`；缓存读取和 `reLogin()` 不构成一个已证实的独立续期接口。
游戏包内 Android `EWanSDK` 和 iOS `IOSEWanSDK` 只转调原生代码，未包含完整的原生授权实现。
具体源码位置见 [现有小游戏登录链](wechat-login.md)。

[2026-01-06 官方 FAQ](https://www.taptap.cn/moment/757636351649644939) 说明，官方 App 与微信／抖音小游戏可以处于同一大区，但账号不同。
[2026-08-13 官方活动指南](https://www.taptap.cn/moment/836937384124744522) 仍分别引导 App 用户使用益世界账号、微信小游戏用户使用微信。
这些资料要求我们单独验证身份互通，不能仅凭 App 扫码成功就认定拿到了原来的小游戏角色；也不能排除后续新增的绑定机制。

## 其他已核实入口

官方社区的 [微信登录页](https://fkssj.quxianghudong.com/user/wx-login) 支持手机扫码。
它返回社区 `accessToken`，角色列表和绑定接口用于社区资料；所检查的页面没有把它换成游戏的四个凭证字段。
公开代码中的 `user-cipher` 用于活动页面的身份参数，不能据接口名称把它当成游戏 token。

微信官方还有 [PC 小程序插件](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_PC_APIs/running_a_mini_program)，
可在不安装或登录电脑微信的情况下，通过手机授权宿主运行小游戏。
该路线需要宿主已获批的网站应用、插件权限及认证后台；目标游戏也可能限制运行。
插件的 `login_buffer` 是运行时登录凭据，公开接口没有证明它会直接向宿主导出第三方游戏 token。
这是另一条可研究路线，并非参考项目采用的方式。

## 官包静态分析

应修正先前的排查范围：小游戏包里没有二维码登录代码，不足以否定跨端扫码登录；参考项目说明原生发行商认证可能提供另一条入口。

已从 [游戏官网 Android 下载入口](https://open-api.ewan.cn/ad/download/15917363/app.apk) 的 1.11.6 官包，先通过 HTTP Range 提取清单、四个 DEX 和相关资源，再下载原包用于独立模拟器验证。
完整包为 515,120,896 字节，SHA-256 为 `2377c11d496096ba2293210f7f0e770ec5c87cae9f3a326a280563fd9687a05a`，APK v1/v2 签名校验通过。
文件与来源索引保存在 `work/wechat-login/native-inspect`。

对官包的静态检查已取得进一步证据：

- 官网包名是 `com.gx.sw.gf030.gzyw`，清单注册了其 `wxapi.WXEntryActivity`。
- 发行商 SDK 包含 `WXManager.loginWeChat` 和对应授权回调，说明编入了原生微信登录功能；当前配置是否启用尚未实测。
- `SDKSupport` 登录回调将 `UserData` 的 `openId/token/timestamp/sign` 转成 JSON，通过 `SDK_onLoginSuccess` 传给游戏。字段格式与小游戏协议一致。
- `getWxAppId`、微信授权回调和核心认证实现转入 `ijiami_ewsdk.NCall` 的受保护原生逻辑，当前提取材料中没有明文移动微信 AppID，也没有完整可见的 code 兑换请求。
- 没有发现原生渠道与小游戏角色映射的证据。四字段格式相同不能证明账号身份相同。

继续检查得到的协议和配置证据如下：

| 项目 | 官包中的静态证据 | 能证明的范围 |
|---|---|---|
| 原生 SDK 初始化 | `INIT=400008`，默认 `https://duoinitsdk.ewan.cn/weplay` | 编译时初始化入口；不是已验证的微信 code 兑换地址 |
| 第三方登录 | `THIRD_LOGIN=420005`、`THIRD_LOGIN_WITH_TOKEN=420006` | 协议常量存在；微信分支的选择和请求字段仍在受保护方法中 |
| 初始化配置 | `InitData.thirdLoginConfig`、`loginUrl`、`syncloginurl`；`ThirdLoginConfig(loginType, aid)` | 正常初始化响应是确认实际 AppID、登录地址和启用情况的检查点 |
| 请求构造 | `InitApi`、`BaseApi` 的签名、加密、公共头及解析均转入 `NCall` | 不能从方法名猜出可用请求体或加密参数 |
| 明文资源排查 | 四个 DEX、清单、`resources.arsc`、相关 SDK 配置与保护资源未检出完整移动微信 AppID | 不能把小游戏 AppID 或广告 SDK 的字段当作原生登录 AppID |

小游戏配置与官包配置也不相同：

| 发行商字段 | 微信小游戏版本 71 | 官网 Android 1.11.6 |
|---|---|---|
| appId | 14021170 | 14021514 |
| channelId | 1400 | 17001784 |
| packetId | 50001988 | 50002196 |

这些是发行商编号，不是微信 AppID。小游戏 SDK 的 `platform=1` 是 Android 操作系统枚举，不能用它把微信小游戏登录切换成原生微信 OAuth。
小游戏的 `/api/public/init/before` 和 `/api/public/info` 同样使用完整签名外层，未尝试替换官包编号试探登录通道。

详细本地证据见 `work/wechat-login/native-inspect/findings.md`、`deeper/findings.md` 和 `minigame-init-comparison.md`。
运行分析使用工作目录内新建的临时 AVD，没有使用已有个人 AVD 的用户数据，也没有登录微信。
最初的 16 KB 镜像因官包加固库仅支持 4 KB 对齐而启动失败；随后使用经过官方 SHA-1 校验的 Android 11 镜像，运行时确认页大小 4096、ARM64 转译可用。

### 模拟器运行验证结果

使用原始签名 APK，没有修改游戏代码或认证逻辑。仅在临时模拟器中安装并尝试启动，没有登录、注册或执行游戏操作。

| 环境／ABI | 结果 |
|---|---|
| Android 37.1，16 KB，ARM64 转译 | `libijiami_ewsdk.so` 的 4096 字节 ELF 对齐与 16384 字节系统页不兼容，无法加载 |
| Android 11，4 KB，arm64-v8a | 安装成功，启动阶段 `SIGSEGV`，尚未进入 SDK 初始化页面 |
| Android 11，4 KB，armeabi-v7a | 使用原包的标准 ABI 安装选项，仍在启动阶段 `SIGSEGV`；回溯包含 `libndk_translation.so` 的 `ArmInterpreter`、`FaultyLoad`、`RunGuestJNIFunction` |

两个 4 KB 运行尝试中，目标测试包均没有生成 `shared_prefs`，其 `files` 目录为空。因此没有取得成功初始化后的配置或授权码兑换流量。
这些结果说明当前转译环境无法完成本包的运行验证，不能据此断言游戏存在反模拟器检测，也不能推断真实安卓手机上不可用。
证据在 `work/wechat-login/native-runtime/api30/run2/runtime-status.json` 与同目录目标进程日志。

模拟器阶段结论：

- 已确认的微信小游戏 AppID 为 `wx2ea52a972ea18e5e`；它不是扫码路线所需的原生移动应用 AppID。
- 原生移动微信 AppID 尚未取得，第三方登录仅定位到 `420005/420006` 协议常量，尚不能宣称已找到可用的授权码兑换接口。
- 原角色互通尚未实测；不同发行配置和官方账号说明要求进一步核对，不能默认互通。
- 扫码接入条件尚未满足，因此没有向产品加入无法验证的二维码登录入口。

模拟器阶段缺少的是能正常运行官包的安卓环境中的初始化配置、正常微信授权兑换样本，以及原角色匹配结果。观察脚本已准备在本地，但没有对运行进程注入。

## 真机验证：当前登录配置没有微信入口

2026-10-19，用户连接并授权 USB 调试后，在原生 ARM64、Android 16、4096 字节系统页的安卓手机上验证同一份官网 APK。
最初安装被手机 USB 安装权限拦截；用户开启后安装成功。官网包使用独立包名，手机原有的小米渠道版没有被替换。

只启动官网包并打开“其他账号登录”。日志采集通过官网包的 UID 限定范围，没有读取微信账号数据，没有输入账号密码、获取短信验证码、点击一键认证或进入角色。

取得以下实际证据：

1. 官网包正常启动，`SuperThirdSdk` 记录 `init onSuccess =====`，不再停留于模拟器兼容问题。
2. `Ew_LoginManager` 的 `openLoginView: loginConfig:` 记录了三个 `ThirdLoginConfig` 项：`phone`、`one_click`、`pwd`。该运行时 Map 没有 `wx`。
3. 默认页面是运营商本机号码一键登录；打开“其他账号登录”后，可见国内手机号、短信验证码、一键登录及账密登录，没有微信入口。
4. 目标手机已经安装 `com.tencent.mm`。这里只确认安装状态，没有打开微信或读取其数据；也不能仅凭此证明 SDK 的包可见性、签名检查均通过。
5. 本次目标包启动及登录方式切换日志没有出现完整 `wx` + 16 位十六进制 AppID，也没有捕获微信授权码兑换请求。

**可支持的结论：这份官包 1.11.6 在本次设备、渠道配置和运行时点，初始化后的登录配置及界面均未开放微信登录入口。**
`loginConfig` 是客户端运行时数据，不是直接读取的 HTTP 响应；尚不能确定缺少 `wx` 来自服务端配置还是客户端处理。
这个结果不能推广为其他版本、渠道或未来永远不支持微信，也不能证明账号绝不互通。

脱敏证据摘要保存在 `work/wechat-login/native-runtime/phone/findings.json`；登录方式 UI 树为同目录 `ui-other-login.xml`。
原始日志与初始化截图可能含设备或运营商预取号信息，只保留在被 Git 忽略的本地分析目录，不应随报告公开。

## 当前接入结论

小游戏 AppID `wx2ea52a972ea18e5e` 已确认；原生移动微信 AppID、实际 code 兑换协议、小游戏账号映射尚未取得。
官包路线在本次真机验证中没有提供可用微信授权入口，不能照搬《咸鱼之王》的原生扫码链。当前没有将未经验证的二维码登录加入工具。

只有真实授权后得到的游戏凭证能查询到用户原有角色，才满足接入条件。验证必须核对角色身份与新角色标志，不能把返回同格式凭证或创建新角色当作成功。
