# esaytree

`esaytree` 是 Prospero 自研的快速 worktree 引擎，用于给 coding agent 创建可丢弃、互相隔离的 Git 工作区。它同时提供 TypeScript API 和独立 CLI，现有手工派发与自动编排已经直接使用同一套实现。

## 核心保证

- 新工作区从指定 ref 的已提交快照开始。
- 源仓的 staged、unstaged 和 untracked 改动不会泄漏给 worker。
- 默认复用完全被 Git 忽略的目录，例如 monorepo 中各层的 `node_modules`。
- CoW 克隆不是硬链接；修改 worker 文件不会改变源仓或其他工作区。
- 创建中途失败会撤销 worktree 登记、目标目录和本次新建的分支。
- 移除前会确认目标确实是当前仓库登记的 worktree。

它是开发工作区隔离工具，不是安全沙箱。worker 仍拥有当前用户本来就有的文件和进程权限。

## 为什么快

普通 `git worktree add` 会重新写出全部 tracked 文件，而且新的工作区没有 ignored 依赖。esaytree 的快速路径是：

1. `git worktree add --no-checkout` 只建立 Git 元数据和分支。
2. 使用 `COPYFILE_FICLONE_FORCE` 对源工作区做文件系统级 CoW 克隆，根 `.git` 不复制。
3. 暂存要复用的 ignored 目录。
4. 用 `git reset`、`git clean` 和按需 `git checkout` 把目标还原到自己的提交快照。
5. 把 ignored 依赖移回目标。

干净 tracked 文件和 ignored 依赖因此共享物理块，只有第一次写入的块会真正分裂。若文件系统不支持强制 CoW，默认退回普通 Git checkout；CLI 不会默认真实复制大型 ignored 目录。

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

- `createEsaytree()`：创建并返回 `mode`、`cow`、耗时和 preserved ignored 报告；旧的 `createWorktree()` 名称继续兼容。
- `listWorktrees()` / `listManagedWorktrees()`：读取 Git 登记与 esaytree 管理范围。
- `removeWorktree()` / `removeManagedWorktree()`：安全移除和可选分支清理。
- `diagnoseEsaytree()`：验证 Git 与目标文件系统的 CoW 能力。

旧的 `worktree.ts` 只保留兼容 re-export，新代码统一直接依赖 `esaytree.ts`。
