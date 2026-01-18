// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 控制台会话（Tabs + PTY 绑定）在渲染层的轻量持久化。
 *
 * 目标
 * - 解决“意外 reload / HMR / 白屏重载后标签页与控制台丢失”的体验问题；
 * - 仅保存结构信息（tab 列表、活跃 tab、tabId->ptyId 映射），不保存终端输出正文；
 * - 终端输出正文由主进程 PTY 尾部缓冲提供回放（见 `pty.backlog`）。
 */

const CONSOLE_SESSION_STORAGE_KEY = "codexflow.consoleSession.v1";
const CONSOLE_SESSION_VERSION = 1 as const;

export type PersistedConsoleTab = {
  id: string;
  name: string;
  providerId: string;
  createdAt: number;
};

export type PersistedConsoleSession = {
  version: typeof CONSOLE_SESSION_VERSION;
  savedAt: number;
  selectedProjectId: string;
  tabsByProject: Record<string, PersistedConsoleTab[]>;
  activeTabByProject: Record<string, string | null>;
  ptyByTab: Record<string, string>;
};

/**
 * 中文说明：安全获取 localStorage（部分环境可能抛异常）。
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
 * 中文说明：对 tabsByProject 做最小校验与归一化，避免脏数据导致 UI 崩溃。
 */
function normalizeTabsByProject(input: unknown): Record<string, PersistedConsoleTab[]> {
  const out: Record<string, PersistedConsoleTab[]> = {};
  if (!input || typeof input !== "object") return out;
  for (const [projectIdRaw, listRaw] of Object.entries(input as Record<string, unknown>)) {
    const projectId = toNonEmptyString(projectIdRaw);
    if (!projectId) continue;
    if (!Array.isArray(listRaw)) continue;
    const tabs: PersistedConsoleTab[] = [];
    for (const item of listRaw) {
      if (!item || typeof item !== "object") continue;
      const obj = item as any;
      const id = toNonEmptyString(obj.id);
      if (!id) continue;
      const name = toNonEmptyString(obj.name) || "Console";
      const providerId = toNonEmptyString(obj.providerId) || "codex";
      const createdAtNum = Number(obj.createdAt);
      const createdAt = Number.isFinite(createdAtNum) ? createdAtNum : Date.now();
      tabs.push({ id, name, providerId, createdAt });
    }
    out[projectId] = tabs;
  }
  return out;
}

/**
 * 中文说明：归一化 Record<string, string|null>（空字符串视为 null）。
 */
function normalizeActiveTabByProject(input: unknown): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!input || typeof input !== "object") return out;
  for (const [projectIdRaw, tabIdRaw] of Object.entries(input as Record<string, unknown>)) {
    const projectId = toNonEmptyString(projectIdRaw);
    if (!projectId) continue;
    const tabId = toNonEmptyString(tabIdRaw);
    out[projectId] = tabId ? tabId : null;
  }
  return out;
}

/**
 * 中文说明：归一化 Record<string, string>（用于 tabId -> ptyId）。
 */
function normalizePtyByTab(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object") return out;
  for (const [tabIdRaw, ptyIdRaw] of Object.entries(input as Record<string, unknown>)) {
    const tabId = toNonEmptyString(tabIdRaw);
    const ptyId = toNonEmptyString(ptyIdRaw);
    if (!tabId || !ptyId) continue;
    out[tabId] = ptyId;
  }
  return out;
}

/**
 * 中文说明：读取控制台会话快照。
 */
export function loadConsoleSession(): PersistedConsoleSession | null {
  const ls = getLocalStorageSafe();
  if (!ls) return null;
  try {
    const raw = ls.getItem(CONSOLE_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as any;
    const version = Number(parsed?.version);
    if (version !== CONSOLE_SESSION_VERSION) return null;
    const selectedProjectId = toNonEmptyString(parsed?.selectedProjectId);
    const tabsByProject = normalizeTabsByProject(parsed?.tabsByProject);
    const activeTabByProject = normalizeActiveTabByProject(parsed?.activeTabByProject);
    const ptyByTab = normalizePtyByTab(parsed?.ptyByTab);
    const savedAtNum = Number(parsed?.savedAt);
    const savedAt = Number.isFinite(savedAtNum) ? savedAtNum : Date.now();
    return { version: CONSOLE_SESSION_VERSION, savedAt, selectedProjectId, tabsByProject, activeTabByProject, ptyByTab };
  } catch {
    return null;
  }
}

/**
 * 中文说明：保存控制台会话快照。
 */
export function saveConsoleSession(session: PersistedConsoleSession): void {
  const ls = getLocalStorageSafe();
  if (!ls) return;
  try {
    const payload: PersistedConsoleSession = {
      version: CONSOLE_SESSION_VERSION,
      savedAt: Date.now(),
      selectedProjectId: toNonEmptyString(session?.selectedProjectId),
      tabsByProject: normalizeTabsByProject(session?.tabsByProject),
      activeTabByProject: normalizeActiveTabByProject(session?.activeTabByProject),
      ptyByTab: normalizePtyByTab(session?.ptyByTab),
    };
    const text = JSON.stringify(payload);
    // 轻量保护：避免异常情况下写入过大导致卡顿（上限约 256KB）
    if (text.length > 256_000) return;
    ls.setItem(CONSOLE_SESSION_STORAGE_KEY, text);
  } catch {
    // noop
  }
}

/**
 * 中文说明：清除控制台会话快照。
 */
export function clearConsoleSession(): void {
  const ls = getLocalStorageSafe();
  if (!ls) return;
  try {
    ls.removeItem(CONSOLE_SESSION_STORAGE_KEY);
  } catch {
    // noop
  }
}

