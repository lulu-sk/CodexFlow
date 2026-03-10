import type { BuildRunCommandConfig, DirBuildRunConfig } from "@/types/host";

/**
 * 中文说明：构造一个空的 Build/Run 命令草稿，作为对话框默认值。
 */
export function createEmptyBuildRunCommandConfig(): BuildRunCommandConfig {
  return {
    mode: "simple",
    commandText: "",
    cwd: "",
    env: [],
    backend: { kind: "system" },
  };
}

/**
 * 中文说明：复制一份可编辑的 Build/Run 命令配置，避免直接复用缓存对象。
 */
export function cloneBuildRunCommandConfig(cfg?: BuildRunCommandConfig | null): BuildRunCommandConfig {
  if (!cfg || typeof cfg !== "object")
    return createEmptyBuildRunCommandConfig();
  return {
    ...cfg,
    env: Array.isArray(cfg.env)
      ? cfg.env.map((row) => ({ key: String(row?.key || ""), value: String(row?.value ?? "") }))
      : [],
    args: Array.isArray(cfg.args) ? cfg.args.map((arg) => String(arg ?? "")) : cfg.args,
    backend: cfg.backend && typeof cfg.backend === "object" ? { ...(cfg.backend as any) } : { kind: "system" },
  };
}

/**
 * 中文说明：判断一条 Build/Run 配置是否包含可执行命令。
 */
export function hasBuildRunCommand(cfg?: BuildRunCommandConfig | null): cfg is BuildRunCommandConfig {
  if (!cfg || typeof cfg !== "object")
    return false;
  if (cfg.mode === "advanced")
    return String(cfg.cmd || "").trim().length > 0;
  return String(cfg.commandText || "").trim().length > 0;
}

/**
 * 中文说明：将对话框草稿标准化为可持久化的 Build/Run 配置。
 */
export function normalizeBuildRunCommandDraft(
  draft: Partial<BuildRunCommandConfig> | null | undefined,
  advanced: boolean,
): BuildRunCommandConfig {
  const nextCmd = cloneBuildRunCommandConfig(draft as BuildRunCommandConfig | null | undefined);
  nextCmd.cwd = String(draft?.cwd || "").trim();
  nextCmd.backend = draft?.backend && typeof draft.backend === "object" ? { ...(draft.backend as any) } : { kind: "system" };
  nextCmd.env = Array.isArray(draft?.env)
    ? draft.env.map((row) => ({ key: String(row?.key || ""), value: String(row?.value ?? "") }))
    : [];

  if (advanced) {
    nextCmd.mode = "advanced";
    nextCmd.commandText = undefined;
    nextCmd.cmd = String(draft?.cmd || "").trim();
    nextCmd.args = Array.isArray(draft?.args)
      ? draft.args.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
      : [];
    return nextCmd;
  }

  nextCmd.mode = "simple";
  nextCmd.cmd = undefined;
  nextCmd.args = undefined;
  nextCmd.commandText = String(draft?.commandText || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  return nextCmd;
}

/**
 * 中文说明：写入指定动作的 Build/Run 配置，并保留另一动作已有配置。
 */
export function upsertBuildRunCommandConfig(
  cfg: DirBuildRunConfig | null | undefined,
  action: "build" | "run",
  command: BuildRunCommandConfig,
): DirBuildRunConfig {
  return { ...(cfg || {}), [action]: command };
}

/**
 * 中文说明：移除指定动作的 Build/Run 配置，用于恢复继承父项目命令。
 */
export function removeBuildRunCommandConfig(
  cfg: DirBuildRunConfig | null | undefined,
  action: "build" | "run",
): DirBuildRunConfig {
  const next: DirBuildRunConfig = { ...(cfg || {}) };
  delete (next as Record<string, unknown>)[action];
  return next;
}
