@echo off
rem Start the two local services the nightly jobs depend on, if they are not
rem already listening. Used by the "Botella Services at logon" scheduled task
rem so a reboot does not silently end the 16-30 Oct 2026 forward test: on
rem 18 Oct the machine rebooted at 02:34 and neither the Python recommendation
rem service (port 8000) nor the Node server (port 3000) came back, so the 04:15
rem job had nothing to generate cards with.
rem
rem Idempotent: a port already listening is left alone.
setlocal
set ROOT=%~dp0..\..
set PYROOT=%ROOT%\Botella_External_APIs
set BACKEND=%ROOT%\backend

netstat -ano | findstr /r /c:":8010 .*LISTENING" >nul
if errorlevel 1 (
  echo %date% %time% starting python recommendation service on 127.0.0.1:8010 >> "%BACKEND%\logs\services.log"
  start "botella-python" /d "%PYROOT%" /min "%PYROOT%\.venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8010
) else (
  echo %date% %time% python service already listening on 8010 >> "%BACKEND%\logs\services.log"
)

netstat -ano | findstr /r /c:":3010 .*LISTENING" >nul
if errorlevel 1 (
  echo %date% %time% starting node server on 3010 >> "%BACKEND%\logs\services.log"
  start "botella-node" /d "%BACKEND%" /min "C:\Program Files\nodejs\node.exe" server.js
) else (
  echo %date% %time% node server already listening on 3010 >> "%BACKEND%\logs\services.log"
)
rem The React dev server (port 3001, proxying /api to the Node server). The owner
rem screens are served from here on this host; production serves the built
rem bundle from nginx instead.
netstat -ano | findstr /r /c:":3001 .*LISTENING" >nul
if errorlevel 1 (
  echo %date% %time% starting frontend dev server on 3001 >> "%BACKEND%\logs\services.log"
  start "botella-frontend" /d "%ROOT%\frontend" /min cmd /c "npm start"
) else (
  echo %date% %time% frontend already listening on 3001 >> "%BACKEND%\logs\services.log"
)
endlocal
