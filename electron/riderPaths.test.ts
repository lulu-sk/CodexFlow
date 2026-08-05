import { describe, expect, it } from "vitest";
import { buildRiderExecutableCandidates, parseRiderRegistryInstallLocations } from "./riderPaths";

describe("riderPaths", () => {
  it("只解析 Rider 注册表项并去掉引号", () => {
    const raw = [
      "HKEY_LOCAL_MACHINE\\Software\\...\\JetBrains Rider 2026.1.3",
      "    InstallLocation    REG_SZ    \"X:\\Apps\\JetBrains\\JetBrains Rider 2026.1.3\"",
      "",
      "HKEY_LOCAL_MACHINE\\Software\\...\\Other Editor",
      "    InstallLocation    REG_SZ    X:\\Apps\\Other Editor",
      "",
      "HKEY_CURRENT_USER\\Software\\...\\JetBrains Toolbox (Rider)",
      "    InstallLocation    REG_SZ    X:\\Apps\\JetBrains Rider (old)",
      "",
      "HKEY_CURRENT_USER\\Software\\...\\JetBrains Rider Preview",
      "    InstallLocation    REG_EXPAND_SZ    %LOCALAPPDATA%\\Programs\\Rider",
    ].join("\r\n");

    expect(parseRiderRegistryInstallLocations(raw)).toEqual([
      "X:\\Apps\\JetBrains\\JetBrains Rider 2026.1.3",
      "X:\\Apps\\JetBrains Rider (old)",
      "%LOCALAPPDATA%\\Programs\\Rider",
    ]);
  });

  it("只生成真实可执行文件候选，不使用 Toolbox 启动脚本", () => {
    const candidates = buildRiderExecutableCandidates({
      platform: "win32",
      pathEntries: ["X:\\Toolbox\\scripts"],
      registryInstallLocations: ["X:\\Apps\\JetBrains\\JetBrains Rider 2026.1.3"],
    });

    expect(candidates).toEqual([
      "X:\\Toolbox\\scripts\\rider64.exe",
      "X:\\Toolbox\\scripts\\rider.exe",
      "X:\\Apps\\JetBrains\\JetBrains Rider 2026.1.3\\bin\\rider64.exe",
      "X:\\Apps\\JetBrains\\JetBrains Rider 2026.1.3\\bin\\rider.exe",
    ]);
    expect(candidates.some((candidate) => /Rider\.cmd$/i.test(candidate))).toBe(false);
  });

  it("规范带引号的 PATH 并展开注册表环境变量", () => {
    const candidates = buildRiderExecutableCandidates({
      platform: "win32",
      pathEntries: ["\"X:\\Tools\\Rider\\bin\""],
      registryInstallLocations: ["%RIDER_HOME%", "Y:\\Portable\\rider64.exe"],
      environment: { RIDER_HOME: "Y:\\Apps\\JetBrains Rider" },
    });

    expect(candidates).toEqual([
      "X:\\Tools\\Rider\\bin\\rider64.exe",
      "X:\\Tools\\Rider\\bin\\rider.exe",
      "Y:\\Apps\\JetBrains Rider\\bin\\rider64.exe",
      "Y:\\Apps\\JetBrains Rider\\bin\\rider.exe",
      "Y:\\Portable\\rider64.exe",
    ]);
  });

  it("注册表已指向 bin 目录时不重复追加 bin", () => {
    expect(buildRiderExecutableCandidates({
      platform: "win32",
      registryInstallLocations: ["X:\\Apps\\JetBrains Rider\\bin"],
    })).toEqual([
      "X:\\Apps\\JetBrains Rider\\bin\\rider64.exe",
      "X:\\Apps\\JetBrains Rider\\bin\\rider.exe",
    ]);
  });

  it("非 Windows 平台不生成 Windows 可执行文件", () => {
    expect(buildRiderExecutableCandidates({ platform: "linux", registryInstallLocations: ["/opt/rider"] })).toEqual([]);
  });
});
