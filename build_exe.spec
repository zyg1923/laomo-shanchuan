# -*- mode: python ; coding: utf-8 -*-
"""把闪传打成单个可双击运行的 exe。"""
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = [
    ('templates/index.html', 'templates'),
    ('templates/admin.html', 'templates'),
    ('templates/admin_ip.html', 'templates'),
    ('templates/admin_login.html', 'templates'),
    ('static/css', 'static/css'),
    ('static/js/main.js', 'static/js'),
    ('static/js/admin.js', 'static/js'),
    ('static/js/admin_login.js', 'static/js'),
    ('static/vendor', 'static/vendor'),
    ('static/img/logo.png', 'static/img'),
    ('static/img/logo.jpg', 'static/img'),
    ('logo.png', '.'),
    ('logo.ico', '.'),
]

binaries = []
hiddenimports = [
    'lM_share',
    'flask',
    'flask_sqlalchemy',
    'sqlalchemy',
    'sqlalchemy.dialects.sqlite',
    'sqlalchemy.sql.default_comparator',
    'jinja2',
    'werkzeug',
    'werkzeug.serving',
    'click',
    'itsdangerous',
    'markupsafe',
    'blinker',
    'greenlet',
    'pystray',
    'pystray._win32',
    'PIL',
    'PIL.Image',
    'PIL.PngImagePlugin',
    'PIL.JpegImagePlugin',
    'PIL.GifImagePlugin',
    'PIL.WebPImagePlugin',
]
hiddenimports += collect_submodules('flask')
hiddenimports += collect_submodules('flask_sqlalchemy')
hiddenimports += collect_submodules('sqlalchemy')

for pkg in ('flask', 'flask_sqlalchemy', 'sqlalchemy', 'jinja2', 'werkzeug', 'pystray'):
    extra_datas, extra_binaries, extra_hidden = collect_all(pkg)
    datas += extra_datas
    binaries += extra_binaries
    hiddenimports += extra_hidden

a = Analysis(
    ['tray_launcher.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['numpy', 'matplotlib', 'pandas', 'tkinter.test'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='闪传',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['logo.ico'],
)
