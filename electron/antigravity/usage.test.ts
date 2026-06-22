// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __antigravityUsageTest, parseAntigravityUsageResponse } from "./usage";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("electron/antigravity/usage", () => {
  it("parseAntigravityUsageResponse：解析 RetrieveUserQuotaSummary 分组额度", () => {
    const snapshot = parseAntigravityUsageResponse({
      response: {
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              {
                bucketId: "five_hour",
                displayName: "Gemini Session",
                remaining: { remainingFraction: 0.42 },
                description: "Resets soon",
              },
            ],
          },
        ],
      },
    }, "quota-summary", { kind: "cli", pid: 1, commandLine: "agy" });

    expect(snapshot?.source).toBe("agy-cli");
    expect(snapshot?.windows).toHaveLength(1);
    expect(snapshot?.windows[0]).toMatchObject({
      groupName: "Gemini Models",
      label: "Gemini Session",
      remainingPercent: 42,
      usedPercent: 58,
      usageKnown: true,
    });
  });

  it("parseAntigravityUsageResponse：解析 GetUserStatus 模型额度并按模型组汇总", () => {
    const snapshot = parseAntigravityUsageResponse({
      userStatus: {
        userInfo: { email: "user@example.com" },
        planStatus: { planInfo: { planName: "Pro" } },
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: "Gemini Pro", modelOrAlias: { model: "gemini-pro" }, quotaInfo: { remainingFraction: 0.8 } },
            { label: "Claude Sonnet", modelOrAlias: { model: "claude-sonnet" }, quotaInfo: { remainingFraction: 0.3 } },
            { label: "Claude Opus", modelOrAlias: { model: "claude-opus" }, quotaInfo: { remainingFraction: 0.5 } },
          ],
        },
      },
    }, "user-status", { kind: "app", pid: 2, commandLine: "language_server --app_data_dir antigravity" });

    expect(snapshot?.source).toBe("app-local");
    expect(snapshot?.accountEmail).toBe("user@example.com");
    expect(snapshot?.planName).toBe("Pro");
    expect(snapshot?.windows.map((x) => x.groupName).sort()).toEqual(["Claude + GPT", "Gemini"]);
    expect(snapshot?.windows.find((x) => x.groupName === "Claude + GPT")?.remainingPercent).toBe(30);
  });

  it("parseAntigravityUsageResponse：解析 GetCommandModelConfigs 并过滤补全模型", () => {
    const snapshot = parseAntigravityUsageResponse({
      clientModelConfigs: [
        { label: "Autocomplete", modelOrAlias: { model: "gemini-autocomplete" }, quotaInfo: { remainingFraction: 0 } },
        { label: "GPT OSS", modelOrAlias: { model: "gpt-oss" }, quotaInfo: { remainingFraction: 0.25 } },
      ],
    }, "command-model-configs", { kind: "ide", pid: 3, commandLine: "language_server --app_data_dir antigravity-ide" });

    expect(snapshot?.source).toBe("ide-local");
    expect(snapshot?.windows).toHaveLength(1);
    expect(snapshot?.windows[0]).toMatchObject({
      groupName: "Claude + GPT",
      modelId: "gpt-oss",
      remainingPercent: 25,
      usedPercent: 75,
    });
  });

  it("buildEndpointsForCandidate：只有扩展服务 CSRF 时仍保留扩展端点", () => {
    const candidate = __antigravityUsageTest.toProcessCandidate({
      pid: 42,
      name: "language_server.exe",
      commandLine: "language_server --app_data_dir antigravity --extension_server_port 54321 --extension_server_csrf_token ext-token",
    });

    expect(candidate).toBeTruthy();
    expect(__antigravityUsageTest.buildEndpointsForCandidate(candidate!, [12345])).toEqual([
      {
        port: 54321,
        protocol: "http",
        csrfToken: "ext-token",
        candidate,
      },
    ]);
  });

  it("resolveAgyPtyCommand：Windows cmd shim 路径作为独立参数传递", () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    const resolved = __antigravityUsageTest.resolveAgyPtyCommand("C:\\Program Files\\Antigravity\\bin\\agy.cmd");

    expect(resolved).toEqual({
      file: "cmd.exe",
      args: ["/d", "/c", "call", "C:\\Program Files\\Antigravity\\bin\\agy.cmd"],
      executable: "C:\\Program Files\\Antigravity\\bin\\agy.cmd",
    });
  });
});
