import { describe, expect, it } from "vitest";
import { interpolateI18nText } from "./translate";

describe("interpolateI18nText", () => {
  it("应替换双花括号占位符", () => {
    expect(interpolateI18nText("变更文件 {{count}} 个", { count: 3 })).toBe("变更文件 3 个");
  });

  it("应兼容替换单花括号占位符", () => {
    expect(interpolateI18nText("默认作者：{author}", { author: "Alice <alice@example.com>" })).toBe("默认作者：Alice <alice@example.com>");
  });
});
