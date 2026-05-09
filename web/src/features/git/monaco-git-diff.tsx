// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DiffEditor, loader } from "@monaco-editor/react";
import type * as MonacoNS from "monaco-editor";
import * as MonacoEditor from "monaco-editor";
import { resolveGitTextWith } from "./git-i18n";
import type { PartialCommitDiffControls, PartialCommitDiffControlSide, PartialCommitDiffHunkControlState } from "./commit-panel/partial-commit-diff-controls";
import { Button } from "@/components/ui/button";
import { isLineVisible, resolveEditorAnchorTop, resolveVisibleLineRange } from "./monaco-overlay-utils";
import { resolveCheckboxGutterOffset } from "./monaco-git-diff-layout";
import type { GitDiffEditorSelection, GitDiffLineDecorations, GitDiffSnapshot } from "./types";

type GitTranslate = (key: string, fallback: string, values?: Record<string, unknown>) => string;

type MonacoGitDiffProps = {
  diff: GitDiffSnapshot | null;
  sideBySide: boolean;
  ignoreWhitespace: boolean;
  collapseUnchanged: boolean;
  modifiedEditable?: boolean;
  onModifiedContentChange?: (content: string) => void;
  activeLine: number;
  onChangedLines: (lines: number[]) => void;
  lineDecorations?: GitDiffLineDecorations | null;
  onSelectionChange?: (selection: GitDiffEditorSelection) => void;
  partialCommitControls?: PartialCommitDiffControls | null;
  onPartialCommitBlockToggle?: (lineKeysByHunkId: Record<string, string[]>, selected: boolean, focusLineNumber?: number) => void;
  onPartialCommitLineToggle?: (hunkId: string, lineKey: string, selected: boolean, focusLineNumber?: number) => void;
  onOpenInIde?: () => void;
  onOpenInSystem?: () => void;
  onExportPatch?: () => void;
};

type MonacoPartialCommitOverlayButtonKind = "block-checkbox" | "line-checkbox";

type MonacoPartialCommitOverlayButton = {
  key: string;
  kind: MonacoPartialCommitOverlayButtonKind;
  left: number;
  top: number;
  state: PartialCommitDiffHunkControlState;
  side: PartialCommitDiffControlSide;
  hunkId?: string;
  lineKeysByHunkId?: Record<string, string[]>;
  lineKey?: string;
  lineNumber: number;
  title: string;
};

type MonacoThemeId = "vs" | "vs-dark";

/**
 * 强制使用本地打包的 Monaco，避免离线环境卡在 “Loading...”。
 */
loader.config({ monaco: MonacoEditor as any });

/**
 * 根据当前文档根节点的主题类名，解析 Monaco 应使用的亮暗主题标识。
 */
function resolveMonacoTheme(): MonacoThemeId {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) return "vs-dark";
  return "vs";
}

/**
 * 订阅应用主题切换并返回当前 Monaco 主题，确保设置面板内动态切换亮暗主题时 DiffEditor 能同步刷新。
 */
function useMonacoTheme(): MonacoThemeId {
  const [theme, setTheme] = useState<MonacoThemeId>(() => resolveMonacoTheme());

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const updateTheme = (): void => {
      setTheme(resolveMonacoTheme());
    };

    updateTheme();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      updateTheme();
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-theme-setting"],
    });
    return () => {
      observer.disconnect();
    };
  }, []);

  return theme;
}

/**
 * 按路径后缀推断 Monaco 语言标识。
 */
function detectLanguageId(pathText: string): string {
  const lower = String(pathText || "").toLowerCase();
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js")) return "javascript";
  if (lower.endsWith(".jsx")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".scss")) return "scss";
  if (lower.endsWith(".less")) return "less";
  if (lower.endsWith(".html")) return "html";
  if (lower.endsWith(".xml")) return "xml";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".sh")) return "shell";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".cs")) return "csharp";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".cpp") || lower.endsWith(".cc") || lower.endsWith(".cxx")) return "cpp";
  if (lower.endsWith(".c")) return "c";
  return "plaintext";
}

/**
 * 从 Monaco DiffEditor 中提取所有变更行（0 基）。
 */
function collectChangedLines(editor: MonacoNS.editor.IStandaloneDiffEditor): number[] {
  const changes = editor.getLineChanges() || [];
  const out: number[] = [];
  for (const one of changes) {
    const start = Math.max(1, one.modifiedStartLineNumber || 1);
    const end = Math.max(start, one.modifiedEndLineNumber || start);
    for (let line = start; line <= end; line += 1) out.push(line - 1);
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

/**
 * 读取单侧编辑器当前真正选中的行号；空选区时返回空数组，供“当前行”回退逻辑单独处理。
 */
function collectSelectedLines(editor: MonacoNS.editor.IStandaloneCodeEditor): number[] {
  const selections = editor.getSelections() || [];
  const lineSet = new Set<number>();
  for (const selection of selections) {
    if (!selection || selection.isEmpty()) continue;
    const startLine = Math.max(1, selection.startLineNumber || 1);
    const rawEndLine = Math.max(startLine, selection.endLineNumber || startLine);
    const endLine = selection.endColumn === 1 && rawEndLine > startLine ? rawEndLine - 1 : rawEndLine;
    for (let line = startLine; line <= endLine; line += 1) {
      lineSet.add(line);
    }
  }
  return Array.from(lineSet).sort((left, right) => left - right);
}

/**
 * 读取单侧编辑器当前光标所在行，供未显式选区时回退为“当前行”操作。
 */
function resolveActiveLine(editor: MonacoNS.editor.IStandaloneCodeEditor): number | undefined {
  const selection = editor.getSelection();
  if (!selection) return undefined;
  return Math.max(1, selection.positionLineNumber || selection.startLineNumber || 1);
}

/**
 * 统一构造 DiffEditor 的视图选项，确保按钮状态与实际渲染行为始终一致。
 */
function buildDiffEditorViewOptions(
  sideBySide: boolean,
  ignoreWhitespace: boolean,
  collapseUnchanged: boolean,
): Pick<MonacoNS.editor.IDiffEditorConstructionOptions, "renderSideBySide" | "ignoreTrimWhitespace" | "hideUnchangedRegions"> {
  return {
    renderSideBySide: sideBySide,
    ignoreTrimWhitespace: ignoreWhitespace,
    hideUnchangedRegions: {
      enabled: collapseUnchanged,
      contextLineCount: 3,
      minimumLineCount: 4,
      revealLineCount: 10,
    },
  };
}

/**
 * 向已挂载的 Monaco DiffEditor 重放当前视图选项，修复切换文件后折叠状态未同步的问题。
 */
function applyDiffEditorViewOptions(
  editor: MonacoNS.editor.IStandaloneDiffEditor,
  sideBySide: boolean,
  ignoreWhitespace: boolean,
  collapseUnchanged: boolean,
): void {
  editor.updateOptions(buildDiffEditorViewOptions(sideBySide, ignoreWhitespace, collapseUnchanged));
}

/**
 * 读取编辑器当前实际行高，供 partial commit 叠层按钮做垂直对齐。
 */
function resolveEditorLineHeight(
  editor: MonacoNS.editor.IStandaloneCodeEditor,
): number {
  return Math.max(16, editor.getOption(MonacoEditor.editor.EditorOption.lineHeight));
}

/**
 * 把复选框定位到行号前侧 gutter，优先居中落在 glyph margin 内，和 IDEA 的左侧勾选列保持一致。
 */
function resolveEditorCheckboxLeft(args: {
  rootNode: HTMLDivElement;
  editor: MonacoNS.editor.IStandaloneCodeEditor;
  controlWidth: number;
}): number | null {
  const { rootNode, editor, controlWidth } = args;
  const domNode = editor.getDomNode();
  if (!domNode) return null;
  const rootRect = rootNode.getBoundingClientRect();
  const editorRect = domNode.getBoundingClientRect();
  const editorLeft = editorRect.left - rootRect.left;
  return editorLeft + resolveCheckboxGutterOffset({
    layoutInfo: editor.getLayoutInfo(),
    controlWidth,
  });
}

/**
 * 将变更块的一侧行号范围规整为可匹配的闭区间；空侧变更返回空值。
 */
function normalizeChangeLineRange(
  startLineNumber: number | undefined,
  endLineNumber: number | undefined,
): { start: number; end: number } | null {
  const start = Math.max(0, Math.floor(Number(startLineNumber) || 0));
  const end = Math.max(0, Math.floor(Number(endLineNumber) || 0));
  if (start <= 0 || end <= 0 || end < start) return null;
  return { start, end };
}

/**
 * 判断某个 changed line 是否落在指定变更块的行号范围内。
 */
function isLineInsideChangeRange(
  lineNumber: number,
  range: { start: number; end: number } | null,
): boolean {
  if (!range) return false;
  return lineNumber >= range.start && lineNumber <= range.end;
}

/**
 * 把命中的行控件集合转换成父组件可消费的批量切换载荷。
 */
function buildLineKeysByHunkId(
  lineControls: Array<{ hunkId: string; lineKey: string }>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const lineControl of lineControls) {
    const hunkId = String(lineControl.hunkId || "").trim();
    const lineKey = String(lineControl.lineKey || "").trim();
    if (!hunkId || !lineKey) continue;
    if (!out[hunkId]) out[hunkId] = [];
    if (!out[hunkId]!.includes(lineKey)) out[hunkId]!.push(lineKey);
  }
  return out;
}

/**
 * 根据一组 changed line 的纳入状态规整块级控件状态。
 */
function resolveBlockSelectionState(
  lineControls: Array<{ included: boolean }>,
): PartialCommitDiffHunkControlState {
  const includedCount = lineControls.reduce((sum, lineControl) => sum + (lineControl.included ? 1 : 0), 0);
  if (includedCount <= 0) return "excluded";
  if (includedCount >= lineControls.length) return "full";
  return "partial";
}

/**
 * 根据 pure control model 计算当前视口真正需要渲染的 partial commit 叠层按钮。
 */
function buildPartialCommitOverlayButtons(args: {
  rootNode: HTMLDivElement;
  diffEditor: MonacoNS.editor.IStandaloneDiffEditor;
  controls: PartialCommitDiffControls | null | undefined;
  sideBySide: boolean;
  gt: GitTranslate;
}): MonacoPartialCommitOverlayButton[] {
  const { rootNode, diffEditor, controls, sideBySide, gt } = args;
  if (!controls || (controls.hunkControls.length === 0 && controls.lineControls.length === 0)) return [];

  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  const originalVisibleRange = resolveVisibleLineRange(originalEditor);
  const modifiedVisibleRange = resolveVisibleLineRange(modifiedEditor);
  const buttons: MonacoPartialCommitOverlayButton[] = [];

  const lineChanges = diffEditor.getLineChanges() || [];
  for (const lineChange of lineChanges) {
    const originalRange = normalizeChangeLineRange(lineChange.originalStartLineNumber, lineChange.originalEndLineNumber);
    const modifiedRange = normalizeChangeLineRange(lineChange.modifiedStartLineNumber, lineChange.modifiedEndLineNumber);
    const matchedLineControls = controls.lineControls.filter((lineControl) => {
      if (lineControl.side === "original") return isLineInsideChangeRange(lineControl.lineNumber, originalRange);
      return isLineInsideChangeRange(lineControl.lineNumber, modifiedRange);
    });
    if (matchedLineControls.length === 0) continue;

    const blockState = resolveBlockSelectionState(matchedLineControls);
    const anchorSide: PartialCommitDiffControlSide = modifiedRange ? "modified" : "original";
    const anchorLineNumber = anchorSide === "modified"
      ? modifiedRange!.start
      : originalRange!.start;
    const anchorEditor = sideBySide
      ? (anchorSide === "original" ? originalEditor : modifiedEditor)
      : modifiedEditor;
    const visibleRange = sideBySide
      ? (anchorSide === "original" ? originalVisibleRange : modifiedVisibleRange)
      : modifiedVisibleRange;
    if (!isLineVisible(visibleRange, anchorLineNumber)) continue;

    const top = resolveEditorAnchorTop({
      rootNode,
      editor: anchorEditor,
      lineNumber: anchorLineNumber,
    });
    const checkboxLeft = resolveEditorCheckboxLeft({
      rootNode,
      editor: anchorEditor,
      controlWidth: 16,
    });
    const lineKeysByHunkId = buildLineKeysByHunkId(matchedLineControls);
    if (top == null || checkboxLeft == null || Object.keys(lineKeysByHunkId).length === 0) continue;

    if (blockState !== "partial") {
      buttons.push({
        key: `block-checkbox:${anchorSide}:${anchorLineNumber}`,
        kind: "block-checkbox",
        left: checkboxLeft,
        top,
        state: blockState,
        side: anchorSide,
        lineKeysByHunkId,
        lineNumber: anchorLineNumber,
        title: blockState === "full"
          ? gt("diffViewer.partial.excludeBlock", "排除当前差异块（{{count}} 行）", { count: matchedLineControls.length })
          : gt("diffViewer.partial.includeBlock", "纳入当前差异块（{{count}} 行）", { count: matchedLineControls.length }),
      });
      continue;
    }

    for (const lineControl of matchedLineControls) {
      const lineEditor = sideBySide
        ? (lineControl.side === "original" ? originalEditor : modifiedEditor)
        : modifiedEditor;
      const lineVisibleRange = sideBySide
        ? (lineControl.side === "original" ? originalVisibleRange : modifiedVisibleRange)
        : modifiedVisibleRange;
      if (!isLineVisible(lineVisibleRange, lineControl.lineNumber)) continue;
      const lineTop = resolveEditorAnchorTop({
        rootNode,
        editor: lineEditor,
        lineNumber: lineControl.lineNumber,
      });
      const lineLeft = resolveEditorCheckboxLeft({
        rootNode,
        editor: lineEditor,
        controlWidth: 14,
      });
      if (lineTop == null || lineLeft == null) continue;
      buttons.push({
        key: `line-checkbox:${lineControl.key}`,
        kind: "line-checkbox",
        left: lineLeft,
        top: lineTop,
        state: lineControl.included ? "full" : "excluded",
        side: lineControl.side,
        hunkId: lineControl.hunkId,
        lineKey: lineControl.lineKey,
        lineNumber: lineControl.lineNumber,
        title: lineControl.included
          ? gt("diffViewer.partial.excludeLine", "排除当前改动行")
          : gt("diffViewer.partial.includeLine", "纳入当前改动行"),
      });
    }
  }

  return buttons;
}

/**
 * Monaco Diff 封装，支持统一/并排视图、未改动折叠、滚动同步、活动行高亮与 Diff 内 partial commit 交互。
 */
export default function MonacoGitDiff(props: MonacoGitDiffProps): JSX.Element {
  const { t } = useTranslation(["git", "common"]);
  const {
    diff,
    sideBySide,
    ignoreWhitespace,
    collapseUnchanged,
    modifiedEditable,
    onModifiedContentChange,
    activeLine,
    onChangedLines,
    lineDecorations,
    onSelectionChange,
    partialCommitControls,
    onPartialCommitBlockToggle,
    onPartialCommitLineToggle,
    onOpenInIde,
    onOpenInSystem,
    onExportPatch,
  } = props;
  const gt = useCallback((key: string, fallback: string, values?: Record<string, unknown>): string => {
    return resolveGitTextWith(t, key, fallback, values);
  }, [t]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const diffEditorRef = useRef<MonacoNS.editor.IStandaloneDiffEditor | null>(null);
  const monacoRef = useRef<typeof MonacoNS | null>(null);
  const lineListenerRef = useRef<MonacoNS.IDisposable | null>(null);
  const contentListenerRef = useRef<MonacoNS.IDisposable | null>(null);
  const decorationRef = useRef<MonacoNS.editor.IEditorDecorationsCollection | null>(null);
  const originalExcludedDecorationRef = useRef<MonacoNS.editor.IEditorDecorationsCollection | null>(null);
  const modifiedExcludedDecorationRef = useRef<MonacoNS.editor.IEditorDecorationsCollection | null>(null);
  const originalSelectionListenerRef = useRef<MonacoNS.IDisposable | null>(null);
  const modifiedSelectionListenerRef = useRef<MonacoNS.IDisposable | null>(null);
  const originalFocusListenerRef = useRef<MonacoNS.IDisposable | null>(null);
  const modifiedFocusListenerRef = useRef<MonacoNS.IDisposable | null>(null);
  const overlayListenerRefs = useRef<MonacoNS.IDisposable[]>([]);
  const overlayFrameRef = useRef<number | null>(null);
  const focusSideRef = useRef<GitDiffEditorSelection["focusSide"]>(null);
  const [overlayButtons, setOverlayButtons] = useState<MonacoPartialCommitOverlayButton[]>([]);

  const language = useMemo(() => detectLanguageId(String(diff?.path || "")), [diff?.path]);
  const original = useMemo(() => String(diff?.leftText || ""), [diff?.leftText]);
  const modified = useMemo(() => String(diff?.rightText || ""), [diff?.rightText]);
  const editorKey = useMemo(() => {
    return [
      String(diff?.mode || ""),
      String(diff?.path || ""),
      String(diff?.hash || ""),
      Array.isArray(diff?.hashes) ? diff?.hashes.join("|") : "",
    ].join("::");
  }, [diff?.hash, diff?.hashes, diff?.mode, diff?.path]);
  const theme = useMonacoTheme();

  /**
   * 把当前 Monaco 左右编辑器选区与光标行统一上报给父组件。
   */
  const emitSelectionChange = useCallback((): void => {
    if (!onSelectionChange) return;
    const editor = diffEditorRef.current;
    if (!editor) {
      onSelectionChange({
        focusSide: null,
        originalSelectedLines: [],
        modifiedSelectedLines: [],
      });
      return;
    }
    const originalEditor = editor.getOriginalEditor();
    const modifiedEditor = editor.getModifiedEditor();
    onSelectionChange({
      focusSide: focusSideRef.current,
      originalSelectedLines: collectSelectedLines(originalEditor),
      modifiedSelectedLines: collectSelectedLines(modifiedEditor),
      originalActiveLine: resolveActiveLine(originalEditor),
      modifiedActiveLine: resolveActiveLine(modifiedEditor),
    });
  }, [onSelectionChange]);

  /**
   * 当 Diff 计算完成后更新“变更行索引”。
   */
  const bindDiffLineListener = useCallback((): void => {
    lineListenerRef.current?.dispose();
    lineListenerRef.current = null;
    const editor = diffEditorRef.current;
    if (!editor) {
      onChangedLines([]);
      return;
    }
    const update = () => onChangedLines(collectChangedLines(editor));
    lineListenerRef.current = editor.onDidUpdateDiff(update);
    update();
  }, [onChangedLines]);

  /**
   * 绑定左右编辑器的选区/焦点监听，使 Git 面板能做 line 级 partial commit 动作。
   */
  const bindSelectionListeners = useCallback((): void => {
    originalSelectionListenerRef.current?.dispose();
    originalSelectionListenerRef.current = null;
    modifiedSelectionListenerRef.current?.dispose();
    modifiedSelectionListenerRef.current = null;
    originalFocusListenerRef.current?.dispose();
    originalFocusListenerRef.current = null;
    modifiedFocusListenerRef.current?.dispose();
    modifiedFocusListenerRef.current = null;
    const editor = diffEditorRef.current;
    if (!editor) {
      emitSelectionChange();
      return;
    }
    const originalEditor = editor.getOriginalEditor();
    const modifiedEditor = editor.getModifiedEditor();
    originalSelectionListenerRef.current = originalEditor.onDidChangeCursorSelection(() => {
      focusSideRef.current = "original";
      emitSelectionChange();
    });
    modifiedSelectionListenerRef.current = modifiedEditor.onDidChangeCursorSelection(() => {
      focusSideRef.current = "modified";
      emitSelectionChange();
    });
    originalFocusListenerRef.current = originalEditor.onDidFocusEditorText(() => {
      focusSideRef.current = "original";
      emitSelectionChange();
    });
    modifiedFocusListenerRef.current = modifiedEditor.onDidFocusEditorText(() => {
      focusSideRef.current = "modified";
      emitSelectionChange();
    });
    emitSelectionChange();
  }, [emitSelectionChange]);

  /**
   * 释放 partial commit 叠层监听，避免切换文件后残留滚动订阅。
   */
  const disposeOverlayListeners = useCallback((): void => {
    for (const listener of overlayListenerRefs.current) {
      listener.dispose();
    }
    overlayListenerRefs.current = [];
  }, []);

  /**
   * 根据当前视口重新计算 partial commit 叠层按钮的位置。
   */
  const updatePartialCommitOverlay = useCallback((): void => {
    const rootNode = rootRef.current;
    const editor = diffEditorRef.current;
    if (!rootNode || !editor) {
      setOverlayButtons([]);
      return;
    }
    const buttons = buildPartialCommitOverlayButtons({
      rootNode,
      diffEditor: editor,
      controls: partialCommitControls,
      sideBySide,
      gt,
    });
    setOverlayButtons(buttons);
  }, [gt, partialCommitControls, sideBySide]);

  /**
   * 用 rAF 节流叠层位置刷新，避免滚动时反复同步导致卡顿。
   */
  const schedulePartialCommitOverlayUpdate = useCallback((): void => {
    if (typeof window === "undefined") {
      updatePartialCommitOverlay();
      return;
    }
    if (overlayFrameRef.current != null) return;
    overlayFrameRef.current = window.requestAnimationFrame(() => {
      overlayFrameRef.current = null;
      updatePartialCommitOverlay();
    });
  }, [updatePartialCommitOverlay]);

  /**
   * 绑定 Diff/编辑器滚动与布局监听，使 gutter 复选框始终跟随 Monaco 视口。
   */
  const bindPartialCommitOverlayListeners = useCallback((): void => {
    disposeOverlayListeners();
    const editor = diffEditorRef.current;
    if (!editor) {
      setOverlayButtons([]);
      return;
    }
    const originalEditor = editor.getOriginalEditor();
    const modifiedEditor = editor.getModifiedEditor();
    overlayListenerRefs.current = [
      editor.onDidUpdateDiff(schedulePartialCommitOverlayUpdate),
      originalEditor.onDidScrollChange(schedulePartialCommitOverlayUpdate),
      modifiedEditor.onDidScrollChange(schedulePartialCommitOverlayUpdate),
      originalEditor.onDidLayoutChange(schedulePartialCommitOverlayUpdate),
      modifiedEditor.onDidLayoutChange(schedulePartialCommitOverlayUpdate),
    ];
    schedulePartialCommitOverlayUpdate();
  }, [disposeOverlayListeners, schedulePartialCommitOverlayUpdate]);

  /**
   * DiffEditor 挂载后初始化引用并绑定监听。
   */
  const onMount = useCallback((editor: MonacoNS.editor.IStandaloneDiffEditor, monaco: typeof MonacoNS): void => {
    diffEditorRef.current = editor;
    monacoRef.current = monaco;
    decorationRef.current = editor.getModifiedEditor().createDecorationsCollection();
    originalExcludedDecorationRef.current = editor.getOriginalEditor().createDecorationsCollection();
    modifiedExcludedDecorationRef.current = editor.getModifiedEditor().createDecorationsCollection();
    applyDiffEditorViewOptions(editor, sideBySide, ignoreWhitespace, collapseUnchanged);
    bindDiffLineListener();
    bindSelectionListeners();
    bindPartialCommitOverlayListeners();
    contentListenerRef.current?.dispose();
    contentListenerRef.current = editor.getModifiedEditor().onDidChangeModelContent(() => {
      if (!onModifiedContentChange) return;
      onModifiedContentChange(editor.getModifiedEditor().getValue());
    });
  }, [
    bindDiffLineListener,
    bindPartialCommitOverlayListeners,
    bindSelectionListeners,
    collapseUnchanged,
    ignoreWhitespace,
    onModifiedContentChange,
    sideBySide,
  ]);

  useEffect(() => {
    if (!diff) {
      onChangedLines([]);
      emitSelectionChange();
      setOverlayButtons([]);
      return;
    }
    bindDiffLineListener();
    bindSelectionListeners();
    bindPartialCommitOverlayListeners();
  }, [
    bindDiffLineListener,
    bindPartialCommitOverlayListeners,
    bindSelectionListeners,
    diff?.leftText,
    diff?.mode,
    diff?.path,
    diff?.rightText,
    emitSelectionChange,
    onChangedLines,
  ]);

  useEffect(() => {
    const editor = diffEditorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const collection = decorationRef.current || editor.getModifiedEditor().createDecorationsCollection();
    decorationRef.current = collection;
    if (activeLine < 0) {
      collection.clear();
      return;
    }
    const line = Math.max(1, activeLine + 1);
    collection.set([{
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: "cf-git-diff-active-line",
        linesDecorationsClassName: "cf-git-diff-active-line-margin",
      },
    }]);
    editor.getModifiedEditor().revealLineInCenter(line);
    schedulePartialCommitOverlayUpdate();
  }, [activeLine, schedulePartialCommitOverlayUpdate]);

  useEffect(() => {
    const editor = diffEditorRef.current;
    if (!editor) return;
    contentListenerRef.current?.dispose();
    contentListenerRef.current = editor.getModifiedEditor().onDidChangeModelContent(() => {
      if (!onModifiedContentChange) return;
      onModifiedContentChange(editor.getModifiedEditor().getValue());
    });
  }, [onModifiedContentChange]);

  /**
   * 把已排除的 changed line 渲染成显式 muted 装饰，帮助用户识别 line 级 partial 状态。
   */
  useEffect(() => {
    const editor = diffEditorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const originalCollection = originalExcludedDecorationRef.current || editor.getOriginalEditor().createDecorationsCollection();
    const modifiedCollection = modifiedExcludedDecorationRef.current || editor.getModifiedEditor().createDecorationsCollection();
    originalExcludedDecorationRef.current = originalCollection;
    modifiedExcludedDecorationRef.current = modifiedCollection;

    /**
     * 把排除的逻辑行号转换为 Monaco 整行装饰。
     */
    const buildDecorations = (lines: number[]): MonacoNS.editor.IModelDeltaDecoration[] => {
      return Array.from(new Set(lines.map((line) => Math.max(1, Math.floor(Number(line) || 0))).filter(Boolean))).map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: "cf-git-diff-excluded-line",
          linesDecorationsClassName: "cf-git-diff-excluded-line-margin",
        },
      }));
    };

    originalCollection.set(buildDecorations(lineDecorations?.excludedOriginalLines || []));
    modifiedCollection.set(buildDecorations(lineDecorations?.excludedModifiedLines || []));
    schedulePartialCommitOverlayUpdate();
  }, [lineDecorations?.excludedModifiedLines, lineDecorations?.excludedOriginalLines, schedulePartialCommitOverlayUpdate]);

  /**
   * 显式同步 DiffEditor 选项，修复 `hideUnchangedRegions` 在首次挂载后未即时生效的问题。
   */
  useEffect(() => {
    const editor = diffEditorRef.current;
    if (!editor) return;
    applyDiffEditorViewOptions(editor, sideBySide, ignoreWhitespace, collapseUnchanged);
    schedulePartialCommitOverlayUpdate();
    if (typeof window === "undefined") return;
    const rafId = window.requestAnimationFrame(() => {
      const currentEditor = diffEditorRef.current;
      if (!currentEditor) return;
      applyDiffEditorViewOptions(currentEditor, sideBySide, ignoreWhitespace, collapseUnchanged);
      schedulePartialCommitOverlayUpdate();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [collapseUnchanged, ignoreWhitespace, schedulePartialCommitOverlayUpdate, sideBySide, diff?.hash, diff?.leftText, diff?.mode, diff?.path, diff?.rightText]);

  /**
   * 亮暗主题切换后显式同步 Monaco 主题与布局，修复设置面板内切换主题时 DiffEditor 颜色未及时刷新的问题。
   */
  useEffect(() => {
    const editor = diffEditorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    monaco.editor.setTheme(theme);
    editor.layout();
    applyDiffEditorViewOptions(editor, sideBySide, ignoreWhitespace, collapseUnchanged);
    schedulePartialCommitOverlayUpdate();
    if (typeof window === "undefined") return;
    const rafId = window.requestAnimationFrame(() => {
      const currentEditor = diffEditorRef.current;
      const currentMonaco = monacoRef.current;
      if (!currentEditor || !currentMonaco) return;
      currentMonaco.editor.setTheme(theme);
      currentEditor.layout();
      applyDiffEditorViewOptions(currentEditor, sideBySide, ignoreWhitespace, collapseUnchanged);
      schedulePartialCommitOverlayUpdate();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [collapseUnchanged, ignoreWhitespace, schedulePartialCommitOverlayUpdate, sideBySide, theme]);

  useLayoutEffect(() => {
    schedulePartialCommitOverlayUpdate();
  }, [partialCommitControls, schedulePartialCommitOverlayUpdate, sideBySide, diff?.hash, diff?.path]);

  useEffect(() => {
    return () => {
      lineListenerRef.current?.dispose();
      lineListenerRef.current = null;
      contentListenerRef.current?.dispose();
      contentListenerRef.current = null;
      decorationRef.current?.clear();
      decorationRef.current = null;
      originalExcludedDecorationRef.current?.clear();
      originalExcludedDecorationRef.current = null;
      modifiedExcludedDecorationRef.current?.clear();
      modifiedExcludedDecorationRef.current = null;
      originalSelectionListenerRef.current?.dispose();
      originalSelectionListenerRef.current = null;
      modifiedSelectionListenerRef.current?.dispose();
      modifiedSelectionListenerRef.current = null;
      originalFocusListenerRef.current?.dispose();
      originalFocusListenerRef.current = null;
      modifiedFocusListenerRef.current?.dispose();
      modifiedFocusListenerRef.current = null;
      disposeOverlayListeners();
      if (overlayFrameRef.current != null && typeof window !== "undefined") {
        window.cancelAnimationFrame(overlayFrameRef.current);
        overlayFrameRef.current = null;
      }
      focusSideRef.current = null;
      diffEditorRef.current = null;
      monacoRef.current = null;
    };
  }, [disposeOverlayListeners]);

  /**
   * 渲染单个 partial commit 叠层按钮，并把点击语义映射回父组件。
   */
  const renderPartialCommitOverlayButton = useCallback((button: MonacoPartialCommitOverlayButton): JSX.Element => {
    const checkboxClassName = button.kind === "block-checkbox"
      ? "cf-git-diff-partial-control cf-git-diff-partial-checkbox"
      : "cf-git-diff-partial-control cf-git-diff-partial-line-checkbox";
    const lineHeight = diffEditorRef.current
      ? resolveEditorLineHeight(button.side === "original" ? diffEditorRef.current.getOriginalEditor() : diffEditorRef.current.getModifiedEditor())
      : 18;
    return (
      <button
        key={button.key}
        type="button"
        className={checkboxClassName}
        data-state={button.state}
        style={{
          left: `${button.left}px`,
          top: `${button.top - (lineHeight / 2)}px`,
        }}
        title={button.title}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (button.kind === "line-checkbox") {
            if (!button.hunkId || !button.lineKey) return;
            onPartialCommitLineToggle?.(button.hunkId, button.lineKey, button.state !== "full", button.lineNumber);
            return;
          }
          if (!button.lineKeysByHunkId) return;
          onPartialCommitBlockToggle?.(button.lineKeysByHunkId, button.state !== "full", button.lineNumber);
        }}
      >
        <span className="cf-git-diff-partial-checkbox-mark" />
      </button>
    );
  }, [onPartialCommitBlockToggle, onPartialCommitLineToggle]);

  if (!diff) return <div className="cf-git-diff-placeholder h-full w-full p-6 text-sm text-[var(--cf-text-secondary)]">{gt("diffViewer.empty", "请选择变更文件以查看差异。")}</div>;
  if (diff.isBinary) {
    return (
      <div className="cf-git-diff-placeholder flex h-full w-full items-center justify-center p-6">
        <div className="w-full max-w-[520px] rounded-apple-lg border border-[var(--cf-border)] bg-[var(--cf-surface-muted)] px-5 py-4 text-sm text-[var(--cf-text-secondary)]">
          <div className="text-sm font-medium text-[var(--cf-text-primary)]">
            {diff.tooLarge
              ? gt("diffViewer.tooLarge", "文件过大，暂不支持预览。")
              : gt("diffViewer.binary", "二进制文件无法预览。")}
          </div>
          <div className="mt-2 text-xs leading-5">
            {gt("diffViewer.fallbackHint", "你可以改用外部 IDE、系统默认程序，或直接导出当前比较视图的补丁。")}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {onOpenInIde ? (
              <Button size="xs" variant="secondary" onClick={onOpenInIde}>
                {gt("diffViewer.actions.openInIde", "在外部 IDE 中打开")}
              </Button>
            ) : null}
            {onOpenInSystem ? (
              <Button size="xs" variant="secondary" onClick={onOpenInSystem}>
                {gt("diffViewer.actions.openInSystem", "使用系统程序打开")}
              </Button>
            ) : null}
            {onExportPatch ? (
              <Button size="xs" onClick={onExportPatch}>
                {gt("diffViewer.actions.exportPatch", "导出补丁")}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="cf-git-diff-viewer relative h-full w-full border-t border-[var(--cf-border)]">
      <DiffEditor
        key={editorKey}
        height="100%"
        language={language}
        original={original}
        modified={modified}
        theme={theme}
        onMount={onMount}
        options={{
          readOnly: !modifiedEditable,
          originalEditable: false,
          glyphMargin: true,
          renderMarginRevertIcon: false,
          enableSplitViewResizing: true,
          smoothScrolling: true,
          scrollBeyondLastLine: false,
          renderOverviewRuler: true,
          lineNumbers: "on",
          minimap: { enabled: false },
          wordWrap: "off",
          ...buildDiffEditorViewOptions(sideBySide, ignoreWhitespace, collapseUnchanged),
        }}
      />
      {overlayButtons.length > 0 ? (
        <div className="cf-git-diff-partial-overlay">
          {overlayButtons.map((button) => renderPartialCommitOverlayButton(button))}
        </div>
      ) : null}
    </div>
  );
}
