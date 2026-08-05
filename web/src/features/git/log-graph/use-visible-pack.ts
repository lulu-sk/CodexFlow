// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { GitLogItem } from "../types";
import {
  buildGitLogVisiblePack,
  buildGitLogVisiblePlaceholderPack,
  type GitLogVisiblePack,
} from "./visible-pack";

const GIT_LOG_GRAPH_WORKER_TIMEOUT_MS = 2500;
const GIT_LOG_GRAPH_SYNC_BUILD_LIMIT = 80;
const GIT_LOG_GRAPH_LIGHT_MODE_TTL_MS = 60_000;
const GIT_LOG_GRAPH_WORKER_FAILURE_RETRY_MS = 10_000;
const GIT_LOG_GRAPH_LIGHT_MODE_EVENT = "cf:renderer-light-mode";

type GitLogVisiblePackWorkerResponse = {
  ok: boolean;
  requestId: number;
  pack?: GitLogVisiblePack;
  error?: string;
  durationMs?: number;
};

type RendererLightModeEvent = CustomEvent<{ reason?: string; durationMs?: number }>;

/**
 * 为图谱输入生成轻量签名，用于避免无意义地重建 Worker 任务。
 */
function buildGitLogVisiblePackSignature(
  items: GitLogItem[],
  graphItems: GitLogItem[] | undefined,
  fileHistoryMode: boolean,
): string {
  /**
   * 将图谱布局实际依赖的提交字段编码为稳定签名片段。
   */
  const serialize = (source: GitLogItem[] | undefined): string => (source || []).map((item) => [
    String(item.hash || ""),
    Array.isArray(item.parents) ? item.parents.join(",") : "",
    String(item.decorations || ""),
  ].join("\u0001")).join("\u0002");
  return [
    fileHistoryMode ? "file" : "log",
    serialize(items),
    serialize(graphItems),
  ].join("|");
}

/**
 * 创建 Git 图谱 Worker；失败时返回 null，由调用方回落到同步小任务或占位图谱。
 */
function createGitLogVisiblePackWorker(): Worker | null {
  try {
    return new Worker(new URL("./visible-pack-worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

/**
 * 判断当前是否应使用轻量模式，长任务刚发生时暂停重图谱计算一小段时间。
 */
function isGitLogGraphLightModeActive(untilRef: MutableRefObject<number>): boolean {
  return Date.now() < untilRef.current;
}

/**
 * 异步构建 Git 日志可见图谱包，避免大仓库日志在 React render 阶段同步阻塞 UI。
 */
export function useGitLogVisiblePack(args: {
  items: GitLogItem[];
  graphItems?: GitLogItem[];
  fileHistoryMode: boolean;
}): GitLogVisiblePack {
  const items = Array.isArray(args.items) ? args.items : [];
  const graphItems = Array.isArray(args.graphItems) ? args.graphItems : undefined;
  const signature = useMemo(
    () => buildGitLogVisiblePackSignature(items, graphItems, args.fileHistoryMode),
    [args.fileHistoryMode, graphItems, items],
  );
  const workerRef = useRef<Worker | null>(null);
  const requestSeqRef = useRef(0);
  const lightModeUntilRef = useRef(0);
  const lightModeRetryTimerRef = useRef<number | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);
  const [pack, setPack] = useState<GitLogVisiblePack>(() => {
    if (items.length <= GIT_LOG_GRAPH_SYNC_BUILD_LIMIT) {
      return buildGitLogVisiblePack({
        items,
        graphItems,
        fileHistoryMode: args.fileHistoryMode,
      });
    }
    return buildGitLogVisiblePlaceholderPack(items, { pending: true });
  });

  /**
   * 安排轻量模式结束后的重试，让简化图谱自动恢复为完整拓扑。
   */
  const scheduleLightModeRetry = (delayMs: number): void => {
    if (lightModeRetryTimerRef.current != null)
      window.clearTimeout(lightModeRetryTimerRef.current);
    const safeDelayMs = Math.max(500, Math.min(120_000, Math.floor(Number(delayMs) || 0)));
    lightModeRetryTimerRef.current = window.setTimeout(() => {
      lightModeRetryTimerRef.current = null;
      setRetrySeq((prev) => prev + 1);
    }, safeDelayMs);
  };

  useEffect(() => {
    /**
     * 记录轻量模式截止时间，避免长任务后立刻继续启动重计算。
     */
    const onLightMode = (event: Event): void => {
      const custom = event as RendererLightModeEvent;
      const durationMs = Math.max(5_000, Math.min(120_000, Number(custom.detail?.durationMs) || GIT_LOG_GRAPH_LIGHT_MODE_TTL_MS));
      lightModeUntilRef.current = Math.max(lightModeUntilRef.current, Date.now() + durationMs);
      setPack(buildGitLogVisiblePlaceholderPack(items, { degraded: true }));
      scheduleLightModeRetry(durationMs + 50);
    };
    window.addEventListener(GIT_LOG_GRAPH_LIGHT_MODE_EVENT, onLightMode as EventListener);
    return () => {
      window.removeEventListener(GIT_LOG_GRAPH_LIGHT_MODE_EVENT, onLightMode as EventListener);
    };
  }, [signature]);

  useEffect(() => {
    const requestId = requestSeqRef.current + 1;
    requestSeqRef.current = requestId;

    if (items.length <= GIT_LOG_GRAPH_SYNC_BUILD_LIMIT && !isGitLogGraphLightModeActive(lightModeUntilRef)) {
      setPack(buildGitLogVisiblePack({
        items,
        graphItems,
        fileHistoryMode: args.fileHistoryMode,
      }));
      return;
    }

    const placeholder = buildGitLogVisiblePlaceholderPack(items, {
      pending: !isGitLogGraphLightModeActive(lightModeUntilRef),
      degraded: isGitLogGraphLightModeActive(lightModeUntilRef),
    });
    setPack(placeholder);
    if (isGitLogGraphLightModeActive(lightModeUntilRef)) return;

    const worker = createGitLogVisiblePackWorker();
    if (!worker) {
      setPack(buildGitLogVisiblePlaceholderPack(items, { degraded: true }));
      scheduleLightModeRetry(GIT_LOG_GRAPH_WORKER_FAILURE_RETRY_MS);
      return;
    }
    workerRef.current?.terminate();
    workerRef.current = worker;

    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      try { worker.terminate(); } catch {}
      if (workerRef.current === worker) workerRef.current = null;
      lightModeUntilRef.current = Math.max(lightModeUntilRef.current, Date.now() + GIT_LOG_GRAPH_LIGHT_MODE_TTL_MS);
      setPack(buildGitLogVisiblePlaceholderPack(items, { degraded: true }));
      scheduleLightModeRetry(GIT_LOG_GRAPH_LIGHT_MODE_TTL_MS + 50);
      try { void window.host?.utils?.perfLog?.(`[git.graph.worker.timeout] items=${items.length} graphItems=${graphItems?.length || 0}`); } catch {}
    }, GIT_LOG_GRAPH_WORKER_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<GitLogVisiblePackWorkerResponse>) => {
      if (settled) return;
      const response = event.data;
      if (Math.max(0, Math.floor(Number(response?.requestId) || 0)) !== requestId) return;
      settled = true;
      window.clearTimeout(timeout);
      try { worker.terminate(); } catch {}
      if (workerRef.current === worker) workerRef.current = null;
      if (response?.ok && response.pack) {
        setPack(response.pack);
        return;
      }
      setPack(buildGitLogVisiblePlaceholderPack(items, { degraded: true }));
      scheduleLightModeRetry(GIT_LOG_GRAPH_WORKER_FAILURE_RETRY_MS);
      try { void window.host?.utils?.perfLog?.(`[git.graph.worker.failed] items=${items.length} error=${String(response?.error || "")}`); } catch {}
    };
    worker.onerror = (event) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      try { worker.terminate(); } catch {}
      if (workerRef.current === worker) workerRef.current = null;
      setPack(buildGitLogVisiblePlaceholderPack(items, { degraded: true }));
      scheduleLightModeRetry(GIT_LOG_GRAPH_WORKER_FAILURE_RETRY_MS);
      try { void window.host?.utils?.perfLog?.(`[git.graph.worker.error] items=${items.length} error=${String(event?.message || "")}`); } catch {}
    };
    worker.postMessage({
      requestId,
      items,
      graphItems,
      fileHistoryMode: args.fileHistoryMode,
    });

    return () => {
      settled = true;
      window.clearTimeout(timeout);
      try { worker.terminate(); } catch {}
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [args.fileHistoryMode, retrySeq, signature]);

  useEffect(() => {
    return () => {
      if (lightModeRetryTimerRef.current != null)
        window.clearTimeout(lightModeRetryTimerRef.current);
      lightModeRetryTimerRef.current = null;
      try { workerRef.current?.terminate(); } catch {}
      workerRef.current = null;
    };
  }, []);

  return pack;
}
