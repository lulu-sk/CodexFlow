import { describe, expect, it } from "vitest";
import {
  classifyCodexCliErrorText,
  detectCodexCliRuntimeStatusText,
  getCodexCliErrorKindLabel,
  isCodexCliErrorAutoRetryable,
  shouldDelayCodexCliFinalErrorForReconnect,
  stripAnsiForCodexErrorScan,
  type CodexCliErrorKind,
} from "./codex-cli-error-classifier";

describe("codex-cli-error-classifier（Codex TUI 错误识别）", () => {
  const cases: Array<{ text: string; kind: CodexCliErrorKind; retryable: boolean }> = [
    {
      text: "exceeded retry limit, last status: 429 Too Many Requests, request id: 9ff93c979e4bee17-SJC",
      kind: "rateLimited",
      retryable: true,
    },
    {
      text: "exceeded retry limit, last status: 429 Too Many Requests",
      kind: "rateLimited",
      retryable: true,
    },
    {
      text: "stream disconnected before completion: Transport error: network error: error decoding response body",
      kind: "networkStream",
      retryable: true,
    },
    {
      text: "unexpected status 502 Bad Gateway: Unknown error, url: http://example.test/v1/responses",
      kind: "badGateway",
      retryable: true,
    },
    {
      text: "Selected model is at capacity. Please try a different model.",
      kind: "modelCapacity",
      retryable: true,
    },
    {
      text: "You've hit your usage limit. Try again later.",
      kind: "usageLimit",
      retryable: false,
    },
    {
      text: "unexpected status 403 Forbidden: openai_error, url: https://example.test/v1/responses, cf-ray: a02de7d0ad6a4833-SJC",
      kind: "forbidden",
      retryable: true,
    },
    {
      text: "unexpected status 403 Forbidden: status 403, url: http://127.0.0.1:15721/v1/responses",
      kind: "forbidden",
      retryable: true,
    },
    {
      text: "<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center></body></html>",
      kind: "badRequest",
      retryable: true,
    },
    {
      text: `unexpected status 413 Payload Too Large: <html>
<head><title>413 Request Entity Too Large</title></head>
<body>
<center><h1>413 Request Entity Too Large</h1></center>
<hr><center>nginx</center>
</body>
</html>, url: https://example.test/v1/responses, cf-ray: a04d1f6`,
      kind: "payloadTooLarge",
      retryable: true,
    },
    {
      text: "unexpected status 413, url: https://example.test/v1/responses",
      kind: "payloadTooLarge",
      retryable: true,
    },
    {
      text: "unexpected status 503 Service Unavailable: openai_error, url: https://example.test/v1/responses, cf-ray: a03f93882b23f591-SJC",
      kind: "serviceUnavailable",
      retryable: true,
    },
    {
      text: "We're currently experiencing high demand, which may cause temporary errors.",
      kind: "highDemand",
      retryable: true,
    },
    {
      text: "stream disconnected before completion: stream closed before response.completed",
      kind: "networkStream",
      retryable: true,
    },
    {
      text: "stream disconnected before completion: Concurrency limit exceeded for user, please retry later",
      kind: "concurrency",
      retryable: true,
    },
  ];

  it("识别用户收集的 Codex CLI 错误样例", () => {
    for (const item of cases) {
      const result = classifyCodexCliErrorText(item.text);
      expect(result?.kind).toBe(item.kind);
      expect(result?.phase).toBe("final");
      expect(result?.retryable).toBe(item.retryable);
      expect(isCodexCliErrorAutoRetryable(item.kind)).toBe(item.retryable);
    }
  });

  it("识别 Reconnecting 阶段的错误详情但不当作最终失败", () => {
    const result = classifyCodexCliErrorText(`
      Reconnecting... 2/5 (5m 35s  esc to interrupt)
        Unexpected status 503 Service Unavailable: upstream_status: HTTP 503
    `);

    expect(result?.kind).toBe("serviceUnavailable");
    expect(result?.phase).toBe("reconnecting");
    expect(result?.reconnectAttempt).toBe(2);
    expect(result?.reconnectMaxAttempts).toBe(5);
  });

  it("Reconnecting 后的 stream disconnected 详情不应被误判为最终失败", () => {
    const result = classifyCodexCliErrorText(`
      Reconnecting... 1/5 (6m 01s  esc to interrupt)
        Stream disconnected before completion: stream closed before response.completed
    `);

    expect(result?.kind).toBe("networkStream");
    expect(result?.phase).toBe("reconnecting");
    expect(result?.reconnectAttempt).toBe(1);
    expect(result?.reconnectMaxAttempts).toBe(5);
  });

  it("最后一次 Reconnecting 后的 stream disconnected 详情仍不应被误判为最终失败", () => {
    const result = classifyCodexCliErrorText(`
      Reconnecting... 5/5 (8m 53s  esc to interrupt)
        Stream disconnected before completion: stream closed before response.completed
    `);

    expect(result?.kind).toBe("networkStream");
    expect(result?.phase).toBe("reconnecting");
    expect(result?.reconnectAttempt).toBe(5);
    expect(result?.reconnectMaxAttempts).toBe(5);
  });

  it("新的 Working 状态会压住旧的 Reconnecting 错误", () => {
    const text = `
      Reconnecting... 1/5 (4m 18s  esc to interrupt)
        Stream disconnected before completion: Upstream request failed
      Working (9m 28s  esc to interrupt)
    `;

    expect(classifyCodexCliErrorText(text)).toBeNull();
    expect(detectCodexCliRuntimeStatusText(text)?.phase).toBe("working");
  });

  it("Working 后出现的新错误仍识别为最终失败", () => {
    const text = `
      Reconnecting... 1/5 (4m 18s  esc to interrupt)
        Stream disconnected before completion: Upstream request failed
      Working (9m 28s  esc to interrupt)
      unexpected status 503 Service Unavailable: openai_error, url: http://example.test/v1/responses
    `;

    const result = classifyCodexCliErrorText(text);
    expect(result?.kind).toBe("serviceUnavailable");
    expect(result?.phase).toBe("final");
  });

  it("同一个 Reconnecting 状态后的多条错误详情仍不应被误判为最终失败", () => {
    const text = `
      Reconnecting... 5/5 (8m 53s  esc to interrupt)
        Unexpected status 503 Service Unavailable: upstream_status: HTTP 503
      unexpected status 503 Service Unavailable: openai_error, url: http://example.test/v1/responses
    `;

    const result = classifyCodexCliErrorText(text);
    expect(result?.kind).toBe("serviceUnavailable");
    expect(result?.phase).toBe("reconnecting");
    expect(result?.reconnectAttempt).toBe(5);
    expect(result?.reconnectMaxAttempts).toBe(5);
  });

  it("exceeded retry limit 即使跟在 Reconnecting 后也应识别为最终失败", () => {
    const text = `
      Reconnecting... 5/5 (8m 53s  esc to interrupt)
        429 Too Many Requests
      exceeded retry limit, last status: 429 Too Many Requests
    `;

    const result = classifyCodexCliErrorText(text);
    expect(result?.kind).toBe("rateLimited");
    expect(result?.phase).toBe("final");
  });

  it("可处理 ANSI 控制序列和终端回车重绘", () => {
    const text = "\u001b[31mWorking...\u001b[0m\r\nunexpected status 502 Bad Gateway";
    expect(stripAnsiForCodexErrorScan(text)).toContain("unexpected status 502 Bad Gateway");
    expect(classifyCodexCliErrorText(text)?.kind).toBe("badGateway");
  });

  it("未知 HTTP 状态保守标记为不可自动重试", () => {
    const result = classifyCodexCliErrorText("unexpected status 418 I'm a teapot");
    expect(result?.kind).toBe("unknownHttp");
    expect(result?.retryable).toBe(false);
  });

  it("可能随后进入 Reconnecting 的最终错误需要延迟确认", () => {
    const result = classifyCodexCliErrorText("unexpected status 503 Service Unavailable: openai_error");
    expect(result?.phase).toBe("final");
    expect(shouldDelayCodexCliFinalErrorForReconnect(result)).toBe(true);
  });

  it("已知直接失败的错误不等待 Reconnecting", () => {
    expect(shouldDelayCodexCliFinalErrorForReconnect(
      classifyCodexCliErrorText("You've hit your usage limit. Try again later."),
    )).toBe(false);
    expect(shouldDelayCodexCliFinalErrorForReconnect(
      classifyCodexCliErrorText("Selected model is at capacity. Please try a different model."),
    )).toBe(false);
    expect(shouldDelayCodexCliFinalErrorForReconnect(
      classifyCodexCliErrorText("<html><body><h1>400 Bad Request</h1></body></html>"),
    )).toBe(false);
    expect(shouldDelayCodexCliFinalErrorForReconnect(
      classifyCodexCliErrorText("<html><body><h1>413 Request Entity Too Large</h1></body></html>"),
    )).toBe(false);
    expect(shouldDelayCodexCliFinalErrorForReconnect(
      classifyCodexCliErrorText("We're currently experiencing high demand, which may cause temporary errors."),
    )).toBe(false);
  });

  it("普通输出不会误判为错误", () => {
    expect(classifyCodexCliErrorText("Agent turn complete: done")).toBeNull();
  });

  it("错误类别展示文本直接使用英文识别文本", () => {
    expect(getCodexCliErrorKindLabel("rateLimited")).toBe("429 Too Many Requests");
    expect(getCodexCliErrorKindLabel("networkStream")).toBe("stream disconnected before completion");
    expect(getCodexCliErrorKindLabel("serviceUnavailable")).toBe("503 Service Unavailable");
    expect(getCodexCliErrorKindLabel("payloadTooLarge")).toBe("413 Payload Too Large");
    expect(getCodexCliErrorKindLabel("highDemand")).toBe("We're currently experiencing high demand, which may cause temporary errors.");
  });
});
