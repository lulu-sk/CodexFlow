// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { resolveGitTextWith } from "./git-i18n";
import type { GitShelfItem } from "./types";

export type GitShelfRestoreDialogValue = {
  selectedPaths: string[];
  targetChangeListId: string;
  removeAppliedFromShelf: boolean;
};

type GitShelfRestoreDialogProps = {
  open: boolean;
  shelf: GitShelfItem | null;
  changeListOptions: Array<{ id: string; name: string }>;
  changeListsEnabled: boolean;
  submitting: boolean;
  value: GitShelfRestoreDialogValue;
  onClose(): void;
  onChange(nextValue: GitShelfRestoreDialogValue): void;
  onSubmit(): void;
};

/**
 * 把传入路径数组规整成去重后的稳定列表，供恢复对话框的勾选与提交逻辑复用。
 */
function normalizeShelfRestorePaths(paths: string[]): string[] {
  return Array.from(new Set(
    (Array.isArray(paths) ? paths : [])
      .map((item) => String(item || "").trim().replace(/\\/g, "/"))
      .filter(Boolean),
  ));
}

/**
 * 渲染 shelf 恢复对话框，统一承载 partial unshelve、目标更改列表与 remove policy。
 */
export function ShelfRestoreDialog(props: GitShelfRestoreDialogProps): JSX.Element | null {
  const { t } = useTranslation(["git", "common"]);
  const gt = (key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveGitTextWith(t, key, fallback, values);
  };
  const {
    open,
    shelf,
    changeListOptions,
    changeListsEnabled,
    submitting,
    value,
    onClose,
    onChange,
    onSubmit,
  } = props;
  if (!open || !shelf) return null;
  const availablePaths = normalizeShelfRestorePaths(shelf.paths || []);
  const selectedPathSet = new Set(normalizeShelfRestorePaths(value.selectedPaths));
  const allSelected = availablePaths.length > 0 && availablePaths.every((item) => selectedPathSet.has(item));

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !submitting) onClose();
      }}
    >
      <DialogContent className="cf-git-dialog-panel w-[760px] max-w-[calc(100vw-4rem)] overflow-hidden p-0">
        <DialogHeader className="border-b border-[var(--cf-border)] px-5 py-4">
          <DialogTitle className="text-base">{gt("dialogs.shelfRestore.title", "取消搁置")}</DialogTitle>
          <DialogDescription>
            {gt("dialogs.shelfRestore.description", "选择需要取消搁置的文件，并决定是否在成功后从 shelf 中移除已应用内容。")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-5 py-4">
          <section className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--cf-text-primary)]">
                {shelf.message || shelf.displayName || shelf.ref}
              </div>
              {shelf.originalChangeListName ? <Badge variant="secondary" className="text-[10px]">{shelf.originalChangeListName}</Badge> : null}
            </div>
            <div className="mt-1 text-[11px] text-[var(--cf-text-secondary)]">{shelf.ref}</div>
          </section>

          <section className="overflow-hidden rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)]">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-4 py-3">
              <div className="text-[10px] font-apple-medium uppercase tracking-[0.08em] text-[var(--cf-text-secondary)]">
                {gt("dialogs.shelfRestore.files.title", "待取消搁置的文件")}
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-[10px]">
                  {gt("dialogs.shelfRestore.files.selectedCount", "已选 {{selected}} / {{total}}", {
                    selected: selectedPathSet.size,
                    total: availablePaths.length,
                  })}
                </Badge>
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  onClick={() => {
                    onChange({
                      ...value,
                      selectedPaths: allSelected ? [] : availablePaths,
                    });
                  }}
                >
                  {allSelected
                    ? gt("dialogs.shelfRestore.actions.clearSelection", "取消全选")
                    : gt("dialogs.shelfRestore.actions.selectAll", "全选")}
                </Button>
              </div>
            </div>
            <div className="max-h-[320px] overflow-y-auto px-4 py-3">
              {availablePaths.length > 0 ? (
                <div className="space-y-2">
                  {availablePaths.map((pathText) => {
                    const checked = selectedPathSet.has(pathText);
                    return (
                      <label
                        key={pathText}
                        className={`flex cursor-pointer items-start gap-3 rounded-apple border px-3 py-2 text-left transition ${
                          checked
                            ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
                            : "border-[var(--cf-border)] bg-[var(--cf-surface)] hover:border-[var(--cf-accent)]/40"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 accent-[var(--cf-accent)]"
                          checked={checked}
                          onChange={() => {
                            const nextSelected = new Set(selectedPathSet);
                            if (checked) nextSelected.delete(pathText);
                            else nextSelected.add(pathText);
                            onChange({
                              ...value,
                              selectedPaths: Array.from(nextSelected),
                            });
                          }}
                        />
                        <div className="min-w-0 flex-1 break-all text-xs text-[var(--cf-text-primary)]">{pathText}</div>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="text-xs text-[var(--cf-text-secondary)]">
                  {gt("dialogs.shelfRestore.files.empty", "该搁置记录没有可恢复的文件列表。")}
                </div>
              )}
            </div>
          </section>

          {changeListsEnabled ? (
            <section className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-4 py-3">
              <div className="mb-2 text-[10px] font-apple-medium uppercase tracking-[0.08em] text-[var(--cf-text-secondary)]">
                {gt("dialogs.shelfRestore.targetChangeList.title", "目标更改列表")}
              </div>
              <Select
                value={value.targetChangeListId || "__default__"}
                onValueChange={(nextValue) => {
                  onChange({
                    ...value,
                    targetChangeListId: nextValue === "__default__" ? "" : nextValue,
                  });
                }}
              >
                <SelectTrigger className="cf-git-filter-input h-9 bg-[var(--cf-surface)] px-2 text-xs">
                  <SelectValue placeholder={gt("dialogs.shelfRestore.targetChangeList.default", "恢复到当前默认列表")} />
                </SelectTrigger>
                <SelectContent fitContent maxContentWidth={360}>
                  <SelectItem value="__default__">{gt("dialogs.shelfRestore.targetChangeList.default", "恢复到当前默认列表")}</SelectItem>
                  {changeListOptions.map((item) => (
                    <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>
          ) : null}

          <button
            type="button"
            className={`w-full rounded-apple border px-4 py-3 text-left transition ${
              value.removeAppliedFromShelf
                ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
                : "border-[var(--cf-border)] bg-[var(--cf-surface-muted)] hover:border-[var(--cf-accent)]/40"
            }`}
            onClick={() => {
              onChange({
                ...value,
                removeAppliedFromShelf: !value.removeAppliedFromShelf,
              });
            }}
          >
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-[var(--cf-accent)]"
                checked={value.removeAppliedFromShelf}
                readOnly
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-[var(--cf-text-primary)]">
                  {gt("dialogs.shelfRestore.removeApplied.title", "移除已成功应用的内容")}
                </div>
                <div className="mt-1 text-xs leading-5 text-[var(--cf-text-secondary)]">
                  {gt("dialogs.shelfRestore.removeApplied.description", "开启后会从 shelf 中删除已取消搁置的文件；关闭时保留原记录，便于稍后再次取消搁置。")}
                </div>
              </div>
            </div>
          </button>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--cf-border)] px-5 py-3.5">
          <Button size="xs" variant="secondary" onClick={onClose} data-cf-dialog-cancel="true">
            {gt("dialogs.shelfRestore.actions.cancel", "取消")}
          </Button>
          <Button size="xs" onClick={onSubmit} disabled={submitting || selectedPathSet.size <= 0} data-cf-dialog-primary="true">
            {gt("dialogs.shelfRestore.actions.submit", "恢复所选文件")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
