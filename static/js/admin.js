/**
 * 闪传 - 管理后台JavaScript脚本
 * 功能：系统配置、文件管理、统计信息、IP访问控制
 * 作者：闪传系统
 * 更新时间：2025-12-22
 * 版本：v1.0 Final (优化版)
 */

// ==========================================
// 全局变量定义
// ==========================================

/**
 * 当前配置对象
 * 存储从服务器加载的系统配置
 */
let currentConfig = {};

const DURATION_TO_HOURS = { minute: 1 / 60, hour: 1, day: 24, week: 168, month: 720 };

function durationToHours(amount, unit) {
    const n = parseFloat(amount);
    if (!(n > 0)) return 1;
    return n * (DURATION_TO_HOURS[unit] || 1);
}

function hoursToDuration(hours) {
    const mins = Math.round(Number(hours) * 60);
    if (!(mins > 0)) return { amount: 1, unit: 'hour' };
    if (mins % (30 * 24 * 60) === 0) return { amount: mins / (30 * 24 * 60), unit: 'month' };
    if (mins % (7 * 24 * 60) === 0) return { amount: mins / (7 * 24 * 60), unit: 'week' };
    if (mins % (24 * 60) === 0) return { amount: mins / (24 * 60), unit: 'day' };
    if (mins % 60 === 0) return { amount: mins / 60, unit: 'hour' };
    return { amount: mins, unit: 'minute' };
}

/**
 * 统计数据缓存
 * 避免频繁请求服务器
 */
let statsCache = null;

// ==========================================
// 页面初始化
// ==========================================

/**
 * 页面加载完成后执行
 * 初始化所有功能
 */
window.onload = function() {
    console.log('管理后台页面初始化...');
    
    // 加载当前配置
    loadConfig();
    
    // 加载统计信息
    loadStats();
    
    // 初始化事件监听器
    initEventListeners();
    bindConfirmModal();
    
    console.log('管理后台页面初始化完成');
};

/**
 * 初始化事件监听器
 * 设置所有交互元素的事件处理
 */
function initEventListeners() {
    // ======================================
    // LOGO上传监听
    // ======================================
    
    const logoUpload = document.getElementById('logo-upload');
    if (logoUpload) {
        logoUpload.addEventListener('change', handleLogoUpload);
    }
    
    // ======================================
    // LOGO URL输入监听
    // ======================================
    
    const logoUrlInput = document.getElementById('logo_url');
    if (logoUrlInput) {
        logoUrlInput.addEventListener('input', updateLogoPreview);
    }
    
    // ======================================
    // 表单输入监听（验证）
    // ======================================
    
    // 网站标题
    const siteTitleInput = document.getElementById('site_title');
    if (siteTitleInput) {
        siteTitleInput.addEventListener('input', validateSiteTitle);
    }
    
    // 最大上传大小
    const maxUploadSizeInput = document.getElementById('max_upload_size');
    if (maxUploadSizeInput) {
        maxUploadSizeInput.addEventListener('input', validateMaxUploadSize);
    }
    
    // 最大下载次数
    const maxDownloadsInput = document.getElementById('max_downloads');
    if (maxDownloadsInput) {
        maxDownloadsInput.addEventListener('input', validateMaxDownloads);
    }
    
    // 最大分享时长
    const maxExpireHoursInput = document.getElementById('max_expire_amount');
    if (maxExpireHoursInput) {
        maxExpireHoursInput.addEventListener('input', validateMaxExpireHours);
    }
    
    // 允许的文件类型
    const allowedExtensionsInput = document.getElementById('allowed_extensions');
    if (allowedExtensionsInput) {
        allowedExtensionsInput.addEventListener('input', validateAllowedExtensions);
    }
    
    // ======================================
    // 重置确认密码监听
    // ======================================
    
    const resetPasswordInput = document.getElementById('reset-confirm-password');
    if (resetPasswordInput) {
        resetPasswordInput.addEventListener('input', validateResetPassword);
    }
    
    // ======================================
    // 保存设置按钮监听 (Header中的按钮)
    // ======================================
    
    const saveButton = document.getElementById('save-button');
    if (saveButton) {
        saveButton.addEventListener('click', saveSettings);
    }
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) {
        logoutButton.addEventListener('click', logout);
    }
    
    console.log('事件监听器初始化完成');
}

// ==========================================
// 配置管理
// ==========================================

/**
 * 加载系统配置
 * 从服务器获取当前配置并更新界面
 */
function loadConfig() {
    fetch('/admin/config')
    .then(response => response.json())
    .then(data => {
        // 保存配置到全局变量
        currentConfig = data;
        
        // 填充表单
        Object.keys(data).forEach(key => {
            if (key === 'admin_password') return;
            const element = document.getElementById(key);
            if (element) {
                element.value = data[key];
            }
        });
        const fitted = hoursToDuration(data.max_expire_hours);
        const amountEl = document.getElementById('max_expire_amount');
        const unitEl = document.getElementById('max_expire_unit');
        const hoursEl = document.getElementById('max_expire_hours');
        if (amountEl) amountEl.value = fitted.amount;
        if (unitEl) unitEl.value = fitted.unit;
        if (hoursEl) hoursEl.value = data.max_expire_hours;
        
        // 更新LOGO预览
        updateLogoPreview();
        
        console.log('配置加载成功:', data);
    })
    .catch(error => {
        console.error('加载配置失败:', error);
        showMessage('加载配置失败: ' + error.message, 'error');
    })
    .finally(() => {
        hideLoading();
    });
}

/**
 * 更新LOGO预览
 * 根据LOGO URL显示预览图片
 */
function updateLogoPreview() {
    const logoUrl = document.getElementById('logo_url');
    const preview = document.getElementById('logo-preview');
    
    if (!logoUrl || !preview) return;
    
    const url = logoUrl.value || '/static/img/logo.png';
    preview.src = url;
    preview.style.display = 'block';
}

/**
 * 保存设置
 * 将表单数据发送到服务器保存
 */
function saveSettings() {
    // ======================================
    // 验证所有输入
    // ======================================
    
    if (!validateAllInputs()) {
        return;
    }
    
    // ======================================
    // 收集表单数据
    // ======================================
    
    const settings = {};
    const fields = [
        'site_title', 'site_subtitle', 'logo_url', 'header_text', 'footer_text',
        'max_upload_size', 'allowed_extensions', 'upload_folder',
        'max_downloads', 'max_expire_hours', 'expire_warn_hours', 'admin_username', 'admin_password', 'listen_port'
    ];
    
    fields.forEach(field => {
        const element = document.getElementById(field);
        if (element) {
            settings[field] = element.value;
        }
    });
    const amountEl = document.getElementById('max_expire_amount');
    const unitEl = document.getElementById('max_expire_unit');
    if (amountEl && unitEl) {
        settings.max_expire_hours = String(durationToHours(amountEl.value, unitEl.value));
    }
    
    // 如果密码为空，使用原密码
    if (!settings.admin_password) {
        settings.admin_password = currentConfig.admin_password;
    }
    
    // ======================================
    // 显示加载状态
    // ======================================
    
    showLoading('保存设置中...');
    
    // ======================================
    // 发送请求到服务器
    // ======================================
    
    fetch('/admin/config', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(settings)
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showMessage('设置保存成功！', 'success');
            
            // 更新全局配置
            Object.keys(settings).forEach(key => {
                currentConfig[key] = settings[key];
            });
            
            // 重新加载配置
            setTimeout(() => {
                loadConfig();
                loadStats();
            }, 1000);
        } else {
            showMessage('设置保存失败: ' + data.error, 'error');
        }
    })
    .catch(error => {
        console.error('保存设置失败:', error);
        showMessage('保存设置失败: ' + error.message, 'error');
    })
    .finally(() => {
        hideLoading();
    });
}

// ==========================================
// LOGO上传管理
// ==========================================

/**
 * 处理LOGO上传
 * 当用户选择LOGO图片时触发
 * 
 * @param {Event} e - 文件选择事件
 */
function handleLogoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const nameEl = document.getElementById('logo-file-name');
    if (nameEl) nameEl.textContent = file.name;
    
    // ======================================
    // 验证文件类型
    // ======================================
    
    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif'];
    if (!allowedTypes.includes(file.type)) {
        showMessage('只支持上传PNG、JPG、GIF格式的图片', 'error');
        e.target.value = '';
        return;
    }
    
    // ======================================
    // 验证文件大小（限制为2MB）
    // ======================================
    
    const maxSize = 2 * 1024 * 1024; // 2MB
    if (file.size > maxSize) {
        showMessage('图片大小不能超过2MB', 'error');
        e.target.value = '';
        return;
    }
    
    // ======================================
    // 准备上传
    // ======================================
    
    const formData = new FormData();
    formData.append('logo', file);
    
    showLoading('上传LOGO中...');
    
    // ======================================
    // 发送上传请求
    // ======================================
    
    fetch('/admin/upload-logo', {
        method: 'POST',
        body: formData
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            // 更新LOGO URL
            document.getElementById('logo_url').value = data.logo_url;
            updateLogoPreview();
            showMessage('LOGO上传成功！', 'success');
        } else {
            showMessage('LOGO上传失败: ' + data.error, 'error');
        }
    })
    .catch(error => {
        console.error('LOGO上传失败:', error);
        showMessage('LOGO上传失败: ' + error.message, 'error');
    })
    .finally(() => {
        hideLoading();
    });
}

// ==========================================
// 统计信息管理
// ==========================================

/**
 * 加载统计信息
 * 从服务器获取系统统计数据
 */
function loadStats() {
    fetch('/admin/stats')
    .then(response => response.json())
    .then(data => {
        // 更新统计数据显示
        document.getElementById('total-files').textContent = data.total_files;
        document.getElementById('active-files').textContent = data.active_files;
        document.getElementById('expired-files').textContent = data.expired_files;
        document.getElementById('limit-reached-files').textContent = data.limit_reached_files;
        document.getElementById('total-size').textContent = data.total_size;
        document.getElementById('upload-folder').textContent = data.upload_folder;
        
        // 缓存统计数据
        statsCache = data;
        
        console.log('统计信息加载成功:', data);
    })
    .catch(error => {
        console.error('获取统计信息失败:', error);
        showMessage('获取统计信息失败: ' + error.message, 'error');
    });
}

// ==========================================
// 系统管理
// ==========================================

/**
 * 清理系统缓存
 * 清理孤立的文件和临时数据
 */
function cleanupSystem() {
    showAppConfirm('确定要清理系统缓存吗? 这将删除孤立的文件和临时数据, 不会影响正常使用的文件。', '清理缓存').then(function (ok) {
        if (!ok) return;
        showLoading('清理系统缓存中...');
        fetch('/admin/cleanup', {
            method: 'POST'
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showMessage(`系统清理完成！清理了 ${data.cleanup_count} 个文件。`, 'success');
                setTimeout(() => {
                    loadStats();
                }, 1000);
            } else {
                showMessage('系统清理失败: ' + data.error, 'error');
            }
        })
        .catch(error => {
            console.error('系统清理失败:', error);
            showMessage('系统清理失败: ' + error.message, 'error');
        })
        .finally(() => {
            hideLoading();
        });
    });
}

/**
 * 重置系统
 * 删除所有文件和记录，恢复到初始状态
 */
function resetSystem() {
    // ======================================
    // 获取确认密码
    // ======================================
    
    const password = document.getElementById('reset-confirm-password').value;
    
    if (!password) {
        showMessage('请输入管理员密码', 'error');
        return;
    }

    showAppConfirm('此操作将删除所有文件和记录, 恢复到初始状态, 且不可撤销。确定继续吗?', '重置系统').then(function (ok) {
        if (!ok) return;
        showLoading('重置系统中...');
        fetch('/admin/reset', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                confirm_password: password
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showMessage('系统重置成功！页面将在3秒后刷新...', 'success');
                setTimeout(() => {
                    window.location.reload();
                }, 3000);
            } else {
                showMessage('系统重置失败: ' + data.error, 'error');
            }
        })
        .catch(error => {
            console.error('系统重置失败:', error);
            showMessage('系统重置失败: ' + error.message, 'error');
        })
        .finally(() => {
            hideLoading();
        });
    });
}

// ==========================================
// 表单验证
// ==========================================

/**
 * 验证所有输入
 * 
 * @returns {boolean} 是否通过验证
 */
function validateAllInputs() {
    let isValid = true;
    
    // 验证网站标题
    if (!validateSiteTitle()) {
        isValid = false;
    }
    
    // 验证最大上传大小
    if (!validateMaxUploadSize()) {
        isValid = false;
    }
    
    // 验证最大下载次数
    if (!validateMaxDownloads()) {
        isValid = false;
    }
    
    // 验证最大分享时长
    if (!validateMaxExpireHours()) {
        isValid = false;
    }
    
    // 验证允许的文件类型
    if (!validateAllowedExtensions()) {
        isValid = false;
    }
    
    return isValid;
}

/**
 * 验证网站标题
 * 
 * @returns {boolean} 是否有效
 */
function validateSiteTitle() {
    const input = document.getElementById('site_title');
    const value = input.value.trim();
    
    if (!value) {
        showMessage('网站标题不能为空', 'error');
        input.focus();
        return false;
    }
    
    if (value.length > 50) {
        showMessage('网站标题不能超过50个字符', 'error');
        input.focus();
        return false;
    }
    
    return true;
}

/**
 * 验证最大上传大小
 * 
 * @returns {boolean} 是否有效
 */
function validateMaxUploadSize() {
    const input = document.getElementById('max_upload_size');
    const value = parseInt(input.value);
    
    if (isNaN(value) || value < 1) {
        showMessage('最大上传大小必须大于0', 'error');
        input.focus();
        return false;
    }
    
    return true;
}

/**
 * 验证最大下载次数
 * 
 * @returns {boolean} 是否有效
 */
function validateMaxDownloads() {
    const input = document.getElementById('max_downloads');
    const value = parseInt(input.value);
    
    if (isNaN(value) || value < 1) {
        showMessage('最大下载次数必须大于0', 'error');
        input.focus();
        return false;
    }
    
    if (value > 100) {
        showMessage('最大下载次数不能超过100', 'error');
        input.focus();
        return false;
    }
    
    return true;
}

/**
 * 验证最大分享时长
 * 
 * @returns {boolean} 是否有效
 */
function validateMaxExpireHours() {
    const input = document.getElementById('max_expire_amount');
    const value = parseFloat(input && input.value);
    
    if (isNaN(value) || value < 1) {
        showMessage('分享时长必须大于0', 'error');
        if (input) input.focus();
        return false;
    }
    
    return true;
}

/**
 * 验证允许的文件类型
 * 
 * @returns {boolean} 是否有效
 */
function validateAllowedExtensions() {
    const input = document.getElementById('allowed_extensions');
    const value = input.value.trim();
    
    if (!value) {
        return true;
    }
    
    // 验证格式（英文逗号分隔）
    const extensions = value.split(',');
    for (let ext of extensions) {
        if (!/^[a-z0-9]+$/i.test(ext.trim())) {
            showMessage(`文件类型 "${ext}" 格式无效, 只能包含字母和数字`, 'error');
            input.focus();
            return false;
        }
    }
    
    return true;
}

/**
 * 验证重置确认密码
 * 
 * @returns {boolean} 是否有效
 */
function validateResetPassword() {
    const input = document.getElementById('reset-confirm-password');
    const value = input.value.trim();
    
    if (!value) {
        return true; // 不输入也可以，点击重置按钮时会再次验证
    }
    
    return true;
}

// ==========================================
// 消息提示
// ==========================================

/**
 * 显示消息提示
 * 置顶显示动画和3秒自动消失
 * 
 * @param {string} text - 消息内容
 * @param {string} type - 消息类型（'success' 或 'error'）
 */
function showMessage(text, type) {
    const successElement = document.getElementById('success-message');
    const errorElement = document.getElementById('error-message');
    
    // 1. 先隐藏所有消息，防止重叠
    if (successElement) {
        successElement.style.display = 'none';
        successElement.classList.remove('show');
    }
    if (errorElement) {
        errorElement.style.display = 'none';
        errorElement.classList.remove('show');
    }
    
    const messageElement = document.getElementById(type + '-message');
    
    if (!messageElement) {
        console.error(`找不到消息元素: ${type}-message`);
        return;
    }
    
    // 2. 设置文字并显示
    messageElement.textContent = text;
    messageElement.style.display = 'block';
    
    // 3. 添加动画类 (触发CSS中的slideDown动画)
    messageElement.classList.add('show');
    
    // 4. 3秒后自动隐藏
    setTimeout(() => {
        // 移除动画类
        messageElement.classList.remove('show');
        
        // 等待动画稍微进行一点后，彻底隐藏元素 (可选，为了视觉效果更平滑)
        setTimeout(() => {
            messageElement.style.display = 'none';
        }, 300); 
    }, 3000);
}

// ==========================================
// 加载状态管理
// ==========================================

/**
 * 显示加载状态
 * 
 * @param {string} text - 加载提示文字
 */
function showLoading(text) {
    // 如果传入文字，创建临时的加载提示
    if (text) {
        const loadingText = document.getElementById('loading-text');
        if (loadingText) {
            loadingText.textContent = text;
            loadingText.style.display = 'block';
        }
    }
    
    // 显示加载遮罩
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) {
        loadingOverlay.style.display = 'flex';
        loadingOverlay.setAttribute('aria-hidden', 'false');
    }
}

/**
 * 隐藏加载状态
 */
function hideLoading() {
    // 隐藏加载文字
    const loadingText = document.getElementById('loading-text');
    if (loadingText) {
        loadingText.style.display = 'none';
    }
    
    // 隐藏加载遮罩
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) {
        loadingOverlay.style.display = 'none';
        loadingOverlay.setAttribute('aria-hidden', 'true');
    }
}

// ==========================================
// 导出功能
// ==========================================

/**
 * 退出登录
 */
function logout() {
    showAppConfirm('确定要退出登录吗?', '退出登录').then(function (ok) {
        if (ok) window.location.href = '/admin/logout';
    });
}

// ==========================================
// 工具函数
// ==========================================

/**
 * 格式化文件大小
 * 
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的大小
 */
function formatFileSize(bytes) {
    for (let unit of ['B', 'KB', 'MB', 'GB']) {
        if (bytes < 1024) {
            return `${bytes.toFixed(2)} ${unit}`;
        }
        bytes /= 1024;
    }
    return `${bytes.toFixed(2)} TB`;
}

/**
 * 防抖函数
 * 防止函数被频繁调用
 * 
 * @param {Function} func - 要防抖的函数
 * @param {number} wait - 等待时间（毫秒）
 * @returns {Function} 防抖后的函数
 */
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

/**
 * 节流函数
 * 限制函数的执行频率
 * 
 * @param {Function} func - 要节流的函数
 * @param {number} limit - 执行间隔（毫秒）
 * @returns {Function} 节流后的函数
 */
function throttle(func, limit) {
    let inThrottle;
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// ==========================================
// IP访问控制功能
// ==========================================

// ==========================================
// IP访问控制功能
// 整合自 admin_ip.html
// 功能：加载IP信息、管理规则、更新配置
// ==========================================

/**
 * 加载当前IP信息
 * 从服务器获取当前访问者的IP地址和访问状态
 * 并显示在页面上
 */
function loadCurrentIP() {
    console.log('正在加载当前IP信息...');
    
    // 发送GET请求获取当前IP
    fetch('/admin/current-ip')
    .then(response => response.json())
    .then(data => {
        // 更新IP地址显示
        const currentIpElement = document.getElementById('current-ip');
        if (currentIpElement) {
            currentIpElement.textContent = data.current_ip;
        }
        
        // 更新访问状态显示
        const statusElement = document.getElementById('access-status');
        if (statusElement) {
            if (data.is_allowed) {
                statusElement.textContent = '✅ 允许访问';
                statusElement.className = 'status-allowed';
            } else {
                statusElement.textContent = '❌ 拒绝访问';
                statusElement.className = 'status-denied';
            }
        }
        
        console.log('当前IP信息加载成功:', data);
    })
    .catch(error => {
        console.error('加载IP信息失败:', error);
        showMessage('加载IP信息失败, 请刷新页面重试', 'error');
    });
}

/**
 * 更新IP访问控制配置
 * 保存IP访问控制的全局设置（开关、默认策略等）到服务器
 */
function updateConfig() {
    // 收集配置数据
    const config = {
        action: 'update_config',
        enabled: document.getElementById('ip-enabled').checked,
        default_policy: document.getElementById('default-policy').value,
        log_access: document.getElementById('log-access').checked
    };
    
    console.log('正在更新IP配置:', config);
    
    showLoading('正在保存配置...');
    
    // 发送POST请求保存配置
    fetch('/admin/ip-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showMessage('✅ 配置更新成功！', 'success');
            // 刷新配置显示
            loadIPConfig();
        } else {
            showMessage('❌ 配置更新失败: ' + data.error, 'error');
        }
    })
    .catch(error => {
        console.error('更新配置失败:', error);
        showMessage('❌ 配置更新失败: ' + error.message, 'error');
    })
    .finally(() => {
        hideLoading();
    });
}

/**
 * 添加新的IP访问控制规则
 * 验证输入并添加到服务器
 */
function addRule() {
    // 获取输入值
    const ipRange = document.getElementById('ip-range').value.trim();
    const accessType = document.getElementById('access-type').value;
    const description = document.getElementById('description').value.trim();
    
    // ======================================
    // 前端验证
    // ======================================
    
    // 验证IP范围是否为空
    if (!ipRange) {
        showMessage('⚠️ 请输入IP范围', 'error');
        document.getElementById('ip-range').focus();
        return;
    }
    
    // 验证IP格式（基础验证）
    // 支持 IPv4、IPv6 和 CIDR 格式
    const ipPattern = /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\/([0-9]|[1-2][0-9]|3[0-2]))?$|^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))(\/([0-9]|[1-9][0-9]|1[0-1][0-9]|12[0-8]))?$/;
    
    if (!ipPattern.test(ipRange)) {
        showMessage('⚠️ IP格式无效, 请输入有效的IP地址或CIDR格式', 'error');
        document.getElementById('ip-range').focus();
        return;
    }
    
    console.log('正在添加IP规则:', { ipRange, accessType, description });
    
    showLoading('正在添加规则...');
    
    // ======================================
    // 发送添加请求
    // ======================================
    
    fetch('/admin/ip-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'add',
            ip_range: ipRange,
            access_type: accessType,
            description: description
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showMessage('✅ 规则添加成功！', 'success');
            
            // 清空输入框
            document.getElementById('ip-range').value = '';
            document.getElementById('description').value = '';
            
            // 重新加载配置
            loadIPConfig();
        } else {
            showMessage('❌ 规则添加失败: ' + data.error, 'error');
        }
    })
    .catch(error => {
        console.error('添加规则失败:', error);
        showMessage('❌ 规则添加失败: ' + error.message, 'error');
    })
    .finally(() => {
        hideLoading();
    });
}

/**
 * 切换规则状态（启用/禁用）
 * 
 * @param {number} ruleId - 规则ID
 */
function toggleRule(ruleId) {
    console.log('正在切换规则状态:', ruleId);
    
    showLoading('正在切换状态...');
    
    // 发送切换请求
    fetch('/admin/ip-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'toggle',
            rule_id: ruleId
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showMessage('✅ 规则状态已更新', 'success');
            loadIPConfig();
        } else {
            showMessage('❌ 操作失败: ' + data.error, 'error');
        }
    })
    .catch(error => {
        console.error('切换状态失败:', error);
        showMessage('❌ 操作失败: ' + error.message, 'error');
    })
    .finally(() => {
        hideLoading();
    });
}

/**
 * 删除IP访问控制规则
 * 
 * @param {number} ruleId - 规则ID
 */
function deleteRule(ruleId) {
    showAppConfirm('确定要删除这条规则吗? 此操作不可撤销。', '删除规则').then(function (ok) {
        if (!ok) return;
        showLoading('正在删除规则...');
        fetch('/admin/ip-access', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'delete',
                rule_id: ruleId
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showMessage('规则删除成功', 'success');
                loadIPConfig();
            } else {
                showMessage('删除失败: ' + data.error, 'error');
            }
        })
        .catch(error => {
            console.error('删除失败:', error);
            showMessage('删除失败: ' + error.message, 'error');
        })
        .finally(() => {
            hideLoading();
        });
    });
}

/**
 * 更新规则数量统计
 * 
 * @param {Array} rules - 规则数组
 */
function updateRulesCount(rules) {
    const totalCount = rules.length;
    const whitelistCount = rules.filter(r => r.access_type === 'whitelist').length;
    const blacklistCount = rules.filter(r => r.access_type === 'blacklist').length;
    
    const countElement = document.getElementById('rules-count');
    if (countElement) {
        countElement.innerHTML = `
            共 <strong>${totalCount}</strong> 条规则
            （白名单 <strong>${whitelistCount}</strong> 条，黑名单 <strong>${blacklistCount}</strong> 条）
        `;
    }
}

/**
 * 更新规则列表显示
 * 
 * @param {Array} rules - 规则数组
 */
function updateRulesList(rules) {
    const container = document.getElementById('rules-list');
    
    if (!container) return;
    
    // 如果没有规则，显示空状态
    if (rules.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i>📋</i>
                <p>暂无规则</p>
                <small style="color: #999; margin-top: 10px; display: block;">
                    点击上方"添加规则"按钮创建新规则
                </small>
            </div>
        `;
        return;
    }
    
    // 生成规则列表HTML
    let html = '';
    rules.forEach(rule => {
        const typeClass = rule.access_type === 'whitelist' ? 'whitelist' : 'blacklist';
        const typeBadge = rule.access_type === 'whitelist' ? '🟢 白名单' : '🔴 黑名单';
        const statusClass = rule.is_active ? '' : 'disabled';
        const statusText = rule.is_active ? '✅ 启用' : '❌ 禁用';
        const statusClass2 = rule.is_active ? 'btn-warning' : 'btn-success';
        
        html += `
            <div class="ip-rule ${typeClass} ${statusClass}" role="listitem">
                <div>
                    <div style="margin-bottom: 8px;">
                        <span class="badge badge-${typeClass}">${typeBadge}</span>
                        <strong>${rule.ip_range}</strong>
                    </div>
                    ${rule.description ? `<p style="margin: 8px 0; font-size: 13px; color: #666; line-height: 1.4;">${rule.description}</p>` : ''}
                    <small style="color: #999; font-size: 12px;">创建时间：${new Date(rule.created_at).toLocaleString()}</small>
                </div>
                <div class="btn-group" style="margin-top: 12px;">
                    <button 
                        class="btn btn-sm ${statusClass2}" 
                        onclick="toggleRule(${rule.id})"
                        aria-label="切换规则状态"
                    >
                        ${statusText}
                    </button>
                    <button 
                        class="btn btn-sm btn-danger" 
                        onclick="deleteRule(${rule.id})"
                        aria-label="删除规则"
                    >
                        🗑️ 删除
                    </button>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

/**
 * 加载IP访问控制配置和规则
 * 从服务器获取完整的IP访问控制数据
 */
function loadIPConfig() {
    console.log('正在加载IP访问控制配置...');
    
    fetch('/admin/ip-access-data')
    .then(response => response.json())
    .then(data => {
        // 更新全局配置
        const enabledElement = document.getElementById('ip-enabled');
        if (enabledElement) {
            enabledElement.checked = data.enabled;
        }
        
        const policyElement = document.getElementById('default-policy');
        if (policyElement) {
            policyElement.value = data.default_policy;
        }
        
        const logElement = document.getElementById('log-access');
        if (logElement) {
            logElement.checked = data.log_access;
        }
        
        // 更新规则列表
        updateRulesList(data.rules);
        
        // 更新规则数量
        updateRulesCount(data.rules);
        
        console.log('IP配置加载成功:', data);
    })
    .catch(error => {
        console.error('加载配置失败:', error);
        showMessage('加载配置失败, 请刷新页面重试', 'error');
    });
}

// ==========================================
// 页面路由检测
// 根据当前URL自动加载相应的功能
// ==========================================

/**
 * 页面加载完成后执行
 */
document.addEventListener('DOMContentLoaded', function() {
    const currentPath = window.location.pathname;
    if (currentPath === '/admin/ip-access' || currentPath === '/admin/ip') {
        setTimeout(() => {
            loadCurrentIP();
            loadIPConfig();
        }, 100);
    }
});

let confirmResolver = null;

function showAppConfirm(message, title) {
    return new Promise(function (resolve) {
        confirmResolver = resolve;
        const titleEl = document.getElementById('confirm-title');
        const msgEl = document.getElementById('confirm-message');
        if (titleEl) titleEl.textContent = title || '确认操作';
        if (msgEl) msgEl.textContent = message;
        const modal = document.getElementById('confirm-modal');
        if (modal) modal.style.display = 'flex';
    });
}

function closeConfirmModal(ok) {
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.style.display = 'none';
    const fn = confirmResolver;
    confirmResolver = null;
    if (fn) fn(!!ok);
}

function bindConfirmModal() {
    const confirmOk = document.getElementById('confirm-ok');
    const confirmCancel = document.getElementById('confirm-cancel');
    const modal = document.getElementById('confirm-modal');
    if (confirmOk) confirmOk.addEventListener('click', function () { closeConfirmModal(true); });
    if (confirmCancel) confirmCancel.addEventListener('click', function () { closeConfirmModal(false); });
    if (modal) {
        modal.addEventListener('click', function (e) {
            if (e.target === modal) closeConfirmModal(false);
        });
    }
    document.addEventListener('keydown', function (e) {
        if (!modal) return;
        const visible = window.getComputedStyle(modal).display !== 'none';
        if (!visible) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeConfirmModal(false);
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
            e.preventDefault();
            e.stopPropagation();
            closeConfirmModal(true);
        }
    });
}

function togglePasswordVisible(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    if (btn) {
        btn.classList.toggle('is-visible', show);
        btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
    }
}
