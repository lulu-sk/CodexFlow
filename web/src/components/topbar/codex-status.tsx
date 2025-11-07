// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Gauge, RotateCcw } from "lucide-react";
import type { CodexAccountInfo, CodexRateLimitSnapshot } from "@/types/host";
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
} from "@/lib/codex-status";

type FetchState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

type HoverHandlers = {
  open: boolean;
  onEnter: () => void;
  onLeave: () => void;
};

function useHoverCard(): HoverHandlers {
  const [open, setOpen] = useState(false);
  const timerRef = useRef<number | null>(null);
  const clear = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  const onEnter = useCallback(() => {
    clear();
    setOpen(true);
  }, []);
  const onLeave = useCallback(() => {
    clear();
    timerRef.current = window.setTimeout(() => {
      setOpen(false);
      timerRef.current = null;
    }, 120);
  }, []);
  useEffect(() => () => clear(), []);
  return { open, onEnter, onLeave };
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
  return t("settings:codexAccount.statusUnknown", "未登录");
}

function describePlan(plan: string | null, t: TFunction): string {
  if (!plan) return t("settings:codexAccount.plan.unknown", "未知套餐");
  const key = PLAN_KEYS[plan];
  return key ? t(key) : plan;
}

const CodexUsageHoverButton: React.FC<{ className?: string; terminalMode?: "wsl" | "windows"; distro?: string }> = ({ className, terminalMode, distro }) => {
  const { t, i18n } = useTranslation(["common"]);
  const [rateState, reloadRate] = useCodexRate(true);
  const rateHover = useHoverCard();
  const lastManualRefreshAtRef = useRef<number>(0);
  const envKey = useMemo(() => {
    if (terminalMode === "wsl") return `wsl:${distro ?? ""}`;
    if (terminalMode === "windows") return "windows";
    return "default";
  }, [terminalMode, distro]);
  const lastEnvKeyRef = useRef(envKey);

  useEffect(() => {
    if (lastEnvKeyRef.current === envKey) return;
    lastEnvKeyRef.current = envKey;
    reloadRate();
  }, [envKey, reloadRate]);

  useEffect(() => {
    if (!rateState.data) return undefined;
    const interval = computeRefreshInterval(rateState.data);
    const timer = window.setTimeout(() => reloadRate(), interval);
    return () => window.clearTimeout(timer);
  }, [rateState.data, reloadRate]);

  // 监听渲染进程全局的“用量刷新请求”事件；冷却时间 1 分钟
  useEffect(() => {
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
  }, [reloadRate]);

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

  const summaryLabel = rateState.loading
    ? t("common:codexUsage.loading", "加载用量…")
    : rateState.error
      ? t("common:codexUsage.unavailable", "用量不可用")
      : dominantWindow
        ? formatUsageSummaryLabel(dominantWindow, dominantWindow.usedPercent ?? null, t)
        : percentUsed != null
          ? formatUsageSummaryLabel(null, percentUsed, t)
          : t("common:codexUsage.title", "用量");

  return (
    <div
      className={`relative ${className ?? ""}`}
      onMouseEnter={rateHover.onEnter}
      onMouseLeave={rateHover.onLeave}
    >
      <Button variant="ghost" size="sm" className="flex items-center gap-2 px-2">
        <Gauge className="h-4 w-4" />
        <span className="truncate max-w-[200px]">{summaryLabel}</span>
      </Button>
      {rateHover.open && (
        <div className="absolute left-0 top-full z-[70] mt-2 w-[320px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple-lg p-4 text-sm text-[var(--cf-text-primary)] shadow-apple-xl dark:shadow-apple-dark-xl">
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

export const CodexAccountInline: React.FC<{
  className?: string;
  auto?: boolean;
  terminalMode?: "wsl" | "windows";
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
