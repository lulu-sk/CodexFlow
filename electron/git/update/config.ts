import fs from "node:fs";
import path from "node:path";
import { toFsPathAbs, toFsPathKey } from "../pathKey";
import { isRebaseConfigValue, parseGitBooleanConfigValue } from "./rebaseConfig";
import { buildRepositoryGraphAsync } from "./repositoryGraph";
import type {
  GitPullCapabilities,
  GitPullOptionKey,
  GitPullOptions,
  GitTrackedRemoteRef,
  GitUpdateConfigRuntime,
  GitUpdateMethod,
  GitUpdateMethodResolution,
  GitUpdateOptionMethod,
  GitUpdateOptions,
  GitUpdateOptionsSnapshot,
  GitUpdateOptionsSource,
  GitUpdateSaveChangesPolicy,
  GitUpdateScopeOptions,
  GitUpdateScopePreview,
  GitUpdateScopePreviewRoot,
  GitUpdateSyncStrategy,
  GitUpdateTrackedBranchApplyResult,
  GitUpdateTrackedBranchIssue,
  GitUpdateTrackedBranchIssueCode,
  GitUpdateTrackedBranchOverride,
  GitUpdateTrackedBranchPreview,
  GitUpdateTrackedBranchRemoteOption,
  GitUpdateTrackedBranchSelection,
} from "./types";

type GitUpdateTrackedBranchAnalysis = {
  branch?: string;
  trackedRemote?: GitTrackedRemoteRef | null;
  remoteOptions: GitUpdateTrackedBranchRemoteOption[];
  suggestedRemote?: string;
  suggestedRemoteBranch?: string;
  suggestedLocalBranchName?: string;
};

type GitUpdateOptionsStore = {
  version: 1;
  options: GitUpdateOptions;
};

const GIT_UPDATE_OPTIONS_STORE_VERSION = 1;
const DEFAULT_GIT_UPDATE_SCOPE_OPTIONS: GitUpdateScopeOptions = {
  syncStrategy: "current",
  linkedRepoRoots: [],
  skippedRepoRoots: [],
  includeNestedRoots: false,
  rootScanMaxDepth: 8,
};
const DEFAULT_GIT_PULL_OPTIONS: GitPullOptions = {
  mode: "merge",
  options: [],
};
const DEFAULT_GIT_UPDATE_OPTIONS: GitUpdateOptions = {
  updateMethod: "merge",
  saveChangesPolicy: "shelve",
  scope: DEFAULT_GIT_UPDATE_SCOPE_OPTIONS,
  pull: DEFAULT_GIT_PULL_OPTIONS,
};
const DEFAULT_GIT_PULL_CAPABILITIES: GitPullCapabilities = {
  noVerify: false,
};
const GIT_PULL_OPTION_ORDER: GitPullOptionKey[] = ["ffOnly", "noFf", "squash", "noCommit", "noVerify"];
const pullCapabilityCache = new Map<string, { expiresAt: number; capabilities: GitPullCapabilities }>();
const PULL_CAPABILITY_CACHE_TTL_MS = 60_000;

/**
 * 返回 Update Project 选项的持久化文件路径。
 */
function getGitUpdateOptionsStorePath(userDataPath: string): string {
  return path.join(userDataPath, "git", "update-options.json");
}

/**
 * 解析持久化 Update Options 允许的更新方式；历史增强值会在后续归一化时降级。
 */
function parseOptionalStoredUpdateMethod(raw: unknown): GitUpdateOptionMethod | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "merge" || value === "rebase") return value;
  return null;
}

/**
 * 解析本次执行允许的更新方式；显式保留 reset 独立入口，但不进入普通持久化设置。
 */
function parseOptionalExecutionUpdateMethod(raw: unknown): GitUpdateMethod | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "merge" || value === "rebase" || value === "reset") return value;
  return null;
}

/**
 * 解析 Pull 选项键，统一兼容内部字段名与 Git CLI 选项文本。
 */
function parseOptionalPullOptionKey(raw: unknown): GitPullOptionKey | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  switch (value) {
    case "rebase":
    case "--rebase":
      return "rebase";
    case "ffonly":
    case "ff-only":
    case "--ff-only":
      return "ffOnly";
    case "noff":
    case "no-ff":
    case "--no-ff":
      return "noFf";
    case "squash":
    case "--squash":
      return "squash";
    case "nocommit":
    case "no-commit":
    case "--no-commit":
      return "noCommit";
    case "noverify":
    case "no-verify":
    case "--no-verify":
      return "noVerify";
    default:
      return null;
  }
}

/**
 * 解析可选的本地改动保存策略；无法识别时返回空。
 */
function parseOptionalSaveChangesPolicy(raw: unknown): GitUpdateSaveChangesPolicy | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "stash" || value === "shelve") return value;
  return null;
}

/**
 * 解析多仓同步策略；无法识别时回退空值，由上层决定是否补默认值。
 */
function parseOptionalSyncStrategy(raw: unknown): GitUpdateSyncStrategy | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "current" || value === "linked") return value;
  return null;
}

/**
 * 把任意输入安全规整为字符串数组，并去重过滤空值。
 */
function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  ));
}

/**
 * 将仓库根路径列表规整为绝对路径并按 path key 去重，避免大小写或分隔符差异导致重复。
 */
function normalizeRepoRootList(raw: unknown): string[] {
  const byKey = new Map<string, string>();
  for (const item of toStringList(raw)) {
    const repoRoot = toFsPathAbs(item);
    const repoKey = toFsPathKey(repoRoot);
    if (!repoKey || byKey.has(repoKey)) continue;
    byKey.set(repoKey, repoRoot);
  }
  return Array.from(byKey.values());
}

/**
 * 约束普通嵌套仓扫描深度，避免异常值导致无界扫描。
 */
function normalizeRootScanMaxDepth(raw: unknown): number {
  return Math.max(0, Math.min(12, Math.floor(Number(raw) || DEFAULT_GIT_UPDATE_SCOPE_OPTIONS.rootScanMaxDepth)));
}

/**
 * 把任意输入规整为稳定的多仓作用域配置对象。
 */
function normalizeGitUpdateScopeOptions(raw: unknown): GitUpdateScopeOptions {
  const input = raw && typeof raw === "object" ? (raw as any) : {};
  return {
    syncStrategy: parseOptionalSyncStrategy(input.syncStrategy) || DEFAULT_GIT_UPDATE_SCOPE_OPTIONS.syncStrategy,
    linkedRepoRoots: normalizeRepoRootList(input.linkedRepoRoots),
    skippedRepoRoots: normalizeRepoRootList(input.skippedRepoRoots),
    includeNestedRoots: input.includeNestedRoots === true,
    rootScanMaxDepth: normalizeRootScanMaxDepth(input.rootScanMaxDepth),
  };
}

/**
 * 判断 Pull 选项是否与当前模式及已接受选项兼容，贴近 IDEA `GitPullOption.isOptionSuitable()` 规则。
 */
function isCompatiblePullOption(
  mode: GitUpdateOptionMethod,
  accepted: GitPullOptionKey[],
  option: GitPullOptionKey,
): boolean {
  if (option === "rebase") return false;
  if (mode === "rebase") return option === "noVerify";
  if (option === "ffOnly") return !accepted.includes("noFf") && !accepted.includes("squash");
  if (option === "noFf") return !accepted.includes("ffOnly") && !accepted.includes("squash");
  if (option === "squash") return !accepted.includes("ffOnly") && !accepted.includes("noFf");
  if (option === "noCommit") return true;
  if (option === "noVerify") return true;
  return true;
}

/**
 * 把任意输入规整为稳定的 Pull 选项对象，并移除互斥组合与重复项。
 */
function normalizeGitPullOptions(raw: unknown): GitPullOptions {
  const input = raw && typeof raw === "object" ? (raw as any) : {};
  const rawOptionKeys = Array.from(new Set(
    (Array.isArray(input.options) ? input.options : [])
      .map((item: unknown) => parseOptionalPullOptionKey(item))
      .filter((item: GitPullOptionKey | undefined): item is GitPullOptionKey => !!item),
  ));
  const mode = parseOptionalStoredUpdateMethod(input.mode) || (rawOptionKeys.includes("rebase") ? "rebase" : DEFAULT_GIT_PULL_OPTIONS.mode);
  const normalizedOptions: GitPullOptionKey[] = [];
  for (const option of GIT_PULL_OPTION_ORDER) {
    if (!rawOptionKeys.includes(option)) continue;
    if (!isCompatiblePullOption(mode, normalizedOptions, option)) continue;
    normalizedOptions.push(option);
  }
  return {
    mode,
    options: normalizedOptions,
  };
}

/**
 * 把任意输入规整为稳定的 Update Project 选项对象。
 */
function normalizeGitUpdateOptions(raw: unknown): GitUpdateOptions {
  const input = raw && typeof raw === "object" ? (raw as any) : {};
  return {
    updateMethod: parseOptionalStoredUpdateMethod(input.updateMethod) || DEFAULT_GIT_UPDATE_OPTIONS.updateMethod,
    saveChangesPolicy: parseOptionalSaveChangesPolicy(input.saveChangesPolicy) || DEFAULT_GIT_UPDATE_OPTIONS.saveChangesPolicy,
    scope: normalizeGitUpdateScopeOptions(input.scope),
    pull: normalizeGitPullOptions(input.pull),
  };
}

/**
 * 判断对象是否显式携带某个字段，避免把默认值误判成调用方显式覆盖。
 */
function hasOwnField(value: unknown, key: string): boolean {
  return !!value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * 从 payload 中提取显式传入的 Update Project 选项覆盖项。
 */
function resolvePayloadUpdateOptions(
  payload: any,
): { selectionSource: GitUpdateOptionsSource; updateMethod?: GitUpdateMethod; saveChangesPolicy?: GitUpdateSaveChangesPolicy } {
  const payloadOptions = (() => {
    if (payload?.options && typeof payload.options === "object") return payload.options;
    if (payload?.updateOptions && typeof payload.updateOptions === "object") return payload.updateOptions;
    return null;
  })();
  const explicitMethod = (() => {
    if (hasOwnField(payloadOptions, "updateMethod")) {
      return parseOptionalExecutionUpdateMethod((payloadOptions as any).updateMethod);
    }
    if (hasOwnField(payload, "updateMethod")) {
      return parseOptionalExecutionUpdateMethod(payload?.updateMethod);
    }
    if (payload?.reset === true) return "reset" satisfies GitUpdateMethod;
    if (payload?.rebase === true) return "rebase" satisfies GitUpdateMethod;
    if (payload?.rebase === false) return "merge" satisfies GitUpdateMethod;
    return null;
  })();
  const explicitSaveChangesPolicy = (() => {
    if (hasOwnField(payloadOptions, "saveChangesPolicy")) {
      return parseOptionalSaveChangesPolicy((payloadOptions as any).saveChangesPolicy);
    }
    if (hasOwnField(payload, "saveChangesPolicy")) {
      return parseOptionalSaveChangesPolicy(payload?.saveChangesPolicy);
    }
    return null;
  })();
  return {
    selectionSource: explicitMethod ? "payload" : "stored",
    updateMethod: explicitMethod || undefined,
    saveChangesPolicy: explicitSaveChangesPolicy || undefined,
  };
}

/**
 * 从 payload 中提取显式传入的多仓作用域覆盖项，供预览与正式保存共用。
 */
function resolvePayloadScopeOptions(payload: any): Partial<GitUpdateScopeOptions> {
  const payloadOptions = (() => {
    if (payload?.options && typeof payload.options === "object") return payload.options;
    if (payload?.updateOptions && typeof payload.updateOptions === "object") return payload.updateOptions;
    return payload && typeof payload === "object" ? payload : null;
  })();
  const scopeInput = payloadOptions?.scope && typeof payloadOptions.scope === "object" ? payloadOptions.scope : payloadOptions;
  if (!scopeInput || typeof scopeInput !== "object") return {};
  const next: Partial<GitUpdateScopeOptions> = {};
  if (hasOwnField(scopeInput, "syncStrategy")) {
    next.syncStrategy = parseOptionalSyncStrategy((scopeInput as any).syncStrategy) || DEFAULT_GIT_UPDATE_SCOPE_OPTIONS.syncStrategy;
  }
  if (hasOwnField(scopeInput, "linkedRepoRoots")) {
    next.linkedRepoRoots = normalizeRepoRootList((scopeInput as any).linkedRepoRoots);
  }
  if (hasOwnField(scopeInput, "skippedRepoRoots")) {
    next.skippedRepoRoots = normalizeRepoRootList((scopeInput as any).skippedRepoRoots);
  }
  if (hasOwnField(scopeInput, "includeNestedRoots")) {
    next.includeNestedRoots = (scopeInput as any).includeNestedRoots === true;
  }
  if (hasOwnField(scopeInput, "rootScanMaxDepth")) {
    next.rootScanMaxDepth = normalizeRootScanMaxDepth((scopeInput as any).rootScanMaxDepth);
  }
  return next;
}

/**
 * 从 payload 中提取 Pull 对话框的显式配置覆盖项；未提供时返回空值。
 */
function resolvePayloadPullOptions(payload: any): GitPullOptions | null {
  const payloadOptions = (() => {
    if (payload?.options && typeof payload.options === "object") return payload.options;
    if (payload?.updateOptions && typeof payload.updateOptions === "object") return payload.updateOptions;
    return payload && typeof payload === "object" ? payload : null;
  })();
  if (!payloadOptions || typeof payloadOptions !== "object") return null;
  const pullInput = payloadOptions.pull && typeof payloadOptions.pull === "object"
    ? payloadOptions.pull
    : null;
  if (!pullInput) return null;
  return normalizeGitPullOptions(pullInput);
}

/**
 * 读取磁盘中的 Update Project 持久化配置；损坏或缺失时回退默认值。
 */
function loadStoredGitUpdateOptions(runtime: GitUpdateConfigRuntime): GitUpdateOptions {
  const storePath = getGitUpdateOptionsStorePath(runtime.userDataPath);
  try {
    if (!fs.existsSync(storePath)) return { ...DEFAULT_GIT_UPDATE_OPTIONS };
    const rawText = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(String(rawText || "")) as GitUpdateOptionsStore;
    if (parsed?.version !== GIT_UPDATE_OPTIONS_STORE_VERSION) return { ...DEFAULT_GIT_UPDATE_OPTIONS };
    const rawOptions = parsed.options && typeof parsed.options === "object" ? parsed.options : {};
    const normalized = normalizeGitUpdateOptions(rawOptions);
    if (
      parseOptionalStoredUpdateMethod((rawOptions as any).updateMethod) !== normalized.updateMethod
      || parseOptionalSaveChangesPolicy((rawOptions as any).saveChangesPolicy) !== normalized.saveChangesPolicy
      || JSON.stringify(normalizeGitUpdateScopeOptions((rawOptions as any).scope)) !== JSON.stringify(normalized.scope)
      || JSON.stringify(normalizeGitPullOptions((rawOptions as any).pull)) !== JSON.stringify(normalized.pull)
    ) {
      saveStoredGitUpdateOptions(runtime, normalized);
    }
    return normalized;
  } catch {
    return { ...DEFAULT_GIT_UPDATE_OPTIONS };
  }
}

/**
 * 把 Update Project 持久化配置写回磁盘，供后续 UI 与执行流程复用。
 */
function saveStoredGitUpdateOptions(runtime: GitUpdateConfigRuntime, options: GitUpdateOptions): void {
  const storePath = getGitUpdateOptionsStorePath(runtime.userDataPath);
  const normalized = normalizeGitUpdateOptions(options);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify({
    version: GIT_UPDATE_OPTIONS_STORE_VERSION,
    options: normalized,
  } satisfies GitUpdateOptionsStore, null, 2), "utf8");
}

/**
 * 探测当前 Git 是否支持 Pull `--no-verify` 选项，并做短时缓存避免频繁执行帮助命令。
 */
async function detectGitPullCapabilitiesAsync(runtime: GitUpdateConfigRuntime, repoRoot: string): Promise<GitPullCapabilities> {
  const cacheKey = toFsPathKey(repoRoot) || repoRoot;
  const cached = pullCapabilityCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.capabilities;

  let capabilities = DEFAULT_GIT_PULL_CAPABILITIES;
  try {
    const helpRes = await runtime.runGitExecAsync(repoRoot, ["pull", "-h"], 10_000);
    const helpText = `${String(helpRes.stdout || "")}\n${String(helpRes.stderr || "")}\n${String(helpRes.error || "")}`.toLowerCase();
    capabilities = {
      noVerify: helpText.includes("--no-verify"),
    };
  } catch {}

  pullCapabilityCache.set(cacheKey, {
    expiresAt: now + PULL_CAPABILITY_CACHE_TTL_MS,
    capabilities,
  });
  return capabilities;
}

/**
 * 判断调用方是否已经显式指定多仓范围，避免把持久化默认值强行覆盖到一次性执行参数上。
 */
function hasExplicitRepositoryScopePayload(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false;
  return toStringList(payload.repoRoots).length > 0
    || toStringList(payload.roots).length > 0
    || toStringList(payload.additionalRepoRoots).length > 0
    || toStringList(payload.skipRoots).length > 0
    || toStringList(payload.skippedRoots).length > 0
    || hasOwnField(payload, "includeNestedRoots")
    || hasOwnField(payload, "includeDiscoveredNestedRoots")
    || hasOwnField(payload, "rootScanMaxDepth");
}

/**
 * 合并持久化与 payload 里的多仓作用域配置，供预览与保存后的执行默认值统一复用。
 */
function resolveEffectiveScopeOptions(
  storedOptions: GitUpdateScopeOptions,
  payload?: any,
): GitUpdateScopeOptions {
  return normalizeGitUpdateScopeOptions({
    ...storedOptions,
    ...resolvePayloadScopeOptions(payload),
    scope: undefined,
  });
}

/**
 * 把多仓作用域配置转换为 repository graph 能直接消费的 payload 字段。
 */
function buildRepositoryScopePayload(
  requestedRepoRoot: string,
  scopeOptions: GitUpdateScopeOptions,
): Record<string, any> {
  const requestedKey = toFsPathKey(requestedRepoRoot);
  const linkedRepoRoots = scopeOptions.syncStrategy === "linked"
    ? scopeOptions.linkedRepoRoots.filter((repoRoot) => toFsPathKey(repoRoot) !== requestedKey)
    : [];
  const skippedRepoRoots = scopeOptions.skippedRepoRoots.filter((repoRoot) => toFsPathKey(repoRoot) !== requestedKey);
  return {
    repoRoots: linkedRepoRoots.length > 0 ? [requestedRepoRoot, ...linkedRepoRoots] : undefined,
    skipRoots: skippedRepoRoots,
    includeNestedRoots: scopeOptions.includeNestedRoots,
    rootScanMaxDepth: scopeOptions.rootScanMaxDepth,
  };
}

/**
 * 把持久化多仓默认值注入到本次 payload，仅在调用方未显式指定范围时生效。
 */
export function applyUpdateOptionsPayloadDefaults(
  requestedRepoRoot: string,
  payload: any,
  options: GitUpdateOptions,
): any {
  const basePayload = payload && typeof payload === "object" ? { ...payload } : {};
  if (hasExplicitRepositoryScopePayload(basePayload)) return basePayload;
  return {
    ...basePayload,
    ...buildRepositoryScopePayload(requestedRepoRoot, options.scope),
  };
}

/**
 * 构建当前多仓默认范围预览，供 Update Options 对话框直接展示“哪些仓会被纳入/跳过”。
 */
async function buildUpdateScopePreviewAsync(
  runtime: GitUpdateConfigRuntime,
  scopeOptions: GitUpdateScopeOptions,
): Promise<GitUpdateScopePreview> {
  const requestedRepoRoot = toFsPathAbs(runtime.repoRoot) || runtime.repoRoot;
  const requestedKey = toFsPathKey(requestedRepoRoot);
  const linkedRootKeys = new Set(scopeOptions.linkedRepoRoots.map((repoRoot) => toFsPathKey(repoRoot)).filter(Boolean));
  const repositoryGraph = await buildRepositoryGraphAsync(runtime, buildRepositoryScopePayload(requestedRepoRoot, scopeOptions));
  const roots: GitUpdateScopePreviewRoot[] = repositoryGraph.roots.map((node) => {
    const repoKey = toFsPathKey(node.repoRoot);
    const source = (() => {
      if (node.kind === "submodule") return "submodule" as const;
      if (repoKey && requestedKey && repoKey === requestedKey) return "current" as const;
      if (repoKey && linkedRootKeys.has(repoKey)) return "linked" as const;
      return "nested" as const;
    })();
    return {
      repoRoot: node.repoRoot,
      rootName: node.rootName,
      kind: node.kind,
      parentRepoRoot: node.parentRepoRoot,
      depth: node.depth,
      detachedHead: node.detachedHead,
      source,
      included: !node.requestedSkip,
    };
  });
  const includedRepoRoots = roots.filter((root) => root.included).map((root) => root.repoRoot);
  return {
    requestedRepoRoot: repositoryGraph.requestedRepoRoot,
    multiRoot: includedRepoRoots.length > 1,
    roots,
    includedRepoRoots,
    skippedRoots: roots
      .map((root, index) => repositoryGraph.roots[index]?.requestedSkip)
      .filter((root): root is NonNullable<typeof repositoryGraph.roots[number]["requestedSkip"]> => !!root),
  };
}

/**
 * 读取 Git config 单值；未配置或读取失败时返回空字符串。
 */
async function getGitConfigValueAsync(runtime: GitUpdateConfigRuntime, repoRoot: string, key: string): Promise<string> {
  const configKey = String(key || "").trim();
  if (!configKey) return "";
  const res = await runtime.runGitExecAsync(repoRoot, ["config", "--get", configKey], 10_000);
  if (!res.ok) return "";
  return String(res.stdout || "").trim();
}

/**
 * 规整 Git 配置中的 remote 名称，过滤空值与本地仓库占位符。
 */
function normalizeGitRemoteName(raw: string): string {
  const value = String(raw || "").trim();
  if (!value || value === ".") return "";
  return value;
}

/**
 * 将 merge 配置规整为远端分支短名。
 */
function normalizeMergeRefBranchName(mergeRef: string, remoteName?: string): string {
  const ref = String(mergeRef || "").trim();
  const remote = String(remoteName || "").trim();
  if (!ref) return "";
  if (remote) {
    const remotePrefix = `refs/remotes/${remote}/`;
    if (ref.startsWith(remotePrefix)) return ref.slice(remotePrefix.length).trim();
  }
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length).trim();
  if (ref.startsWith("refs/remotes/")) {
    const remain = ref.slice("refs/remotes/".length).trim();
    const parsed = parseUpstreamRef(remain, remote ? [remote] : undefined);
    if (parsed) return parsed.branch;
  }
  return ref.replace(/^heads\//, "").replace(/^remotes\//, "").trim();
}

/**
 * 读取仓库远程名列表，失败时返回空数组。
 */
async function listRemoteNamesAsync(runtime: GitUpdateConfigRuntime, repoRoot: string): Promise<string[]> {
  const remoteRes = await runtime.runGitExecAsync(repoRoot, ["remote"], 10_000);
  if (!remoteRes.ok) return [];
  return String(remoteRes.stdout || "")
    .split(/\r?\n/)
    .map((one) => String(one || "").trim())
    .filter(Boolean);
}

/**
 * 读取指定本地分支的上游引用（如 `origin/main`），未配置则返回空字符串。
 */
async function getBranchUpstreamRefAsync(runtime: GitUpdateConfigRuntime, repoRoot: string, branchName: string): Promise<string> {
  const branch = String(branchName || "").trim();
  if (!branch) return "";
  const ref = `refs/heads/${branch}`;
  const res = await runtime.runGitExecAsync(repoRoot, ["for-each-ref", "--format=%(upstream:short)", ref], 10_000);
  if (!res.ok) return "";
  const text = String(res.stdout || "").split(/\r?\n/)[0] || "";
  return String(text).trim();
}

/**
 * 读取指定分支的 merge 配置（如 `refs/heads/main`）。
 */
async function getBranchMergeRefAsync(runtime: GitUpdateConfigRuntime, repoRoot: string, branchName: string): Promise<string> {
  const branch = String(branchName || "").trim();
  if (!branch) return "";
  const res = await runtime.runGitExecAsync(repoRoot, ["config", "--get", `branch.${branch}.merge`], 10_000);
  if (!res.ok) return "";
  return String(res.stdout || "").trim();
}

/**
 * 解析上游引用为 remote/branch 对。
 */
function parseUpstreamRef(upstreamRef: string, remoteNamesInput?: string[] | null): { remote: string; branch: string } | null {
  const upstream = String(upstreamRef || "").trim();
  if (!upstream) return null;
  const remoteNames = Array.from(new Set(
    (remoteNamesInput || [])
      .map((one) => String(one || "").trim())
      .filter(Boolean),
  )).sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (remoteNames.length > 0) {
    for (const remote of remoteNames) {
      const prefix = `${remote}/`;
      if (!upstream.startsWith(prefix)) continue;
      const branch = upstream.slice(prefix.length).trim();
      if (branch) return { remote, branch };
    }
  }
  const idx = upstream.indexOf("/");
  if (idx <= 0 || idx >= upstream.length - 1) return null;
  return {
    remote: upstream.slice(0, idx),
    branch: upstream.slice(idx + 1),
  };
}

/**
 * 解析指定本地分支对应的远端跟踪目标。
 */
async function resolveBranchTrackedRemoteAsync(
  runtime: GitUpdateConfigRuntime,
  repoRoot: string,
  branchName: string,
  remoteNamesInput?: string[] | null,
): Promise<GitTrackedRemoteRef | null> {
  const branch = String(branchName || "").trim();
  if (!branch) return null;
  const remoteNames = Array.from(new Set(
    (Array.isArray(remoteNamesInput) ? remoteNamesInput : await listRemoteNamesAsync(runtime, repoRoot))
      .map((one) => String(one || "").trim())
      .filter(Boolean),
  ));
  const upstream = await getBranchUpstreamRefAsync(runtime, repoRoot, branch);
  const upstreamPair = parseUpstreamRef(upstream, remoteNames);
  if (upstreamPair?.remote && upstreamPair?.branch) {
    return {
      upstream,
      remote: upstreamPair.remote,
      branch: upstreamPair.branch,
    };
  }

  const branchRemote = normalizeGitRemoteName(await getGitConfigValueAsync(runtime, repoRoot, `branch.${branch}.remote`));
  if (!branchRemote || (remoteNames.length > 0 && !remoteNames.includes(branchRemote))) return null;
  const mergeRef = await getBranchMergeRefAsync(runtime, repoRoot, branch);
  const mergeBranch = normalizeMergeRefBranchName(mergeRef, branchRemote);
  if (!mergeBranch) return null;
  return {
    upstream: `${branchRemote}/${mergeBranch}`,
    remote: branchRemote,
    branch: mergeBranch,
  };
}

/**
 * 读取仓库默认远程名，单远程直接返回，多远程优先 `origin`。
 */
async function getPreferredRemoteAsync(runtime: GitUpdateConfigRuntime, repoRoot: string, remoteNamesInput?: string[] | null): Promise<string> {
  const names = Array.from(new Set(
    (Array.isArray(remoteNamesInput) ? remoteNamesInput : await listRemoteNamesAsync(runtime, repoRoot))
      .map((one) => String(one || "").trim())
      .filter(Boolean),
  ));
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] || "";
  const origin = names.find((one) => one === "origin");
  if (origin) return origin;
  return names[0] || "";
}

/**
 * 判断本地是否已存在对应的远端跟踪引用。
 */
async function hasRemoteTrackingRefAsync(
  runtime: GitUpdateConfigRuntime,
  repoRoot: string,
  remote: string,
  branch: string,
): Promise<boolean> {
  const remoteName = String(remote || "").trim();
  const remoteBranch = String(branch || "").trim();
  if (!remoteName || !remoteBranch) return false;
  const res = await runtime.runGitExecAsync(repoRoot, ["rev-parse", "--verify", "-q", `refs/remotes/${remoteName}/${remoteBranch}`], 8_000);
  return res.ok;
}

/**
 * 执行一次定向 fetch/prune 后复核 tracking ref，并在必要时用 `ls-remote` 确认远端分支是否真实存在。
 */
async function verifyTrackedRemoteExistsAsync(
  runtime: GitUpdateConfigRuntime,
  repoRoot: string,
  trackedRemote: GitTrackedRemoteRef,
): Promise<{ ok: true; exists: boolean } | { ok: false; error: string }> {
  runtime.emitProgress?.(repoRoot, "正在刷新远端跟踪分支", trackedRemote.upstream);
  const fetchRes = await runtime.runGitSpawnAsync(repoRoot, ["fetch", "--prune", trackedRemote.remote], 120_000);
  if (!fetchRes.ok) {
    return {
      ok: false,
      error: runtime.toGitErrorMessage(fetchRes, `刷新远端 ${trackedRemote.remote} 失败`),
    };
  }

  if (await hasRemoteTrackingRefAsync(runtime, repoRoot, trackedRemote.remote, trackedRemote.branch)) {
    return { ok: true, exists: true };
  }

  const lsRemoteRes = await runtime.runGitExecAsync(
    repoRoot,
    ["ls-remote", "--heads", trackedRemote.remote, trackedRemote.branch],
    30_000,
  );
  if (!lsRemoteRes.ok) {
    return {
      ok: false,
      error: runtime.toGitErrorMessage(lsRemoteRes, `校验远端分支 ${trackedRemote.upstream} 失败`),
    };
  }
  return {
    ok: true,
    exists: String(lsRemoteRes.stdout || "").trim().length > 0,
  };
}

/**
 * 读取当前 HEAD 分支与 detached 状态。
 */
async function getHeadInfoAsync(runtime: GitUpdateConfigRuntime, repoRoot: string): Promise<{ branch?: string; detached: boolean; headSha?: string }> {
  const branchRes = await runtime.runGitExecAsync(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], 5_000);
  const branch = String(branchRes.stdout || "").trim();
  const detached = !branch;
  const shaRes = await runtime.runGitExecAsync(repoRoot, ["rev-parse", "--short", "HEAD"], 5_000);
  const headSha = shaRes.ok ? String(shaRes.stdout || "").trim() : undefined;
  return {
    branch: branch || undefined,
    detached,
    headSha,
  };
}

/**
 * 将建议的远端分支名规整为本地分支名候选，供 Detached HEAD 修复表单预填。
 */
function normalizeSuggestedLocalBranchName(remoteBranch?: string, headSha?: string): string | undefined {
  const source = String(remoteBranch || "").trim() || (headSha ? `recovered-${headSha}` : "");
  const normalized = source
    .replace(/^refs\/heads\//, "")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "");
  return normalized || undefined;
}

/**
 * 读取当前仓库保存的 Update Project 选项，供 UI 和执行流程共享。
 */
export async function getStoredUpdateOptionsAsync(runtime: GitUpdateConfigRuntime): Promise<GitUpdateOptions> {
  return loadStoredGitUpdateOptions(runtime);
}

/**
 * 按 IDEA `branch.<name>.rebase -> pull.rebase -> merge` 的顺序解析分支默认更新方式。
 */
async function resolveBranchDefaultMethodAsync(
  runtime: GitUpdateConfigRuntime,
  repoRoot: string,
  currentBranch?: string,
): Promise<Pick<GitUpdateMethodResolution, "resolvedMethod" | "resolvedSource" | "branchRebaseKey" | "branchRebaseValue" | "pullRebaseValue">> {
  const branch = String(currentBranch || "").trim();
  const branchRebaseKey = branch ? `branch.${branch}.rebase` : undefined;
  const branchRebaseValue = branchRebaseKey ? await getGitConfigValueAsync(runtime, repoRoot, branchRebaseKey) : "";
  if (branchRebaseValue) {
    if (isRebaseConfigValue(branchRebaseValue)) {
      return {
        resolvedMethod: "rebase",
        resolvedSource: "branch-config",
        branchRebaseKey,
        branchRebaseValue,
      };
    }
    if (parseGitBooleanConfigValue(branchRebaseValue) === false) {
      return {
        resolvedMethod: "merge",
        resolvedSource: "branch-config",
        branchRebaseKey,
        branchRebaseValue,
      };
    }
  }

  const pullRebaseValue = await getGitConfigValueAsync(runtime, repoRoot, "pull.rebase");
  if (pullRebaseValue && isRebaseConfigValue(pullRebaseValue)) {
    return {
      resolvedMethod: "rebase",
      resolvedSource: "pull-config",
      branchRebaseKey,
      branchRebaseValue: branchRebaseValue || undefined,
      pullRebaseValue,
    };
  }

  return {
    resolvedMethod: "merge",
    resolvedSource: "fallback",
    branchRebaseKey,
    branchRebaseValue: branchRebaseValue || undefined,
    pullRebaseValue: pullRebaseValue || undefined,
  };
}

/**
 * 汇总 payload 覆盖项、持久化设置与 Git config，得到本次 Update Project 的生效选项快照。
 */
export async function getUpdateOptionsSnapshotAsync(
  runtime: GitUpdateConfigRuntime,
  payload?: any,
): Promise<GitUpdateOptionsSnapshot> {
  const repoRoot = toFsPathAbs(runtime.repoRoot) || runtime.repoRoot;
  const storedOptions = loadStoredGitUpdateOptions(runtime);
  const pullOptions = resolvePayloadPullOptions(payload) || normalizeGitPullOptions(storedOptions.pull);
  const payloadOptions = resolvePayloadUpdateOptions(payload);
  const scopeOptions = resolveEffectiveScopeOptions(storedOptions.scope, payload);
  const selectedMethod = payloadOptions.updateMethod || storedOptions.updateMethod;
  const saveChangesPolicy = payloadOptions.saveChangesPolicy || storedOptions.saveChangesPolicy;
  const previewUpdateMethod = (() => {
    const payloadInput = payload?.options && typeof payload.options === "object"
      ? payload.options
      : payload?.updateOptions && typeof payload.updateOptions === "object"
        ? payload.updateOptions
        : payload;
    return parseOptionalStoredUpdateMethod(payloadInput?.updateMethod) || storedOptions.updateMethod;
  })();
  const options: GitUpdateOptions = {
    updateMethod: previewUpdateMethod,
    saveChangesPolicy,
    scope: scopeOptions,
    pull: pullOptions,
  };
  const headInfo = await getHeadInfoAsync(runtime, repoRoot);
  const currentBranch = String(headInfo.branch || "").trim() || undefined;
  const currentTrackedRemote = currentBranch
    ? await resolveBranchTrackedRemoteAsync(runtime, repoRoot, currentBranch)
    : null;
  const branchDefaultResolution = await resolveBranchDefaultMethodAsync(runtime, repoRoot, currentBranch);

  return {
    options,
    methodResolution: {
      selectedMethod,
      selectionSource: payloadOptions.selectionSource,
      resolvedMethod: selectedMethod,
      resolvedSource: "explicit",
      currentBranch,
      currentUpstream: currentTrackedRemote?.upstream,
      currentRemote: currentTrackedRemote?.remote,
      currentRemoteBranch: currentTrackedRemote?.branch,
      branchRebaseKey: branchDefaultResolution.branchRebaseKey,
      branchRebaseValue: branchDefaultResolution.branchRebaseValue,
      pullRebaseValue: branchDefaultResolution.pullRebaseValue,
      saveChangesPolicy,
    },
    scopePreview: await buildUpdateScopePreviewAsync(runtime, scopeOptions),
    pullCapabilities: await detectGitPullCapabilitiesAsync(runtime, repoRoot),
  };
}

/**
 * 保存 Update Project 选项，并返回最新的持久化快照供前端刷新显示。
 */
export async function updateStoredUpdateOptionsAsync(
  runtime: GitUpdateConfigRuntime,
  payload?: any,
): Promise<{ ok: true; data: GitUpdateOptionsSnapshot } | { ok: false; error: string }> {
  try {
    const currentOptions = loadStoredGitUpdateOptions(runtime);
    const nextInput = payload?.options && typeof payload.options === "object" ? payload.options : payload;
    const nextPullOptions = resolvePayloadPullOptions({ options: nextInput }) || normalizeGitPullOptions(currentOptions.pull);
    const nextOptions = normalizeGitUpdateOptions({
      ...currentOptions,
      ...(nextInput && typeof nextInput === "object" ? nextInput : {}),
      scope: {
        ...currentOptions.scope,
        ...resolvePayloadScopeOptions({ options: nextInput }),
      },
      pull: nextPullOptions,
    });
    saveStoredGitUpdateOptions(runtime, nextOptions);
    return {
      ok: true,
      data: await getUpdateOptionsSnapshotAsync(runtime),
    };
  } catch (error: any) {
    return {
      ok: false,
      error: String(error?.message || error || "保存 Update Project 选项失败"),
    };
  }
}

/**
 * 读取远端分支列表，并按 remote 分组。
 */
async function listRemoteBranchOptionsAsync(
  runtime: GitUpdateConfigRuntime,
  repoRoot: string,
  remoteNames: string[],
): Promise<GitUpdateTrackedBranchRemoteOption[]> {
  const remoteSet = new Set(remoteNames);
  const res = await runtime.runGitExecAsync(repoRoot, ["for-each-ref", "--sort=refname", "--format=%(refname:short)", "refs/remotes"], 12_000);
  if (!res.ok) {
    return remoteNames.map((name) => ({ name, branches: [] }));
  }
  const grouped = new Map<string, Set<string>>();
  for (const remoteName of remoteNames) {
    grouped.set(remoteName, new Set<string>());
  }
  const rows = String(res.stdout || "").split(/\r?\n/).map((one) => String(one || "").trim()).filter(Boolean);
  for (const row of rows) {
    const parsed = parseUpstreamRef(row, remoteNames);
    if (!parsed?.remote || !parsed.branch) continue;
    if (parsed.branch === "HEAD") continue;
    if (!remoteSet.has(parsed.remote)) continue;
    if (!grouped.has(parsed.remote)) grouped.set(parsed.remote, new Set<string>());
    grouped.get(parsed.remote)?.add(parsed.branch);
  }
  return Array.from(grouped.entries())
    .map(([name, branches]) => ({
      name,
      branches: Array.from(branches.values()).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 为当前本地分支推断最合理的远端/分支建议。
 */
function resolveSuggestedRemoteBranch(
  currentBranch: string,
  trackedRemote: GitTrackedRemoteRef | null,
  remoteOptions: GitUpdateTrackedBranchRemoteOption[],
  preferredRemote: string,
): { remote?: string; branch?: string } {
  const localBranch = String(currentBranch || "").trim();
  const trackedBranch = String(trackedRemote?.branch || "").trim();
  const candidateOrder = [
    String(trackedRemote?.remote || "").trim(),
    String(preferredRemote || "").trim(),
    ...remoteOptions.map((one) => one.name),
  ].filter(Boolean);
  for (const remoteName of candidateOrder) {
    const remoteOption = remoteOptions.find((one) => one.name === remoteName);
    if (!remoteOption) continue;
    if (trackedBranch && remoteOption.branches.includes(trackedBranch)) {
      return { remote: remoteName, branch: trackedBranch };
    }
    if (localBranch && remoteOption.branches.includes(localBranch)) {
      return { remote: remoteName, branch: localBranch };
    }
    if (remoteOption.branches.length > 0) {
      return { remote: remoteName, branch: remoteOption.branches[0] };
    }
  }
  const fallbackRemote = remoteOptions[0];
  return {
    remote: fallbackRemote?.name,
    branch: fallbackRemote?.branches[0],
  };
}

/**
 * 分析单个仓库的 tracked branch 状态，并生成修复建议所需数据。
 */
async function analyzeTrackedBranchAsync(
  runtime: GitUpdateConfigRuntime,
  repoRoot: string,
): Promise<GitUpdateTrackedBranchAnalysis> {
  const headInfo = await getHeadInfoAsync(runtime, repoRoot);
  const remoteNames = await listRemoteNamesAsync(runtime, repoRoot);
  const remoteOptions = await listRemoteBranchOptionsAsync(runtime, repoRoot, remoteNames);
  const preferredRemote = await getPreferredRemoteAsync(runtime, repoRoot, remoteNames);
  if (!headInfo.branch) {
    const fallbackSuggestion = resolveSuggestedRemoteBranch("", null, remoteOptions, preferredRemote);
    return {
      branch: undefined,
      trackedRemote: null,
      remoteOptions,
      suggestedRemote: fallbackSuggestion.remote,
      suggestedRemoteBranch: fallbackSuggestion.branch,
      suggestedLocalBranchName: normalizeSuggestedLocalBranchName(fallbackSuggestion.branch, headInfo.headSha),
    };
  }
  const trackedRemote = await resolveBranchTrackedRemoteAsync(runtime, repoRoot, headInfo.branch, remoteNames);
  const suggested = resolveSuggestedRemoteBranch(headInfo.branch, trackedRemote, remoteOptions, preferredRemote);
  return {
    branch: headInfo.branch,
    trackedRemote,
    remoteOptions,
    suggestedRemote: suggested.remote,
    suggestedRemoteBranch: suggested.branch,
    suggestedLocalBranchName: normalizeSuggestedLocalBranchName(headInfo.branch || suggested.branch, headInfo.headSha),
  };
}

/**
 * 构造单条 tracked branch 问题项，供前端对话框直接渲染。
 */
function buildTrackedBranchIssue(
  params: {
    repoRoot: string;
    rootName: string;
    kind: GitUpdateTrackedBranchIssue["kind"];
    parentRepoRoot?: string;
    issueCode: GitUpdateTrackedBranchIssueCode;
    message: string;
    branch?: string;
    trackedRemote?: GitTrackedRemoteRef | null;
    remoteOptions: GitUpdateTrackedBranchRemoteOption[];
    suggestedRemote?: string;
    suggestedRemoteBranch?: string;
    suggestedLocalBranchName?: string;
    detachedHead?: boolean;
  },
): GitUpdateTrackedBranchIssue {
  const hasSuggestedRemote = !!String(params.suggestedRemote || "").trim();
  const hasSuggestedRemoteBranch = !!String(params.suggestedRemoteBranch || "").trim();
  const hasRemoteChoices = params.remoteOptions.some((option) => option.branches.length > 0);
  const canFix = !!params.branch && hasSuggestedRemote && hasSuggestedRemoteBranch && hasRemoteChoices;
  return {
    repoRoot: params.repoRoot,
    rootName: params.rootName,
    kind: params.kind,
    parentRepoRoot: params.parentRepoRoot,
    issueCode: params.issueCode,
    message: params.message,
    branch: params.branch,
    currentUpstream: params.trackedRemote?.upstream,
    currentRemote: params.trackedRemote?.remote,
    currentRemoteBranch: params.trackedRemote?.branch,
    suggestedRemote: params.suggestedRemote,
    suggestedRemoteBranch: params.suggestedRemoteBranch,
    suggestedLocalBranchName: params.suggestedLocalBranchName,
    detachedHead: params.detachedHead === true,
    remoteOptions: params.remoteOptions,
    canFix,
    canSetAsTracked: canFix,
  };
}

/**
 * 读取当前 Update Project 需要用户修复的 tracked branch 问题集合。
 */
export async function getTrackedBranchPreviewAsync(
  runtime: GitUpdateConfigRuntime,
  payload?: any,
): Promise<GitUpdateTrackedBranchPreview> {
  const storedOptions = loadStoredGitUpdateOptions(runtime);
  const repositoryGraph = await buildRepositoryGraphAsync(
    runtime,
    applyUpdateOptionsPayloadDefaults(runtime.repoRoot, payload, {
      ...storedOptions,
      scope: resolveEffectiveScopeOptions(storedOptions.scope, payload),
    }),
  );
  const issues: GitUpdateTrackedBranchIssue[] = [];
  for (const node of repositoryGraph.roots) {
    const repoRoot = toFsPathAbs(node.repoRoot);
    if (!repoRoot) continue;
    if (node.kind === "submodule" && node.submoduleMode === "detached") continue;
    if (node.detachedHead) continue;
    const analysis = await analyzeTrackedBranchAsync(runtime, repoRoot);
    const branch = String(analysis.branch || "").trim();
    if (!analysis.trackedRemote?.remote || !analysis.trackedRemote.branch) {
      issues.push(buildTrackedBranchIssue({
        repoRoot,
        rootName: node.rootName,
        kind: node.kind,
        parentRepoRoot: node.parentRepoRoot,
        issueCode: "no-tracked-branch",
        message: `当前分支 ${branch} 未配置远端上游分支`,
        branch,
        trackedRemote: null,
        remoteOptions: analysis.remoteOptions,
        suggestedRemote: analysis.suggestedRemote,
        suggestedRemoteBranch: analysis.suggestedRemoteBranch,
        suggestedLocalBranchName: analysis.suggestedLocalBranchName,
      }));
      continue;
    }

    const remoteExistsRes = await verifyTrackedRemoteExistsAsync(runtime, repoRoot, analysis.trackedRemote);
    if (!remoteExistsRes.ok) {
      throw new Error(remoteExistsRes.error);
    }
    if (!remoteExistsRes.exists) {
      issues.push(buildTrackedBranchIssue({
        repoRoot,
        rootName: node.rootName,
        kind: node.kind,
        parentRepoRoot: node.parentRepoRoot,
        issueCode: "remote-missing",
        message: `当前上游分支 ${analysis.trackedRemote.upstream} 在本地不存在或已失效`,
        branch,
        trackedRemote: analysis.trackedRemote,
        remoteOptions: analysis.remoteOptions,
        suggestedRemote: analysis.suggestedRemote,
        suggestedRemoteBranch: analysis.suggestedRemoteBranch,
        suggestedLocalBranchName: analysis.suggestedLocalBranchName,
      }));
    }
  }
  return {
    requestedRepoRoot: repositoryGraph.requestedRepoRoot,
    multiRoot: repositoryGraph.roots.length > 1,
    defaultUpdateMethod: storedOptions.updateMethod,
    issues,
    hasFixableIssues: issues.some((issue) => issue.canFix),
  };
}

/**
 * 从 Update payload 中解析指定 root 的临时 tracked branch 覆盖项。
 */
export function resolveTrackedBranchOverride(
  payload: any,
  repoRoot: string,
): GitUpdateTrackedBranchOverride | null {
  const entries = payload?.updateTrackedBranches;
  if (!entries || typeof entries !== "object") return null;
  const rootKey = toFsPathKey(repoRoot);
  const direct = entries[rootKey] || entries[repoRoot];
  if (!direct || typeof direct !== "object") return null;
  const localBranch = String(direct.localBranch || "").trim();
  const remote = String(direct.remote || "").trim();
  const remoteBranch = String(direct.remoteBranch || "").trim();
  const upstream = String(direct.upstream || "").trim() || (remote && remoteBranch ? `${remote}/${remoteBranch}` : "");
  if (!localBranch || !remote || !remoteBranch || !upstream) return null;
  return {
    localBranch,
    remote,
    remoteBranch,
    upstream,
    setAsTracked: direct.setAsTracked === true,
  };
}

/**
 * 将前端提交的修复选择应用到 Git 配置，并返回后续 Update Project 需要的临时 payload。
 */
export async function applyTrackedBranchSelectionsAsync(
  runtime: GitUpdateConfigRuntime,
  payload: any,
): Promise<{ ok: true; data: GitUpdateTrackedBranchApplyResult } | { ok: false; error: string }> {
  const selectionsInput = Array.isArray(payload?.selections) ? payload.selections : [];
  const updateMethod = parseOptionalStoredUpdateMethod(payload?.updateMethod) || loadStoredGitUpdateOptions(runtime).updateMethod;
  const updateTrackedBranches: Record<string, GitUpdateTrackedBranchOverride> = {};
  const appliedRoots: string[] = [];
  const persistedRoots: string[] = [];

  for (const item of selectionsInput) {
    const repoRoot = toFsPathAbs(String(item?.repoRoot || "").trim());
    const remote = String(item?.remote || "").trim();
    const remoteBranch = String(item?.remoteBranch || "").trim();
    const setAsTracked = item?.setAsTracked === true;
    if (!repoRoot || !remote || !remoteBranch) continue;

    const headInfo = await getHeadInfoAsync(runtime, repoRoot);
    const localBranch = String(headInfo.branch || "").trim();
    if (!localBranch) {
      return { ok: false, error: `仓库 ${path.basename(repoRoot) || repoRoot} 当前处于 Detached HEAD，请先切换到本地分支后再继续更新` };
    }

    const override: GitUpdateTrackedBranchOverride = {
      localBranch,
      remote,
      remoteBranch,
      upstream: `${remote}/${remoteBranch}`,
      setAsTracked,
    };
    updateTrackedBranches[toFsPathKey(repoRoot)] = override;
    appliedRoots.push(repoRoot);

    if (setAsTracked) {
      runtime.emitProgress?.(repoRoot, "正在写入跟踪分支配置", `${localBranch} -> ${override.upstream}`);
      const res = await runtime.runGitSpawnAsync(repoRoot, ["branch", "--set-upstream-to", override.upstream, localBranch], 30_000);
      if (!res.ok) return { ok: false, error: runtime.toGitErrorMessage(res, "写入跟踪分支配置失败") };
      persistedRoots.push(repoRoot);
    }
  }

  return {
    ok: true,
    data: {
      updatePayloadPatch: {
        updateTrackedBranches,
        updateMethod,
      },
      appliedRoots,
      persistedRoots,
    },
  };
}
