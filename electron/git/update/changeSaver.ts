// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)
// Update 保存/恢复本地改动流程参考 IntelliJ IDEA Community Edition / IntelliJ Platform 的 Apache-2.0 源码语义，并按本项目 Electron/TypeScript 架构重写。

import { spawnGitStdoutToFileAsync } from "../exec";
import { ShelveChangesManager } from "../shelf/manager";
import type { GitShelfManagerRuntime } from "../shelf/types";
import { ShelvedChangesViewManager } from "../shelf/viewManager";
import { GitStashViewManager } from "../stash/viewManager";
import { VcsShelveChangesSaver } from "../shelf/vcsShelveChangesSaver";
import {
  buildLocalChangesNotRestoredMessage,
  buildPreservingState,
  buildSavedLocalChangesDisplayName,
} from "./conflicts";
import type {
  GitSavedLocalChanges,
  GitUpdatePostAction,
  GitUpdatePreservingState,
  GitUpdateSaveChangesPolicy,
} from "./types";

type GitChangesSaverLoadResult = Promise<
  | { ok: true; restoredRoots: string[] }
  | { ok: false; error: string; failedRoots: string[]; restoredRoots: string[]; conflictRoots?: string[] }
>;

export type GitChangesSaverRuntime = {
  ctx?: {
    gitPath?: string;
    userDataPath?: string;
  };
  userDataPath?: string;
  repoRoot: string;
  runGitExecAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number): Promise<any>;
  runGitSpawnAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv): Promise<any>;
  runGitStdoutToFileAsync?(targetRepoRoot: string, argv: string[], targetPath: string, timeoutMs?: number): Promise<any>;
  emitProgress?(targetRepoRoot: string, message: string, detail?: string): void;
  toGitErrorMessage(res: any, fallback: string): string;
};

/**
 * 构建 update preserving 使用的统一保存说明，便于 stash/shelve 两种实现共享展示文本。
 */
function buildUpdatePreservingMessage(reason: string): string {
  return `codexflow update: ${String(reason || "preserve").trim() || "preserve"} @ ${new Date().toISOString()}`;
}

/**
 * 读取指定仓库当前栈顶 stash 引用；不存在时返回空字符串。
 */
async function getTopStashRefAsync(runtime: GitChangesSaverRuntime, repoRoot: string): Promise<string> {
  const res = await runtime.runGitExecAsync(repoRoot, ["stash", "list", "-n", "1", "--format=%gd"], 10_000);
  if (!res.ok) return "";
  return String(res.stdout || "").trim().split(/\r?\n/)[0] || "";
}

/**
 * 把通用 saver runtime 适配为 shelf manager runtime，统一支持单仓与多仓 preserving。
 */
function createShelfManagerRuntime(runtime: GitChangesSaverRuntime): GitShelfManagerRuntime {
  return {
    repoRoot: runtime.repoRoot,
    userDataPath: String(runtime.userDataPath || runtime.ctx?.userDataPath || "").trim(),
    runGitExecAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number) {
      return runtime.runGitExecAsync(targetRepoRoot, argv, timeoutMs);
    },
    runGitSpawnAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv) {
      return runtime.runGitSpawnAsync(targetRepoRoot, argv, timeoutMs, envPatch);
    },
    runGitStdoutToFileAsync(targetRepoRoot: string, argv: string[], targetPath: string, timeoutMs?: number) {
      if (runtime.runGitStdoutToFileAsync)
        return runtime.runGitStdoutToFileAsync(targetRepoRoot, argv, targetPath, timeoutMs);
      return spawnGitStdoutToFileAsync({
        gitPath: runtime.ctx?.gitPath,
        cwd: targetRepoRoot,
        argv,
        outFile: targetPath,
        timeoutMs,
      });
    },
    emitProgress(targetRepoRoot: string, message: string, detail?: string) {
      runtime.emitProgress?.(targetRepoRoot, message, detail);
    },
    toGitErrorMessage(res, fallback) {
      return runtime.toGitErrorMessage(res, fallback);
    },
  };
}

/**
 * 读取指定仓库当前的未合并文件列表，供 stash/shelve 恢复失败时识别是否进入冲突态。
 */
async function listUnmergedPathsAsync(runtime: GitChangesSaverRuntime, repoRoot: string): Promise<string[]> {
  const res = await runtime.runGitExecAsync(repoRoot, ["diff", "--name-only", "--diff-filter=U"], 10_000);
  if (!res.ok) return [];
  return String(res.stdout || "")
    .split(/\r?\n/)
    .map((item) => String(item || "").trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

/**
 * 把单根更新 runtime 适配为可跨 root 的 saver runtime，兼容旧有单仓 preserving 调用方。
 */
export function adaptSingleRootSaverRuntime(runtime: {
  ctx?: {
    gitPath?: string;
    userDataPath?: string;
  };
  repoRoot: string;
  runGitExecAsync(argv: string[], timeoutMs?: number): Promise<any>;
  runGitSpawnAsync(argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv): Promise<any>;
  emitProgress?(message: string, detail?: string): void;
  toGitErrorMessage(res: any, fallback: string): string;
}): GitChangesSaverRuntime {
  return {
    ctx: runtime.ctx,
    userDataPath: runtime.ctx?.userDataPath,
    repoRoot: runtime.repoRoot,
    runGitExecAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number) {
      if (targetRepoRoot !== runtime.repoRoot)
        throw new Error("当前 saver runtime 不支持跨仓读取");
      return runtime.runGitExecAsync(argv, timeoutMs);
    },
    runGitSpawnAsync(targetRepoRoot: string, argv: string[], timeoutMs?: number, envPatch?: NodeJS.ProcessEnv) {
      if (targetRepoRoot !== runtime.repoRoot)
        throw new Error("当前 saver runtime 不支持跨仓执行");
      return runtime.runGitSpawnAsync(argv, timeoutMs, envPatch);
    },
    emitProgress(targetRepoRoot: string, message: string, detail?: string) {
      if (targetRepoRoot !== runtime.repoRoot) return;
      runtime.emitProgress?.(message, detail);
    },
    toGitErrorMessage(res: any, fallback: string) {
      return runtime.toGitErrorMessage(res, fallback);
    },
  };
}

/**
 * 抽象 update 过程中的“保存/恢复本地改动”能力，对齐 IDEA `GitChangesSaver` 的职责边界。
 */
export abstract class GitChangesSaver {
  protected readonly runtime: GitChangesSaverRuntime;

  protected readonly saveChangesPolicy: GitUpdateSaveChangesPolicy;

  protected readonly stashMessage: string;

  protected readonly savedLocalChangesByRoot = new Map<string, GitSavedLocalChanges>();

  /**
   * 初始化 saver 基础上下文，供具体 stash/shelve 实现复用。
   */
  protected constructor(runtime: GitChangesSaverRuntime, saveChangesPolicy: GitUpdateSaveChangesPolicy, stashMessage: string) {
    this.runtime = runtime;
    this.saveChangesPolicy = saveChangesPolicy;
    this.stashMessage = stashMessage;
  }

  /**
   * 按保存策略创建具体 saver，实现 update 主流程与具体保存介质解耦。
   */
  static getSaver(
    runtime: GitChangesSaverRuntime,
    saveChangesPolicy: GitUpdateSaveChangesPolicy,
    stashMessage: string,
  ): GitChangesSaver {
    if (saveChangesPolicy === "shelve")
      return new GitShelveChangesSaver(runtime, stashMessage);
    return new GitStashChangesSaver(runtime, stashMessage);
  }

  /**
   * 兼容旧调用方，按默认消息构造 saver。
   */
  static create(runtime: GitChangesSaverRuntime, saveChangesPolicy: GitUpdateSaveChangesPolicy): GitChangesSaver {
    return GitChangesSaver.getSaver(runtime, saveChangesPolicy, buildUpdatePreservingMessage("preserve"));
  }

  /**
   * 写入当前 saver 持有的保存记录集合。
   */
  protected setSavedLocalChanges(savedItems: GitSavedLocalChanges[]): void {
    this.savedLocalChangesByRoot.clear();
    for (const item of savedItems) {
      const repoRoot = String(item.repoRoot || "").trim();
      if (!repoRoot) continue;
      this.savedLocalChangesByRoot.set(repoRoot, item);
    }
  }

  /**
   * 把外部已存在的保存记录重新挂回当前 saver，供单仓恢复失败后的 `showSavedChanges` 与通知动作复用。
   */
  rehydrateSavedLocalChanges(savedItems: GitSavedLocalChanges[]): void {
    this.setSavedLocalChanges(savedItems);
  }

  /**
   * 保存指定 roots 的本地改动；空集合直接视为无需保存。
   */
  async saveLocalChanges(rootsToSave: string[]): Promise<void> {
    const normalizedRoots = Array.from(new Set(
      (Array.isArray(rootsToSave) ? rootsToSave : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ));
    if (normalizedRoots.length <= 0) {
      this.savedLocalChangesByRoot.clear();
      return;
    }
    const saveRes = await this.save(normalizedRoots);
    if (!saveRes.ok) throw new Error(saveRes.error);
    this.setSavedLocalChanges(saveRes.saved);
  }

  /**
   * 保存本地改动并把失败转换为文本错误，方便 preserving process 直接中断主流程。
   */
  async saveLocalChangesOrError(rootsToSave: string[]): Promise<string | null> {
    try {
      await this.saveLocalChanges(rootsToSave);
      return null;
    } catch (error) {
      return String((error as Error)?.message || "保存本地改动失败");
    }
  }

  /**
   * 尝试保存本地改动；成功返回布尔结果，失败时附带可直接展示的错误文本。
   */
  async trySaveLocalChanges(rootsToSave: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
    const errorMessage = await this.saveLocalChangesOrError(rootsToSave);
    if (!errorMessage) return { ok: true };
    return { ok: false, error: errorMessage };
  }

  /**
   * 恢复之前保存的全部本地改动；若此前没有保存任何内容，则直接成功返回。
   */
  async load(): GitChangesSaverLoadResult {
    return await this.loadSavedLocalChangesAsync(this.getSavedLocalChangesList());
  }

  /**
   * 判断当前 saver 是否真的保存过本地改动。
   */
  wereChangesSaved(): boolean {
    return this.savedLocalChangesByRoot.size > 0;
  }

  /**
   * 返回第一条保存记录，兼容既有单仓 preserving 调用方。
   */
  getSavedLocalChanges(): GitSavedLocalChanges | null {
    return this.getSavedLocalChangesList()[0] || null;
  }

  /**
   * 返回指定 root 对应的保存记录；未保存时返回 null。
   */
  getSavedLocalChangesForRoot(repoRoot: string): GitSavedLocalChanges | null {
    return this.savedLocalChangesByRoot.get(String(repoRoot || "").trim()) || null;
  }

  /**
   * 返回全部保存记录副本，供 preserving 结果回填与通知动作构建复用。
   */
  getSavedLocalChangesList(): GitSavedLocalChanges[] {
    return Array.from(this.savedLocalChangesByRoot.values()).map((item) => ({ ...item }));
  }

  /**
   * 构建“本地改动暂不自动恢复”的 preserving state，和 IDEA 的 warning 语义保持一致。
   */
  notifyLocalChangesAreNotRestored(operationName: string): GitUpdatePreservingState | null {
    const first = this.getSavedLocalChanges();
    if (!first) return null;
    return buildPreservingState(
      first,
      "kept-saved",
      "keep-saved",
      buildLocalChangesNotRestoredMessage(first, "manual-decision", operationName),
      "manual-decision",
      {
        savedChangesAction: this.showSavedChanges() || undefined,
      },
    );
  }

  /**
   * 为指定保存记录生成“查看已保存改动”动作；多仓场景会优先指向当前 root 对应的记录。
   */
  getSavedChangesAction(_saved?: GitSavedLocalChanges | null): GitUpdatePostAction | null {
    return this.showSavedChanges();
  }

  /**
   * 返回当前保存记录对应的查看动作；在当前宿主环境中由前端据此激活对应视图。
   */
  showSavedChanges(): GitUpdatePostAction | null {
    return null;
  }

  /**
   * 保存当前 roots 的本地改动，并返回每个 root 对应的保存记录。
   */
  abstract save(rootsToSave: string[]): Promise<{ ok: true; saved: GitSavedLocalChanges[] } | { ok: false; error: string }>;

  /**
   * 恢复给定的保存记录集合；失败时返回结构化错误供外层构建 preserving state。
   */
  abstract loadSavedLocalChangesAsync(savedItems: GitSavedLocalChanges[]): GitChangesSaverLoadResult;

  /**
   * 兼容旧调用方，恢复单条保存记录。
   */
  async loadLocalChangesAsync(saved: GitSavedLocalChanges): GitChangesSaverLoadResult {
    return await this.loadSavedLocalChangesAsync([saved]);
  }
}

/**
 * 基于统一 shelf manager 保存更新前本地改动，对齐 IDEA 的 `GitShelveChangesSaver` 角色。
 */
class GitShelveChangesSaver extends GitChangesSaver {
  private readonly shelfManager: ShelveChangesManager;

  private readonly shelvedChangesViewManager: ShelvedChangesViewManager;

  private readonly vcsShelveChangesSaver: VcsShelveChangesSaver;

  /**
   * 初始化 shelve saver，并派生统一 shelf manager 与平台级 saver。
   */
  constructor(runtime: GitChangesSaverRuntime, stashMessage: string) {
    super(runtime, "shelve", stashMessage);
    const shelfRuntime = createShelfManagerRuntime(runtime);
    this.shelfManager = new ShelveChangesManager(shelfRuntime);
    this.shelvedChangesViewManager = new ShelvedChangesViewManager(runtime.repoRoot);
    this.vcsShelveChangesSaver = new VcsShelveChangesSaver(shelfRuntime, stashMessage, "system");
  }

  /**
   * 通过平台级 `VcsShelveChangesSaver` 保存当前本地改动。
   */
  async save(rootsToSave: string[]): Promise<{ ok: true; saved: GitSavedLocalChanges[] } | { ok: false; error: string }> {
    try {
      await this.vcsShelveChangesSaver.save(rootsToSave);
      const savedItems = this.vcsShelveChangesSaver.getShelvedLists().flatMap((item) => (
        item.repoRoots.map((repoRoot) => ({
          repoRoot,
          ref: item.ref,
          message: item.message,
          saveChangesPolicy: "shelve" as const,
          displayName: item.displayName,
        }))
      ));
      return {
        ok: true,
        saved: savedItems,
      };
    } catch (error) {
      return {
        ok: false,
        error: String((error as Error)?.message || "保存本地改动失败"),
      };
    }
  }

  /**
   * 按唯一 shelf 引用恢复保存记录；多 root 记录会一次性恢复整条 system shelf。
   */
  async loadSavedLocalChangesAsync(savedItems: GitSavedLocalChanges[]): GitChangesSaverLoadResult {
    const refs = Array.from(new Set(
      (Array.isArray(savedItems) ? savedItems : [])
        .map((item) => String(item.ref || "").trim())
        .filter(Boolean),
    ));
    const failedRoots = new Set<string>();
    const restoredRoots = new Set<string>();
    for (const ref of refs) {
      const restoreRes = await this.shelfManager.unshelveChangeListAsync(ref);
      if (!restoreRes.ok) {
        for (const item of savedItems) {
          if (String(item.ref || "").trim() === ref)
            failedRoots.add(String(item.repoRoot || "").trim());
        }
        return {
          ok: false,
          error: restoreRes.error,
          failedRoots: Array.from(failedRoots).filter(Boolean),
          restoredRoots: Array.from(restoredRoots).filter(Boolean),
          conflictRoots: Array.isArray(restoreRes.conflictRepoRoots)
            ? restoreRes.conflictRepoRoots.map((item) => String(item || "").trim()).filter(Boolean)
            : undefined,
        };
      }
      for (const item of savedItems) {
        if (String(item.ref || "").trim() === ref)
          restoredRoots.add(String(item.repoRoot || "").trim());
      }
    }
    return { ok: true, restoredRoots: Array.from(restoredRoots).filter(Boolean) };
  }

  /**
   * 返回 shelf saver 的查看动作，对齐 IDEA `ShelvedChangesViewManager.activateView` 的职责。
   */
  showSavedChanges(): GitUpdatePostAction | null {
    const first = this.vcsShelveChangesSaver.getShelvedLists()[0] || null;
    if (first)
      return this.shelvedChangesViewManager.activateView(first);
    const saved = this.getSavedLocalChanges();
    return saved
      ? this.getSavedChangesAction(saved)
      : null;
  }

  /**
   * 按指定保存记录生成 shelf 视图动作，确保多仓 preserving 的每个 root 都能定位到自己的 system shelf。
   */
  getSavedChangesAction(saved?: GitSavedLocalChanges | null): GitUpdatePostAction | null {
    const target = saved || this.getSavedLocalChanges();
    const ref = String(target?.ref || "").trim();
    const repoRoot = String(target?.repoRoot || "").trim();
    if (!ref || !repoRoot) return null;
    return this.shelvedChangesViewManager.activateView({
      ref,
      repoRoot,
      repoRoots: this.getSavedLocalChangesList()
        .filter((item) => String(item.ref || "").trim() === ref)
        .map((item) => String(item.repoRoot || "").trim())
        .filter(Boolean),
      source: "system",
    });
  }
}

/**
 * 基于 Git stash 保存更新前本地改动，对齐 IDEA 的 `GitStashChangesSaver` 多仓保存模型。
 */
class GitStashChangesSaver extends GitChangesSaver {
  private readonly stashViewManager: GitStashViewManager;

  /**
   * 初始化 stash saver，并固定其保存策略标记为 `stash`。
   */
  constructor(runtime: GitChangesSaverRuntime, stashMessage: string) {
    super(runtime, "stash", stashMessage);
    this.stashViewManager = new GitStashViewManager(runtime.repoRoot);
  }

  /**
   * 执行 `git stash push` 保存每个 root 的工作区与未跟踪文件，并记录 root -> ref 映射。
   */
  async save(rootsToSave: string[]): Promise<{ ok: true; saved: GitSavedLocalChanges[] } | { ok: false; error: string }> {
    const savedItems: GitSavedLocalChanges[] = [];
    for (const repoRoot of rootsToSave) {
      this.runtime.emitProgress?.(repoRoot, "正在保存本地改动", this.stashMessage);
      const res = await this.runtime.runGitSpawnAsync(repoRoot, ["stash", "push", "--include-untracked", "-m", this.stashMessage], 180_000);
      if (!res.ok)
        return { ok: false, error: this.runtime.toGitErrorMessage(res, "保存本地改动失败") };
      const output = `${String(res.stdout || "")}\n${String(res.stderr || "")}`.toLowerCase();
      if (output.includes("no local changes to save") || output.includes("no local changes"))
        continue;
      const ref = await getTopStashRefAsync(this.runtime, repoRoot);
      if (!ref)
        return { ok: false, error: "已保存本地改动，但未能确认临时保存记录" };
      savedItems.push({
        repoRoot,
        ref,
        message: this.stashMessage,
        saveChangesPolicy: "stash",
        displayName: buildSavedLocalChangesDisplayName({ ref, saveChangesPolicy: "stash" }),
      });
    }
    return {
      ok: true,
      saved: savedItems,
    };
  }

  /**
   * 按 root -> stash ref 映射执行 `git stash pop --index` 恢复先前保存的本地改动。
   */
  async loadSavedLocalChangesAsync(savedItems: GitSavedLocalChanges[]): GitChangesSaverLoadResult {
    const failedRoots: string[] = [];
    const restoredRoots: string[] = [];
    for (const saved of savedItems) {
      const repoRoot = String(saved.repoRoot || "").trim();
      if (!repoRoot) continue;
      this.runtime.emitProgress?.(repoRoot, "正在恢复本地改动", saved.displayName || saved.ref);
      const restoreRes = await this.runtime.runGitSpawnAsync(repoRoot, ["stash", "pop", "--index", saved.ref], 180_000);
      if (!restoreRes.ok) {
        failedRoots.push(repoRoot);
        const conflictRoots = (await listUnmergedPathsAsync(this.runtime, repoRoot)).length > 0 ? [repoRoot] : undefined;
        return {
          ok: false,
          error: this.runtime.toGitErrorMessage(restoreRes, "恢复本地改动失败"),
          failedRoots,
          restoredRoots,
          conflictRoots,
        };
      }
      restoredRoots.push(repoRoot);
    }
    return { ok: true, restoredRoots };
  }

  /**
   * 返回 stash saver 的查看动作，对齐 IDEA `GitStashUIHandler/GitUnstashDialog` 的入口语义。
   */
  showSavedChanges(): GitUpdatePostAction | null {
    return this.getSavedChangesAction();
  }

  /**
   * 按指定保存记录生成 stash 视图动作，确保多仓 preserving 的 root 卡片能回到对应仓库。
   */
  getSavedChangesAction(saved?: GitSavedLocalChanges | null): GitUpdatePostAction | null {
    const target = saved || this.getSavedLocalChanges();
    const repoRoot = String(target?.repoRoot || "").trim();
    if (!repoRoot) return null;
    return this.stashViewManager.activateView({
      repoRoot,
      ref: target?.ref,
      repoRoots: this.getSavedLocalChangesList()
        .map((item) => item.repoRoot)
        .filter((item): item is string => !!String(item || "").trim()),
    });
  }
}
