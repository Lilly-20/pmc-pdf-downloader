# 📚 PMC 全文批量下载器

> **⚠️ 这是源代码仓库，不是软件本身。**
> - **普通用户**：直接去 [**Releases 页面**](../../releases) 下载对应平台的可执行文件（例如 Windows: `PMC-PDF-Downloader.exe`），双击或在终端运行即可，零依赖。
> - **开发者 / 想自己改代码**：装 Node.js 22+，在本目录下 `npm install`，再往下看。

一个本地运行的小工具：粘贴文献列表，自动从 **PMC（PubMed Central）** 批量下载**有免费全文**的文献 PDF，按「第一作者 年份 - 标题」自动命名，直接拖进 Zotero 即可。

专为以下场景设计：机构没有外文数据库订阅、Zotero「查找可用 PDF」失灵、浏览器插件装不了。

## 🤔 为什么 Release 里下载，不直接放在 git 里？

exe 单文件 57 MB，二进制文件 git 没法 diff/merge、克隆时会一并拉下来，仓库会臃肿到几百兆。这是开源项目的业界标准做法，VSCode / Chrome / Python 都是这样：**源代码进 git，构建产物走 Release**。

## ✨ 特性

- 支持三种编号：**PMID**（如 `42670262`）、**PMCID**（如 `PMC13527554`）、**DOI**（如 `10.1002/sim.70722`）
- **整段粘贴参考文献表即可**：从 Zotero「由所选条目创建参考文献表」复制的任意格式引文，直接粘进输入框，自动提取其中全部 DOI，自动去重、自动忽略作者名/年份/页码等干扰信息
- 自动解析元数据并按 `作者 年份 - 标题.pdf` 命名，与 Zotero 命名习惯一致
- 自动通过 PMC 的 PoW（工作量证明）下载挑战
- 限流自动重试 + 请求间隔，对 NCBI / EBI 服务器友好
- **断点续传**：已下载的文件自动跳过（按文件名匹配），中断后再跑一遍无需手动筛选没下完的
- **保存位置记忆**：自动记住上次用过的保存路径，下次打开自动填充；输入框下拉可切换历史路径
- **强制覆盖**：勾选后可重新下载更新版的 PDF；不勾则默认跳过已下载同名文件
- 无免费版的文献单独汇总列出（提示走文献传递 / 邮件索要）
- 纯 Node.js 内置模块，**无任何第三方依赖**
- **跨平台**：Windows / macOS（Intel + Apple Silicon）都有对应可执行文件（见 Release）

## 🚀 快速开始

### 方式一：图形界面（推荐）

| 平台 | 下载文件 | 使用方式 |
|---|---|---|
| **Windows** | `PMC-PDF-Downloader-Windows.exe` | 双击运行，浏览器自动打开 |
| **macOS Intel**（M1 之前的 Mac） | `PMC-PDF-Downloader-macOS-Intel` | 终端 `chmod +x` 后运行 |
| **macOS Apple Silicon**（M1/M2/M3/M4） | `PMC-PDF-Downloader-macOS-Apple` | 同上 |
| **iOS / iPadOS** | ❌ 不支持 | 用 iCloud 同步 PDF 到 iPad 阅读即可 |

1. 从 [Releases](../../releases) 下载对应平台的可执行文件
2. 运行后浏览器自动打开操作页面（`http://127.0.0.1:3737`）
3. 输入框支持两种写法（可混用）：
   - 每行一个 PMID / PMCID / DOI
   - **直接整段粘贴参考文献表**（如 Zotero 复制的 Chicago/APA 格式引文），自动识别其中的 DOI
4. 选择保存位置（会自动记住上次路径），点「开始下载」；完成后点「打开文件夹」，把 PDF 拖进 Zotero 对应条目

> **Windows**：首次运行若 SmartScreen 提示「未知发布者」，点「更多信息 → 仍要运行」。命令行黑窗口是程序本体，使用期间请勿关闭。
>
> **macOS**：首次运行 Gatekeeper 会拦截未签名二进制。在 Finder 里右键点文件 → 「打开」→ 同意；或在终端执行：
> ```bash
> chmod +x PMC-PDF-Downloader-macOS-Apple
> ./PMC-PDF-Downloader-macOS-Apple
> ```

### 方式二：命令行

```bash
# 输入文件同样支持两种内容：每行一个编号的清单，或整段参考文献文本
node download_pdfs.js ids.txt ./文献PDF
```

要求 Node.js ≥ 18（内置 fetch）。

## 📦 自行打包

```bash
npm install -g @yao-pkg/pkg
# Windows
pkg pmc_downloader_app.js -t node22-win-x64 -o PMC-PDF-Downloader-Windows.exe
# macOS Intel
pkg pmc_downloader_app.js -t node22-macos-x64 -o PMC-PDF-Downloader-macOS-Intel
# macOS Apple Silicon (M1/M2/M3/M4)
pkg pmc_downloader_app.js -t node22-macos-arm64 -o PMC-PDF-Downloader-macOS-Apple
```

也可以直接 push 一个 tag（如 `v1.1.0`），GitHub Actions 会自动构建三个平台版本并发布 Release（见 `.github/workflows/release.yml`）。

## ⚠️ 使用须知

- 本工具**只能下载 PMC 上存在免费全文的文献**。纯付费墙文献无法、也不应通过本工具获取，请使用 NSTL 文献传递（nstl.gov.cn）、馆际互借或邮件向通讯作者索要。
- 请合理使用，控制批量规模、保持默认的请求间隔，勿对公共服务器造成压力。
- 仅供个人学习研究使用，请遵守所在机构的网络与版权规定。

## 🧩 工作原理

1. 通过 **Europe PMC REST API** 将 PMID/DOI 解析为元数据和 PMCID（太新的文章自动走 NCBI idconv 兜底）
2. 访问 PMC 文章页，提取 PDF 链接（注意链接是相对路径）
3. PMC 对 PDF 下载启用 PoW 反爬：返回「Preparing to download」挑战页，包含 `POW_CHALLENGE` 与 `POW_DIFFICULTY`
4. 本地暴力求解 nonce，使 `sha256(challenge + nonce)` 十六进制前缀含指定数量的 `0`，将 `challenge,nonce` 写入 `cloudpmc-viewer-pow` cookie
5. 带 cookie 重新请求即得真实 PDF（cookie 有效约 5 小时）

## 📁 项目结构

```
├── pmc_downloader_app.js   # 图形界面版（HTTP 服务 + 内嵌网页，单文件）
├── download_pdfs.js        # 命令行版
├── docs/使用说明.txt        # 面向最终用户的详细说明
└── .github/workflows/      # CI：push tag 自动构建三平台版本并发布 Release
```

## 📄 License

MIT
