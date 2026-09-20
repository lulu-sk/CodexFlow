// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type * as MonacoNS from "monaco-editor";
import MonacoGitDiff from "./monaco-git-diff";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  /** 返回可释放的空订阅，供不参与本测试的布局监听使用。 */
  const subscribe = () => ({ dispose: vi.fn() });
  /** 模拟单侧编辑器，记录注册的动作及其释放过程。 */
  const createSide = () => ({
    addAction: vi.fn((_action: MonacoNS.editor.IActionDescriptor) => ({ dispose: vi.fn() })),
    trigger: vi.fn(),
    getSelections: () => [],
    getSelection: () => null,
    createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() }),
    onDidChangeCursorSelection: subscribe,
    onDidFocusEditorText: subscribe,
    onDidChangeModelContent: subscribe,
    onDidScrollChange: subscribe,
    onDidLayoutChange: subscribe,
    onDidDispose: vi.fn((_listener: () => void) => subscribe()),
  });
  return {
    subscribe,
    createSide,
    translate: (key: string) => key,
    sides: [] as Array<ReturnType<typeof createSide>>,
    monaco: {
      KeyMod: { CtrlCmd: 2048 },
      KeyCode: { KeyC: 33 },
      Uri: { parse: (value: string) => value },
      editor: { getModel: () => null, setTheme: vi.fn() },
    },
  };
});

vi.mock("monaco-editor", () => mocks.monaco);
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.translate }) }));
vi.mock("@monaco-editor/react", () => ({
  loader: { config: vi.fn() },
  /** 模拟真实包装器按 key 重建编辑器并触发挂载回调。 */
  DiffEditor: (props: { onMount: (...args: any[]) => void }) => {
    React.useEffect(() => {
      const original = mocks.createSide();
      const modified = mocks.createSide();
      mocks.sides.push(original, modified);
      props.onMount({
        getOriginalEditor: () => original,
        getModifiedEditor: () => modified,
        getLineChanges: () => [],
        getModel: () => null,
        updateOptions: vi.fn(),
        layout: vi.fn(),
        onDidUpdateDiff: mocks.subscribe,
      }, mocks.monaco);
    }, []);
    return null;
  },
}));

/** 保持父组件回调稳定，避免无关的选区、布局重新订阅。 */
function handleChangedLines(): void {}

describe("Git 比对复制快捷键", () => {
  it("左右只读编辑器应调用原生复制动作，切换文件和卸载时释放旧绑定", async () => {
    mocks.sides.length = 0;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    /** 按文件路径重建比对实例，模拟用户切换文件。 */
    const renderDiff = async (path: string): Promise<void> => {
      await act(async () => {
        root.render(<MonacoGitDiff
          diff={{ path, mode: "working", isBinary: false, leftText: "原文🙂", rightText: "修改🚀", leftTitle: "HEAD", rightTitle: "Working Tree" }}
          sideBySide={true}
          ignoreWhitespace={false}
          collapseUnchanged={false}
          activeLine={-1}
          onChangedLines={handleChangedLines}
        />);
      });
    };
    try {
      await renderDiff("first.txt");
      expect(mocks.sides).toHaveLength(2);
      for (const side of mocks.sides) {
        const action = side.addAction.mock.calls[0][0];
        expect(action.keybindings).toEqual([2048 | 33]);
        expect(action.precondition).toBe("editorTextFocus");
        await action.run(side as unknown as MonacoNS.editor.IStandaloneCodeEditor);
        expect(side.trigger).toHaveBeenCalledWith("keyboard", "editor.action.clipboardCopyAction", null);
        // 编辑器可能先于父组件销毁，之后父组件再次清理不能重复释放。
        side.onDidDispose.mock.calls[0][0]();
        expect(side.addAction.mock.results[0].value.dispose).toHaveBeenCalledTimes(1);
      }
      await renderDiff("second.txt");
      expect(mocks.sides).toHaveLength(4);
      for (const side of mocks.sides.slice(0, 2))
        expect(side.addAction.mock.results[0].value.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
    for (const side of mocks.sides.slice(2))
      expect(side.addAction.mock.results[0].value.dispose).toHaveBeenCalledTimes(1);
  });
});
