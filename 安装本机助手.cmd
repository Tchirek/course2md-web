@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-helper.ps1" %*
if errorlevel 1 (
  echo Installation failed. See the message above.
  pause
  exit /b 1
)
echo Ready. You can close this window and check the connection in course2md.
pause
