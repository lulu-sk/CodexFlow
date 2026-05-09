import { describe, expect, it } from "vitest";
import { resolveCommitToolbarIntent, resolveGitToolbarState } from "./toolbar-state";

const t = ((_: string, options?: { defaultValue?: string }) => options?.defaultValue ?? "") as any;

describe("toolbar-state", () => {
  it("非 Git 仓库时所有主按钮都应禁用", () => {
    const state = resolveGitToolbarState({
      isRepo: false,
      repoDetached: false,
      hasRemotes: false,
      flowBusy: false,
      hasRollbackSelection: false,
    }, t);
    expect(state.fetch.enabled).toBe(false);
    expect(state.pull.enabled).toBe(false);
    expect(state.commit.enabled).toBe(false);
    expect(state.push.enabled).toBe(false);
    expect(state.rollback.enabled).toBe(false);
  });

  it("应按远端、Detached HEAD 与回滚选择状态推导 enablement", () => {
    const state = resolveGitToolbarState({
      isRepo: true,
      repoDetached: true,
      hasRemotes: false,
      flowBusy: false,
      hasRollbackSelection: true,
    }, t);
    expect(state.fetch.enabled).toBe(false);
    expect(state.pull.enabled).toBe(false);
    expect(state.commit.enabled).toBe(true);
    expect(state.push.enabled).toBe(true);
    expect(state.rollback.enabled).toBe(true);
  });

  it("提交按钮在已激活与未激活场景都应保持可聚焦到提交流程", () => {
    expect(resolveCommitToolbarIntent(true)).toEqual({
      shouldSwitchTab: false,
      shouldFocusEditor: true,
      shouldAlignTreeSelection: true,
    });
    expect(resolveCommitToolbarIntent(false)).toEqual({
      shouldSwitchTab: true,
      shouldFocusEditor: true,
      shouldAlignTreeSelection: true,
    });
  });
});
