export type TaggedPrefixPick = { type: string; text: string; tags?: string[] };

/**
 * 为多行值补齐缩进，避免 JSON 字符串中的换行继续以 `\n` 形式展示。
 */
function indentSubagentNotificationText(value: string, indentLevel: number): string {
  const pad = "  ".repeat(Math.max(0, indentLevel));
  return String(value || "").replace(/\r\n/g, "\n").split("\n").map((line) => `${pad}${line}`).join("\n");
}

/**
 * 将 subagent 通知的 JSON payload 格式化为可读文本。
 */
function formatSubagentNotificationValue(value: unknown, indentLevel = 0): string {
  const pad = "  ".repeat(Math.max(0, indentLevel));
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value.map((item) => {
      if (item && typeof item === "object") return `${pad}-\n${formatSubagentNotificationValue(item, indentLevel + 1)}`;
      return `${pad}- ${String(item ?? "").replace(/\r\n/g, "\n")}`;
    }).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${pad}{}`;
    return entries.map(([key, item]) => {
      if (item && typeof item === "object") return `${pad}${key}:\n${formatSubagentNotificationValue(item, indentLevel + 1)}`;
      const text = String(item ?? "").replace(/\r\n/g, "\n");
      if (text.includes("\n")) return `${pad}${key}:\n${indentSubagentNotificationText(text, indentLevel + 1)}`;
      return `${pad}${key}: ${text}`;
    }).join("\n");
  }
  return `${pad}${String(value ?? "").replace(/\r\n/g, "\n")}`;
}

/**
 * 解析 subagent 通知文本；JSON 解析失败时仅还原换行转义，保留原始内容。
 */
function formatSubagentNotificationText(raw: string): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    return formatSubagentNotificationValue(JSON.parse(text)).trim();
  } catch {
    return text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").trim();
  }
}

/**
 * 从输入文本的“前缀”提取内嵌标签块（为性能考虑，不做全文搜索）。
 *
 * 目前支持：
 * - `<user_instructions>...</user_instructions>` -> `instructions`
 * - `<permissions instructions>...</permissions instructions>` -> `instructions`
 * - `<environment_context>...</environment_context>` -> `environment_context`
 * - `<subagent_notification>...</subagent_notification>` -> `subagent_notification`
 * - `# AGENTS.md instructions for ...`（含可选 `<instructions>...</instructions>`）-> `instructions`
 */
export function extractTaggedPrefix(source: string): { rest: string; picked: TaggedPrefixPick[] } {
  const src = String(source || "");
  const picked: TaggedPrefixPick[] = [];
  const leading = (src.match(/^\s*/) || [""])[0].length;
  const s2 = src.slice(leading);
  const lower = s2.toLowerCase();

  const openU = "<user_instructions>";
  const closeU = "</user_instructions>";
  const openP = "<permissions instructions>";
  const closeP = "</permissions instructions>";
  const openE = "<environment_context>";
  const closeE = "</environment_context>";
  const openS = "<subagent_notification>";
  const closeS = "</subagent_notification>";

  // 匹配 subagent_notification 前缀，转成可读通知块，避免 JSON 字符串换行以 \n 展示
  if (lower.startsWith(openS)) {
    const endTag = lower.indexOf(closeS);
    if (endTag >= 0) {
      const inner = s2.slice(openS.length, endTag);
      picked.push({ type: "subagent_notification", text: formatSubagentNotificationText(inner), tags: ["subagent_notification"] });
      const rest = s2.slice(endTag + closeS.length);
      return { rest: rest.trim(), picked };
    }
    const inner = s2.slice(openS.length);
    picked.push({ type: "subagent_notification", text: formatSubagentNotificationText(inner), tags: ["subagent_notification"] });
    return { rest: "", picked };
  }

  // 优先匹配 user_instructions 前缀
  if (lower.startsWith(openU)) {
    const endTag = lower.indexOf(closeU);
    if (endTag >= 0) {
      const inner = s2.slice(openU.length, endTag);
      picked.push({ type: "instructions", text: inner });
      const rest = s2.slice(endTag + closeU.length);
      return { rest: rest.trim(), picked };
    }
    const inner = s2.slice(openU.length);
    picked.push({ type: "instructions", text: inner });
    return { rest: "", picked };
  }

  // 匹配 permissions instructions 前缀（用于沙盒/审批策略等运行权限说明）
  if (lower.startsWith(openP)) {
    const endTag = lower.indexOf(closeP);
    if (endTag >= 0) {
      const inner = s2.slice(openP.length, endTag);
      picked.push({ type: "instructions", text: inner });
      const rest = s2.slice(endTag + closeP.length);
      return { rest: rest.trim(), picked };
    }
    const inner = s2.slice(openP.length);
    picked.push({ type: "instructions", text: inner });
    return { rest: "", picked };
  }

  // 匹配 environment_context 前缀
  if (lower.startsWith(openE)) {
    const endTag = lower.indexOf(closeE);
    if (endTag >= 0) {
      const inner = s2.slice(openE.length, endTag);
      picked.push({ type: "environment_context", text: inner });
      const rest = s2.slice(endTag + closeE.length);
      return { rest: rest.trim(), picked };
    }
    const inner = s2.slice(openE.length);
    picked.push({ type: "environment_context", text: inner });
    return { rest: "", picked };
  }

  const agentsPrefix = "# agents.md instructions for";
  if (lower.startsWith(agentsPrefix)) {
    const openTag = "<instructions>";
    const closeTag = "</instructions>";
    const openIdx = lower.indexOf(openTag);
    if (openIdx >= 0) {
      const closeIdx = lower.indexOf(closeTag, openIdx + openTag.length);
      if (closeIdx >= 0) {
        const inner = s2.slice(openIdx + openTag.length, closeIdx);
        picked.push({ type: "instructions", text: inner });
        const rest = s2.slice(closeIdx + closeTag.length);
        return { rest: rest.trim(), picked };
      }
    }
    const afterHeader = s2.split(/\r?\n/).slice(1).join("\n").trim();
    if (afterHeader) {
      picked.push({ type: "instructions", text: afterHeader });
      return { rest: "", picked };
    }
    picked.push({ type: "instructions", text: s2 });
    return { rest: "", picked };
  }

  return { rest: src, picked };
}

