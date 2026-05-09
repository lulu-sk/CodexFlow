import type { GitExecResult } from "../exec";
import type {
  GitSavedLocalChanges,
  GitUpdateLocalChangesRestorePolicy,
  GitUpdateMergeFailure,
  GitUpdateOperationProblem,
  GitUpdateProblemAction,
  GitUpdatePreservingNotRestoredReason,
  GitUpdatePreservingState,
  GitUpdateProblemFileList,
  GitUpdateProblemOperation,
  GitUpdateSaveChangesPolicy,
} from "./types";

const MERGE_CONFLICT_MARKERS = [
  "automatic merge failed; fix conflicts and then commit the result",
  "automatic merge failed; fix conflicts and then commit the result.",
];

type GitSmartOperationProblemConfig = {
  operation: GitUpdateProblemOperation;
  localChangesHeader: string;
  localChangesFooters: RegExp[];
  untrackedHeader: string;
  untrackedFooters: RegExp[];
  localChangesPatterns?: RegExp[];
  untrackedPatterns?: RegExp[];
  localChangesTitle: string;
  localChangesDescription: string;
  untrackedTitle: string;
  untrackedDescription: string;
};

const LOCAL_CHANGES_FOOTER_PATTERNS = [
  /commit your changes or stash them before/i,
  /aborting/i,
  /merge with strategy .* failed/i,
  /no merge strategy handled the merge/i,
];

const UNTRACKED_FOOTER_PATTERNS = [
  /please move or remove them before/i,
  /aborting/i,
  /merge with strategy .* failed/i,
  /no merge strategy handled the merge/i,
];

const SMART_OPERATION_PROBLEM_CONFIGS: Record<GitUpdateProblemOperation, GitSmartOperationProblemConfig> = {
  merge: {
    operation: "merge",
    localChangesHeader: "your local changes to the following files would be overwritten by merge",
    localChangesFooters: LOCAL_CHANGES_FOOTER_PATTERNS,
    untrackedHeader: "the following untracked working tree files would be overwritten by merge",
    untrackedFooters: UNTRACKED_FOOTER_PATTERNS,
    localChangesPatterns: [
      /your local changes to ['"](.+?)['"] would be overwritten by merge/i,
      /entry ['"](.+?)['"] would be overwritten by merge/i,
      /entry ['"](.+?)['"] not uptodate\. cannot merge/i,
    ],
    untrackedPatterns: [
      /untracked working tree file ['"]?(.+?)['"]? would be overwritten by/i,
    ],
    localChangesTitle: "本地改动会被 Merge 覆盖",
    localChangesDescription: "以下文件的本地改动会被本次 Merge 覆盖。请先提交、暂存，或改用保存本地改动后再重试。",
    untrackedTitle: "未跟踪文件会被 Merge 覆盖",
    untrackedDescription: "以下未跟踪文件会被本次 Merge 覆盖。请先移动、删除，或纳入版本控制后再重试。",
  },
  reset: {
    operation: "reset",
    localChangesHeader: "your local changes to the following files would be overwritten by checkout",
    localChangesFooters: LOCAL_CHANGES_FOOTER_PATTERNS,
    untrackedHeader: "the following untracked working tree files would be overwritten by checkout",
    untrackedFooters: UNTRACKED_FOOTER_PATTERNS,
    localChangesPatterns: [
      /you have local changes to ['"](.+?)['"]; cannot switch branches/i,
      /your local changes to ['"](.+?)['"] would be overwritten by checkout/i,
    ],
    untrackedPatterns: [
      /untracked working tree file ['"]?(.+?)['"]? would be overwritten by/i,
    ],
    localChangesTitle: "本地改动会被 Reset 覆盖",
    localChangesDescription: "以下文件的本地改动会被本次 Reset 覆盖。系统会在可行时自动保护非冲突改动；若仍提示这些文件，请先提交、暂存，或手动处理后再重试。",
    untrackedTitle: "未跟踪文件会被 Reset 覆盖",
    untrackedDescription: "以下未跟踪文件会被本次 Reset 覆盖。请先移动、删除，或纳入版本控制后再重试。",
  },
  checkout: {
    operation: "checkout",
    localChangesHeader: "your local changes to the following files would be overwritten by checkout",
    localChangesFooters: LOCAL_CHANGES_FOOTER_PATTERNS,
    untrackedHeader: "the following untracked working tree files would be overwritten by checkout",
    untrackedFooters: UNTRACKED_FOOTER_PATTERNS,
    localChangesPatterns: [
      /you have local changes to ['"](.+?)['"]; cannot switch branches/i,
      /your local changes to ['"](.+?)['"] would be overwritten by checkout/i,
    ],
    untrackedPatterns: [
      /untracked working tree file ['"]?(.+?)['"]? would be overwritten by/i,
    ],
    localChangesTitle: "本地改动会被 Checkout 覆盖",
    localChangesDescription: "以下文件的本地改动会被本次 Checkout 覆盖。请先提交、暂存，或改用智能 Checkout 后再重试。",
    untrackedTitle: "未跟踪文件会被 Checkout 覆盖",
    untrackedDescription: "以下未跟踪文件会被本次 Checkout 覆盖。请先移动、删除，或纳入版本控制后再重试。",
  },
  "cherry-pick": {
    operation: "cherry-pick",
    localChangesHeader: "your local changes would be overwritten by cherry-pick",
    localChangesFooters: [
      /commit your changes or stash them to proceed/i,
      /hint:\s*commit your changes or stash them to proceed/i,
      /fatal:\s*cherry-pick failed/i,
      /aborting/i,
    ],
    untrackedHeader: "the following untracked working tree files would be overwritten by cherry-pick",
    untrackedFooters: [
      /please move or remove them before/i,
      /hint:\s*commit your changes or stash them to proceed/i,
      /fatal:\s*cherry-pick failed/i,
      /aborting/i,
    ],
    localChangesPatterns: [
      /your local changes to ['"](.+?)['"] would be overwritten by cherry-pick/i,
    ],
    untrackedPatterns: [
      /untracked working tree file ['"]?(.+?)['"]? would be overwritten by cherry-pick/i,
    ],
    localChangesTitle: "本地改动会被 Cherry-pick 覆盖",
    localChangesDescription: "以下文件的本地改动会被本次 Cherry-pick 覆盖。请先提交、暂存，或改用保存本地改动后再重试。",
    untrackedTitle: "未跟踪文件会被 Cherry-pick 覆盖",
    untrackedDescription: "以下未跟踪文件会被本次 Cherry-pick 覆盖。请先移动、删除，或纳入版本控制后再重试。",
  },
};

const DIRECTORY_UNTRACKED_OVERWRITE_HEADER = "updating the following directories would lose untracked files in them";

/**
 * 将 Git 命令输出统一拆成文本行，便于后续按 IDEA 语义解析 Merge 失败类型。
 */
function getCommandOutputLines(commandRes: GitExecResult): string[] {
  return `${String(commandRes.stdout || "")}\n${String(commandRes.stderr || "")}`
    .split(/\r?\n/)
    .map((line) => String(line || "").replace(/\r/g, ""));
}

/**
 * 解码 Git 可能返回的八进制转义路径，尽量还原真实文件名。
 */
function decodeGitEscapedPath(raw: string): string {
  const text = String(raw || "");
  if (!/\\[0-7]{3}/.test(text)) return text;
  const bytes: number[] = [];
  for (let idx = 0; idx < text.length;) {
    if (text[idx] === "\\" && idx + 3 < text.length) {
      const octal = text.slice(idx + 1, idx + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(Number.parseInt(octal, 8));
        idx += 4;
        continue;
      }
    }
    const chunk = Buffer.from(text[idx], "utf8");
    for (const one of chunk.values())
      bytes.push(one);
    idx += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * 清洗 Git 错误输出中的单行文本，去掉通用前缀并统一路径分隔符。
 */
function normalizeCommandOutputLine(raw: string): string {
  return decodeGitEscapedPath(String(raw || ""))
    .replace(/^error:\s*/i, "")
    .trim()
    .replace(/\\/g, "/");
}

/**
 * 判断当前输出行是否属于 Merge 过程中 `git apply` 产生的 `<stdin>` 噪声，避免被误判为文件路径。
 */
function isGitApplyNoiseLine(raw: string): boolean {
  return /^<stdin>:\d+:.*/i.test(normalizeCommandOutputLine(raw));
}

/**
 * 从 Git 错误输出的路径行中提取文件列表，兼容多列空格分隔、制表符分隔，以及 IDEA 已覆盖的“前导双空格 + 单行多文件”旧格式。
 */
function extractPathCandidatesFromLine(raw: string): string[] {
  const line = normalizeCommandOutputLine(raw);
  if (!line) return [];
  if (/^\s{2,}\S/.test(String(raw || ""))) {
    return line.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  }
  const splitByColumns = line.split(/\t+|\s{2,}/).map((item) => item.trim()).filter(Boolean);
  return splitByColumns.length > 0 ? splitByColumns : [line];
}

/**
 * 从带头尾标记的 Git 错误输出片段里提取文件路径列表。
 */
function collectProblemFiles(
  lines: string[],
  headerMarker: string,
  footerMarkers: RegExp[],
): string[] {
  const files = new Set<string>();
  let collecting = false;
  for (const rawLine of lines) {
    const normalized = normalizeCommandOutputLine(rawLine);
    const lower = normalized.toLowerCase();
    if (!collecting) {
      if (lower.includes(headerMarker)) {
        collecting = true;
      }
      continue;
    }
    if (!normalized) continue;
    if (footerMarkers.some((marker) => marker.test(normalized))) break;
    if (files.size > 0 && isGitApplyNoiseLine(rawLine)) break;
    for (const filePath of extractPathCandidatesFromLine(rawLine))
      files.add(filePath);
  }
  return Array.from(files);
}

/**
 * 从旧格式单行错误文本中补提文件路径，兼容旧版 Git 的 checkout/merge 提示。
 */
function collectPatternProblemFiles(lines: string[], patterns?: RegExp[]): string[] {
  if (!patterns || patterns.length <= 0) return [];
  const files = new Set<string>();
  for (const rawLine of lines) {
    const normalized = normalizeCommandOutputLine(rawLine);
    for (const pattern of patterns) {
      const matched = normalized.match(pattern);
      if (!matched?.[1]) continue;
      files.add(normalizeCommandOutputLine(matched[1]));
    }
  }
  return Array.from(files);
}

/**
 * 为覆盖文件问题构建统一的文件列表展示模型，供工作台弹窗直接复用。
 */
function buildProblemFileList(
  operation: GitUpdateProblemOperation,
  kind: GitUpdateProblemFileList["kind"],
  files: string[],
): GitUpdateProblemFileList | undefined {
  const config = SMART_OPERATION_PROBLEM_CONFIGS[operation];
  if (kind === "local-changes-overwritten")
    return {
      operation,
      kind,
      title: config.localChangesTitle,
      description: config.localChangesDescription,
      files,
    };
  return {
    operation,
    kind,
    title: config.untrackedTitle,
    description: config.untrackedDescription,
    files,
  };
}

/**
 * 规整问题动作列表，避免上层把非法 payload 或空标签透传给前端。
 */
function normalizeProblemActions(actions?: GitUpdateProblemAction[]): GitUpdateProblemAction[] {
  if (!Array.isArray(actions) || actions.length <= 0) return [];
  const normalized: GitUpdateProblemAction[] = [];
  for (const action of actions) {
    const kind = String(action?.kind || "").trim();
    const label = String(action?.label || "").trim();
    if (!label) continue;
    if (kind !== "smart" && kind !== "force" && kind !== "rollback") continue;
    normalized.push({
      kind: kind as GitUpdateProblemAction["kind"],
      label,
      payloadPatch: action?.payloadPatch && typeof action.payloadPatch === "object"
        ? { ...action.payloadPatch }
        : {},
      variant: action?.variant === "danger" || action?.variant === "primary" || action?.variant === "secondary"
        ? action.variant
        : undefined,
    });
  }
  return normalized;
}

/**
 * 为结构化问题构建稳定动作对象，便于 checkout / update 失败路径直接复用。
 */
export function buildUpdateProblemAction(
  kind: GitUpdateProblemAction["kind"],
  label: string,
  payloadPatch?: Record<string, any>,
  variant?: GitUpdateProblemAction["variant"],
): GitUpdateProblemAction {
  return {
    kind,
    label: String(label || "").trim() || kind,
    payloadPatch: payloadPatch && typeof payloadPatch === "object" ? { ...payloadPatch } : {},
    variant,
  };
}

/**
 * 把覆盖文件问题升级为统一的问题提示模型，供聚合结果与工作台弹窗共用。
 */
export function buildOperationProblemFromFileList(
  fileList: GitUpdateProblemFileList,
  source: GitUpdateOperationProblem["source"],
  extra?: Partial<Pick<GitUpdateOperationProblem, "repoRoot" | "rootName" | "mergeFailureType">> & {
    actions?: GitUpdateProblemAction[];
  },
): GitUpdateOperationProblem {
  const files = Array.isArray(fileList.files)
    ? Array.from(new Set(fileList.files.map((filePath) => String(filePath || "").trim()).filter(Boolean)))
    : [];
  return {
    operation: fileList.operation,
    kind: fileList.kind,
    title: String(fileList.title || "").trim(),
    description: String(fileList.description || "").trim(),
    files,
    source,
    repoRoot: String(extra?.repoRoot || "").trim() || undefined,
    rootName: String(extra?.rootName || "").trim() || undefined,
    mergeFailureType: extra?.mergeFailureType,
    actions: normalizeProblemActions(extra?.actions),
  };
}

/**
 * 构建 Merge 冲突问题的统一提示模型，避免多仓聚合再回退为字符串判断。
 */
export function buildMergeConflictOperationProblem(
  extra?: Partial<Pick<GitUpdateOperationProblem, "repoRoot" | "rootName" | "mergeFailureType">>,
): GitUpdateOperationProblem {
  return {
    operation: "merge",
    kind: "merge-conflict",
    title: "Merge 过程中出现冲突",
    description: "当前仓库已进入 Merge 冲突状态，请先解决冲突并完成或中止本次 Merge，然后再继续后续更新操作。",
    files: [],
    source: "merge-failure",
    repoRoot: String(extra?.repoRoot || "").trim() || undefined,
    rootName: String(extra?.rootName || "").trim() || undefined,
    mergeFailureType: extra?.mergeFailureType || "CONFLICT",
    actions: [],
  };
}

/**
 * 按 smart operation 语义解析 checkout / reset / merge 的覆盖文件列表。
 */
export function parseSmartOperationProblem(
  commandRes: GitExecResult,
  operation: GitUpdateProblemOperation,
): GitUpdateProblemFileList | undefined {
  const config = SMART_OPERATION_PROBLEM_CONFIGS[operation];
  const lines = getCommandOutputLines(commandRes);
  const joined = lines.map((line) => normalizeCommandOutputLine(line).toLowerCase()).join("\n");

  const localChangeFiles = new Set<string>([
    ...collectProblemFiles(lines, config.localChangesHeader, config.localChangesFooters),
    ...collectPatternProblemFiles(lines, config.localChangesPatterns),
  ]);
  if (joined.includes(config.localChangesHeader) || localChangeFiles.size > 0) {
    return buildProblemFileList(operation, "local-changes-overwritten", Array.from(localChangeFiles));
  }

  const untrackedFiles = new Set<string>([
    ...collectProblemFiles(lines, config.untrackedHeader, config.untrackedFooters),
    ...collectProblemFiles(lines, DIRECTORY_UNTRACKED_OVERWRITE_HEADER, config.untrackedFooters),
    ...collectPatternProblemFiles(lines, config.untrackedPatterns),
  ]);
  if (joined.includes(config.untrackedHeader) || joined.includes(DIRECTORY_UNTRACKED_OVERWRITE_HEADER) || untrackedFiles.size > 0) {
    return buildProblemFileList(operation, "untracked-overwritten", Array.from(untrackedFiles));
  }
  return undefined;
}

/**
 * 按 IDEA `GitMergeUpdater` 语义解析 Merge 失败类型，并尽量提取受影响文件列表。
 */
export function parseMergeFailure(commandRes: GitExecResult): GitUpdateMergeFailure {
  const lines = getCommandOutputLines(commandRes);
  const joined = lines.map((line) => normalizeCommandOutputLine(line).toLowerCase()).join("\n");
  if (MERGE_CONFLICT_MARKERS.some((marker) => joined.includes(marker)) || joined.includes("conflict (")) {
    return {
      type: "CONFLICT",
      message: "Merge 过程中检测到冲突，请先解决冲突后再继续。",
      problem: buildMergeConflictOperationProblem({
        mergeFailureType: "CONFLICT",
      }),
    };
  }

  const smartOperationProblem = parseSmartOperationProblem(commandRes, "merge");
  if (smartOperationProblem?.kind === "local-changes-overwritten") {
    return {
      type: "LOCAL_CHANGES",
      message: "本地改动会被 Merge 覆盖，请先提交、暂存，或启用保存本地改动后再重试。",
      fileList: smartOperationProblem,
      problem: buildOperationProblemFromFileList(smartOperationProblem, "merge-failure", {
        mergeFailureType: "LOCAL_CHANGES",
      }),
    };
  }

  if (smartOperationProblem?.kind === "untracked-overwritten") {
    return {
      type: "UNTRACKED",
      message: "未跟踪文件会被 Merge 覆盖，请先移动、删除，或纳入版本控制后再重试。",
      fileList: smartOperationProblem,
      problem: buildOperationProblemFromFileList(smartOperationProblem, "merge-failure", {
        mergeFailureType: "UNTRACKED",
      }),
    };
  }

  const message = String(commandRes.stderr || "").trim()
    || String(commandRes.stdout || "").trim()
    || String(commandRes.error || "").trim()
    || "Merge 更新失败";
  return {
    type: "OTHER",
    message,
  };
}

/**
 * 把 save changes policy 转换为 preserving 过程中的中文名词。
 */
function getSaveChangesPolicyNoun(policy: GitUpdateSaveChangesPolicy): string {
  return policy === "shelve" ? "搁置记录" : "暂存记录";
}

/**
 * 构建保存后的本地改动显示名，统一覆盖 stash 与独立 shelve 两种 preserving 记录。
 */
export function buildSavedLocalChangesDisplayName(saved: Pick<GitSavedLocalChanges, "ref" | "saveChangesPolicy">): string {
  const ref = String(saved.ref || "").trim();
  if (!ref) return getSaveChangesPolicyNoun(saved.saveChangesPolicy);
  return saved.saveChangesPolicy === "shelve"
    ? `搁置记录 ${ref}`
    : `暂存记录 ${ref}`;
}

/**
 * 基于保存结果构建 preserving state，供 session、结果聚合与前端提示复用。
 */
export function buildPreservingState(
  saved: GitSavedLocalChanges,
  status: GitUpdatePreservingState["status"],
  localChangesRestorePolicy: GitUpdateLocalChangesRestorePolicy,
  message?: string,
  notRestoredReason?: GitUpdatePreservingNotRestoredReason,
  extras?: Pick<GitUpdatePreservingState, "savedChangesAction" | "resolveConflictsAction" | "conflictResolverDialog">,
): GitUpdatePreservingState {
  return {
    saveChangesPolicy: saved.saveChangesPolicy,
    status,
    localChangesRestorePolicy,
    savedLocalChangesRef: saved.ref,
    savedLocalChangesDisplayName: saved.displayName || buildSavedLocalChangesDisplayName(saved),
    message: String(message || "").trim() || undefined,
    notRestoredReason,
    savedChangesAction: extras?.savedChangesAction,
    resolveConflictsAction: extras?.resolveConflictsAction,
    conflictResolverDialog: extras?.conflictResolverDialog,
  };
}

/**
 * 构建“本地改动未自动恢复”场景的统一提示文案。
 */
export function buildLocalChangesNotRestoredMessage(
  saved: GitSavedLocalChanges,
  reason: GitUpdatePreservingNotRestoredReason,
  error?: string,
): string {
  const displayName = saved.displayName || buildSavedLocalChangesDisplayName(saved);
  const detail = String(error || "").trim();
  if (reason === "unfinished-state") {
    return `当前仓库已进入未完成更新状态，${displayName} 尚未自动恢复，请先处理冲突或完成当前更新后再手动恢复。`;
  }
  if (reason === "manual-decision") {
    return `本次未自动恢复 ${displayName}，请按需手动恢复。`;
  }
  if (detail) {
    return `更新已完成，但未能自动恢复 ${displayName}，请手动检查并恢复。\n${detail}`;
  }
  return `更新已完成，但未能自动恢复 ${displayName}，请手动检查并恢复。`;
}
