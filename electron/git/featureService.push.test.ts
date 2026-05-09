import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { execGitAsync } from "./exec";
import { dispatchGitFeatureAction } from "./featureService";

/**
 * 在指定仓库执行 Git 命令，失败时直接抛出带 stderr 的断言，便于定位用例问题。
 */
async function gitAsync(repo: string, argv: string[], timeoutMs: number = 20_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 初始化 bare 远端与两个工作副本，供 push reject 变体测试复用。
 */
async function initPushRejectReposAsync(prefix: string): Promise<{
  repo: string;
  peerRepo: string;
  remoteRoot: string;
  userDataPath: string;
  defaultBranch: string;
}> {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), `codexflow-feature-push-${prefix}-`));
  const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `codexflow-feature-push-remote-${prefix}-`));
  const peerRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `codexflow-feature-push-peer-${prefix}-`));
  const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), `codexflow-feature-push-userdata-${prefix}-`));
  const remoteRepo = path.join(remoteRoot, "origin.git");
  await gitAsync(remoteRoot, ["init", "--bare", remoteRepo]);

  await gitAsync(repo, ["init"]);
  await gitAsync(repo, ["config", "user.name", "CodexFlow"]);
  await gitAsync(repo, ["config", "user.email", "codexflow@example.com"]);
  await gitAsync(repo, ["config", "core.autocrlf", "false"]);
  await gitAsync(repo, ["config", "core.eol", "lf"]);
  await fsp.writeFile(path.join(repo, "README.md"), "# demo\n", "utf8");
  await gitAsync(repo, ["add", "README.md"]);
  await gitAsync(repo, ["commit", "-m", "init"]);
  const defaultBranch = String(await gitAsync(repo, ["branch", "--show-current"])).trim() || "main";
  await gitAsync(repo, ["remote", "add", "origin", remoteRepo]);
  await gitAsync(repo, ["push", "-u", "origin", defaultBranch]);

  const peerRepo = path.join(peerRoot, "peer");
  await gitAsync(peerRoot, ["clone", remoteRepo, peerRepo]);
  await gitAsync(peerRepo, ["config", "user.name", "CodexFlow Peer"]);
  await gitAsync(peerRepo, ["config", "user.email", "codexflow-peer@example.com"]);

  return {
    repo,
    peerRepo,
    remoteRoot,
    userDataPath,
    defaultBranch,
  };
}

/**
 * 初始化会拒收当前分支 push 的非 bare 远端，稳定触发 remote rejected 场景。
 */
async function initRefusingRemoteAsync(prefix: string): Promise<{
  repo: string;
  remoteRoot: string;
  userDataPath: string;
  defaultBranch: string;
}> {
  const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `codexflow-feature-push-refuse-remote-${prefix}-`));
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `codexflow-feature-push-refuse-local-${prefix}-`));
  const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), `codexflow-feature-push-refuse-userdata-${prefix}-`));
  const remoteRepo = path.join(remoteRoot, "origin");
  await fsp.mkdir(remoteRepo, { recursive: true });
  await gitAsync(remoteRepo, ["init"]);
  await gitAsync(remoteRepo, ["config", "user.name", "CodexFlow Remote"]);
  await gitAsync(remoteRepo, ["config", "user.email", "codexflow-remote@example.com"]);
  await gitAsync(remoteRepo, ["config", "receive.denyCurrentBranch", "refuse"]);
  await fsp.writeFile(path.join(remoteRepo, "README.md"), "# remote\n", "utf8");
  await gitAsync(remoteRepo, ["add", "README.md"]);
  await gitAsync(remoteRepo, ["commit", "-m", "init"]);
  const defaultBranch = String(await gitAsync(remoteRepo, ["branch", "--show-current"])).trim() || "main";

  const repo = path.join(repoRoot, "repo");
  await gitAsync(repoRoot, ["clone", remoteRepo, repo]);
  await gitAsync(repo, ["config", "user.name", "CodexFlow"]);
  await gitAsync(repo, ["config", "user.email", "codexflow@example.com"]);

  return {
    repo,
    remoteRoot,
    userDataPath,
    defaultBranch,
  };
}

describe("featureService push target resolution", () => {
  it(
    "本地上游分支名包含斜杠时，推送仍应落到真实远端仓库",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-feature-push-"));
      const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-feature-push-remote-"));
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-feature-push-userdata-"));
      try {
        const remoteRepo = path.join(remoteRoot, "origin.git");
        await gitAsync(remoteRoot, ["init", "--bare", remoteRepo]);

        await gitAsync(root, ["init"]);
        await gitAsync(root, ["config", "user.name", "CodexFlow"]);
        await gitAsync(root, ["config", "user.email", "codexflow@example.com"]);
        await gitAsync(root, ["config", "core.autocrlf", "false"]);
        await gitAsync(root, ["config", "core.eol", "lf"]);

        await fsp.writeFile(path.join(root, "README.md"), "# demo\n", "utf8");
        await gitAsync(root, ["add", "README.md"]);
        await gitAsync(root, ["commit", "-m", "init"]);
        const defaultBranch = String(await gitAsync(root, ["branch", "--show-current"])).trim() || "main";
        await gitAsync(root, ["remote", "add", "origin", remoteRepo]);
        await gitAsync(root, ["push", "-u", "origin", defaultBranch]);

        await gitAsync(root, ["checkout", "-b", "feat/base"]);
        await fsp.writeFile(path.join(root, "base.txt"), "base\n", "utf8");
        await gitAsync(root, ["add", "base.txt"]);
        await gitAsync(root, ["commit", "-m", "base"]);

        await gitAsync(root, ["checkout", "-b", "fix/local-upstream"]);
        await gitAsync(root, ["branch", "--set-upstream-to", "feat/base"]);
        await fsp.writeFile(path.join(root, "topic.txt"), "topic\n", "utf8");
        await gitAsync(root, ["add", "topic.txt"]);
        await gitAsync(root, ["commit", "-m", "topic"]);

        const preview = await dispatchGitFeatureAction({
          action: "push.preview",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(preview.ok).toBe(true);
        expect(preview.data?.remote).toBe("origin");
        expect(preview.data?.remoteBranch).toBe("fix/local-upstream");
        expect(preview.data?.canPush).toBe(true);
        expect(preview.data?.upstream).toBeUndefined();

        const push = await dispatchGitFeatureAction({
          action: "push.execute",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(push.ok).toBe(true);

        const upstreamRef = (await gitAsync(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).trim();
        expect(upstreamRef).toBe("origin/fix/local-upstream");
        const remoteBranchHash = (await gitAsync(root, ["ls-remote", "--heads", "origin", "fix/local-upstream"])).trim();
        expect(remoteBranchHash).not.toBe("");
      } finally {
        try { await fsp.rm(root, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(remoteRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "新建远端分支的推送预览应仅包含该远端尚未拥有的提交",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-feature-preview-"));
      const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-feature-preview-remote-"));
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-feature-preview-userdata-"));
      try {
        const remoteRepo = path.join(remoteRoot, "origin.git");
        await gitAsync(remoteRoot, ["init", "--bare", remoteRepo]);

        await gitAsync(root, ["init"]);
        await gitAsync(root, ["config", "user.name", "CodexFlow"]);
        await gitAsync(root, ["config", "user.email", "codexflow@example.com"]);
        await gitAsync(root, ["config", "core.autocrlf", "false"]);
        await gitAsync(root, ["config", "core.eol", "lf"]);

        await fsp.writeFile(path.join(root, "README.md"), "# demo\n", "utf8");
        await gitAsync(root, ["add", "README.md"]);
        await gitAsync(root, ["commit", "-m", "init"]);
        const defaultBranch = String(await gitAsync(root, ["branch", "--show-current"])).trim() || "main";
        await gitAsync(root, ["remote", "add", "origin", remoteRepo]);
        await gitAsync(root, ["push", "-u", "origin", defaultBranch]);

        await gitAsync(root, ["checkout", "-b", "feat/preview-only-one"]);
        await fsp.writeFile(path.join(root, "feature.txt"), "feature\n", "utf8");
        await gitAsync(root, ["add", "feature.txt"]);
        await gitAsync(root, ["commit", "-m", "feature preview"]);

        const preview = await dispatchGitFeatureAction({
          action: "push.preview",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(preview.ok).toBe(true);
        expect(preview.data?.remote).toBe("origin");
        expect(preview.data?.remoteBranch).toBe("feat/preview-only-one");
        expect(preview.data?.commitCount).toBe(1);
        expect(preview.data?.commits?.map((one: { subject: string }) => one.subject)).toEqual(["feature preview"]);
        expect(preview.data?.commits?.[0]?.files).toEqual([
          expect.objectContaining({
            path: "feature.txt",
            status: "A",
          }),
        ]);
        expect(preview.data?.files).toEqual([
          expect.objectContaining({
            path: "feature.txt",
            status: "A",
          }),
        ]);
      } finally {
        try { await fsp.rm(root, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(remoteRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "推送预览应保留重命名文件的旧路径信息",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-feature-preview-rename-"));
      const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-feature-preview-rename-remote-"));
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-feature-preview-rename-userdata-"));
      try {
        const remoteRepo = path.join(remoteRoot, "origin.git");
        await gitAsync(remoteRoot, ["init", "--bare", remoteRepo]);

        await gitAsync(root, ["init"]);
        await gitAsync(root, ["config", "user.name", "CodexFlow"]);
        await gitAsync(root, ["config", "user.email", "codexflow@example.com"]);
        await gitAsync(root, ["config", "core.autocrlf", "false"]);
        await gitAsync(root, ["config", "core.eol", "lf"]);

        await fsp.writeFile(path.join(root, "README.md"), "# demo\n", "utf8");
        await gitAsync(root, ["add", "README.md"]);
        await gitAsync(root, ["commit", "-m", "init"]);
        const defaultBranch = String(await gitAsync(root, ["branch", "--show-current"])).trim() || "main";
        await gitAsync(root, ["remote", "add", "origin", remoteRepo]);
        await gitAsync(root, ["push", "-u", "origin", defaultBranch]);

        await gitAsync(root, ["checkout", "-b", "feat/preview-rename"]);
        await fsp.mkdir(path.join(root, "docs"), { recursive: true });
        await gitAsync(root, ["mv", "README.md", "docs/README.md"]);
        await gitAsync(root, ["commit", "-m", "rename readme"]);

        const preview = await dispatchGitFeatureAction({
          action: "push.preview",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(preview.ok).toBe(true);
        expect(preview.data?.commitCount).toBe(1);
        expect(preview.data?.commits?.[0]?.files?.[0]?.path).toBe("docs/README.md");
        expect(preview.data?.commits?.[0]?.files?.[0]?.oldPath).toBe("README.md");
        expect(String(preview.data?.commits?.[0]?.files?.[0]?.status || "")).toMatch(/^R/);
        expect(preview.data?.files?.[0]?.path).toBe("docs/README.md");
        expect(preview.data?.files?.[0]?.oldPath).toBe("README.md");
        expect(String(preview.data?.files?.[0]?.status || "")).toMatch(/^R/);
      } finally {
        try { await fsp.rm(root, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(remoteRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "push reject 为 no-fast-forward 时应返回结构化更新决策",
    async () => {
      const ctx = await initPushRejectReposAsync("reject-no-ff");
      try {
        await fsp.writeFile(path.join(ctx.peerRepo, "README.md"), "# demo\npeer\n", "utf8");
        await gitAsync(ctx.peerRepo, ["add", "README.md"]);
        await gitAsync(ctx.peerRepo, ["commit", "-m", "peer change"]);
        await gitAsync(ctx.peerRepo, ["push", "origin", ctx.defaultBranch]);

        await fsp.writeFile(path.join(ctx.repo, "README.md"), "# demo\nlocal\n", "utf8");
        await gitAsync(ctx.repo, ["add", "README.md"]);
        await gitAsync(ctx.repo, ["commit", "-m", "local change"]);

        const push = await dispatchGitFeatureAction({
          action: "push.execute",
          payload: { repoPath: ctx.repo, updateIfRejected: true },
          userDataPath: ctx.userDataPath,
        });

        expect(push.ok).toBe(false);
        expect(push.data?.pushRejected).toEqual(expect.objectContaining({
          type: "no-fast-forward",
          branch: ctx.defaultBranch,
          remote: "origin",
          remoteBranch: ctx.defaultBranch,
        }));
        expect(push.data?.pushRejected?.actions?.map((item: { kind: string }) => item.kind)).toEqual([
          "update-with-merge",
          "update-with-rebase",
          "force-with-lease",
          "cancel",
        ]);
      } finally {
        try { await fsp.rm(ctx.repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(ctx.remoteRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(path.dirname(ctx.peerRepo), { recursive: true, force: true }); } catch {}
        try { await fsp.rm(ctx.userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "force-with-lease 因 stale info 被拒绝时应返回继续强推决策",
    async () => {
      const ctx = await initPushRejectReposAsync("reject-stale-info");
      try {
        await fsp.writeFile(path.join(ctx.peerRepo, "README.md"), "# demo\npeer\n", "utf8");
        await gitAsync(ctx.peerRepo, ["add", "README.md"]);
        await gitAsync(ctx.peerRepo, ["commit", "-m", "peer change"]);
        await gitAsync(ctx.peerRepo, ["push", "origin", ctx.defaultBranch]);

        await fsp.writeFile(path.join(ctx.repo, "README.md"), "# demo\nlocal rewrite\n", "utf8");
        await gitAsync(ctx.repo, ["add", "README.md"]);
        await gitAsync(ctx.repo, ["commit", "-m", "local rewrite"]);

        const push = await dispatchGitFeatureAction({
          action: "push.execute",
          payload: { repoPath: ctx.repo, forceWithLease: true },
          userDataPath: ctx.userDataPath,
        });

        expect(push.ok).toBe(false);
        expect(push.data?.pushRejected).toEqual(expect.objectContaining({
          type: "stale-info",
          branch: ctx.defaultBranch,
          remote: "origin",
          remoteBranch: ctx.defaultBranch,
        }));
        expect(push.data?.pushRejected?.actions?.map((item: { kind: string }) => item.kind)).toEqual([
          "force-push",
          "cancel",
        ]);
      } finally {
        try { await fsp.rm(ctx.repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(ctx.remoteRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(path.dirname(ctx.peerRepo), { recursive: true, force: true }); } catch {}
        try { await fsp.rm(ctx.userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "远端策略拒绝推送时应返回 rejected-other 结构化结果",
    async () => {
      const ctx = await initRefusingRemoteAsync("reject-other");
      try {
        await fsp.writeFile(path.join(ctx.repo, "README.md"), "# remote\nlocal\n", "utf8");
        await gitAsync(ctx.repo, ["add", "README.md"]);
        await gitAsync(ctx.repo, ["commit", "-m", "local change"]);

        const push = await dispatchGitFeatureAction({
          action: "push.execute",
          payload: { repoPath: ctx.repo },
          userDataPath: ctx.userDataPath,
        });

        expect(push.ok).toBe(false);
        expect(push.data?.pushRejected).toEqual(expect.objectContaining({
          type: "rejected-other",
          branch: ctx.defaultBranch,
          remote: "origin",
          remoteBranch: ctx.defaultBranch,
        }));
        expect(push.data?.pushRejected?.actions?.map((item: { kind: string }) => item.kind)).toEqual(["cancel"]);
      } finally {
        try { await fsp.rm(path.dirname(ctx.repo), { recursive: true, force: true }); } catch {}
        try { await fsp.rm(ctx.remoteRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(ctx.userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );
});
