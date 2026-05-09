// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Editor, loader } from "@monaco-editor/react";
import type * as MonacoNS from "monaco-editor";
import * as MonacoEditor from "monaco-editor";
import { ArrowDown, ArrowLeft, ArrowRight, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { resolveGitTextWith } from "../git-i18n";
import {
  isLineVisible,
  resolveEditorAnchorTop,
  resolveEditorVerticalSpan,
  resolveVisibleLineRange,
} from "../monaco-overlay-utils";
import type {
  ConflictMergeBlock,
  ConflictMergeBlockKind,
  ConflictMergeLineRange,
} from "./conflict-merge-model";
import {
  buildConflictMergeViewerFoldingPlan,
  buildConflictMergeViewerScrollMaps,
  countConflictMergeViewerLogicalLines,
  transferConflictMergeViewerLine,
  type ConflictMergeViewerFoldingPlan,
  type ConflictMergeViewerPaneKey,
} from "./conflict-merge-viewer-layout";

loader.config({ monaco: MonacoEditor as any });

type ConflictMergeThreeWayPane = {
  label: string;
  text: string;
  renderable: boolean;
  fallbackText: string;
};

type ConflictMergeEditorPaneKey = ConflictMergeViewerPaneKey;

type ConflictMergeGutterControl = {
  key: string;
  blockIndex: number;
  side: "left" | "right" | "result";
  operation: "apply" | "ignore" | "resolve";
  left: number;
  top: number;
  icon: "apply-left" | "apply-right" | "apply-down" | "ignore" | "resolve";
  title: string;
  selected: boolean;
};

type ConflictMergeConnector = {
  key: string;
  side: "left" | "right";
  kind: ConflictMergeBlockKind;
  selected: boolean;
  path: string;
};

type ConflictMergeFoldSeparator = {
  key: string;
  side: "left" | "right";
  path: string;
};

type ConflictMergeThreeWayEditorProps = {
  language: string;
  saving: boolean;
  busy: boolean;
  collapseUnchanged: boolean;
  leftPane: ConflictMergeThreeWayPane;
  rightPane: ConflictMergeThreeWayPane;
  resultLabel: string;
  resultText: string;
  blocks: ConflictMergeBlock[];
  selectedBlock: ConflictMergeBlock | null;
  scrollRequest?: {
    blockIndex: number;
    force: boolean;
  } | null;
  focusedPane?: ConflictMergeEditorPaneKey | null;
  onPaneFocus?: (paneKey: ConflictMergeEditorPaneKey) => void;
  onSelectBlock?: (blockIndex: number) => void;
  onApplyBlock?: (blockIndex: number, side: "ours" | "theirs") => void;
  onIgnoreBlock?: (blockIndex: number, side: "ours" | "theirs") => void;
  canAutoResolveBlock?: (block: ConflictMergeBlock) => boolean;
  onAutoResolveBlock?: (blockIndex: number) => void;
  onResultTextChange: (value: string) => void;
};

/**
 * 构造单栏 Monaco 编辑器选项，统一收口三栏 merge 视图的字体、滚动与只读行为。
 */
function buildConflictMergeStandaloneEditorOptions(
  readOnly: boolean,
): MonacoNS.editor.IStandaloneEditorConstructionOptions {
  return {
    automaticLayout: true,
    readOnly,
    domReadOnly: readOnly,
    minimap: { enabled: false },
    lineNumbers: "on",
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: true,
    roundedSelection: false,
    scrollBeyondLastLine: false,
    wordWrap: "off",
    renderLineHighlight: "none",
    overviewRulerLanes: 0,
    fontSize: 13,
    lineHeight: 20,
    lineDecorationsWidth: 10,
    padding: {
      top: 10,
      bottom: 12,
    },
    stickyScroll: {
      enabled: false,
    },
  };
}

/**
 * 把行范围转换为 Monaco 装饰集合，供三栏 merge 视图高亮冲突块、普通变更块与选中块。
 */
function buildConflictMergeLineRangeDecorations(
  monaco: typeof MonacoNS,
  ranges: Array<ConflictMergeLineRange | null>,
  className: string,
  marginClassName: string,
  emptyClassName: string,
  emptyMarginClassName: string,
  overviewColor: string,
): MonacoNS.editor.IModelDeltaDecoration[] {
  return ranges
    .filter((range): range is ConflictMergeLineRange => !!range && (range.empty || range.endLine >= range.startLine))
    .map((range) => ({
      range: range.empty
        ? new monaco.Range(range.anchorLine, 1, range.anchorLine, 1)
        : new monaco.Range(range.startLine, 1, range.endLine, 1),
      options: {
        isWholeLine: true,
        className: range.empty ? emptyClassName : className,
        linesDecorationsClassName: range.empty ? emptyMarginClassName : marginClassName,
        overviewRuler: {
          color: overviewColor,
          position: monaco.editor.OverviewRulerLane.Full,
        },
      },
    }));
}

/**
 * 为 resolved 块生成边界线装饰；只绘制块的首行/末行（或空块双线），避免出现逐行虚线纹理。
 */
function buildConflictMergeResolvedLineDecorations(
  monaco: typeof MonacoNS,
  ranges: Array<ConflictMergeLineRange | null>,
  classNames: {
    single: string;
    start: string;
    end: string;
    empty: string;
    singleMargin: string;
    startMargin: string;
    endMargin: string;
    emptyMargin: string;
  },
  overviewColor: string,
): MonacoNS.editor.IModelDeltaDecoration[] {
  return ranges.flatMap((range) => {
    if (!range || (!range.empty && range.endLine < range.startLine)) return [];
    if (range.empty) {
      return [{
        range: new monaco.Range(range.anchorLine, 1, range.anchorLine, 1),
        options: {
          isWholeLine: true,
          className: classNames.empty,
          linesDecorationsClassName: classNames.emptyMargin,
          overviewRuler: {
            color: overviewColor,
            position: monaco.editor.OverviewRulerLane.Full,
          },
        },
      }];
    }
    if (range.startLine === range.endLine) {
      return [{
        range: new monaco.Range(range.startLine, 1, range.endLine, 1),
        options: {
          isWholeLine: true,
          className: classNames.single,
          linesDecorationsClassName: classNames.singleMargin,
          overviewRuler: {
            color: overviewColor,
            position: monaco.editor.OverviewRulerLane.Full,
          },
        },
      }];
    }
    return [{
      range: new monaco.Range(range.startLine, 1, range.startLine, 1),
      options: {
        isWholeLine: true,
        className: classNames.start,
        linesDecorationsClassName: classNames.startMargin,
        overviewRuler: {
          color: overviewColor,
          position: monaco.editor.OverviewRulerLane.Full,
        },
      },
    }, {
      range: new monaco.Range(range.endLine, 1, range.endLine, 1),
      options: {
        isWholeLine: true,
        className: classNames.end,
        linesDecorationsClassName: classNames.endMargin,
        overviewRuler: {
          color: overviewColor,
          position: monaco.editor.OverviewRulerLane.Full,
        },
      },
    }];
  });
}

/**
 * 把指定块范围滚动到编辑区；强制模式对齐 IDEA `doScrollToChange(..., true)`，直接居中到目标块。
 */
function revealConflictMergeLineRange(
  editor: MonacoNS.editor.IStandaloneCodeEditor | null | undefined,
  range: ConflictMergeLineRange | null | undefined,
  force: boolean,
): void {
  if (!editor || !range) return;
  const lineNumber = range.empty ? range.anchorLine : range.startLine;
  if (force && typeof editor.revealLineInCenter === "function") {
    editor.revealLineInCenter(lineNumber);
    return;
  }
  editor.revealLineInCenterIfOutsideViewport(lineNumber);
}

/**
 * 根据当前聚焦列返回标题栏样式，让三栏编辑器更接近桌面 IDE 的复合面板感。
 */
function resolveConflictMergePaneHeaderClassName(args: {
  focused: boolean;
  readonly?: boolean;
}): string {
  if (args.focused && args.readonly) {
    return "bg-[var(--cf-accent-light)]/60";
  }
  if (args.focused) {
    return "bg-[var(--cf-accent-light)]/72";
  }
  return args.readonly
    ? "bg-[var(--cf-git-panel-muted)]/85"
    : "bg-[var(--cf-git-panel-elevated)]";
}

/**
 * 渲染单个三栏 pane 的标题栏，统一承载列标签、只读状态与聚焦反馈。
 */
function renderConflictMergePaneHeader(args: {
  label: string;
  badgeLabel: string;
  readonly?: boolean;
  focused: boolean;
  testId: string;
  onFocus?: () => void;
}): React.ReactElement {
  const content = (
    <>
      <div className="min-w-0 truncate text-[11px] font-medium text-[var(--cf-text-primary)]">
        {args.label}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {args.readonly
          ? <Badge variant="outline" className="text-[10px]">{args.badgeLabel}</Badge>
          : <Badge variant="secondary" className="text-[10px]">{args.badgeLabel}</Badge>}
        {args.focused ? <span className="inline-block h-2 w-2 rounded-full bg-[var(--cf-accent)]" aria-hidden="true" /> : null}
      </div>
    </>
  );
  const className = cn(
    "flex shrink-0 items-center justify-between gap-2 border-b border-[var(--cf-git-panel-line)] px-2.5 py-1.5",
    resolveConflictMergePaneHeaderClassName({
      focused: args.focused,
      readonly: args.readonly,
    }),
    args.onFocus ? "cursor-pointer transition-colors hover:bg-[var(--cf-surface-hover)]" : "",
  );
  if (!args.onFocus) {
    return (
      <div className={className} data-testid={args.testId}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={cn(className, "w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)]/45")}
      data-testid={args.testId}
      onClick={args.onFocus}
    >
      {content}
    </button>
  );
}

/**
 * 渲染单个 merge pane 的主体，统一处理编辑器承载、不可预览降级态与聚焦边框。
 */
function renderConflictMergePaneBody(args: {
  readonly?: boolean;
  focused: boolean;
  renderable: boolean;
  value: string;
  fallbackText: string;
  language: string;
  options: MonacoNS.editor.IStandaloneEditorConstructionOptions;
  testId: string;
  headerTestId: string;
  label: string;
  badgeLabel: string;
  onMount: (editor: MonacoNS.editor.IStandaloneCodeEditor, monaco: typeof MonacoNS) => void;
  onChange?: (value?: string) => void;
  onFocus?: () => void;
  hostRef?: (node: HTMLDivElement | null) => void;
}): React.ReactElement {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col",
        args.readonly ? "bg-[var(--cf-git-panel-muted)]/60" : "bg-[var(--cf-git-panel-elevated)]",
        args.focused ? "ring-1 ring-inset ring-[var(--cf-accent)]/35" : "",
      )}
    >
      {renderConflictMergePaneHeader({
        label: args.label,
        badgeLabel: args.badgeLabel,
        readonly: args.readonly,
        focused: args.focused,
        testId: args.headerTestId,
        onFocus: args.onFocus,
      })}
      <div
        ref={args.hostRef}
        className="relative h-full min-h-0 flex-1 overflow-hidden"
        data-testid={args.testId}
      >
        {args.renderable ? (
          <div className="h-full min-h-0 w-full">
            <Editor
              height="100%"
              language={args.language}
              value={args.value}
              options={args.options}
              onChange={args.onChange}
              onMount={args.onMount}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-[var(--cf-text-secondary)]">
            {args.fallbackText}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 把块行范围转换成可绘制的垂直 span；删除/插入这类空块会退化为一条短锚点带。
 */
function resolveConflictMergeBlockSpan(args: {
  rootNode: HTMLDivElement;
  editor: MonacoNS.editor.IStandaloneCodeEditor;
  range: ConflictMergeLineRange | null;
}): { top: number; bottom: number; center: number } | null {
  if (!args.range) return null;
  const span = resolveEditorVerticalSpan({
    rootNode: args.rootNode,
    editor: args.editor,
    startLine: args.range.empty ? args.range.anchorLine : args.range.startLine,
    endLine: args.range.empty ? args.range.anchorLine : args.range.endLine,
    empty: args.range.empty,
  });
  if (!span) return null;
  if (!args.range.empty) return span;

  const minHeight = 10;
  const center = span.center;
  return {
    top: center - (minHeight / 2),
    bottom: center + (minHeight / 2),
    center,
  };
}

/**
 * 为左右来源与结果列之间构造连接多边形，增强三栏 merge 的对应关系可读性。
 */
function buildConflictMergeConnectorPoints(args: {
  sourceX: number;
  targetX: number;
  sourceTop: number;
  sourceBottom: number;
  targetTop: number;
  targetBottom: number;
}): string {
  const width = args.targetX - args.sourceX;
  const controlOffset = width * 0.3;
  return [
    `M ${args.sourceX} ${args.sourceTop}`,
    `C ${args.sourceX + controlOffset} ${args.sourceTop}, ${args.targetX - controlOffset} ${args.targetTop}, ${args.targetX} ${args.targetTop}`,
    `L ${args.targetX} ${args.targetBottom}`,
    `C ${args.targetX - controlOffset} ${args.targetBottom}, ${args.sourceX + controlOffset} ${args.sourceBottom}, ${args.sourceX} ${args.sourceBottom}`,
    "Z",
  ].join(" ");
}

/**
 * 为折叠分隔线构造一条平滑的 Bezier 路径，补齐 collapsed unchanged group 在两个 pane 之间的错位提示。
 */
function buildConflictMergeFoldSeparatorPath(args: {
  startX: number;
  endX: number;
  startY: number;
  endY: number;
}): string {
  const width = Math.max(1, args.endX - args.startX);
  const step = Math.max(width / 6, 2);
  const height = 3;
  const startX = args.startX;
  const endX = args.endX;
  const startY = args.startY;
  const endY = args.endY;
  const delta = Math.abs(endY - startY) / width;

  if (delta < 0.2) {
    const middleX = (startX + endX) / 2;
    const middleY = (startY + endY) / 2;
    if (width > 5 * step) {
      return [
        `M ${startX} ${startY}`,
        `Q ${startX + (step * 0.5)} ${startY + height}, ${startX + step} ${startY + height}`,
        `Q ${startX + (step * 1.5)} ${startY + height}, ${startX + (step * 2)} ${middleY}`,
        `Q ${startX + (step * 2.5)} ${middleY - height}, ${middleX} ${middleY - height}`,
        `Q ${endX - (step * 2.5)} ${middleY - height}, ${endX - (step * 2)} ${middleY}`,
        `Q ${endX - (step * 1.5)} ${endY + height}, ${endX - step} ${endY + height}`,
        `Q ${endX - (step * 0.5)} ${endY + height}, ${endX} ${endY}`,
      ].join(" ");
    }
    return `M ${startX} ${startY} Q ${middleX} ${middleY + (height * 2)}, ${endX} ${endY}`;
  }

  if (startY > endY) {
    return [
      `M ${startX} ${startY}`,
      `C ${startX + (step * 0.125)} ${startY + (height * 0.125)}, ${startX + (step * 0.125)} ${startY + (height * 0.5)}, ${startX + (step * 0.5)} ${startY + (height * 0.5)}`,
      `C ${endX - (step * 2)} ${startY + (height * 0.5)}, ${endX - (step * 2)} ${endY + (height * 4)}, ${endX} ${endY}`,
    ].join(" ");
  }
  return [
    `M ${startX} ${startY}`,
    `C ${startX + (step * 2)} ${startY + (height * 4)}, ${startX + (step * 2)} ${endY + (height * 0.5)}, ${endX - (step * 0.5)} ${endY + (height * 0.5)}`,
    `C ${endX - (step * 0.125)} ${endY + (height * 0.5)}, ${endX - (step * 0.125)} ${endY + (height * 0.125)}, ${endX} ${endY}`,
  ].join(" ");
}

/**
 * 当一侧为空块时，把细锚点扩成与对侧等高的连接带，逼近 IDEA divider polygon 的 `withAlignedHeight` 效果。
 */
function alignConflictMergeConnectorSpans(args: {
  source: { top: number; bottom: number; center: number };
  target: { top: number; bottom: number; center: number };
  sourceEmpty: boolean;
  targetEmpty: boolean;
}): {
  source: { top: number; bottom: number; center: number };
  target: { top: number; bottom: number; center: number };
} {
  const sourceHeight = args.source.bottom - args.source.top;
  const targetHeight = args.target.bottom - args.target.top;
  if (sourceHeight <= 0 || targetHeight <= 0) return { source: args.source, target: args.target };

  if (args.sourceEmpty && !args.targetEmpty) {
    const half = targetHeight / 2;
    return {
      source: {
        top: args.source.center - half,
        bottom: args.source.center + half,
        center: args.source.center,
      },
      target: args.target,
    };
  }
  if (!args.sourceEmpty && args.targetEmpty) {
    const half = sourceHeight / 2;
    return {
      source: args.source,
      target: {
        top: args.target.center - half,
        bottom: args.target.center + half,
        center: args.target.center,
      },
    };
  }
  return {
    source: args.source,
    target: args.target,
  };
}

/**
 * 根据 gutter 控件语义返回对应图标，和 IDEA 的左右箭头 / 向下追加 / 删除操作保持一致。
 */
function renderConflictMergeGutterControlIcon(control: ConflictMergeGutterControl): React.ReactElement {
  if (control.icon === "apply-left") {
    return <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />;
  }
  if (control.icon === "apply-right") {
    return <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />;
  }
  if (control.icon === "apply-down") {
    return <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />;
  }
  if (control.icon === "resolve") {
    return <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />;
  }
  return <X className="h-3.5 w-3.5" aria-hidden="true" />;
}

/**
 * 更接近 IDEA `TextMergeViewer` 的三栏代码视图；左右为只读来源，中间为可编辑结果，并为每个未解决块渲染 gutter 操作。
 */
export function ConflictMergeThreeWayEditor(props: ConflictMergeThreeWayEditorProps): React.ReactElement {
  const { t } = useTranslation(["git", "common"]);
  const gt = React.useCallback((key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveGitTextWith(t, key, fallback, values);
  }, [t]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const monacoRef = useRef<typeof MonacoNS | null>(null);
  const editorRefs = useRef<Record<ConflictMergeEditorPaneKey, MonacoNS.editor.IStandaloneCodeEditor | null>>({
    left: null,
    result: null,
    right: null,
  });
  const paneHostRefs = useRef<Record<ConflictMergeEditorPaneKey, HTMLDivElement | null>>({
    left: null,
    result: null,
    right: null,
  });
  const decorationRefs = useRef<Record<ConflictMergeEditorPaneKey, MonacoNS.editor.IEditorDecorationsCollection | null>>({
    left: null,
    result: null,
    right: null,
  });
  const scrollListenersRef = useRef<MonacoNS.IDisposable[]>([]);
  const scrollSyncingRef = useRef<boolean>(false);
  const gutterFrameRef = useRef<number | null>(null);
  const [editorMountStamp, setEditorMountStamp] = React.useState(0);
  const [gutterControls, setGutterControls] = React.useState<ConflictMergeGutterControl[]>([]);
  const [connectors, setConnectors] = React.useState<ConflictMergeConnector[]>([]);
  const [foldSeparators, setFoldSeparators] = React.useState<ConflictMergeFoldSeparator[]>([]);
  const [overlaySize, setOverlaySize] = React.useState<{ width: number; height: number }>({ width: 1, height: 1 });
  const readonlyOptions = useMemo(() => buildConflictMergeStandaloneEditorOptions(true), []);
  const editableOptions = useMemo(
    () => buildConflictMergeStandaloneEditorOptions(props.saving),
    [props.saving],
  );
  const paneLineCounts = useMemo(() => ({
    left: countConflictMergeViewerLogicalLines(props.leftPane.text),
    result: countConflictMergeViewerLogicalLines(props.resultText),
    right: countConflictMergeViewerLogicalLines(props.rightPane.text),
  }), [props.leftPane.text, props.resultText, props.rightPane.text]);
  const scrollMaps = useMemo(
    () => buildConflictMergeViewerScrollMaps({
      blocks: props.blocks,
      lineCounts: paneLineCounts,
    }),
    [paneLineCounts, props.blocks],
  );
  const foldingPlan = useMemo<ConflictMergeViewerFoldingPlan>(() => {
    if (!props.collapseUnchanged) {
      return {
        hiddenAreas: {
          left: [],
          result: [],
          right: [],
        },
        separators: [],
      };
    }
    return buildConflictMergeViewerFoldingPlan({
      blocks: props.blocks,
      lineCounts: paneLineCounts,
      contextRange: 4,
    });
  }, [paneLineCounts, props.blocks, props.collapseUnchanged]);

  /**
   * 统一注册编辑器实例，后续滚动同步、折叠与块高亮都从这里读取三栏引用。
   */
  const handleEditorMount = React.useCallback((
    paneKey: ConflictMergeEditorPaneKey,
    editor: MonacoNS.editor.IStandaloneCodeEditor,
    monaco: typeof MonacoNS,
  ): void => {
    monacoRef.current = monaco;
    editorRefs.current[paneKey] = editor;
    setEditorMountStamp((prev) => prev + 1);
  }, []);

  /**
   * 记录三栏宿主节点，供 gutter 操作按真实布局定位。
   */
  const bindPaneHostRef = React.useCallback((paneKey: ConflictMergeEditorPaneKey) => {
    return (node: HTMLDivElement | null): void => {
      paneHostRefs.current[paneKey] = node;
    };
  }, []);

  /**
   * 读取当前 pane 的滚动锚点，按“逻辑行 + 行内像素偏移”表示，供三栏差异映射同步使用。
   */
  const resolveConflictMergeScrollAnchor = React.useCallback((
    paneKey: ConflictMergeEditorPaneKey,
  ): { line: number; lineOffset: number } | null => {
    const editor = editorRefs.current[paneKey];
    if (!editor) return null;
    const visibleRange = resolveVisibleLineRange(editor);
    if (!visibleRange) return null;

    const safeLine = Math.max(1, Math.min(paneLineCounts[paneKey], visibleRange.start));
    const lineTop = editor.getTopForLineNumber(safeLine);
    return {
      line: safeLine - 1,
      lineOffset: Math.max(0, editor.getScrollTop() - lineTop),
    };
  }, [paneLineCounts]);

  /**
   * 把映射后的逻辑行号滚到目标 pane，替换掉旧的“直接复制 scrollTop”近似实现。
   */
  const applyConflictMergeMappedScroll = React.useCallback((
    paneKey: ConflictMergeEditorPaneKey,
    line: number,
    lineOffset: number,
  ): void => {
    const editor = editorRefs.current[paneKey];
    if (!editor) return;
    const safeLine = Math.max(1, Math.min(paneLineCounts[paneKey], line + 1));
    editor.setScrollTop(Math.max(0, editor.getTopForLineNumber(safeLine) + lineOffset));
  }, [paneLineCounts]);

  /**
   * 按 IDEA `SyncScrollSupport` 的片段映射策略同步三栏纵向滚动，折叠后仍能保持块级错位关系可读。
   */
  const syncConflictMergeEditorScrollTop = React.useCallback((
    sourcePaneKey: ConflictMergeEditorPaneKey,
  ): void => {
    if (scrollSyncingRef.current) return;
    const anchor = resolveConflictMergeScrollAnchor(sourcePaneKey);
    if (!anchor) return;

    scrollSyncingRef.current = true;
    try {
      if (sourcePaneKey === "left") {
        const resultLine = transferConflictMergeViewerLine(anchor.line, scrollMaps.leftToResult);
        applyConflictMergeMappedScroll("result", resultLine, anchor.lineOffset);
        applyConflictMergeMappedScroll("right", transferConflictMergeViewerLine(resultLine, scrollMaps.resultToRight), anchor.lineOffset);
        return;
      }
      if (sourcePaneKey === "result") {
        applyConflictMergeMappedScroll("left", transferConflictMergeViewerLine(anchor.line, scrollMaps.resultToLeft), anchor.lineOffset);
        applyConflictMergeMappedScroll("right", transferConflictMergeViewerLine(anchor.line, scrollMaps.resultToRight), anchor.lineOffset);
        return;
      }
      const resultLine = transferConflictMergeViewerLine(anchor.line, scrollMaps.rightToResult);
      applyConflictMergeMappedScroll("result", resultLine, anchor.lineOffset);
      applyConflictMergeMappedScroll("left", transferConflictMergeViewerLine(resultLine, scrollMaps.resultToLeft), anchor.lineOffset);
    } finally {
      scrollSyncingRef.current = false;
    }
  }, [applyConflictMergeMappedScroll, resolveConflictMergeScrollAnchor, scrollMaps]);

  /**
   * 根据块高亮、折叠分隔线与三栏真实位置计算所有叠层控件坐标，参考上游 merge viewer 的可视关联提示。
   */
  const updateConflictMergeGutterControls = React.useCallback((): void => {
    const rootNode = rootRef.current;
    const resultEditor = editorRefs.current.result;
    const leftEditor = editorRefs.current.left;
    const rightEditor = editorRefs.current.right;
    const leftHost = paneHostRefs.current.left;
    const resultHost = paneHostRefs.current.result;
    const rightHost = paneHostRefs.current.right;
    if (!rootNode || !resultEditor || !leftEditor || !rightEditor || !leftHost || !resultHost || !rightHost) {
      setGutterControls([]);
      setConnectors([]);
      setFoldSeparators([]);
      return;
    }
    const rootRect = rootNode.getBoundingClientRect();
    const leftRect = leftHost.getBoundingClientRect();
    const resultRect = resultHost.getBoundingClientRect();
    const rightRect = rightHost.getBoundingClientRect();
    const horizontalLayout = Math.abs(leftRect.top - resultRect.top) < 4 && Math.abs(resultRect.top - rightRect.top) < 4;
    const leftDividerCenter = ((leftRect.right + resultRect.left) / 2) - rootRect.left;
    const rightDividerCenter = ((resultRect.right + rightRect.left) / 2) - rootRect.left;
    const leftVisibleRange = resolveVisibleLineRange(leftEditor);
    const resultVisibleRange = resolveVisibleLineRange(resultEditor);
    const rightVisibleRange = resolveVisibleLineRange(rightEditor);
    const nextControls: ConflictMergeGutterControl[] = [];
    const nextConnectors: ConflictMergeConnector[] = [];
    const nextFoldSeparators: ConflictMergeFoldSeparator[] = [];

    setOverlaySize({
      width: Math.max(1, rootRect.width),
      height: Math.max(1, rootRect.height),
    });

    if (!horizontalLayout || !resultVisibleRange) {
      setGutterControls([]);
      setConnectors([]);
      setFoldSeparators([]);
      return;
    }

    for (const block of props.blocks) {
      const anchorLine = block.resultRange?.anchorLine || 1;
      if (!isLineVisible(resultVisibleRange, anchorLine)) continue;

      const resultSpan = resolveConflictMergeBlockSpan({
        rootNode,
        editor: resultEditor,
        range: block.resultRange,
      });
      const leftSpan = block.changedInOurs
        ? resolveConflictMergeBlockSpan({
            rootNode,
            editor: leftEditor,
            range: block.oursRange,
          })
        : null;
      const rightSpan = block.changedInTheirs
        ? resolveConflictMergeBlockSpan({
            rootNode,
            editor: rightEditor,
            range: block.theirsRange,
          })
        : null;
      const anchorTop = resolveEditorAnchorTop({
        rootNode,
        editor: resultEditor,
        lineNumber: anchorLine,
      });
      const top = anchorTop == null
        ? null
        : Math.max(8, Math.min(rootRect.height - 24, anchorTop - 10));
      const selected = block.index === props.selectedBlock?.index;

      if (resultSpan && leftSpan) {
        const aligned = alignConflictMergeConnectorSpans({
          source: leftSpan,
          target: resultSpan,
          sourceEmpty: !!block.oursRange?.empty,
          targetEmpty: !!block.resultRange?.empty,
        });
        nextConnectors.push({
          key: `connector:left:${block.index}`,
          side: "left",
          kind: block.kind,
          selected,
          path: buildConflictMergeConnectorPoints({
            sourceX: leftRect.right - rootRect.left - 1,
            targetX: resultRect.left - rootRect.left + 1,
            sourceTop: aligned.source.top,
            sourceBottom: aligned.source.bottom,
            targetTop: aligned.target.top,
            targetBottom: aligned.target.bottom,
          }),
        });
      }
      if (resultSpan && rightSpan) {
        const aligned = alignConflictMergeConnectorSpans({
          source: resultSpan,
          target: rightSpan,
          sourceEmpty: !!block.resultRange?.empty,
          targetEmpty: !!block.theirsRange?.empty,
        });
        nextConnectors.push({
          key: `connector:right:${block.index}`,
          side: "right",
          kind: block.kind,
          selected,
          path: buildConflictMergeConnectorPoints({
            sourceX: resultRect.right - rootRect.left - 1,
            targetX: rightRect.left - rootRect.left + 1,
            sourceTop: aligned.source.top,
            sourceBottom: aligned.source.bottom,
            targetTop: aligned.target.top,
            targetBottom: aligned.target.bottom,
          }),
        });
      }

      if (top == null) continue;

      if (block.changedInOurs && !block.resolvedOurs) {
        nextControls.push({
          key: `apply:left:${block.index}`,
          blockIndex: block.index,
          side: "left",
          operation: "apply",
          left: leftDividerCenter + 9,
          top,
          icon: block.onesideApplied ? "apply-down" : "apply-right",
          title: block.onesideApplied
            ? gt("commitPanel.conflictMergeThreeWay.controls.appendLeft", "追加左侧更改")
            : gt("commitPanel.conflictMergeThreeWay.controls.acceptLeft", "接受左侧更改"),
          selected,
        });
        nextControls.push({
          key: `ignore:left:${block.index}`,
          blockIndex: block.index,
          side: "left",
          operation: "ignore",
          left: leftDividerCenter - 9,
          top,
          icon: "ignore",
          title: gt("commitPanel.conflictMergeThreeWay.controls.ignoreLeft", "忽略左侧更改"),
          selected,
        });
      }
      if (block.changedInTheirs && !block.resolvedTheirs) {
        nextControls.push({
          key: `ignore:right:${block.index}`,
          blockIndex: block.index,
          side: "right",
          operation: "ignore",
          left: rightDividerCenter - 9,
          top,
          icon: "ignore",
          title: gt("commitPanel.conflictMergeThreeWay.controls.ignoreRight", "忽略右侧更改"),
          selected,
        });
        nextControls.push({
          key: `apply:right:${block.index}`,
          blockIndex: block.index,
          side: "right",
          operation: "apply",
          left: rightDividerCenter + 9,
          top,
          icon: block.onesideApplied ? "apply-down" : "apply-left",
          title: block.onesideApplied
            ? gt("commitPanel.conflictMergeThreeWay.controls.appendRight", "追加右侧更改")
            : gt("commitPanel.conflictMergeThreeWay.controls.acceptRight", "接受右侧更改"),
          selected,
        });
      }
      if (!props.busy && block.kind === "conflict" && props.canAutoResolveBlock?.(block)) {
        nextControls.push({
          key: `resolve:${block.index}`,
          blockIndex: block.index,
          side: "result",
          operation: "resolve",
          left: resultRect.left - rootRect.left + 8,
          top,
          icon: "resolve",
          title: gt("commitPanel.conflictMergeThreeWay.controls.resolveCurrent", "自动解决当前冲突"),
          selected,
        });
      }
    }

    for (const separator of foldingPlan.separators) {
      if (separator.side === "left") {
        if (!leftVisibleRange || !isLineVisible(leftVisibleRange, separator.sourceLine) || !isLineVisible(resultVisibleRange, separator.targetLine)) {
          continue;
        }
        const leftTop = resolveEditorAnchorTop({
          rootNode,
          editor: leftEditor,
          lineNumber: separator.sourceLine,
        });
        const resultTop = resolveEditorAnchorTop({
          rootNode,
          editor: resultEditor,
          lineNumber: separator.targetLine,
        });
        if (leftTop == null || resultTop == null) continue;
        nextFoldSeparators.push({
          key: `fold-separator:left:${separator.sourceLine}:${separator.targetLine}`,
          side: "left",
          path: buildConflictMergeFoldSeparatorPath({
            startX: leftRect.right - rootRect.left - 1,
            endX: resultRect.left - rootRect.left + 1,
            startY: leftTop,
            endY: resultTop,
          }),
        });
        continue;
      }
      if (!rightVisibleRange || !isLineVisible(resultVisibleRange, separator.sourceLine) || !isLineVisible(rightVisibleRange, separator.targetLine)) {
        continue;
      }
      const resultTop = resolveEditorAnchorTop({
        rootNode,
        editor: resultEditor,
        lineNumber: separator.sourceLine,
      });
      const rightTop = resolveEditorAnchorTop({
        rootNode,
        editor: rightEditor,
        lineNumber: separator.targetLine,
      });
      if (resultTop == null || rightTop == null) continue;
      nextFoldSeparators.push({
        key: `fold-separator:right:${separator.sourceLine}:${separator.targetLine}`,
        side: "right",
        path: buildConflictMergeFoldSeparatorPath({
          startX: resultRect.right - rootRect.left - 1,
          endX: rightRect.left - rootRect.left + 1,
          startY: resultTop,
          endY: rightTop,
        }),
      });
    }
    setGutterControls(nextControls);
    setConnectors(nextConnectors.sort((left, right) => Number(left.selected) - Number(right.selected)));
    setFoldSeparators(nextFoldSeparators);
  }, [foldingPlan.separators, props.blocks, props.busy, props.canAutoResolveBlock, props.selectedBlock?.index]);

  /**
   * 用 rAF 节流 gutter 按钮定位刷新，避免滚动同步期间反复写状态。
   */
  const scheduleConflictMergeGutterControls = React.useCallback((): void => {
    if (typeof window === "undefined") {
      updateConflictMergeGutterControls();
      return;
    }
    if (gutterFrameRef.current != null) return;
    gutterFrameRef.current = window.requestAnimationFrame(() => {
      gutterFrameRef.current = null;
      updateConflictMergeGutterControls();
    });
  }, [updateConflictMergeGutterControls]);

  /**
   * 重建三栏滚动同步监听，滚动时按片段映射同步其余 pane，而不是继续复制同一个像素偏移。
   */
  useEffect(() => {
    scrollListenersRef.current.forEach((listener) => {
      try { listener.dispose(); } catch {}
    });
    scrollListenersRef.current = [];
    (Object.keys(editorRefs.current) as ConflictMergeEditorPaneKey[]).forEach((paneKey) => {
      const editor = editorRefs.current[paneKey];
      if (!editor) return;
      scrollListenersRef.current.push(editor.onDidScrollChange((event) => {
        if (!event.scrollTopChanged) return;
        syncConflictMergeEditorScrollTop(paneKey);
        scheduleConflictMergeGutterControls();
      }));
      scrollListenersRef.current.push(editor.onDidLayoutChange(scheduleConflictMergeGutterControls));
    });
    scheduleConflictMergeGutterControls();
    return () => {
      scrollListenersRef.current.forEach((listener) => {
        try { listener.dispose(); } catch {}
      });
      scrollListenersRef.current = [];
    };
  }, [editorMountStamp, props.leftPane.renderable, props.rightPane.renderable, scheduleConflictMergeGutterControls, syncConflictMergeEditorScrollTop]);

  /**
   * 向三栏编辑器写入块装饰，区分普通变更块、冲突块与当前选中块。
   */
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    const unresolvedConflictBlocks = props.blocks.filter((block) => block.kind === "conflict" && !block.resolved);
    const unresolvedChangeBlocks = props.blocks.filter((block) => block.kind === "change" && !block.resolved);
    const resolvedBlocks = props.blocks.filter((block) => block.resolved);

    const resultEditor = editorRefs.current.result;
    if (resultEditor) {
      const resultCollection = decorationRefs.current.result || resultEditor.createDecorationsCollection();
      decorationRefs.current.result = resultCollection;
      resultCollection.set([
        ...buildConflictMergeLineRangeDecorations(
          monaco,
          unresolvedConflictBlocks.map((block) => block.resultRange),
          "cf-git-merge-conflict-block",
          "cf-git-merge-conflict-block-margin",
          "cf-git-merge-conflict-empty-anchor",
          "cf-git-merge-conflict-empty-anchor-margin",
          "rgba(217, 119, 6, 0.82)",
        ),
        ...buildConflictMergeLineRangeDecorations(
          monaco,
          unresolvedChangeBlocks.map((block) => block.resultRange),
          "cf-git-merge-change-block",
          "cf-git-merge-change-block-margin",
          "cf-git-merge-change-empty-anchor",
          "cf-git-merge-change-empty-anchor-margin",
          "rgba(22, 163, 74, 0.78)",
        ),
        ...buildConflictMergeResolvedLineDecorations(
          monaco,
          resolvedBlocks.map((block) => block.resultRange),
          {
            single: "cf-git-merge-resolved-single-line",
            start: "cf-git-merge-resolved-start-line",
            end: "cf-git-merge-resolved-end-line",
            empty: "cf-git-merge-resolved-empty-anchor",
            singleMargin: "cf-git-merge-resolved-single-line-margin",
            startMargin: "cf-git-merge-resolved-start-line-margin",
            endMargin: "cf-git-merge-resolved-end-line-margin",
            emptyMargin: "cf-git-merge-resolved-empty-anchor-margin",
          },
          "rgba(99, 102, 241, 0.52)",
        ),
        ...buildConflictMergeLineRangeDecorations(
          monaco,
          props.selectedBlock ? [props.selectedBlock.resultRange] : [],
          "cf-git-merge-selected-block",
          "cf-git-merge-selected-block-margin",
          "cf-git-merge-selected-empty-anchor",
          "cf-git-merge-selected-empty-anchor-margin",
          "rgba(37, 99, 235, 0.9)",
        ),
      ]);
    }

    const leftEditor = editorRefs.current.left;
    if (leftEditor) {
      const leftCollection = decorationRefs.current.left || leftEditor.createDecorationsCollection();
      decorationRefs.current.left = leftCollection;
      leftCollection.set([
        ...buildConflictMergeLineRangeDecorations(
          monaco,
          props.blocks.filter((block) => block.changedInOurs && !block.resolvedOurs).map((block) => block.oursRange),
          "cf-git-merge-source-block",
          "cf-git-merge-source-block-margin",
          "cf-git-merge-source-empty-anchor",
          "cf-git-merge-source-empty-anchor-margin",
          "rgba(22, 163, 74, 0.7)",
        ),
        ...buildConflictMergeResolvedLineDecorations(
          monaco,
          props.blocks.filter((block) => block.changedInOurs && block.resolvedOurs).map((block) => block.oursRange),
          {
            single: "cf-git-merge-source-resolved-single-line",
            start: "cf-git-merge-source-resolved-start-line",
            end: "cf-git-merge-source-resolved-end-line",
            empty: "cf-git-merge-source-resolved-empty-anchor",
            singleMargin: "cf-git-merge-source-resolved-single-line-margin",
            startMargin: "cf-git-merge-source-resolved-start-line-margin",
            endMargin: "cf-git-merge-source-resolved-end-line-margin",
            emptyMargin: "cf-git-merge-source-resolved-empty-anchor-margin",
          },
          "rgba(22, 163, 74, 0.48)",
        ),
        ...buildConflictMergeLineRangeDecorations(
          monaco,
          props.selectedBlock?.changedInOurs && !props.selectedBlock.resolvedOurs ? [props.selectedBlock.oursRange] : [],
          "cf-git-merge-source-selected-block",
          "cf-git-merge-source-selected-block-margin",
          "cf-git-merge-source-selected-empty-anchor",
          "cf-git-merge-source-selected-empty-anchor-margin",
          "rgba(37, 99, 235, 0.78)",
        ),
      ]);
    }

    const rightEditor = editorRefs.current.right;
    if (rightEditor) {
      const rightCollection = decorationRefs.current.right || rightEditor.createDecorationsCollection();
      decorationRefs.current.right = rightCollection;
      rightCollection.set([
        ...buildConflictMergeLineRangeDecorations(
          monaco,
          props.blocks.filter((block) => block.changedInTheirs && !block.resolvedTheirs).map((block) => block.theirsRange),
          "cf-git-merge-source-block",
          "cf-git-merge-source-block-margin",
          "cf-git-merge-source-empty-anchor",
          "cf-git-merge-source-empty-anchor-margin",
          "rgba(22, 163, 74, 0.7)",
        ),
        ...buildConflictMergeResolvedLineDecorations(
          monaco,
          props.blocks.filter((block) => block.changedInTheirs && block.resolvedTheirs).map((block) => block.theirsRange),
          {
            single: "cf-git-merge-source-resolved-single-line",
            start: "cf-git-merge-source-resolved-start-line",
            end: "cf-git-merge-source-resolved-end-line",
            empty: "cf-git-merge-source-resolved-empty-anchor",
            singleMargin: "cf-git-merge-source-resolved-single-line-margin",
            startMargin: "cf-git-merge-source-resolved-start-line-margin",
            endMargin: "cf-git-merge-source-resolved-end-line-margin",
            emptyMargin: "cf-git-merge-source-resolved-empty-anchor-margin",
          },
          "rgba(22, 163, 74, 0.48)",
        ),
        ...buildConflictMergeLineRangeDecorations(
          monaco,
          props.selectedBlock?.changedInTheirs && !props.selectedBlock.resolvedTheirs ? [props.selectedBlock.theirsRange] : [],
          "cf-git-merge-source-selected-block",
          "cf-git-merge-source-selected-block-margin",
          "cf-git-merge-source-selected-empty-anchor",
          "cf-git-merge-source-selected-empty-anchor-margin",
          "rgba(37, 99, 235, 0.78)",
        ),
      ]);
    }
    scheduleConflictMergeGutterControls();
  }, [editorMountStamp, props.blocks, props.selectedBlock, scheduleConflictMergeGutterControls]);

  /**
   * 切换“收起未更改片段”时按同步 fold plan 更新三栏隐藏区域，参考上游 `FoldingModelSupport` 的同组折叠关系。
   */
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    const applyHiddenAreas = (
      paneKey: ConflictMergeEditorPaneKey,
    ): void => {
      const editor = editorRefs.current[paneKey];
      if (!editor) return;
      const hiddenAreaEditor = editor as MonacoNS.editor.IStandaloneCodeEditor & {
        setHiddenAreas?: (ranges: MonacoNS.Range[]) => void;
      };
      if (typeof hiddenAreaEditor.setHiddenAreas !== "function") return;
      const hiddenAreas = foldingPlan.hiddenAreas[paneKey];
      if (hiddenAreas.length <= 0) {
        hiddenAreaEditor.setHiddenAreas([]);
        return;
      }
      hiddenAreaEditor.setHiddenAreas(hiddenAreas.map((range) => new monaco.Range(
        range.startLine,
        1,
        range.endLine,
        1,
      )));
    };

    applyHiddenAreas("left");
    applyHiddenAreas("right");
    applyHiddenAreas("result");
    scheduleConflictMergeGutterControls();
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        scheduleConflictMergeGutterControls();
      });
    }
  }, [editorMountStamp, foldingPlan.hiddenAreas, scheduleConflictMergeGutterControls]);

  /**
   * 当用户切换块导航时，让三栏视图尽量把对应范围滚动到可见区域中央。
   */
  useEffect(() => {
    revealConflictMergeLineRange(editorRefs.current.result, props.selectedBlock?.resultRange, false);
    revealConflictMergeLineRange(editorRefs.current.left, props.selectedBlock?.oursRange, false);
    revealConflictMergeLineRange(editorRefs.current.right, props.selectedBlock?.theirsRange, false);
    scheduleConflictMergeGutterControls();
  }, [editorMountStamp, props.selectedBlock, scheduleConflictMergeGutterControls]);

  /**
   * 批量自动处理后强制把下一个待处理块滚到中央，避免折叠和同步滚动导致用户仍停留在旧位置。
   */
  useEffect(() => {
    if (!props.scrollRequest) return;
    const targetBlock = props.blocks.find((block) => block.index === props.scrollRequest?.blockIndex);
    if (!targetBlock) return;
    revealConflictMergeLineRange(editorRefs.current.result, targetBlock.resultRange, props.scrollRequest.force);
    revealConflictMergeLineRange(editorRefs.current.left, targetBlock.oursRange, props.scrollRequest.force);
    revealConflictMergeLineRange(editorRefs.current.right, targetBlock.theirsRange, props.scrollRequest.force);
    scheduleConflictMergeGutterControls();
  }, [editorMountStamp, props.blocks, props.scrollRequest, scheduleConflictMergeGutterControls]);

  useEffect(() => {
    scheduleConflictMergeGutterControls();
  }, [editorMountStamp, props.blocks, props.selectedBlock, scheduleConflictMergeGutterControls]);

  useEffect(() => {
    return () => {
      scrollListenersRef.current.forEach((listener) => {
        try { listener.dispose(); } catch {}
      });
      scrollListenersRef.current = [];
      (Object.keys(decorationRefs.current) as ConflictMergeEditorPaneKey[]).forEach((paneKey) => {
        try { decorationRefs.current[paneKey]?.clear(); } catch {}
        decorationRefs.current[paneKey] = null;
      });
      (Object.keys(editorRefs.current) as ConflictMergeEditorPaneKey[]).forEach((paneKey) => {
        editorRefs.current[paneKey] = null;
      });
      if (gutterFrameRef.current != null && typeof window !== "undefined") {
        window.cancelAnimationFrame(gutterFrameRef.current);
        gutterFrameRef.current = null;
      }
      monacoRef.current = null;
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="cf-git-merge-viewer relative flex h-full min-h-0 flex-col overflow-hidden rounded-apple-lg border border-[var(--cf-border-strong)] bg-[var(--cf-git-panel-elevated)] shadow-apple-sm"
    >
      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_34px_minmax(0,1fr)_34px_minmax(0,1fr)]">
        <div className="h-full min-h-0 xl:border-r xl:border-[var(--cf-git-panel-line)]">
          {renderConflictMergePaneBody({
            label: props.leftPane.label,
            badgeLabel: gt("commitPanel.conflictMergeThreeWay.source", "Source"),
            readonly: true,
            focused: props.focusedPane === "left",
            renderable: props.leftPane.renderable,
            value: props.leftPane.text,
            fallbackText: props.leftPane.fallbackText,
            language: props.language,
            options: readonlyOptions,
            testId: "conflict-merge-left-host",
            headerTestId: "conflict-merge-pane-left",
            onFocus: props.onPaneFocus ? () => props.onPaneFocus?.("left") : undefined,
            hostRef: bindPaneHostRef("left"),
            onMount: (editor, monaco) => handleEditorMount("left", editor, monaco),
          })}
        </div>

        <div className="hidden xl:block cf-git-merge-divider-column" aria-hidden="true" />

        <div className="h-full min-h-0 border-t border-[var(--cf-git-panel-line)] xl:border-t-0 xl:border-r xl:border-[var(--cf-git-panel-line)]">
          {renderConflictMergePaneBody({
            label: props.resultLabel,
            badgeLabel: gt("commitPanel.conflictMergeThreeWay.result", "Result"),
            focused: props.focusedPane === "result",
            renderable: true,
            value: props.resultText,
            fallbackText: "",
            language: props.language,
            options: editableOptions,
            testId: "conflict-merge-result-host",
            headerTestId: "conflict-merge-pane-result",
            onFocus: props.onPaneFocus ? () => props.onPaneFocus?.("result") : undefined,
            hostRef: bindPaneHostRef("result"),
            onMount: (editor, monaco) => handleEditorMount("result", editor, monaco),
            onChange: (value) => props.onResultTextChange(String(value || "")),
          })}
        </div>

        <div className="hidden xl:block cf-git-merge-divider-column" aria-hidden="true" />

        <div className="h-full min-h-0 border-t border-[var(--cf-git-panel-line)] xl:border-t-0">
          {renderConflictMergePaneBody({
            label: props.rightPane.label,
            badgeLabel: gt("commitPanel.conflictMergeThreeWay.source", "Source"),
            readonly: true,
            focused: props.focusedPane === "right",
            renderable: props.rightPane.renderable,
            value: props.rightPane.text,
            fallbackText: props.rightPane.fallbackText,
            language: props.language,
            options: readonlyOptions,
            testId: "conflict-merge-right-host",
            headerTestId: "conflict-merge-pane-right",
            onFocus: props.onPaneFocus ? () => props.onPaneFocus?.("right") : undefined,
            hostRef: bindPaneHostRef("right"),
            onMount: (editor, monaco) => handleEditorMount("right", editor, monaco),
          })}
        </div>
      </div>
      {foldSeparators.length > 0 ? (
        <svg
          className="cf-git-merge-fold-separator-overlay"
          data-testid="conflict-merge-fold-separator-overlay"
          viewBox={`0 0 ${overlaySize.width} ${overlaySize.height}`}
          preserveAspectRatio="none"
        >
          {foldSeparators.map((separator) => (
            <path
              key={separator.key}
              d={separator.path}
              className="cf-git-merge-fold-separator"
              data-side={separator.side}
            />
          ))}
        </svg>
      ) : null}
      {connectors.length > 0 ? (
        <svg
          className="cf-git-merge-connector-overlay"
          data-testid="conflict-merge-connector-overlay"
          viewBox={`0 0 ${overlaySize.width} ${overlaySize.height}`}
          preserveAspectRatio="none"
        >
          {connectors.map((connector) => (
            <path
              key={connector.key}
              d={connector.path}
              className="cf-git-merge-connector"
              data-side={connector.side}
              data-kind={connector.kind}
              data-selected={connector.selected ? "true" : "false"}
            />
          ))}
        </svg>
      ) : null}
      {gutterControls.length > 0 ? (
        <div className="cf-git-merge-gutter-overlay" data-testid="conflict-merge-gutter-overlay">
          {gutterControls.map((control) => (
            <button
              key={control.key}
              type="button"
              className="cf-git-merge-gutter-control"
              data-side={control.side}
              data-operation={control.operation}
              data-selected={control.selected ? "true" : "false"}
              aria-label={control.title}
              title={control.title}
              data-testid={`conflict-gutter-${control.operation}-${control.blockIndex}`}
              style={{
                left: `${control.left}px`,
                top: `${control.top}px`,
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onSelectBlock?.(control.blockIndex);
                if (control.operation === "apply") {
                  props.onApplyBlock?.(control.blockIndex, control.side === "left" ? "ours" : "theirs");
                } else if (control.operation === "ignore") {
                  props.onIgnoreBlock?.(control.blockIndex, control.side === "left" ? "ours" : "theirs");
                } else {
                  props.onAutoResolveBlock?.(control.blockIndex);
                }
              }}
            >
              {renderConflictMergeGutterControlIcon(control)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
