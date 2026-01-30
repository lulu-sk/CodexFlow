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

import { setWorktreeMeta } from "../stores/worktreeMetaStore";
import { resolveWorktreeForkPointAsync, searchForkPointCommitsAsync, validateForkPointRefAsync } from "./worktreeForkPoint";

/**
 * 中文说明：在临时目录内执行 git 命令（统一加 -C 与超时），失败时给出更清晰的断言信息。
 */
async function git(repo: string, argv: string[], timeoutMs: number = 12_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

describe("worktreeForkPoint（分叉点解析/搜索/校验）", () => {
  it(
    "能返回创建记录/自动分叉点摘要，并支持搜索提交与校验手动引用",
    async () => {
      const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-wt-forkpoint-"));
      const userData = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-userdata-"));
      userDataDir = userData;

      try {
        await git(repo, ["init"]);
        await git(repo, ["config", "user.name", "CodexFlow"]);
        await git(repo, ["config", "user.email", "codexflow@example.com"]);
        // 中文说明：测试期望以 LF 为基准；不同平台/全局 git 配置可能导致自动 CRLF 转换，需在测试仓库内显式关闭。
        await git(repo, ["config", "core.autocrlf", "false"]);
        await git(repo, ["config", "core.eol", "lf"]);

        // 统一主分支名为 main（避免不同 git 版本默认分支差异）
        await git(repo, ["checkout", "-b", "main"]);

        await fsp.writeFile(path.join(repo, "a.txt"), "A\n", "utf8");
        await git(repo, ["add", "a.txt"]);
        await git(repo, ["commit", "-m", "main: init"]);
        const commit1 = (await git(repo, ["rev-parse", "HEAD"])).trim();

        await fsp.writeFile(path.join(repo, "b.txt"), "B\n", "utf8");
        await git(repo, ["add", "b.txt"]);
        await git(repo, ["commit", "-m", "main: base"]);
        const commit2 = (await git(repo, ["rev-parse", "HEAD"])).trim();

        // 源分支：从 commit2 分叉
        await git(repo, ["checkout", "-b", "wt"]);
        await fsp.writeFile(path.join(repo, "w.txt"), "W\n", "utf8");
        await git(repo, ["add", "w.txt"]);
        await git(repo, ["commit", "-m", "wt: change"]);
        const wtCommit = (await git(repo, ["rev-parse", "HEAD"])).trim();

        // base 分支继续前进：制造一个“非源分支祖先”的提交，用于 validate 失败用例
        await git(repo, ["checkout", "main"]);
        await fsp.writeFile(path.join(repo, "c.txt"), "C\n", "utf8");
        await git(repo, ["add", "c.txt"]);
        await git(repo, ["commit", "-m", "main: after fork"]);
        const mainAfterFork = (await git(repo, ["rev-parse", "HEAD"])).trim();

        // 写入创建记录：baseRefAtCreate=commit2，且 base/wt 分支与当前选择一致
        setWorktreeMeta(repo, {
          repoMainPath: repo,
          baseBranch: "main",
          baseRefAtCreate: commit2,
          wtBranch: "wt",
          createdAt: Date.now(),
        });

        const fork = await resolveWorktreeForkPointAsync({ worktreePath: repo, baseBranch: "main", wtBranch: "wt" });
        expect(fork.ok).toBe(true);
        if (fork.ok) {
          expect(fork.forkPoint.recordedCommit?.sha).toBe(commit2);
          expect(fork.forkPoint.recordedCommit?.subject).toBe("main: base");
          expect(fork.forkPoint.autoCommit?.sha).toBe(commit2);
          expect(fork.forkPoint.autoCommit?.subject).toBe("main: base");
          expect(fork.forkPoint.source).toBe("recorded");
        }

        const search = await searchForkPointCommitsAsync({ worktreePath: repo, wtBranch: "wt", query: "wt: change", limit: 50 });
        expect(search.ok).toBe(true);
        if (search.ok) {
          expect(search.items.some((x) => x.sha === wtCommit && x.subject === "wt: change")).toBe(true);
        }

        const okRef = await validateForkPointRefAsync({ worktreePath: repo, wtBranch: "wt", ref: commit1 });
        expect(okRef.ok).toBe(true);

        const badRef = await validateForkPointRefAsync({ worktreePath: repo, wtBranch: "wt", ref: mainAfterFork });
        expect(badRef.ok).toBe(false);
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userData, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 }
  );
});

