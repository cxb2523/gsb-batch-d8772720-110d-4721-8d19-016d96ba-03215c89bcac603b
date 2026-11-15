# GLOSSARY — 抖音「钢材分条」参考片的逆向与复刻方法论

> 阶段 3 产出。由 candidates/glossary.md（阶段 1 术语提取器，20 条）整理提升；其中 g09、g14 两条经阶段 1.5 判为待核查（见 needs-review.md），已在对应条目尾部标注。

- id: g01
  term: 结构复刻
  type: term
  source_chapter: 全书主旨 / BOOK_OVERVIEW L22、L46；source.md L397（第 3 部分·经验 2）、L395–L398
  author_definition: |
    "同作者所有视频都是同一模板：实拍 + 左上黄字两行标题 + 底部黄字字幕 + BGM；复刻复制的是结构不是画面。"（source.md L397）
    术语表定义："复制切镜节奏 + 版式坐标 + 声音配方，不复制画面内容。"（BOOK_OVERVIEW L46）
  key_distinction: |
    ≠ 常识"复刻" = 尽量做成一模一样（画面、素材、文案全都要同）
    ≠ 逐帧模仿/像素级还原画面内容
    = 只复制三样：切镜节奏（几刀、什么时候切）、版式坐标（标题/字幕位置、颜色语义）、声音配方（BGM 节拍 + 音效摆放）；素材可换，坐标与颜色语义不可换
  why_it_matters: |
    复刻类 skill 若按字典义理解"复刻"，会要求保留原画面/原素材、追求视觉一模一样，方向全错。
    本书的验收比对的是坐标与节奏（成片帧 vs 参考帧逐项对坐标、配色、亮度），不是画面相似度。
  tags: [term, core-concept, remake]

- id: g02
  term: 包装层（剪辑包装层 / 叠加层）
  type: term
  source_chapter: source.md L111「## 剪辑包装层（字幕 / 花字 / 贴纸 / 音效卡点）」；L10 结论行"叠加层"；L163–L165 分镜表"叠加层"列；BOOK_OVERVIEW L26、L47
  author_definition: |
    "剪辑包装层（字幕 / 花字 / 贴纸 / 音效卡点）"（L111 章节标题）
    "叠加层：花字、字幕、标题（代码/剪辑软件合成）"（L10）
    导出物："`packaging/subtitles.srt`、`packaging/overlays.ass`、`packaging/timeline.json`"（L119）
  key_distinction: |
    ≠ 常识"字幕"（只指台词字）
    ≠ 底层画面（实拍 100%，L19–L21 的 mix 表）
    = 字幕 + 花字 + 标题 + 文字标注 + 贴纸 + 卡在它们出现上的音效，与画面分离、可单独叠加/单独导出（ASS/SRT/timeline.json）的一层
  why_it_matters: |
    拆解与复刻 skill 必须把视频切成"底层画面 / 包装层"两条轨：包装层可重做（ffmpeg -vf ass 压制或按 timeline 重建），底层画面只能重拍或换素材。
    混淆会导致把字幕当画面的一部分去"复刻像素"，或者把可重建的包装当成不可动的素材。
  tags: [term, packaging, core-concept]

- id: g03
  term: 一刀（刀）
  type: term
  source_chapter: source.md L78、L87"剪辑：每分钟 0.0 刀"；L393"全片 1 刀（单镜头）"；BOOK_OVERVIEW L22、L48
  author_definition: |
    "全片 1 刀（单镜头）、无口播、BGM 145.6BPM + 5 处音效"（L393）
    "剪辑：每分钟 0.0 刀，实拍镜头平均 13.5s；机位/场景 1 个"（L78/L87）
  key_distinction: |
    ≠ 剪辑动作词"剪一刀"（一次剪切操作）
    = 量化单位：一刀 = scene 检测切点之间的一个连续镜头；用"刀/分钟""几刀"统计切镜密度
    （BOOK_OVERVIEW L48 原话："剪辑行话'一刀'含义相同，但这里用作量化单位（刀/分钟）"）
  why_it_matters: |
    节奏类 skill 要输出可计算的"刀/分钟"指标来描述节奏结构；把"一刀"当动作词就无法统计切镜密度，
    三种节奏结构（单镜头/等距卡点/前长后短）也就无法量化比较。
  tags: [term, metric, rhythm]

- id: g04
  term: 像素级实测（版式实测）
  type: term
  source_chapter: source.md L387 标题「# 附：本机像素级实测与工作流落地」（= measured.md L1）；L390–L393；BOOK_OVERVIEW L26、L49、L106（task-02）
  author_definition: |
    "版式实测（720×1280 坐标系）：顶部标题：左对齐两行，x≈90（12.5%），y≈205–340（16–27%），黄字 #FFD700 + 黑描边，字号≈58。
    底部字幕：居中，y≈940–1050（73–82%），黄字黑边，逐句切换。"（L390–L392）
    术语表："逐帧扫像素求 bbox/色值/字高，而不是看图估。"（BOOK_OVERVIEW L49）
  key_distinction: |
    ≠ 目测/看图估版式（task-02 依据："肉眼估会偏 10%+"）
    ≠ rea-video 的工具拆解（工具给"是什么"，实测给"怎么摆"，BOOK_OVERVIEW L26）
    = 逐帧扫像素得到坐标/色值/字高，结论以"像素值 + 百分比"双写，可直接进规格书
  why_it_matters: |
    版式类 skill 的取数必须来自扫像素而非截图目测，否则产出的是"大概放左上角"这种无法验收的指令。
    逆向分两轮的第二轮就是它，跳过它成片会不像。
  tags: [term, measurement, core-concept]

- id: g05
  term: 烧录字
  type: term
  source_chapter: source.md L398（第 3 部分·经验 3）；measured.md L12；BOOK_OVERVIEW L29、L50
  author_definition: |
    "素材几乎都带烧录字，组装前要挑无字片段或换素材。"（L398）
    BOOK_OVERVIEW L29："素材带烧录字是常态，组装前要挑干净片段。"
  key_distinction: |
    ≠ 外挂字幕/软字幕（可单独关掉、可导出 overlays.ass 再压）
    ≠ 画面里物体上本来就有的字（L184"画面里物体上的字（不是后期字幕）：40、e"）
    = 烧进画面像素的后期文字，无法单独移除，只能挑无字片段或换素材
  why_it_matters: |
    素材准备 skill 若把带烧录字的素材当干净素材用，成片会出现双份字幕（原片烧录字 + 自己压的字幕）。
    正确动作是先挑干净片段，这是组装前的硬前置。
  tags: [term, asset, packaging]

- id: g06
  term: 花字
  type: term
  source_chapter: source.md L10、L114、L117–L118、L128–L129、L136–L139
  author_definition: |
    "花字 2 处（字号大、倾斜、多色/渐变）：「合澜」、「Vailifteaa」"（L114）
    "按台词定位 2 处（换文案时跟着这句话走，不按原秒数放）：花字「合澜」 → 「匆匆八月…」开始后 1.0s"（L118）
  key_distinction: |
    ≠ 字幕（底部逐句台词，黄字黑边）
    ≠ 标题（顶部两行，黄字黑描边）
    ≠ 文字标注（跟随物体的小字，如「40」「福」）
    = 大字号、倾斜、多色/渐变的强调文字；且定位规则特殊——按台词锚定偏移，不按绝对秒数
  why_it_matters: |
    包装层四类文字（字幕/花字/标题/文字标注）定位规则各不相同：字幕逐句切、花字跟台词锚偏移、标注跟物体移动。
    混为一类会在换文案后元素错位——这是复刻 skill 换文案场景下的高频错误点。
  tags: [term, packaging, text-layer]

- id: g07
  term: 音效卡点
  type: term
  source_chapter: source.md L10"4 个音效卡在文字/贴纸出现上"；L117"音效卡点：花字出现 2 处、标题出现 1 处、文字标注出现 1 处"；L67
  author_definition: |
    "音效卡点：花字出现 2 处、标题出现 1 处、文字标注出现 1 处"（L117）
    "复刻：按时间点摆放：capsule-cinema SoundEffectsTool / 音效库，或像 plush 配方那样程序合成（音高对齐 BGM 调性）"（L67）
  key_distinction: |
    ≠ BGM 卡点（音乐节拍对齐切镜，见 g08）
    = 音效对齐**包装层元素的出现时刻**（whoosh/pop 落在花字/标题/文字标注出现的那一帧）
  why_it_matters: |
    声音复刻 skill 必须区分两类卡点：音效跟文字出现走，BGM 跟切点/节拍走。
    混淆会把 whoosh 摆到切镜上，节奏立刻不像。
  tags: [term, audio, packaging]

- id: g08
  term: 卡点（等距卡点 / 单点卡点 / 卡点蒙太奇）
  type: term
  source_chapter: source.md L249"一段 0.5 秒等距卡点"；L258"每 0.5 s 一切 → 明确卡点蒙太奇"；L374"Lindsay 单点卡点"；L341–L342（模板名"卡点变装"）
  author_definition: |
    "内部 27.03/27.53/28.03/28.53/29.03/29.53 每 0.5 s 一切 → 明确卡点蒙太奇"（L258）
    "Lindsay | 两个长镜（7 s / 12 s） | 4 s 的 0.5 s 等距卡点 | 讲解段不切，只在一处做密集蒙太奇"（L281）
  key_distinction: |
    ≠ 音效卡点（g07，音效对齐文字出现）
    = 按固定节拍间隔**切镜**：等距卡点（每 0.5s 一切）与单点卡点（全片只在一处做密集蒙太奇）
    同词两用是本书的语境事实，读到"卡点"先判断指切镜还是指音效
  why_it_matters: |
    节奏 skill 输出"卡点"时若不说明是节拍切镜还是音效对齐文字，复刻动作会完全相反。
  tags: [term, rhythm, audio]

- id: g09
  term: 三种节奏结构
  type: term
  source_chapter: source.md L276–L284「三种节奏结构 = 三种"可复刻的行为"」；L374；BOOK_OVERVIEW L27
  author_definition: |
    "AI小凯 | 全程 2 s 快切 | — | 数字人口播 + 画面每 2 s 换一次，节奏由**句读**驱动"
    "Lindsay | 两个长镜（7 s / 12 s） | 4 s 的 0.5 s 等距卡点 | 讲解段不切，**只在一处**做密集蒙太奇"
    "Scrapling | 16.4 s 一镜到底 | 切成 2–3 s 段 | 前段是纯口播/整页录屏，**演示段才切**"（L278–L282）
    "这是复刻时最该保留的东西——不是画面内容，是'什么时候切、切多密'与口播语义的关系。"（L284）
  key_distinction: |
    ≠ 泛泛的"节奏快/慢"主观描述
    = 三种离散可选模板：①单镜头（一镜到底）②长镜 + 单点卡点 ③前长后短
    判断依据是切镜密度与口播语义的关系（句读驱动 / 只在一处爆发 / 演示段才切），不是绝对时长
  why_it_matters: |
    复刻 skill 的核心交付是三选一并按口播语义排切点（引 hypit 原话 "Cue boundaries are author intent"）。
    只给"加快剪辑"这类泛建议就丢掉了作者认定最该保留的东西。
  tags: [term, rhythm, core-concept]

- id: g10
  term: scene 阈值
  type: term
  source_chapter: source.md L228「### 镜头切分（ffmpeg scene 阈值 0.22）」及 L230–L274 三张段表；BOOK_OVERVIEW L48
  author_definition: |
    "镜头切分（ffmpeg scene 阈值 0.22）"（L228）——三条参考片的全部段表（12 段 / 7 段 / 10 段）、
    "平均 2.15 s/镜"（L247）、刀数统计都在这个阈值下得到。
  key_distinction: |
    ≠ 可忽略的工具默认值（换个阈值，段表、平均时长、刀数全变）
    = 本书切分口径的固定参数 0.22，是"一刀"边界的判定标准；引用任何节奏数字都必须连同它一起引用
  why_it_matters: |
    下游 skill 引用刀数/节奏指标时不带阈值口径，数据就不可比、不可复跑。
    复刻比对时若用不同阈值重切参考片，节奏结构会对不上。
  tags: [term, metric, tool-param]

- id: g11
  term: play_addr
  type: term
  source_chapter: source.md L398（经验 3）；measured.md L12；BOOK_OVERVIEW L29、L90（task-04）
  author_definition: |
    "抖音无水印原片提取走 web aweme/detail 接口（页面内 X-Bogus 签名），play_addr 为无水印流。"（L398）
  key_distinction: |
    ≠ 视频页面上看到的播放地址 / 带水印的转码流
    ≠ 角标、水印清理（"全部无水印、无角标"是提取后的结果，L226）
    = aweme/detail 接口返回中代表**无水印原始视频流**的字段，是提取干净原片的取数点
  why_it_matters: |
    素材提取 skill 的核心字段。取错成页面播放地址会拿到带水印/带角标的流，
    后续像素实测的色值与版式统计、组装的素材全部被污染。
  tags: [term, douyin, asset]

- id: g12
  term: X-Bogus（页面内签名）
  type: term
  source_chapter: source.md L398；measured.md L12；BOOK_OVERVIEW L29"页面内签名"
  author_definition: |
    "抖音无水印原片提取走 web aweme/detail 接口（页面内 X-Bogus 签名）"（L398）
    BOOK_OVERVIEW L29："抖音无水印原片走 web aweme/detail 页面内签名"
  key_distinction: |
    ≠ 登录态 cookie / 服务端 token
    = 抖音 web 端在页面上下文里**现算**的请求签名参数；"页面内"是关键词——签名依赖页面执行环境
  why_it_matters: |
    素材提取 skill 若裸调 aweme/detail 而不带页面内签名会失败；流程必须先进页面上下文取签名再发请求。
    词表/接口文档里不会告诉你"页面内"这个前置条件。
  tags: [term, douyin, api-signature]

- id: g13
  term: breakdown.json
  type: term
  source_chapter: source.md L207"完整数据在 breakdown.json"；L105（task-01 交付物 breakdown/report，BOOK_OVERVIEW）
  author_definition: |
    "完整数据在 `breakdown.json`；agent 用 `rea-video summary` 读紧凑版。"（L207）
    "每个镜头的证据、概率、文字轨和提示词"（L177，附录·逐镜取证的内容即来自它）
  key_distinction: |
    ≠ 拆解报告 md 本身（source.md 第一部分是它的渲染给人看的摘要）
    ≠ storyboard.jpg / audio.png（只是插图）
    = rea-video 的**全量结构化输出**；三层读取路径：breakdown.json（全量）→ `rea-video summary`（agent 紧凑版）→ 报告 md（人读）
  why_it_matters: |
    取证 skill 取数要选对层：读报告 md 会丢字段（逐镜概率、文字轨、证据等级），
    直接读 breakdown.json 又可能超出 agent 上下文——作者已给出 summary 这条中间路径。
  tags: [term, artifact, rea-video]

- id: g14
  term: SVML
  type: term
  source_chapter: source.md L374"写第一份 SVML"（全书唯一出现处，第四部分·下一步清单第 3 步）
  author_definition: |
    "**写第一份 SVML**：只做 30 秒（沿用 vibe 的做法：先 30 秒样片，过三问再铺全片），Script 直接用转写里的词，
    保留上面分析出的**切点节奏**（AI小凯 2 s / Lindsay 单点卡点 / Scrapling 前长后短）"（L374）
  key_distinction: |
    ≠ 成片 mp4 / 视频文件（渲染结果）
    ≠ 转写 transcript.json（它的输入锚）
    = hypit 编排层里 Script 的落地产物：用词级转写当锚写的可重跑编排脚本；推进节奏是"先 30 秒样片，过三问再铺全片"
    （待核查：书内未展开 SVML 语法，仅此一处，语法规则需查 hypit 自有文档）
  why_it_matters: |
    出片 skill 的中间交付物是这份脚本而不是 mp4；"先 30 秒"是作者明确的成本控制动作，
    跳过直接渲全片会浪费整片渲染成本且问题在最后才暴露。
  tags: [term, artifact, hypit, core-concept]

- id: g15
  term: 词级锚定（词级时间戳）
  type: term
  source_chapter: source.md L352"逐字锚定 + 精确字幕"、"词级时间戳，hypit 的 Script 语法就建在这上面"；L373"这是写 Script 的锚"；L361
  author_definition: |
    "得到带词级时间戳的转写，这是写 Script 的锚"（L373）
    分工表："要'逐字锚定 + 精确字幕' → hypit + WhisperX：词级时间戳，hypit 的 Script 语法就建在这上面"（L352）
    "hypit → 编排层：Script（词级锚定）→ 时间轴 → 组件 → 渲染 → studio 改"（L361）
  key_distinction: |
    ≠ 句级字幕（SRT 逐句时间轴，packaging/subtitles.srt）
    = 每个**词**都有时间戳（WhisperX 中文对齐权重产出），动画/切点/文字入场按词对齐
  why_it_matters: |
    时间轴 skill 若只有句级时间戳，"花字在台词开始后 1.0s"（L118）这类锚定落不到位。
    词级转写是写 Script 的前置条件（下一步清单第 2 步），顺序不能颠倒。
  tags: [term, pipeline, whisperx]

- id: g16
  term: 确定性取证（deterministic）
  type: term
  source_chapter: source.md L13"判定方式：仅确定性取证"；L61 `deterministic_anchored`；L183"（deterministic）"；L205
  author_definition: |
    "确定性取证对「是否在动、是否整图推拉、是否渲染纹理、是否 24→30 帧率转换」很可靠；
    对实拍 / AI / 3D 的区分要依赖 VLM 与人工复核。"（L205）
    "判断置信度（按时长加权）60%；判定方式：仅确定性取证；未开 VLM……可信度有限"（L13）
  key_distinction: |
    ≠ 完整可信的结论（"实拍 59%"也只是像素统计概率，L183；"仅确定性取证"在报告里是降级标记）
    = 可复算的像素/信号统计证据，只在它擅长的问题上可靠（动/静、推拉、纹理、帧率转换）
    证据等级还分"信号候选（低置信）"与 `deterministic_anchored`（L56–L63 音效表）
  why_it_matters: |
    拆解 skill 输出必须带证据等级（确定性 / 信号候选 / 待确认），把低置信概率当结论用会误导下游——
    例如把"实拍 60%"当实拍就省掉重拍环节，成片直接错。
  tags: [term, evidence, core-concept]

- id: g17
  term: 模板（同作者模板 vs MUSE AV 视频模板）
  type: term
  source_chapter: source.md L397（参考片模板）与 L337–L350（MUSE AV 模板）；BOOK_OVERVIEW L28、L76
  author_definition: |
    参考片模板："同作者所有视频都是同一模板：实拍 + 左上黄字两行标题 + 底部黄字字幕 + BGM；复刻复制的是结构不是画面。"（L397）
    生产模板："MUSE AV 中台本身就是一个模板化的出图出视频平台：94 个技能模板……29 个视频模板"（L335–L338）
    "MUSE AV 视频模板（知识科普动画 / 卡点变装）| 填字段就出片，无本地环境依赖"（L350）
  key_distinction: |
    ≠ 一般说的"剪映模板"（一键套用的成片样式）
    本书"模板"是**两个不同的东西**：
    ① 参考片模板 = 从某作者所有视频归纳出的结构配方（画面形式 + 版式 + 声音），是复刻的**提取对象**
    ② MUSE AV 视频模板 = 中台里填字段就出片的生产资源（如 `知识科普动画` 字段 topic/facts/style/hook/title），是出片的**调用对象**
  why_it_matters: |
    同词两义：复刻 skill 说"提取模板"指①，出片 skill 说"用模板"指②。
    不拆开会把"归纳参考片模板"误执行成"去中台挑一个模板"，两者产出物完全不同。
    BOOK_OVERVIEW L76 还标注了①的边界："假设同作者所有视频共用同一模板（样本内成立，全站未验证）"。
  tags: [term, ambiguous, core-concept]

- id: g18
  term: hypit
  type: term
  source_chapter: source.md L212–L382（第 2 部分·结构分析与 hypit 落地路径）；L396（描边经验）；BOOK_OVERVIEW L57、L68
  author_definition: |
    "要'复刻这条参考片'的工作流 → hypit：唯一能产出**可编辑、可重跑、可批量变体**的 production"（L351）
    "hypit 的 `media` 命令零依赖：不需要 runtime profile、不需要凭据、不需要装任何 provider，就能把原片拆成帧网格/单帧/突变点候选"（L303–L305）
    "hypit 文字描边是「双倍宽度 + 后写 Fill 盖内半边」，Stroke 必须写在 Fill 前面，写反整字变描边色。"（L396）
  key_distinction: |
    ≠ 生成模型/出图出视频服务（那是 MUSE AV 中台）
    ≠ 参考片拆解工具（那是 rea-video）
    = 本地**编排层**：Script（词级锚定）→ 时间轴 → 组件 → 渲染 → studio 改；`media` 子命令零依赖可先行拆片
    附带的硬约束（作者记录）：Apache-2.0 **+ 附加条件**（多租户 SaaS/去 LOGO 需商业授权，L380）；成本 $1.07–1.15/条全在模型 API（L382）
  why_it_matters: |
    出片流水线 skill 的分工、许可证边界、以及"描边 Stroke 必须写在 Fill 前面"这个成败级细节都挂在 hypit 上。
    把 hypit 当生成服务用会走错整条链路；漏掉描边顺序坑会导致整字变描边色。
  tags: [tool, hypit, core-concept]

- id: g19
  term: rea-video
  type: term
  source_chapter: source.md L3、L13、L169、L177、L205–L207（第 1 部分·视频拆解报告）；BOOK_OVERVIEW L8、L95
  author_definition: |
    "来源：本机 rea-video 拆解报告、结构分析笔记、像素实测记录"（L3）
    "能看图的 agent：运行 rea-video review 逐镜看图并 apply-review 并入"（L13）
    "agent 用 `rea-video summary` 读紧凑版"（L207）
    VLM 接入方式："设置 REA_VLM_BASE_URL、REA_VLM_API_KEY、REA_VLM_MODEL……再加 --vlm 重跑"（L13/L169）
  key_distinction: |
    ≠ 视频播放/剪辑/压制工具（ffmpeg 才做压制）
    = 参考片逆向**第一轮（工具拆解）**的取证 CLI：产出镜头/画面来源/包装层/声音统计 + breakdown.json，
      子命令 review（逐镜看图）/ apply-review（并入复核）/ summary（紧凑版）/--vlm（接多模态复核）
    能力边界（L205）：确定性取证可靠，实拍/AI/3D 区分要 VLM 或人工复核
  why_it_matters: |
    取证 skill 的入口工具。必须知道它的能力边界与三层输出（breakdown.json / summary / 报告 md），
    否则会把"未开 VLM 的低置信判断"当成权威结论，或在需要语义判断时硬用像素统计。
  tags: [tool, rea-video, core-concept]

- id: g20
  term: 分镜（分镜表 / storyboard JSON）
  type: term
  source_chapter: source.md L161–L165「## 分镜表」、L23 `storyboard.jpg`；BOOK_OVERVIEW L30、L91（task-05）
  author_definition: |
    分镜表列头："`# | 时间 | 时长 | 底层画面 | 素材来源 | 叠加层 | 运镜 | 画面 | 复刻`"（L163）
    出片链路："分镜 JSON → 模板渲染 → 编译期校验 → 本地渲染 → 导出成片 + 文案"（BOOK_OVERVIEW L30）
    表内样例："| 1 | 00:00.000 | 13.50s | 实拍 60% | 用户真实素材… | 字幕、标题、花字 | 平滑运镜 | — | 实拍 · S1 |"（L165）
  key_distinction: |
    ≠ 拍摄前的手绘/文字分镜头脚本（创作概念）
    = 结构分析的**结构化产物兼流水线输入**：一行一个镜头，字段含叠加层与复刻方式，可直接进编译期校验
    其中"复刻"列的取值（实拍 · S1）与拍摄场次编号（S1，L151）对应
  why_it_matters: |
    出片 skill 的契约就是这份 JSON：上游（逆向/结构提取）写它，下游（渲染）读它。
    字段口径（叠加层列、复刻列）必须与逆向输出对齐，改字段名会直接断链。
  tags: [term, artifact, pipeline, core-concept]