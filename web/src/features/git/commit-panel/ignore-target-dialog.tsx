// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useEffect } from "react";
import { Loader2 } from "lucide-react";
import type { GitIgnoreTarget } from "../types";
import { resolveGitText } from "../git-i18n";

type IgnoreTargetDialogProps = {
  open: boolean;
  paths: string[];
  targets: GitIgnoreTarget[];
  repoRoot?: string;
  repoIndex?: number;
  repoCount?: number;
  applyingTargetId?: string;
  anchor?: { x: number; y: number };
  onOpenChange: (open: boolean) => void;
  onSelectTarget: (target: GitIgnoreTarget) => void;
};

/**
 * 根据投放位置推导 popup 坐标，并为边缘场景预留基本防溢出空间。
 */
function resolvePopupPosition(anchor?: { x: number; y: number }): React.CSSProperties {
  const x = Math.max(16, Math.floor(anchor?.x || 120));
  const y = Math.max(16, Math.floor(anchor?.y || 120));
  return {
    left: `min(${x}px, calc(100vw - 360px))`,
    top: `min(${y}px, calc(100vh - 220px))`,
  };
}

/**
 * 展示 ignored special node 投放后的 ignore 目标 popup，对齐 IDEA 的 action popup 语义。
 */
export function IgnoreTargetDialog(props: IgnoreTargetDialogProps): React.ReactElement | null {
  const { open, paths, targets, repoRoot, repoIndex, repoCount, applyingTargetId, anchor, onOpenChange, onSelectTarget } = props;
  const visiblePaths = paths.slice(0, 5);
  const hiddenCount = Math.max(0, paths.length - visiblePaths.length);
  const normalizedRepoRoot = String(repoRoot || "").trim();
  const showRepoProgress = Number(repoCount || 0) > 1;

  useEffect(() => {
    if (!open) return;
    const handleWindowMouseDown = (): void => {
      onOpenChange(false);
    };
    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("mousedown", handleWindowMouseDown);
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleWindowMouseDown);
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [onOpenChange, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90]"
      onMouseDown={() => {
        onOpenChange(false);
      }}
    >
      <div
        className="fixed z-[91] w-[320px] rounded-apple-md border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] shadow-apple-xl"
        style={resolvePopupPosition(anchor)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--cf-border)] px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-apple-medium text-[var(--cf-text-primary)]">{resolveGitText("commit.ignoreTarget.title", "忽略文件")}</div>
            {showRepoProgress ? (
              <div className="shrink-0 rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-2 py-0.5 text-[10px] text-[var(--cf-text-secondary)]">
                {resolveGitText("commit.ignoreTarget.repoProgress", "仓库 {{index}} / {{count}}", {
                  index: Math.max(1, Math.floor(Number(repoIndex || 1))),
                  count: Math.max(1, Math.floor(Number(repoCount || 1))),
                })}
              </div>
            ) : null}
          </div>
          <div className="mt-1 text-[11px] text-[var(--cf-text-secondary)]">
            {resolveGitText(
              "commit.ignoreTarget.description",
              "选择要写入的 ignore 目标。该 popup 只接收未跟踪文件投放，对齐 IDEA 的 ignored special node 语义。",
            )}
          </div>
          {normalizedRepoRoot ? (
            <div className="mt-2 truncate rounded-apple-sm border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-2 py-1 text-[10px] text-[var(--cf-text-secondary)]" title={normalizedRepoRoot}>
              {resolveGitText("commit.ignoreTarget.repoScope", "当前仓库：{{path}}", { path: normalizedRepoRoot })}
            </div>
          ) : null}
        </div>
        <div className="px-3 py-2 text-xs text-[var(--cf-text-secondary)]">
          <div>{resolveGitText("commit.ignoreTarget.count", "即将忽略 {{count}} 个文件：", { count: paths.length })}</div>
          <div className="mt-1 space-y-1 text-[var(--cf-text-primary)]">
            {visiblePaths.map((one) => (
              <div key={one} className="truncate" title={one}>{one}</div>
            ))}
            {hiddenCount > 0 ? <div>{resolveGitText("commit.ignoreTarget.hiddenCount", "还有 {{count}} 个文件未展开显示", { count: hiddenCount })}</div> : null}
          </div>
        </div>
        <div className="max-h-[240px] overflow-auto px-2 pb-2 cf-scroll-area">
          {targets.map((target) => {
            const applying = applyingTargetId === target.id;
            return (
              <button
                key={target.id}
                type="button"
                className="mt-1 flex w-full items-center justify-between rounded-apple-sm border border-[var(--cf-border)] px-3 py-2 text-left hover:bg-[var(--cf-surface-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!!applyingTargetId}
                onClick={() => {
                  onSelectTarget(target);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-[var(--cf-text-primary)]">{target.label}</span>
                  <span className="block truncate text-[11px] text-[var(--cf-text-secondary)]" title={target.description}>
                    {target.description}
                  </span>
                </span>
                {applying ? <Loader2 className="ml-3 h-4 w-4 shrink-0 animate-spin text-[var(--cf-text-secondary)]" /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
