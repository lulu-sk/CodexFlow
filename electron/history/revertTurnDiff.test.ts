import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
  it("apply_patch 使用历史子目录撤销和重新应用，不改根目录同名文件", async () => {
    const projectDir = await createTempProjectDir();
    const cwd = path.join(projectDir, "nested");
    const rootFile = path.join(projectDir, "example.txt");
    const nestedFile = path.join(cwd, "example.txt");
    await fsp.mkdir(cwd);
    await Promise.all([fsp.writeFile(rootFile, "new\n", "utf8"), fsp.writeFile(nestedFile, "new\n", "utf8")]);
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValue({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 });
    const diffText = "*** Begin Patch\n*** Update File: example.txt\n@@\n-old\n+new\n*** End Patch";

    const undo = await revertHistoryTurnDiff({ projectWinPath: projectDir, cwd, diffText }, { runGit });
    expect(undo).toMatchObject({ ok: true });
    expect(await fsp.readFile(nestedFile, "utf8")).toBe("old\n");
    expect(await fsp.readFile(rootFile, "utf8")).toBe("new\n");

    const reapply = await revertHistoryTurnDiff({ projectWinPath: projectDir, cwd: pathToFileURL(cwd).href, diffText, operation: "reapply" }, { runGit });
    expect(reapply).toMatchObject({ ok: true });
    expect(await fsp.readFile(nestedFile, "utf8")).toBe("new\n");
    expect(await fsp.readFile(rootFile, "utf8")).toBe("new\n");
  });

  it("历史子目录文件有后续修改时拒绝撤销，不回退根目录同名文件", async () => {
    const projectDir = await createTempProjectDir();
    const cwd = path.join(projectDir, "nested");
    const rootFile = path.join(projectDir, "example.txt");
    const nestedFile = path.join(cwd, "example.txt");
    await fsp.mkdir(cwd);
    await Promise.all([fsp.writeFile(rootFile, "new\n", "utf8"), fsp.writeFile(nestedFile, "later\n", "utf8")]);
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValue({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 });

    const result = await revertHistoryTurnDiff({
      projectWinPath: projectDir, cwd,
      diffText: "*** Begin Patch\n*** Update File: example.txt\n@@\n-old\n+new\n*** End Patch",
    }, { runGit });

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(await fsp.readFile(nestedFile, "utf8")).toBe("later\n");
    expect(await fsp.readFile(rootFile, "utf8")).toBe("new\n");
  });

  it("拒绝仓库外或无法解析的工作目录，不修改根目录同名文件", async () => {
    const projectDir = await createTempProjectDir();
    const outsideDir = await createTempProjectDir();
    const rootFile = path.join(projectDir, "example.txt");
    await fsp.writeFile(rootFile, "new\n", "utf8");
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValue({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 });
    for (const cwd of [outsideDir, "relative-directory", path.join(projectDir, "missing")]) {
      const result = await revertHistoryTurnDiff({
        projectWinPath: projectDir, cwd,
        diffText: "*** Begin Patch\n*** Update File: example.txt\n@@\n-old\n+new\n*** End Patch",
      }, { runGit });
      expect(result).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(await fsp.readFile(rootFile, "utf8")).toBe("new\n");
  });

  it("没有历史工作目录时保持以仓库根目录解析 apply_patch 的旧行为", async () => {
    const projectDir = await createTempProjectDir();
    const rootFile = path.join(projectDir, "example.txt");
    await fsp.writeFile(rootFile, "new\n", "utf8");
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValue({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 });
    const result = await revertHistoryTurnDiff({
      projectWinPath: projectDir,
      diffText: "*** Begin Patch\n*** Update File: example.txt\n@@\n-old\n+new\n*** End Patch",
    }, { runGit });

    expect(result).toMatchObject({ ok: true });
    expect(await fsp.readFile(rootFile, "utf8")).toBe("old\n");
  });

  it("工作目录经符号链接指向仓库外时拒绝撤销", async () => {
    const projectDir = await createTempProjectDir();
    const outsideDir = await createTempProjectDir();
    const cwd = path.join(projectDir, "linked");
    const outsideFile = path.join(outsideDir, "example.txt");
    await fsp.writeFile(outsideFile, "new\n", "utf8");
    await fsp.symlink(outsideDir, cwd, "junction");
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValue({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 });
    const result = await revertHistoryTurnDiff({
      projectWinPath: projectDir, cwd,
      diffText: "*** Begin Patch\n*** Update File: example.txt\n@@\n-old\n+new\n*** End Patch",
    }, { runGit });

    expect(result).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await fsp.readFile(outsideFile, "utf8")).toBe("new\n");
  });

  it("合法工作目录内的补丁目标经目录链接越界时拒绝撤销和重新应用", async () => {
    const projectDir = await createTempProjectDir();
    const outsideDir = await createTempProjectDir();
    const cwd = path.join(projectDir, "nested");
    await fsp.mkdir(cwd);
    await fsp.symlink(outsideDir, path.join(cwd, "linked"), "junction");
    const outsideFile = path.join(outsideDir, "example.txt");
    await fsp.writeFile(outsideFile, "new\n", "utf8");
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValue({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 });
    const diffText = "*** Begin Patch\n*** Update File: linked/example.txt\n@@\n-old\n+new\n*** End Patch";

    const undo = await revertHistoryTurnDiff({ projectWinPath: projectDir, cwd, diffText }, { runGit });
    expect(undo).toMatchObject({ ok: false, code: "conflict" });
    expect(await fsp.readFile(outsideFile, "utf8")).toBe("new\n");

    await fsp.writeFile(outsideFile, "old\n", "utf8");
    const reapply = await revertHistoryTurnDiff({ projectWinPath: projectDir, cwd, diffText, operation: "reapply" }, { runGit });
    expect(reapply).toMatchObject({ ok: false, code: "conflict" });
    expect(await fsp.readFile(outsideFile, "utf8")).toBe("old\n");
  });

  it("新增目标尚不存在时检查最近父目录，不沿链接在仓库外创建文件", async () => {
    const projectDir = await createTempProjectDir();
    const outsideDir = await createTempProjectDir();
    await fsp.symlink(outsideDir, path.join(projectDir, "linked"), "junction");
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValue({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 });
    const result = await revertHistoryTurnDiff({
      projectWinPath: projectDir, cwd: projectDir, operation: "reapply",
      diffText: "*** Begin Patch\n*** Add File: linked/missing/example.txt\n+new\n*** End Patch",
    }, { runGit });

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    await expect(fsp.stat(path.join(outsideDir, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("新增目标是指向仓库外缺失文件的悬空链接时拒绝写入", async (context) => {
    const projectDir = await createTempProjectDir();
    const outsideDir = await createTempProjectDir();
    const outsideFile = path.join(outsideDir, "missing.txt");
    try {
      await fsp.symlink(outsideFile, path.join(projectDir, "link.txt"), "file");
    } catch (error: any) {
      if (process.platform === "win32" && error?.code === "EPERM") {
        context.skip();
        return;
      }
      throw error;
    }
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValue({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 });
    const result = await revertHistoryTurnDiff({
      projectWinPath: projectDir, cwd: projectDir, operation: "reapply",
      diffText: "*** Begin Patch\n*** Add File: link.txt\n+new\n*** End Patch",
    }, { runGit });

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    await expect(fsp.stat(outsideFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fsp.lstat(path.join(projectDir, "link.txt"))).isSymbolicLink()).toBe(true);
  });

  it.runIf(process.platform === "win32")("把 WSL 挂载盘工作目录映射为同一 Windows 子目录", async () => {
    const projectDir = await createTempProjectDir();
    const nestedDir = path.join(projectDir, "nested");
    await fsp.mkdir(nestedDir);
    await fsp.writeFile(path.join(nestedDir, "example.txt"), "new\n", "utf8");
    const normalized = nestedDir.replace(/\\/g, "/");
    const cwd = `/mnt/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValue({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 });
    const result = await revertHistoryTurnDiff({
      projectWinPath: projectDir, cwd,
      diffText: "*** Begin Patch\n*** Update File: example.txt\n@@\n-old\n+new\n*** End Patch",
    }, { runGit });

    expect(result).toMatchObject({ ok: true });
    expect(await fsp.readFile(path.join(nestedDir, "example.txt"), "utf8")).toBe("old\n");
  });

  it("统一差异保持仓库根目录执行，先校验反向补丁再撤销", async () => {
    const projectDir = await createTempProjectDir();
    const cwd = path.join(projectDir, "nested");
    await fsp.mkdir(cwd);
    const runGit = vi.fn<RevertHistoryTurnDiffDependencies["runGit"]>()
      .mockResolvedValueOnce({ ok: true, stdout: projectDir, stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ ok: true, stdout: "", stderr: "", exitCode: 0 });
    const diffText = "diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new\n";

    const result = await revertHistoryTurnDiff({ projectWinPath: projectDir, cwd, diffText }, { runGit });

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
