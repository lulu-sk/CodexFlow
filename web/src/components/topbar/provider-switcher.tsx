// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { AppSettings, ProviderItem } from "@/types/host";
import { getBuiltInProviders } from "@/lib/providers/builtins";
import { resolveProvider } from "@/lib/providers/resolve";
import { CodexUsageHoverCard } from "@/components/topbar/codex-status";
import { ClaudeUsageHoverCard } from "@/components/topbar/claude-status";
import { GeminiUsageHoverCard } from "@/components/topbar/gemini-status";
import { MoreHorizontal } from "lucide-react";

type TerminalMode = NonNullable<AppSettings["terminal"]>;

export type ProviderSwitcherProps = {
  activeId: string;
  providers: ProviderItem[];
  onChange: (id: string) => void;
  terminalMode?: TerminalMode;
  distro?: string;
  className?: string;
};

/**
 * 顶部栏引擎切换器：固定展示 Codex/Claude/Gemini 三个图标，额外引擎通过“更多”菜单选择。
 */
export const ProviderSwitcher: React.FC<ProviderSwitcherProps> = ({ activeId, providers, onChange, terminalMode, distro, className }) => {
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
    return getBuiltInProviders().map((meta) => resolveProvider(byId.get(meta.id) ?? { id: meta.id }));
  }, [byId]);

  const extras = useMemo(() => {
    const builtInIds = new Set(getBuiltInProviders().map((x) => x.id));
    const list: Array<{ id: string; label: string; iconSrc: string }> = [];
    for (const it of providers || []) {
      const resolved = resolveProvider(it);
      if (!resolved.id || builtInIds.has(resolved.id as any)) continue;
      const label = String(resolved.displayName || "").trim() || (t("providers:customEngine", "Custom Engine") as string);
      list.push({ id: resolved.id, label, iconSrc: resolved.iconSrc });
    }
    return list;
  }, [providers, t]);

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

      {extras.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-md" title={t("providers:more") as string} aria-label={t("providers:more") as string}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="text-xs text-slate-500">{t("providers:customList")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {extras.map((x) => (
              <DropdownMenuItem key={x.id} onClick={() => onChange(x.id)} className="flex items-center gap-2">
                {x.iconSrc ? <img src={x.iconSrc} className="h-4 w-4" alt={x.label} /> : null}
                <span className="truncate">{x.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
};
