import { afterEach, describe, expect, it } from "vitest";
import {
  clearPendingPushAfterCommitRequest,
  consumePendingPushAfterCommitRequest,
  persistPendingPushAfterCommitRequest,
} from "./push-after-commit";

type MockStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/**
 * 创建一个最小可用的本地存储桩，供 push-after-commit 持久化逻辑复用。
 */
function createMockStorage(): MockStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

/**
 * 把测试用 storage 挂到 globalThis，模拟浏览器 localStorage。
 */
function installMockStorage(storage: MockStorage): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
}

afterEach(() => {
  try {
    clearPendingPushAfterCommitRequest();
  } catch {}
  try {
    Reflect.deleteProperty(globalThis, "localStorage");
  } catch {}
  try {
    Reflect.deleteProperty(globalThis, "window");
  } catch {}
});

describe("push-after-commit storage helpers", () => {
  it("匹配目标仓库时应消费并清理待续推请求", () => {
    installMockStorage(createMockStorage());

    persistPendingPushAfterCommitRequest({
      targetRepoRoot: "/repo/app",
      targetHash: "abc123",
    });

    expect(consumePendingPushAfterCommitRequest("/repo/app")).toEqual({
      targetRepoRoot: "/repo/app",
      targetHash: "abc123",
    });
    expect(consumePendingPushAfterCommitRequest("/repo/app")).toBeNull();
  });

  it("仓库不匹配时不应提前消费，等匹配仓库再返回", () => {
    installMockStorage(createMockStorage());

    persistPendingPushAfterCommitRequest({
      targetRepoRoot: "/repo/lib",
      targetHash: "def456",
    });

    expect(consumePendingPushAfterCommitRequest("/repo/app")).toBeNull();
    expect(consumePendingPushAfterCommitRequest("/repo/lib")).toEqual({
      targetRepoRoot: "/repo/lib",
      targetHash: "def456",
    });
  });

  it("读取到损坏的持久化数据时应回收脏状态", () => {
    const storage = createMockStorage();
    installMockStorage(storage);
    storage.setItem("cf.git.pendingPushAfterCommit", "{bad json");

    expect(consumePendingPushAfterCommitRequest("/repo/app")).toBeNull();
    expect(storage.getItem("cf.git.pendingPushAfterCommit")).toBeNull();
  });
});
