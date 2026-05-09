// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { buildConflictMergeMetadata } from "../../../../../electron/git/commitPanel/conflictMergeMetadata";
import { setConflictMergeSemanticResolversForTesting } from "../../../../../electron/git/commitPanel/conflictMergeSemantic";
import type { GitConflictMergeSnapshot } from "../types";
import {
  applyConflictMergeBlockResolution,
  canResolveConflictMergeBlockAutomatically,
  createConflictMergeViewerState,
} from "./conflict-merge-model";
import { ConflictMergeThreeWayEditor } from "./conflict-merge-three-way-editor";

const decorationSetCalls: Array<unknown[]> = [];
const revealLineInCenterCalls: number[] = [];
const revealLineInCenterIfOutsideViewportCalls: number[] = [];

vi.mock("monaco-editor", () => {
  class Range {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;

    /**
     * 提供 Monaco `Range` 的最小测试桩，满足 gutter/装饰相关逻辑的行列字段读取。
     */
    constructor(startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) {
      this.startLineNumber = startLineNumber;
      this.startColumn = startColumn;
      this.endLineNumber = endLineNumber;
      this.endColumn = endColumn;
    }
  }

  return {
    Range,
    editor: {
      OverviewRulerLane: {
        Full: 2,
      },
    },
  };
});

vi.mock("@monaco-editor/react", async () => {
  const React = await import("react");
  const monaco = await import("monaco-editor");

  /**
   * 创建 Monaco editor 的最小测试桩，让 three-way editor 可以在 jsdom 中生成 gutter controls。
   */
  function createEditorStub(args: {
    hostRef: React.RefObject<HTMLDivElement>;
    valueRef: React.MutableRefObject<string>;
  }): Record<string, unknown> {
    let scrollTop = 0;

    /**
     * 按 merge viewer 的逻辑行口径返回当前文本行数，供可视区与 reveal 计算复用。
     */
    const getLineCount = (): number => {
      const source = String(args.valueRef.current || "");
      if (!source) return 1;
      return source.endsWith("\n") ? source.split("\n").length - 1 : source.split("\n").length;
    };

    /**
     * 生成可释放的监听句柄，避免测试卸载时残留无效回调。
     */
    const createDisposable = () => ({
      dispose() {},
    });

    return {
      getVisibleRanges() {
        return [{
          startLineNumber: 1,
          endLineNumber: getLineCount(),
        }];
      },
      getModel() {
        return {
          getLineCount,
        };
      },
      getDomNode() {
        return args.hostRef.current;
      },
      getScrolledVisiblePosition(position: { lineNumber: number }) {
        return {
          top: Math.max(0, (Math.max(1, position.lineNumber) - 1) * 20),
          height: 20,
          left: 0,
        };
      },
      getTopForLineNumber(lineNumber: number) {
        return Math.max(0, (Math.max(1, lineNumber) - 1) * 20);
      },
      getScrollTop() {
        return scrollTop;
      },
      setScrollTop(nextScrollTop: number) {
        scrollTop = Math.max(0, Number(nextScrollTop) || 0);
      },
      createDecorationsCollection() {
        return {
          set(nextDecorations: unknown[]) {
            decorationSetCalls.push(nextDecorations);
          },
          clear() {},
        };
      },
      onDidScrollChange() {
        return createDisposable();
      },
      onDidLayoutChange() {
        return createDisposable();
      },
      setHiddenAreas() {},
      revealLineInCenter(lineNumber: number) {
        revealLineInCenterCalls.push(lineNumber);
      },
      revealLineInCenterIfOutsideViewport(lineNumber: number) {
        revealLineInCenterIfOutsideViewportCalls.push(lineNumber);
      },
    };
  }

  return {
    loader: {
      config: () => {},
    },
    Editor: (props: {
      value?: string;
      options?: { readOnly?: boolean };
      onChange?: (value?: string) => void;
      onMount?: (editor: any, monacoNs: typeof monaco) => void;
    }) => {
      const hostRef = React.useRef<HTMLDivElement>(null);
      const valueRef = React.useRef<string>(props.value || "");
      valueRef.current = props.value || "";
      const editorRef = React.useRef<Record<string, unknown> | null>(null);
      if (!editorRef.current) {
        editorRef.current = createEditorStub({
          hostRef,
          valueRef,
        });
      }

      React.useEffect(() => {
        props.onMount?.(editorRef.current, monaco);
      }, []);

      return (
        <div ref={hostRef} className="h-full min-h-0 w-full">
          {props.options?.readOnly
            ? <pre>{props.value || ""}</pre>
            : (
              <textarea
                data-testid="three-way-editor-result"
                value={props.value || ""}
                onChange={(event) => props.onChange?.(event.target.value)}
              />
            )}
        </div>
      );
    },
  };
});

/**
 * 启用 React 18 的 act 环境标记，避免测试输出无关告警。
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 同步执行 rAF，确保 gutter overlay 在测试中可立即稳定渲染。
 */
function installSyncRequestAnimationFrame(): () => void {
  const originalRaf = (window as any).requestAnimationFrame as ((cb: FrameRequestCallback) => number) | undefined;
  const originalCancel = (window as any).cancelAnimationFrame as ((id: number) => void) | undefined;
  let seq = 0;
  (window as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
    seq += 1;
    cb(0);
    return seq;
  };
  (window as any).cancelAnimationFrame = () => {};
  return () => {
    (window as any).requestAnimationFrame = originalRaf;
    (window as any).cancelAnimationFrame = originalCancel;
  };
}

/**
 * 构造最小语义冲突快照，供 three-way editor 的 magic resolve 入口测试复用。
 */
function createSemanticSnapshot(): GitConflictMergeSnapshot {
  return {
    path: "src/semantic.ts",
    base: { label: "基线", text: "const value = createBaseNode();\n", available: true },
    ours: { label: "你的更改", text: "const value = createLeftNode();\n", available: true },
    theirs: { label: "他们的更改", text: "const value = createRightNode();\n", available: true },
    working: {
      label: "结果",
      text: "<<<<<<< ours\nconst value = createLeftNode();\n=======\nconst value = createRightNode();\n>>>>>>> theirs\n",
      available: true,
    },
    merge: buildConflictMergeMetadata({
      path: "src/semantic.ts",
      baseText: "const value = createBaseNode();\n",
      oursText: "const value = createLeftNode();\n",
      theirsText: "const value = createRightNode();\n",
    }),
  };
}

/**
 * 构造真实 `.properties` semantic 冲突快照，供中缝 magic resolve 验证内建 resolver 已接入现有入口。
 */
function createPropertiesSemanticSnapshot(): GitConflictMergeSnapshot {
  return {
    path: "src/messages.properties",
    base: { label: "基线", text: "", available: true },
    ours: { label: "你的更改", text: "left.key = left value\n", available: true },
    theirs: { label: "他们的更改", text: "right.key = right value\n", available: true },
    working: {
      label: "结果",
      text: "<<<<<<< ours\nleft.key = left value\n=======\nright.key = right value\n>>>>>>> theirs\n",
      available: true,
    },
    merge: buildConflictMergeMetadata({
      path: "src/messages.properties",
      baseText: "",
      oursText: "left.key = left value\n",
      theirsText: "right.key = right value\n",
    }),
  };
}

/**
 * 构造包含两个块的冲突快照，供强制滚动到指定块的行为测试复用。
 */
function createTwoBlockSnapshot(): GitConflictMergeSnapshot {
  return {
    path: "src/two-blocks.ts",
    base: { label: "基线", text: "head\nbase-one\nmid\nbase-two\ntail\n", available: true },
    ours: { label: "你的更改", text: "head\nours-one\nmid\nours-two\ntail\n", available: true },
    theirs: { label: "他们的更改", text: "head\ntheirs-one\nmid\nbase-two\ntail\n", available: true },
    working: {
      label: "结果",
      text: "<<<<<<< ours\nours-one\n=======\ntheirs-one\n>>>>>>> theirs\nmid\nbase-two\ntail\n",
      available: true,
    },
    merge: buildConflictMergeMetadata({
      path: "src/two-blocks.ts",
      baseText: "head\nbase-one\nmid\nbase-two\ntail\n",
      oursText: "head\nours-one\nmid\nours-two\ntail\n",
      theirsText: "head\ntheirs-one\nmid\nbase-two\ntail\n",
    }),
  };
}

/**
 * 创建并挂载测试根节点，供 three-way editor 渲染与事件派发复用。
 */
function createMountedRoot(): { host: HTMLDivElement; root: Root; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return {
    host,
    root,
    unmount: () => {
      try {
        act(() => {
          root.unmount();
        });
      } catch {
        try { root.unmount(); } catch {}
      }
      try { host.remove(); } catch {}
    },
  };
}

/**
 * 按 data-testid 读取节点，缺失时直接抛错，便于定位 gutter 入口未生成的问题。
 */
function getByTestId<T extends HTMLElement>(id: string): T {
  const element = document.querySelector(`[data-testid="${id}"]`);
  if (!element) throw new Error(`missing element data-testid=${id}`);
  return element as T;
}

afterEach(() => {
  setConflictMergeSemanticResolversForTesting(null);
  decorationSetCalls.length = 0;
  revealLineInCenterCalls.length = 0;
  revealLineInCenterIfOutsideViewportCalls.length = 0;
});

describe("ConflictMergeThreeWayEditor", () => {
  it("应为可自动解决的 conflict 渲染 magic resolve gutter 按钮，并回调到统一入口", async () => {
    const restoreRaf = installSyncRequestAnimationFrame();
    setConflictMergeSemanticResolversForTesting([{
      id: "three-way-semantic-fixture",
      isApplicable(filePath) {
        return filePath.endsWith(".ts");
      },
      resolve() {
        return "const value = buildSemanticMerged();\n";
      },
    }]);
    const snapshot = createSemanticSnapshot();
    const state = createConflictMergeViewerState(snapshot);
    const onAutoResolveBlock = vi.fn();
    const mounted = createMountedRoot();

    try {
      await act(async () => {
        mounted.root.render(
          <ConflictMergeThreeWayEditor
            language="typescript"
            saving={false}
            busy={false}
            collapseUnchanged={true}
            leftPane={{
              label: snapshot.ours.label,
              text: snapshot.ours.text,
              renderable: true,
              fallbackText: "",
            }}
            rightPane={{
              label: snapshot.theirs.label,
              text: snapshot.theirs.text,
              renderable: true,
              fallbackText: "",
            }}
            resultLabel="结果"
            resultText={state.resultText}
            blocks={state.blocks}
            selectedBlock={state.blocks[0] || null}
            canAutoResolveBlock={canResolveConflictMergeBlockAutomatically}
            onAutoResolveBlock={onAutoResolveBlock}
            onResultTextChange={() => {}}
          />,
        );
      });

      expect(getByTestId<HTMLDivElement>("conflict-merge-gutter-overlay")).toBeTruthy();
      await act(async () => {
        getByTestId<HTMLButtonElement>("conflict-gutter-resolve-0").click();
      });
      expect(onAutoResolveBlock).toHaveBeenCalledWith(0);
    } finally {
      restoreRaf();
      mounted.unmount();
    }
  });

  it("真实 .properties semantic 块也应渲染 magic resolve gutter 按钮", async () => {
    const restoreRaf = installSyncRequestAnimationFrame();
    const snapshot = createPropertiesSemanticSnapshot();
    const state = createConflictMergeViewerState(snapshot);
    const onAutoResolveBlock = vi.fn();
    const mounted = createMountedRoot();

    try {
      await act(async () => {
        mounted.root.render(
          <ConflictMergeThreeWayEditor
            language="properties"
            saving={false}
            busy={false}
            collapseUnchanged={true}
            leftPane={{
              label: snapshot.ours.label,
              text: snapshot.ours.text,
              renderable: true,
              fallbackText: "",
            }}
            rightPane={{
              label: snapshot.theirs.label,
              text: snapshot.theirs.text,
              renderable: true,
              fallbackText: "",
            }}
            resultLabel="结果"
            resultText={state.resultText}
            blocks={state.blocks}
            selectedBlock={state.blocks[0] || null}
            canAutoResolveBlock={canResolveConflictMergeBlockAutomatically}
            onAutoResolveBlock={onAutoResolveBlock}
            onResultTextChange={() => {}}
          />,
        );
      });

      expect(getByTestId<HTMLDivElement>("conflict-merge-gutter-overlay")).toBeTruthy();
      await act(async () => {
        getByTestId<HTMLButtonElement>("conflict-gutter-resolve-0").click();
      });
      expect(onAutoResolveBlock).toHaveBeenCalledWith(0);
    } finally {
      restoreRaf();
      mounted.unmount();
    }
  });

  it("busy 状态下应隐藏 magic resolve gutter 按钮", async () => {
    const restoreRaf = installSyncRequestAnimationFrame();
    const snapshot = createPropertiesSemanticSnapshot();
    const state = createConflictMergeViewerState(snapshot);
    const mounted = createMountedRoot();

    try {
      await act(async () => {
        mounted.root.render(
          <ConflictMergeThreeWayEditor
            language="properties"
            saving={true}
            busy={true}
            collapseUnchanged={true}
            leftPane={{
              label: snapshot.ours.label,
              text: snapshot.ours.text,
              renderable: true,
              fallbackText: "",
            }}
            rightPane={{
              label: snapshot.theirs.label,
              text: snapshot.theirs.text,
              renderable: true,
              fallbackText: "",
            }}
            resultLabel="结果"
            resultText={state.resultText}
            blocks={state.blocks}
            selectedBlock={state.blocks[0] || null}
            canAutoResolveBlock={canResolveConflictMergeBlockAutomatically}
            onAutoResolveBlock={() => {}}
            onResultTextChange={() => {}}
          />,
        );
      });

      expect(document.querySelector("[data-testid=\"conflict-gutter-resolve-0\"]")).toBeNull();
    } finally {
      restoreRaf();
      mounted.unmount();
    }
  });

  it("收到强制滚动请求时应把目标块居中到视口", async () => {
    const restoreRaf = installSyncRequestAnimationFrame();
    const snapshot = createTwoBlockSnapshot();
    const state = createConflictMergeViewerState(snapshot);
    const mounted = createMountedRoot();

    try {
      await act(async () => {
        mounted.root.render(
          <ConflictMergeThreeWayEditor
            language="typescript"
            saving={false}
            busy={false}
            collapseUnchanged={true}
            leftPane={{
              label: snapshot.ours.label,
              text: snapshot.ours.text,
              renderable: true,
              fallbackText: "",
            }}
            rightPane={{
              label: snapshot.theirs.label,
              text: snapshot.theirs.text,
              renderable: true,
              fallbackText: "",
            }}
            resultLabel="结果"
            resultText={state.resultText}
            blocks={state.blocks}
            selectedBlock={state.blocks[0] || null}
            scrollRequest={{ blockIndex: state.blocks[1].index, force: true }}
            onResultTextChange={() => {}}
          />,
        );
      });

      expect(revealLineInCenterCalls).toContain(state.blocks[1].resultRange?.startLine);
    } finally {
      restoreRaf();
      mounted.unmount();
    }
  });

  it("已解决块应切换为 resolved decoration，而不是继续保留未解决填充块", async () => {
    const restoreRaf = installSyncRequestAnimationFrame();
    const snapshot = createSemanticSnapshot();
    const initialState = createConflictMergeViewerState(snapshot);
    const resolvedState = applyConflictMergeBlockResolution(
      applyConflictMergeBlockResolution(initialState, 0, "ours"),
      0,
      "theirs",
    );
    const mounted = createMountedRoot();

    try {
      await act(async () => {
        mounted.root.render(
          <ConflictMergeThreeWayEditor
            language="typescript"
            saving={false}
            busy={false}
            collapseUnchanged={true}
            leftPane={{
              label: snapshot.ours.label,
              text: snapshot.ours.text,
              renderable: true,
              fallbackText: "",
            }}
            rightPane={{
              label: snapshot.theirs.label,
              text: snapshot.theirs.text,
              renderable: true,
              fallbackText: "",
            }}
            resultLabel="结果"
            resultText={resolvedState.resultText}
            blocks={resolvedState.blocks}
            selectedBlock={null}
            onResultTextChange={() => {}}
          />,
        );
      });

      const allDecorations = decorationSetCalls.flat();
      expect(allDecorations.some((item: any) => [
        "cf-git-merge-resolved-single-line",
        "cf-git-merge-resolved-start-line",
        "cf-git-merge-resolved-end-line",
      ].includes(item?.options?.className))).toBe(true);
      expect(allDecorations.some((item: any) => [
        "cf-git-merge-source-resolved-single-line",
        "cf-git-merge-source-resolved-start-line",
        "cf-git-merge-source-resolved-end-line",
      ].includes(item?.options?.className))).toBe(true);
    } finally {
      restoreRaf();
      mounted.unmount();
    }
  });
});
