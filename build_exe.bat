@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo    正在打包闪传为单个 exe...
echo ==========================================
echo.

python -m pip install pyinstaller pystray pillow flask flask-sqlalchemy -i https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 (
    python -m pip install pyinstaller pystray pillow flask flask-sqlalchemy
)

echo.
echo 开始 PyInstaller 打包，请稍候...
python -m PyInstaller --noconfirm --clean build_exe.spec
if errorlevel 1 (
    echo.
    echo [错误] 打包失败。
    pause
    exit /b 1
)

echo.
echo 完成: "%~dp0dist\闪传.exe"
echo 把这个 exe 发给别人即可，对方不需要安装 Python。
echo 建议和 exe 放在同一个空文件夹里运行，上传文件和数据库会生成在旁边。
pause
