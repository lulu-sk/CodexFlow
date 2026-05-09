// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

export type CommitAdvancedOptionsState = {
  signOff: boolean;
  runHooks: boolean;
  author: string;
  authorDate: string;
  cleanupMessage: boolean;
  commitRenamesSeparately: boolean;
};

export type CommitAdvancedOptionsPayload = {
  signOff?: boolean;
  skipHooks?: boolean;
  author?: string;
  authorDate?: string;
  cleanupMessage?: boolean;
  commitRenamesSeparately?: boolean;
};

export type CommitHooksAvailability = {
  available: boolean;
  disabledByPolicy: boolean;
  runByDefault?: boolean;
};

/**
 * 把可能缺失字段的 hooks 可用性快照规整为稳定默认值，避免旧状态或异常响应导致渲染层直接读取空对象属性。
 */
export function resolveCommitHooksAvailability(
  hooksAvailability?: Partial<CommitHooksAvailability> | null,
): CommitHooksAvailability {
  return {
    available: hooksAvailability?.available === true,
    disabledByPolicy: hooksAvailability?.disabledByPolicy === true,
    runByDefault: hooksAvailability?.runByDefault !== false,
  };
}

/**
 * 补齐两位数字文本，统一供作者时间格式化复用。
 */
function padCommitAuthorDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 验证本地日期时间各字段是否能构成真实时间，避免 `2026-02-31` 之类的伪合法输入混入 payload。
 */
function isValidCommitAuthorDateParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
    && date.getHours() === hour
    && date.getMinutes() === minute
    && date.getSeconds() === second;
}

/**
 * 把作者时间输入规整为稳定的本地 ISO 文本，支持 `YYYY-MM-DD HH:mm[:ss]`、`YYYY-MM-DDTHH:mm[:ss]` 与日期-only 输入。
 */
export function normalizeCommitAuthorDateInput(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";

  const localMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (localMatch) {
    const year = Number(localMatch[1]);
    const month = Number(localMatch[2]);
    const day = Number(localMatch[3]);
    const hour = Number(localMatch[4] || "0");
    const minute = Number(localMatch[5] || "0");
    const second = Number(localMatch[6] || "0");
    if (!isValidCommitAuthorDateParts(year, month, day, hour, minute, second)) return "";
    return `${year}-${padCommitAuthorDatePart(month)}-${padCommitAuthorDatePart(day)}T${padCommitAuthorDatePart(hour)}:${padCommitAuthorDatePart(minute)}:${padCommitAuthorDatePart(second)}`;
  }

  return Number.isNaN(new Date(trimmed).getTime()) ? "" : trimmed;
}

/**
 * 判断作者时间输入是否有效，供 UI 即时提示复用。
 */
export function isCommitAuthorDateInputValid(raw: string): boolean {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return true;
  return !!normalizeCommitAuthorDateInput(trimmed);
}

/**
 * 创建提交高级选项默认状态，统一供主提交流程与右键提交入口复用。
 */
export function createCommitAdvancedOptionsState(options?: { runHooks?: boolean }): CommitAdvancedOptionsState {
  return {
    signOff: false,
    runHooks: options?.runHooks !== false,
    author: "",
    authorDate: "",
    cleanupMessage: false,
    commitRenamesSeparately: false,
  };
}

/**
 * 以最小增量更新提交高级选项字段，统一约束布尔值与字符串字段的回写语义。
 */
export function patchCommitAdvancedOptionsState(
  prev: CommitAdvancedOptionsState,
  patch: Partial<CommitAdvancedOptionsState>,
): CommitAdvancedOptionsState {
  const nextState = {
    signOff: patch.signOff ?? prev.signOff,
    runHooks: patch.runHooks ?? prev.runHooks,
    author: patch.author ?? prev.author,
    authorDate: patch.authorDate ?? prev.authorDate,
    cleanupMessage: patch.cleanupMessage ?? prev.cleanupMessage,
    commitRenamesSeparately: patch.commitRenamesSeparately ?? prev.commitRenamesSeparately,
  };
  if (
    nextState.signOff === prev.signOff
    && nextState.runHooks === prev.runHooks
    && nextState.author === prev.author
    && nextState.authorDate === prev.authorDate
    && nextState.cleanupMessage === prev.cleanupMessage
    && nextState.commitRenamesSeparately === prev.commitRenamesSeparately
  ) {
    return prev;
  }
  return nextState;
}

/**
 * 规整高级选项输入，去掉字符串首尾空白，避免 UI 状态把脏值透传到提交 payload。
 */
export function sanitizeCommitAdvancedOptionsState(state?: Partial<CommitAdvancedOptionsState> | null): CommitAdvancedOptionsState {
  return {
    signOff: state?.signOff === true,
    runHooks: state?.runHooks !== false,
    author: String(state?.author || "").trim(),
    authorDate: String(state?.authorDate || "").trim(),
    cleanupMessage: state?.cleanupMessage === true,
    commitRenamesSeparately: state?.commitRenamesSeparately === true,
  };
}

/**
 * 把高级选项状态归一化为提交 payload，仅保留已启用或有效的字段。
 */
export function normalizeCommitAdvancedOptionsPayload(
  state?: Partial<CommitAdvancedOptionsState> | null,
  hooksAvailability?: Partial<CommitHooksAvailability> | null,
): CommitAdvancedOptionsPayload {
  const sanitized = sanitizeCommitAdvancedOptionsState(state);
  const payload: CommitAdvancedOptionsPayload = {};
  if (sanitized.signOff) payload.signOff = true;
  const hooksDisabledByPolicy = hooksAvailability?.disabledByPolicy === true;
  const hooksAvailable = hooksAvailability?.available === true;
  if (hooksDisabledByPolicy || (hooksAvailable && sanitized.runHooks === false))
    payload.skipHooks = true;
  if (sanitized.cleanupMessage) payload.cleanupMessage = true;
  if (sanitized.commitRenamesSeparately) payload.commitRenamesSeparately = true;
  if (sanitized.author) payload.author = sanitized.author;
  const normalizedAuthorDate = normalizeCommitAuthorDateInput(sanitized.authorDate);
  if (normalizedAuthorDate) payload.authorDate = normalizedAuthorDate;
  return payload;
}

/**
 * 判断当前 workflow 是否存在任何已启用的高级选项，供面板摘要与重置逻辑复用。
 */
export function hasCommitAdvancedOptions(
  state?: Partial<CommitAdvancedOptionsState> | null,
  hooksAvailability?: Partial<CommitHooksAvailability> | null,
): boolean {
  return Object.keys(normalizeCommitAdvancedOptionsPayload(state, hooksAvailability)).length > 0;
}

/**
 * 把当前高级选项转换成简短摘要标签，便于在提交面板 footer 显示当前生效状态。
 */
export function buildCommitAdvancedOptionsSummary(
  state?: Partial<CommitAdvancedOptionsState> | null,
  hooksAvailability?: Partial<CommitHooksAvailability> | null,
  translate?: (key: string, fallback: string, values?: Record<string, unknown>) => string,
): string[] {
  const normalized = normalizeCommitAdvancedOptionsPayload(state, hooksAvailability);
  const labels: string[] = [];
  const gt = translate;
  if (normalized.signOff) labels.push(gt ? gt("commitOptions.summary.signOff", "Sign-off") : "Sign-off");
  if (normalized.skipHooks)
    labels.push(hooksAvailability?.disabledByPolicy === true
      ? (gt ? gt("commitOptions.summary.hooksDisabled", "Hooks 已全局禁用") : "Hooks 已全局禁用")
      : (gt ? gt("commitOptions.summary.hooksDisabledLocal", "不运行 Hooks") : "不运行 Hooks"));
  if (normalized.author) labels.push(gt ? gt("commitOptions.summary.author", "作者：{{value}}", { value: normalized.author }) : `作者：${normalized.author}`);
  if (normalized.authorDate) labels.push(gt ? gt("commitOptions.summary.authorDate", "作者时间") : "作者时间");
  if (normalized.cleanupMessage) labels.push(gt ? gt("commitOptions.summary.cleanupMessage", "清理消息") : "清理消息");
  if (normalized.commitRenamesSeparately) labels.push(gt ? gt("commitOptions.summary.commitRenamesSeparately", "重命名单独提交") : "重命名单独提交");
  return labels;
}
