// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type * as MonacoNS from "monaco-editor";

/** 为 Git 比对编辑器绑定复制快捷键，复用原生命令并随编辑器销毁释放。 */
export function bindGitEditorCopyAction(
  editor: MonacoNS.editor.IStandaloneCodeEditor,
  monaco: typeof MonacoNS,
  label: string,
): MonacoNS.IDisposable {
  // 浏览器版 Monaco 依赖原生菜单提供快捷键，Electron 无编辑菜单时需要显式绑定。
  const action = editor.addAction({
    id: "codexflow.git.copy",
    label,
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC],
    precondition: "editorTextFocus",
    /** 保留多选区、整行复制以及剪贴板元数据等原有行为。 */
    run: (focusedEditor) => focusedEditor.trigger("keyboard", "editor.action.clipboardCopyAction", null),
  });
  let disposed = false;
  let listener: MonacoNS.IDisposable | undefined;
  /** 兼容父组件清理和编辑器销毁的不同顺序，每个绑定只释放一次。 */
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    action.dispose();
    listener?.dispose();
  };
  listener = editor.onDidDispose(dispose);
  return { dispose };
}
