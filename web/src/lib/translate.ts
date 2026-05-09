/**
 * 转义字符串中的正则元字符，供插值兜底逻辑安全构造占位符匹配表达式。
 */
function escapeRegExp(text: string): string {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 对未初始化 i18n 或仅返回 defaultValue 的场景做一次兜底插值，避免 `{{count}}` / `{count}` 等占位符残留到界面。
 */
export function interpolateI18nText(text: string, values?: Record<string, unknown>): string {
  let output = String(text || "");
  if (!values) return output;
  for (const [key, value] of Object.entries(values)) {
    const replacement = value === null || value === undefined ? "" : String(value);
    output = output.replace(new RegExp(`\\{\\{\\s*${escapeRegExp(key)}\\s*\\}\\}`, "g"), replacement);
    output = output.replace(new RegExp(`\\{\\s*${escapeRegExp(key)}\\s*\\}`, "g"), replacement);
  }
  return output;
}
