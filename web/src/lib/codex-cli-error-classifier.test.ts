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
      text: "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
      kind: "usageLimit",
      retryable: false,
    },
    {
      text: "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
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
      text: "Codex is currently experiencing high load.",
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
    {
      text: "rate limit exceeded: retry later",
      kind: "rateLimited",
      retryable: true,
    },
    {
      text: "Connection failed: error sending request",
      kind: "networkStream",
      retryable: true,
    },
    {
      text: "Error while reading the server response: HTTP status client error (429 Too Many Requests)",
      kind: "rateLimited",
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

  it("最后一次 Reconnecting 后进入历史区的 stream disconnected 应识别为最终失败", () => {
    const text = `
      Reconnecting... 5/5 (5h 16m 19s  esc to interrupt)
        Stream disconnected before completion: Incomplete response returned, reason: upstream_error
      › 继续
      ■ stream disconnected before completion: Incomplete response returned, reason: upstream_error
      › Ask Codex to do anything
    `;

    const result = classifyCodexCliErrorText(text);
    expect(result?.kind).toBe("networkStream");
    expect(result?.phase).toBe("final");
    expect(result?.explicitFinal).toBe(true);
    expect(shouldDelayCodexCliFinalErrorForReconnect(result)).toBe(false);
    expect(detectCodexCliRuntimeStatusText(text)).toBeNull();
  });

  it("输入框不表示空闲，和 Working 同屏时仍识别为运行中", () => {
    const text = `
      Working (9m 39s  esc to interrupt)
      › Ask Codex to do anything
    `;

    expect(detectCodexCliRuntimeStatusText(text)?.phase).toBe("working");
  });

  it("服务过载警告完成后会覆盖旧的 Working 状态", () => {
    const text = [
      "Working (9m 39s  esc to interrupt)",
      "⚠ Codex is currently experiencing high load.",
      "› Ask Codex to do anything",
    ].join("\n");

    expect(detectCodexCliRuntimeStatusText(text)).toBeNull();
  });

  it("普通警告中的网络错误文字不会覆盖旧的 Working 状态", () => {
    const text = [
      "Working (9m 39s  esc to interrupt)",
      "⚠ network error was recovered; continuing work",
      "› Ask Codex to do anything",
    ].join("\n");

    expect(detectCodexCliRuntimeStatusText(text)?.phase).toBe("working");
  });

  it.each([
    ["⚠Selected model is at capacity. Please try a different model.", "modelCapacity"],
    ["⚠\ufe0fError running remote compact task: Selected model is at capacity. Please try a different model.", "modelCapacity"],
    ["■Error running remote compact task: unexpected status 503 Service Unavailable", "serviceUnavailable"],
    ["▪ Error running remote compact task: stream disconnected before completion", "networkStream"],
  ])("终态标记兼容紧贴文字、变体选择符和压缩错误包装：%s", (errorLine, kind) => {
    const text = [
      "Reconnecting... 1/5 (1m 03s  esc to interrupt)",
      errorLine,
      "  1 background terminal running · /ps to view · /stop to close",
      "› Ask Codex to do anything",
    ].join("\n");
    expect(classifyCodexCliErrorText(text)).toMatchObject({ kind, phase: "final", explicitFinal: true });
    expect(detectCodexCliRuntimeStatusText(text)).toBeNull();
  });

  it("单独输入框不是 Codex 运行状态", () => {
    expect(detectCodexCliRuntimeStatusText("› Ask Codex to do anything")).toBeNull();
  });

  it("额度重置提示不是额度错误", () => {
    const informationalMessages = [
      "You have 1 usage limit reset available. Run /usage to use one.",
      "You don't have any usage limit resets available.",
      "No usage limit resets are available.",
      "Usage reset. You have 0 usage limit resets left.",
    ];

    for (const message of informationalMessages)
      expect(classifyCodexCliErrorText(message)).toBeNull();
  });

  it("明确的额度耗尽文案仍识别为额度错误", () => {
    for (const message of [
      "You've hit your usage limit. Try again later.",
      "Usage limit reached. Try again later.",
      "Usage limit has been reached. Try again later.",
    ])
      expect(classifyCodexCliErrorText(message)?.kind).toBe("usageLimit");
  });

  it("Codex 最终错误的外层包装仍会继承历史错误终态", () => {
    const cases = [
      ["■ Error while reading the server response: HTTP status server error (503 Service Unavailable)", "serviceUnavailable"],
      ["■ rate limit exceeded: retry later", "rateLimited"],
      ["■ Connection failed: error sending request", "networkStream"],
      ["■ Codex is currently experiencing high load.", "highDemand"],
    ] as const;

    for (const [text, kind] of cases) {
      const result = classifyCodexCliErrorText(text);
      expect(result?.kind).toBe(kind);
      expect(result?.phase).toBe("final");
      expect(result?.explicitFinal).toBe(true);
    }
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

  it("新的 Working 状态会压住旧的 Concurrency 错误", () => {
    const text = `
      stream disconnected before completion: Concurrency limit exceeded for user, please retry later
      Working (13m 06s  esc to interrupt)
    `;

    expect(classifyCodexCliErrorText(text)).toBeNull();
    expect(detectCodexCliRuntimeStatusText(text)?.phase).toBe("working");
  });

  it("源码 diff 中的 Concurrency 样例不会被误判为运行时错误", () => {
    const text = `
      diff --git a/web/src/lib/codex-cli-error-classifier.test.ts b/web/src/lib/codex-cli-error-classifier.test.ts
      +      text: "stream disconnected before completion: Concurrency limit exceeded for user, please retry later",
      +      pattern: /concurrency limit exceeded/i,
      Working (13m 06s  esc to interrupt)
    `;

    expect(classifyCodexCliErrorText(text)).toBeNull();
    expect(detectCodexCliRuntimeStatusText(text)?.phase).toBe("working");
  });

  it("搜索结果中的 Concurrency 样例不会被误判为运行时错误", () => {
    const text = `
      web/src/lib/codex-cli-error-classifier.ts:83:    pattern: /concurrency limit exceeded/i,
      web/src/lib/codex-cli-error-classifier.test.ts:76:      text: "stream disconnected before completion: Concurrency limit exceeded for user, please retry later",
    `;

    expect(classifyCodexCliErrorText(text)).toBeNull();
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

  it("Codex 最终历史错误行会压住分类阶段，但不会自行伪造空闲状态", () => {
    const text = `
      Reconnecting... 1/5 (4m 09s  esc to interrupt)
      ■ unexpected status 503 Service Unavailable: upstream_status: HTTP 503
    `;

    const result = classifyCodexCliErrorText(text);
    expect(result?.kind).toBe("serviceUnavailable");
    expect(result?.phase).toBe("final");
    expect(result?.explicitFinal).toBe(true);
    expect(shouldDelayCodexCliFinalErrorForReconnect(result)).toBe(false);
    expect(detectCodexCliRuntimeStatusText(text)?.phase).toBe("reconnecting");
  });

  it("最终历史行中的内层错误匹配仍会继承整行的最终状态", () => {
    const text = [
      "Reconnecting... 5/5 (8m 53s  esc to interrupt)",
      "■ stream disconnected before completion: Concurrency limit exceeded for user",
    ].join("\n");

    const result = classifyCodexCliErrorText(text);
    expect(result?.kind).toBe("concurrency");
    expect(result?.phase).toBe("final");
    expect(result?.explicitFinal).toBe(true);
    expect(shouldDelayCodexCliFinalErrorForReconnect(result)).toBe(false);
  });

  it("单独重绘最终错误历史行时不能把它当成当前空闲提示", () => {
    const text = "■ exceeded retry limit, last status: 429 Too Many Requests";

    expect(classifyCodexCliErrorText(text)?.explicitFinal).toBe(true);
    expect(detectCodexCliRuntimeStatusText(text)).toBeNull();
  });

  it("明确最终错误后出现 Working 时保留错误供回放守卫裁决", () => {
    const text = `
      ■ exceeded retry limit, last status: 429 Too Many Requests
      Working (3m 01s  esc to interrupt)
      › Ask Codex to do anything
    `;

    const result = classifyCodexCliErrorText(text);
    expect(result?.kind).toBe("rateLimited");
    expect(result?.phase).toBe("final");
    expect(result?.explicitFinal).toBe(true);
    expect(detectCodexCliRuntimeStatusText(text)?.phase).toBe("working");
  });

  it("同屏出现两次 429 时错误匹配不能吞入中间的助手输出", () => {
    const errorText = "exceeded retry limit, last status: 429 Too Many Requests";
    const single = classifyCodexCliErrorText(`■ ${errorText}`);
    const repeated = classifyCodexCliErrorText([
      `■ ${errorText}`,
      "› continue",
      "• Inspecting tools",
      `■ ${errorText}`,
      "› Ask Codex to do anything",
    ].join("\n"));

    expect(repeated?.matchedText).toBe(single?.matchedText);
    expect(repeated?.replayFingerprint).toBe(single?.replayFingerprint);
  });

  it("普通方块项目符号不会被误判为 Codex 最终历史行", () => {
    const text = `
      Reconnecting... 1/5 (4m 09s  esc to interrupt)
      ■ checklist item
    `;

    const result = classifyCodexCliErrorText(text);
    const status = detectCodexCliRuntimeStatusText(text);
    expect(result).toBeNull();
    expect(status?.phase).toBe("reconnecting");
    expect(status?.reconnectAttempt).toBe(1);
    expect(status?.reconnectMaxAttempts).toBe(5);
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

  it("同一块重绘输出中错误详情先于 Reconnecting 标题时仍识别为重连", () => {
    const text = `
      Unexpected status 502 Bad Gateway: upstream_status: HTTP 502
      Reconnecting... 2/5 (6m 48s  esc to interrupt)
    `;

    const result = classifyCodexCliErrorText(text);
    expect(result?.kind).toBe("badGateway");
    expect(result?.phase).toBe("reconnecting");
    expect(result?.reconnectAttempt).toBe(2);
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
