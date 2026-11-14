# 手机号/账号密码登录链分析

分析日期：2026-11-07。对象是用户提供的 `1.apk`（版本 1.11.6.480，包名 `com.gx.sw.qd.mi`）。在 MuMu 模拟器（Android 12、已 root）上安装并抓包，账号密码登录请求已经完整解密。

## 结论

这个包没有走 `user-center-api.eworld.cn` 的 UCAuth 网页流程，而是走益世界 ewan 账号 SDK：

| 动作 | 地址 | 协议号 |
|---|---|---|
| 账号密码登录 | `http://loginsdk.ewan.cn/login` | `100003` |
| 获取短信验证码 | `http://duoaccountsdk.ewan.cn/account` | `100015` |
| 短信验证码校验 | `http://loginsdk.ewan.cn/login` | `420012` |
| 短信验证码完成登录 | `http://loginsdk.ewan.cn/login` | `420007` |

请求和响应都是 URL 编码表单/JSON 做 **AES-128-ECB/PKCS7**，密钥为 SDK 内的 `cwQ52wanEJkW56Xc`。请求体以十六进制文本发送，`Content-Type` 仍是 `application/x-www-form-urlencoded`。

ewan 登录成功后，SDK 返回 `openid / sign / timestamp / token`，但这还**不能直接连网关**。APP 随后会调用游戏业务登录 `api.gzxianc.com/api/user/login`，用 ewan 身份换取最终的 `openId / signToken / sign / ts`；直接拿 ewan 凭证连网关会被 `1000 Bye` 关闭。

```json
{
  "status": 200,
  "userid": 100000000,
  "username": "example",
  "openid": "1234567890123456789012345",
  "sign": "0123456789abcdef0123456789abcdef",
  "timestamp": "1790000000000",
  "token": "1790000000000",
  "phone": "138****0000",
  "bandphoneflag": 1
}
```

`token` 与 `timestamp` 都是 13 位数字，和微信抓包里的网关 token 格式一致；`openid` 是游戏账号身份，不是微信 openId。

业务登录请求：

```text
POST https://api.gzxianc.com/api/user/login?...
{
  "appVersion": "1.11.6",
  "channel": {
    "uid": "<ewan openid>",
    "extJson": "{\"username\":\"...\",\"timestamp\":0,\"token\":\"<ewan token>\",\"isAuth\":true,\"birthday\":\"20001013\"}"
  },
  "phoneModel": "Xiaomi M2102K1AC",
  "registrationId": "",
  "sysVersion": "12"
}
```

业务登录成功返回：

```json
{"code":0,"data":{"openId":"...","token":"<36位会话token>","signToken":"<13位网关token>","sign":"<32位签名>","ts":1794062429729,"zoneId":"2"}}
```

网关 `eworldParams.token` 用 `signToken`，不要用 `token`。

APP 实际 `LoginRequest.eworldClientInfo`：

```json
{
  "appId": "14021105",
  "channelId": "17001784",
  "clientVersion": "1.12.9",
  "networkType": "Wifi",
  "platform": "1",
  "did": "0123456789ABCDEF0123456789ABCDEF",
  "sc": "261390",
  "extc": "261390",
  "biz": "102",
  "isAuth": true,
  "birthday": "2000-10-13",
  "originVersion": "1.11.6.480"
}
```

`LoginRequest.language` 为 `zh_CN`，`systemLanguage` 为 `zh_cn_#hans`。这些字段与 APP 不一致时，即使凭证正确，网关也会以 `1000 Bye` 关闭。

## 抓包条件

- MuMu 模拟器，Android 12，`adb root` 可用。
- 本机 mitmproxy 监听 `8888`，CA 通过 tmpfs 挂载写入 `/system/etc/security/cacerts`。
- `adb reverse tcp:8888 tcp:8888`，模拟器系统代理指向 `127.0.0.1:8888`。
- 只用于分析本机模拟器中的游戏登录，不抓其他应用。

账号密码登录请求和响应示例（已解密，敏感值用假数据）：

```text
POST http://loginsdk.ewan.cn/login
Headers: ai=56000005, pi=261390, cv=6633, di=<64 hex>, oi=<di 后 32 位>, pf=1
Body (AES-128-ECB 后为 hex):
appid=56000005&appname=疯狂水世界&appversion=1.11.6&channel=17001784
&devicecode=<16 hex>&packetid=261390&password=<明文>&protocol=100003
&superappid=14021105&username=<账号>&...
Response:
{"status":-100,"error":1002,"errorMsg":"亲,用户名或密码错误哦 ..."}
```

短信验证码流程（已抓包确认）：

```text
POST http://duoaccountsdk.ewan.cn/account
protocol=100015&phone=<手机号>&type=7&...
Response: {"status":200,"validatecode":""}

POST http://loginsdk.ewan.cn/login
protocol=420012&phone=<手机号>&querytype=1&queryvalue=<验证码>&resolution=720*1280&...
Response: {"status":-100,"error":1004,"errorMsg":"亲,动态验证码错误哦 ..."}
```

验证码正确时，420012 只返回手机号关联账号，不是最终凭证：

```json
{
  "status": 200,
  "userAccountStatus": 1,
  "userAccount": [
    {"userId": 0, "userName": "example", "multiAccountToken": "<临时令牌>"}
  ],
  "phone": "138****0000"
}
```

工具取第一个账号的 `multiAccountToken`，再提交 420007：

```text
POST http://loginsdk.ewan.cn/login
protocol=420007&phone=<手机号>&multiAccountToken=<临时令牌>
&validatecode=<验证码>&resolution=720*1280&...
```

420007 的成功响应与账号密码登录相同，返回 `openid/sign/timestamp/token`。

## APK 内的常量

`AndroidManifest.xml` 的 `cwpd` Base64 JSON 给出：

```json
{"signKey":"6d16b907a941e3Fa","packetId":50001889,"channelId":17001784,"bai":14021105,"bci":17001784,"sst":1,"cst":1}
```

抓包实际使用的账号 SDK 参数：

| 字段 | 值 |
|---|---|
| `appid` | `56000005` |
| `superappid` | `14021105` |
| `channel` | `17001784` |
| `packetid` / `tt_channel_id` | `261390` |
| `curvc` / `sdkversionid` | `6633` |
| `pluginvc` / `hostvc` / `cursubvc` / `hostsubvc` | `354` |
| `appversion` / `appversioncode` | `1.11.6` / `356` |
| AES key | `cwQ52wanEJkW56Xc` |

`di` 是 64 位十六进制设备标识，`oi` 是 `di` 的后 32 位。`devicecode` 是另外生成的 16 位十六进制字符串。

## 设备绑定

账号密码登录还绑定了 `di / oi / devicecode`。用随机设备标识登录真实账号会返回：

```json
{"status":-100,"error":1068,"errorMsg":"亲,用户名或密码错误哦 ..."}
```

用 APP 抓到的同一组 `di / oi / devicecode` 可以成功登录。工具把这三项保存在本地 `data/ewan-device.json`（可用 `CW_EWAN_DEVICE` 指向其他文件），不会提交到仓库。APP 重装或换设备后需要重新抓一份：

```json
{
  "di": "<64位十六进制>",
  "oi": "<di 后32位>",
  "deviceCode": "<16位十六进制>",
  "model": "Xiaomi M2102K1AC",
  "sysVersion": "12",
  "traceId": "<base64>"
}
```

## 工具实现

- `src/phone-login.mjs`：AES 加解密、设备档案、ewan 账号密码/短信验证码登录、游戏业务登录、凭证构造。
- CLI：`node src/app.mjs accounts login-phone`，支持 `--password`、`--code`、`--probe`、`--save`、`--connect`。
- 控制台：**账号 → 手机号登录**，支持账号密码和短信验证码；先“登录并预览”，显示 openId、游戏 uid 和是否匹配已有账号，确认后保存。
- 密码和验证码不落盘；待保存凭证只在内存保留 10 分钟。
- 发送验证码需要用户确认，同一手机号 60 秒内只发送一次。

## 限制与验证

1. **设备档案必须匹配 APP 安装。** 真实账号已用 APP 的设备档案登录成功；换成随机设备会返回 1068。工具默认读取 `data/ewan-device.json`，APP 重装或换设备后要重新导入。
2. **手机号关联多个账号时只取第一个。** 420012 可能返回多个 `userAccount`；工具目前直接用第一个账号的 `multiAccountToken` 完成 420007。如果进入的不是目标角色，请改用账号密码登录或在官方 APP 里选择账号。
3. **账号密码是明文进入 AES 的。** 工具不会保存密码，但流量和进程内存中能看到明文；只在本人设备上使用。
4. **小程序角色和 APP 角色可能不互通。** 社区绑定手机号只解决登录身份；如果角色没有迁移到 APP 服，登录后会是另一个角色。保存前核对 openId。
5. **登录会顶号。** 连接游戏可能让当前客户端掉线；`--connect` 需要显式加 `--yes`。
6. **不要用别人的账号测试。** 本项目只处理用户自己的账号。

## 复现命令

```powershell
$env:CW_PHONE='手机号或账号'
$env:CW_PHONE_PASSWORD='登录密码'

# 只登录并打印响应字段，不保存
node src/app.mjs accounts login-phone --probe

# 预览游戏 openId，不保存
node src/app.mjs accounts login-phone

# 确认 openId 是已有角色后保存并切换
node src/app.mjs accounts login-phone --save --yes

# 保存并连接验证（会让现有会话掉线）
node src/app.mjs accounts login-phone --save --yes --connect --yes
```
