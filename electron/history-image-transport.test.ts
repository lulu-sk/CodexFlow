import { describe, expect, it } from "vitest";
import { createHistoryImageTransport, isHistoryImageReference } from "./history-image-transport";

type ImageContent = { type: string; text?: string; src?: string; fallbackSrc?: string };

describe("历史图片传输", () => {
  it("只替换内嵌主图和回退图，不修改原始解析缓存", () => {
    const transport = createHistoryImageTransport();
    const text: ImageContent = { type: "output_text", text: "正文" };
    const local: ImageContent = { type: "image", src: "file:///workspace/image.png", fallbackSrc: "data:image/png;base64,AAAA" };
    const inline: ImageContent = { type: "image", src: "data:image/png;base64,BBBB" };
    const original = { messages: [{ role: "assistant", content: [text, local, inline] }] };
    const view = transport.prepareDetails(original);

    expect(view).not.toBe(original);
    expect(view.messages[0].content[0]).toBe(text);
    expect(view.messages[0].content[1].src).toBe(local.src);
    expect(isHistoryImageReference(view.messages[0].content[1].fallbackSrc)).toBe(true);
    expect(transport.resolveSource(view.messages[0].content[1].fallbackSrc)).toBe(local.fallbackSrc);
    expect(transport.resolveSource(view.messages[0].content[2].src)).toBe(inline.src);
    expect(original.messages[0].content[1]).toBe(local);
    expect(local.fallbackSrc).toBe("data:image/png;base64,AAAA");
    expect(transport.prepareDetails(original).messages[0].content[2].src).toBe(view.messages[0].content[2].src);
  });

  it("刷新或原对象更新不会把旧引用错绑到新图片", () => {
    const transport = createHistoryImageTransport();
    const image = { type: "image", src: "data:image/png;base64,AAAA" };
    const original = { messages: [{ content: [image] }] };
    const before = transport.prepareDetails(original).messages[0].content[0].src;
    image.src = "data:image/png;base64,BBBB";
    const after = transport.prepareDetails(original).messages[0].content[0].src;

    expect(after).not.toBe(before);
    expect(transport.resolveSource(before)).not.toBe(image.src);
    expect(transport.resolveSource(after)).toBe(image.src);
  });

  it("有限缓存淘汰后不误返回其它图片，重新打开可恢复引用", () => {
    const transport = createHistoryImageTransport(1);
    const first = { messages: [{ content: [{ type: "image", src: "data:image/png;base64,AAAA" }] }] };
    const second = { messages: [{ content: [{ type: "image", src: "data:image/png;base64,BBBB" }] }] };
    const reference = transport.prepareDetails(first).messages[0].content[0].src;
    transport.prepareDetails(second);

    expect(transport.resolveSource(reference)).toBeUndefined();
    expect(transport.prepareDetails(first).messages[0].content[0].src).toBe(reference);
    expect(transport.resolveSource(reference)).toBe(first.messages[0].content[0].src);
    expect(transport.resolveSource("CODEXFLOW-HISTORY-IMAGE:" + reference!.split(":")[1])).toBe(first.messages[0].content[0].src);
    expect(transport.resolveSource("codexflow-history-image:invalid")).toBeUndefined();
    expect(transport.resolveSource("file:///workspace/image.png")).toBe("file:///workspace/image.png");
  });
});
