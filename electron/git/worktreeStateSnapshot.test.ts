import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import { execGitAsync } from "./exec";
import { createWorktreeStateSnapshotAsync, restoreWorktreeStateSnapshotAsync } from "./worktreeStateSnapshot";

/**
 * 中文说明：在临时目录内执行 git 命令（统一加 -C 与超时），失败时给出更清晰的断言信息。
 */
async function git(repo: string, argv: string[], timeoutMs: number = 12_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

describe("worktreeStateSnapshot（事务化快照：index 字节级 + stash 内容级）", () => {
  it(
    "能在同一文件同时存在 staged+unstaged 时保持三态不被打乱",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-wt-snapshot-"));
      try {
        await git(root, ["init"]);
        await git(root, ["config", "user.name", "CodexFlow"]);
        await git(root, ["config", "user.email", "codexflow@example.com"]);
        // 中文说明：测试期望以 LF 为基准；不同平台/全局 git 配置可能导致自动 CRLF 转换，需在测试仓库内显式关闭。
        await git(root, ["config", "core.autocrlf", "false"]);
        await git(root, ["config", "core.eol", "lf"]);

        const fp = path.join(root, "f.txt");
        await fsp.writeFile(fp, "A\nB\n", "utf8");
        await git(root, ["add", "f.txt"]);
        await git(root, ["commit", "-m", "init"]);

        // staged：先改 A 行并 git add
        await fsp.writeFile(fp, "A1\nB\n", "utf8");
        await git(root, ["add", "f.txt"]);
        // unstaged：再改 B 行（不 add）
        await fsp.writeFile(fp, "A1\nB2\n", "utf8");

        // untracked：额外放一个未跟踪文件
        const up = path.join(root, "u.txt");
        await fsp.writeFile(up, "U\n", "utf8");

        const stBefore = (await git(root, ["status", "--porcelain"])).trim();
        expect(stBefore).toMatch(/^MM f\.txt$/m);
        expect(stBefore).toMatch(/^\?\? u\.txt$/m);

        const snapRes = await createWorktreeStateSnapshotAsync({ repoMainPath: root, stashMessage: "test:snapshot" });
        expect(snapRes.ok).toBe(true);
        if (!snapRes.ok) return;
        const snap = snapRes.snapshot;

        const stAfterStash = (await git(root, ["status", "--porcelain"])).trim();
        expect(stAfterStash).toBe("");

        // 模拟“中间随便折腾”：做一次与目标文件无关的提交，使 HEAD 前进
        await fsp.writeFile(path.join(root, "other.txt"), "X\n", "utf8");
        await git(root, ["add", "other.txt"]);
        await git(root, ["commit", "-m", "other"]);

        const restoreRes = await restoreWorktreeStateSnapshotAsync({ repoMainPath: root, snapshot: snap });
        expect(restoreRes.ok).toBe(true);

        // 工作区应为最终内容（A1 + B2）
        expect(await fsp.readFile(fp, "utf8")).toBe("A1\nB2\n");

        // index 应为 staged 版本（A1 + B）
        const idxText = await git(root, ["show", ":f.txt"]);
        expect(idxText).toBe("A1\nB\n");

        // untracked 文件应还在，且保持未跟踪
        expect(fs.existsSync(up)).toBe(true);
        expect((await git(root, ["status", "--porcelain"])).trim()).toMatch(/^\?\? u\.txt$/m);

        // staged/unstaged 分离仍存在（f.txt 同时在 index 与 worktree 变化）
        const stAfter = (await git(root, ["status", "--porcelain"])).trim();
        expect(stAfter).toMatch(/^MM f\.txt$/m);
      } finally {
        try { await fsp.rm(root, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 }
  );
});

