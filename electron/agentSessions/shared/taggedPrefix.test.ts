import { describe, it, expect } from "vitest";
import { extractTaggedPrefix } from "./taggedPrefix";

describe("extractTaggedPrefix", () => {
  it("识别 <permissions instructions> 并归类为 instructions", () => {
    const src = "<permissions instructions>AAA</permissions instructions>";
    const res = extractTaggedPrefix(src);
    expect(res.rest).toBe("");
    expect(res.picked).toEqual([{ type: "instructions", text: "AAA" }]);
  });

  it("兼容 permissions instructions 无闭合标签", () => {
    const src = "<permissions instructions>AAA";
    const res = extractTaggedPrefix(src);
    expect(res.rest).toBe("");
    expect(res.picked).toEqual([{ type: "instructions", text: "AAA" }]);
  });

  it("识别 permissions instructions 后保留剩余文本（并 trim）", () => {
    const src = "<permissions instructions>AAA</permissions instructions>\n  NEXT  ";
    const res = extractTaggedPrefix(src);
    expect(res.rest).toBe("NEXT");
    expect(res.picked).toEqual([{ type: "instructions", text: "AAA" }]);
  });

  it("识别 subagent_notification 并格式化 JSON 字符串换行", () => {
    const src = [
      "<subagent_notification>",
      "{\"agent_path\":\"agent-1\",\"status\":{\"completed\":\"第一行\\n\\n第二行\"}}",
      "</subagent_notification>",
    ].join("\n");
    const res = extractTaggedPrefix(src);

    expect(res.rest).toBe("");
    expect(res.picked[0]?.type).toBe("subagent_notification");
    expect(res.picked[0]?.tags).toEqual(["subagent_notification"]);
    expect(res.picked[0]?.text).toContain("agent_path: agent-1");
    expect(res.picked[0]?.text).toContain("completed:");
    expect(res.picked[0]?.text).toContain("第一行");
    expect(res.picked[0]?.text).toContain("第二行");
    expect(res.picked[0]?.text).not.toContain("\\n");
  });
});

