import React, { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatGitLogFilterTriggerLabel } from "./log-filters";
import { resolveGitText } from "./git-i18n";

export type GitLogMultiSelectFilterOption = {
  value: string;
  label: string;
  keywords?: string[];
};

type GitLogMultiSelectFilterButtonProps = {
  label: string;
  values: string[];
  options: GitLogMultiSelectFilterOption[];
  disabled?: boolean;
  searchPlaceholder?: string;
  triggerClassName?: string;
  menuClassName?: string;
  onChange: (values: string[]) => void;
};

type GitLogDateFilterButtonProps = {
  label?: string;
  dateFrom: string;
  dateTo: string;
  disabled?: boolean;
  triggerClassName?: string;
  onSelectPreset: (preset: string) => void;
};

/**
 * 根据按钮文案长度自适应压缩字距与字号，减少筛选工具栏的横向占用。
 */
function resolveGitLogFilterTriggerTextClass(text: string): string {
  const length = Array.from(String(text || "").trim()).length;
  if (length >= 14) return "text-[11px] tracking-[-0.06em]";
  if (length >= 10) return "text-[11.5px] tracking-[-0.04em]";
  if (length >= 7) return "tracking-[-0.025em]";
  return "";
}

/**
 * 按关键字过滤多选候选项，供分支/用户筛选弹层复用。
 */
function filterGitLogMultiSelectOptions(
  options: GitLogMultiSelectFilterOption[],
  query: string,
): GitLogMultiSelectFilterOption[] {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return options;
  return options.filter((option) => {
    const keywords = Array.isArray(option.keywords) ? option.keywords : [];
    const haystack = [option.label, option.value, ...keywords].join("\n").toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

/**
 * 切换多选筛选项，并保持结果去重与原有顺序稳定。
 */
function toggleGitLogMultiSelectValue(values: string[], value: string): string[] {
  const clean = String(value || "").trim();
  if (!clean) return values;
  return values.includes(clean)
    ? values.filter((item) => item !== clean)
    : [...values, clean];
}

/**
 * 把日期筛选状态压缩成按钮文案，优先展示快捷预设，其次回退显式范围。
 */
export function formatGitLogDateFilterLabel(label: string, dateFrom: string, dateTo: string): string {
  const from = String(dateFrom || "").trim();
  const to = String(dateTo || "").trim();
  if (!from && !to) return label;
  const now = Date.now();
  const fromTime = from ? new Date(from).getTime() : Number.NaN;
  if (Number.isFinite(fromTime) && !to) {
    const days = Math.round((now - fromTime) / (24 * 60 * 60 * 1000));
    if (days >= 0 && days <= 2) return `${label}: ${resolveGitText("log.filters.recentDay", "最近 1 天")}`;
    if (days >= 6 && days <= 8) return `${label}: ${resolveGitText("log.filters.recentWeek", "最近 1 周")}`;
    if (days >= 29 && days <= 31) return `${label}: ${resolveGitText("log.filters.recent30Days", "最近 30 天")}`;
  }
  if (from && to) return `${label}: ${from} ~ ${to}`;
  if (from) return `${label}: ${resolveGitText("log.filters.fromPrefix", "自")} ${from}`;
  return `${label}: ${resolveGitText("log.filters.toPrefix", "至")} ${to}`;
}

/**
 * 顶部多值筛选按钮，按 IDEA popup 语义提供搜索、多选与清空入口。
 */
export function GitLogMultiSelectFilterButton(props: GitLogMultiSelectFilterButtonProps): JSX.Element {
  const {
    label,
    values,
    options,
    disabled,
    searchPlaceholder,
    triggerClassName,
    menuClassName,
    onChange,
  } = props;
  const [query, setQuery] = useState<string>("");
  const filteredOptions = useMemo<GitLogMultiSelectFilterOption[]>(() => {
    return filterGitLogMultiSelectOptions(options, query);
  }, [options, query]);
  const triggerLabel = useMemo<string>(() => {
    return formatGitLogFilterTriggerLabel(label, values, { emptyLabel: label, maxInlineValues: 1 });
  }, [label, values]);
  const triggerTextClassName = useMemo<string>(() => {
    return resolveGitLogFilterTriggerTextClass(triggerLabel);
  }, [triggerLabel]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <Button
          size="xs"
          variant={values.length > 0 ? "secondary" : "outline"}
          className={cn("max-w-[156px] justify-start px-2", triggerClassName)}
          disabled={disabled}
          title={values.length > 0 ? values.join(" | ") : label}
        >
          <span className={cn("truncate", triggerTextClassName)}>{triggerLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={cn("w-[260px] p-0", menuClassName)}>
        <div className="border-b border-[var(--cf-border)] p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-[var(--cf-text-secondary)]" />
            <Input
              className="h-8 pl-7 text-xs"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder || resolveGitText("log.filters.searchPlaceholder", "搜索{{label}}", { label })}
            />
          </div>
        </div>
        <div className="max-h-[280px] overflow-y-auto p-1">
          <DropdownMenuItem
            className="text-xs"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onChange([]);
            }}
          >
            <Check className={cn("mr-2 h-3.5 w-3.5", values.length === 0 ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0")} />
            {resolveGitText("log.filters.all", "全部")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {filteredOptions.length > 0 ? filteredOptions.map((option) => {
            const selected = values.includes(option.value);
            return (
              <DropdownMenuItem
                key={`${label}:${option.value}`}
                className="text-xs"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onChange(toggleGitLogMultiSelectValue(values, option.value));
                }}
                title={option.label}
              >
                <Check className={cn("mr-2 h-3.5 w-3.5", selected ? "opacity-100 text-[var(--cf-accent)]" : "opacity-0")} />
                <span className="truncate">{option.label}</span>
              </DropdownMenuItem>
            );
          }) : (
            <div className="px-3 py-4 text-xs text-[var(--cf-text-secondary)]">{resolveGitText("log.filters.noMatch", "没有匹配项")}</div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 顶部日期筛选按钮，提供 IDEA 风格的快捷时间范围与自定义入口。
 */
export function GitLogDateFilterButton(props: GitLogDateFilterButtonProps): JSX.Element {
  const {
    label = resolveGitText("log.filters.date", "日期"),
    dateFrom,
    dateTo,
    disabled,
    triggerClassName,
    onSelectPreset,
  } = props;
  const triggerLabel = useMemo<string>(() => {
    return formatGitLogDateFilterLabel(label, dateFrom, dateTo);
  }, [dateFrom, dateTo, label]);
  const triggerTextClassName = useMemo<string>(() => {
    return resolveGitLogFilterTriggerTextClass(triggerLabel);
  }, [triggerLabel]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>
        <Button
          size="xs"
          variant={dateFrom || dateTo ? "secondary" : "outline"}
          className={cn("max-w-[156px] justify-start px-2", triggerClassName)}
          disabled={disabled}
          title={triggerLabel}
        >
          <span className={cn("truncate", triggerTextClassName)}>{triggerLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[188px]">
        <DropdownMenuItem className="text-xs" onClick={() => onSelectPreset("all")}>{resolveGitText("log.filters.allTime", "全部时间")}</DropdownMenuItem>
        <DropdownMenuItem className="text-xs" onClick={() => onSelectPreset("1d")}>{resolveGitText("log.filters.recentDay", "最近 1 天")}</DropdownMenuItem>
        <DropdownMenuItem className="text-xs" onClick={() => onSelectPreset("7d")}>{resolveGitText("log.filters.recentWeek", "最近 1 周")}</DropdownMenuItem>
        <DropdownMenuItem className="text-xs" onClick={() => onSelectPreset("30d")}>{resolveGitText("log.filters.recent30Days", "最近 30 天")}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-xs" onClick={() => onSelectPreset("custom")}>{resolveGitText("log.filters.custom", "自定义...")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
