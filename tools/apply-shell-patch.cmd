@echo off
rem ---------------------------------------------------------------------------
rem Task_Tracker B1 - apply the DeepSeek Harness shell patch.
rem
rem This file is deliberately ASCII-ONLY: cmd.exe decodes a batch file with the
rem console codepage (GBK on a Chinese Windows), so UTF-8 Chinese text here is
rem mangled into stray quotes and the script dies while parsing. All Chinese
rem messages come from the Node tool instead, which reads UTF-8 correctly.
rem
rem chcp 65001 makes the console render the tool's UTF-8 output.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
setlocal
set "TOOL=%~dp0shell-patch.mjs"
set "DSH_TT_NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%DSH_TT_NODE%" set "DSH_TT_NODE=node"

"%DSH_TT_NODE%" "%TOOL%" --apply --wait
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [FAILED] nothing was replaced. Read the messages above.
  echo.
  pause
  exit /b %CODE%
)

echo.
echo [DONE] the shell is patched; DeepSeek Harness was restarted if it was found.
echo Press any key to close this window.
pause >nul
endlocal
