import type { CodexCliErrorKind } from "./codex-cli-error-classifier";

export type CodexAutoContinueErrorKind = Extract<
  CodexCliErrorKind,
  "rateLimited" | "concurrency" | "networkStream" | "badGateway" | "serviceUnavailable" | "highDemand" | "modelCapacity" | "forbidden" | "badRequest"
>;

export type CodexErrorHandlingPrefs = {
  detectionEnabled: boolean;
  notifyReconnectErrors: boolean;
  autoContinueEnabled: boolean;
  autoContinueErrorKinds: CodexAutoContinueErrorKind[];
  autoContinueErrorKindsVersion: number;
  autoContinueDelaySeconds: number;
  autoContinueMaxAttempts: number;
};

export const CODEX_ERROR_AUTO_CONTINUE_DELAY_MIN_SECONDS = 5;
export const CODEX_ERROR_AUTO_CONTINUE_DELAY_MAX_SECONDS = 600;
export const CODEX_ERROR_AUTO_CONTINUE_ATTEMPTS_MIN = 0;
export const CODEX_ERROR_AUTO_CONTINUE_ATTEMPTS_MAX = 10;
export const CODEX_AUTO_CONTINUE_ERROR_KINDS_VERSION = 3;
export const CODEX_AUTO_CONTINUE_ERROR_KINDS: CodexAutoContinueErrorKind[] = [
  "networkStream",
  "rateLimited",
  "concurrency",
  "modelCapacity",
  "badGateway",
  "serviceUnavailable",
  "highDemand",
  "forbidden",
  "badRequest",
];

const LEGACY_CODEX_AUTO_CONTINUE_ERROR_KINDS_V1: CodexAutoContinueErrorKind[] = [
  "networkStream",
  "rateLimited",
  "concurrency",
  "badGateway",
  "serviceUnavailable",
];

const LEGACY_CODEX_AUTO_CONTINUE_ERROR_KINDS_V2: CodexAutoContinueErrorKind[] = [
  "networkStream",
  "rateLimited",
  "concurrency",
  "modelCapacity",
  "badGateway",
  "serviceUnavailable",
  "forbidden",
  "badRequest",
];

export const DEFAULT_CODEX_ERROR_HANDLING_PREFS: CodexErrorHandlingPrefs = {
  detectionEnabled: true,
  notifyReconnectErrors: false,
  autoContinueEnabled: false,
  autoContinueErrorKinds: [...CODEX_AUTO_CONTINUE_ERROR_KINDS],
  autoContinueErrorKindsVersion: CODEX_AUTO_CONTINUE_ERROR_KINDS_VERSION,
  autoContinueDelaySeconds: 30,
  autoContinueMaxAttempts: 2,
};

/**
 * 判断错误类型是否属于可配置自动 continue 的可恢复错误。
 */
export function isCodexAutoContinueErrorKind(kind: CodexCliErrorKind | undefined): kind is CodexAutoContinueErrorKind {
  if (!kind) return false;
  return CODEX_AUTO_CONTINUE_ERROR_KINDS.includes(kind as CodexAutoContinueErrorKind);
}

/**
 * 将输入值归一化为指定区间内的整数。
 */
function normalizeBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.round(numeric);
  return Math.min(max, Math.max(min, rounded));
}

/**
 * 归一化自动 continue 错误类型列表版本，缺失版本按旧配置处理。
 */
function normalizeAutoContinueErrorKindsVersion(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.min(CODEX_AUTO_CONTINUE_ERROR_KINDS_VERSION, Math.floor(numeric));
}

/**
 * 判断两个错误类型列表是否包含同一组类型。
 */
function hasSameAutoContinueErrorKinds(left: CodexAutoContinueErrorKind[], right: CodexAutoContinueErrorKind[]): boolean {
  return (
    left.length === right.length &&
    right.every((kind) => left.includes(kind))
  );
}

/**
 * 判断旧配置是否仍是当时版本的默认全选列表。
 */
function shouldUpgradeLegacyDefaultAutoContinueErrorKinds(kinds: CodexAutoContinueErrorKind[], version: number): boolean {
  if (version < 2 && hasSameAutoContinueErrorKinds(kinds, LEGACY_CODEX_AUTO_CONTINUE_ERROR_KINDS_V1)) return true;
  if (version < 3 && hasSameAutoContinueErrorKinds(kinds, LEGACY_CODEX_AUTO_CONTINUE_ERROR_KINDS_V2)) return true;
  return false;
}

/**
 * 归一化自动 continue 适用的错误类型列表，保留用户明确清空的选择。
 */
function normalizeAutoContinueErrorKinds(value: unknown, version: number): CodexAutoContinueErrorKind[] {
  if (!Array.isArray(value)) return [...DEFAULT_CODEX_ERROR_HANDLING_PREFS.autoContinueErrorKinds];
  const allowed = new Set<CodexAutoContinueErrorKind>(CODEX_AUTO_CONTINUE_ERROR_KINDS);
  const next: CodexAutoContinueErrorKind[] = [];
  for (const item of value) {
    const kind = String(item || "").trim() as CodexCliErrorKind;
    if (!isCodexAutoContinueErrorKind(kind) || !allowed.has(kind) || next.includes(kind)) continue;
    next.push(kind);
  }
  if (shouldUpgradeLegacyDefaultAutoContinueErrorKinds(next, version)) {
    return [...DEFAULT_CODEX_ERROR_HANDLING_PREFS.autoContinueErrorKinds];
  }
  return next;
}

/**
 * 归一化 Codex TUI 错误识别与自动 continue 设置，保证运行时使用稳定结构。
 */
export function normalizeCodexErrorHandlingPrefs(value: unknown): CodexErrorHandlingPrefs {
  const raw = value && typeof value === "object" ? (value as Partial<CodexErrorHandlingPrefs>) : {};
  const autoContinueErrorKindsVersion = normalizeAutoContinueErrorKindsVersion(raw.autoContinueErrorKindsVersion);
  return {
    detectionEnabled: raw.detectionEnabled !== false,
    notifyReconnectErrors: raw.notifyReconnectErrors === true,
    autoContinueEnabled: raw.autoContinueEnabled === true,
    autoContinueErrorKinds: normalizeAutoContinueErrorKinds(raw.autoContinueErrorKinds, autoContinueErrorKindsVersion),
    autoContinueErrorKindsVersion: CODEX_AUTO_CONTINUE_ERROR_KINDS_VERSION,
    autoContinueDelaySeconds: normalizeBoundedInteger(
      raw.autoContinueDelaySeconds,
      DEFAULT_CODEX_ERROR_HANDLING_PREFS.autoContinueDelaySeconds,
      CODEX_ERROR_AUTO_CONTINUE_DELAY_MIN_SECONDS,
      CODEX_ERROR_AUTO_CONTINUE_DELAY_MAX_SECONDS,
    ),
    autoContinueMaxAttempts: normalizeBoundedInteger(
      raw.autoContinueMaxAttempts,
      DEFAULT_CODEX_ERROR_HANDLING_PREFS.autoContinueMaxAttempts,
      CODEX_ERROR_AUTO_CONTINUE_ATTEMPTS_MIN,
      CODEX_ERROR_AUTO_CONTINUE_ATTEMPTS_MAX,
    ),
  };
}
