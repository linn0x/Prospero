# esaytree

`esaytree` 是 Prospero 自研的快速 worktree 引擎，用于给 coding agent 创建可丢弃、互相隔离的 Git 工作区。它同时提供 TypeScript API 和独立 CLI，现有手工派发与自动编排已经直接使用同一套实现。

## 核心保证

- 新工作区从指定 ref 的已提交快照开始。
- 源仓的 staged、unstaged 和 untracked 改动不会泄漏给 worker。
- 默认只复用明确的依赖目录：monorepo 中各层的 `node_modules`。
- `build/`、`.cache/`、`.expo/`、`ios/build/`、`.claude/` 等构建产物、缓存和潜在私有配置不会进入 worker。
- CoW 克隆不是硬链接；修改 worker 文件不会改变源仓或其他工作区。macOS 只在直接 `clonefile` 成功后才报告 CoW，绝不把 `cp -c` 的成功当作证明。
- 创建中途失败会撤销 worktree 登记、目标目录和本次新建的分支。
- 移除前会确认目标确实是当前仓库登记的 worktree。

它是开发工作区隔离工具，不是安全沙箱。worker 仍拥有当前用户本来就有的文件和进程权限。

## 为什么快

普通 `git worktree add` 会检出已提交的 tracked 文件，但新的工作区没有 ignored 依赖。esaytree 保持这条安全 Git 路径，并只为允许的依赖加速：

1. `git worktree add` 从指定 ref 检出干净的 tracked 快照；源仓的本地状态和所有 ignored 内容都不会进入目标。
2. 仅发现 allowlist 中的 `node_modules`，并先对每个目录尝试严格 CoW。
3. macOS 同卷路径通过系统自带 JXA 显式绑定并调用 `clonefile`；其他平台使用 Node 的 `COPYFILE_FICLONE_FORCE` 严格语义。
4. 只有上一步失败且显式开启 `--copy-fallback` 时，才统计失败候选目录并进行容量预检，然后做实体副本。

允许的 ignored 依赖在 CoW 成功时共享物理块，只有第一次写入的块会真正分裂。若文件系统不支持强制 CoW（包括跨卷的 `EXDEV`、Node 探针的 `ENOSYS`），默认保留普通 Git checkout，且**不复制** ignored 依赖；工作树仍然完全隔离，可在其中重新安装依赖。

`--copy-fallback` 是唯一允许实体复制的 CLI 开关。复制前 esaytree 会先统计所有候选依赖的逻辑字节数、读取目标卷可用空间，并一次性判断以下门槛；未通过时不会写任何一个候选目录：

- 默认每次最多 `8 GiB`（`ESAYTREE_MAX_FALLBACK_COPY_BYTES`，设为 `0` 可禁止）；
- 复制后至少保留 `4 GiB`（`ESAYTREE_MIN_FREE_BYTES`）；
- 任一预检、复制或 CoW 降级原因都会写入报告，便于释放空间、提高上限或改为在目标树安装依赖。

## CLI

先构建 daemon：

```bash
npm run typecheck
apps/daemon/bin/esaytree doctor
```

日常操作：

```bash
# 从当前 HEAD 创建分支 esaytree/fix-login，并复用 ignored 依赖
apps/daemon/bin/esaytree new fix-login

# 创建完全干净、不带 ignored 目录的工作区
apps/daemon/bin/esaytree new clean-room --no-ignored

# 查看、取得 cwd、永久移除
apps/daemon/bin/esaytree list
cd "$(apps/daemon/bin/esaytree switch fix-login)"
apps/daemon/bin/esaytree rm fix-login
```

`rm` 会永久丢弃工作区中的未保存改动，并默认删除对应本地分支。需要保留分支时使用 `--keep-branch`。

常用选项：

- `-C, --repo <path>`：指定仓库或其子目录。
- `--base <ref>`：指定起点，默认 `HEAD`。
- `--branch <name>` / `--detach`：指定新分支或 detached 模式。
- `--at <path>`：覆盖默认目标路径。
- `--require-cow`：CoW 不可用时直接失败。
- `--copy-fallback`：fallback 时允许真实复制 ignored 目录。
- `--json` 或 `--format json`：输出稳定的单个 JSON 文档。

默认存储目录是仓库相邻的 `.prospero-worktrees/<repo>/<name>`。可通过 `ESAYTREE_ROOT` 改为统一根目录；该目录下仍会按仓库名分组。

`doctor` 使用与创建相同的源→目标同卷探针，并在可用时报告 `cow_backend: macos_clonefile`（人类输出为 `cow backend: macos_clonefile`）。它不是 `cp -c` 探测：`clonefile` 返回失败就会明确报告 unavailable 并走安全 fallback。

## 机器接口

JSON 响应使用以下 envelope：

```json
{
  "schema": "esaytree.dev/cli/v1",
  "schema_version": 1,
  "kind": "esaytree.task-new",
  "data": {}
}
```

`esaytree.task-new` 的 `data.task` 除路径和分支外还包括 `mode`、`cow`、`cow_backend`、`elapsed_ms`、`fallback_reason`（若降级），以及完整的 `clones` 数组。每项有 `strategy: cow|copy|skipped`、耗时、可选字节估算和原因；`preserved_ignored` 与 `skipped_ignored` 分别列出最终带入和明确未带入的目录。消费者不得把 `cow: false` 或 `skipped` 当作已复用。

成功 kind 包括：

- `esaytree.task-new`
- `esaytree.task-list`
- `esaytree.task-switch`
- `esaytree.task-remove`
- `esaytree.doctor`

失败响应使用 `esaytree.error`，诊断写入 stderr。退出码为：参数错误 `2`、仓库或工作区不存在 `3`、目标冲突 `4`、CoW 前置能力缺失 `5`、Git/复制操作失败 `6`、意外内部错误 `70`。

`switch` 不可能改变父 shell 的 cwd；脚本应读取人类模式输出的绝对路径，或 JSON 中的 `data.task.path`，再把它用作子进程 cwd。

## 内部 API

实现位于 `apps/daemon/src/orchestration/esaytree.ts`。编排层主要使用：

- `createEsaytree()`：创建并返回 `mode`、`cow`/`cowBackend`、耗时，以及 preserved/skipped ignored 和逐目录 clone 报告；旧的 `createWorktree()` 名称继续兼容。
- `listWorktrees()` / `listManagedWorktrees()`：读取 Git 登记与 esaytree 管理范围。
- `removeWorktree()` / `removeManagedWorktree()`：安全移除和可选分支清理。
- `diagnoseEsaytree()`：验证 Git 与目标文件系统的 CoW 能力。

旧的 `worktree.ts` 只保留兼容 re-export，新代码统一直接依赖 `esaytree.ts`。
