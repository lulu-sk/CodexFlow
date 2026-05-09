import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyIgnoreTargetAsync, listIgnoreTargetsAsync } from "./ignoreTargets";

/**
 * 创建一个临时仓库目录，供 ignore 写入策略测试复用。
 */
async function createTempRepoAsync(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("commit panel ignore targets", () => {
  it("已存在父目录规则时，不应重复写入被覆盖的文件规则", async () => {
    const repoRoot = await createTempRepoAsync("codexflow-ignore-targets-");
    try {
      await fsp.mkdir(path.join(repoRoot, "build"), { recursive: true });
      await fsp.writeFile(path.join(repoRoot, ".gitignore"), "build/\n", "utf8");
      await fsp.writeFile(path.join(repoRoot, "build", "cache.log"), "temp\n", "utf8");
      const preview = await listIgnoreTargetsAsync({
        repoRoot,
        gitExcludeFile: path.join(repoRoot, ".git", "info", "exclude"),
        pathsInput: ["build/cache.log"],
      });
      expect(preview.ok).toBe(true);
      const rootIgnoreTarget = preview.data?.targets.find((item) => item.kind === "ignore-file");
      expect(rootIgnoreTarget).toBeTruthy();
      const applied = await applyIgnoreTargetAsync({
        repoRoot,
        gitExcludeFile: path.join(repoRoot, ".git", "info", "exclude"),
        pathsInput: ["build/cache.log"],
        targetInput: rootIgnoreTarget,
      });
      expect(applied.ok).toBe(true);
      expect(applied.data?.addedCount).toBe(0);
      expect(await fsp.readFile(path.join(repoRoot, ".gitignore"), "utf8")).toBe("build/\n");
    } finally {
      try { await fsp.rm(repoRoot, { recursive: true, force: true }); } catch {}
    }
  });

  it("嵌套目录应向最近的 .gitignore 写入精确相对规则", async () => {
    const repoRoot = await createTempRepoAsync("codexflow-ignore-targets-");
    try {
      await fsp.mkdir(path.join(repoRoot, "src", "generated"), { recursive: true });
      await fsp.writeFile(path.join(repoRoot, "src", ".gitignore"), "# existing\n", "utf8");
      await fsp.writeFile(path.join(repoRoot, "src", "generated", "data.json"), "{}\n", "utf8");
      const preview = await listIgnoreTargetsAsync({
        repoRoot,
        gitExcludeFile: path.join(repoRoot, ".git", "info", "exclude"),
        pathsInput: ["src/generated/data.json"],
      });
      expect(preview.ok).toBe(true);
      const nestedIgnoreTarget = preview.data?.targets.find((item) => item.displayPath === "src/.gitignore");
      expect(nestedIgnoreTarget).toBeTruthy();
      const applied = await applyIgnoreTargetAsync({
        repoRoot,
        gitExcludeFile: path.join(repoRoot, ".git", "info", "exclude"),
        pathsInput: ["src/generated/data.json"],
        targetInput: nestedIgnoreTarget,
      });
      expect(applied.ok).toBe(true);
      expect(await fsp.readFile(path.join(repoRoot, "src", ".gitignore"), "utf8")).toBe("# existing\n/generated/data.json\n");
    } finally {
      try { await fsp.rm(repoRoot, { recursive: true, force: true }); } catch {}
    }
  });

  it("重复拖拽同一文件时，不应反复追加重复规则", async () => {
    const repoRoot = await createTempRepoAsync("codexflow-ignore-targets-");
    try {
      await fsp.mkdir(path.join(repoRoot, "dist"), { recursive: true });
      await fsp.writeFile(path.join(repoRoot, "dist", "app.js"), "console.log('x');\n", "utf8");
      const preview = await listIgnoreTargetsAsync({
        repoRoot,
        gitExcludeFile: path.join(repoRoot, ".git", "info", "exclude"),
        pathsInput: ["dist/app.js"],
      });
      expect(preview.ok).toBe(true);
      const createIgnoreTarget = preview.data?.targets.find((item) => item.kind === "create-ignore-file");
      expect(createIgnoreTarget).toBeTruthy();
      const firstApplied = await applyIgnoreTargetAsync({
        repoRoot,
        gitExcludeFile: path.join(repoRoot, ".git", "info", "exclude"),
        pathsInput: ["dist/app.js"],
        targetInput: createIgnoreTarget,
      });
      const secondApplied = await applyIgnoreTargetAsync({
        repoRoot,
        gitExcludeFile: path.join(repoRoot, ".git", "info", "exclude"),
        pathsInput: ["dist/app.js"],
        targetInput: createIgnoreTarget,
      });
      expect(firstApplied.ok).toBe(true);
      expect(firstApplied.data?.addedCount).toBe(1);
      expect(secondApplied.ok).toBe(true);
      expect(secondApplied.data?.addedCount).toBe(0);
      expect(await fsp.readFile(path.join(repoRoot, ".gitignore"), "utf8")).toBe("/dist/app.js\n");
    } finally {
      try { await fsp.rm(repoRoot, { recursive: true, force: true }); } catch {}
    }
  });
});
