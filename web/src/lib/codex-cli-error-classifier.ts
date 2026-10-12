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
  | "contextWindow"
  | "authentication"
  | "fatal"
  | "unknownHttp";

export type CodexCliErrorSeverity = "temporary" | "blocking";
export type CodexCliErrorPhase = "reconnecting" | "final";
export type CodexCliRuntimePhase = "working" | "reconnecting";

export type CodexCliErrorClassification = {
  kind: CodexCliErrorKind;
  severity: CodexCliErrorSeverity;
  retryable: boolean;
  matchedText: string;
  replayFingerprint?: string;
  phase: CodexCliErrorPhase;
  explicitFinal?: boolean;
  reconnectAttempt?: number;
  reconnectMaxAttempts?: number;
};

export type CodexCliRuntimeStatus = {
  phase: CodexCliRuntimePhase;
  statusText?: string;
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
  contextWindow: "Context window exceeded",
  authentication: "Authentication failed",
  fatal: "Codex internal error",
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
    pattern: /(?:you['’]ve hit your usage limit|usage limit(?:\s+has been)?\s+reached|you['’]re\s+out\s+of\s+credits|your(?:\s+workspace)?\s+is\s+out\s+of\s+credits|you\s+hit\s+your\s+spend\s+cap|spend\s+cap\s+set\s+(?:in|by)\s+(?:your|the\s+owner)|Quota exceeded|To use Codex with your ChatGPT plan, upgrade to Plus|shared rollout token budget exhausted)/i,
  },
  {
    kind: "modelCapacity",
    severity: "blocking",
    pattern: /selected model is at capacity|model is at capacity|Flex capacity unavailable/i,
  },
  {
    kind: "badGateway",
    severity: "temporary",
    pattern: /(?:unexpected status\s+502\s+Bad Gateway|502\s+Bad Gateway)/i,
  },
  {
    kind: "highDemand",
    severity: "temporary",
    pattern: /(?:currently experiencing high (?:demand|load)|server overloaded)/i,
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
    pattern: /(?:exceeded retry limit[\s\S]{0,240}?(?:429(?:\s+Too Many Requests)?|Too Many Requests)|429\s+Too Many Requests|Too Many Requests|rate limit exceeded)/i,
  },
  {
    kind: "networkStream",
    severity: "temporary",
    pattern: /(?:stream disconnected before completion|Transport error|network error|error decoding response body|stream closed before response\.completed|connection failed|Error while reading the server response|request timed out)/i,
  },
  {
    kind: "contextWindow",
    severity: "blocking",
    pattern: /Codex ran out of room in the model['’]s context window/i,
  },
  {
    kind: "authentication",
    severity: "blocking",
    pattern: /(?:Your access token could not be refreshed|Your refresh token has already been used to generate a new access token|Failed to refresh token|sign in with ChatGPT|unexpected status\s+401\b|401\s+Unauthorized)/i,
  },
  {
    kind: "fatal",
    severity: "blocking",
    pattern: /(?:internal error; agent loop died unexpectedly|Fatal error:|turn aborted\. Something went wrong\?)/i,
  },
  {
    kind: "unknownHttp",
    severity: "blocking",
    pattern: /unexpected status\s+\d{3}|exceeded retry limit(?:, last status:\s*\d{3})?/i,
  },
];

const ANSI_SEQUENCE_PATTERN =
  /(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\))|(?:\u001b\[[0-?]*[ -/]*[@-~])|(?:\u001b[@-Z\\-_])/g;

const CONTROL_CHARS_EXCEPT_WHITESPACE_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MAX_MATCHED_TEXT_LENGTH = 280;
const MAX_REPLAY_FINGERPRINT_DETAIL_LENGTH = 160;
const RECONNECTING_STATUS_PATTERN = /^[^\S\n]*(?:[•●◦][^\S\n]*)?Reconnecting\.\.\.[^\S\n]+(\d+)\/(\d+)\b/gimu;
const WORKING_STATUS_PATTERN = /^[^\S\n]*(?:[•●◦][^\S\n]*)?(Working|Compacting context)[^\S\n]*\(/gimu;
const RUNTIME_CURSOR_POSITION_PATTERN = /(?:\u001b\[|\u009b)\d*(?:;\d*)?[HfG]/gu;
const CODEX_COMPOSER_PROMPT_PATTERN = /(?:^|\n)[^\S\n]*›[^\S\n]+Ask Codex to do\b/giu;
const CODEX_FINAL_HISTORY_LINE_PATTERN =
  /^(?:unexpected status\s+\d{3}|exceeded retry limit|stream disconnected before completion|Conversation interrupted|Goal budget reached|you['’]ve hit your usage limit|usage limit(?:\s+has been)?\s+reached|you['’]re\s+out\s+of\s+credits|your(?:\s+workspace)?\s+is\s+out\s+of\s+credits|you\s+hit\s+your\s+spend\s+cap|spend\s+cap\s+set\s+(?:in|by)\s+(?:your|the\s+owner)|selected model is at capacity|model is at capacity|(?:we['’]re\s+|codex\s+is\s+)?currently experiencing high (?:demand|load)|server overloaded|rate limit exceeded|connection failed|Error while reading the server response|Transport error|network error|error decoding response body|stream closed before response\.completed|concurrency limit exceeded|429\s+Too Many Requests|Too Many Requests|502\s+Bad Gateway|503\s+Service Unavailable|400\s+Bad Request|403\s+Forbidden|413\s+(?:Payload Too Large|Request Entity Too Large)|sign in with ChatGPT)\b/i;
const CODEX_SERVER_OVERLOADED_HISTORY_LINE_PATTERN =
  /^(?:selected model is at capacity|model is at capacity|(?:we['’]re\s+|codex\s+is\s+)?currently experiencing high (?:demand|load)|server overloaded)\b/i;
const CODEX_FINAL_HISTORY_MARKER_PATTERN = /^[^\S\n]*([■▪⚠])[\ufe0e\ufe0f]?[^\S\n]*/u;
const CODEX_COMPACT_ERROR_PREFIX_PATTERN = /^Error running remote compact task:[^\S\n]*/i;
const EXPLICIT_FINAL_ERROR_PATTERN =
  /(?:exceeded retry limit|selected model is at capacity|you['’]ve hit your usage limit|usage limit(?:\s+has been)?\s+reached|you['’]re\s+out\s+of\s+credits|your(?:\s+workspace)?\s+is\s+out\s+of\s+credits|you\s+hit\s+your\s+spend\s+cap|spend\s+cap\s+set\s+(?:in|by)\s+(?:your|the\s+owner)|currently experiencing high (?:demand|load)|server overloaded|400\s+Bad Request|<h1>\s*400\s+Bad Request\s*<\/h1>|unexpected status\s+413\b|413\s+Payload Too Large|413\s+Request Entity Too Large|<h1>\s*413\s+(?:Payload Too Large|Request Entity Too Large)\s*<\/h1>)/i;
const SOURCE_LOCATION_LINE_PATTERN = /^(?:(?:[A-Za-z]:)?[./\\\w@ -]+\.(?:ts|tsx|js|jsx|json|cjs|mjs|md|css|scss|html|yml|yaml|txt|cs|shader|uxml|uss):\d+(?::\d+)?:)/i;
const SOURCE_LITERAL_LINE_PATTERN = /\b(?:pattern|text|kind|matchedText|label|expect|toBe|toContain)\s*[:(=]/i;
const CODEX_ADDITIONAL_FINAL_HISTORY_LINE_PATTERN = /^(?:Quota exceeded|To use Codex with your ChatGPT plan, upgrade to Plus|shared rollout token budget exhausted|Flex capacity unavailable|request timed out|Codex ran out of room in the model['’]s context window|Your access token could not be refreshed|Your refresh token has already been used to generate a new access token|Failed to refresh token|401\s+Unauthorized|internal error; agent loop died unexpectedly|Fatal error:|turn aborted\. Something went wrong\?)/i;
const CODEX_TRANSCRIPT_EVENT_LINE_PATTERN = /^[^\S\n]*(?:[›•●◦■▪⚠─]|(?:Working|Compacting context)\s*\(|Reconnecting\.\.\.\s+\d+\/\d+)/iu;
const CODEX_BACKGROUND_TERMINALS_FOOTER_PATTERN = /^[^\S\n]*[1-9]\d* background terminals? running · \/ps to view · \/stop to close[^\S\n]*$/u;
const CODEX_PRIMARY_BLOCKING_ERROR_PATTERN = new RegExp(
  "^(?:[■▪⚠][\\ufe0e\\ufe0f]?\\s*)?(?:Error running remote compact task:\\s*)?(?:"
    + CODEX_CLI_ERROR_RULES.filter((rule) => ["usageLimit", "modelCapacity", "contextWindow", "authentication", "fatal"].includes(rule.kind))
      .map((rule) => rule.pattern.source).join("|") + ")",
  "i",
);

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
  if (classification.explicitFinal) return false;
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
  return joinCodexFinalHistoryContinuationLines(stripAnsiForCodexErrorScan(input))
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

/**
 * 读取指定位置所在的单行文本，用于判断匹配内容是否来自源码、diff 或搜索结果。
 */
function readLineAtIndex(text: string, index: number): string {
  const safeIndex = Math.max(0, Number(index) || 0);
  const lineStart = Math.max(0, text.lastIndexOf("\n", Math.max(0, safeIndex - 1)) + 1);
  const lineEnd = text.indexOf("\n", safeIndex);
  return text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
}

/**
 * 提取稳定的错误详情指纹：保留错误原因，排除 URL、请求标识等每次都会变化的附带信息。
 */
function buildCodexCliErrorReplayFingerprint(text: string, errorIndex: number, matchedText: string): string {
  const normalizedMatch = String(matchedText || "").replace(/\s+/g, " ").trim();
  if (!normalizedMatch) return "";
  const lineText = readLineAtIndex(text, errorIndex);
  const matchOffset = lineText.toLowerCase().indexOf(normalizedMatch.toLowerCase());
  const detail = (matchOffset >= 0 ? lineText.slice(matchOffset + normalizedMatch.length) : "")
    .replace(/^[\s:：,，;；-]+/u, "")
    .replace(/\b(?:url|request(?:[_ -]?id)?|cf-ray|x-request-id)\s*[:=]\s*[^,\s;]+/giu, "")
    .replace(/https?:\/\/\S+/giu, "")
    .replace(/\b[0-9a-f]{12,}\b/giu, "#")
    .replace(/\s+/g, " ")
    .replace(/^[\s,，;；]+|[\s,，;；]+$/gu, "")
    .slice(0, MAX_REPLAY_FINGERPRINT_DETAIL_LENGTH);
  return detail ? normalizedMatch + ": " + detail : normalizedMatch;
}

/**
 * 判断匹配是否更像源码/diff/搜索结果里的错误样例，而不是 Codex CLI 运行时真正吐出的错误。
 */
function isLikelySourceOrDiffErrorExample(text: string, errorIndex: number): boolean {
  const lineText = readLineAtIndex(text, errorIndex);
  if (!lineText) return false;
  if (/^[+-]\s/.test(lineText)) return true;
  if (SOURCE_LOCATION_LINE_PATTERN.test(lineText)) return true;
  return SOURCE_LITERAL_LINE_PATTERN.test(lineText) && /["'`/]/.test(lineText);
}

/**
 * 验证整条 Codex 终态历史行；兼容终端紧排符号和压缩错误包装，普通警告仍不能代表失败。
 */
export function isCodexFinalHistoryLine(line: string): boolean {
  const marker = CODEX_FINAL_HISTORY_MARKER_PATTERN.exec(line);
  if (!marker) return false;
  const content = line.slice(marker[0].length).replace(CODEX_COMPACT_ERROR_PREFIX_PATTERN, "");
  return marker[1] === "⚠"
    ? CODEX_SERVER_OVERLOADED_HISTORY_LINE_PATTERN.test(content)
    : CODEX_FINAL_HISTORY_LINE_PATTERN.test(content) || CODEX_ADDITIONAL_FINAL_HISTORY_LINE_PATTERN.test(content);
}

/** 合并错误历史块的紧邻续行，兼容标题折行，保留独立事件和状态栏边界。 */
export function joinCodexFinalHistoryContinuationLines(text: string): string {
  const lines: string[] = [];
  let historyIndex = -1;
  for (const line of text.split("\n")) {
    if (historyIndex >= 0 && line.trim()
      && !CODEX_TRANSCRIPT_EVENT_LINE_PATTERN.test(line)
      && !CODEX_BACKGROUND_TERMINALS_FOOTER_PATTERN.test(line)) {
      lines[historyIndex] += ` ${line.trim()}`;
      continue;
    }
    lines.push(line);
    historyIndex = CODEX_FINAL_HISTORY_MARKER_PATTERN.test(line) ? lines.length - 1 : -1;
  }
  return lines.join("\n");
}

type CodexStatusMarker = {
  kind: "reconnecting" | "working";
  index: number;
  statusText?: string;
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
      statusText: match[1],
    });
  }
  markers.sort((left, right) => left.index - right.index);
  return markers;
}

/**
 * 判断旧运行标记之后是否已经出现终态错误和输入框的完整结束画面。
 */
function hasCodexFinalHistoryEndedAfterRuntimeStatus(text: string, runtimeStatusIndex: number): boolean {
  let latestFinalHistoryIndex = -1;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const lineEnd = text.indexOf("\n", lineStart);
    const lineText = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    if (isCodexFinalHistoryLine(lineText))
      latestFinalHistoryIndex = lineStart;
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  if (latestFinalHistoryIndex <= runtimeStatusIndex) return false;

  let latestComposerIndex = -1;
  for (const match of text.matchAll(CODEX_COMPOSER_PROMPT_PATTERN))
    latestComposerIndex = match.index || 0;
  return latestComposerIndex > latestFinalHistoryIndex;
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
 * 判断错误匹配是否位于 Codex TUI 最终历史行中，典型形态为红色方块后的错误/中断消息。
 */
function hasCodexFinalHistoryMarkerBeforeMatch(text: string, errorIndex: number): boolean {
  return isCodexFinalHistoryLine(readLineAtIndex(text, errorIndex));
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
  if (latestBeforeError?.kind === "reconnecting") {
    return {
      phase: "reconnecting",
      reconnectAttempt: latestBeforeError.attempt,
      reconnectMaxAttempts: latestBeforeError.maxAttempts,
    };
  }
  const latestMarker = markers[markers.length - 1];
  if (latestMarker?.kind === "reconnecting" && latestMarker.index > errorIndex) {
    // Codex TUI 重绘状态行时，PTY 片段里可能先出现错误详情，再出现 Reconnecting 标题。
    return {
      phase: "reconnecting",
      reconnectAttempt: latestMarker.attempt,
      reconnectMaxAttempts: latestMarker.maxAttempts,
    };
  }
  return { phase: "final" };
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
    const lineStart = Math.max(0, text.lastIndexOf("\n", Math.max(0, match.index - 1)) + 1);
    const lineText = readLineAtIndex(text, match.index);
    const mainHttpError = /^(?:[■▪⚠][\ufe0e\ufe0f]?\s*)?(?:Error running remote compact task:\s*)?unexpected status\s+\d{3}\b[^:,\n]*/i.exec(lineText);
    const mainError = mainHttpError || CODEX_PRIMARY_BLOCKING_ERROR_PATTERN.exec(lineText);
    const matchOffset = text.slice(lineStart, match.index).trimStart().length;
    // 正文里的其他错误不能覆盖主 HTTP 或明确阻断错误；详情仍保留在指纹里。
    if ((!mainError || matchOffset < mainError[0].length)
      && !isLikelySourceOrDiffErrorExample(text, match.index || 0))
      lastMatch = match;
    if (match[0] === "") pattern.lastIndex += 1;
  }
  return lastMatch;
}

/**
 * 读取独立运行状态行；绝对光标定位视为绘制边界，可输入框不参与运行状态判断。
 */
export function detectCodexCliRuntimeStatusText(input: string): CodexCliRuntimeStatus | null {
  const text = normalizeCodexCliErrorText(String(input || "").replace(RUNTIME_CURSOR_POSITION_PATTERN, "\n"));
  if (!text) return null;
  const markers = collectCodexStatusMarkers(text);
  const latest = markers[markers.length - 1];
  if (!latest) return null;
  if (hasCodexFinalHistoryEndedAfterRuntimeStatus(text, latest.index)) return null;
  if (latest.kind === "working") return { phase: "working", statusText: latest.statusText };
  return {
    phase: "reconnecting",
    reconnectAttempt: latest.attempt,
    reconnectMaxAttempts: latest.maxAttempts,
  };
}

/** 只读取输入框附近带计时的活动栏，避免把历史正文里的状态示例当作当前状态。 */
export function detectCodexCliRuntimeStatusOnScreen(input: string): CodexCliRuntimeStatus | null {
  const text = stripAnsiForCodexErrorScan(input);
  const composer = Array.from(text.matchAll(CODEX_COMPOSER_PROMPT_PATTERN)).at(-1);
  if (!composer) return null;
  const area = text.slice(0, composer.index).split("\n").slice(-8).join("\n");
  const markers = collectCodexStatusMarkers(area);
  const latest = markers.at(-1);
  if (!latest || !/\((?:<1s|(?:\d+h\s+)?(?:\d+m\s+)?\d+s)(?:[^\n)]*\)|[^\n)]*…$)/iu.test(readLineAtIndex(area, latest.index)))
    return null;
  const followingLines = area.slice(latest.index).split("\n").slice(1);
  if (followingLines.some((line) => CODEX_TRANSCRIPT_EVENT_LINE_PATTERN.test(line)
    || /^[^\S\n]*(?:Worked for\b|```)/u.test(line))) return null;
  return detectCodexCliRuntimeStatusText(area);
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
    const explicitFinal = isExplicitFinalCodexErrorText(match[0]) || hasCodexFinalHistoryMarkerBeforeMatch(text, match.index || 0);
    const markers = collectCodexStatusMarkers(text);
    const latestMarker = markers[markers.length - 1];
    if (!explicitFinal && latestMarker?.kind === "working" && latestMarker.index > (match.index || 0)) return null;
    const phase = explicitFinal
      ? { phase: "final" as const }
      : resolveCodexCliErrorPhase(text, match.index || 0);
    const matchedText = clipMatchedText(match[0] || text);
    const replayFingerprint = buildCodexCliErrorReplayFingerprint(text, match.index || 0, match[0] || text);
    return {
      kind: rule.kind,
      severity: rule.severity,
      retryable: isCodexCliErrorAutoRetryable(rule.kind),
      matchedText,
      replayFingerprint: replayFingerprint || undefined,
      explicitFinal: explicitFinal || undefined,
      ...phase,
    };
  }
  return null;
}
