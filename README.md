# Oh My Agy (`oma`)

**Oh My Agy (`oma`)** 是一个基于 [Tern Surface Protocol (TSP)](https://github.com/stencil-hq/tern-sdk) 与 Google Antigravity 官方 **Agent Client Protocol (`agy acp`)** 构建的独立终端前端 CLI。

它采用与 Tern 官方 Agent `omp` 完全同源的外挂进程架构：在 Tern 窗格中提供原生渲染的聊天界面、原生编辑器（中文 IME / 软换行 / 选区 / 撤销）、带对话预览的 `/resume` 会话选择器、自定义思考与工具卡片以及本地系统通知；在非 Tern 终端环境下自动回退，且支持通过普通 SSH 透传到远端服务器使用。

## 核心特性

- **1:1 对齐 `omp` 原生聊天与交互体验**：基于 `@stencil-hq/tern`（TypeScript + TSX JSX 运行时）与 Bun，使用 `role: "omp.session"` 与完整 `omp.*` 节点角色树原生命中 Tern 预加载 `omp*.css` 及 Reader / Spine / Console 三种 Chat Style：
  - **一体化 Composer 与紧凑模型/思考浮层**：底部融合单胶囊 `omp.composer.model`（内嵌可点击循环切换的 `omp.composer.model.effort` 图标）+ 常驻上下文进度条 `omp.composer.context` + `/` 与 `@file` 语法高亮与幽灵参数提示；按 `Alt+P` 或点击模型胶囊在编辑器上方弹出紧凑 `<picker anchor="composer" search="list" density="snug" scopeStyle="rail" preview="none">` 模型浮层，内置左侧厂商轨、`Recent`/`All` 分组与底部 `level` 思考强度滑块（`←`/`→` 步进、Esc 保留、`recent_models` 自动持久化）；
  - **光标下方 `/` 与 `@` 智能补全**：最多 10 行、纯命令名无前导 `/`、全量语义图标（目录 `folder`/文件 `file`）、右侧实时动态状态值（当前模型/思考档位/权限模式/上下文占用/活跃蜂群数等）及多技能自动折叠 `skill:` 行；
  - **原生思考链、工具卡片与交互闭环**：原生 Stencil Spindle 动画与 3 层 Dock HUD（输入框上方独立右对齐 `omp.hud` → `omp.hud.pill` 双段胶囊，蜂群模式下 `jobs` 左侧渲染专属像素小蜜蜂图标按钮 `oma.bee.hud`，点击打开蜂群面板；点击 `jobs` 或执行 `/jobs` / `/tasks` 打开 1:1 `omp.overlay.jobs` 后台任务面板并在结束后严格停表；`omp.hud.activity` 含 `omp.working.sep`/`label`/`stop` 与 `omp.hud.todo`）、跨 Turn 后台任务与蜂群活跃态追踪（后台/蜂群运行期间不提前发送 `OSC 7501 state=done`，空草稿保持停止按钮且输入框显示灰色运行提示，输入补充文字或添加附件时自动切回发送按钮允许随时发补充消息，全部结束后自动补发 `done` → `idle`）、带耗时 `took` 的 `omp.thinking`（`Ctrl+T` 显隐、`Ctrl+O` 展开/折叠全部工具）、`omp.error.actions` 错误重试/复制/切模型按钮（`F5` 重试）、按 `hour12` 格式化并带右键菜单（复制/编辑重发/重试）的用户消息，以及前后双锁 + 节流重申的 `DECTCEM`（`surface.open()` 前 `\x1b[?25l` + 后原子 `OSC 2 + \x1b[?25l` + 首帧/`resize`/`theme`/`features`/`settleTurn` 节流重申 + `/login`/`/quit` 恢复 `\x1b[?25h`）彻底消除 Windows ConPTY 下孤立原生竖线光标；
- **原生 `<prefs>` `/settings`（`/config`）侧边配置面板**：桌面支持 `aside` 时直挂 `layer` 右侧边栏与对话/输入框焦点共存，覆盖 `Session`（实时同步 ACP）、`Interface`、`Defaults`、`Permissions`（含 `oma` `auto_allow_tools` 原子写 `config.toml` 与 `agy` 5 键安全白名单原子写 `~/.gemini/antigravity-cli/settings.json` 且 100% 保留未知键）与 `Ecosystem` 5 个分页；
- **全量 P0 + P1 命令与生态面板**：支持 `/resume`（别名 `/r`/`/sessions`/`/switch`/`/conversation`，无侧栏 `Tab` 切目录 + 右侧对话预览）、`/jobs`（别名 `/tasks`，查看运行中与近期后台命令/任务及输出详情）、`/settings`（`/config`）、`/permissions`、`/status`、`/context`、`/usage`（`/quota`）、`/mcp`、`/plugins`、`/skills`（预览 `SKILL.md` 并一键插入草稿）、`/agents`、`/model`、`/thought`（`/effort`/`/thinking`/`/t`）、`/mode`、`/new`（`/clear`）、`/export [path]`、`/copy [n]`、`/login`、`/logout`（二次确认调用官方 `auth/logout` RPC）、`/log`、`/compact`、`/help` 与 `/quit`；
- **原版 `agy` 风格 Swarm Board 蜂群实时看板与像素小蜜蜂动效**：会话级常驻轻量后台 `watchSwarmBoard` 自动感知 `agy` 本地蜂群状态（`swarm.json` / `members.json` / `board.jsonl`）；蜂群运行期间动态加载 `oma-swarm-fx` 样式表（严守 Tern CSS 白名单、支持 `prefers-reduced-motion`）在输入框四周呈现琥珀呼吸边框与 4 只 `pointer-events: none` 环绕飞舞像素小蜜蜂（空闲/切换会话自动卸载），并在输入框内展示灰色实时提示；按 `Alt+S`、点击 `jobs` 左侧像素小蜜蜂按钮或输入 `/swarm board`（别名 `/board`）打开直挂 `layer` 的原版 `agy` 风格 `SwarmBoardView`（顶部多列通透 Roster 卡片，按成员名哈希分色多彩像素小蜜蜂 + `coordinator` 暖金皇冠 `👑` + `working` 振翅 / `waiting` 像素 `z` 双态 + 折叠 `Retired` 行；下方左右分栏为左侧 Posts 列表与右侧完整 Markdown 详情，支持点击成员筛选、`↑`/`↓` 选行、键入搜索、`Follow` 与 `Refresh`）；`/swarm` 及 `/swarm <任务>` 保持原样透传给 `agy acp`。
- **单文件跨平台分发**：使用 **TypeScript + Bun**（参考 `omp` 的实现），通过 `bun build --compile` 打包为 Windows（`oma.exe`）与 Linux/macOS（`oma`）单可执行文件，支持本地、远程 Tern Host 以及纯 SSH 环境。
- **可选 Tern 重启自动恢复**：配套轻量 Host 插件 `plugins/oma-reopen/`，利用 Tern 的 `reopen` 插件钩子在守护进程重建时自动拉起 `oma --resume` 续接会话。
- **合规边界**：严格调用未修改的官方 `agy acp` 二进制并走其原生本地认证，不提取/转发 OAuth Token，不触碰任何凭证文件，不包装无头自动刷量循环。

## 开发、构建与安装

```powershell
# 安装依赖
bun install

# 类型检查与单元测试
bun run typecheck
bun test

# 打包单文件可执行程序
bun build --compile src/bin/oma.ts --outfile dist/oma.exe

# 或使用构建脚本一键执行 typecheck、test、编译并安装至用户 PATH
.\scripts\build.ps1 -Install -AddToPath
```

如需在 Tern 守护进程重启或 Fork 窗格时自动恢复 `oma` 会话，可安装配套的 `oma-reopen` Tern Host 插件：

```powershell
# 推荐：正式安装插件
tern plugin install .\plugins\oma-reopen

# 或用于本地开发的符号链接方式
tern plugin link .\plugins\oma-reopen
```

> 可运行 `tern plugin dir` 查看当前系统的实际 Tern 插件目录（Windows 默认为 `%APPDATA%\Tern\plugins`）。

## 文档索引

- 详细系统设计与架构规范：[docs/DESIGN.md](docs/DESIGN.md)
- `oma-reopen` 重启自动恢复插件说明：[plugins/oma-reopen/README.md](plugins/oma-reopen/README.md)

## 当前状态

**M1 – M5（含方案 A 全量 `omp` 1:1 界面精修与 P0 + P1 命令补全）已完成实装**：

- 界面对齐：`surface.open({ role: 'omp.session', ... })` 完整接入 Tern 预加载 `omp*.css` 与 Chat Style（Reader / Spine / Console），覆盖一体化 `omp.composer.model` 单胶囊与紧凑模型+滑块浮层、`<prefs>` `/settings` 侧边栏、语义图标 `/` 补全与 `skill:` 折叠、无侧栏 `/resume`、Working HUD（Spindle + `omp.hud.pill` 像素小蜜蜂与后台任务胶囊）、跨 Turn 后台/蜂群态与智能 Stop/Send 切换、带 `took` 的 `omp.thinking`、`omp.error.actions`、`omp.user` 右键菜单、原版 `agy` 风格多色像素小蜜蜂 `SwarmBoardView` 实时看板、`oma-swarm-fx` 蜜蜂环绕动效以及前后双锁 + 节流重申的 `\x1b[?25l`/`\x1b[?25h` 终端光标根治；
- 命令与配置：全量 P0 + P1 斜杠命令、快捷键（`Alt+P`/`Ctrl+T`/`Ctrl+O`/`F5`/`Shift+Tab`/`Alt+S`）、`config.toml` 原子读写与 `agy` 安全白名单配置落盘均已闭环；
- 类型检查与自动化测试：`bun run typecheck` 零错误、`bun test` 全量测试全绿；
- 单文件打包与冒烟：`dist/oma.exe`（或未释放旧进程时的 `dist/oma-new.exe`）编译通过。
