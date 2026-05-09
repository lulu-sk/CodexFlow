// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { BranchSyncStatusIcon } from "./widgets";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 创建并挂载一个 React Root，供分支同步图标组件在 jsdom 中渲染。
 */
function createMountedRoot(): { host: HTMLDivElement; root: Root; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return {
    host,
    root,
    unmount: () => {
      try {
        act(() => {
          root.unmount();
        });
      } catch {}
      try {
        host.remove();
      } catch {}
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("BranchSyncStatusIcon", () => {
  it("diverged 状态应渲染更清楚的双向同步 glyph", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <BranchSyncStatusIcon
            sync={{
              upstream: "origin/master",
              incoming: 2,
              outgoing: 1,
              hasUnfetched: false,
              status: "diverged",
              tooltip: "落后 2 个提交，领先 1 个提交。",
            }}
          />,
        );
      });

      expect(document.querySelector('[data-cf-branch-sync-cluster="diverged"]')).not.toBeNull();
      expect(document.querySelector('[data-cf-sync-glyph="diverged"]')).not.toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  it("synced 状态应只保留 branch glyph，不额外渲染状态 glyph", async () => {
    const mounted = createMountedRoot();
    try {
      await act(async () => {
        mounted.root.render(
          <BranchSyncStatusIcon
            sync={{
              upstream: "origin/master",
              incoming: 0,
              outgoing: 0,
              hasUnfetched: false,
              status: "synced",
              tooltip: "已与 origin/master 同步。",
            }}
          />,
        );
      });

      expect(document.querySelector('[data-cf-branch-sync-cluster="branch-only"]')).not.toBeNull();
      expect(document.querySelector("[data-cf-sync-glyph]")).toBeNull();
    } finally {
      mounted.unmount();
    }
  });
});
