// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Gauge, RotateCcw } from "lucide-react";
import type { AppSettings, CodexAccountInfo, CodexRateLimitSnapshot } from "@/types/host";
import {
  computeRefreshInterval,
  formatPercent,
  formatResetTime,
  formatUsageSummaryLabel,
  formatWindowLabel,
  resolveDominantUsageWindow,
  translateRateLimitError,
  translateCodexBridgeError,
  CODEX_RATE_REFRESH_EVENT,
  CODEX_AUTH_CHANGED_EVENT,
} from "@/lib/codex-status";
import { useHoverCard } from "@/components/topbar/hover-card";

type FetchState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

type TerminalMode = NonNullable<AppSettings["terminal"]>;

/**
 * 解析 Codex 用量请求的运行环境键，用于在终端模式/发行版变化时触发重新拉取。
 */
function resolveCodexEnvKey(terminalMode?: TerminalMode, distro?: string): string {
  if (terminalMode === "wsl") return `wsl:${distro ?? ""}`;
  if (terminalMode === "pwsh") return "windows-pwsh";
  if (terminalMode === "windows") return "windows";
  return "default";
}

type CodexRateCacheEntry = {
  attemptedAt: number | null;
  data: CodexRateLimitSnapshot | null;
  error: string | null;
};

const CODEX_RATE_CACHE = new Map<string, CodexRateCacheEntry>();

/**
 * 读取 Codex 用量缓存（按 envKey 区分），用于避免频繁的自动刷新。
 */
function readCodexRateCache(envKey: string): CodexRateCacheEntry {
  const cached = CODEX_RATE_CACHE.get(envKey);
  if (cached) return cached;
  const empty: CodexRateCacheEntry = { attemptedAt: null, data: null, error: null };
  CODEX_RATE_CACHE.set(envKey, empty);
  return empty;
}

type CodexAccountCacheEntry = {
  attemptedAt: number | null;
  data: CodexAccountInfo | null;
  error: string | null;
};

const CODEX_ACCOUNT_CACHE = new Map<string, CodexAccountCacheEntry>();

/**
 * 读取 Codex 账号缓存（按 envKey 区分），用于避免重复拉取账号信息。
 */
function readCodexAccountCache(envKey: string): CodexAccountCacheEntry {
  const cached = CODEX_ACCOUNT_CACHE.get(envKey);
  if (cached) return cached;
  const empty: CodexAccountCacheEntry = { attemptedAt: null, data: null, error: null };
  CODEX_ACCOUNT_CACHE.set(envKey, empty);
  return empty;
}

/**
 * 使用带缓存的 Codex 账号状态：用于在顶部栏用量面板展示“状态/套餐”。
 */
function useCodexAccountCached(envKey: string): [
  FetchState<CodexAccountInfo>,
  () => void,
  { attempted: boolean },
] {
  const { t } = useTranslation(["settings"]);
  const [attempted, setAttempted] = useState<boolean>(() => readCodexAccountCache(envKey).attemptedAt != null);
  const [state, setState] = useState<FetchState<CodexAccountInfo>>(() => {
    const cached = readCodexAccountCache(envKey);
    return { loading: false, error: cached.error, data: cached.data };
  });

  useEffect(() => {
    const cached = readCodexAccountCache(envKey);
    setAttempted(cached.attemptedAt != null);
    setState({ loading: false, error: cached.error, data: cached.data });
  }, [envKey]);

  const fetchAccount = useCallback(async () => {
    const now = Date.now();
    setAttempted(true);
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await window.host.codex.getAccountInfo();
      if (res.ok) {
        const entry: CodexAccountCacheEntry = { attemptedAt: now, error: null, data: res.info ?? null };
        CODEX_ACCOUNT_CACHE.set(envKey, entry);
        setState({ loading: false, error: null, data: entry.data });
      } else {
        const errorText = t("settings:codexAccount.statusError", "账号信息不可用") as string;
        const entry: CodexAccountCacheEntry = { attemptedAt: now, error: errorText, data: null };
        CODEX_ACCOUNT_CACHE.set(envKey, entry);
        setState({ loading: false, error: errorText, data: null });
      }
    } catch {
      const errorText = t("settings:codexAccount.statusError", "账号信息不可用") as string;
      const entry: CodexAccountCacheEntry = { attemptedAt: now, error: errorText, data: null };
      CODEX_ACCOUNT_CACHE.set(envKey, entry);
      setState({ loading: false, error: errorText, data: null });
    }
  }, [envKey, t]);

  // 监听“账号已切换”事件：清空缓存并立即重新拉取
  useEffect(() => {
    const onAuthChanged = () => {
      try {
        CODEX_ACCOUNT_CACHE.set(envKey, { attemptedAt: null, data: null, error: null });
        setAttempted(false);
        setState({ loading: false, error: null, data: null });
        fetchAccount();
      } catch {}
    };
    window.addEventListener(CODEX_AUTH_CHANGED_EVENT, onAuthChanged as any);
    return () => window.removeEventListener(CODEX_AUTH_CHANGED_EVENT, onAuthChanged as any);
  }, [envKey, fetchAccount]);

  return [state, fetchAccount, { attempted }];
}

function useCodexAccount(
  auto = true,
  translateError?: (error: unknown) => string,
): [FetchState<CodexAccountInfo>, () => void] {
  const [state, setState] = useState<FetchState<CodexAccountInfo>>({
    loading: false,
    error: null,
    data: null,
  });
  const resolveError = useCallback(
    (error: unknown) => {
      if (translateError) return translateError(error);
      if (error == null) return "Unable to load account information";
      const text = String(error).trim();
      return text || "Unable to load account information";
    },
    [translateError],
  );
  const fetchAccount = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await window.host.codex.getAccountInfo();
      if (res.ok) {
        setState({ loading: false, error: null, data: res.info ?? null });
      } else {
        setState({
          loading: false,
          error: resolveError(res.error),
          data: null,
        });
      }
    } catch (err) {
      setState({
        loading: false,
        error: resolveError(err),
        data: null,
      });
    }
  }, [resolveError]);
  useEffect(() => {
    if (auto) fetchAccount();
  }, [auto, fetchAccount]);

  // 监听“账号已切换”事件：立即重新拉取账号信息
  useEffect(() => {
    const onAuthChanged = () => {
      try { fetchAccount(); } catch {}
    };
    window.addEventListener(CODEX_AUTH_CHANGED_EVENT, onAuthChanged as any);
    return () => window.removeEventListener(CODEX_AUTH_CHANGED_EVENT, onAuthChanged as any);
  }, [fetchAccount]);

  return [state, fetchAccount];
}

function useCodexRate(auto = true): [FetchState<CodexRateLimitSnapshot>, () => void] {
  const { t } = useTranslation(["common"]);
  const resolveErrorMessage = useCallback(
    (error: unknown) => translateRateLimitError(error, t),
    [t],
  );
  const [state, setState] = useState<FetchState<CodexRateLimitSnapshot>>({
    loading: false,
    error: null,
    data: null,
  });
  const fetchRate = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await window.host.codex.getRateLimit();
      if (res.ok) {
        setState({ loading: false, error: null, data: res.snapshot ?? null });
      } else {
        setState({
          loading: false,
          error: resolveErrorMessage(res.error),
          data: null,
        });
      }
    } catch (err) {
      setState({
        loading: false,
        error: resolveErrorMessage(err),
        data: null,
      });
    }
  }, [resolveErrorMessage]);
  useEffect(() => {
    if (auto) fetchRate();
  }, [auto, fetchRate]);
  return [state, fetchRate];
}

type CodexRateLoadPolicy = "always" | "ifMissing" | "never";

/**
 * 使用带缓存的 Codex 用量状态：避免组件反复挂载时重复拉取；支持“仅首次无缓存时自动拉取”。
 */
function useCodexRateCached(envKey: string): [
  FetchState<CodexRateLimitSnapshot>,
  () => void,
  { attempted: boolean },
] {
  const { t } = useTranslation(["common"]);
  const resolveErrorMessage = useCallback(
    (error: unknown) => translateRateLimitError(error, t),
    [t],
  );

  const [attempted, setAttempted] = useState<boolean>(() => readCodexRateCache(envKey).attemptedAt != null);
  const [state, setState] = useState<FetchState<CodexRateLimitSnapshot>>(() => {
    const cached = readCodexRateCache(envKey);
    return {
      loading: false,
      error: cached.error,
      data: cached.data,
    };
  });

  useEffect(() => {
    const cached = readCodexRateCache(envKey);
    setAttempted(cached.attemptedAt != null);
    setState({
      loading: false,
      error: cached.error,
      data: cached.data,
    });
  }, [envKey]);

  const fetchRate = useCallback(async () => {
    const now = Date.now();
    setAttempted(true);
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await window.host.codex.getRateLimit();
      if (res.ok) {
        const entry: CodexRateCacheEntry = { attemptedAt: now, error: null, data: res.snapshot ?? null };
        CODEX_RATE_CACHE.set(envKey, entry);
        setState({ loading: false, error: null, data: entry.data });
      } else {
        const errorText = resolveErrorMessage(res.error);
        const entry: CodexRateCacheEntry = { attemptedAt: now, error: errorText, data: null };
        CODEX_RATE_CACHE.set(envKey, entry);
        setState({ loading: false, error: errorText, data: null });
      }
    } catch (err) {
      const errorText = resolveErrorMessage(err);
      const entry: CodexRateCacheEntry = { attemptedAt: now, error: errorText, data: null };
      CODEX_RATE_CACHE.set(envKey, entry);
      setState({ loading: false, error: errorText, data: null });
    }
  }, [envKey, resolveErrorMessage]);

  // 监听“账号已切换”事件：清空缓存并立即重新拉取用量
  useEffect(() => {
    const onAuthChanged = () => {
      try {
        CODEX_RATE_CACHE.set(envKey, { attemptedAt: null, data: null, error: null });
        setAttempted(false);
        setState({ loading: false, error: null, data: null });
        fetchRate();
      } catch {}
    };
    window.addEventListener(CODEX_AUTH_CHANGED_EVENT, onAuthChanged as any);
    return () => window.removeEventListener(CODEX_AUTH_CHANGED_EVENT, onAuthChanged as any);
  }, [envKey, fetchRate]);

  return [state, fetchRate, { attempted }];
}

type CodexUsageHoverCardTriggerArgs = {
  rateState: FetchState<CodexRateLimitSnapshot>;
  percentLabel: string;
  summaryLabel: string;
};

export type CodexUsageHoverCardProps = {
  className?: string;
  terminalMode?: TerminalMode;
  distro?: string;
  renderTrigger: (args: CodexUsageHoverCardTriggerArgs) => React.ReactNode;
  panelAlign?: "start" | "end";
  loadPolicy?: CodexRateLoadPolicy;
  enableAutoRefreshInterval?: boolean;
  enableGlobalRefreshEvent?: boolean;
};

/**
 * Codex 用量 Hover Card：提供统一的 hover 行为与用量面板渲染，触发器由调用方自定义。
 */
export const CodexUsageHoverCard: React.FC<CodexUsageHoverCardProps> = ({
  className,
  terminalMode,
  distro,
  renderTrigger,
  panelAlign = "start",
  loadPolicy = "always",
  enableAutoRefreshInterval = true,
  enableGlobalRefreshEvent = true,
}) => {
  const { t, i18n } = useTranslation(["common", "settings"]);
  const envKey = useMemo(() => resolveCodexEnvKey(terminalMode, distro), [terminalMode, distro]);
  const [rateState, reloadRate] = useCodexRateCached(envKey);
  const [accountState, reloadAccount, accountMeta] = useCodexAccountCached(envKey);
  const hover = useHoverCard();
  const lastManualRefreshAtRef = useRef<number>(0);
  const lastAutoLoadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!hover.open) return;
    if (accountMeta.attempted) return;
    reloadAccount();
  }, [accountMeta.attempted, hover.open, reloadAccount]);

  useEffect(() => {
    if (loadPolicy === "never") return;
    if (lastAutoLoadKeyRef.current === envKey) return;
    lastAutoLoadKeyRef.current = envKey;
    if (loadPolicy === "always") {
      reloadRate();
      return;
    }
    const attemptedInCache = readCodexRateCache(envKey).attemptedAt != null;
    if (loadPolicy === "ifMissing" && !attemptedInCache) {
      reloadRate();
    }
  }, [envKey, loadPolicy, reloadRate]);

  // 监听渲染进程全局的“用量刷新请求”事件；冷却时间 1 分钟
  useEffect(() => {
    if (!enableGlobalRefreshEvent) return undefined;
    const onRefresh = () => {
      try {
        const now = Date.now();
        if (now - (lastManualRefreshAtRef.current || 0) < 60_000) return;
        lastManualRefreshAtRef.current = now;
        reloadRate();
      } catch {}
    };
    window.addEventListener(CODEX_RATE_REFRESH_EVENT, onRefresh as any);
    return () => window.removeEventListener(CODEX_RATE_REFRESH_EVENT, onRefresh as any);
  }, [enableGlobalRefreshEvent, reloadRate]);

  useEffect(() => {
    if (!enableAutoRefreshInterval) return undefined;
    if (!rateState.data) return undefined;
    const interval = computeRefreshInterval(rateState.data);
    const timer = window.setTimeout(() => reloadRate(), interval);
    return () => window.clearTimeout(timer);
  }, [enableAutoRefreshInterval, rateState.data, reloadRate]);

  const dominantWindow = useMemo(
    () => resolveDominantUsageWindow(rateState.data ?? null),
    [rateState.data],
  );
  const percentUsed = useMemo(() => {
    if (!rateState.data) return null;
    const values = [
      rateState.data.primary?.usedPercent,
      rateState.data.secondary?.usedPercent,
    ].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return values.length > 0 ? Math.max(...values) : null;
  }, [rateState.data]);
  const percentLabel = dominantWindow
    ? formatPercent(dominantWindow.usedPercent ?? null)
    : formatPercent(percentUsed);

  const summaryLabel = rateState.loading
    ? t("common:codexUsage.loading", "加载用量…")
    : rateState.error
      ? t("common:codexUsage.unavailable", "用量不可用")
      : dominantWindow
        ? formatUsageSummaryLabel(dominantWindow, dominantWindow.usedPercent ?? null, t)
      : percentUsed != null
        ? formatUsageSummaryLabel(null, percentUsed, t)
        : t("common:codexUsage.title", "用量");

  const signedIn = useMemo(() => {
    const account = accountState.data;
    if (!account) return false;
    return !!(account.email || account.accountId || account.userId);
  }, [accountState.data]);

  const accountStatusText = useMemo(() => {
    if (!accountMeta.attempted && hover.open) {
      return t("settings:codexAccount.statusLoading", "正在读取账号信息…") as string;
    }
    if (accountState.loading && !accountState.data) {
      return t("settings:codexAccount.statusLoading", "正在读取账号信息…") as string;
    }
    if (accountState.error) {
      return t("settings:codexAccount.statusError", "账号信息不可用") as string;
    }
    return resolveAccountLabel(accountState.data, t);
  }, [accountMeta.attempted, accountState.data, accountState.error, accountState.loading, hover.open, t]);

  const planText = useMemo(() => {
    if (!signedIn) return "";
    return describePlan(accountState.data?.plan ?? null, t);
  }, [accountState.data?.plan, signedIn, t]);

  const planBadgeText = useMemo(() => {
    if (!accountMeta.attempted && hover.open) return "…";
    if (accountState.loading && !accountState.data) return "…";
    if (accountState.error) return "—";
    if (!signedIn) return "—";
    return planText;
  }, [
    accountMeta.attempted,
    accountState.data,
    accountState.error,
    accountState.loading,
    hover.open,
    planText,
    signedIn,
  ]);

  return (
    <div
      className={`relative ${className ?? ""}`}
      onMouseEnter={hover.onEnter}
      onMouseLeave={hover.onLeave}
    >
      {renderTrigger({ rateState, percentLabel, summaryLabel })}
      {hover.open && (
        <div
          className={`absolute top-full z-[70] mt-2 w-[320px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple-lg p-4 text-sm text-[var(--cf-text-primary)] shadow-apple-xl dark:shadow-apple-dark-xl ${panelAlign === "end" ? "right-0" : "left-0"}`}
        >
          <div className="mb-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-apple-medium text-[var(--cf-text-secondary)]">
                {t("common:account", "账号")}
              </span>
              <span
                className={`min-w-0 truncate text-right ${accountState.error ? "text-[var(--cf-red)]" : ""}`}
                title={accountStatusText}
              >
                {accountStatusText}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-apple-medium text-[var(--cf-text-secondary)]">
                {t("settings:codexAccount.planLabel", "套餐")}
              </span>
              <Badge
                variant={signedIn ? "secondary" : "outline"}
                className={`shrink-0 ${signedIn ? "" : "opacity-70"}`}
                title={signedIn ? planText : ""}
              >
                {planBadgeText}
              </Badge>
            </div>
          </div>
          {rateState.error ? (
            <div className="text-[var(--cf-red)]">{rateState.error}</div>
          ) : rateState.data ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-2.5 shadow-apple-xs">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-apple-medium text-[var(--cf-text-secondary)]">
                    {t("common:codexUsage.primary", "主要额度")}
                  </span>
                  <Badge variant="outline">
                    {formatWindowLabel(rateState.data.primary, t)}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-[var(--cf-text-primary)]">
                  <span className="font-apple-medium">
                    {t("common:codexUsage.summary", {
                      percent: formatPercent(rateState.data.primary?.usedPercent ?? null),
                    })}
                  </span>
                  <span className="text-xs text-[var(--cf-text-secondary)]">
                    {t("common:codexUsage.reset", {
                      time: formatResetTime(
                        rateState.data.primary?.resetAfterSeconds ?? null,
                        t,
                        i18n.language,
                      ),
                    })}
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-2.5 shadow-apple-xs">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-apple-medium text-[var(--cf-text-secondary)]">
                    {t("common:codexUsage.secondary", "备用额度")}
                  </span>
                  <Badge variant="outline">
                    {formatWindowLabel(rateState.data.secondary, t)}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-[var(--cf-text-primary)]">
                  <span className="font-apple-medium">
                    {t("common:codexUsage.summary", {
                      percent: formatPercent(rateState.data.secondary?.usedPercent ?? null),
                    })}
                  </span>
                  <span className="text-xs text-[var(--cf-text-secondary)]">
                    {t("common:codexUsage.reset", {
                      time: formatResetTime(
                        rateState.data.secondary?.resetAfterSeconds ?? null,
                        t,
                        i18n.language,
                      ),
                    })}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-[var(--cf-text-secondary)]">
              {t("common:codexUsage.empty", "暂无用量信息")}
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={(e) => {
                e.preventDefault();
                reloadRate();
                reloadAccount();
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t("common:refresh", "刷新")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

const PLAN_KEYS: Record<string, string> = {
  free: "settings:codexAccount.plan.free",
  plus: "settings:codexAccount.plan.plus",
  pro: "settings:codexAccount.plan.pro",
  team: "settings:codexAccount.plan.team",
  business: "settings:codexAccount.plan.business",
  deprecated_enterprise: "settings:codexAccount.plan.business",
  education: "settings:codexAccount.plan.education",
  deprecated_edu: "settings:codexAccount.plan.education",
};

function resolveAccountLabel(account: CodexAccountInfo | null, t: TFunction): string {
  if (!account) return t("settings:codexAccount.statusUnknown", "未登录");
  if (account.email) return account.email;
  if (account.accountId) return account.accountId;
  if (account.userId) return account.userId;
  return t("settings:codexAccount.statusUnknown", "未登录");
}

function describePlan(plan: string | null, t: TFunction): string {
  if (!plan) return t("settings:codexAccount.plan.unknown", "未知套餐");
  const key = PLAN_KEYS[plan];
  return key ? t(key) : plan;
}

/**
 * 顶部栏 Codex 用量按钮：显示摘要文案，悬停展开详情并允许手动刷新。
 */
const CodexUsageHoverButton: React.FC<{ className?: string; terminalMode?: TerminalMode; distro?: string }> = ({ className, terminalMode, distro }) => {
  return (
    <CodexUsageHoverCard
      className={className}
      terminalMode={terminalMode}
      distro={distro}
      renderTrigger={({ summaryLabel }) => (
        <Button variant="ghost" size="sm" className="flex items-center gap-2 px-2">
          <Gauge className="h-4 w-4" />
          <span className="truncate max-w-[200px]">{summaryLabel}</span>
        </Button>
      )}
    />
  );
};

export type CodexUsageInlinePercentProps = {
  terminalMode?: TerminalMode;
  distro?: string;
  className?: string;
  triggerVariant?: ButtonProps["variant"];
  triggerSize?: ButtonProps["size"];
  triggerClassName?: string;
};

/**
 * 顶部栏内联用量展示：仅显示百分比（选中 Codex 时可见），悬停可展开详情并允许手动刷新。
 */
export const CodexUsageInlinePercent: React.FC<CodexUsageInlinePercentProps> = ({ className, terminalMode, distro, triggerVariant = "secondary", triggerSize = "sm", triggerClassName }) => {
  return (
    <CodexUsageHoverCard
      className={className}
      terminalMode={terminalMode}
      distro={distro}
      renderTrigger={({ rateState, percentLabel }) => (
        <Button
          variant={triggerVariant}
          size={triggerSize}
          className={`h-8 w-[52px] justify-center px-2 tabular-nums ${rateState.error ? "text-[var(--cf-red)]" : ""} ${triggerClassName ?? ""}`}
        >
          {percentLabel}
        </Button>
      )}
    />
  );
};

export const CodexAccountInline: React.FC<{
  className?: string;
  auto?: boolean;
  terminalMode?: TerminalMode;
  distro?: string;
  expanded?: boolean;
}> = ({ className, auto = true, terminalMode, distro, expanded = false }) => {
  const { t } = useTranslation(["settings", "common"]);
  const errorTranslator = useCallback(
    (error: unknown) => {
      // 尝试使用多语言翻译
      const translated = translateCodexBridgeError(error, t, {
        fallbackKey: "common:codexUsage.errorAccountInfoFailed",
        fallbackDefault: "无法读取账号信息",
      });
      // 如果翻译结果等于原错误消息，说明没有匹配到模式，使用账号特定错误键
      const errorMsg = String(error || "").trim();
      if (translated === errorMsg) {
        return t("settings:codexAccount.statusError", "账号信息不可用");
      }
      return translated;
    },
    [t],
  );
  const [accountState, reloadAccount] = useCodexAccount(auto, errorTranslator);
  const hover = useHoverCard();
  const envKey = useMemo(() => {
    if (terminalMode === "wsl") return `wsl:${distro ?? ""}`;
    if (terminalMode === "pwsh") return "windows-pwsh";
    if (terminalMode === "windows") return "windows";
    return "default";
  }, [terminalMode, distro]);
  const lastEnvKeyRef = useRef(envKey);

  useEffect(() => {
    if (!auto) {
      lastEnvKeyRef.current = envKey;
      return;
    }
    if (lastEnvKeyRef.current === envKey) return;
    lastEnvKeyRef.current = envKey;
    reloadAccount();
  }, [auto, envKey, reloadAccount]);

  const statusText = useMemo(() => {
    if (accountState.loading && !accountState.data) {
      return t("settings:codexAccount.statusLoading", "正在读取账号信息...");
    }
    if (accountState.error) {
      return t("settings:codexAccount.statusError", "账号信息不可用");
    }
    return resolveAccountLabel(accountState.data, t);
  }, [accountState, t]);

  const details = (
    <>
      {accountState.error ? (
        <div className="text-[var(--cf-red)]">{accountState.error}</div>
      ) : accountState.loading && !accountState.data ? (
        <div className="text-[var(--cf-text-secondary)]">
          {t("settings:codexAccount.statusLoading", "正在读取账号信息…")}
        </div>
      ) : (
        <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2.5 text-sm text-[var(--cf-text-primary)]">
          <dt className="text-xs font-apple-medium text-[var(--cf-text-secondary)]">{t("settings:codexAccount.statusLabel", "状态")}</dt>
          <dd className="font-apple-regular">{resolveAccountLabel(accountState.data, t)}</dd>
          <dt className="text-xs font-apple-medium text-[var(--cf-text-secondary)]">{t("settings:codexAccount.email", "邮箱")}</dt>
          <dd className="break-all font-apple-regular">{accountState.data?.email ?? t("settings:codexAccount.notProvided", "未提供")}</dd>
          <dt className="text-xs font-apple-medium text-[var(--cf-text-secondary)]">{t("settings:codexAccount.planLabel", "套餐")}</dt>
          <dd className="font-apple-regular">{describePlan(accountState.data?.plan ?? null, t)}</dd>
          <dt className="text-xs font-apple-medium text-[var(--cf-text-secondary)]">{t("settings:codexAccount.accountId", "账号 ID")}</dt>
          <dd className="break-all font-apple-regular">{accountState.data?.accountId ?? t("settings:codexAccount.notProvided", "未提供")}</dd>
          <dt className="text-xs font-apple-medium text-[var(--cf-text-secondary)]">{t("settings:codexAccount.userId", "用户 ID")}</dt>
          <dd className="break-all font-apple-regular">{accountState.data?.userId ?? t("settings:codexAccount.notProvided", "未提供")}</dd>
        </dl>
      )}
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="outline" className="gap-2" onClick={() => reloadAccount()}>
          <RotateCcw className="h-3.5 w-3.5" />
          {t("common:refresh", "刷新")}
        </Button>
      </div>
    </>
  );

  if (expanded) {
    return (
      <div className={`rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple p-4 shadow-apple-sm ${className ?? ""}`}>
        {details}
      </div>
    );
  }

  return (
    <div
      className={`relative inline-flex cursor-default items-center ${className ?? ""}`}
      onMouseEnter={hover.onEnter}
      onMouseLeave={hover.onLeave}
    >
      <span className="text-sm text-[var(--cf-text-primary)] truncate max-w-full font-apple-regular" title={statusText}>
        {statusText}
      </span>
      {hover.open && (
        <div className="absolute left-0 top-full z-[70] mt-2 w-[480px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple-lg p-4 text-sm text-[var(--cf-text-primary)] shadow-apple-xl dark:shadow-apple-dark-xl">
          {details}
        </div>
      )}
    </div>
  );
};

export default CodexUsageHoverButton;
