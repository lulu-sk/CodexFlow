// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import {
  createDefaultBranchPopupGroupOpen,
  type BranchPopupGroupOpen,
  type GitBranchPopupStep,
} from "./tree-model";

const GIT_BRANCH_POPUP_STATE_STORAGE_KEY = "cf.git.branchPopup.state.v1";

export type GitBranchPopupPersistedState = {
  selectedRepoRoot: string;
  step: GitBranchPopupStep;
  groupOpen: BranchPopupGroupOpen;
};

function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function normalizeBranchPopupPersistedState(value: any): GitBranchPopupPersistedState {
  return {
    selectedRepoRoot: String(value?.selectedRepoRoot || "").trim(),
    step: value?.step === "repositories" ? "repositories" : "branches",
    groupOpen: {
      favorites: value?.groupOpen?.favorites !== false,
      recent: value?.groupOpen?.recent !== false,
      local: value?.groupOpen?.local !== false,
      remote: value?.groupOpen?.remote !== false,
    },
  };
}

/**
 * 读取 branch popup 的本地树状态；读取失败时回退到默认展开策略。
 */
export function loadGitBranchPopupState(): GitBranchPopupPersistedState {
  const storage = getStorage();
  if (!storage) {
    return {
      selectedRepoRoot: "",
      step: "branches",
      groupOpen: createDefaultBranchPopupGroupOpen(),
    };
  }
  try {
    const raw = storage.getItem(GIT_BRANCH_POPUP_STATE_STORAGE_KEY);
    if (!raw) {
      return {
        selectedRepoRoot: "",
        step: "branches",
        groupOpen: createDefaultBranchPopupGroupOpen(),
      };
    }
    return normalizeBranchPopupPersistedState(JSON.parse(raw));
  } catch {
    return {
      selectedRepoRoot: "",
      step: "branches",
      groupOpen: createDefaultBranchPopupGroupOpen(),
    };
  }
}

/**
 * 持久化 branch popup 的仓选择、step 与分组展开状态，供再次打开时恢复。
 */
export function saveGitBranchPopupState(state: Partial<GitBranchPopupPersistedState>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const previous = loadGitBranchPopupState();
    const next = normalizeBranchPopupPersistedState({
      ...previous,
      ...state,
      groupOpen: {
        ...previous.groupOpen,
        ...state.groupOpen,
      },
    });
    storage.setItem(GIT_BRANCH_POPUP_STATE_STORAGE_KEY, JSON.stringify(next));
  } catch {}
}
