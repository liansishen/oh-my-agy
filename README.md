# Oh My Agy (`oma`)

**Oh My Agy (`oma`)** 是一个基于 [Tern Surface Protocol (TSP)](https://github.com/stencil-hq/tern-sdk) 与 Google Antigravity 官方 **Agent Client Protocol (`agy acp`)** 构建的独立终端前端 CLI。

它采用与 Tern 官方 Agent `omp` 完全同源的外挂进程架构：在 Tern 窗格中提供原生渲染的聊天界面、原生编辑器（中文 IME / 软换行 / 选区 / 撤销）、可点击全屏 Git Diff / Commit 面板、原生多步交互问答卡片、蜂群实时看板与小蜜蜂环绕动效、带对话预览的 `/resume` 会话选择器以及本地系统通知；在非 Tern 终端环境下自动回退，且支持通过普通 SSH 或 Tern Remote 在远端服务器使用。

## 快速安装

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/liansishen/oh-my-agy/main/scripts/install.ps1 | iex
```

默认安装到 `%LOCALAPPDATA%\Programs\oma\oma.exe` 并自动加入用户 `PATH`；若检测到本机已安装 `tern`，将一并安装配套的 `oma-reopen` 会话自动恢复插件。

### Linux / macOS

```sh
curl -fsSL https://raw.githubusercontent.com/liansishen/oh-my-agy/main/scripts/install.sh | sh
```

默认安装到 `~/.local/bin/oma`（以 `root` 运行且存在 `/usr/local/bin` 时自动创建 `/usr/local/bin/oma` 软链接）；若检测到 `tern`，自动安装 `oma-reopen` 插件。

> **安装脚本可选环境变量**：
> - `OMA_VERSION`：指定版本（如 `v0.1.0`，默认 `latest`）
> - `OMA_INSTALL_DIR`：自定义安装目录
> - `OMA_SKIP_PLUGIN=1`：跳过自动安装 `oma-reopen` Tern 插件
> - `OMA_REPO`：自定义 GitHub 仓库（默认 `liansishen/oh-my-agy`）

## 更新 (`oma update`)

```sh
# 检查并更新到最新 GitHub Release（自动校验 SHA256）
oma update

# 仅检查是否有新版本
oma update --check

# 强制重装或切换到指定版本
oma update --force
oma update --version v0.1.0
```

## 核心特性

- **1:1 对齐 `omp` 原生聊天与交互体验**：基于 `@stencil-hq/tern`（TypeScript + TSX）与 Bun，原生命中 Tern 预加载 `omp*.css` 及 Reader / Spine / Console 三种 Chat Style：
  - **一体化 Composer 与底部状态栏遥测**：融合模型/思考档位单胶囊（`Alt+P` 紧凑模型浮层 + 思考强度滑块）、常驻上下文进度条、语义着色权限模式（点击切换）、可点击 Git 分支与脏态（点击打开全屏 Git UI）、实时滑窗 + `transcript.jsonl` 校准的输出速率（`tok/s`）与累计 Token / 缓存命中率（点击查看 `/context`）；
  - **全屏 Git Diff & Commit 界面（点击底部 Git 状态或 `/git`）**：1:1 复刻 `omp.app.git` 原生界面，支持 `Split / Inline / File` 视图、`Path / Tree` 目录树、Unstaged / Staged 折叠分组、单文件或批量 Stage / Unstage、Amend 与提交，以及干净工作区下的 HEAD Commit 卡片浏览；
  - **原生交互式问答卡片（`ask_question` / `elicitation/create`）**：在 `initialize` 握手中完整声明 `elicitation` 能力，自动合并 `agy acp` 的单选/多选 + `Other` 自由输入字段，支持鼠标点选与全键盘导航（`↑/↓`、`1–9`、`Tab`/`Shift+Tab`、`Enter`、`Esc`）；
  - **原版 `agy` 风格 Swarm Board 蜂群实时看板与像素小蜜蜂动效**：常驻轻量监听 `swarm.json` / `members.json` / `board.jsonl`，蜂群模式下根据实际成员数动态呈现环绕输入框飞舞的像素小蜜蜂；按 `Alt+S`、点击 `jobs` 左侧小蜜蜂或输入 `/swarm board` 打开居中蜂群面板（多彩成员 Roster + 倒序 Posts 列表 + Markdown 详情）；
  - **光标下方 `/` 与 `@` 智能补全 & 全量 P0/P1 命令**：支持 `/resume`、`/git`、`/jobs`（`/tasks`）、`/settings`（`/config`）、`/permissions`、`/status`、`/context`、`/usage`、`/mcp`、`/plugins`、`/skills`、`/agents`、`/model`、`/thought`、`/mode`、`/new`、`/export`、`/copy`、`/login`、`/logout`、`/log`、`/compact`、`/help`、`/quit`；
  - **可靠的后台任务/蜂群通知与终端光标根治**：后台任务与蜂群运行期间不提前发送 `OSC 7501 state=done`，并支持输入补充消息实时转向；双锁 + 节流重申 `DECTCEM` 消除 Windows ConPTY 下孤立光标。
- **跨平台单文件分发**：通过 `bun build --compile` 打包为 Windows / Linux / macOS 独立单可执行文件，零外部运行时依赖。
- **可选 Tern 重启自动恢复**：配套轻量 Host 插件 [plugins/oma-reopen](plugins/oma-reopen/README.md)，在 Tern 守护进程重建或分屏时自动拉起 `oma --resume` 续接会话。
- **合规边界**：严格调用官方未修改的 `agy acp` 二进制并走其原生本地认证，不提取/转发 OAuth Token，不触碰任何凭证文件。

## 从源码构建

前置依赖：[Bun](https://bun.sh) 1.4+ 与官方 `agy` CLI。

```powershell
# 安装依赖
bun install

# 类型检查与单元测试
bun run typecheck
bun test

# 编译单文件可执行程序
bun run build:win     # dist/oma.exe
bun run build:linux   # dist/oma

# 或使用 Windows 构建脚本一键完成测试、编译并安装至用户 PATH
.\scripts\build.ps1 -Install -AddToPath
```

如需手动安装 `oma-reopen` Tern Host 插件：

```powershell
tern plugin install .\plugins\oma-reopen
```

## 文档索引

- 详细系统设计与架构规范：[docs/DESIGN.md](docs/DESIGN.md)
- `oma-reopen` 重启自动恢复插件说明：[plugins/oma-reopen/README.md](plugins/oma-reopen/README.md)

## License

[MIT](LICENSE)
