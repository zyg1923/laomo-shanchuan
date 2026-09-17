/**
 * 闪传 - 管理员登录页面JavaScript脚本
 * 功能：密码可见性切换、表单验证、防止重复提交
 * 作者：闪传系统
 * 更新时间：2025-12-22
 */

// ==========================================
// 页面初始化
// ==========================================

/**
 * DOM内容加载完成后执行
 * 初始化登录页面的所有交互功能
 */
document.addEventListener('DOMContentLoaded', function() {
    console.log('登录页面JavaScript初始化...');
    
    // 初始化登录功能
    initLogin();
    
    console.log('登录页面JavaScript初始化完成');
});

/**
 * 初始化登录功能
 * 绑定所有事件监听器
 */
function initLogin() {
    const passwordInput = document.getElementById('password');
    const usernameInput = document.getElementById('username');
    const toggleButton = document.getElementById('toggle-password');
    const loginForm = document.getElementById('login-form');
    const loginButton = document.getElementById('login-btn');
    
    if (!passwordInput || !toggleButton || !loginForm || !loginButton) {
        return;
    }

    if (usernameInput) usernameInput.value = '';
    passwordInput.value = '';
    setTimeout(function () {
        if (usernameInput) usernameInput.value = '';
        passwordInput.value = '';
    }, 50);
    
    // ======================================
    // 绑定事件监听器
    // ======================================
    
    /**
     * 密码可见性切换
     * 点击眼睛图标时切换密码输入框的类型
     */
    toggleButton.addEventListener('click', function() {
        togglePasswordVisibility(passwordInput, toggleButton);
    });
    
    /**
     * 表单提交处理
     * 在提交前进行验证并添加加载状态
     */
    loginForm.addEventListener('submit', function(event) {
        handleFormSubmit(event, passwordInput, loginForm, loginButton);
    });
    
    /**
     * 回车键提交表单
     * 在密码输入框中按下回车键时提交表单
     */
    passwordInput.addEventListener('keypress', function(event) {
        handleKeyPress(event, loginForm);
    });
    
    /**
     * 输入框获得焦点时的效果
     */
    passwordInput.addEventListener('focus', function() {
        console.log('密码输入框获得焦点');
        // 可以在这里添加获得焦点时的额外逻辑，比如显示帮助提示
    });
    
    /**
     * 输入框失去焦点时的验证
     */
    passwordInput.addEventListener('blur', function() {
        validatePasswordInput(passwordInput);
    });
}

// ==========================================
// 密码可见性切换功能
// ==========================================

/**
 * 切换密码可见性
 * 根据当前状态在密码和文本类型之间切换
 * 
 * @param {HTMLInputElement} input - 密码输入框元素
 * @param {HTMLButtonElement} button - 切换按钮元素
 */
function togglePasswordVisibility(input, button) {
    // 获取当前输入框的类型
    const currentType = input.getAttribute('type');
    
    // 如果当前是密码类型，切换为文本类型（显示密码）
    if (currentType === 'password') {
        input.setAttribute('type', 'text');
        button.classList.add('is-visible');
        button.title = '隐藏密码';
        button.setAttribute('aria-label', '隐藏密码');
        console.log('密码已显示');
    } 
    // 如果当前是文本类型，切换为密码类型（隐藏密码）
    else {
        input.setAttribute('type', 'password');
        button.classList.remove('is-visible');
        button.title = '显示密码';
        button.setAttribute('aria-label', '显示密码');
        console.log('密码已隐藏');
    }
}

// ==========================================
// 表单提交处理功能
// ==========================================

/**
 * 处理表单提交
 * 验证密码是否为空，并添加加载状态防止重复提交
 * 
 * @param {Event} event - 提交事件对象
 * @param {HTMLInputElement} passwordInput - 密码输入框元素
 * @param {HTMLFormElement} form - 表单元素
 * @param {HTMLButtonElement} button - 提交按钮元素
 */
function handleFormSubmit(event, passwordInput, form, button) {
    // 获取输入的密码值并去除首尾空格
    const passwordValue = passwordInput.value.trim();
    
    // ======================================
    // 验证密码是否为空
    // ======================================
    
    if (!passwordValue) {
        // 阻止表单提交
        event.preventDefault();
        const err = document.getElementById('login-error');
        if (err) {
            err.textContent = '请输入密码';
            err.style.display = 'block';
        }
        passwordInput.focus();
        
        console.warn('登录失败：密码为空');
        return;
    }
    
    // ======================================
    // 添加加载状态
    // ======================================
    
    // 添加loading类到表单（改变样式）
    form.classList.add('loading');
    
    // 禁用登录按钮，防止重复点击
    button.disabled = true;
    
    console.log('表单正在提交...');
}

// ==========================================
// 键盘事件处理
// ==========================================

/**
 * 处理键盘按键事件
 * 监听回车键并提交表单
 * 
 * @param {Event} event - 键盘事件对象
 * @param {HTMLFormElement} form - 表单元素
 */
function handleKeyPress(event, form) {
    // 检查是否按下了回车键（Enter）
    if (event.key === 'Enter') {
        // 阻止默认的回车行为（比如换行或提交）
        event.preventDefault();
        
        // 提交表单
        form.submit();
        
        console.log('通过回车键提交表单');
    }
}

// ==========================================
// 输入验证功能
// ==========================================

/**
 * 验证密码输入
 * 在输入框失去焦点时检查密码长度
 * 
 * @param {HTMLInputElement} input - 密码输入框元素
 */
function validatePasswordInput(input) {
    // 获取输入的密码值并去除首尾空格
    const passwordValue = input.value.trim();
    
    // ======================================
    // 密码长度检查（可选）
    // ======================================
    
    // 如果用户输入了密码且长度较短，给出提示
    if (passwordValue.length > 0 && passwordValue.length < 6) {
        console.warn('密码长度较短，建议使用更安全的密码（至少6位）');
        // 可以在这里添加UI提示，例如显示警告文字
        // showWarningMessage('密码长度较短，建议使用更安全的密码');
    }
}

// ==========================================
// 工具函数
// ==========================================

/**
 * 显示警告消息（可选功能）
 * 在页面上显示警告提示，用于辅助输入验证
 * 
 * @param {string} message - 警告消息内容
 */
function showWarningMessage(message) {
    // 检查是否已存在警告消息容器
    let warningContainer = document.getElementById('warning-message-container');
    
    // 如果不存在，创建一个
    if (!warningContainer) {
        warningContainer = document.createElement('div');
        warningContainer.id = 'warning-message-container';
        warningContainer.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background-color: #fff3cd;
            color: #856404;
            padding: 12px 24px;
            border-radius: 8px;
            border: 1px solid #ffeeba;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 9999;
            font-size: 14px;
            transition: opacity 0.3s ease;
        `;
        document.body.appendChild(warningContainer);
    }
    
    // 设置警告消息内容
    warningContainer.textContent = message;
    warningContainer.style.opacity = '1';
    
    // 3秒后自动隐藏警告消息
    setTimeout(() => {
        warningContainer.style.opacity = '0';
        
        // 动画结束后移除元素
        setTimeout(() => {
            if (warningContainer.parentNode) {
                warningContainer.parentNode.removeChild(warningContainer);
            }
        }, 300);
    }, 3000);
}

/**
 * 清空输入框（可选功能）
 * 清空密码输入框并重置状态
 * 
 * @param {HTMLInputElement} input - 密码输入框元素
 * @param {HTMLButtonElement} toggleButton - 切换按钮元素
 * @param {HTMLFormElement} form - 表单元素
 */
function clearForm(input, toggleButton, form) {
    // 清空输入框
    input.value = '';
    
    // 恢复为密码类型（隐藏密码）
    input.setAttribute('type', 'password');
    
    // 恢复按钮图标
    toggleButton.textContent = '👁️';
    
    // 移除loading状态
    form.classList.remove('loading');
    
    console.log('表单已清空');
}
