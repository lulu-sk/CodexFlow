// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from "react";
import { ArrowDown, ArrowUp, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GitBranchSyncBadgePresentation } from "./presentation";
import type { GitBranchSyncState } from "../types";

type BranchSyncStatusIconProps = {
  sync?: GitBranchSyncState;
  className?: string;
};

type BranchSyncBadgesProps = {
  incoming: GitBranchSyncBadgePresentation | null;
  outgoing: GitBranchSyncBadgePresentation | null;
  compact?: boolean;
  className?: string;
};

type BranchSyncGlyphKind = "incoming" | "outgoing" | "diverged" | "unfetched";

/**
 * 渲染当前分支入口的同步状态图标，参考上游“branch + incoming/outgoing 状态”的主视觉语义。
 */
export function BranchSyncStatusIcon(props: BranchSyncStatusIconProps): JSX.Element {
  const glyphKind = resolveBranchSyncGlyphKind(props.sync);
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center",
        glyphKind ? "gap-[1px]" : "justify-center",
        props.className,
      )}
      data-cf-branch-sync-cluster={glyphKind || "branch-only"}
    >
      <GitBranch className="h-3.5 w-3.5 text-[var(--cf-text-secondary)]" strokeWidth={1.9} />
      {glyphKind ? <BranchSyncGlyph kind={glyphKind} /> : null}
    </span>
  );
}

/**
 * 渲染 incoming / outgoing 标签，统一 `99+`、无数字 incoming 与颜色语义。
 */
export function BranchSyncBadges(props: BranchSyncBadgesProps): JSX.Element | null {
  const badges = [props.incoming, props.outgoing].filter(Boolean) as GitBranchSyncBadgePresentation[];
  if (badges.length <= 0) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", props.className)}>
      {badges.map((badge) => (
        <span
          key={`${badge.kind}:${badge.text || "icon"}`}
          className={cn(
            "inline-flex min-w-[18px] items-center justify-center gap-0.5 rounded-full border px-1 py-0 text-[10px] font-medium leading-4",
            badge.kind === "incoming"
              ? "border-[color:rgba(53,116,240,0.28)] bg-[color:rgba(53,116,240,0.12)] text-[#3574F0] dark:border-[color:rgba(84,138,247,0.34)] dark:bg-[color:rgba(84,138,247,0.14)] dark:text-[#87AEFF]"
              : "border-[color:rgba(54,150,80,0.28)] bg-[color:rgba(54,150,80,0.12)] text-[#369650] dark:border-[color:rgba(87,150,92,0.34)] dark:bg-[color:rgba(87,150,92,0.14)] dark:text-[#8CCF91]",
            props.compact ? "min-w-[16px] px-[5px]" : "",
          )}
          title={badge.tooltip}
        >
          {badge.kind === "incoming" ? <ArrowDown className="h-2.5 w-2.5" /> : <ArrowUp className="h-2.5 w-2.5" />}
          {badge.text ? <span>{badge.text}</span> : null}
        </span>
      ))}
    </span>
  );
}

/**
 * 根据同步状态选择顶栏入口的 companion glyph，贴近 IDEA 的分层 branch icon 语义。
 */
function resolveBranchSyncGlyphKind(sync?: GitBranchSyncState): BranchSyncGlyphKind | null {
  if (!sync || sync.gone || sync.status === "synced" || sync.status === "untracked")
    return null;
  if (sync.hasUnfetched && Math.max(0, Math.floor(Number(sync.outgoing) || 0)) > 0)
    return "diverged";
  if (sync.hasUnfetched)
    return "unfetched";
  if (sync.status === "diverged")
    return "diverged";
  if (sync.status === "incoming")
    return "incoming";
  return "outgoing";
}

/**
 * 渲染顶栏当前分支旁的同步状态 glyph，使用更粗更清楚的矢量笔画模拟 IDEA layered icon。
 */
function BranchSyncGlyph(props: { kind: BranchSyncGlyphKind }): JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      className="shrink-0 overflow-visible"
      aria-hidden="true"
      focusable="false"
      data-cf-sync-glyph={props.kind}
    >
      {props.kind === "incoming" ? (
        <BranchSyncStrokePath
          d="M5 1.4 V6.1 M3.2 4.3 L5 6.1 L6.8 4.3"
          className="text-[#3574F0] dark:text-[#87AEFF]"
        />
      ) : null}
      {props.kind === "outgoing" ? (
        <BranchSyncStrokePath
          d="M5 8.6 V3.1 M3.2 4.9 L5 3.1 L6.8 4.9"
          className="text-[#369650] dark:text-[#8CCF91]"
        />
      ) : null}
      {props.kind === "unfetched" ? (
        <>
          <BranchSyncStrokePath
            d="M5 1.4 V5.4 M3.2 3.6 L5 5.4 L6.8 3.6"
            className="text-[#3574F0] dark:text-[#87AEFF]"
          />
          <BranchSyncStrokePath
            d="M2.2 7.2 H7.8"
            className="text-[#3574F0] dark:text-[#87AEFF]"
          />
        </>
      ) : null}
      {props.kind === "diverged" ? (
        <>
          <BranchSyncStrokePath
            d="M2.8 8.4 V3.2 M1.4 4.6 L2.8 3.2 L4.2 4.6"
            className="text-[#369650] dark:text-[#8CCF91]"
          />
          <BranchSyncStrokePath
            d="M7.2 1.6 V6.8 M5.8 5.4 L7.2 6.8 L8.6 5.4"
            className="text-[#3574F0] dark:text-[#87AEFF]"
          />
        </>
      ) : null}
    </svg>
  );
}

/**
 * 用底色描边 + 主色描边的双层路径提高小尺寸状态 glyph 的可辨识度。
 */
function BranchSyncStrokePath(props: { d: string; className: string }): JSX.Element {
  return (
    <>
      <path
        d={props.d}
        stroke="var(--cf-surface-solid)"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d={props.d}
        className={props.className}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </>
  );
}
