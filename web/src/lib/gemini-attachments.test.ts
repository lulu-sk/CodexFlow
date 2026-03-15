import { describe, expect, it } from "vitest";
import {
  buildGeminiImageAttachmentToken,
  escapeGeminiAttachmentPath,
  isGeminiImageChip,
} from "./gemini-attachments";

describe("gemini-attachments", () => {
  it("仅将图片 Chip 识别为 Gemini 图片附件", () => {
    expect(isGeminiImageChip({ type: "image/png" })).toBe(true);
    expect(isGeminiImageChip({ chipKind: "image", type: "text/path" })).toBe(true);
    expect(isGeminiImageChip({ chipKind: "file", type: "text/path" })).toBe(false);
  });

  it("WSL 模式会按 Gemini CLI 规则转义空格与特殊字符", () => {
    expect(escapeGeminiAttachmentPath("/home/example-user/a b(c).png", "wsl")).toBe("/home/example-user/a\\ b\\(c\\).png");
  });

  it("Windows 模式会在需要时用双引号包裹路径", () => {
    expect(buildGeminiImageAttachmentToken("C:\\Users\\Foo Bar\\shot 1.png", "windows")).toBe("@\"C:\\Users\\Foo Bar\\shot 1.png\"");
    expect(buildGeminiImageAttachmentToken("C:\\shot.png", "windows")).toBe("@C:\\shot.png");
  });
});
