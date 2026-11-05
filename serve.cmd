@echo off
rem Local preview: double-click this file, then open http://localhost:8000/
rem Opening index.html directly (file://) is blocked by the browser local-file
rem policy (config.json cannot be read). Uses the system python only,
rem downloads nothing (Node users may also run: npx serve -l 8000).
cd /d "%~dp0"

echo.
echo   Steve Server Map - local preview
echo   URL:    http://localhost:8000/
echo   Stop:   Ctrl + C
echo.

where python >nul 2>nul
if %errorlevel%==0 goto runpy
where py >nul 2>nul
if %errorlevel%==0 goto runpy_launcher

echo   [x] Python not found.
echo.
echo   Start any static server instead, then visit http://localhost:8000/ :
echo     1. Install Python 3 and double-click this file again (check "Add to PATH")
echo     2. Use Node: npx serve -l 8000
echo     3. Use the Live Server extension of VS Code
echo.
pause
exit /b 1

:runpy
python -m http.server 8000 --bind 127.0.0.1
goto done

:runpy_launcher
py -3 -m http.server 8000 --bind 127.0.0.1
goto done

:done
pause
