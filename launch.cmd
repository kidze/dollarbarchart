@echo off
rem BTC dollar-bar chart, Windows launcher.
rem Starts the local server (first run downloads ~6 years of 1-minute candles from Bybit, about 20 minutes; after
rem that it only catches up), waits until it answers, then opens the page as its own window in Edge or Chrome.
rem The server quits by itself two minutes after the window is closed. Logs: logs\server.log next to this file.
rem Set DOLLARBARS_PY to point at a specific Python (e.g. set "DOLLARBARS_PY=C:\Python314\pythonw.exe").
setlocal
cd /d "%~dp0"

set "PY="
if defined DOLLARBARS_PY set "PY=%DOLLARBARS_PY%"
if not defined PY (where pyw >nul 2>&1 && set "PY=pyw -3")
if not defined PY (where pythonw >nul 2>&1 && set "PY=pythonw")
if not defined PY set "PY=python"

set "URL=http://127.0.0.1:8793/"
powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing %URL%ping -TimeoutSec 2|Out-Null;exit 0}catch{exit 1}"
if not errorlevel 1 goto open

start "dollar-bar chart server" /min %PY% "%~dp0server.py"
powershell -NoProfile -Command "for($i=0;$i -lt 90;$i++){try{Invoke-WebRequest -UseBasicParsing %URL%ping -TimeoutSec 2|Out-Null;exit 0}catch{Start-Sleep 1}};exit 1"
if errorlevel 1 (
  echo The server did not answer on port 8793 within 90 s. See logs\server.log in this folder.
  echo If it says a module is missing:  %PY% -m pip install -r requirements.txt
  pause
  exit /b 1
)

:open
set "BROWSER="
for %%b in (msedge chrome) do (
  if not defined BROWSER (
    reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%%b.exe" /ve >nul 2>&1 && set "BROWSER=%%b"
  )
)
if defined BROWSER (
  start "" %BROWSER% --app=%URL% --window-size=1500,860
) else (
  start "" %URL%
)
