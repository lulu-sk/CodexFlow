import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { execGitAsync } from "./exec";
import { dispatchGitFeatureAction } from "./featureService";

/**
 * 在指定仓库执行 Git 命令，失败时输出完整 stderr，方便定位 fetch 夹具问题。
 */
async function gitAsync(repo: string, argv: string[], timeoutMs: number = 30_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 创建一个带默认提交用户信息的临时 Git 仓库。
 */
async function createRepoAsync(prefix: string): Promise<string> {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  await gitAsync(repo, ["init"]);
  await gitAsync(repo, ["config", "user.name", "CodexFlow"]);
  await gitAsync(repo, ["config", "user.email", "codexflow@example.com"]);
  await gitAsync(repo, ["config", "core.autocrlf", "false"]);
  await gitAsync(repo, ["config", "core.eol", "lf"]);
  return repo;
}

/**
 * 创建 bare 远端仓库，供 fetch 集成测试复用。
 */
async function createBareRemoteAsync(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const remoteRepo = path.join(root, "origin.git");
  await gitAsync(root, ["init", "--bare", remoteRepo]);
  return remoteRepo;
}

/**
 * 统一删除测试产生的临时目录，避免失败场景污染后续用例。
 */
async function removePathQuietlyAsync(targetPath: string): Promise<void> {
  try {
    await fsp.rm(targetPath, { recursive: true, force: true });
  } catch {}
}

describe("featureService fetch flow", () => {
  it(
    "显式 remote + refspec 应只把目标分支获取到指定 remote ref",
    async () => {
      const repo = await createRepoAsync("codexflow-fetch-repo-");
      const remoteRepo = await createBareRemoteAsync("codexflow-fetch-remote-");
      const collaboratorRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-fetch-collab-"));
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-fetch-user-"));
      try {
        await fsp.writeFile(path.join(repo, "README.md"), "# fetch\n", "utf8");
        await gitAsync(repo, ["add", "README.md"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "main";
        await gitAsync(repo, ["remote", "add", "origin", remoteRepo]);
        await gitAsync(repo, ["push", "-u", "origin", defaultBranch], 60_000);

        const collaborator = path.join(collaboratorRoot, "collaborator");
        await gitAsync(collaboratorRoot, ["clone", remoteRepo, collaborator], 60_000);
        await gitAsync(collaborator, ["config", "user.name", "Collaborator"]);
        await gitAsync(collaborator, ["config", "user.email", "collaborator@example.com"]);
        await fsp.writeFile(path.join(collaborator, "topic.txt"), "topic\n", "utf8");
        await gitAsync(collaborator, ["checkout", "-b", "topic"]);
        await gitAsync(collaborator, ["add", "topic.txt"]);
        await gitAsync(collaborator, ["commit", "-m", "topic commit"]);
        await gitAsync(collaborator, ["push", "origin", "topic"], 60_000);

        const fetchRes = await dispatchGitFeatureAction({
          action: "flow.fetch",
          payload: {
            repoPath: repo,
            remote: "origin",
            refspec: "refs/heads/topic:refs/remotes/origin/topic",
          },
          userDataPath,
        });
        expect(fetchRes.ok).toBe(true);
        expect(fetchRes.data?.fetchedRemotes).toEqual(["origin"]);
        expect((await gitAsync(repo, ["log", "-1", "--pretty=%s", "refs/remotes/origin/topic"])).trim()).toBe("topic commit");
      } finally {
        await removePathQuietlyAsync(repo);
        await removePathQuietlyAsync(path.dirname(remoteRepo));
        await removePathQuietlyAsync(collaboratorRoot);
        await removePathQuietlyAsync(userDataPath);
      }
    },
    { timeout: 120_000 },
  );

  it(
    "tagMode=none/all 应分别跳过或获取远端新 tag",
    async () => {
      const repo = await createRepoAsync("codexflow-fetch-repo-");
      const remoteRepo = await createBareRemoteAsync("codexflow-fetch-remote-");
      const collaboratorRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-fetch-collab-"));
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-fetch-user-"));
      try {
        await fsp.writeFile(path.join(repo, "README.md"), "# fetch\n", "utf8");
        await gitAsync(repo, ["add", "README.md"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "main";
        await gitAsync(repo, ["remote", "add", "origin", remoteRepo]);
        await gitAsync(repo, ["push", "-u", "origin", defaultBranch], 60_000);

        const collaborator = path.join(collaboratorRoot, "collaborator");
        await gitAsync(collaboratorRoot, ["clone", remoteRepo, collaborator], 60_000);
        await gitAsync(collaborator, ["config", "user.name", "Collaborator"]);
        await gitAsync(collaborator, ["config", "user.email", "collaborator@example.com"]);
        await gitAsync(collaborator, ["tag", "v1"]);
        await gitAsync(collaborator, ["push", "origin", "v1"], 60_000);

        const noTagsRes = await dispatchGitFeatureAction({
          action: "flow.fetch",
          payload: {
            repoPath: repo,
            remote: "origin",
            tagMode: "none",
          },
          userDataPath,
        });
        expect(noTagsRes.ok).toBe(true);
        expect((await gitAsync(repo, ["tag", "--list", "v1"])).trim()).toBe("");

        const allTagsRes = await dispatchGitFeatureAction({
          action: "flow.fetch",
          payload: {
            repoPath: repo,
            remote: "origin",
            tagMode: "all",
          },
          userDataPath,
        });
        expect(allTagsRes.ok).toBe(true);
        expect((await gitAsync(repo, ["tag", "--list", "v1"])).trim()).toBe("v1");
      } finally {
        await removePathQuietlyAsync(repo);
        await removePathQuietlyAsync(path.dirname(remoteRepo));
        await removePathQuietlyAsync(collaboratorRoot);
        await removePathQuietlyAsync(userDataPath);
      }
    },
    { timeout: 120_000 },
  );

  it(
    "allRemotes=true 应顺序获取全部远端并刷新各自 remote refs",
    async () => {
      const repo = await createRepoAsync("codexflow-fetch-repo-");
      const originRemote = await createBareRemoteAsync("codexflow-fetch-origin-");
      const upstreamRemote = await createBareRemoteAsync("codexflow-fetch-upstream-");
      const originCollaboratorRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-fetch-origin-collab-"));
      const upstreamCollaboratorRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-fetch-upstream-collab-"));
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-fetch-user-"));
      try {
        await fsp.writeFile(path.join(repo, "README.md"), "# fetch\n", "utf8");
        await gitAsync(repo, ["add", "README.md"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "main";

        await gitAsync(repo, ["remote", "add", "origin", originRemote]);
        await gitAsync(repo, ["remote", "add", "upstream", upstreamRemote]);
        await gitAsync(repo, ["push", "-u", "origin", defaultBranch], 60_000);
        await gitAsync(repo, ["push", "-u", "upstream", defaultBranch], 60_000);

        const originCollaborator = path.join(originCollaboratorRoot, "collaborator");
        await gitAsync(originCollaboratorRoot, ["clone", originRemote, originCollaborator], 60_000);
        await gitAsync(originCollaborator, ["config", "user.name", "Origin"]);
        await gitAsync(originCollaborator, ["config", "user.email", "origin@example.com"]);
        await fsp.writeFile(path.join(originCollaborator, "origin.txt"), "origin\n", "utf8");
        await gitAsync(originCollaborator, ["add", "origin.txt"]);
        await gitAsync(originCollaborator, ["commit", "-m", "origin commit"]);
        await gitAsync(originCollaborator, ["push", "origin", defaultBranch], 60_000);

        const upstreamCollaborator = path.join(upstreamCollaboratorRoot, "collaborator");
        await gitAsync(upstreamCollaboratorRoot, ["clone", upstreamRemote, upstreamCollaborator], 60_000);
        await gitAsync(upstreamCollaborator, ["config", "user.name", "Upstream"]);
        await gitAsync(upstreamCollaborator, ["config", "user.email", "upstream@example.com"]);
        await fsp.writeFile(path.join(upstreamCollaborator, "upstream.txt"), "upstream\n", "utf8");
        await gitAsync(upstreamCollaborator, ["add", "upstream.txt"]);
        await gitAsync(upstreamCollaborator, ["commit", "-m", "upstream commit"]);
        await gitAsync(upstreamCollaborator, ["push", "origin", defaultBranch], 60_000);

        const fetchRes = await dispatchGitFeatureAction({
          action: "flow.fetch",
          payload: {
            repoPath: repo,
            allRemotes: true,
          },
          userDataPath,
        });
        expect(fetchRes.ok).toBe(true);
        expect(fetchRes.data?.fetchedRemotes).toEqual(["origin", "upstream"]);
        expect((await gitAsync(repo, ["log", "-1", "--pretty=%s", `refs/remotes/origin/${defaultBranch}`])).trim()).toBe("origin commit");
        expect((await gitAsync(repo, ["log", "-1", "--pretty=%s", `refs/remotes/upstream/${defaultBranch}`])).trim()).toBe("upstream commit");
      } finally {
        await removePathQuietlyAsync(repo);
        await removePathQuietlyAsync(path.dirname(originRemote));
        await removePathQuietlyAsync(path.dirname(upstreamRemote));
        await removePathQuietlyAsync(originCollaboratorRoot);
        await removePathQuietlyAsync(upstreamCollaboratorRoot);
        await removePathQuietlyAsync(userDataPath);
      }
    },
    { timeout: 120_000 },
  );

  it(
    "unshallow=true 应把浅克隆仓库补全为完整历史",
    async () => {
      const sourceRepo = await createRepoAsync("codexflow-fetch-source-");
      const remoteRepo = await createBareRemoteAsync("codexflow-fetch-remote-");
      const shallowRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-fetch-shallow-root-"));
      const shallowClone = path.join(shallowRoot, "repo");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-fetch-user-"));
      try {
        await fsp.writeFile(path.join(sourceRepo, "README.md"), "one\n", "utf8");
        await gitAsync(sourceRepo, ["add", "README.md"]);
        await gitAsync(sourceRepo, ["commit", "-m", "commit one"]);
        await fsp.writeFile(path.join(sourceRepo, "README.md"), "two\n", "utf8");
        await gitAsync(sourceRepo, ["commit", "-am", "commit two"]);
        const defaultBranch = (await gitAsync(sourceRepo, ["branch", "--show-current"])).trim() || "main";
        await gitAsync(sourceRepo, ["remote", "add", "origin", remoteRepo]);
        await gitAsync(sourceRepo, ["push", "-u", "origin", defaultBranch], 60_000);

        const remoteUrl = pathToFileURL(remoteRepo).href;
        const cloneRes = await execGitAsync({
          argv: ["clone", "--depth=1", remoteUrl, shallowClone],
          timeoutMs: 60_000,
        });
        expect(cloneRes.ok, cloneRes.stderr || cloneRes.error || cloneRes.stdout).toBe(true);
        expect((await gitAsync(shallowClone, ["rev-parse", "--is-shallow-repository"])).trim()).toBe("true");

        const fetchRes = await dispatchGitFeatureAction({
          action: "flow.fetch",
          payload: {
            repoPath: shallowClone,
            unshallow: true,
          },
          userDataPath,
        });
        expect(fetchRes.ok).toBe(true);
        expect(fetchRes.data?.fetchedRemotes).toEqual(["origin"]);
        expect((await gitAsync(shallowClone, ["rev-parse", "--is-shallow-repository"])).trim()).toBe("false");
      } finally {
        await removePathQuietlyAsync(sourceRepo);
        await removePathQuietlyAsync(path.dirname(remoteRepo));
        await removePathQuietlyAsync(shallowRoot);
        await removePathQuietlyAsync(userDataPath);
      }
    },
    { timeout: 120_000 },
  );
});
