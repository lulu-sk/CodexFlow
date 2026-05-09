// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Diff, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { resolveGitTextWith } from "./git-i18n";
import type {
  GitInteractiveRebaseAction,
  GitInteractiveRebaseEntry,
  GitInteractiveRebasePlan,
  GitLogDetails,
} from "./types";
import {
  getInteractiveRebaseActionAvailability,
  INTERACTIVE_REBASE_ACTION_OPTIONS,
  isInteractiveRebaseMessageAction,
  resolveInteractiveRebaseMessageValue,
  resolveInteractiveRebaseSuggestedMessage,
  summarizeInteractiveRebaseEntries,
} from "./interactive-rebase-model";

type GitTranslate = (key: string, fallback: string, values?: Record<string, unknown>) => string;

type InteractiveRebaseDialogProps = {
  open: boolean;
  plan: GitInteractiveRebasePlan;
  entries: GitInteractiveRebaseEntry[];
  selectedHash: string;
  submitting: boolean;
  detailsLoading?: boolean;
  selectedDetails?: GitLogDetails | null;
  selectedDiffPath?: string;
  error?: string;
  onOpenChange: (open: boolean) => void;
  onSelectHash: (hash: string) => void;
  onMoveEntry: (hash: string, offset: -1 | 1) => void;
  onMoveEntryToEdge: (hash: string, edge: "top" | "bottom") => void;
  onChangeAction: (hash: string, action: GitInteractiveRebaseAction) => void;
  onChangeMessage: (hash: string, message: string) => void;
  onSelectDiffPath: (path: string) => void;
  onOpenDiff: () => void;
  onFillSuggestedMessage: (hash: string) => void;
  onReset: () => void;
  onSubmit: () => void;
  onRequestCancel: () => void;
};

/**
 * 把 ISO 时间压缩成简短日期，避免 interactive rebase 列表信息过载。
 */
function toCompactDateText(value: string): string {
  const text = String(value || "").trim();
  if (!text) return "-";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * 把 action 转换为按钮语义色，便于当前上下文动作快速识别历史改写强度。
 */
function getActionButtonVariant(
  activeAction: GitInteractiveRebaseAction,
  candidate: GitInteractiveRebaseAction,
): "default" | "secondary" | "danger" {
  if (candidate !== activeAction) return candidate === "drop" ? "danger" : "secondary";
  return candidate === "drop" ? "danger" : "default";
}

/**
 * 把变基 warning 映射为紧凑提示块，统一承载 autosquash / update-refs 等上下文提示。
 */
function renderPlanWarnings(plan: GitInteractiveRebasePlan, gt: GitTranslate): React.JSX.Element | null {
  if (!Array.isArray(plan.warnings) || plan.warnings.length <= 0) return null;
  return (
    <div className="space-y-2 border-b border-[var(--cf-border)] px-5 py-3">
      {plan.warnings.map((warning) => (
        <div
          key={warning.code}
          className="rounded-apple border border-[var(--cf-yellow-light)] bg-[var(--cf-yellow-light)]/70 px-3 py-2 text-xs leading-5 text-[var(--cf-warning-foreground)]"
        >
          <div className="font-medium">
            {warning.code === "autosquash"
              ? gt("dialogs.interactiveRebase.warnings.autosquash.title", "检测到 autosquash 提交")
              : gt("dialogs.interactiveRebase.warnings.updateRefs.title", "检测到 rebase.updateRefs")}
          </div>
          <div className="mt-1">
            {warning.code === "autosquash"
              ? gt("dialogs.interactiveRebase.warnings.autosquash.message", "当前计划包含 fixup!/squash!/amend! 提交。应用内编辑器会固定展示真实 replay 顺序，并以 `--no-autosquash` 执行。")
              : gt("dialogs.interactiveRebase.warnings.updateRefs.message", "当前 Git 配置启用了 `rebase.updateRefs`。应用内结果仍会按真实 Git 执行，但相关引用会在变基期间被联动改写。")}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 渲染当前选中提交的 details 面板，优先复用 `log.details` 的真实文件与 refs 信息。
 */
function renderSelectedDetails(
  entry: GitInteractiveRebaseEntry,
  detailsLoading: boolean,
  gt: GitTranslate,
  listSeparator: string,
  selectedDetails?: GitLogDetails | null,
  selectedDiffPath?: string,
  onSelectDiffPath?: (path: string) => void,
  onOpenDiff?: () => void,
): React.JSX.Element {
  if (detailsLoading) {
    return (
      <div className="flex items-center gap-2 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-3 text-xs text-[var(--cf-text-secondary)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {gt("dialogs.interactiveRebase.details.loading", "正在读取提交详情...")}
      </div>
    );
  }
  if (selectedDetails?.mode === "single" && selectedDetails.detail.hash === entry.hash) {
    return (
      <div className="space-y-3 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-4 py-3">
        <div className="grid gap-2 text-xs text-[var(--cf-text-secondary)] md:grid-cols-2">
          <div>{gt("dialogs.interactiveRebase.details.author", "作者：{{value}}", { value: selectedDetails.detail.authorName || "-" })}</div>
          <div>{gt("dialogs.interactiveRebase.details.email", "邮箱：{{value}}", { value: selectedDetails.detail.authorEmail || "-" })}</div>
          <div>{gt("dialogs.interactiveRebase.details.time", "时间：{{value}}", { value: toCompactDateText(selectedDetails.detail.authorDate) })}</div>
          <div>{gt("dialogs.interactiveRebase.details.parents", "父提交：{{value}}", {
            value: selectedDetails.detail.parents.map((parent) => parent.slice(0, 8)).join(listSeparator) || "(root)",
          })}</div>
        </div>
        {selectedDetails.detail.branches.length > 0 ? (
          <div className="text-xs text-[var(--cf-text-secondary)]">
            {gt("dialogs.interactiveRebase.details.branches", "分支：{{value}}", {
              value: selectedDetails.detail.branches.join(listSeparator),
            })}
          </div>
        ) : null}
        {selectedDetails.detail.tags.length > 0 ? (
          <div className="text-xs text-[var(--cf-text-secondary)]">
            {gt("dialogs.interactiveRebase.details.tags", "标签：{{value}}", {
              value: selectedDetails.detail.tags.join(listSeparator),
            })}
          </div>
        ) : null}
        <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-3 text-xs leading-5 text-[var(--cf-text-primary)]">
          <pre className="whitespace-pre-wrap break-words font-mono">{selectedDetails.detail.body || entry.fullMessage || entry.subject}</pre>
        </div>
        <div className="space-y-2">
          <div className="text-xs font-medium text-[var(--cf-text-secondary)]">
            {gt("dialogs.interactiveRebase.details.files", "变更文件（{{count}}）", { count: selectedDetails.detail.files.length })}
          </div>
          <div className="space-y-1">
            {selectedDetails.detail.files.slice(0, 8).map((file, index) => {
              const selected = selectedDiffPath === file.path;
              return (
                <button
                  key={`${file.status}:${file.path}`}
                  type="button"
                  className={`flex w-full items-center gap-2 rounded-apple px-2 py-1 text-left text-xs ${
                    selected
                      ? "bg-[var(--cf-accent)]/10 text-[var(--cf-text-primary)]"
                      : "text-[var(--cf-text-secondary)] hover:bg-[var(--cf-surface)]"
                  }`}
                  data-testid={`interactive-rebase-detail-file-${index}`}
                  onClick={() => {
                    onSelectDiffPath?.(file.path);
                  }}
                  onDoubleClick={() => {
                    onSelectDiffPath?.(file.path);
                    onOpenDiff?.();
                  }}
                >
                  <span className="w-5 shrink-0 font-mono text-[10px] uppercase">{file.status}</span>
                  <span className="truncate">{file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}</span>
                </button>
              );
            })}
            {selectedDetails.detail.files.length > 8 ? (
              <div className="text-[11px] text-[var(--cf-text-secondary)]">
                {gt("dialogs.interactiveRebase.details.moreFiles", "还有 {{count}} 个文件未展开", {
                  count: selectedDetails.detail.files.length - 8,
                })}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-4 py-3 text-xs leading-5 text-[var(--cf-text-secondary)]">
      <div>{gt("dialogs.interactiveRebase.details.author", "作者：{{value}}", { value: entry.authorName || "-" })}</div>
      <div>{gt("dialogs.interactiveRebase.details.time", "时间：{{value}}", { value: toCompactDateText(entry.authorDate) })}</div>
      <div>{gt("dialogs.interactiveRebase.details.subject", "原始消息首行：{{value}}", { value: entry.subject })}</div>
      <div className="mt-2 whitespace-pre-wrap break-words text-[var(--cf-text-primary)]">{entry.fullMessage || entry.subject}</div>
    </div>
  );
}

/**
 * 渲染应用内 interactive rebase editor，对齐 IDEA 的提交列表 + 行级动作编辑主流程。
 */
export function InteractiveRebaseDialog({
  open,
  plan,
  entries,
  selectedHash,
  submitting,
  detailsLoading,
  selectedDetails,
  selectedDiffPath,
  error,
  onOpenChange,
  onSelectHash,
  onMoveEntry,
  onMoveEntryToEdge,
  onChangeAction,
  onChangeMessage,
  onSelectDiffPath,
  onOpenDiff,
  onFillSuggestedMessage,
  onReset,
  onSubmit,
  onRequestCancel,
}: InteractiveRebaseDialogProps): React.JSX.Element {
  const { t } = useTranslation(["git", "common"]);
  const gt = React.useCallback((key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveGitTextWith(t, key, fallback, values);
  }, [t]);
  const listSeparator = gt("dialogs.interactiveRebase.listSeparator", "、");
  const selectedEntry = entries.find((entry) => entry.hash === selectedHash) || entries[0] || null;
  const selectedIndex = selectedEntry ? entries.findIndex((entry) => entry.hash === selectedEntry.hash) : -1;
  const messageValue = selectedEntry ? resolveInteractiveRebaseMessageValue(entries, selectedEntry.hash) : "";
  const suggestedMessage = selectedEntry ? resolveInteractiveRebaseSuggestedMessage(entries, selectedEntry.hash) : "";
  const canMoveUp = selectedIndex > 0;
  const canMoveDown = selectedIndex >= 0 && selectedIndex < entries.length - 1;
  const summary = summarizeInteractiveRebaseEntries(entries);
  const actionAvailability = selectedEntry
    ? getInteractiveRebaseActionAvailability(entries, selectedEntry.hash, gt)
    : null;
  const canOpenDiff = !!selectedDetails && selectedDetails.mode === "single" && selectedDetails.detail.files.length > 0 && !!selectedDiffPath;

  useEffect(() => {
    if (!open || submitting || !selectedEntry || !actionAvailability) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const tagName = String(target?.tagName || "").toUpperCase();
      if (target?.isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") return;
      const lowerKey = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && lowerKey === "d") {
        if (!canOpenDiff) return;
        event.preventDefault();
        onOpenDiff();
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (lowerKey === "r") {
        event.preventDefault();
        onChangeAction(selectedEntry.hash, "reword");
        return;
      }
      if (lowerKey === "e") {
        event.preventDefault();
        onChangeAction(selectedEntry.hash, "edit");
        return;
      }
      if (lowerKey === "f") {
        if (!actionAvailability.fixup.enabled) return;
        event.preventDefault();
        onChangeAction(selectedEntry.hash, "fixup");
        return;
      }
      if (lowerKey === "s") {
        if (!actionAvailability.squash.enabled) return;
        event.preventDefault();
        onChangeAction(selectedEntry.hash, "squash");
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        onChangeAction(selectedEntry.hash, "drop");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionAvailability, canOpenDiff, onChangeAction, onOpenDiff, open, selectedEntry, submitting]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="cf-git-dialog-panel w-[960px] max-w-[calc(100vw-3rem)] p-0">
        <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
          <DialogTitle className="text-base">{gt("dialogs.interactiveRebase.title", "交互式变基")}</DialogTitle>
          <DialogDescription>
            {gt("dialogs.interactiveRebase.description", "共 {{count}} 个提交，范围从 {{from}} 到当前 HEAD。", {
              count: entries.length,
              from: plan.rootMode
                ? gt("dialogs.interactiveRebase.range.root", "仓库根提交")
                : (plan.baseHash ? gt("dialogs.interactiveRebase.range.afterHash", "{{hash}} 之后", { hash: plan.baseHash.slice(0, 8) }) : gt("dialogs.interactiveRebase.range.target", "目标提交")),
            })}
          </DialogDescription>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--cf-text-secondary)]">
            <span>{gt("dialogs.interactiveRebase.summary.keep", "保留 {{count}}", { count: summary.keepCount })}</span>
            <span>{gt("dialogs.interactiveRebase.summary.rewrite", "改写 {{count}}", { count: summary.rewriteCount })}</span>
            <span>{gt("dialogs.interactiveRebase.summary.drop", "丢弃 {{count}}", { count: summary.dropCount })}</span>
            {summary.autosquashCount > 0 ? <span>{gt("dialogs.interactiveRebase.summary.autosquash", "自动压缩 {{count}}", { count: summary.autosquashCount })}</span> : null}
          </div>
        </DialogHeader>
      {renderPlanWarnings(plan, gt)}
        <div className="grid min-h-[560px] grid-cols-[360px_minmax(0,1fr)]">
          <div className="border-r border-[var(--cf-border)] bg-[var(--cf-surface-solid)]">
            <div className="border-b border-[var(--cf-border)] px-4 py-3 text-[11px] text-[var(--cf-text-secondary)]">
              {gt("dialogs.interactiveRebase.orderHint", "提交按从旧到新的顺序展示。上下移动会直接改变最终重放顺序。")}
            </div>
            <div className="max-h-[510px] overflow-y-auto px-3 py-3">
              <div className="space-y-2">
                {entries.map((entry, index) => {
                  const selected = selectedEntry?.hash === entry.hash;
                  return (
                    <button
                      key={entry.hash}
                      type="button"
                      className={`w-full rounded-apple border px-3 py-3 text-left transition-colors ${
                        selected
                          ? "border-[var(--cf-accent)] bg-[var(--cf-accent)]/10"
                          : "border-[var(--cf-border)] bg-[var(--cf-surface)] hover:border-[var(--cf-border-strong)]"
                      }`}
                      data-testid={`interactive-rebase-row-${entry.hash}`}
                      onClick={() => onSelectHash(entry.hash)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-[var(--cf-text-secondary)]">
                            <span>{String(index + 1).padStart(2, "0")}</span>
                            <span className="rounded-full border border-[var(--cf-border)] px-2 py-0.5">
                              {gt(`dialogs.interactiveRebase.actions.${entry.action}`, entry.action)}
                            </span>
                          </div>
                          <div className="mt-1 truncate text-sm font-apple-medium text-[var(--cf-text-primary)]" title={entry.subject}>
                            {entry.subject}
                          </div>
                          <div className="mt-1 flex items-center gap-2 truncate text-[11px] text-[var(--cf-text-secondary)]">
                            <span>{entry.shortHash}</span>
                            <span>{entry.authorName || "-"}</span>
                            <span>{toCompactDateText(entry.authorDate)}</span>
                          </div>
                          {entry.autosquashCandidate ? (
                            <div className="mt-1 text-[11px] text-[var(--cf-warning-foreground)]">{gt("dialogs.interactiveRebase.autosquashCandidate", "自动压缩候选")}</div>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="flex min-h-0 flex-col">
            {selectedEntry ? (
              <>
                <div className="border-b border-[var(--cf-border)] px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--cf-text-secondary)]">
                        {selectedEntry.shortHash}
                      </div>
                      <div className="mt-1 text-base font-apple-medium text-[var(--cf-text-primary)]">
                        {selectedEntry.subject}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={onOpenDiff}
                        disabled={!canOpenDiff || submitting}
                        data-testid="interactive-rebase-open-diff"
                      >
                        <Diff className="mr-1 h-3.5 w-3.5" />
                        {gt("dialogs.interactiveRebase.openDiff", "打开差异")}
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => onMoveEntryToEdge(selectedEntry.hash, "top")}
                        disabled={!canMoveUp || submitting}
                        data-testid="interactive-rebase-move-top"
                      >
                        <ChevronsUp className="mr-1 h-3.5 w-3.5" />
                        {gt("dialogs.interactiveRebase.moveTop", "置顶")}
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => onMoveEntry(selectedEntry.hash, -1)}
                        disabled={!canMoveUp || submitting}
                        data-testid="interactive-rebase-move-up"
                      >
                        <ArrowUp className="mr-1 h-3.5 w-3.5" />
                        {gt("dialogs.interactiveRebase.moveUp", "上移")}
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => onMoveEntry(selectedEntry.hash, 1)}
                        disabled={!canMoveDown || submitting}
                        data-testid="interactive-rebase-move-down"
                      >
                        <ArrowDown className="mr-1 h-3.5 w-3.5" />
                        {gt("dialogs.interactiveRebase.moveDown", "下移")}
                      </Button>
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => onMoveEntryToEdge(selectedEntry.hash, "bottom")}
                        disabled={!canMoveDown || submitting}
                        data-testid="interactive-rebase-move-bottom"
                      >
                        <ChevronsDown className="mr-1 h-3.5 w-3.5" />
                        {gt("dialogs.interactiveRebase.moveBottom", "置底")}
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto px-5 py-4">
                  <div className="mb-4 space-y-2">
                    <div className="text-xs text-[var(--cf-text-secondary)]">{gt("dialogs.interactiveRebase.quickActions", "上下文动作")}</div>
                    <div className="flex flex-wrap gap-2">
                      {INTERACTIVE_REBASE_ACTION_OPTIONS.map((option) => (
                        <Button
                          key={`quick-${option.value}`}
                          size="xs"
                          variant={getActionButtonVariant(selectedEntry.action, option.value)}
                          onClick={() => onChangeAction(selectedEntry.hash, option.value)}
                          disabled={submitting || actionAvailability?.[option.value].enabled === false}
                          title={actionAvailability?.[option.value].reason}
                          data-testid={`interactive-rebase-quick-${option.value}`}
                        >
                          {gt(`dialogs.interactiveRebase.actions.${option.value}`, option.label)}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <label className="block">
                    <div className="mb-1 text-xs text-[var(--cf-text-secondary)]">{gt("dialogs.interactiveRebase.actionLabel", "动作")}</div>
                    <select
                      className="cf-git-filter-input h-9 w-full rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 text-sm"
                      value={selectedEntry.action}
                      data-testid="interactive-rebase-action-select"
                      disabled={submitting}
                      onChange={(event) => onChangeAction(selectedEntry.hash, event.target.value as GitInteractiveRebaseAction)}
                    >
                      {INTERACTIVE_REBASE_ACTION_OPTIONS.map((option) => (
                        <option
                          key={option.value}
                          value={option.value}
                          disabled={actionAvailability?.[option.value].enabled === false}
                        >
                          {gt(`dialogs.interactiveRebase.actions.${option.value}`, option.label)}
                        </option>
                      ))}
                    </select>
                  </label>

                  {isInteractiveRebaseMessageAction(selectedEntry.action) ? (
                    <div className="mt-4">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-xs text-[var(--cf-text-secondary)]">
                          {selectedEntry.action === "reword"
                            ? gt("dialogs.interactiveRebase.messageLabel", "提交信息")
                            : gt("dialogs.interactiveRebase.messageOverrideLabel", "提交信息覆盖（可选）")}
                        </span>
                        {suggestedMessage ? (
                          <Button
                            size="xs"
                            variant="secondary"
                            onClick={() => onFillSuggestedMessage(selectedEntry.hash)}
                            disabled={submitting}
                            data-testid="interactive-rebase-fill-suggestion"
                          >
                            {gt("dialogs.interactiveRebase.fillSuggestedMessage", "填充建议消息")}
                          </Button>
                        ) : null}
                      </div>
                      <textarea
                        className="cf-git-editor-input min-h-[220px] w-full resize-y rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] p-3 text-xs leading-5 shadow-apple-inner transition-all duration-apple hover:border-[var(--cf-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/50 focus-visible:border-[var(--cf-accent)]"
                        placeholder={selectedEntry.action === "reword"
                          ? gt("dialogs.interactiveRebase.messagePlaceholder", "请输入新的提交信息")
                          : gt("dialogs.interactiveRebase.squashPlaceholder", "留空则使用 Git 默认的压缩提交消息")}
                        value={messageValue}
                        data-testid="interactive-rebase-message-input"
                        disabled={submitting}
                        onChange={(event) => onChangeMessage(selectedEntry.hash, event.target.value)}
                      />
                      {selectedEntry.action === "squash" ? (
                        <div className="mt-2 text-[11px] leading-5 text-[var(--cf-text-secondary)]">
                          {gt("dialogs.interactiveRebase.squashHint", "留空时由 Git 按当前变基进度生成默认的压缩提交消息；如果你想固定最终消息，可以手动填写或点击“填充建议消息”。")}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="mt-4 space-y-2">
                    <div className="text-xs text-[var(--cf-text-secondary)]">{gt("dialogs.interactiveRebase.details.title", "提交详情")}</div>
                    {renderSelectedDetails(
                      selectedEntry,
                      detailsLoading === true,
                      gt,
                      listSeparator,
                      selectedDetails,
                      selectedDiffPath,
                      onSelectDiffPath,
                      onOpenDiff,
                    )}
                  </div>

                  {error ? (
                    <div className="mt-4 rounded-apple border border-[var(--cf-danger)]/30 bg-[var(--cf-danger)]/10 px-3 py-2 text-xs text-[var(--cf-danger)]">
                      {error}
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-[var(--cf-border)] px-5 py-4">
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={onReset}
                    disabled={submitting}
                    data-testid="interactive-rebase-reset"
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    {gt("dialogs.interactiveRebase.reset", "重置计划")}
                  </Button>
                  <div className="flex items-center gap-2">
                    <Button size="xs" variant="secondary" onClick={onRequestCancel} disabled={submitting} data-testid="interactive-rebase-cancel">
                      {gt("dialogs.interactiveRebase.cancel", "取消")}
                    </Button>
                    <Button size="xs" onClick={onSubmit} disabled={submitting} data-testid="interactive-rebase-submit">
                      {gt("dialogs.interactiveRebase.submit", "开始变基")}
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-[var(--cf-text-secondary)]">
                {gt("dialogs.interactiveRebase.empty", "当前没有可编辑的提交")}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
