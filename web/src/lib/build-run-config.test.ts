import { describe, expect, it } from "vitest";

import type { BuildRunCommandConfig, DirBuildRunConfig } from "@/types/host";

import {
  cloneBuildRunCommandConfig,
  createEmptyBuildRunCommandConfig,
  hasBuildRunCommand,
  normalizeBuildRunCommandDraft,
  removeBuildRunCommandConfig,
  upsertBuildRunCommandConfig,
} from "./build-run-config";

/**
 * 中文说明：构造简单模式命令，便于测试读写逻辑。
 */
function createSimpleCommand(commandText: string): BuildRunCommandConfig {
  return {
    mode: "simple",
    commandText,
    cwd: "",
    env: [],
    backend: { kind: "system" },
  };
}

/**
 * 中文说明：构造目录级配置，减少测试中的重复样板。
 */
function createDirConfig(partial?: Partial<DirBuildRunConfig>): DirBuildRunConfig {
  return {
    ...(partial || {}),
  };
}

describe("build-run-config（Build/Run 配置辅助逻辑）", () => {
  it("空草稿会回落到默认简单模式配置", () => {
    expect(createEmptyBuildRunCommandConfig()).toEqual({
      mode: "simple",
      commandText: "",
      cwd: "",
      env: [],
      backend: { kind: "system" },
    });
    expect(cloneBuildRunCommandConfig(null)).toEqual(createEmptyBuildRunCommandConfig());
  });

  it("标准化简单模式草稿时会清理空白并折叠换行", () => {
    const normalized = normalizeBuildRunCommandDraft({
      mode: "simple",
      commandText: "  npm run build\r\n",
      cwd: "  ./web  ",
      env: [{ key: " A ", value: "1" }],
    }, false);

    expect(normalized).toEqual({
      mode: "simple",
      commandText: "npm run build",
      cwd: "./web",
      env: [{ key: " A ", value: "1" }],
      backend: { kind: "system" },
      cmd: undefined,
      args: undefined,
    });
  });

  it("标准化高级模式草稿时会提取 cmd 和 args", () => {
    const normalized = normalizeBuildRunCommandDraft({
      mode: "advanced",
      cmd: "  npm  ",
      args: [" run ", "", " dev "],
      backend: { kind: "wsl", distro: "Ubuntu" },
    }, true);

    expect(normalized).toEqual({
      mode: "advanced",
      cwd: "",
      env: [],
      backend: { kind: "wsl", distro: "Ubuntu" },
      commandText: undefined,
      cmd: "npm",
      args: ["run", "dev"],
    });
  });

  it("hasBuildRunCommand 只在存在有效命令时返回 true", () => {
    expect(hasBuildRunCommand(createSimpleCommand("npm run build"))).toBe(true);
    expect(hasBuildRunCommand(createSimpleCommand("   "))).toBe(false);
    expect(hasBuildRunCommand({ mode: "advanced", cmd: "node", args: [], env: [], backend: { kind: "system" } })).toBe(true);
    expect(hasBuildRunCommand({ mode: "advanced", cmd: "   ", args: [], env: [], backend: { kind: "system" } })).toBe(false);
  });

  it("移除当前 worktree 的动作配置时会保留另一动作", () => {
    const source = createDirConfig({
      build: createSimpleCommand("npm run build"),
      run: createSimpleCommand("npm run dev"),
    });

    expect(removeBuildRunCommandConfig(source, "build")).toEqual({
      run: createSimpleCommand("npm run dev"),
    });
    expect(upsertBuildRunCommandConfig(source, "build", createSimpleCommand("pnpm build"))).toEqual({
      build: createSimpleCommand("pnpm build"),
      run: createSimpleCommand("npm run dev"),
    });
  });
});
