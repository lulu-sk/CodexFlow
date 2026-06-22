// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { GitLogItem } from "../types";
import { buildGitLogVisiblePack } from "./visible-pack";

type GitLogVisiblePackWorkerRequest = {
  requestId: number;
  items: GitLogItem[];
  graphItems?: GitLogItem[];
  fileHistoryMode: boolean;
};

type GitLogVisiblePackWorkerResponse =
  | {
      ok: true;
      requestId: number;
      pack: ReturnType<typeof buildGitLogVisiblePack>;
      durationMs: number;
    }
  | {
      ok: false;
      requestId: number;
      error: string;
      durationMs: number;
    };

/**
 * 在 Worker 线程构建 Git 日志图谱，避免 React 渲染线程被大列表同步计算堵住。
 */
self.onmessage = (event: MessageEvent<GitLogVisiblePackWorkerRequest>) => {
  const request = event.data;
  const startedAt = Date.now();
  try {
    const pack = buildGitLogVisiblePack({
      items: Array.isArray(request.items) ? request.items : [],
      graphItems: Array.isArray(request.graphItems) ? request.graphItems : undefined,
      fileHistoryMode: request.fileHistoryMode === true,
      emitRuntimeProbe: false,
    });
    const response: GitLogVisiblePackWorkerResponse = {
      ok: true,
      requestId: Math.max(0, Math.floor(Number(request.requestId) || 0)),
      pack,
      durationMs: Date.now() - startedAt,
    };
    self.postMessage(response);
  } catch (error: any) {
    const response: GitLogVisiblePackWorkerResponse = {
      ok: false,
      requestId: Math.max(0, Math.floor(Number(request.requestId) || 0)),
      error: String(error?.message || error),
      durationMs: Date.now() - startedAt,
    };
    self.postMessage(response);
  }
};
