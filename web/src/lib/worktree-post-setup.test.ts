import { describe, expect, it } from "vitest";

import {
  hasWorktreePostSetupActions,
  isBlockedWorktreePostSetupRelativePath,
  normalizeWorktreePostSetupConfig,
  normalizeWorktreePostSetupRelativePath,
  toProjectRelativeWorktreePostSetupPath,
} from "./worktree-post-setup";

describe("worktree-post-setup", () => {
  it("应只接受项目内相对路径", () => {
    expect(normalizeWorktreePostSetupRelativePath("config/local.json")).toBe("config/local.json");
    expect(normalizeWorktreePostSetupRelativePath("config\\local.json")).toBe("config/local.json");
    expect(normalizeWorktreePostSetupRelativePath("../secret")).toBe("");
    expect(normalizeWorktreePostSetupRelativePath("C:/repo/.env")).toBe("");
    expect(normalizeWorktreePostSetupRelativePath("/repo/.env")).toBe("");
  });

  it("应拦截 node_modules 等危险目录", () => {
    expect(isBlockedWorktreePostSetupRelativePath("node_modules")).toBe(true);
    expect(isBlockedWorktreePostSetupRelativePath("node_modules/pkg")).toBe(true);
    expect(isBlockedWorktreePostSetupRelativePath(".git/hooks")).toBe(true);
    expect(isBlockedWorktreePostSetupRelativePath("web/dist")).toBe(true);
    expect(isBlockedWorktreePostSetupRelativePath(".env.local")).toBe(false);
  });

  it("应从项目绝对路径推导相对路径", () => {
    expect(toProjectRelativeWorktreePostSetupPath("G:/Repo/App", "G:/Repo/App/.env.local")).toBe(".env.local");
    expect(toProjectRelativeWorktreePostSetupPath("G:/Repo/App", "G:/Repo/App/config/local")).toBe("config/local");
    expect(toProjectRelativeWorktreePostSetupPath("G:/Repo/App", "G:/Other/config")).toBe("");
    expect(toProjectRelativeWorktreePostSetupPath("G:/Repo/App", "G:/Repo/App")).toBe("");
  });

  it("应归一化配置并默认启用重置后应用", () => {
    const cfg = normalizeWorktreePostSetupConfig({
      items: [{ relativePath: ".env.local" }, { relativePath: ".env.local" }, "config/local"],
      command: " npm ci ",
    });
    expect(cfg.items?.map((item) => item.relativePath)).toEqual([".env.local", "config/local"]);
    expect(cfg.command).toBe("npm ci");
    expect(cfg.applyAfterReset).toBe(true);
    expect(hasWorktreePostSetupActions(cfg)).toBe(true);
  });
});
