import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGitLogCommitEditingPrefs, saveGitLogCommitEditingPrefs } from "./log-commit-editing-prefs";

type LocalStorageMock = {
  clear(): void;
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
};

/**
 * 为 Node 测试环境注入最小 localStorage mock，供偏好持久化逻辑复用。
 */
function ensureLocalStorageMock(): LocalStorageMock {
  const globalObject = globalThis as typeof globalThis & {
    localStorage?: Storage & LocalStorageMock;
    window?: any;
  };
  const existing = globalObject.window?.localStorage || globalObject.localStorage;
  if (existing) return existing;

  const store = new Map<string, string>();
  const mock: Storage & LocalStorageMock = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  globalObject.localStorage = mock;
  if (typeof globalObject.window !== "object" || !globalObject.window) {
    globalObject.window = {};
  }
  globalObject.window.localStorage = mock;
  return mock;
}

/**
 * 为偏好测试提供稳定的 localStorage 清理，避免用例间互相污染。
 */
function clearStorage(): void {
  ensureLocalStorageMock().clear();
}

afterEach(() => {
  clearStorage();
});

beforeEach(() => {
  ensureLocalStorageMock();
  clearStorage();
});

describe("log-commit-editing-prefs", () => {
  it("缺省场景应继续显示删除提交确认", () => {
    expect(loadGitLogCommitEditingPrefs()).toEqual({
      showDropCommitConfirmation: true,
    });
  });

  it("保存后应恢复删除提交确认开关", () => {
    saveGitLogCommitEditingPrefs({
      showDropCommitConfirmation: false,
    });

    expect(loadGitLogCommitEditingPrefs()).toEqual({
      showDropCommitConfirmation: false,
    });
  });
});
