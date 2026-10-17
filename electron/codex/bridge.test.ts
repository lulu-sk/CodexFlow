import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processMocks = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock("node:child_process", () => processMocks);
const authPathMock = vi.hoisted(() => ({ resolveCodexAuthJsonPathAsync: vi.fn() }));
vi.mock("./authPath", () => authPathMock);
vi.mock("../log", () => ({ perfLogger: { log: vi.fn() } }));
import { CodexBridge } from "./bridge";

let tempRoot: string;
let bridge: CodexBridge;
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable; killed: boolean; kill: ReturnType<typeof vi.fn> };
let messages: any[];
let respond: (message: any) => any;

/** 生成只含测试身份的 JWT 夹具。 */
function identityToken(overrides: Record<string, unknown> = {}): string {
  return `header.${Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "account-test", chatgpt_user_id: "user-test", chatgpt_plan_type: "plus", ...overrides },
  })).toString("base64url")}.signature`;
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexflow-bridge-test-"));
  const binary = path.join(tempRoot, "codex.exe");
  await fs.writeFile(binary, "test", "utf8");
  vi.stubEnv("CODEXFLOW_CODEX_BIN", binary);
  authPathMock.resolveCodexAuthJsonPathAsync.mockResolvedValue({ ok: true, authJsonPath: path.join(tempRoot, "auth.json") });
  processMocks.spawn.mockReset();
  processMocks.execFileSync.mockReset();
  messages = [];
  respond = (message) => message.method === "initialize" ? { userAgent: "test-client" } : {};
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    kill: vi.fn(() => { child.killed = true; child.emit("exit", 0, null); }),
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(String(chunk));
        messages.push(message);
        if (message.id) {
          const result = respond(message);
          if (result !== undefined) child.stdout.write(JSON.stringify({ id: message.id, ...(result?.rpcError ? { error: result.rpcError } : { result }) }) + "\n");
        }
        callback();
      },
    }),
  });
  processMocks.spawn.mockReturnValue(child);
  bridge = new CodexBridge();
});

afterEach(async () => {
  await bridge.dispose();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("Codex 账号与额度协议", () => {
  it("兼容新版令牌中的 user_id 身份字段", async () => {
    respond = (message) => message.method === "account/read" ? { account: { type: "chatgpt", email: null, planType: "plus" } }
      : message.method === "getAuthStatus" ? { authToken: identityToken({ chatgpt_user_id: undefined, user_id: "auth-user-test" }) } : {};
    expect((await bridge.getAccountInfo()).userId).toBe("auth-user-test");
  });

  it("完成初始化握手，通过官方账号接口取得邮箱与套餐，并补齐身份 ID", async () => {
    const fixtures: Record<string, unknown> = {
      initialize: { userAgent: "test-client" },
      "account/read": { account: { type: "chatgpt", email: "user@example.test", planType: "pro" } },
      getAuthStatus: { authToken: identityToken() },
    };
    respond = (message) => fixtures[message.method];
    expect(await bridge.getAccountInfo()).toEqual({ authMode: "chatgpt", email: "user@example.test", plan: "pro", accountId: "account-test", userId: "user-test" });
    expect(messages.slice(0, 3).map((message) => message.method)).toEqual(["initialize", "initialized", "account/read"]);
    expect(messages.find((message) => message.method === "account/read").params.refreshToken).toBe(false);
  });

  it("支持不导出令牌的登录方式，不能误判为未登录", async () => {
    respond = (message) => message.method === "account/read" ? { account: { type: "chatgpt", email: null, planType: "business" } }
      : message.method === "getAuthStatus" ? { authToken: null } : {};
    expect(await bridge.getAccountInfo()).toMatchObject({ authMode: "chatgpt", plan: "business" });
    respond = (message) => message.method === "account/read" ? { account: { type: "apiKey" } } : {};
    expect(await bridge.getAccountInfo()).toMatchObject({ authMode: "apiKey", email: null });
    respond = (message) => message.method === "account/read" ? { account: null } : {};
    expect(await bridge.getAccountInfo()).toMatchObject({ authMode: null, email: null, accountId: null });
  });

  it("选择 Codex 额度桶并转换分钟和绝对重置时间", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    respond = (message) => message.method === "account/rateLimits/read" ? {
      rateLimits: { primary: { usedPercent: 99 } },
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt }, secondary: null } },
    } : {};
    const snapshot = await bridge.getRateLimit();
    expect(snapshot.primary).toMatchObject({ usedPercent: 25, limitWindowSeconds: 18_000, resetsAt });
    expect(snapshot.primary?.resetAfterSeconds).toBeGreaterThanOrEqual(3599);
    expect(snapshot.secondary).toBeNull();
  });

  it("普通协议错误直接报错，不能退回旧接口或伪装成已退出登录", async () => {
    respond = (message) => message.method === "account/read" ? { rpcError: { code: -32000, message: "account unavailable" } } : {};
    await expect(bridge.getAccountInfo()).rejects.toThrow("account unavailable");
    expect(messages.some((message) => message.method === "getAuthStatus")).toBe(false);
  });

  it("仅旧版不支持新接口时使用历史身份与 HTTP 额度查询", async () => {
    respond = (message) => message.method.startsWith("account/") ? { rpcError: { code: -32601, message: "Method not found" } }
      : message.method === "getAuthStatus" ? { authToken: identityToken() } : {};
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_after_seconds: 600 } } })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await bridge.getAccountInfo()).toMatchObject({ accountId: "account-test", plan: "plus" });
    expect((await bridge.getRateLimit()).primary).toMatchObject({ usedPercent: 10, resetAfterSeconds: 600 });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("初始化和业务请求均有超时，失败后可结束等待", async () => {
    vi.spyOn(fs, "stat").mockRejectedValue(new Error("missing"));
    vi.useFakeTimers();
    respond = () => undefined;
    const pending = expect(bridge.getAccountInfo()).rejects.toThrow("timed out: initialize");
    await vi.advanceTimersByTimeAsync(20_001);
    await pending;
    expect(child.kill).toHaveBeenCalled();
  });

  it("进程退出时立即拒绝待处理请求", async () => {
    let onAccountRequest: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { onAccountRequest = resolve; });
    respond = (message) => {
      if (message.method === "account/read") {
        onAccountRequest();
        return undefined;
      }
      return {};
    };
    const pending = expect(bridge.getAccountInfo()).rejects.toThrow("CODEX_CLI_EXITED");
    await started;
    child.emit("exit", 1, null);
    await pending;
  });

  it("外部凭据文件变化时重新读取登录身份，内容不变时复用进程", async () => {
    respond = (message) => message.method === "account/read" ? { account: null } : {};
    await bridge.getAccountInfo();
    await bridge.getAccountInfo();
    expect(processMocks.spawn).toHaveBeenCalledTimes(1);
    await fs.writeFile(path.join(tempRoot, "auth.json"), JSON.stringify({ tokens: { access_token: "test-token" } }), "utf8");
    await bridge.getAccountInfo();
    expect(child.kill).toHaveBeenCalled();
    expect(processMocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("业务请求超时后清理计时器，后续请求仍可成功", async () => {
    respond = (message) => message.method === "account/read" ? { account: null } : {};
    await bridge.getAccountInfo();
    vi.spyOn(fs, "stat").mockRejectedValue(new Error("missing"));
    vi.useFakeTimers();
    respond = (message) => message.method === "account/rateLimits/read" ? undefined : {};
    const pending = expect(bridge.getRateLimit()).rejects.toThrow("timed out: account/rateLimits/read");
    await vi.advanceTimersByTimeAsync(20_001);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    respond = (message) => message.method === "account/read" ? { account: null } : {};
    await bridge.getAccountInfo();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Windows 可以直接使用 PATH 中的 Codex 可执行文件", async () => {
    vi.stubEnv("CODEXFLOW_CODEX_BIN", "");
    processMocks.execFileSync.mockReturnValue(path.join(tempRoot, "codex.exe"));
    respond = (message) => message.method === "account/read" ? { account: null } : {};
    await bridge.getAccountInfo();
    expect(processMocks.spawn.mock.calls[0][0]).toBe(path.join(tempRoot, "codex.exe"));
  });

  it("macOS/Linux 可以直接使用 PATH 中的 Codex 可执行文件", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const binary = path.join(tempRoot, "codex");
    await fs.writeFile(binary, "test", "utf8");
    await fs.chmod(binary, 0o755);
    vi.stubEnv("CODEXFLOW_CODEX_BIN", "");
    vi.stubEnv("PATH", tempRoot);
    respond = (message) => message.method === "account/read" ? { account: null } : {};
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "linux" });
      await bridge.getAccountInfo();
      expect(processMocks.spawn.mock.calls[0][0]).toBe(binary);
      expect(processMocks.execFileSync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("WSL 优先使用所选发行版安装的 Codex", async () => {
    vi.stubEnv("CODEXFLOW_CODEX_BIN", "");
    bridge = new CodexBridge({ mode: "wsl", wslDistro: "TestLinux" });
    respond = (message) => message.method === "account/read" ? { account: null } : {};
    await bridge.getAccountInfo();
    expect(processMocks.spawn.mock.calls[0][0]).toBe("wsl.exe");
    expect(processMocks.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["TestLinux", expect.stringContaining("exec codex app-server")]));
    expect(processMocks.execFileSync).not.toHaveBeenCalled();
  });
});
