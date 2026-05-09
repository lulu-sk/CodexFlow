// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronsUpDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  MoveHorizontal,
  RefreshCcw,
  Sparkles,
} from "lucide-react";
import { resolveGitTextWith } from "../git-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type {
  GitConflictMergeRevision,
  GitConflictMergeSnapshot,
  GitConflictMergeSourceKey,
} from "../types";
import { ConflictMergeThreeWayEditor } from "./conflict-merge-three-way-editor";
import {
  applyConflictMergeBlockResolution,
  applyConflictMergeBlockAutoResolution,
  applyConflictMergeNonConflictedChanges,
  applyResolvableConflictMergeBlocks,
  canResolveConflictMergeBlockAutomatically,
  countConflictMergeUnresolvedChanges,
  countConflictMergeUnresolvedConflicts,
  createConflictMergeViewerState,
  ignoreConflictMergeBlockSide,
  resolveConflictMergeAutoResolution,
  updateConflictMergeViewerResultText,
  type ConflictMergeAutoResolution,
  type ConflictMergeBlock,
  type ConflictMergeBlockResolution,
  type ConflictMergeLineRange,
  type ConflictMergeViewerState,
} from "./conflict-merge-model";

type ConflictMergeDialogProps = {
  open: boolean;
  loading: boolean;
  saving: boolean;
  snapshot: GitConflictMergeSnapshot | null;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => void;
  onResolve: (resultText: string) => void;
  onResolveWithSource?: (source: "ours" | "theirs") => void;
  onOpenInIde?: () => void;
  onOpenInSystem?: () => void;
};

type ConflictMergeScrollRequest = {
  blockIndex: number;
  force: boolean;
};

type GitTranslate = (key: string, fallback: string, values?: Record<string, unknown>) => string;

/**
 * 判断当前冲突来源是否可以直接按文本参与应用内比对，避免 binary/过大文件把编辑区渲染坏掉。
 */
function canRenderConflictRevision(revision: GitConflictMergeRevision | null | undefined): boolean {
  return !!revision?.available && !revision.isBinary && !revision.tooLarge;
}

/**
 * 把来源状态转换为用户可读提示，统一复用到来源面板与预览卡片。
 */
function resolveConflictRevisionFallbackText(
  revision: GitConflictMergeRevision | null | undefined,
  gt?: GitTranslate,
): string {
  if (!revision) return gt ? gt("dialogs.conflictMerge.fallbacks.sourceUnavailable", "当前来源不可用。") : "当前来源不可用。";
  if (revision.isBinary) return gt ? gt("dialogs.conflictMerge.fallbacks.binary", "二进制内容暂不支持应用内预览。") : "二进制内容暂不支持应用内预览。";
  if (revision.tooLarge) return gt ? gt("dialogs.conflictMerge.fallbacks.tooLarge", "文件过大，暂不支持应用内预览。") : "文件过大，暂不支持应用内预览。";
  if (!revision.available) return gt ? gt("dialogs.conflictMerge.fallbacks.sourceUnavailable", "当前来源不可用。") : "当前来源不可用。";
  return gt ? gt("dialogs.conflictMerge.fallbacks.empty", "当前来源内容为空。") : "当前来源内容为空。";
}

/**
 * 根据文件后缀推断 Monaco 语言类型，提升冲突合并时的基本语法高亮体验。
 */
function resolveConflictMergeLanguage(pathText: string): string {
  const cleanPath = String(pathText || "").trim().toLowerCase();
  if (cleanPath.endsWith(".ts") || cleanPath.endsWith(".tsx")) return "typescript";
  if (cleanPath.endsWith(".js") || cleanPath.endsWith(".jsx") || cleanPath.endsWith(".mjs") || cleanPath.endsWith(".cjs")) return "javascript";
  if (cleanPath.endsWith(".json")) return "json";
  if (cleanPath.endsWith(".css")) return "css";
  if (cleanPath.endsWith(".html") || cleanPath.endsWith(".htm")) return "html";
  if (cleanPath.endsWith(".md")) return "markdown";
  if (cleanPath.endsWith(".java")) return "java";
  if (cleanPath.endsWith(".kt") || cleanPath.endsWith(".kts")) return "kotlin";
  if (cleanPath.endsWith(".cs")) return "csharp";
  if (cleanPath.endsWith(".go")) return "go";
  if (cleanPath.endsWith(".py")) return "python";
  if (cleanPath.endsWith(".xml") || cleanPath.endsWith(".svg")) return "xml";
  if (cleanPath.endsWith(".yml") || cleanPath.endsWith(".yaml")) return "yaml";
  if (cleanPath.endsWith(".sh") || cleanPath.endsWith(".bash")) return "shell";
  return "plaintext";
}

/**
 * 把 sourceView 映射为三栏编辑器的聚焦列。
 */
function resolveConflictMergeFocusedPane(
  sourceView: GitConflictMergeSourceKey,
): "left" | "result" | "right" | null {
  if (sourceView === "ours") return "left";
  if (sourceView === "theirs") return "right";
  if (sourceView === "working") return "result";
  return null;
}

/**
 * 把当前聚焦来源翻译成用户可读标题，供顶部上下文条与当前块摘要区复用。
 */
function resolveConflictMergeFocusLabel(
  sourceView: GitConflictMergeSourceKey,
  snapshot: GitConflictMergeSnapshot | null,
  gt?: GitTranslate,
): string {
  if (sourceView === "base") return snapshot?.base.label || (gt ? gt("dialogs.conflictMerge.sources.base", "基线") : "基线");
  if (sourceView === "ours") return snapshot?.ours.label || (gt ? gt("dialogs.conflictMerge.sources.ours", "左侧来源") : "左侧来源");
  if (sourceView === "theirs") return snapshot?.theirs.label || (gt ? gt("dialogs.conflictMerge.sources.theirs", "右侧来源") : "右侧来源");
  return gt ? gt("dialogs.conflictMerge.sources.result", "结果") : "结果";
}

/**
 * 把来源高亮范围格式化为紧凑文案，供右侧 inspector 复用。
 */
function formatConflictMergeRangeText(range: ConflictMergeLineRange | null, gt?: GitTranslate): string {
  return range ? `L${range.startLine}-${range.endLine}` : (gt ? gt("dialogs.conflictMerge.rangeUnavailable", "无法定位") : "无法定位");
}

/**
 * 构造顶部状态提示，帮助用户理解当前还剩多少块和多少真正冲突没有处理。
 */
function buildConflictMergeResolveHint(args: {
  unresolvedChanges: number;
  unresolvedConflicts: number;
}, gt?: GitTranslate): string {
  if (args.unresolvedChanges <= 0) return gt ? gt("dialogs.conflictMerge.hints.allResolved", "所有变更块都已处理，可直接应用当前结果。") : "所有变更块都已处理，可直接应用当前结果。";
  if (args.unresolvedConflicts <= 0) {
    return gt
      ? gt("dialogs.conflictMerge.hints.unresolvedChangesOnly", "当前仍有 {{count}} 个变更块未处理，但其中不包含真正冲突。", {
        count: args.unresolvedChanges,
      })
      : `当前仍有 ${args.unresolvedChanges} 个变更块未处理，但其中不包含真正冲突。`;
  }
  return gt
    ? gt("dialogs.conflictMerge.hints.unresolvedConflicts", "当前仍有 {{changes}} 个未处理块，其中 {{conflicts}} 个为冲突。", {
      changes: args.unresolvedChanges,
      conflicts: args.unresolvedConflicts,
    })
    : `当前仍有 ${args.unresolvedChanges} 个未处理块，其中 ${args.unresolvedConflicts} 个为冲突。`;
}

/**
 * 构造“应用”前的确认提示，贴近 IDEA 对“部分解决仍可继续应用”的收口语义。
 */
function buildConflictMergeResolvePromptMessage(args: {
  unresolvedChanges: number;
  unresolvedConflicts: number;
}, gt?: GitTranslate): string {
  return gt
    ? gt("dialogs.conflictMerge.prompts.resolveWithPending", "当前仍有 {{changes}} 个未处理块，其中 {{conflicts}} 个是冲突。继续应用会按当前结果写回文件并执行 git add，是否继续？", {
      changes: args.unresolvedChanges,
      conflicts: args.unresolvedConflicts,
    })
    : `当前仍有 ${args.unresolvedChanges} 个未处理块，其中 ${args.unresolvedConflicts} 个是冲突。继续应用会按当前结果写回文件并执行 git add，是否继续？`;
}

/**
 * 构造“接受左侧/接受右侧”前的确认提示，避免用户误把当前结果覆盖掉。
 */
function buildConflictMergeAcceptSourcePromptMessage(label: string, gt?: GitTranslate): string {
  const cleanLabel = String(label || "").trim();
  if (cleanLabel) {
    return gt
      ? gt("dialogs.conflictMerge.prompts.acceptSourceWithLabel", "当前结果已经修改。继续将直接整份采用{{label}}并关闭合并器，是否继续？", { label: cleanLabel })
      : `当前结果已经修改。继续将直接整份采用${cleanLabel}并关闭合并器，是否继续？`;
  }
  return gt ? gt("dialogs.conflictMerge.prompts.acceptSource", "当前结果已经修改。继续将直接整份采用该侧内容并关闭合并器，是否继续？") : "当前结果已经修改。继续将直接整份采用该侧内容并关闭合并器，是否继续？";
}

/**
 * 把当前未处理更改/冲突数量格式化成接近 IDEA 顶部状态栏的摘要文案。
 */
function buildConflictMergeChangeSummaryText(args: {
  unresolvedChanges: number;
  unresolvedConflicts: number;
}, gt?: GitTranslate): string {
  if (args.unresolvedChanges <= 0) return gt ? gt("dialogs.conflictMerge.summary.noChanges", "没有未处理的更改。") : "没有未处理的更改。";
  if (args.unresolvedConflicts <= 0) {
    return gt
      ? gt("dialogs.conflictMerge.summary.changesOnly", "{{changes}} 个更改。没有冲突。", { changes: args.unresolvedChanges })
      : `${args.unresolvedChanges} 个更改。没有冲突。`;
  }
  return gt
    ? gt("dialogs.conflictMerge.summary.withConflicts", "{{changes}} 个更改。{{conflicts}} 个冲突。", {
      changes: args.unresolvedChanges,
      conflicts: args.unresolvedConflicts,
    })
    : `${args.unresolvedChanges} 个更改。${args.unresolvedConflicts} 个冲突。`;
}

/**
 * 解析下一块或上一块的块索引；列表为空时返回 -1。
 */
function resolveNextConflictMergeBlockIndex(
  currentIndex: number,
  blocks: ConflictMergeBlock[],
  direction: "previous" | "next",
): number {
  if (blocks.length <= 0) return -1;
  const currentPosition = blocks.findIndex((block) => block.index === currentIndex);
  if (currentPosition < 0) {
    return direction === "previous" ? blocks[blocks.length - 1].index : blocks[0].index;
  }
  if (direction === "previous") {
    return blocks[(currentPosition - 1 + blocks.length) % blocks.length].index;
  }
  return blocks[(currentPosition + 1) % blocks.length].index;
}

/**
 * 在一批块被处理后，优先把焦点移动到原块之后的下一个未解决块；若不存在则回退到首个未解决块。
 */
function resolveNextUnresolvedConflictMergeBlockIndex(
  currentIndex: number,
  blocks: ConflictMergeBlock[],
): number {
  if (blocks.length <= 0) return -1;
  const currentPosition = blocks.findIndex((block) => block.index === currentIndex);
  if (currentPosition < 0) return blocks[0].index;
  for (let index = currentPosition; index < blocks.length; index += 1) {
    if (blocks[index]) return blocks[index].index;
  }
  return blocks[0].index;
}

/**
 * 生成批量应用某一侧不冲突更改的文案，避免与块级动作和整份动作重名。
 */
function buildApplyNonConflictedChangesLabel(label: string, gt?: GitTranslate): string {
  const cleanLabel = String(label || "").trim();
  return cleanLabel
    ? (gt ? gt("dialogs.conflictMerge.actions.applyNonConflictedWithLabel", "应用{{label}}中的不冲突更改", { label: cleanLabel }) : `应用${cleanLabel}中的不冲突更改`)
    : (gt ? gt("dialogs.conflictMerge.actions.applyNonConflicted", "应用该侧中的不冲突更改") : "应用该侧中的不冲突更改");
}

/**
 * 生成块级采用动作文案，明确只会影响当前选中的块。
 */
function buildApplyCurrentBlockLabel(label: string, gt?: GitTranslate): string {
  const cleanLabel = String(label || "").trim();
  return cleanLabel
    ? (gt ? gt("dialogs.conflictMerge.actions.applyCurrentBlockWithLabel", "当前块采用{{label}}", { label: cleanLabel }) : `当前块采用${cleanLabel}`)
    : (gt ? gt("dialogs.conflictMerge.actions.applyCurrentBlock", "当前块采用该侧内容") : "当前块采用该侧内容");
}

/**
 * 生成整份采用动作文案，明确会直接用某一侧完整内容覆盖结果文件。
 */
function buildResolveWithSourceLabel(label: string, gt?: GitTranslate): string {
  const cleanLabel = String(label || "").trim();
  return cleanLabel
    ? (gt ? gt("dialogs.conflictMerge.actions.resolveWithSourceWithLabel", "整份采用{{label}}", { label: cleanLabel }) : `整份采用${cleanLabel}`)
    : (gt ? gt("dialogs.conflictMerge.actions.resolveWithSource", "整份采用该侧内容") : "整份采用该侧内容");
}

/**
 * 把自动解决动作的实际决议结果翻译成短文案，供工具条和提示条复用。
 */
function resolveAutoResolutionLabel(
  resolution: ConflictMergeBlockResolution | "auto" | null,
  snapshot: GitConflictMergeSnapshot | null,
  gt?: GitTranslate,
): string {
  if (!resolution) return gt ? gt("dialogs.conflictMerge.autoResolution.unavailable", "无法自动解决") : "无法自动解决";
  if (resolution === "base") return gt ? gt("dialogs.conflictMerge.autoResolution.base", "恢复为基线") : "恢复为基线";
  if (resolution === "ours") {
    return snapshot?.ours.label
      ? (gt ? gt("dialogs.conflictMerge.autoResolution.withLabel", "采用{{label}}", { label: snapshot.ours.label }) : `采用${snapshot.ours.label}`)
      : (gt ? gt("dialogs.conflictMerge.autoResolution.ours", "采用左侧内容") : "采用左侧内容");
  }
  if (resolution === "theirs") {
    return snapshot?.theirs.label
      ? (gt ? gt("dialogs.conflictMerge.autoResolution.withLabel", "采用{{label}}", { label: snapshot.theirs.label }) : `采用${snapshot.theirs.label}`)
      : (gt ? gt("dialogs.conflictMerge.autoResolution.theirs", "采用右侧内容") : "采用右侧内容");
  }
  if (resolution === "auto") return gt ? gt("dialogs.conflictMerge.autoResolution.auto", "自动合并两边可兼容的修改") : "自动合并两边可兼容的修改";
  return gt ? gt("dialogs.conflictMerge.autoResolution.both", "同时保留两侧修改") : "同时保留两侧修改";
}

/**
 * 为右侧 inspector 生成当前块说明，帮助用户理解自动处理建议与手工编辑状态。
 */
function buildConflictMergeSelectedBlockHint(args: {
  block: ConflictMergeBlock | null;
  autoResolution: ConflictMergeAutoResolution | null;
  snapshot: GitConflictMergeSnapshot | null;
}, gt?: GitTranslate): string {
  if (!args.block) return gt ? gt("dialogs.conflictMerge.selectedBlockHint.none", "当前没有待处理块。你仍可检查结果列，确认无误后点击“应用”。") : "当前没有待处理块。你仍可检查结果列，确认无误后点击“应用”。";
  if (args.block.modified) return gt ? gt("dialogs.conflictMerge.selectedBlockHint.modified", "当前块已经被手工编辑。为避免覆盖你的手工结果，自动处理会停用。") : "当前块已经被手工编辑。为避免覆盖你的手工结果，自动处理会停用。";
  if (args.block.onesideApplied) return gt ? gt("dialogs.conflictMerge.selectedBlockHint.oneSideApplied", "当前块已经先采用了一侧。你还可以补上另一侧、恢复为基线，或保留两侧内容。") : "当前块已经先采用了一侧。你还可以补上另一侧、恢复为基线，或保留两侧内容。";
  if (args.autoResolution) {
    return gt
      ? gt("dialogs.conflictMerge.selectedBlockHint.auto", "建议结果：{{label}}。", {
        label: resolveAutoResolutionLabel(args.autoResolution, args.snapshot, gt),
      })
      : `建议结果：${resolveAutoResolutionLabel(args.autoResolution, args.snapshot)}。`;
  }
  return gt ? gt("dialogs.conflictMerge.selectedBlockHint.manual", "这个块需要你手工比较左右两侧后再决定。") : "这个块需要你手工比较左右两侧后再决定。";
}

/**
 * 解释“基线”的含义，并说明恢复为基线会对当前块产生什么效果。
 */
function buildConflictMergeBaseDescription(block: ConflictMergeBlock | null, gt?: GitTranslate): string {
  if (!block) return gt ? gt("dialogs.conflictMerge.baseDescription.default", "基线 = 你和对方开始各自修改前的共同原文。") : "基线 = 你和对方开始各自修改前的共同原文。";
  if (!block.hasBase) return gt ? gt("dialogs.conflictMerge.baseDescription.missing", "当前块没有基线，通常表示双方都在这里新增了内容，或共同原文在这里是空的。") : "当前块没有基线，通常表示双方都在这里新增了内容，或共同原文在这里是空的。";
  return gt ? gt("dialogs.conflictMerge.baseDescription.withBase", "基线 = 你和对方开始各自修改前的共同原文。恢复为基线，就是把当前块还原成那份共同原文。") : "基线 = 你和对方开始各自修改前的共同原文。恢复为基线，就是把当前块还原成那份共同原文。";
}

/**
 * 读取指定来源的快照对象，统一封装索引访问与空快照兜底。
 */
function getConflictRevision(
  snapshot: GitConflictMergeSnapshot | null,
  source: "base" | "ours" | "theirs",
): GitConflictMergeRevision | null {
  if (!snapshot) return null;
  return snapshot[source];
}

/**
 * 应用内冲突处理对话框，按接近 IDEA `TextMergeViewer` 的方式展示三栏来源、结果与块级处理入口。
 */
export function ConflictMergeDialog(props: ConflictMergeDialogProps): React.ReactElement {
  const { t } = useTranslation(["git", "common"]);
  const gt: GitTranslate = (key, fallback, values) => {
    return resolveGitTextWith(t, key, fallback, values);
  };
  const [viewerState, setViewerState] = useState<ConflictMergeViewerState | null>(null);
  const [sourceView, setSourceView] = useState<GitConflictMergeSourceKey>("working");
  const [collapseUnchanged, setCollapseUnchanged] = useState<boolean>(true);
  const [selectedBlockIndex, setSelectedBlockIndex] = useState<number>(0);
  const [scrollRequest, setScrollRequest] = useState<ConflictMergeScrollRequest | null>(null);

  const oursRevision = useMemo(() => getConflictRevision(props.snapshot, "ours"), [props.snapshot]);
  const theirsRevision = useMemo(() => getConflictRevision(props.snapshot, "theirs"), [props.snapshot]);
  const needsExternalFallback = useMemo(() => {
    return !canRenderConflictRevision(oursRevision) || !canRenderConflictRevision(theirsRevision);
  }, [oursRevision, theirsRevision]);
  const language = useMemo(() => resolveConflictMergeLanguage(props.snapshot?.path || ""), [props.snapshot?.path]);
  const oursLabel = props.snapshot?.ours.label || gt("dialogs.conflictMerge.sources.ours", "左侧来源");
  const theirsLabel = props.snapshot?.theirs.label || gt("dialogs.conflictMerge.sources.theirs", "右侧来源");
  const baseLabel = props.snapshot?.base.label || gt("dialogs.conflictMerge.sources.base", "基线");
  const resultLabel = gt("dialogs.conflictMerge.sources.result", "结果");

  useEffect(() => {
    if (!props.open || !props.snapshot) {
      setViewerState(null);
      setSourceView("working");
      setCollapseUnchanged(true);
      setSelectedBlockIndex(0);
      setScrollRequest(null);
      return;
    }
    let cancelled = false;
    const timer = globalThis.setTimeout(() => {
      if (cancelled) return;
      React.startTransition(() => {
        if (cancelled) return;
        setViewerState(createConflictMergeViewerState(props.snapshot as GitConflictMergeSnapshot));
      });
    }, 0);
    setViewerState(null);
    setSourceView("working");
    setCollapseUnchanged(true);
    setSelectedBlockIndex(0);
    setScrollRequest(null);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timer);
    };
  }, [props.open, props.snapshot]);

  const unresolvedBlocks = useMemo(() => {
    return viewerState?.blocks.filter((block) => !block.resolved) || [];
  }, [viewerState]);
  const unresolvedChangesCount = useMemo(() => {
    return viewerState ? countConflictMergeUnresolvedChanges(viewerState) : 0;
  }, [viewerState]);
  const unresolvedConflictsCount = useMemo(() => {
    return viewerState ? countConflictMergeUnresolvedConflicts(viewerState) : 0;
  }, [viewerState]);
  const autoResolvableBlockCount = useMemo(() => {
    return viewerState?.blocks.filter((block) => canResolveConflictMergeBlockAutomatically(block)).length || 0;
  }, [viewerState]);
  const selectedBlock = useMemo<ConflictMergeBlock | null>(() => {
    if (unresolvedBlocks.length <= 0) return null;
    return unresolvedBlocks.find((block) => block.index === selectedBlockIndex) || unresolvedBlocks[0] || null;
  }, [selectedBlockIndex, unresolvedBlocks]);
  const focusedPane = useMemo(
    () => resolveConflictMergeFocusedPane(sourceView),
    [sourceView],
  );
  const resolveHint = useMemo(
    () => buildConflictMergeResolveHint({
      unresolvedChanges: unresolvedChangesCount,
      unresolvedConflicts: unresolvedConflictsCount,
    }, gt),
    [gt, unresolvedChangesCount, unresolvedConflictsCount],
  );
  const changeSummaryText = useMemo(
    () => buildConflictMergeChangeSummaryText({
      unresolvedChanges: unresolvedChangesCount,
      unresolvedConflicts: unresolvedConflictsCount,
    }, gt),
    [gt, unresolvedChangesCount, unresolvedConflictsCount],
  );
  const selectedAutoResolution = useMemo(
    () => selectedBlock ? resolveConflictMergeAutoResolution(selectedBlock) : null,
    [selectedBlock],
  );

  useEffect(() => {
    if (unresolvedBlocks.length <= 0) {
      if (selectedBlockIndex !== 0) setSelectedBlockIndex(0);
      return;
    }
    if (!unresolvedBlocks.some((block) => block.index === selectedBlockIndex)) {
      setSelectedBlockIndex(unresolvedBlocks[0].index);
    }
  }, [selectedBlockIndex, unresolvedBlocks]);

  /**
   * 统一更新 merge viewer 状态，避免在 saving/loading 中继续写入局部修改。
   */
  const updateViewerState = React.useCallback((producer: (state: ConflictMergeViewerState) => ConflictMergeViewerState): void => {
    setViewerState((prev) => {
      if (!prev || props.loading || props.saving) return prev;
      return producer(prev);
    });
  }, [props.loading, props.saving]);

  /**
   * 记录一次强制滚动请求，供 three-way editor 在批量处理后把下一个未解决块居中展示。
   */
  const requestConflictMergeScroll = React.useCallback((blockIndex: number | null, force = true): void => {
    if (typeof blockIndex !== "number" || blockIndex < 0) {
      setScrollRequest(null);
      return;
    }
    setScrollRequest({
      blockIndex,
      force,
    });
  }, []);

  /**
   * 对当前块执行快速采用动作，供 inspector 与中缝箭头共同复用。
   */
  const handleApplyBlockResolution = React.useCallback((resolution: ConflictMergeBlockResolution, blockIndex?: number): void => {
    if (!viewerState) return;
    const targetIndex = typeof blockIndex === "number" ? blockIndex : selectedBlock?.index;
    if (typeof targetIndex !== "number") return;
    updateViewerState((prev) => applyConflictMergeBlockResolution(prev, targetIndex, resolution));
  }, [selectedBlock?.index, updateViewerState, viewerState]);

  /**
   * 忽略指定侧的更改，供中缝 `x` 按钮与 inspector 的辅助动作复用。
   */
  const handleIgnoreBlockSide = React.useCallback((side: "ours" | "theirs", blockIndex?: number): void => {
    if (!viewerState) return;
    const targetIndex = typeof blockIndex === "number" ? blockIndex : selectedBlock?.index;
    if (typeof targetIndex !== "number") return;
    updateViewerState((prev) => ignoreConflictMergeBlockSide(prev, targetIndex, side));
  }, [selectedBlock?.index, updateViewerState, viewerState]);

  /**
   * 批量应用不冲突更改，完整覆盖 IDEA 菜单中的左侧/所有/右侧三种语义。
   */
  const handleApplyNonConflictedChanges = React.useCallback((target: "ours" | "all" | "theirs"): void => {
    setViewerState((prev) => {
      if (!prev || props.loading || props.saving) return prev;
      const currentIndex = selectedBlock?.index ?? selectedBlockIndex;
      const nextState = applyConflictMergeNonConflictedChanges(prev, target).state;
      const nextPending = nextState.blocks.filter((block) => !block.resolved);
      const nextBlockIndex = resolveNextUnresolvedConflictMergeBlockIndex(currentIndex, nextPending);
      setSelectedBlockIndex(nextBlockIndex);
      requestConflictMergeScroll(nextBlockIndex);
      return nextState;
    });
  }, [props.loading, props.saving, requestConflictMergeScroll, selectedBlock?.index, selectedBlockIndex]);

  /**
   * 批量自动处理简单块，对齐 IDEA merge viewer 的 `Resolve simple conflicts` 入口会同时吞掉可直接应用的普通更改。
   */
  const handleAutoResolveSimpleConflicts = React.useCallback((): void => {
    setViewerState((prev) => {
      if (!prev || props.loading || props.saving) return prev;
      const currentIndex = selectedBlock?.index ?? selectedBlockIndex;
      const nextState = applyResolvableConflictMergeBlocks(prev).state;
      const nextPending = nextState.blocks.filter((block) => !block.resolved);
      const nextBlockIndex = resolveNextUnresolvedConflictMergeBlockIndex(currentIndex, nextPending);
      setSelectedBlockIndex(nextBlockIndex);
      requestConflictMergeScroll(nextBlockIndex);
      return nextState;
    });
  }, [props.loading, props.saving, requestConflictMergeScroll, selectedBlock?.index, selectedBlockIndex]);

  /**
   * 同步右侧最终结果区文本，并按最小影响范围更新块坐标与 modified 状态。
   */
  const handleResultTextChange = React.useCallback((value: string): void => {
    updateViewerState((prev) => updateConflictMergeViewerResultText(prev, value));
  }, [updateViewerState]);

  /**
   * 按方向切换当前聚焦的块，提升多块冲突时的连续处理效率。
   */
  const navigateConflictBlock = React.useCallback((direction: "previous" | "next"): void => {
    setSelectedBlockIndex((prev) => resolveNextConflictMergeBlockIndex(prev, unresolvedBlocks, direction));
  }, [unresolvedBlocks]);

  /**
   * 执行最终应用动作；若仍有未处理块，则先给出一次接近 IDEA 的部分解决确认。
   */
  const handleResolve = React.useCallback((): void => {
    if (!viewerState || props.loading || props.saving) return;
    if (unresolvedChangesCount > 0) {
      const confirmed = typeof window === "undefined" || typeof window.confirm !== "function"
        ? true
        : window.confirm(buildConflictMergeResolvePromptMessage({
          unresolvedChanges: unresolvedChangesCount,
          unresolvedConflicts: unresolvedConflictsCount,
        }, gt));
      if (!confirmed) return;
    }
    props.onResolve(viewerState.resultText);
  }, [props, unresolvedChangesCount, unresolvedConflictsCount, viewerState]);

  /**
   * 执行底部“接受左侧/接受右侧”动作；若结果区已编辑，则先确认是否直接丢弃当前结果。
   */
  const handleResolveWithSource = React.useCallback((source: "ours" | "theirs"): void => {
    if (!viewerState || props.loading || props.saving) return;
    if (viewerState.resultText !== viewerState.initialResultText) {
      const label = source === "ours"
        ? (props.snapshot?.ours.label || gt("dialogs.conflictMerge.sources.oursShort", "左侧"))
        : (props.snapshot?.theirs.label || gt("dialogs.conflictMerge.sources.theirsShort", "右侧"));
      const confirmed = typeof window === "undefined" || typeof window.confirm !== "function"
        ? true
        : window.confirm(buildConflictMergeAcceptSourcePromptMessage(label, gt));
      if (!confirmed) return;
    }
    props.onResolveWithSource?.(source);
    if (!props.onResolveWithSource) {
      const text = source === "ours" ? String(props.snapshot?.ours.text || "") : String(props.snapshot?.theirs.text || "");
      props.onResolve(text);
    }
  }, [gt, props, viewerState]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="cf-git-dialog-panel h-[min(94vh,940px)] max-h-[calc(100vh-16px)] w-[min(1820px,calc(100vw-16px))] max-w-[1820px] overflow-hidden p-0">
        <div className="flex h-full min-h-0 flex-col bg-[var(--cf-git-panel)]">
          <DialogHeader className="cf-git-header-surface mb-0 shrink-0 border-b border-[var(--cf-git-panel-line)] px-4 py-2.5">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-sm font-semibold">{gt("dialogs.conflictMerge.title", "合并")}</DialogTitle>
                <DialogDescription className="mt-0.5 min-w-0 truncate text-[11px] leading-5">
                  {props.snapshot?.path || gt("dialogs.conflictMerge.loadingPath", "正在读取冲突文件…")}
                </DialogDescription>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-[11px] text-[var(--cf-text-secondary)]">
                {autoResolvableBlockCount > 0 ? (
                  <Badge variant="outline" className="text-[10px] tabular-nums">
                    {gt("dialogs.conflictMerge.autoResolvableCount", "{{count}} 个块可自动处理", { count: autoResolvableBlockCount })}
                  </Badge>
                ) : null}
                {props.snapshot ? <span className="tabular-nums">{changeSummaryText}</span> : null}
              </div>
            </div>
          </DialogHeader>

          <div className="cf-git-toolbar-surface shrink-0 overflow-x-auto border-b border-[var(--cf-git-panel-line)]">
            <div className="inline-flex w-full min-w-max items-center gap-2 px-4 py-2 text-[11px]" data-testid="conflict-merge-toolbar-row">
              <div className="flex items-center gap-1.5">
                <span className="cf-git-merge-toolbar-group-label">{gt("dialogs.conflictMerge.toolbar.applyNonConflicted", "应用不冲突的更改:")}</span>
                <button
                  type="button"
                  className="cf-git-merge-toolbar-icon-action"
                  disabled={!viewerState || props.loading || props.saving || unresolvedBlocks.length <= 0}
                  onClick={() => handleApplyNonConflictedChanges("ours")}
                  data-testid="conflict-apply-non-conflicts-ours"
                  aria-label={buildApplyNonConflictedChangesLabel(props.snapshot?.ours.label || gt("dialogs.conflictMerge.sources.oursShort", "左侧"), gt)}
                  title={buildApplyNonConflictedChangesLabel(props.snapshot?.ours.label || gt("dialogs.conflictMerge.sources.oursShort", "左侧"), gt)}
                >
                  <ChevronsRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="cf-git-merge-toolbar-icon-action"
                  disabled={!viewerState || props.loading || props.saving || unresolvedBlocks.length <= 0}
                  onClick={() => handleApplyNonConflictedChanges("all")}
                  data-testid="conflict-apply-non-conflicts-all"
                  aria-label={gt("dialogs.conflictMerge.actions.applyAllNonConflicted", "应用所有不冲突的更改")}
                  title={gt("dialogs.conflictMerge.actions.applyAllNonConflicted", "应用所有不冲突的更改")}
                >
                  <MoveHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="cf-git-merge-toolbar-icon-action"
                  disabled={!viewerState || props.loading || props.saving || unresolvedBlocks.length <= 0}
                  onClick={() => handleApplyNonConflictedChanges("theirs")}
                  data-testid="conflict-apply-non-conflicts-theirs"
                  aria-label={buildApplyNonConflictedChangesLabel(props.snapshot?.theirs.label || gt("dialogs.conflictMerge.sources.theirsShort", "右侧"), gt)}
                  title={buildApplyNonConflictedChangesLabel(props.snapshot?.theirs.label || gt("dialogs.conflictMerge.sources.theirsShort", "右侧"), gt)}
                >
                  <ChevronsLeft className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>

              <span className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-git-panel-line)]" aria-hidden="true" />

              <Button
                size="xs"
                variant="ghost"
                className={cn(
                  "cf-git-merge-toolbar-toggle",
                  collapseUnchanged ? "cf-git-merge-toolbar-toggle-active" : "",
                )}
                disabled={!viewerState || props.loading || props.saving}
                onClick={() => setCollapseUnchanged((prev) => !prev)}
                data-testid="conflict-collapse-unchanged"
                aria-label={gt("dialogs.conflictMerge.toolbar.collapseUnchanged", "收起未更改的片段")}
                aria-pressed={collapseUnchanged}
                title={gt("dialogs.conflictMerge.toolbar.collapseUnchanged", "收起未更改的片段")}
              >
                <ChevronsUpDown className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                {gt("dialogs.conflictMerge.toolbar.collapseUnchanged", "收起未更改的片段")}
              </Button>

              <Button
                size="icon-sm"
                variant="ghost"
                className={cn(
                  "cf-git-merge-toolbar-icon-action",
                  autoResolvableBlockCount > 0 ? "cf-git-merge-toolbar-magic-action" : "",
                )}
                disabled={!viewerState || props.loading || props.saving || autoResolvableBlockCount <= 0}
                onClick={handleAutoResolveSimpleConflicts}
                data-testid="conflict-auto-resolve-toolbar"
                aria-label={gt("dialogs.conflictMerge.toolbar.autoResolveSimple", "解决简单的冲突")}
                title={gt("dialogs.conflictMerge.toolbar.autoResolveSimple", "解决简单的冲突")}
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>

              <span className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-git-panel-line)]" aria-hidden="true" />

              <Button
                size="xs"
                variant="secondary"
                onClick={() => navigateConflictBlock("previous")}
                disabled={unresolvedBlocks.length <= 0 || props.loading || props.saving}
              >
                <ChevronLeft className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                {gt("dialogs.conflictMerge.toolbar.previous", "上一个更改")}
              </Button>
              <Button
                size="xs"
                variant="secondary"
                onClick={() => navigateConflictBlock("next")}
                disabled={unresolvedBlocks.length <= 0 || props.loading || props.saving}
              >
                <ChevronRight className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                {gt("dialogs.conflictMerge.toolbar.next", "下一个更改")}
              </Button>
              <span className="tabular-nums text-[var(--cf-text-secondary)]">
                {unresolvedBlocks.length > 0
                  ? `${Math.max(1, unresolvedBlocks.findIndex((block) => block.index === selectedBlock?.index) + 1)} / ${unresolvedBlocks.length}`
                  : "0 / 0"}
              </span>

              <Button
                size="xs"
                variant="secondary"
                onClick={props.onRefresh}
                disabled={props.loading || props.saving}
                data-testid="conflict-refresh"
              >
                <RefreshCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                {gt("dialogs.conflictMerge.toolbar.reload", "重新读取")}
              </Button>
              {needsExternalFallback && props.onOpenInIde ? (
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={props.onOpenInIde}
                  disabled={props.loading || props.saving}
                >
                  <ExternalLink className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  {gt("dialogs.multipleFileMerge.buttons.openInIde", "在外部 IDE 中打开")}
                </Button>
              ) : null}
              {needsExternalFallback && props.onOpenInSystem ? (
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={props.onOpenInSystem}
                  disabled={props.loading || props.saving}
                >
                  <ExternalLink className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  {gt("dialogs.multipleFileMerge.buttons.openInSystem", "使用系统程序打开")}
                </Button>
              ) : null}

              <span className="min-w-0 flex-1 truncate text-right text-[var(--cf-text-secondary)]">
                {selectedBlock
                  ? selectedAutoResolution
                    ? gt("dialogs.conflictMerge.toolbar.focusAuto", "当前聚焦：第 {{index}} 块，建议结果：{{label}}", {
                      index: selectedBlock.index + 1,
                      label: resolveAutoResolutionLabel(selectedAutoResolution, props.snapshot, gt),
                    })
                    : gt("dialogs.conflictMerge.toolbar.focusManual", "当前聚焦：第 {{index}} 块，需要手工确认", {
                      index: selectedBlock.index + 1,
                    })
                  : gt("dialogs.conflictMerge.toolbar.focusHint", "左侧与右侧为只读来源，中间为可编辑结果；按块应用或忽略后再点击“应用”。")}
              </span>
            </div>
          </div>

          <div className="grid min-h-0 flex-1 gap-3 px-3 py-2 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-h-0 min-w-0" data-testid="conflict-merge-main-viewer">
              {props.loading || !viewerState ? (
                <div className="flex h-full min-h-[360px] items-center justify-center gap-2 rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] text-sm text-[var(--cf-text-secondary)]">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>{gt("dialogs.conflictMerge.loadingContent", "正在读取冲突内容…")}</span>
                </div>
              ) : (
                <ConflictMergeThreeWayEditor
                  language={language}
                  saving={props.saving}
                  busy={props.loading || props.saving}
                  collapseUnchanged={collapseUnchanged}
                  leftPane={{
                    label: oursLabel,
                    text: String(oursRevision?.text || ""),
                    renderable: canRenderConflictRevision(oursRevision),
                    fallbackText: resolveConflictRevisionFallbackText(oursRevision, gt),
                  }}
                  rightPane={{
                    label: theirsLabel,
                    text: String(theirsRevision?.text || ""),
                    renderable: canRenderConflictRevision(theirsRevision),
                    fallbackText: resolveConflictRevisionFallbackText(theirsRevision, gt),
                  }}
                  resultLabel={resultLabel}
                  resultText={viewerState.resultText}
                  blocks={viewerState.blocks}
                  selectedBlock={selectedBlock}
                  scrollRequest={scrollRequest}
                  focusedPane={focusedPane}
                  onPaneFocus={(paneKey) => {
                    if (paneKey === "left") setSourceView("ours");
                    else if (paneKey === "right") setSourceView("theirs");
                    else setSourceView("working");
                  }}
                  onSelectBlock={setSelectedBlockIndex}
                  onApplyBlock={(blockIndex, side) => handleApplyBlockResolution(side, blockIndex)}
                  onIgnoreBlock={(blockIndex, side) => handleIgnoreBlockSide(side, blockIndex)}
                  canAutoResolveBlock={canResolveConflictMergeBlockAutomatically}
                  onAutoResolveBlock={(blockIndex) => updateViewerState((prev) => applyConflictMergeBlockAutoResolution(prev, blockIndex))}
                  onResultTextChange={handleResultTextChange}
                />
              )}
            </div>

            <aside
              className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-git-panel-muted)]/28 shadow-apple-sm"
              data-testid="conflict-merge-inspector-column"
            >
              <div
                className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-gutter:stable]"
                data-testid="conflict-merge-bottom-inspector"
              >
                <section className="shrink-0 border-b border-[var(--cf-git-panel-line)] px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[11px] text-[var(--cf-text-secondary)]">
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                        <span className="font-semibold text-[var(--cf-text-primary)]">{gt("dialogs.conflictMerge.currentBlock.title", "当前块")}</span>
                      </div>
                      <div className="mt-1 text-[12px] font-semibold text-[var(--cf-text-primary)]">
                        {selectedBlock
                          ? (selectedBlock.kind === "conflict"
                            ? gt("dialogs.conflictMerge.currentBlock.conflict", "冲突块 {{index}}", { index: selectedBlock.index + 1 })
                            : gt("dialogs.conflictMerge.currentBlock.change", "更改块 {{index}}", { index: selectedBlock.index + 1 }))
                          : gt("dialogs.conflictMerge.currentBlock.none", "没有待处理块")}
                      </div>
                      <div className="mt-0.5 tabular-nums text-[10px] text-[var(--cf-text-secondary)]">
                        {selectedBlock
                          ? gt("dialogs.conflictMerge.currentBlock.resultRange", "结果 {{range}}", {
                            range: formatConflictMergeRangeText(selectedBlock.resultRange, gt),
                          })
                          : gt("dialogs.conflictMerge.currentBlock.resolved", "结果已全部收口")}
                      </div>
                    </div>
                    <div className="flex max-w-[56%] flex-wrap justify-end gap-1.5">
                      {selectedBlock ? (
                        <Badge variant={selectedBlock.kind === "conflict" ? "secondary" : "outline"} className="text-[10px]">
                          {selectedBlock.kind === "conflict"
                            ? gt("dialogs.conflictMerge.badges.conflict", "冲突")
                            : gt("dialogs.conflictMerge.badges.nonConflict", "不冲突")}
                        </Badge>
                      ) : null}
                      {selectedAutoResolution ? <Badge variant="outline" className="text-[10px]">{gt("dialogs.conflictMerge.badges.autoResolvable", "可自动处理")}</Badge> : null}
                      {selectedBlock?.modified ? <Badge variant="outline" className="text-[10px]">{gt("dialogs.conflictMerge.badges.edited", "已手工编辑")}</Badge> : null}
                      {selectedBlock?.onesideApplied ? <Badge variant="outline" className="text-[10px]">{gt("dialogs.conflictMerge.badges.oneSideApplied", "单侧已应用")}</Badge> : null}
                    </div>
                  </div>
                  <div className="mt-3 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 py-2.5">
                    <div className="text-[11px] font-medium text-[var(--cf-text-primary)]">{gt("dialogs.conflictMerge.currentBlock.summaryTitle", "块摘要")}</div>
                    <div className="mt-1 text-[11px] leading-5 text-[var(--cf-text-secondary)]">
                      {selectedBlock
                        ? selectedBlock.summary
                        : gt("dialogs.conflictMerge.currentBlock.summaryEmpty", "当前没有待处理块。你仍可继续检查结果列后点击“应用”完成写回。")}
                    </div>
                    <div className="mt-2 border-t border-[var(--cf-border)]/70 pt-2 text-[11px] leading-5 text-[var(--cf-text-secondary)]">
                      {buildConflictMergeSelectedBlockHint({
                        block: selectedBlock,
                        autoResolution: selectedAutoResolution,
                        snapshot: props.snapshot,
                      }, gt)}
                    </div>
                  </div>
                </section>

                <section className="shrink-0 border-b border-[var(--cf-git-panel-line)] px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-semibold text-[var(--cf-text-primary)]">{gt("dialogs.conflictMerge.viewSource.title", "查看来源")}</div>
                      <div className="mt-0.5 text-[10px] leading-4 text-[var(--cf-text-secondary)]">
                        {gt("dialogs.conflictMerge.viewSource.description", "这里只切换聚焦和查看行号，不会修改内容。")}
                      </div>
                    </div>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {gt("dialogs.conflictMerge.viewSource.focus", "聚焦：{{label}}", {
                        label: resolveConflictMergeFocusLabel(sourceView, props.snapshot, gt),
                      })}
                    </Badge>
                  </div>
                  <div className="mt-2.5 space-y-1.5">
                    <button
                      type="button"
                      className={cn(
                        "w-full rounded-apple border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/45",
                        sourceView === "ours"
                          ? "border-[var(--cf-accent)] bg-[var(--cf-accent-light)]/85"
                          : "border-[var(--cf-border)] bg-[var(--cf-surface-solid)] hover:bg-[var(--cf-surface-hover)]",
                      )}
                      onClick={() => setSourceView("ours")}
                      data-testid="conflict-focus-ours"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[11px] font-medium text-[var(--cf-text-primary)]">
                          {oursLabel}
                        </span>
                        {sourceView === "ours" ? <Badge variant="outline" className="text-[10px]">{gt("dialogs.conflictMerge.viewSource.currentFocus", "当前聚焦")}</Badge> : null}
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-[var(--cf-text-secondary)]">
                        <span>{gt("dialogs.conflictMerge.sources.ours", "左侧来源")}</span>
                        <span className="shrink-0 tabular-nums">{formatConflictMergeRangeText(selectedBlock?.oursRange || null, gt)}</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "w-full rounded-apple border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/45",
                        sourceView === "theirs"
                          ? "border-[var(--cf-accent)] bg-[var(--cf-accent-light)]/85"
                          : "border-[var(--cf-border)] bg-[var(--cf-surface-solid)] hover:bg-[var(--cf-surface-hover)]",
                      )}
                      onClick={() => setSourceView("theirs")}
                      data-testid="conflict-focus-theirs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[11px] font-medium text-[var(--cf-text-primary)]">
                          {theirsLabel}
                        </span>
                        {sourceView === "theirs" ? <Badge variant="outline" className="text-[10px]">{gt("dialogs.conflictMerge.viewSource.currentFocus", "当前聚焦")}</Badge> : null}
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-[var(--cf-text-secondary)]">
                        <span>{gt("dialogs.conflictMerge.sources.theirs", "右侧来源")}</span>
                        <span className="shrink-0 tabular-nums">{formatConflictMergeRangeText(selectedBlock?.theirsRange || null, gt)}</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "w-full rounded-apple border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/45",
                        sourceView === "base"
                          ? "border-[var(--cf-accent)] bg-[var(--cf-accent-light)]/85"
                          : "border-[var(--cf-border)] bg-[var(--cf-surface-muted)] hover:bg-[var(--cf-surface-hover)]",
                      )}
                      onClick={() => setSourceView("base")}
                      data-testid="conflict-focus-base"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[11px] font-medium text-[var(--cf-text-primary)]">
                          {baseLabel}
                        </span>
                        {sourceView === "base" ? <Badge variant="outline" className="text-[10px]">{gt("dialogs.conflictMerge.viewSource.currentFocus", "当前聚焦")}</Badge> : null}
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-[var(--cf-text-secondary)]">
                        <span>{gt("dialogs.conflictMerge.viewSource.sharedOriginal", "共同原文")}</span>
                        <span className="shrink-0">{selectedBlock?.hasBase ? formatConflictMergeRangeText(selectedBlock?.baseRange || null, gt) : gt("dialogs.conflictMerge.viewSource.noBase", "当前块不含基线")}</span>
                      </div>
                    </button>
                  </div>
                  <div className="mt-2 rounded-apple border border-[var(--cf-border)]/80 bg-[var(--cf-surface-solid)]/90 px-2.5 py-2 text-[10px] leading-5 text-[var(--cf-text-secondary)]">
                    {buildConflictMergeBaseDescription(selectedBlock, gt)}
                  </div>
                </section>

                <section className="shrink-0 border-b border-[var(--cf-git-panel-line)] px-3 py-3">
                  <div className="text-[11px] font-semibold text-[var(--cf-text-primary)]">{gt("dialogs.conflictMerge.processCurrentBlock.title", "处理当前块")}</div>
                  <div className="mt-0.5 text-[10px] leading-4 text-[var(--cf-text-secondary)]">
                    {gt("dialogs.conflictMerge.processCurrentBlock.description", "这些按钮只影响当前选中的块，不会整份替换文件。")}
                  </div>
                  <div className="mt-2.5 grid grid-cols-2 gap-1.5">
                    <Button
                      size="xs"
                      variant="secondary"
                      className="h-auto min-h-8 justify-start whitespace-normal px-2.5 py-2 text-left leading-4"
                      disabled={!selectedBlock || props.loading || props.saving || !selectedBlock.changedInOurs || selectedBlock.resolvedOurs}
                      onClick={() => handleApplyBlockResolution("ours")}
                      data-testid="conflict-block-action-ours"
                    >
                      {buildApplyCurrentBlockLabel(props.snapshot?.ours.label || gt("dialogs.conflictMerge.sources.oursShort", "左侧"), gt)}
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      className="h-auto min-h-8 justify-start whitespace-normal px-2.5 py-2 text-left leading-4"
                      disabled={!selectedBlock || props.loading || props.saving || !selectedBlock.changedInTheirs || selectedBlock.resolvedTheirs}
                      onClick={() => handleApplyBlockResolution("theirs")}
                      data-testid="conflict-block-action-theirs"
                    >
                      {buildApplyCurrentBlockLabel(props.snapshot?.theirs.label || gt("dialogs.conflictMerge.sources.theirsShort", "右侧"), gt)}
                    </Button>
                    {selectedBlock?.hasBase ? (
                      <Button
                        size="xs"
                        variant="secondary"
                        className="h-auto min-h-8 justify-start whitespace-normal px-2.5 py-2 text-left leading-4"
                        disabled={!selectedBlock || props.loading || props.saving}
                        onClick={() => handleApplyBlockResolution("base")}
                        data-testid="conflict-block-action-base"
                      >
                        {gt("dialogs.conflictMerge.actions.restoreBase", "当前块恢复为基线")}
                      </Button>
                    ) : null}
                    {selectedBlock ? (
                      <Button
                        size="xs"
                        variant="secondary"
                        className="h-auto min-h-8 justify-start whitespace-normal px-2.5 py-2 text-left leading-4"
                        disabled={props.loading || props.saving}
                        onClick={() => handleApplyBlockResolution("both")}
                        data-testid="conflict-block-action-both"
                      >
                        {gt("dialogs.conflictMerge.actions.keepBoth", "当前块保留两侧")}
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="secondary"
                      className="h-auto min-h-8 justify-start whitespace-normal px-2.5 py-2 text-left leading-4"
                      disabled={!selectedBlock || props.loading || props.saving || !selectedBlock.changedInOurs || selectedBlock.resolvedOurs}
                      onClick={() => handleIgnoreBlockSide("ours")}
                      data-testid="conflict-block-ignore-ours"
                    >
                      {gt("dialogs.conflictMerge.actions.ignoreOurs", "当前块忽略左侧")}
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      className="h-auto min-h-8 justify-start whitespace-normal px-2.5 py-2 text-left leading-4"
                      disabled={!selectedBlock || props.loading || props.saving || !selectedBlock.changedInTheirs || selectedBlock.resolvedTheirs}
                      onClick={() => handleIgnoreBlockSide("theirs")}
                      data-testid="conflict-block-ignore-theirs"
                    >
                      {gt("dialogs.conflictMerge.actions.ignoreTheirs", "当前块忽略右侧")}
                    </Button>
                    <Button
                      size="xs"
                      variant="secondary"
                      className={cn(
                        "col-span-2 h-auto min-h-8 justify-start whitespace-normal px-2.5 py-2 text-left leading-4",
                        selectedAutoResolution ? "border-[var(--cf-accent)]/35 bg-[var(--cf-accent-light)]/85 hover:bg-[var(--cf-accent-light)]" : "",
                      )}
                      disabled={!selectedBlock || props.loading || props.saving || !canResolveConflictMergeBlockAutomatically(selectedBlock)}
                      onClick={() => selectedBlock ? updateViewerState((prev) => applyConflictMergeBlockAutoResolution(prev, selectedBlock.index)) : undefined}
                      data-testid="conflict-selected-auto-resolve"
                    >
                      <Sparkles className="mr-1.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {gt("dialogs.conflictMerge.actions.autoResolveCurrent", "自动处理当前块")}
                    </Button>
                  </div>
                </section>

                <section className="min-h-0 shrink-0 flex flex-col">
                  <div className="flex items-center justify-between gap-2 border-b border-[var(--cf-git-panel-line)] px-3 py-2.5">
                    <div>
                      <div className="text-[11px] font-semibold text-[var(--cf-text-primary)]">{gt("dialogs.conflictMerge.pendingList.title", "待处理块列表")}</div>
                      <div className="mt-0.5 text-[10px] leading-4 text-[var(--cf-text-secondary)]">
                        {gt("dialogs.conflictMerge.pendingList.description", "点击任意条目即可定位到对应块。")}
                      </div>
                    </div>
                    <div className="tabular-nums text-[10px] text-[var(--cf-text-secondary)]">
                      {gt("dialogs.conflictMerge.pendingList.count", "{{count}} 个块", { count: unresolvedBlocks.length })}
                    </div>
                  </div>
                  <div
                    className="min-h-0 max-h-[42vh] overflow-auto p-2 overscroll-contain"
                    data-testid="conflict-merge-block-list"
                  >
                    {unresolvedBlocks.length <= 0 ? (
                      <div className="rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-2.5 py-2 text-[11px] leading-5 text-[var(--cf-text-secondary)]">
                        {gt("dialogs.conflictMerge.pendingList.empty", "当前结果已经没有待处理块，可直接继续检查后应用。")}
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {unresolvedBlocks.map((block) => {
                          const autoResolution = resolveConflictMergeAutoResolution(block);
                          const selected = block.index === selectedBlock?.index;
                          return (
                            <button
                              key={`conflict-block:${block.index}`}
                              type="button"
                              className={cn(
                                "w-full rounded-apple border px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/45",
                                selected
                                  ? "border-[var(--cf-accent)] bg-[var(--cf-accent-light)]"
                                  : "border-[var(--cf-border)] bg-[var(--cf-surface-solid)] hover:bg-[var(--cf-surface-hover)]",
                              )}
                              onClick={() => setSelectedBlockIndex(block.index)}
                              data-testid={`conflict-block-item-${block.index}`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-[11px] font-medium text-[var(--cf-text-primary)] tabular-nums">
                                  {block.kind === "conflict"
                                    ? gt("dialogs.conflictMerge.currentBlock.conflict", "冲突块 {{index}}", { index: block.index + 1 })
                                    : gt("dialogs.conflictMerge.currentBlock.change", "更改块 {{index}}", { index: block.index + 1 })}
                                </div>
                                <div className="flex items-center gap-1">
                                  {block.kind === "conflict"
                                    ? <Badge variant="secondary" className="text-[10px]">{gt("dialogs.conflictMerge.badges.conflict", "冲突")}</Badge>
                                    : <Badge variant="outline" className="text-[10px]">{gt("dialogs.conflictMerge.badges.nonConflict", "不冲突")}</Badge>}
                                  {autoResolution ? <Badge variant="outline" className="text-[10px]">{gt("dialogs.conflictMerge.badges.autoResolvable", "可自动处理")}</Badge> : null}
                                  {block.modified ? <Badge variant="outline" className="text-[10px]">{gt("dialogs.conflictMerge.badges.edited", "已编辑")}</Badge> : null}
                                </div>
                              </div>
                              <div className="mt-1 tabular-nums text-[10px] text-[var(--cf-text-secondary)]">
                                {formatConflictMergeRangeText(block.resultRange, gt)}
                              </div>
                              <div className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-[10px] text-[var(--cf-text-secondary)]">
                                {block.summary}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </section>
              </div>
            </aside>
          </div>

          <div className="cf-git-toolbar-surface shrink-0 overflow-x-auto border-t border-[var(--cf-git-panel-line)]">
            <div className="inline-flex w-full min-w-max items-center gap-4 px-4 py-2.5 text-[11px]" data-testid="conflict-merge-footer-row">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canRenderConflictRevision(oursRevision) || props.loading || props.saving}
                  onClick={() => handleResolveWithSource("ours")}
                  data-testid="conflict-resolve-left"
                >
                  {buildResolveWithSourceLabel(oursRevision?.label || gt("dialogs.conflictMerge.sources.oursShort", "左侧"), gt)}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canRenderConflictRevision(theirsRevision) || props.loading || props.saving}
                  onClick={() => handleResolveWithSource("theirs")}
                  data-testid="conflict-resolve-right"
                >
                  {buildResolveWithSourceLabel(theirsRevision?.label || gt("dialogs.conflictMerge.sources.theirsShort", "右侧"), gt)}
                </Button>
              </div>
              <span className="min-w-0 flex-1 truncate text-[var(--cf-text-secondary)]">
                {resolveHint}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  size="sm"
                  data-cf-dialog-primary="true"
                  disabled={props.loading || props.saving || !viewerState}
                  onClick={handleResolve}
                  data-testid="conflict-resolve"
                >
                  {props.saving ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      {gt("dialogs.conflictMerge.actions.applying", "应用中…")}
                    </>
                  ) : (
                    gt("dialogs.conflictMerge.actions.apply", "应用")
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  data-cf-dialog-cancel="true"
                  disabled={props.saving}
                  onClick={() => props.onOpenChange(false)}
                >
                  {gt("dialogs.conflictMerge.actions.cancel", "取消")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
