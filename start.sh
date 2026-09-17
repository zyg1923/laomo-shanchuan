#!/bin/bash
echo "=========================================="
echo "   闪传 - 系统启动中..."
echo "=========================================="
echo ""

# 1. 安装依赖
pip3 install -r requirements.txt

# 2. 启动程序
python3 lM_share.py
