@echo off
rem Local preview: double-click this file, then open the URL it prints.
rem Opening index.html directly (file://) is blocked by the browser local-file
rem policy (config.json cannot be read). Uses the system Python only,
rem downloads nothing (Node users may also run: npx serve -l 8000).
setlocal
cd /d "%~dp0"

set "PORT=8000"
set "LASTPORT=8010"

rem Windows lets a second server bind the same port without any error, but
rem every connection keeps going to the first (old, possibly frozen) process.
rem Pick the next free port so a forgotten preview window cannot block us.
:portcheck
netstat -ano | findstr /c:":%PORT% " | findstr /c:"LISTENING" >nul
if errorlevel 1 goto welcome
set /a PORT+=1
if %PORT% gtr %LASTPORT% goto noport
goto portcheck

:welcome
echo.
echo   Steve Server Map - local preview
echo   URL:    http://127.0.0.1:%PORT%/
echo   Stop:   Ctrl + C
echo.
if not "%PORT%"=="8000" echo   [i] Port 8000 is already taken, using %PORT% instead.
echo   Ready when Python prints "Serving HTTP on" below.
echo.

rem The Microsoft Store "python" stub is found by where but cannot run a
rem server, so probe the real module instead of trusting the executable name.
python -c "import http.server" >nul 2>nul
if not errorlevel 1 goto runpython
py -3 -c "import http.server" >nul 2>nul
if not errorlevel 1 goto runpy
goto nopython

:runpython
python -m http.server %PORT% --bind 127.0.0.1
goto done

:runpy
py -3 -m http.server %PORT% --bind 127.0.0.1
goto done

:nopython
echo   [x] Python 3 not found.
echo.
echo   Start any static server instead, then visit http://127.0.0.1:%PORT%/ :
echo     1. Install Python 3 and double-click this file again (check "Add to PATH")
echo     2. Use Node: npx serve -l %PORT%
echo     3. Use the Live Server extension of VS Code
echo.
pause
exit /b 1

:noport
echo   [x] Ports 8000-%LASTPORT% are all in use.
echo       Close the other preview windows (Ctrl + C) and double-click again.
echo.
pause
exit /b 1

:done
rem A deliberate Ctrl + C is a clean stop; only keep the window on errors.
if errorlevel 1 pause
