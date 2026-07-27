import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execGitAsync } from "./exec";

let userDataDir = "";
vi.mock("electron", () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

import { autoCommitWorktreeIfDirtyAsync, createWorktreesAsync, listLocalBranchesAsync } from "./worktreeOps";

/**
 * 在临时仓库中执行 Git 命令，并在失败时输出完整诊断。
 */
async function gitAsync(repo: string, argv: string[]): Promise<string> {
  const result = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs: 12_000 });
  expect(result.ok, `git ${argv.join(" ")} failed: ${result.stderr || result.error || result.stdout}`).toBe(true);
  return String(result.stdout || "");
}

describe("尚无首次提交的仓库创建 worktree", () => {
  it("应提示先完成首次提交并拒绝创建孤立 worktree", async () => {
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-wt-unborn-"));
    const repo = path.join(sandbox, "repo");
    userDataDir = path.join(sandbox, "userdata");
    await fsp.mkdir(repo, { recursive: true });
    await fsp.mkdir(userDataDir, { recursive: true });

    try {
      await gitAsync(repo, ["init", "-b", "main"]);
      await fsp.writeFile(path.join(repo, "untracked.txt"), "尚未提交\n", "utf8");

      const branches = await listLocalBranchesAsync({ repoDir: repo });
      expect(branches.ok).toBe(true);
      expect(branches.current).toBe("main");
      expect(branches.branches).toEqual([]);
      expect(branches.unborn).toBe(true);

      const result = await createWorktreesAsync({
        repoDir: repo,
        baseBranch: "main",
        instances: [{ providerId: "codex", count: 1 }],
        copyRules: false,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Initial commit required before creating a worktree");
      expect(await fsp.stat(path.join(sandbox, "repo_wt")).catch(() => null)).toBeNull();
    } finally {
      try { await fsp.rm(sandbox, { recursive: true, force: true }); } catch {}
    }
  }, { timeout: 120_000 });

  it.runIf(process.platform === "win32")("自动提交前应清理由旧通知 hook 生成的 CONOUT$ 文件", async () => {
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-wt-conout-"));
    const repo = path.join(sandbox, "repo");
    userDataDir = path.join(sandbox, "userdata");
    await fsp.mkdir(repo, { recursive: true });
    await fsp.mkdir(userDataDir, { recursive: true });

    try {
      await gitAsync(repo, ["init", "-b", "main"]);
      await gitAsync(repo, ["config", "user.name", "CodexFlow"]);
      await gitAsync(repo, ["config", "user.email", "codexflow@example.com"]);
      await fsp.writeFile(path.join(repo, "README.md"), "initial\n", "utf8");
      await gitAsync(repo, ["add", "README.md"]);
      await gitAsync(repo, ["commit", "-m", "initial"]);

      const created = await createWorktreesAsync({
        repoDir: repo,
        baseBranch: "main",
        instances: [{ providerId: "gemini", count: 1 }],
        copyRules: false,
      });
      expect(created.ok).toBe(true);
      const worktreePath = String(created.items?.[0]?.worktreePath || "");
      await fsp.writeFile(path.join(worktreePath, "CONOUT$"), "\u001b]9;agent-turn-complete\u0007", "utf8");
      await fsp.writeFile(path.join(worktreePath, "change.txt"), "change\n", "utf8");

      const committed = await autoCommitWorktreeIfDirtyAsync({
        worktreePath,
        message: "test: auto commit",
        timeoutMs: 12_000,
      });

      expect(committed).toEqual({ ok: true, committed: true });
      expect((await fsp.readdir(worktreePath)).some((name) => name.toUpperCase() === "CONOUT$")).toBe(false);
      expect((await gitAsync(worktreePath, ["log", "-1", "--format=%s"])).trim()).toBe("test: auto commit");
    } finally {
      try { await fsp.rm(sandbox, { recursive: true, force: true }); } catch {}
    }
  }, { timeout: 120_000 });
});
