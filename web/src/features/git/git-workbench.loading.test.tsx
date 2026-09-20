// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import GitWorkbench from "./git-workbench";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  loadDiff: vi.fn(),
  loadConflict: vi.fn(),
  loadThreeWay: vi.fn(),
  translate: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.translate }) }));
vi.mock("./monaco-git-diff", () => {
  mocks.loadDiff();
  return { default: () => <div data-testid="loaded-diff" /> };
});
vi.mock("./commit-panel/conflict-merge-dialog", () => {
  mocks.loadConflict();
  return { ConflictMergeDialog: () => null };
});
vi.mock("./commit-panel/conflict-merge-three-way-editor", () => {
  mocks.loadThreeWay();
  return { ConflictMergeThreeWayEditor: () => null };
});

describe("Git 工作台首次加载", () => {
  it("切换项目后应立即加载新仓库，并丢弃旧仓库的检测结果", async () => {
    const previousHost = window.host;
    let releaseDetect!: () => void;
    const detectReady = new Promise<void>((resolve) => { releaseDetect = resolve; });
    const call = vi.fn(async ({ action, payload }: { action: string; payload?: { repoPath?: string } }) => {
      if (action === "repo.detect") {
        if (payload?.repoPath === "/old-repo") await detectReady;
        return { ok: true, data: { isRepo: true, repoRoot: payload?.repoPath, branch: "main" } };
      }
      if (action === "log.get")
        return { ok: true, data: { items: [], nextCursor: 0, hasMore: false } };
      return { ok: false, error: "测试未提供此数据" };
    });
    window.host = { gitFeature: { call }, utils: {} } as unknown as typeof window.host;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => { root.render(<GitWorkbench repoPath="/old-repo" active={true} />); });
      await act(async () => { root.render(<GitWorkbench repoPath="/new-repo" active={true} />); });
      // 旧检测仍未返回，新仓库也应开始刷新，不能被旧队列阻塞。
      expect(call.mock.calls.filter(([request]) => request.action === "repo.detect")).toHaveLength(2);
      await act(async () => { releaseDetect(); });
      const statusRequests = call.mock.calls.filter(([request]) => request.action === "status.get");
      expect(statusRequests.map(([request]) => request.payload?.repoPath)).toEqual(["/new-repo"]);
      expect(call.mock.calls.filter(([request]) => request.action === "repo.detect")).toHaveLength(2);
    } finally {
      releaseDetect();
      await act(async () => root.unmount());
      host.remove();
      window.host = previousHost;
      localStorage.clear();
    }
  });

  it("新仓库加载期间，旧状态和日志返回不能触发预览或覆盖新界面", async () => {
    const previousHost = window.host;
    const releases: Array<() => void> = [];
    /** 分别控制旧状态、旧日志、新检测和新日志的返回顺序。 */
    const defer = (): Promise<void> => new Promise((resolve) => { releases.push(resolve); });
    const oldStatus = defer();
    const oldLog = defer();
    const newDetect = defer();
    const newLog = defer();
    const call = vi.fn(async ({ action, payload }: { action: string; payload?: { repoPath?: string } }) => {
      const old = payload?.repoPath === "/old-repo";
      if (action === "repo.detect") {
        if (!old) await newDetect;
        return { ok: true, data: { isRepo: true, repoRoot: payload?.repoPath, branch: "main" } };
      }
      if (action === "status.get") {
        if (old) await oldStatus;
        return { ok: true, data: {
          repoRoot: payload?.repoPath, branch: "main", ignoredEntries: [],
          entries: old ? [{
            path: "old-file.txt", x: " ", y: "M", staged: false, unstaged: true,
            untracked: false, ignored: false, renamed: false, deleted: false,
            statusText: "M", changeListId: "default",
          }] : [],
          changeLists: { activeListId: "default", lists: [{ id: "default", name: "Default", isDefault: true }] },
        } };
      }
      if (action === "log.get") {
        await (old ? oldLog : newLog);
        return { ok: true, data: {
          items: old ? [{ hash: "a".repeat(40), shortHash: "aaaaaaa", subject: "过期的旧仓库日志", parents: [], refs: [] }] : [],
          nextCursor: 0, hasMore: false,
        } };
      }
      return { ok: false, error: "测试未提供此数据" };
    });
    window.host = { gitFeature: { call }, utils: {} } as unknown as typeof window.host;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => { root.render(<GitWorkbench repoPath="/old-repo" active={true} />); });
      await act(async () => { root.render(<GitWorkbench repoPath="/new-repo" active={true} />); });
      await act(async () => { releases[0](); releases[1](); });
      await act(async () => { releases[2](); });
      expect(call.mock.calls.filter(([request]) => request.action === "status.get")).toHaveLength(2);
      expect(call.mock.calls.some(([request]) => request.action === "diff.get")).toBe(false);
      expect(host.textContent).not.toContain("old-file.txt");
      expect(host.textContent).not.toContain("过期的旧仓库日志");
    } finally {
      await act(async () => { releases.forEach((release) => release()); });
      await act(async () => root.unmount());
      host.remove();
      window.host = previousHost;
      localStorage.clear();
    }
  });

  it("空白区不加载编辑器，自动预览文件时才加载；状态较慢时只读取一次日志首屏", async () => {
    const previousHost = window.host;
    let releaseStatus!: () => void;
    const statusReady = new Promise<void>((resolve) => { releaseStatus = resolve; });
    const call = vi.fn(async ({ action }: { action: string }) => {
      if (action === "repo.detect")
        return { ok: true, data: { isRepo: true, repoRoot: "/repo", branch: "main" } };
      if (action === "status.get") {
        await statusReady;
        return { ok: true, data: {
          repoRoot: "/repo", branch: "main", ignoredEntries: [],
          entries: [{
            path: "sample.txt", x: " ", y: "M", staged: false, unstaged: true,
            untracked: false, ignored: false, renamed: false, deleted: false,
            statusText: "M", changeListId: "default",
          }],
          changeLists: { activeListId: "default", lists: [{ id: "default", name: "Default", isDefault: true }] },
        } };
      }
      if (action === "log.get")
        return { ok: true, data: { items: [], nextCursor: 0, hasMore: false } };
      if (action === "diff.get")
        return { ok: true, data: { path: "sample.txt", mode: "working", isBinary: false, leftText: "原文", rightText: "修改" } };
      return { ok: false, error: "测试未提供此数据" };
    });
    window.host = { gitFeature: { call }, utils: {} } as unknown as typeof window.host;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    vi.useFakeTimers();
    try {
      await act(async () => {
        root.render(<GitWorkbench repoPath="/repo" active={true} />);
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(call.mock.calls.filter(([request]) => request.action === "log.get")).toHaveLength(1);
      expect(mocks.loadDiff).not.toHaveBeenCalled();
      expect(mocks.loadConflict).not.toHaveBeenCalled();
      expect(mocks.loadThreeWay).not.toHaveBeenCalled();
      expect(host.textContent).toContain("请选择变更文件以查看差异");
      await act(async () => { releaseStatus(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(call.mock.calls.filter(([request]) => request.action === "log.get")).toHaveLength(1);
      // 沿用已有的首文件自动预览行为；真正有比对内容后才应加载编辑器。
      expect(call.mock.calls.some(([request]) => request.action === "diff.get")).toBe(true);
      expect(mocks.loadDiff).toHaveBeenCalledTimes(1);
      expect(host.querySelector('[data-testid="loaded-diff"]')).not.toBeNull();
    } finally {
      releaseStatus();
      await act(async () => root.unmount());
      host.remove();
      vi.useRealTimers();
      window.host = previousHost;
      localStorage.clear();
    }
  });
});
