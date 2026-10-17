import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wslMocks = vi.hoisted(() => ({ execInWslAsync: vi.fn() }));
vi.mock("../wsl", () => wslMocks);
import { applyCodexAuthBackupAsync, deleteCodexAuthBackupAsync, listCodexAuthBackupsAsync, preserveCodexAuthBeforeSwitchAsync, resolveCodexAccountSignature, resolveCodexAuthJsonPathAsync, upsertCodexAuthBackupAsync } from "./authBackups";

let tempRoot: string;

/** 生成可验证身份的隔离认证文件，不使用真实令牌。 */
function authContent(accountId = "account-test", userId = "user-test"): string {
  const token = `header.${Buffer.from(JSON.stringify({
    email: "user@example.test",
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_user_id: userId },
  })).toString("base64url")}.signature`;
  return JSON.stringify({ tokens: { access_token: token, id_token: token, account_id: accountId } });
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexflow-auth-backup-"));
  vi.spyOn(app, "getPath").mockReturnValue(path.join(tempRoot, "app-data"));
  vi.stubEnv("CODEX_HOME", path.join(tempRoot, "codex-home"));
  wslMocks.execInWslAsync.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("Codex 账号记录与切换", () => {
  it("同一用户的不同工作区使用不同签名，不互相覆盖", () => {
    const info = { userId: "user-test", email: "user@example.test", plan: "business", accountId: "workspace-a" };
    expect(resolveCodexAccountSignature(info).signature)
      .not.toBe(resolveCodexAccountSignature({ ...info, accountId: "workspace-b" }).signature);
  });

  it("本地与 WSL 备份路径均尊重 CODEX_HOME，兼容默认发行版", async () => {
    expect(await resolveCodexAuthJsonPathAsync({ key: "native", options: {} }))
      .toEqual({ ok: true, authJsonPath: path.join(tempRoot, "codex-home", "auth.json") });
    wslMocks.execInWslAsync.mockResolvedValue(path.join(tempRoot, "wsl-codex-home"));
    expect(await resolveCodexAuthJsonPathAsync({ key: "wsl:", options: { mode: "wsl" } }))
      .toEqual({ ok: true, authJsonPath: path.join(tempRoot, "wsl-codex-home", "auth.json") });
    expect(wslMocks.execInWslAsync).toHaveBeenCalledWith(undefined, expect.stringContaining("CODEX_HOME"), { timeoutMs: 5000 });
  });

  it("在隔离目录完成备份、列表、恢复和删除，不改动真实登录", async () => {
    const source = path.join(tempRoot, "source-auth.json");
    const target = path.join(tempRoot, "target-auth.json");
    const content = `\uFEFF${authContent()}`;
    await fs.writeFile(source, content, "utf8");
    const signature = resolveCodexAccountSignature({ accountId: "account-test", userId: "user-test", email: "user@example.test", plan: "plus" }).signature;
    expect(await upsertCodexAuthBackupAsync({ runtimeKey: "native", authJsonPath: source, signature, status: "signed_in", accountId: "account-test", userId: "user-test", email: "user@example.test", plan: "plus", reason: "test" })).toMatchObject({ ok: true });
    const items = await listCodexAuthBackupsAsync("native");
    expect(items).toHaveLength(1);
    expect(await applyCodexAuthBackupAsync({ runtimeKey: "native", backupId: items[0].id, targetAuthJsonPath: target })).toEqual({ ok: true });
    expect(await fs.readFile(target, "utf8")).toBe(content);
    expect(await applyCodexAuthBackupAsync({ runtimeKey: "native", backupId: "../invalid", targetAuthJsonPath: target })).toMatchObject({ ok: false });
    expect(await deleteCodexAuthBackupAsync({ runtimeKey: "native", backupId: items[0].id })).toEqual({ ok: true });
    expect(await listCodexAuthBackupsAsync("native")).toEqual([]);
  });

  it("凭据在查询后被外部切换时，拒绝覆盖原账号备份", async () => {
    const source = path.join(tempRoot, "source-auth.json");
    const info = { accountId: "account-test", userId: "user-test", email: "user@example.test", plan: "plus" };
    const signature = resolveCodexAccountSignature(info).signature;
    const args = { runtimeKey: "native", authJsonPath: source, signature, status: "signed_in" as const, ...info, reason: "test" };
    await fs.writeFile(source, authContent(), "utf8");
    const initial = await upsertCodexAuthBackupAsync(args);
    expect(initial).toMatchObject({ ok: true });
    if (!initial.ok) throw new Error(initial.error);
    await fs.writeFile(source, authContent("account-test", "another-user"), "utf8");
    expect(await upsertCodexAuthBackupAsync(args)).toMatchObject({ ok: false, error: expect.stringContaining("账号已变化") });
    const saved = path.join(tempRoot, "app-data", "codex-auth-backups", `auth.${initial.item.id}.json`);
    expect(await fs.readFile(saved, "utf8")).toBe(authContent());
  });

  it("API Key 即使残留旧 ChatGPT 令牌，也不能当作旧账号备份", async () => {
    const source = path.join(tempRoot, "source-auth.json");
    const info = { accountId: "account-test", userId: "user-test", email: "user@example.test", plan: "plus" };
    const raw = JSON.parse(authContent());
    await fs.writeFile(source, JSON.stringify({ ...raw, auth_mode: "apikey", OPENAI_API_KEY: "test-api-key" }), "utf8");
    expect(await upsertCodexAuthBackupAsync({ runtimeKey: "native", authJsonPath: source, signature: resolveCodexAccountSignature(info).signature, status: "signed_in", ...info, reason: "test" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("不是可备份") });
    expect(await listCodexAuthBackupsAsync("native")).toEqual([]);
  });

  it("恢复前核对备份内容与元信息，身份不符时保留当前凭据", async () => {
    const source = path.join(tempRoot, "source-auth.json");
    const target = path.join(tempRoot, "target-auth.json");
    const info = { accountId: "account-test", userId: "user-test", email: "user@example.test", plan: "plus" };
    await fs.writeFile(source, authContent(), "utf8");
    await fs.writeFile(target, "current-credentials", "utf8");
    const saved = await upsertCodexAuthBackupAsync({ runtimeKey: "native", authJsonPath: source, signature: resolveCodexAccountSignature(info).signature, status: "signed_in", ...info, reason: "test" });
    if (!saved.ok) throw new Error(saved.error);
    await fs.writeFile(path.join(tempRoot, "app-data", "codex-auth-backups", `auth.${saved.item.id}.json`), authContent("other-account"), "utf8");
    expect(await applyCodexAuthBackupAsync({ runtimeKey: "native", backupId: saved.item.id, targetAuthJsonPath: target }))
      .toMatchObject({ ok: false, error: expect.stringContaining("账号已变化") });
    expect(await fs.readFile(target, "utf8")).toBe("current-credentials");
  });

  it("首次恢复没有现有认证文件时无需查询旧账号", async () => {
    const getAccountInfo = vi.fn();
    expect(await preserveCodexAuthBeforeSwitchAsync({ runtimeKey: "native", authJsonPath: path.join(tempRoot, "missing-auth.json"), getAccountInfo }))
      .toEqual({ ok: true });
    expect(getAccountInfo).not.toHaveBeenCalled();
  });

  it("切换前成功备份现有凭据并标记备份原因", async () => {
    const source = path.join(tempRoot, "source-auth.json");
    await fs.writeFile(source, authContent(), "utf8");
    const info = { accountId: "account-test", userId: "user-test", email: "user@example.test", plan: "plus" };
    expect(await preserveCodexAuthBeforeSwitchAsync({ runtimeKey: "native", authJsonPath: source, getAccountInfo: async () => info }))
      .toEqual({ ok: true });
    expect(await listCodexAuthBackupsAsync("native")).toMatchObject([{ reason: "before-switch", userId: "user-test" }]);
  });

  it("切换前账号查询失败或无法识别已有文件时阻止覆盖", async () => {
    const source = path.join(tempRoot, "source-auth.json");
    await fs.writeFile(source, authContent(), "utf8");
    const getAccountInfo = vi.fn().mockRejectedValueOnce(new Error("query unavailable"))
      .mockResolvedValueOnce({ accountId: null, userId: null, email: null, plan: null });
    const args = { runtimeKey: "native", authJsonPath: source, getAccountInfo };
    expect(await preserveCodexAuthBeforeSwitchAsync(args)).toMatchObject({ ok: false, error: expect.stringContaining("query unavailable") });
    expect(await preserveCodexAuthBeforeSwitchAsync(args)).toMatchObject({ ok: false, error: expect.stringContaining("无法确认") });
    expect(await fs.readFile(source, "utf8")).toBe(authContent());
  });

  it("切换前备份失败时透传失败，不能继续覆盖凭据", async () => {
    const source = path.join(tempRoot, "source-auth.json");
    await fs.writeFile(source, authContent("changed-account"), "utf8");
    const info = { accountId: "account-test", userId: "user-test", email: "user@example.test", plan: "plus" };
    expect(await preserveCodexAuthBeforeSwitchAsync({ runtimeKey: "native", authJsonPath: source, getAccountInfo: async () => info }))
      .toMatchObject({ ok: false, error: expect.stringContaining("账号已变化") });
    expect(await listCodexAuthBackupsAsync("native")).toEqual([]);
  });
});
