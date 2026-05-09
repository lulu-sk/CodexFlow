import { describe, expect, it } from "vitest";
import { canOpenDiffForCommitEntry, resolveCommitOpenAction, resolveCommitPreviewDiffMode } from "./interaction-model";

const VIEW_OPTIONS = {
  groupByDirectory: false,
  showIgnored: false,
  detailsPreviewShown: true,
  diffPreviewOnDoubleClickOrEnter: true,
  manyFilesThreshold: 1000,
} as const;

describe("commit panel interaction model", () => {
  it("开启 diffPreviewOnDoubleClickOrEnter 时，双击文件应优先打开 Diff", () => {
    expect(resolveCommitOpenAction(VIEW_OPTIONS, "doubleClick", true)).toBe("diff");
    expect(resolveCommitOpenAction(VIEW_OPTIONS, "enter", true)).toBe("diff");
  });

  it("关闭 diffPreviewOnDoubleClickOrEnter 时，双击与回车应打开源文件，而 F4 始终打开源文件", () => {
    const nextViewOptions = { ...VIEW_OPTIONS, diffPreviewOnDoubleClickOrEnter: false };
    expect(resolveCommitOpenAction(nextViewOptions, "doubleClick", true)).toBe("source");
    expect(resolveCommitOpenAction(nextViewOptions, "enter", true)).toBe("source");
    expect(resolveCommitOpenAction(nextViewOptions, "f4", true)).toBe("source");
  });

  it("详情预览关闭时，单击不应自动打开 Diff", () => {
    const nextViewOptions = { ...VIEW_OPTIONS, detailsPreviewShown: false };
    expect(resolveCommitOpenAction(nextViewOptions, "singleClick", true)).toBe("none");
  });

  it("已忽略文件不应进入 Diff 打开链路", () => {
    expect(canOpenDiffForCommitEntry({
      path: "dist/app.js",
      x: "!",
      y: "!",
      staged: false,
      unstaged: false,
      untracked: false,
      ignored: true,
      renamed: false,
      deleted: false,
      statusText: "已忽略",
      changeListId: "",
    })).toBe(false);
  });

  it("暂存区模式下，已暂存文件应打开 staged Diff", () => {
    expect(resolveCommitPreviewDiffMode({
      path: "src/app.ts",
      x: "M",
      y: ".",
      staged: true,
      unstaged: false,
      untracked: false,
      ignored: false,
      renamed: false,
      deleted: false,
      statusText: "已暂存",
      changeListId: "default",
    }, {
      stagingAreaEnabled: true,
      changeListsEnabled: false,
    })).toBe("staged");
  });

  it("未启用暂存区时，仅已暂存文件也应打开 staged Diff", () => {
    expect(resolveCommitPreviewDiffMode({
      path: "src/app.ts",
      x: "M",
      y: ".",
      staged: true,
      unstaged: false,
      untracked: false,
      ignored: false,
      renamed: false,
      deleted: false,
      statusText: "已暂存",
      changeListId: "default",
    }, {
      stagingAreaEnabled: false,
      changeListsEnabled: false,
    })).toBe("staged");
  });

  it("未启用暂存区时，已暂存且仍有未暂存改动的文件应保持 working Diff", () => {
    expect(resolveCommitPreviewDiffMode({
      path: "src/app.ts",
      x: "M",
      y: "M",
      staged: true,
      unstaged: true,
      untracked: false,
      ignored: false,
      renamed: false,
      deleted: false,
      statusText: "已修改",
      changeListId: "default",
    }, {
      stagingAreaEnabled: false,
      changeListsEnabled: false,
    })).toBe("working");
  });
});
