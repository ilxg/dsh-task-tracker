@echo off
rem ---------------------------------------------------------------------------
rem Task_Tracker B1 - revert the DeepSeek Harness shell patch.
rem ASCII-only on purpose; see apply-shell-patch.cmd for why.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
setlocal
set "TOOL=%~dp0shell-patch.mjs"
set "DSH_TT_NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%DSH_TT_NODE%" set "DSH_TT_NODE=node"

"%DSH_TT_NODE%" "%TOOL%" --revert --wait
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [FAILED] nothing was changed. Read the messages above.
  echo.
  pause
  exit /b %CODE%
)

echo.
echo [DONE] the original archive is back.
echo Press any key to close this window.
pause >nul
endlocal
