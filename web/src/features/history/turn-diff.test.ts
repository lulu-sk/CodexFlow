import { describe, expect, it } from "vitest";

import { buildHistoryDiffSplitRows, formatHistoryDiffPath, parseHistoryTurnDiff } from "./turn-diff";

describe("parseHistoryTurnDiff", () => {
  it("按文件统计新增和删除行，并保留新旧行号", () => {
    const parsed = parseHistoryTurnDiff([
      "diff --git a/src/first.ts b/src/first.ts",
      "--- a/src/first.ts",
      "+++ b/src/first.ts",
      "@@ -2,2 +2,3 @@",
      " unchanged",
      "-oldValue();",
      "+newValue();",
      "+anotherValue();",
      "diff --git a/src/second.ts b/src/second.ts",
      "--- a/src/second.ts",
      "+++ b/src/second.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ].join("\n"));

    expect(parsed).toMatchObject({ additions: 3, deletions: 2 });
    expect(parsed.files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions }))).toEqual([
      { path: "src/first.ts", additions: 2, deletions: 1 },
      { path: "src/second.ts", additions: 1, deletions: 1 },
    ]);
    expect(parsed.files[0]?.lines.find((line) => line.kind === "context")).toMatchObject({ oldLine: 2, newLine: 2 });
    expect(parsed.files[0]?.lines.find((line) => line.kind === "addition")).toMatchObject({ oldLine: null, newLine: 3 });
    expect(parsed.files[0]?.lines.find((line) => line.kind === "hunk")).toMatchObject({ unchangedLines: 1 });
    expect(parsed.files[1]?.lines.find((line) => line.kind === "hunk")).toMatchObject({ unchangedLines: 0 });
  });

  it("把 hunk 头转换为首次及后续省略的未修改行数", () => {
    const parsed = parseHistoryTurnDiff([
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -25,2 +25,2 @@",
      "-before",
      "+after",
      " context",
      "@@ -30 +30 @@",
      "-second-before",
      "+second-after",
    ].join("\n"));

    expect(parsed.files[0]?.lines.filter((line) => line.kind === "hunk")).toMatchObject([
      { unchangedLines: 24 },
      { unchangedLines: 3 },
    ]);
  });

  it("左右比较会按修改块配对增删行，并保留上下文与 hunk 边界", () => {
    const parsed = parseHistoryTurnDiff([
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,4 +1,5 @@",
      "-old-one",
      "-old-two",
      "+new-one",
      "+new-two",
      "+new-three",
      " context",
      "@@ -10 +11 @@",
      "-later-old",
      "+later-new",
    ].join("\n"));

    const rows = buildHistoryDiffSplitRows(parsed.files[0]?.lines || []);
    expect(rows.map((row) => row.kind === "hunk"
      ? { kind: row.kind, unchangedLines: row.unchangedLines }
      : { kind: row.kind, left: row.left?.text || null, right: row.right?.text || null })).toEqual([
      { kind: "content", left: "-old-one", right: "+new-one" },
      { kind: "content", left: "-old-two", right: "+new-two" },
      { kind: "content", left: null, right: "+new-three" },
      { kind: "content", left: " context", right: " context" },
      { kind: "hunk", unchangedLines: 6 },
      { kind: "content", left: "-later-old", right: "+later-new" },
    ]);
  });

  it("删除文件时使用旧路径作为标题", () => {
    const parsed = parseHistoryTurnDiff([
      "diff --git a/docs/old.md b/docs/old.md",
      "deleted file mode 100644",
      "--- a/docs/old.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-removed",
    ].join("\n"));

    expect(parsed.files[0]?.path).toBe("docs/old.md");
    expect(parsed.deletions).toBe(1);
  });

  it("纯重命名从带引号的差异头识别目标路径，保留各文件的独立摘要", () => {
    const parsed = parseHistoryTurnDiff([
      'diff --git "a/old name.bin" "b/new name.bin"',
      "similarity index 100%",
      "rename from old name.bin",
      "rename to new name.bin",
      'diff --git "a/old \\"quoted\\".bin" "b/new \\"quoted\\".bin"',
      "similarity index 100%",
      'rename from old "quoted".bin',
      'rename to new "quoted".bin',
    ].join("\n"));

    expect(parsed.files.map((file) => file.path)).toEqual(["new name.bin", 'new "quoted".bin']);
    expect(parsed.summaryFiles).toHaveLength(2);
    expect(parsed.files[0]?.lines.map((line) => line.text)).toContain("rename to new name.bin");
  });

  it("解析并合并同一轮中的多个 apply_patch 文件记录", () => {
    const parsed = parseHistoryTurnDiff([
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "@@",
      "-export const value = 1;",
      "+export const value = 2;",
      "*** End Patch",
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "@@",
      "-export const value = 2;",
      "+export const value = 3;",
      "*** Add File: src/added.ts",
      "+export const added = true;",
      "*** End Patch",
    ].join("\n"));

    expect(parsed.format).toBe("apply_patch");
    expect(parsed).toMatchObject({ additions: 3, deletions: 2 });
    expect(parsed.files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions }))).toEqual([
      { path: "src/example.ts", additions: 2, deletions: 2 },
      { path: "src/added.ts", additions: 1, deletions: 0 },
    ]);
  });

  it("审核保留原始差异段，摘要按路径合并文件数量", () => {
    const parsed = parseHistoryTurnDiff([
      "diff --git a/C:/workspace/project/Client/Packages/first.json b/C:/workspace/project/Client/Packages/first.json",
      "--- a/C:/workspace/project/Client/Packages/first.json",
      "+++ b/C:/workspace/project/Client/Packages/first.json",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "diff --git a/C:/workspace/project/Client/Packages/second.json b/C:/workspace/project/Client/Packages/second.json",
      "--- a/C:/workspace/project/Client/Packages/second.json",
      "+++ b/C:/workspace/project/Client/Packages/second.json",
      "@@ -1 +1,2 @@",
      "-old",
      "+new",
      "+extra",
      "diff --git a/C:/workspace/project/Client/Packages/second.json b/C:/workspace/project/Client/Packages/second.json",
      "--- a/C:/workspace/project/Client/Packages/second.json",
      "+++ b/C:/workspace/project/Client/Packages/second.json",
      "@@ -8 +8 @@",
      "-second-old",
      "+second-new",
    ].join("\n"));

    expect(parsed).toMatchObject({ additions: 4, deletions: 3, rawFileCount: 3 });
    expect(parsed.files).toHaveLength(3);
    expect(parsed.summaryFiles.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions }))).toEqual([
      { path: "C:/workspace/project/Client/Packages/first.json", additions: 1, deletions: 1 },
      { path: "C:/workspace/project/Client/Packages/second.json", additions: 3, deletions: 2 },
    ]);
  });

  it("会把工作目录内的绝对路径显示为相对路径", () => {
    expect(formatHistoryDiffPath(
      "C:\\workspace\\project\\Client\\Packages\\manifest.json",
      "C:\\workspace\\project",
    )).toBe("Client/Packages/manifest.json");
    expect(formatHistoryDiffPath(
      "C:\\workspace\\peer-project\\Client\\Packages\\manifest.json",
      "C:\\workspace\\project",
    )).toBe("C:/workspace/peer-project/Client/Packages/manifest.json");
  });
});
