// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { parentPort, workerData } from "node:worker_threads";
import { cleanupCodexStateForDeletedHistoryFiles, repairMissingCodexRolloutRows } from "./codexStateCleanup";

type CleanupWorkerTask =
  | { kind: "cleanupDeleted"; filePaths?: string[] }
  | { kind: "repairMissing" };

/**
 * 执行 Codex sqlite 清理 worker 任务。
 */
async function runCleanupWorkerTask(task: CleanupWorkerTask): Promise<unknown> {
  if (task?.kind === "cleanupDeleted") {
    return await cleanupCodexStateForDeletedHistoryFiles(Array.isArray(task.filePaths) ? task.filePaths : [], {
      repairMissingRollouts: false,
    });
  }
  if (task?.kind === "repairMissing")
    return await repairMissingCodexRolloutRows();
  throw new Error(`unknown codex cleanup task: ${String((task as any)?.kind || "")}`);
}

/**
 * 启动 worker 主流程，并把结果发送回主进程。
 */
async function main(): Promise<void> {
  try {
    const result = await runCleanupWorkerTask(workerData as CleanupWorkerTask);
    parentPort?.postMessage({ ok: true, result });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: String((error as any)?.stack || (error as any)?.message || error),
    });
  }
}

void main();
