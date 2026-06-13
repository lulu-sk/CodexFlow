// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import { describe, expect, it } from "vitest";

import {
  mergeProjectWorktreePostSetup,
  normalizeProjectWorktreePostSetup,
} from "./worktreePostSetupConfig";

describe("project worktree post setup config", () => {
  it("归一化项目级后置设置并过滤无效路径", () => {
    const cfg = normalizeProjectWorktreePostSetup({
      items: [".env.local", ".env.local", "../secret", "C:/repo/.env", { relativePath: "config\\local", label: "本地配置" }],
      command: " npm ci ",
      applyAfterReset: false,
    });

    expect(cfg).toEqual({
      items: [
        { relativePath: ".env.local", label: ".env.local" },
        { relativePath: "config/local", label: "本地配置" },
      ],
      command: "npm ci",
      applyAfterReset: false,
    });
  });

  it("扫描结果缺少配置时保留缓存项目的后置设置", () => {
    const scanned = {
      id: "scan",
      name: "repo",
      winPath: "C:\\repo",
      wslPath: "/mnt/c/repo",
      hasDotCodex: false,
      createdAt: 20,
    };
    const cached = {
      id: "cache",
      worktreePostSetup: {
        items: [{ relativePath: ".env.local" }],
        command: "npm ci",
        applyAfterReset: false,
      },
    };

    const merged = mergeProjectWorktreePostSetup(scanned, cached);

    expect(merged.worktreePostSetup).toEqual({
      items: [{ relativePath: ".env.local", label: ".env.local" }],
      command: "npm ci",
      applyAfterReset: false,
    });
  });

  it("扫描结果自身存在有效配置时优先使用自身配置", () => {
    const merged = mergeProjectWorktreePostSetup(
      {
        id: "scan",
        worktreePostSetup: { items: [{ relativePath: ".env" }], command: "", applyAfterReset: true },
      },
      { worktreePostSetup: { items: [{ relativePath: ".env.local" }], command: "npm ci", applyAfterReset: false } },
    );

    expect(merged.worktreePostSetup).toEqual({
      items: [{ relativePath: ".env", label: ".env" }],
      command: "",
      applyAfterReset: true,
    });
  });
});
