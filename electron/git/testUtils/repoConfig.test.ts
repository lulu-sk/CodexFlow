import { afterEach, beforeEach, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execGitAsync } from "../exec";
import { configureGitFixtureAsync } from "./repoConfig";

let root = "";
let repo = "";
const calls: string[][] = [];

/** 执行真实配置命令，并要求测试准备及查询都成功。 */
async function git(directory: string, argv: string[]): Promise<string> {
  const result = await execGitAsync({ argv: ["-C", directory, ...argv], timeoutMs: 20_000 });
  expect(result.ok, result.stderr || result.error).toBe(true);
  return result.stdout.trim();
}

/** 记录回退命令，验证特殊配置仍由 Git 按原语义处理。 */
async function fallback(directory: string, argv: string[]): Promise<string> {
  calls.push(argv);
  return await git(directory, argv);
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-fixture-config-"));
  repo = path.join(root, "repo");
  await fsp.mkdir(repo);
  await git(repo, ["init", "--template=", "-b", "main"]);
  calls.length = 0;
});

afterEach(async () => {
  if (!root) return;
  const realRoot = await fsp.realpath(root);
  if (path.dirname(realRoot) !== await fsp.realpath(os.tmpdir()) || !path.basename(realRoot).startsWith("codexflow-fixture-config-")) {
    throw new Error("临时目录越界，拒绝删除");
  }
  await fsp.rm(realRoot, { recursive: true, force: true });
});

it("初始配置可由 Git 正常读取且不再启动逐项配置命令", async () => {
  await configureGitFixtureAsync(repo, [
    ["user.name", "Fixture"], ["user.email", "fixture@example.invalid"],
    ["core.autocrlf", "false"], ["core.eol", "lf"],
  ], fallback);
  expect(calls).toHaveLength(0);
  expect(await git(repo, ["config", "--local", "--get-all", "user.name"])).toBe("Fixture");
  expect(await git(repo, ["config", "--local", "user.email"])).toBe("fixture@example.invalid");
  expect(await git(repo, ["config", "--local", "core.autocrlf"])).toBe("false");
  expect(await git(repo, ["config", "--local", "core.eol"])).toBe("lf");
}, 30_000);

it("既有值通过原命令更新而不是产生重复配置", async () => {
  await git(repo, ["config", "user.name", "Before"]);
  await configureGitFixtureAsync(repo, [["user.name", "After"]], fallback);
  expect(calls).toHaveLength(1);
  expect(await git(repo, ["config", "--local", "--get-all", "user.name"])).toBe("After");
}, 30_000);

it.each([
  { label: "同一行的节名和配置项", config: "[user] name = Before\n", key: "user.name", value: "After" },
  { label: "省略等号的布尔配置", config: "[core]\n\tautocrlf\n", key: "core.autocrlf", value: "false" },
])("$label 仍更新已有值", async ({ config, key, value }) => {
  await fsp.appendFile(path.join(repo, ".git", "config"), config, "utf8");
  await configureGitFixtureAsync(repo, [[key, value]], fallback);
  expect(await git(repo, ["config", "--local", "--get-all", key])).toBe(value);
  expect(calls).toHaveLength(1);
}, 30_000);

it("包含配置文件时保留原 Git 写入方式", async () => {
  await fsp.writeFile(path.join(repo, ".git", "included.config"), "[user]\n\tname = Included\n", "utf8");
  await git(repo, ["config", "include.path", "included.config"]);
  await configureGitFixtureAsync(repo, [["user.email", "fixture@example.invalid"]], fallback);
  expect(calls).toHaveLength(1);
  expect(await git(repo, ["config", "--local", "--includes", "user.name"])).toBe("Included");
  expect(await git(repo, ["config", "--local", "user.email"])).toBe("fixture@example.invalid");
}, 30_000);

it.each<{
  label: string; settings: Array<[string, string]>; key: string; value: string;
}>([
  { label: "空格取值", settings: [["user.name", "Fixture User"]], key: "user.name", value: "Fixture User" },
  { label: "未知配置项", settings: [["core.filemode", "false"]], key: "core.filemode", value: "false" },
  { label: "重复键", settings: [["user.email", "first@example.invalid"], ["user.email", "last@example.invalid"]], key: "user.email", value: "last@example.invalid" },
])("$label 保持原命令语义", async ({ settings, key, value }) => {
  await configureGitFixtureAsync(repo, settings, fallback);
  expect(calls).toHaveLength(settings.length);
  expect(await git(repo, ["config", "--local", "--get-all", key])).toBe(value);
}, 30_000);

it("独立工作区使用原配置命令且不改写 gitdir 文件", async () => {
  await configureGitFixtureAsync(repo, [["user.name", "Fixture"], ["user.email", "fixture@example.invalid"]], fallback);
  await git(repo, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"]);
  const worktree = path.join(root, "worktree");
  await git(repo, ["worktree", "add", "-b", "linked", worktree]);
  const original = await fsp.readFile(path.join(worktree, ".git"), "utf8");
  await configureGitFixtureAsync(worktree, [["user.name", "Updated"]], fallback);
  expect(calls).toHaveLength(1);
  expect(await git(worktree, ["config", "--local", "user.name"])).toBe("Updated");
  expect(await fsp.readFile(path.join(worktree, ".git"), "utf8")).toBe(original);
}, 30_000);

it("回退命令失败时仍让测试失败", async () => {
  await fsp.unlink(path.join(repo, ".git", "config"));
  const error = new Error("configuration failed");
  await expect(configureGitFixtureAsync(repo, [["user.name", "Fixture"]], async () => { throw error; })).rejects.toBe(error);
});
