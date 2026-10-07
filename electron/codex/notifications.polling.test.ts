import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, startCodexNotificationBridge, stopCodexNotificationBridge } from "./notifications";

const roots = vi.hoisted(() => ({ windowsCodex: "", wsl: [] as Array<{ codexUNC: string }> }));
const discovery = vi.hoisted(() => vi.fn(async () => roots));
vi.mock("../wsl", () => ({ getCodexRootsFastAsync: discovery }));
vi.mock("../historyReconciler", () => ({ requestHistoryFastRefresh: vi.fn() }));
vi.mock("../log", () => ({ perfLogger: { log: vi.fn() } }));

const tempDirs: string[] = [];

afterEach(async () => {
  stopCodexNotificationBridge();
  vi.restoreAllMocks();
  discovery.mockReset();
  discovery.mockImplementation(async () => roots);
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

/** 创建两个去标识化通知来源和可观察的渲染进程接收端。 */
async function createBridge() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexflow-notify-poll-"));
  tempDirs.push(root);
  vi.spyOn(os, "homedir").mockReturnValue(root);
  roots.windowsCodex = path.join(root, ".codex");
  roots.wsl = [{ codexUNC: path.join(root, "remote") }];
  await Promise.all([roots.windowsCodex, roots.wsl[0].codexUNC].map((dir) => fs.mkdir(dir)));
  const localFile = path.join(roots.windowsCodex, "codexflow_after_agent_notify.jsonl");
  const remoteFile = path.join(roots.wsl[0].codexUNC, "codexflow_after_agent_notify.jsonl");
  await Promise.all([localFile, remoteFile].map((file) => fs.writeFile(file, "", "utf8")));
  const send = vi.fn();
  const window = { webContents: { send } } as unknown as BrowserWindow;
  return { localFile, remoteFile, send, window };
}

/** 写入一条带标签标记的真实 JSONL 完成事件。 */
async function appendCompletion(file: string, eventId: string): Promise<void> {
  await fs.appendFile(file, `${JSON.stringify({ tabId: "tab-1", eventId, hookEventName: "Stop", completionKind: "agent", preview: "已回复。" })}\n`, "utf8");
}

describe("Codex 通知来源独立轮询", () => {
  it("远端根目录发现失败不能移除已经就绪的本地来源", async () => {
    const { localFile, send, window } = await createBridge();
    discovery.mockRejectedValueOnce(new Error("remote discovery unavailable"));
    await startCodexNotificationBridge(() => window);
    await appendCompletion(localFile, "after-discovery-failure");
    await __testing.pollCodexNotifyFiles();
    expect(send).toHaveBeenCalledWith("notifications:externalAgentComplete", expect.objectContaining({ eventId: "after-discovery-failure" }));
  });

  it("WSL 根目录发现未完成时，本地完成事件仍能收到", async () => {
    const { localFile, send, window } = await createBridge();
    let unblock!: () => void;
    discovery.mockImplementationOnce(() => new Promise((resolve) => { unblock = () => resolve(roots); }));
    const startup = startCodexNotificationBridge(() => window);
    try {
      await vi.waitFor(() => expect(discovery).toHaveBeenCalled());
      await appendCompletion(localFile, "before-discovery");
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith("notifications:externalAgentComplete", expect.objectContaining({ eventId: "before-discovery" })));
    } finally {
      unblock();
      await startup;
    }
  });

  it("远端读取卡住后，后续本地完成事件仍可转发且远端读取不会堆积", async () => {
    const { localFile, remoteFile, send, window } = await createBridge();
    await startCodexNotificationBridge(() => window);
    const originalStat = fs.stat.bind(fs);
    let unblock!: () => void;
    const remoteRead = new Promise<void>((resolve) => { unblock = resolve; });
    const stat = vi.spyOn(fs, "stat").mockImplementation(async (file, ...args) => {
      if (file === remoteFile) await remoteRead;
      return originalStat(file, ...args);
    });
    await appendCompletion(localFile, "first");
    const pending = __testing.pollCodexNotifyFiles();
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await appendCompletion(localFile, "second");
      await __testing.pollCodexNotifyFiles();
      expect(send).toHaveBeenLastCalledWith("notifications:externalAgentComplete", expect.objectContaining({ eventId: "second" }));
      expect(stat.mock.calls.filter(([file]) => file === remoteFile)).toHaveLength(1);
    } finally {
      unblock();
      await pending;
    }
  });

  it("远端初始化卡住时，已经就绪的本地来源仍开始定时轮询", async () => {
    const { localFile, remoteFile, send, window } = await createBridge();
    const originalStat = fs.stat.bind(fs);
    let unblock!: () => void;
    let signalLocalReady!: () => void;
    const remoteRead = new Promise<void>((resolve) => { unblock = resolve; });
    const localReady = new Promise<void>((resolve) => { signalLocalReady = resolve; });
    vi.spyOn(fs, "stat").mockImplementation(async (file, ...args) => {
      if (file === remoteFile) await remoteRead;
      const result = await originalStat(file, ...args);
      if (file === localFile) signalLocalReady();
      return result;
    });
    const startup = startCodexNotificationBridge(() => window);
    try {
      await localReady;
      await appendCompletion(localFile, "during-startup");
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith("notifications:externalAgentComplete", expect.objectContaining({ eventId: "during-startup" })));
    } finally {
      unblock();
      await startup;
    }
  });

  it("桥接停止后，迟到的远端读取不能向新窗口转发旧事件", async () => {
    const { remoteFile, send, window } = await createBridge();
    await startCodexNotificationBridge(() => window);
    const originalStat = fs.stat.bind(fs);
    let unblock!: () => void;
    let blockNextRemote = true;
    const remoteRead = new Promise<void>((resolve) => { unblock = resolve; });
    vi.spyOn(fs, "stat").mockImplementation(async (file, ...args) => {
      if (file === remoteFile && blockNextRemote) {
        blockNextRemote = false;
        await remoteRead;
      }
      return originalStat(file, ...args);
    });
    await appendCompletion(remoteFile, "stale");
    const pending = __testing.pollCodexNotifyFiles();
    try {
      stopCodexNotificationBridge();
      await startCodexNotificationBridge(() => window);
    } finally {
      unblock();
      await pending;
    }
    expect(send).not.toHaveBeenCalled();
    await __testing.pollCodexNotifyFiles();
    expect(send).not.toHaveBeenCalled();
  });
});
