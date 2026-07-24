// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useHoverCard } from "@/components/topbar/hover-card";
import { cn } from "@/lib/utils";
import { formatGrokUsageErrorText, GROK_USAGE_REFRESH_EVENT } from "@/lib/grok-status";
import type { AppSettings, GrokUsageSnapshot } from "@/types/host";

type TerminalMode = NonNullable<AppSettings["terminal"]>;

type FetchState = {
  loading: boolean;
  error: string | null;
  data: GrokUsageSnapshot | null;
};

type GrokUsageHoverCardTriggerArgs = {
  usageState: FetchState;
  percentLabel: string;
  summaryLabel: string;
};

export type GrokUsageHoverCardProps = {
  className?: string;
  terminalMode?: TerminalMode;
  distro?: string;
  renderTrigger: (args: GrokUsageHoverCardTriggerArgs) => React.ReactNode;
  panelAlign?: "start" | "end";
};

/**
 * 将百分比格式化为顶部栏使用的整数文本。
 */
function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "–";
  return String(Math.round(value)) + "%";
}

/**
 * 将美元分格式化为当前语言的美元金额。
 */
function formatUsdCents(value: number | null | undefined, language?: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "–";
  try {
    return new Intl.NumberFormat(language, { style: "currency", currency: "USD" }).format(value / 100);
  } catch {
    return `$${(value / 100).toFixed(2)}`;
  }
}

/**
 * 将毫秒时间戳格式化为当前语言日期时间。
 */
function formatTimeMs(value: number | null | undefined, language?: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "–";
  try {
    return new Date(value).toLocaleString(language);
  } catch {
    return "–";
  }
}

/**
 * Grok Build 用量悬浮卡：展示当前登录账号的官方额度。
 */
export const GrokUsageHoverCard: React.FC<GrokUsageHoverCardProps> = ({
  className,
  terminalMode,
  distro,
  renderTrigger,
  panelAlign = "start",
}) => {
  const { t, i18n } = useTranslation(["common"]);
  const hover = useHoverCard();
  const lastRefreshAtRef = useRef(0);
  const [usageState, setUsageState] = useState<FetchState>({ loading: false, error: null, data: null });

  /**
   * 从主进程重新获取 Grok 账号额度。
   */
  const reloadUsage = useCallback(async () => {
    setUsageState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const result = await window.host.grok.getUsage();
      if (result.ok) {
        setUsageState({ loading: false, error: null, data: result.snapshot ?? null });
        return;
      }
      setUsageState({ loading: false, error: formatGrokUsageErrorText(result.error, t), data: null });
    } catch (reason) {
      setUsageState({ loading: false, error: formatGrokUsageErrorText(reason, t), data: null });
    }
  }, [distro, t, terminalMode]);

  useEffect(() => {
    reloadUsage();
  }, [reloadUsage]);

  useEffect(() => {
    /**
     * 响应任务完成事件，并限制自动刷新频率。
     */
    const onRefresh = () => {
      const now = Date.now();
      if (now - lastRefreshAtRef.current < 60_000) return;
      lastRefreshAtRef.current = now;
      reloadUsage();
    };
    window.addEventListener(GROK_USAGE_REFRESH_EVENT, onRefresh as EventListener);
    return () => window.removeEventListener(GROK_USAGE_REFRESH_EVENT, onRefresh as EventListener);
  }, [reloadUsage]);

  const snapshot = usageState.data;
  const quota = snapshot?.quota;
  const percentLabel = formatPercent(quota?.usedPercent);
  const summaryLabel = usageState.loading
    ? t("common:grokUsage.loading", "正在同步账号额度…")
    : usageState.error
      ? t("common:grokUsage.unavailable", "账号额度不可用")
      : t("common:grokUsage.title", "账号额度");
  const errorLines = String(usageState.error || "").split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean);
  const periodLabel = quota?.periodType?.includes("WEEKLY")
    ? t("common:grokUsage.periodWeekly", "每周额度")
    : quota?.periodType?.includes("MONTHLY")
      ? t("common:grokUsage.periodMonthly", "每月额度")
      : t("common:grokUsage.periodUnknown", "账号额度");
  const hasIncludedAmounts = quota?.includedUsedCents != null || quota?.includedLimitCents != null;
  const hasAdditionalCredits = quota?.prepaidBalanceCents != null
    || quota?.onDemandUsedCents != null
    || quota?.onDemandCapCents != null
    || quota?.onDemandEnabled === false;
  const sourceLabel = snapshot?.source === "billing-cache"
    ? t("common:grokUsage.sourceCache", "Grok 官方缓存")
    : t("common:grokUsage.sourceLive", "实时");

  return (
    <div className={cn("relative", className)} onMouseEnter={hover.onEnter} onMouseLeave={hover.onLeave}>
      {renderTrigger({ usageState, percentLabel, summaryLabel })}
      {hover.open ? (
        <div className={cn(
          "absolute top-full z-[70] mt-2 flex w-[380px] flex-col rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-4 text-sm text-[var(--cf-text-primary)] shadow-apple-xl backdrop-blur-apple-lg dark:shadow-apple-dark-xl",
          panelAlign === "end" ? "right-0" : "left-0",
        )}>
          {usageState.loading && !snapshot ? (
            <div role="status" className="text-[var(--cf-text-secondary)]">
              {t("common:grokUsage.loading", "正在同步账号额度…")}
            </div>
          ) : usageState.error ? (
            <div role="alert" className="flex flex-col gap-1">
              <div className="text-[var(--cf-red)]">{errorLines[0] || summaryLabel}</div>
              {errorLines[1] ? <div className="text-xs text-[var(--cf-text-secondary)]">{errorLines[1]}</div> : null}
            </div>
          ) : snapshot && quota ? (
            <div className="flex flex-col gap-3">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span
                  className="min-w-0 truncate text-xs text-[var(--cf-text-secondary)]"
                  title={snapshot.accountEmail || t("common:grokUsage.account", "Grok Build 账号")}
                >
                  {snapshot.accountEmail || t("common:grokUsage.account", "Grok Build 账号")}
                </span>
                {snapshot.subscriptionTier ? (
                  <Badge variant="outline" className="max-w-[190px] shrink-0" title={snapshot.subscriptionTier}>
                    <span className="truncate">{snapshot.subscriptionTier}</span>
                  </Badge>
                ) : null}
              </div>

              <div className="flex flex-col gap-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-2.5 shadow-apple-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-apple-medium text-[var(--cf-text-secondary)]">
                    {t("common:grokUsage.includedQuota", "包含额度")}
                  </span>
                  <Badge variant="outline">{periodLabel}</Badge>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="font-apple-medium">
                    {t("common:grokUsage.used", { percent: percentLabel })}
                  </span>
                  <span className="text-right text-xs text-[var(--cf-text-secondary)]">
                    {t("common:grokUsage.resetAt", {
                      time: quota.periodEndAt == null
                        ? t("common:grokUsage.resetNotProvided", "未提供")
                        : formatTimeMs(quota.periodEndAt, i18n.language),
                    })}
                  </span>
                </div>
                {hasIncludedAmounts ? (
                  <div className="text-right text-xs tabular-nums text-[var(--cf-text-secondary)]">
                    {t("common:grokUsage.amount", {
                      used: formatUsdCents(quota.includedUsedCents, i18n.language),
                      limit: formatUsdCents(quota.includedLimitCents, i18n.language),
                    })}
                  </div>
                ) : null}
              </div>

              {hasAdditionalCredits ? (
                <div className="flex flex-col gap-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-2.5 shadow-apple-xs">
                  <span className="text-xs font-apple-medium text-[var(--cf-text-secondary)]">
                    {t("common:grokUsage.additionalCredits", "额外额度")}
                  </span>
                  <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-xs">
                    {quota.prepaidBalanceCents != null ? (
                      <>
                        <span className="text-[var(--cf-text-secondary)]">{t("common:grokUsage.prepaidBalance", "已购余额")}</span>
                        <span className="text-right tabular-nums">{formatUsdCents(quota.prepaidBalanceCents, i18n.language)}</span>
                      </>
                    ) : null}
                    {quota.onDemandUsedCents != null || quota.onDemandCapCents != null || quota.onDemandEnabled === false ? (
                      <>
                        <span className="text-[var(--cf-text-secondary)]">{t("common:grokUsage.onDemandUsage", "按需用量")}</span>
                        <span className="text-right tabular-nums">
                          {quota.onDemandEnabled === false && quota.onDemandUsedCents == null && quota.onDemandCapCents == null
                            ? t("common:grokUsage.onDemandDisabled", "未启用")
                            : t("common:grokUsage.amount", {
                              used: formatUsdCents(quota.onDemandUsedCents, i18n.language),
                              limit: formatUsdCents(quota.onDemandCapCents, i18n.language),
                            })}
                        </span>
                      </>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--cf-text-secondary)]">
                <span>{t("common:grokUsage.updatedAt", { time: formatTimeMs(snapshot.updatedAt, i18n.language) })}</span>
                <span>{sourceLabel}</span>
              </div>
            </div>
          ) : (
            <div className="text-[var(--cf-text-secondary)]">{t("common:grokUsage.empty", "暂无账号额度信息")}</div>
          )}

          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              disabled={usageState.loading}
              onClick={(event) => {
                event.preventDefault();
                reloadUsage();
              }}
            >
              <RotateCcw className={cn("h-3.5 w-3.5", usageState.loading && "animate-spin")} aria-hidden="true" />
              {t("common:refresh", "刷新")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
};
