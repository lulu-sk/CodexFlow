// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { resolveGitTextWith } from "../git-i18n";
import {
  createCommitAdvancedOptionsState,
  isCommitAuthorDateInputValid,
  patchCommitAdvancedOptionsState,
  sanitizeCommitAdvancedOptionsState,
  type CommitHooksAvailability,
  type CommitAdvancedOptionsState,
} from "./commit-options-model";

type CommitOptionsPopoverProps = {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  value: CommitAdvancedOptionsState;
  commitHooks?: CommitHooksAvailability;
  commitRenamesSeparatelyDisabled?: boolean;
  commitRenamesSeparatelyHint?: string;
  onOpenChange(open: boolean): void;
  onChange(value: CommitAdvancedOptionsState): void;
};

type PopoverPosition = {
  top: number;
  left: number;
  width: number;
};

/**
 * 根据当前作者时间值推导折叠区默认展开状态；已有值时自动展开，避免隐藏已填写内容。
 */
function shouldExpandAuthorDateSection(value: CommitAdvancedOptionsState): boolean {
  return !!sanitizeCommitAdvancedOptionsState(value).authorDate;
}

/**
 * 根据触发按钮与弹层尺寸计算定位，默认从按钮位置向右上展开；右侧空间不足时再回退到左侧。
 */
function resolvePopoverPosition(anchorRect: DOMRect, panelRect: DOMRect): PopoverPosition {
  const gap = 8;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(Math.max(panelRect.width || 320, 320), viewportWidth - 16);

  let left = anchorRect.left;
  if (left + width > viewportWidth - 8) {
    const fallbackLeft = anchorRect.right - width;
    left = fallbackLeft >= 8 ? fallbackLeft : viewportWidth - width - 8;
  }
  if (left < 8) left = 8;
  if (left + width > viewportWidth - 8) left = viewportWidth - width - 8;

  let top = anchorRect.top - panelRect.height - gap;
  if (top < 8) {
    const nextTop = anchorRect.bottom + gap;
    top = nextTop + panelRect.height <= viewportHeight - 8
      ? nextTop
      : Math.max(8, viewportHeight - panelRect.height - 8);
  }

  return { top, left, width };
}

/**
 * 渲染提交高级选项弹出面板，并把编辑结果保存回当前非模态提交流程状态。
 */
export function CommitOptionsPopover(props: CommitOptionsPopoverProps): React.ReactElement | null {
  const { t } = useTranslation(["git", "common"]);
  const {
    open,
    anchorRef,
    value,
    commitHooks,
    commitRenamesSeparatelyDisabled,
    commitRenamesSeparatelyHint,
    onOpenChange,
    onChange,
  } = props;
  const gt = React.useCallback((key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveGitTextWith(t, key, fallback, values);
  }, [t]);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PopoverPosition>({ top: -9999, left: -9999, width: 360 });
  const [authorDateExpanded, setAuthorDateExpanded] = useState<boolean>(() => shouldExpandAuthorDateSection(value));
  const sanitizedState = useMemo(() => sanitizeCommitAdvancedOptionsState(value), [value]);

  const authorDateInvalid = useMemo(() => {
    return !isCommitAuthorDateInputValid(sanitizedState.authorDate);
  }, [sanitizedState.authorDate]);

  /**
   * 关闭弹层，当前编辑值已实时写回 workflow，无需额外保存。
   */
  const closePopover = (): void => {
    onOpenChange(false);
  };

  /**
   * 根据触发按钮位置刷新弹层坐标，供初次打开、窗口变化与滚动时复用。
   */
  const updatePosition = (): void => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const nextPosition = resolvePopoverPosition(anchor.getBoundingClientRect(), panel.getBoundingClientRect());
    setPosition(nextPosition);
  };

  useLayoutEffect(() => {
    if (!open) return;
    setAuthorDateExpanded(shouldExpandAuthorDateSection(value));
    updatePosition();
    const timer = window.requestAnimationFrame(() => {
      updatePosition();
    });
    return () => {
      window.cancelAnimationFrame(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      const panel = panelRef.current;
      const anchor = anchorRef.current;
      if (!target || !panel || !anchor) return;
      if (panel.contains(target) || anchor.contains(target)) return;
      closePopover();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePopover();
    };
    const handleWindowChange = (): void => {
      updatePosition();
    };
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("resize", handleWindowChange);
    window.addEventListener("scroll", handleWindowChange, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("resize", handleWindowChange);
      window.removeEventListener("scroll", handleWindowChange, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [anchorRef, open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      data-commit-options-popover="true"
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        width: position.width,
        zIndex: 9999,
      }}
      className="rounded-[12px] border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] p-2.5 shadow-[0_18px_48px_rgba(15,23,42,0.16)]"
      >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[12px] font-apple-medium text-[var(--cf-text-primary)]">{gt("commitOptions.title", "提交高级选项")}</div>
          <div className="mt-0.5 text-[10px] leading-4 text-[var(--cf-text-secondary)]">
            {gt("commitOptions.description", "实时保存到当前提交流程。")}
          </div>
        </div>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            closePopover();
          }}
        >
          {gt("commitOptions.close", "关闭")}
        </Button>
      </div>

      <div className="mt-2.5 space-y-2.5">
        <label className="flex items-center gap-2 text-[11px] text-[var(--cf-text-primary)]">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-[var(--cf-accent)]"
            checked={value.signOff === true}
            onChange={(event) => {
              onChange(patchCommitAdvancedOptionsState(value, { signOff: event.target.checked }));
            }}
          />
          {gt("commitOptions.signOff", "提交后附加 Sign-off（`--signoff`）")}
        </label>
        {commitHooks?.available ? (
          <label className={cn(
            "flex items-center gap-2 text-[11px]",
            commitHooks.disabledByPolicy ? "text-[var(--cf-text-secondary)]" : "text-[var(--cf-text-primary)]",
          )}>
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[var(--cf-accent)]"
              checked={value.runHooks !== false}
              disabled={commitHooks.disabledByPolicy === true}
              onChange={(event) => {
                onChange(patchCommitAdvancedOptionsState(value, { runHooks: event.target.checked }));
              }}
            />
            {gt("commitOptions.runHooks", "运行 Git Hooks")}
          </label>
        ) : null}
        {commitHooks?.available && commitHooks.disabledByPolicy ? (
          <div className="text-[10px] leading-4 text-[var(--cf-text-secondary)]">
            {gt("commitOptions.runHooksDisabled", "当前已启用全局禁用策略，本次提交将自动追加 `--no-verify`。")}
          </div>
        ) : null}
        <label className="flex items-center gap-2 text-[11px] text-[var(--cf-text-primary)]">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-[var(--cf-accent)]"
            checked={value.cleanupMessage === true}
            onChange={(event) => {
              onChange(patchCommitAdvancedOptionsState(value, { cleanupMessage: event.target.checked }));
            }}
          />
          {gt("commitOptions.cleanupMessage", "清理提交消息注释与空行（`--cleanup=strip`）")}
        </label>
        <label className={cn(
          "flex items-center gap-2 text-[11px]",
          commitRenamesSeparatelyDisabled ? "text-[var(--cf-text-secondary)]" : "text-[var(--cf-text-primary)]",
        )}>
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-[var(--cf-accent)]"
            checked={value.commitRenamesSeparately === true}
            disabled={commitRenamesSeparatelyDisabled === true}
            onChange={(event) => {
              onChange(patchCommitAdvancedOptionsState(value, { commitRenamesSeparately: event.target.checked }));
            }}
          />
          {gt("commitOptions.commitRenamesSeparately", "将文件移动单独提交（提交前先拆出 rename/move 变更）")}
        </label>
        {commitRenamesSeparatelyHint ? (
          <div className="text-[10px] leading-4 text-[var(--cf-text-secondary)]">
            {commitRenamesSeparatelyHint}
          </div>
        ) : null}

        <div className="space-y-1">
          <div className="text-[11px] font-apple-medium text-[var(--cf-text-secondary)]">{gt("commitOptions.authorLabel", "作者")}</div>
          <Input
            className="h-7 text-[11px]"
            value={String(value.author || "")}
            placeholder={gt("commitOptions.authorPlaceholder", "姓名 <email@example.com>")}
            onChange={(event) => {
              onChange(patchCommitAdvancedOptionsState(value, { author: event.target.value }));
            }}
          />
          <div className="text-[10px] leading-4 text-[var(--cf-text-secondary)]">
            {gt("commitOptions.authorHint", "与 Git `--author` 一致，请输入完整作者签名。")}
          </div>
        </div>

        <div className="rounded-[10px] border border-dashed border-[var(--cf-border)] bg-[var(--cf-surface)]">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left"
            onClick={() => {
              setAuthorDateExpanded((prev) => !prev);
            }}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[11px] font-apple-medium text-[var(--cf-text-secondary)]">
                {authorDateExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {gt("commitOptions.authorDateLabel", "作者时间（可选，Git `--date`）")}
              </div>
              <div className="mt-0.5 truncate text-[10px] leading-4 text-[var(--cf-text-secondary)]">
                {sanitizedState.authorDate || gt("commitOptions.authorDateEmpty", "低频选项，日常提交通常留空")}
              </div>
            </div>
            <div className="shrink-0 text-[10px] text-[var(--cf-text-secondary)]">{gt("commitOptions.lowFrequencyBadge", "低频")}</div>
          </button>
          {authorDateExpanded ? (
            <div className="space-y-1 border-t border-[var(--cf-border)] px-2.5 py-2">
              <Input
                className={cn("h-7 text-[11px]", authorDateInvalid ? "border-[var(--cf-red)] focus-visible:ring-[var(--cf-red)]/30" : undefined)}
                value={String(value.authorDate || "")}
                placeholder={gt("commitOptions.authorDatePlaceholder", "例如：2026-03-12 21:11:00")}
                onChange={(event) => {
                  onChange(patchCommitAdvancedOptionsState(value, { authorDate: event.target.value }));
                }}
              />
              <div className={cn("text-[10px] leading-4", authorDateInvalid ? "text-[var(--cf-red)]" : "text-[var(--cf-text-secondary)]")}>
                {authorDateInvalid
                  ? gt("commitOptions.authorDateInvalid", "请输入有效时间，例如 2026-03-12 21:11:00。")
                  : gt("commitOptions.authorDateHint", "只修改 author date，不修改 committer date。通常只在保留原作者时间时填写。")}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--cf-border)] pt-2.5">
        <div className="text-[10px] leading-4 text-[var(--cf-text-secondary)]">
          {gt("commitOptions.payloadHint", "未填写的字段不会进入提交参数。")}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              onChange(createCommitAdvancedOptionsState({ runHooks: commitHooks?.runByDefault !== false }));
            }}
          >
            {gt("commitOptions.reset", "重置")}
          </Button>
          <Button
            size="xs"
            onClick={closePopover}
          >
            {gt("commitOptions.close", "关闭")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
