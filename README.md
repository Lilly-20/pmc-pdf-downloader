# 📚 PMC 全文批量下载器

一个本地运行的小工具：粘贴文献列表，自动从 **PMC（PubMed Central）** 批量下载**有免费全文**的文献 PDF，按「第一作者 年份 - 标题」自动命名，直接拖进 Zotero 即可。

专为以下场景设计：机构没有外文数据库订阅、Zotero「查找可用 PDF」失灵、浏览器插件装不了。零依赖、免安装、双击即用。

## ✨ 特性

- 支持三种编号：**PMID**（如 `42670262`）、**PMCID**（如 `PMC13527554`）、**DOI**（如 `10.1002/sim.70722`）
- **整段粘贴参考文献表即可**：从 Zotero「由所选条目创建参考文献表」复制的任意格式引文，直接粘进输入框，自动提取其中全部 DOI，自动去重、自动忽略作者名/年份/页码等干扰信息
- 自动解析元数据并按 `作者 年份 - 标题.pdf` 命名，与 Zotero 命名习惯一致
- 自动通过 PMC 的 PoW（工作量证明）下载挑战
- 限流自动重试 + 请求间隔，对 NCBI / EBI 服务器友好
- 已下载的文件自动跳过，重复运行不浪费流量
- 无免费版的文献单独汇总列出（提示走文献传递 / 邮件索要）
- 纯 Node.js 内置模块，**无任何第三方依赖**

## 🚀 快速开始

### 方式一：图形界面（推荐）

1. 下载 [Releases](../../releases) 里的 `PMC全文下载器.exe`（或按下方说明自行打包）
2. 双击运行，浏览器自动打开操作页面（`http://127.0.0.1:3737`）
3. 输入框支持两种写法（可混用）：
   - 每行一个 PMID / PMCID / DOI
   - **直接整段粘贴参考文献表**（如 Zotero 复制的 Chicago/APA 格式引文），自动识别其中的 DOI
4. 选择保存位置，点「开始下载」；完成后点「打开文件夹」，把 PDF 拖进 Zotero 对应条目

> 首次运行若 Windows SmartScreen 提示「未知发布者」，点「更多信息 → 仍要运行」。命令行黑窗口是程序本体，使用期间请勿关闭。

### 方式二：命令行

```bash
# 输入文件同样支持两种内容：每行一个编号的清单，或整段参考文献文本
node download_pdfs.js ids.txt ./文献PDF
```

要求 Node.js ≥ 18（内置 fetch）。

## 📦 自行打包 exe

```bash
npm install -g @yao-pkg/pkg
pkg pmc_downloader_app.js -t node22-win-x64 -o PMC全文下载器.exe
```

也可以直接 push 一个 tag（如 `v1.0.0`），GitHub Actions 会自动构建并发布 exe（见 `.github/workflows/release.yml`）。

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
└── .github/workflows/      # CI：push tag 自动构建 exe 并发布 Release
```

## 📄 License

MIT
