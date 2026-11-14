@echo off
rem Local preview: double-click this file; it opens the browser for you.
rem Opening index.html directly (file://) is blocked by the browser local-file
rem policy (config.json cannot be read). Uses the system Python only,
rem downloads nothing (Node users may also run: npx serve -l 8000).
rem
rem serve.py picks the first free port in 8000-8010, prints the real URL and
rem opens it. Port probing uses connect(), because Windows lets a second
rem server silently bind a port already in use while connections keep going
rem to the first (old, possibly frozen) process.
setlocal
cd /d "%~dp0"

python "serve.py" %*
set "CODE=%errorlevel%"
if "%CODE%"=="0" goto done
if "%CODE%"=="2" goto done
if "%CODE%"=="3" goto failed

rem Fall back to the py launcher. This also covers the Microsoft Store python
rem stub, which is found by `where` but cannot run a script.
py -3 "serve.py" %*
set "CODE=%errorlevel%"
if "%CODE%"=="0" goto done
if "%CODE%"=="2" goto done
if "%CODE%"=="3" goto failed
goto nopython

:failed
echo   [x] Preview server failed to start (exit code %CODE%).
echo       Run it manually for the full error: python "%~dp0serve.py"
echo.
pause
exit /b %CODE%

:nopython
echo   [x] Python 3 not found.
echo.
echo   Start any static server instead, then visit http://127.0.0.1:8000/ :
echo     1. Install Python 3 and double-click this file again (check "Add to PATH")
echo     2. Use Node: npx serve -l 8000
echo     3. Use the Live Server extension of VS Code
echo.
pause
exit /b 1

:done
rem A deliberate Ctrl + C is a clean stop; only keep the window on errors.
if errorlevel 1 pause
