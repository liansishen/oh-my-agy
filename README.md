<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg" />
    <img alt="Oh My Agy Logo" src="assets/logo-dark.svg" width="84" />
  </picture>

  <h1>Oh My Agy (<code>oma</code>)</h1>

  <p>
    基于 <a href="https://github.com/stencil-hq/tern-sdk">Tern Surface Protocol (TSP)</a> 与 Google Antigravity 官方 <code>agy acp</code> 构建的独立终端前端 CLI
  </p>
</div>

**Oh My Agy (`oma`)** 采用与 Tern 官方 Agent `omp` 同源的外挂进程架构：在 Tern 窗格中提供原生渲染的聊天界面、原生编辑器（中文 IME / 软换行 / 选区 / 撤销）、多阶段实时 Todo HUD 清单、Orchestrator 三段式编排胶囊、实时思考流、压缩前历史折叠、可点击全屏 Git Diff / Commit 面板、原生多步交互问答卡片、蜂群实时看板（含 Overview 概览与像素小蜜蜂动效）、带对话预览的 `/resume` 会话选择器以及本地系统通知；在非 Tern 终端环境下自动回退，并支持通过普通 SSH 或 Tern Remote 在远端服务器使用。

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
> - `OMA_VERSION`：指定版本（如 `v0.3.2`，默认 `latest`）
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
oma update --version v0.3.2
```

## 核心特性

- **基于 Tern 原生组件与 `omp` 样式/交互约定构建**：基于 `@stencil-hq/tern`（TypeScript + TSX）与 Bun，原生复用 Tern 预加载 `omp*.css` 及 Reader / Spine / Console 三种 Chat Style：
  - **内置 HTTP MCP Todo 工具与多阶段实时 HUD 清单（`/todo`）**：内嵌本地 HTTP MCP 服务（`oma_todo`，启用 `antigravity/alwaysLoad` 并静默自动放行），在输入框上方实时展示多阶段 `omp.hud.todo` 进度清单与 `1:1` `omp.tool.todo` 工具卡片，支持完成后 60 秒自动收起、`/todo` 命令行管理以及 `/resume` 历史回放重建；
  - **压缩前历史折叠与会话配置持久继承**：提供 `ui.collapse_compacted` 设置（默认开启），自动识别 `CHECKPOINT` / `USER_INPUT` 与自动压缩边界并将较早对话折叠为可交互展开/收起的横幅，同时保留完整历史供 `/copy`、`/export`、`/status` 与 `/context` 使用；`/new` 与 `/resume` 自动延续已选模型、思考档位与权限模式；
  - **按模型真实能力的思考档位与 Orchestrator 三段式胶囊**：`/model`（`Alt+P`）按各模型实际能力精准显示 4 档（Neon / Hydrogen）、3 档（Carbon / Argon / Flash / Claude）或禁用（GPT-OSS / Orchestrator），并将编排变体合并为按 `google` 分类与图标展示的单个 `Orchestrator` 入口；切入 Orchestrator 后底部呈现具备多层极光呼吸与运行态强化动效的 `Orchestrator` + 天蓝色 `Plan`（受限 4 选 1）+ 薄荷绿色 `Exec`（受限 2 选 1）短名胶囊，支持独立点击循环思考强度与弹窗切换，并原子持久化至 `~/.gemini/antigravity-cli/settings.json`；
  - **实时思考流 `/thinking [on|off]` 与智能工具折叠**：对应 `agy` `settings.json` 的 `showThinking`，开启后实时输出完整思考过程并在思考完成后保持展开；支持 `All / Compact / Hidden` 工具显示模式（`Alt+O` / `Ctrl+Shift+O`）与 `Ctrl+O` 展开工具解耦；
  - **一体化 Composer 与底部状态栏遥测**：常驻上下文进度条、语义着色权限模式（点击切换）、可点击 Git 分支与脏态（点击打开全屏 Git UI）、实时滑窗 + `transcript.jsonl` 校准的输出速率（`tok/s`）与累计 Token / 缓存命中率（点击查看 `/context`，并在 `/context` 与 `/model` 中展示 `AGY_CLI_AUTO_COMPACT_OVERRIDE` 自动压缩阈值）；
  - **全屏 Git Diff & Commit 界面（点击底部 Git 状态或 `/git`）**：基于 `omp.app.git` 原生组件实现，支持 `Split / Inline / File` 视图、行折行（`Wrap`）、`Path / Tree` 目录树、Unstaged / Staged 折叠分组、双端点重命名预览、单文件或批量 Stage / Unstage、Amend 与提交，以及干净工作区下按第一父提交基准的 HEAD Commit 浏览；
  - **原生交互式问答卡片（`ask_question` / `elicitation/create`）**：在 `initialize` 握手中完整声明 `elicitation` 能力，自动合并 `agy acp` 的单选/多选 + `Other` 自由输入字段，支持鼠标点选与全键盘导航（`↑/↓`、`1–9`、`Tab`/`Shift+Tab`、`Enter`、`Esc`）；
  - **原版 `agy` 风格 Swarm Board 蜂群实时看板（含 Overview 概览）与像素小蜜蜂动效**：常驻轻量监听 `swarm.json` / `members.json` / `board.jsonl` / `plan.json`，在高度 ≥ 28 行的终端中于看板顶部实时展示集群目标、完成/阻塞进度与最多 6 个并行工作流状态，蜂群模式下按实际成员数动态环绕飞舞像素小蜜蜂；按 `Alt+S`、点击 `jobs` 左侧小蜜蜂或输入 `/swarm board` 打开；
  - **光标下方 `/` 与 `@` 智能补全 & 全量命令**：支持带空格、逗号与前导 `@` 路径的统一 `@"..."` 文件引用解析，覆盖 `/todo`、`/resume`、`/git`、`/jobs`（`/tasks`）、`/settings`（`/config`）、`/permissions`、`/status`、`/context`、`/usage`、`/mcp`、`/plugins`、`/skills`、`/agents`、`/model`、`/thought`、`/thinking`、`/mode`、`/new`、`/export`、`/copy`、`/login`、`/logout`、`/log`、`/compact`、`/help`、`/quit`；
  - **可靠的后台任务收敛、完成门控与终端光标抑制**：精准收敛 Timer、Cron、后台任务与 `manage_task` 状态，将 HUD `jobs` 计数与独立子代理严格解耦；后台执行结束后等待 `transcript.jsonl` 权威 `planner_final` 才发出 `OSC 7501 state=done`；双锁 + 节流重申 `DECTCEM` 消除 Windows ConPTY 下孤立光标。
- **跨平台单文件分发**：通过 `bun build --compile` 打包为 Windows / Linux / macOS 独立单可执行文件，零外部运行时依赖。
- **可选 Tern 重启自动恢复**：配套轻量 Host 插件 [plugins/oma-reopen](plugins/oma-reopen/README.md)，在 Tern 守护进程重建或分屏时自动拉起 `oma --resume` 续接会话。
- **合规与后端能力边界**：严格调用官方未修改的 `agy acp` 二进制并走其原生本地认证，不提取/转发 OAuth Token，不触碰任何凭证文件。受限于当前 `agy acp` 协议接口：
  - 不支持当轮实时 `steer` 队列注入（运行中需等待当前回合结束或按 `Esc` 取消后发送新指令）；
  - `/usage` 展示当前会话的 Token、缓存命中率与输出速率统计（非提供商账户配额周期面板）；
  - `--fork` 不支持独立分叉会话，将安全回退为加载原会话；
  - `/resume` 搜索基于 ACP `session/list` 与本地预览缓存正文，不做全量磁盘对话全文索引。

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
- 发布与分支协作规范：[docs/RELEASE.md](docs/RELEASE.md)
- `oma-reopen` 重启自动恢复插件说明：[plugins/oma-reopen/README.md](plugins/oma-reopen/README.md)

## License

[MIT](LICENSE)
