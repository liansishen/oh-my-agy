# 发布与分支协作规范

为确保 `main` 分支始终处于可构建、可测试、可发布状态，本仓库遵循以下分支与版本发布流程。

## 1. 分支保护约定

- **`main` 分支禁止直接推送除 `README.md` 以外的任何修改。**
- 所有代码、配置、依赖、工作流、测试与版本号变更均须在独立分支开发，通过 **Pull Request (PR)** 合并进 `main`。
- 禁止对 `main` 或已发布的 `v*` 标签执行强制推送或删除操作。

## 2. PR 与 CI 门禁

1. 从最新 `main` 切出特性或发布分支（如 `feat/...`、`fix/...`、`release/vX.Y.Z`）。
2. 提交变更并推送到远端分支，向 `main` 发起 Pull Request。
3. GitHub Actions [`CI`](../.github/workflows/ci.yml) 将自动在 `ubuntu-latest` 上执行：
   - `bun install --frozen-lockfile`
   - `bun run typecheck`
   - `bun test`
   - 跨平台二进制编译与 `--version` 一致性校验
4. 仅当全部 CI 检查通过后，方可合并 PR 至 `main`。

## 3. 版本发布流程

1. 在发布分支的 PR 中统一更新版本号（`package.json` 的 `version` 与 `src/acp/client.ts` 默认版本号保持一致）。
2. 等待该 PR 在 GitHub Actions `CI` 全部通过后合并到 `main`。
3. 拉取合并后的最新 `main`，创建附注标签并推送：
   ```bash
   git checkout main
   git pull --ff-only origin main
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```
4. 推送 `vX.Y.Z` 标签后，[`.github/workflows/release.yml`](../.github/workflows/release.yml) 将自动校验标签与 `package.json` 版本一致、运行测试、交叉编译 5 平台二进制、生成 `SHA256SUMS.txt` 并发布 GitHub Release。
5. `v*` 标签受仓库规则集 `Protect release tags (v*)` 保护，一经推送不可覆盖或删除；若需修复请递增补丁版本号重新走 PR → CI → 合并 → 新 tag 流程。
