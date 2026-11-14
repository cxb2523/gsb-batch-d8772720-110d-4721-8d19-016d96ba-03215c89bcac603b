# Disclaimer · 免责声明

> English first, 中文在后.

---

## English

**Prism** is provided for **learning, research and personal content analysis only.**

### Terms of use

- This project is **for study and reference only. Commercial use is prohibited.**
- Users are responsible for complying with the Terms of Service and `robots` rules of any target
  platform, as well as all applicable laws in their jurisdiction (including, where relevant,
  China's Cybersecurity Law, Data Security Law and PIPL).
- Users must keep request rates modest (a slow-by-default `compliance.RateLimiter` is built in)
  and **must not** use this project for large-scale scraping, commercial harvesting, or anything
  that places a burden on the target platform.
- **All consequences of use are the user's own. The project and its author accept no liability
  whatsoever for any legal consequences arising from use of this code.**
- Before you start, understand where the legal line sits. The community-maintained
  [list of Chinese web-scraping prosecutions](https://github.com/HiddenStrawberry/Crawler_Illegal_Cases_In_China)
  is a good primer.

### Scope boundary (important)

- Prism is an **analysis layer**. Its value is the universal 5-table schema and the
  cross-platform analytics built on top of it. Data may come from the bundled adapters — or from
  any external export (e.g. a CSV/JSON dump produced by a third-party crawler).
- **Prism does not implement, vendor or ship any anti-bot signature bypass, nor any
  circumvention of platform security measures.** Adapters target publicly reachable endpoints
  only. If a platform requires circumventing its protections to obtain data, that is explicitly
  out of scope.

### Data & privacy

- No personal sensitive data is stored or redistributed: user IDs are irreversibly salted-hashed
  before storage, and nickname / avatar / phone / IP fields are dropped (see `compliance.py`).
- Credentials (cookies, keys) must never be committed — `.gitignore` blocks them.
- All analysis runs locally; LLM-based analysis uses a user-configured local endpoint and uploads
  nothing to third parties.

### License

The code is MIT-licensed, but **responsibility for how the data is used does not transfer with
the code** — it stays with whoever runs the tool.

---

## 中文

本项目 **Prism** 仅供 **学习、研究与个人内容分析** 使用。

### 使用须知

- 本项目**仅供学习和参考之用，禁止用于商业用途**。
- 使用者应自行遵守目标平台（小红书 / B站 / 抖音 / 快手等）的服务条款与 `robots` 规则，以及
  《中华人民共和国网络安全法》《数据安全法》《个人信息保护法》等相关法律法规。
- 使用者须保持克制的访问频率（本项目内置 `compliance.RateLimiter` 慢速率限制），
  **不得用于大规模爬取、商业采集或任何对目标平台造成负担的行为**。
- 使用本项目产生的一切后果由使用者自行承担；**因使用本项目内容引起的任何法律责任，
  本项目及作者不承担任何责任。**
- 使用前请了解相关法律边界，可参考社区整理的
  [中国爬虫违法违规案例](https://github.com/HiddenStrawberry/Crawler_Illegal_Cases_In_China)。

### 技术边界（重要）

- Prism 的定位是**分析层**：核心价值在于通用五表 schema 与跨平台分析能力。
  数据来源可以是内置 adapter，也可以是任何外部导出（例如第三方采集器的 CSV / JSON）。
- **Prism 不实现、不分发、不内置任何反爬签名绕过或安全保护机制突破手段。**
  各 adapter 仅访问公开可达的接口。若某平台必须绕过其保护机制才能获取数据，
  则明确不在本项目范围内。

### 数据与隐私

- 本项目**不存储、不传播**用户个人敏感信息：入库前对用户 ID 做加盐不可逆哈希，
  并丢弃昵称 / 头像 / 手机号 / IP 等敏感字段（见 `compliance.py`）。
- cookies、密钥等凭证**严禁**提交版本库（已在 `.gitignore` 中拦截）。
- 所有分析在本地进行；AI 分析走用户自行配置的本地 LLM 端点，不上传任何第三方服务。

### 开源协议

代码以 MIT 协议开源，但 **数据使用的责任不随代码转移** —— 使用工具的人自负其责。
