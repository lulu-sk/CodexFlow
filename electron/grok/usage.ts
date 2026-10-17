// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { execInWslAsync } from "../wsl";
import { perfLogger } from "../log";

export type GrokUsageSnapshot = {
  providerId: "grok";
  source: "billing-api" | "billing-cache";
  collectedAt: number;
  updatedAt: number;
  accountEmail: string | null;
  subscriptionTier: string | null;
  quota: {
    usedPercent: number | null;
    periodType: string | null;
    periodStartAt: number | null;
    periodEndAt: number | null;
    includedUsedCents: number | null;
    includedLimitCents: number | null;
    onDemandEnabled: boolean | null;
    onDemandUsedCents: number | null;
    onDemandCapCents: number | null;
    prepaidBalanceCents: number | null;
    isUnifiedBillingUser: boolean | null;
  };
};

type ProviderRuntimeEnv = { terminal: "wsl" | "windows" | "pwsh" | "cmd"; distro?: string };

type GrokAuthRecord = {
  key?: unknown;
  auth_mode?: unknown;
  user_id?: unknown;
  email?: unknown;
  team_id?: unknown;
  team_name?: unknown;
  oidc_issuer?: unknown;
};

type GrokOAuthCredential = {
  token: string;
  userId: string;
  email: string | null;
  isTeam: boolean;
};

type GrokCredentialState =
  | { kind: "oauth"; credential: GrokOAuthCredential }
  | { kind: "api-key" }
  | { kind: "missing" };

type GrokUsageContext = {
  credential: GrokCredentialState;
  baseUrl: string;
};

const DEFAULT_BILLING_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const BILLING_REQUEST_TIMEOUT_MS = 15_000;
let lastVerifiedUsage: { identity: string; snapshot: GrokUsageSnapshot } | null = null;

/**
 * 将未知值转换为普通对象。
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * 将未知值转换为去除首尾空白的字符串。
 */
function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 将未知值转换为非负有限数。
 */
function toNonNegativeNumber(value: unknown): number | null {
  const normalized = typeof value === "string" ? value.trim() : value;
  if (normalized == null || normalized === "" || (typeof normalized !== "number" && typeof normalized !== "string")) return null;
  const numberValue = typeof normalized === "number" ? normalized : Number(normalized);
  if (!Number.isFinite(numberValue) || numberValue < 0) return null;
  return numberValue;
}

/**
 * 将未知值转换为可选布尔值。
 */
function toOptionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * 将 RFC 3339 时间转换为毫秒时间戳。
 */
function toTimestampMs(value: unknown): number | null {
  const text = toTrimmedString(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * 读取 JSON 对象，并兼容文件开头的 UTF-8 BOM。
 */
async function readJsonObjectAsync(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return parseJsonObject(await fsp.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 判断认证记录是否属于 Grok 官方 OAuth 登录。
 */
function isXaiOAuthRecord(scope: string, auth: GrokAuthRecord): boolean {
  const mode = toTrimmedString(auth.auth_mode).toLowerCase();
  if (mode !== "oidc") return false;
  const issuer = toTrimmedString(auth.oidc_issuer).replace(/\/$/, "").toLowerCase();
  const normalizedScope = scope.trim().toLowerCase();
  return issuer === "https://auth.x.ai"
    || issuer === "http://auth.x.ai.localhost"
    || normalizedScope.startsWith("https://auth.x.ai::")
    || normalizedScope.startsWith("http://auth.x.ai.localhost::");
}

/**
 * 按 Grok Build 默认优先级解析 OAuth 或 API Key 登录状态。
 */
function resolveCredentialState(store: Record<string, unknown> | null): GrokCredentialState {
  const entries = Object.entries(store || {});
  for (const [scope, rawAuth] of entries) {
    const auth = asRecord(rawAuth) as GrokAuthRecord | null;
    if (!auth || !isXaiOAuthRecord(scope, auth)) continue;
    const token = toTrimmedString(auth.key);
    const userId = toTrimmedString(auth.user_id);
    if (!token || !userId) continue;
    return {
      kind: "oauth",
      credential: {
        token,
        userId,
        email: toTrimmedString(auth.email) || null,
        isTeam: Boolean(toTrimmedString(auth.team_id) || toTrimmedString(auth.team_name)),
      },
    };
  }

  const hasApiKeyRecord = entries.some(([scope, rawAuth]) => {
    const auth = asRecord(rawAuth) as GrokAuthRecord | null;
    const mode = toTrimmedString(auth?.auth_mode).toLowerCase();
    return scope.trim().toLowerCase() === "xai::api_key" || mode === "api_key";
  });
  return hasApiKeyRecord ? { kind: "api-key" } : { kind: "missing" };
}

/**
 * 读取 JSON 文本，并兼容文件开头的 UTF-8 BOM。
 */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  try { return asRecord(JSON.parse(raw.replace(/^\uFEFF/, ""))); }
  catch { return null; }
}

/**
 * 读取当前 Grok 主目录中的认证状态。
 */
async function resolveUsageContextAsync(env: ProviderRuntimeEnv): Promise<GrokUsageContext> {
  if (env.terminal === "wsl") {
    const script = [
      'printf "PROXY=%s\\n" "${GROK_CLI_CHAT_PROXY_BASE_URL:-}"',
      'printf "API_KEY=%s\\n" "${XAI_API_KEY:+yes}"',
      'cat "${GROK_AUTH_PATH:-${GROK_HOME:-$HOME/.grok}/auth.json}" 2>/dev/null || true',
    ].join("\n");
    const raw = await execInWslAsync(env.distro, script, { timeoutMs: 5000 });
    if (raw == null) throw new Error("GROK_USAGE_AUTH_REQUIRED");
    const [proxyLine, apiKeyLine, ...authLines] = raw.split(/\r?\n/);
    const credential = resolveCredentialState(parseJsonObject(authLines.join("\n")));
    return {
      credential: credential.kind === "missing" && apiKeyLine === "API_KEY=yes" ? { kind: "api-key" } : credential,
      baseUrl: resolveBillingBaseUrl(proxyLine?.replace(/^PROXY=/, "")),
    };
  }
  const home = toTrimmedString(process.env.GROK_HOME) || path.join(os.homedir(), ".grok");
  const configuredAuthPath = toTrimmedString(process.env.GROK_AUTH_PATH);
  const store = await readJsonObjectAsync(configuredAuthPath || path.join(home, "auth.json"));
  const credential = resolveCredentialState(store);
  return {
    credential: credential.kind === "missing" && toTrimmedString(process.env.XAI_API_KEY) ? { kind: "api-key" } : credential,
    baseUrl: resolveBillingBaseUrl(process.env.GROK_CLI_CHAT_PROXY_BASE_URL),
  };
}

/**
 * 读取官方 Cent 对象；字段存在但 val 被 proto3 省略时按 0 处理。
 */
function readCent(config: Record<string, unknown>, key: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(config, key)) return null;
  const cent = asRecord(config[key]);
  if (!cent) return null;
  return Object.prototype.hasOwnProperty.call(cent, "val") ? toNonNegativeNumber(cent.val) : 0;
}

/**
 * 判断额度快照是否包含至少一项可展示的账号信息。
 */
function hasQuotaData(snapshot: GrokUsageSnapshot): boolean {
  const quota = snapshot.quota;
  return snapshot.subscriptionTier != null
    || quota.usedPercent != null
    || quota.includedUsedCents != null
    || quota.includedLimitCents != null
    || quota.onDemandUsedCents != null
    || quota.onDemandCapCents != null
    || quota.prepaidBalanceCents != null;
}

/**
 * 将 Grok 官方 billing 响应解析为稳定的账号额度快照。
 */
function parseBillingSnapshot(
  value: unknown,
  source: GrokUsageSnapshot["source"],
  updatedAt: number,
  accountEmail: string | null,
): GrokUsageSnapshot | null {
  const response = asRecord(value);
  const config = asRecord(response?.config);
  if (!response || !config) return null;

  const includedUsedCents = readCent(config, "used");
  const includedLimitCents = readCent(config, "monthlyLimit");
  const reportedPercent = toNonNegativeNumber(config.creditUsagePercent);
  const derivedPercent = includedUsedCents != null && includedLimitCents != null && includedLimitCents > 0
    ? (includedUsedCents / includedLimitCents) * 100
    : null;
  const currentPeriod = asRecord(config.currentPeriod);
  const snapshot: GrokUsageSnapshot = {
    providerId: "grok",
    source,
    collectedAt: Date.now(),
    updatedAt,
    accountEmail,
    subscriptionTier: toTrimmedString(response.subscriptionTier ?? response.subscription_tier) || null,
    quota: {
      usedPercent: reportedPercent ?? derivedPercent,
      periodType: toTrimmedString(currentPeriod?.type) || null,
      periodStartAt: toTimestampMs(currentPeriod?.start) ?? toTimestampMs(config.billingPeriodStart),
      periodEndAt: toTimestampMs(currentPeriod?.end) ?? toTimestampMs(config.billingPeriodEnd),
      includedUsedCents,
      includedLimitCents,
      onDemandEnabled: toOptionalBoolean(response.onDemandEnabled ?? response.on_demand_enabled),
      onDemandUsedCents: readCent(config, "onDemandUsed"),
      onDemandCapCents: readCent(config, "onDemandCap"),
      prepaidBalanceCents: readCent(config, "prepaidBalance"),
      isUnifiedBillingUser: toOptionalBoolean(config.isUnifiedBillingUser),
    },
  };
  return hasQuotaData(snapshot) ? snapshot : null;
}

/**
 * 解析可选的 Grok 代理地址，仅允许 HTTP(S) 地址。
 */
function resolveBillingBaseUrl(value: unknown): string {
  const configured = toTrimmedString(value).replace(/\/$/, "");
  if (/^https?:\/\//i.test(configured)) return configured;
  return DEFAULT_BILLING_BASE_URL;
}

/**
 * 使用 Grok 官方 OAuth 身份实时获取账号额度。
 */
async function fetchBillingSnapshotAsync(credential: GrokOAuthCredential, baseUrl: string): Promise<GrokUsageSnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BILLING_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/billing?format=credits`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential.token}`,
        "X-XAI-Token-Auth": "xai-grok-cli",
        "x-userid": credential.userId,
        "x-grok-client-version": "codexflow",
        "x-grok-client-mode": "interactive",
      },
    });
    const raw = await response.text().catch(() => "");
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new Error("GROK_USAGE_AUTH_EXPIRED");
      throw new Error(`GROK_USAGE_REQUEST_FAILED:${response.status}`);
    }
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error("GROK_USAGE_RESPONSE_INVALID");
    }
    const snapshot = parseBillingSnapshot(parsed, "billing-api", Date.now(), credential.email);
    if (!snapshot) throw new Error("GROK_USAGE_NOT_AVAILABLE");
    return snapshot;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error("GROK_USAGE_REQUEST_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 获取 Grok Build 当前账号的消费者额度快照。
 */
export async function getGrokUsageSnapshotAsync(env: ProviderRuntimeEnv): Promise<GrokUsageSnapshot> {
  return perfLogger.time("[grok] account usage snapshot", async () => {
    const { baseUrl, credential } = await resolveUsageContextAsync(env);
    const identity = credential.kind === "oauth"
      ? createHash("sha256").update(`${env.terminal}:${env.distro || ""}:${baseUrl}\0${credential.credential.userId}\0${credential.credential.token}`).digest("hex")
      : "";
    if (lastVerifiedUsage?.identity !== identity) lastVerifiedUsage = null;
    if (credential.kind === "api-key") throw new Error("GROK_USAGE_API_KEY_UNSUPPORTED");
    if (credential.kind === "missing") throw new Error("GROK_USAGE_AUTH_REQUIRED");
    if (credential.credential.isTeam) throw new Error("GROK_USAGE_TEAM_UNSUPPORTED");

    try {
      const snapshot = await fetchBillingSnapshotAsync(credential.credential, baseUrl);
      lastVerifiedUsage = { identity, snapshot };
      return snapshot;
    } catch (error) {
      // 认证失败时不能借用其他登录时期的日志掩盖失效状态。
      if (error instanceof Error && error.message === "GROK_USAGE_AUTH_EXPIRED") {
        lastVerifiedUsage = null;
        throw error;
      }
      const cached = lastVerifiedUsage?.identity === identity ? lastVerifiedUsage.snapshot : null;
      if (cached && Date.now() - cached.updatedAt >= 0 && Date.now() - cached.updatedAt <= 5 * 60_000)
        return { ...cached, source: "billing-cache", collectedAt: Date.now() };
      throw error;
    }
  });
}

export const __grokUsageTest = {
  parseBillingSnapshot,
  resolveCredentialState,
};
