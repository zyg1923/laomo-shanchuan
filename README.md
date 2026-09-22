# 闪传 v2.0

仓库地址：https://github.com/zyg1923/shanchuan

```powershell
git clone https://github.com/zyg1923/shanchuan.git
```

局域网传文件的 Flask 服务。开发时用 Python 跑，发给别人时打成单个 exe。克隆后如何打包、缺了哪些文件，见下面的「打包」和「未入库的文件」。

## 环境

- Windows
- Python 3，安装时勾选 Add Python to PATH

## 开发运行

双击 `start.bat`，或：

```powershell
python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
python lM_share.py
```

默认监听端口 `5000`。数据库、上传文件和日志写在程序所在目录的 `instance\`、`uploads\`、`logs\`。

## 打包

双击 `build_exe.bat`。脚本会安装 PyInstaller 和依赖，并执行：

```powershell
python -m PyInstaller --noconfirm --clean build_exe.spec
```

完成后得到 `dist\闪传.exe`。

## 部署

把 `dist\闪传.exe` 单独放到一个空文件夹里运行。对方不需要安装 Python。上传文件和数据库会生成在 exe 旁边。

## 未入库的文件

这些都是依赖、编译结果或运行时数据。源码在 `lM_share.py`、`tray_launcher.py`、`templates\`、`static\` 和 `build_exe.spec`。

| 路径 | 是什么 | 没有它会怎样 | 怎么补 |
| --- | --- | --- | --- |
| `dist\闪传.exe` | PyInstaller 打出的单文件程序 | 没有现成的 exe 可分发 | 运行 `build_exe.bat` |
| `build\`、`build_launcher\` | PyInstaller 中间文件 | 不影响源码 | 打包时自动生成 |
| `packages\` | 本地打好的分发包 | 没有现成压缩包 | 重新打包后再自行拷贝 |
| `*.exe` | 编译结果 | 同上 | 重新打包 |
| `__pycache__\` | Python 字节码 | 无影响 | 运行时自动生成 |
| `instance\`、`uploads\`、`logs\` | 数据库、用户文件、日志 | 新环境是空数据，这是预期 | 要保留历史时单独拷贝，不要提交到 Git |
