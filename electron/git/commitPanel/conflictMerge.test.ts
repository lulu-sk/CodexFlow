import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { GitExecResult } from "../exec";
import {
  describeConflictResolverEntriesAsync,
  getConflictMergeSnapshotAsync,
} from "./conflictMerge";
import { buildConflictMergeMetadata } from "./conflictMergeMetadata";
import {
  setConflictMergeSemanticResolversForTesting,
  type GitConflictMergeSemanticResolver,
} from "./conflictMergeSemantic";
import { tryResolveConflictMergeText } from "./conflictMergeTextResolve";

const cleanupTargets = new Set<string>();

type ConflictStageRuntimeState = {
  lsFilesStdout?: string;
  stageTexts?: Partial<Record<1 | 2 | 3, string | null>>;
};

/**
 * 统一给测试样本补齐 LF，保持与 metadata 的逐行 token 语义一致。
 */
function withConflictMergeTestLf(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

/**
 * 创建隔离的临时仓库目录，供冲突快照与工作区文件状态测试复用。
 */
async function createTempRepoAsync(prefix: string): Promise<string> {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupTargets.add(repoRoot);
  return repoRoot;
}

/**
 * 构造最小 Git runtime 测试桩，只覆盖冲突快照读取链会访问到的命令。
 */
function createConflictRuntime(state?: ConflictStageRuntimeState): {
  runGitExecAsync(argv: string[], timeoutMs?: number): Promise<GitExecResult>;
} {
  return {
    async runGitExecAsync(argv: string[]) {
      if (argv[0] === "ls-files" && argv[1] === "--unmerged") {
        return {
          ok: true,
          stdout: state?.lsFilesStdout ?? "100644 0000000000000000000000000000000000000000 1\tsrc/conflict.ts\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (argv[0] === "show") {
        const stage = Number(String(argv[1] || "").match(/^:(\d):/)?.[1] || 0) as 1 | 2 | 3;
        const text = state?.stageTexts?.[stage];
        if (text == null) return { ok: false, stdout: "", stderr: "missing stage", exitCode: 1 };
        return { ok: true, stdout: text, stderr: "", exitCode: 0 };
      }
      if (argv[0] === "cat-file" && argv[1] === "-s") {
        const stage = Number(String(argv[2] || "").match(/^:(\d):/)?.[1] || 0) as 1 | 2 | 3;
        const text = state?.stageTexts?.[stage];
        if (text == null) return { ok: false, stdout: "", stderr: "missing stage", exitCode: 1 };
        return { ok: true, stdout: String(Buffer.byteLength(text, "utf8")), stderr: "", exitCode: 0 };
      }
      return { ok: false, stdout: "", stderr: `unexpected argv: ${argv.join(" ")}`, exitCode: 1 };
    },
  };
}

/**
 * 基于 IntelliJ Community `MergeResolveUtilTest` 上游样例整理文本自动解决断言表。
 */
function createIdeaTextResolveFixtures(): Array<{
  base: string;
  ours: string;
  theirs: string;
  expected: string | null;
}> {
  return [
    { base: "", ours: "", theirs: "", expected: "" },
    { base: "x x x", ours: "x x x", theirs: "x x x", expected: "x x x" },
    { base: "x x x", ours: "x Y x", theirs: "x x x", expected: "x Y x" },
    { base: "x x", ours: "x x", theirs: "x Y x", expected: "x Y x" },
    { base: "x X x", ours: "x x", theirs: "x X x", expected: "x x" },
    { base: "x x x", ours: "x Y x", theirs: "x Y x", expected: "x Y x" },
    { base: "x x", ours: "x Y x", theirs: "x Y x", expected: "x Y x" },
    { base: "x X x", ours: "x x", theirs: "x x", expected: "x x" },
    { base: "x x x", ours: "x Y x x", theirs: "x x Z x", expected: "x Y x Z x" },
    { base: "x", ours: "x Y", theirs: "Z x", expected: "Z x Y" },
    { base: "x x", ours: "x", theirs: "Z x x", expected: "Z x" },
    { base: "x x x", ours: "x Y x", theirs: "x Z x", expected: null },
    { base: "x x", ours: "x Y x", theirs: "x Z x", expected: null },
    { base: "version: 1.0.0", ours: "version: 2.0.0", theirs: "version: 1.0.4", expected: "version: 2.0.4" },
    { base: "i\n", ours: "i", theirs: "\ni", expected: "i" },
    { base: "Y X Y", ours: "Y C\nX\nC Y", theirs: "Y \nX\n Y", expected: "Y \nC\nX\nC Y" },
  ];
}

/**
 * 构造带大量重复上下文的 57 组变更样本，回归覆盖 `mergeLines` 稳定分块语义。
 */
function createLargeConflictMergeBlockFixture(): {
  baseText: string;
  oursText: string;
  theirsText: string;
} {
  const baseLines: string[] = [];
  const oursLines: string[] = [];
  const theirsLines: string[] = [];

  for (let index = 0; index < 57; index += 1) {
    const repeatCount = 2 + (index % 3);

    baseLines.push("section:start");
    oursLines.push("section:start");
    theirsLines.push("section:start");

    for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
      baseLines.push("repeated-context");
      oursLines.push("repeated-context");
      theirsLines.push("repeated-context");
    }

    baseLines.push(`anchor:${index}`);
    baseLines.push("section:end");

    if (index % 3 === 0) {
      oursLines.push(`ours:${index}`);
      oursLines.push(`anchor:${index}`);
      oursLines.push("section:end");
      theirsLines.push(`anchor:${index}`);
      theirsLines.push("section:end");
      continue;
    }

    if (index % 3 === 1) {
      oursLines.push(`anchor:${index}`);
      oursLines.push("section:end");
      theirsLines.push(`theirs:${index}`);
      theirsLines.push(`anchor:${index}`);
      theirsLines.push("section:end");
      continue;
    }

    oursLines.push(`ours:${index}`);
    oursLines.push(`anchor:${index}`);
    oursLines.push("section:end");
    theirsLines.push(`theirs:${index}`);
    theirsLines.push(`anchor:${index}`);
    theirsLines.push("section:end");
  }

  baseLines.push("tail");
  oursLines.push("tail");
  theirsLines.push("tail");

  return {
    baseText: withConflictMergeTestLf(baseLines),
    oursText: withConflictMergeTestLf(oursLines),
    theirsText: withConflictMergeTestLf(theirsLines),
  };
}

afterEach(async () => {
  setConflictMergeSemanticResolversForTesting(null);
  await Promise.all(
    Array.from(cleanupTargets.values()).map(async (target) => {
      try {
        await fsp.rm(target, { recursive: true, force: true });
      } catch {}
      cleanupTargets.delete(target);
    }),
  );
});

describe("conflict merge electron alignment", () => {
  it("TEXT 自动解决应覆盖 IntelliJ Community MergeResolveUtilTest 上游样例", () => {
    for (const fixture of createIdeaTextResolveFixtures()) {
      expect(tryResolveConflictMergeText(fixture.ours, fixture.base, fixture.theirs)).toBe(fixture.expected);
    }
  });

  it("TEXT 自动解决应收敛一侧包裹 base、另一侧改写主体的真实 App.tsx 冲突块", () => {
    const base = [
      "const forceHint = needForceReset",
      "  ? \"reset\"",
      "  : needForceRemove",
      "    ? \"remove\"",
      "    : needForceBranch",
      "      ? \"branch\"",
      "      : \"\";",
      "",
    ].join("\n");
    const ours = [
      "const forceHints = needForceReset",
      "  ? [\"reset\"]",
      "  : [",
      "    needForceRemove ? \"remove\" : \"\",",
      "    needForceBranch ? \"branch\" : \"\",",
      "  ].filter(Boolean);",
      "",
    ].join("\n");
    const theirs = [
      "const selectedResetTargetBranch = String(targetBranch || \"\").trim();",
      "const forceHint = needForceReset",
      "  ? \"reset\"",
      "  : needForceRemove",
      "    ? \"remove\"",
      "    : needForceBranch",
      "      ? \"branch\"",
      "      : \"\";",
      "",
    ].join("\n");

    expect(tryResolveConflictMergeText(ours, base, theirs)).toBe([
      "const selectedResetTargetBranch = String(targetBranch || \"\").trim();",
      "const forceHints = needForceReset",
      "  ? [\"reset\"]",
      "  : [",
      "    needForceRemove ? \"remove\" : \"\",",
      "    needForceBranch ? \"branch\" : \"\",",
      "  ].filter(Boolean);",
      "",
    ].join("\n"));
  });

  it("merge metadata 应包含 provider-support import range 与 semantic 分支所需字段", () => {
    const semanticResolver: GitConflictMergeSemanticResolver = {
      id: "ts-semantic-fixture",
      isApplicable(filePath) {
        return filePath.endsWith(".ts");
      },
      resolve() {
        return "const merged = createMergedNode();\n";
      },
    };
    setConflictMergeSemanticResolversForTesting([semanticResolver]);

    const importMetadata = buildConflictMergeMetadata({
      path: "src/Example.java",
      baseText: [
        "package demo;",
        "",
        "import demo.BaseOnly;",
        "",
        "class Example {",
        "  BaseOnly value;",
        "}",
      ].join("\n"),
      oursText: [
        "package demo;",
        "",
        "import demo.LeftOnly;",
        "",
        "class Example {",
        "  BaseOnly value;",
        "}",
      ].join("\n"),
      theirsText: [
        "package demo;",
        "",
        "import demo.RightOnly;",
        "",
        "class Example {",
        "  BaseOnly value;",
        "}",
      ].join("\n"),
    });

    expect(importMetadata.importMetadata?.autoResolveEnabled).toBe(true);
    expect(importMetadata.importMetadata?.oursEntries.map((item) => item.importedSymbols)).toEqual([[ "LeftOnly" ]]);
    expect(importMetadata.blocks.some((block) => block.isImportChange)).toBe(true);

    const semanticMetadata = buildConflictMergeMetadata({
      path: "src/semantic.ts",
      baseText: "const value = createBaseNode();\n",
      oursText: "const value = createLeftNode();\n",
      theirsText: "const value = createRightNode();\n",
    });

    expect(semanticMetadata.semanticResolverId).toBe("ts-semantic-fixture");
    expect(semanticMetadata.blocks[0]).toMatchObject({
      kind: "conflict",
      resolutionStrategy: "SEMANTIC",
      semanticResolverId: "ts-semantic-fixture",
      semanticResolvedText: "const merged = createMergedNode();\n",
    });
  });

  it("merge metadata 应对齐新的 line diff 分块与 line type 判型", () => {
    const repeatedFixture = createLargeConflictMergeBlockFixture();
    const repeatedMetadata = buildConflictMergeMetadata({
      path: "src/repeated.txt",
      baseText: repeatedFixture.baseText,
      oursText: repeatedFixture.oursText,
      theirsText: repeatedFixture.theirsText,
    });

    expect(repeatedMetadata.blocks).toHaveLength(57);
    expect(repeatedMetadata.blocks[0]).toMatchObject({
      baseStart: 3,
      oursStart: 3,
      theirsStart: 3,
    });

    const insertedMetadata = buildConflictMergeMetadata({
      path: "src/inserted.txt",
      baseText: "keep\n",
      oursText: "keep\n",
      theirsText: "keep\nextra\n",
    });
    expect(insertedMetadata.blocks[0]).toMatchObject({
      conflictType: "INSERTED",
      changedInOurs: false,
      changedInTheirs: true,
      resolutionStrategy: "DEFAULT",
    });

    const deletedMetadata = buildConflictMergeMetadata({
      path: "src/deleted.txt",
      baseText: "keep\nremove\nend\n",
      oursText: "keep\nend\n",
      theirsText: "keep\nend\n",
    });
    expect(deletedMetadata.blocks[0]).toMatchObject({
      conflictType: "DELETED",
      changedInOurs: true,
      changedInTheirs: true,
      resolutionStrategy: "DEFAULT",
    });

    const conflictMetadata = buildConflictMergeMetadata({
      path: "src/conflict.txt",
      baseText: "version: 1.0.0\n",
      oursText: "version: 2.0.0\n",
      theirsText: "version: 1.0.4\n",
    });
    expect(conflictMetadata.blocks[0]).toMatchObject({
      conflictType: "CONFLICT",
      changedInOurs: true,
      changedInTheirs: true,
      resolutionStrategy: "TEXT",
    });
  });

  it("import-specific 只应在 Java / Kotlin / KTS 启用，其余语言退回文本层", () => {
    const buildImportFixture = (pathText: string) => buildConflictMergeMetadata({
      path: pathText,
      baseText: "import demo.BaseOnly;\n\nclass Example {}\n",
      oursText: "import demo.LeftOnly;\n\nclass Example {}\n",
      theirsText: "import demo.RightOnly;\n\nclass Example {}\n",
    });

    expect(buildImportFixture("src/Example.java").importMetadata).toBeTruthy();
    expect(buildConflictMergeMetadata({
      path: "src/App.kt",
      baseText: "package demo\n\nimport demo.BaseOnly\n\nclass Example\n",
      oursText: "package demo\n\nimport demo.LeftOnly\n\nclass Example\n",
      theirsText: "package demo\n\nimport demo.RightOnly\n\nclass Example\n",
    }).importMetadata).toBeTruthy();
    expect(buildConflictMergeMetadata({
      path: "src/App.kts",
      baseText: "@file:Suppress(\"unused\")\npackage demo\n\nimport demo.BaseOnly\n\nprintln(BaseOnly)\n",
      oursText: "@file:Suppress(\"unused\")\npackage demo\n\nimport demo.LeftOnly\n\nprintln(LeftOnly)\n",
      theirsText: "@file:Suppress(\"unused\")\npackage demo\n\nimport demo.RightOnly\n\nprintln(RightOnly)\n",
    }).importMetadata).toBeTruthy();

    for (const unsupportedPath of [
      "src/app.js",
      "src/App.tsx",
      "src/app.py",
      "src/app.scala",
      "src/app.groovy",
    ]) {
      const metadata = buildConflictMergeMetadata({
        path: unsupportedPath,
        baseText: "import demo.BaseOnly\n\nvalue = BaseOnly\n",
        oursText: "import demo.LeftOnly\n\nvalue = LeftOnly\n",
        theirsText: "import demo.RightOnly\n\nvalue = RightOnly\n",
      });
      expect(metadata.importMetadata).toBeNull();
      expect(metadata.blocks.some((block) => block.isImportChange)).toBe(false);
    }
  });

  it("冲突快照应带 merge metadata，并保持 binary / tooLarge / 缺失 stage 的降级语义", async () => {
    const repoRoot = await createTempRepoAsync("codexflow-conflict-merge-");
    await fsp.mkdir(path.join(repoRoot, "src"), { recursive: true });
    await fsp.writeFile(path.join(repoRoot, "src", "conflict.ts"), "const value = 2;\n", "utf8");

    const okResult = await getConflictMergeSnapshotAsync({
      runtime: createConflictRuntime({
        stageTexts: {
          1: "const value = 1;\n",
          2: "const value = 2;\n",
          3: "const value = 3;\n",
        },
      }),
      repoRoot,
      relPath: "src/conflict.ts",
    });
    expect(okResult.ok).toBe(true);
    if (!okResult.ok) return;
    expect(okResult.snapshot.merge.blocks).toHaveLength(1);
    expect(okResult.snapshot.merge.blocks[0]?.conflictType).toBe("CONFLICT");

    const missingStageResult = await getConflictMergeSnapshotAsync({
      runtime: createConflictRuntime({
        stageTexts: {
          1: "base\n",
          2: null,
          3: "theirs\n",
        },
      }),
      repoRoot,
      relPath: "src/conflict.ts",
    });
    expect(missingStageResult.ok).toBe(true);
    if (!missingStageResult.ok) return;
    expect(missingStageResult.snapshot.ours.available).toBe(false);

    const binaryPath = path.join(repoRoot, "src", "binary.ts");
    await fsp.writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02]));
    const binaryResult = await getConflictMergeSnapshotAsync({
      runtime: createConflictRuntime({
        lsFilesStdout: "100644 0000000000000000000000000000000000000000 1\tsrc/binary.ts\n",
        stageTexts: {
          1: "base\n",
          2: "ours\n",
          3: "theirs\n",
        },
      }),
      repoRoot,
      relPath: "src/binary.ts",
    });
    expect(binaryResult.ok).toBe(true);
    if (!binaryResult.ok) return;
    expect(binaryResult.snapshot.working.isBinary).toBe(true);

    const largePath = path.join(repoRoot, "src", "large.ts");
    await fsp.writeFile(largePath, "x".repeat((2 * 1024 * 1024) + 1), "utf8");
    const largeResult = await getConflictMergeSnapshotAsync({
      runtime: createConflictRuntime({
        lsFilesStdout: "100644 0000000000000000000000000000000000000000 1\tsrc/large.ts\n",
        stageTexts: {
          1: "base\n",
          2: "ours\n",
          3: "theirs\n",
        },
      }),
      repoRoot,
      relPath: "src/large.ts",
    });
    expect(largeResult.ok).toBe(true);
    if (!largeResult.ok) return;
    expect(largeResult.snapshot.working.tooLarge).toBe(true);
  });

  it("resolver 元数据应把超大 stage 与超长文本行数降级为不可应用内合并", async () => {
    const repoRoot = await createTempRepoAsync("codexflow-conflict-merge-");
    await fsp.mkdir(path.join(repoRoot, "src"), { recursive: true });
    await fsp.writeFile(path.join(repoRoot, "src", "large-stage.ts"), "result\n", "utf8");
    await fsp.writeFile(path.join(repoRoot, "src", "many-lines.ts"), Array.from({ length: 20_001 }, (_, index) => `line-${index}`).join("\n"), "utf8");

    const stageTooLargeEntries = await describeConflictResolverEntriesAsync({
      runtime: createConflictRuntime({
        lsFilesStdout: "100644 0000000000000000000000000000000000000000 1\tsrc/large-stage.ts\n",
        stageTexts: {
          1: "base\n",
          2: "x".repeat((2 * 1024 * 1024) + 1),
          3: "theirs\n",
        },
      }),
      repoRoot,
      relPaths: ["src/large-stage.ts"],
    });
    expect(stageTooLargeEntries).toHaveLength(1);
    expect(stageTooLargeEntries[0]?.canOpenMerge).toBe(false);
    expect(stageTooLargeEntries[0]?.ours?.tooLarge).toBe(true);

    const lineTooLargeEntries = await describeConflictResolverEntriesAsync({
      runtime: createConflictRuntime({
        lsFilesStdout: "100644 0000000000000000000000000000000000000000 1\tsrc/many-lines.ts\n",
        stageTexts: {
          1: Array.from({ length: 20_001 }, (_, index) => `base-${index}`).join("\n"),
          2: Array.from({ length: 20_001 }, (_, index) => `ours-${index}`).join("\n"),
          3: Array.from({ length: 20_001 }, (_, index) => `theirs-${index}`).join("\n"),
        },
      }),
      repoRoot,
      relPaths: ["src/many-lines.ts"],
    });
    expect(lineTooLargeEntries).toHaveLength(1);
    expect(lineTooLargeEntries[0]?.canOpenMerge).toBe(false);
    expect(lineTooLargeEntries[0]?.ours?.tooLarge).toBe(true);
    expect(lineTooLargeEntries[0]?.working?.tooLarge).toBe(true);
  });
});
