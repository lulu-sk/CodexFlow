:: SPDX-License-Identifier: Apache-2.0
:: Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

@echo off
REM 构建 CodexFlow 发布包的便捷脚本
setlocal enabledelayedexpansion

REM 切换到仓库根目录
cd /d %~dp0

REM 如需跳过安装依赖，可传入参数 skip-install
set "SKIP_INSTALL=%1"
if /I "%SKIP_INSTALL%"=="skip-install" goto build

echo [CodexFlow] 安装依赖...
call npm install
if errorlevel 1 goto error

:build
echo [CodexFlow] 开始编译...
call npm run build
if errorlevel 1 goto error

echo [CodexFlow] 构建完成，产物位于 dist/ 与 web/dist/ 下。
goto end

:error
echo [CodexFlow] 构建失败，请检查上述日志。
exit /b 1

:end
endlocal
exit /b 0
