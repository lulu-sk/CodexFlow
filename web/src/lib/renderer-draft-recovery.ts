// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 渲染进程草稿恢复快照。
 *
 * 设计目标
 * - 仅服务于“同一主进程生命周期内”的 reload / HMR / 崩溃后自动刷新恢复；
 * - 保存 Tab 输入草稿、附件 chips，以及 worktree 创建面板的完整运行态草稿；
 * - 通过 bootId 避免跨应用重启误恢复已失效的临时图片与会话状态。
 */

const RENDERER_DRAFT_RECOVERY_STORAGE_KEY = "codexflow.rendererDraftRecovery.v1";
const RENDERER_DRAFT_RECOVERY_VERSION = 1 as const;
const RENDERER_DRAFT_RECOVERY_MAX_TEXT_LENGTH = 1_200_000;

export type RecoveryProviderId = "codex" | "claude" | "gemini";

export type PersistedRecoveryPathChip = {
  chipKind?: "file" | "image" | "rule";
  winPath?: string;
  wslPath?: string;
  fileName?: string;
  isDir?: boolean;
  rulePath?: string;
  type?: string;
  size?: number;
  saved?: boolean;
  fromPaste?: boolean;
  fingerprint?: string;
};

export type RecoveryPathChipLike = PersistedRecoveryPathChip & {
  previewUrl?: string;
  blob?: Blob;
  id?: string;
};

export type RestoredRecoveryPathChip = PersistedRecoveryPathChip & {
  id: string;
  blob: Blob;
  previewUrl: string;
  type: string;
  size: number;
  saved: boolean;
  fromPaste: boolean;
};

export type PersistedRecoveryTabInput = {
  draft: string;
  chips: PersistedRecoveryPathChip[];
};

export type PersistedRecoveryWorktreeCreateDraft = {
  baseBranch: string;
  remarkBaseName: string;
  selectedChildWorktreeIds: string[];
  promptChips: PersistedRecoveryPathChip[];
  promptDraft: string;
  useYolo: boolean;
  useMultipleModels: boolean;
  singleProviderId: RecoveryProviderId;
  multiCounts: Record<RecoveryProviderId, number>;
};

export type PersistedRendererDraftRecovery = {
  version: typeof RENDERER_DRAFT_RECOVERY_VERSION;
  savedAt: number;
  bootId?: string;
  tabInputsByTab: Record<string, PersistedRecoveryTabInput>;
  worktreeCreateDraftByRepoId: Record<string, PersistedRecoveryWorktreeCreateDraft>;
};

/**
 * 中文说明：生成恢复态 chip 的稳定随机 id，避免与现有运行中节点冲突。
 */
function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 中文说明：安全读取 localStorage；某些环境或隐私模式下可能抛异常。
 */
function getLocalStorageSafe(): Storage | null {
  try {
    if (typeof window === "undefined")
      return null;

    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 中文说明：将输入转为去首尾空白后的字符串；无效时返回空串。
 */
function toNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

/**
 * 中文说明：归一化 ProviderId；非内置三引擎统一回退为 `codex`。
 */
function normalizeRecoveryProviderId(value: unknown): RecoveryProviderId {
  const normalized = toNonEmptyString(value).toLowerCase();
  if (normalized === "codex" || normalized === "claude" || normalized === "gemini")
    return normalized as RecoveryProviderId;
  return "codex";
}

/**
 * 中文说明：将实例计数限制在 0..8，保持与 worktree 创建 UI 上限一致。
 */
function clampRecoveryCount(value: unknown): number {
  const num = Math.floor(Number(value) || 0);
  if (!Number.isFinite(num))
    return 0;
  return Math.max(0, Math.min(8, num));
}

/**
 * 中文说明：归一化多模型实例计数，确保三个引擎键始终齐全。
 */
function normalizeRecoveryMultiCounts(value: unknown): Record<RecoveryProviderId, number> {
  const obj = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    codex: clampRecoveryCount(obj.codex),
    claude: clampRecoveryCount(obj.claude),
    gemini: clampRecoveryCount(obj.gemini),
  };
}

/**
 * 中文说明：归一化字符串数组，自动去空、去重并保持输入顺序。
 */
function normalizeStringArray(value: unknown): string[] {
  const source = Array.isArray(value) ? value : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    const normalized = toNonEmptyString(item);
    if (!normalized || seen.has(normalized))
      continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * 中文说明：将 chip 类型规范化为可接受的稳定值。
 */
function normalizeRecoveryChipKind(value: unknown): PersistedRecoveryPathChip["chipKind"] {
  const normalized = toNonEmptyString(value).toLowerCase();
  if (normalized === "file" || normalized === "image" || normalized === "rule")
    return normalized as PersistedRecoveryPathChip["chipKind"];
  return undefined;
}

/**
 * 中文说明：归一化图片/路径 chip 列表，只保留 reload 后仍可重建的稳定字段。
 */
function normalizeRecoveryPathChips(value: unknown): PersistedRecoveryPathChip[] {
  const source = Array.isArray(value) ? value : [];
  const out: PersistedRecoveryPathChip[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object")
      continue;

    const chip = item as Record<string, unknown>;
    const winPath = toNonEmptyString(chip.winPath);
    const wslPath = toNonEmptyString(chip.wslPath);
    const fileName = toNonEmptyString(chip.fileName);
    const rulePath = toNonEmptyString(chip.rulePath);
    if (!winPath && !wslPath && !fileName && !rulePath)
      continue;

    const sizeValue = Number(chip.size);
    const typeValue = toNonEmptyString(chip.type);
    const fingerprint = toNonEmptyString(chip.fingerprint);
    out.push({
      chipKind: normalizeRecoveryChipKind(chip.chipKind),
      winPath: winPath || undefined,
      wslPath: wslPath || undefined,
      fileName: fileName || undefined,
      isDir: typeof chip.isDir === "boolean" ? chip.isDir : undefined,
      rulePath: rulePath || undefined,
      type: typeValue || undefined,
      size: Number.isFinite(sizeValue) && sizeValue >= 0 ? sizeValue : undefined,
      saved: typeof chip.saved === "boolean" ? chip.saved : undefined,
      fromPaste: typeof chip.fromPaste === "boolean" ? chip.fromPaste : undefined,
      fingerprint: fingerprint || undefined,
    });
  }
  return out;
}

/**
 * 中文说明：将运行态 PathChip 列表压缩为可持久化的最小结构。
 */
export function serializeRecoveryPathChips<T extends RecoveryPathChipLike>(chips: T[] | null | undefined): PersistedRecoveryPathChip[] {
  return normalizeRecoveryPathChips(chips);
}

/**
 * 中文说明：将持久化 chip 恢复为运行态对象。
 * - 不恢复 `blob:` 预览 URL，统一由磁盘路径在渲染时按需回退；
 * - `fromPaste` 会被保留，便于应用内资源引用计数继续生效。
 */
export function restoreRecoveryPathChips(chips: PersistedRecoveryPathChip[] | null | undefined): RestoredRecoveryPathChip[] {
  const source = normalizeRecoveryPathChips(chips);
  const out: RestoredRecoveryPathChip[] = [];
  for (const chip of source) {
    out.push({
      id: uid(),
      blob: new Blob(),
      previewUrl: "",
      type: String(chip.type || (chip.chipKind === "image" ? "image/png" : (chip.chipKind === "rule" ? "text/rule" : "text/path"))),
      size: Number(chip.size) || 0,
      saved: chip.saved !== false,
      fromPaste: !!chip.fromPaste,
      winPath: chip.winPath,
      wslPath: chip.wslPath,
      fileName: chip.fileName,
      isDir: chip.isDir,
      rulePath: chip.rulePath,
      fingerprint: chip.fingerprint,
      chipKind: chip.chipKind,
    });
  }
  return out;
}

/**
 * 中文说明：归一化单个 tab 的输入草稿快照。
 */
function normalizeRecoveryTabInput(value: unknown): PersistedRecoveryTabInput {
  const obj = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    draft: String(obj.draft ?? ""),
    chips: normalizeRecoveryPathChips(obj.chips),
  };
}

/**
 * 中文说明：归一化 tab 输入草稿映射，仅保留有效 tabId。
 */
function normalizeRecoveryTabInputs(value: unknown): Record<string, PersistedRecoveryTabInput> {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const out: Record<string, PersistedRecoveryTabInput> = {};
  for (const [tabIdRaw, item] of Object.entries(source)) {
    const tabId = toNonEmptyString(tabIdRaw);
    if (!tabId)
      continue;
    out[tabId] = normalizeRecoveryTabInput(item);
  }
  return out;
}

/**
 * 中文说明：归一化单个 repo 的 worktree 创建草稿快照。
 */
function normalizeRecoveryWorktreeCreateDraft(value: unknown): PersistedRecoveryWorktreeCreateDraft {
  const obj = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    baseBranch: toNonEmptyString(obj.baseBranch),
    remarkBaseName: String(obj.remarkBaseName ?? "").replace(/\s+/g, " ").trim(),
    selectedChildWorktreeIds: normalizeStringArray(obj.selectedChildWorktreeIds),
    promptChips: normalizeRecoveryPathChips(obj.promptChips),
    promptDraft: String(obj.promptDraft ?? ""),
    useYolo: typeof obj.useYolo === "boolean" ? obj.useYolo : true,
    useMultipleModels: typeof obj.useMultipleModels === "boolean" ? obj.useMultipleModels : false,
    singleProviderId: normalizeRecoveryProviderId(obj.singleProviderId),
    multiCounts: normalizeRecoveryMultiCounts(obj.multiCounts),
  };
}

/**
 * 中文说明：归一化 worktree 创建草稿映射，仅保留有效 repoProjectId。
 */
function normalizeRecoveryWorktreeCreateDrafts(value: unknown): Record<string, PersistedRecoveryWorktreeCreateDraft> {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const out: Record<string, PersistedRecoveryWorktreeCreateDraft> = {};
  for (const [repoIdRaw, item] of Object.entries(source)) {
    const repoId = toNonEmptyString(repoIdRaw);
    if (!repoId)
      continue;
    out[repoId] = normalizeRecoveryWorktreeCreateDraft(item);
  }
  return out;
}

/**
 * 中文说明：读取渲染进程草稿恢复快照。
 * - 若提供 `currentBootId`，仅接受同一主进程生命周期内写入的快照；
 * - 发现 bootId 不匹配时会主动清理旧数据，避免残留污染后续恢复。
 */
export function loadRendererDraftRecovery(options?: { currentBootId?: string }): PersistedRendererDraftRecovery | null {
  const ls = getLocalStorageSafe();
  if (!ls)
    return null;

  try {
    const raw = ls.getItem(RENDERER_DRAFT_RECOVERY_STORAGE_KEY);
    if (!raw)
      return null;

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (Number(parsed?.version) !== RENDERER_DRAFT_RECOVERY_VERSION) {
      try { ls.removeItem(RENDERER_DRAFT_RECOVERY_STORAGE_KEY); } catch {}
      return null;
    }

    const bootId = toNonEmptyString(parsed?.bootId);
    const currentBootId = toNonEmptyString(options?.currentBootId);
    if (currentBootId) {
      if (!bootId || bootId !== currentBootId) {
        try { ls.removeItem(RENDERER_DRAFT_RECOVERY_STORAGE_KEY); } catch {}
        return null;
      }
    }

    const savedAtValue = Number(parsed?.savedAt);
    return {
      version: RENDERER_DRAFT_RECOVERY_VERSION,
      savedAt: Number.isFinite(savedAtValue) ? savedAtValue : Date.now(),
      bootId: bootId || undefined,
      tabInputsByTab: normalizeRecoveryTabInputs(parsed?.tabInputsByTab),
      worktreeCreateDraftByRepoId: normalizeRecoveryWorktreeCreateDrafts(parsed?.worktreeCreateDraftByRepoId),
    };
  } catch {
    try { ls.removeItem(RENDERER_DRAFT_RECOVERY_STORAGE_KEY); } catch {}
    return null;
  }
}

/**
 * 中文说明：保存渲染进程草稿恢复快照。
 * - 只写入最小稳定字段，避免把 blob/previewUrl 等运行态对象塞进 localStorage；
 * - 当快照为空时自动删除存储项，减少无意义残留。
 */
export function saveRendererDraftRecovery(snapshot: PersistedRendererDraftRecovery): void {
  const ls = getLocalStorageSafe();
  if (!ls)
    return;

  try {
    const payload: PersistedRendererDraftRecovery = {
      version: RENDERER_DRAFT_RECOVERY_VERSION,
      savedAt: Date.now(),
      bootId: toNonEmptyString(snapshot?.bootId) || undefined,
      tabInputsByTab: normalizeRecoveryTabInputs(snapshot?.tabInputsByTab),
      worktreeCreateDraftByRepoId: normalizeRecoveryWorktreeCreateDrafts(snapshot?.worktreeCreateDraftByRepoId),
    };
    if (
      Object.keys(payload.tabInputsByTab).length === 0
      && Object.keys(payload.worktreeCreateDraftByRepoId).length === 0
    ) {
      ls.removeItem(RENDERER_DRAFT_RECOVERY_STORAGE_KEY);
      return;
    }

    const text = JSON.stringify(payload);
    if (text.length > RENDERER_DRAFT_RECOVERY_MAX_TEXT_LENGTH) {
      try { ls.removeItem(RENDERER_DRAFT_RECOVERY_STORAGE_KEY); } catch {}
      return;
    }
    ls.setItem(RENDERER_DRAFT_RECOVERY_STORAGE_KEY, text);
  } catch {
    try { ls.removeItem(RENDERER_DRAFT_RECOVERY_STORAGE_KEY); } catch {}
  }
}

/**
 * 中文说明：清空渲染进程草稿恢复快照。
 */
export function clearRendererDraftRecovery(): void {
  const ls = getLocalStorageSafe();
  if (!ls)
    return;

  try {
    ls.removeItem(RENDERER_DRAFT_RECOVERY_STORAGE_KEY);
  } catch {
    // noop
  }
}
