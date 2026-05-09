import { describe, expect, it } from "vitest";
import {
  buildCommitDetailsActionGroups,
  buildCommitDetailsContextMenuGroups,
  buildCommitDetailsSelectionChanges,
  getCommitDetailsActionItem,
  resolveCommitDetailsSelectionHashResolution,
} from "./detail-actions";

describe("detail-actions", () => {
  const resolveText = (key: string, fallback: string): string => {
    const map: Record<string, string> = {
      "details.actions.showDiff": "显示差异",
      "details.actions.compareRevisions": "比较版本",
      "details.actions.compareLocal": "与本地比较",
      "details.actions.comparePreviousLocal": "将之前版本与本地版本进行比较",
      "details.actions.editSource": "编辑源",
      "details.actions.openRepositoryVersion": "打开仓库版本",
      "details.actions.revertSelectedChanges": "还原所选更改",
      "details.actions.applySelectedChanges": "优选所选更改",
      "details.actions.extractSelectedChanges": "将所选更改提取到单独的提交...",
      "details.actions.dropSelectedChanges": "删除所选更改",
      "details.actions.createPatch": "创建补丁...",
      "details.actions.restoreFromRevision": "从修订中获取",
      "details.actions.pathHistory": "迄今为止的历史记录",
      "details.actions.toggleParentChanges": "显示对父项的更改",
    };
    return map[key] || fallback;
  };

  it("应按详情树已选路径构建 committed changes 载荷", () => {
    const changes = buildCommitDetailsSelectionChanges([
      { path: "src\\main.ts", status: "M" },
      { path: "src/renamed.ts", oldPath: "src/old.ts", status: "R100" },
    ], ["src/main.ts", "src/renamed.ts"]);
    expect(changes).toEqual([
      { path: "src/main.ts", oldPath: undefined, status: "M" },
      { path: "src/renamed.ts", oldPath: "src/old.ts", status: "R100" },
    ]);
  });

  it("缺失 availability 时应回退为不可见不可用", () => {
    expect(getCommitDetailsActionItem(null, "editSource")).toEqual({
      visible: false,
      enabled: false,
    });
  });

  it("应按详情树选中文件解析提交哈希分布，并标记缺失 / 歧义路径", () => {
    expect(resolveCommitDetailsSelectionHashResolution(
      ["src/a.ts", "src/b.ts", "src/c.ts"],
      (targetPath) => {
        if (targetPath === "src/a.ts") return ["11111111"];
        if (targetPath === "src/b.ts") return ["22222222", "33333333"];
        return [];
      },
    )).toEqual({
      items: [
        { path: "src/a.ts", hashes: ["11111111"], uniqueHash: "11111111" },
        { path: "src/b.ts", hashes: ["22222222", "33333333"], uniqueHash: undefined },
        { path: "src/c.ts", hashes: [], uniqueHash: undefined },
      ],
      uniqueHashes: ["11111111", "22222222", "33333333"],
      missingPaths: ["src/c.ts"],
      ambiguousPaths: ["src/b.ts"],
      allPathsHaveSingleHash: false,
    });
  });

  it("应按 IDEA committed changes 菜单层级输出详情右键分组", () => {
    const availability = {
      actions: {
        editSource: { visible: true, enabled: true },
        openRepositoryVersion: { visible: true, enabled: true },
        revertSelectedChanges: { visible: true, enabled: true },
        applySelectedChanges: { visible: true, enabled: true },
        extractSelectedChanges: { visible: true, enabled: true },
        dropSelectedChanges: { visible: true, enabled: false, reason: "不可删除" },
        showHistoryForRevision: { visible: true, enabled: true },
      },
    };

    expect(buildCommitDetailsContextMenuGroups(availability)).toEqual([
      ["showDiff", "compareRevisions", "compareLocal", "comparePreviousLocal", "editSource", "openRepositoryVersion"],
      ["revertSelectedChanges", "applySelectedChanges", "extractSelectedChanges", "dropSelectedChanges", "createPatch", "restoreFromRevision"],
      ["pathHistory", "toggleParentChanges"],
    ]);

    expect(buildCommitDetailsActionGroups(availability, resolveText)).toEqual([
      {
        id: "compare",
        items: [
          { id: "showDiff", label: "显示差异", shortcut: "Ctrl+D" },
          { id: "compareRevisions", label: "比较版本" },
          { id: "compareLocal", label: "与本地比较" },
          { id: "comparePreviousLocal", label: "将之前版本与本地版本进行比较" },
          { id: "editSource", label: "编辑源", shortcut: "F4", enabled: true, reason: undefined },
          { id: "openRepositoryVersion", label: "打开仓库版本", enabled: true, reason: undefined },
        ],
      },
      {
        id: "changes",
        items: [
          { id: "revertSelectedChanges", label: "还原所选更改", enabled: true, reason: undefined },
          { id: "applySelectedChanges", label: "优选所选更改", enabled: true, reason: undefined },
          { id: "extractSelectedChanges", label: "将所选更改提取到单独的提交...", enabled: true, reason: undefined },
          { id: "dropSelectedChanges", label: "删除所选更改", enabled: false, reason: "不可删除", tone: "danger" },
          { id: "createPatch", label: "创建补丁..." },
          { id: "restoreFromRevision", label: "从修订中获取" },
        ],
      },
      {
        id: "history",
        items: [
          { id: "pathHistory", label: "迄今为止的历史记录", enabled: true, reason: undefined },
          { id: "toggleParentChanges", label: "显示对父项的更改" },
        ],
      },
    ]);
  });
});
