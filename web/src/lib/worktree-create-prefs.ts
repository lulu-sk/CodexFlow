// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * worktree 创建面板（“从分支创建 worktree”）的轻量持久化。
 *
 * 设计目标
 * - 按 repoProjectId（项目节点 id）隔离保存：每个项目独立记录上次设置；
 * - 仅保存“可跨会话复用”的字段（去除 blob/previewUrl 等运行态字段）；
 * - 初始提示词在“已发送”后会被调用方清空（本模块提供清空接口）。
 */

const WORKTREE_CREATE_PREFS_STORAGE_KEY = "codexflow.worktreeCreatePrefs.v1";
const WORKTREE_CREATE_PREFS_VERSION = 1 as const;

export type GitWorktreeProviderId = "codex" | "claude" | "gemini";

export type PersistedWorktreePromptChip = {
  chipKind?: "file" | "image" | "rule";
  winPath?: string;
  wslPath?: string;
  fileName?: string;
  isDir?: boolean;
  rulePath?: string;
};

export type WorktreeCreatePrefs = {
  baseBranch: string;
  selectedChildWorktreeIds: string[];
  promptChips: PersistedWorktreePromptChip[];
  promptDraft: string;
  useYolo: boolean;
  useMultipleModels: boolean;
  singleProviderId: GitWorktreeProviderId;
  multiCounts: Record<GitWorktreeProviderId, number>;
};

type PersistedWorktreeCreatePrefsRoot = {
  version: typeof WORKTREE_CREATE_PREFS_VERSION;
  savedAt: number;
  byRepoProjectId: Record<string, WorktreeCreatePrefs>;
};

/**
 * 中文说明：安全获取 localStorage（某些环境下可能抛异常）。
 */
function getLocalStorageSafe(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 中文说明：将输入转为非空字符串；否则返回空串。
 */
function toNonEmptyString(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return s;
}

/**
 * 中文说明：归一化 ProviderId，非内置三引擎则回退为 codex。
 */
function normalizeProviderId(value: unknown): GitWorktreeProviderId {
  const v = toNonEmptyString(value).toLowerCase();
  if (v === "codex" || v === "claude" || v === "gemini") return v as GitWorktreeProviderId;
  return "codex";
}

/**
 * 中文说明：将计数限制在 0..8（与 UI 控件上限一致）。
 */
function clampCount(value: unknown): number {
  const n = Math.floor(Number(value) || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(8, n));
}

/**
 * 中文说明：归一化 multiCounts，确保三个引擎键齐全。
 */
function normalizeMultiCounts(input: unknown): Record<GitWorktreeProviderId, number> {
  const obj = (input && typeof input === "object") ? (input as any) : {};
  return {
    codex: clampCount(obj.codex),
    claude: clampCount(obj.claude),
    gemini: clampCount(obj.gemini),
  };
}

/**
 * 中文说明：归一化字符串数组（去空、去重、保持顺序）。
 */
function normalizeStringArray(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of arr) {
    const s = toNonEmptyString(it);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * 中文说明：归一化提示词 chips（仅保留稳定字段）。
 */
function normalizePromptChips(input: unknown): PersistedWorktreePromptChip[] {
  const arr = Array.isArray(input) ? input : [];
  const out: PersistedWorktreePromptChip[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const obj = item as any;
    const winPath = toNonEmptyString(obj.winPath);
    const wslPath = toNonEmptyString(obj.wslPath);
    const fileName = toNonEmptyString(obj.fileName);
    const rulePath = toNonEmptyString(obj.rulePath);
    const chipKindRaw = toNonEmptyString(obj.chipKind);
    const chipKind = (chipKindRaw === "file" || chipKindRaw === "image" || chipKindRaw === "rule") ? (chipKindRaw as any) : undefined;
    const isDir = typeof obj.isDir === "boolean" ? obj.isDir : undefined;
    // 至少要有一个可定位的字段，否则丢弃
    if (!winPath && !wslPath && !fileName && !rulePath) continue;
    out.push({ chipKind, winPath: winPath || undefined, wslPath: wslPath || undefined, fileName: fileName || undefined, isDir, rulePath: rulePath || undefined });
  }
  return out;
}

/**
 * 中文说明：归一化单个项目的 worktree 创建面板偏好。
 */
function normalizePrefs(input: unknown): WorktreeCreatePrefs {
  const obj = (input && typeof input === "object") ? (input as any) : {};
  const singleProviderId = normalizeProviderId(obj.singleProviderId);
  const multiCounts = normalizeMultiCounts(obj.multiCounts);
  return {
    baseBranch: toNonEmptyString(obj.baseBranch),
    selectedChildWorktreeIds: normalizeStringArray(obj.selectedChildWorktreeIds),
    promptChips: normalizePromptChips(obj.promptChips),
    promptDraft: String(obj.promptDraft ?? ""),
    useYolo: typeof obj.useYolo === "boolean" ? obj.useYolo : true,
    useMultipleModels: typeof obj.useMultipleModels === "boolean" ? obj.useMultipleModels : false,
    singleProviderId,
    multiCounts,
  };
}

/**
 * 中文说明：读取指定 repoProjectId 的 worktree 创建面板偏好；不存在则返回 null。
 */
export function loadWorktreeCreatePrefs(repoProjectId: string): WorktreeCreatePrefs | null {
  const repoId = toNonEmptyString(repoProjectId);
  if (!repoId) return null;
  const ls = getLocalStorageSafe();
  if (!ls) return null;
  try {
    const raw = ls.getItem(WORKTREE_CREATE_PREFS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as any;
    if (Number(parsed?.version) !== WORKTREE_CREATE_PREFS_VERSION) return null;
    const by = (parsed?.byRepoProjectId && typeof parsed.byRepoProjectId === "object") ? parsed.byRepoProjectId : {};
    const prefsRaw = by[repoId];
    if (!prefsRaw) return null;
    return normalizePrefs(prefsRaw);
  } catch {
    return null;
  }
}

/**
 * 中文说明：写入指定 repoProjectId 的 worktree 创建面板偏好（覆盖保存）。
 */
export function saveWorktreeCreatePrefs(repoProjectId: string, prefs: WorktreeCreatePrefs): void {
  const repoId = toNonEmptyString(repoProjectId);
  if (!repoId) return;
  const ls = getLocalStorageSafe();
  if (!ls) return;
  try {
    let root: PersistedWorktreeCreatePrefsRoot = {
      version: WORKTREE_CREATE_PREFS_VERSION,
      savedAt: Date.now(),
      byRepoProjectId: {},
    };
    try {
      const raw = ls.getItem(WORKTREE_CREATE_PREFS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as any;
        if (Number(parsed?.version) === WORKTREE_CREATE_PREFS_VERSION && parsed?.byRepoProjectId && typeof parsed.byRepoProjectId === "object") {
          root = {
            version: WORKTREE_CREATE_PREFS_VERSION,
            savedAt: Date.now(),
            byRepoProjectId: parsed.byRepoProjectId as any,
          };
        }
      }
    } catch {
      // ignore
    }
    root.byRepoProjectId = { ...(root.byRepoProjectId || {}), [repoId]: normalizePrefs(prefs) };
    root.savedAt = Date.now();
    ls.setItem(WORKTREE_CREATE_PREFS_STORAGE_KEY, JSON.stringify(root));
  } catch {
    // ignore
  }
}

/**
 * 中文说明：清空指定 repoProjectId 的“初始提示词记录”（chips + draft），保留其他设置不变。
 */
export function clearWorktreeCreatePromptPrefs(repoProjectId: string): void {
  const repoId = toNonEmptyString(repoProjectId);
  if (!repoId) return;
  const existing = loadWorktreeCreatePrefs(repoId);
  if (!existing) return;
  saveWorktreeCreatePrefs(repoId, { ...existing, promptChips: [], promptDraft: "" });
}

