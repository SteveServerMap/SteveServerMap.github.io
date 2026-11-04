@echo off
rem 本地预览：双击本文件，然后浏览器打开 http://localhost:8000/
rem 直接双击 index.html（file://）会被浏览器的本地文件策略拦截，读不到 config.json。
rem 只用系统自带的 python，不下载任何东西（Node 用户也可以自己跑 npx serve / http-server）。
cd /d "%~dp0"

echo.
echo   Steve Server Map - 本地预览
echo   地址: http://localhost:8000/
echo   停止: Ctrl + C
echo.

where python >nul 2>nul
if %errorlevel%==0 goto runpy
where py >nul 2>nul
if %errorlevel%==0 goto runpy_launcher

echo   [x] 没有找到 Python。
echo.
echo   任选一种方式启动一个静态服务器，然后访问 http://localhost:8000/ ：
echo     1. 安装 Python 3 后重新双击本文件（推荐，安装时勾选 Add to PATH）
echo     2. 用 Node：npx serve -l 8000
echo     3. 用 VS Code 的 Live Server 插件
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
