// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RotateCcw } from "lucide-react";
import type { AppSettings, GeminiQuotaSnapshot, GeminiQuotaBucket } from "@/types/host";
import { GEMINI_USAGE_REFRESH_EVENT, formatGeminiUsageErrorText } from "@/lib/gemini-status";
import { useHoverCard } from "@/components/topbar/hover-card";

type TerminalMode = NonNullable<AppSettings["terminal"]>;

type FetchState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

/**
 * 统一的百分比格式化：与 Codex/Claude 面板保持一致（四舍五入到整数）。
 */
function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "–";
  return `${Math.round(value)}%`;
}

function resolveLocale(language: string | undefined): string | undefined {
  if (!language) return undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(language);
    return canonical ?? language;
  } catch {
    return language;
  }
}

/**
 * 将 Gemini quota 的 resetTime（ISO 字符串）格式化为更贴近 Codex 面板的展示：
 * - 24 小时内展示 HH:mm
 * - 24 小时外展示月/日
 * - 缺失/非法返回 fallback；已过期返回 finishedLabel
 */
function formatResetTimeIso(
  value: string | null | undefined,
  language: string | undefined,
  fallback: string,
  finishedLabel: string,
): string {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return fallback;
  const deltaMs = ms - Date.now();
  if (deltaMs <= 0) return finishedLabel;
  const locale = resolveLocale(language);
  try {
    const d = new Date(ms);
    if (deltaMs < 24 * 60 * 60 * 1000) {
      return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
  } catch {
    return fallback;
  }
}

/**
 * 将百分比夹到 [0,100]，避免异常数据影响 UI。
 */
function clampPercent0To100(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * Gemini 用量请求的运行环境键：用于缓存与设置变化触发刷新。
 */
function resolveGeminiEnvKey(terminalMode?: TerminalMode, distro?: string): string {
  if (terminalMode === "wsl") return `wsl:${distro ?? ""}`;
  if (terminalMode === "pwsh") return "windows-pwsh";
  if (terminalMode === "windows") return "windows";
  return "default";
}

type GeminiUsageCacheEntry = {
  attemptedAt: number | null;
  data: GeminiQuotaSnapshot | null;
  error: string | null;
};

const GEMINI_USAGE_CACHE = new Map<string, GeminiUsageCacheEntry>();

function readGeminiUsageCache(envKey: string): GeminiUsageCacheEntry {
  const cached = GEMINI_USAGE_CACHE.get(envKey);
  if (cached) return cached;
  const empty: GeminiUsageCacheEntry = { attemptedAt: null, data: null, error: null };
  GEMINI_USAGE_CACHE.set(envKey, empty);
  return empty;
}

function useGeminiUsageCached(envKey: string): [FetchState<GeminiQuotaSnapshot>, () => void] {
  const { t } = useTranslation(["common"]);
  const [state, setState] = useState<FetchState<GeminiQuotaSnapshot>>(() => {
    const cached = readGeminiUsageCache(envKey);
    return { loading: false, error: cached.error, data: cached.data };
  });

  useEffect(() => {
    const cached = readGeminiUsageCache(envKey);
    setState({ loading: false, error: cached.error, data: cached.data });
  }, [envKey]);

  const fetchUsage = useCallback(async () => {
    const now = Date.now();
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await window.host.gemini.getUsage();
      if (res.ok) {
        const entry: GeminiUsageCacheEntry = { attemptedAt: now, error: null, data: res.snapshot ?? null };
        GEMINI_USAGE_CACHE.set(envKey, entry);
        setState({ loading: false, error: null, data: entry.data });
      } else {
        const errorText = formatGeminiUsageErrorText(res.error, t);
        const entry: GeminiUsageCacheEntry = { attemptedAt: now, error: errorText, data: null };
        GEMINI_USAGE_CACHE.set(envKey, entry);
        setState({ loading: false, error: errorText, data: null });
      }
    } catch (err) {
      const errorText = formatGeminiUsageErrorText(err, t);
      const entry: GeminiUsageCacheEntry = { attemptedAt: now, error: errorText, data: null };
      GEMINI_USAGE_CACHE.set(envKey, entry);
      setState({ loading: false, error: errorText, data: null });
    }
  }, [envKey, t]);

  return [state, fetchUsage];
}

type GeminiUsageLoadPolicy = "always" | "ifMissing" | "never";

type GeminiUsageHoverCardTriggerArgs = {
  usageState: FetchState<GeminiQuotaSnapshot>;
  percentLabel: string;
  summaryLabel: string;
};

export type GeminiUsageHoverCardProps = {
  className?: string;
  terminalMode?: TerminalMode;
  distro?: string;
  renderTrigger: (args: GeminiUsageHoverCardTriggerArgs) => React.ReactNode;
  panelAlign?: "start" | "end";
  loadPolicy?: GeminiUsageLoadPolicy;
  enableGlobalRefreshEvent?: boolean;
};

function resolveBucketLabel(bucket: GeminiQuotaBucket, fallback: string): string {
  const model = String(bucket.modelId ?? "").trim();
  if (model) return model;
  const tokenType = String(bucket.tokenType ?? "").trim();
  if (tokenType) return tokenType;
  return fallback;
}

/**
 * 计算 Gemini 的“最高已用百分比”（用于顶部栏摘要展示）。
 */
function computeMaxUsedPercent(snapshot: GeminiQuotaSnapshot | null): number | null {
  if (!snapshot) return null;
  const values = (snapshot.buckets || [])
    .map((b) => {
      const frac = b.remainingFraction;
      if (typeof frac !== "number" || !Number.isFinite(frac)) return null;
      return clampPercent0To100((1 - frac) * 100);
    })
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (values.length === 0) return null;
  return Math.max(...values);
}

/**
 * Gemini 用量 Hover Card：悬停展开详情并允许手动刷新。
 */
export const GeminiUsageHoverCard: React.FC<GeminiUsageHoverCardProps> = ({
  className,
  terminalMode,
  distro,
  renderTrigger,
  panelAlign = "start",
  loadPolicy = "ifMissing",
  enableGlobalRefreshEvent = true,
}) => {
  const { t, i18n } = useTranslation(["common"]);
  const envKey = useMemo(() => resolveGeminiEnvKey(terminalMode, distro), [terminalMode, distro]);
  const [usageState, reloadUsage] = useGeminiUsageCached(envKey);
  const hover = useHoverCard();
  const lastRefreshAtRef = useRef<number>(0);
  const lastAutoLoadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (loadPolicy === "never") return;
    if (lastAutoLoadKeyRef.current === envKey) return;
    lastAutoLoadKeyRef.current = envKey;
    if (loadPolicy === "always") {
      reloadUsage();
      return;
    }
    const attemptedInCache = readGeminiUsageCache(envKey).attemptedAt != null;
    if (loadPolicy === "ifMissing" && !attemptedInCache) {
      reloadUsage();
    }
  }, [envKey, loadPolicy, reloadUsage]);

  useEffect(() => {
    if (!enableGlobalRefreshEvent) return undefined;
    const onRefresh = () => {
      try {
        const now = Date.now();
        if (now - (lastRefreshAtRef.current || 0) < 60_000) return;
        lastRefreshAtRef.current = now;
        reloadUsage();
      } catch {}
    };
    window.addEventListener(GEMINI_USAGE_REFRESH_EVENT, onRefresh as any);
    return () => window.removeEventListener(GEMINI_USAGE_REFRESH_EVENT, onRefresh as any);
  }, [enableGlobalRefreshEvent, reloadUsage]);

  const maxUsed = useMemo(() => computeMaxUsedPercent(usageState.data), [usageState.data]);
  const percentLabel = formatPercent(maxUsed);
  const summaryLabel = usageState.loading
    ? t("common:geminiUsage.loading", "正在同步用量…")
    : usageState.error
      ? t("common:geminiUsage.unavailable", "用量信息不可用")
      : t("common:geminiUsage.title", "用量");

  const resetFallback = t("common:codexUsage.resetNotProvided", "未提供");
  const resetFinished = t("common:codexUsage.resetFinished", "已重置");

  const errorLines = useMemo(() => {
    const lines = String(usageState.error || "").split("\n").map((x) => x.trim()).filter(Boolean);
    return { title: lines[0] || "", hint: lines[1] || "" };
  }, [usageState.error]);

  return (
    <div className={`relative ${className ?? ""}`} onMouseEnter={hover.onEnter} onMouseLeave={hover.onLeave}>
      {renderTrigger({ usageState, percentLabel, summaryLabel })}
      {hover.open && (
        <div
          className={`absolute top-full z-[70] mt-2 w-[380px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple-lg p-4 text-sm text-[var(--cf-text-primary)] shadow-apple-xl dark:shadow-apple-dark-xl ${panelAlign === "end" ? "right-0" : "left-0"}`}
        >
          {usageState.error ? (
            <div className="flex flex-col gap-1">
              <div className="text-[var(--cf-red)]">{errorLines.title || t("common:geminiUsage.unavailable", "用量信息不可用")}</div>
              {errorLines.hint ? (
                <div className="text-xs text-[var(--cf-text-secondary)]">{errorLines.hint}</div>
              ) : null}
            </div>
          ) : usageState.data ? (
            <div className="flex flex-col gap-3">
              {usageState.data.buckets.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {usageState.data.buckets.map((b, idx) => {
                    const label = resolveBucketLabel(b, `bucket-${idx + 1}`);
                    const usedPct = typeof b.remainingFraction === "number" && Number.isFinite(b.remainingFraction)
                      ? clampPercent0To100((1 - b.remainingFraction) * 100)
                      : null;
                    return (
                      <div
                        key={`${label}-${idx}`}
                        className="flex flex-col gap-1.5 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-2.5 shadow-apple-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-apple-medium text-[var(--cf-text-secondary)]">
                            {t("common:geminiUsage.bucket", { index: idx + 1 })}
                          </span>
                          <Badge variant="outline" className="max-w-[220px]" title={label}>
                            <span className="truncate">{label}</span>
                          </Badge>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="font-apple-medium">
                            {t("common:codexUsage.summary", { percent: formatPercent(usedPct) })}
                          </span>
                          <span className="text-xs text-[var(--cf-text-secondary)]">
                            {t("common:codexUsage.reset", {
                              time: formatResetTimeIso(b.resetTime, i18n.language, resetFallback, resetFinished),
                            })}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-[var(--cf-text-secondary)]">{t("common:geminiUsage.empty", "暂无用量信息")}</div>
              )}
            </div>
          ) : (
            <div className="text-[var(--cf-text-secondary)]">{t("common:geminiUsage.empty", "暂无用量信息")}</div>
          )}

          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={(e) => {
                e.preventDefault();
                reloadUsage();
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
