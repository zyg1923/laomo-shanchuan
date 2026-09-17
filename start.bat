@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo    闪传 - 系统启动中...
echo ==========================================
echo.

echo 1. 正在安装依赖...
python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 (
    echo 清华源失败，改用官方源...
    python -m pip install -r requirements.txt
)
if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败。请确认已安装 Python，并已勾选 "Add Python to PATH"。
    pause
    exit /b 1
)

echo.
echo 2. 正在启动服务...
echo.

python lM_share.py

pause
