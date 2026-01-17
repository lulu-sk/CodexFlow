// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AppSettings, ProviderItem } from "@/types/host";
import { getBuiltInProviders } from "@/lib/providers/builtins";
import { resolveProvider } from "@/lib/providers/resolve";
import type { ThemeMode } from "@/lib/theme";
import { CodexUsageHoverCard } from "@/components/topbar/codex-status";
import { ClaudeUsageHoverCard } from "@/components/topbar/claude-status";
import { GeminiUsageHoverCard } from "@/components/topbar/gemini-status";

type TerminalMode = NonNullable<AppSettings["terminal"]>;

export type ProviderSwitcherProps = {
  activeId: string;
  providers: ProviderItem[];
  onChange: (id: string) => void;
  terminalMode?: TerminalMode;
  distro?: string;
  themeMode?: ThemeMode;
  className?: string;
};

/**
 * 顶部栏引擎切换器：内置引擎与自定义引擎同排展示（自定义无用量面板）。
 */
export const ProviderSwitcher: React.FC<ProviderSwitcherProps> = ({ activeId, providers, onChange, terminalMode, distro, themeMode, className }) => {
  const { t } = useTranslation(["providers", "common"]);

  const byId = useMemo(() => {
    const map = new Map<string, ProviderItem>();
    for (const it of providers || []) {
      const id = String(it?.id || "").trim();
      if (!id) continue;
      if (map.has(id)) continue;
      map.set(id, it);
    }
    return map;
  }, [providers]);

  const builtIns = useMemo(() => {
    return getBuiltInProviders().map((meta) => resolveProvider(byId.get(meta.id) ?? { id: meta.id }, { themeMode }));
  }, [byId, themeMode]);

  const customs = useMemo(() => {
    const builtInIds = new Set(getBuiltInProviders().map((x) => x.id));
    const list: Array<{ id: string; label: string; iconSrc: string }> = [];
    for (const it of providers || []) {
      const resolved = resolveProvider(it, { themeMode });
      if (!resolved.id || builtInIds.has(resolved.id as any)) continue;
      const label = String(resolved.displayName || "").trim() || (t("providers:customEngine", "Custom Engine") as string);
      list.push({ id: resolved.id, label, iconSrc: resolved.iconSrc });
    }
    return list;
  }, [providers, themeMode, t]);

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {builtIns.map((p) => {
        const label = p.labelKey ? (t(p.labelKey) as string) : (p.displayName || p.id);
        const selected = p.id === activeId;
        const isCodex = p.id === "codex";
        const isClaude = p.id === "claude";
        const isGemini = p.id === "gemini";
        return (
          <div key={p.id} className="flex items-center">
            {isCodex ? (
              selected ? (
                <CodexUsageHoverCard
                  terminalMode={terminalMode}
                  distro={terminalMode === "wsl" ? distro : undefined}
                  loadPolicy="ifMissing"
                  enableAutoRefreshInterval={false}
                  enableGlobalRefreshEvent={false}
                  renderTrigger={({ percentLabel, rateState }) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-8 gap-2 px-2.5 border border-[var(--cf-border)] bg-slate-100 text-[var(--cf-text-primary)] dark:bg-slate-800 active:scale-100 shadow-apple-xs dark:shadow-apple-dark-xs",
                        rateState.error && "text-[var(--cf-red)]",
                      )}
                      title={label}
                      aria-label={label}
                      onClick={() => onChange(p.id)}
                    >
                      {p.iconSrc ? <img src={p.iconSrc} className="h-4 w-4 shrink-0" alt={label} /> : <span className="text-xs">{label[0] || "?"}</span>}
                      <span className="tabular-nums text-xs text-[var(--cf-text-secondary)]">{percentLabel}</span>
                    </Button>
                  )}
                />
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("h-8 w-8 rounded-md", selected && "bg-slate-100 dark:bg-slate-800")}
                  title={label}
                  aria-label={label}
                  onClick={() => onChange(p.id)}
                >
                  {p.iconSrc ? <img src={p.iconSrc} className="h-4 w-4" alt={label} /> : <span className="text-xs">{label[0] || "?"}</span>}
                </Button>
              )
            ) : isClaude ? (
              selected ? (
                <ClaudeUsageHoverCard
                  terminalMode={terminalMode}
                  distro={terminalMode === "wsl" ? distro : undefined}
                  loadPolicy="ifMissing"
                  enableGlobalRefreshEvent={true}
                  renderTrigger={({ percentLabel, usageState }) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-8 gap-2 px-2.5 border border-[var(--cf-border)] bg-slate-100 text-[var(--cf-text-primary)] dark:bg-slate-800 active:scale-100 shadow-apple-xs dark:shadow-apple-dark-xs",
                        usageState.error && "text-[var(--cf-red)]",
                      )}
                      title={label}
                      aria-label={label}
                      onClick={() => onChange(p.id)}
                    >
                      {p.iconSrc ? <img src={p.iconSrc} className="h-4 w-4 shrink-0" alt={label} /> : <span className="text-xs">{label[0] || "?"}</span>}
                      <span className="tabular-nums text-xs text-[var(--cf-text-secondary)]">{percentLabel}</span>
                    </Button>
                  )}
                />
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("h-8 w-8 rounded-md", selected && "bg-slate-100 dark:bg-slate-800")}
                  title={label}
                  aria-label={label}
                  onClick={() => onChange(p.id)}
                >
                  {p.iconSrc ? <img src={p.iconSrc} className="h-4 w-4" alt={label} /> : <span className="text-xs">{label[0] || "?"}</span>}
                </Button>
              )
            ) : isGemini ? (
              selected ? (
                <GeminiUsageHoverCard
                  terminalMode={terminalMode}
                  distro={terminalMode === "wsl" ? distro : undefined}
                  loadPolicy="ifMissing"
                  enableGlobalRefreshEvent={true}
                  renderTrigger={({ percentLabel, usageState }) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-8 gap-2 px-2.5 border border-[var(--cf-border)] bg-slate-100 text-[var(--cf-text-primary)] dark:bg-slate-800 active:scale-100 shadow-apple-xs dark:shadow-apple-dark-xs",
                        usageState.error && "text-[var(--cf-red)]",
                      )}
                      title={label}
                      aria-label={label}
                      onClick={() => onChange(p.id)}
                    >
                      {p.iconSrc ? <img src={p.iconSrc} className="h-4 w-4 shrink-0" alt={label} /> : <span className="text-xs">{label[0] || "?"}</span>}
                      <span className="tabular-nums text-xs text-[var(--cf-text-secondary)]">{percentLabel}</span>
                    </Button>
                  )}
                />
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("h-8 w-8 rounded-md", selected && "bg-slate-100 dark:bg-slate-800")}
                  title={label}
                  aria-label={label}
                  onClick={() => onChange(p.id)}
                >
                  {p.iconSrc ? <img src={p.iconSrc} className="h-4 w-4" alt={label} /> : <span className="text-xs">{label[0] || "?"}</span>}
                </Button>
              )
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className={cn("h-8 w-8 rounded-md", selected && "bg-slate-100 dark:bg-slate-800")}
                title={label}
                aria-label={label}
                onClick={() => onChange(p.id)}
              >
                {p.iconSrc ? <img src={p.iconSrc} className="h-4 w-4" alt={label} /> : <span className="text-xs">{label[0] || "?"}</span>}
              </Button>
            )}
          </div>
        );
      })}

      {customs.map((x) => {
        const selected = x.id === activeId;
        return (
          <div key={x.id} className="flex items-center">
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8 rounded-md", selected && "bg-slate-100 dark:bg-slate-800")}
              title={x.label}
              aria-label={x.label}
              onClick={() => onChange(x.id)}
            >
              {x.iconSrc ? <img src={x.iconSrc} className="h-4 w-4" alt={x.label} /> : <span className="text-xs">{(x.label || "?")[0]}</span>}
            </Button>
          </div>
        );
      })}
    </div>
  );
};
