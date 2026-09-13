export type AgentKind = "codex" | "claude" | "opencode" | "deepseek" | "grok" | "trae" | "shell" | "custom";
export type SessionKind = "structured" | "pty";
export type SessionLifecycle = "active" | "archived";
export type SessionStatus = "idle" | "starting" | "running" | "waiting_permission" | "waiting_input" | "completed" | "failed";
export type SessionHead = { id: string, agent: AgentKind, kind: SessionKind, title: string, workspace: string, lifecycle: SessionLifecycle, status: SessionStatus, createdAt: number, updatedAt: number, revision: number, };
export type CreateSession = { agent: AgentKind, kind: SessionKind, title: string, workspace: string, };
export type UpdateSession = { revision: number, title: string | null, lifecycle: SessionLifecycle | null, status: SessionStatus | null, };
export type SessionQuery = { cursor: string | null, limit: number | null, lifecycle: SessionLifecycle | null, workspace: string | null, text: string | null, };
export type SessionPage = { items: Array<SessionHead>, nextCursor: string | null, previousCursor: string | null, hasMore: boolean, total: number, latestSeq: number, };
export type SessionSummary = { revision: number, total: number, active: number, archived: number, attention: number, latestSeq: number, };
export type WorkspaceQuery = { cursor: string | null, limit: number | null, };
export type WorkspaceHead = { workspace: string, summary: SessionSummary, };
export type WorkspacePage = { items: Array<WorkspaceHead>, nextCursor: string | null, hasMore: boolean, latestSeq: number, };
export type SessionLookup = { ids: Array<string>, };
export type SessionLookupResult = { items: Array<SessionHead>, missingIds: Array<string>, latestSeq: number, };
export type ChangeEvent = { scope: string, seq: number, kind: string, entityId: string, data: unknown, };
export type EventPage = { items: Array<ChangeEvent>, nextSeq: number, latestSeq: number, floorSeq: number, hasMore: boolean, resyncRequired: boolean, };
export type Health = { apiVersion: number, backend: string, activeRuntimeSessions: number, databaseQueueCapacity: number, capabilities: Array<string>, };
export type RenameSession = { revision: number, title: string, };
export type EventQuery = { scope: string, afterSeq: number | null, limit: number | null, };
export type ResyncRequired = { scope: string, latestSeq: number, floorSeq: number, };
export type ContentHead = { id: string, bytes: number, };
export type ContentPage = { items: Array<ContentHead>, nextCursor: string | null, hasMore: boolean, };
export type MessageRole = "user" | "assistant";
export type ToolState = "running" | "success" | "failed";
export type QuestionOption = { label: string, description: string | null, preview: string | null, };
export type AgentQuestion = { id: string, header: string, question: string, options: Array<QuestionOption>, multiSelect: boolean, allowOther: boolean, };
export type MessageAttachment = { id: string, mimeType: string, name: string | null, };
export type TimelineBody = { "kind": "message", role: MessageRole, finalAnswer: boolean, attachments?: Array<MessageAttachment>, } | { "kind": "reasoning" } | { "kind": "tool", name: string, state: ToolState, summary: string, } | { "kind": "permission_request", requestId: string, tool: string, resolved: boolean, 
/**
 * Set when the approval belongs to a Task-tool subagent; the event
 * still shows on the main timeline so it can be answered there.
 */
subagent: string | null, } | { "kind": "question", requestId: string, questions: Array<AgentQuestion>, resolved: boolean, subagent: string | null, } | { "kind": "turn_end", finish: string, } | { "kind": "subagent", subagentId: string, name: string, role: string | null, task: string | null, status: string, canMessage: boolean, summary: string, createdAt: number, updatedAt: number, } | { "kind": "error" };
export type TimelineRecord = { id: string, turnId: string, position: number, revision: number, body: TimelineBody, preview: string, bytes: number, generation: number, truncated: boolean, };
export type TimelineWrite = { id: string, turnId: string, expectedRevision: number, body: TimelineBody, text: string, replace: boolean, };
export type TimelineQuery = { before: number | null, after: number | null, limit: number | null, };
export type TimelinePage = { items: Array<TimelineRecord>, older: number | null, newer: number | null, latestPosition: number, revision: number, };
export type TimelineLookupResult = { items: Array<TimelineRecord>, latestPosition: number, revision: number, };
export type TimelineTextQuery = { part: number | null, generation: number | null, };
export type TimelineTextPage = { text: string, part: number, nextPart: number | null, previousPart: number | null, totalBytes: number, generation: number, };
export type CreateTerminal = { title: string, workspace: string, size: TerminalSize, agent?: AgentKind | null, command?: string | null, accountId?: string | null, model?: string | null, effort?: string | null, };
export type TerminalSize = { cols: number, rows: number, };
export type TerminalEvent = { "type": "output", dataB64: string, } | { "type": "resize", size: TerminalSize, };
export type TerminalQuery = { afterSeq: number | null, waitMs: number | null, };
export type TerminalPage = { initialSize: TerminalSize, baseSeq: number, nextSeq: number, latestSeq: number, floorSeq: number, events: Array<TerminalEvent>, resyncRequired: boolean, exited: boolean, exitCode: number | null, };
export type TerminalInput = { dataB64: string, };
export type TerminalSnapshot = { seq: number, size: TerminalSize, dataB64: string, };
export type CreateAgentSession = { agent: AgentKind, title: string, workspace: string, autoApprove: boolean, 
/**
 * Optional initial collaboration mode for structured Claude sessions.
 */
mode?: string | null, 
/**
 * Optional launch catalog selection (native CLI aliases / ids).
 */
model?: string | null, effort?: string | null, 
/**
 * Managed account id; None (or the native id) uses the本机默认环境.
 */
accountId?: string | null, 
/**
 * Agent-native local conversation to resume at launch.
 */
resume?: ResumeInput | null, };
export type ResumeInput = { 
/**
 * Agent-native conversation/session id to attach on the first turn.
 */
id: string, title?: string | null, 
/**
 * Kept for protocol parity; Rust/Claude rejects forked resume like TS.
 */
fork?: boolean | null, };
export type ResumableConversation = { id: string, agent: AgentKind, title: string, preview?: string | null, cwd: string, createdAt?: number | null, updatedAt: number, };
export type ConversationSearchResult = { agent: AgentKind, conversations: Array<ResumableConversation>, };
export type AttachmentChunk = { mimeType: string, dataB64: string, total: number, eof: boolean, };
export type LaunchModelInfo = { id: string, label: string, description?: string | null, supportedEfforts: Array<string>, isDefault?: boolean, };
export type LaunchModelCatalog = { models: Array<LaunchModelInfo>, currentModel: string | null, };
export type AgentModelSelection = { model: string, effort: string | null, };
export type AgentModelSelectionResult = { currentModel: string, currentEffort: string | null, };
export type AgentControlResult = { type: string, sid: string, requestId: string, action: string, ok: boolean, message: string | null, };
export type AgentCompactRequest = { requestId: string, };
export type ApprovalPolicySelection = { policy: string, };
export type AgentModelCatalog = { models: Array<LaunchModelInfo>, currentModel: string | null, currentEffort: string | null, };
export type SessionAgentControls = { sessionId: string, compact: boolean, model: boolean, mode: boolean, currentModel: string | null, currentEffort: string | null, currentMode: string | null, };
export type AgentControlsProjection = { controls: Array<SessionAgentControls>, };
export type AttachmentInput = { mimeType: string, dataB64: string, name?: string | null, };
export type AgentSend = { text: string, 
/**
 * `steer` tries to guide the running turn live and falls back to the
 * front of the queue; anything else enqueues normally (FIFO).
 */
delivery: string | null, attachments: Array<AttachmentInput>, };
export type QueuedMessage = { id: string, text: string, 
/**
 * `guide` rows jump the front of the queue ("现在引导").
 */
kind: string, createdAt: number, 
/**
 * Number of images parked with the message (bytes are never projected).
 */
attachmentCount: number, };
export type AgentQueue = { sessionId: string, items: Array<QueuedMessage>, };
export type AgentQueues = { queues: Array<AgentQueue>, };
export type UsageWindow = { label: string, utilization: number, resetsAt?: string | null, };
export type UsageDailyBucket = { date: string, tokens: number, };
export type UsageReport = { subscription?: string | null, costUsd?: number | null, inputTokens?: number | null, outputTokens?: number | null, lifetimeTokens?: number | null, creditsUnlimited?: boolean | null, creditsBalance?: string | null, spendLimit?: string | null, spendUsed?: string | null, spendRemainingPercent?: number | null, dailyUsage?: Array<UsageDailyBucket> | null, windows: Array<UsageWindow>, };
export type UsageAccount = { agent: AgentKind, accountId?: string | null, accountName?: string | null, source?: string | null, available: boolean, reason?: string | null, subscription?: string | null, costUsd?: number | null, inputTokens?: number | null, outputTokens?: number | null, lifetimeTokens?: number | null, creditsUnlimited?: boolean | null, creditsBalance?: string | null, spendLimit?: string | null, spendUsed?: string | null, spendRemainingPercent?: number | null, dailyUsage?: Array<UsageDailyBucket> | null, windows: Array<UsageWindow>, };
export type UsageResult = { type: string, sid?: string | null, available: boolean, reason?: string | null, accounts?: Array<UsageAccount> | null, subscription?: string | null, costUsd?: number | null, inputTokens?: number | null, outputTokens?: number | null, lifetimeTokens?: number | null, creditsUnlimited?: boolean | null, creditsBalance?: string | null, spendLimit?: string | null, spendUsed?: string | null, spendRemainingPercent?: number | null, dailyUsage?: Array<UsageDailyBucket> | null, windows: Array<UsageWindow>, };
export type PermissionDecision = { requestId: string, allow: boolean, };
export type QuestionAnswer = { questionId: string, values: Array<string>, };
export type QuestionDecision = { requestId: string, answers: Array<QuestionAnswer>, cancelled: boolean, };
export type AgentModeSelection = { mode: string, };
export type AgentModeCatalog = { modes: Array<AgentModeEntry>, currentMode: string, };
export type AgentModeEntry = { id: string, label: string, description: string, };
export type SubagentInfo = { id: string, name: string, role: string | null, task: string | null, status: string, canMessage: boolean, createdAt: number, updatedAt: number, preview: string | null, };
export type SubagentSnapshot = { subagent: SubagentInfo, events: Array<Record<string, unknown>>, evSeq: number, };
export type RunStatus = "active" | "completed" | "abandoned";
export type TaskStatus = "pending" | "dispatched" | "blocked" | "done" | "failed" | "cancelled";
export type DispatchState = "starting" | "running" | "succeeded" | "failed" | "abandoned";
export type GateStatus = "pending" | "resolved" | "cancelled";
export type MessageType = "note" | "ask" | "reply" | "report";
export type Run = { id: string, objective: string, status: RunStatus, coordinatorSessionId: string | null, graphRevision: number, createdAt: number, updatedAt: number, };
export type Task = { id: string, runId: string, title: string, spec: string, skills: Array<string>, deps: Array<string>, parentId: string | null, status: TaskStatus, result: string | null, createdAt: number, updatedAt: number, };
export type Dispatch = { id: string, runId: string, taskId: string, sessionId: string, state: DispatchState, outcome: string | null, startedAt: number, settledAt: number | null, 
/**
 * Working directory of the worker; for an isolated worker this is the
 * registered worktree path.
 */
worktreePath: string | null, };
export type Gate = { id: string, runId: string, taskId: string | null, question: string, options: Array<string>, status: GateStatus, decision: string | null, createdAt: number, resolvedAt: number | null, };
export type OrchMessage = { id: string, runId: string, from: string, to: string, type: MessageType, subject: string, body: string, threadId: string | null, taskId: string | null, createdAt: number, readAt: number | null, answeredAt: number | null, };
export type RunSnapshot = { run: Run, tasks: Array<Task>, ready: Array<string>, dispatches: Array<Dispatch>, gates: Array<Gate>, };
export type GraphNodeInput = { clientId: string, title: string, spec: string, skills: Array<string>, deps: Array<string>, parentId: string | null, };
export type CreateRunGraph = { objective: string, nodes: Array<GraphNodeInput>, coordinatorSessionId: string | null, 
/**
 * Required so a retried graph creation never makes two runs.
 */
operationId: string, };
export type ApplyTaskGraph = { runId: string, baseRevision: number, nodes: Array<GraphNodeInput>, deleteTaskIds: Array<string>, operationId: string | null, };
export type GraphMutationResult = { run: Run, tasks: Array<Task>, 
/**
 * Maps submitted `clientId` to the durable task id.
 */
idMap: { [key in string]: string }, deletedTaskIds: Array<string>, };
export type DispatchTask = { sessionId: string, operationId: string | null, worktreePath: string | null, };
export type SettleDispatch = { success: boolean, outcome: string, };
export type AbandonDispatch = { reason: string | null, 
/**
 * `failed` (default) or `cancelled`; only used when the task is still
 * dispatched.
 */
finalStatus: string | null, };
export type CompleteRun = { allowFailedTasks: boolean, };
export type AbandonRun = { reason: string | null, };
export type CancelTask = { reason: string | null, };
export type CreateGate = { taskId: string | null, question: string, options: Array<string>, };
export type ResolveGate = { decision: string, };
export type PostMessage = { runId: string, from: string, to: string, type: MessageType, subject: string, body: string, threadId: string | null, taskId: string | null, };
export type MarkMessages = { ids: Array<string>, };
export type SettleOutcome = { task: Task, dispatch: Dispatch, };
export type RecoveryReport = { 
/**
 * Dispatches whose worker session is gone; converged abandoned/failed.
 */
settled: Array<Dispatch>, 
/**
 * `starting` dispatches whose worker survived; promoted to `running`.
 */
resumed: Array<Dispatch>, };
export type WorktreeAssetKind = "run" | "worker";
export type WorktreeAssetState = "active" | "preserved" | "missing" | "dirty" | "unmerged" | "equivalent" | "safe_to_clean" | "cleaned" | "unknown";
export type WorktreeInspection = { state: WorktreeAssetState, targetRef: string, checkedAt: number, pathExists: boolean, registered: boolean | null, dirty: boolean | null, branch: string | null, aheadCommitCount: number | null, equivalentCommitCount: number | null, message: string | null, };
export type WorktreeCleanup = { removedAt: number, branchDeleted: boolean, warning: string | null, };
export type WorktreeAsset = { id: string, kind: WorktreeAssetKind, runId: string, taskId: string | null, dispatchId: string | null, repo: string, path: string, branch: string | null, state: WorktreeAssetState, createdAt: number, updatedAt: number, runDeletedAt: number | null, lastInspection: WorktreeInspection | null, cleanup: WorktreeCleanup | null, lastError: string | null, };
export type WorktreeCleanupResult = { asset: WorktreeAsset, inspection: WorktreeInspection, branchDeleted: boolean, warning: string | null, };
export type CreateRun = { objective: string, coordinatorSessionId: string | null, };
export type CreateTask = { runId: string, title: string, spec: string, skills: Array<string>, deps: Array<string>, parentId: string | null, };
export type DeleteRun = { force: boolean, };
export type RunDeletionResult = { runId: string, deletedTaskCount: number, preservedWorktreeAssetIds: number, };
export type StartWorker = { taskId: string, agent: AgentKind, 
/**
 * Only structured Claude workers are launched today; the wire contract
 * carries the requested agent so unsupported choices fail in Rust instead
 * of being rejected by the desktop bridge.
 */
cwd: string, worktree: string, approvalPolicy: string | null, accountId: string | null, operationId: string | null, };
export type StopWorker = { taskId: string, reason: string | null, 
/**
 * `failed` (default) or `cancelled`.
 */
finalStatus: string | null, };
export type WorkerStartOutcome = { task: Task, dispatch: Dispatch, sessionId: string, worktree: WorktreeAsset | null, };
export type InspectWorktree = { targetRef: string | null, };
export type CleanupWorktree = { targetRef: string | null, 
/**
 * Explicit authorization; without it the directory is never removed.
 */
confirm: boolean, deleteBranch: boolean, };
export type Skill = { name: string, description: string, path: string, scope: string, };
export type SkillSuggestion = { kind: string, value: string, label: string, detail: string, };
export type AccountStatus = "signed_in" | "signed_out" | "unavailable" | "error";
export type AccountCapabilities = { sessionKinds: Array<SessionKind>, plan: boolean, resume: boolean, modelSelection: boolean, reasoningEffort: boolean, };
export type ModelCapabilities = { contextWindow?: number, maxOutputTokens?: number, tools?: boolean | null, vision?: boolean | null, reasoning?: boolean | null, supportedEfforts?: Array<string> | null, };
export type ApiProfile = { provider: string, protocol?: string | null, baseUrl: string, model: string, modelCapabilities?: ModelCapabilities | null, headers?: { [key in string]: string } | null, };
export type Check = "passed" | "failed" | "not_tested";
export type ValidationChecks = { runtime: Check, streaming: Check, tools: Check, };
export type ApiValidation = { status: string, checkedAt: number, engine: string, checks: ValidationChecks, code?: string | null, detail: string, latencyMs?: number, };
export type NativeAccount = { id: string, agent: AgentKind, name: string, managed: boolean, isDefault: boolean, status: AccountStatus, capabilities: AccountCapabilities, apiProfile?: ApiProfile | null, modelSource?: SourceBindingView | null, engine?: string | null, apiValidation?: ApiValidation | null, authMethod?: string | null, detail?: string | null, createdAt: number, updatedAt: number, activeSessions: number, };
export type AccountListResult = { type: string, requestId: string, action: string, ok: boolean, accounts: Array<NativeAccount>, accountId?: string | null, sessionId?: string | null, validation?: ApiValidation | null, };
export type CatalogModel = { id: string, label?: string | null, owner?: string | null, description?: string | null, modelCapabilities?: ModelCapabilities | null, };
export type FeatureError = { code: string, message: string, };
export type ModelsResult = { type: string, requestId: string, ok: boolean, models: Array<CatalogModel>, error?: FeatureError | null, };
export type AccountConfigDocument = { id: string, label: string, format: string, content: string, revision: string, writable: boolean, generated: boolean, editableKeys: Array<string>, };
export type AgentAccountConfig = { accountId: string, documents: Array<AccountConfigDocument>, defaultEffort?: string | null, defaultModel?: string | null, supportedEfforts: Array<string>, appliesTo: string, activeSessions: number, };
export type AccountConfigResult = { type: string, requestId: string, ok: boolean, config?: AgentAccountConfig | null, error?: FeatureError | null, };
export type SourceEndpoint = { protocol: string, baseUrl: string, headers?: { [key in string]: string } | null, };
export type SourceCredentialInfo = { id: string, name: string, revision: number, };
export type SourceRoute = { id: string, name: string, model: string, protocol: string, credentialId: string, enabled: boolean, modelCapabilities?: ModelCapabilities | null, defaultEffort?: string | null, };
export type ModelSource = { id: string, name: string, revision: number, enabled: boolean, endpoints: Array<SourceEndpoint>, credentials: Array<SourceCredentialInfo>, routes: Array<SourceRoute>, defaultRouteId?: string | null, createdAt: number, updatedAt: number, };
export type SourceBindingView = { sourceId: string, routeId: string, revision: number, sourceName: string, routeName: string, legacy: boolean, current: boolean, };
export type SourceMigrationAccount = { id: string, name: string, model: string, };
export type SourceMigration = { id: string, name: string, protocol: string, baseUrl: string, credentialCount: number, accounts: Array<SourceMigrationAccount>, };
export type SourceResult = { type: string, requestId: string, ok: boolean, sources?: Array<ModelSource> | null, models?: Array<CatalogModel> | null, migrations?: Array<SourceMigration> | null, skippedAccounts?: number | null, accountId?: string | null, accounts?: Array<NativeAccount> | null, error?: FeatureError | null, };
export type FsEntry = { name: string, kind: string, size: number, mtime: number, };
export type FsListing = { type: string, sid: string, path: string, entries: Array<FsEntry>, };
export type FsContent = { type: string, sid: string, path: string, contentB64: string, size: number, truncated: boolean, binary: boolean, };
export type FsWritten = { type: string, sid: string, path: string, size: number, };
export type FsChunk = { type: string, sid: string, path: string, offset: number, dataB64: string, total: number, eof: boolean, };
export type FsDone = { type: string, sid: string, path: string, op: string, };
export type SearchMatch = { path: string, line: number, column: number, text: string, };
export type SearchResult = { matches: Array<SearchMatch>, scanned: number, skipped: number, truncated: boolean, };
export type ProjectSearchRequest = { query: string, caseSensitive: boolean, wholeWord: boolean, pathFilter: string, };
export type WorkspaceSummaryResult = { type: string, sid: string, requestId: string, branch: string | null, sizeBytes: number | null, sizeComplete: boolean, checkedAt: number, };
export type GitFile = { path: string, originalPath: string | null, index: string, worktree: string, untracked: boolean, };
export type GitStatusResult = { type: string, sid: string, branch: string | null, ahead: number, behind: number, files: Array<GitFile>, staged: boolean, };
export type GitDiffResult = { type: string, sid: string, path: string, patch: string, };
export type GitHistoryEntry = { hash: string, subject: string, author: string, date: string, };
export type GitHistoryResult = { type: string, sid: string, entries: Array<GitHistoryEntry>, };
export type GitDone = { type: string, sid: string, op: string, detail: string | null, };
export type FsPathQuery = { path: string, };
export type FsChunkQuery = { path: string, offset: number, length: number, };
export type GitDiffQuery = { path: string, staged: boolean, };
export type FsWriteRequest = { path: string, contentB64: string, createNew?: boolean | null, expectedVersion?: string | null, };
export type FsPathRequest = { path: string, };
export type FsRenameRequest = { path: string, to: string, };
export type GitStageRequest = { paths: Array<string>, unstage: boolean, };
export type GitCommitRequest = { message: string, };
export type FsPutRequest = { path: string, offset: number, dataB64: string, final: boolean, };
export type ErrorBody = { code: string, message: string, retryable: boolean, };
export const TERMINAL_WIDTH_0: readonly (readonly [number, number])[] = [[0,31],[127,159],[173,173],[768,879],[1155,1161],[1425,1469],[1471,1471],[1473,1474],[1476,1477],[1479,1479],[1541,1541],[1552,1562],[1564,1564],[1611,1631],[1648,1648],[1750,1756],[1759,1764],[1767,1768],[1770,1773],[1807,1807],[1809,1809],[1840,1866],[1958,1968],[2027,2035],[2045,2045],[2070,2073],[2075,2083],[2085,2087],[2089,2093],[2137,2139],[2192,2193],[2200,2207],[2250,2306],[2362,2362],[2364,2364],[2369,2376],[2381,2381],[2385,2391],[2402,2403],[2433,2433],[2492,2492],[2494,2494],[2497,2500],[2509,2509],[2519,2519],[2530,2531],[2558,2558],[2561,2562],[2620,2620],[2625,2626],[2631,2632],[2635,2637],[2641,2641],[2672,2673],[2677,2677],[2689,2690],[2748,2748],[2753,2757],[2759,2760],[2765,2765],[2786,2787],[2810,2815],[2817,2817],[2876,2876],[2878,2879],[2881,2884],[2893,2893],[2901,2903],[2914,2915],[2946,2946],[3006,3006],[3008,3008],[3021,3021],[3031,3031],[3072,3072],[3076,3076],[3132,3132],[3134,3136],[3142,3144],[3146,3149],[3157,3158],[3170,3171],[3201,3201],[3260,3260],[3263,3264],[3266,3266],[3270,3272],[3274,3277],[3285,3286],[3298,3299],[3328,3329],[3387,3388],[3390,3390],[3393,3396],[3405,3406],[3415,3415],[3426,3427],[3457,3457],[3530,3530],[3535,3535],[3538,3540],[3542,3542],[3551,3551],[3633,3633],[3636,3642],[3655,3662],[3761,3761],[3764,3772],[3784,3790],[3864,3865],[3893,3893],[3895,3895],[3897,3897],[3953,3966],[3968,3972],[3974,3975],[3981,3991],[3993,4028],[4038,4038],[4141,4144],[4146,4151],[4153,4154],[4157,4158],[4184,4185],[4190,4192],[4209,4212],[4226,4226],[4229,4230],[4237,4237],[4253,4253],[4448,4607],[4957,4959],[5906,5908],[5938,5939],[5970,5971],[6002,6003],[6068,6069],[6071,6077],[6086,6086],[6089,6099],[6109,6109],[6155,6159],[6277,6278],[6313,6313],[6432,6434],[6439,6440],[6450,6450],[6457,6459],[6679,6680],[6683,6683],[6742,6742],[6744,6750],[6752,6752],[6754,6754],[6757,6764],[6771,6780],[6783,6783],[6832,6862],[6912,6915],[6964,6973],[6978,6979],[7019,7027],[7040,7041],[7074,7077],[7080,7081],[7083,7085],[7142,7142],[7144,7145],[7149,7149],[7151,7153],[7212,7219],[7222,7223],[7376,7378],[7380,7392],[7394,7400],[7405,7405],[7412,7412],[7416,7417],[7616,7679],[8203,8207],[8234,8238],[8288,8303],[8400,8432],[11503,11505],[11744,11775],[12330,12335],[12441,12442],[12644,12644],[42607,42610],[42612,42621],[42654,42655],[42736,42737],[43010,43010],[43014,43014],[43019,43019],[43045,43046],[43052,43052],[43204,43205],[43232,43249],[43258,43258],[43263,43263],[43302,43309],[43335,43345],[43392,43394],[43443,43443],[43446,43449],[43452,43453],[43493,43493],[43561,43566],[43569,43570],[43573,43574],[43587,43587],[43596,43596],[43644,43644],[43696,43696],[43698,43700],[43703,43704],[43710,43711],[43713,43713],[43756,43757],[43766,43766],[44005,44005],[44008,44008],[44013,44013],[55216,55238],[55243,55291],[64286,64286],[65024,65039],[65056,65071],[65279,65279],[65438,65440],[65520,65528],[66045,66045],[66272,66272],[66422,66426],[68097,68099],[68101,68102],[68108,68111],[68152,68154],[68159,68159],[68325,68326],[68900,68903],[69291,69292],[69373,69375],[69446,69456],[69506,69509],[69633,69633],[69688,69702],[69744,69744],[69747,69748],[69759,69761],[69811,69814],[69817,69818],[69826,69826],[69888,69890],[69927,69931],[69933,69940],[70003,70003],[70016,70017],[70070,70078],[70082,70083],[70089,70092],[70095,70095],[70191,70193],[70196,70196],[70198,70199],[70206,70206],[70209,70209],[70367,70367],[70371,70378],[70400,70401],[70459,70460],[70462,70462],[70464,70464],[70487,70487],[70502,70508],[70512,70516],[70712,70719],[70722,70724],[70726,70726],[70750,70750],[70832,70832],[70835,70840],[70842,70842],[70845,70845],[70847,70848],[70850,70851],[71087,71087],[71090,71093],[71100,71101],[71103,71104],[71132,71133],[71219,71226],[71229,71229],[71231,71232],[71339,71339],[71341,71341],[71344,71349],[71351,71351],[71453,71455],[71458,71461],[71463,71467],[71727,71735],[71737,71738],[71984,71984],[71995,71996],[71998,71999],[72001,72001],[72003,72003],[72148,72151],[72154,72155],[72160,72160],[72193,72202],[72243,72248],[72250,72254],[72263,72263],[72273,72278],[72281,72283],[72324,72342],[72344,72345],[72752,72758],[72760,72765],[72767,72767],[72850,72871],[72874,72880],[72882,72883],[72885,72886],[73009,73014],[73018,73018],[73020,73021],[73023,73031],[73104,73105],[73109,73109],[73111,73111],[73459,73460],[73472,73474],[73526,73530],[73536,73536],[73538,73538],[78912,78912],[78919,78933],[92912,92916],[92976,92982],[94031,94031],[94095,94098],[94180,94180],[113821,113822],[113824,113827],[118528,118573],[118576,118598],[119141,119141],[119143,119145],[119150,119170],[119173,119179],[119210,119213],[119362,119364],[121344,121398],[121403,121452],[121461,121461],[121476,121476],[121499,121503],[121505,121519],[122880,122886],[122888,122904],[122907,122913],[122915,122916],[122918,122922],[123023,123023],[123184,123190],[123566,123566],[123628,123631],[124140,124143],[125136,125142],[125252,125258],[917504,921599]];
export const TERMINAL_WIDTH_2: readonly (readonly [number, number])[] = [[4352,4447],[6052,6052],[8986,8987],[9001,9002],[9193,9196],[9200,9200],[9203,9203],[9725,9726],[9748,9749],[9800,9811],[9855,9855],[9875,9875],[9889,9889],[9898,9899],[9917,9918],[9924,9925],[9934,9934],[9940,9940],[9962,9962],[9970,9971],[9973,9973],[9978,9978],[9981,9981],[9989,9989],[9994,9995],[10024,10024],[10060,10060],[10062,10062],[10067,10069],[10071,10071],[10133,10135],[10160,10160],[10175,10175],[11035,11036],[11088,11088],[11093,11093],[11904,11929],[11931,12019],[12032,12245],[12272,12329],[12336,12350],[12353,12438],[12443,12543],[12549,12591],[12593,12643],[12645,12686],[12688,12771],[12783,12830],[12832,12871],[12880,19903],[19968,42124],[42128,42182],[43360,43388],[44032,55203],[63744,64255],[65040,65049],[65072,65106],[65108,65126],[65128,65131],[65281,65376],[65504,65510],[94176,94179],[94192,94193],[94208,100343],[100352,101589],[101632,101640],[110576,110579],[110581,110587],[110589,110590],[110592,110882],[110898,110898],[110928,110930],[110933,110933],[110948,110951],[110960,111355],[126980,126980],[127183,127183],[127374,127374],[127377,127386],[127488,127490],[127504,127547],[127552,127560],[127568,127569],[127584,127589],[127744,127776],[127789,127797],[127799,127868],[127870,127891],[127904,127946],[127951,127955],[127968,127984],[127988,127988],[127992,128062],[128064,128064],[128066,128252],[128255,128317],[128331,128334],[128336,128359],[128378,128378],[128405,128406],[128420,128420],[128507,128591],[128640,128709],[128716,128716],[128720,128722],[128725,128727],[128732,128735],[128747,128748],[128756,128764],[128992,129003],[129008,129008],[129292,129338],[129340,129349],[129351,129535],[129648,129660],[129664,129672],[129680,129725],[129727,129733],[129742,129755],[129760,129768],[129776,129784],[131072,196605],[196608,262141]];
