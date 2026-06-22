// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RotateCcw } from "lucide-react";
import type { AntigravityUsageSnapshot, AntigravityUsageWindow } from "@/types/host";
import { ANTIGRAVITY_USAGE_REFRESH_EVENT, formatAntigravityUsageErrorText } from "@/lib/antigravity-status";
import { useHoverCard } from "@/components/topbar/hover-card";

type FetchState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

type CommonT = ReturnType<typeof useTranslation<["common"]>>["t"];

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "–";
  return `${Math.round(value)}%`;
}

function formatTimeMs(ms: number | null | undefined, language?: string): string {
  if (!Number.isFinite(ms) || ms == null) return "–";
  try {
    return new Date(ms).toLocaleString(language);
  } catch {
    return "–";
  }
}

function formatResetTimeMs(ms: number | null | undefined, language?: string): string {
  if (!Number.isFinite(ms) || ms == null) return "–";
  const deltaMs = ms - Date.now();
  try {
    const d = new Date(ms);
    if (deltaMs > 0 && deltaMs < 24 * 60 * 60 * 1000)
      return d.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString(language, { month: "short", day: "numeric" });
  } catch {
    return "–";
  }
}

function resolveResetLabel(win: AntigravityUsageWindow, language: string | undefined, fallback: string): string {
  const label = formatResetTimeMs(win.resetAt, language);
  if (label !== "–") return label;
  const text = String(win.resetText || "").trim();
  if (text && text.length <= 32) return text;
  return fallback;
}

/**
 * 归一化 Antigravity 返回的英文标签，便于做稳定的本地化匹配。
 */
function normalizeAntigravityUsageLabel(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[+&]/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * 将 Antigravity 模型组名转换为当前界面的语言。
 */
function resolveAntigravityGroupLabel(win: AntigravityUsageWindow, t: CommonT): string {
  const raw = String(win.groupName || win.label || "").trim();
  const normalized = normalizeAntigravityUsageLabel(raw);
  if (normalized.includes("gemini")) return t("common:antigravityUsage.groups.gemini", "Gemini Models");
  if ((normalized.includes("claude") && normalized.includes("gpt")) || normalized.includes("3p"))
    return t("common:antigravityUsage.groups.claudeGpt", "Claude and GPT models");
  return raw || t("common:antigravityUsage.unknownGroup", "Unknown group");
}

/**
 * 将 Antigravity 额度窗口名转换为当前界面的语言。
 */
function resolveAntigravityWindowLabel(win: AntigravityUsageWindow, fallback: string, t: CommonT): string {
  const raw = String(win.label || "").trim();
  const bucketId = normalizeAntigravityUsageLabel(win.bucketId);
  const normalized = normalizeAntigravityUsageLabel(raw);
  if (bucketId.includes("weekly") || normalized === "weekly limit" || normalized === "weekly")
    return t("common:antigravityUsage.windows.weekly", "Weekly Limit");
  return raw || fallback;
}

type AntigravityUsageCacheEntry = {
  attemptedAt: number | null;
  data: AntigravityUsageSnapshot | null;
  error: string | null;
};

const ANTIGRAVITY_USAGE_CACHE = new Map<string, AntigravityUsageCacheEntry>();

function readAntigravityUsageCache(cacheKey: string): AntigravityUsageCacheEntry {
  const cached = ANTIGRAVITY_USAGE_CACHE.get(cacheKey);
  if (cached) return cached;
  const empty: AntigravityUsageCacheEntry = { attemptedAt: null, data: null, error: null };
  ANTIGRAVITY_USAGE_CACHE.set(cacheKey, empty);
  return empty;
}

function useAntigravityUsageCached(cacheKey: string): [FetchState<AntigravityUsageSnapshot>, () => void] {
  const { t } = useTranslation(["common"]);
  const [state, setState] = useState<FetchState<AntigravityUsageSnapshot>>(() => {
    const cached = readAntigravityUsageCache(cacheKey);
    return { loading: false, error: cached.error, data: cached.data };
  });

  useEffect(() => {
    const cached = readAntigravityUsageCache(cacheKey);
    setState({ loading: false, error: cached.error, data: cached.data });
  }, [cacheKey]);

  const fetchUsage = useCallback(async () => {
    const now = Date.now();
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await window.host.antigravity.getUsage();
      if (res.ok) {
        const entry: AntigravityUsageCacheEntry = { attemptedAt: now, error: null, data: res.snapshot ?? null };
        ANTIGRAVITY_USAGE_CACHE.set(cacheKey, entry);
        setState({ loading: false, error: null, data: entry.data });
      } else {
        const errorText = formatAntigravityUsageErrorText(res.error, t);
        const entry: AntigravityUsageCacheEntry = { attemptedAt: now, error: errorText, data: null };
        ANTIGRAVITY_USAGE_CACHE.set(cacheKey, entry);
        setState({ loading: false, error: errorText, data: null });
      }
    } catch (err) {
      const errorText = formatAntigravityUsageErrorText(err, t);
      const entry: AntigravityUsageCacheEntry = { attemptedAt: now, error: errorText, data: null };
      ANTIGRAVITY_USAGE_CACHE.set(cacheKey, entry);
      setState({ loading: false, error: errorText, data: null });
    }
  }, [cacheKey, t]);

  return [state, fetchUsage];
}

type AntigravityUsageLoadPolicy = "always" | "ifMissing" | "never";

type AntigravityUsageHoverCardTriggerArgs = {
  usageState: FetchState<AntigravityUsageSnapshot>;
  percentLabel: string;
  summaryLabel: string;
};

export type AntigravityUsageHoverCardProps = {
  className?: string;
  renderTrigger: (args: AntigravityUsageHoverCardTriggerArgs) => React.ReactNode;
  panelAlign?: "start" | "end";
  loadPolicy?: AntigravityUsageLoadPolicy;
  enableGlobalRefreshEvent?: boolean;
};

function computeMaxUsedPercent(snapshot: AntigravityUsageSnapshot | null): number | null {
  if (!snapshot) return null;
  const values = (snapshot.windows || [])
    .map((win) => win.usedPercent)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return values.length > 0 ? Math.max(...values) : null;
}

function resolveSourceLabel(snapshot: AntigravityUsageSnapshot, t: CommonT): string {
  if (snapshot.source === "app-local") return t("common:antigravityUsage.sourceApp", "Antigravity App");
  if (snapshot.source === "agy-cli") return t("common:antigravityUsage.sourceAgy", "AGY");
  if (snapshot.source === "launched-agy") return t("common:antigravityUsage.sourceLaunchedAgy", "临时 AGY");
  if (snapshot.source === "ide-local") return t("common:antigravityUsage.sourceIde", "Antigravity IDE");
  return t("common:antigravityUsage.sourceLocal", "本地服务");
}

function resolveRawSourceLabel(snapshot: AntigravityUsageSnapshot, t: CommonT): string {
  if (snapshot.rawSource === "quota-summary") return t("common:antigravityUsage.rawSourceQuotaSummary", "额度摘要");
  if (snapshot.rawSource === "user-status") return t("common:antigravityUsage.rawSourceUserStatus", "账号状态");
  return t("common:antigravityUsage.rawSourceModelConfig", "模型配置");
}

/**
 * Antigravity 用量 Hover Card：悬停展开详情并允许手动刷新。
 */
export const AntigravityUsageHoverCard: React.FC<AntigravityUsageHoverCardProps> = ({
  className,
  renderTrigger,
  panelAlign = "start",
  loadPolicy = "ifMissing",
  enableGlobalRefreshEvent = true,
}) => {
  const { t, i18n } = useTranslation(["common"]);
  const cacheKey = "default";
  const [usageState, reloadUsage] = useAntigravityUsageCached(cacheKey);
  const hover = useHoverCard();
  const lastRefreshAtRef = useRef<number>(0);
  const lastAutoLoadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (loadPolicy === "never") return;
    if (lastAutoLoadKeyRef.current === cacheKey) return;
    lastAutoLoadKeyRef.current = cacheKey;
    if (loadPolicy === "always") {
      reloadUsage();
      return;
    }
    const attemptedInCache = readAntigravityUsageCache(cacheKey).attemptedAt != null;
    if (loadPolicy === "ifMissing" && !attemptedInCache) reloadUsage();
  }, [cacheKey, loadPolicy, reloadUsage]);

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
    window.addEventListener(ANTIGRAVITY_USAGE_REFRESH_EVENT, onRefresh as any);
    return () => window.removeEventListener(ANTIGRAVITY_USAGE_REFRESH_EVENT, onRefresh as any);
  }, [enableGlobalRefreshEvent, reloadUsage]);

  const maxUsed = useMemo(() => computeMaxUsedPercent(usageState.data), [usageState.data]);
  const percentLabel = formatPercent(maxUsed);
  const summaryLabel = usageState.loading
    ? t("common:antigravityUsage.loading", "正在同步用量…")
    : usageState.error
      ? t("common:antigravityUsage.unavailable", "用量信息不可用")
      : t("common:antigravityUsage.title", "用量");

  const errorLines = useMemo(() => {
    const lines = String(usageState.error || "").split("\n").map((x) => x.trim()).filter(Boolean);
    return { title: lines[0] || "", hint: lines[1] || "" };
  }, [usageState.error]);

  return (
    <div className={`relative ${className ?? ""}`} onMouseEnter={hover.onEnter} onMouseLeave={hover.onLeave}>
      {renderTrigger({ usageState, percentLabel, summaryLabel })}
      {hover.open && (
        <div
          className={`absolute top-full z-[70] mt-2 flex max-h-[calc(100vh-6rem)] w-[380px] flex-col overflow-hidden rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-4 text-sm text-[var(--cf-text-primary)] shadow-apple-xl backdrop-blur-apple-lg dark:shadow-apple-dark-xl ${panelAlign === "end" ? "right-0" : "left-0"}`}
        >
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {usageState.error ? (
              <div className="flex flex-col gap-1">
                <div className="text-[var(--cf-red)]">{errorLines.title || t("common:antigravityUsage.unavailable", "用量信息不可用")}</div>
                {errorLines.hint ? (
                  <div className="text-xs text-[var(--cf-text-secondary)]">{errorLines.hint}</div>
                ) : null}
              </div>
            ) : usageState.data ? (
              <div className="flex flex-col gap-3">
                {usageState.data.windows.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {usageState.data.windows.map((win, idx) => {
                      const groupLabel = resolveAntigravityGroupLabel(win, t);
                      const windowLabel = resolveAntigravityWindowLabel(win, groupLabel, t);
                      return (
                        <div
                          key={`${win.groupName || win.label}-${win.bucketId || win.modelId || idx}`}
                          className="flex flex-col gap-1.5 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-2.5 shadow-apple-xs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate text-xs font-apple-medium text-[var(--cf-text-secondary)]" title={groupLabel}>
                              {groupLabel}
                            </span>
                            <Badge variant="outline" className="max-w-[190px]" title={windowLabel}>
                              <span className="truncate">{windowLabel}</span>
                            </Badge>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-apple-medium">
                              {win.usageKnown
                                ? t("common:codexUsage.summary", { percent: formatPercent(win.usedPercent) })
                                : t("common:antigravityUsage.usageUnknown", "用量未知")}
                            </span>
                            <span className="text-xs text-[var(--cf-text-secondary)]">
                              {t("common:antigravityUsage.resetAt", {
                                time: resolveResetLabel(win, i18n.language, t("common:codexUsage.resetNotProvided", "未提供")),
                              })}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-[var(--cf-text-secondary)]">{t("common:antigravityUsage.empty", "暂无用量信息")}</div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--cf-text-secondary)]">
                  <span>{t("common:claudeUsage.updatedAt", { time: formatTimeMs(usageState.data.collectedAt, i18n.language) })}</span>
                  <span>{resolveSourceLabel(usageState.data, t)} · {resolveRawSourceLabel(usageState.data, t)}</span>
                </div>
              </div>
            ) : (
              <div className="text-[var(--cf-text-secondary)]">{t("common:antigravityUsage.empty", "暂无用量信息")}</div>
            )}
          </div>

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
