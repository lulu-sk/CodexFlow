// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RotateCcw } from "lucide-react";
import type { AppSettings, ClaudeUsageSnapshot } from "@/types/host";
import { CLAUDE_USAGE_REFRESH_EVENT, formatClaudeUsageErrorText } from "@/lib/claude-status";
import { useHoverCard } from "@/components/topbar/hover-card";

type TerminalMode = NonNullable<AppSettings["terminal"]>;

type FetchState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

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

/**
 * 将“下一次重置时间戳（ms）”格式化为更贴近 Codex 面板的展示：
 * - 24 小时内展示 HH:mm
 * - 24 小时外展示月/日
 */
function formatResetTimeMs(ms: number | null | undefined, language?: string): string {
  if (!Number.isFinite(ms) || ms == null) return "–";
  const future = new Date(ms);
  const deltaMs = ms - Date.now();
  try {
    if (deltaMs > 0 && deltaMs < 24 * 60 * 60 * 1000) {
      return future.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
    }
    return future.toLocaleDateString(language, { month: "short", day: "numeric" });
  } catch {
    return "–";
  }
}

/**
 * 解析 Claude 单窗口的“重置时间”展示文案：优先使用抓取到的 resetText，其次使用缓存的 resetAt。
 */
function resolveClaudeResetLabel(
  win: { resetText?: string | null } | null | undefined,
  resetAtMs: number | null | undefined,
  language: string | undefined,
  fallback: string,
): string {
  const text = String(win?.resetText ?? "").trim();
  if (text) return text;
  if (Number.isFinite(resetAtMs) && resetAtMs != null) return formatResetTimeMs(resetAtMs, language);
  return fallback;
}

/**
 * Claude 用量请求的运行环境键：用于缓存与设置变化触发刷新。
 */
function resolveClaudeEnvKey(terminalMode?: TerminalMode, distro?: string): string {
  if (terminalMode === "wsl") return `wsl:${distro ?? ""}`;
  if (terminalMode === "pwsh") return "windows-pwsh";
  if (terminalMode === "windows") return "windows";
  return "default";
}

type ClaudeUsageCacheEntry = {
  attemptedAt: number | null;
  data: ClaudeUsageSnapshot | null;
  error: string | null;
};

const CLAUDE_USAGE_CACHE = new Map<string, ClaudeUsageCacheEntry>();

function readClaudeUsageCache(envKey: string): ClaudeUsageCacheEntry {
  const cached = CLAUDE_USAGE_CACHE.get(envKey);
  if (cached) return cached;
  const empty: ClaudeUsageCacheEntry = { attemptedAt: null, data: null, error: null };
  CLAUDE_USAGE_CACHE.set(envKey, empty);
  return empty;
}

function useClaudeUsageCached(envKey: string): [FetchState<ClaudeUsageSnapshot>, () => void] {
  const { t } = useTranslation(["common"]);
  const [state, setState] = useState<FetchState<ClaudeUsageSnapshot>>(() => {
    const cached = readClaudeUsageCache(envKey);
    return { loading: false, error: cached.error, data: cached.data };
  });

  useEffect(() => {
    const cached = readClaudeUsageCache(envKey);
    setState({ loading: false, error: cached.error, data: cached.data });
  }, [envKey]);

  const fetchUsage = useCallback(async () => {
    const now = Date.now();
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await window.host.claude.getUsage();
      if (res.ok) {
        const entry: ClaudeUsageCacheEntry = { attemptedAt: now, error: null, data: res.snapshot ?? null };
        CLAUDE_USAGE_CACHE.set(envKey, entry);
        setState({ loading: false, error: null, data: entry.data });
      } else {
        const errorText = formatClaudeUsageErrorText(res.error, t);
        const entry: ClaudeUsageCacheEntry = { attemptedAt: now, error: errorText, data: null };
        CLAUDE_USAGE_CACHE.set(envKey, entry);
        setState({ loading: false, error: errorText, data: null });
      }
    } catch (err) {
      const errorText = formatClaudeUsageErrorText(err, t);
      const entry: ClaudeUsageCacheEntry = { attemptedAt: now, error: errorText, data: null };
      CLAUDE_USAGE_CACHE.set(envKey, entry);
      setState({ loading: false, error: errorText, data: null });
    }
  }, [envKey, t]);

  return [state, fetchUsage];
}

type ClaudeUsageLoadPolicy = "always" | "ifMissing" | "never";

type ClaudeUsageHoverCardTriggerArgs = {
  usageState: FetchState<ClaudeUsageSnapshot>;
  percentLabel: string;
  summaryLabel: string;
};

export type ClaudeUsageHoverCardProps = {
  className?: string;
  terminalMode?: TerminalMode;
  distro?: string;
  renderTrigger: (args: ClaudeUsageHoverCardTriggerArgs) => React.ReactNode;
  panelAlign?: "start" | "end";
  loadPolicy?: ClaudeUsageLoadPolicy;
  enableGlobalRefreshEvent?: boolean;
};

/**
 * Claude 用量 Hover Card：悬停展开详情并允许手动刷新。
 */
export const ClaudeUsageHoverCard: React.FC<ClaudeUsageHoverCardProps> = ({
  className,
  terminalMode,
  distro,
  renderTrigger,
  panelAlign = "start",
  loadPolicy = "ifMissing",
  enableGlobalRefreshEvent = true,
}) => {
  const { t, i18n } = useTranslation(["common"]);
  const envKey = useMemo(() => resolveClaudeEnvKey(terminalMode, distro), [terminalMode, distro]);
  const [usageState, reloadUsage] = useClaudeUsageCached(envKey);
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
    const attemptedInCache = readClaudeUsageCache(envKey).attemptedAt != null;
    if (loadPolicy === "ifMissing" && !attemptedInCache) {
      reloadUsage();
    }
  }, [envKey, loadPolicy, reloadUsage]);

  // 监听全局刷新事件，默认 1 分钟冷却，避免频繁触发
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
    window.addEventListener(CLAUDE_USAGE_REFRESH_EVENT, onRefresh as any);
    return () => window.removeEventListener(CLAUDE_USAGE_REFRESH_EVENT, onRefresh as any);
  }, [enableGlobalRefreshEvent, reloadUsage]);

  const fiveHour = usageState.data?.windows?.fiveHour ?? null;
  const percentUsed = useMemo(() => {
    const values = [
      usageState.data?.windows?.fiveHour?.usedPercent,
      usageState.data?.windows?.sevenDay?.usedPercent,
      usageState.data?.windows?.weekOpus?.usedPercent,
    ].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return values.length > 0 ? Math.max(...values) : null;
  }, [usageState.data]);
  const percentLabel = formatPercent(percentUsed ?? fiveHour?.usedPercent ?? null);
  const summaryLabel = usageState.loading
    ? t("common:claudeUsage.loading", "正在同步用量…")
    : usageState.error
      ? t("common:claudeUsage.unavailable", "用量信息不可用")
      : t("common:claudeUsage.title", "用量");

  const updatedAt = usageState.data?.cachedAt ?? usageState.data?.collectedAt ?? null;
  const sourceLabel = usageState.data
    ? (usageState.data.source === "ccline-cache"
      ? t("common:claudeUsage.sourceCache", "缓存")
      : usageState.data.source === "tmux-capture"
        ? t("common:claudeUsage.sourceLive", "实时")
        : usageState.data.source)
    : "";

  const errorLines = useMemo(() => {
    const lines = String(usageState.error || "").split("\n").map((x) => x.trim()).filter(Boolean);
    return { title: lines[0] || "", hint: lines[1] || "" };
  }, [usageState.error]);

  return (
    <div className={`relative ${className ?? ""}`} onMouseEnter={hover.onEnter} onMouseLeave={hover.onLeave}>
      {renderTrigger({ usageState, percentLabel, summaryLabel })}
      {hover.open && (
        <div
          className={`absolute top-full z-[70] mt-2 w-[340px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] backdrop-blur-apple-lg p-4 text-sm text-[var(--cf-text-primary)] shadow-apple-xl dark:shadow-apple-dark-xl ${panelAlign === "end" ? "right-0" : "left-0"}`}
        >
          {usageState.error ? (
            <div className="flex flex-col gap-1">
              <div className="text-[var(--cf-red)]">{errorLines.title || t("common:claudeUsage.unavailable", "用量信息不可用")}</div>
              {errorLines.hint ? (
                <div className="text-xs text-[var(--cf-text-secondary)]">{errorLines.hint}</div>
              ) : null}
            </div>
          ) : usageState.data ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-2.5 shadow-apple-xs">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-apple-medium text-[var(--cf-text-secondary)]">
                    {t("common:codexUsage.primary", "主要额度")}
                  </span>
                  <Badge variant="outline">{t("common:codexUsage.windowHourly", { count: 5 })}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-apple-medium">
                    {t("common:codexUsage.summary", { percent: formatPercent(usageState.data.windows.fiveHour.usedPercent) })}
                  </span>
                  <span className="text-xs text-[var(--cf-text-secondary)]">
                    {t("common:codexUsage.reset", {
                      time: resolveClaudeResetLabel(
                        usageState.data.windows.fiveHour,
                        usageState.data.resetAt ?? null,
                        i18n.language,
                        t("common:codexUsage.resetNotProvided", "未提供"),
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
                  <Badge variant="outline">{t("common:codexUsage.windowDaily", { count: 7 })}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-apple-medium">
                    {t("common:codexUsage.summary", { percent: formatPercent(usageState.data.windows.sevenDay.usedPercent) })}
                  </span>
                  <span className="text-xs text-[var(--cf-text-secondary)]">
                    {t("common:codexUsage.reset", {
                      time: resolveClaudeResetLabel(
                        usageState.data.windows.sevenDay,
                        usageState.data.resetAt ?? null,
                        i18n.language,
                        t("common:codexUsage.resetNotProvided", "未提供"),
                      ),
                    })}
                  </span>
                </div>
              </div>

              {usageState.data.windows.weekOpus ? (
                <div className="flex flex-col gap-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-2.5 shadow-apple-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-apple-medium text-[var(--cf-text-secondary)]">
                      Opus
                    </span>
                    <Badge variant="outline">{t("common:codexUsage.windowWeekly", { count: 1 })}</Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="font-apple-medium">
                      {t("common:codexUsage.summary", { percent: formatPercent(usageState.data.windows.weekOpus.usedPercent) })}
                    </span>
                    <span className="text-xs text-[var(--cf-text-secondary)]">
                      {t("common:codexUsage.reset", {
                        time: resolveClaudeResetLabel(
                          usageState.data.windows.weekOpus,
                          usageState.data.resetAt ?? null,
                          i18n.language,
                          t("common:codexUsage.resetNotProvided", "未提供"),
                        ),
                      })}
                    </span>
                  </div>
                </div>
              ) : null}

              <div className="flex items-center justify-between text-xs text-[var(--cf-text-secondary)]">
                <span>{t("common:claudeUsage.updatedAt", { time: formatTimeMs(updatedAt, i18n.language) })}</span>
                <span>{t("common:claudeUsage.source", { source: sourceLabel })}</span>
              </div>
            </div>
          ) : (
            <div className="text-[var(--cf-text-secondary)]">{t("common:claudeUsage.empty", "暂无用量信息")}</div>
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
