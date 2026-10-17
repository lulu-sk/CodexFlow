// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAccountInline, CodexUsageHoverCard } from "./codex-status";
import { ClaudeUsageHoverCard } from "./claude-status";
import { GeminiUsageHoverCard } from "./gemini-status";
import { GrokUsageHoverCard } from "./grok-status";
import { ProviderSwitcher } from "./provider-switcher";
import { CODEX_AUTH_CHANGED_EVENT, CODEX_RATE_REFRESH_EVENT } from "@/lib/codex-status";
import { CLAUDE_USAGE_REFRESH_EVENT } from "@/lib/claude-status";
import { GEMINI_USAGE_REFRESH_EVENT } from "@/lib/gemini-status";
import { GROK_USAGE_REFRESH_EVENT } from "@/lib/grok-status";

const localization = vi.hoisted(() => ({
  t: (key: string, options?: unknown) => typeof options === "string" ? options : options ? `${key}:${JSON.stringify(options)}` : key,
  i18n: { language: "en" },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => localization }));
const hover = vi.hoisted(() => ({ open: false, onEnter: () => undefined, onLeave: () => undefined }));
vi.mock("./hover-card", () => ({ useHoverCard: () => hover }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Engine = "codex" | "claude" | "gemini" | "grok";
const cases: Array<{ id: Engine; component: React.ComponentType<any>; event: string }> = [
  { id: "codex", component: CodexUsageHoverCard, event: CODEX_RATE_REFRESH_EVENT },
  { id: "claude", component: ClaudeUsageHoverCard, event: CLAUDE_USAGE_REFRESH_EVENT },
  { id: "gemini", component: GeminiUsageHoverCard, event: GEMINI_USAGE_REFRESH_EVENT },
  { id: "grok", component: GrokUsageHoverCard, event: GROK_USAGE_REFRESH_EVENT },
];
let root: Root;
let container: HTMLDivElement;
let serial = 0;
let query: Record<Engine, ReturnType<typeof vi.fn>>;
let account: ReturnType<typeof vi.fn>;

/** 创建可手动完成的桥接请求，模拟网络返回顺序。 */
function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** 构建各引擎能显示的最小额度响应。 */
function quotaResult(id: Engine, value: number) {
  const common = { providerId: id, collectedAt: 1000 };
  const snapshot = id === "codex" ? { ...common, primary: { usedPercent: value, windowMinutes: 300 } }
    : id === "claude" ? { ...common, source: "oauth-api", windows: { fiveHour: { usedPercent: value }, sevenDay: { usedPercent: value } } }
      : id === "gemini" ? { ...common, buckets: [{ remainingFraction: 1 - value / 100 }] }
        : { ...common, source: "billing-api", quota: { usedPercent: value }, updatedAt: 1000 };
  return { ok: true, snapshot };
}

/** 挂载或更新实际组件，并完成 React 的同步状态更新。 */
async function render(element: React.ReactElement) {
  await act(async () => root.render(element));
}

/** 用触发器暴露查询状态，不依赖悬浮动画与样式。 */
function renderState(args: any) {
  return <output>{JSON.stringify(args.rateState ?? args.usageState)}</output>;
}

/** 读取实际组件呈现的查询状态。 */
function readState() {
  return JSON.parse(container.querySelector("output")!.textContent!);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  hover.open = false;
  query = {
    codex: vi.fn().mockResolvedValue(quotaResult("codex", 20)),
    claude: vi.fn().mockResolvedValue(quotaResult("claude", 20)),
    gemini: vi.fn().mockResolvedValue(quotaResult("gemini", 20)),
    grok: vi.fn().mockResolvedValue(quotaResult("grok", 20)),
  };
  account = vi.fn().mockResolvedValue({ ok: true, info: { email: "current@example.test", authType: "chatgpt", plan: "plus" } });
  (window as any).host = {
    codex: { getAccountInfo: account, getRateLimit: query.codex },
    claude: { getUsage: query.claude },
    gemini: { getUsage: query.gemini },
    grok: { getUsage: query.grok },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as any).host;
});

describe.each(cases)("$id 用量请求顺序", ({ id, component: Component, event }) => {
  it("开发模式重复挂载副作用时仍能完成首次查询", async () => {
    await render(<React.StrictMode><Component terminalMode="wsl" distro={`TestLinux-${++serial}`} loadPolicy="always"
      enableAutoRefreshInterval={false} renderTrigger={renderState} /></React.StrictMode>);
    expect(readState().loading).toBe(false);
    expect(readState().data).not.toBeNull();
  });

  it("切换运行环境后，旧环境晚到的响应不能覆盖状态或缓存", async () => {
    const old = deferred();
    const current = deferred();
    query[id].mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const distro = `TestLinux-${++serial}`;
    const card = (value: string) => <Component terminalMode="wsl" distro={value} loadPolicy="always" enableAutoRefreshInterval={false} renderTrigger={renderState} />;
    await render(card(distro));
    await render(card(`${distro}-new`));
    expect(query[id]).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve(quotaResult(id, 20)));
    const expected = readState();
    await act(async () => old.resolve(quotaResult(id, 80)));
    expect(readState()).toEqual(expected);
    if (id !== "grok") {
      await render(<span />);
      await render(<Component terminalMode="wsl" distro={distro} loadPolicy="never" renderTrigger={renderState} />);
      expect(readState().data).toBeNull();
    }
  });

  it("同环境的新请求完成后，旧请求失败不能覆盖成功结果", async () => {
    const old = deferred();
    const current = deferred();
    query[id].mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await render(<Component terminalMode="wsl" distro={`TestLinux-${++serial}`} loadPolicy="always" enableAutoRefreshInterval={false} renderTrigger={renderState} />);
    await act(async () => window.dispatchEvent(new Event(event)));
    expect(query[id]).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve(quotaResult(id, 20)));
    const expected = readState();
    await act(async () => old.reject(new Error("old request failed")));
    expect(readState()).toEqual(expected);
    expect(readState().error).toBeNull();
  });

  it("用量面板按引擎独立环境刷新，不随无关的全局环境变化", async () => {
    const distro = `TestLinux-${++serial}`;
    const switcher = (globalDistro: string, providerDistro: string) => <ProviderSwitcher activeId={id} providers={[]} onChange={() => undefined}
      terminalMode="wsl" distro={globalDistro} providerEnvs={{ [id]: { terminal: "wsl", distro: providerDistro } }} />;
    await render(switcher("GlobalLinux", distro));
    expect(query[id]).toHaveBeenCalledTimes(1);
    await render(switcher("OtherGlobalLinux", distro));
    expect(query[id]).toHaveBeenCalledTimes(1);
    await render(switcher("OtherGlobalLinux", `${distro}-new`));
    expect(query[id]).toHaveBeenCalledTimes(2);
  });
});

describe("Codex 账号信息请求顺序", () => {
  it("认证变化会清除其他 Windows 终端模式保存的账号和用量", async () => {
    hover.open = true;
    query.codex.mockResolvedValue(quotaResult("codex", 80));
    account.mockResolvedValue({ ok: true, info: { email: "old@example.test", authMode: "chatgpt" } });
    const card = (terminalMode: "cmd" | "pwsh") => <CodexUsageHoverCard terminalMode={terminalMode} loadPolicy="ifMissing"
      enableAutoRefreshInterval={false} renderTrigger={renderState} />;
    await render(card("cmd"));
    expect(container.textContent).toContain("old@example.test");
    query.codex.mockResolvedValue(quotaResult("codex", 20));
    account.mockResolvedValue({ ok: true, info: { email: "new@example.test", authMode: "chatgpt" } });
    await render(card("pwsh"));
    await act(async () => window.dispatchEvent(new Event(CODEX_AUTH_CHANGED_EVENT)));
    expect(query.codex).toHaveBeenCalledTimes(3);
    expect(account).toHaveBeenCalledTimes(3);
    await render(card("cmd"));
    expect(query.codex).toHaveBeenCalledTimes(4);
    expect(account).toHaveBeenCalledTimes(4);
    expect(readState().data.primary.usedPercent).toBe(20);
    expect(container.textContent).toContain("new@example.test");
    expect(container.textContent).not.toContain("old@example.test");
  });

  it("切换环境后不再显示旧请求返回的账号", async () => {
    const old = deferred();
    const current = deferred();
    account.mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const distro = `TestLinux-${++serial}`;
    await render(<CodexAccountInline terminalMode="wsl" distro={distro} expanded />);
    await render(<CodexAccountInline terminalMode="wsl" distro={`${distro}-new`} expanded />);
    expect(account).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve({ ok: true, info: { email: "new@example.test", authType: "chatgpt" } }));
    await act(async () => old.resolve({ ok: true, info: { email: "old@example.test", authType: "chatgpt" } }));
    expect(container.textContent).toContain("new@example.test");
    expect(container.textContent).not.toContain("old@example.test");
  });

  it("收到认证变化通知后，旧账号请求失败不能覆盖新账号", async () => {
    const old = deferred();
    const current = deferred();
    account.mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await render(<CodexAccountInline terminalMode="wsl" distro={`TestLinux-${++serial}`} expanded />);
    await act(async () => window.dispatchEvent(new Event(CODEX_AUTH_CHANGED_EVENT)));
    expect(account).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve({ ok: true, info: { email: "new@example.test", authType: "chatgpt" } }));
    await act(async () => old.reject(new Error("old account request failed")));
    expect(container.textContent).toContain("new@example.test");
    expect(container.textContent).not.toContain("账号信息不可用");
  });
});

it("Claude 内存兜底用量标记为缓存", async () => {
  hover.open = true;
  const result = quotaResult("claude", 20);
  (result.snapshot as any).source = "oauth-api-cache";
  query.claude.mockResolvedValue(result);
  await render(<ClaudeUsageHoverCard terminalMode="wsl" distro={`TestLinux-${++serial}`} loadPolicy="always" renderTrigger={renderState} />);
  expect(container.textContent).toContain('common:claudeUsage.source:{"source":"缓存"}');
});
