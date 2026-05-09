import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { execGitAsync, type GitExecResult } from "./exec";
import { dispatchGitFeatureAction } from "./featureService";

type RepoFixture = {
  repo: string;
  userDataPath: string;
  cleanup(): Promise<void>;
};

/**
 * 在测试仓库内执行 Git 命令；失败时直接抛出断言，便于聚焦回滚语义本身。
 */
async function gitAsync(repo: string, argv: string[], timeoutMs: number = 20_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 执行一个允许失败的 Git 命令，并把原始结果返回给调用方继续断言。
 */
async function gitMayFailAsync(repo: string, argv: string[], timeoutMs: number = 20_000): Promise<GitExecResult> {
  return await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
}

/**
 * 向测试仓库写入文件内容，必要时自动补目录。
 */
async function writeFileAsync(repo: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(repo, relativePath);
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsp.writeFile(absolutePath, content, "utf8");
}

/**
 * 创建带基础提交的临时仓库，供 rollback action 集成测试隔离使用。
 */
async function createRepoFixture(prefix: string): Promise<RepoFixture> {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-repo-`));
  const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-userdata-`));
  await gitAsync(repo, ["init", "-b", "master"]);
  await gitAsync(repo, ["config", "user.name", "CodexFlow"]);
  await gitAsync(repo, ["config", "user.email", "codexflow@example.com"]);
  await writeFileAsync(repo, "tracked.txt", "tracked\n");
  await writeFileAsync(repo, "rename.txt", "rename\n");
  await gitAsync(repo, ["add", "tracked.txt", "rename.txt"]);
  await gitAsync(repo, ["commit", "-m", "base"]);
  return {
    repo,
    userDataPath,
    async cleanup(): Promise<void> {
      try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
      try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
    },
  };
}

describe("featureService rollback action", () => {
  it(
    "changes.rollback 应把 NEW 文件从索引移除，但保留为未跟踪文件",
    async () => {
      const fixture = await createRepoFixture("codexflow-rollback-new");
      try {
        await writeFileAsync(fixture.repo, "new.txt", "new\n");
        await gitAsync(fixture.repo, ["add", "new.txt"]);

        const res = await dispatchGitFeatureAction({
          action: "changes.rollback",
          payload: {
            repoPath: fixture.repo,
            changes: [{
              path: "new.txt",
              x: "A",
              y: ".",
              staged: true,
              unstaged: false,
              untracked: false,
              ignored: false,
              renamed: false,
              deleted: false,
            }],
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(true);

        const status = await gitAsync(fixture.repo, ["status", "--porcelain"]);
        expect(status).toContain("?? new.txt");
        const trackedRes = await gitMayFailAsync(fixture.repo, ["ls-files", "--error-unmatch", "new.txt"]);
        expect(trackedRes.ok).toBe(false);
        expect(await fsp.readFile(path.join(fixture.repo, "new.txt"), "utf8")).toBe("new\n");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "changes.rollback 应恢复 MOVED 与 DELETED 条目到 HEAD 语义",
    async () => {
      const fixture = await createRepoFixture("codexflow-rollback-moved-deleted");
      try {
        await gitAsync(fixture.repo, ["mv", "rename.txt", "renamed.txt"]);
        await fsp.rm(path.join(fixture.repo, "tracked.txt"), { force: true });
        await gitAsync(fixture.repo, ["add", "-A"]);

        const res = await dispatchGitFeatureAction({
          action: "changes.rollback",
          payload: {
            repoPath: fixture.repo,
            changes: [
              {
                path: "renamed.txt",
                oldPath: "rename.txt",
                x: "R",
                y: ".",
                staged: true,
                unstaged: false,
                untracked: false,
                ignored: false,
                renamed: true,
                deleted: false,
              },
              {
                path: "tracked.txt",
                x: "D",
                y: ".",
                staged: true,
                unstaged: false,
                untracked: false,
                ignored: false,
                renamed: false,
                deleted: true,
              },
            ],
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(true);

        const status = (await gitAsync(fixture.repo, ["status", "--porcelain"])).trim();
        expect(status).toBe("");
        expect((await fsp.readFile(path.join(fixture.repo, "rename.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("rename\n");
        await expect(fsp.access(path.join(fixture.repo, "renamed.txt"))).rejects.toThrow();
        expect((await fsp.readFile(path.join(fixture.repo, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("tracked\n");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );
});
