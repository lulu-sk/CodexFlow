import { afterAll, beforeAll, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execGitAsync } from "./exec";
import { readSubmoduleStatusAsync } from "./submoduleStatus";
import { configureGitFixtureAsync } from "./testUtils/repoConfig";

let root = "";

/** 执行真实 Git 命令，保留失败结果供子模块状态对照。 */
async function git(repo: string, argv: string[], stdin?: string) {
  return await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs: 20_000, stdin });
}

/** 构造夹具时要求命令成功，避免错误的初始状态掩盖回归。 */
async function prepare(repo: string, argv: string[], stdin?: string): Promise<string> {
  const result = await git(repo, argv, stdin);
  expect(result.ok, result.stderr || result.error).toBe(true);
  return result.stdout;
}

/** 创建具有独立配置和初始提交的仓库。 */
async function createRepo(name: string): Promise<string> {
  const repo = path.join(root, name);
  await fsp.mkdir(repo);
  await prepare(repo, ["init", "--template=", "-b", "main"]);
  await configureGitFixtureAsync(repo, [["user.name", "Fixture"], ["user.email", "fixture@example.invalid"]], prepare);
  await fsp.writeFile(path.join(repo, "file.txt"), "fixture\n", "utf8");
  await prepare(repo, ["add", "file.txt"]);
  await prepare(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
  return repo;
}

/** 与 Git 原始递归查询比较成功状态和完整输出。 */
async function expectOriginalResult(repo: string): Promise<void> {
  const actual = await readSubmoduleStatusAsync(repo, (directory, argv) => git(directory, argv));
  const original = await git(repo, ["submodule", "status", "--recursive"]);
  expect(actual.ok).toBe(original.ok);
  expect(actual.stdout).toBe(original.stdout);
}

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-submodule-status-"));
});

afterAll(async () => {
  if (!root) return;
  const realRoot = await fsp.realpath(root);
  const realParent = await fsp.realpath(os.tmpdir());
  if (path.dirname(realRoot) !== realParent || !path.basename(realRoot).startsWith("codexflow-submodule-status-")) {
    throw new Error("临时目录越界，拒绝删除");
  }
  await fsp.rm(realRoot, { recursive: true, force: true });
});

it("普通仓库、独立工作区和空索引保持原查询结果", async () => {
  const repo = await createRepo("plain");
  const commands: string[] = [];
  const result = await readSubmoduleStatusAsync(repo, async (directory, argv) => {
    commands.push(argv[0]);
    return await git(directory, argv);
  });
  expect(result).toEqual({ ok: true, stdout: "" });
  expect(commands).not.toContain("submodule");
  await expectOriginalResult(repo);
  const linked = path.join(root, "linked");
  await prepare(repo, ["worktree", "add", "-b", "linked", linked]);
  await expectOriginalResult(linked);
  const unborn = path.join(root, "unborn");
  await fsp.mkdir(unborn);
  await prepare(unborn, ["init", "-b", "main"]);
  await expectOriginalResult(unborn);
}, 60_000);

it("裸仓库的空索引不能掩盖原查询错误", async () => {
  const repo = path.join(root, "bare");
  await fsp.mkdir(repo);
  await prepare(repo, ["init", "--bare", "-b", "main"]);
  await expectOriginalResult(repo);
}, 30_000);

it("存在 .git 标记但启用裸仓库配置时保留原查询错误", async () => {
  const repo = await createRepo("bare-with-marker");
  await prepare(repo, ["config", "core.bare", "true"]);
  const original = await git(repo, ["submodule", "status", "--recursive"]);
  expect(original.ok).toBe(false);
  await expectOriginalResult(repo);
}, 30_000);

it("索引内子模块、配置缺失和未初始化状态保持原查询结果", async () => {
  const repo = await createRepo("gitlink");
  const head = (await prepare(repo, ["rev-parse", "HEAD"])).trim();
  await prepare(repo, ["update-index", "--add", "--cacheinfo", `160000,${head},module`]);
  await expectOriginalResult(repo);
  await fsp.writeFile(path.join(repo, ".gitmodules"), '[submodule "module"]\n\tpath = module\n\turl = ../origin\n', "utf8");
  await prepare(repo, ["add", ".gitmodules"]);
  await expectOriginalResult(repo);
  await fsp.unlink(path.join(repo, ".gitmodules"));
  await expectOriginalResult(repo);
}, 60_000);

it("冲突索引不能被误判为可以省略查询", async () => {
  const repo = await createRepo("conflict");
  const blob = (await prepare(repo, ["rev-parse", "HEAD:file.txt"])).trim();
  await prepare(repo, ["update-index", "--index-info"], `100644 ${blob} 1\tconflict.txt\n100644 ${blob} 2\tconflict.txt\n`);
  const commands: string[] = [];
  await readSubmoduleStatusAsync(repo, async (directory, argv) => {
    commands.push(argv[0]);
    return await git(directory, argv);
  });
  expect(commands).toContain("submodule");
  await expectOriginalResult(repo);
}, 60_000);

it("已初始化的嵌套子模块保留完整递归结果", async () => {
  const leaf = await createRepo("nested-leaf");
  const middle = await createRepo("nested-middle");
  const parent = await createRepo("nested-parent");
  await prepare(middle, ["-c", "protocol.file.allow=always", "submodule", "add", leaf, "leaf"]);
  await prepare(middle, ["-c", "commit.gpgsign=false", "commit", "-am", "add leaf"]);
  await prepare(parent, ["-c", "protocol.file.allow=always", "submodule", "add", middle, "middle"]);
  await prepare(parent, ["-c", "commit.gpgsign=false", "commit", "-am", "add middle"]);
  await prepare(parent, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
  const status = await readSubmoduleStatusAsync(parent, (directory, argv) => git(directory, argv));
  expect(status.ok).toBe(true);
  expect(status.stdout).toContain("middle/leaf");
  await expectOriginalResult(parent);
}, 90_000);

it("稀疏索引和两万条目索引保持原查询结果", async () => {
  const repo = await createRepo("sparse");
  await fsp.mkdir(path.join(repo, "included"));
  await fsp.mkdir(path.join(repo, "excluded"));
  await fsp.writeFile(path.join(repo, "included", "a.txt"), "a", "utf8");
  await fsp.writeFile(path.join(repo, "excluded", "b.txt"), "b", "utf8");
  await prepare(repo, ["add", "."]);
  await prepare(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "sparse fixture"]);
  await prepare(repo, ["sparse-checkout", "init", "--cone", "--sparse-index"]);
  await prepare(repo, ["sparse-checkout", "set", "included"]);
  await expectOriginalResult(repo);
  const large = await createRepo("large");
  const blob = (await prepare(large, ["rev-parse", "HEAD:file.txt"])).trim();
  const entries = Array.from({ length: 20_000 }, (_, index) => `100644 ${blob}\tfile-${index}.txt\n`).join("");
  await prepare(large, ["update-index", "--index-info"], entries);
  await expectOriginalResult(large);
}, 90_000);

it("索引失败、异常或输出不完整时保留原查询错误", async () => {
  const repo = await createRepo("fallback");
  const blob = "a".repeat(40);
  const inputs = [
    { ok: false, stdout: "" },
    { ok: true },
    { ok: true, stdout: "unexpected\0" },
    { ok: true, stdout: `100644 ${blob} 0\tfile.txt` },
    { ok: true, stdout: `040000 ${blob} 0\tdir\0` },
    new Error("index read failed"),
  ];
  for (const input of inputs) {
    const expected = { ok: false, stdout: "", error: "original error" };
    const actual = await readSubmoduleStatusAsync(repo, async (_directory, argv) => {
      if (argv[0] !== "ls-files") return expected;
      if (input instanceof Error) throw input;
      return input;
    });
    expect(actual).toBe(expected);
  }
  await fsp.writeFile(path.join(repo, ".gitmodules"), "[malformed\n", "utf8");
  await expectOriginalResult(repo);
}, 60_000);
