/**
 * 闪传 - 主页面JavaScript脚本
 * 版本：终极修复版
 * 修复内容：
 * 1. 修复配置读取接口 (从 /admin/config 改为 /api/config)
 * 2. 修复公网 IP 访问时剪贴板 API 崩溃问题
 * 3. 修复输入框读取逻辑 (适配 index.html ID，增加容错)
 * 作者：闪传系统
 */

// ==========================================
// 全局变量定义
// ==========================================

let uploadHistory = JSON.parse(localStorage.getItem('uploadHistory') || '[]');
let downloadHistory = JSON.parse(localStorage.getItem('downloadHistory') || '[]');
let uploadDisplayedCount = 5;
let downloadDisplayedCount = 5;
let uploadLoading = false;
let downloadLoading = false;
let uploadOffset = 0;
let downloadOffset = 0;
let uploadHasMore = true;
let downloadHasMore = true;
let currentExtractCode = '';
let uploadMineOnly = true;
let downloadMineOnly = true;
let isAdminUser = false;
let notesMineOnly = false;
let noteEditEditors = {};
let lastUploadItems = [];
let lastDownloadItems = [];

function getClientId() {
    const key = 'lM_client_id';
    let id = localStorage.getItem(key);
    if (!id || id.length < 8) {
        id = (window.crypto && crypto.randomUUID)
            ? crypto.randomUUID().replace(/-/g, '')
            : ('c' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10));
        localStorage.setItem(key, id);
    }
    document.cookie = 'client_id=' + encodeURIComponent(id) + ';path=/;max-age=31536000;SameSite=Lax';
    return id;
}

function apiFetch(url, options) {
    options = options || {};
    const headers = Object.assign({ 'X-Client-Id': getClientId() }, options.headers || {});
    options.headers = headers;
    options.credentials = options.credentials || 'same-origin';
    return fetch(url, options);
}

/**
 * 系统配置对象
 * 默认值会在页面加载时被服务器配置覆盖
 */
let systemConfig = {
    max_upload_size: 50,
    max_downloads: 10,
    max_expire_hours: 72,
    expire_warn_hours: 1,
    allowed_extensions: ''
};

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

function getPickerExpireHours() {
    const modeEl = document.getElementById('expire_mode');
    if (modeEl && modeEl.value === 'datetime') {
        const dt = document.getElementById('expire_datetime');
        if (!dt || !dt.value) return 24;
        const ms = new Date(dt.value).getTime() - Date.now();
        return Math.max(ms / 3600000, 1 / 60);
    }
    const amountEl = document.getElementById('expire_amount');
    const unitEl = document.getElementById('expire_unit');
    return durationToHours(amountEl ? amountEl.value : 24, unitEl ? unitEl.value : 'hour');
}

function getExpireAtValue() {
    const modeEl = document.getElementById('expire_mode');
    const dt = document.getElementById('expire_datetime');
    if (modeEl && modeEl.value === 'datetime' && dt && dt.value) return dt.value;
    return '';
}

function toggleExpireMode() {
    const modeEl = document.getElementById('expire_mode');
    const durationBox = document.getElementById('expire-duration-box');
    const dateBox = document.getElementById('expire-datetime-box');
    const dt = document.getElementById('expire_datetime');
    const isDt = modeEl && modeEl.value === 'datetime';
    if (durationBox) durationBox.style.display = isDt ? 'none' : 'flex';
    if (dateBox) dateBox.style.display = isDt ? 'flex' : 'none';
    if (dt) {
        dt.style.display = '';
        if (isDt && !dt.value) {
            const hours = durationToHours(
                (document.getElementById('expire_amount') || {}).value || 24,
                (document.getElementById('expire_unit') || {}).value || 'hour'
            );
            dt.value = toDatetimeLocalValue(new Date(Date.now() + hours * 3600000));
        }
        const maxEnd = new Date(Date.now() + (systemConfig.max_expire_hours || 72) * 3600000);
        dt.min = toDatetimeLocalValue(new Date());
        dt.max = toDatetimeLocalValue(maxEnd);
    }
}

function toDatetimeLocalValue(dateOrText) {
    const date = dateOrText instanceof Date ? dateOrText : new Date(String(dateOrText).replace(' ', 'T'));
    if (isNaN(date.getTime())) return '';
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

// ==========================================
// 系统配置管理
// ==========================================

/**
 * 加载系统配置
 * 从 /api/config 接口获取最新配置
 */
async function loadSystemConfig() {
    try {
        // 使用公开接口 /api/config (无需登录)
        const response = await apiFetch('/api/config');
        
        if (response.ok) {
            const config = await response.json();
            
            // 更新全局配置
            systemConfig = {
                max_upload_size: parseInt(config.max_upload_size) || 50,
                max_downloads: parseInt(config.max_downloads) || 10,
                max_expire_hours: parseFloat(config.max_expire_hours) || 72,
                expire_warn_hours: parseFloat(config.expire_warn_hours) || 1,
                allowed_extensions: config.allowed_extensions || ''
            };
            
            console.log('系统配置加载成功:', systemConfig);
            
            // 更新界面限制
            updateFrontendLimits();
            updateConfigDisplay();
        } else {
            console.warn('加载配置失败，使用默认值');
        }
    } catch (error) {
        console.error('加载系统配置失败:', error);
        console.log('使用默认配置:', systemConfig);
    }
}

function updateFrontendLimits() {
    const maxDownloadsSelect = document.getElementById('max_downloads');
    if (maxDownloadsSelect) {
        maxDownloadsSelect.max = systemConfig.max_downloads;
        // 确保当前值不超限
        const current = parseInt(maxDownloadsSelect.value) || 1;
        maxDownloadsSelect.value = Math.min(current, systemConfig.max_downloads);
    }
    
    const expireHoursSelect = document.getElementById('expire_hours');
    const amountEl = document.getElementById('expire_amount');
    const unitEl = document.getElementById('expire_unit');
    const modeEl = document.getElementById('expire_mode');
    if (amountEl && unitEl && (!modeEl || modeEl.value !== 'datetime')) {
        let hours = getPickerExpireHours();
        if (hours > systemConfig.max_expire_hours) {
            const fitted = hoursToDuration(systemConfig.max_expire_hours);
            amountEl.value = fitted.amount;
            unitEl.value = fitted.unit;
            hours = systemConfig.max_expire_hours;
        }
        if (expireHoursSelect) expireHoursSelect.value = String(hours);
    } else if (expireHoursSelect && (!modeEl || modeEl.value !== 'datetime')) {
        expireHoursSelect.max = systemConfig.max_expire_hours;
        const current = parseFloat(expireHoursSelect.value) || 24;
        expireHoursSelect.value = Math.min(current, systemConfig.max_expire_hours);
    }
    toggleExpireMode();
}

function updateConfigDisplay() {
    const maxSizeDisplay = document.getElementById('max-size-display');
    if (maxSizeDisplay) maxSizeDisplay.textContent = `${systemConfig.max_upload_size}MB`;
    
    const maxDownloadsDisplay = document.getElementById('max-downloads-display');
    if (maxDownloadsDisplay) maxDownloadsDisplay.textContent = `${systemConfig.max_downloads}次`;
    
    const maxHoursDisplay = document.getElementById('max-hours-display');
    if (maxHoursDisplay) maxHoursDisplay.textContent = `${systemConfig.max_expire_hours}小时`;
}

// ==========================================
// 页面切换管理
// ==========================================

function showPage(page) {
    const mainPage = document.getElementById('main-page');
    const historyPage = document.getElementById('history-page');
    const notesPage = document.getElementById('notes-page');
    const sharedPage = document.getElementById('shared-page');
    if (mainPage) mainPage.style.display = page === 'main' ? 'block' : 'none';
    if (historyPage) historyPage.style.display = page === 'history' ? 'block' : 'none';
    if (notesPage) {
        if (page === 'notes') {
            notesPage.style.display = 'block';
            initNoteEditor();
            restoreWangSelection(noteEditor);
            loadNotes();
        } else {
            notesPage.style.display = 'none';
        }
    }
    if (sharedPage) {
        if (page === 'shared') {
            sharedPage.style.display = 'block';
            loadSharedPage();
        } else {
            sharedPage.style.display = 'none';
        }
    }

    const navLinks = document.querySelectorAll('.nav a');
    navLinks.forEach(link => link.classList.remove('active'));

    if (event && event.target) {
        event.target.classList.add('active');
    }

    if (page === 'history') {
        updateHistoryPage();
    }
}

// ==========================================
// 文件上传功能
// ==========================================

function handleFileUpload(event) {
    const files = event.target && event.target.files;
    if (!files || !files.length) return;
    const items = Array.from(files).map(file => ({
        file: file,
        path: file.webkitRelativePath || file.name
    }));
    startUpload(items);
    event.target.value = '';
}

function handleFolderUpload(event) {
    handleFileUpload(event);
}

function startUpload(items) {
    if (!items || !items.length) return;
    const maxSizeMB = systemConfig.max_upload_size;
    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    const allowedExtensions = (systemConfig.allowed_extensions || '').split(',').map(item => item.trim()).filter(Boolean);
    let totalSize = 0;
    for (const item of items) {
        totalSize += item.file.size || 0;
        const name = item.path || item.file.name;
        const fileExtension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
        if (allowedExtensions.length > 0 && !allowedExtensions.includes(fileExtension)) {
            showError(`不支持的文件类型: ${fileExtension}, 支持的类型: ${allowedExtensions.join(', ')}`);
            return;
        }
    }
    if (totalSize > maxSizeBytes) {
        showError(`文件大小超过限制（最大 ${maxSizeMB}MB）`);
        return;
    }

    const formData = new FormData();
    items.forEach(item => {
        formData.append('files', item.file, item.file.name);
        formData.append('paths', item.path || item.file.name);
    });
    formData.append('max_downloads', Math.min(
        parseInt(document.getElementById('max_downloads').value, 10) || 3,
        systemConfig.max_downloads
    ));
    formData.append('expire_hours', Math.min(
        getPickerExpireHours(),
        systemConfig.max_expire_hours
    ));
    const expireAt = getExpireAtValue();
    if (expireAt) formData.append('expires_at', expireAt);

    showTransferProgress('正在上传', '准备上传...');
    xhrWithProgress('/upload', {
        method: 'POST',
        body: formData,
        responseType: 'json',
        onUploadProgress: function (loaded, total) {
            updateTransferProgress(
                loaded,
                total,
                '已上传 ' + formatProgressSize(loaded) + (total ? ' / ' + formatProgressSize(total) : '')
            );
        }
    }).then(function (result) {
        const data = result.response || {};
        if (!result.ok) {
            throw new Error(data.error || ('上传失败 (' + result.status + ')'));
        }
        updateTransferProgress(1, 1, '上传完成');
        if (data.success) {
            const extractCodeEl = document.getElementById('extract-code-text');
            const deleteCodeEl = document.getElementById('delete-code-text');
            if (extractCodeEl) extractCodeEl.textContent = data.extract_code;
            if (deleteCodeEl) deleteCodeEl.textContent = data.delete_code;
            currentExtractCode = data.extract_code;
            const extractIndicator = document.getElementById('extract-copy-indicator');
            if (extractIndicator) {
                extractIndicator.textContent = '点击复制';
                extractIndicator.className = 'copy-indicator pending';
            }
            const deleteIndicator = document.getElementById('delete-copy-indicator');
            if (deleteIndicator) {
                deleteIndicator.textContent = '点击复制';
                deleteIndicator.className = 'copy-indicator pending';
            }
            const modal = document.getElementById('success-modal');
            if (modal) modal.style.display = 'flex';
            uploadHistory.unshift({
                id: Date.now(),
                shareUid: data.share_uid,
                filename: data.filename,
                extractCode: data.extract_code,
                deleteCode: data.delete_code,
                time: new Date().toLocaleString(),
                maxDownloads: data.max_downloads,
                expireHours: data.expire_hours
            });
            localStorage.setItem('uploadHistory', JSON.stringify(uploadHistory));
        } else {
            showError('上传失败: ' + (data.error || '未知错误'));
        }
    }).catch(function (error) {
        showError('上传过程中发生错误: ' + (error.message || error));
    }).finally(function () {
        hideTransferProgress();
    });
}

// ==========================================
// 文件下载/删除功能
// ==========================================

function markCodeTyped(el) {
    if (el) el.dataset.typed = '1';
}

function isBrowserAutofillValue(value) {
    const v = (value || '').trim().toLowerCase();
    return v === 'admin' || v === 'admi' || v === 'adm';
}

function stripAutofilledCodes() {
    ['extract-code', 'delete-code'].forEach(function (id) {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.dataset.typed === '1' && document.activeElement === el) return;
        if (isBrowserAutofillValue(el.value)) {
            el.value = '';
            el.dataset.typed = '';
            updateButtonText();
        }
    });
}

function guardReceiveCodeAutofill() {
    stripAutofilledCodes();
    [0, 50, 150, 400, 1000].forEach(function (ms) {
        setTimeout(stripAutofilledCodes, ms);
    });
    window.addEventListener('pageshow', stripAutofilledCodes);
    ['extract-code', 'delete-code'].forEach(function (id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('animationstart', function () {
            if (el.dataset.typed !== '1') stripAutofilledCodes();
        });
        el.addEventListener('change', function () {
            if (el.dataset.typed !== '1') stripAutofilledCodes();
        });
    });
}

function updateButtonText() {
    const deleteCode = document.getElementById('delete-code');
    const actionButton = document.getElementById('action-button');
    
    if (!deleteCode || !actionButton) return;
    if (deleteCode.value) {
        actionButton.textContent = '删除文件';
        actionButton.className = 'btn btn-danger';
    } else {
        actionButton.textContent = '下载文件';
        actionButton.className = 'btn btn-primary';
    }
}

function sanitizeShareCodeInput(raw) {
    return String(raw || '').replace(/[^A-Za-z0-9,，]/g, '');
}

function splitShareCodes(raw) {
    return sanitizeShareCodeInput(raw).split(/[,，]/).map(function (item) {
        return item.trim().toUpperCase();
    }).filter(Boolean);
}

async function confirmManyFilesDownload(count) {
    if (!(count > 2)) return true;
    return showAppConfirm('文件为 ' + count + ' 个，是否确认下载？', '确认下载');
}

function handleReceive() {
    const extractCodeEl = document.getElementById('extract-code');
    const deleteCodeEl = document.getElementById('delete-code');
    if (!extractCodeEl || !deleteCodeEl) {
        showAppAlert('系统错误: 找不到输入框, 请刷新页面重试。');
        return;
    }
    extractCodeEl.value = sanitizeShareCodeInput(extractCodeEl.value);
    deleteCodeEl.value = sanitizeShareCodeInput(deleteCodeEl.value);

    const extractCodes = splitShareCodes(extractCodeEl.value);
    const deleteCodes = splitShareCodes(deleteCodeEl.value);
    if (!extractCodes.length && !deleteCodes.length) {
        showError('请输入提取码或删除码');
        return;
    }

    if (!extractCodes.length && deleteCodes.length === 1) {
        showLoading();
        apiFetch('/d/' + encodeURIComponent(deleteCodes[0]))
            .then(async function (response) {
                if (!response.ok) {
                    let errorMessage = '操作失败';
                    try {
                        const data = await response.json();
                        errorMessage = data.error || errorMessage;
                    } catch (e) {}
                    throw new Error(errorMessage);
                }
                const data = await response.json();
                showSuccess(data.message || '文件删除成功');
                extractCodeEl.value = '';
                deleteCodeEl.value = '';
                updateButtonText();
            })
            .catch(function (error) {
                showError(error.message);
            })
            .finally(hideLoading);
        return;
    }

    const codes = extractCodes.concat(deleteCodes);
    confirmManyFilesDownload(codes.length).then(function (ok) {
        if (!ok) return;
        downloadBundle(codes, extractCodeEl, deleteCodeEl);
    });
}

async function downloadBundle(codes, extractCodeEl, deleteCodeEl) {
    showTransferProgress('正在下载', '正在请求文件...');
    try {
        const response = await apiFetch('/api/download-bundle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codes: codes })
        });
        if (!response.ok) {
            let errorMessage = '下载失败';
            try {
                const data = await response.json();
                errorMessage = data.error || errorMessage;
            } catch (e) {}
            throw new Error(errorMessage);
        }
        const blob = await readResponseWithProgress(response, function (loaded, total) {
            updateTransferProgress(
                loaded,
                total,
                '已下载 ' + formatProgressSize(loaded) + (total ? ' / ' + formatProgressSize(total) : '')
            );
        });
        updateTransferProgress(1, 1, '下载完成');
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filenameFromDownloadResponse(response);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        if (extractCodeEl) extractCodeEl.value = '';
        if (deleteCodeEl) deleteCodeEl.value = '';
        updateButtonText();
        showSuccess(codes.length > 1 ? '已打包下载 ' + codes.length + ' 个文件' : '文件下载成功');
        if (document.getElementById('history-page') && document.getElementById('history-page').style.display !== 'none') {
            updateDownloadHistory();
        }
    } catch (error) {
        showError(error.message);
    } finally {
        hideTransferProgress();
    }
}

async function runSpeedTest() {
    showLoading();
    try {
        const size = 2 * 1024 * 1024;
        const started = performance.now();
        const response = await apiFetch('/api/speedtest?size=' + size + '&t=' + Date.now());
        if (!response.ok) throw new Error('测速失败');
        const buf = await response.arrayBuffer();
        const seconds = Math.max((performance.now() - started) / 1000, 0.001);
        const bps = buf.byteLength / seconds;
        let text;
        if (bps >= 1024 * 1024) {
            text = (bps / (1024 * 1024)).toFixed(2) + ' MB/S';
        } else if (bps >= 1024) {
            text = (bps / 1024).toFixed(2) + ' KB/S';
        } else {
            text = bps.toFixed(0) + ' B/S';
        }
        showSuccess('当前网速 ' + text);
    } catch (error) {
        showError(error.message || '测速失败');
    } finally {
        hideLoading();
    }
}

// ==========================================
// 历史记录管理
// ==========================================

function updateHistoryPage() {
    updateUploadHistory();
    updateDownloadHistory();
}

function setTransferFilter(kind, mineOnly) {
    if (kind === 'upload') {
        uploadMineOnly = mineOnly;
        document.getElementById('filter-upload-all').classList.toggle('active', !mineOnly);
        document.getElementById('filter-upload-mine').classList.toggle('active', mineOnly);
        updateUploadHistory();
    } else {
        downloadMineOnly = mineOnly;
        document.getElementById('filter-download-all').classList.toggle('active', !mineOnly);
        document.getElementById('filter-download-mine').classList.toggle('active', mineOnly);
        updateDownloadHistory();
    }
}

function formatRemainText(expiresAt) {
    if (!expiresAt) return '已过期';
    const end = new Date(String(expiresAt).replace(' ', 'T'));
    if (isNaN(end.getTime())) return '';
    let totalSec = Math.floor((end.getTime() - Date.now()) / 1000);
    if (totalSec <= 0) return '已过期';
    const year = Math.floor(totalSec / (365 * 24 * 3600));
    totalSec %= 365 * 24 * 3600;
    const month = Math.floor(totalSec / (30 * 24 * 3600));
    totalSec %= 30 * 24 * 3600;
    const day = Math.floor(totalSec / 86400);
    totalSec %= 86400;
    const hour = Math.floor(totalSec / 3600);
    totalSec %= 3600;
    const minute = Math.floor(totalSec / 60);
    const second = totalSec % 60;
    const parts = [['年', year], ['月', month], ['天', day], ['时', hour], ['分', minute], ['秒', second]];
    let started = false;
    const out = [];
    parts.forEach(function (pair) {
        if (!started && pair[1] === 0) return;
        started = true;
        out.push(pair[1] + pair[0]);
    });
    return out.length ? out.join('') : '0秒';
}

function expireBlock(item) {
    if (!item.expires_at) {
        return '<div class="expire-countdown">已经过期</div>';
    }
    if (item.expired || !item.file_available) {
        return `<div class="expire-countdown" data-expires="${escapeHtml(item.expires_at)}">到期 ${escapeHtml(item.expires_at)} · 已经过期</div>`;
    }
    return `<div class="expire-countdown" data-expires="${escapeHtml(item.expires_at)}">到期 ${escapeHtml(item.expires_at)} · ${formatRemainText(item.expires_at)}</div>`;
}

function refreshExpireCountdowns() {
    document.querySelectorAll('.expire-countdown[data-expires]').forEach(function (el) {
        const expires = el.getAttribute('data-expires');
        el.textContent = '到期 ' + expires + ' · ' + formatRemainText(expires);
    });
}

if (!window._expireCountdownTimer) {
    window._expireCountdownTimer = setInterval(refreshExpireCountdowns, 1000);
}

function matchesHistoryFilters(item, kind) {
    const needDl = document.getElementById('filter-' + kind + '-downloadable');
    const needLive = document.getElementById('filter-' + kind + '-unexpired');
    if (needDl && needDl.checked && !item.downloadable) return false;
    if (needLive && needLive.checked && item.expired) return false;
    return true;
}

function toggleSelectAllTransfers(kind) {
    const rootId = kind === 'download' ? 'download-history-content' : 'upload-history-content';
    const boxes = Array.from(document.querySelectorAll('#' + rootId + ' .share-pick:not(:disabled)'));
    if (!boxes.length) {
        showError('当前没有可选记录');
        return;
    }
    const allChecked = boxes.every(function (box) { return box.checked; });
    boxes.forEach(function (box) { box.checked = !allChecked; });
}

async function copyMergedShareCodes(kind) {
    const rootId = kind === 'download' ? 'download-history-content' : 'upload-history-content';
    const boxes = document.querySelectorAll('#' + rootId + ' .share-pick:checked');
    const selected = [];
    boxes.forEach(function (box) {
        const extract = box.getAttribute('data-extract');
        const filename = box.getAttribute('data-filename') || '';
        const hours = parseFloat(box.getAttribute('data-remain-hours') || '0');
        if (extract) selected.push({ extract: extract, filename: filename, hours: hours });
    });
    if (!selected.length) {
        showError('请先勾选要合并分享的文件');
        return;
    }
    const warnHours = parseFloat(systemConfig.expire_warn_hours) || 0;
    const soon = warnHours > 0 ? selected.filter(function (item) { return item.hours < warnHours; }) : [];
    const text = selected.map(function (item) { return item.extract; }).join(',');
    try {
        await copyTextToClipboard(text);
    } catch (e) {
        showAppAlert('请手动复制: ' + text);
        return;
    }
    if (soon.length) {
        const lines = soon.map(function (item) {
            return '文件名' + item.filename + ' 分享码' + item.extract + ' 以及不足 ' + warnHours + ' 小时, 注意文件过期';
        }).join('\n');
        await showAppAlert(lines, '即将过期提醒');
    }
    showSuccess('已复制 ' + selected.length + ' 个提取码');
}

async function updateUploadHistory(append) {
    const content = document.getElementById('upload-history-content');
    if (!content) return;
    if (uploadLoading) return;
    if (append && !uploadHasMore) return;
    uploadLoading = true;
    try {
        if (!append) {
            uploadOffset = 0;
            uploadHasMore = true;
            lastUploadItems = [];
        }
        const mine = uploadMineOnly ? '1' : '0';
        const response = await apiFetch('/api/transfer-logs?type=upload&mine=' + mine + '&offset=' + uploadOffset + '&limit=20');
        const data = await response.json();
        const page = data.items || [];
        if (!append) lastUploadItems = page;
        else lastUploadItems = lastUploadItems.concat(page);
        uploadOffset = lastUploadItems.length;
        uploadHasMore = page.length >= 20;
        const items = lastUploadItems.filter(function (item) { return matchesHistoryFilters(item, 'upload'); });
        if (!lastUploadItems.length) {
            content.innerHTML = `
                <div class="empty-state">
                    <i>📂</i>
                    <p>${uploadMineOnly ? '暂无我的上传记录' : '暂无上传记录'}</p>
                </div>
            `;
            return;
        }
        if (!items.length) {
            content.innerHTML = `
                <div class="empty-state">
                    <i>📂</i>
                    <p>没有符合筛选条件的上传记录</p>
                </div>
            `;
            return;
        }
        const scrollTop = content.scrollTop;
        content.innerHTML = items.map(renderUploadHistoryItem).join('');
        if (append) content.scrollTop = scrollTop;
    } catch (error) {
        if (!append) content.innerHTML = `<div class="empty-state"><p>加载上传记录失败</p></div>`;
    } finally {
        uploadLoading = false;
    }
}

function historyActionBtn(label, enabled, onclickAttr) {
    if (enabled) {
        return `<button type="button" class="filter-btn" onclick="${onclickAttr}">${label}</button>`;
    }
    return `<button type="button" class="filter-btn" disabled title="已过期或不可用">${label}</button>`;
}

function renderUploadHistoryItem(item) {
    const extract = item.extract_code || '';
    const del = item.delete_code || '';
    const share = item.share || {};
    const canEdit = !!share.can_edit;
    const downloadable = !!item.downloadable;
    const canDelete = (item.is_mine || isAdminUser) && item.id;
    const canCopy = !!(extract && !item.expired && item.file_available);
    const canCopyDelete = !!(del && !item.expired && item.file_available);
    const pickDisabled = !extract ? 'disabled' : '';
    const deleteRow = item.is_mine && del ? `
        <div class="history-row">
            <span class="history-label">删除码</span>
            <span class="history-code">${escapeHtml(del)}</span>
            ${historyActionBtn('复制', canCopyDelete, `copyHistoryCode('${del}', '删除码')`)}
        </div>
    ` : '';
    const manage = item.is_mine ? `
        <div class="share-manage" id="share-manage-${escapeHtml(extract)}">
            ${renderShareManageHtml(extract, share)}
        </div>
    ` : '';
    return `
    <div class="history-item" data-extract="${escapeHtml(extract)}" data-share="${item.share_uid || ''}" data-id="${item.id || ''}">
        <div class="history-item-head">
            <input type="checkbox" class="share-pick" ${pickDisabled} data-id="${item.id || ''}" data-extract="${escapeHtml(extract)}" data-filename="${escapeHtml(item.filename || '')}" data-remain-hours="${item.remaining_hours != null ? item.remaining_hours : 0}">
            <div class="history-filename">${escapeHtml(item.filename)}</div>
        </div>
        ${downloadCountText(item)}
        ${expireBlock(item)}
        <div class="history-time">上传人 IP: ${escapeHtml(item.operator_ip)}${item.operator_ips && item.operator_ips !== item.operator_ip ? '（' + escapeHtml(item.operator_ips) + '）' : ''} · ${escapeHtml(item.created_at)}</div>
        <div class="history-row">
            <span class="history-label">提取码</span>
            <span class="history-code">${escapeHtml(extract)}</span>
            ${historyActionBtn('复制', canCopy, `copyHistoryCode('${extract}', '提取码')`)}
            ${historyActionBtn('下载', downloadable, `downloadByExtractCode('${extract}')`)}
            ${historyActionBtn('刷新提取码', canEdit && item.is_mine, `refreshHistoryCode('${extract}', 'extract')`)}
            ${historyActionBtn('删除', !!canDelete, `deleteTransferLog(${item.id}, 'upload')`)}
        </div>
        ${deleteRow}
        ${manage}
    </div>`;
}

async function updateDownloadHistory(append) {
    const content = document.getElementById('download-history-content');
    if (!content) return;
    if (downloadLoading) return;
    if (append && !downloadHasMore) return;
    downloadLoading = true;
    try {
        if (!append) {
            downloadOffset = 0;
            downloadHasMore = true;
            lastDownloadItems = [];
        }
        const mine = downloadMineOnly ? '1' : '0';
        const response = await apiFetch('/api/transfer-logs?type=download&mine=' + mine + '&offset=' + downloadOffset + '&limit=20');
        const data = await response.json();
        const page = data.items || [];
        if (!append) lastDownloadItems = page;
        else lastDownloadItems = lastDownloadItems.concat(page);
        downloadOffset = lastDownloadItems.length;
        downloadHasMore = page.length >= 20;
        const items = lastDownloadItems.filter(function (item) { return matchesHistoryFilters(item, 'download'); });
        if (!lastDownloadItems.length) {
            content.innerHTML = `
                <div class="empty-state">
                    <i>💾</i>
                    <p>${downloadMineOnly ? '暂无我的下载记录' : '暂无下载记录'}</p>
                </div>
            `;
            return;
        }
        if (!items.length) {
            content.innerHTML = `
                <div class="empty-state">
                    <i>💾</i>
                    <p>没有符合筛选条件的下载记录</p>
                </div>
            `;
            return;
        }
        const scrollTop = content.scrollTop;
        content.innerHTML = items.map(renderDownloadHistoryItem).join('');
        if (append) content.scrollTop = scrollTop;
        highlightLinkedUploads(items);
    } catch (error) {
        if (!append) content.innerHTML = `<div class="empty-state"><p>加载下载记录失败</p></div>`;
    } finally {
        downloadLoading = false;
    }
}

function renderDownloadHistoryItem(item) {
    const upload = item.upload;
    const extract = (item.extract_code || (upload && upload.extract_code) || '');
    const uploadHtml = upload ? `
        <div class="history-meta-block">
            <div>对应上传: ${escapeHtml(upload.filename)}</div>
            <div>上传人 IP: ${escapeHtml(upload.operator_ip)} · ${escapeHtml(upload.created_at)}</div>
        </div>
    ` : '<div class="history-meta-block">未找到对应上传记录</div>';
    const canDelete = (item.is_mine || isAdminUser) && item.id;
    const canCopy = !!(extract && !item.expired && item.file_available);
    return `
        <div class="history-item download-item" data-share="${item.share_uid}" data-id="${item.id || ''}">
            <div class="history-item-head">
                <input type="checkbox" class="share-pick" data-id="${item.id || ''}" data-extract="${escapeHtml(extract)}" data-filename="${escapeHtml(item.filename || '')}" data-remain-hours="${item.remaining_hours != null ? item.remaining_hours : 0}">
                <div class="history-filename">${escapeHtml(item.filename)}</div>
            </div>
            ${downloadCountText(item)}
            ${expireBlock(item)}
            <div class="history-time">下载人 IP: ${escapeHtml(item.operator_ip)}${item.operator_ips && item.operator_ips !== item.operator_ip ? '（' + escapeHtml(item.operator_ips) + '）' : ''} · ${escapeHtml(item.created_at)}</div>
            <div class="history-row">
                <span class="history-label">提取码</span>
                <span class="history-code">${escapeHtml(extract)}</span>
                ${historyActionBtn('复制', canCopy, `copyHistoryCode('${extract}', '提取码')`)}
                ${historyActionBtn('下载', !!item.downloadable, `downloadByExtractCode('${extract}')`)}
                ${historyActionBtn('删除', !!canDelete, `deleteTransferLog(${item.id}, 'download')`)}
            </div>
            ${uploadHtml}
        </div>
    `;
}

function handleScroll(type, element) {
    const scrollTop = element.scrollTop;
    const scrollHeight = element.scrollHeight;
    const clientHeight = element.clientHeight;
    if (scrollTop + clientHeight < scrollHeight - 80) return;
    if (type === 'upload') updateUploadHistory(true);
    else if (type === 'download') updateDownloadHistory(true);
}

function highlightLinkedUploads(downloadItems) {
    const uids = new Set((downloadItems || []).map(item => item.share_uid).filter(Boolean));
    document.querySelectorAll('#upload-history-content .history-item').forEach(el => {
        if (uids.has(el.getAttribute('data-share'))) {
            el.classList.add('linked-share');
        }
    });
}

// ==========================================
// 刷新提取码 / 删除码
// ==========================================

function syncHistoryCodes(oldExtractCode, data) {
    uploadHistory = uploadHistory.map(item => {
        if (String(item.extractCode || '').toUpperCase() === String(oldExtractCode || '').toUpperCase()) {
            return Object.assign({}, item, {
                extractCode: data.extract_code,
                deleteCode: data.delete_code,
                shareUid: data.share_uid || item.shareUid
            });
        }
        return item;
    });
    localStorage.setItem('uploadHistory', JSON.stringify(uploadHistory));
    const historyPage = document.getElementById('history-page');
    if (historyPage && historyPage.style.display !== 'none') {
        updateUploadHistory();
        updateDownloadHistory();
    }
}

async function doRefreshCodes(extractCode, target) {
    const response = await apiFetch('/refresh-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extract_code: extractCode, target: target })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || '刷新失败');
    }
    syncHistoryCodes(extractCode, data);
    currentExtractCode = data.extract_code;
    return data;
}

async function refreshUploadCode(target) {
    if (!currentExtractCode) {
        showError('没有可刷新的文件');
        return;
    }
    try {
        const data = await doRefreshCodes(currentExtractCode, target);
        const extractCodeEl = document.getElementById('extract-code-text');
        const deleteCodeEl = document.getElementById('delete-code-text');
        if (extractCodeEl) extractCodeEl.textContent = data.extract_code;
        if (deleteCodeEl) deleteCodeEl.textContent = data.delete_code;
        const extractIndicator = document.getElementById('extract-copy-indicator');
        if (extractIndicator) {
            extractIndicator.textContent = '点击复制';
            extractIndicator.className = 'copy-indicator pending';
        }
    } catch (error) {
        showError(error.message);
    }
}

async function refreshHistoryCode(extractCode, target) {
    try {
        const data = await doRefreshCodes(extractCode, target);
        const extractCodeEl = document.getElementById('extract-code-text');
        const deleteCodeEl = document.getElementById('delete-code-text');
        if (extractCodeEl) extractCodeEl.textContent = data.extract_code;
        if (deleteCodeEl) deleteCodeEl.textContent = data.delete_code;
        showSuccess(target === 'delete' ? '删除码已刷新' : '提取码已刷新');
        updateUploadHistory();
    } catch (error) {
        showError(error.message);
    }
}

async function loadShareStatus(extractCode) {
    const box = document.getElementById('share-manage-' + extractCode);
    if (!box) return;
    try {
        const response = await apiFetch('/share-manage/' + encodeURIComponent(extractCode));
        const data = await response.json();
        renderShareManage(box, extractCode, data);
    } catch (error) {
        renderShareManage(box, extractCode, {
            status: 'deleted',
            can_edit: false,
            message: '已经过期'
        });
    }
}

function renderShareManageHtml(extractCode, data) {
    data = data || {};
    if (!data.can_edit) {
        const created = data.upload_time || '';
        return `
            <div class="share-status share-readonly">${escapeHtml(data.message || '已经过期')}</div>
            <div class="share-view">${created ? ('创建时间 ' + escapeHtml(created) + ' · ') : ''}已经过期，不可再修改</div>
        `;
    }
    const maxDl = data.system_max_downloads || systemConfig.max_downloads;
    const maxHours = data.system_max_expire_hours || systemConfig.max_expire_hours;
    return `
        <div class="share-status share-active">分享有效, 可修改次数和时限</div>
        <div class="share-edit-row expire-control-wrap">
            <label>下载次数
                <input type="number" id="share-dl-${extractCode}" min="${Math.max(1, data.current_downloads || 1)}" max="${maxDl}" value="${data.max_downloads}">
            </label>
            <label>剩余小时
                <input type="number" id="share-hr-${extractCode}" min="1" max="${maxHours}" value="${data.remaining_hours}" oninput="syncShareExpireFromHours('${extractCode}')">
            </label>
            <label>指定过期时间
                <input type="datetime-local" class="expire-datetime-input" id="share-at-${extractCode}" value="${toDatetimeLocalValue(data.expires_at || '')}">
            </label>
            <button type="button" class="filter-btn" onclick="saveShareSettings('${extractCode}')">保存设置</button>
        </div>
        <div class="share-view">已下载 ${data.current_downloads}/${data.max_downloads} 次 · 到期 ${escapeHtml(data.expires_at || '')}</div>
    `;
}

function renderShareManage(box, extractCode, data) {
    const item = box.closest('.history-item');
    const editButtons = item ? item.querySelectorAll('.share-edit-only') : [];
    editButtons.forEach(btn => {
        btn.disabled = !data.can_edit;
        btn.title = data.can_edit ? '' : (data.message || '当前不能修改');
    });
    box.innerHTML = renderShareManageHtml(extractCode, data);
}

function syncShareExpireFromHours(extractCode) {
    const hrEl = document.getElementById('share-hr-' + extractCode);
    const atEl = document.getElementById('share-at-' + extractCode);
    const hours = parseFloat(hrEl && hrEl.value);
    if (!(hours > 0) || !atEl) return;
    atEl.value = toDatetimeLocalValue(new Date(Date.now() + hours * 3600000));
}

async function saveShareSettings(extractCode) {
    const dlEl = document.getElementById('share-dl-' + extractCode);
    const hrEl = document.getElementById('share-hr-' + extractCode);
    const atEl = document.getElementById('share-at-' + extractCode);
    if (!dlEl) return;
    const payload = { max_downloads: parseInt(dlEl.value, 10) };
    if (atEl && atEl.value) payload.expires_at = atEl.value;
    else if (hrEl) payload.expire_hours = parseFloat(hrEl.value);
    try {
        const response = await apiFetch('/share-manage/' + encodeURIComponent(extractCode), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || '保存失败');
        }
        const box = document.getElementById('share-manage-' + extractCode);
        if (box) renderShareManage(box, extractCode, data);
        showSuccess('修改成功');
        updateUploadHistory();
    } catch (error) {
        showError(error.message);
    }
}

// ==========================================
// 复制功能
// ==========================================

function copyExtractCode() {
    const codeEl = document.getElementById('extract-code-text');
    const indicator = document.getElementById('extract-copy-indicator');
    if (!codeEl) return;
    copyTextToClipboard(codeEl.textContent).then(function () {
        if (indicator) {
            indicator.textContent = '已复制！';
            indicator.className = 'copy-indicator success';
            setTimeout(function () {
                indicator.textContent = '点击复制';
                indicator.className = 'copy-indicator pending';
            }, 2000);
        }
        showSuccess('提取码已复制');
    }).catch(function () {
        showError('复制失败, 请手动复制');
    });
}

function copyDeleteCode() {
    const codeEl = document.getElementById('delete-code-text');
    const indicator = document.getElementById('delete-copy-indicator');
    if (!codeEl) return;
    copyTextToClipboard(codeEl.textContent).then(function () {
        if (indicator) {
            indicator.textContent = '已复制！';
            indicator.className = 'copy-indicator success';
            setTimeout(function () {
                indicator.textContent = '点击复制';
                indicator.className = 'copy-indicator pending';
            }, 2000);
        }
        showSuccess('删除码已复制');
    }).catch(function () {
        showError('复制失败, 请手动复制');
    });
}

function copyHistoryCode(code, type) {
    copyTextToClipboard(code).then(function () {
        showSuccess((type || '内容') + '已复制');
    }).catch(function () {
        showAppAlert('复制失败: 请手动复制: ' + code);
    });
}

// ==========================================
// 消息提示功能
// ==========================================

let toastTimer = null;
function showToast(message, type) {
    const el = document.getElementById('app-toast');
    if (!el) {
        showAppAlert(message);
        return;
    }
    el.textContent = message;
    el.className = 'app-toast show ' + (type || 'success');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
        el.classList.remove('show');
    }, 3200);
}

function showError(message) {
    showToast(message, 'error');
}

function showSuccess(message) {
    showToast(message, 'success');
}

// ==========================================
// 加载状态管理
// ==========================================

function showLoading() {
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) {
        loadingOverlay.style.display = 'flex';
        loadingOverlay.setAttribute('aria-hidden', 'false');
    }
}

function hideLoading() {
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) {
        loadingOverlay.style.display = 'none';
        loadingOverlay.setAttribute('aria-hidden', 'true');
    }
}

function showTransferProgress(title, text) {
    hideLoading();
    const modal = document.getElementById('transfer-progress-modal');
    const titleEl = document.getElementById('transfer-progress-title');
    const textEl = document.getElementById('transfer-progress-text');
    const bar = document.getElementById('transfer-progress-bar');
    const percent = document.getElementById('transfer-progress-percent');
    if (titleEl) titleEl.textContent = title || '传输中';
    if (textEl) textEl.textContent = text || '准备中...';
    if (bar) bar.style.width = '0%';
    if (percent) percent.textContent = '0%';
    if (modal) modal.style.display = 'flex';
}

function updateTransferProgress(loaded, total, text) {
    const textEl = document.getElementById('transfer-progress-text');
    const bar = document.getElementById('transfer-progress-bar');
    const percent = document.getElementById('transfer-progress-percent');
    let pct = 0;
    if (total > 0) {
        pct = Math.min(100, Math.max(0, Math.round((loaded / total) * 100)));
    } else if (loaded > 0) {
        pct = Math.min(99, Math.max(1, Math.round(Math.log10(loaded + 1) * 12)));
    }
    if (bar) bar.style.width = pct + '%';
    if (percent) percent.textContent = pct + '%';
    if (textEl && text) textEl.textContent = text;
}

function hideTransferProgress() {
    const modal = document.getElementById('transfer-progress-modal');
    if (modal) modal.style.display = 'none';
}

function formatProgressSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
}

function xhrWithProgress(url, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
        const xhr = new XMLHttpRequest();
        xhr.open(options.method || 'GET', url, true);
        xhr.responseType = options.responseType || 'json';
        xhr.withCredentials = true;
        const headers = Object.assign({ 'X-Client-Id': getClientId() }, options.headers || {});
        Object.keys(headers).forEach(function (key) {
            if (headers[key] != null) xhr.setRequestHeader(key, headers[key]);
        });
        xhr.upload.onprogress = function (event) {
            if (typeof options.onUploadProgress === 'function') {
                options.onUploadProgress(event.loaded || 0, event.lengthComputable ? event.total : 0);
            }
        };
        xhr.onprogress = function (event) {
            if (typeof options.onDownloadProgress === 'function') {
                options.onDownloadProgress(event.loaded || 0, event.lengthComputable ? event.total : 0);
            }
        };
        xhr.onload = function () {
            resolve({
                ok: xhr.status >= 200 && xhr.status < 300,
                status: xhr.status,
                response: xhr.response,
                getHeader: function (name) {
                    return xhr.getResponseHeader(name);
                },
                raw: xhr
            });
        };
        xhr.onerror = function () {
            reject(new Error('网络错误'));
        };
        xhr.onabort = function () {
            reject(new Error('已取消'));
        };
        xhr.send(options.body || null);
    });
}

async function readResponseWithProgress(response, onProgress) {
    if (!response.body || !response.body.getReader) {
        const blob = await response.blob();
        if (onProgress) onProgress(blob.size, blob.size);
        return blob;
    }
    const reader = response.body.getReader();
    const total = Number(response.headers.get('Content-Length') || 0);
    const chunks = [];
    let loaded = 0;
    while (true) {
        const result = await reader.read();
        if (result.done) break;
        chunks.push(result.value);
        loaded += result.value.byteLength;
        if (onProgress) onProgress(loaded, total);
    }
    return new Blob(chunks);
}

// ==========================================
// 页面导航
// ==========================================

function filenameFromDownloadResponse(response) {
    const encoded = response.headers.get('X-Download-Filename');
    if (encoded) {
        try { return decodeURIComponent(encoded); } catch (e) {}
    }
    const cd = response.headers.get('Content-Disposition') || '';
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
    if (star) {
        try { return decodeURIComponent(star[1].replace(/["']/g, '')); } catch (e) {}
    }
    const plain = /filename\s*=\s*("?)([^";]+)\1/i.exec(cd);
    if (plain && plain[2]) return plain[2];
    return '下载的文件';
}

async function downloadByExtractCode(code) {
    if (!code) return;
    const codes = splitShareCodes(code);
    if (!(await confirmManyFilesDownload(codes.length))) return;
    showTransferProgress('正在下载', '正在请求文件...');
    try {
        const response = await apiFetch('/d/' + encodeURIComponent(codes[0] || code));
        if (!response.ok) {
            let errorMessage = '下载失败';
            try {
                const data = await response.json();
                errorMessage = data.error || errorMessage;
            } catch (e) {}
            throw new Error(errorMessage);
        }
        const blob = await readResponseWithProgress(response, function (loaded, total) {
            updateTransferProgress(
                loaded,
                total,
                '已下载 ' + formatProgressSize(loaded) + (total ? ' / ' + formatProgressSize(total) : '')
            );
        });
        updateTransferProgress(1, 1, '下载完成');
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filenameFromDownloadResponse(response);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        showSuccess('文件下载成功');
        if (document.getElementById('history-page') && document.getElementById('history-page').style.display !== 'none') {
            updateHistoryPage();
        }
        if (isModalVisible('note-file-modal') && noteFileModalCodes.length) {
            loadNoteFileModal(noteFileModalCodes);
        }
    } catch (error) {
        showError(error.message);
    } finally {
        hideTransferProgress();
    }
}

function applyAdminUI() {
    document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = isAdminUser ? '' : 'none';
    });
    const toggle = document.getElementById('nav-admin-toggle');
    if (toggle) toggle.textContent = isAdminUser ? '退出管理员' : '切换为管理员';
    const loginFields = document.getElementById('admin-login-fields');
    const accountBox = document.getElementById('admin-account-box');
    if (!isAdminUser) {
        if (accountBox) accountBox.style.display = 'none';
        if (loginFields) loginFields.style.display = '';
        uploadMineOnly = true;
        downloadMineOnly = true;
        const ua = document.getElementById('filter-upload-all');
        const um = document.getElementById('filter-upload-mine');
        const da = document.getElementById('filter-download-all');
        const dm = document.getElementById('filter-download-mine');
        if (ua) ua.classList.remove('active');
        if (um) um.classList.add('active');
        if (da) da.classList.remove('active');
        if (dm) dm.classList.add('active');
    }
}

async function refreshAdminStatus() {
    try {
        const response = await apiFetch('/api/admin/status');
        const data = await response.json();
        isAdminUser = !!data.is_admin;
    } catch (e) {
        isAdminUser = false;
    }
    applyAdminUI();
}

function downloadCountText(item) {
    if (item == null) return '';
    if (item.expired || !item.file_available) {
        return `<div class="history-downloads">已经过期</div>`;
    }
    if (item.max_downloads == null) {
        return `<div class="history-downloads">已经过期</div>`;
    }
    const used = item.current_downloads != null ? item.current_downloads : 0;
    return `<div class="history-downloads">下载次数 ${used}/${item.max_downloads}</div>`;
}

async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text || ''));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function clearAdminPasswordFields() {
    ['admin-login-password', 'admin-current-password', 'admin-new-password', 'admin-confirm-password'].forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    resetPasswordEyes();
    setAdminAlert(document.getElementById('admin-login-error'), '');
    setAdminAlert(document.getElementById('admin-account-error'), '');
}

function toggleAdminMode() {
    if (isAdminUser) {
        apiFetch('/api/admin/logout', { method: 'POST' }).then(() => {
            isAdminUser = false;
            applyAdminUI();
            updateHistoryPage();
            loadNotes();
        });
        return;
    }
    clearAdminPasswordFields();
    const userEl = document.getElementById('admin-login-username');
    if (userEl) userEl.value = '';
    const loginFields = document.getElementById('admin-login-fields');
    const accountBox = document.getElementById('admin-account-box');
    if (loginFields) loginFields.style.display = '';
    if (accountBox) accountBox.style.display = 'none';
    const modal = document.getElementById('admin-login-modal');
    if (modal) modal.style.display = 'flex';
}

function closeAdminLoginModal() {
    const modal = document.getElementById('admin-login-modal');
    if (modal) modal.style.display = 'none';
    clearAdminPasswordFields();
}

function openAdminAccountModal() {
    if (!isAdminUser) return;
    clearAdminPasswordFields();
    const loginFields = document.getElementById('admin-login-fields');
    const accountBox = document.getElementById('admin-account-box');
    if (loginFields) loginFields.style.display = 'none';
    if (accountBox) accountBox.style.display = '';
    const modal = document.getElementById('admin-login-modal');
    if (modal) modal.style.display = 'flex';
}

function setAdminAlert(el, text, kind) {
    if (!el) return;
    if (!text) {
        el.style.display = 'none';
        el.textContent = '';
        return;
    }
    el.className = 'admin-alert ' + (kind || 'error');
    el.textContent = text;
    el.style.display = 'block';
}

function resetPasswordEyes() {
    document.querySelectorAll('#admin-login-modal .pwd-eye').forEach(function (btn) {
        btn.classList.remove('is-visible');
        btn.setAttribute('aria-label', '显示密码');
    });
    ['admin-login-password', 'admin-current-password', 'admin-new-password', 'admin-confirm-password'].forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.type = 'password';
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

async function submitAdminLogin() {
    const username = (document.getElementById('admin-login-username').value || '').trim();
    const password = document.getElementById('admin-login-password').value || '';
    const err = document.getElementById('admin-login-error');
    try {
        const hashed = await sha256Hex(password);
        const response = await apiFetch('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, password: hashed })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '登录失败');
        isAdminUser = true;
        applyAdminUI();
        closeAdminLoginModal();
        setAdminAlert(err, '');
        updateHistoryPage();
        loadNotes();
    } catch (error) {
        resetPasswordEyes();
        const pwd = document.getElementById('admin-login-password');
        if (pwd) pwd.value = '';
        setAdminAlert(err, error.message, 'error');
    }
}

async function submitAdminAccount() {
    const username = (document.getElementById('admin-new-username').value || '').trim();
    const currentPassword = document.getElementById('admin-current-password').value || '';
    const password = document.getElementById('admin-new-password').value || '';
    const confirmPassword = document.getElementById('admin-confirm-password').value || '';
    const err = document.getElementById('admin-account-error');
    try {
        if (password && password !== confirmPassword) {
            throw new Error('两次输入的新密码不一致');
        }
        const response = await apiFetch('/api/admin/account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: username,
                current_password: await sha256Hex(currentPassword),
                password: password ? await sha256Hex(password) : ''
            })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '修改失败');
        clearAdminPasswordFields();
        setAdminAlert(err, '已保存', 'success');
    } catch (error) {
        resetPasswordEyes();
        setAdminAlert(err, error.message, 'error');
    }
}

function goToAdmin() {
    window.location.href = '/admin';
}

function closeModal() {
    const modal = document.getElementById('success-modal');
    if (modal) {
        modal.style.display = 'none';
    }
}

let confirmResolver = null;
let confirmPromptMode = false;

function resetConfirmPromptUI() {
    confirmPromptMode = false;
    const wrap = document.getElementById('confirm-prompt-wrap');
    const input = document.getElementById('confirm-prompt-input');
    if (wrap) wrap.style.display = 'none';
    if (input) input.value = '';
}

function showAppConfirm(message, title) {
    return new Promise(function (resolve) {
        confirmPromptMode = false;
        confirmResolver = resolve;
        const titleEl = document.getElementById('confirm-title');
        const msgEl = document.getElementById('confirm-message');
        const cancelBtn = document.getElementById('confirm-cancel');
        const wrap = document.getElementById('confirm-prompt-wrap');
        if (titleEl) titleEl.textContent = title || '确认操作';
        if (msgEl) {
            msgEl.textContent = message;
            msgEl.style.display = '';
        }
        if (wrap) wrap.style.display = 'none';
        if (cancelBtn) cancelBtn.style.display = '';
        const modal = document.getElementById('confirm-modal');
        if (modal) modal.style.display = 'flex';
    });
}

function showAppAlert(message, title) {
    return new Promise(function (resolve) {
        confirmPromptMode = false;
        confirmResolver = resolve;
        const titleEl = document.getElementById('confirm-title');
        const msgEl = document.getElementById('confirm-message');
        const cancelBtn = document.getElementById('confirm-cancel');
        const wrap = document.getElementById('confirm-prompt-wrap');
        if (titleEl) titleEl.textContent = title || '提示';
        if (msgEl) {
            msgEl.textContent = message;
            msgEl.style.display = '';
        }
        if (wrap) wrap.style.display = 'none';
        if (cancelBtn) cancelBtn.style.display = 'none';
        const modal = document.getElementById('confirm-modal');
        if (modal) modal.style.display = 'flex';
    });
}

function showAppPrompt(message, defaultValue, title) {
    return new Promise(function (resolve) {
        confirmPromptMode = true;
        confirmResolver = resolve;
        const titleEl = document.getElementById('confirm-title');
        const msgEl = document.getElementById('confirm-message');
        const cancelBtn = document.getElementById('confirm-cancel');
        const wrap = document.getElementById('confirm-prompt-wrap');
        const input = document.getElementById('confirm-prompt-input');
        if (titleEl) titleEl.textContent = title || '请输入';
        if (msgEl) {
            msgEl.textContent = message || '';
            msgEl.style.display = message ? '' : 'none';
        }
        if (wrap) wrap.style.display = 'block';
        if (input) {
            input.value = defaultValue == null ? '' : String(defaultValue);
            setTimeout(function () {
                input.focus();
                input.select();
            }, 0);
        }
        if (cancelBtn) cancelBtn.style.display = '';
        const modal = document.getElementById('confirm-modal');
        if (modal) modal.style.display = 'flex';
    });
}

function closeConfirmModal(ok) {
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.style.display = 'none';
    const cancelBtn = document.getElementById('confirm-cancel');
    if (cancelBtn) cancelBtn.style.display = '';
    const msgEl = document.getElementById('confirm-message');
    if (msgEl) msgEl.style.display = '';
    const input = document.getElementById('confirm-prompt-input');
    const value = input ? input.value : '';
    const wasPrompt = confirmPromptMode;
    const fn = confirmResolver;
    confirmResolver = null;
    resetConfirmPromptUI();
    if (!fn) return;
    if (wasPrompt) fn(ok ? value : null);
    else fn(!!ok);
}

function isModalVisible(id) {
    const el = document.getElementById(id);
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
}

function getOpenModals() {
    // 从上到下：越靠前优先级越高（先处理）
    return [
        'confirm-modal',
        'shared-perm-modal',
        'admin-login-modal',
        'success-modal',
        'note-file-modal',
        'transfer-progress-modal'
    ].filter(isModalVisible);
}

function handleModalKeys(e) {
    const open = getOpenModals();
    if (!open.length) return;
    const top = open[0];

    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeTopModal();
        return;
    }

    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;

    // 传输进度弹窗没有“确认”动作，回车不处理
    if (top === 'transfer-progress-modal') return;

    e.preventDefault();
    e.stopPropagation();

    if (top === 'confirm-modal') {
        closeConfirmModal(true);
        return;
    }
    if (top === 'shared-perm-modal') {
        saveSharedPermModal();
        return;
    }
    if (top === 'admin-login-modal') {
        const accountBox = document.getElementById('admin-account-box');
        if (accountBox && accountBox.style.display !== 'none') {
            submitAdminAccount();
        } else {
            submitAdminLogin();
        }
        return;
    }
    if (top === 'success-modal') {
        closeModal();
        return;
    }
    if (top === 'note-file-modal') {
        return;
    }
}

function closeTopModal() {
    const open = getOpenModals();
    if (!open.length) return;
    const top = open[0];
    if (top === 'confirm-modal') {
        closeConfirmModal(false);
        return;
    }
    if (top === 'shared-perm-modal') {
        closeSharedPermModal();
        return;
    }
    if (top === 'admin-login-modal') {
        closeAdminLoginModal();
        return;
    }
    if (top === 'success-modal') {
        closeModal();
        return;
    }
    if (top === 'note-file-modal') {
        closeNoteFileModal();
        return;
    }
    if (top === 'transfer-progress-modal') {
        hideTransferProgress();
    }
}

// ==========================================
// 拖拽上传功能
// ==========================================

function initDragAndDrop() {
    const uploadArea = document.querySelector('.upload-area');
    
    if (!uploadArea) {
        console.warn('未找到上传区域');
        return;
    }
    
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = 'var(--secondary-color)';
        uploadArea.style.background = 'linear-gradient(135deg, rgba(102, 126, 234, 0.2) 0%, rgba(118, 75, 162, 0.2) 100%)';
        uploadArea.classList.add('drag-over');
    });

    uploadArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = 'var(--primary-color)';
        uploadArea.style.background = 'linear-gradient(135deg, rgba(102, 126, 234, 0.05) 0%, rgba(118, 75, 162, 0.05) 100%)';
        uploadArea.classList.remove('drag-over');
    });

    uploadArea.addEventListener('drop', async (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = 'var(--primary-color)';
        uploadArea.style.background = 'linear-gradient(135deg, rgba(102, 126, 234, 0.05) 0%, rgba(118, 75, 162, 0.05) 100%)';
        uploadArea.classList.remove('drag-over');
        const items = await collectDroppedItems(e.dataTransfer);
        if (items.length) {
            startUpload(items);
        }
    });
}

function readAllDirectoryEntries(reader) {
    return new Promise((resolve, reject) => {
        const entries = [];
        const readBatch = () => {
            reader.readEntries(batch => {
                if (!batch.length) {
                    resolve(entries);
                    return;
                }
                entries.push.apply(entries, batch);
                readBatch();
            }, reject);
        };
        readBatch();
    });
}

function traverseEntry(entry, prefix) {
    return new Promise((resolve, reject) => {
        if (entry.isFile) {
            entry.file(file => {
                const path = prefix ? `${prefix}/${entry.name}` : entry.name;
                resolve([{ file: file, path: path }]);
            }, reject);
            return;
        }
        if (entry.isDirectory) {
            const dirPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            readAllDirectoryEntries(entry.createReader()).then(entries => {
                return Promise.all(entries.map(child => traverseEntry(child, dirPath)));
            }).then(nested => {
                resolve([].concat.apply([], nested));
            }).catch(reject);
            return;
        }
        resolve([]);
    });
}

async function collectDroppedItems(dataTransfer) {
    const itemList = dataTransfer && dataTransfer.items;
    if (itemList && itemList.length && itemList[0].webkitGetAsEntry) {
        const tasks = [];
        for (let i = 0; i < itemList.length; i++) {
            const entry = itemList[i].webkitGetAsEntry();
            if (entry) tasks.push(traverseEntry(entry, ''));
        }
        const nested = await Promise.all(tasks);
        return [].concat.apply([], nested);
    }
    const files = dataTransfer.files || [];
    return Array.from(files).map(file => ({
        file: file,
        path: file.webkitRelativePath || file.name
    }));
}

// ==========================================
// 页面初始化
// ==========================================

document.addEventListener('DOMContentLoaded', function() {
    console.log('闪传主页面初始化...');
    getClientId();
    refreshAdminStatus();
    loadSystemConfig();
    
    // 关闭弹窗
    const modal = document.getElementById('success-modal');
    if (modal) {
        modal.addEventListener('click', function(e) {
            if (e.target === this) {
                closeModal();
            }
        });
    }
    
    // 初始化拖拽
    initDragAndDrop();
    guardReceiveCodeAutofill();
    document.addEventListener('keydown', function (e) {
        handleModalKeys(e);
    });
    const confirmOk = document.getElementById('confirm-ok');
    const confirmCancel = document.getElementById('confirm-cancel');
    if (confirmOk) confirmOk.addEventListener('click', function () { closeConfirmModal(true); });
    if (confirmCancel) confirmCancel.addEventListener('click', function () { closeConfirmModal(false); });
    ['confirm-modal', 'admin-login-modal', 'shared-perm-modal', 'success-modal', 'note-file-modal', 'transfer-progress-modal'].forEach(function (id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('click', function (e) {
            if (e.target === el) closeTopModal();
        });
    });
    
    // 键盘回车支持
    const extractInput = document.getElementById('extract-code');
    if (extractInput) {
        extractInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') handleReceive();
        });
    }
    
    const deleteInput = document.getElementById('delete-code');
    if (deleteInput) {
        deleteInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') handleReceive();
        });
    }
    
    // 在线状态监听
    window.addEventListener('online', () => {
        console.log('网络已连接');
        loadSystemConfig();
    });
    
    window.addEventListener('offline', () => {
        console.warn('网络已断开');
        showError('网络已断开, 请检查网络连接');
    });
    
    console.log('闪传主页面初始化完成');
});

// ==========================================
// 留言（wangEditor）
// 失焦后 Slate 会把 selection 置空, 键盘插入就会失效.
// 处理: 失焦时记下选区, 再次聚焦且 selection 为空时还原.
// ==========================================

let noteEditor = null;
let replyEditors = {};

function isEditorHtmlEmpty(html) {
    const raw = html || '';
    if (/<img\b/i.test(raw) || /<video\b/i.test(raw)) return false;
    const text = raw.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    return !text;
}

function createNoteImageUploadConfig() {
    return {
        maxFileSize: 10 * 1024 * 1024,
        allowedFileTypes: ['image/*'],
        customUpload: async function (file, insertFn) {
            const formData = new FormData();
            formData.append('image', file);
            const response = await apiFetch('/api/notes/image', { method: 'POST', body: formData });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '图片上传失败');
            insertFn(data.url, file.name || '图片', data.url);
        }
    };
}

function cloneWangRange(range) {
    if (!range) return null;
    try {
        return JSON.parse(JSON.stringify(range));
    } catch (e) {
        return range;
    }
}

function restoreWangSelection(editor) {
    if (!editor || editor.isDestroyed) return;
    if (editor.selection) {
        try { editor.focus(); } catch (e) {}
        return;
    }
    const WE = window.wangEditor;
    const loc = editor.__savedSel || (WE && WE.SlateEditor ? WE.SlateEditor.end(editor, []) : null);
    try {
        if (loc && WE && WE.SlateTransforms) {
            WE.SlateTransforms.select(editor, loc);
        } else if (loc && typeof editor.select === 'function') {
            editor.select(loc);
        }
        editor.focus();
    } catch (e) {
        try { editor.focus(); } catch (err) {}
    }
}

function wangEditorConfig() {
    return {
        placeholder: '',
        autoFocus: false,
        onBlur: function (ed) {
            if (ed && ed.selection) ed.__savedSel = cloneWangRange(ed.selection);
        },
        onFocus: function (ed) {
            requestAnimationFrame(function () {
                restoreWangSelection(ed);
            });
        },
        MENU_CONF: {
            uploadImage: createNoteImageUploadConfig()
        }
    };
}

function bindWangToolbarKeepSelection(toolbarSelector) {
    const el = document.querySelector(toolbarSelector);
    if (!el || el.dataset.keepSel) return;
    el.dataset.keepSel = '1';
    el.addEventListener('mousedown', function (e) {
        e.preventDefault();
    });
}

function bindWangClickRestore(editorSelector, editor) {
    const el = document.querySelector(editorSelector);
    if (!el || el.dataset.clickRestore) return;
    el.dataset.clickRestore = '1';
    el.addEventListener('click', function () {
        restoreWangSelection(editor);
    });
}

function mountWangEditor(editorSelector, toolbarSelector, html, mode) {
    if (!window.wangEditor) {
        showNotesMessage('富文本组件未加载', true);
        return null;
    }
    const { createEditor, createToolbar } = window.wangEditor;
    const editor = createEditor({
        selector: editorSelector,
        html: html || '<p><br></p>',
        config: wangEditorConfig(),
        mode: mode || 'default'
    });
    createToolbar({
        editor: editor,
        selector: toolbarSelector,
        config: {},
        mode: mode || 'default'
    });
    bindWangToolbarKeepSelection(toolbarSelector);
    bindWangClickRestore(editorSelector, editor);
    return editor;
}

function initNoteEditor() {
    if (noteEditor) return;
    const toolbarEl = document.getElementById('note-toolbar');
    const editorEl = document.getElementById('note-editor');
    if (!toolbarEl || !editorEl) return;
    noteEditor = mountWangEditor('#note-editor', '#note-toolbar', '<p><br></p>', 'default');
}

function destroyMainNoteEditor() {
    if (noteEditor) {
        try { noteEditor.destroy(); } catch (e) {}
        noteEditor = null;
    }
    const toolbarEl = document.getElementById('note-toolbar');
    const editorEl = document.getElementById('note-editor');
    if (toolbarEl) {
        toolbarEl.innerHTML = '';
        delete toolbarEl.dataset.keepSel;
    }
    if (editorEl) {
        editorEl.innerHTML = '';
        delete editorEl.dataset.clickRestore;
    }
}

function destroyReplyEditors() {
    Object.keys(replyEditors).forEach(function (id) {
        try { replyEditors[id].destroy(); } catch (e) {}
    });
    replyEditors = {};
}

function showNotesMessage(text, isError) {
    if (!text) return;
    if (isError) showError(text);
    else showSuccess(text);
}

function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderRequestInfo(info) {
    if (!isAdminUser || info == null) return '';
    const pretty = escapeHtml(JSON.stringify(info || {}, null, 2));
    return `<details class="note-request"><summary>请求信息</summary><pre>${pretty}</pre></details>`;
}

function renderNoteItem(note, isReply) {
    const repliesHtml = (note.replies || []).map(item => renderNoteItem(item, true)).join('');
    const canManage = !!(note.can_edit || note.is_mine || isAdminUser);
    const editBtn = canManage
        ? `<button type="button" class="filter-btn" onclick="startEditNote(${note.id})">编辑</button>`
        : '';
    const deleteBtn = canManage
        ? `<button type="button" class="filter-btn note-delete-btn" onclick="deleteNote(${note.id})">删除</button>`
        : '';
    return `
        <article class="note-item ${isReply ? 'note-reply' : ''}" data-id="${note.id}">
            <div class="note-meta">
                <span>IP ${escapeHtml(note.client_ip)}${note.is_mine ? ' · 我的留言' : ''}</span>
                <span>${escapeHtml(note.created_at)}</span>
            </div>
            <div class="note-content" id="note-content-${note.id}">${note.content}</div>
            ${renderRequestInfo(note.request_info)}
            <div class="note-actions">
                <button type="button" class="filter-btn" onclick="copyNoteContent(${note.id})">复制</button>
                <button type="button" class="filter-btn" onclick="fetchFilesFromNote(${note.id})">获取文件</button>
                ${editBtn}
                <button type="button" class="filter-btn" onclick="toggleReplyEditor(${note.id})">回复</button>
                ${deleteBtn}
            </div>
            <div id="edit-editor-${note.id}" class="reply-editor" style="display:none;">
                <div class="richtext-box reply-richtext">
                    <div id="edit-toolbar-${note.id}"></div>
                    <div id="edit-area-${note.id}"></div>
                </div>
                <div class="note-editor-actions">
                    <button type="button" class="btn btn-primary" onclick="saveEditNote(${note.id})">保存</button>
                    <button type="button" class="btn btn-secondary" onclick="cancelEditNote(${note.id})">取消</button>
                </div>
            </div>
            <div id="reply-editor-${note.id}" class="reply-editor" style="display:none;">
                <div class="richtext-box reply-richtext">
                    <div id="reply-toolbar-${note.id}"></div>
                    <div id="reply-area-${note.id}"></div>
                </div>
                <div class="note-editor-actions">
                    <button type="button" class="btn btn-primary" onclick="submitNote(${note.id})">发送回复</button>
                    <button type="button" class="btn btn-secondary" onclick="toggleReplyEditor(${note.id})">取消回复</button>
                </div>
            </div>
            <div class="note-replies">${repliesHtml}</div>
        </article>
    `;
}

function setNotesFilter(mineOnly) {
    notesMineOnly = !!mineOnly;
    const allBtn = document.getElementById('filter-notes-all');
    const mineBtn = document.getElementById('filter-notes-mine');
    if (allBtn) allBtn.classList.toggle('active', !notesMineOnly);
    if (mineBtn) mineBtn.classList.toggle('active', notesMineOnly);
    loadNotes();
}

function destroyNoteEditEditors() {
    Object.keys(noteEditEditors).forEach(function (id) {
        try { noteEditEditors[id].destroy(); } catch (e) {}
    });
    noteEditEditors = {};
}

function copyTextToClipboard(text) {
    const value = String(text == null ? '' : text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(value).catch(function () {
            return fallbackCopyText(value);
        });
    }
    return Promise.resolve().then(function () {
        return fallbackCopyText(value);
    });
}

function fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try {
        ok = document.execCommand('copy');
    } catch (e) {
        ok = false;
    }
    document.body.removeChild(ta);
    if (!ok) throw new Error('复制失败');
}

function copyNoteContent(noteId) {
    const el = document.getElementById('note-content-' + noteId);
    const text = el ? (el.innerText || el.textContent || '').trim() : '';
    if (!text) {
        showError('没有可复制的内容');
        return;
    }
    copyTextToClipboard(text).then(function () {
        showSuccess('留言内容已复制');
    }).catch(function () {
        showAppAlert('复制失败, 请手动选择留言内容复制');
    });
}

function startEditNote(noteId) {
    const box = document.getElementById('edit-editor-' + noteId);
    const contentEl = document.getElementById('note-content-' + noteId);
    if (!box || !contentEl) return;
    box.style.display = 'block';
    contentEl.style.display = 'none';
    if (noteEditEditors[noteId]) {
        noteEditEditors[noteId].setHtml(contentEl.innerHTML || '<p><br></p>');
        restoreWangSelection(noteEditEditors[noteId]);
        return;
    }
    noteEditEditors[noteId] = mountWangEditor(
        '#edit-area-' + noteId,
        '#edit-toolbar-' + noteId,
        contentEl.innerHTML || '<p><br></p>',
        'simple'
    );
    restoreWangSelection(noteEditEditors[noteId]);
}

function cancelEditNote(noteId) {
    const box = document.getElementById('edit-editor-' + noteId);
    const contentEl = document.getElementById('note-content-' + noteId);
    if (box) box.style.display = 'none';
    if (contentEl) contentEl.style.display = '';
    if (noteEditEditors[noteId]) {
        try { noteEditEditors[noteId].destroy(); } catch (e) {}
        delete noteEditEditors[noteId];
    }
}

async function saveEditNote(noteId) {
    const editor = noteEditEditors[noteId];
    if (!editor) return;
    const content = editor.getHtml();
    if (isEditorHtmlEmpty(content)) {
        showError('请输入内容');
        return;
    }
    try {
        const response = await apiFetch('/api/notes/' + noteId, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content })
        });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '保存失败');
        showSuccess('保存成功');
        loadNotes();
    } catch (error) {
        showError(error.message);
    }
}

async function loadNotes() {
    const list = document.getElementById('notes-list');
    if (!list) return;
    destroyReplyEditors();
    destroyNoteEditEditors();
    try {
        const mine = notesMineOnly ? '1' : '0';
        const response = await apiFetch('/api/notes?mine=' + mine);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '加载失败');
        if (data.is_admin) isAdminUser = true;
        applyAdminUI();
        if (!data.notes || data.notes.length === 0) {
            list.innerHTML = `<div class="empty-state"><i>💬</i><p>${notesMineOnly ? '暂无我的留言' : '暂无留言'}</p></div>`;
        } else {
            list.innerHTML = data.notes.map(note => renderNoteItem(note, false)).join('');
        }
    } catch (error) {
        list.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
    }
}

function toggleReplyEditor(noteId) {
    const el = document.getElementById('reply-editor-' + noteId);
    if (!el) return;
    const show = el.style.display === 'none';
    el.style.display = show ? 'block' : 'none';
    if (!show) {
        if (replyEditors[noteId]) {
            try { replyEditors[noteId].destroy(); } catch (e) {}
            delete replyEditors[noteId];
        }
        return;
    }
    if (replyEditors[noteId]) {
        restoreWangSelection(replyEditors[noteId]);
        return;
    }
    replyEditors[noteId] = mountWangEditor(
        '#reply-area-' + noteId,
        '#reply-toolbar-' + noteId,
        '<p><br></p>',
        'simple'
    );
    restoreWangSelection(replyEditors[noteId]);
}

async function submitNote(parentId) {
    let content = '';
    if (parentId) {
        const editor = replyEditors[parentId];
        if (!editor) {
            showError('请先打开回复框');
            return;
        }
        content = editor.getHtml();
    } else {
        if (!noteEditor) initNoteEditor();
        if (!noteEditor) return;
        content = noteEditor.getHtml();
    }
    if (isEditorHtmlEmpty(content)) {
        showError('请输入内容');
        return;
    }
    try {
        const response = await apiFetch('/api/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content, parent_id: parentId || null })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '发布失败');
        if (parentId && replyEditors[parentId]) {
            replyEditors[parentId].setHtml('<p><br></p>');
            const box = document.getElementById('reply-editor-' + parentId);
            if (box) box.style.display = 'none';
            try { replyEditors[parentId].destroy(); } catch (e) {}
            delete replyEditors[parentId];
        } else if (noteEditor) {
            noteEditor.setHtml('<p><br></p>');
            noteEditor.__savedSel = null;
            restoreWangSelection(noteEditor);
        }
        showSuccess(parentId ? '回复成功' : '发布成功');
        loadNotes();
    } catch (error) {
        showError(error.message);
    }
}

async function deleteNote(noteId) {
    if (!(await showAppConfirm('确定删除这条留言及其回复？', '删除留言'))) return;
    try {
        const response = await apiFetch('/api/notes/' + noteId, { method: 'DELETE' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '删除失败');
        showSuccess('留言已删除');
        loadNotes();
    } catch (error) {
        showError(error.message);
    }
}

async function clearAllNotes() {
    if (!isAdminUser) return;
    if (!(await showAppConfirm('确定清空全部留言？', '清空留言'))) return;
    try {
        const response = await apiFetch('/api/notes/clear', { method: 'POST' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '清空失败');
        showSuccess('留言已清空');
        loadNotes();
    } catch (error) {
        showError(error.message);
    }
}

function clearNoteEditor() {
    if (!noteEditor) initNoteEditor();
    if (!noteEditor) {
        showError('编辑器未就绪');
        return;
    }
    noteEditor.setHtml('<p><br></p>');
    noteEditor.__savedSel = null;
    restoreWangSelection(noteEditor);
    showSuccess('输入框已清空');
}

async function deleteTransferLog(id, kind) {
    if (!(await showAppConfirm('确定删除这条记录？只删除记录数据，不会立刻删除文件。', '删除'))) return;
    try {
        const response = await apiFetch('/api/transfer-logs?id=' + encodeURIComponent(id), { method: 'DELETE' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '删除失败');
        if (kind === 'download') updateDownloadHistory();
        else updateUploadHistory();
        showSuccess('记录已删除');
    } catch (error) {
        showError(error.message);
    }
}

async function batchDeleteTransferLogs(kind) {
    const rootId = kind === 'download' ? 'download-history-content' : 'upload-history-content';
    const boxes = document.querySelectorAll('#' + rootId + ' .share-pick:checked');
    const ids = [];
    boxes.forEach(function (box) {
        const id = parseInt(box.getAttribute('data-id') || '', 10);
        if (id) ids.push(id);
    });
    if (!ids.length) {
        showError('请先勾选要删除的记录');
        return;
    }
    if (!(await showAppConfirm('确定合并删除选中的 ' + ids.length + ' 条记录？只删除记录，不立刻删除文件。', '合并删除'))) return;
    try {
        const response = await apiFetch('/api/transfer-logs', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: ids })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '删除失败');
        showSuccess('已删除 ' + (data.deleted || ids.length) + ' 条记录');
        if (kind === 'download') updateDownloadHistory();
        else updateUploadHistory();
    } catch (error) {
        showError(error.message);
    }
}

async function clearTransferLogs(kind) {
    const label = kind === 'upload' ? '上传' : '下载';
    if (!(await showAppConfirm('确定清空全部' + label + '记录？其他人将不再看到这些记录。', '清空' + label + '记录'))) return;
    try {
        const response = await apiFetch('/api/transfer-logs?type=' + kind, {
            method: 'DELETE'
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '清空失败');
        if (kind === 'upload') updateUploadHistory();
        else updateDownloadHistory();
        showSuccess('已清空' + label + '记录');
    } catch (error) {
        showError(error.message);
    }
}

function extractCodesFromText(text) {
    const cleaned = sanitizeShareCodeInput(text);
    return splitShareCodes(cleaned);
}

function extractCodesFromNoteHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return extractCodesFromText(tmp.innerText || tmp.textContent || '');
}

async function forwardCodeToNotes(kind) {
    const extractEl = document.getElementById('extract-code-text');
    const deleteEl = document.getElementById('delete-code-text');
    let text = '';
    if (kind === 'delete') {
        text = '删除码:' + ((deleteEl && deleteEl.textContent) || '').trim();
    } else {
        text = '提取码:' + ((extractEl && extractEl.textContent) || '').trim();
    }
    if (!text || text.endsWith(':')) {
        showError('没有可转发的内容');
        return;
    }
    try {
        if (!noteEditor) initNoteEditor();
        const response = await apiFetch('/api/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: '<p>' + escapeHtml(text) + '</p>', parent_id: null })
        });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '转发失败');
        showSuccess('转发成功');
        closeModal();
    } catch (error) {
        showError(error.message);
    }
}

async function fetchFilesFromNote(noteId) {
    const el = document.getElementById('note-content-' + noteId);
    const codes = extractCodesFromNoteHtml(el ? el.innerHTML : '');
    if (!codes.length) {
        showError('留言中没有找到提取码');
        return;
    }
    openNoteFileModal(codes);
}

async function fetchFilesFromEditor() {
    let html = '';
    if (noteEditor) html = noteEditor.getHtml();
    const codes = extractCodesFromNoteHtml(html);
    if (!codes.length) {
        showError('编辑器中没有找到提取码');
        return;
    }
    openNoteFileModal(codes);
}

let noteFileModalCodes = [];

function fileSizeBlock(item) {
    if (item == null || item.file_size == null) return '';
    return `<div class="history-downloads">文件大小 ${escapeHtml(formatProgressSize(item.file_size))}</div>`;
}

function renderNoteFileItem(item) {
    const extract = item.extract_code || '';
    if (item.error && !item.filename) {
        return `
        <div class="history-item">
            <div class="history-item-head">
                <input type="checkbox" class="share-pick note-file-pick" disabled>
                <div class="history-filename">提取码 ${escapeHtml(extract)}</div>
            </div>
            <div class="history-downloads">${escapeHtml(item.error)}</div>
        </div>`;
    }
    const canCopy = !!(extract && !item.expired && item.file_available);
    const downloadable = !!item.downloadable;
    const timeLine = item.upload_time
        ? `<div class="history-time">${item.operator_ip ? '上传人 IP: ' + escapeHtml(item.operator_ip) + ' · ' : ''}上传时间 ${escapeHtml(item.upload_time)}</div>`
        : '';
    return `
    <div class="history-item">
        <div class="history-item-head">
            <input type="checkbox" class="share-pick note-file-pick" ${downloadable ? '' : 'disabled'} data-extract="${escapeHtml(extract)}" data-filename="${escapeHtml(item.filename || '')}">
            <div class="history-filename">${escapeHtml(item.filename || ('提取码 ' + extract))}</div>
        </div>
        ${fileSizeBlock(item)}
        ${downloadCountText(item)}
        ${expireBlock(item)}
        ${timeLine}
        <div class="history-row">
            <span class="history-label">提取码</span>
            <span class="history-code">${escapeHtml(extract)}</span>
            ${historyActionBtn('复制', canCopy, `copyHistoryCode('${extract}', '提取码')`)}
            ${historyActionBtn('下载', downloadable, `downloadByExtractCode('${extract}')`)}
        </div>
    </div>`;
}

async function loadNoteFileModal(codes) {
    const list = document.getElementById('note-file-list');
    if (!list) return;
    list.innerHTML = '<div class="empty-state"><p>正在获取文件信息...</p></div>';
    try {
        const response = await apiFetch('/api/file-info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codes: codes })
        });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '获取文件信息失败');
        const items = data.items || [];
        if (!items.length) {
            list.innerHTML = '<div class="empty-state"><p>没有可显示的文件信息</p></div>';
            return;
        }
        list.innerHTML = items.map(renderNoteFileItem).join('');
        refreshExpireCountdowns();
    } catch (error) {
        list.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
    }
}

async function openNoteFileModal(codes) {
    noteFileModalCodes = codes || [];
    const modal = document.getElementById('note-file-modal');
    if (modal) modal.style.display = 'flex';
    await loadNoteFileModal(noteFileModalCodes);
}

function closeNoteFileModal() {
    const modal = document.getElementById('note-file-modal');
    if (modal) modal.style.display = 'none';
}

function toggleSelectNoteFiles() {
    const boxes = Array.from(document.querySelectorAll('#note-file-list .note-file-pick:not(:disabled)'));
    if (!boxes.length) {
        showError('当前没有可下载的文件');
        return;
    }
    const allChecked = boxes.every(function (box) { return box.checked; });
    boxes.forEach(function (box) { box.checked = !allChecked; });
}

async function downloadSelectedNoteFiles() {
    const boxes = document.querySelectorAll('#note-file-list .note-file-pick:checked');
    const codes = [];
    boxes.forEach(function (box) {
        const extract = box.getAttribute('data-extract');
        if (extract) codes.push(extract);
    });
    if (!codes.length) {
        showError('请先勾选要下载的文件');
        return;
    }
    if (!(await confirmManyFilesDownload(codes.length))) return;
    await downloadBundle(codes);
    if (isModalVisible('note-file-modal') && noteFileModalCodes.length) {
        loadNoteFileModal(noteFileModalCodes);
    }
}

// ==========================================
// 共享目录
// ==========================================

const SHARED_PERM_DEFS = [
    { key: 'perm_browse', label: '可读/浏览' },
    { key: 'perm_download', label: '可下载' },
    { key: 'perm_zip', label: '可打包下载' },
    { key: 'perm_upload', label: '可上传' },
    { key: 'perm_mkdir', label: '可新建文件夹' },
    { key: 'perm_delete', label: '可删除' },
    { key: 'perm_rename', label: '可重命名' },
    { key: 'perm_show_hidden', label: '可见隐藏文件' }
];

const sharedState = {
    peerKey: 'local',
    host: '',
    port: 0,
    isLocal: true,
    view: 'roots',
    dirId: null,
    dirName: '',
    path: '',
    parent: '',
    entries: [],
    roots: [],
    effective: {},
    currentDir: null,
    editingId: null,
    treeCache: {},
    selected: {}
};

function sharedApiPrefix() {
    if (sharedState.isLocal || sharedState.peerKey === 'local') {
        return '/api/shared';
    }
    return '/api/shared/relay/' + encodeURIComponent(sharedState.host) + '/' + sharedState.port;
}

function sharedTreeKey(dirId, path) {
    return String(dirId) + '::' + String(path || '');
}

function sharedSelectedMap(dirId) {
    const id = String(dirId || '');
    if (!id) return {};
    if (!sharedState.selected || typeof sharedState.selected !== 'object') {
        sharedState.selected = {};
    }
    // 兼容旧的扁平 selected；按共享目录隔离，避免根目录树多共享互相串勾选
    if (sharedState.selected[id] && typeof sharedState.selected[id] === 'object' && !Array.isArray(sharedState.selected[id])) {
        return sharedState.selected[id];
    }
    sharedState.selected[id] = {};
    return sharedState.selected[id];
}

function isSharedPathSelected(dirId, path) {
    const map = sharedSelectedMap(dirId);
    return !!map[path || ''];
}

function setSharedPathSelected(dirId, path, on) {
    const map = sharedSelectedMap(dirId);
    const key = path || '';
    if (on) map[key] = true;
    else delete map[key];
}

function collectSharedPermsFromForm(prefix) {
    prefix = prefix || '';
    const perms = {};
    SHARED_PERM_DEFS.forEach(function (item) {
        const el = document.getElementById(prefix + item.key);
        perms[item.key] = !!(el && el.checked);
    });
    return perms;
}

function fillSharedPermsForm(perms, prefix) {
    prefix = prefix || '';
    SHARED_PERM_DEFS.forEach(function (item) {
        const el = document.getElementById(prefix + item.key);
        if (!el) return;
        if (perms && Object.prototype.hasOwnProperty.call(perms, item.key)) {
            el.checked = !!perms[item.key];
        } else {
            el.checked = ['perm_browse', 'perm_download', 'perm_zip'].indexOf(item.key) >= 0;
        }
    });
}

function sharedPermSummary(perms) {
    if (!perms) return '';
    return SHARED_PERM_DEFS.filter(function (item) { return perms[item.key]; })
        .map(function (item) { return item.label; }).join('、') || '无权限';
}

function sharedJsStr(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function updateSharedActionButtons() {
    const eff = sharedState.effective || {};
    const inBrowse = !!sharedState.dirId;
    const rootsPickable = !inBrowse && (sharedState.roots || []).some(function (r) {
        const e = r.effective || {};
        return !!(e.perm_download || e.perm_delete);
    });
    const setDisp = function (id, show) {
        const el = document.getElementById(id);
        if (el) el.style.display = show ? '' : 'none';
    };
    setDisp('shared-btn-download', (inBrowse && !!eff.perm_download) || rootsPickable);
    setDisp('shared-btn-select-all', (inBrowse && (!!eff.perm_download || !!eff.perm_delete)) || rootsPickable);
    setDisp('shared-btn-select-none', (inBrowse && (!!eff.perm_download || !!eff.perm_delete)) || rootsPickable);
    setDisp('shared-btn-upload', inBrowse && !!eff.perm_upload);
    setDisp('shared-btn-mkdir', inBrowse && !!eff.perm_mkdir);
    setDisp('shared-btn-delete', inBrowse && !!eff.perm_delete);
}

function renderSharedBreadcrumb() {
    const crumb = document.getElementById('shared-breadcrumb');
    if (!crumb) return;
    if (!sharedState.dirId) {
        crumb.innerHTML = '共享目录树';
        return;
    }
    const parts = [];
    parts.push(
        '<a href="#" class="shared-crumb-link" onclick="openSharedDir(' +
        sharedState.dirId + ',\'' + sharedJsStr(sharedState.dirName) + '\',\'\'); return false;">' +
        escapeHtml(sharedState.dirName || '根') + '</a>'
    );
    const segs = (sharedState.path || '').split('/').filter(Boolean);
    let acc = '';
    segs.forEach(function (seg) {
        acc = acc ? (acc + '/' + seg) : seg;
        const pathNow = acc;
        parts.push(
            '<a href="#" class="shared-crumb-link" onclick="openSharedDir(' +
            sharedState.dirId + ',\'' + sharedJsStr(sharedState.dirName) + '\',\'' + sharedJsStr(pathNow) +
            '\'); return false;">' + escapeHtml(seg) + '</a>'
        );
    });
    crumb.innerHTML = parts.join('<span class="shared-crumb-sep"> / </span>');
}

async function loadSharedPage() {
    sharedState.treeCache = {};
    await loadSharedHosts();
    await loadSharedRoots();
}

async function loadSharedHosts() {
    const box = document.getElementById('shared-hosts');
    if (!box) return;
    try {
        const response = await apiFetch('/api/shared/hosts');
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '加载节点失败');
        const hosts = data.hosts || [];
        if (!hosts.length) {
            box.innerHTML = '<div class="empty-state">暂无节点</div>';
            return;
        }
        box.innerHTML = hosts.map(function (h) {
            const active = (h.key === sharedState.peerKey) ? ' active' : '';
            const label = escapeHtml(h.label || h.host);
            const ipText = escapeHtml(h.host + ':' + h.port);
            const removeBtn = h.is_local
                ? ''
                : '<button type="button" class="shared-host-remove" onclick="event.stopPropagation(); removeSharedPeer(\'' +
                    escapeHtml(h.host) + '\',' + h.port + ')">×</button>';
            return '<button type="button" class="shared-host-chip' + active + '" onclick="selectSharedHost(\'' +
                escapeHtml(h.key) + '\',\'' + escapeHtml(h.host) + '\',' + h.port + ',' + (h.is_local ? 'true' : 'false') + ')">' +
                '<span class="shared-host-label">' + label + '</span>' +
                '<span class="shared-host-ip">' + ipText + '</span>' +
                removeBtn +
                '</button>';
        }).join('');
        const local = hosts.find(function (h) { return h.is_local; }) || hosts[0];
        if (sharedState.peerKey === 'local' && local) {
            sharedState.host = local.host;
            sharedState.port = local.port;
            sharedState.isLocal = true;
        }
    } catch (error) {
        box.innerHTML = '<div class="empty-state">' + escapeHtml(error.message) + '</div>';
    }
}

async function selectSharedHost(key, host, port, isLocal) {
    sharedState.peerKey = key;
    sharedState.host = host;
    sharedState.port = port;
    sharedState.isLocal = !!isLocal;
    sharedState.view = 'roots';
    sharedState.dirId = null;
    sharedState.path = '';
    sharedState.entries = [];
    sharedState.effective = {};
    sharedState.currentDir = null;
    sharedState.treeCache = {};
    sharedState.selected = {};
    await loadSharedHosts();
    await loadSharedRoots();
}

async function promptAddSharedPeer() {
    const host = await showAppPrompt('请输入对方局域网 IP', '', '添加节点');
    if (host == null || !String(host).trim()) return;
    let port = await showAppPrompt('端口（默认与本机相同）', String(sharedState.port || 5000), '添加节点');
    if (port === null) return;
    port = parseInt(String(port || '5000').trim(), 10) || 5000;
    try {
        const response = await apiFetch('/api/shared/peers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: String(host).trim(), port: port, label: String(host).trim() })
        });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '添加失败');
        showSuccess('已添加节点');
        await loadSharedHosts();
    } catch (error) {
        showError(error.message);
    }
}

async function removeSharedPeer(host, port) {
    try {
        const response = await apiFetch('/api/shared/peers', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: host, port: port })
        });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '移除失败');
        if (sharedState.peerKey === host + ':' + port) {
            sharedState.peerKey = 'local';
            sharedState.isLocal = true;
        }
        showSuccess('已移除节点');
        await loadSharedPage();
    } catch (error) {
        showError(error.message);
    }
}

async function scanSharedHosts() {
    showLoading();
    try {
        const response = await apiFetch('/api/shared/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port: sharedState.port || 5000 })
        });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '扫描失败');
        const hosts = data.hosts || [];
        if (!hosts.length) {
            showSuccess('未发现其他节点');
            return;
        }
        for (const h of hosts) {
            await apiFetch('/api/shared/peers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host: h.host, port: h.port, label: h.label || h.host })
            });
        }
        showSuccess('发现并添加 ' + hosts.length + ' 个节点');
        await loadSharedHosts();
    } catch (error) {
        showError(error.message);
    } finally {
        hideLoading();
    }
}

function renderManagedSharedRoots() {
    const list = document.getElementById('shared-root-list');
    if (!list) return;
    const mine = (sharedState.roots || []).filter(function (item) { return item.can_manage; });
    if (!mine.length) {
        list.innerHTML = '<div class="empty-state">你还没有在此节点添加共享（可添加本机路径或网络路径）</div>';
        return;
    }
    list.innerHTML = mine.map(function (item) {
        return '<div class="shared-root-item">' +
            '<div class="shared-root-meta">' +
            '<strong>' + escapeHtml(item.name) + '</strong>' +
            '<span>' + escapeHtml(item.path || '') + '</span>' +
            '<span>所有者 ' + escapeHtml(item.owner_ip || '-') + ' · ' + escapeHtml(sharedPermSummary(item.permissions)) + '</span>' +
            '</div>' +
            '<div class="shared-root-actions">' +
            '<button type="button" class="filter-btn" onclick="openSharedDir(' + item.id + ',\'' + sharedJsStr(item.name) + '\')">打开</button>' +
            '<button type="button" class="filter-btn" onclick="editSharedDirPerms(' + item.id + ')">权限</button>' +
            '<button type="button" class="filter-btn" onclick="removeSharedDir(' + item.id + ')">移除</button>' +
            '</div></div>';
    }).join('');
}

async function loadSharedRoots() {
    const manage = document.getElementById('shared-manage');
    const upBtn = document.getElementById('shared-btn-up');
    if (manage) manage.style.display = 'block';
    if (upBtn) upBtn.disabled = !sharedState.dirId;
    sharedState.view = sharedState.dirId ? 'browse' : 'roots';
    updateSharedActionButtons();
    renderSharedBreadcrumb();
    try {
        const response = await apiFetch(sharedApiPrefix() + '/dirs');
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '加载共享目录失败');
        sharedState.roots = data.items || [];
        renderManagedSharedRoots();
        if (sharedState.dirId) {
            await openSharedDir(sharedState.dirId, sharedState.dirName, sharedState.path || '', true);
        } else {
            renderSharedTreeRoots();
        }
    } catch (error) {
        const entryList = document.getElementById('shared-entry-list');
        if (entryList) entryList.innerHTML = '<div class="empty-state">' + escapeHtml(error.message) + '</div>';
        renderManagedSharedRoots();
    }
}

function renderSharedTreeRoots() {
    const entryList = document.getElementById('shared-entry-list');
    if (!entryList) return;
    sharedState.view = 'roots';
    sharedState.dirId = null;
    sharedState.path = '';
    sharedState.effective = {};
    updateSharedActionButtons();
    renderSharedBreadcrumb();
    const upBtn = document.getElementById('shared-btn-up');
    if (upBtn) upBtn.disabled = true;
    if (!sharedState.roots.length) {
        entryList.innerHTML = '<div class="empty-state">暂无共享目录</div>';
        return;
    }
    entryList.innerHTML = '<ul class="shared-tree-ul">' + sharedState.roots.map(function (item) {
        return renderSharedTreeNode({
            dirId: item.id,
            dirName: item.name,
            path: '',
            name: item.name,
            type: 'dir',
            has_children: !!item.has_children,
            isRoot: true,
            can_manage: !!item.can_manage,
            owner_ip: item.owner_ip || '',
            effective: item.effective || {},
            depth: 0
        });
    }).join('') + '</ul>';
    syncSharedCheckboxUI();
}

function renderSharedTreeNode(node) {
    const key = sharedTreeKey(node.dirId, node.path);
    const cached = sharedState.treeCache[key];
    const expanded = !!(cached && cached.expanded);
    const hasChildren = !!node.has_children;
    const canExpand = node.type === 'dir' && hasChildren;
    const toggle = canExpand
        ? '<button type="button" class="shared-tree-toggle" title="' + (expanded ? '收起' : '展开') +
            '" onclick="event.stopPropagation(); toggleSharedTreeNode(' +
            node.dirId + ',\'' + sharedJsStr(node.dirName) + '\',\'' + sharedJsStr(node.path) + '\')">' +
            (expanded ? '▼' : '▶') + '</button>'
        : '<span class="shared-tree-toggle shared-tree-leaf">•</span>';
    const icon = node.type === 'dir' ? '📁' : '📄';
    const badge = node.isRoot && node.can_manage ? ' · 我的' : '';
    const sub = node.isRoot
        ? (escapeHtml(node.owner_ip || '') + (node.effective ? ' · ' + escapeHtml(sharedPermSummary(node.effective)) : ''))
        : ((node.type === 'dir' ? '文件夹' : formatProgressSize(node.size || 0)) + (node.mtime ? ' · ' + escapeHtml(node.mtime) : ''));
    const openClick = node.type === 'dir'
        ? 'openSharedDir(' + node.dirId + ',\'' + sharedJsStr(node.dirName) + '\',\'' + sharedJsStr(node.path) + '\')'
        : '';
    const nameHtml = node.type === 'dir'
        ? '<button type="button" class="shared-tree-name" onclick="event.stopPropagation(); ' + openClick + '">' +
            escapeHtml(node.name) + badge + '</button>'
        : '<span class="shared-tree-name">' + escapeHtml(node.name) + '</span>';
    let actions = '';
    const eff = sharedState.dirId === node.dirId ? (sharedState.effective || {}) : (node.effective || sharedState.effective || {});
    if (node.type === 'dir' && hasChildren) {
        actions += '<button type="button" class="filter-btn" onclick="event.stopPropagation(); toggleSharedTreeNode(' +
            node.dirId + ',\'' + sharedJsStr(node.dirName) + '\',\'' + sharedJsStr(node.path) + '\')">' +
            (expanded ? '收起' : '展开') + '</button>';
    }
    if (node.type === 'dir') {
        actions += '<button type="button" class="filter-btn" onclick="event.stopPropagation(); ' + openClick + '">打开</button>';
    }
    if (eff.perm_download && node.path) {
        actions += '<button type="button" class="filter-btn" onclick="event.stopPropagation(); downloadSharedPaths([\'' +
            sharedJsStr(node.path) + '\'], ' + node.dirId + ')">下载</button>';
    }
    if (eff.perm_rename && node.path) {
        actions += '<button type="button" class="filter-btn" onclick="event.stopPropagation(); sharedRenameEntry(\'' +
            sharedJsStr(node.path) + '\',\'' + sharedJsStr(node.name) + '\')">重命名</button>';
    }
    const showCheck = !!(eff.perm_download || eff.perm_delete);
    const checked = isSharedPathSelected(node.dirId, node.path || '');
    const active = (sharedState.dirId === node.dirId && (sharedState.path || '') === (node.path || '')) ? ' active' : '';
    let childrenHtml = '';
    if (expanded && cached && cached.entries) {
        childrenHtml = '<ul class="shared-tree-ul">' + cached.entries.map(function (child) {
            const childPath = node.path ? (node.path + '/' + child.name) : child.name;
            return renderSharedTreeNode({
                dirId: node.dirId,
                dirName: node.dirName,
                path: childPath,
                name: child.name,
                type: child.type,
                size: child.size,
                mtime: child.mtime,
                has_children: !!child.has_children,
                isRoot: false,
                effective: node.effective || sharedState.effective,
                depth: (node.depth || 0) + 1
            });
        }).join('') + '</ul>';
    }
    return '<li class="shared-tree-node" data-rel="' + escapeHtml(node.path || '') + '" data-type="' + node.type + '" data-dir-id="' + node.dirId + '" style="--depth:' + (node.depth || 0) + '">' +
        '<div class="shared-tree-row' + active + (checked ? ' is-checked' : '') + '">' +
        toggle +
        (showCheck
            ? '<input type="checkbox" class="shared-entry-pick" data-rel="' + escapeHtml(node.path || '') +
                '" data-type="' + node.type + '" data-dir-id="' + node.dirId +
                '" data-dir-name="' + escapeHtml(node.dirName || '') + '"' +
                (checked ? ' checked' : '') +
                ' title="' + (node.isRoot || !node.path ? '勾选整个共享目录' : (node.type === 'dir' ? '勾选文件夹及子项' : '勾选文件')) + '"' +
                ' onclick="event.stopPropagation()" onchange="onSharedPickChange(this)">'
            : '') +
        '<span class="shared-entry-icon">' + icon + '</span>' +
        '<div class="shared-entry-meta" ' + (node.type === 'dir' ? 'onclick="' + openClick + '"' : '') + '>' +
        nameHtml +
        '<div class="shared-entry-sub">' + sub + '</div>' +
        '</div>' +
        '<div class="shared-tree-actions">' + actions + '</div>' +
        '</div>' +
        childrenHtml +
        '</li>';
}

async function toggleSharedTreeNode(dirId, dirName, path) {
    const key = sharedTreeKey(dirId, path || '');
    const cached = sharedState.treeCache[key] || { expanded: false, entries: null };
    if (cached.expanded) {
        cached.expanded = false;
        sharedState.treeCache[key] = cached;
        refreshSharedTreeView();
        syncSharedCheckboxUI();
        return;
    }
    try {
        await ensureSharedNodeExpanded(dirId, dirName, path || '');
        if (isSharedPathSelected(dirId, path || '')) {
            selectSharedDescendants(dirId, path || '', true);
        }
        refreshSharedTreeView();
        syncSharedCheckboxUI();
    } catch (error) {
        showError(error.message);
    }
}

function listCachedChildPaths(dirId, path) {
    const key = sharedTreeKey(dirId, path || '');
    const cached = sharedState.treeCache[key];
    if (!cached || !cached.entries) return [];
    const result = [];
    cached.entries.forEach(function (child) {
        const childPath = path ? (path + '/' + child.name) : child.name;
        result.push({
            path: childPath,
            type: child.type,
            has_children: !!child.has_children
        });
        if (child.type === 'dir') {
            result.push.apply(result, listCachedChildPaths(dirId, childPath));
        }
    });
    return result;
}

function clearSharedSelectionByPrefix(dirId, path) {
    const map = sharedSelectedMap(dirId);
    if (!path) {
        sharedState.selected[String(dirId)] = {};
        return;
    }
    const prefix = path + '/';
    Object.keys(map).forEach(function (p) {
        if (p === path || p.indexOf(prefix) === 0) delete map[p];
    });
}

function selectSharedDescendants(dirId, path, checked) {
    const map = sharedSelectedMap(dirId);
    listCachedChildPaths(dirId, path || '').forEach(function (item) {
        if (checked) map[item.path] = true;
        else delete map[item.path];
    });
    if (!checked && path) {
        const prefix = path + '/';
        Object.keys(map).forEach(function (p) {
            if (p.indexOf(prefix) === 0) delete map[p];
        });
    }
}

async function ensureSharedNodeExpanded(dirId, dirName, path) {
    const key = sharedTreeKey(dirId, path || '');
    let cached = sharedState.treeCache[key] || { expanded: false, entries: null };
    if (!cached.entries) {
        const url = sharedApiPrefix() + '/dirs/' + dirId + '/browse?path=' + encodeURIComponent(path || '');
        const response = await apiFetch(url);
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '加载失败');
        cached.entries = data.entries || [];
        if (data.dir) {
            sharedState.currentDir = data.dir;
            // 仅在当前正浏览该共享时覆盖 effective，避免根目录树展开时冲掉其他项权限
            if (sharedState.dirId === dirId) {
                sharedState.effective = data.effective || data.dir.effective || {};
            }
        }
    }
    cached.expanded = true;
    sharedState.treeCache[key] = cached;
    return cached;
}

async function onSharedPickChange(el) {
    const rel = el.getAttribute('data-rel') || '';
    const type = el.getAttribute('data-type') || 'file';
    const checked = !!el.checked;
    const dirId = parseInt(el.getAttribute('data-dir-id') || '0', 10) || sharedState.dirId;
    const dirName = el.getAttribute('data-dir-name') || sharedState.dirName || '';
    if (!dirId) return;

    if (type === 'dir') {
        if (checked) {
            setSharedPathSelected(dirId, rel, true);
            try {
                await ensureSharedNodeExpanded(dirId, dirName, rel);
                selectSharedDescendants(dirId, rel, true);
            } catch (error) {
                showError(error.message);
            }
        } else {
            clearSharedSelectionByPrefix(dirId, rel);
        }
    } else if (checked) {
        setSharedPathSelected(dirId, rel, true);
    } else {
        setSharedPathSelected(dirId, rel, false);
    }

    syncSharedAncestorSelection(dirId, rel);
    refreshSharedTreeView();
    syncSharedCheckboxUI();
}

function syncSharedAncestorSelection(dirId, rel) {
    if (!dirId) return;
    const map = sharedSelectedMap(dirId);
    // 子项变化后，根目录与祖先都不再保持“显式全选”
    if (rel) delete map[''];
    const parts = (rel || '').split('/').filter(Boolean);
    for (let i = parts.length - 1; i >= 1; i--) {
        delete map[parts.slice(0, i).join('/')];
    }
}

function folderHasSelectedDescendant(dirId, path) {
    const map = sharedSelectedMap(dirId);
    const prefix = path ? path + '/' : '';
    return Object.keys(map).some(function (p) {
        if (!map[p] || p === '') return false;
        if (!path) return true;
        return p.indexOf(prefix) === 0;
    });
}

function getSharedFolderCheckState(dirId, path) {
    const key = sharedTreeKey(dirId, path || '');
    const cached = sharedState.treeCache[key];
    const selfSelected = isSharedPathSelected(dirId, path || '');

    // 只有用户主动勾选该文件夹(含共享根)时，才显示“全部选中”
    if (selfSelected) return 'checked';

    // 未展开：只要有任意子孙被选中，就显示半选
    if (!cached || !cached.expanded || !cached.entries || !cached.entries.length) {
        return folderHasSelectedDescendant(dirId, path || '') ? 'partial' : 'unchecked';
    }

    let checkedCount = 0;
    let partial = false;
    cached.entries.forEach(function (child) {
        const childPath = path ? (path + '/' + child.name) : child.name;
        if (child.type === 'dir') {
            const st = getSharedFolderCheckState(dirId, childPath);
            if (st === 'checked') checkedCount += 1;
            else if (st === 'partial') partial = true;
        } else if (isSharedPathSelected(dirId, childPath)) {
            checkedCount += 1;
        }
    });

    // 有子项被选中/半选，但本文件夹未被显式勾选 → 一律半选
    if (partial || checkedCount > 0) return 'partial';
    return 'unchecked';
}

function syncSharedCheckboxUI() {
    document.querySelectorAll('.shared-entry-pick').forEach(function (el) {
        const rel = el.getAttribute('data-rel') || '';
        const type = el.getAttribute('data-type') || 'file';
        const dirId = parseInt(el.getAttribute('data-dir-id') || '0', 10) || sharedState.dirId;
        if (!dirId) return;
        let state = 'unchecked';
        if (type === 'dir') {
            state = getSharedFolderCheckState(dirId, rel);
        } else {
            state = isSharedPathSelected(dirId, rel) ? 'checked' : 'unchecked';
        }
        el.checked = state === 'checked';
        el.indeterminate = state === 'partial';
        const row = el.closest('.shared-tree-row');
        if (row) {
            row.classList.toggle('is-checked', state === 'checked');
            row.classList.toggle('is-partial', state === 'partial');
        }
        if (state === 'partial' || state === 'unchecked') {
            setSharedPathSelected(dirId, rel, false);
        }
    });
}

function refreshSharedTreeView() {
    if (!sharedState.dirId) {
        renderSharedTreeRoots();
        syncSharedCheckboxUI();
        return;
    }
    renderSharedBrowseTree();
    syncSharedCheckboxUI();
}

function renderSharedBrowseTree() {
    const entryList = document.getElementById('shared-entry-list');
    if (!entryList) return;
    const key = sharedTreeKey(sharedState.dirId, sharedState.path || '');
    const cached = sharedState.treeCache[key];
    const entries = (cached && cached.entries) || sharedState.entries || [];
    if (!entries.length) {
        entryList.innerHTML = '<div class="empty-state">空文件夹</div>';
        return;
    }
    sharedState.treeCache[key] = {
        expanded: cached ? !!cached.expanded : true,
        entries: entries
    };
    // 浏览层本身始终展示子项；子目录可再展开/收起
    if (!cached) sharedState.treeCache[key].expanded = true;
    entryList.innerHTML = '<ul class="shared-tree-ul">' + entries.map(function (child) {
        const childPath = sharedState.path ? (sharedState.path + '/' + child.name) : child.name;
        return renderSharedTreeNode({
            dirId: sharedState.dirId,
            dirName: sharedState.dirName,
            path: childPath,
            name: child.name,
            type: child.type,
            size: child.size,
            mtime: child.mtime,
            has_children: !!child.has_children,
            isRoot: false,
            effective: sharedState.effective,
            depth: 0
        });
    }).join('') + '</ul>';
}

async function addSharedDir() {
    const pathEl = document.getElementById('shared-dir-path');
    const nameEl = document.getElementById('shared-dir-name');
    const path = pathEl ? pathEl.value.trim() : '';
    const name = nameEl ? nameEl.value.trim() : '';
    if (!path) {
        showError('请填写目录路径或网络地址');
        return;
    }
    try {
        const response = await apiFetch(sharedApiPrefix() + '/dirs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: path,
                name: name,
                permissions: collectSharedPermsFromForm()
            })
        });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '添加失败');
        if (pathEl) pathEl.value = '';
        if (nameEl) nameEl.value = '';
        showSuccess('已添加共享目录');
        sharedState.treeCache = {};
        await loadSharedRoots();
    } catch (error) {
        showError(error.message);
    }
}

function editSharedDirPerms(id) {
    const item = (sharedState.roots || []).find(function (row) { return row.id === id; });
    if (!item || !item.can_manage) {
        showError('只能修改自己添加的共享目录');
        return;
    }
    sharedState.editingId = id;
    const nameEl = document.getElementById('shared-edit-name');
    const pathEl = document.getElementById('shared-edit-path');
    const errEl = document.getElementById('shared-perm-modal-error');
    if (nameEl) nameEl.value = item.name || '';
    if (pathEl) pathEl.value = item.path || '';
    if (errEl) {
        errEl.style.display = 'none';
        errEl.textContent = '';
    }
    fillSharedPermsForm(item.permissions || {}, 'edit_');
    const modal = document.getElementById('shared-perm-modal');
    if (modal) modal.style.display = 'flex';
}

function closeSharedPermModal() {
    sharedState.editingId = null;
    const modal = document.getElementById('shared-perm-modal');
    if (modal) modal.style.display = 'none';
}

async function saveSharedPermModal() {
    const id = sharedState.editingId;
    if (!id) return;
    const nameEl = document.getElementById('shared-edit-name');
    const errEl = document.getElementById('shared-perm-modal-error');
    const name = nameEl ? nameEl.value.trim() : '';
    if (!name) {
        if (errEl) {
            errEl.textContent = '显示名称不能为空';
            errEl.style.display = 'block';
        }
        return;
    }
    try {
        const response = await apiFetch(sharedApiPrefix() + '/dirs/' + id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name,
                permissions: collectSharedPermsFromForm('edit_')
            })
        });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '保存失败');
        closeSharedPermModal();
        showSuccess('已保存');
        sharedState.treeCache = {};
        await loadSharedRoots();
    } catch (error) {
        if (errEl) {
            errEl.textContent = error.message;
            errEl.style.display = 'block';
        } else {
            showError(error.message);
        }
    }
}

async function removeSharedDir(id) {
    if (!(await showAppConfirm('确定移除该共享目录？', '移除共享'))) return;
    try {
        const response = await apiFetch(sharedApiPrefix() + '/dirs/' + id, { method: 'DELETE' });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '移除失败');
        showSuccess('已移除');
        if (sharedState.dirId === id) {
            sharedState.dirId = null;
            sharedState.path = '';
        }
        sharedState.treeCache = {};
        await loadSharedRoots();
    } catch (error) {
        showError(error.message);
    }
}

async function openSharedDir(dirId, dirName, path, silent) {
    const dirChanged = sharedState.dirId !== dirId;
    sharedState.view = 'browse';
    sharedState.dirId = dirId;
    sharedState.dirName = dirName || sharedState.dirName || '';
    sharedState.path = path || '';
    if (dirChanged) sharedState.selected = {};
    const upBtn = document.getElementById('shared-btn-up');
    try {
        const url = sharedApiPrefix() + '/dirs/' + dirId + '/browse?path=' + encodeURIComponent(sharedState.path);
        const response = await apiFetch(url);
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '浏览失败');
        sharedState.path = data.path || '';
        sharedState.parent = data.parent || '';
        sharedState.entries = data.entries || [];
        sharedState.currentDir = data.dir || null;
        sharedState.effective = data.effective || (data.dir && data.dir.effective) || {};
        if (data.dir && data.dir.name) sharedState.dirName = data.dir.name;
        const key = sharedTreeKey(dirId, sharedState.path || '');
        sharedState.treeCache[key] = {
            expanded: true,
            entries: sharedState.entries
        };
        if (upBtn) upBtn.disabled = false;
        updateSharedActionButtons();
        renderSharedBreadcrumb();
        renderSharedBrowseTree();
        syncSharedCheckboxUI();
    } catch (error) {
        if (!silent) showError(error.message);
        const entryList = document.getElementById('shared-entry-list');
        if (entryList) entryList.innerHTML = '<div class="empty-state">' + escapeHtml(error.message) + '</div>';
        updateSharedActionButtons();
    }
}

function sharedJoinPath(base, name) {
    if (!base) return name;
    return base.replace(/\/+$/, '') + '/' + name;
}

function sharedGoUp() {
    if (!sharedState.dirId) {
        loadSharedRoots();
        return;
    }
    if (!sharedState.path) {
        sharedState.dirId = null;
        sharedState.path = '';
        sharedState.effective = {};
        renderSharedTreeRoots();
        return;
    }
    openSharedDir(sharedState.dirId, sharedState.dirName, sharedState.parent || '');
}

function sharedSelectAll(checked) {
    const tasks = [];
    document.querySelectorAll('.shared-entry-pick').forEach(function (el) {
        const rel = el.getAttribute('data-rel') || '';
        const type = el.getAttribute('data-type') || 'file';
        const dirId = parseInt(el.getAttribute('data-dir-id') || '0', 10) || sharedState.dirId;
        const dirName = el.getAttribute('data-dir-name') || sharedState.dirName || '';
        if (!dirId) return;
        if (sharedState.dirId && dirId !== sharedState.dirId) return;
        if (checked) {
            setSharedPathSelected(dirId, rel, true);
            if (type === 'dir') {
                tasks.push(
                    ensureSharedNodeExpanded(dirId, dirName, rel)
                        .then(function () {
                            selectSharedDescendants(dirId, rel, true);
                        })
                        .catch(function () {})
                );
            }
        } else if (type === 'dir') {
            clearSharedSelectionByPrefix(dirId, rel);
        } else {
            setSharedPathSelected(dirId, rel, false);
        }
    });
    Promise.all(tasks).then(function () {
        refreshSharedTreeView();
        syncSharedCheckboxUI();
    });
}

function getSharedSelectedPaths(dirId) {
    dirId = dirId || sharedState.dirId;
    const map = sharedSelectedMap(dirId);
    let all = Object.keys(map).filter(function (p) {
        return !!map[p] && p !== '';
    }).sort();
    if (map[''] && !all.length) {
        all = listCachedChildPaths(dirId, '').map(function (item) { return item.path; }).sort();
    }
    return all.filter(function (path) {
        return !all.some(function (other) {
            if (other === path) return false;
            return path.indexOf(other + '/') === 0;
        });
    });
}

async function downloadSharedSelection() {
    const targets = [];
    if (sharedState.dirId) {
        targets.push(sharedState.dirId);
    } else {
        Object.keys(sharedState.selected || {}).forEach(function (id) {
            const map = sharedState.selected[id];
            if (map && typeof map === 'object' && Object.keys(map).some(function (k) { return !!map[k]; })) {
                targets.push(parseInt(id, 10));
            }
        });
    }
    if (!targets.length) {
        showError('请先打开一个共享目录或勾选内容');
        return;
    }
    let downloaded = false;
    for (let i = 0; i < targets.length; i++) {
        const dirId = targets[i];
        const paths = getSharedSelectedPaths(dirId);
        if (!paths.length) continue;
        if (sharedState.dirId === dirId && !(sharedState.effective || {}).perm_download) {
            showError('没有下载权限');
            return;
        }
        await downloadSharedPaths(paths, dirId);
        downloaded = true;
    }
    if (!downloaded) {
        showError('请先勾选文件或文件夹');
    }
}

async function downloadSharedPaths(paths, dirId) {
    dirId = dirId || sharedState.dirId;
    if (!dirId || !paths || !paths.length) return;
    if (sharedState.dirId === dirId && !(sharedState.effective || {}).perm_download) {
        showError('没有下载权限');
        return;
    }
    showTransferProgress('正在下载', '正在从共享目录获取...');
    try {
        const url = sharedApiPrefix() + '/dirs/' + dirId + '/download';
        const response = await apiFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: paths })
        });
        if (!response.ok) {
            let errorMessage = '下载失败';
            try {
                const data = await response.json();
                errorMessage = data.error || errorMessage;
            } catch (e) {}
            throw new Error(errorMessage);
        }
        const blob = await readResponseWithProgress(response, function (loaded, total) {
            updateTransferProgress(
                loaded,
                total,
                '已下载 ' + formatProgressSize(loaded) + (total ? ' / ' + formatProgressSize(total) : '')
            );
        });
        updateTransferProgress(1, 1, '下载完成');
        const a = document.createElement('a');
        const objectUrl = window.URL.createObjectURL(blob);
        a.href = objectUrl;
        a.download = filenameFromDownloadResponse(response);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(objectUrl);
        showSuccess(paths.length > 1 ? '已打包下载' : '下载成功');
    } catch (error) {
        showError(error.message);
    } finally {
        hideTransferProgress();
    }
}

async function sharedMkdir() {
    if (!(sharedState.effective || {}).perm_mkdir || !sharedState.dirId) {
        showError('没有新建文件夹权限');
        return;
    }
    const name = await showAppPrompt('新文件夹名称', '', '新建文件夹');
    if (name == null || !String(name).trim()) return;
    try {
        const response = await apiFetch(sharedApiPrefix() + '/dirs/' + sharedState.dirId + '/mkdir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: sharedState.path || '', name: String(name).trim() })
        });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '创建失败');
        showSuccess('已创建');
        delete sharedState.treeCache[sharedTreeKey(sharedState.dirId, sharedState.path || '')];
        await openSharedDir(sharedState.dirId, sharedState.dirName, sharedState.path || '');
    } catch (error) {
        showError(error.message);
    }
}

async function sharedUploadFiles(event) {
    const files = event.target && event.target.files;
    if (!files || !files.length) return;
    if (!(sharedState.effective || {}).perm_upload || !sharedState.dirId) {
        showError('没有上传权限');
        event.target.value = '';
        return;
    }
    showTransferProgress('正在上传', '上传到共享目录...');
    try {
        for (let i = 0; i < files.length; i++) {
            const formData = new FormData();
            formData.append('file', files[i]);
            formData.append('path', sharedState.path || '');
            updateTransferProgress(i, files.length, '上传 ' + files[i].name);
            const response = await apiFetch(sharedApiPrefix() + '/dirs/' + sharedState.dirId + '/upload', {
                method: 'POST',
                body: formData
            });
            const data = await response.json().catch(function () { return {}; });
            if (!response.ok) throw new Error(data.error || ('上传失败: ' + files[i].name));
        }
        showSuccess('上传完成');
        delete sharedState.treeCache[sharedTreeKey(sharedState.dirId, sharedState.path || '')];
        await openSharedDir(sharedState.dirId, sharedState.dirName, sharedState.path || '');
    } catch (error) {
        showError(error.message);
    } finally {
        hideTransferProgress();
        event.target.value = '';
    }
}

async function sharedDeleteSelection() {
    if (!(sharedState.effective || {}).perm_delete || !sharedState.dirId) {
        showError('没有删除权限');
        return;
    }
    const paths = getSharedSelectedPaths(sharedState.dirId);
    if (!paths.length) {
        showError('请先勾选要删除的内容');
        return;
    }
    if (!(await showAppConfirm('确定删除选中的 ' + paths.length + ' 项？此操作不可恢复', '删除'))) return;
    try {
        const response = await apiFetch(sharedApiPrefix() + '/dirs/' + sharedState.dirId + '/delete-entry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: paths })
        });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '删除失败');
        showSuccess('已删除');
        delete sharedState.treeCache[sharedTreeKey(sharedState.dirId, sharedState.path || '')];
        await openSharedDir(sharedState.dirId, sharedState.dirName, sharedState.path || '');
    } catch (error) {
        showError(error.message);
    }
}

async function sharedRenameEntry(rel, oldName) {
    if (!(sharedState.effective || {}).perm_rename || !sharedState.dirId) {
        showError('没有重命名权限');
        return;
    }
    const name = await showAppPrompt('新名称', oldName || '', '重命名');
    if (name == null || !String(name).trim() || String(name).trim() === oldName) return;
    try {
        const response = await apiFetch(sharedApiPrefix() + '/dirs/' + sharedState.dirId + '/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: rel, name: String(name).trim() })
        });
        const data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || '重命名失败');
        showSuccess('已重命名');
        delete sharedState.treeCache[sharedTreeKey(sharedState.dirId, sharedState.path || '')];
        await openSharedDir(sharedState.dirId, sharedState.dirName, sharedState.path || '');
    } catch (error) {
        showError(error.message);
    }
}
