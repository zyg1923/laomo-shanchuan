# -*- coding: utf-8 -*-
"""闪传启动器：读取 config.json，关窗口进托盘，支持重启/退出。"""
import ctypes
import json
import os
import socket
import subprocess
import sys
import threading
import webbrowser
from shutil import which

import tkinter as tk
from tkinter import messagebox

CREATE_NO_WINDOW = 0x08000000
MUTEX_NAME = 'Global\\ShanChuanLauncherMutex'
SHOW_FLAG = '.shanchuan_show'
ERROR_ALREADY_EXISTS = 183
CONFIG_DEFAULTS = {
    'port': 5000,
    'host': '0.0.0.0',
    'auto_open_browser': False,
    'start_in_tray': False,
}


def app_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def config_path():
    return os.path.join(app_dir(), 'config.json')


def resource_path(name):
    base = getattr(sys, '_MEIPASS', app_dir())
    candidate = os.path.join(base, name)
    if os.path.exists(candidate):
        return candidate
    return os.path.join(app_dir(), name)


def load_config():
    cfg = dict(CONFIG_DEFAULTS)
    path = config_path()
    try:
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                cfg.update(data)
        cfg['port'] = int(cfg.get('port', 5000))
        cfg['host'] = str(cfg.get('host', '0.0.0.0'))
        cfg['auto_open_browser'] = bool(cfg.get('auto_open_browser', False))
        cfg['start_in_tray'] = bool(cfg.get('start_in_tray', False))
    except Exception:
        pass
    return cfg


def save_config(cfg):
    data = load_config()
    data.update(cfg)
    data['port'] = int(data['port'])
    data['host'] = str(data['host'])
    data['auto_open_browser'] = bool(data.get('auto_open_browser', False))
    data['start_in_tray'] = bool(data.get('start_in_tray', False))
    with open(config_path(), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return data


def port_in_use(port):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.4)
    try:
        sock.connect(('127.0.0.1', int(port)))
        return True
    except Exception:
        return False
    finally:
        sock.close()


def pids_listening_on_port(port):
    pids = set()
    try:
        out = subprocess.check_output(
            ['netstat', '-ano', '-p', 'tcp'],
            creationflags=CREATE_NO_WINDOW,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding='oem',
            errors='ignore',
        )
    except Exception:
        return []
    needle = f':{int(port)}'
    for line in out.splitlines():
        if 'LISTENING' not in line:
            continue
        if needle not in line:
            continue
        parts = line.split()
        if not parts:
            continue
        pid = parts[-1]
        if pid.isdigit() and int(pid) not in (0, os.getpid()):
            pids.add(int(pid))
    return list(pids)


def pids_running_lm_share():
    pids = set()
    if getattr(sys, 'frozen', False):
        return []
    try:
        out = subprocess.check_output(
            ['wmic', 'process', 'where',
             "CommandLine like '%lM_share.py%'",
             'get', 'ProcessId,CommandLine'],
            creationflags=CREATE_NO_WINDOW,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding='oem',
            errors='ignore',
        )
    except Exception:
        return []
    for line in out.splitlines():
        if 'lM_share.py' not in line:
            continue
        parts = line.strip().split()
        if parts and parts[-1].isdigit():
            pid = int(parts[-1])
            if pid != os.getpid():
                pids.add(pid)
    return list(pids)


def kill_pid_tree(pid):
    subprocess.run(
        ['taskkill', '/F', '/T', '/PID', str(pid)],
        creationflags=CREATE_NO_WINDOW,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def acquire_mutex():
    handle = ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if ctypes.GetLastError() == ERROR_ALREADY_EXISTS:
        return None
    return handle


def request_existing_instance_show():
    path = os.path.join(app_dir(), SHOW_FLAG)
    try:
        with open(path, 'w', encoding='utf-8') as f:
            f.write('show')
    except Exception:
        pass


class ShanChuanApp:
    def __init__(self):
        self.proc = None
        self.attached = False
        self.exiting = False
        self.restarting = False
        self.tray = None
        self.cfg = load_config()
        self.port = self.cfg['port']
        self.root = tk.Tk()
        self.root.title('闪传')
        self.root.resizable(False, False)
        self.root.protocol('WM_DELETE_WINDOW', self.hide_to_tray)

        logo_file = resource_path('logo.png')
        if not os.path.exists(logo_file):
            logo_file = os.path.join(app_dir(), 'static', 'img', 'logo.png')
        self.logo_file = logo_file
        try:
            self.logo = tk.PhotoImage(file=logo_file)
            if self.logo.width() > 128:
                factor = max(1, self.logo.width() // 128)
                self.logo = self.logo.subsample(factor, factor)
            self.root.iconphoto(True, self.logo)
            tk.Label(self.root, image=self.logo).pack(pady=(12, 4))
        except Exception:
            self.logo = None
            tk.Label(self.root, text='闪传', font=('Microsoft YaHei', 20, 'bold')).pack(pady=(12, 4))

        tk.Label(self.root, text='闪传', font=('Microsoft YaHei', 12)).pack()
        tk.Label(self.root, text='配置来自 config.json，可改后点重启生效',
                 font=('Microsoft YaHei', 8), fg='#888').pack()

        form = tk.Frame(self.root)
        form.pack(pady=8, padx=16, fill=tk.X)

        tk.Label(form, text='端口', width=10, anchor='e').grid(row=0, column=0, pady=3)
        self.port_var = tk.StringVar(value=str(self.cfg['port']))
        tk.Entry(form, textvariable=self.port_var, width=18).grid(row=0, column=1, pady=3)

        tk.Label(form, text='监听地址', width=10, anchor='e').grid(row=1, column=0, pady=3)
        self.host_var = tk.StringVar(value=str(self.cfg['host']))
        tk.Entry(form, textvariable=self.host_var, width=18).grid(row=1, column=1, pady=3)

        self.auto_open_var = tk.BooleanVar(value=bool(self.cfg['auto_open_browser']))
        tk.Checkbutton(form, text='启动后自动打开网页', variable=self.auto_open_var).grid(
            row=2, column=0, columnspan=2, sticky='w', pady=2)

        self.start_tray_var = tk.BooleanVar(value=bool(self.cfg['start_in_tray']))
        tk.Checkbutton(form, text='启动后最小化到托盘', variable=self.start_tray_var).grid(
            row=3, column=0, columnspan=2, sticky='w', pady=2)

        self.status = tk.Label(self.root, text='正在启动服务...', fg='#555')
        self.status.pack(pady=4)

        btns = tk.Frame(self.root)
        btns.pack(pady=(4, 14))
        tk.Button(btns, text='打开网页', width=10, command=self.open_web).pack(side=tk.LEFT, padx=4)
        tk.Button(btns, text='重启', width=10, command=self.restart_server).pack(side=tk.LEFT, padx=4)
        tk.Button(btns, text='退出', width=10, command=self.quit_and_stop).pack(side=tk.LEFT, padx=4)

        self.root.geometry('320x420')
        self.ensure_server()
        self.start_tray()
        if self.cfg.get('auto_open_browser'):
            self.root.after(1200, self.open_web)
        if self.cfg.get('start_in_tray'):
            self.root.after(300, self.hide_to_tray)
        self.root.after(400, self.watch_server)
        self.root.after(500, self.poll_show_flag)

    def fill_ui_from_config(self):
        self.port_var.set(str(self.cfg['port']))
        self.host_var.set(str(self.cfg['host']))
        self.auto_open_var.set(bool(self.cfg.get('auto_open_browser', False)))
        self.start_tray_var.set(bool(self.cfg.get('start_in_tray', False)))

    def save_ui_to_config(self):
        try:
            port = int(str(self.port_var.get()).strip())
        except ValueError:
            messagebox.showerror('闪传', '端口必须是数字')
            return None
        if port < 1 or port > 65535:
            messagebox.showerror('闪传', '端口范围 1-65535')
            return None
        host = str(self.host_var.get()).strip() or '0.0.0.0'
        self.cfg = save_config({
            'port': port,
            'host': host,
            'auto_open_browser': bool(self.auto_open_var.get()),
            'start_in_tray': bool(self.start_tray_var.get()),
        })
        self.port = self.cfg['port']
        return self.cfg

    def find_python(self):
        if not getattr(sys, 'frozen', False):
            return sys.executable
        for name in ('pythonw', 'python'):
            path = which(name)
            if path:
                return path
        return 'python'

    def server_command(self):
        if getattr(sys, 'frozen', False):
            return [sys.executable, '--server', '--port', str(self.port)]
        script = os.path.join(app_dir(), 'lM_share.py')
        if not os.path.exists(script):
            return None
        return [self.find_python(), script, '--port', str(self.port)]

    def ensure_server(self):
        cmd = self.server_command()
        if not cmd:
            messagebox.showerror('闪传', f'找不到主程序：{os.path.join(app_dir(), "lM_share.py")}')
            self.root.destroy()
            return
        if port_in_use(self.port):
            self.attached = True
            self.status.config(text=f'已接管现有服务  http://127.0.0.1:{self.port}', fg='#1a7f37')
            return
        self.proc = subprocess.Popen(
            cmd,
            cwd=app_dir(),
            creationflags=CREATE_NO_WINDOW if os.name == 'nt' else 0,
        )
        self.attached = False

    def start_tray(self):
        try:
            import pystray
            from PIL import Image
            image = Image.open(self.logo_file)
            menu = pystray.Menu(
                pystray.MenuItem('打开面板', self.show_window, default=True),
                pystray.MenuItem('打开网页', lambda: self.open_web()),
                pystray.MenuItem('重启', lambda: self.root.after(0, self.restart_server)),
                pystray.MenuItem('退出', lambda: self.root.after(0, self.quit_and_stop)),
            )
            self.tray = pystray.Icon('闪传', image, '闪传', menu)
            threading.Thread(target=self.tray.run, daemon=True).start()
        except Exception:
            self.tray = None

    def hide_to_tray(self):
        self.root.withdraw()
        if self.tray:
            try:
                self.tray.notify('闪传仍在后台运行，右键托盘可重启或退出', '闪传')
            except Exception:
                pass

    def show_window(self, *_args):
        self.root.after(0, self._show_window_ui)

    def _show_window_ui(self):
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    def poll_show_flag(self):
        if self.exiting:
            return
        path = os.path.join(app_dir(), SHOW_FLAG)
        if os.path.exists(path):
            try:
                os.remove(path)
            except Exception:
                pass
            self._show_window_ui()
        self.root.after(500, self.poll_show_flag)

    def watch_server(self):
        if self.exiting:
            return
        alive = port_in_use(self.port)
        if self.restarting:
            pass
        elif self.proc and self.proc.poll() is not None and not alive:
            self.status.config(text='服务已停止', fg='#c0392b')
        elif alive:
            extra = '（已接管）' if self.attached and not self.proc else ''
            self.status.config(text=f'本机 http://127.0.0.1:{self.port}{extra}', fg='#1a7f37')
        else:
            self.status.config(text='服务未在运行', fg='#c0392b')
        self.root.after(1500, self.watch_server)

    def open_web(self, *_args):
        webbrowser.open(f'http://127.0.0.1:{self.port}')

    def stop_server(self):
        pids = set(pids_listening_on_port(self.port))
        pids.update(pids_running_lm_share())
        if self.proc and self.proc.poll() is None:
            pids.add(self.proc.pid)
        for pid in pids:
            kill_pid_tree(pid)
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.kill()
            except Exception:
                pass
        self.proc = None

    def restart_server(self):
        if self.exiting or self.restarting:
            return
        old_port = self.port
        if self.save_ui_to_config() is None:
            return
        self.restarting = True
        try:
            self.status.config(text='正在重启服务...')
            self.root.update_idletasks()
        except Exception:
            pass
        self.port = old_port
        self.stop_server()
        self.port = self.cfg['port']
        self.attached = False
        self.root.after(400, self._restart_wait, 0, old_port)

    def _restart_wait(self, n, old_port):
        busy = port_in_use(old_port) or (self.port != old_port and port_in_use(self.port))
        if busy and n < 25:
            self.root.after(300, self._restart_wait, n + 1, old_port)
            return
        self.ensure_server()
        self.restarting = False
        if self.cfg.get('auto_open_browser'):
            self.root.after(800, self.open_web)

    def quit_and_stop(self):
        if self.exiting:
            return
        self.exiting = True
        try:
            self.status.config(text='正在停止服务...')
            self.root.update_idletasks()
        except Exception:
            pass
        self.stop_server()
        if self.tray:
            try:
                self.tray.stop()
            except Exception:
                pass
        self.root.destroy()

    def run(self):
        self.root.mainloop()


if __name__ == '__main__':
    if '--server' in sys.argv:
        sys.argv = [sys.argv[0]] + [a for a in sys.argv[1:] if a != '--server']
        from lM_share import main
        main()
        sys.exit(0)
    mutex = acquire_mutex()
    if mutex is None:
        request_existing_instance_show()
        sys.exit(0)
    ShanChuanApp().run()
