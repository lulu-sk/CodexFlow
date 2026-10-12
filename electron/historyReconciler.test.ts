import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "",
  },
}));

import {
  __testing,
  beginHistoryReconcilerInitialization,
  markHistoryReconcilerReady,
  requestHistoryFastRefresh,
  requestHistoryReconcileNow,
} from "./historyReconciler";

type Snapshot = ReturnType<typeof import("./indexer")["getHistoryReconcileSnapshot"]>;

/**
 * 创建空的 Provider 根目录映射。
 */
function emptyRoots(): Snapshot["rootsByProvider"] {
  return { codex: [], claude: [], gemini: [], antigravity: [], grok: [] };
}

/**
 * 创建协调器测试使用的最小索引快照。
 */
function createSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    ready: true,
    rootsByProvider: emptyRoots(),
    existingRootsByProvider: emptyRoots(),
    files: [],
    ...overrides,
  };
}

/**
 * 创建固定目录签名的伪 Stats。
 */
function createDirectoryStat(signature = 1): fs.Stats {
  return {
    mtimeMs: signature,
    ctimeMs: signature,
    size: signature,
    isDirectory: () => true,
  } as fs.Stats;
}

/**
 * 创建文件类型的伪目录项。
 */
function createFileEntry(name: string): fs.Dirent {
  return {
    name,
    isFile: () => true,
    isDirectory: () => false,
  } as fs.Dirent;
}

/**
 * 推进假定时器并等待已排队的 Promise 回调。
 */
async function advance(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let index = 0; index < 8; index++) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
}

beforeEach(async () => {
  vi.useFakeTimers();
  await __testing.reset();
  __testing.setTiming({
    notificationDebounceMs: 10,
    fileRetryBaseMs: 10,
    localIoTimeoutMs: 100,
    uncIoTimeoutMs: 50,
    activePeriodicMs: 60_000,
    idlePeriodicMs: 60_000,
  });
});

afterEach(async () => {
  await __testing.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("electron/historyReconciler", () => {
  it("启动扫描在秒级覆盖旧日期目录，不丢弃超过队列容量的历史", async () => {
    const rootPath = "C:\\history";
    const dayPath = path.join(rootPath, "2025", "01", "01");
    const directories = new Map([
      [rootPath, ["2025"]],
      [path.join(rootPath, "2025"), ["01"]],
      [path.join(rootPath, "2025", "01"), ["01"]],
    ]);
    const reconcileFile = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      return "updated" as const;
    });
    __testing.setIndexPort({
      getSnapshot: () => createSnapshot({ rootsByProvider: { ...emptyRoots(), codex: [rootPath] } }),
      reconcileFile,
      normalizeFileAnchor: (_providerId, filePath) => filePath,
      shouldIndexFile: () => true,
    });
    __testing.setFileSystemPort({
      stat: async () => createDirectoryStat(),
      opendir: async (directoryPath) => {
        const entries = directoryPath === dayPath
          ? Array.from({ length: 600 }, (_, index) => createFileEntry(`session-${index}.jsonl`))
          : (directories.get(directoryPath) || []).map((name) => ({ name, isFile: () => false, isDirectory: () => true }) as fs.Dirent);
        let index = 0;
        return { read: async () => entries[index++] || null, close: async () => {} };
      },
    });
    const generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    await advance(10_000);
    const paths = new Set(reconcileFile.mock.calls.map((call: unknown[]) => call[0]));
    expect(paths.size).toBe(600);
    expect(__testing.snapshot().pendingFiles).toBe(0);
  });

  it("保留初始化前到达的精确文件通知", async () => {
    const reconcileFile = vi.fn(async () => "updated" as const);
    __testing.setIndexPort({
      getSnapshot: () => createSnapshot(),
      reconcileFile,
      resolveAccessibleFilePath: (filePath) => filePath,
      normalizeFileAnchor: (_providerId, filePath) => filePath,
    });

    requestHistoryFastRefresh({ providerId: "codex", filePath: "C:\\history\\session.jsonl" });
    expect(__testing.snapshot().pendingRequests).toBe(1);

    const generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    await advance(1);

    expect(reconcileFile).toHaveBeenCalledTimes(1);
  });

  it("代次切换后旧任务不能继续取得写入许可", async () => {
    let isCurrent: (() => boolean) | null = null;
    let finish: ((result: "updated") => void) | null = null;
    const reconcileFile = vi.fn((_filePath: string, _providerId?: string, current?: () => boolean) => {
      isCurrent = current || (() => false);
      return new Promise<"updated">((resolve) => { finish = resolve; });
    });
    __testing.setIndexPort({
      getSnapshot: () => createSnapshot(),
      reconcileFile,
      resolveAccessibleFilePath: (filePath) => filePath,
      normalizeFileAnchor: (_providerId, filePath) => filePath,
    });

    const generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    requestHistoryFastRefresh({ providerId: "codex", filePath: "C:\\history\\session.jsonl" });
    await advance(10);
    const currentBeforePause = isCurrent as (() => boolean) | null;
    expect(currentBeforePause ? currentBeforePause() : false).toBe(true);

    await beginHistoryReconcilerInitialization();
    const currentAfterPause = isCurrent as (() => boolean) | null;
    expect(currentAfterPause ? currentAfterPause() : false).toBe(false);
    const resolvePending = finish as ((result: "updated") => void) | null;
    if (resolvePending) resolvePending("updated");
    await advance();
  });

  it("过时代次不能重新标记 ready", async () => {
    const firstGeneration = await beginHistoryReconcilerInitialization();
    const currentGeneration = await beginHistoryReconcilerInitialization();

    expect(markHistoryReconcilerReady(firstGeneration)).toBe(false);
    expect(__testing.snapshot().ready).toBe(false);
    expect(markHistoryReconcilerReady(currentGeneration)).toBe(true);
  });

  it("合并同一文件的重复通知，只启动一次解析", async () => {
    const reconcileFile = vi.fn(async () => "updated" as const);
    __testing.setIndexPort({
      getSnapshot: () => createSnapshot(),
      reconcileFile,
      resolveAccessibleFilePath: (filePath) => filePath,
      normalizeFileAnchor: (_providerId, filePath) => filePath,
    });
    const generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    await advance(1);

    const request = { providerId: "codex" as const, filePath: "C:\\history\\session.jsonl" };
    requestHistoryFastRefresh(request);
    requestHistoryFastRefresh(request);
    await advance(10);

    expect(reconcileFile).toHaveBeenCalledTimes(1);
  });

  it("会话标识恢复只扫描指定 Provider，不扩散到其他 Provider", async () => {
    const openedDirectories: string[] = [];
    const codexRoot = "C:\\history\\codex";
    let snapshot = createSnapshot();
    __testing.setTiming({ localDirectorySliceIntervalMs: 10 });
    __testing.setIndexPort({
      getSnapshot: () => snapshot,
      reconcileFile: vi.fn(async () => "unchanged" as const),
      shouldIndexFile: () => true,
    });
    __testing.setFileSystemPort({
      stat: async () => createDirectoryStat(),
      opendir: async (directoryPath) => {
        openedDirectories.push(directoryPath);
        return { read: async () => null, close: async () => {} };
      },
    });

    const generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    await advance(1);
    snapshot = createSnapshot({
      rootsByProvider: {
        codex: [codexRoot],
        claude: ["C:\\history\\claude"],
        gemini: ["C:\\history\\gemini"],
        antigravity: ["C:\\history\\antigravity"],
        grok: ["C:\\history\\grok"],
      },
    });
    requestHistoryFastRefresh({ providerId: "codex", sessionId: "missing-session" });
    await advance(20);

    expect(openedDirectories.length).toBeGreaterThan(0);
    expect(openedDirectories.every((directoryPath) => directoryPath.startsWith(codexRoot))).toBe(true);
    expect(__testing.snapshot().roots).toBe(1);
  });

  it("新 Codex 会话按启动日期恢复，不扫描历史根目录", async () => {
    const openedDirectories: string[] = [];
    const codexRoot = "C:\\history\\codex";
    const startedAt = new Date(2026, 3, 29, 10, 30, 0).getTime();
    let snapshot = createSnapshot();
    __testing.setTiming({ localDirectorySliceIntervalMs: 10 });
    __testing.setIndexPort({
      getSnapshot: () => snapshot,
      reconcileFile: vi.fn(async () => "unchanged" as const),
      shouldIndexFile: () => true,
    });
    __testing.setFileSystemPort({
      stat: async () => createDirectoryStat(),
      opendir: async (directoryPath) => {
        openedDirectories.push(directoryPath);
        return { read: async () => null, close: async () => {} };
      },
    });

    const generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    await advance(1);
    snapshot = createSnapshot({
      rootsByProvider: { ...emptyRoots(), codex: [codexRoot] },
    });
    requestHistoryFastRefresh({ providerId: "codex", startedAt });
    await advance(100);

    expect(openedDirectories).toHaveLength(3);
    expect(openedDirectories).not.toContain(codexRoot);
    expect(openedDirectories.every((directoryPath) => directoryPath.startsWith(`${codexRoot}\\2026\\04\\`))).toBe(true);
    expect(__testing.snapshot().roots).toBe(1);
  });

  it("启动全量校对优先扫描 Codex 最近日期目录", async () => {
    const codexRoot = "C:\\history\\codex";
    const otherProviderRoot = "C:\\history\\other-provider";
    const now = new Date(2026, 3, 29, 10, 30, 0).getTime();
    const todayDirectory = path.join(codexRoot, "2026", "04", "29");
    const newSessionPath = path.join(todayDirectory, "new-session.jsonl");
    const openedDirectories: string[] = [];
    const reconcileFile = vi.fn(async () => "updated" as const);
    vi.setSystemTime(now);
    __testing.setTiming({ localDirectorySliceIntervalMs: 10 });
    __testing.setIndexPort({
      getSnapshot: () => createSnapshot({
        rootsByProvider: {
          ...emptyRoots(),
          codex: [codexRoot],
          claude: [otherProviderRoot],
        },
      }),
      reconcileFile,
      normalizeFileAnchor: (_providerId, filePath) => filePath,
      shouldIndexFile: () => true,
    });
    __testing.setFileSystemPort({
      stat: async () => createDirectoryStat(),
      opendir: async (directoryPath) => {
        openedDirectories.push(directoryPath);
        const entries: Array<fs.Dirent | null> = directoryPath === todayDirectory
          ? [createFileEntry(path.basename(newSessionPath)), null]
          : [null];
        let index = 0;
        return { read: async () => entries[index++], close: async () => {} };
      },
    });

    const generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    requestHistoryReconcileNow("roots-discovered:claude");
    await advance(100);

    const codexDirectories = openedDirectories.filter((directoryPath) => directoryPath.startsWith(codexRoot));
    expect(codexDirectories[0]).toBe(todayDirectory);
    expect(reconcileFile).toHaveBeenCalledWith(newSessionPath, "codex", expect.any(Function));
    expect(openedDirectories).toContain(otherProviderRoot);
  });

  it("普通周期校对不重复插入 Codex 最近日期目录", async () => {
    const codexRoot = "C:\\history\\codex";
    const openedDirectories: string[] = [];
    __testing.setTiming({ localDirectorySliceIntervalMs: 10 });
    __testing.setIndexPort({
      getSnapshot: () => createSnapshot({
        rootsByProvider: { ...emptyRoots(), codex: [codexRoot] },
      }),
      reconcileFile: vi.fn(async () => "unchanged" as const),
      shouldIndexFile: () => true,
    });
    __testing.setFileSystemPort({
      stat: async () => createDirectoryStat(),
      opendir: async (directoryPath) => {
        openedDirectories.push(directoryPath);
        return { read: async () => null, close: async () => {} };
      },
    });

    const generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    await advance(100);
    openedDirectories.length = 0;

    requestHistoryReconcileNow("periodic");
    await advance(20);

    expect(openedDirectories).toEqual([codexRoot]);
  });

  it("非 Codex 的全量校对不增加日期目录任务", async () => {
    const providerRoot = "C:\\history\\claude";
    const openedDirectories: string[] = [];
    __testing.setTiming({ localDirectorySliceIntervalMs: 10 });
    __testing.setIndexPort({
      getSnapshot: () => createSnapshot({
        rootsByProvider: { ...emptyRoots(), claude: [providerRoot] },
      }),
      reconcileFile: vi.fn(async () => "unchanged" as const),
      shouldIndexFile: () => true,
    });
    __testing.setFileSystemPort({
      stat: async () => createDirectoryStat(),
      opendir: async (directoryPath) => {
        openedDirectories.push(directoryPath);
        return { read: async () => null, close: async () => {} };
      },
    });

    const generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    await advance(20);

    expect(openedDirectories).toEqual([providerRoot]);
  });

  it("全量扫描未结束时仍会重新扫描已处理的 Codex 日期目录", async () => {
    const codexRoot = "C:\\history\\codex";
    const startedAt = new Date(2026, 3, 29, 10, 30, 0).getTime();
    const todayDirectory = path.join(codexRoot, "2026", "04", "29");
    const newSessionPath = path.join(todayDirectory, "new-session.jsonl");
    const openedDirectories: string[] = [];
    const reconcileFile = vi.fn(async () => "updated" as const);
    let todayOpenCount = 0;
    let snapshot = createSnapshot();
    vi.setSystemTime(startedAt);
    __testing.setTiming({ localDirectorySliceIntervalMs: 1_000 });
    __testing.setIndexPort({
      getSnapshot: () => snapshot,
      reconcileFile,
      normalizeFileAnchor: (_providerId, filePath) => filePath,
      shouldIndexFile: () => true,
    });
    __testing.setFileSystemPort({
      stat: async () => createDirectoryStat(),
      opendir: async (directoryPath) => {
        openedDirectories.push(directoryPath);
        if (directoryPath === todayDirectory && ++todayOpenCount === 2) {
          const entries: Array<fs.Dirent | null> = [createFileEntry(path.basename(newSessionPath)), null];
          let index = 0;
          return { read: async () => entries[index++], close: async () => {} };
        }
        return { read: async () => null, close: async () => {} };
      },
    });

    const generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    await advance(1);
    snapshot = createSnapshot({
      rootsByProvider: { ...emptyRoots(), codex: [codexRoot] },
    });

    requestHistoryFastRefresh({ providerId: "codex", sessionId: "missing-session" });
    await advance(20);
    expect(openedDirectories.filter((directoryPath) => directoryPath === todayDirectory)).toHaveLength(1);

    requestHistoryFastRefresh({ providerId: "codex", startedAt });
    await advance(1_000);

    expect(openedDirectories.filter((directoryPath) => directoryPath === todayDirectory)).toHaveLength(2);
    expect(openedDirectories).not.toContain(codexRoot);
    expect(reconcileFile).toHaveBeenCalledWith(newSessionPath, "codex", expect.any(Function));
  });

  it("超大目录严格遵守条目预算和真实时间间隔", async () => {
    const entries = Array.from({ length: 6 }, (_, index) => createFileEntry(`session-${index}.jsonl`));
    let readCount = 0;
    const reader = {
      read: vi.fn(async () => entries[readCount++] || null),
      close: vi.fn(async () => {}),
    };
    __testing.setTiming({
      localDirectoryEntriesPerSlice: 2,
      localDirectorySliceIntervalMs: 1_000,
    });
    __testing.setIndexPort({
      getSnapshot: () => createSnapshot({
        rootsByProvider: { ...emptyRoots(), codex: ["C:\\history"] },
      }),
      reconcileFile: vi.fn(async () => "unchanged" as const),
      normalizeFileAnchor: (_providerId, filePath) => filePath,
      shouldIndexFile: () => true,
    });
    __testing.setFileSystemPort({
      stat: async () => createDirectoryStat(),
      opendir: async () => reader,
    });

    const generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    await advance(1);
    expect(__testing.snapshot().roots).toBe(1);
    expect(reader.read).toHaveBeenCalledTimes(2);

    await advance(999);
    expect(reader.read).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(reader.read).toHaveBeenCalledTimes(4);
  });

  it("UNC 未返回的 I/O 不阻塞本地 Provider", async () => {
    const opened: string[] = [];
    __testing.setTiming({
      localDirectoryEntriesPerSlice: 1,
      uncDirectoryEntriesPerSlice: 1,
      localDirectorySliceIntervalMs: 1_000,
      uncDirectorySliceIntervalMs: 1_000,
    });
    __testing.setIndexPort({
      getSnapshot: () => createSnapshot({
        rootsByProvider: {
          ...emptyRoots(),
          codex: ["\\\\wsl.localhost\\Ubuntu\\sessions"],
          claude: ["C:\\history"],
        },
      }),
      reconcileFile: vi.fn(async () => "unchanged" as const),
      shouldIndexFile: () => true,
    });
    __testing.setFileSystemPort({
      stat: async (filePath) => {
        if (filePath.startsWith("\\\\wsl.localhost")) return await new Promise<fs.Stats>(() => {});
        return createDirectoryStat();
      },
      opendir: async (directoryPath) => {
        opened.push(directoryPath);
        return {
          read: async () => null,
          close: async () => {},
        };
      },
    });

    const generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    await advance(1);

    expect(opened).toContain("C:\\history");
    expect(__testing.snapshot().unresolvedRootIo).toBe(1);
  });

  it("跨代次未结束的 UNC 文件任务不会耗尽本地刷新容量", async () => {
    const reconcileFile = vi.fn((filePath: string) => {
      if (filePath.startsWith("\\\\server\\")) return new Promise<"updated">(() => {});
      return Promise.resolve("updated" as const);
    });
    __testing.setIndexPort({
      getSnapshot: () => createSnapshot(),
      reconcileFile,
      resolveAccessibleFilePath: (filePath) => filePath,
      normalizeFileAnchor: (_providerId, filePath) => filePath,
    });
    const providers = ["codex", "claude", "gemini", "antigravity", "grok"] as const;

    let generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    for (const providerId of providers)
      requestHistoryFastRefresh({ providerId, filePath: `\\\\server\\share-a\\${providerId}\\session` });
    await advance(10);

    generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    for (const providerId of providers)
      requestHistoryFastRefresh({ providerId, filePath: `\\\\server\\share-b\\${providerId}\\session` });
    await advance(10);
    expect(__testing.snapshot().activeFileTasks).toBe(6);

    generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    requestHistoryFastRefresh({ providerId: "codex", filePath: "\\\\server\\share-c\\codex\\session" });
    await advance(10);
    expect(reconcileFile).toHaveBeenCalledTimes(6);
    await advance(100);
    expect(reconcileFile).toHaveBeenCalledTimes(6);

    requestHistoryFastRefresh({ providerId: "codex", filePath: "C:\\history\\local-session.jsonl" });
    await advance(10);

    expect(reconcileFile).toHaveBeenCalledWith(
      "C:\\history\\local-session.jsonl",
      "codex",
      expect.any(Function),
    );
  });

  it("只有稳定且完整到达 EOF 的目录才提交删除证据", async () => {
    const listSweepRemovalCandidates = vi.fn(
      (_providerId: string, _directoryPath: string, _observedFiles: ReadonlySet<string>) => [] as string[],
    );
    const rootPath = "C:\\history";
    const entriesByDirectory = new Map<string, Array<fs.Dirent | null>>([
      [rootPath, [createFileEntry("session.jsonl"), null]],
    ]);
    __testing.setTiming({
      localDirectoryEntriesPerSlice: 8,
      localDirectorySliceIntervalMs: 1_000,
    });
    __testing.setIndexPort({
      getSnapshot: () => createSnapshot({
        rootsByProvider: { ...emptyRoots(), codex: [rootPath] },
      }),
      reconcileFile: vi.fn(async () => "unchanged" as const),
      listSweepRemovalCandidates,
      normalizeFileAnchor: (_providerId, filePath) => filePath,
      shouldIndexFile: () => true,
    });
    __testing.setFileSystemPort({
      stat: async () => createDirectoryStat(7),
      opendir: async (directoryPath) => {
        const entries = entriesByDirectory.get(directoryPath) || [null];
        let index = 0;
        return {
          read: async () => entries[index++],
          close: async () => {},
        };
      },
    });

    const generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    await advance(5_000);

    const matchingCall = listSweepRemovalCandidates.mock.calls.find(
      (call) => call[1] === rootPath,
    );
    expect(matchingCall).toBeDefined();
    const observed = matchingCall![2];
    expect(observed.has("c:/history/session.jsonl")).toBe(true);
  });

  it("组合文件只触发主文件刷新，删除复核仅提交明确 ENOENT", async () => {
    const listSweepRemovalCandidates = vi.fn((_providerId: string, _parentDir: string, _observedFiles: ReadonlySet<string>) => [
      "C:\\grok\\sessions\\session-1\\summary.json",
      "C:\\grok\\sessions\\session-1\\denied.json",
    ]);
    const commitSweepRemovals = vi.fn(() => 1);
    const entries: Array<fs.Dirent | null> = [createFileEntry("updates.jsonl"), null];
    let index = 0;
    __testing.setTiming({ localDirectoryEntriesPerSlice: 8, localDirectorySliceIntervalMs: 100 });
    __testing.setIndexPort({
      getSnapshot: () => createSnapshot({ rootsByProvider: { ...emptyRoots(), grok: ["C:\\grok\\sessions"] } }),
      reconcileFile: vi.fn(async () => "unchanged" as const),
      listSweepRemovalCandidates,
      commitSweepRemovals,
      normalizeFileAnchor: (_providerId, filePath) => {
        return path.basename(filePath).toLowerCase() === "updates.jsonl"
          ? path.join(path.dirname(filePath), "summary.json")
          : filePath;
      },
      shouldIndexFile: (_providerId, filePath) => path.basename(filePath).toLowerCase() === "summary.json",
    });
    __testing.setFileSystemPort({
      stat: async (filePath) => {
        if (path.basename(filePath).toLowerCase() === "summary.json")
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        if (path.basename(filePath).toLowerCase() === "denied.json")
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        return createDirectoryStat(9);
      },
      opendir: async () => ({
        read: async () => entries[index++],
        close: async () => {},
      }),
    });

    const generation = await beginHistoryReconcilerInitialization();
    markHistoryReconcilerReady(generation);
    await advance(1);
    expect(listSweepRemovalCandidates).toHaveBeenCalledTimes(1);
    const observed = listSweepRemovalCandidates.mock.calls[0][2];
    expect(observed.has("c:/grok/sessions/summary.json")).toBe(false);

    await advance(100);
    expect(commitSweepRemovals).toHaveBeenCalledWith(
      "grok",
      ["C:\\grok\\sessions\\session-1\\summary.json"],
      expect.any(Function),
    );
  });
});
