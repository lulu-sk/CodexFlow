import { afterEach, describe, expect, it } from "vitest";
import { buildConflictMergeMetadata } from "../../../../../electron/git/commitPanel/conflictMergeMetadata";
import {
  CONFLICT_MERGE_PROPERTIES_SEMANTIC_RESOLVER_ID,
} from "../../../../../electron/git/commitPanel/conflictMergePropertiesSemantic";
import { setConflictMergeSemanticResolversForTesting } from "../../../../../electron/git/commitPanel/conflictMergeSemantic";
import type { GitConflictMergeSnapshot } from "../types";
import {
  applyConflictMergeBlockAutoResolution,
  applyConflictMergeBlockResolution,
  applyConflictMergeNonConflictedChanges,
  applyResolvableConflictMergeBlocks,
  canResolveConflictMergeBlockAutomatically,
  countConflictMergeUnresolvedChanges,
  countConflictMergeUnresolvedConflicts,
  createConflictMergeViewerState,
  hasConflictMergeBlocks,
  ignoreConflictMergeBlockSide,
  resolveConflictMergeAutoResolution,
  updateConflictMergeViewerResultText,
} from "./conflict-merge-model";

/**
 * 构造最小三方冲突快照，统一复用到 merge model 的语义测试。
 */
function createSnapshot(args: {
  base: string;
  ours: string;
  theirs: string;
  working?: string;
  path?: string;
}): GitConflictMergeSnapshot {
  return {
    path: args.path || "src/conflict.ts",
    base: { label: "基线", text: args.base, available: true },
    ours: { label: "你的更改", text: args.ours, available: true },
    theirs: { label: "他们的更改", text: args.theirs, available: true },
    working: { label: "结果", text: args.working ?? args.base, available: true },
    merge: buildConflictMergeMetadata({
      path: args.path || "src/conflict.ts",
      baseText: args.base,
      oursText: args.ours,
      theirsText: args.theirs,
    }),
  };
}

afterEach(() => {
  setConflictMergeSemanticResolversForTesting(null);
});

describe("conflict-merge-model", () => {
  it("应以基线文本初始化结果列，并且不直接展示冲突标记", () => {
    const snapshot = createSnapshot({
      base: "header\nbase line\nfooter\n",
      ours: "header\nours line\nfooter\n",
      theirs: "header\ntheirs line\nfooter\n",
      working: "header\n<<<<<<< ours\nours line\n=======\ntheirs line\n>>>>>>> theirs\nfooter\n",
    });

    const state = createConflictMergeViewerState(snapshot);

    expect(state.resultText).toBe("header\nbase line\nfooter\n");
    expect(state.resultText).not.toContain("<<<<<<<");
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({
      kind: "conflict",
      resultText: "base line\n",
      resolved: false,
      resolvedOurs: false,
      resolvedTheirs: false,
      modified: false,
      onesideApplied: false,
    });
    expect(countConflictMergeUnresolvedChanges(state)).toBe(1);
    expect(countConflictMergeUnresolvedConflicts(state)).toBe(1);
  });

  it("冲突块单侧应用后应进入 onesideApplied，再次应用另一侧时应追加内容", () => {
    const snapshot = createSnapshot({
      base: "header\nbase line\nfooter\n",
      ours: "header\nours line\nfooter\n",
      theirs: "header\ntheirs line\nfooter\n",
    });

    const initialState = createConflictMergeViewerState(snapshot);
    const onesideAppliedState = applyConflictMergeBlockResolution(initialState, 0, "ours");

    expect(onesideAppliedState.resultText).toBe("header\nours line\nfooter\n");
    expect(onesideAppliedState.blocks[0]).toMatchObject({
      resolved: false,
      resolvedOurs: true,
      resolvedTheirs: false,
      modified: false,
      onesideApplied: true,
    });

    const appendedState = applyConflictMergeBlockResolution(onesideAppliedState, 0, "theirs");

    expect(appendedState.resultText).toBe("header\nours line\ntheirs line\nfooter\n");
    expect(appendedState.blocks[0]).toMatchObject({
      resolved: true,
      resolvedOurs: true,
      resolvedTheirs: true,
      modified: false,
      onesideApplied: false,
    });
    expect(countConflictMergeUnresolvedChanges(appendedState)).toBe(0);
  });

  it("gutter 的忽略与接受链路不应把程序态合并误判为手工编辑", () => {
    const snapshot = createSnapshot({
      base: "",
      ours: "left line\n",
      theirs: "right line\n",
      path: "src/empty-base.ts",
    });

    const initialState = createConflictMergeViewerState(snapshot);
    const ignoredState = ignoreConflictMergeBlockSide(initialState, 0, "ours");

    expect(ignoredState.blocks[0]).toMatchObject({
      resolved: false,
      resolvedOurs: true,
      resolvedTheirs: false,
      modified: false,
    });

    const resolvedState = applyConflictMergeBlockResolution(ignoredState, 0, "theirs");

    expect(resolvedState.resultText).toBe("right line\n");
    expect(resolvedState.blocks[0]).toMatchObject({
      resolved: true,
      resolvedOurs: true,
      resolvedTheirs: true,
      modified: false,
      onesideApplied: false,
    });
  });

  it("应用全部不冲突更改时应同时收敛左右两侧的普通变更块", () => {
    const snapshot = createSnapshot({
      base: "start\nbase-left\nmid\nbase-right\nend\n",
      ours: "start\nours-left\nmid\nbase-right\nend\n",
      theirs: "start\nbase-left\nmid\ntheirs-right\nend\n",
      working: "start\nbase-left\nmid\nbase-right\nend\n",
    });

    const initialState = createConflictMergeViewerState(snapshot);
    const applied = applyConflictMergeNonConflictedChanges(initialState, "all");

    expect(applied.resolvedCount).toBeGreaterThanOrEqual(2);
    expect(applied.state.resultText).toBe("start\nours-left\nmid\ntheirs-right\nend\n");
    expect(countConflictMergeUnresolvedChanges(applied.state)).toBe(0);
    expect(countConflictMergeUnresolvedConflicts(applied.state)).toBe(0);
  });

  it("应用右侧中的不冲突更改时应只收敛 right changed 的普通块", () => {
    const snapshot = createSnapshot({
      base: "start\nbase-left\nmid\nbase-right\nend\n",
      ours: "start\nours-left\nmid\nbase-right\nend\n",
      theirs: "start\nbase-left\nmid\ntheirs-right\nend\n",
      working: "start\nbase-left\nmid\nbase-right\nend\n",
    });

    const initialState = createConflictMergeViewerState(snapshot);
    const applied = applyConflictMergeNonConflictedChanges(initialState, "theirs");

    expect(applied.resolvedCount).toBe(1);
    expect(applied.state.resultText).toBe("start\nbase-left\nmid\ntheirs-right\nend\n");
    expect(applied.state.blocks[0]).toMatchObject({
      resolved: false,
      resolvedOurs: false,
      resolvedTheirs: false,
    });
    expect(applied.state.blocks[1]).toMatchObject({
      resolved: true,
      resolvedOurs: true,
      resolvedTheirs: true,
    });
  });

  it("自动处理入口在只有普通变更块时也应可用，并直接应用对应来源", () => {
    const snapshot = createSnapshot({
      base: "start\nbase-left\nmid\nbase-right\nend\n",
      ours: "start\nours-left\nmid\nbase-right\nend\n",
      theirs: "start\nbase-left\nmid\ntheirs-right\nend\n",
      working: "start\nbase-left\nmid\nbase-right\nend\n",
    });

    const initialState = createConflictMergeViewerState(snapshot);

    expect(initialState.blocks).toHaveLength(2);
    expect(canResolveConflictMergeBlockAutomatically(initialState.blocks[0])).toBe(true);
    expect(canResolveConflictMergeBlockAutomatically(initialState.blocks[1])).toBe(true);
    expect(resolveConflictMergeAutoResolution(initialState.blocks[0])).toBe("ours");
    expect(resolveConflictMergeAutoResolution(initialState.blocks[1])).toBe("theirs");

    const applied = applyResolvableConflictMergeBlocks(initialState);

    expect(applied.resolvedCount).toBeGreaterThanOrEqual(2);
    expect(applied.state.resultText).toBe("start\nours-left\nmid\ntheirs-right\nend\n");
  });

  it("解决简单冲突应自动处理上游样例中的文本级可收敛冲突块", () => {
    const snapshot = createSnapshot({
      base: "version: 1.0.0\n",
      ours: "version: 2.0.0\n",
      theirs: "version: 1.0.4\n",
      working: "<<<<<<< ours\nversion: 2.0.0\n=======\nversion: 1.0.4\n>>>>>>> theirs\n",
    });

    const initialState = createConflictMergeViewerState(snapshot);

    expect(initialState.blocks).toHaveLength(1);
    expect(initialState.blocks[0].kind).toBe("conflict");
    expect(resolveConflictMergeAutoResolution(initialState.blocks[0])).toBe("auto");

    const applied = applyResolvableConflictMergeBlocks(initialState);

    expect(applied.resolvedCount).toBe(1);
    expect(applied.state.resultText).toBe("version: 2.0.4\n");
    expect(countConflictMergeUnresolvedChanges(applied.state)).toBe(0);
  });

  it("解决简单冲突应收敛真实 App.tsx 中的一侧包裹 base、另一侧改写主体场景", () => {
    const snapshot = createSnapshot({
      base: [
        "const forceHint = needForceReset",
        "  ? \"reset\"",
        "  : needForceRemove",
        "    ? \"remove\"",
        "    : needForceBranch",
        "      ? \"branch\"",
        "      : \"\";",
        "",
      ].join("\n"),
      ours: [
        "const forceHints = needForceReset",
        "  ? [\"reset\"]",
        "  : [",
        "    needForceRemove ? \"remove\" : \"\",",
        "    needForceBranch ? \"branch\" : \"\",",
        "  ].filter(Boolean);",
        "",
      ].join("\n"),
      theirs: [
        "const selectedResetTargetBranch = String(targetBranch || \"\").trim();",
        "const forceHint = needForceReset",
        "  ? \"reset\"",
        "  : needForceRemove",
        "    ? \"remove\"",
        "    : needForceBranch",
        "      ? \"branch\"",
        "      : \"\";",
        "",
      ].join("\n"),
      working: [
        "<<<<<<< ours",
        "const forceHints = needForceReset",
        "  ? [\"reset\"]",
        "  : [",
        "    needForceRemove ? \"remove\" : \"\",",
        "    needForceBranch ? \"branch\" : \"\",",
        "  ].filter(Boolean);",
        "=======",
        "const selectedResetTargetBranch = String(targetBranch || \"\").trim();",
        "const forceHint = needForceReset",
        "  ? \"reset\"",
        "  : needForceRemove",
        "    ? \"remove\"",
        "    : needForceBranch",
        "      ? \"branch\"",
        "      : \"\";",
        ">>>>>>> theirs",
        "",
      ].join("\n"),
    });

    const initialState = createConflictMergeViewerState(snapshot);

    expect(initialState.blocks).toHaveLength(1);
    expect(initialState.blocks[0]).toMatchObject({
      kind: "conflict",
      resolutionStrategy: "TEXT",
    });

    const applied = applyResolvableConflictMergeBlocks(initialState);

    expect(applied.resolvedCount).toBe(1);
    expect(applied.state.resultText).toBe([
      "const selectedResetTargetBranch = String(targetBranch || \"\").trim();",
      "const forceHints = needForceReset",
      "  ? [\"reset\"]",
      "  : [",
      "    needForceRemove ? \"remove\" : \"\",",
      "    needForceBranch ? \"branch\" : \"\",",
      "  ].filter(Boolean);",
      "",
    ].join("\n"));
    expect(countConflictMergeUnresolvedConflicts(applied.state)).toBe(0);
  });

  it("自动解决应能合并块内多个彼此独立的简单子冲突", () => {
    const baseText = "alpha\nstay\nbeta\n";
    const oursText = "ALPHA\nstay\nbeta\n";
    const theirsText = "alpha\nstay\nBETA\n";
    const manualState = {
      lineEnding: "\n",
      baseTokens: ["alpha\n", "stay\n", "beta\n"],
      oursTokens: ["ALPHA\n", "stay\n", "beta\n"],
      theirsTokens: ["alpha\n", "stay\n", "BETA\n"],
      resultTokens: ["alpha\n", "stay\n", "beta\n"],
      initialResultTokens: ["alpha\n", "stay\n", "beta\n"],
      resultText: baseText,
      initialResultText: baseText,
      blocks: [{
        index: 0,
        kind: "conflict" as const,
        conflictType: "CONFLICT" as const,
        resolutionStrategy: "TEXT" as const,
        semanticResolverId: null,
        semanticResolvedText: null,
        isImportChange: false,
        summary: "alpha",
        hasBase: true,
        baseText,
        oursText,
        theirsText,
        resultText: baseText,
        changedInOurs: true,
        changedInTheirs: true,
        resolvedOurs: false,
        resolvedTheirs: false,
        resolved: false,
        modified: false,
        onesideApplied: false,
        baseRange: { startLine: 1, endLine: 3, anchorLine: 1 },
        oursRange: { startLine: 1, endLine: 3, anchorLine: 1 },
        theirsRange: { startLine: 1, endLine: 3, anchorLine: 1 },
        resultRange: { startLine: 1, endLine: 3, anchorLine: 1 },
        baseStart: 0,
        baseEnd: 3,
        oursStart: 0,
        oursEnd: 3,
        theirsStart: 0,
        theirsEnd: 3,
        resultStart: 0,
        resultEnd: 3,
      }],
      path: "src/manual.ts",
      importMetadata: null,
      resultImportRange: null,
    };

    expect(canResolveConflictMergeBlockAutomatically(manualState.blocks[0])).toBe(true);
    expect(resolveConflictMergeAutoResolution(manualState.blocks[0])).toBe("auto");

    const applied = applyConflictMergeBlockAutoResolution(manualState, 0);

    expect(applied.resultText).toBe("ALPHA\nstay\nBETA\n");
    expect(applied.blocks[0]).toMatchObject({
      resolved: true,
      resolvedOurs: true,
      resolvedTheirs: true,
    });
  });

  it("TS/TSX 应退回文本层，并在 replay 场景保持单份 import block", () => {
    const snapshot = createSnapshot({
      path: "web/src/App.tsx",
      base: [
        "import {",
        "  GitMerge,",
        "  Loader2,",
        "} from \"lucide-react\";",
        "import {",
        "  loadWorktreeDeletePrefs,",
        "  saveWorktreeDeletePrefs,",
        "} from \"./prefs\";",
        "import type {",
        "  DialogState,",
        "} from \"./types\";",
        "",
        "const icon = GitMerge;",
        "const spacer = keepBase();",
        "const deletePrefs = loadWorktreeDeletePrefs();",
        "",
      ].join("\n"),
      ours: [
        "import {",
        "  GitMerge,",
        "  GitBranch,",
        "  Loader2,",
        "} from \"lucide-react\";",
        "import {",
        "  loadWorktreeDeletePrefs,",
        "  saveWorktreeDeletePrefs,",
        "} from \"./prefs\";",
        "import { resolveWorktreeDeleteResetTargetBranch } from \"./delete\";",
        "import type {",
        "  DialogState,",
        "} from \"./types\";",
        "",
        "const icon = GitBranch;",
        "const spacer = keepBase();",
        "const deletePrefs = resolveWorktreeDeleteResetTargetBranch(loadWorktreeDeletePrefs());",
        "",
      ].join("\n"),
      theirs: [
        "import {",
        "  GitMerge,",
        "  Loader2,",
        "} from \"lucide-react\";",
        "import {",
        "  loadWorktreeDeletePrefs,",
        "  saveWorktreeDeletePrefs,",
        "} from \"./prefs\";",
        "import type {",
        "  DialogState,",
        "} from \"./types\";",
        "",
        "const icon = GitMerge;",
        "const spacer = keepBase();",
        "const deletePrefs = loadWorktreeDeletePrefs();",
        "",
      ].join("\n"),
    });

    const initialState = createConflictMergeViewerState(snapshot);

    expect(initialState.blocks.some((block) => block.isImportChange)).toBe(false);

    const applied = applyResolvableConflictMergeBlocks(initialState);
    const resultText = applied.state.resultText;
    const lucideImportMatches = resultText.match(/import \{\n  GitMerge,\n  GitBranch,\n  Loader2,\n\} from \"lucide-react\";\n/g) || [];
    const typeImportMatches = resultText.match(/import type \{\n  DialogState,\n\} from \"\.\/types\";\n/g) || [];

    expect(applied.resolvedCount).toBeGreaterThanOrEqual(2);
    expect(lucideImportMatches).toHaveLength(1);
    expect(typeImportMatches).toHaveLength(1);
    expect(resultText).toContain("const icon = GitBranch;\n");
    expect(resultText).toContain("const deletePrefs = resolveWorktreeDeleteResetTargetBranch(loadWorktreeDeletePrefs());\n");
  });

  it("SEMANTIC 块应支持自动解决，并在结果文本变化后重新计算 resolver 结果", () => {
    setConflictMergeSemanticResolversForTesting([{
      id: "semantic-fixture",
      isApplicable(filePath) {
        return filePath.endsWith(".ts");
      },
      resolve(context) {
        if (context.resultText.includes("manual")) return null;
        return "const value = buildSemanticMerged();\n";
      },
    }]);
    const snapshot = createSnapshot({
      path: "src/semantic.ts",
      base: "const value = createBaseNode();\n",
      ours: "const value = createLeftNode();\n",
      theirs: "const value = createRightNode();\n",
    });

    const initialState = createConflictMergeViewerState(snapshot);

    expect(initialState.blocks[0]).toMatchObject({
      kind: "conflict",
      resolutionStrategy: "SEMANTIC",
      semanticResolverId: "semantic-fixture",
      semanticResolvedText: "const value = buildSemanticMerged();\n",
    });
    expect(canResolveConflictMergeBlockAutomatically(initialState.blocks[0])).toBe(true);
    expect(resolveConflictMergeAutoResolution(initialState.blocks[0])).toBe("auto");

    const applied = applyConflictMergeBlockAutoResolution(initialState, 0);

    expect(applied.resultText).toBe("const value = buildSemanticMerged();\n");
    expect(applied.blocks[0]).toMatchObject({
      resolved: true,
      resolvedOurs: true,
      resolvedTheirs: true,
    });

    const editedState = updateConflictMergeViewerResultText(initialState, "const manual = true;\n");

    expect(editedState.blocks[0].semanticResolvedText).toBeNull();
    expect(canResolveConflictMergeBlockAutomatically(editedState.blocks[0])).toBe(false);
  });

  it("真实 .properties semantic 结果在结果列被改坏后应重新失效", () => {
    const snapshot = createSnapshot({
      path: "src/messages.properties",
      base: "",
      ours: "left.key = left value\n",
      theirs: "right.key = right value\n",
    });

    const initialState = createConflictMergeViewerState(snapshot);

    expect(initialState.blocks[0]).toMatchObject({
      kind: "conflict",
      resolutionStrategy: "SEMANTIC",
      semanticResolverId: CONFLICT_MERGE_PROPERTIES_SEMANTIC_RESOLVER_ID,
      semanticResolvedText: "left.key=left value\nright.key=right value",
    });
    expect(canResolveConflictMergeBlockAutomatically(initialState.blocks[0])).toBe(true);

    const applied = applyConflictMergeBlockAutoResolution(initialState, 0);

    expect(applied.resultText).toBe("left.key=left value\nright.key=right value");

    const editedState = updateConflictMergeViewerResultText(
      initialState,
      "left.key = manual value\nleft.key = duplicated value\n",
    );

    expect(editedState.blocks[0].semanticResolverId).toBe(CONFLICT_MERGE_PROPERTIES_SEMANTIC_RESOLVER_ID);
    expect(editedState.blocks[0].semanticResolvedText).toBeNull();
    expect(canResolveConflictMergeBlockAutomatically(editedState.blocks[0])).toBe(false);
  });

  it("结果列发生多处独立编辑后，应保留未触及块的精确坐标与自动解决资格", () => {
    const snapshot = createSnapshot({
      base: "head\nbase-one\nmid\nbase-two\nafter\n",
      ours: "head\nours-one\nmid\nbase-two\nafter\n",
      theirs: "head\nbase-one\nmid\ntheirs-two\nafter\n",
    });

    const initialState = createConflictMergeViewerState(snapshot);
    const editedState = updateConflictMergeViewerResultText(
      initialState,
      "head\nmanual-one\nmid\nbase-two\nmanual-after\n",
    );

    expect(editedState.blocks[0]).toMatchObject({
      resultText: "manual-one\n",
      modified: true,
    });
    expect(editedState.blocks[1]).toMatchObject({
      resultText: "base-two\n",
      resultRange: {
        startLine: 4,
        endLine: 4,
      },
      modified: false,
    });
    expect(canResolveConflictMergeBlockAutomatically(editedState.blocks[1])).toBe(true);
  });

  it("结果列被手工编辑后应把受影响块标记为 modified", () => {
    const snapshot = createSnapshot({
      base: "header\nbase line\nfooter\n",
      ours: "header\nours line\nfooter\n",
      theirs: "header\ntheirs line\nfooter\n",
    });

    const initialState = createConflictMergeViewerState(snapshot);
    const editedState = updateConflictMergeViewerResultText(initialState, "header\nmanual line\nfooter\n");

    expect(editedState.resultText).toBe("header\nmanual line\nfooter\n");
    expect(editedState.blocks[0].modified).toBe(true);
  });

  it("仍应保留对用户手工粘贴冲突标记的兜底检测", () => {
    expect(hasConflictMergeBlocks("<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n")).toBe(true);
    expect(hasConflictMergeBlocks("plain text\nwithout markers\n")).toBe(false);
  });
});
