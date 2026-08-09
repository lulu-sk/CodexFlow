import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { revertHistoryTurnDiff, type RevertHistoryTurnDiffDependencies } from "./revertTurnDiff";

const tempDirs: string[] = [];

/**
 * 创建不包含固定本地路径的临时项目目录。
 */
async function createTempProjectDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-history-revert-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe("revertHistoryTurnDiff", () => {
  it("先校验反向补丁，再执行真正撤销", async () => {
    const projectDir = await createTempProjectDir();
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValueOnce({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "", exitCode: 0 });
    const diffText = "diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new\n";

    const result = await revertHistoryTurnDiff({ projectWinPath: projectDir, diffText }, { runGit });

    expect(result).toEqual({ ok: true, repoRoot: path.resolve(projectDir) });
    expect(runGit).toHaveBeenCalledTimes(3);
    expect(runGit.mock.calls[1]?.[0]).toMatchObject({
      cwd: path.resolve(projectDir),
      argv: ["apply", "--reverse", "--check", "--whitespace=nowarn", "--recount", "-"],
      stdin: diffText,
    });
    expect(runGit.mock.calls[2]?.[0].argv).toEqual(["apply", "--reverse", "--whitespace=nowarn", "--recount", "-"]);
  });

  it("重新应用统一差异时应使用正向 git apply", async () => {
    const projectDir = await createTempProjectDir();
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValueOnce({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "", exitCode: 0 });
    const diffText = "diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new\n";

    const result = await revertHistoryTurnDiff({ projectWinPath: projectDir, diffText, operation: "reapply" }, { runGit });

    expect(result).toEqual({ ok: true, repoRoot: path.resolve(projectDir) });
    expect(runGit.mock.calls[1]?.[0].argv).toEqual(["apply", "--check", "--whitespace=nowarn", "--recount", "-"]);
    expect(runGit.mock.calls[2]?.[0].argv).toEqual(["apply", "--whitespace=nowarn", "--recount", "-"]);
  });

  it("重新应用 apply_patch 时应先校验内存中的旧内容", async () => {
    const projectDir = await createTempProjectDir();
    const sourcePath = path.join(projectDir, "src", "example.ts");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(sourcePath, "export const value = 1;\n", "utf8");
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValueOnce({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 });
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "@@",
      "-export const value = 1;",
      "+export const value = 2;",
      "*** End Patch",
    ].join("\n");

    const result = await revertHistoryTurnDiff({ projectWinPath: projectDir, diffText: patchText, operation: "reapply" }, { runGit });

    expect(result).toEqual({ ok: true, repoRoot: path.resolve(projectDir) });
    expect(await fsp.readFile(sourcePath, "utf8")).toBe("export const value = 2;\n");
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  it("反向补丁校验失败时不修改文件", async () => {
    const projectDir = await createTempProjectDir();
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValueOnce({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ ok: false, stdout: "", stderr: "patch does not apply", exitCode: 1 });

    const result = await revertHistoryTurnDiff({
      projectWinPath: projectDir,
      diffText: "diff --git a/example.txt b/example.txt\n",
    }, { runGit });

    expect(result).toEqual({ ok: false, code: "conflict", error: "patch does not apply" });
    expect(runGit).toHaveBeenCalledTimes(2);
  });

  it("会按相反顺序撤销同一轮中的多个 apply_patch", async () => {
    const projectDir = await createTempProjectDir();
    const sourcePath = path.join(projectDir, "src", "example.ts");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(sourcePath, "export const value = 3;\n", "utf8");
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValueOnce({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 });
    const patchText = [
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
      "*** End Patch",
    ].join("\n");

    const result = await revertHistoryTurnDiff({ projectWinPath: projectDir, diffText: patchText }, { runGit });

    expect(result).toEqual({ ok: true, repoRoot: path.resolve(projectDir) });
    expect(await fsp.readFile(sourcePath, "utf8")).toBe("export const value = 1;\n");
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  it("apply_patch 内容与当前文件不一致时不会写入", async () => {
    const projectDir = await createTempProjectDir();
    const sourcePath = path.join(projectDir, "src", "example.ts");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(sourcePath, "export const value = 4;\n", "utf8");
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValueOnce({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 });
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "@@",
      "-export const value = 1;",
      "+export const value = 2;",
      "*** End Patch",
    ].join("\n");

    const result = await revertHistoryTurnDiff({ projectWinPath: projectDir, diffText: patchText }, { runGit });

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(await fsp.readFile(sourcePath, "utf8")).toBe("export const value = 4;\n");
    expect(runGit).toHaveBeenCalledTimes(1);
  });
});
