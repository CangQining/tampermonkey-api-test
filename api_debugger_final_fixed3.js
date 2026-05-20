// ==UserScript==
// @name         API接口调试助手[豆包]
// @namespace    http://tampermonkey.net/
// @version      1.6.0
// @description  自动记录网页API请求，支持重发、调试、导出，按网站隔离请求数据，支持表格自定义字段
// @author       You
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// ==/UserScript==
(function() {
    'use strict';
    // 配置 - 按网站区分存储，避免不同网站请求混淆
    const origin = window.location.origin;
    const originKey = origin.replace(/[^a-zA-Z0-9]/g, '_');
    const STORAGE_KEY = `api_debugger_requests_${originKey}`;
    const CONFIG_KEY = `api_debugger_config_${originKey}`;
    const DEFAULT_MAX_REQUESTS = 100; // 默认最大保存请求数
    // 全局变量
    let requests = [];
    let filteredRequests = [];
    let config = {
        autoSave: true,
        showPanel: false,
        filterText: '',
        selectedRequest: null,
        responseViewMode: 'json', // json, table
        customTableFields: [], // 自定义表格展示字段
        maxRequests: DEFAULT_MAX_REQUESTS, // 最大保存请求数
        tableDataPath: 'data', // 表格数据路径，如 'data.list'
        panelHeight: 50, // 面板高度百分比（底部模式）
        panelWidth: 50, // 面板宽度百分比（侧边模式）
        panelPosition: 'bottom', // 面板位置：bottom/side
        hotkey: 'ctrl+shift+q', // 自定义快捷键
        rawResponseSizeLimit: 512 * 1024 // 原始响应体保存上限（字节），默认 512KB
    };
    // 加载数据
    function loadData() {
        try {
            const savedRequests = GM_getValue(STORAGE_KEY, []);
            const savedConfig = GM_getValue(CONFIG_KEY, {});
            requests = savedRequests;
            filteredRequests = [...requests];
            // 加载的时候，不加载customTableFields，因为用户说不需要自动保存
            const { customTableFields, ...restConfig } = savedConfig;
            config = { ...config, ...restConfig };
        } catch (e) {
            console.error('加载数据失败:', e);
            requests = [];
            filteredRequests = [];
        }
    }
    // 保存数据
    function saveData() {
        if (!config.autoSave) return;
        
        try {
            // 限制保存的请求数量
            if (config.maxRequests > 0 && requests.length > config.maxRequests) {
                requests = requests.slice(-config.maxRequests);
                // 重新应用当前搜索过滤，保留用户的筛选状态
                filterRequests();
            }
            
            // 保存的时候，不保存customTableFields，因为用户说不需要自动保存
            const { customTableFields, ...saveConfig } = config;
            GM_setValue(STORAGE_KEY, requests);
            GM_setValue(CONFIG_KEY, saveConfig);
        } catch (e) {
            console.error('保存数据失败:', e);
        }
    }
    // 转义HTML（用于innerHTML文本节点，会转义所有特殊字符）
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    // 轻量转义（用于 input value="" 属性或 textarea 内容）
    // 只转义 < > & " 防止提前闭合标签，不转义其余字符，避免内容被二次转义
    function escapeAttr(text) {
        if (text === null || text === undefined) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    // 根据路径获取对象属性
    function getValueByPath(obj, path) {
        if (!path || !obj) return obj;
        const keys = path.split('.');
        let result = obj;
        for (const key of keys) {
            if (result && typeof result === 'object' && key in result) {
                result = result[key];
            } else {
                return undefined;
            }
        }
        return result;
    }
    // 可折叠的JSON格式化
    function formatJSONCollapsible(obj, level = 0) {
        if (obj === undefined || obj === null) {
            return `<span style="color: #969696;">null</span>`;
        }
        if (typeof obj !== 'object') {
            const color = typeof obj === 'string' ? '#ce9178' : 
                         (typeof obj === 'number' || typeof obj === 'boolean' ? '#b5cea8' : '#d4d4d4');
            // 使用 escapeAttr 而非 escapeHtml，避免 & 等字符被二次转义显示为 &amp;
            return `<span style="color: ${color}">${escapeAttr(JSON.stringify(obj))}</span>`;
        }
        const isArray = Array.isArray(obj);
        const items = Object.entries(obj);
        const isEmpty = items.length === 0;
        if (isEmpty) {
            return isArray ? `[]` : `{}`;
        }
        let html = '';
        const id = 'json-node-' + Math.random().toString(36).substr(2, 9);
        if (isArray) {
            html += `<span class="json-toggle" data-target="${id}" style="cursor: pointer; color: #569cd6; user-select: none;">▼</span> [`;
        } else {
            html += `<span class="json-toggle" data-target="${id}" style="cursor: pointer; color: #569cd6; user-select: none;">▼</span> {`;
        }
        html += `<div id="${id}" class="json-children">`;
        
        items.forEach(([key, value], index) => {
            const comma = index < items.length - 1 ? ',' : '';
            const keyColor = '#9cdcfe';
            const keyHtml = isArray ? '' : `<span style="color: ${keyColor}">"${escapeAttr(key)}"</span>: `;
            
            html += `<div style="padding-left: 16px;">${keyHtml}${formatJSONCollapsible(value, level + 1)}${comma}</div>`;
        });
        html += `</div>`;
        html += `<div style="padding-left: ${level * 16}px;">${isArray ? ']' : '}'}</div>`;
        return html;
    }
    // 绑定JSON折叠事件
    function bindJsonToggleEvents() {
        document.querySelectorAll('.json-toggle').forEach(toggle => {
            if (toggle) {
                toggle.onclick = function() {
                    const targetId = this.dataset.target;
                    const target = document.getElementById(targetId);
                    if (target && target.style) {
                        if (target.style.display === 'none') {
                            target.style.display = 'block';
                            this.textContent = '▼';
                        } else {
                            target.style.display = 'none';
                            this.textContent = '▶';
                        }
                    }
                };
            }
        });
    }
    // 渲染为表格
    function renderAsTable(data) {
        if (!Array.isArray(data) || data.length === 0) {
            return '<span style="color: #969696;">无数据</span>';
        }
        // 获取所有字段
        const allFields = new Set();
        data.forEach(item => {
            if (typeof item === 'object') {
                Object.keys(item).forEach(k => allFields.add(k));
            }
        });
        let fieldList = Array.from(allFields);
        // 如果有自定义字段，就用自定义的
        if (config.customTableFields && config.customTableFields.length > 0) {
            // 过滤掉不存在的字段
            const filtered = config.customTableFields.filter(f => allFields.has(f));
            // 若过滤后为空（字段全不匹配），回退到全部字段，避免表头空白
            fieldList = filtered.length > 0 ? filtered : Array.from(allFields);
        }
        if (fieldList.length === 0) {
            return '<span style="color: #969696;">无可展示字段</span>';
        }
        
        let html = '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">';
        html += '<thead><tr style="background: #2d2d30;">';
        fieldList.forEach(field => {
            html += `<th style="padding: 6px 8px; text-align: left; border: 1px solid #3c3c3c;">${escapeHtml(field)}</th>`;
        });
        html += '</tr></thead>';
        html += '<tbody>';
        data.forEach(item => {
            html += '<tr>';
            fieldList.forEach(field => {
                const value = item ? item[field] : undefined;
                let displayValue = '';
                if (value === undefined || value === null) {
                    displayValue = '<span style="color: #969696;">-</span>';
                } else if (typeof value === 'object') {
                    displayValue = '<span style="color: #569cd6;">Object</span>';
                } else {
                    displayValue = escapeHtml(String(value));
                }
                html += `<td style="padding: 6px 8px; border: 1px solid #3c3c3c;">${displayValue}</td>`;
            });
            html += '</tr>';
        });
        html += '</tbody></table>';
        return html;
    }
    // 更新浮动按钮的请求数量显示，99个以后显示99+
    function updateFloatButtonCount() {
        const btn = document.getElementById('api-debugger-float-btn');
        if (btn) {
            const count = requests.length;
            const displayCount = count > 99 ? '99+' : count;
            btn.innerHTML = `🔧 API (${displayCount})`;
        }
    }
    // 渲染请求列表
    function updateRequestList() {
        const tbody = document.getElementById('api-requests-tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        filteredRequests.slice().reverse().forEach((req, index) => {
            const tr = document.createElement('tr');
            const isSelected = config.selectedRequest && config.selectedRequest.id === req.id;
            
            tr.style.background = isSelected ? '#094771' : 'transparent';
            tr.style.cursor = 'pointer';
            tr.onclick = () => selectRequest(req);
            // 方法颜色
            const methodColors = {
                GET: '#5cb85c',
                POST: '#f0ad4e',
                PUT: '#5bc0de',
                DELETE: '#d9534f',
                PATCH: '#6f42c1',
                HEAD: '#777',
                OPTIONS: '#777'
            };
            const methodColor = methodColors[req.method] || '#777';
            // 状态颜色
            let statusColor = '#969696';
            if (req.status >= 200 && req.status < 300) statusColor = '#5cb85c';
            else if (req.status >= 300 && req.status < 400) statusColor = '#f0ad4e';
            else if (req.status >= 400) statusColor = '#d9534f';
            // 截断URL
            let url = req.url;
            if (url.length > 30) {
                url = url.substring(0, 27) + '...';
            }
            tr.innerHTML = `
                <td style="padding: 6px 8px; border-bottom: 1px solid #3c3c3c;">
                    <span style="color: ${methodColor}; font-weight: bold;">${req.method}</span>
                </td>
                <td style="padding: 6px 8px; border-bottom: 1px solid #3c3c3c; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    ${escapeHtml(url)}
                </td>
                <td style="padding: 6px 8px; border-bottom: 1px solid #3c3c3c;">
                    <span style="color: ${statusColor}">${req.status || '-'}</span>
                </td>
                <td style="padding: 6px 8px; border-bottom: 1px solid #3c3c3c;">
                    ${req.duration || '-'}ms
                </td>
            `;
            tbody.appendChild(tr);
        });
        // 更新浮动按钮的请求数量
        updateFloatButtonCount();
    }
    // 选择请求
    function selectRequest(req) {
        // 选择新请求的时候，重置自定义字段，因为用户说不需要自动保存
        config.customTableFields = [];
        config.selectedRequest = req;
        renderRequestDetail(req);
        updateRequestList();
    }
    // 渲染请求详情
    function renderRequestDetail(request) {
        // 切换请求时清空响应容器，强制工具栏重建，保证事件绑定指向新请求
        const responseContainer = document.getElementById('response-content');
        if (responseContainer) responseContainer.innerHTML = '';
        // 渲染请求内容
        renderRequestContent(request);
        // 渲染响应内容
        renderResponseContent(request);
        // 渲染头信息
        renderHeadersContent(request);
        // 渲染重发界面
        renderReplayContent(request);
        
        // 绑定JSON折叠事件
        setTimeout(bindJsonToggleEvents, 0);
    }
    // 渲染请求内容
    function renderRequestContent(request) {
        const container = document.getElementById('request-content');
        if (!container) return;
        let content = '';
        content += `<div><strong>URL:</strong> ${escapeHtml(request.url)}</div>`;
        content += `<div><strong>方法:</strong> ${request.method}</div>`;
        content += `<div><strong>时间:</strong> ${new Date(request.timestamp).toLocaleString()}</div>`;
        
        if (request.requestBody) {
            content += `<div style="margin-top: 12px;"><strong>请求体:</strong></div>`;
            content += `<div style="padding: 8px; background: #252526; border-radius: 4px; margin-top: 4px;">`;
            if (typeof request.requestBody === 'object') {
                content += formatJSONCollapsible(request.requestBody);
            } else {
                content += `<pre style="margin: 0; white-space: pre-wrap; word-wrap: break-word;">${escapeHtml(request.requestBody)}</pre>`;
            }
            content += `</div>`;
        }
        container.innerHTML = content;
    }
    // 只更新响应内容区（不碰工具栏，避免重建输入框导致焦点丢失）
    function renderResponseBody(request) {
        const bodyEl = document.getElementById('response-body');
        if (!bodyEl) return;
        const mode = config.responseViewMode;
        const response = request.response;
        const rawResponse = request.rawResponse;
        let content = '';
        if (response === undefined || response === null) {
            content = '<span style="color: #969696;">无响应数据</span>';
        } else if (mode === 'json' && typeof response === 'object') {
            content = formatJSONCollapsible(response);
        } else if (mode === 'table') {
            let tableData = getValueByPath(response, config.tableDataPath);
            if (Array.isArray(tableData)) {
                content = renderAsTable(tableData);
            } else if (Array.isArray(response)) {
                content = renderAsTable(response);
            } else {
                content = '<span style="color: #d9534f;">无法找到数组数据，请检查数据路径是否正确。</span>';
            }
        } else {
            if (rawResponse !== undefined) {
                content = '<pre style="margin: 0; white-space: pre-wrap; word-wrap: break-word; color: #d4d4d4;">' + escapeHtml(rawResponse) + '</pre>';
            } else {
                content = '<pre style="margin: 0; white-space: pre-wrap; word-wrap: break-word; color: #d4d4d4;">' + escapeHtml(JSON.stringify(response, null, 2)) + '</pre>';
            }
        }
        bodyEl.innerHTML = content;
        setTimeout(bindJsonToggleEvents, 0);
    }
    // 渲染响应内容
    // 工具栏（select/input）只在首次或切换请求时重建；
    // oninput 时只调用 renderResponseBody()，不会销毁输入框，焦点不丢失。
    function renderResponseContent(request) {
        const container = document.getElementById('response-content');
        if (!container) return;
        const mode = config.responseViewMode;

        // 工具栏已存在则只同步 select 的选中状态，不重建 DOM
        const existingToolbar = container.querySelector('#response-toolbar');
        if (!existingToolbar) {
            // 首次渲染：构建完整结构（工具栏 + 内容区）
            container.innerHTML =
                '<div id="response-toolbar" style="margin-bottom: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">' +
                    '<label style="color: #969696;">展示模式:</label>' +
                    '<select id="response-view-mode" style="padding: 2px 6px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px;">' +
                        '<option value="json">JSON格式化</option>' +
                        '<option value="table">表格展示</option>' +
                        '<option value="raw">原始数据</option>' +
                    '</select>' +
                    '<label style="color: #969696; margin-left: 8px;">数据路径:</label>' +
                    '<input type="text" id="table-data-path" placeholder="如: data.list" style="padding: 2px 6px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; width: 120px;">' +
                    '<button id="custom-table-fields-btn" style="padding: 2px 8px; background: #3c3c3c; border: none; color: #d4d4d4; border-radius: 3px; cursor: pointer; font-size: 12px;">自定义字段</button>' +
                    '<button id="copy-response-btn" style="padding: 2px 8px; background: #3c3c3c; border: none; color: #d4d4d4; border-radius: 3px; cursor: pointer; font-size: 12px;">复制</button>' +
                '</div>' +
                '<div id="response-body" style="padding: 8px; background: #252526; border-radius: 4px;"></div>';

            // 绑定展示模式下拉
            const viewMode = document.getElementById('response-view-mode');
            if (viewMode) {
                viewMode.onchange = function() {
                    config.responseViewMode = this.value;
                    if (config.selectedRequest) renderResponseBody(config.selectedRequest);
                    saveData();
                };
            }
            // 绑定数据路径输入框（oninput 只刷新内容区，不重建工具栏）
            const dataPath = document.getElementById('table-data-path');
            if (dataPath) {
                dataPath.oninput = function() {
                    config.tableDataPath = this.value.trim();
                    if (config.selectedRequest) renderResponseBody(config.selectedRequest);
                    saveData();
                };
            }
        } // end if (!existingToolbar)

        // 无论首次还是复用工具栏，都同步控件状态（不会触发 oninput/onchange）
        const vmEl = document.getElementById('response-view-mode');
        if (vmEl) vmEl.value = mode;
        const dpEl = document.getElementById('table-data-path');
        if (dpEl && document.activeElement !== dpEl) {
            // 只在输入框未聚焦时同步，避免覆盖用户正在编辑的内容
            dpEl.value = config.tableDataPath;
        }

        // 绑定自定义字段按钮（每次都重新绑，因为切换请求后 fieldsBtn 事件里的 request 引用需要更新）
        const fieldsBtn = document.getElementById('custom-table-fields-btn');
        if (fieldsBtn) {
            fieldsBtn.onclick = () => {
                // 首先获取当前响应的所有字段
                if (!config.selectedRequest) {
                    showNotification('请先选择一个请求');
                    return;
                }
                const response = config.selectedRequest.response;
                if (!response) {
                    showNotification('没有响应数据');
                    return;
                }
                // 获取数据
                let tableData = getValueByPath(response, config.tableDataPath);
                if (!Array.isArray(tableData)) {
                    tableData = response;
                }
                if (!Array.isArray(tableData) || tableData.length === 0) {
                    showNotification('没有表格数据可自定义字段');
                    return;
                }
                // 获取所有字段
                const allFields = new Set();
                tableData.forEach(item => {
                    if (typeof item === 'object') {
                        Object.keys(item).forEach(k => allFields.add(k));
                    }
                });
                const fieldList = Array.from(allFields);
                
                // 创建对话框
                const dialog = document.createElement('div');
                dialog.style.cssText = `
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background: #252526;
                    border: 1px solid #3c3c3c;
                    border-radius: 6px;
                    padding: 20px;
                    z-index: 1000000;
                    min-width: 300px;
                    max-height: 400px;
                    overflow-y: auto;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                `;
                let fieldsHtml = '';
                fieldList.forEach(field => {
                    // 默认全部勾选
                    const checked = true;
                    fieldsHtml += `
                        <label style="display: block; margin: 8px 0; color: #d4d4d4; cursor: pointer;">
                            <input type="checkbox" class="field-checkbox" value="${escapeHtml(field)}" checked>
                            ${escapeHtml(field)}
                        </label>
                    `;
                });
                dialog.innerHTML = `
                    <h3 style="margin: 0 0 16px 0; color: #007acc;">自定义表格字段</h3>
                    <div style="margin-bottom: 16px;">
                        勾选需要展示的字段：
                        ${fieldsHtml}
                    </div>
                    <div style="display: flex; gap: 8px; justify-content: flex-end;">
                        <button id="fields-cancel" style="padding: 6px 16px; background: #3c3c3c; border: none; color: #d4d4d4; border-radius: 3px; cursor: pointer;">取消</button>
                        <button id="fields-save" style="padding: 6px 16px; background: #007acc; border: none; color: white; border-radius: 3px; cursor: pointer;">保存</button>
                    </div>
                `;
                // 遮罩
                const mask = document.createElement('div');
                mask.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0,0,0,0.5);
                    z-index: 999999;
                `;
                document.body.appendChild(mask);
                document.body.appendChild(dialog);
                
                // 绑定事件
                const cancelBtn = dialog.querySelector('#fields-cancel');
                if (cancelBtn) {
                    cancelBtn.onclick = () => {
                        document.body.removeChild(dialog);
                        document.body.removeChild(mask);
                    };
                }
                const saveBtn = dialog.querySelector('#fields-save');
                if (saveBtn) {
                    saveBtn.onclick = () => {
                        // 获取选中的字段
                        const checkboxes = dialog.querySelectorAll('.field-checkbox:checked');
                        const selectedFields = Array.from(checkboxes).map(cb => cb.value);
                        config.customTableFields = selectedFields;
                        // 不保存到GM存储，因为用户说不需要自动保存
                        // 重新渲染响应内容
                        if (config.selectedRequest) {
                            renderResponseBody(config.selectedRequest);
                        }
                        document.body.removeChild(dialog);
                        document.body.removeChild(mask);
                        showNotification('字段设置已生效');
                    };
                }
                mask.onclick = () => {
                    document.body.removeChild(dialog);
                    document.body.removeChild(mask);
                };
            };
        }
        // 复制响应按钮（每次重新绑，保证引用最新 request）
        const copyBtn = document.getElementById('copy-response-btn');
        if (copyBtn) {
            copyBtn.onclick = function() {
                if (config.selectedRequest) {
                    const response = config.selectedRequest.response;
                    if (copyToClipboard(JSON.stringify(response, null, 2))) {
                        showNotification('响应数据已复制到剪贴板');
                    }
                }
            };
        }

        // 渲染内容区
        renderResponseBody(request);
    }
    // 渲染头信息
    function renderHeadersContent(request) {
        const container = document.getElementById('headers-content');
        if (!container) return;
        let html = '';
        
        if (request.requestHeaders) {
            html += `<div style="margin-bottom: 16px;">
                <h4 style="margin: 0 0 8px 0; color: #9cdcfe;">请求头</h4>
                <table style="width: 100%; border-collapse: collapse;">`;
            Object.entries(request.requestHeaders).forEach(([key, value]) => {
                html += `<tr>
                    <td style="padding: 4px 8px; border: 1px solid #3c3c3c; width: 30%; color: #9cdcfe;">${escapeHtml(key)}</td>
                    <td style="padding: 4px 8px; border: 1px solid #3c3c3c;">${escapeHtml(String(value))}</td>
                </tr>`;
            });
            html += `</table></div>`;
        }
        if (request.responseHeaders) {
            html += `<div>
                <h4 style="margin: 0 0 8px 0; color: #9cdcfe;">响应头</h4>
                <table style="width: 100%; border-collapse: collapse;">`;
            Object.entries(request.responseHeaders).forEach(([key, value]) => {
                html += `<tr>
                    <td style="padding: 4px 8px; border: 1px solid #3c3c3c; width: 30%; color: #9cdcfe;">${escapeHtml(key)}</td>
                    <td style="padding: 4px 8px; border: 1px solid #3c3c3c;">${escapeHtml(String(value))}</td>
                </tr>`;
            });
            html += `</table></div>`;
        }
        container.innerHTML = html || '<span style="color: #969696;">无头部信息</span>';
    }
    // 渲染重发界面
    function renderReplayContent(request) {
        const container = document.getElementById('replay-content');
        if (!container) return;
        container.innerHTML = `
            <div style="margin-bottom: 12px;">
                <label style="display: block; margin-bottom: 4px; color: #969696;">请求方法</label>
                <select id="replay-method" style="width: 100%; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box;">
                    <option value="GET" ${request.method === 'GET' ? 'selected' : ''}>GET</option>
                    <option value="POST" ${request.method === 'POST' ? 'selected' : ''}>POST</option>
                    <option value="PUT" ${request.method === 'PUT' ? 'selected' : ''}>PUT</option>
                    <option value="DELETE" ${request.method === 'DELETE' ? 'selected' : ''}>DELETE</option>
                    <option value="PATCH" ${request.method === 'PATCH' ? 'selected' : ''}>PATCH</option>
                    <option value="HEAD" ${request.method === 'HEAD' ? 'selected' : ''}>HEAD</option>
                    <option value="OPTIONS" ${request.method === 'OPTIONS' ? 'selected' : ''}>OPTIONS</option>
                </select>
            </div>
            <div style="margin-bottom: 12px;">
                <label style="display: block; margin-bottom: 4px; color: #969696;">请求URL</label>
                <input type="text" id="replay-url" value="${escapeAttr(request.url)}" style="width: 100%; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box;">
            </div>
            <div style="margin-bottom: 12px;">
                <label style="display: block; margin-bottom: 4px; color: #969696;">请求头 (JSON格式)</label>
                <textarea id="replay-headers" style="width: 100%; height: 100px; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box; font-family: monospace;">${escapeAttr(JSON.stringify(request.requestHeaders || {}, null, 2))}</textarea>
            </div>
            <div style="margin-bottom: 12px;">
                <label style="display: block; margin-bottom: 4px; color: #969696;">请求体</label>
                <textarea id="replay-body" style="width: 100%; height: 150px; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box; font-family: monospace;">${request.requestBody ? escapeAttr(typeof request.requestBody === 'object' ? JSON.stringify(request.requestBody, null, 2) : request.requestBody) : ''}</textarea>
            </div>
            <button id="replay-send-btn" style="padding: 8px 24px; background: #007acc; border: none; color: white; border-radius: 3px; cursor: pointer; font-size: 14px;">发送请求</button>
            <div id="replay-result" style="margin-top: 16px; display: none;">
                <h4 style="margin: 0 0 8px 0; color: #9cdcfe;">响应结果</h4>
                <div id="replay-result-content" style="padding: 8px; background: #252526; border-radius: 4px; min-height: 50px;"></div>
            </div>
        `;
        // 绑定发送按钮
        const replaySendBtn = document.getElementById('replay-send-btn');
        if (replaySendBtn) {
            replaySendBtn.onclick = async () => {
                await sendReplayRequest(request);
            };
        }
    }
    // 发送重发请求
    async function sendReplayRequest(originalRequest) {
        const methodEl = document.getElementById('replay-method');
        const urlEl = document.getElementById('replay-url');
        const headersEl = document.getElementById('replay-headers');
        const bodyEl = document.getElementById('replay-body');
        const resultDiv = document.getElementById('replay-result');
        const resultContent = document.getElementById('replay-result-content');
        if (!methodEl || !urlEl || !headersEl || !bodyEl) return;
        
        try {
            let headers;
            try {
                headers = JSON.parse(headersEl.value);
            } catch (e) {
                if (resultDiv) resultDiv.style.display = 'block';
                if (resultContent) resultContent.innerHTML = `<span style="color: #d9534f;">请求头格式错误，请检查JSON格式: ${escapeHtml(e.message)}</span>`;
                return;
            }
            let body = bodyEl.value;
            
            // 如果是JSON格式的body，尝试解析
            try {
                body = JSON.parse(body);
            } catch (e) {
                // 不是JSON，保持原样
            }
            if (resultDiv) resultDiv.style.display = 'block';
            if (resultContent) resultContent.innerHTML = '<span style="color: #969696;">请求中...</span>';
            // 使用GM_xmlhttpRequest发送请求
            const startTime = Date.now();
            
            GM_xmlhttpRequest({
                method: methodEl.value,
                url: urlEl.value,
                headers: headers,
                data: typeof body === 'object' ? JSON.stringify(body) : body,
                timeout: 30000,
                onload: function(response) {
                    const duration = Date.now() - startTime;
                    
                    let responseData = response.responseText;
                    try {
                        responseData = JSON.parse(response.responseText);
                    } catch (e) {
                        // 不是JSON
                    }
                    if (resultContent) {
                        resultContent.innerHTML = `
                            <div style="margin-bottom: 8px;">
                                <span style="color: #969696;">状态: </span>
                                <span style="color: ${response.status >= 400 ? '#d9534f' : '#5cb85c'}">${response.status} ${response.statusText}</span>
                                <span style="color: #969696; margin-left: 16px;">耗时: </span>
                                <span>${duration}ms</span>
                            </div>
                            ${formatJSONCollapsible(responseData)}
                        `;
                        
                        setTimeout(bindJsonToggleEvents, 0);
                    }
                },
                onerror: function(error) {
                    if (resultContent) {
                        resultContent.innerHTML = `<span style="color: #d9534f;">请求失败: ${error}</span>`;
                    }
                },
                ontimeout: function() {
                    if (resultContent) {
                        resultContent.innerHTML = `<span style="color: #d9534f;">请求超时（30s）</span>`;
                    }
                }
            });
        } catch (e) {
            if (resultDiv) resultDiv.style.display = 'block';
            if (resultContent) {
                resultContent.innerHTML = `<span style="color: #d9534f;">参数解析失败: ${e.message}</span>`;
            }
        }
    }
    // 发送自定义请求
    async function sendCustomRequest() {
        const methodEl = document.getElementById('custom-method');
        const urlEl = document.getElementById('custom-url');
        const headersEl = document.getElementById('custom-headers');
        const bodyEl = document.getElementById('custom-body');
        const resultDiv = document.getElementById('custom-result');
        const resultContent = document.getElementById('custom-result-content');
        if (!methodEl || !urlEl || !headersEl || !bodyEl) return;
        
        if (!urlEl.value) {
            if (resultDiv) resultDiv.style.display = 'block';
            if (resultContent) resultContent.innerHTML = `<span style="color: #d9534f;">请输入请求URL</span>`;
            return;
        }
        try {
            let headers = {};
            if (headersEl.value.trim()) {
                headers = JSON.parse(headersEl.value);
            }
            
            let body = bodyEl.value;
            // 如果是JSON格式的body，尝试解析
            try {
                if (bodyEl.value.trim()) {
                    body = JSON.parse(bodyEl.value);
                }
            } catch (e) {
                // 不是JSON，保持原样
            }
            if (resultDiv) resultDiv.style.display = 'block';
            if (resultContent) resultContent.innerHTML = '<span style="color: #969696;">请求中...</span>';
            // 使用GM_xmlhttpRequest发送请求
            const startTime = Date.now();
            
            GM_xmlhttpRequest({
                method: methodEl.value,
                url: urlEl.value,
                headers: headers,
                data: (methodEl.value !== 'GET' && methodEl.value !== 'HEAD') ? (typeof body === 'object' ? JSON.stringify(body) : body) : undefined,
                timeout: 30000,
                onload: function(response) {
                    const duration = Date.now() - startTime;
                    
                    let responseData = response.responseText;
                    try {
                        responseData = JSON.parse(response.responseText);
                    } catch (e) {
                        // 不是JSON
                    }
                    if (resultContent) {
                        resultContent.innerHTML = `
                            <div style="margin-bottom: 8px;">
                                <span style="color: #969696;">状态: </span>
                                <span style="color: ${response.status >= 400 ? '#d9534f' : '#5cb85c'}">${response.status} ${response.statusText}</span>
                                <span style="color: #969696; margin-left: 16px;">耗时: </span>
                                <span>${duration}ms</span>
                            </div>
                            ${formatJSONCollapsible(responseData)}
                        `;
                        
                        setTimeout(bindJsonToggleEvents, 0);
                    }
                },
                onerror: function(error) {
                    if (resultContent) {
                        resultContent.innerHTML = `<span style="color: #d9534f;">请求失败: ${error}</span>`;
                    }
                },
                ontimeout: function() {
                    if (resultContent) {
                        resultContent.innerHTML = `<span style="color: #d9534f;">请求超时（30s）</span>`;
                    }
                }
            });
        } catch (e) {
            if (resultDiv) resultDiv.style.display = 'block';
            if (resultContent) {
                resultContent.innerHTML = `<span style="color: #d9534f;">参数解析失败: ${e.message}</span>`;
            }
        }
    }
    // 复制到剪贴板
    function copyToClipboard(text) {
        // 优先使用现代 Clipboard API
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => {});
            return true;
        }
        // 降级：使用 execCommand（已废弃但兼容旧环境）
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            return true;
        } catch (e) {
            return false;
        }
    }
    // 显示通知
    function showNotification(text) {
        try {
            GM_notification({
                title: 'API调试助手',
                text: text,
                timeout: 2000
            });
        } catch (e) {
            // 降级处理：在页面内显示 toast，不阻塞页面
            const toast = document.createElement('div');
            toast.textContent = text;
            toast.style.cssText = `
                position: fixed;
                bottom: 80px;
                right: 20px;
                background: #333;
                color: #fff;
                padding: 8px 16px;
                border-radius: 4px;
                z-index: 10000000;
                font-size: 13px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.4);
                pointer-events: none;
            `;
            document.body.appendChild(toast);
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 2000);
        }
    }
    // 筛选请求
    function filterRequests() {
        const filterText = config.filterText.toLowerCase();
        const methodFilter = config.methodFilter || '';
        filteredRequests = requests.filter(req => {
            // 方法筛选
            if (methodFilter && req.method !== methodFilter) {
                return false;
            }
            // 文本筛选
            if (filterText) {
                const urlMatch = req.url.toLowerCase().includes(filterText);
                const methodMatch = req.method.toLowerCase().includes(filterText);
                const bodyMatch = req.requestBody && JSON.stringify(req.requestBody).toLowerCase().includes(filterText);
                const responseMatch = req.response && JSON.stringify(req.response).toLowerCase().includes(filterText);
                
                return urlMatch || methodMatch || bodyMatch || responseMatch;
            }
            return true;
        });
        updateRequestList();
    }
    // 切换标签页
    function switchTab(tabName) {
        // 更新标签状态
        document.querySelectorAll('#api-debugger-panel .tab').forEach(tab => {
            if (tab && tab.dataset) {
                if (tab.dataset.tab === tabName) {
                    tab.classList.add('active');
                    tab.style.borderBottomColor = '#007acc';
                    tab.style.color = '#007acc';
                } else {
                    tab.classList.remove('active');
                    tab.style.borderBottomColor = 'transparent';
                    tab.style.color = '#969696';
                }
            }
        });
        // 显示对应内容
        document.querySelectorAll('#api-debugger-panel .tab-panel').forEach(p => {
            if (p && p.style) p.style.display = 'none';
        });
        const tabEl = document.getElementById(`tab-${tabName}`);
        if (tabEl && tabEl.style) tabEl.style.display = 'block';
    }
    // 绑定面板事件
    function bindPanelEvents(panel) {
        if (!panel) return;
        
        // 标签页点击
        panel.querySelectorAll('.tab').forEach(tab => {
            if (tab) {
                tab.onclick = () => switchTab(tab.dataset.tab);
            }
        });
        // 关闭按钮
        const toggleBtn = panel.querySelector('#api-toggle-btn');
        if (toggleBtn) {
            toggleBtn.onclick = () => {
                if (panel && panel.style) panel.style.display = 'none';
                config.showPanel = false;
                const btn = document.getElementById('api-debugger-float-btn');
                if (btn) btn.style.display = 'block';
                saveData();
            };
        }
        // 搜索框
        const filterInput = panel.querySelector('#api-filter-input');
        if (filterInput) {
            filterInput.value = config.filterText;
            filterInput.oninput = function() {
                config.filterText = this.value;
                filterRequests();
            };
        }
        // 方法筛选
        const methodFilter = panel.querySelector('#api-method-filter');
        if (methodFilter) {
            methodFilter.value = config.methodFilter || '';
            methodFilter.onchange = function() {
                config.methodFilter = this.value;
                filterRequests();
            };
        }
        // 清空按钮
        const clearBtn = panel.querySelector('#api-clear-btn');
        if (clearBtn) {
            clearBtn.onclick = () => {
                if (confirm('确定要清空所有请求记录吗？')) {
                    requests = [];
                    filteredRequests = [];
                    config.selectedRequest = null;
                    updateRequestList();
                    const requestContent = document.getElementById('request-content');
                    if (requestContent) requestContent.innerHTML = '';
                    const responseContent = document.getElementById('response-content');
                    if (responseContent) responseContent.innerHTML = '';
                    const headersContent = document.getElementById('headers-content');
                    if (headersContent) headersContent.innerHTML = '';
                    const replayContent = document.getElementById('replay-content');
                    if (replayContent) replayContent.innerHTML = '';
                    saveData();
                    showNotification('已清空所有请求');
                }
            };
        }
        // 导出按钮
        const exportBtn = panel.querySelector('#api-export-btn');
        if (exportBtn) {
            exportBtn.onclick = () => {
                // 只导出持久化配置，剔除瞬时状态（selectedRequest、filterText 等）
                const { selectedRequest, filterText, methodFilter, customTableFields, ...persistConfig } = config;
                const data = {
                    requests: requests,
                    config: persistConfig,
                    exportTime: new Date().toISOString(),
                    origin: origin
                };
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `api-debugger-export-${Date.now()}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                showNotification('导出成功');
            };
        }
        // 导入按钮
        const importBtn = panel.querySelector('#api-import-btn');
        if (importBtn) {
            importBtn.onclick = () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.onchange = function(e) {
                    const file = e.target.files[0];
                    if (!file) return;
                    
                    const reader = new FileReader();
                    reader.onload = function(e) {
                        try {
                            const data = JSON.parse(e.target.result);
                            requests = data.requests || [];
                            filteredRequests = [...requests];
                            if (data.config) {
                                // 导入的时候，也不导入customTableFields
                                const { customTableFields, ...restConfig } = data.config;
                                config = { ...config, ...restConfig };
                            }
                            updateRequestList();
                            saveData();
                            showNotification('导入成功');
                        } catch (err) {
                            showNotification('导入失败：文件格式错误');
                        }
                    };
                    reader.readAsText(file);
                };
                input.click();
            };
        }
        // 自定义请求发送按钮
        const customSendBtn = panel.querySelector('#custom-send-btn');
        if (customSendBtn) {
            customSendBtn.onclick = async () => {
                await sendCustomRequest();
            };
        }
        // 设置按钮
        const settingsBtn = panel.querySelector('#api-settings-btn');
        if (settingsBtn) {
            settingsBtn.onclick = () => {
                // 创建设置对话框
                const dialog = document.createElement('div');
                dialog.style.cssText = `
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background: #252526;
                    border: 1px solid #3c3c3c;
                    border-radius: 6px;
                    padding: 20px;
                    z-index: 1000000;
                    min-width: 300px;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                `;
                dialog.innerHTML = `
                    <h3 style="margin: 0 0 16px 0; color: #007acc;">设置</h3>
                    <div style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 4px; color: #969696;">面板位置</label>
                        <select id="settings-panel-position" style="width: 100%; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box;">
                            <option value="bottom" ${config.panelPosition === 'bottom' ? 'selected' : ''}>底部（可调整高度）</option>
                            <option value="side" ${config.panelPosition === 'side' ? 'selected' : ''}>右侧（可调整宽度）</option>
                        </select>
                    </div>
                    <div style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 4px; color: #969696;">最大保存请求数</label>
                        <input type="number" id="settings-max-requests" value="${config.maxRequests}" style="width: 100%; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box;">
                        <div style="font-size: 11px; color: #969696;">0 表示永不主动清除，默认 100</div>
                    </div>
                    <div style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 4px; color: #969696;">面板高度（底部模式，百分比）</label>
                        <input type="number" id="settings-panel-height" value="${config.panelHeight}" style="width: 100%; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box;">
                        <div style="font-size: 11px; color: #969696;">底部面板的默认高度，建议10-80之间</div>
                    </div>
                    <div style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 4px; color: #969696;">面板宽度（侧边模式，百分比）</label>
                        <input type="number" id="settings-panel-width" value="${config.panelWidth}" style="width: 100%; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box;">
                        <div style="font-size: 11px; color: #969696;">侧边面板的默认宽度，建议20-80之间</div>
                    </div>
                    <div style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 4px; color: #969696;">快捷键</label>
                        <input type="text" id="settings-hotkey" value="${escapeAttr(config.hotkey)}" placeholder="如: ctrl+shift+q" style="width: 100%; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box;">
                        <div style="font-size: 11px; color: #969696;">用 + 连接修饰键和主键，如 ctrl+shift+q、alt+shift+a</div>
                    </div>
                    <div style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 4px; color: #969696;">响应体保存上限（KB）</label>
                        <input type="number" id="settings-response-size" value="${Math.round(config.rawResponseSizeLimit / 1024)}" style="width: 100%; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box;">
                        <div style="font-size: 11px; color: #969696;">超出部分会被截断，默认 512KB，0 表示不限制</div>
                    </div>
                    <div style="display: flex; gap: 8px; justify-content: flex-end;">
                        <button id="settings-cancel" style="padding: 6px 16px; background: #3c3c3c; border: none; color: #d4d4d4; border-radius: 3px; cursor: pointer;">取消</button>
                        <button id="settings-save" style="padding: 6px 16px; background: #007acc; border: none; color: white; border-radius: 3px; cursor: pointer;">保存</button>
                    </div>
                `;
                // 遮罩
                const mask = document.createElement('div');
                mask.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0,0,0,0.5);
                    z-index: 999999;
                `;
                document.body.appendChild(mask);
                document.body.appendChild(dialog);
                // 绑定事件
                const sCancelBtn = dialog.querySelector('#settings-cancel');
                if (sCancelBtn) {
                    sCancelBtn.onclick = () => {
                        document.body.removeChild(dialog);
                        document.body.removeChild(mask);
                    };
                }
                const sSaveBtn = dialog.querySelector('#settings-save');
                if (sSaveBtn) {
                    sSaveBtn.onclick = () => {
                        // 最大请求数
                        const maxReqInput = document.getElementById('settings-max-requests');
                        let maxReq = parseInt(maxReqInput?.value) || 0;
                        if (maxReq < 0) maxReq = 0;
                        config.maxRequests = maxReq;
                        
                        // 面板位置
                        const positionInput = document.getElementById('settings-panel-position');
                        if (positionInput) config.panelPosition = positionInput.value;
                        
                        // 面板高度
                        const heightInput = document.getElementById('settings-panel-height');
                        let height = parseInt(heightInput?.value) || 50;
                        if (height < 10) height = 10;
                        if (height > 80) height = 80;
                        config.panelHeight = height;
                        
                        // 面板宽度
                        const widthInput = document.getElementById('settings-panel-width');
                        let width = parseInt(widthInput?.value) || 50;
                        if (width < 20) width = 20;
                        if (width > 80) width = 80;
                        config.panelWidth = width;

                        // 快捷键
                        const hotkeyInput = document.getElementById('settings-hotkey');
                        if (hotkeyInput && hotkeyInput.value.trim()) {
                            config.hotkey = hotkeyInput.value.trim().toLowerCase();
                        }

                        // 响应体大小上限
                        const sizeInput = document.getElementById('settings-response-size');
                        let sizeKB = parseInt(sizeInput?.value) || 512;
                        if (sizeKB < 0) sizeKB = 0;
                        config.rawResponseSizeLimit = sizeKB === 0 ? Infinity : sizeKB * 1024;
                        
                        saveData();
                        
                        // 保存后重新创建面板以应用新的位置配置
                        const oldPanel = document.getElementById('api-debugger-panel');
                        if (oldPanel) {
                            document.body.removeChild(oldPanel);
                        }
                        const oldBtn = document.getElementById('api-debugger-float-btn');
                        if (oldBtn) {
                            document.body.removeChild(oldBtn);
                        }
                        createPanel();
                        
                        document.body.removeChild(dialog);
                        document.body.removeChild(mask);
                        showNotification('设置已保存');
                    };
                }
                mask.onclick = () => {
                    document.body.removeChild(dialog);
                    document.body.removeChild(mask);
                };
            };
        }
        // 面板大小调整
        const resizer = document.getElementById('api-resizer');
        if (resizer) {
            let isResizing = false;
            resizer.addEventListener('mousedown', function(e) {
                isResizing = true;
                if (config.panelPosition === 'bottom') {
                    document.body.style.cursor = 'ns-resize';
                } else {
                    document.body.style.cursor = 'ew-resize';
                }
                document.body.style.userSelect = 'none';
            });
            document.addEventListener('mousemove', function(e) {
                if (!isResizing) return;
                if (config.panelPosition === 'bottom') {
                    // 底部模式，调整高度
                    const windowHeight = window.innerHeight;
                    const newHeight = ((windowHeight - e.clientY) / windowHeight) * 100;
                    // 限制最小高度10%，最大高度80%
                    if (newHeight >= 10 && newHeight <= 80) {
                        if (panel && panel.style) panel.style.height = newHeight + '%';
                        config.panelHeight = newHeight;
                    }
                } else {
                    // 侧边模式，调整宽度
                    const windowWidth = window.innerWidth;
                    const newWidth = ((windowWidth - e.clientX) / windowWidth) * 100;
                    // 限制最小宽度20%，最大宽度80%
                    if (newWidth >= 20 && newWidth <= 80) {
                        if (panel && panel.style) panel.style.width = newWidth + '%';
                        config.panelWidth = newWidth;
                    }
                }
            });
            document.addEventListener('mouseup', function() {
                if (isResizing) {
                    isResizing = false;
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                    saveData();
                }
            });
        }
        // 初始化
        filterRequests();
    }
    // 创建面板
    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'api-debugger-panel';
        
        let panelStyle, resizerStyle, resizerTitle;
        if (config.panelPosition === 'bottom') {
            panelStyle = `
                position: fixed;
                bottom: 0;
                left: 0;
                right: 0;
                height: ${config.panelHeight}%;
                background: #1e1e1e;
                color: #d4d4d4;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 13px;
                z-index: 999999;
                display: none;
                flex-direction: column;
                box-shadow: 0 -2px 10px rgba(0,0,0,0.3);
            `;
            resizerStyle = `height: 12px; background: #007acc; cursor: ns-resize; user-select: none; display: flex; align-items: center; justify-content: center; border-bottom: 1px solid #005a9e;`;
            resizerTitle = '👆 这里！按住这里拖动调整面板高度！';
        } else { // side
            panelStyle = `
                position: fixed;
                right: 0;
                top: 0;
                bottom: 0;
                width: ${config.panelWidth}%;
                background: #1e1e1e;
                color: #d4d4d4;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 13px;
                z-index: 999999;
                display: none;
                flex-direction: column;
                box-shadow: -2px 0 10px rgba(0,0,0,0.3);
            `;
            resizerStyle = `width: 12px; background: #007acc; cursor: ew-resize; user-select: none; display: flex; align-items: center; justify-content: center; border-right: 1px solid #005a9e;`;
            resizerTitle = '👈 这里！按住这里拖动调整面板宽度！';
        }
        panel.style.cssText = panelStyle;
        
        panel.innerHTML = `
            <!-- 可拖动的分隔条 -->
            <div id="api-resizer" style="${resizerStyle}" title="${resizerTitle}">
                <div style="display: flex; gap: 3px;">
                    <div style="width: 4px; height: 4px; background: rgba(255,255,255,0.6); border-radius: 50%;"></div>
                    <div style="width: 4px; height: 4px; background: rgba(255,255,255,0.6); border-radius: 50%;"></div>
                    <div style="width: 4px; height: 4px; background: rgba(255,255,255,0.6); border-radius: 50%;"></div>
                </div>
            </div>
            
            <!-- 头部 -->
            <div class="panel-header" style="padding: 8px 12px; background: #252526; border-bottom: 1px solid #3c3c3c; display: flex; align-items: center; gap: 8px;">
                <div style="font-weight: bold; color: #007acc; font-size: 14px;">API接口调试助手</div>
                <input type="text" id="api-filter-input" placeholder="搜索接口、参数..." style="flex: 1; max-width: 300px; padding: 4px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; outline: none;">
                <select id="api-method-filter" style="padding: 4px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px;">
                    <option value="">全部方法</option>
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="DELETE">DELETE</option>
                    <option value="PATCH">PATCH</option>
                </select>
                <button id="api-settings-btn" style="padding: 4px 12px; background: #6f42c1; border: none; color: white; border-radius: 3px; cursor: pointer;">设置</button>
                <button id="api-clear-btn" style="padding: 4px 12px; background: #d9534f; border: none; color: white; border-radius: 3px; cursor: pointer;">清空</button>
                <button id="api-export-btn" style="padding: 4px 12px; background: #5bc0de; border: none; color: white; border-radius: 3px; cursor: pointer;">导出</button>
                <button id="api-import-btn" style="padding: 4px 12px; background: #5cb85c; border: none; color: white; border-radius: 3px; cursor: pointer;">导入</button>
                <button id="api-toggle-btn" style="padding: 4px 8px; background: #3c3c3c; border: none; color: #d4d4d4; border-radius: 3px; cursor: pointer;">×</button>
            </div>
            
            <!-- 主体 -->
            <div class="panel-body" style="flex: 1; display: flex; overflow: hidden;">
                <!-- 请求列表 -->
                <div class="request-list" style="width: 40%; border-right: 1px solid #3c3c3c; overflow-y: auto;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <thead>
                            <tr style="background: #2d2d30; position: sticky; top: 0;">
                                <th style="padding: 6px 8px; text-align: left; border-bottom: 1px solid #3c3c3c;">方法</th>
                                <th style="padding: 6px 8px; text-align: left; border-bottom: 1px solid #3c3c3c;">接口</th>
                                <th style="padding: 6px 8px; text-align: left; border-bottom: 1px solid #3c3c3c;">状态</th>
                                <th style="padding: 6px 8px; text-align: left; border-bottom: 1px solid #3c3c3c;">耗时</th>
                            </tr>
                        </thead>
                        <tbody id="api-requests-tbody">
                            <!-- 动态填充 -->
                        </tbody>
                    </table>
                </div>
                
                <!-- 请求详情 -->
                <div class="request-detail" style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
                    <!-- 标签页 -->
                    <div class="tabs" style="display: flex; background: #252526; border-bottom: 1px solid #3c3c3c;">
                        <div class="tab active" data-tab="request" style="padding: 8px 16px; cursor: pointer; border-bottom: 2px solid #007acc; color: #007acc;">请求</div>
                        <div class="tab" data-tab="response" style="padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; color: #969696;">响应</div>
                        <div class="tab" data-tab="headers" style="padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; color: #969696;">头信息</div>
                        <div class="tab" data-tab="replay" style="padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; color: #969696;">重发</div>
                        <div class="tab" data-tab="custom" style="padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; color: #969696;">自定义请求</div>
                    </div>
                    
                    <!-- 标签页内容 -->
                    <div class="tab-content" style="flex: 1; overflow-y: auto; padding: 12px;">
                        <div id="tab-request" class="tab-panel">
                            <div id="request-content"></div>
                        </div>
                        <div id="tab-response" class="tab-panel" style="display: none;">
                            <div id="response-content"></div>
                        </div>
                        <div id="tab-headers" class="tab-panel" style="display: none;">
                            <div id="headers-content"></div>
                        </div>
                        <div id="tab-replay" class="tab-panel" style="display: none;">
                            <div id="replay-content"></div>
                        </div>
                        <div id="tab-custom" class="tab-panel" style="display: none;">
                            <div id="custom-content">
                                <div style="margin-bottom: 12px;">
                                    <label style="display: block; margin-bottom: 4px; color: #969696;">请求方法</label>
                                    <select id="custom-method" style="width: 100%; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box;">
                                        <option value="GET">GET</option>
                                        <option value="POST">POST</option>
                                        <option value="PUT">PUT</option>
                                        <option value="DELETE">DELETE</option>
                                        <option value="PATCH">PATCH</option>
                                        <option value="HEAD">HEAD</option>
                                        <option value="OPTIONS">OPTIONS</option>
                                    </select>
                                </div>
                                <div style="margin-bottom: 12px;">
                                    <label style="display: block; margin-bottom: 4px; color: #969696;">请求URL</label>
                                    <input type="text" id="custom-url" placeholder="https://example.com/api/xxx" style="width: 100%; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box;">
                                </div>
                                <div style="margin-bottom: 12px;">
                                    <label style="display: block; margin-bottom: 4px; color: #969696;">请求头 (JSON格式，可选)</label>
                                    <textarea id="custom-headers" placeholder='{"Content-Type": "application/json"}' style="width: 100%; height: 100px; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box; font-family: monospace;">{"Content-Type": "application/json"}</textarea>
                                </div>
                                <div style="margin-bottom: 12px;">
                                    <label style="display: block; margin-bottom: 4px; color: #969696;">请求体 (POST/PUT等方法使用)</label>
                                    <textarea id="custom-body" placeholder='{"key": "value"}' style="width: 100%; height: 150px; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box; font-family: monospace;"></textarea>
                                </div>
                                <button id="custom-send-btn" style="padding: 8px 24px; background: #007acc; border: none; color: white; border-radius: 3px; cursor: pointer; font-size: 14px;">发送请求</button>
                                <div id="custom-result" style="margin-top: 16px; display: none;">
                                    <h4 style="margin: 0 0 8px 0; color: #9cdcfe;">响应结果</h4>
                                    <div id="custom-result-content" style="padding: 8px; background: #252526; border-radius: 4px; min-height: 50px;"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        // 绑定事件
        bindPanelEvents(panel);
        // 如果之前是打开的，就显示
        if (config.showPanel) {
            panel.style.display = 'flex';
        }
        // 创建浮动按钮
        createFloatButton();
        
        // 确保按钮能正确显示
        setTimeout(() => {
            const btn = document.getElementById('api-debugger-float-btn');
            const panelEl = document.getElementById('api-debugger-panel');
            if (btn && panelEl) {
                if (panelEl.style.display === 'none') {
                    btn.style.display = 'block';
                } else {
                    btn.style.display = 'none';
                }
            }
        }, 100);
    }
    // 创建浮动按钮
    function createFloatButton() {
        // 防止重复创建
        if (document.getElementById('api-debugger-float-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'api-debugger-float-btn';
        const count = requests.length;
        const displayCount = count > 99 ? '99+' : count;
        btn.innerHTML = `🔧 API (${displayCount})`;
        btn.style.cssText = `
            position: fixed;
            right: 20px;
            top: 50%;
            transform: translateY(-50%);
            padding: 10px 16px;
            background: #007acc;
            color: white;
            border: none;
            border-radius: 24px;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            z-index: 9999999;
            box-shadow: 0 2px 8px rgba(0,122,204,0.4);
            transition: all 0.2s;
        `;
        btn.onclick = function() {
            const panel = document.getElementById('api-debugger-panel');
            if (panel && panel.style) {
                if (panel.style.display === 'none') {
                    panel.style.display = 'flex';
                    config.showPanel = true;
                    btn.style.display = 'none';
                } else {
                    panel.style.display = 'none';
                    config.showPanel = false;
                    btn.style.display = 'block';
                }
            }
            saveData();
        };
        btn.onmouseover = function() {
            this.style.transform = 'translateY(-50%) scale(1.05)';
        };
        btn.onmouseout = function() {
            this.style.transform = 'translateY(-50%) scale(1)';
        };
        document.body.appendChild(btn);
    }
    // 拦截XHR
    function interceptXHR() {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
            this._xhrMethod = method;
            this._xhrUrl = url;
            this._xhrRequestHeaders = {};
            return originalOpen.call(this, method, url, ...args);
        };
        XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
            this._xhrRequestHeaders[name] = value;
            return originalSetRequestHeader.call(this, name, value);
        };
        XMLHttpRequest.prototype.send = function(body) {
            const xhr = this;
            const startTime = Date.now();
            xhr.addEventListener('readystatechange', function() {
                if (xhr.readyState !== 4) return;
                const duration = Date.now() - startTime;

                // 根据 responseType 安全读取响应，避免 InvalidStateError
                let rawResponse = '';
                let response;
                try {
                    const rt = xhr.responseType;
                    if (!rt || rt === 'text') {
                        rawResponse = xhr.responseText || '';
                        try { response = JSON.parse(rawResponse); } catch(e) { response = rawResponse; }
                    } else if (rt === 'json') {
                        response = xhr.response;
                        try { rawResponse = JSON.stringify(response); } catch(e) { rawResponse = '[JSON]'; }
                    } else {
                        // blob / arraybuffer 等二进制类型，无法读取文本
                        rawResponse = `[${rt} 响应，无法显示文本内容]`;
                        response = rawResponse;
                    }
                } catch(e) {
                    rawResponse = '[读取响应失败]';
                    response = rawResponse;
                }

                // 响应体体积限制，超出时截断并标注
                if (rawResponse && rawResponse.length > config.rawResponseSizeLimit) {
                    rawResponse = rawResponse.substring(0, config.rawResponseSizeLimit) + `\n\n[超过 ${Math.round(config.rawResponseSizeLimit/1024)}KB 限制，已截断]`;
                }

                // 解析响应头
                const responseHeaders = {};
                const headersText = xhr.getAllResponseHeaders();
                if (headersText) {
                    headersText.split('\r\n').forEach(line => {
                        const parts = line.split(':');
                        if (parts.length >= 2) {
                            responseHeaders[parts[0].trim()] = parts.slice(1).join(':').trim();
                        }
                    });
                }
                const request = {
                    id: Date.now() + Math.random(),
                    method: xhr._xhrMethod,
                    url: xhr._xhrUrl,
                    status: xhr.status,
                    statusText: xhr.statusText,
                    requestHeaders: xhr._xhrRequestHeaders,
                    responseHeaders: responseHeaders,
                    requestBody: body,
                    response: response,
                    rawResponse: rawResponse,
                    duration: duration,
                    timestamp: Date.now()
                };
                requests.push(request);
                filteredRequests.push(request);
                updateRequestList();
                saveData();
            });
            return originalSend.call(this, body);
        };
    }
    // 拦截Fetch
    function interceptFetch() {
        const originalFetch = window.fetch;
        window.fetch = function(input, init) {
            const startTime = Date.now();
            
            let method = 'GET';
            let url = input;
            let body = null;
            let headers = {};
            if (input instanceof Request) {
                method = input.method;
                url = input.url;
                headers = {};
                input.headers.forEach((v, k) => headers[k] = v);
                // 读取 Request body（克隆避免消耗原始流）
                try {
                    body = input.clone().body ? input.clone().text().then(t => t).catch(() => null) : null;
                } catch(e) {}
            } else if (input instanceof URL) {
                // 支持 fetch(new URL(...)) 的调用方式
                url = input.toString();
            }
            if (init) {
                method = init.method || method;
                body = init.body;
                if (init.headers) {
                    if (init.headers instanceof Headers) {
                        init.headers.forEach((v, k) => headers[k] = v);
                    } else {
                        headers = { ...headers, ...init.headers };
                    }
                }
            }
            if (typeof url === 'string' && url.startsWith('/')) {
                url = window.location.origin + url;
            }
            return originalFetch.call(this, input, init)
                .then(response => {
                    const duration = Date.now() - startTime;
                    const clone = response.clone();
                    clone.text().then(text => {
                        // 响应体体积限制
                        let rawResponse = text;
                        if (rawResponse && rawResponse.length > config.rawResponseSizeLimit) {
                            rawResponse = rawResponse.substring(0, config.rawResponseSizeLimit) + `\n\n[超过 ${Math.round(config.rawResponseSizeLimit/1024)}KB 限制，已截断]`;
                        }
                        let responseData = rawResponse;
                        try {
                            responseData = JSON.parse(text); // 解析用原始完整文本
                        } catch (e) {
                            // 不是JSON
                        }
                        // 解析响应头
                        const responseHeaders = {};
                        response.headers.forEach((v, k) => responseHeaders[k] = v);
                        const request = {
                            id: Date.now() + Math.random(),
                            method: method,
                            url: url,
                            status: response.status,
                            statusText: response.statusText,
                            requestHeaders: headers,
                            responseHeaders: responseHeaders,
                            requestBody: body,
                            response: responseData,
                            rawResponse: rawResponse,
                            duration: duration,
                            timestamp: Date.now()
                        };
                        requests.push(request);
                        filteredRequests.push(request);
                        updateRequestList();
                        saveData();
                    }).catch(e => {
                        // 读取响应体失败（如 ReadableStream 已被消费），静默忽略
                        console.warn('API调试助手: 读取响应体失败', e);
                    });
                    return response;
                })
                .catch(error => {
                    console.error('Fetch error:', error);
                    throw error;
                });
        };
    }
    // 快捷键
    function setupHotkey() {
        document.addEventListener('keydown', function(e) {
            // 解析 config.hotkey 格式，如 "ctrl+shift+q"
            const parts = (config.hotkey || 'ctrl+shift+q').toLowerCase().split('+');
            const key = parts.filter(p => !['ctrl','shift','alt','meta'].includes(p))[0] || 'q';
            const needCtrl = parts.includes('ctrl');
            const needShift = parts.includes('shift');
            const needAlt = parts.includes('alt');
            const needMeta = parts.includes('meta');
            if (
                e.key.toLowerCase() === key &&
                e.ctrlKey === needCtrl &&
                e.shiftKey === needShift &&
                e.altKey === needAlt &&
                e.metaKey === needMeta
            ) {
                e.preventDefault();
                const btn = document.getElementById('api-debugger-float-btn');
                if (btn) btn.click();
            }
        });
    }
    // 初始化
    function init() {
        loadData();
        interceptXHR();
        interceptFetch();
        createPanel();
        setupHotkey();
    }
    // 页面加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})()
