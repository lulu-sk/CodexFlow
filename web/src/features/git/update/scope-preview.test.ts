import { describe, expect, it } from "vitest";
import type { GitUpdateOptions, GitUpdateScopePreview } from "./types";
import {
  buildRuntimeUpdateScopePayload,
  shouldPromptRuntimeUpdateScope,
} from "./scope-preview";

/**
 * 构造最小 scope 预览，避免每个测试重复拼接无关字段。
 */
function createScopePreview(input?: Partial<GitUpdateScopePreview>): GitUpdateScopePreview {
  return {
    requestedRepoRoot: "/repo",
    multiRoot: true,
    includedRepoRoots: ["/repo", "/repo-lib", "/repo/submodule-a"],
    skippedRoots: [],
    roots: [
      {
        repoRoot: "/repo",
        rootName: "repo",
        kind: "repository",
        depth: 0,
        detachedHead: false,
        source: "current",
        included: true,
      },
      {
        repoRoot: "/repo-lib",
        rootName: "repo-lib",
        kind: "repository",
        depth: 0,
        detachedHead: false,
        source: "linked",
        included: true,
      },
      {
        repoRoot: "/repo/submodule-a",
        rootName: "submodule-a",
        kind: "submodule",
        parentRepoRoot: "/repo",
        depth: 1,
        detachedHead: false,
        source: "submodule",
        included: true,
      },
    ],
    ...(input || {}),
  };
}

describe("scope-preview", () => {
  it("多仓存在可选根时应提示运行期范围对话框", () => {
    expect(shouldPromptRuntimeUpdateScope(createScopePreview())).toBe(true);
    expect(shouldPromptRuntimeUpdateScope(createScopePreview({
      multiRoot: false,
      includedRepoRoots: ["/repo"],
      roots: [{
        repoRoot: "/repo",
        rootName: "repo",
        kind: "repository",
        depth: 0,
        detachedHead: false,
        source: "current",
        included: true,
      }],
    }))).toBe(false);
  });

  it("应把运行期勾选结果转换为显式 repoRoots/skipRoots payload", () => {
    const options: GitUpdateOptions = {
      updateMethod: "merge",
      saveChangesPolicy: "shelve",
      scope: {
        syncStrategy: "linked",
        linkedRepoRoots: ["/repo-lib"],
        skippedRepoRoots: [],
        includeNestedRoots: true,
        rootScanMaxDepth: 6,
      },
    };
    const payload = buildRuntimeUpdateScopePayload(options, createScopePreview(), ["/repo", "/repo/submodule-a"]);
    expect(payload).toEqual({
      repoRoots: ["/repo", "/repo/submodule-a"],
      skipRoots: ["/repo-lib"],
      includeNestedRoots: true,
      rootScanMaxDepth: 6,
    });
  });
});
