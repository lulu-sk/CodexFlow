// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TypeScriptWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

type MonacoWorkerEnvironment = {
  getWorker(moduleId: string, label: string): Worker;
};

type MonacoWorkerGlobal = typeof globalThis & {
  MonacoEnvironment?: MonacoWorkerEnvironment;
};

/**
 * 根据 Monaco 的语言标签创建对应 worker，避免打包版退回主线程执行语言服务。
 */
function createMonacoWorker(label: string): Worker {
  if (label === "json") return new JsonWorker();
  if (label === "css" || label === "scss" || label === "less") return new CssWorker();
  if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
  if (label === "typescript" || label === "javascript") return new TypeScriptWorker();
  return new EditorWorker();
}

/**
 * 安装 Monaco worker 工厂；Vite 会把 worker 输出为相对资源，适配 Electron file:// 打包路径。
 */
export function installMonacoWorkers(): void {
  const target = globalThis as MonacoWorkerGlobal;
  if (target.MonacoEnvironment?.getWorker) return;
  target.MonacoEnvironment = {
    getWorker(_moduleId: string, label: string): Worker {
      return createMonacoWorker(label);
    },
  };
}

installMonacoWorkers();
