import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { execGitAsync } from "./exec";
import { dispatchGitFeatureAction } from "./featureService";

type RepoFixture = {
  repo: string;
  userDataPath: string;
  cleanup(): Promise<void>;
};

/**
 * 在测试仓库执行 Git 命令，失败时直接抛断言，减少每条用例的样板错误处理。
 */
async function gitAsync(repo: string, argv: string[], timeoutMs: number = 30_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 创建一个带默认用户信息的最小测试仓库。
 */
async function createRepoFixture(prefix: string): Promise<RepoFixture> {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-repo-`));
  const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-userdata-`));
  await gitAsync(repo, ["init", "-b", "master"]);
  await gitAsync(repo, ["config", "user.name", "CodexFlow"]);
  await gitAsync(repo, ["config", "user.email", "codexflow@example.com"]);
  return {
    repo,
    userDataPath,
    async cleanup(): Promise<void> {
      try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
      try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * 写入测试文件并在需要时补齐父目录。
 */
async function writeFileAsync(repo: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(repo, relativePath);
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsp.writeFile(absolutePath, content, "utf8");
}

describe("featureService diff.openPath", () => {
  it("commit 模式应把右侧修订版落成临时文件后返回", async () => {
    const fixture = await createRepoFixture("codexflow-diff-open-commit");
    try {
      await writeFileAsync(fixture.repo, "src/demo.txt", "v1\n");
      await gitAsync(fixture.repo, ["add", "src/demo.txt"]);
      await gitAsync(fixture.repo, ["commit", "-m", "first"]);
      await writeFileAsync(fixture.repo, "src/demo.txt", "v2\n");
      await gitAsync(fixture.repo, ["add", "src/demo.txt"]);
      await gitAsync(fixture.repo, ["commit", "-m", "second"]);
      const commitHash = String(await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

      const res = await dispatchGitFeatureAction({
        action: "diff.openPath",
        payload: {
          repoPath: fixture.repo,
          path: "src/demo.txt",
          mode: "commit",
          hash: commitHash,
        },
        userDataPath: fixture.userDataPath,
      });

      expect(res.ok).toBe(true);
      const openedPath = String(res.data?.path || "").trim();
      expect(openedPath).not.toBe("");
      expect(openedPath.startsWith(fixture.repo)).toBe(false);
      expect(String(await fsp.readFile(openedPath, "utf8"))).toBe("v2\n");
    } finally {
      await fixture.cleanup();
    }
  });

  it("revisionToWorking 模式应直接返回当前工作区文件路径", async () => {
    const fixture = await createRepoFixture("codexflow-diff-open-working");
    try {
      await writeFileAsync(fixture.repo, "src/demo.txt", "base\n");
      await gitAsync(fixture.repo, ["add", "src/demo.txt"]);
      await gitAsync(fixture.repo, ["commit", "-m", "base"]);
      const baseHash = String(await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();
      await writeFileAsync(fixture.repo, "src/demo.txt", "working\n");

      const res = await dispatchGitFeatureAction({
        action: "diff.openPath",
        payload: {
          repoPath: fixture.repo,
          path: "src/demo.txt",
          mode: "revisionToWorking",
          hash: baseHash,
        },
        userDataPath: fixture.userDataPath,
      });

      expect(res.ok).toBe(true);
      expect(String(res.data?.path || "").trim()).toBe(path.join(fixture.repo, "src/demo.txt"));
    } finally {
      await fixture.cleanup();
    }
  });

  it("revisionToRevision 模式在右侧版本缺失时应回退到左侧修订文件", async () => {
    const fixture = await createRepoFixture("codexflow-diff-open-revision-fallback");
    try {
      await writeFileAsync(fixture.repo, "src/demo.txt", "v1\n");
      await gitAsync(fixture.repo, ["add", "src/demo.txt"]);
      await gitAsync(fixture.repo, ["commit", "-m", "add demo"]);
      const leftHash = String(await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

      await gitAsync(fixture.repo, ["rm", "src/demo.txt"]);
      await gitAsync(fixture.repo, ["commit", "-m", "remove demo"]);
      const rightHash = String(await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

      const res = await dispatchGitFeatureAction({
        action: "diff.openPath",
        payload: {
          repoPath: fixture.repo,
          path: "src/demo.txt",
          oldPath: "src/demo.txt",
          mode: "revisionToRevision",
          hashes: [leftHash, rightHash],
        },
        userDataPath: fixture.userDataPath,
      });

      expect(res.ok).toBe(true);
      const openedPath = String(res.data?.path || "").trim();
      expect(openedPath).not.toBe("");
      expect(openedPath.startsWith(fixture.repo)).toBe(false);
      expect(String(await fsp.readFile(openedPath, "utf8"))).toBe("v1\n");
    } finally {
      await fixture.cleanup();
    }
  });
});
