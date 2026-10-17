import { describe, expect, it } from "vitest";
import { historyDiffFileKey, resolveHistoryDiffFilePath, resolveHistoryDiffPathBase, selectHistoryTurnDiffFiles } from "./turn-diff-file-actions";

const FIRST_DIFF = [
  "diff --git a/src/first.ts b/src/first.ts",
  "--- a/src/first.ts",
  "+++ b/src/first.ts",
  "@@ -1 +1 @@",
  "-old-first",
  "+new-first",
].join("\n");
const SECOND_DIFF = [
  "diff --git a/src/second.ts b/src/second.ts",
  "--- a/src/second.ts",
  "+++ b/src/second.ts",
  "@@ -1 +1 @@",
  "-old-second",
  "+new-second",
].join("\n");

describe("历史差异的单文件操作", () => {
  it("只选择目标文件，并保留同文件的全部原始差异段和顺序", () => {
    const repeated = FIRST_DIFF.replace("new-first", "newer-first");
    const selected = selectHistoryTurnDiffFiles([FIRST_DIFF, SECOND_DIFF, repeated].join("\n"), ["src/first.ts"]);
    expect(selected).toBe(`${FIRST_DIFF}\n${repeated}\n`);
    expect(selected).not.toContain("second.ts");
  });

  it("保留统一差异中的重命名与二进制元数据", () => {
    const rename = ["diff --git a/old.bin b/new.bin", "similarity index 100%", "rename from old.bin", "rename to new.bin"].join("\n");
    expect(selectHistoryTurnDiffFiles(`${rename}\n${SECOND_DIFF}`, ["new.bin"])).toBe(`${rename}\n`);
  });

  it("apply_patch 只保留目标文件操作，并保留连续修改及移动信息", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: first.ts", "@@", "-before", "+middle",
      "*** Update File: second.ts", "@@", "-other", "+changed",
      "*** Update File: first.ts", "*** Move to: renamed.ts", "@@", "-middle", "+after",
      "*** End Patch",
    ].join("\n");
    const selected = selectHistoryTurnDiffFiles(patch, ["first.ts -> renamed.ts"]);
    expect(selected).toBe([
      "*** Begin Patch",
      "*** Update File: first.ts", "@@", "-before", "+middle",
      "*** Update File: first.ts", "*** Move to: renamed.ts", "@@", "-middle", "+after",
      "*** End Patch", "",
    ].join("\n"));
    expect(selected).not.toContain("second.ts");
  });

  it("选择全部文件保留原文，未匹配文件返回空补丁", () => {
    const diffText = `${FIRST_DIFF}\r\n${SECOND_DIFF}\r\n`;
    expect(selectHistoryTurnDiffFiles(diffText, ["src/first.ts", "src/second.ts"])).toBe(diffText);
    expect(selectHistoryTurnDiffFiles(diffText, ["missing.ts"])).toBe("");
    expect(selectHistoryTurnDiffFiles("diff --git malformed", ["unknown"])).toBe("");
  });

  it("选择部分 apply_patch 文件时仍保留跨文件的原始操作顺序", () => {
    const operations = [
      "*** Update File: first.ts\n@@\n-one\n+two",
      "*** Update File: second.ts\n@@\n-before\n+after",
      "*** Update File: first.ts\n*** Move to: renamed.ts\n@@\n-two\n+three",
      "*** Add File: third.ts\n+keep",
    ];
    const patch = `*** Begin Patch\n${operations.join("\n")}\n*** End Patch`;
    expect(selectHistoryTurnDiffFiles(patch, ["first.ts -> renamed.ts", "second.ts"]))
      .toBe(`*** Begin Patch\n${operations.slice(0, 3).join("\n")}\n*** End Patch\n`);
  });

  it("路径匹配保留 Linux 大小写，并兼容 Windows 大小写及分隔符", () => {
    expect(historyDiffFileKey("C:\\workspace\\file.ts")).toBe(historyDiffFileKey("c:/workspace/file.ts"));
    expect(historyDiffFileKey("/workspace/File.ts")).not.toBe(historyDiffFileKey("/workspace/file.ts"));
  });

  it("打开文件使用项目路径，兼容 WSL 挂载盘和移动记录", () => {
    expect(resolveHistoryDiffFilePath("src/file.ts", "C:\\workspace\\project")).toBe("C:\\workspace\\project\\src\\file.ts");
    expect(resolveHistoryDiffFilePath("/mnt/c/workspace/file.ts")).toBe("C:\\workspace\\file.ts");
    expect(resolveHistoryDiffFilePath("before.ts -> src/after.ts", undefined, "/workspace/project")).toBe("/workspace/project/src/after.ts");
    expect(resolveHistoryDiffFilePath("src/file.ts", "C:\\workspace\\project", "C:\\workspace\\project\\packages\\client"))
      .toBe("C:\\workspace\\project\\packages\\client\\src\\file.ts");
    expect(resolveHistoryDiffFilePath("relative.ts")).toBe("");
  });

  it("标准 Git 差异相对项目，FileChange 与 apply_patch 相对真实工作目录", () => {
    const projectWinPath = "C:\\workspace\\project";
    const cwd = "C:\\workspace\\project\\packages\\client";
    expect(resolveHistoryDiffPathBase({ source: "turn_diff", format: "unified", projectWinPath, cwd })).toBe(projectWinPath);
    expect(resolveHistoryDiffPathBase({ source: "file_change", format: "unified", projectWinPath, cwd })).toBe(cwd);
    expect(resolveHistoryDiffPathBase({ source: "apply_patch", format: "apply_patch", projectWinPath, cwd })).toBe(cwd);
    expect(resolveHistoryDiffPathBase({ format: "apply_patch", projectWinPath, cwd })).toBe(cwd);
    expect(resolveHistoryDiffPathBase({ format: "unified", projectWinPath, cwd })).toBe(projectWinPath);
  });
});
