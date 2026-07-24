import { describe, expect, it } from "vitest";
import { getBuiltInProviders, isBuiltInProviderId, isBuiltInSessionProviderId } from "./builtins";
import { BUILT_IN_AGENT_PROVIDER_IDS, isBuiltInAgentProviderId } from "./ids";

describe("内置 Provider 注册", () => {
  it("Grok 作为第五个内置会话引擎注册，并使用独立明暗图标", () => {
    expect(BUILT_IN_AGENT_PROVIDER_IDS).toEqual(["codex", "claude", "gemini", "antigravity", "grok"]);
    expect(isBuiltInAgentProviderId("grok")).toBe(true);
    expect(isBuiltInProviderId("grok")).toBe(true);
    expect(isBuiltInSessionProviderId("grok")).toBe(true);

    const grok = getBuiltInProviders().find((provider) => provider.id === "grok");
    expect(grok).toMatchObject({ defaultStartupCmd: "grok", labelKey: "providers:items.grok" });
    expect(grok?.iconUrl).toBeTruthy();
    expect(grok?.iconUrlDark).toBeTruthy();
    expect(grok?.iconUrlDark).not.toBe(grok?.iconUrl);
  });
});
