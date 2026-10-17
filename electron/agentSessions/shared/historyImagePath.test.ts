import { describe, expect, it } from "vitest";
import { normalizeHistoryImageContent, normalizeHistoryImageLocalPath } from "./historyImagePath";

describe("历史图片路径规整", () => {
  it.each([1, 2, 4, 8])("Windows 路径每段 %i 个反斜杠统一为一个", (count) => {
    const separator = "\\".repeat(count);
    expect(normalizeHistoryImageLocalPath(`C:${separator}workspace${separator}image.png`))
      .toBe("C:\\workspace\\image.png");
  });

  it.each([2, 4, 8])("UNC 前缀 %i 个反斜杠仍保留正确网络路径", (count) => {
    const separator = "\\".repeat(count);
    expect(normalizeHistoryImageLocalPath(`${separator}server${separator}share${separator}image.png`))
      .toBe("\\\\server\\share\\image.png");
  });

  it.each(["C:/workspace/image.png", "/workspace/file\\name.png", "https://example.com/image.png"])(
    "不改写其他路径或网址：%s", (value) => {
      expect(normalizeHistoryImageLocalPath(value)).toBe(value);
    },
  );

  it.each([
    ["file:///C://workspace//image.png", "file:///C:/workspace/image.png"],
    ["file://server//share//image.png", "file://server/share/image.png"],
  ])("旧缓存预览地址去重：%s", (src, expected) => {
    const rawPath = "C:\\\\workspace\\\\image.png";
    const image = normalizeHistoryImageContent({
      type: "image", localPath: rawPath, text: `图片\n路径: ${rawPath}`, src,
      fallbackSrc: "data:image/png;base64,AAAA",
    });
    expect(image.localPath).toBe("C:\\workspace\\image.png");
    expect(image.text).toBe("图片\n路径: C:\\workspace\\image.png");
    expect(image.src).toBe(expected);
    expect(image.fallbackSrc).toBe("data:image/png;base64,AAAA");
  });

  it("已规整的图片保持引用，不触发额外渲染", () => {
    const image = { localPath: "C:\\workspace\\image.png", text: "图片", src: "file:///C:/workspace/image.png" };
    expect(normalizeHistoryImageContent(image)).toBe(image);
  });
});
