import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyWorktreePostSetupAsync,
  isBlockedWorktreePostSetupRelativePath,
  normalizeWorktreePostSetupConfig,
  normalizeWorktreePostSetupRelativePath,
} from "./worktreePostSetup";

/**
 * 创建临时测试目录。
 */
async function createTempDirAsync(): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-wt-post-setup-"));
}

describe("worktreePostSetup", () => {
  it("应复制项目内保留项并跳过危险目录", async () => {
    const root = await createTempDirAsync();
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await fsp.mkdir(path.join(source, "config"), { recursive: true });
    await fsp.mkdir(path.join(source, "node_modules", "pkg"), { recursive: true });
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(source, ".env.local"), "TOKEN=1", "utf8");
    await fsp.writeFile(path.join(source, "config", "local.json"), "{\"ok\":true}", "utf8");
    await fsp.writeFile(path.join(source, "node_modules", "pkg", "index.js"), "module.exports = 1", "utf8");

    const res = await applyWorktreePostSetupAsync({
      sourceDir: source,
      targetDir: target,
      config: {
        items: [
          { relativePath: ".env.local" },
          { relativePath: "config" },
          { relativePath: "node_modules" },
        ],
      },
    });

    expect(res.ok).toBe(true);
    expect(res.copied).toEqual([".env.local", "config"]);
    expect(res.warnings?.some((item) => item.includes("node_modules"))).toBe(true);
    expect(await fsp.readFile(path.join(target, ".env.local"), "utf8")).toBe("TOKEN=1");
    expect(await fsp.readFile(path.join(target, "config", "local.json"), "utf8")).toBe("{\"ok\":true}");
    expect(fs.existsSync(path.join(target, "node_modules"))).toBe(false);

    await fsp.rm(root, { recursive: true, force: true });
  });

  it("应在目标目录执行初始化命令", async () => {
    const root = await createTempDirAsync();
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await fsp.mkdir(source, { recursive: true });
    await fsp.mkdir(target, { recursive: true });
    const command = process.platform === "win32"
      ? "echo ok>post.txt"
      : "printf ok > post.txt";

    const res = await applyWorktreePostSetupAsync({
      sourceDir: source,
      targetDir: target,
      config: { command },
    });

    expect(res.ok).toBe(true);
    expect(res.command?.exitCode).toBe(0);
    expect((await fsp.readFile(path.join(target, "post.txt"), "utf8")).trim()).toBe("ok");

    await fsp.rm(root, { recursive: true, force: true });
  });

  it("应拒绝复制符号链接路径", async () => {
    if (process.platform === "win32") return;
    const root = await createTempDirAsync();
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const outside = path.join(root, "outside");
    await fsp.mkdir(source, { recursive: true });
    await fsp.mkdir(target, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await fsp.symlink(outside, path.join(source, "linked"));

    const res = await applyWorktreePostSetupAsync({
      sourceDir: source,
      targetDir: target,
      config: { items: [{ relativePath: "linked" }] },
    });

    expect(res.ok).toBe(true);
    expect(res.copied).toEqual([]);
    expect(res.warnings?.some((item) => item.includes("symbolic link"))).toBe(true);
    expect(fs.existsSync(path.join(target, "linked"))).toBe(false);

    await fsp.rm(root, { recursive: true, force: true });
  });

  it("应拒绝旧规则复制中的符号链接文件", async () => {
    if (process.platform === "win32") return;
    const root = await createTempDirAsync();
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const outside = path.join(root, "outside");
    await fsp.mkdir(source, { recursive: true });
    await fsp.mkdir(target, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(path.join(outside, "AGENTS.md"), "secret", "utf8");
    await fsp.writeFile(path.join(source, ".gitignore"), "AGENTS.md\n", "utf8");
    await fsp.symlink(path.join(outside, "AGENTS.md"), path.join(source, "AGENTS.md"));
    const gitInit = spawnSync("git", ["init"], { cwd: source, stdio: "ignore" });
    if (gitInit.status !== 0) {
      await fsp.rm(root, { recursive: true, force: true });
      return;
    }

    const res = await applyWorktreePostSetupAsync({
      sourceDir: source,
      targetDir: target,
      config: {},
      copyRules: true,
    });

    expect(res.ok).toBe(true);
    expect(res.copied).not.toContain("AGENTS.md");
    expect(res.warnings?.some((item) => item.includes("symbolic link"))).toBe(true);
    expect(fs.existsSync(path.join(target, "AGENTS.md"))).toBe(false);

    await fsp.rm(root, { recursive: true, force: true });
  });

  it("应归一化路径和配置默认值", () => {
    expect(normalizeWorktreePostSetupRelativePath("config\\local")).toBe("config/local");
    expect(normalizeWorktreePostSetupRelativePath("../outside")).toBe("");
    expect(isBlockedWorktreePostSetupRelativePath("web/dist/assets")).toBe(true);
    const cfg = normalizeWorktreePostSetupConfig({ items: [".env", ".env"], command: " npm ci " });
    expect(cfg.items?.map((item) => item.relativePath)).toEqual([".env"]);
    expect(cfg.command).toBe("npm ci");
    expect(cfg.applyAfterReset).toBe(true);
  });
});
