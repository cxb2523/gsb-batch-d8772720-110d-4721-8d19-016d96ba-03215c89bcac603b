# copymanga-nasdownloader

![social-media](./assets/social-media.png)

<p align="center">
  <!--<a href="https://pypi.org/project/copymanga-downloader/" target="_blank"><img alt="PyPI - Version" src="https://img.shields.io/pypi/v/copymanga-downloader?style=for-the-badge&logo=PyPI"></a>-->
  <a href="https://github.com/misaka10843/copymanga-nasdownloader/graphs/contributors" target="_blank"><img alt="GitHub contributors" src="https://img.shields.io/github/contributors/misaka10843/copymanga-nasdownloader?style=for-the-badge&logo=github"></a>
  <a href="https://github.com/misaka10843/copymanga-nasdownloader/stargazers" target="_blank"><img alt="GitHub Repo stars" src="https://img.shields.io/github/stars/misaka10843/copymanga-nasdownloader?style=for-the-badge&label=%E2%AD%90STAR"></a>
</p>

## 前言💭

此仓库原先是[copymanga-downloader](https://github.com/misaka10843/copymanga-downloader)的重构版本，但是随着功能的更新已经逐渐与原先的仓库开发方向分道扬镳

之后会着重与多漫画源+自动化下载，当前WebUI已可以正常使用，并可以设定cron定时任务等功能

**非常非常非常不建议您每次运行时间间隔小于5天！！！！**

您需要注意的一点，为了尽可能不影响到相关站点，此程序并不会也永不会支持多线程处理，请多多支持对应站点，小站真的不容易

当前通知功能是按照[message-pusher](https://github.com/songquanpeng/message-pusher)的规范进行适配，可能并不会适配其他主流平台，请注意

## 当前支持站点

- [x] [copymanga](https://copymanga.com)
- [x] [泰拉记事社](https://terra-historicus.hypergryph.com)
- [x] [antbyw](https://www.antbyw.com)
- [x] [ガンガンONLINE](https://www.ganganonline.com/) (建议仅作为最新生肉漫画的免费下载)

## 如何使用

### 可选安装与按需加载

以本项目的订阅、顺序调度、通知和 CBZ 打包为统一入口。站点仅在处理对应订阅时加载；WebUI 获取表单时会读取各站点元数据，但 JM SDK 不会因此导入。
可选依赖采用 Python 标准 extras：

```bash
pip install .                 # 核心与 CopyManga、泰拉记事社
pip install ".[jm,yamibo]"    # 增加 JM 与 Yamibo
pip install ".[server,jm]"    # WebUI 与 JM
pip install ".[all]"         # 全部站点与 WebUI
cmnas                        # 检查并下载订阅
cmnas-server                 # 启动 WebUI，默认 8000 端口
```

另有 `antbyw`、`ganganonline`、`bilibili` extras。当前从本地源码安装；发布到 PyPI 后才可使用 `pip install "copymanga-nasdownloader[all]"`。
Docker 默认安装全部功能，可用 `--build-arg EXTRAS=server,jm,yamibo` 选择依赖。
WebUI 静态资源仍需构建到运行目录的 `spa_dist`，Docker 会自动构建。

JM 仅支持登录后同步自己的全部收藏夹，图片通过 jmcomic 解码。必须在系统设置填写账号、密码，可选 SDK option 文件路径，或使用 `CMNAS_JM_USERNAME`、`CMNAS_JM_PASSWORD`、`CMNAS_JM_OPTION_FILE`。不支持按任意专辑 ID 下载。
Yamibo 按关键词订阅漫画区搜索结果，抓取主楼图片附件，需要 `CMNAS_YAMIBO_COOKIE`，`CMNAS_YAMIBO_DELAY` 默认 4 秒且至少 3 秒；也可在系统设置填写。关键词应足够精确，以免下载同名作品。

在 `CMNAS_DATA_PATH/updater.json` 中添加：

```json
{
  "jm": [{"mode": "favorites", "name": "JM 收藏夹"}],
  "yamibo": [{"keyword": "精确作品关键词", "name": "作品名称", "latest_chapter": "", "last_download_date": ""}]
}
```

JM 在 `CMNAS_DATA_PATH/jm.sqlite` 保存按账号隔离的历史作品、当前收藏状态、作品元数据、章节打包状态和专辑完成状态。每次完整扫描所有收藏页，再按作品 ID 与历史库比较，不依赖最新 ID 或列表顺序。取消收藏不删除历史或文件；已发现但未完成的作品会继续重试，已完成作品重新收藏不重复下载。只有整次收藏扫描成功才提交快照，登录或分页失败不会清空状态。请持久化并备份该数据库，Docker 的 `/data` 挂载已覆盖它。
已完成专辑默认跳过详情请求，与原 jm-downloader 行为一致；不检测已完成专辑后来新增的章节。不同专辑的输出目录包含 JM ID，避免同名覆盖。多个账号的进度隔离，密码不写入数据库。
Yamibo 的 `latest_chapter` 保存帖子 ID，留空首次下载全部匹配项；仅完整下载并成功打包后推进，失败章节保留原图并在下次重试。以帖子 ID 升序处理新帖子，不检测旧帖编辑或回复附件。
旧 JM SQLite 库采用不同表结构，本次不自动迁移；使用独立 `jm.sqlite`，首次运行会下载全部历史未知收藏。作者监听和交互搜索仍保留在原项目中。

### 使用webUI/docker

如果您需要使用WebUI或者docker，请确保创建了`.env`文件

如果您想直接从代码库中运行WebUI，请确保运行了`frontend`中的前端文件以及运行`python3 server.py`

#### docker compose部署

```yml
version: '3.8'

services:
  cmnas:
    image: ghcr.io/misaka10843/copymanga-nasdownloader:latest
    # 如果是国内网络请注释上方的代码，然后将下方代码的#删除掉
    #image: ghcr.nju.edu.cn/misaka10843/copymanga-nasdownloader:latest
    container_name: cmnas
    restart: unless-stopped
    ports:
      - "8000:8000"  # Web 访问端口
    volumes:
      # 映射数据目录 (配置文件、日志)
      - ./data:/data
      # 映射下载目录 (临时下载文件)
      - ./downloads:/downloads
      # 映射 CBZ 输出目录 (最终打包文件)
      - ./cbz:/cbz
    environment:
      # --- 基础配置 ---
      - CMNAS_LOG_LEVEL=INFO

      # --- Copymanga 账号配置 ---
      # 如果你的 config.py 优先读取环境变量，填在这里
      - CMNAS_CM_USERNAME=your_username
      - CMNAS_CM_PASSWORD=your_password

      # --- 代理配置 ---
      # 注意：如果使用本机代理，在Docker中可能需要写 http://host.docker.internal:7890
      - CMNAS_CM_PROXY=

      # --- API URL ---
      - CMNAS_API_URL=https://api.mangacopy.com

      # --- 行为配置 ---
      # 是否使用copymanga原名 (True/False)
      - CMNAS_USE_CM_CNAME=False
```

将上方的内容保存到`docker-compose.yml`中，然后运行`docker compose up -d`即可部署完成

---

在部署完成之后您可以打开url然后访问WebUI

在WebUI中允许直接配置所有当前插件的配置文件以及支持定时运行更新任务，以及直接编辑`updater.json`
![img.png](.github/assets/img.png)
![img_1.png](.github/assets/img_1.png)
![img_2.png](.github/assets/img_2.png)

### 普通命令行使用

本仓库是为了nas系统下载而进行优化，所以下载器本身并没有任何的交互/配置界面

下载器的配置是通过环境变量进行设置，更新列表是通过json进行设置

在运行下载器之前请确保bash的目录在程序目录下

#### 配置下载器

请将本仓库中的`.env.sample`更名为`.env`放在cmd的运行目录下

其中各个变量的内容如下

```dotenv
CMNAS_TOKEN= # token填写，必须登录，否则会无法请求其章节详细
CMNAS_DOWNLOAD_PATH= # 下载路径(暂存路径，将在cbz打包完成后删除)(字符串)
CMNAS_CBZ_PATH= # CBZ存放路径(字符串)
CMNAS_DATA_PATH= # 配置文件相关存放路径(字符串)
CMNAS_USE_CM_CNAME= # 是否使用copymanga的章节名，如果不使用将按照kavita的格式进行命名(True/False)
CMNAS_API_URL= # API服务器地址(字符串)
CMNAS_LOG_LEVEL= # 日志等级(DEBUG,INFO,WARNING,ERROR)
CMNAS_CM_USERNAME= # copymanga 账户名称
CMNAS_CM_PASSWORD= # copymanga 密码
CMNAS_CM_PROXY= # copymanga 使用的代理
```

#### 配置更新列表

当前只能自行进行配置(之后会做一个web界面进行配置管理)

请在`CMNAS_DATA_PATH`的目录下创建`updater.json`

##### copymanga

其中内部的结构如下：

```json
{
  "copymanga": [
    {
      "name": "漫画名称(指定保存的系列名/文件夹名)",
      "ep_pattern": "重命名的话数的正则提取，默认可以为空",
      "vol_pattern": "重命名的卷数的正则提取，默认可以为空",
      "path_word": "copymanga的path_word",
      "group_word": "copymanga的group_word，默认为default",
      "latest_chapter": "最后下载的章节，可以用来限制下载范围(为空则直接下载所有的内容)",
      "last_download_date": "最后下载章节的完成日期"
    },
    {
      "name": "漫画名称(指定保存的系列名/文件夹名)",
      "ep_pattern": "重命名的话数的正则提取，默认可以为空",
      "vol_pattern": "重命名的卷数的正则提取，默认可以为空",
      "path_word": "copymanga的path_word",
      "group_word": "copymanga的group_word，默认为default",
      "latest_chapter": "最后下载的章节，可以用来限制下载范围(为空则直接下载所有的内容)",
      "last_download_date": "最后下载章节的完成日期"
    }
  ]
}
```

示例如下

````json
{
  "copymanga": [
    {
      "name": "白圣女与黑牧师",
      "ep_pattern": "连载版(\\d+\\.?\\d*)",
      "vol_pattern": "",
      "path_word": "baishengnvyuheimushi",
      "group_word": "default",
      "latest_chapter": "连载版02",
      "last_download_date": "2025-04-05T20:58:29.386183"
    },
    {
      "name": "静音酱今天也睡不着觉",
      "ep_pattern": "",
      "vol_pattern": "",
      "path_word": "jinyingjiangjintianyeshuibuzhaojiao",
      "group_word": "default",
      "latest_chapter": "",
      "last_download_date": ""
    }
  ]
}
````

##### 泰拉记事社

对于漫画ID获取可以直接前往官网点击任何一个漫画例如 `https://terra-historicus.hypergryph.com/comic/6253` 中的 `6253`
就是漫画ID

配置结构如下

```json
{
  "terra_historicus": [
    {
      "name": "漫画名称",
      "comic_id": 漫画id(数字),
      "latest_chapter": "最后下载的章节，可以用来限制下载范围(为空则直接下载所有的内容)",
      "last_download_date": "最后下载章节的完成日期"
    }
  ]
}
```

示例如下

```json
{
  "terra_historicus": [
    {
      "name": "暮岁闲谈：这是平凡人生",
      "comic_id": 4579,
      "last_download_date": "2025-07-30T15:17:12.854869",
      "latest_chapter": "这是平凡人生"
    }
  ]
}
```

##### antbyw

对于漫画ID获取可以直接前往官网点击任何一个漫画例如
`https://www.antbyw.com/plugin.php?id=jameson_manhua&a=read&kuid=196880` 中的 `196880`（kuid的值）
就是漫画ID

配置结构如下

```json
{
  "antbyw": [
    {
      "comic_id": "漫画ID",
      "name": "漫画名称",
      "group_word": "单话/单行本/番外篇",
      "last_download_date": "",
      "latest_chapter": ""
    }
  ]
}
```

示例如下

```json
{
  "antbyw": [
    {
      "comic_id": "196880",
      "name": "放学后的迷宫冒险者们",
      "group_word": "单话",
      "last_download_date": "",
      "latest_chapter": ""
    }
  ]
}
```

如果需要下载两个及以上的站点可以通过下方结构配置

```json
{
  "copymanga": [
    {
      "name": "白圣女与黑牧师",
      "ep_pattern": "连载版(\\d+\\.?\\d*)",
      "vol_pattern": "",
      "path_word": "baishengnvyuheimushi",
      "group_word": "default",
      "latest_chapter": "连载版02",
      "last_download_date": "2025-04-05T20:58:29.386183"
    }
  ],
  "terra_historicus": [
    {
      "name": "暮岁闲谈：这是平凡人生",
      "comic_id": 4579,
      "last_download_date": "2025-07-30T15:17:12.854869",
      "latest_chapter": "这是平凡人生"
    }
  ]
}
```

在配置完成之后直接运行程序即可

## 如何开发其他站点

`copymanga-nasdownloader` 采用模块化设计，增加新站点支持需要遵循以下步骤。

(如果不会可以看当前已有的站点)

### 核心流程

1. **定义 Updater**: 在 `updater/` 目录下创建站点更新器，负责获取章节列表和对比本地记录。
2. **定义 Plugin**: 在 `plugins/` 目录下创建站点插件，负责解析具体章节的图片 URL 并下载。
3. **注册站点**: 在 `updater/updater.py` 和 `dispatcher.py` 中注册新站点的映射关系。

### 开发步骤

#### 第一步：创建更新器 (Updater)

在 `updater/your_site.py` 中继承 `BaseUpdater`：

* `get_chapters()`: 调用 API 或爬取网页，返回包含章节名称和 ID 的列表。
* `find_subsequent_uuids()`: 根据 `updater.json` 中的 `latest_chapter` 过滤出需要下载的新章节 ID。
* `create_download_task()`: 构造传递给插件的任务字典。

#### 第二步：创建下载插件 (Plugin)

在 `plugins/your_site/main.py` 中实现：

* `download_batch(tasks)`: 插件的入口点。
* `download_chapter()`: 处理单章逻辑。
* 调用 `downloader.downloader` 下载图片。
* 下载完成后调用 `downloader.postprocess` 进行 CBZ 打包。

#### 第三步：配置与注册

1. **环境变量**: 如需特殊配置（如 Cookie/Token），在 `utils/config.py` 和 `.env.sample` 中添加。
2. **映射注册**:

* `updater/updater.py` -> `SITE_MAPPING`
* `dispatcher.py` -> `SITE_MODULES`
