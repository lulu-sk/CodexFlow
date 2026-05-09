/**
 * 解析 Git 布尔配置值；无法识别时返回空。
 */
export function parseGitBooleanConfigValue(raw: string): boolean | null {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return null;
  if (["true", "yes", "on", "1"].includes(value)) return true;
  if (["false", "no", "off", "0"].includes(value)) return false;
  return null;
}

/**
 * 判断 git config 的 rebase 值是否表示开启 rebase，兼容现代 Git 的 `merges` / `m`。
 */
export function isRebaseConfigValue(raw: string): boolean {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return false;
  const bool = parseGitBooleanConfigValue(value);
  if (bool === true) return true;
  return value === "interactive" || value === "preserve" || value === "merges" || value === "m";
}
