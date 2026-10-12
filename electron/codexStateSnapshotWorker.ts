// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { readCodexStateSnapshot } from "./codexStateSnapshot";

/** 只读恢复官方摘要；异常时返回空结果，常规索引继续负责补齐。 */
function main(task: { roots?: string[] }): void {
  let entries: ReturnType<typeof readCodexStateSnapshot> = [];
  try {
    entries = readCodexStateSnapshot(task.roots || []);
  } catch {}
  process.send?.({ entries }, () => { if (process.connected) process.disconnect(); });
}

process.once("message", main);
