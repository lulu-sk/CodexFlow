import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";

let userDataDir = "";
vi.mock("electron", () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

vi.mock("./exec", async () => {
  const actual = await vi.importActual<typeof import("./exec")>("./exec");
  return {
    ...actual,
    spawnGitAsync: vi.fn(actual.spawnGitAsync),
  };
});

import { execGitAsync, spawnGitAsync } from "./exec";
import { removeWorktreeAsync } from "./worktreeOps";

/**
 * 中文说明：在临时仓库中执行 git 命令，并对失败给出明确断言信息。
 */
async function git(repo: string, argv: string[], timeoutMs: number = 12_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 中文说明：执行 git 命令但不强制断言成功，便于验证分支是否已删除等场景。
 */
async function gitTry(repo: string, argv: string[], timeoutMs: number = 12_000) {
  return await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
}

/**
 * 中文说明：创建一个最小可复现的主仓库 + 子 worktree 测试夹具。
 */
async function createWorktreeFixtureAsync(prefix: string): Promise<{
  repo: string;
  wtParent: string;
  wtDir: string;
  userData: string;
}> {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}repo-`));
  const wtParent = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}wt-parent-`));
  const wtDir = path.join(wtParent, "wt");
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}userdata-`));
  userDataDir = userData;

  await git(repo, ["init"]);
  await git(repo, ["config", "user.name", "CodexFlow"]);
  await git(repo, ["config", "user.email", "codexflow@example.com"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  await git(repo, ["config", "core.eol", "lf"]);
  await git(repo, ["checkout", "-b", "main"]);

  await fsp.writeFile(path.join(repo, "a.txt"), "A\n", "utf8");
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-m", "main: init"]);
  await git(repo, ["worktree", "add", "-b", "wt", wtDir, "main"]);

  return { repo, wtParent, wtDir, userData };
}

/**
 * 中文说明：删除测试夹具目录，避免临时文件泄漏。
 */
async function cleanupFixtureAsync(args: {
  repo: string;
  wtParent: string;
  userData: string;
}): Promise<void> {
  try { await fsp.rm(args.wtParent, { recursive: true, force: true }); } catch {}
  try { await fsp.rm(args.repo, { recursive: true, force: true }); } catch {}
  try { await fsp.rm(args.userData, { recursive: true, force: true }); } catch {}
}

const mockedSpawnGitAsync = vi.mocked(spawnGitAsync);

afterEach(async () => {
  const actual = await vi.importActual<typeof import("./exec")>("./exec");
  mockedSpawnGitAsync.mockReset();
  mockedSpawnGitAsync.mockImplementation(actual.spawnGitAsync);
});

describe("removeWorktreeAsync（删除预检与兜底）", () => {
  it(
    "会一次性返回 dirty worktree 与未合并分支两个强制确认标记",
    async () => {
      const fixture = await createWorktreeFixtureAsync("codexflow-wt-remove-force-");

      try {
        await fsp.writeFile(path.join(fixture.wtDir, "feature.txt"), "feature\n", "utf8");
        await git(fixture.wtDir, ["add", "feature.txt"]);
        await git(fixture.wtDir, ["commit", "-m", "wt: feature"]);
        await fsp.writeFile(path.join(fixture.wtDir, "dirty.txt"), "dirty\n", "utf8");

        const previewRes = await removeWorktreeAsync({
          worktreePath: fixture.wtDir,
          deleteBranch: true,
        });

        expect(previewRes.ok).toBe(false);
        expect(previewRes.removedWorktree).toBe(false);
        expect(previewRes.removedBranch).toBe(false);
        expect(previewRes.needsForceRemoveWorktree).toBe(true);
        expect(previewRes.needsForceDeleteBranch).toBe(true);

        const removeRes = await removeWorktreeAsync({
          worktreePath: fixture.wtDir,
          deleteBranch: true,
          forceRemoveWorktree: true,
          forceDeleteBranch: true,
        });

        expect(removeRes.ok).toBe(true);
        if (removeRes.ok) {
          expect(removeRes.removedWorktree).toBe(true);
          expect(removeRes.removedBranch).toBe(true);
        }

        const ref = await gitTry(fixture.repo, ["show-ref", "--verify", "refs/heads/wt"]);
        expect(ref.ok).toBe(false);
      } finally {
        await cleanupFixtureAsync(fixture);
      }
    },
    { timeout: 120_000 }
  );

  it(
    "当 worktree 已解绑但目录清理阶段报错时，仍应继续删除分支并返回成功",
    async () => {
      const fixture = await createWorktreeFixtureAsync("codexflow-wt-remove-cleanup-");
      const actual = await vi.importActual<typeof import("./exec")>("./exec");

      mockedSpawnGitAsync.mockImplementation(async (opts) => {
        const argv = Array.isArray(opts?.argv) ? opts.argv.map((item) => String(item)) : [];
        const isRemoveWorktree =
          argv.includes("worktree") &&
          argv.includes("remove") &&
          argv.includes(fixture.wtDir);
        if (!isRemoveWorktree)
          return await actual.spawnGitAsync(opts);

        const real = await actual.spawnGitAsync(opts);
        expect(real.ok, `expected real git worktree remove to succeed: ${real.stderr || real.error || real.stdout}`).toBe(true);
        return {
          ok: false,
          stdout: String(real.stdout || ""),
          stderr: "Directory not empty",
          exitCode: 1,
          error: "Directory not empty",
        };
      });

      try {
        const res = await removeWorktreeAsync({
          worktreePath: fixture.wtDir,
          deleteBranch: true,
        });

        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.removedWorktree).toBe(true);
          expect(res.removedBranch).toBe(true);
        }

        const ref = await gitTry(fixture.repo, ["show-ref", "--verify", "refs/heads/wt"]);
        expect(ref.ok).toBe(false);
      } finally {
        await cleanupFixtureAsync(fixture);
      }
    },
    { timeout: 120_000 }
  );
});
