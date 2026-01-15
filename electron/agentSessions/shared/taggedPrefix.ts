export type TaggedPrefixPick = { type: string; text: string; tags?: string[] };

/**
 * 从输入文本的“前缀”提取内嵌标签块（为性能考虑，不做全文搜索）。
 *
 * 目前支持：
 * - `<user_instructions>...</user_instructions>` -> `instructions`
 * - `<permissions instructions>...</permissions instructions>` -> `instructions`
 * - `<environment_context>...</environment_context>` -> `environment_context`
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

