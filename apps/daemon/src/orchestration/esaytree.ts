/**
 * esaytree: 为 coding agent 创建快速、隔离、可回收的 Git 工作区。
 *
 * 快速路径以 Git 正常检出已提交的 tracked 快照（它不复制 ignored 文件）开始，再：
 *   1. 只识别明确允许的 ignored 依赖目录；
 *   2. 用文件系统 CoW 逐目录克隆允许的依赖；
 *   3. CoW 不可用时保留干净 Git checkout，默认不做实体复制；
 *   4. 只有显式允许的实体复制才先完成磁盘容量预检。
 *
 * 这样 staged / unstaged / untracked 状态不会泄漏给 worker，依赖的首次写入也不会
 * 污染源树；构建缓存和私有配置从始至终不进入目标工作树。
 */
import { execFile, execFileSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  statfsSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_GIT_BUFFER = 32 * 1024 * 1024;
const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const ESAYTREE_SCHEMA = "esaytree.dev/cli/v1";
export const ESAYTREE_SCHEMA_VERSION = 1;

export type EsaytreeErrorCode =
  | "invalid_name"
  | "not_a_repo"
  | "worktree_exists"
  | "worktree_missing"
  | "unsafe_path"
  | "cow_unavailable"
  | "copy_failed"
  | "git_failed";

export class EsaytreeError extends Error {
  constructor(message: string, readonly code: EsaytreeErrorCode) {
    super(message);
    this.name = "EsaytreeError";
  }
}

// 兼容旧模块的公开类型名；新代码应使用 EsaytreeError。
export { EsaytreeError as WorktreeError };
export type WorktreeErrorCode = EsaytreeErrorCode;

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface ManagedWorktreeInfo extends WorktreeInfo {
  name: string;
}

export interface CloneReport {
  dir: string;
  /** true 表示文件系统确认使用 CoW；false 表示发生了真实复制。 */
  cow: boolean;
  /** `skipped` 从未写入目标路径；不能被误认为已复用。 */
  strategy: "cow" | "copy" | "skipped";
  ms: number;
  /** 物理复制预检得到的保守逻辑字节数；CoW 路径不需要遍历统计。 */
  bytes?: number;
  /** 跳过、降级或失败的可操作原因。 */
  reason?: string;
  /** @deprecated 使用 reason；保留给已有 API 调用方。 */
  error?: string;
}

export type CowBackend = "macos_clonefile" | "node_copyfile_ficlone" | "injected" | "none";

/**
 * 实体复制是兜底，不是常态。默认 8 GiB 可防止一次 worker 派发吞掉整个数据卷；
 * 部署方可通过 ESAYTREE_MAX_FALLBACK_COPY_BYTES 调整，0 表示禁止实体复制。
 */
export const DEFAULT_MAX_FALLBACK_COPY_BYTES = 8 * 1024 ** 3;
/** 无论候选目录大小，都为源仓、Git 和后续工具留下最少 4 GiB。 */
export const DEFAULT_MIN_FREE_BYTES = 4 * 1024 ** 3;

export interface EsaytreeOperations {
  /** 测试或受控嵌入可替换严格 CoW 后端；生产代码不应以普通 copy 冒充成功。 */
  cloneCow?(from: string, to: string): void;
  /** 以字节返回目标文件系统当前可分配空间。 */
  availableBytes?(at: string): number;
}

export type EsaytreeCreateMode = "copy-on-write" | "git-checkout";

export interface CreateWorktreeInput {
  repo: string;
  /** 工作区目录名，也用于默认存储路径。 */
  name: string;
  /** 目标路径；默认位于 defaultWorktreeRoot(repo)/name。 */
  at?: string;
  /** 起点 ref；默认当前 HEAD。 */
  baseRef?: string;
  /** 要新建的分支；省略时创建 detached worktree。 */
  branch?: string;
  /** 是否保留完全被 Git 忽略的目录（依赖、缓存等）；默认保留。 */
  cloneIgnored?: boolean;
  /** CoW 不可用时是否退回普通 Git checkout；默认退回。 */
  fallbackToCheckout?: boolean;
  /** fallback 时是否允许真实复制 ignored 目录；默认关闭，避免一次派发耗尽数据卷。 */
  fallbackCopyIgnored?: boolean;
  /** fallback 实体复制的总量上限；默认 8 GiB。 */
  maxFallbackCopyBytes?: number;
  /** fallback 实体复制后必须保留的可用空间；默认 4 GiB。 */
  minFreeBytes?: number;
  /** 仅供受控嵌入和故障注入测试替换文件系统观察点。 */
  operations?: EsaytreeOperations;
}

export interface CreateWorktreeResult {
  path: string;
  branch: string | null;
  mode: EsaytreeCreateMode;
  cow: boolean;
  cowBackend: CowBackend;
  clones: CloneReport[];
  preservedIgnored: string[];
  skippedIgnored: CloneReport[];
  ms: number;
  fallbackReason?: string;
}

export interface EsaytreeDoctorReport {
  repo: string;
  root: string;
  gitVersion: string;
  cow: boolean;
  cowBackend?: Exclude<CowBackend, "none">;
  cowError?: string;
}

class CowCloneFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CowCloneFailure";
  }
}

/**
 * `cp -c` 在 macOS 上允许静默退回 copyfile，因而它的 0 退出码不能证明 CoW。
 * 这里通过系统自带的 JXA ObjC bridge 直接调用 libSystem 的 clonefile(2)。绑定使用
 * `char *` 和未包装的 JS 路径字符串，读取 C `int` 返回值并额外核验原子目标创建；
 * 没有两项成功绝不报告 `cow: true`。不引入 npm 原生 addon，也不共享可写目录。
 *
 * 每个允许的依赖目录只启动一次 helper；目录层级由 clonefile 原子处理，避免为
 * node_modules 的每个文件启动进程或重写递归复制逻辑。
 */
const MACOS_CLONEFILE_SCRIPT = String.raw`
ObjC.import('Foundation');
// Foundation 不会自动把 libSystem 的 C 符号暴露到 dollar bridge。显式绑定是严格
// clonefile 路径的一部分：没有它就失败并让上层安全降级，绝不退回 cp -c。
ObjC.bindFunction('clonefile', ['int', ['char *', 'char *', 'uint32']]);

const fileManager = $.NSFileManager.defaultManager;
const environment = $.NSProcessInfo.processInfo.environment;
const sourceRoot = ObjC.unwrap(environment.objectForKey($('ESAYTREE_CLONE_SOURCE')));
const destinationRoot = ObjC.unwrap(environment.objectForKey($('ESAYTREE_CLONE_DESTINATION')));

// clonefile 对目录会原子地 clone 整棵层级。不要在 JXA 中重写递归 copy；那既慢又
// 容易破坏 xattr/符号链接语义。dst 原本不存在，调用后必须收到 0 并且实际存在。
if (!sourceRoot || !destinationRoot) throw new Error('missing clonefile source or destination');
if (fileManager.fileExistsAtPath($(destinationRoot))) throw new Error('clonefile destination already exists');
const result = $.clonefile(sourceRoot, destinationRoot, 0);
if (result !== 0 || !fileManager.fileExistsAtPath($(destinationRoot))) {
  throw new Error('clonefile failed to create destination (rc=' + result + ')');
}
`;

function nearestExistingDirectory(value: string): string {
  let cursor = path.resolve(value);
  while (!pathExists(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return cursor;
}

function assertSameVolume(from: string, to: string): void {
  const sourceDevice = statSync(from).dev;
  const destinationDevice = statSync(nearestExistingDirectory(path.dirname(to))).dev;
  if (sourceDevice !== destinationDevice) {
    throw new CowCloneFailure(
      `CoW 源和目标不在同一文件系统（source dev ${String(sourceDevice)}，target dev ${String(destinationDevice)}）`,
    );
  }
}

function cloneWithMacosClonefile(from: string, to: string): void {
  assertSameVolume(from, to);
  try {
    // macOS 自带 /usr/bin/osascript；参数经环境变量传递且完全不经过 shell。
    // clonefile 的返回值是严格语义，区别于 /bin/cp -c 的静默 copyfile fallback。
    execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", MACOS_CLONEFILE_SCRIPT], {
      env: {
        ...process.env,
        ESAYTREE_CLONE_SOURCE: from,
        ESAYTREE_CLONE_DESTINATION: to,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failure = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const detail = String(failure.stderr ?? failure.stdout ?? failure.message ?? error).trim();
    throw new CowCloneFailure(detail || "macOS clonefile failed");
  }
}

function cloneCowPath(
  from: string,
  to: string,
  operations?: EsaytreeOperations,
): Exclude<CowBackend, "none"> {
  try {
    if (operations?.cloneCow) {
      operations.cloneCow(from, to);
      return "injected";
    }
    if (process.platform === "darwin") {
      cloneWithMacosClonefile(from, to);
      return "macos_clonefile";
    }
    // 非 macOS 平台仍保留 Node 的 FORCE 语义；一旦不支持就必须抛错，绝不静默复制。
    if (lstatSync(from).isDirectory()) {
      cpSync(from, to, { recursive: true, mode: constants.COPYFILE_FICLONE_FORCE });
    } else {
      copyFileSync(from, to, constants.COPYFILE_FICLONE_FORCE);
    }
    return "node_copyfile_ficlone";
  } catch (error) {
    if (error instanceof CowCloneFailure) throw error;
    throw new CowCloneFailure(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 用源仓 Git 元数据中的小文件做跨源/目标卷的强制 clonefile 探针。
 * 不能用空仓库“没有文件可复制”来推断 CoW 可用，也不能只在目标卷内部自拷贝，
 * 否则跨卷存储会被误报为可用。
 */
function assertCowAvailable(
  fromRepo: string,
  toDir: string,
  operations?: EsaytreeOperations,
): Exclude<CowBackend, "none"> {
  const dotGit = path.join(fromRepo, ".git");
  const source = lstatSync(dotGit).isFile() ? dotGit : path.join(dotGit, "HEAD");
  const probe = path.join(
    toDir,
    `.esaytree-cow-probe-${String(process.pid)}-${Date.now().toString(36)}`,
  );
  try {
    return cloneCowPath(source, probe, operations);
  } finally {
    rmSync(probe, { force: true });
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      maxBuffer: MAX_GIT_BUFFER,
    });
    return stdout;
  } catch (error) {
    const failure = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const detail = String(failure.stderr ?? failure.stdout ?? failure.message ?? error).trim();
    throw new EsaytreeError(
      `git ${args.slice(0, 2).join(" ")} 失败${detail ? `：${detail}` : ""}`,
      "git_failed",
    );
  }
}

async function tryGit(cwd: string, args: string[]): Promise<boolean> {
  try {
    await exec("git", args, { cwd, maxBuffer: MAX_GIT_BUFFER });
    return true;
  } catch {
    return false;
  }
}

/** 当前工作区的仓库根目录；不在仓库中时返回 null。 */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
    return out.trim() ? canonicalPath(out.trim()) : null;
  } catch {
    return null;
  }
}

export function validateEsaytreeName(name: string): void {
  if (!TASK_NAME.test(name)) {
    throw new EsaytreeError(
      `无效的 esaytree 名称“${name}”；仅允许字母、数字、点、下划线和短横线，且必须以字母或数字开头`,
      "invalid_name",
    );
  }
}

export async function listWorktrees(repo: string): Promise<WorktreeInfo[]> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  const result: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) result.push(finishWorktree(current));
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
    } else if (line === "" && current.path) {
      result.push(finishWorktree(current));
      current = {};
    }
  }
  if (current.path) result.push(finishWorktree(current));
  return result;
}

function finishWorktree(partial: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    path: partial.path ? canonicalPath(partial.path) : "",
    branch: partial.branch ?? null,
    head: partial.head ?? "",
    detached: partial.detached ?? partial.branch === undefined,
    locked: partial.locked ?? false,
    prunable: partial.prunable ?? false,
  };
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    // On Windows the native implementation expands 8.3 aliases such as
    // RUNNER~1. Git reports the long path, while os.tmpdir() may return the
    // short alias; treating those as different loses registered worktrees.
    return realpathSync.native(resolved);
  } catch {
    // 目标尚不存在时也要解析最近的既存祖先。macOS 的 /var → /private/var
    // 会让单纯 path.resolve 得到两个不同字符串，进而漏掉“目标在源目录内”。
    const suffix: string[] = [];
    let cursor = resolved;
    while (!pathExists(cursor)) {
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
    try {
      return path.join(realpathSync.native(cursor), ...suffix);
    } catch {
      return resolved;
    }
  }
}

function pathExists(value: string): boolean {
  try {
    lstatSync(value);
    return true;
  } catch {
    return false;
  }
}

function isSameOrInside(root: string, candidate: string): boolean {
  const rel = path.relative(canonicalPath(root), canonicalPath(candidate));
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

function isStrictlyInside(root: string, candidate: string): boolean {
  const rel = path.relative(canonicalPath(root), canonicalPath(candidate));
  return rel !== "" && !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

interface IgnoredDirectorySelection {
  preserved: string[];
  skipped: CloneReport[];
}

/** 仅复用明确的、可再生成的依赖目录。绝不搬运缓存、构建输出或私有 agent 配置。 */
function isReusableDependencyDir(rel: string): boolean {
  return path.basename(rel) === "node_modules";
}

/**
 * 返回完全被 Git 忽略的目录。`--directory` 会折叠整棵 ignored 子树，避免遍历
 * node_modules 等巨型目录；`-z` 让空格和换行文件名也能被无损解析。
 *
 * 不再把“git ignored”等同于“可安全复用”：`build/`、`.cache/`、`.expo/`、
 * `ios/build/`、`.claude/` 等可能很大、可再生成或含私有状态的目录都会跳过。
 */
async function selectIgnoredDirs(repo: string): Promise<IgnoredDirectorySelection> {
  const out = await git(repo, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--directory",
    "--exclude-standard",
  ]);
  const allIgnored = out
    .split("\0")
    .map((line) => line.endsWith("/") ? line.slice(0, -1) : line)
    .filter((line) => line !== "")
    .filter((rel) => {
      if (!isStrictlyInside(repo, path.join(repo, rel))) return false;
      try {
        return statSync(path.join(repo, rel)).isDirectory();
      } catch {
        return false;
      }
    });
  const preserved: string[] = [];
  const skipped: CloneReport[] = [];
  for (const rel of allIgnored) {
    if (isReusableDependencyDir(rel)) {
      preserved.push(rel);
    } else {
      skipped.push({
        dir: rel,
        cow: false,
        strategy: "skipped",
        ms: 0,
        reason: "默认仅复用明确依赖目录 node_modules；构建产物、缓存和私有配置不会带入工作树",
      });
    }
  }
  return { preserved, skipped };
}

/** 兼容公开 API：只返回默认允许复用的依赖目录。 */
export async function ignoredDirs(repo: string): Promise<string[]> {
  return (await selectIgnoredDirs(repo)).preserved;
}

function configuredLimit(value: number | undefined, envName: string, fallback: number): number {
  if (value !== undefined) return Math.max(0, Math.floor(value));
  const raw = process.env[envName]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function availableBytesAt(value: string, operations?: EsaytreeOperations): number {
  if (operations?.availableBytes) return operations.availableBytes(value);
  const stats = statfsSync(nearestExistingDirectory(value));
  return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * 统计逻辑字节数，而不是 `du` 的已分配块。这样对稀疏文件和 APFS 已有 clone 都是
 * 保守估算；宁可少复用一个可重装依赖，也不能按已共享块数把目标卷打满。
 */
function estimateDirectoryBytes(source: string, stopAfter = Number.MAX_SAFE_INTEGER): number {
  let total = 0;
  const pending = [source];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const status = lstatSync(current);
    if (status.isDirectory()) {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        pending.push(path.join(current, entry.name));
      }
    } else if (status.isFile()) {
      total += status.size;
      if (!Number.isSafeInteger(total)) {
        throw new Error(`目录过大，无法安全估算：${source}`);
      }
      // 一旦已经确定会越过实体复制上限/可用空间预算，就不再遍历余下的 node_modules。
      if (total > stopAfter) return total;
    }
    // symlink 只复制链接文本，不跟随其指向内容；无需计入可用空间预算。
  }
  return total;
}

export interface PhysicalCopyPreflight {
  approved: Map<string, number>;
  skipped: CloneReport[];
}

function skippedReport(dir: string, reason: string, bytes?: number): CloneReport {
  return {
    dir,
    cow: false,
    strategy: "skipped",
    ms: 0,
    ...(bytes === undefined ? {} : { bytes }),
    reason,
    error: reason,
  };
}

/** 在写任何一个 ignored 目录前完成容量预检，避免“复制到一半才发现磁盘满”。 */
export function preflightPhysicalIgnoredCopy(
  from: string,
  to: string,
  dirs: string[],
  opts: Pick<CreateWorktreeInput, "maxFallbackCopyBytes" | "minFreeBytes" | "operations"> = {},
): PhysicalCopyPreflight {
  const maxBytes = configuredLimit(
    opts.maxFallbackCopyBytes,
    "ESAYTREE_MAX_FALLBACK_COPY_BYTES",
    DEFAULT_MAX_FALLBACK_COPY_BYTES,
  );
  const minFreeBytes = configuredLimit(
    opts.minFreeBytes,
    "ESAYTREE_MIN_FREE_BYTES",
    DEFAULT_MIN_FREE_BYTES,
  );
  const available = availableBytesAt(path.dirname(to), opts.operations);
  if (available < minFreeBytes) {
    const reason = `跳过实体复制：目标卷仅剩 ${formatBytes(available)}，低于 ${formatBytes(minFreeBytes)} 安全保留；请释放空间、改用 CoW 或重新安装依赖`;
    return { approved: new Map(), skipped: dirs.map((dir) => skippedReport(dir, reason)) };
  }

  const estimates = new Map<string, number>();
  let total = 0;
  // 空间预算可能比配置上限更紧；任一门槛越界即可立即停止扫描并拒绝全部实体副本。
  const capacityBudget = Math.max(0, available - minFreeBytes);
  const estimateBudget = Math.min(maxBytes, capacityBudget);
  for (const rel of dirs) {
    const source = path.join(from, rel);
    if (!existsSync(source)) continue;
    try {
      const bytes = estimateDirectoryBytes(source, Math.max(0, estimateBudget - total));
      estimates.set(rel, bytes);
      total += bytes;
    } catch (error) {
      const reason = `跳过实体复制：无法安全估算 ${rel}（${error instanceof Error ? error.message : String(error)}）`;
      return { approved: new Map(), skipped: dirs.map((dir) => skippedReport(dir, reason)) };
    }
    if (total > maxBytes) {
      const reason = `跳过实体复制：候选依赖至少 ${formatBytes(total)}，超过本次 ${formatBytes(maxBytes)} 上限；可设置 ESAYTREE_MAX_FALLBACK_COPY_BYTES 或在目标工作树重新安装依赖`;
      return {
        approved: new Map(),
        skipped: dirs.map((dir) => skippedReport(dir, reason, estimates.get(dir))),
      };
    }
    if (total + minFreeBytes > available) {
      const reason = `跳过实体复制：候选依赖至少 ${formatBytes(total)}，复制后将低于 ${formatBytes(minFreeBytes)} 安全保留（当前可用 ${formatBytes(available)}）；请释放空间或重新安装依赖`;
      return {
        approved: new Map(),
        skipped: dirs.map((dir) => skippedReport(dir, reason, estimates.get(dir))),
      };
    }
  }
  return { approved: estimates, skipped: [] };
}

function formatBytes(value: number): string {
  if (value < 1024) return `${String(value)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = -1;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * 单独克隆允许的 ignored 依赖。严格 CoW 总是先尝试；只有实际失败的目录且调用
 * 方显式允许时，才做一次实体复制预检。这样 31 GiB 的 APFS clone 不会因 8 GiB
 * fallback 上限被遍历或拒绝，同时依旧保证任何实体写入前已经过完整空间检查。
 */
export function cloneIgnoredDirs(
  from: string,
  to: string,
  dirs: string[],
  opts: Pick<CreateWorktreeInput,
    "fallbackCopyIgnored" | "maxFallbackCopyBytes" | "minFreeBytes" | "operations"
  > & { allowPhysicalCopy?: boolean } = {},
): CloneReport[] {
  const reports: CloneReport[] = [];
  const allowPhysicalCopy = opts.allowPhysicalCopy ?? opts.fallbackCopyIgnored === true;
  const failedCow: Array<{ dir: string; error: string; started: number }> = [];
  for (const rel of dirs) {
    const src = path.join(from, rel);
    const dst = path.join(to, rel);
    if (!existsSync(src)) continue;
    const started = Date.now();
    mkdirSync(path.dirname(dst), { recursive: true });
    try {
      const backend = cloneCowPath(src, dst, opts.operations);
      reports.push({
        dir: rel,
        cow: true,
        strategy: "cow",
        ms: Date.now() - started,
        reason: `严格 CoW：${backend}`,
      });
    } catch (cowError) {
      // clonefile/Node FORCE 可能创建了一部分树；删除后才可安全选择实体 fallback。
      rmSync(dst, { recursive: true, force: true });
      failedCow.push({
        dir: rel,
        error: cowError instanceof Error ? cowError.message : String(cowError),
        started,
      });
    }
  }

  if (failedCow.length === 0) return reports;
  if (!allowPhysicalCopy) {
    reports.push(...failedCow.map((failed) => ({
      ...skippedReport(
        failed.dir,
        `跳过实体复制：严格 CoW 不可用（${failed.error}），且 fallback 实体复制未显式启用；工作树保持隔离，可在其中重新安装依赖`,
      ),
      ms: Date.now() - failed.started,
    })));
    return reports;
  }

  // 必须在任何实体写入之前对 *所有* CoW 失败候选做一次总量/可用空间检查。
  const preflight = preflightPhysicalIgnoredCopy(from, to, failedCow.map((failed) => failed.dir), opts);
  if (preflight.skipped.length > 0) {
    reports.push(...preflight.skipped);
    return reports;
  }
  for (const failed of failedCow) {
    const src = path.join(from, failed.dir);
    const dst = path.join(to, failed.dir);
    try {
      mkdirSync(path.dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true });
      reports.push({
        dir: failed.dir,
        cow: false,
        strategy: "copy",
        ms: Date.now() - failed.started,
        ...(preflight.approved.has(failed.dir) ? { bytes: preflight.approved.get(failed.dir)! } : {}),
        reason: `实体复制（已通过容量预检；CoW 原因：${failed.error}）`,
      });
    } catch (copyError) {
      rmSync(dst, { recursive: true, force: true });
      const reason = copyError instanceof Error ? copyError.message : String(copyError);
      reports.push({
        dir: failed.dir,
        cow: false,
        strategy: "skipped",
        ms: Date.now() - failed.started,
        ...(preflight.approved.has(failed.dir) ? { bytes: preflight.approved.get(failed.dir)! } : {}),
        reason,
        error: reason,
      });
    }
  }
  return reports;
}

function addArgs(
  target: string,
  baseRef: string,
  branch: string | undefined,
  noCheckout: boolean,
): string[] {
  const args = ["worktree", "add"];
  if (noCheckout) args.push("--no-checkout");
  if (branch) args.push("-b", branch);
  else args.push("--detach");
  args.push(target, baseRef);
  return args;
}

async function rollbackCreatedWorktree(
  repo: string,
  target: string,
  branch: string | undefined,
): Promise<void> {
  await tryGit(repo, ["worktree", "remove", "--force", target]);
  // 目标在调用前已确认不存在，因此这里只会清理由本次 create 留下的残片。
  if (pathExists(target)) rmSync(target, { recursive: true, force: true });
  await tryGit(repo, ["worktree", "prune"]);
  if (branch) await tryGit(repo, ["branch", "-D", "--", branch]);
}

export function defaultWorktreeRoot(repo: string): string {
  const configured = process.env["ESAYTREE_ROOT"]?.trim();
  const normalizedRepo = canonicalPath(repo);
  if (configured) return path.join(canonicalPath(configured), path.basename(normalizedRepo));
  return path.join(
    path.dirname(normalizedRepo),
    ".prospero-worktrees",
    path.basename(normalizedRepo),
  );
}

export async function createWorktree(input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
  const started = Date.now();
  validateEsaytreeName(input.name);
  const root = await repoRoot(input.repo);
  if (!root) throw new EsaytreeError(`${input.repo} 不在 Git 仓库中`, "not_a_repo");

  const target = path.resolve(input.at ?? path.join(defaultWorktreeRoot(root), input.name));
  if (canonicalPath(target) === canonicalPath(root) || isSameOrInside(path.join(root, ".git"), target)) {
    throw new EsaytreeError(`拒绝把 esaytree 建在源仓或 .git 内：${target}`, "unsafe_path");
  }
  if (pathExists(target)) {
    throw new EsaytreeError(`目标已存在：${target}`, "worktree_exists");
  }

  const branch = input.branch;
  const baseRef = input.baseRef?.trim() || "HEAD";
  const keepIgnored = input.cloneIgnored !== false;
  const ignored = keepIgnored
    ? await selectIgnoredDirs(root)
    : { preserved: [], skipped: [] } satisfies IgnoredDirectorySelection;
  const dirs = ignored.preserved;
  mkdirSync(path.dirname(target), { recursive: true });

  let added = false;
  try {
    // Git 只检出已提交 tracked 文件；它不会把 ignored/private 目录带进目标。
    // 大型依赖随后仅通过 allowlist 的严格 CoW 复制，避免整仓 clone 的短暂泄漏。
    await git(root, addArgs(target, baseRef, branch, false));
    added = true;
    let probeBackend: Exclude<CowBackend, "none"> | null = null;
    let cowFailure: string | null = null;
    try {
      probeBackend = assertCowAvailable(root, target, input.operations);
    } catch (error) {
      cowFailure = error instanceof Error ? error.message : String(error);
      if (input.fallbackToCheckout === false) {
        throw new EsaytreeError(`当前文件系统无法完成 CoW 克隆：${cowFailure}`, "cow_unavailable");
      }
    }

    const clones = keepIgnored
      ? cloneIgnoredDirs(root, target, dirs, {
          ...(input.fallbackCopyIgnored === true ? { allowPhysicalCopy: true } : {}),
          ...(input.maxFallbackCopyBytes === undefined
            ? {}
            : { maxFallbackCopyBytes: input.maxFallbackCopyBytes }),
          ...(input.minFreeBytes === undefined ? {} : { minFreeBytes: input.minFreeBytes }),
          ...(input.operations ? { operations: input.operations } : {}),
        })
      : [];
    const nonCow = clones.filter((item) => item.strategy !== "cow");
    if (input.fallbackToCheckout === false && nonCow.length > 0) {
      throw new EsaytreeError(
        `当前文件系统无法完成 CoW 克隆：${nonCow.map((item) => item.reason ?? item.dir).join("；")}`,
        "cow_unavailable",
      );
    }
    const preservedIgnored = clones
      .filter((item) => item.strategy === "cow" || item.strategy === "copy")
      .map((item) => item.dir);
    const skippedIgnored = [
      ...ignored.skipped,
      ...clones.filter((item) => item.strategy === "skipped"),
    ];
    const cow = dirs.length > 0 && clones.length === dirs.length && nonCow.length === 0;
    const cloneFailure = nonCow.map((item) => item.reason).filter((reason): reason is string => Boolean(reason));
    return {
      path: target,
      branch: branch ?? null,
      mode: "git-checkout",
      cow,
      cowBackend: cow ? (probeBackend ?? "none") : "none",
      clones: [...clones, ...ignored.skipped],
      preservedIgnored,
      skippedIgnored,
      ms: Date.now() - started,
      ...((cowFailure || cloneFailure.length > 0)
        ? { fallbackReason: [cowFailure, ...cloneFailure].filter(Boolean).join("；") }
        : {}),
    };
  } catch (error) {
    if (added) await rollbackCreatedWorktree(root, target, branch);
    throw error;
  }
}

/** esaytree 的品牌化入口；createWorktree 保留给已有编排调用方兼容。 */
export const createEsaytree = createWorktree;

export async function listManagedWorktrees(repo: string): Promise<ManagedWorktreeInfo[]> {
  const root = await repoRoot(repo);
  if (!root) throw new EsaytreeError(`${repo} 不在 Git 仓库中`, "not_a_repo");
  const managedRoot = defaultWorktreeRoot(root);
  const result: ManagedWorktreeInfo[] = [];
  for (const worktree of await listWorktrees(root)) {
    if (!isStrictlyInside(managedRoot, worktree.path)) continue;
    const name = path.relative(canonicalPath(managedRoot), canonicalPath(worktree.path));
    if (name.includes(path.sep) || !TASK_NAME.test(name)) continue;
    result.push({ ...worktree, name });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveManagedWorktree(repo: string, name: string): Promise<ManagedWorktreeInfo> {
  validateEsaytreeName(name);
  const root = await repoRoot(repo);
  if (!root) throw new EsaytreeError(`${repo} 不在 Git 仓库中`, "not_a_repo");
  const managedRoot = defaultWorktreeRoot(root);
  const target = path.join(managedRoot, name);
  if (!pathExists(target) || !isStrictlyInside(managedRoot, target)) {
    throw new EsaytreeError(`esaytree 不存在：${name}`, "worktree_missing");
  }
  const canonicalTarget = canonicalPath(target);
  const worktree = (await listWorktrees(root)).find(
    (candidate) => canonicalPath(candidate.path) === canonicalTarget,
  );
  if (!worktree) throw new EsaytreeError(`esaytree 未登记或已损坏：${name}`, "worktree_missing");
  return { ...worktree, name };
}

/**
 * 移除一个已登记 worktree。默认保留分支；显式 deleteBranch 才丢弃分支历史。
 */
export async function removeWorktree(
  repo: string,
  target: string,
  opts: { force?: boolean; deleteBranch?: boolean } = {},
): Promise<void> {
  const root = await repoRoot(repo);
  if (!root) throw new EsaytreeError(`${repo} 不在 Git 仓库中`, "not_a_repo");
  const canonicalTarget = canonicalPath(target);
  const known = (await listWorktrees(root)).find(
    (worktree) => canonicalPath(worktree.path) === canonicalTarget,
  );
  if (!known) throw new EsaytreeError(`不是本仓已登记的 worktree：${target}`, "worktree_missing");

  const args = ["worktree", "remove"];
  if (opts.force !== false) args.push("--force");
  args.push(target);
  await git(root, args);
  await git(root, ["worktree", "prune"]);
  if (opts.deleteBranch && known.branch?.startsWith("refs/heads/")) {
    await git(root, ["branch", "-D", "--", known.branch.slice("refs/heads/".length)]);
  }
}

export async function removeManagedWorktree(
  repo: string,
  name: string,
  opts: { force?: boolean; deleteBranch?: boolean } = {},
): Promise<void> {
  const task = await resolveManagedWorktree(repo, name);
  await removeWorktree(repo, task.path, opts);
}

/** 检查 Git 仓库和目标文件系统是否支持强制 CoW。 */
export async function diagnoseEsaytree(repo: string): Promise<EsaytreeDoctorReport> {
  const root = await repoRoot(repo);
  if (!root) throw new EsaytreeError(`${repo} 不在 Git 仓库中`, "not_a_repo");
  const gitVersion = (await git(root, ["--version"])).trim();
  const storageRoot = defaultWorktreeRoot(root);
  mkdirSync(path.dirname(storageRoot), { recursive: true });
  const probe = mkdtempSync(path.join(path.dirname(storageRoot), ".esaytree-doctor-"));
  let cow = false;
  let cowBackend: Exclude<CowBackend, "none"> | undefined;
  let cowError: string | undefined;
  try {
    try {
      cowBackend = assertCowAvailable(root, probe);
      cow = true;
    } catch (error) {
      cowError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  return {
    repo: root,
    root: storageRoot,
    gitVersion,
    cow,
    ...(cowBackend ? { cowBackend } : {}),
    ...(cowError ? { cowError } : {}),
  };
}
