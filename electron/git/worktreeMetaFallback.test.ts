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

import { getWorktreeMeta } from "../stores/worktreeMetaStore";
import { recycleWorktreeAsync, removeWorktreeAsync } from "./worktreeOps";
import { resetWorktreeAsync } from "./worktreeReset";

/**
 * 中文说明：在临时目录内执行 git 命令（统一加 -C 与超时），失败时给出更清晰的断言信息。
 */
async function git(repo: string, argv: string[], timeoutMs: number = 12_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 中文说明：执行 git 命令但不做 ok 断言（用于验证“分支不存在”等预期失败场景）。
 */
async function gitTry(repo: string, argv: string[], timeoutMs: number = 12_000) {
  return await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
}

describe("worktree meta 缺失回退（recycle/reset/remove）", () => {
  it(
    "recycle：无创建记录时仍可推断主 worktree 并合并到目标分支，同时写入映射",
    async () => {
      const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-wt-recycle-main-"));
      const wtParent = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-wt-recycle-child-parent-"));
      const wtDir = path.join(wtParent, "wt");
      const userData = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-userdata-"));
      userDataDir = userData;

      try {
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

        await fsp.writeFile(path.join(wtDir, "w.txt"), "W\n", "utf8");
        await git(wtDir, ["add", "w.txt"]);
        await git(wtDir, ["commit", "-m", "wt: change"]);

        const res = await recycleWorktreeAsync({ worktreePath: wtDir, baseBranch: "main", wtBranch: "wt", range: "full", mode: "rebase" });
        expect(res.ok).toBe(true);

        const subject = (await git(repo, ["log", "-1", "--format=%s"])).trim();
        expect(subject).toBe("wt: change");

        const meta = getWorktreeMeta(wtDir);
        expect(meta).toBeTruthy();
        if (meta) {
          expect(meta.repoMainPath).toBe(repo);
          expect(meta.baseBranch).toBe("main");
          expect(meta.wtBranch).toBe("wt");
        }
      } finally {
        try { await fsp.rm(wtParent, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userData, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 120_000 }
  );

  it(
    "reset：无创建记录时仍可推断 base/wt 并将 worktree 对齐到主工作区当前基线",
    async () => {
      const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-wt-reset-main-"));
      const wtParent = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-wt-reset-child-parent-"));
      const wtDir = path.join(wtParent, "wt");
      const userData = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-userdata-"));
      userDataDir = userData;

      try {
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

        // base 前进一格，模拟“主 worktree 当前基线”变化
        await fsp.writeFile(path.join(repo, "b.txt"), "B\n", "utf8");
        await git(repo, ["add", "b.txt"]);
        await git(repo, ["commit", "-m", "main: after"]);

        const before = (await git(repo, ["rev-parse", "main"])).trim();
        const resetRes = await resetWorktreeAsync({ worktreePath: wtDir });
        expect(resetRes.ok).toBe(true);

        const afterMain = (await git(repo, ["rev-parse", "main"])).trim();
        expect(afterMain).toBe(before);
        const afterWt = (await git(repo, ["rev-parse", "wt"])).trim();
        expect(afterWt).toBe(afterMain);
      } finally {
        try { await fsp.rm(wtParent, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userData, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 120_000 }
  );

  it(
    "remove：无创建记录时仍可推断 repoMainPath/wtBranch 并删除 worktree + 分支",
    async () => {
      const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-wt-remove-main-"));
      const wtParent = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-wt-remove-child-parent-"));
      const wtDir = path.join(wtParent, "wt");
      const userData = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-userdata-"));
      userDataDir = userData;

      try {
        await git(repo, ["init"]);
        await git(repo, ["config", "user.name", "CodexFlow"]);
        await git(repo, ["config", "user.email", "codexflow@example.com"]);
        await git(repo, ["config", "core.autocrlf", "false"]);
        await git(repo, ["config", "core.eol", "lf"]);

        await git(repo, ["checkout", "-b", "main"]);
        await fsp.writeFile(path.join(repo, "a.txt"), "A\n", "utf8");
        await git(repo, ["add", "a.txt"]);
        await git(repo, ["commit", "-m", "main: init"]);

        // 创建子 worktree：分支 wt 不做额外提交，确保可安全 -d 删除
        await git(repo, ["worktree", "add", "-b", "wt", wtDir, "main"]);

        const res = await removeWorktreeAsync({ worktreePath: wtDir, deleteBranch: true });
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.removedWorktree).toBe(true);
          expect(res.removedBranch).toBe(true);
        }

        const ref = await gitTry(repo, ["show-ref", "--verify", "refs/heads/wt"]);
        expect(ref.ok).toBe(false);
      } finally {
        try { await fsp.rm(wtParent, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userData, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 120_000 }
  );
});

