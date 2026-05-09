import { describe, expect, it } from "vitest";
import {
  buildConflictContextActionKeys,
  collectSelectedConflictPaths,
  resolveConflictContextMenuRequest,
} from "./change-context-actions";

describe("change context actions", () => {
  const resolveText = (key: string, fallback: string): string => {
    const map: Record<string, string> = {
      "workbench.changes.context.conflictDialog.title": "解决冲突",
      "workbench.changes.context.conflictDialog.description": "已按当前选择预选冲突文件，可直接批量采用 Yours/Theirs，或继续逐个打开 Merge 工具。",
      "workbench.changes.context.conflictDialog.acceptYoursAction": "接受 Yours ",
      "workbench.changes.context.conflictDialog.acceptTheirsAction": "接受 Theirs ",
    };
    return map[key] || fallback;
  };

  it("应只收集未解决冲突路径，并统一去重为 `/` 分隔", () => {
    expect(collectSelectedConflictPaths([
      { path: "src\\conflict.ts", conflictState: "conflict" },
      { path: "src/conflict.ts", conflictState: "conflict" },
      { path: "src/resolved.ts", conflictState: "resolved" },
      { path: "src/plain.ts", conflictState: undefined },
    ] as any)).toEqual(["src/conflict.ts"]);
  });

  it("存在冲突选择时，右键动作顺序应固定为 Merge、Accept Theirs、Accept Yours", () => {
    expect(buildConflictContextActionKeys([
      { path: "src/conflict.ts", conflictState: "conflict" },
    ] as any)).toEqual(["mergeConflicts", "acceptTheirs", "acceptYours"]);
  });

  it("Merge 在单选与多选冲突时应分别落到 merge dialog 与 resolver dialog", () => {
    expect(resolveConflictContextMenuRequest("mergeConflicts", [
      { path: "src/conflict.ts", conflictState: "conflict" },
    ] as any)).toEqual({
      kind: "openMergeDialog",
      path: "src/conflict.ts",
    });

    expect(resolveConflictContextMenuRequest("mergeConflicts", [
      { path: "src/a.ts", conflictState: "conflict" },
      { path: "src/b.ts", conflictState: "conflict" },
    ] as any, resolveText)).toEqual({
      kind: "openResolverDialog",
      title: "解决冲突",
      description: "已按当前选择预选冲突文件，可直接批量采用 Yours/Theirs，或继续逐个打开 Merge 工具。",
      focusPath: "src/a.ts",
      checkedPaths: ["src/a.ts", "src/b.ts"],
    });
  });

  it("Accept Yours/Theirs 应映射到对应 side 与失败提示文案", () => {
    expect(resolveConflictContextMenuRequest("acceptYours", [
      { path: "src/a.ts", conflictState: "conflict" },
      { path: "src/b.ts", conflictState: "conflict" },
    ] as any, resolveText)).toEqual({
      kind: "applySide",
      side: "ours",
      paths: ["src/a.ts", "src/b.ts"],
      failureActionText: "接受 Yours ",
    });

    expect(resolveConflictContextMenuRequest("acceptTheirs", [
      { path: "src/a.ts", conflictState: "conflict" },
    ] as any, resolveText)).toEqual({
      kind: "applySide",
      side: "theirs",
      paths: ["src/a.ts"],
      failureActionText: "接受 Theirs ",
    });
  });
});
