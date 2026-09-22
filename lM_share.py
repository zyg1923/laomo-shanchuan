from flask import Flask, request, render_template, send_from_directory, jsonify, session, redirect, url_for, after_this_request, send_file, Response
from urllib.parse import quote, unquote
import flask
from flask_sqlalchemy import SQLAlchemy
import os
import sys
import uuid
import secrets
from datetime import datetime, timedelta
import threading
import time
import json
from werkzeug.utils import secure_filename
import ipaddress
from functools import wraps
import logging
from logging.handlers import TimedRotatingFileHandler
import traceback
import hashlib
import argparse
import re
import zipfile
import tempfile
import socket
import shutil
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from sqlalchemy import text, inspect as sa_inspect, or_, and_, exists

# ==========================================
# 运行目录：开发时是脚本所在目录，打包后是 exe 所在目录
# 模板/静态资源在打包后从解压目录读取，数据库和上传文件写在 exe 旁边
# ==========================================

def _app_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _resource_dir():
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        return sys._MEIPASS
    return _app_dir()


APP_DIR = _app_dir()
RESOURCE_DIR = _resource_dir()
try:
    os.chdir(APP_DIR)
except OSError:
    pass

# ==========================================
# 配置日志系统
# ==========================================

# 创建日志目录
LOG_DIR = os.path.join(APP_DIR, 'logs')
if not os.path.exists(LOG_DIR):
    os.makedirs(LOG_DIR)
    print(f"[系统日志] 创建日志目录: {LOG_DIR}")

# 配置主日志记录器
logger = logging.getLogger('lM_share')
logger.setLevel(logging.INFO)  # 设置日志级别为INFO，可记录INFO及以上级别的日志

# 创建按天轮转的文件处理器
# 每天午夜创建新日志文件，最多保留7天的日志
log_file = os.path.join(LOG_DIR, 'app.log')
file_handler = TimedRotatingFileHandler(
    log_file, 
    when='midnight',  # 每天午夜轮转
    interval=1,  # 每天轮转一次
    backupCount=7,  # 保留7天的日志
    encoding='utf-8'
)
file_handler.suffix = '%Y-%m-%d'  # 日志文件名后缀，例如 app_2025-12-22.log

# 设置日志格式
# 🔧 修复：移除了不存在的 [%(ip)s] 占位符
log_format = '[%(asctime)s] [%(levelname)s] [%(module)s] %(message)s'
date_format = '%Y-%m-%d %H:%M:%S'
formatter = logging.Formatter(log_format, datefmt=date_format)
file_handler.setFormatter(formatter)

# 添加处理器到日志记录器
logger.addHandler(file_handler)

# 同时输出到控制台（方便开发调试）
console_handler = logging.StreamHandler()
console_handler.setFormatter(formatter)
console_handler.setLevel(logging.INFO)
logger.addHandler(console_handler)

# 记录系统启动
logger.info("=" * 80)
logger.info("闪传系统启动中...")
# 🔧 修复：使用 flask.__version__ 而不是 Flask.__version__
logger.info(f"Flask版本: {flask.__version__}")
logger.info(f"工作目录: {os.getcwd()}")
logger.info(f"日志目录: {os.path.abspath(LOG_DIR)}")
logger.info("=" * 80)


# ==========================================
# Flask应用初始化
# ==========================================

_instance_dir = os.path.join(APP_DIR, 'instance')
os.makedirs(_instance_dir, exist_ok=True)
_db_path = os.path.join(_instance_dir, 'files.db').replace('\\', '/')

app = Flask(
    __name__,
    template_folder=os.path.join(RESOURCE_DIR, 'templates'),
    static_folder=os.path.join(RESOURCE_DIR, 'static'),
    instance_path=_instance_dir,
)
app.config['UPLOAD_FOLDER'] = os.path.join(APP_DIR, 'uploads')
# 移除Flask的MAX_CONTENT_LENGTH限制，让后端代码自己处理
# app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 注释掉这行
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///' + _db_path
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SECRET_KEY'] = secrets.token_hex(32)
app.config['SESSION_PERMANENT'] = False
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

logger.info("Flask应用初始化完成")

db = SQLAlchemy(app)


def _safe_user_static_dir(*parts):
    return os.path.join(APP_DIR, 'static', *parts)


@app.route('/static/img/<path:filename>')
def serve_user_img(filename):
    """用户上传的 LOGO 写在 exe 旁，打包后的默认图片仍从内置资源读取。"""
    user_dir = _safe_user_static_dir('img')
    bundled = os.path.join(RESOURCE_DIR, 'static', 'img')
    if os.path.isfile(os.path.join(user_dir, filename)):
        return send_from_directory(user_dir, filename)
    return send_from_directory(bundled, filename)


@app.route('/static/note_img/<path:filename>')
def serve_note_img(filename):
    user_dir = _safe_user_static_dir('note_img')
    os.makedirs(user_dir, exist_ok=True)
    return send_from_directory(user_dir, filename)

logger.info("数据库连接初始化完成")


# ==========================================
# 数据库模型定义
# SQLite 不持久化 COMMENT, 表/字段含义以本模型 comment 为准,
# 启动时同步到 schema_doc, 可用 SELECT * FROM schema_doc 查看.
# ==========================================

class File(db.Model):
    """文件表: 当前可分享的上传文件(物理删除后行即消失)。"""
    __tablename__ = 'file'
    __table_args__ = {'comment': '文件表: 当前可分享的上传文件, 删除文件时物理删行'}

    id = db.Column(db.Integer, primary_key=True, autoincrement=True, comment='主键, 文件记录ID')
    original_filename = db.Column(db.String(512), nullable=False, comment='用户看到的原始文件名(含扩展名, 文件夹会打成zip)')
    filename_on_disk = db.Column(db.String(255), nullable=False, comment='uploads目录中的实际存储文件名')
    share_uid = db.Column(db.String(32), unique=True, index=True, comment='稳定分享ID, 刷新提取码后不变, 关联收发记录')
    extract_code = db.Column(db.String(6), unique=True, nullable=False, comment='提取码, 6位字母数字, 不区分大小写')
    delete_code = db.Column(db.String(16), unique=True, nullable=False, comment='删除码, 4位字母数字, 不区分大小写')
    upload_time = db.Column(db.DateTime, nullable=False, default=datetime.now, comment='上传时间')
    expires_at = db.Column(db.DateTime, nullable=False, comment='到期时间, 超时后文件删除')
    max_downloads = db.Column(db.Integer, nullable=False, default=3, comment='允许的最大下载次数')
    current_downloads = db.Column(db.Integer, nullable=False, default=0, comment='已下载次数')
    uploader_client_id = db.Column(db.String(64), index=True, comment='上传者浏览器设备ID, 用于我的上传')
    uploaded_by_admin = db.Column(db.Boolean, default=False, comment='是否管理员上传(管理员下载不占次数)')

    def __repr__(self):
        return f'<File {self.original_filename} ({self.extract_code})>'


class ShareTransfer(db.Model):
    """收发记录表: 全员可见的上传/下载流水, 支持逻辑删除。"""
    __tablename__ = 'share_transfer'
    __table_args__ = {'comment': '收发记录表: 上传/下载流水, deleted_at非空表示逻辑删除'}

    id = db.Column(db.Integer, primary_key=True, autoincrement=True, comment='主键, 记录ID')
    share_uid = db.Column(db.String(32), nullable=False, index=True, comment='对应file.share_uid, 提取码刷新后不变')
    event_type = db.Column(db.String(20), nullable=False, index=True, comment='事件类型: upload上传 / download下载')
    operator_ip = db.Column(db.String(45), nullable=False, comment='操作人主IP')
    operator_ips = db.Column(db.String(255), comment='本次请求见到的全部IP(代理链), 逗号分隔')
    operator_client_id = db.Column(db.String(64), index=True, comment='操作人浏览器设备ID, 用于我的上传/下载')
    filename = db.Column(db.String(512), nullable=False, comment='当时的文件名')
    extract_code = db.Column(db.String(6), nullable=False, comment='当时的提取码, 刷新后本表会同步')
    delete_code = db.Column(db.String(16), comment='当时的删除码, 刷新后本表会同步')
    created_at = db.Column(db.DateTime, default=datetime.now, index=True, comment='操作时间')
    deleted_at = db.Column(db.DateTime, index=True, comment='逻辑删除时间, 空表示有效, 清空记录时写入')

    def __repr__(self):
        return f'<ShareTransfer {self.event_type} {self.share_uid}>'


class SiteConfig(db.Model):
    """站点配置表: 键值对保存站长设置。"""
    __tablename__ = 'site_config'
    __table_args__ = {'comment': '站点配置表: key/value, 具体key含义见schema_doc中site_config.key:*'}

    id = db.Column(db.Integer, primary_key=True, autoincrement=True, comment='主键, 配置项ID')
    key = db.Column(db.String(100), unique=True, nullable=False, comment='配置键, 如site_title、max_upload_size')
    value = db.Column(db.Text, nullable=False, comment='配置值, 均为文本, 数字/布尔需自行转换')
    updated_at = db.Column(db.DateTime, default=datetime.now, onupdate=datetime.now, comment='最后修改时间')

    def __repr__(self):
        return f'<SiteConfig {self.key}={self.value}>'


class IPAccessControl(db.Model):
    """IP访问控制表: 白名单/黑名单规则。"""
    __tablename__ = 'ip_access_control'
    __table_args__ = (
        db.UniqueConstraint('ip_range', 'access_type', name='_ip_range_access_type_uc'),
        {'comment': 'IP访问控制表: 白名单whitelist / 黑名单blacklist'},
    )

    id = db.Column(db.Integer, primary_key=True, autoincrement=True, comment='主键, 规则ID')
    ip_address = db.Column(db.String(45), nullable=False, comment='录入的IP或网段原文, 支持IPv4/IPv6')
    ip_range = db.Column(db.String(45), nullable=False, comment='规范化CIDR, 如192.168.1.0/24')
    access_type = db.Column(db.String(10), nullable=False, comment='规则类型: whitelist允许 / blacklist拒绝')
    description = db.Column(db.String(255), comment='规则说明, 便于识别')
    created_at = db.Column(db.DateTime, default=datetime.now, comment='创建时间')
    is_active = db.Column(db.Boolean, default=True, comment='是否启用, 0停用 1启用')

    def __repr__(self):
        return f'<IPAccessControl {self.ip_range} ({self.access_type})>'


class AccessLog(db.Model):
    """访问日志表: 上传/下载/删除等操作流水。"""
    __tablename__ = 'access_log'
    __table_args__ = {'comment': '访问日志表: 上传下载删除等操作结果'}

    id = db.Column(db.Integer, primary_key=True, autoincrement=True, comment='主键, 日志ID')
    client_ip = db.Column(db.String(45), nullable=False, index=True, comment='客户端IP')
    action_type = db.Column(db.String(20), nullable=False, index=True, comment='操作类型: upload/download/delete/admin_login等')
    file_id = db.Column(db.Integer, db.ForeignKey('file.id'), comment='关联file.id, 文件已删时可能为空')
    extract_code = db.Column(db.String(6), comment='当时使用的提取码')
    filename = db.Column(db.String(255), comment='当时的文件名')
    status = db.Column(db.String(20), nullable=False, comment='结果: success成功 / failed失败')
    error_message = db.Column(db.Text, comment='失败时的错误信息')
    created_at = db.Column(db.DateTime, default=datetime.now, index=True, comment='操作时间')
    user_agent = db.Column(db.String(255), comment='浏览器User-Agent')
    file_size = db.Column(db.Integer, comment='文件大小, 单位字节')

    def __repr__(self):
        return f'<AccessLog {self.client_ip} {self.action_type} at {self.created_at}>'


class SystemLog(db.Model):
    """系统日志表: 后台与异常。"""
    __tablename__ = 'system_log'
    __table_args__ = {'comment': '系统日志表: 后台任务、清理、异常'}

    id = db.Column(db.Integer, primary_key=True, autoincrement=True, comment='主键, 日志ID')
    log_level = db.Column(db.String(20), nullable=False, index=True, comment='级别: INFO / WARNING / ERROR')
    log_module = db.Column(db.String(50), nullable=False, index=True, comment='模块名, 如admin_cleanup、auto_cleanup')
    log_message = db.Column(db.Text, nullable=False, comment='日志正文')
    extra_data = db.Column(db.Text, comment='附加JSON, 如IP、数量')
    created_at = db.Column(db.DateTime, default=datetime.now, index=True, comment='记录时间')

    def __repr__(self):
        return f'<SystemLog {self.log_level} {self.log_module}>'


class MessageNote(db.Model):
    """留言表: 留言与回复, 支持逻辑删除。"""
    __tablename__ = 'message_note'
    __table_args__ = {'comment': '留言表: parent_id为空是主贴, 非空是回复; deleted_at非空为逻辑删除'}

    id = db.Column(db.Integer, primary_key=True, autoincrement=True, comment='主键, 留言ID')
    parent_id = db.Column(db.Integer, db.ForeignKey('message_note.id'), nullable=True, index=True, comment='父留言ID, 空表示主贴')
    content = db.Column(db.Text, nullable=False, comment='富文本HTML内容')
    client_ip = db.Column(db.String(45), nullable=False, index=True, comment='发布者IP')
    client_id = db.Column(db.String(64), index=True, comment='发布者浏览器设备ID, 用于我的留言/编辑权限')
    request_info = db.Column(db.Text, nullable=False, comment='当次请求信息JSON, 仅管理员可见')
    created_at = db.Column(db.DateTime, default=datetime.now, index=True, comment='发布时间')
    updated_at = db.Column(db.DateTime, comment='最后编辑时间, 未编辑为空')
    deleted_at = db.Column(db.DateTime, index=True, comment='逻辑删除时间, 空表示有效')

    parent = db.relationship(
        'MessageNote',
        remote_side='MessageNote.id',
        foreign_keys='MessageNote.parent_id',
        back_populates='replies'
    )
    replies = db.relationship(
        'MessageNote',
        foreign_keys='MessageNote.parent_id',
        back_populates='parent',
        cascade='all, delete-orphan'
    )

    def __repr__(self):
        return f'<MessageNote {self.id} ip={self.client_ip}>'


class SharedDir(db.Model):
    """共享目录表: 可共享的本机/网络目录, 带所有者与权限。"""
    __tablename__ = 'shared_dir'
    __table_args__ = {'comment': '共享目录表: 本机或网络路径, 按目录配置权限, 归属创建者IP'}

    id = db.Column(db.Integer, primary_key=True, autoincrement=True, comment='主键')
    name = db.Column(db.String(255), nullable=False, comment='显示名称')
    root_path = db.Column(db.String(1024), nullable=False, unique=True, comment='本机绝对路径或UNC网络路径')
    owner_ip = db.Column(db.String(45), nullable=False, default='', index=True, comment='创建者主IP, 仅本人或管理员可管理')
    owner_client_id = db.Column(db.String(64), index=True, comment='创建者设备ID')
    created_at = db.Column(db.DateTime, default=datetime.now, comment='添加时间')
    is_active = db.Column(db.Boolean, default=True, comment='是否启用')
    perm_browse = db.Column(db.Boolean, default=True, comment='他人是否可读/浏览目录')
    perm_download = db.Column(db.Boolean, default=True, comment='他人是否可下载文件')
    perm_zip = db.Column(db.Boolean, default=True, comment='他人是否可打包下载(多文件/文件夹)')
    perm_upload = db.Column(db.Boolean, default=False, comment='他人是否可上传到该目录')
    perm_mkdir = db.Column(db.Boolean, default=False, comment='他人是否可新建文件夹')
    perm_delete = db.Column(db.Boolean, default=False, comment='他人是否可删除文件/文件夹')
    perm_rename = db.Column(db.Boolean, default=False, comment='他人是否可重命名')
    perm_show_hidden = db.Column(db.Boolean, default=False, comment='他人是否可见隐藏文件')

    def __repr__(self):
        return f'<SharedDir {self.id} {self.name}>'


class SchemaDoc(db.Model):
    """数据字典表: 同步各表及字段中文含义, 便于在SQLite中直接查阅。"""
    __tablename__ = 'schema_doc'
    __table_args__ = (
        db.UniqueConstraint('table_name', 'column_name', name='uq_schema_doc_table_column'),
        {'comment': '数据字典: column_name为空表示表注释, 否则为字段注释'},
    )

    id = db.Column(db.Integer, primary_key=True, autoincrement=True, comment='主键')
    table_name = db.Column(db.String(64), nullable=False, index=True, comment='表名')
    column_name = db.Column(db.String(64), nullable=False, default='', comment='字段名, 空字符串表示该行是表注释')
    data_type = db.Column(db.String(64), comment='字段类型, 表注释行为空')
    nullable = db.Column(db.String(8), comment='是否可空: YES/NO, 表注释行为空')
    comment_text = db.Column(db.Text, nullable=False, comment='中文含义')

    def __repr__(self):
        return f'<SchemaDoc {self.table_name}.{self.column_name}>'


SITE_CONFIG_KEY_COMMENTS = {
    'site_title': '网站标题',
    'site_subtitle': '网站副标题, 显示在标题下方',
    'logo_url': '网站LOGO路径, 如/static/img/logo.png',
    'max_upload_size': '最大上传大小, 单位MB',
    'allowed_extensions': '允许的扩展名, 英文逗号分隔, 空表示不限制',
    'max_downloads': '用户可设置的最大下载次数上限',
    'max_expire_hours': '用户上传时可设置的最大分享时限, 换算后存为小时',
    'expire_warn_hours': '合并分享时, 剩余时间不足该小时数则提醒即将过期',
    'footer_text': '页面底部提示文字',
    'header_text': '页面顶部提示文字',
    'admin_username': '站长登录账号',
    'admin_password': '站长密码SHA-256十六进制',
    'upload_folder': '上传文件存储目录, 相对项目根目录',
    'listen_port': '服务监听端口, 改后需重启',
    'ip_access_enabled': '是否启用IP访问控制: true/false',
    'default_access_policy': '默认访问策略: allow黑名单模式 / deny白名单模式',
    'log_ip_access': '是否记录IP访问日志: true/false',
    'shared_peers': '共享目录节点列表JSON, [{host,port,label}]',
}


def sync_schema_doc():
    """把模型里的表/字段comment写入schema_doc, 覆盖旧内容。"""
    rows = []
    for mapper in db.Model.registry.mappers:
        cls = mapper.class_
        table = cls.__table__
        table_comment = (table.comment or (cls.__doc__ or '').strip().split('\n')[0]).strip()
        rows.append({
            'table_name': table.name,
            'column_name': '',
            'data_type': '',
            'nullable': '',
            'comment_text': table_comment or table.name,
        })
        for col in table.columns:
            rows.append({
                'table_name': table.name,
                'column_name': col.name,
                'data_type': str(col.type),
                'nullable': 'NO' if not col.nullable else 'YES',
                'comment_text': (col.comment or '').strip() or col.name,
            })
    for key, meaning in SITE_CONFIG_KEY_COMMENTS.items():
        rows.append({
            'table_name': 'site_config',
            'column_name': 'key:' + key,
            'data_type': 'TEXT',
            'nullable': 'YES',
            'comment_text': meaning,
        })
    SchemaDoc.query.delete()
    for item in rows:
        db.session.add(SchemaDoc(**item))
    db.session.commit()
    logger.info(f"数据字典已同步, 共 {len(rows)} 条")


logger.info("数据库模型定义完成")

# ==========================================
# 默认配置
# ==========================================

DEFAULT_CONFIGS = {
    'site_title': '闪传',
    'site_subtitle': '',
    'logo_url': '/static/img/logo.png',
    'max_upload_size': '50',  # MB
    'allowed_extensions': '',
    'max_downloads': '10',
    'max_expire_hours': '72',
    'expire_warn_hours': '1',
    'footer_text': '发送违法、违规等有害信息, 会受到司法严惩。',
    'header_text': '',
    'admin_username': 'admin',
    'admin_password': hashlib.sha256(b'admin').hexdigest(),
    'upload_folder': 'uploads',
    'listen_port': '5000',
    'ip_access_enabled': 'false',  # 是否启用IP访问控制
    'default_access_policy': 'allow',  # 默认策略：allow 或 deny
    'log_ip_access': 'true',  # 是否记录IP访问日志
    'shared_peers': '[]',
}

logger.info(f"默认配置加载完成，共 {len(DEFAULT_CONFIGS)} 项配置")


RUNTIME_CONFIG_PATH = os.path.join(APP_DIR, 'config.json')


def load_runtime_config():
    """读取程序目录下的 config.json（端口等启动参数）。"""
    defaults = {
        'port': 5000,
        'host': '0.0.0.0',
        'auto_open_browser': False,
        'start_in_tray': False,
    }
    try:
        if os.path.exists(RUNTIME_CONFIG_PATH):
            with open(RUNTIME_CONFIG_PATH, 'r', encoding='utf-8') as f:
                data = json.load(f)
            defaults.update(data)
            defaults['port'] = int(defaults.get('port', 5000))
            defaults['host'] = str(defaults.get('host', '0.0.0.0'))
    except Exception as e:
        logger.warning(f"读取 config.json 失败，使用默认端口: {e}")
    return defaults


def save_runtime_config(port=None, host=None):
    """把端口写回 config.json，保留其它字段。"""
    data = {}
    if os.path.exists(RUNTIME_CONFIG_PATH):
        try:
            with open(RUNTIME_CONFIG_PATH, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception:
            data = {}
    data.update(load_runtime_config())
    if port is not None:
        data['port'] = int(port)
    if host is not None:
        data['host'] = host
    with open(RUNTIME_CONFIG_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info(f"已更新 config.json: {data}")


# ==========================================
# 工具函数
# ==========================================

def get_config(key, default=None):
    """
    从数据库获取配置值
    
    Args:
        key: 配置键
        default: 默认值（如果配置不存在）
    
    Returns:
        配置值或默认值
    """
    config = SiteConfig.query.filter_by(key=key).first()
    if config:
        return config.value
    elif key in DEFAULT_CONFIGS:
        return DEFAULT_CONFIGS[key]
    return default


def set_config(key, value):
    """
    设置配置值到数据库
    
    Args:
        key: 配置键
        value: 配置值
    """
    if key == 'admin_password':
        value = store_password_hash(value)
    config = SiteConfig.query.filter_by(key=key).first()
    if config:
        old_value = config.value
        config.value = value
        config.updated_at = datetime.now()
        logger.info(f"配置更新: {key} = {old_value} → {value}")
    else:
        config = SiteConfig(key=key, value=value)
        db.session.add(config)
        logger.info(f"配置创建: {key} = {value}")
    db.session.commit()


def strip_im_brand(text):
    if not text:
        return text or ''
    value = str(text)
    for token in ("IM'Share", "IM’Share", "IM Share", "IM'Share", "IM'MO", "IM’MO", "IMMO", "IM' MO"):
        value = value.replace(token, '')
    value = value.replace("IM'", '').replace('IM’', '')
    return value.strip(' -–—|')


def is_admin():
    return bool(session.get('admin_logged_in'))


def hash_password(raw):
    return hashlib.sha256((raw or '').encode('utf-8')).hexdigest()


def is_sha256_hex(value):
    text = (value or '').strip().lower()
    return len(text) == 64 and all(c in '0123456789abcdef' for c in text)


def store_password_hash(value):
    if is_sha256_hex(value):
        return (value or '').strip().lower()
    return hash_password(value)


def check_admin_credentials(username, password):
    stored_user = (get_config('admin_username', 'admin') or 'admin').strip()
    stored_pw = get_config('admin_password', '') or ''
    return (username or '').strip() == stored_user and store_password_hash(password) == store_password_hash(stored_pw)


def send_named_file(directory, disk_name, download_name):
    response = send_from_directory(directory, disk_name, as_attachment=True, download_name=download_name)
    quoted = quote(download_name or 'download', safe='')
    ascii_name = 'download'
    if download_name and '.' in download_name:
        ascii_name = 'download.' + download_name.rsplit('.', 1)[-1]
    try:
        (download_name or '').encode('ascii')
        ascii_name = (download_name or 'download').replace('"', '')
    except UnicodeEncodeError:
        pass
    response.headers['Content-Disposition'] = (
        f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quoted}'
    )
    response.headers['X-Download-Filename'] = quoted
    return response


def init_default_configs():
    """
    初始化默认配置到数据库
    如果数据库中不存在配置，则使用默认值
    """
    logger.info("开始初始化默认配置...")
    init_count = 0
    for key, value in DEFAULT_CONFIGS.items():
        existing = SiteConfig.query.filter_by(key=key).first()
        if not existing:
            db.session.add(SiteConfig(key=key, value=value))
            init_count += 1
            logger.debug(f"初始化配置: {key} = {value}")
        elif key == 'site_title' and existing.value == '老默闪传':
            existing.value = value
            existing.updated_at = datetime.now()
            logger.info("网站标题已更新为「闪传」")
        elif key in ('site_subtitle', 'site_title', 'header_text', 'footer_text') and existing.value:
            cleaned = strip_im_brand(existing.value).replace('，', ',').replace('：', ':')
            if key == 'header_text' and cleaned.strip() in (
                '简单快速，安全可靠的文件传输服务',
                '简单2步，极速传文件给他人',
            ):
                cleaned = ''
            if cleaned != existing.value:
                existing.value = cleaned
                existing.updated_at = datetime.now()
        elif key == 'allowed_extensions' and existing.value == 'jpg,jpeg,png,gif,pdf,doc,docx,xls,xlsx,ppt,pptx,txt,zip,rar,mp4,mp3':
            existing.value = ''
            existing.updated_at = datetime.now()
        elif key == 'header_text' and (existing.value or '').strip() in (
            '简单快速，安全可靠的文件传输服务',
            '简单2步，极速传文件给他人',
        ):
            existing.value = ''
            existing.updated_at = datetime.now()
        elif key == 'admin_password' and existing.value and not is_sha256_hex(existing.value):
            existing.value = store_password_hash(existing.value)
            existing.updated_at = datetime.now()
    for existing in SiteConfig.query.all():
        if existing.key in ('admin_password', 'admin_username', 'allowed_extensions', 'upload_folder', 'listen_port', 'max_upload_size', 'max_downloads', 'max_expire_hours'):
            continue
        cleaned = strip_im_brand(existing.value or '')
        if cleaned != (existing.value or ''):
            existing.value = cleaned
            existing.updated_at = datetime.now()
    db.session.commit()
    logger.info(f"默认配置初始化完成，共初始化 {init_count} 项配置")


def log_access(client_ip, action_type, file_id=None, extract_code=None, filename=None, 
               status='success', error_message=None, file_size=None):
    """
    记录用户访问日志到数据库
    
    Args:
        client_ip: 客户端IP地址
        action_type: 操作类型（upload, download, delete, etc.）
        file_id: 文件ID（可选）
        extract_code: 提取码（可选）
        filename: 文件名（可选）
        status: 操作状态（success, failed）
        error_message: 错误信息（可选）
        file_size: 文件大小（可选）
    """
    try:
        access_log = AccessLog(
            client_ip=client_ip,
            action_type=action_type,
            file_id=file_id,
            extract_code=extract_code,
            filename=filename,
            status=status,
            error_message=error_message,
            user_agent=request.headers.get('User-Agent', ''),
            file_size=file_size
        )
        db.session.add(access_log)
        db.session.commit()
    except Exception as e:
        logger.error(f"记录访问日志失败: {str(e)}", exc_info=True)


def log_system(level, module, message, extra_data=None):
    """
    记录系统日志到数据库
    
    Args:
        level: 日志级别（INFO, WARNING, ERROR）
        module: 日志模块
        message: 日志消息
        extra_data: 额外数据（可选，JSON格式）
    """
    try:
        system_log = SystemLog(
            log_level=level,
            log_module=module,
            log_message=message,
            extra_data=json.dumps(extra_data) if extra_data else None
        )
        db.session.add(system_log)
        db.session.commit()
    except Exception as e:
        logger.error(f"记录系统日志失败: {str(e)}", exc_info=True)


def is_ip_allowed(client_ip):
    """
    检查IP是否被允许访问
    
    Args:
        client_ip: 客户端IP地址
    
    Returns:
        True: 允许访问
        False: 拒绝访问
    """
    if not get_config('ip_access_enabled', 'false').lower() == 'true':
        return True
    
    try:
        client_ip_obj = ipaddress.ip_address(client_ip)
        default_policy = get_config('default_access_policy', 'allow')
        
        # 检查黑名单
        blacklist_entries = IPAccessControl.query.filter_by(
            access_type='blacklist', 
            is_active=True
        ).all()
        
        for entry in blacklist_entries:
            try:
                network = ipaddress.ip_network(entry.ip_range, strict=False)
                if client_ip_obj in network:
                    if get_config('log_ip_access', 'true').lower() == 'true':
                        logger.warning(f"IP {client_ip} 被黑名单拒绝: {entry.ip_range}")
                    return False
            except ValueError:
                continue
        
        # 检查白名单
        whitelist_entries = IPAccessControl.query.filter_by(
            access_type='whitelist', 
            is_active=True
        ).all()
        
        if whitelist_entries:
            for entry in whitelist_entries:
                try:
                    network = ipaddress.ip_network(entry.ip_range, strict=False)
                    if client_ip_obj in network:
                        if get_config('log_ip_access', 'true').lower() == 'true':
                            logger.info(f"IP {client_ip} 被白名单允许: {entry.ip_range}")
                        return True
                except ValueError:
                    continue
            # 如果有白名单但IP不在任何白名单中，则拒绝
            if get_config('log_ip_access', 'true').lower() == 'true':
                logger.warning(f"IP {client_ip} 不在任何白名单中，拒绝访问")
            return False
        
        # 如果没有白名单，使用默认策略
        return default_policy == 'allow'
        
    except ValueError as e:
        logger.error(f"IP地址格式错误: {client_ip}, 错误: {str(e)}")
        return get_config('default_access_policy', 'allow') == 'allow'
    except Exception as e:
        logger.error(f"IP访问检查失败: {str(e)}", exc_info=True)
        return True


def ip_access_required(f):
    """
    IP访问控制装饰器
    检查客户端IP是否被允许访问系统
    
    Args:
        f: 被装饰的函数
    
    Returns:
        如果IP被拒绝，返回403错误
        否则执行原函数
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # 获取客户端真实IP
        client_ip = request.environ.get('HTTP_X_FORWARDED_FOR', request.environ.get('REMOTE_ADDR', 'unknown'))
        
        # 如果是多个IP（通过代理），取第一个
        if ',' in client_ip:
            client_ip = client_ip.split(',')[0].strip()
        
        # 检查IP是否被允许访问
        if not is_ip_allowed(client_ip):
            logger.warning(f"访问被拒绝: IP={client_ip}, 路径={request.path}")
            log_access(client_ip, 'access_denied', status='failed', error_message='IP访问被拒绝')
            return jsonify({'error': '访问被拒绝'}), 403
        
        # 记录访问
        log_access(client_ip, 'page_access', status='success')
        
        return f(*args, **kwargs)
    return decorated_function


def is_loopback_ip(ip):
    """判断是否为本机回环地址（127.0.0.1 / ::1 等）。"""
    if not ip or ip in ('unknown', 'localhost'):
        return ip == 'localhost'
    try:
        return ipaddress.ip_address(str(ip).split('%')[0]).is_loopback
    except ValueError:
        return False


_local_lan_ip_cache = None


def get_local_lan_ip():
    """获取本机局域网 IP，用于本机经 127.0.0.1 访问时展示真实网卡地址。"""
    global _local_lan_ip_cache
    if _local_lan_ip_cache and not is_loopback_ip(_local_lan_ip_cache):
        return _local_lan_ip_cache
    candidates = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(('8.8.8.8', 80))
            ip = sock.getsockname()[0]
            if ip and not is_loopback_ip(ip):
                candidates.append(ip)
    except OSError:
        pass
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip and not is_loopback_ip(ip) and ip not in candidates:
                candidates.append(ip)
    except OSError:
        pass
    lan = candidates[0] if candidates else '127.0.0.1'
    if not is_loopback_ip(lan):
        _local_lan_ip_cache = lan
    return lan


def get_client_ip():
    """
    获取客户端真实IP地址
    支持多种代理头，能够穿透代理获取真实IP
    本机经 127.0.0.1 / ::1 访问时，记录本机局域网 IP，避免显示回环地址

    Returns:
        客户端IP地址
    """
    # 检查各种可能的代理头（按优先级排序）
    ip_headers = [
        'HTTP_X_FORWARDED_FOR',  # 最常用的代理头
        'HTTP_X_REAL_IP',        # Nginx等代理设置的头部
        'HTTP_CLIENT_IP',         # CloudFlare等CDN设置的头部
        'HTTP_X_FORWARDED',
        'HTTP_X_CLUSTER_CLIENT_IP',
        'HTTP_FORWARDED_FOR',
        'HTTP_FORWARDED',
        'REMOTE_ADDR'            # 直连时的IP
    ]

    for header in ip_headers:
        ip = request.environ.get(header)
        if ip:
            # 如果有多个IP（通过多层代理），取第一个
            if ',' in ip:
                ip = ip.split(',')[0].strip()
            if is_loopback_ip(ip):
                lan = get_local_lan_ip()
                if lan and not is_loopback_ip(lan):
                    return lan
            return ip

    return 'unknown'


def get_all_client_ips():
    """收集本次请求能见到的全部 IP（代理链 + 直连），用于多 IP 场景。浏览器拿不到 MAC。"""
    seen = []
    for header in (
        'HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP', 'HTTP_CLIENT_IP',
        'HTTP_X_FORWARDED', 'HTTP_X_CLUSTER_CLIENT_IP', 'HTTP_FORWARDED_FOR',
        'HTTP_FORWARDED', 'REMOTE_ADDR'
    ):
        raw = request.environ.get(header)
        if not raw:
            continue
        for part in str(raw).split(','):
            ip = part.strip()
            if ip and ip not in seen:
                seen.append(ip)
    primary = get_client_ip()
    if primary and primary not in seen:
        seen.insert(0, primary)
    # 本机访问时保留回环地址，便于匹配历史记录里仍是 127.0.0.1 的条目
    if any(is_loopback_ip(ip) for ip in seen):
        lan = get_local_lan_ip()
        if lan and not is_loopback_ip(lan) and lan not in seen:
            seen.insert(0, lan)
    return primary, seen


def display_client_ip(ip):
    """展示用：回环地址替换为本机局域网 IP。"""
    if is_loopback_ip(ip):
        lan = get_local_lan_ip()
        if lan and not is_loopback_ip(lan):
            return lan
    return ip or ''


def display_client_ips(ips_text, primary=None):
    """展示用：逗号分隔 IP 列表中的回环地址替换为本机局域网 IP。"""
    parts = []
    for part in str(ips_text or primary or '').split(','):
        ip = display_client_ip(part.strip())
        if ip and ip not in parts:
            parts.append(ip)
    return ','.join(parts) if parts else display_client_ip(primary)


def get_client_device_id():
    """浏览器设备标识。网页读不到 MAC，用本地生成的 ID 区分同一台设备换 IP / 多 IP。"""
    raw = (request.headers.get('X-Client-Id') or request.cookies.get('client_id') or '').strip()
    if re.match(r'^[A-Za-z0-9_-]{8,64}$', raw):
        return raw
    return ''


def download_skips_quota(file_record):
    if not file_record:
        return False
    if is_admin():
        return True
    if getattr(file_record, 'uploaded_by_admin', False):
        return True
    cid = get_client_device_id()
    uploader = getattr(file_record, 'uploader_client_id', None) or ''
    if cid and uploader and cid == uploader:
        return True
    if cid and file_record.share_uid:
        upload = ShareTransfer.query.filter_by(
            share_uid=file_record.share_uid,
            event_type='upload'
        ).order_by(ShareTransfer.created_at.asc()).first()
        if upload and upload.operator_client_id and upload.operator_client_id == cid:
            return True
    return False


# 去掉易混字符：0/O、1/I/L 等
SAFE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'


def find_file_by_extract_code(code):
    """按提取码查找文件，英文不区分大小写。"""
    if not code:
        return None
    normalized = code.strip().upper()
    return File.query.filter(db.func.upper(File.extract_code) == normalized).first()


def find_file_by_delete_code(code):
    """按删除码查找文件，英文不区分大小写。"""
    if not code:
        return None
    normalized = code.strip().upper()
    return File.query.filter(db.func.upper(File.delete_code) == normalized).first()


def parse_share_codes(raw):
    if not raw:
        return []
    parts = re.split(r'[,，]+', str(raw).strip())
    return [p.strip().upper() for p in parts if p.strip()]


def find_file_by_any_code(code):
    return find_file_by_extract_code(code) or find_file_by_delete_code(code)


def generate_random_code(length):
    return ''.join(secrets.choice(SAFE_CODE_ALPHABET) for _ in range(length))


def generate_unique_extract_code():
    while True:
        code = generate_random_code(6)
        if not find_file_by_extract_code(code):
            return code


def generate_unique_delete_code():
    while True:
        code = generate_random_code(4)
        if not find_file_by_delete_code(code):
            return code


def generate_codes():
    """
    生成唯一的提取码和删除码
    
    Returns:
        tuple: (提取码, 删除码)
              - 提取码: 6位易读字母数字
              - 删除码: 4位易读字母数字（校验时不区分大小写）
    """
    extract_code = generate_unique_extract_code()
    delete_code = generate_unique_delete_code()
            
    logger.debug(f"生成代码: 提取码={extract_code}, 删除码={delete_code}")
    return extract_code, delete_code


def ensure_share_uid(file_record):
    if file_record and not file_record.share_uid:
        file_record.share_uid = uuid.uuid4().hex
    return file_record.share_uid if file_record else None


def record_share_transfer(event_type, file_record, operator_ip, operator_ips=None, operator_client_id=None):
    if not file_record:
        return
    share_uid = ensure_share_uid(file_record)
    if operator_ips is None or operator_client_id is None:
        primary, ips = get_all_client_ips()
        operator_ip = operator_ip or primary
        operator_ips = operator_ips if operator_ips is not None else ','.join(ips)
        operator_client_id = operator_client_id if operator_client_id is not None else get_client_device_id()
    db.session.add(ShareTransfer(
        share_uid=share_uid,
        event_type=event_type,
        operator_ip=operator_ip,
        operator_ips=operator_ips or operator_ip,
        operator_client_id=operator_client_id or '',
        filename=file_record.original_filename,
        extract_code=file_record.extract_code,
        delete_code=file_record.delete_code
    ))


def sync_transfer_codes(file_record):
    if not file_record or not file_record.share_uid:
        return
    ShareTransfer.query.filter_by(share_uid=file_record.share_uid).update({
        'extract_code': file_record.extract_code,
        'delete_code': file_record.delete_code,
        'filename': file_record.original_filename
    }, synchronize_session=False)


def sanitize_relpath(path, fallback_name=''):
    raw = (path or fallback_name or '').replace('\\', '/')
    parts = [part for part in raw.split('/') if part not in ('', '.', '..')]
    return '/'.join(parts)


def collect_upload_items():
    items = []
    files = request.files.getlist('files')
    paths = request.form.getlist('paths')
    if files:
        for index, storage in enumerate(files):
            rel = paths[index] if index < len(paths) else storage.filename
            rel = sanitize_relpath(rel, storage.filename)
            if storage and storage.filename and rel:
                items.append((storage, rel))
        return items
    if 'file' in request.files:
        storage = request.files['file']
        rel = sanitize_relpath(request.form.get('path') or storage.filename, storage.filename)
        if storage and storage.filename and rel:
            items.append((storage, rel))
    return items


def ensure_schema():
    db.create_all()
    inspector = sa_inspect(db.engine)
    tables = inspector.get_table_names()
    if 'file' in tables:
        columns = {col['name'] for col in inspector.get_columns('file')}
        if 'share_uid' not in columns:
            db.session.execute(text('ALTER TABLE file ADD COLUMN share_uid VARCHAR(32)'))
            db.session.commit()
            logger.info('已为 file 表增加 share_uid 字段')
        file_cols = {col['name'] for col in inspector.get_columns('file')}
        if 'uploader_client_id' not in file_cols:
            db.session.execute(text('ALTER TABLE file ADD COLUMN uploader_client_id VARCHAR(64)'))
            db.session.commit()
        if 'uploaded_by_admin' not in file_cols:
            db.session.execute(text('ALTER TABLE file ADD COLUMN uploaded_by_admin BOOLEAN DEFAULT 0'))
            db.session.commit()
    if 'share_transfer' in tables:
        columns = {col['name'] for col in inspector.get_columns('share_transfer')}
        if 'operator_client_id' not in columns:
            db.session.execute(text('ALTER TABLE share_transfer ADD COLUMN operator_client_id VARCHAR(64)'))
            db.session.commit()
        if 'operator_ips' not in columns:
            db.session.execute(text('ALTER TABLE share_transfer ADD COLUMN operator_ips VARCHAR(255)'))
            db.session.commit()
        if 'deleted_at' not in columns:
            db.session.execute(text('ALTER TABLE share_transfer ADD COLUMN deleted_at DATETIME'))
            db.session.commit()
    if 'message_note' in tables:
        columns = {col['name'] for col in inspector.get_columns('message_note')}
        if 'deleted_at' not in columns:
            db.session.execute(text('ALTER TABLE message_note ADD COLUMN deleted_at DATETIME'))
            db.session.commit()
        if 'client_id' not in columns:
            db.session.execute(text('ALTER TABLE message_note ADD COLUMN client_id VARCHAR(64)'))
            db.session.commit()
        if 'updated_at' not in columns:
            db.session.execute(text('ALTER TABLE message_note ADD COLUMN updated_at DATETIME'))
            db.session.commit()
    for rec in File.query.filter((File.share_uid.is_(None)) | (File.share_uid == '')).all():
        rec.share_uid = uuid.uuid4().hex
    db.session.commit()
    if 'shared_dir' in tables:
        columns = {col['name'] for col in inspector.get_columns('shared_dir')}
        alter_specs = [
            ('owner_ip', "ALTER TABLE shared_dir ADD COLUMN owner_ip VARCHAR(45) DEFAULT ''"),
            ('owner_client_id', 'ALTER TABLE shared_dir ADD COLUMN owner_client_id VARCHAR(64)'),
            ('perm_browse', 'ALTER TABLE shared_dir ADD COLUMN perm_browse BOOLEAN DEFAULT 1'),
            ('perm_download', 'ALTER TABLE shared_dir ADD COLUMN perm_download BOOLEAN DEFAULT 1'),
            ('perm_zip', 'ALTER TABLE shared_dir ADD COLUMN perm_zip BOOLEAN DEFAULT 1'),
            ('perm_upload', 'ALTER TABLE shared_dir ADD COLUMN perm_upload BOOLEAN DEFAULT 0'),
            ('perm_mkdir', 'ALTER TABLE shared_dir ADD COLUMN perm_mkdir BOOLEAN DEFAULT 0'),
            ('perm_delete', 'ALTER TABLE shared_dir ADD COLUMN perm_delete BOOLEAN DEFAULT 0'),
            ('perm_rename', 'ALTER TABLE shared_dir ADD COLUMN perm_rename BOOLEAN DEFAULT 0'),
            ('perm_show_hidden', 'ALTER TABLE shared_dir ADD COLUMN perm_show_hidden BOOLEAN DEFAULT 0'),
        ]
        for col_name, sql in alter_specs:
            if col_name not in columns:
                db.session.execute(text(sql))
                db.session.commit()
                logger.info(f'已为 shared_dir 表增加 {col_name} 字段')
    sync_schema_doc()


def get_upload_folder():
    return os.path.abspath(get_config('upload_folder', 'uploads'))


def remove_share_file(file_record, reason=''):
    """删除磁盘文件和数据库记录。文件不存在时仍删除库记录。"""
    if not file_record:
        return
    upload_folder = get_upload_folder()
    file_path = os.path.join(upload_folder, file_record.filename_on_disk)
    try:
        if os.path.exists(file_path):
            os.remove(file_path)
            logger.info(f"已删除磁盘文件: {file_path} ({reason})")
        else:
            logger.warning(f"磁盘文件已不存在, 仅清理库记录: {file_path} ({reason})")
    except Exception as e:
        logger.error(f"删除磁盘文件失败: {file_path}, {e}")
    db.session.delete(file_record)


def share_remaining_hours(file_record):
    seconds = (file_record.expires_at - datetime.now()).total_seconds()
    if seconds <= 0:
        return 0
    return max(1, int((seconds + 3599) // 3600))


def serialize_public_file_info(code):
    """按提取码/删除码返回可展示的文件信息，过期或失效时也返回详情。"""
    raw = str(code or '').strip().upper()
    rec = find_file_by_any_code(raw)
    if not rec:
        return {
            'extract_code': raw,
            'filename': '',
            'file_size': 0,
            'current_downloads': None,
            'max_downloads': None,
            'expires_at': None,
            'expired': True,
            'file_available': False,
            'downloadable': False,
            'upload_time': '',
            'operator_ip': '',
            'remaining_hours': 0,
            'remaining_seconds': 0,
            'error': '无效的提取码',
        }
    file_path = os.path.join(get_upload_folder(), rec.filename_on_disk)
    available = os.path.exists(file_path)
    size = os.path.getsize(file_path) if available else 0
    now = datetime.now()
    expired = bool(rec.expires_at and now > rec.expires_at)
    remain = (rec.expires_at - now).total_seconds() if rec.expires_at else 0
    limit_reached = rec.current_downloads >= rec.max_downloads
    downloadable = bool(available and not expired and not limit_reached)
    error = None
    if not available:
        error = '文件不存在'
    elif expired:
        error = '文件已过期'
    elif limit_reached:
        error = '已达到最大下载次数'
    upload = None
    if rec.share_uid:
        upload = ShareTransfer.query.filter_by(
            share_uid=rec.share_uid,
            event_type='upload'
        ).order_by(ShareTransfer.created_at.asc()).first()
    return {
        'filename': rec.original_filename,
        'extract_code': rec.extract_code,
        'file_size': size,
        'current_downloads': rec.current_downloads,
        'max_downloads': rec.max_downloads,
        'expires_at': rec.expires_at.strftime('%Y-%m-%d %H:%M:%S') if rec.expires_at else None,
        'expired': expired or not available,
        'file_available': available,
        'downloadable': downloadable,
        'upload_time': rec.upload_time.strftime('%Y-%m-%d %H:%M:%S') if rec.upload_time else '',
        'operator_ip': display_client_ip(upload.operator_ip) if upload else '',
        'remaining_hours': 0 if expired else max(0, remain / 3600.0),
        'remaining_seconds': max(0, int(remain)),
        'error': error,
    }


def describe_share(file_record):
    upload_folder = get_upload_folder()
    file_path = os.path.join(upload_folder, file_record.filename_on_disk) if file_record else ''
    file_exists = bool(file_record and os.path.exists(file_path))
    now = datetime.now()
    system_max_downloads = int(get_config('max_downloads', '10'))
    system_max_expire_hours = float(get_config('max_expire_hours', '72'))

    if not file_record or not file_exists:
        return {
            'status': 'deleted',
            'can_edit': False,
            'message': '已经过期',
            'filename': file_record.original_filename if file_record else '',
            'extract_code': file_record.extract_code if file_record else '',
            'delete_code': file_record.delete_code if file_record else '',
            'max_downloads': file_record.max_downloads if file_record else None,
            'current_downloads': file_record.current_downloads if file_record else None,
            'expires_at': file_record.expires_at.strftime('%Y-%m-%d %H:%M:%S') if file_record and file_record.expires_at else None,
            'remaining_hours': 0,
            'upload_time': file_record.upload_time.strftime('%Y-%m-%d %H:%M:%S') if file_record and file_record.upload_time else '',
            'system_max_downloads': system_max_downloads,
            'system_max_expire_hours': system_max_expire_hours
        }

    expired = now > file_record.expires_at
    limit_reached = file_record.current_downloads >= file_record.max_downloads
    if expired or limit_reached:
        status = 'expired' if expired else 'limit_reached'
        message = '已经过期' if expired else '已达下载次数上限'
        return {
            'status': status,
            'can_edit': False,
            'message': message,
            'filename': file_record.original_filename,
            'extract_code': file_record.extract_code,
            'delete_code': file_record.delete_code,
            'max_downloads': file_record.max_downloads,
            'current_downloads': file_record.current_downloads,
            'expires_at': file_record.expires_at.strftime('%Y-%m-%d %H:%M:%S'),
            'remaining_hours': 0,
            'upload_time': file_record.upload_time.strftime('%Y-%m-%d %H:%M:%S') if file_record.upload_time else '',
            'system_max_downloads': system_max_downloads,
            'system_max_expire_hours': system_max_expire_hours
        }

    return {
        'status': 'active',
        'can_edit': True,
        'message': '',
        'filename': file_record.original_filename,
        'extract_code': file_record.extract_code,
        'delete_code': file_record.delete_code,
        'max_downloads': file_record.max_downloads,
        'current_downloads': file_record.current_downloads,
        'expires_at': file_record.expires_at.strftime('%Y-%m-%d %H:%M:%S'),
        'remaining_hours': share_remaining_hours(file_record),
        'upload_time': file_record.upload_time.strftime('%Y-%m-%d %H:%M:%S') if file_record.upload_time else '',
        'system_max_downloads': system_max_downloads,
        'system_max_expire_hours': system_max_expire_hours
    }


def format_multi_upload_display_name(paths):
    names = []
    for path in paths:
        base = os.path.basename((path or '').replace('\\', '/')) or 'file'
        names.append(base)
    if len(names) == 1:
        return names[0]
    shown = names[:3]
    return ','.join(shown) + f'等{len(names)}个文件'


# ==========================================
# 路由定义
# ==========================================

@app.route('/')
@ip_access_required
def home():
    """
    主页路由
    显示文件上传和下载界面
    """
    logger.info(f"访问主页: IP={get_client_ip()}")
    return render_template('index.html', 
                        site_title=get_config('site_title'),
                        site_subtitle=get_config('site_subtitle'),
                        logo_url=get_config('logo_url'),
                        header_text=get_config('header_text'),
                        footer_text=get_config('footer_text'))


@app.route('/admin')
def admin():
    """
    管理后台首页路由
    如果未登录，重定向到登录页面
    """
    client_ip = get_client_ip()
    if not session.get('admin_logged_in'):
        logger.warning(f"未登录尝试访问管理后台: IP={client_ip}")
        return redirect(url_for('admin_login'))
    
    logger.info(f"访问管理后台: IP={client_ip}")
    return render_template('admin.html')


@app.route('/admin/login', methods=['GET', 'POST'])
def admin_login():
    """
    管理员登录路由
    处理管理员登录请求
    """
    client_ip = get_client_ip()
    
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        if check_admin_credentials(username, password):
            session['admin_logged_in'] = True
            session.permanent = False
            logger.info(f"管理员登录成功: IP={client_ip}")
            log_access(client_ip, 'admin_login', status='success')
            return redirect(url_for('admin'))
        else:
            logger.warning(f"管理员登录失败: 账号或密码错误, IP={client_ip}")
            log_access(client_ip, 'admin_login', status='failed', error_message='账号或密码错误')
            return render_template('admin_login.html', error='账号或密码错误')
    
    # GET请求显示登录页面
    logger.info(f"访问管理员登录页面: IP={client_ip}")
    return render_template('admin_login.html')


@app.route('/admin/logout')
def admin_logout():
    """
    管理员登出路由
    清除session并重定向到首页
    """
    client_ip = get_client_ip()
    session.pop('admin_logged_in', None)
    logger.info(f"管理员登出: IP={client_ip}")
    log_access(client_ip, 'admin_logout', status='success')
    if request.path.startswith('/api/'):
        return jsonify({'success': True})
    return redirect(url_for('home'))


@app.route('/api/admin/status', methods=['GET'])
def api_admin_status():
    return jsonify({
        'is_admin': is_admin(),
        'username': get_config('admin_username', 'admin') if is_admin() else None
    })


@app.route('/api/admin/login', methods=['POST'])
def api_admin_login():
    client_ip = get_client_ip()
    data = request.get_json(silent=True) or {}
    username = data.get('username') or request.form.get('username')
    password = data.get('password') or request.form.get('password')
    if check_admin_credentials(username, password):
        session['admin_logged_in'] = True
        session.permanent = False
        log_access(client_ip, 'admin_login', status='success')
        return jsonify({'success': True, 'is_admin': True, 'username': (username or '').strip()})
    log_access(client_ip, 'admin_login', status='failed', error_message='账号或密码错误')
    return jsonify({'error': '账号或密码错误'}), 401


@app.route('/api/admin/logout', methods=['POST'])
def api_admin_logout():
    session.pop('admin_logged_in', None)
    log_access(get_client_ip(), 'admin_logout', status='success')
    return jsonify({'success': True, 'is_admin': False})


@app.route('/api/admin/account', methods=['POST'])
def api_admin_account():
    if not is_admin():
        return jsonify({'error': '需要管理员登录'}), 401
    data = request.get_json(silent=True) or {}
    current_password = data.get('current_password') or ''
    if store_password_hash(current_password) != store_password_hash(get_config('admin_password', '') or ''):
        return jsonify({'error': '当前密码不正确'}), 400
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    if not username:
        return jsonify({'error': '用户名不能为空'}), 400
    set_config('admin_username', username)
    if password:
        set_config('admin_password', password)
    return jsonify({'success': True, 'username': username})


# ==========================================
# 公开的系统配置接口
# ==========================================

@app.route('/api/config', methods=['GET'])
def get_public_config():
    """
    公开配置接口
    无需登录即可访问，专门给前端使用。
    用于获取最大上传限制、下载次数限制、过期时间等基础配置。
    """
    try:
        configs = {}
        for key in DEFAULT_CONFIGS.keys():
            if key in ('admin_password', 'admin_username'):
                continue
            configs[key] = get_config(key)
        
        logger.info(f"前端请求公开配置: IP={get_client_ip()}")
        return jsonify(configs)
        
    except Exception as e:
        logger.error(f"获取公开配置失败: {str(e)}", exc_info=True)
        return jsonify({'error': f'获取配置失败: {str(e)}'}), 500

# ==========================================
#  /admin/config (管理员专用，保持不变)
# ==========================================

@app.route('/admin/config', methods=['GET', 'POST'])
def admin_config():
    """
    管理后台配置路由
    获取或更新系统配置
    """
    client_ip = get_client_ip()
    if not session.get('admin_logged_in'):
        logger.warning(f"未登录尝试访问配置接口: IP={client_ip}")
        return jsonify({'error': '未登录'}), 401
    
    if request.method == 'GET':
        # 获取所有配置
        logger.info(f"获取配置: IP={client_ip}")
        configs = {}
        for key in DEFAULT_CONFIGS.keys():
            configs[key] = get_config(key)
        return jsonify(configs)
    
    elif request.method == 'POST':
        # 更新配置
        data = request.get_json()
        logger.info(f"更新配置: IP={client_ip}, 配置数={len(data)}")
        update_count = 0
        for key, value in data.items():
            if key in DEFAULT_CONFIGS:
                set_config(key, value)
                update_count += 1
        if 'listen_port' in data:
            save_runtime_config(port=data.get('listen_port'))
        logger.info(f"配置更新完成: 更新了 {update_count} 项配置")
        return jsonify({'success': True})


@app.route('/admin/upload-logo', methods=['POST'])
def admin_upload_logo():
    """
    上传网站LOGO路由
    处理管理员上传的LOGO图片
    """
    client_ip = get_client_ip()
    if not session.get('admin_logged_in'):
        logger.warning(f"未登录尝试上传LOGO: IP={client_ip}")
        return jsonify({'error': '未登录'}), 401
    
    if 'logo' not in request.files:
        logger.error(f"上传LOGO失败: 没有文件, IP={client_ip}")
        return jsonify({'error': '没有文件'}), 400
    
    file = request.files['logo']
    if file.filename == '':
        logger.error(f"上传LOGO失败: 没有选择文件, IP={client_ip}")
        return jsonify({'error': '没有选择文件'}), 400
    
    # 检查文件类型
    allowed_extensions = {'png', 'jpg', 'jpeg', 'gif'}
    if not ('.' in file.filename and file.filename.rsplit('.', 1)[1].lower() in allowed_extensions):
        logger.error(f"上传LOGO失败: 文件类型不允许, 文件名={file.filename}, IP={client_ip}")
        return jsonify({'error': '只允许上传图片文件'}), 400
    
    try:
        # 生成唯一文件名
        filename = secure_filename(file.filename)
        unique_filename = f"logo_{uuid.uuid4().hex}.{filename.rsplit('.', 1)[1]}"
        
        # 使用 static/img 目录
        img_folder = os.path.join('static', 'img')
        if not os.path.exists(img_folder):
            os.makedirs(img_folder)
            logger.info(f"创建图片目录: {img_folder}")
        
        # 保存文件到 static/img
        file_path = os.path.join(img_folder, unique_filename)
        file.save(file_path)
        file_size = os.path.getsize(file_path)
        
        # 更新配置，使用静态文件路径
        logo_url = f"/static/img/{unique_filename}"
        set_config('logo_url', logo_url)
        
        logger.info(f"LOGO上传成功: 文件名={unique_filename}, 大小={file_size}字节, IP={client_ip}")
        log_access(client_ip, 'logo_upload', filename=filename, status='success', file_size=file_size)
        return jsonify({'success': True, 'logo_url': logo_url})
        
    except Exception as e:
        logger.error(f"LOGO上传失败: {str(e)}, IP={client_ip}", exc_info=True)
        log_access(client_ip, 'logo_upload', filename=file.filename, status='failed', error_message=str(e))
        return jsonify({'error': f'上传失败: {str(e)}'}), 500


@app.route('/upload', methods=['POST'])
@ip_access_required
def upload_file():
    """
    文件上传路由
    支持单文件，以及文件夹（保留 A/A1.txt 相对路径，多文件打成 zip）。
    """
    client_ip = get_client_ip()
    items = collect_upload_items()
    if not items:
        logger.error(f"文件上传失败: 没有文件部分, IP={client_ip}")
        return jsonify({'error': '没有选择文件'}), 400

    max_upload_size = int(get_config('max_upload_size', '50')) * 1024 * 1024
    allowed_raw = (get_config('allowed_extensions', '') or '').strip()
    allowed_extensions = [ext.strip().lower() for ext in allowed_raw.split(',') if ext.strip()]
    system_max_downloads = int(get_config('max_downloads', '10'))
    try:
        max_downloads = int(request.form.get('max_downloads', '3'))
    except (TypeError, ValueError):
        max_downloads = 3
    max_downloads = max(1, min(max_downloads, system_max_downloads))
    try:
        expire_hours = float(request.form.get('expire_hours', get_config('max_expire_hours', '72')))
    except (TypeError, ValueError):
        expire_hours = float(get_config('max_expire_hours', '72'))
    system_max_hours = float(get_config('max_expire_hours', '72'))
    try:
        expires_at = resolve_share_expiry(expire_hours, request.form.get('expires_at'), system_max_hours)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400

    total_size = 0
    for storage, rel in items:
        if allowed_extensions:
            if '.' not in rel:
                return jsonify({'error': f'文件名无效: {rel}'}), 400
            ext = rel.rsplit('.', 1)[1].lower()
            if ext not in allowed_extensions:
                return jsonify({'error': f'不支持的文件类型: {ext}, 支持的类型: {", ".join(allowed_extensions)}'}), 400
        pos = storage.stream.tell()
        storage.stream.seek(0, os.SEEK_END)
        size = storage.stream.tell()
        storage.stream.seek(pos)
        total_size += size

    if total_size > max_upload_size:
        return jsonify({'error': f'文件大小超过限制（{max_upload_size // (1024 * 1024)}MB）'}), 400

    display_name = format_multi_upload_display_name([rel for _, rel in items])
    pack_zip = len(items) > 1

    try:
        extract_code, delete_code = generate_codes()
        disk_id = uuid.uuid4().hex
        upload_folder = get_upload_folder()
        if not os.path.exists(upload_folder):
            os.makedirs(upload_folder)
        save_path = os.path.join(upload_folder, disk_id)

        if pack_zip:
            with zipfile.ZipFile(save_path, 'w', zipfile.ZIP_DEFLATED) as archive:
                for storage, rel in items:
                    info = zipfile.ZipInfo(rel)
                    info.flag_bits |= 0x800
                    archive.writestr(info, storage.read())
        else:
            items[0][0].save(save_path)

        actual_file_size = os.path.getsize(save_path)
        new_file = File(
            original_filename=display_name,
            filename_on_disk=disk_id,
            share_uid=uuid.uuid4().hex,
            extract_code=extract_code,
            delete_code=delete_code,
            expires_at=expires_at,
            max_downloads=max_downloads,
            uploader_client_id=get_client_device_id() or '',
            uploaded_by_admin=is_admin()
        )
        db.session.add(new_file)
        db.session.flush()
        record_share_transfer('upload', new_file, client_ip)
        db.session.commit()

        logger.info(f"文件上传成功: 文件名={display_name}, 提取码={extract_code}, "
                   f"大小={actual_file_size}字节, 下载次数限制={max_downloads}, "
                   f"过期时间={expire_hours}小时, IP={client_ip}")
        log_access(client_ip, 'upload', file_id=new_file.id, extract_code=extract_code,
                 filename=display_name, status='success', file_size=actual_file_size)

        return jsonify({
            'success': True,
            'extract_code': extract_code,
            'delete_code': delete_code,
            'filename': display_name,
            'share_uid': new_file.share_uid,
            'max_downloads': max_downloads,
            'expire_hours': expire_hours,
            'expires_at': new_file.expires_at.strftime('%Y-%m-%d %H:%M:%S')
        })
    except Exception as e:
        logger.error(f"文件上传失败: {str(e)}, IP={client_ip}", exc_info=True)
        log_access(client_ip, 'upload', filename=display_name, status='failed', error_message=str(e), file_size=total_size)
        return jsonify({'error': f'上传失败: {str(e)}'}), 500


@app.route('/refresh-codes', methods=['POST'])
@ip_access_required
def refresh_codes():
    """刷新提取码和/或删除码。"""
    client_ip = get_client_ip()
    data = request.get_json(silent=True) or {}
    extract_code = (data.get('extract_code') or '').strip().upper()
    target = (data.get('target') or 'both').strip().lower()
    if target not in ('extract', 'delete', 'both'):
        return jsonify({'error': '无效的刷新类型'}), 400

    file_record = find_file_by_extract_code(extract_code)
    if not file_record:
        logger.warning(f"刷新码失败: 提取码不存在 code={extract_code}, IP={client_ip}")
        return jsonify({'error': '文件不存在或提取码已失效'}), 404

    share = describe_share(file_record)
    if not share.get('can_edit'):
        return jsonify({'error': share.get('message') or '当前分享不能修改'}), 409

    old_extract = file_record.extract_code
    old_delete = file_record.delete_code
    if target in ('extract', 'both'):
        file_record.extract_code = generate_unique_extract_code()
    if target in ('delete', 'both'):
        file_record.delete_code = generate_unique_delete_code()
    ensure_share_uid(file_record)
    sync_transfer_codes(file_record)
    db.session.commit()

    logger.info(f"刷新码成功: 原提取码={old_extract} 新提取码={file_record.extract_code}, "
                f"原删除码={old_delete} 新删除码={file_record.delete_code}, target={target}, IP={client_ip}")
    return jsonify({
        'success': True,
        'extract_code': file_record.extract_code,
        'delete_code': file_record.delete_code,
        'filename': file_record.original_filename,
        'share_uid': file_record.share_uid
    })


@app.route('/share-manage/<code>', methods=['GET', 'POST'])
@ip_access_required
def share_manage(code):
    """查看或修改已生成分享的下载次数、分享时限。"""
    client_ip = get_client_ip()
    file_record = find_file_by_extract_code(code)
    info = describe_share(file_record)
    if request.method == 'GET':
        return jsonify(info)

    if not info.get('can_edit'):
        return jsonify({
            'error': info.get('message') or '当前分享不能修改',
            'status': info.get('status'),
            'can_edit': False
        }), 409

    data = request.get_json(silent=True) or {}
    system_max_downloads = int(get_config('max_downloads', '10'))
    system_max_hours = float(get_config('max_expire_hours', '72'))
    try:
        max_downloads = int(data.get('max_downloads', file_record.max_downloads))
        expire_hours = float(data.get('expire_hours', info.get('remaining_hours') or 1))
    except (TypeError, ValueError):
        return jsonify({'error': '下载次数或分享时限格式不正确'}), 400

    if max_downloads < 1 or max_downloads > system_max_downloads:
        return jsonify({'error': f'下载次数需在 1～{system_max_downloads} 之间'}), 400
    if max_downloads < file_record.current_downloads:
        return jsonify({'error': f'下载次数不能小于已下载次数（{file_record.current_downloads}）'}), 400
    try:
        expires_at = resolve_share_expiry(expire_hours, data.get('expires_at'), system_max_hours)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400

    file_record.max_downloads = max_downloads
    file_record.expires_at = expires_at
    db.session.commit()
    logger.info(f"修改分享设置: 提取码={file_record.extract_code}, 次数={max_downloads}, "
                f"时限={expire_hours}小时, IP={client_ip}")
    return jsonify(describe_share(file_record))


def is_share_transfer_mine(row):
    cid = get_client_device_id()
    if cid and row.operator_client_id == cid:
        return True
    if cid and row.share_uid:
        rec = File.query.filter_by(share_uid=row.share_uid).first()
        if rec and (rec.uploader_client_id or '') == cid:
            return True
    if (row.operator_client_id or '').strip():
        return False
    primary, ips = get_all_client_ips()
    ip_set = set([ip for ip in ([primary] + list(ips)) if ip])
    return row.operator_ip in ip_set


def parse_expire_datetime(raw):
    if not raw:
        return None
    text = str(raw).strip().replace('Z', '').replace('T', ' ')
    if len(text) == 16:
        text += ':00'
    try:
        return datetime.strptime(text[:19], '%Y-%m-%d %H:%M:%S')
    except ValueError:
        return None


def resolve_share_expiry(expire_hours, expires_at_raw, system_max_hours):
    now = datetime.now()
    target = None
    if expires_at_raw:
        target = parse_expire_datetime(expires_at_raw)
        if target is None:
            raise ValueError('过期时间格式不正确')
    if target is None:
        hours = float(expire_hours)
        if hours < (1.0 / 60.0):
            hours = 1.0 / 60.0
        if system_max_hours > 0:
            hours = min(hours, system_max_hours)
        return now + timedelta(hours=hours)
    if target <= now:
        raise ValueError('过期时间必须晚于当前时间')
    max_end = now + timedelta(hours=system_max_hours) if system_max_hours > 0 else target
    if target > max_end:
        raise ValueError('过期时间超过允许的最大分享时限')
    return target


def apply_mine_filter(query):
    cid = get_client_device_id()
    primary, ips = get_all_client_ips()
    clauses = []
    if cid:
        clauses.append(ShareTransfer.operator_client_id == cid)
        clauses.append(exists().where(and_(
            File.share_uid == ShareTransfer.share_uid,
            File.uploader_client_id == cid
        )))
    ip_set = [ip for ip in ([primary] + ips) if ip]
    unique_ips = list(dict.fromkeys(ip_set))
    if unique_ips:
        clauses.append(and_(
            or_(ShareTransfer.operator_client_id.is_(None), ShareTransfer.operator_client_id == ''),
            ShareTransfer.operator_ip.in_(unique_ips)
        ))
    if not clauses:
        return query.filter(text('0=1'))
    return query.filter(or_(*clauses))


def serialize_transfer_rows(rows, include_delete_code=False):
    uids = list({row.share_uid for row in rows})
    uploads = {}
    live_files = {}
    if uids:
        upload_rows = ShareTransfer.query.filter(
            ShareTransfer.event_type == 'upload',
            ShareTransfer.share_uid.in_(uids)
        ).order_by(ShareTransfer.created_at.asc()).all()
        for row in upload_rows:
            uploads[row.share_uid] = row
        live_files = {rec.share_uid: rec for rec in File.query.filter(File.share_uid.in_(uids)).all()}
    cid = get_client_device_id()
    primary, ips = get_all_client_ips()
    ip_set = set([ip for ip in ([primary] + list(ips)) if ip])
    items = []
    for row in rows:
        upload = uploads.get(row.share_uid)
        live = live_files.get(row.share_uid)
        current_extract = (live.extract_code if live else None) or (upload.extract_code if upload else row.extract_code)
        current_delete = (live.delete_code if live else None) or (upload.delete_code if upload else row.delete_code)
        current_name = (live.original_filename if live else None) or (upload.filename if upload else row.filename)
        is_mine = bool(cid and row.operator_client_id == cid)
        if not is_mine and live and cid and (live.uploader_client_id or '') == cid:
            is_mine = True
        if not is_mine and not (row.operator_client_id or '').strip() and row.operator_ip in ip_set:
            is_mine = True
        item = {
            'id': row.id,
            'share_uid': row.share_uid,
            'operator_ip': display_client_ip(row.operator_ip),
            'operator_ips': display_client_ips(row.operator_ips, row.operator_ip),
            'filename': current_name,
            'extract_code': current_extract,
            'created_at': row.created_at.strftime('%Y-%m-%d %H:%M:%S'),
            'is_mine': is_mine,
            'current_downloads': live.current_downloads if live else None,
            'max_downloads': live.max_downloads if live else None,
            'upload': None if not upload else {
                'operator_ip': display_client_ip(upload.operator_ip),
                'filename': current_name,
                'extract_code': current_extract,
                'created_at': upload.created_at.strftime('%Y-%m-%d %H:%M:%S')
            }
        }
        if include_delete_code and is_mine:
            item['delete_code'] = current_delete
        item['file_available'] = bool(
            live and os.path.exists(os.path.join(get_upload_folder(), live.filename_on_disk))
        )
        now = datetime.now()
        if live:
            item['expires_at'] = live.expires_at.strftime('%Y-%m-%d %H:%M:%S')
            item['expired'] = now > live.expires_at
            remain = (live.expires_at - now).total_seconds()
            item['remaining_seconds'] = max(0, int(remain))
            item['remaining_hours'] = max(0, remain / 3600.0)
            item['downloadable'] = bool(
                item['file_available']
                and not item['expired']
                and live.current_downloads < live.max_downloads
            )
            item['share'] = describe_share(live)
        else:
            item['expires_at'] = None
            item['expired'] = True
            item['remaining_seconds'] = 0
            item['remaining_hours'] = 0
            item['downloadable'] = False
            item['share'] = {
                'status': 'deleted',
                'can_edit': False,
                'message': '已经过期',
                'filename': current_name,
                'extract_code': current_extract,
                'delete_code': current_delete,
                'max_downloads': None,
                'current_downloads': None,
                'expires_at': None,
                'remaining_hours': 0,
                'upload_time': item['created_at'],
                'system_max_downloads': int(get_config('max_downloads', '10')),
                'system_max_expire_hours': float(get_config('max_expire_hours', '72'))
            }
        items.append(item)
    return items


def live_file_as_upload_item(rec, include_delete_code=False):
    now = datetime.now()
    available = bool(rec and os.path.exists(os.path.join(get_upload_folder(), rec.filename_on_disk)))
    expired = bool(rec.expires_at and now > rec.expires_at)
    remain = (rec.expires_at - now).total_seconds() if rec.expires_at else 0
    item = {
        'id': None,
        'share_uid': rec.share_uid,
        'operator_ip': '',
        'operator_ips': '',
        'filename': rec.original_filename,
        'extract_code': rec.extract_code,
        'created_at': rec.upload_time.strftime('%Y-%m-%d %H:%M:%S') if rec.upload_time else '',
        'is_mine': True,
        'current_downloads': rec.current_downloads,
        'max_downloads': rec.max_downloads,
        'upload': None,
        'file_available': available,
        'expires_at': rec.expires_at.strftime('%Y-%m-%d %H:%M:%S') if rec.expires_at else None,
        'expired': expired,
        'remaining_seconds': max(0, int(remain)),
        'remaining_hours': max(0, remain / 3600.0),
        'downloadable': bool(available and not expired and rec.current_downloads < rec.max_downloads),
        'share': describe_share(rec)
    }
    if include_delete_code:
        item['delete_code'] = rec.delete_code
    return item


def prepend_my_live_uploads(items):
    cid = get_client_device_id()
    if not cid:
        return items
    have = {item.get('share_uid') for item in items if item.get('share_uid')}
    extra = []
    for rec in File.query.filter(File.uploader_client_id == cid).order_by(File.upload_time.desc()).all():
        if rec.share_uid in have:
            continue
        extra.append(live_file_as_upload_item(rec, include_delete_code=True))
        have.add(rec.share_uid)
    return extra + items


@app.route('/api/transfer-logs', methods=['GET', 'DELETE'])
@app.route('/api/download-logs', methods=['GET'])
@ip_access_required
def api_transfer_logs():
    """全员可见的上传/下载记录。mine=1 按浏览器设备 ID 过滤（网页无法读取 MAC）。"""
    if request.method == 'DELETE':
        data = request.get_json(silent=True) or {}
        raw_ids = request.args.get('ids') or data.get('ids') or request.args.get('id') or data.get('id')
        id_list = []
        if isinstance(raw_ids, list):
            id_list = raw_ids
        elif raw_ids not in (None, ''):
            id_list = re.split(r'[,，\s]+', str(raw_ids))
        id_list = [int(x) for x in id_list if str(x).strip().isdigit()]
        if id_list:
            deleted = 0
            for lid in id_list:
                row = db.session.get(ShareTransfer, lid)
                if not row or row.deleted_at:
                    continue
                if not is_admin() and not is_share_transfer_mine(row):
                    continue
                row.deleted_at = datetime.now()
                deleted += 1
            db.session.commit()
            return jsonify({'success': True, 'deleted': deleted})
        if not is_admin():
            return jsonify({'error': '只有管理员可以清空记录'}), 403
        event_type = (request.args.get('type') or request.args.get('event') or '').strip().lower()
        if event_type not in ('upload', 'download'):
            return jsonify({'error': '请指定要清空的记录类型'}), 400
        query = ShareTransfer.query.filter(ShareTransfer.event_type == event_type).filter(
            or_(ShareTransfer.deleted_at.is_(None), ShareTransfer.deleted_at == '')
        )
        deleted = query.update({'deleted_at': datetime.now()}, synchronize_session=False)
        db.session.commit()
        logger.info(f"逻辑清空{event_type}记录: {deleted}条, IP={get_client_ip()}")
        return jsonify({'success': True, 'deleted': deleted})

    try:
        offset = max(0, int(request.args.get('offset', 0)))
        limit = min(50, max(1, int(request.args.get('limit', 20))))
    except (TypeError, ValueError):
        offset, limit = 0, 20
    event_type = (request.args.get('type') or request.args.get('event') or 'download').strip().lower()
    if event_type not in ('upload', 'download'):
        event_type = 'download'
    mine = str(request.args.get('mine', '')).lower() in ('1', 'true', 'yes')
    if not is_admin():
        mine = True
    query = ShareTransfer.query.filter(
        ShareTransfer.event_type == event_type
    ).filter(
        or_(ShareTransfer.deleted_at.is_(None), ShareTransfer.deleted_at == '')
    ).order_by(ShareTransfer.created_at.desc())
    if mine:
        query = apply_mine_filter(query)
    total = query.count()
    rows = query.offset(offset).limit(limit).all()
    items = serialize_transfer_rows(rows, include_delete_code=(event_type == 'upload'))
    if event_type == 'upload' and mine and offset == 0:
        items = prepend_my_live_uploads(items)
    return jsonify({
        'success': True,
        'total': total,
        'items': items
    })


def capture_request_info():
    sensitive = {'cookie', 'authorization'}
    headers = {k: v for k, v in request.headers.items() if k.lower() not in sensitive}
    return {
        'method': request.method,
        'path': request.path,
        'url': request.url,
        'remote_addr': request.remote_addr,
        'client_ip': get_client_ip(),
        'user_agent': request.headers.get('User-Agent', ''),
        'referrer': request.referrer,
        'query': request.args.to_dict(flat=True),
        'content_type': request.content_type,
        'headers': headers
    }


def sanitize_note_html(html):
    if not html:
        return ''
    cleaned = re.sub(r'(?is)<script.*?>.*?</script>', '', html)
    cleaned = re.sub(r'(?is)<iframe.*?>.*?</iframe>', '', cleaned)
    cleaned = re.sub(r'(?is)<style.*?>.*?</style>', '', cleaned)
    cleaned = re.sub(r'(?i)\son\w+\s*=', ' ', cleaned)
    cleaned = re.sub(r'(?i)javascript:', '', cleaned)
    cleaned = re.sub(r'(?i)data:text/html', '', cleaned)
    return cleaned.strip()


def note_is_mine(note):
    cid = get_client_device_id()
    if cid and (note.client_id or '') == cid:
        return True
    if not (note.client_id or '').strip():
        primary, ips = get_all_client_ips()
        ip_set = set([ip for ip in ([primary] + list(ips)) if ip])
        if note.client_ip in ip_set:
            return True
    return False


def note_to_dict(note):
    try:
        info = json.loads(note.request_info) if note.request_info else {}
    except Exception:
        info = {'raw': note.request_info}
    replies = sorted(
        [item for item in note.replies if not item.deleted_at],
        key=lambda item: item.created_at,
        reverse=True
    )
    mine = note_is_mine(note)
    return {
        'id': note.id,
        'parent_id': note.parent_id,
        'content': note.content,
        'client_ip': display_client_ip(note.client_ip),
        'created_at': note.created_at.strftime('%Y-%m-%d %H:%M:%S'),
        'updated_at': note.updated_at.strftime('%Y-%m-%d %H:%M:%S') if note.updated_at else None,
        'is_mine': mine,
        'can_edit': is_admin() or mine,
        'request_info': info if is_admin() else None,
        'replies': [note_to_dict(reply) for reply in replies]
    }


def soft_delete_note_tree(note):
    now = datetime.now()
    def walk(node):
        if not node.deleted_at:
            node.deleted_at = now
        for child in node.replies:
            walk(child)
    walk(note)


@app.route('/api/notes', methods=['GET', 'POST'])
@ip_access_required
def notes_collection():
    client_ip = get_client_ip()
    if request.method == 'GET':
        query = MessageNote.query.filter(
            MessageNote.parent_id.is_(None),
            MessageNote.deleted_at.is_(None)
        )
        mine = str(request.args.get('mine', '')).lower() in ('1', 'true', 'yes')
        if mine:
            cid = get_client_device_id()
            primary, ips = get_all_client_ips()
            ip_set = [ip for ip in ([primary] + list(ips)) if ip]
            clauses = []
            if cid:
                clauses.append(MessageNote.client_id == cid)
            if ip_set:
                clauses.append(and_(
                    or_(MessageNote.client_id.is_(None), MessageNote.client_id == ''),
                    MessageNote.client_ip.in_(ip_set)
                ))
            query = query.filter(or_(*clauses)) if clauses else query.filter(text('0=1'))
        notes = query.order_by(MessageNote.created_at.desc()).all()
        return jsonify({
            'success': True,
            'is_admin': is_admin(),
            'notes': [note_to_dict(n) for n in notes]
        })

    data = request.get_json(silent=True) or {}
    content = sanitize_note_html(data.get('content') or '')
    if not content or content in ('<br>', '<div><br></div>'):
        return jsonify({'error': '留言内容不能为空'}), 400
    if len(content) > 200000:
        return jsonify({'error': '留言内容过长'}), 400

    parent_id = data.get('parent_id')
    parent = None
    if parent_id is not None:
        parent = MessageNote.query.get(parent_id)
        if not parent or parent.deleted_at:
            return jsonify({'error': '要回复的留言不存在'}), 404

    note = MessageNote(
        parent_id=parent.id if parent else None,
        content=content,
        client_ip=client_ip,
        client_id=get_client_device_id() or '',
        request_info=json.dumps(capture_request_info(), ensure_ascii=False)
    )
    db.session.add(note)
    db.session.commit()
    logger.info(f"新增留言: id={note.id}, parent={note.parent_id}, IP={client_ip}")
    return jsonify({'success': True, 'note': note_to_dict(note)}), 201


@app.route('/api/notes/image', methods=['POST'])
@ip_access_required
def upload_note_image():
    client_ip = get_client_ip()
    image = request.files.get('image')
    if not image or not image.filename:
        return jsonify({'error': '请选择图片'}), 400
    ext = image.filename.rsplit('.', 1)[-1].lower() if '.' in image.filename else ''
    if ext not in ('jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'):
        return jsonify({'error': '仅支持 jpg/png/gif/webp 图片'}), 400
    folder = os.path.join('static', 'note_img')
    if not os.path.exists(folder):
        os.makedirs(folder)
    filename = f"{uuid.uuid4().hex}.{ext}"
    save_path = os.path.join(folder, filename)
    image.save(save_path)
    url = f'/static/note_img/{filename}'
    logger.info(f"留言图片上传: {url}, IP={client_ip}")
    return jsonify({'success': True, 'url': url})


@app.route('/api/notes/clear', methods=['POST'])
@ip_access_required
def clear_notes():
    if not is_admin():
        return jsonify({'error': '只有管理员可以清空留言'}), 403
    now = datetime.now()
    updated = MessageNote.query.filter(MessageNote.deleted_at.is_(None)).update(
        {'deleted_at': now}, synchronize_session=False
    )
    db.session.commit()
    logger.info(f"逻辑清空留言: {updated}条, IP={get_client_ip()}")
    return jsonify({'success': True, 'deleted': updated})


@app.route('/api/notes/<int:note_id>', methods=['DELETE', 'PUT'])
@ip_access_required
def delete_note(note_id):
    client_ip = get_client_ip()
    note = MessageNote.query.get(note_id)
    if not note or note.deleted_at:
        return jsonify({'error': '留言不存在'}), 404

    if request.method == 'PUT':
        if not (is_admin() or note_is_mine(note)):
            return jsonify({'error': '只能编辑自己的留言'}), 403
        data = request.get_json(silent=True) or {}
        content = sanitize_note_html(data.get('content') or '')
        if not content or content in ('<br>', '<div><br></div>'):
            return jsonify({'error': '留言内容不能为空'}), 400
        if len(content) > 200000:
            return jsonify({'error': '留言内容过长'}), 400
        note.content = content
        note.updated_at = datetime.now()
        db.session.commit()
        return jsonify({'success': True, 'note': note_to_dict(note)})

    if not (is_admin() or note_is_mine(note)):
        return jsonify({'error': '只能删除自己的留言'}), 403
    soft_delete_note_tree(note)
    db.session.commit()
    logger.info(f"逻辑删除留言: id={note_id}, IP={client_ip}")
    return jsonify({'success': True})


@app.route('/admin/cleanup', methods=['POST'])
def admin_cleanup():
    """
    系统清理路由
    清理孤立的文件和临时数据
    """
    client_ip = get_client_ip()
    if not session.get('admin_logged_in'):
        logger.warning(f"未登录尝试执行系统清理: IP={client_ip}")
        return jsonify({'error': '未登录'}), 401
    
    try:
        logger.info(f"开始系统清理: IP={client_ip}")
        cleanup_count = 0
        upload_folder = os.path.abspath(get_config('upload_folder', 'uploads'))
        
        # 清理孤立的文件（在磁盘上但不在数据库中的文件）
        if os.path.exists(upload_folder):
            all_files = File.query.all()
            db_files = set(f.filename_on_disk for f in all_files)
            disk_files = set(os.listdir(upload_folder))
            orphaned_files = disk_files - db_files
            
            for orphaned_file in orphaned_files:
                file_path = os.path.join(upload_folder, orphaned_file)
                try:
                    file_size = os.path.getsize(file_path)
                    os.remove(file_path)
                    cleanup_count += 1
                    logger.info(f"清理孤立文件: {orphaned_file}, 大小={file_size}字节")
                except Exception as e:
                    logger.error(f"清理文件 {orphaned_file} 时出错: {e}")
        
        # 清理 static/img 文件夹中的孤立LOGO
        img_folder = os.path.join('static', 'img')
        if os.path.exists(img_folder):
            current_logo_url = get_config('logo_url', '')
            current_logo_name = current_logo_url.split('/')[-1] if current_logo_url else ''
            
            for img_file in os.listdir(img_folder):
                # 只清理 logo_ 开头的文件，避免误删其他图片
                if img_file.startswith('logo_') and img_file != current_logo_name:
                    img_path = os.path.join(img_folder, img_file)
                    try:
                        file_size = os.path.getsize(img_path)
                        os.remove(img_path)
                        cleanup_count += 1
                        logger.info(f"清理孤立LOGO: {img_file}, 大小={file_size}字节")
                    except Exception as e:
                        logger.error(f"清理LOGO {img_file} 时出错: {e}")
        
        logger.info(f"系统清理完成: IP={client_ip}, 共清理 {cleanup_count} 个文件")
        log_system('INFO', 'admin_cleanup', f'系统清理完成，共清理 {cleanup_count} 个文件', {'client_ip': client_ip, 'cleanup_count': cleanup_count})
        return jsonify({'success': True, 'cleanup_count': cleanup_count})
    
    except Exception as e:
        logger.error(f"系统清理失败: {str(e)}, IP={client_ip}", exc_info=True)
        return jsonify({'error': f'清理失败: {str(e)}'}), 500


@app.route('/admin/reset', methods=['POST'])
def admin_reset():
    """
    系统重置路由
    重置系统到初始状态
    """
    client_ip = get_client_ip()
    if not session.get('admin_logged_in'):
        logger.warning(f"未登录尝试重置系统: IP={client_ip}")
        return jsonify({'error': '未登录'}), 401
    
    try:
        logger.warning(f"开始系统重置: IP={client_ip}")
        
        with app.app_context():
            # 确认密码（防止误操作）
            data = request.get_json()
            if not data or data.get('confirm_password') != get_config('admin_password'):
                logger.warning(f"系统重置失败: 确认密码错误, IP={client_ip}")
                return jsonify({'error': '确认密码错误'}), 400
            
            # 清空所有文件记录
            File.query.delete()
            logger.info("清空文件记录")
            
            # 重置配置为默认值（除了管理员密码）
            reset_count = 0
            for key, value in DEFAULT_CONFIGS.items():
                if key != 'admin_password':
                    set_config(key, value)
                    reset_count += 1
            logger.info(f"重置配置: 共重置 {reset_count} 项配置")
            
            # 清理上传文件夹
            upload_folder = os.path.abspath(get_config('upload_folder', 'uploads'))
            if os.path.exists(upload_folder):
                import shutil
                shutil.rmtree(upload_folder)
                os.makedirs(upload_folder)
                logger.info(f"清理上传文件夹: {upload_folder}")
            
            # 清理 static/img 文件夹中的LOGO文件
            img_folder = os.path.join('static', 'img')
            if os.path.exists(img_folder):
                for img_file in os.listdir(img_folder):
                    if img_file.startswith('logo_'):
                        img_path = os.path.join(img_folder, img_file)
                        try:
                            os.remove(img_path)
                            logger.info(f"重置时删除LOGO: {img_file}")
                        except Exception as e:
                            logger.error(f"删除LOGO {img_file} 时出错: {e}")
            
            db.session.commit()
            
            logger.warning(f"系统重置完成: IP={client_ip}")
            log_system('WARNING', 'admin_reset', '系统已重置到初始状态', {'client_ip': client_ip})
            return jsonify({'success': True})
    
    except Exception as e:
        logger.error(f"系统重置失败: {str(e)}, IP={client_ip}", exc_info=True)
        db.session.rollback()
        return jsonify({'error': f'重置失败: {str(e)}'}), 500


@app.route('/admin/stats', methods=['GET'])
def admin_stats():
    """
    系统统计路由
    获取系统统计信息
    """
    client_ip = get_client_ip()
    if not session.get('admin_logged_in'):
        logger.warning(f"未登录尝试获取统计信息: IP={client_ip}")
        return jsonify({'error': '未登录'}), 401
    
    try:
        with app.app_context():
            now = datetime.now()
            live_upload = exists().where(
                and_(
                    ShareTransfer.share_uid == File.share_uid,
                    ShareTransfer.event_type == 'upload',
                    or_(ShareTransfer.deleted_at.is_(None), ShareTransfer.deleted_at == '')
                )
            )
            any_upload = exists().where(
                and_(
                    ShareTransfer.share_uid == File.share_uid,
                    ShareTransfer.event_type == 'upload'
                )
            )
            file_q = File.query.filter(or_(live_upload, ~any_upload))
            total_files = file_q.count()
            active_files = file_q.filter(
                File.expires_at > now,
                File.current_downloads < File.max_downloads
            ).count()
            expired_files = file_q.filter(File.expires_at <= now).count()
            limit_reached_files = file_q.filter(
                File.current_downloads >= File.max_downloads
            ).count()

            upload_folder = os.path.abspath(get_config('upload_folder', 'uploads'))
            total_size = 0
            for rec in file_q.all():
                file_path = os.path.join(upload_folder, rec.filename_on_disk or '')
                if rec.filename_on_disk and os.path.isfile(file_path):
                    total_size += os.path.getsize(file_path)
            
            # 计算LOGO文件大小和数量
            img_folder = os.path.join('static', 'img')
            logo_count = 0
            logo_size = 0
            if os.path.exists(img_folder):
                for img_file in os.listdir(img_folder):
                    if img_file.startswith('logo_'):
                        logo_count += 1
                        img_path = os.path.join(img_folder, img_file)
                        if os.path.exists(img_path):
                            logo_size += os.path.getsize(img_path)
            
            # 格式化文件大小
            def format_size(size):
                for unit in ['B', 'KB', 'MB', 'GB']:
                    if size < 1024:
                        return f"{size:.2f} {unit}"
                    size /= 1024
                return f"{size:.2f} TB"
            
            logger.info(f"获取统计信息: IP={client_ip}")
            return jsonify({
                'total_files': total_files,
                'active_files': active_files,
                'expired_files': expired_files,
                'limit_reached_files': limit_reached_files,
                'total_size': format_size(total_size),
                'upload_folder': upload_folder,
                'logo_count': logo_count,
                'logo_size': format_size(logo_size),
                'img_folder': img_folder
            })
    
    except Exception as e:
        logger.error(f"获取统计信息失败: {str(e)}, IP={client_ip}", exc_info=True)
        return jsonify({'error': f'获取统计信息失败: {str(e)}'}), 500


def consume_and_record_download(file_record, client_ip):
    skip_quota = download_skips_quota(file_record)
    if datetime.now() > file_record.expires_at:
        remove_share_file(file_record, '分享时限已到')
        db.session.commit()
        return None, '文件已过期', True
    if (not skip_quota) and file_record.current_downloads >= file_record.max_downloads:
        remove_share_file(file_record, '达到最大下载次数')
        db.session.commit()
        return None, '已达到最大下载次数', True
    upload_folder = os.path.abspath(get_config('upload_folder', 'uploads'))
    file_path = os.path.join(upload_folder, file_record.filename_on_disk)
    if not os.path.exists(file_path):
        db.session.delete(file_record)
        db.session.commit()
        return None, '文件不存在', True
    if not skip_quota:
        file_record.current_downloads += 1
    file_size = os.path.getsize(file_path)
    log_access(client_ip, 'download', file_id=file_record.id, extract_code=file_record.extract_code,
               filename=file_record.original_filename, status='success', file_size=file_size)
    ensure_share_uid(file_record)
    record_share_transfer('download', file_record, client_ip)
    db.session.commit()
    should_delete = (not skip_quota) and file_record.current_downloads >= file_record.max_downloads
    return {
        'record': file_record,
        'path': file_path,
        'folder': upload_folder,
        'delete_id': file_record.id if should_delete else None
    }, None, False


@app.route('/api/speedtest', methods=['GET'])
@ip_access_required
def api_speedtest():
    try:
        size = int(request.args.get('size', 2 * 1024 * 1024))
    except (TypeError, ValueError):
        size = 2 * 1024 * 1024
    size = max(64 * 1024, min(size, 8 * 1024 * 1024))
    chunk = b'0' * 65536

    def generate():
        sent = 0
        while sent < size:
            n = min(len(chunk), size - sent)
            yield chunk[:n]
            sent += n

    return Response(generate(), mimetype='application/octet-stream', headers={
        'Content-Length': str(size),
        'Cache-Control': 'no-store, no-cache'
    })


@app.route('/api/download-bundle', methods=['POST'])
@ip_access_required
def api_download_bundle():
    client_ip = get_client_ip()
    data = request.get_json(silent=True) or {}
    codes = []
    for raw in (data.get('codes') or []):
        codes.extend(parse_share_codes(raw))
    codes.extend(parse_share_codes(data.get('text') or ''))
    seen = []
    for code in codes:
        if code not in seen:
            seen.append(code)
    if not seen:
        return jsonify({'error': '请输入提取码或删除码'}), 400

    prepared = []
    errors = []
    delete_ids = []
    seen_ids = set()
    for code in seen:
        rec = find_file_by_any_code(code)
        if not rec:
            errors.append(code + ' 无效')
            continue
        if rec.id in seen_ids:
            continue
        seen_ids.add(rec.id)
        info, err, _ = consume_and_record_download(rec, client_ip)
        if err:
            errors.append((rec.original_filename or code) + ': ' + err)
            continue
        prepared.append(info)
        if info.get('delete_id'):
            delete_ids.append(info['delete_id'])

    if not prepared:
        return jsonify({'error': '没有可下载的文件' + ((': ' + '; '.join(errors)) if errors else '')}), 400

    if len(prepared) == 1:
        only = prepared[0]
        rec = only['record']

        @after_this_request
        def delete_single(response):
            if delete_ids:
                try:
                    leftover = File.query.get(delete_ids[0])
                    if leftover:
                        remove_share_file(leftover, '达到最大下载次数')
                        db.session.commit()
                except Exception as cleanup_error:
                    logger.error(f"打包下载后删除失败: {cleanup_error}")
            return response

        return send_named_file(only['folder'], rec.filename_on_disk, rec.original_filename)

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.zip')
    tmp.close()
    used_names = {}
    try:
        with zipfile.ZipFile(tmp.name, 'w', zipfile.ZIP_DEFLATED) as archive:
            for info in prepared:
                rec = info['record']
                name = rec.original_filename or 'file'
                if name in used_names:
                    used_names[name] += 1
                    stem, ext = os.path.splitext(name)
                    name = f'{stem}_{used_names[name]}{ext}'
                else:
                    used_names[name] = 1
                zip_info = zipfile.ZipInfo(name)
                zip_info.flag_bits |= 0x800
                with open(info['path'], 'rb') as src:
                    archive.writestr(zip_info, src.read())
    except Exception as e:
        try:
            os.remove(tmp.name)
        except OSError:
            pass
        logger.error(f"打包下载失败: {e}", exc_info=True)
        return jsonify({'error': '打包失败'}), 500

    @after_this_request
    def cleanup_bundle(response):
        try:
            os.remove(tmp.name)
        except OSError:
            pass
        for fid in delete_ids:
            try:
                leftover = File.query.get(fid)
                if leftover:
                    remove_share_file(leftover, '达到最大下载次数')
                    db.session.commit()
            except Exception as cleanup_error:
                logger.error(f"打包下载后删除失败: {cleanup_error}")
        return response

    response = send_file(
        tmp.name,
        as_attachment=True,
        download_name='flash-bundle.zip',
        mimetype='application/zip'
    )
    quoted = quote('闪传打包.zip', safe='')
    response.headers['Content-Disposition'] = (
        f'attachment; filename="flash-bundle.zip"; filename*=UTF-8\'\'{quoted}'
    )
    response.headers['X-Download-Filename'] = quoted
    return response


# ==========================================
# 共享目录
# ==========================================

def get_listen_port():
    try:
        return int(load_runtime_config().get('port') or get_config('listen_port', '5000') or 5000)
    except (TypeError, ValueError):
        return 5000


def load_shared_peers():
    raw = get_config('shared_peers', '[]') or '[]'
    try:
        peers = json.loads(raw)
    except Exception:
        peers = []
    if not isinstance(peers, list):
        peers = []
    cleaned = []
    seen = set()
    for item in peers:
        if not isinstance(item, dict):
            continue
        host = str(item.get('host') or '').strip()
        try:
            port = int(item.get('port') or 5000)
        except (TypeError, ValueError):
            port = 5000
        if not host or not is_safe_peer_host(host):
            continue
        key = f'{host}:{port}'
        if key in seen:
            continue
        seen.add(key)
        cleaned.append({
            'host': host,
            'port': port,
            'label': str(item.get('label') or host).strip() or host
        })
    return cleaned


def save_shared_peers(peers):
    set_config('shared_peers', json.dumps(peers, ensure_ascii=False))


def is_safe_peer_host(host):
    """仅允许私网/本机 IP，防止 SSRF。"""
    try:
        ip = ipaddress.ip_address(str(host).strip())
        return bool(ip.is_private or ip.is_loopback or ip.is_link_local)
    except ValueError:
        return False


def shared_bool(value, default=False):
    if value is None:
        return bool(default)
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on')


SHARED_PERM_FIELDS = (
    'perm_browse',
    'perm_download',
    'perm_zip',
    'perm_upload',
    'perm_mkdir',
    'perm_delete',
    'perm_rename',
    'perm_show_hidden',
)


def parse_shared_perms(data, defaults=None):
    defaults = defaults or {}
    result = {}
    for key in SHARED_PERM_FIELDS:
        if key in (data or {}):
            result[key] = shared_bool(data.get(key))
        elif key in defaults:
            result[key] = bool(defaults[key])
        else:
            # 默认可浏览/下载/打包，其余关闭
            result[key] = key in ('perm_browse', 'perm_download', 'perm_zip')
    return result


def current_request_identity():
    primary, ips = get_all_client_ips()
    return {
        'primary': primary,
        'ips': [ip for ip in ([primary] + list(ips)) if ip],
        'client_id': get_client_device_id(),
        'is_admin': is_admin(),
    }


def can_manage_shared_dir(row, identity=None):
    identity = identity or current_request_identity()
    if identity.get('is_admin'):
        return True
    if not row:
        return False
    owner_ip = (row.owner_ip or '').strip()
    if owner_ip and owner_ip in set(identity.get('ips') or []):
        return True
    cid = (identity.get('client_id') or '').strip()
    owner_cid = (getattr(row, 'owner_client_id', None) or '').strip()
    if cid and owner_cid and cid == owner_cid:
        return True
    return False


def shared_effective_perms(row, identity=None):
    """管理员或所有者不受目录权限限制；其他人按目录配置。"""
    identity = identity or current_request_identity()
    if can_manage_shared_dir(row, identity):
        return {key: True for key in SHARED_PERM_FIELDS}
    return {key: bool(getattr(row, key, False)) for key in SHARED_PERM_FIELDS}


def shared_dir_to_dict(row, identity=None):
    identity = identity or current_request_identity()
    perms = shared_effective_perms(row, identity)
    raw = {key: bool(getattr(row, key, False)) for key in SHARED_PERM_FIELDS}
    manage = can_manage_shared_dir(row, identity)
    has_children = False
    try:
        if row.root_path and os.path.isdir(row.root_path):
            has_children = dir_has_children(row.root_path, show_hidden=perms.get('perm_show_hidden'))
    except Exception:
        has_children = False
    return {
        'id': row.id,
        'name': row.name,
        'path': row.root_path if manage else '',
        'owner_ip': row.owner_ip or '',
        'created_at': row.created_at.strftime('%Y-%m-%d %H:%M:%S') if row.created_at else '',
        'is_active': bool(row.is_active),
        'is_mine': bool(
            ((row.owner_ip or '') in set(identity.get('ips') or []))
            or (
                (identity.get('client_id') or '')
                and (getattr(row, 'owner_client_id', None) or '')
                and identity.get('client_id') == row.owner_client_id
            )
        ),
        'can_manage': manage,
        'permissions': raw,
        'effective': perms,
        'has_children': has_children,
    }


def normalize_shared_path(path):
    """支持本机路径与 UNC 网络路径（\\\\server\\share 或 //server/share）。"""
    path = str(path or '').strip().strip('"').strip("'")
    if not path:
        raise ValueError('请填写目录路径或网络地址')
    if path.startswith('\\\\') or path.startswith('//'):
        # 统一成 Windows UNC 形式，保留双斜杠前缀
        body = path.lstrip('\\/').replace('/', '\\')
        return '\\\\' + body
    return os.path.abspath(os.path.expanduser(path))


def validate_shared_root(path):
    if not os.path.isdir(path):
        raise ValueError('目录不存在或无法访问（支持本机路径或已连通的网络路径）')
    return path


def resolve_under_shared_root(root_path, rel=''):
    root = os.path.realpath(root_path)
    if not os.path.isdir(root):
        raise ValueError('共享目录不存在或不可访问')
    rel = (rel or '').replace('\\', '/').strip('/')
    parts = []
    if rel:
        for part in rel.split('/'):
            if part in ('', '.'):
                continue
            if part == '..' or '/' in part or '\\' in part:
                raise ValueError('非法路径')
            parts.append(part)
        target = os.path.realpath(os.path.join(root, *parts))
    else:
        target = root
    try:
        common = os.path.commonpath([root, target])
    except ValueError:
        raise ValueError('非法路径')
    if common != root:
        raise ValueError('非法路径')
    return root, target, '/'.join(parts)


def dir_has_children(abs_path, show_hidden=False):
    try:
        names = os.listdir(abs_path)
    except OSError:
        return False
    for name in names:
        if not show_hidden:
            if name.startswith('.'):
                continue
            try:
                import ctypes
                if os.name == 'nt':
                    attrs = ctypes.windll.kernel32.GetFileAttributesW(str(os.path.join(abs_path, name)))
                    if attrs != -1 and (attrs & 2):
                        continue
            except Exception:
                pass
        return True
    return False


def list_shared_entries(abs_path, show_hidden=False):
    entries = []
    try:
        names = os.listdir(abs_path)
    except OSError as e:
        raise ValueError(f'无法读取目录: {e}')
    for name in names:
        if not show_hidden:
            if name.startswith('.'):
                continue
            try:
                import ctypes
                if os.name == 'nt':
                    attrs = ctypes.windll.kernel32.GetFileAttributesW(str(os.path.join(abs_path, name)))
                    if attrs != -1 and (attrs & 2):
                        continue
            except Exception:
                pass
        full = os.path.join(abs_path, name)
        try:
            st = os.stat(full)
            is_dir = os.path.isdir(full)
            entries.append({
                'name': name,
                'type': 'dir' if is_dir else 'file',
                'size': 0 if is_dir else int(st.st_size),
                'mtime': datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M:%S'),
                'has_children': dir_has_children(full, show_hidden) if is_dir else False,
            })
        except OSError:
            continue
    entries.sort(key=lambda x: (0 if x['type'] == 'dir' else 1, x['name'].lower()))
    return entries


def zip_shared_paths(root_path, rels):
    """把多个相对路径打成 zip，文件夹递归打包。返回 (tmp_path, download_name)。"""
    if not rels:
        raise ValueError('请选择要下载的文件或文件夹')
    resolved = []
    for rel in rels:
        _, target, clean_rel = resolve_under_shared_root(root_path, rel)
        if not os.path.exists(target):
            raise ValueError(f'不存在: {rel}')
        resolved.append((target, clean_rel or os.path.basename(target)))

    if len(resolved) == 1 and os.path.isfile(resolved[0][0]):
        return None, resolved[0][0], os.path.basename(resolved[0][0])

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.zip')
    tmp.close()
    used = {}
    try:
        with zipfile.ZipFile(tmp.name, 'w', zipfile.ZIP_DEFLATED) as archive:
            for abs_path, arc_base in resolved:
                base_name = os.path.basename(abs_path.rstrip('\\/')) or 'item'
                if base_name in used:
                    used[base_name] += 1
                    stem, ext = os.path.splitext(base_name)
                    if os.path.isdir(abs_path):
                        zip_root = f'{base_name}_{used[base_name]}'
                    else:
                        zip_root = f'{stem}_{used[base_name]}{ext}'
                else:
                    used[base_name] = 1
                    zip_root = base_name
                if os.path.isdir(abs_path):
                    empty = True
                    for dirpath, dirnames, filenames in os.walk(abs_path):
                        for fname in filenames:
                            empty = False
                            full = os.path.join(dirpath, fname)
                            rel_inside = os.path.relpath(full, abs_path).replace('\\', '/')
                            arcname = f'{zip_root}/{rel_inside}'
                            info = zipfile.ZipInfo(arcname)
                            info.flag_bits |= 0x800
                            info.date_time = time.localtime(os.path.getmtime(full))[:6]
                            with open(full, 'rb') as src:
                                archive.writestr(info, src.read())
                    if empty:
                        info = zipfile.ZipInfo(zip_root + '/')
                        info.flag_bits |= 0x800
                        archive.writestr(info, b'')
                else:
                    info = zipfile.ZipInfo(zip_root)
                    info.flag_bits |= 0x800
                    info.date_time = time.localtime(os.path.getmtime(abs_path))[:6]
                    with open(abs_path, 'rb') as src:
                        archive.writestr(info, src.read())
    except Exception:
        try:
            os.remove(tmp.name)
        except OSError:
            pass
        raise

    zip_name = '共享目录.zip'
    if len(resolved) == 1 and os.path.isdir(resolved[0][0]):
        zip_name = (os.path.basename(resolved[0][0].rstrip('\\/')) or 'folder') + '.zip'
    return tmp.name, None, zip_name


def send_shared_download(tmp_zip, single_file, download_name):
    if single_file:
        directory, disk_name = os.path.split(single_file)
        return send_named_file(directory, disk_name, download_name)

    @after_this_request
    def cleanup_shared_zip(response):
        try:
            os.remove(tmp_zip)
        except OSError:
            pass
        return response

    response = send_file(
        tmp_zip,
        as_attachment=True,
        download_name=download_name,
        mimetype='application/zip'
    )
    quoted = quote(download_name or 'shared.zip', safe='')
    ascii_name = 'shared.zip'
    response.headers['Content-Disposition'] = (
        f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quoted}'
    )
    response.headers['X-Download-Filename'] = quoted
    return response


def peer_http_request(host, port, method, path, body=None, timeout=8, extra_headers=None, raw_body=None, content_type=None):
    if not is_safe_peer_host(host):
        raise ValueError('节点地址不合法')
    port = int(port)
    if port < 1 or port > 65535:
        raise ValueError('端口不合法')
    url = f'http://{host}:{port}{path}'
    data = raw_body
    headers = {'Accept': 'application/json, */*'}
    # 转发真实访客身份，便于对端按 IP 归属与权限判断
    try:
        primary, ips = get_all_client_ips()
        headers['X-Forwarded-For'] = ','.join([ip for ip in ([primary] + list(ips)) if ip])
        headers['X-Real-IP'] = primary or ''
        cid = get_client_device_id()
        if cid:
            headers['X-Client-Id'] = cid
    except Exception:
        pass
    if extra_headers:
        headers.update(extra_headers)
    if data is None and body is not None:
        data = json.dumps(body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    elif content_type:
        headers['Content-Type'] = content_type
    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        content = resp.read()
        content_type_resp = resp.headers.get('Content-Type', '')
        return {
            'status': resp.status,
            'headers': {k: v for k, v in resp.headers.items()},
            'content': content,
            'content_type': content_type_resp,
        }


def relay_json_response(result):
    ctype = result.get('content_type') or ''
    if 'application/json' in ctype or (result['content'][:1] in (b'{', b'[')):
        try:
            payload = json.loads(result['content'].decode('utf-8'))
        except Exception:
            payload = {'error': '节点返回无效数据'}
            return jsonify(payload), 502
        return jsonify(payload), result['status']
    return jsonify({'error': '节点返回非 JSON'}), 502


@app.route('/api/shared/info', methods=['GET'])
@ip_access_required
def api_shared_info():
    lan_ip = get_local_lan_ip()
    port = get_listen_port()
    return jsonify({
        'success': True,
        'lan_ip': lan_ip,
        'port': port,
        'base_url': f'http://{lan_ip}:{port}',
        'title': get_config('site_title', '闪传') or '闪传',
        'dir_count': SharedDir.query.filter_by(is_active=True).count(),
    })


@app.route('/api/shared/hosts', methods=['GET'])
@ip_access_required
def api_shared_hosts():
    lan_ip = get_local_lan_ip()
    port = get_listen_port()
    hosts = [{
        'key': 'local',
        'label': '本机',
        'host': lan_ip,
        'port': port,
        'is_local': True,
        'base_url': f'http://{lan_ip}:{port}',
    }]
    for peer in load_shared_peers():
        hosts.append({
            'key': f"{peer['host']}:{peer['port']}",
            'label': peer.get('label') or peer['host'],
            'host': peer['host'],
            'port': peer['port'],
            'is_local': False,
            'base_url': f"http://{peer['host']}:{peer['port']}",
        })
    return jsonify({'success': True, 'hosts': hosts})


@app.route('/api/shared/peers', methods=['GET', 'POST', 'DELETE'])
@ip_access_required
def api_shared_peers():
    if request.method == 'GET':
        return jsonify({'success': True, 'peers': load_shared_peers()})

    data = request.get_json(silent=True) or {}
    host = str(data.get('host') or '').strip()
    try:
        port = int(data.get('port') or 5000)
    except (TypeError, ValueError):
        port = 5000
    label = str(data.get('label') or host).strip() or host

    if request.method == 'POST':
        if not host or not is_safe_peer_host(host):
            return jsonify({'error': '请输入局域网 IP'}), 400
        if port < 1 or port > 65535:
            return jsonify({'error': '端口无效'}), 400
        peers = load_shared_peers()
        peers = [p for p in peers if not (p['host'] == host and int(p['port']) == port)]
        peers.append({'host': host, 'port': port, 'label': label})
        save_shared_peers(peers)
        logger.info(f"添加共享节点: {host}:{port}, IP={get_client_ip()}")
        return jsonify({'success': True, 'peers': peers})

    peers = load_shared_peers()
    peers = [p for p in peers if not (p['host'] == host and int(p['port']) == port)]
    save_shared_peers(peers)
    logger.info(f"移除共享节点: {host}:{port}, IP={get_client_ip()}")
    return jsonify({'success': True, 'peers': peers})


@app.route('/api/shared/scan', methods=['POST'])
@ip_access_required
def api_shared_scan():
    """扫描本机网段 /24 上同端口的闪传节点。"""
    data = request.get_json(silent=True) or {}
    try:
        port = int(data.get('port') or get_listen_port())
    except (TypeError, ValueError):
        port = get_listen_port()
    lan_ip = get_local_lan_ip()
    found = []
    try:
        network = ipaddress.ip_network(f'{lan_ip}/24', strict=False)
    except ValueError:
        return jsonify({'success': True, 'hosts': [], 'message': '无法确定本机网段'})

    self_ip = lan_ip

    def probe(ip_str):
        if ip_str == self_ip:
            return None
        try:
            result = peer_http_request(ip_str, port, 'GET', '/api/shared/info', timeout=0.6)
            payload = json.loads(result['content'].decode('utf-8'))
            if payload.get('success'):
                return {
                    'host': ip_str,
                    'port': port,
                    'label': payload.get('title') or ip_str,
                    'dir_count': payload.get('dir_count', 0),
                    'base_url': payload.get('base_url') or f'http://{ip_str}:{port}',
                }
        except Exception:
            return None
        return None

    hosts = [str(ip) for ip in network.hosts()]
    with ThreadPoolExecutor(max_workers=64) as pool:
        futures = [pool.submit(probe, ip) for ip in hosts]
        for fut in as_completed(futures):
            item = fut.result()
            if item:
                found.append(item)
    found.sort(key=lambda x: tuple(int(p) for p in x['host'].split('.')))
    return jsonify({'success': True, 'hosts': found, 'scanned': len(hosts), 'port': port})


@app.route('/api/shared/dirs', methods=['GET', 'POST'])
@ip_access_required
def api_shared_dirs():
    identity = current_request_identity()
    if request.method == 'GET':
        rows = SharedDir.query.filter_by(is_active=True).order_by(SharedDir.created_at.desc()).all()
        items = []
        for row in rows:
            perms = shared_effective_perms(row, identity)
            # 无浏览权且非管理者：列表中不展示
            if not perms.get('perm_browse') and not can_manage_shared_dir(row, identity):
                continue
            items.append(shared_dir_to_dict(row, identity))
        return jsonify({'success': True, 'items': items, 'is_admin': identity['is_admin']})

    data = request.get_json(silent=True) or {}
    try:
        root_path = validate_shared_root(normalize_shared_path(data.get('path')))
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    name = str(data.get('name') or '').strip()
    if not name:
        name = os.path.basename(root_path.rstrip('\\/')) or root_path
    perms = parse_shared_perms(data.get('permissions') or data)
    existing = SharedDir.query.filter_by(root_path=root_path).first()
    if existing:
        if not can_manage_shared_dir(existing, identity):
            return jsonify({'error': '该路径已被其他人共享，无权覆盖'}), 403
        existing.is_active = True
        existing.name = name
        for key, val in perms.items():
            setattr(existing, key, val)
        db.session.commit()
        logger.info(f"更新共享目录: {root_path}, IP={identity['primary']}")
        return jsonify({'success': True, 'item': shared_dir_to_dict(existing, identity)})

    row = SharedDir(
        name=name,
        root_path=root_path,
        owner_ip=identity['primary'] or '',
        owner_client_id=identity.get('client_id') or '',
        is_active=True,
        **perms
    )
    db.session.add(row)
    db.session.commit()
    logger.info(f"添加共享目录: {root_path}, owner={row.owner_ip}, IP={identity['primary']}")
    return jsonify({'success': True, 'item': shared_dir_to_dict(row, identity)})


@app.route('/api/shared/dirs/<int:dir_id>', methods=['PUT', 'DELETE'])
@ip_access_required
def api_shared_dir_update(dir_id):
    identity = current_request_identity()
    row = SharedDir.query.get(dir_id)
    if not row:
        return jsonify({'error': '共享目录不存在'}), 404
    if not can_manage_shared_dir(row, identity):
        return jsonify({'error': '只能管理自己 IP 添加的共享目录'}), 403

    if request.method == 'DELETE':
        db.session.delete(row)
        db.session.commit()
        logger.info(f"移除共享目录: id={dir_id}, path={row.root_path}, IP={identity['primary']}")
        return jsonify({'success': True})

    data = request.get_json(silent=True) or {}
    if 'name' in data and str(data.get('name') or '').strip():
        row.name = str(data.get('name')).strip()
    if 'path' in data and str(data.get('path') or '').strip():
        try:
            new_path = validate_shared_root(normalize_shared_path(data.get('path')))
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        clash = SharedDir.query.filter(SharedDir.root_path == new_path, SharedDir.id != row.id).first()
        if clash:
            return jsonify({'error': '该路径已被其他共享占用'}), 400
        row.root_path = new_path
    if 'is_active' in data:
        row.is_active = shared_bool(data.get('is_active'), True)
    perm_data = data.get('permissions') if isinstance(data.get('permissions'), dict) else data
    for key in SHARED_PERM_FIELDS:
        if key in (perm_data or {}):
            setattr(row, key, shared_bool(perm_data.get(key)))
    db.session.commit()
    logger.info(f"修改共享目录: id={dir_id}, IP={identity['primary']}")
    return jsonify({'success': True, 'item': shared_dir_to_dict(row, identity)})


@app.route('/api/shared/dirs/<int:dir_id>/browse', methods=['GET'])
@ip_access_required
def api_shared_dir_browse(dir_id):
    identity = current_request_identity()
    row = SharedDir.query.get(dir_id)
    if not row or not row.is_active:
        return jsonify({'error': '共享目录不存在'}), 404
    perms = shared_effective_perms(row, identity)
    if not perms.get('perm_browse'):
        return jsonify({'error': '没有浏览权限'}), 403
    rel = request.args.get('path') or request.args.get('rel') or ''
    try:
        root, target, clean_rel = resolve_under_shared_root(row.root_path, rel)
        if not os.path.isdir(target):
            return jsonify({'error': '不是文件夹'}), 400
        entries = list_shared_entries(target, show_hidden=perms.get('perm_show_hidden'))
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    parent = ''
    if clean_rel:
        parent = '/'.join(clean_rel.split('/')[:-1])
    return jsonify({
        'success': True,
        'dir': shared_dir_to_dict(row, identity),
        'path': clean_rel,
        'parent': parent,
        'entries': entries,
        'effective': perms,
    })


@app.route('/api/shared/dirs/<int:dir_id>/download', methods=['GET', 'POST'])
@ip_access_required
def api_shared_dir_download(dir_id):
    identity = current_request_identity()
    row = SharedDir.query.get(dir_id)
    if not row or not row.is_active:
        return jsonify({'error': '共享目录不存在'}), 404
    perms = shared_effective_perms(row, identity)
    if not perms.get('perm_download'):
        return jsonify({'error': '没有下载权限'}), 403

    if request.method == 'GET':
        rels = [request.args.get('path') or request.args.get('rel') or '']
    else:
        data = request.get_json(silent=True) or {}
        rels = data.get('paths') or data.get('rels') or []
        if isinstance(rels, str):
            rels = [rels]
        single = data.get('path') or data.get('rel')
        if single and single not in rels:
            rels = [single] + list(rels)

    rels = [str(r).replace('\\', '/').strip('/') for r in rels if str(r).strip()]
    if not rels:
        return jsonify({'error': '请选择要下载的内容'}), 400

    need_zip = len(rels) > 1
    if not need_zip:
        try:
            _, target, _ = resolve_under_shared_root(row.root_path, rels[0])
            need_zip = os.path.isdir(target)
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
    if need_zip and not perms.get('perm_zip'):
        return jsonify({'error': '没有打包下载权限'}), 403

    try:
        if len(rels) == 1:
            _, target, _ = resolve_under_shared_root(row.root_path, rels[0])
            if os.path.isfile(target):
                directory, disk_name = os.path.split(target)
                return send_named_file(directory, disk_name, os.path.basename(target))
        tmp_zip, single_file, download_name = zip_shared_paths(row.root_path, rels)
        return send_shared_download(tmp_zip, single_file, download_name)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        logger.error(f"共享目录下载失败: {e}", exc_info=True)
        return jsonify({'error': '下载失败'}), 500


@app.route('/api/shared/dirs/<int:dir_id>/upload', methods=['POST'])
@ip_access_required
def api_shared_dir_upload(dir_id):
    identity = current_request_identity()
    row = SharedDir.query.get(dir_id)
    if not row or not row.is_active:
        return jsonify({'error': '共享目录不存在'}), 404
    perms = shared_effective_perms(row, identity)
    if not perms.get('perm_upload'):
        return jsonify({'error': '没有上传权限'}), 403
    rel = request.form.get('path') or request.form.get('rel') or ''
    upload = request.files.get('file')
    if not upload or not upload.filename:
        return jsonify({'error': '没有上传文件'}), 400
    try:
        _, target_dir, clean_rel = resolve_under_shared_root(row.root_path, rel)
        if not os.path.isdir(target_dir):
            return jsonify({'error': '目标不是文件夹'}), 400
        filename = secure_filename(upload.filename) or 'upload.bin'
        # 保留中文名：secure_filename 可能清空，回退原名 basename
        if not filename or filename == 'upload.bin':
            filename = os.path.basename(upload.filename.replace('\\', '/')) or 'upload.bin'
        dest = os.path.join(target_dir, filename)
        if os.path.exists(dest) and not can_manage_shared_dir(row, identity):
            return jsonify({'error': '文件已存在'}), 400
        upload.save(dest)
        logger.info(f"共享目录上传: dir={dir_id}, path={clean_rel}/{filename}, IP={identity['primary']}")
        return jsonify({'success': True, 'name': filename, 'path': (clean_rel + '/' + filename).strip('/')})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        logger.error(f"共享目录上传失败: {e}", exc_info=True)
        return jsonify({'error': '上传失败'}), 500


@app.route('/api/shared/dirs/<int:dir_id>/mkdir', methods=['POST'])
@ip_access_required
def api_shared_dir_mkdir(dir_id):
    identity = current_request_identity()
    row = SharedDir.query.get(dir_id)
    if not row or not row.is_active:
        return jsonify({'error': '共享目录不存在'}), 404
    perms = shared_effective_perms(row, identity)
    if not perms.get('perm_mkdir'):
        return jsonify({'error': '没有新建文件夹权限'}), 403
    data = request.get_json(silent=True) or {}
    rel = data.get('path') or data.get('rel') or ''
    folder_name = str(data.get('name') or '').strip()
    if not folder_name or '/' in folder_name or '\\' in folder_name or folder_name in ('.', '..'):
        return jsonify({'error': '文件夹名称无效'}), 400
    try:
        _, target_dir, _ = resolve_under_shared_root(row.root_path, rel)
        new_dir = os.path.join(target_dir, folder_name)
        if os.path.exists(new_dir):
            return jsonify({'error': '已存在同名项'}), 400
        os.makedirs(new_dir)
        return jsonify({'success': True})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except OSError as e:
        return jsonify({'error': f'创建失败: {e}'}), 500


@app.route('/api/shared/dirs/<int:dir_id>/delete-entry', methods=['POST'])
@ip_access_required
def api_shared_dir_delete_entry(dir_id):
    identity = current_request_identity()
    row = SharedDir.query.get(dir_id)
    if not row or not row.is_active:
        return jsonify({'error': '共享目录不存在'}), 404
    perms = shared_effective_perms(row, identity)
    if not perms.get('perm_delete'):
        return jsonify({'error': '没有删除权限'}), 403
    data = request.get_json(silent=True) or {}
    paths = data.get('paths') or []
    if isinstance(paths, str):
        paths = [paths]
    single = data.get('path') or data.get('rel')
    if single:
        paths = [single] + list(paths)
    paths = [str(p).replace('\\', '/').strip('/') for p in paths if str(p).strip()]
    if not paths:
        return jsonify({'error': '请选择要删除的内容'}), 400
    try:
        for rel in paths:
            _, target, clean_rel = resolve_under_shared_root(row.root_path, rel)
            if not clean_rel:
                return jsonify({'error': '不能删除共享根目录'}), 400
            if os.path.isdir(target):
                shutil.rmtree(target)
            elif os.path.isfile(target):
                os.remove(target)
        return jsonify({'success': True})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except OSError as e:
        return jsonify({'error': f'删除失败: {e}'}), 500


@app.route('/api/shared/dirs/<int:dir_id>/rename', methods=['POST'])
@ip_access_required
def api_shared_dir_rename(dir_id):
    identity = current_request_identity()
    row = SharedDir.query.get(dir_id)
    if not row or not row.is_active:
        return jsonify({'error': '共享目录不存在'}), 404
    perms = shared_effective_perms(row, identity)
    if not perms.get('perm_rename'):
        return jsonify({'error': '没有重命名权限'}), 403
    data = request.get_json(silent=True) or {}
    rel = str(data.get('path') or data.get('rel') or '').replace('\\', '/').strip('/')
    new_name = str(data.get('name') or '').strip()
    if not rel:
        return jsonify({'error': '请指定要重命名的项'}), 400
    if not new_name or '/' in new_name or '\\' in new_name or new_name in ('.', '..'):
        return jsonify({'error': '新名称无效'}), 400
    try:
        _, target, clean_rel = resolve_under_shared_root(row.root_path, rel)
        if not clean_rel:
            return jsonify({'error': '不能重命名共享根目录'}), 400
        dest = os.path.join(os.path.dirname(target), new_name)
        if os.path.exists(dest):
            return jsonify({'error': '目标名称已存在'}), 400
        os.rename(target, dest)
        parent = '/'.join(clean_rel.split('/')[:-1])
        new_rel = (parent + '/' + new_name).strip('/')
        return jsonify({'success': True, 'path': new_rel})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except OSError as e:
        return jsonify({'error': f'重命名失败: {e}'}), 500


@app.route('/api/shared/relay/<host>/<int:port>/dirs', methods=['GET', 'POST'])
@ip_access_required
def api_shared_relay_dirs(host, port):
    try:
        if request.method == 'GET':
            result = peer_http_request(host, port, 'GET', '/api/shared/dirs')
        else:
            data = request.get_json(silent=True) or {}
            result = peer_http_request(host, port, 'POST', '/api/shared/dirs', body=data)
        return relay_json_response(result)
    except Exception as e:
        return jsonify({'error': f'无法连接节点: {e}'}), 502


@app.route('/api/shared/relay/<host>/<int:port>/dirs/<int:dir_id>', methods=['PUT', 'DELETE'])
@ip_access_required
def api_shared_relay_dir_update(host, port, dir_id):
    try:
        if request.method == 'DELETE':
            result = peer_http_request(host, port, 'DELETE', f'/api/shared/dirs/{dir_id}')
        else:
            data = request.get_json(silent=True) or {}
            result = peer_http_request(host, port, 'PUT', f'/api/shared/dirs/{dir_id}', body=data)
        return relay_json_response(result)
    except Exception as e:
        return jsonify({'error': f'无法连接节点: {e}'}), 502


@app.route('/api/shared/relay/<host>/<int:port>/dirs/<int:dir_id>/browse', methods=['GET'])
@ip_access_required
def api_shared_relay_browse(host, port, dir_id):
    rel = request.args.get('path') or request.args.get('rel') or ''
    qs = f'?path={quote(rel, safe="")}'
    try:
        result = peer_http_request(host, port, 'GET', f'/api/shared/dirs/{dir_id}/browse{qs}')
        return relay_json_response(result)
    except Exception as e:
        return jsonify({'error': f'无法连接节点: {e}'}), 502


@app.route('/api/shared/relay/<host>/<int:port>/dirs/<int:dir_id>/download', methods=['GET', 'POST'])
@ip_access_required
def api_shared_relay_download(host, port, dir_id):
    try:
        if request.method == 'GET':
            rel = request.args.get('path') or request.args.get('rel') or ''
            path = f'/api/shared/dirs/{dir_id}/download?path={quote(rel, safe="")}'
            result = peer_http_request(host, port, 'GET', path, timeout=120)
        else:
            data = request.get_json(silent=True) or {}
            path = f'/api/shared/dirs/{dir_id}/download'
            result = peer_http_request(host, port, 'POST', path, body=data, timeout=300)
    except Exception as e:
        return jsonify({'error': f'无法连接节点: {e}'}), 502

    ctype = result.get('content_type') or ''
    if 'application/json' in ctype:
        return relay_json_response(result)

    tmp = tempfile.NamedTemporaryFile(delete=False)
    tmp.write(result['content'])
    tmp.close()
    headers = result.get('headers') or {}
    download_name = 'download'
    cd = headers.get('Content-Disposition') or headers.get('content-disposition') or ''
    xname = headers.get('X-Download-Filename') or headers.get('x-download-filename')
    if xname:
        try:
            download_name = unquote(xname)
        except Exception:
            download_name = xname
    elif 'filename*=' in cd:
        try:
            download_name = unquote(cd.split("filename*=UTF-8''", 1)[1].split(';')[0].strip())
        except Exception:
            pass
    elif 'filename=' in cd:
        download_name = cd.split('filename=', 1)[1].split(';')[0].strip().strip('"')

    @after_this_request
    def cleanup_relay(response):
        try:
            os.remove(tmp.name)
        except OSError:
            pass
        return response

    response = send_file(tmp.name, as_attachment=True, download_name=download_name)
    quoted = quote(download_name or 'download', safe='')
    response.headers['Content-Disposition'] = (
        f'attachment; filename="download"; filename*=UTF-8\'\'{quoted}'
    )
    response.headers['X-Download-Filename'] = quoted
    return response


@app.route('/api/shared/relay/<host>/<int:port>/dirs/<int:dir_id>/<action>', methods=['POST'])
@ip_access_required
def api_shared_relay_action(host, port, dir_id, action):
    if action not in ('upload', 'mkdir', 'delete-entry', 'rename'):
        return jsonify({'error': '未知操作'}), 404
    try:
        if action == 'upload':
            # multipart 中继较复杂：把文件暂存后以 multipart 转发
            upload = request.files.get('file')
            if not upload:
                return jsonify({'error': '没有上传文件'}), 400
            import io
            boundary = '----FlashShareBoundary' + uuid.uuid4().hex
            rel = request.form.get('path') or ''
            file_bytes = upload.read()
            filename = upload.filename or 'upload.bin'
            body = (
                f'--{boundary}\r\n'
                f'Content-Disposition: form-data; name="path"\r\n\r\n{rel}\r\n'
                f'--{boundary}\r\n'
                f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                f'Content-Type: application/octet-stream\r\n\r\n'
            ).encode('utf-8') + file_bytes + f'\r\n--{boundary}--\r\n'.encode('utf-8')
            result = peer_http_request(
                host, port, 'POST', f'/api/shared/dirs/{dir_id}/upload',
                raw_body=body,
                content_type=f'multipart/form-data; boundary={boundary}',
                timeout=300
            )
        else:
            data = request.get_json(silent=True) or {}
            result = peer_http_request(host, port, 'POST', f'/api/shared/dirs/{dir_id}/{action}', body=data)
        return relay_json_response(result)
    except Exception as e:
        return jsonify({'error': f'无法连接节点: {e}'}), 502


@app.route('/d/<code>', methods=['GET'])
@ip_access_required
def download_or_delete_file(code):
    """
    文件下载或删除路由
    根据code判断是提取码（下载）还是删除码（删除）
    """
    client_ip = get_client_ip()
    logger.info(f"收到文件操作请求: code={code}, IP={client_ip}")
    
    # 先检查是否是删除码
    file_record = find_file_by_delete_code(code)
    if file_record:
        logger.info(f"收到删除码请求: 提取码={file_record.extract_code}, 文件名={file_record.original_filename}, IP={client_ip}")
        
        # 删除文件
        try:
            upload_folder = os.path.abspath(get_config('upload_folder', 'uploads'))
            file_path = os.path.join(upload_folder, file_record.filename_on_disk)
            file_size = os.path.getsize(file_path) if os.path.exists(file_path) else 0
            
            if os.path.exists(file_path):
                os.remove(file_path)
                logger.info(f"用户主动删除文件: {file_record.original_filename}, 大小={file_size}字节, IP={client_ip}")
        except Exception as e:
            logger.error(f"删除文件时出错: {e}")
        
        # 删除数据库记录
        db.session.delete(file_record)
        db.session.commit()
        
        # 记录删除日志
        log_access(client_ip, 'delete', file_id=file_record.id, extract_code=file_record.extract_code,
                 filename=file_record.original_filename, status='success', file_size=file_size)
        
        logger.info(f"文件删除成功: 提取码={file_record.extract_code}, IP={client_ip}")
        return jsonify({'message': '文件删除成功'}), 200
    
    # 如果不是删除码，检查是否是提取码
    file_record = find_file_by_extract_code(code)
    if not file_record:
        logger.warning(f"无效的提取码或删除码: code={code}, IP={client_ip}")
        log_access(client_ip, 'invalid_code', status='failed', error_message='无效的提取码或删除码')
        return jsonify({'error': '无效的提取码或删除码'}), 404

    logger.info(f"找到文件: 文件名={file_record.original_filename}, "
               f"提取码={code}, 当前下载次数={file_record.current_downloads}/{file_record.max_downloads}, IP={client_ip}")

    skip_quota = download_skips_quota(file_record)

    # 检查文件是否过期
    if datetime.now() > file_record.expires_at:
        logger.warning(f"文件已过期: 提取码={code}, 过期时间={file_record.expires_at}, IP={client_ip}")
        log_access(client_ip, 'download', file_id=file_record.id, extract_code=code,
                 filename=file_record.original_filename, status='failed', error_message='文件已过期')
        remove_share_file(file_record, '分享时限已到')
        db.session.commit()
        return jsonify({'error': '文件已过期'}), 410

    # 检查下载次数限制（管理员下载不消耗次数）
    if (not skip_quota) and file_record.current_downloads >= file_record.max_downloads:
        logger.warning(f"已达到最大下载次数: 提取码={code}, 次数={file_record.current_downloads}/{file_record.max_downloads}, IP={client_ip}")
        log_access(client_ip, 'download', file_id=file_record.id, extract_code=code,
                 filename=file_record.original_filename, status='failed', error_message='已达到最大下载次数')
        remove_share_file(file_record, '达到最大下载次数')
        db.session.commit()
        return jsonify({'error': '已达到最大下载次数'}), 409

    # 检查文件是否真实存在
    upload_folder = os.path.abspath(get_config('upload_folder', 'uploads'))
    file_path = os.path.join(upload_folder, file_record.filename_on_disk)
    if not os.path.exists(file_path):
        logger.error(f"文件不存在: 提取码={code}, 文件名={file_record.filename_on_disk}, IP={client_ip}")
        # 如果文件不存在，清理数据库记录
        db.session.delete(file_record)
        db.session.commit()
        log_access(client_ip, 'download', file_id=file_record.id, extract_code=code,
                 filename=file_record.original_filename, status='failed', error_message='文件不存在')
        return jsonify({'error': '文件不存在'}), 404

    # 使用数据库锁来确保原子性操作
    try:
        # 获取数据库锁
        locked_record = File.query.filter_by(id=file_record.id).with_for_update().first()
        
        if not locked_record:
            logger.error(f"无法获取锁: 文件ID={file_record.id}, IP={client_ip}")
            return jsonify({'error': '文件不存在'}), 404
        
        logger.debug(f"获取锁成功, 当前下载次数: {locked_record.current_downloads}/{locked_record.max_downloads}, IP={client_ip}")
        
        if (not skip_quota) and locked_record.current_downloads >= locked_record.max_downloads:
            logger.warning(f"已达到最大下载次数（锁保护下）: 提取码={code}, IP={client_ip}")
            log_access(client_ip, 'download', file_id=locked_record.id, extract_code=code,
                     filename=locked_record.original_filename, status='failed', error_message='已达到最大下载次数')
            remove_share_file(locked_record, '达到最大下载次数')
            db.session.commit()
            return jsonify({'error': '已达到最大下载次数'}), 409
        
        old_count = locked_record.current_downloads
        if not skip_quota:
            locked_record.current_downloads += 1
        new_count = locked_record.current_downloads
        
        db.session.commit()
        
        file_size = os.path.getsize(file_path)
        
        logger.info(f"{'不消耗下载次数' if skip_quota else '更新下载次数'}: 提取码={code}, 次数={old_count} -> {new_count}, IP={client_ip}")
        log_access(client_ip, 'download', file_id=locked_record.id, extract_code=code,
                 filename=locked_record.original_filename, status='success', file_size=file_size)
        ensure_share_uid(locked_record)
        record_share_transfer('download', locked_record, client_ip)
        db.session.commit()

        should_delete_after = (not skip_quota) and new_count >= locked_record.max_downloads
        file_id_to_delete = locked_record.id

        @after_this_request
        def delete_after_last_download(response):
            if should_delete_after:
                try:
                    rec = File.query.get(file_id_to_delete)
                    if rec:
                        remove_share_file(rec, '达到最大下载次数')
                        db.session.commit()
                except Exception as cleanup_error:
                    logger.error(f"最后一次下载后删除失败: {cleanup_error}")
            return response
        
        # 返回文件
        return send_named_file(
            upload_folder,
            locked_record.filename_on_disk,
            locked_record.original_filename
        )
        
    except Exception as e:
        db.session.rollback()
        logger.error(f"下载时出错: {str(e)}, IP={client_ip}", exc_info=True)
        log_access(client_ip, 'download', file_id=file_record.id, extract_code=code,
                 filename=file_record.original_filename, status='failed', error_message=str(e))
        return jsonify({'error': f'下载失败: {str(e)}'}), 500


@app.route('/file-info/<code>', methods=['GET'])
@ip_access_required
def get_file_info(code):
    """根据提取码获取文件详情（过期/失效也返回信息，便于弹窗展示）。"""
    client_ip = get_client_ip()
    logger.debug(f"获取文件信息: 提取码={code}, IP={client_ip}")
    item = serialize_public_file_info(code)
    if item.get('error') == '无效的提取码':
        return jsonify(item), 404
    return jsonify(item)


@app.route('/api/file-info', methods=['POST'])
@ip_access_required
def api_file_info():
    """批量查询留言中的提取码对应文件信息。"""
    data = request.get_json(silent=True) or {}
    raw_codes = data.get('codes') if isinstance(data.get('codes'), list) else []
    seen = []
    for item in raw_codes:
        for code in parse_share_codes(item):
            if code not in seen:
                seen.append(code)
    for code in parse_share_codes(data.get('text') or ''):
        if code not in seen:
            seen.append(code)
    return jsonify({
        'items': [serialize_public_file_info(code) for code in seen]
    })


# IP访问控制管理路由
@app.route('/admin/ip-access', methods=['GET', 'POST'])
@ip_access_required
def admin_ip_access():
    """
    IP访问控制管理路由
    GET: 返回管理页面
    POST: 处理IP访问控制操作
    """
    client_ip = get_client_ip()
    if not session.get('admin_logged_in'):
        logger.warning(f"未登录尝试访问IP访问控制: IP={client_ip}")
        return jsonify({'error': '未登录'}), 401
    
    if request.method == 'GET':
        logger.info(f"访问IP访问控制页面: IP={client_ip}")
        return render_template('admin_ip.html')
    
    elif request.method == 'POST':
        data = request.get_json()
        action = data.get('action')
        logger.info(f"IP访问控制操作: 动作={action}, IP={client_ip}")
        
        if action == 'add':
            # 添加新的IP访问控制规则
            ip_range = data.get('ip_range', '').strip()
            access_type = data.get('access_type')
            description = data.get('description', '')
            
            if not ip_range or access_type not in ['whitelist', 'blacklist']:
                logger.error(f"添加IP规则失败: 参数错误, IP={client_ip}")
                return jsonify({'error': '参数错误'}), 400
            
            # 验证IP范围格式
            try:
                network = ipaddress.ip_network(ip_range, strict=False)
                ip_address = str(network.network_address)
            except ValueError:
                logger.error(f"添加IP规则失败: IP范围格式错误, IP范围={ip_range}, IP={client_ip}")
                return jsonify({'error': '无效的IP范围格式'}), 400
            
            # 检查是否已存在
            existing = IPAccessControl.query.filter_by(
                ip_range=ip_range, 
                access_type=access_type
            ).first()
            if existing:
                logger.warning(f"添加IP规则失败: 规则已存在, IP范围={ip_range}, 类型={access_type}, IP={client_ip}")
                return jsonify({'error': '该IP范围已存在'}), 400
            
            # 创建新规则
            new_rule = IPAccessControl(
                ip_address=ip_address,
                ip_range=ip_range,
                access_type=access_type,
                description=description
            )
            db.session.add(new_rule)
            db.session.commit()
            
            logger.info(f"添加IP规则成功: IP范围={ip_range}, 类型={access_type}, IP={client_ip}")
            log_system('INFO', 'ip_rule_add', f'添加IP访问控制规则: {ip_range} ({access_type})', {'client_ip': client_ip, 'ip_range': ip_range, 'access_type': access_type})
            return jsonify({'success': True, 'message': 'IP访问控制规则添加成功'})
        
        elif action == 'delete':
            # 删除IP访问控制规则
            rule_id = data.get('rule_id')
            if not rule_id:
                logger.error(f"删除IP规则失败: 规则ID为空, IP={client_ip}")
                return jsonify({'error': '规则ID不能为空'}), 400
            
            rule = IPAccessControl.query.get(rule_id)
            if not rule:
                logger.warning(f"删除IP规则失败: 规则不存在, 规则ID={rule_id}, IP={client_ip}")
                return jsonify({'error': '规则不存在'}), 404
            
            db.session.delete(rule)
            db.session.commit()
            
            logger.info(f"删除IP规则成功: 规则ID={rule_id}, IP范围={rule.ip_range}, 类型={rule.access_type}, IP={client_ip}")
            log_system('INFO', 'ip_rule_delete', f'删除IP访问控制规则: {rule.ip_range} ({rule.access_type})', {'client_ip': client_ip, 'rule_id': rule_id})
            return jsonify({'success': True, 'message': 'IP访问控制规则删除成功'})
        
        elif action == 'toggle':
            # 启用/禁用IP访问控制规则
            rule_id = data.get('rule_id')
            if not rule_id:
                logger.error(f"切换IP规则状态失败: 规则ID为空, IP={client_ip}")
                return jsonify({'error': '规则ID不能为空'}), 400
            
            rule = IPAccessControl.query.get(rule_id)
            if not rule:
                logger.warning(f"切换IP规则状态失败: 规则不存在, 规则ID={rule_id}, IP={client_ip}")
                return jsonify({'error': '规则不存在'}), 404
            
            rule.is_active = not rule.is_active
            db.session.commit()
            
            status = '启用' if rule.is_active else '禁用'
            logger.info(f"切换IP规则状态成功: 规则ID={rule_id}, 状态={status}, IP={client_ip}")
            log_system('INFO', 'ip_rule_toggle', f'切换IP规则状态: {rule.ip_range} ({rule.access_type}) -> {status}', {'client_ip': client_ip, 'rule_id': rule_id, 'is_active': rule.is_active})
            return jsonify({'success': True, 'message': f'规则已{status}'})
        
        elif action == 'update_config':
            # 更新IP访问控制配置
            enabled = data.get('enabled', False)
            default_policy = data.get('default_policy', 'allow')
            log_access_flag = data.get('log_access', True)
            
            set_config('ip_access_enabled', str(enabled).lower())
            set_config('default_access_policy', default_policy)
            set_config('log_ip_access', str(log_access_flag).lower())
            
            logger.info(f"更新IP访问控制配置: 启用={enabled}, 默认策略={default_policy}, 记录日志={log_access_flag}, IP={client_ip}")
            log_system('INFO', 'ip_config_update', '更新IP访问控制配置', {'client_ip': client_ip, 'enabled': enabled, 'default_policy': default_policy, 'log_access': log_access_flag})
            return jsonify({'success': True, 'message': '配置更新成功'})
        
        else:
            logger.error(f"IP访问控制操作失败: 未知操作, 操作={action}, IP={client_ip}")
            return jsonify({'error': '未知操作'}), 400


# 添加一个单独的API路由用于获取配置数据
@app.route('/admin/ip-access-data', methods=['GET'])
@ip_access_required
def admin_ip_access_data():
    """
    获取IP访问控制配置和规则数据
    """
    client_ip = get_client_ip()
    if not session.get('admin_logged_in'):
        logger.warning(f"未登录尝试获取IP访问控制数据: IP={client_ip}")
        return jsonify({'error': '未登录'}), 401
    
    try:
        # 获取所有IP访问控制规则
        rules = IPAccessControl.query.order_by(IPAccessControl.created_at.desc()).all()
        rules_list = []
        for rule in rules:
            rules_list.append({
                'id': rule.id,
                'ip_address': rule.ip_address,
                'ip_range': rule.ip_range,
                'access_type': rule.access_type,
                'description': rule.description,
                'created_at': rule.created_at.isoformat(),
                'is_active': rule.is_active
            })
        
        logger.info(f"获取IP访问控制数据成功: 规则数={len(rules_list)}, IP={client_ip}")
        return jsonify({
            'rules': rules_list,
            'enabled': get_config('ip_access_enabled', 'false') == 'true',
            'default_policy': get_config('default_access_policy', 'allow'),
            'log_access': get_config('log_ip_access', 'true') == 'true'
        })
    
    except Exception as e:
        logger.error(f"获取IP访问控制数据失败: {str(e)}, IP={client_ip}", exc_info=True)
        return jsonify({'error': f'获取数据失败: {str(e)}'}), 500


# 获取当前客户端IP信息
@app.route('/admin/current-ip', methods=['GET'])
@ip_access_required
def admin_current_ip():
    """
    获取当前客户端IP信息
    """
    client_ip = get_client_ip()
    if not session.get('admin_logged_in'):
        logger.warning(f"未登录尝试获取当前IP信息: IP={client_ip}")
        return jsonify({'error': '未登录'}), 401
    
    is_allowed = is_ip_allowed(client_ip)
    logger.info(f"获取当前IP信息: IP={client_ip}, 允许访问={is_allowed}")
    return jsonify({
        'current_ip': client_ip,
        'is_allowed': is_allowed
    })


# ==========================================
# 后台任务
# ==========================================

def cleanup_expired_and_limit_reached_files():
    """
    定期清理过期和达到下载限制的文件
    每5分钟执行一次
    """
    logger.info("定期清理任务启动")
    
    while True:
        try:
            with app.app_context():
                now = datetime.now()
                files_to_delete = []
                upload_folder = os.path.abspath(get_config('upload_folder', 'uploads'))
                
                # 查找所有需要删除的文件
                all_files = File.query.all()
                for file_record in all_files:
                    should_delete = False
                    reason = ""
                    
                    # 检查是否过期
                    if now > file_record.expires_at:
                        should_delete = True
                        reason = "分享时限已到"
                    
                    # 检查是否达到下载次数限制
                    elif file_record.current_downloads >= file_record.max_downloads:
                        should_delete = True
                        reason = "达到最大下载次数"
                    
                    if should_delete:
                        files_to_delete.append((file_record, reason))
                
                # 删除文件和数据库记录
                delete_count = 0
                for file_record, reason in files_to_delete:
                    try:
                        remove_share_file(file_record, reason)
                        delete_count += 1
                        logger.info(f"删除文件: {file_record.original_filename} (原因: {reason})")
                        log_system('INFO', 'auto_cleanup', f'自动清理文件: {file_record.original_filename} ({reason})', 
                                {'extract_code': file_record.extract_code, 'reason': reason})
                    except Exception as e:
                        logger.error(f"删除文件 {file_record.original_filename} 时出错: {e}")
                
                if delete_count > 0:
                    db.session.commit()
                    logger.info(f"清理完成，共删除 {delete_count} 个文件")
                    log_system('INFO', 'auto_cleanup', f'定期清理完成，共删除 {delete_count} 个文件', {'delete_count': delete_count})

                # 物理清空已逻辑删除的收发记录，便于库瘦身
                purged = ShareTransfer.query.filter(ShareTransfer.deleted_at.isnot(None)).delete(synchronize_session=False)
                if purged:
                    db.session.commit()
                    logger.info(f"已物理清理逻辑删除记录 {purged} 条")
                
        except Exception as e:
            logger.error(f"定期清理时出错: {e}", exc_info=True)
        
        # 每5分钟执行一次清理
        time.sleep(300)


def startup_cleanup():
    """
    启动时清理孤立文件
    确保数据库和文件系统的一致性
    """
    try:
        with app.app_context():
            logger.info("开始启动清理")
            
            # 初始化默认配置
            init_default_configs()
            
            # 检查数据库中的文件是否都存在
            all_files = File.query.all()
            upload_folder = os.path.abspath(get_config('upload_folder', 'uploads'))
            for file_record in all_files:
                file_path = os.path.join(upload_folder, file_record.filename_on_disk)
                if not os.path.exists(file_path):
                    logger.warning(f"发现孤立的数据库记录: {file_record.original_filename}，文件不存在，删除记录")
                    db.session.delete(file_record)
            
            # 检查uploads目录中的文件是否都有数据库记录
            if os.path.exists(upload_folder):
                disk_files = set(os.listdir(upload_folder))
                db_files = set(f.filename_on_disk for f in all_files)
                orphaned_files = disk_files - db_files
                
                for orphaned_file in orphaned_files:
                    file_path = os.path.join(upload_folder, orphaned_file)
                    try:
                        os.remove(file_path)
                        logger.info(f"发现孤立的文件: {orphaned_file}，删除文件")
                    except Exception as e:
                        logger.error(f"删除孤立文件 {orphaned_file} 时出错: {e}")
            
            if len(all_files) != File.query.count() or orphaned_files:
                db.session.commit()
            
            logger.info("启动清理完成")
            log_system('INFO', 'startup_cleanup', '启动清理完成')
            
    except Exception as e:
        logger.error(f"启动清理时出错: {e}", exc_info=True)


# ==========================================
# 应用启动
# ==========================================

def main():
    # ✨ 1. 命令行参数解析
    parser = argparse.ArgumentParser(description='闪传系统')
    parser.add_argument('--port', type=int, default=None, help='运行端口（默认读取 config.json）')
    parser.add_argument('--debug', action='store_true', help='开启调试模式')
    parser.add_argument('--server', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()

    runtime = load_runtime_config()
    run_port = args.port if args.port is not None else runtime['port']
    run_host = runtime.get('host', '0.0.0.0')
    run_debug = args.debug

    logger.info("=" * 80)
    logger.info("闪传服务启动中...")
    
    # 确保所有必要的文件夹存在
    required_folders = [
        app.config['UPLOAD_FOLDER'],
        'static',
        'static/css',
        'static/js',
        'static/img',
        'static/note_img'
    ]
    
    for folder in required_folders:
        if not os.path.exists(folder):
            os.makedirs(folder)
            logger.info(f"创建文件夹: {folder}")
    
    # 初始化数据库
    with app.app_context():
        db.create_all()
        ensure_schema()
        logger.info("数据库表创建完成")
        
        # 执行启动清理
        startup_cleanup()
        
        # ✨ 2. 输出解析到的端口 (确认生效)
        logger.info(f"闪传服务启动完成，开始监听请求...")
        logger.info(f"监听端口: {run_port}")
        logger.info(f"监听地址: {run_host}:{run_port}")
        logger.info(f"调试模式: {'开启' if run_debug else '关闭'}")
        logger.info(f"定期清理任务: 每5分钟执行一次")
        logger.info(f"日志目录: {os.path.abspath(LOG_DIR)}")
        logger.info("=" * 80)
    
    # 启动定期清理线程
    cleanup_thread = threading.Thread(target=cleanup_expired_and_limit_reached_files, daemon=True)
    cleanup_thread.start()
    logger.info("定期清理线程已启动")
    
    # 启动Flask应用
    app.run(host=run_host, port=run_port, debug=run_debug)


if __name__ == '__main__':
    main()
