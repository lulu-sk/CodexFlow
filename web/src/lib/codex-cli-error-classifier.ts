export type CodexCliErrorKind =
  | "usageLimit"
  | "modelCapacity"
  | "rateLimited"
  | "concurrency"
  | "networkStream"
  | "badGateway"
  | "serviceUnavailable"
  | "highDemand"
  | "forbidden"
  | "badRequest"
  | "payloadTooLarge"
  | "unknownHttp";

export type CodexCliErrorSeverity = "temporary" | "blocking";
export type CodexCliErrorPhase = "reconnecting" | "final";
export type CodexCliRuntimePhase = "working" | "reconnecting";

export type CodexCliErrorClassification = {
  kind: CodexCliErrorKind;
  severity: CodexCliErrorSeverity;
  retryable: boolean;
  matchedText: string;
  phase: CodexCliErrorPhase;
  reconnectAttempt?: number;
  reconnectMaxAttempts?: number;
};

export type CodexCliRuntimeStatus = {
  phase: CodexCliRuntimePhase;
  reconnectAttempt?: number;
  reconnectMaxAttempts?: number;
};

export const CODEX_CLI_ERROR_KIND_LABELS: Record<CodexCliErrorKind, string> = {
  usageLimit: "You've hit your usage limit",
  modelCapacity: "Selected model is at capacity",
  rateLimited: "429 Too Many Requests",
  concurrency: "Concurrency limit exceeded",
  networkStream: "stream disconnected before completion",
  badGateway: "502 Bad Gateway",
  serviceUnavailable: "503 Service Unavailable",
  highDemand: "We're currently experiencing high demand, which may cause temporary errors.",
  forbidden: "403 Forbidden",
  badRequest: "400 Bad Request",
  payloadTooLarge: "413 Payload Too Large",
  unknownHttp: "unexpected status",
};

type CodexCliErrorRule = {
  kind: CodexCliErrorKind;
  severity: CodexCliErrorSeverity;
  pattern: RegExp;
};

const CODEX_CLI_ERROR_RULES: CodexCliErrorRule[] = [
  {
    kind: "usageLimit",
    severity: "blocking",
    pattern: /(?:you['’]ve hit your usage limit|usage limit(?:ed)?(?:\s+reached)?)/i,
  },
  {
    kind: "modelCapacity",
    severity: "blocking",
    pattern: /selected model is at capacity|model is at capacity/i,
  },
  {
    kind: "badGateway",
    severity: "temporary",
    pattern: /(?:unexpected status\s+502\s+Bad Gateway|502\s+Bad Gateway)/i,
  },
  {
    kind: "highDemand",
    severity: "temporary",
    pattern: /currently experiencing high demand/i,
  },
  {
    kind: "serviceUnavailable",
    severity: "temporary",
    pattern: /(?:unexpected status\s+503\s+Service Unavailable|503\s+Service Unavailable)/i,
  },
  {
    kind: "forbidden",
    severity: "blocking",
    pattern: /(?:unexpected status\s+403\s+Forbidden|status\s+403|403\s+Forbidden)/i,
  },
  {
    kind: "badRequest",
    severity: "blocking",
    pattern: /(?:unexpected status\s+400|400\s+Bad Request|<h1>\s*400\s+Bad Request\s*<\/h1>)/i,
  },
  {
    kind: "payloadTooLarge",
    severity: "blocking",
    pattern: /(?:unexpected status\s+413(?:\s+(?:Payload Too Large|Request Entity Too Large))?|413\s+(?:Payload Too Large|Request Entity Too Large)|<h1>\s*413\s+(?:Payload Too Large|Request Entity Too Large)\s*<\/h1>)/i,
  },
  {
    kind: "concurrency",
    severity: "temporary",
    pattern: /concurrency limit exceeded/i,
  },
  {
    kind: "rateLimited",
    severity: "temporary",
    pattern: /(?:exceeded retry limit[\s\S]{0,240}(?:429|Too Many Requests)|429\s+Too Many Requests|Too Many Requests)/i,
  },
  {
    kind: "networkStream",
    severity: "temporary",
    pattern: /(?:stream disconnected before completion|Transport error|network error|error decoding response body|stream closed before response\.completed)/i,
  },
  {
    kind: "unknownHttp",
    severity: "blocking",
    pattern: /unexpected status\s+\d{3}/i,
  },
];

const ANSI_SEQUENCE_PATTERN =
  /(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\))|(?:\u001b\[[0-?]*[ -/]*[@-~])|(?:\u001b[@-Z\\-_])/g;

const CONTROL_CHARS_EXCEPT_WHITESPACE_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MAX_MATCHED_TEXT_LENGTH = 280;
const RECONNECTING_STATUS_PATTERN = /Reconnecting\.\.\.\s+(\d+)\/(\d+)/gi;
const WORKING_STATUS_PATTERN = /\bWorking\s*\(/gi;
const EXPLICIT_FINAL_ERROR_PATTERN =
  /(?:exceeded retry limit|selected model is at capacity|you['’]ve hit your usage limit|usage limit(?:ed)?(?:\s+reached)?|currently experiencing high demand|400\s+Bad Request|<h1>\s*400\s+Bad Request\s*<\/h1>|unexpected status\s+413\b|413\s+Payload Too Large|413\s+Request Entity Too Large|<h1>\s*413\s+(?:Payload Too Large|Request Entity Too Large)\s*<\/h1>)/i;

/**
 * 去除终端 ANSI/控制序列，并保留足够的换行信息用于错误文本识别。
 */
export function stripAnsiForCodexErrorScan(input: string): string {
  return String(input || "")
    .replace(ANSI_SEQUENCE_PATTERN, "")
    .replace(/\r/g, "\n")
    .replace(CONTROL_CHARS_EXCEPT_WHITESPACE_PATTERN, "");
}

/**
 * 判断指定 Codex CLI 错误类别是否适合自动发送 continue。
 */
export function isCodexCliErrorAutoRetryable(kind: CodexCliErrorKind): boolean {
  return (
    kind === "rateLimited" ||
    kind === "concurrency" ||
    kind === "networkStream" ||
    kind === "badGateway" ||
    kind === "serviceUnavailable" ||
    kind === "highDemand" ||
    kind === "modelCapacity" ||
    kind === "forbidden" ||
    kind === "badRequest" ||
    kind === "payloadTooLarge"
  );
}

/**
 * 判断最终错误是否需要短暂等待后续 Reconnecting 状态再确认。
 */
export function shouldDelayCodexCliFinalErrorForReconnect(classification: CodexCliErrorClassification | null | undefined): boolean {
  if (!classification || classification.phase !== "final") return false;
  return (
    classification.kind === "rateLimited" ||
    classification.kind === "concurrency" ||
    classification.kind === "networkStream" ||
    classification.kind === "badGateway" ||
    classification.kind === "serviceUnavailable" ||
    classification.kind === "forbidden" ||
    classification.kind === "unknownHttp"
  );
}

/**
 * 返回 Codex 错误类别对应的英文识别文本，用于设置面板与状态展示。
 */
export function getCodexCliErrorKindLabel(kind: CodexCliErrorKind | undefined): string {
  if (!kind) return "Unknown Codex error";
  return CODEX_CLI_ERROR_KIND_LABELS[kind] || "Unknown Codex error";
}

/**
 * 将终端文本归一化为轻量扫描文本，避免全量历史或复杂解析带来的额外开销。
 */
function normalizeCodexCliErrorText(input: string): string {
  return stripAnsiForCodexErrorScan(input)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 生成用于界面与去重的错误片段，避免把整段 HTML 或终端输出放入状态。
 */
function clipMatchedText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_MATCHED_TEXT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_MATCHED_TEXT_LENGTH - 1)}…`;
}

type CodexStatusMarker = {
  kind: "reconnecting" | "working";
  index: number;
  attempt?: number;
  maxAttempts?: number;
};

/**
 * 扫描最近的 Codex TUI 状态标记，用于区分“重连中详情”和“最终失败”。
 */
function collectCodexStatusMarkers(text: string): CodexStatusMarker[] {
  const markers: CodexStatusMarker[] = [];
  for (const match of text.matchAll(RECONNECTING_STATUS_PATTERN)) {
    markers.push({
      kind: "reconnecting",
      index: match.index || 0,
      attempt: Number(match[1]),
      maxAttempts: Number(match[2]),
    });
  }
  for (const match of text.matchAll(WORKING_STATUS_PATTERN)) {
    markers.push({
      kind: "working",
      index: match.index || 0,
    });
  }
  markers.sort((left, right) => left.index - right.index);
  return markers;
}

/**
 * 判断匹配文本是否来自 Codex 已经停止重试后的最终错误行。
 */
function isExplicitFinalCodexErrorText(matchedText: string): boolean {
  const text = String(matchedText || "").trim();
  if (!text) return false;
  return EXPLICIT_FINAL_ERROR_PATTERN.test(text);
}

/**
 * 根据错误出现位置前最近的状态标记推断错误阶段。
 */
function resolveCodexCliErrorPhase(text: string, errorIndex: number): {
  phase: CodexCliErrorPhase;
  reconnectAttempt?: number;
  reconnectMaxAttempts?: number;
} {
  const markers = collectCodexStatusMarkers(text);
  let latestBeforeError: CodexStatusMarker | undefined;
  for (const marker of markers) {
    if (marker.index > errorIndex) break;
    latestBeforeError = marker;
  }
  if (latestBeforeError?.kind !== "reconnecting") return { phase: "final" };
  return {
    phase: "reconnecting",
    reconnectAttempt: latestBeforeError.attempt,
    reconnectMaxAttempts: latestBeforeError.maxAttempts,
  };
}

/**
 * 从指定规则中找到最后一次错误匹配，避免滚动缓冲中的旧重连错误盖过后续最终错误。
 */
function findLastRuleMatch(text: string, rule: CodexCliErrorRule): RegExpExecArray | null {
  const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
  const pattern = new RegExp(rule.pattern.source, flags);
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    lastMatch = match;
    if (match[0] === "") pattern.lastIndex += 1;
  }
  return lastMatch;
}

/**
 * 读取终端文本中最后一个 Codex 运行状态标记。
 */
export function detectCodexCliRuntimeStatusText(input: string): CodexCliRuntimeStatus | null {
  const text = normalizeCodexCliErrorText(input);
  if (!text) return null;
  const markers = collectCodexStatusMarkers(text);
  const latest = markers[markers.length - 1];
  if (!latest) return null;
  if (latest.kind === "working") return { phase: "working" };
  return {
    phase: "reconnecting",
    reconnectAttempt: latest.attempt,
    reconnectMaxAttempts: latest.maxAttempts,
  };
}

/**
 * 从 Codex TUI/CLI 终端输出中识别常见错误类型。
 */
export function classifyCodexCliErrorText(input: string): CodexCliErrorClassification | null {
  const text = normalizeCodexCliErrorText(input);
  if (!text) return null;
  let selected: {
    rule: CodexCliErrorRule;
    match: RegExpExecArray;
    ruleIndex: number;
  } | null = null;
  for (let ruleIndex = 0; ruleIndex < CODEX_CLI_ERROR_RULES.length; ruleIndex++) {
    const rule = CODEX_CLI_ERROR_RULES[ruleIndex];
    const match = findLastRuleMatch(text, rule);
    if (!match) continue;
    const matchIndex = match.index || 0;
    const selectedIndex = selected?.match.index || 0;
    if (!selected || matchIndex > selectedIndex || (matchIndex === selectedIndex && ruleIndex < selected.ruleIndex)) {
      selected = { rule, match, ruleIndex };
    }
  }
  if (selected) {
    const { rule, match } = selected;
    const markers = collectCodexStatusMarkers(text);
    const latestMarker = markers[markers.length - 1];
    if (latestMarker?.kind === "working" && latestMarker.index > (match.index || 0)) return null;
    const phase = isExplicitFinalCodexErrorText(match[0])
      ? { phase: "final" as const }
      : resolveCodexCliErrorPhase(text, match.index || 0);
    return {
      kind: rule.kind,
      severity: rule.severity,
      retryable: isCodexCliErrorAutoRetryable(rule.kind),
      matchedText: clipMatchedText(match[0] || text),
      ...phase,
    };
  }
  return null;
}
