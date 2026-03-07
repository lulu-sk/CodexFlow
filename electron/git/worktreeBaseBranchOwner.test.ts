import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { execGitAsync } from "./exec";

let userDataDir = "";
vi.mock("electron", () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

import { createWorktreesAsync, recycleWorktreeAsync } from "./worktreeOps";
import { getWorktreeMeta, setWorktreeMeta } from "../stores/worktreeMetaStore";

/**
 * 中文说明：在临时目录内执行 git 命令（统一加 -C 与超时），失败时给出更清晰的断言信息。
 */
async function git(repo: string, argv: string[], timeoutMs: number = 12_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 中文说明：创建一个带 `main` 初始提交的临时仓库，并返回后续测试会复用的目录路径。
 */
async function setupRepoFixtureAsync(prefix: string): Promise<{ sandbox: string; repo: string; poolDir: string }> {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const repo = path.join(sandbox, "repo");
  await fsp.mkdir(repo, { recursive: true });

  userDataDir = path.join(sandbox, "userdata");
  await fsp.mkdir(userDataDir, { recursive: true });

  await git(repo, ["init"]);
  await git(repo, ["config", "user.name", "CodexFlow"]);
  await git(repo, ["config", "user.email", "codexflow@example.com"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  await git(repo, ["config", "core.eol", "lf"]);
  await git(repo, ["checkout", "-b", "main"]);

  await fsp.writeFile(path.join(repo, "README.md"), "hello\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "main: init"]);

  return {
    sandbox,
    repo,
    poolDir: path.join(path.dirname(repo), `${path.basename(repo)}_wt`),
  };
}

describe("worktree 基分支落点解析", () => {
  it(
    "create：当基分支由子 worktree 持有时，应写入该基 worktree 作为默认操作落点",
    async () => {
      const { sandbox, repo, poolDir } = await setupRepoFixtureAsync("codexflow-wt-create-base-owner-");
      const parentWtDir = path.join(sandbox, "parent-wt");

      try {
        await git(repo, ["worktree", "add", "-b", "parent", parentWtDir, "main"]);

        const res = await createWorktreesAsync({
          repoDir: repo,
          baseBranch: "parent",
          instances: [{ providerId: "codex", count: 1 }],
          copyRules: false,
        });

        expect(res.ok).toBe(true);
        expect(res.items?.length).toBe(1);

        const item = res.items?.[0];
        expect(item).toBeTruthy();
        expect(item?.repoMainPath).toBe(parentWtDir);
        expect(item?.baseBranch).toBe("parent");

        const meta = item ? getWorktreeMeta(item.worktreePath) : null;
        expect(meta).toBeTruthy();
        expect(meta?.repoMainPath).toBe(parentWtDir);
        expect(meta?.baseBranch).toBe("parent");
      } finally {
        try { await fsp.rm(poolDir, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(sandbox, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 120_000 }
  );

  it(
    "recycle：当历史创建记录仍指向主 worktree 时，应自动切换到基分支所属 worktree 完成回收",
    async () => {
      const { sandbox, repo } = await setupRepoFixtureAsync("codexflow-wt-recycle-base-owner-");
      const parentWtDir = path.join(sandbox, "parent-wt");
      const childWtDir = path.join(sandbox, "child-wt");

      try {
        await git(repo, ["worktree", "add", "-b", "parent", parentWtDir, "main"]);
        await git(repo, ["worktree", "add", "-b", "child", childWtDir, "parent"]);

        await fsp.writeFile(path.join(childWtDir, "child.txt"), "child\n", "utf8");
        await git(childWtDir, ["add", "child.txt"]);
        await git(childWtDir, ["commit", "-m", "child: change"]);

        setWorktreeMeta(childWtDir, {
          repoMainPath: repo,
          baseBranch: "parent",
          wtBranch: "child",
          createdAt: Date.now(),
        });

        const recycleRes = await recycleWorktreeAsync({
          worktreePath: childWtDir,
          baseBranch: "parent",
          wtBranch: "child",
          range: "full",
          mode: "rebase",
        });

        expect(recycleRes.ok).toBe(true);

        const latestSubject = (await git(repo, ["log", "-1", "--format=%s", "parent"])).trim();
        expect(latestSubject).toBe("child: change");

        const parentSha = (await git(repo, ["rev-parse", "parent"])).trim();
        const childSha = (await git(repo, ["rev-parse", "child"])).trim();
        expect(parentSha).toBe(childSha);

        const meta = getWorktreeMeta(childWtDir);
        expect(meta?.repoMainPath).toBe(parentWtDir);
      } finally {
        try { await fsp.rm(sandbox, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 120_000 }
  );
});
