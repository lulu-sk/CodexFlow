// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanupDetachedHistoryPath,
  detachHistoryPath,
  isHistoryDeleteStagingName,
  readHistoryDeleteQueue,
} from "./historyFastDelete";

describe("electron/historyFastDelete", () => {
  it("先持久化队列并摘除文件，重启读取队列后可继续清理", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-history-delete-"));
    const filePath = path.join(root, "session.jsonl");
    const queueDirectory = path.join(root, "queue");
    try {
      await fsp.writeFile(filePath, "session", "utf8");
      const result = await detachHistoryPath(
        { filePath, recursive: false },
        { queueDirectory },
      );

      expect(result.ok).toBe(true);
      expect(result.queuedCleanup?.filePath).toBeTruthy();
      expect(isHistoryDeleteStagingName(path.basename(result.queuedCleanup?.filePath || ""))).toBe(true);
      await expect(fsp.stat(filePath)).rejects.toThrow();

      const recovered = await readHistoryDeleteQueue(queueDirectory);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        filePath: result.queuedCleanup?.filePath,
        recursive: false,
      });
      await cleanupDetachedHistoryPath(recovered[0]);
      await expect(fsp.stat(recovered[0].filePath)).rejects.toThrow();
      await expect(readHistoryDeleteQueue(queueDirectory)).resolves.toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("原路径无法改名时返回失败且不遗留清理记录", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-history-delete-failed-"));
    const queueDirectory = path.join(root, "queue");
    try {
      const result = await detachHistoryPath(
        { filePath: path.join(root, "missing.jsonl"), recursive: false },
        { queueDirectory },
      );

      expect(result.ok).toBe(false);
      expect(result.queuedCleanup).toBeUndefined();
      await expect(readHistoryDeleteQueue(queueDirectory)).resolves.toEqual([]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
