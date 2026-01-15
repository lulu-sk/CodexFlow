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
});

