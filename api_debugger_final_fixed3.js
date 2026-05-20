// ==UserScript==
// @name         API接口调试助手[豆包] (Fixed)
// @namespace    http://tampermonkey.net/
// @version      1.5.7
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
        panelPosition: 'bottom' // 面板位置：bottom/side
    };

    // 加载数据
    function loadData() {
        try {
            const savedRequests = GM_getValue(STORAGE_KEY, []);
            const savedConfig = GM_getValue(CONFIG_KEY, {});
            requests = savedRequests;
            filteredRequests = [...requests];
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
                // 修复：不应强行重置，应重新执行过滤以保持用户的搜索状态
                filterRequests(); 
            }
            
            const { customTableFields, ...saveConfig } = config;
            GM_setValue(STORAGE_KEY, requests);
            GM_setValue(CONFIG_KEY, saveConfig);
        } catch (e) {
            console.error('保存数据失败:', e);
        }
    }

    // 转义HTML
    function escapeHtml(text) {
        if (text === null || text === undefined) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
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
            return `<span style="color: ${color}">${escapeHtml(JSON.stringify(obj))}</span>`;
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
            const keyHtml = isArray ? '' : `<span style="color: ${keyColor}">"${escapeHtml(key)}"</span>: `;
            
            html += `<div style="padding-left: 16px;">${keyHtml}${formatJSONCollapsible(value, level + 1)}${comma}</div>`;
        });
        html += `</div>`;
        html += `<div style="padding-left: ${level * 16}px;">${isArray ? ']' : '}'}</div>`;
        return html;
    }

    // 绑定JSON折叠事件
    function bindJsonToggleEvents() {
        document.querySelectorAll('.json-toggle').forEach(toggle => {
            if (toggle && !toggle.dataset.bound) {
                toggle.dataset.bound = 'true';
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
            if (typeof item === 'object' && item !== null) {
                Object.keys(item).forEach(k => allFields.add(k));
            }
        });
        let fieldList = Array.from(allFields);
        if (config.customTableFields && config.customTableFields.length > 0) {
            fieldList = config.customTableFields.filter(f => allFields.has(f));
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

    // 更新浮动按钮的请求数量显示
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
        filteredRequests.slice().reverse().forEach((req) => {
            const tr = document.createElement('tr');
            const isSelected = config.selectedRequest && config.selectedRequest.id === req.id;
            
            tr.style.background = isSelected ? '#094771' : 'transparent';
            tr.style.cursor = 'pointer';
            tr.onclick = () => selectRequest(req);
            
            const methodColors = { GET: '#5cb85c', POST: '#f0ad4e', PUT: '#5bc0de', DELETE: '#d9534f', PATCH: '#6f42c1', HEAD: '#777', OPTIONS: '#777' };
            const methodColor = methodColors[req.method] || '#777';
            
            let statusColor = '#969696';
            if (req.status >= 200 && req.status < 300) statusColor = '#5cb85c';
            else if (req.status >= 300 && req.status < 400) statusColor = '#f0ad4e';
            else if (req.status >= 400) statusColor = '#d9534f';
            
            let url = req.url;
            if (url.length > 30) url = url.substring(0, 27) + '...';
            
            tr.innerHTML = `
                <td style="padding: 6px 8px; border-bottom: 1px solid #3c3c3c;">
                    <span style="color: ${methodColor}; font-weight: bold;">${req.method}</span>
                </td>
                <td style="padding: 6px 8px; border-bottom: 1px solid #3c3c3c; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(req.url)}">
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
        updateFloatButtonCount();
    }

    // 选择请求
    function selectRequest(req) {
        config.customTableFields = [];
        config.selectedRequest = req;
        renderRequestDetail(req);
        updateRequestList();
    }

    // 渲染请求详情
    function renderRequestDetail(request) {
        renderRequestContent(request);
        renderResponseContent(request);
        renderHeadersContent(request);
        renderReplayContent(request);
        setTimeout(bindJsonToggleEvents, 0);
    }

    // 渲染请求内容
    function renderRequestContent(request) {
        const container = document.getElementById('request-content');
        if (!container) return;
        let content = '';
        content += `<div style="word-break: break-all;"><strong>URL:</strong> ${escapeHtml(request.url)}</div>`;
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

    // 渲染响应内容
    function renderResponseContent(request) {
        const container = document.getElementById('response-content');
        if (!container) return;
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
                content = `<span style="color: #d9534f;">无法找到数组数据，请检查数据路径是否正确。当前路径: ${config.tableDataPath}</span>`;
            }
        } else {
            if (rawResponse !== undefined) {
                content = `<pre style="margin: 0; white-space: pre-wrap; word-wrap: break-word; color: #d4d4d4;">${escapeHtml(rawResponse)}</pre>`;
            } else {
                content = `<pre style="margin: 0; white-space: pre-wrap; word-wrap: break-word; color: #d4d4d4;">${escapeHtml(JSON.stringify(response, null, 2))}</pre>`;
            }
        }
        container.innerHTML = `
            <div style="margin-bottom: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                <label style="color: #969696;">展示模式:</label>
                <select id="response-view-mode" style="padding: 2px 6px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px;">
                    <option value="json" ${mode === 'json' ? 'selected' : ''}>JSON格式化</option>
                    <option value="table" ${mode === 'table' ? 'selected' : ''}>表格展示</option>
                    <option value="raw" ${mode === 'raw' ? 'selected' : ''}>原始数据</option>
                </select>
                <label style="color: #969696; margin-left: 8px;">数据路径:</label>
                <input type="text" id="table-data-path" placeholder="如: data.list" value="${config.tableDataPath}" style="padding: 2px 6px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; width: 120px;">
                <button id="custom-table-fields-btn" style="padding: 2px 8px; background: #3c3c3c; border: none; color: #d4d4d4; border-radius: 3px; cursor: pointer; font-size: 12px;">自定义字段</button>
                <button id="copy-response-btn" style="padding: 2px 8px; background: #3c3c3c; border: none; color: #d4d4d4; border-radius: 3px; cursor: pointer; font-size: 12px;">复制</button>
            </div>
            <div style="padding: 8px; background: #252526; border-radius: 4px; overflow-x: auto;">
                ${content}
            </div>
        `;
        
        const viewMode = document.getElementById('response-view-mode');
        if (viewMode) {
            viewMode.onchange = function() {
                config.responseViewMode = this.value;
                if (config.selectedRequest) {
                    renderResponseContent(config.selectedRequest);
                    setTimeout(bindJsonToggleEvents, 0);
                }
                saveData();
            };
        }
        
        const dataPath = document.getElementById('table-data-path');
        if (dataPath) {
            dataPath.oninput = function() {
                config.tableDataPath = this.value.trim();
                if (config.selectedRequest) renderResponseContent(config.selectedRequest);
                saveData();
            };
        }
        
        const fieldsBtn = document.getElementById('custom-table-fields-btn');
        if (fieldsBtn) {
            fieldsBtn.onclick = () => {
                if (!config.selectedRequest) return showNotification('请先选择一个请求');
                const response = config.selectedRequest.response;
                if (!response) return showNotification('没有响应数据');
                
                let tableData = getValueByPath(response, config.tableDataPath);
                if (!Array.isArray(tableData)) tableData = response;
                if (!Array.isArray(tableData) || tableData.length === 0) return showNotification('没有表格数据可自定义字段');
                
                const allFields = new Set();
                tableData.forEach(item => {
                    if (typeof item === 'object' && item !== null) {
                        Object.keys(item).forEach(k => allFields.add(k));
                    }
                });
                const fieldList = Array.from(allFields);
                
                const dialog = document.createElement('div');
                dialog.style.cssText = `
                    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                    background: #252526; border: 1px solid #3c3c3c; border-radius: 6px;
                    padding: 20px; z-index: 1000000; min-width: 300px; max-height: 400px;
                    overflow-y: auto; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                `;
                let fieldsHtml = '';
                fieldList.forEach(field => {
                    const checked = config.customTableFields.length === 0 || config.customTableFields.includes(field);
                    fieldsHtml += `
                        <label style="display: block; margin: 8px 0; color: #d4d4d4; cursor: pointer;">
                            <input type="checkbox" class="field-checkbox" value="${escapeHtml(field)}" ${checked ? 'checked' : ''}>
                            ${escapeHtml(field)}
                        </label>
                    `;
                });
                dialog.innerHTML = `
                    <h3 style="margin: 0 0 16px 0; color: #007acc;">自定义表格字段</h3>
                    <div style="margin-bottom: 16px;">勾选需要展示的字段：${fieldsHtml}</div>
                    <div style="display: flex; gap: 8px; justify-content: flex-end;">
                        <button id="fields-cancel" style="padding: 6px 16px; background: #3c3c3c; border: none; color: #d4d4d4; border-radius: 3px; cursor: pointer;">取消</button>
                        <button id="fields-save" style="padding: 6px 16px; background: #007acc; border: none; color: white; border-radius: 3px; cursor: pointer;">保存</button>
                    </div>
                `;
                
                const mask = document.createElement('div');
                mask.style.cssText = `position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 999999;`;
                document.body.appendChild(mask);
                document.body.appendChild(dialog);
                
                dialog.querySelector('#fields-cancel').onclick = mask.onclick = () => {
                    document.body.removeChild(dialog);
                    document.body.removeChild(mask);
                };
                
                dialog.querySelector('#fields-save').onclick = () => {
                    const checkboxes = dialog.querySelectorAll('.field-checkbox:checked');
                    config.customTableFields = Array.from(checkboxes).map(cb => cb.value);
                    if (config.selectedRequest) renderResponseContent(config.selectedRequest);
                    document.body.removeChild(dialog);
                    document.body.removeChild(mask);
                    showNotification('字段设置已生效');
                };
            };
        }
        
        const copyBtn = document.getElementById('copy-response-btn');
        if (copyBtn) {
            copyBtn.onclick = function() {
                if (config.selectedRequest) {
                    if (copyToClipboard(JSON.stringify(config.selectedRequest.response, null, 2))) {
                        showNotification('响应数据已复制到剪贴板');
                    }
                }
            };
        }
        
        if (mode === 'table') {
            setTimeout(() => {
                const input = document.getElementById('table-data-path');
                if (input) {
                    input.focus();
                    input.setSelectionRange(input.value.length, input.value.length);
                }
            }, 0);
        }
    }

    // 渲染头信息
    function renderHeadersContent(request) {
        const container = document.getElementById('headers-content');
        if (!container) return;
        let html = '';
        
        if (request.requestHeaders && Object.keys(request.requestHeaders).length > 0) {
            html += `<div style="margin-bottom: 16px;"><h4 style="margin: 0 0 8px 0; color: #9cdcfe;">请求头</h4><table style="width: 100%; border-collapse: collapse;">`;
            Object.entries(request.requestHeaders).forEach(([key, value]) => {
                html += `<tr><td style="padding: 4px 8px; border: 1px solid #3c3c3c; width: 30%; color: #9cdcfe;">${escapeHtml(key)}</td><td style="padding: 4px 8px; border: 1px solid #3c3c3c;">${escapeHtml(String(value))}</td></tr>`;
            });
            html += `</table></div>`;
        }
        if (request.responseHeaders && Object.keys(request.responseHeaders).length > 0) {
            html += `<div><h4 style="margin: 0 0 8px 0; color: #9cdcfe;">响应头</h4><table style="width: 100%; border-collapse: collapse;">`;
            Object.entries(request.responseHeaders).forEach(([key, value]) => {
                html += `<tr><td style="padding: 4px 8px; border: 1px solid #3c3c3c; width: 30%; color: #9cdcfe;">${escapeHtml(key)}</td><td style="padding: 4px 8px; border: 1px solid #3c3c3c;">${escapeHtml(String(value))}</td></tr>`;
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
                <input type="text" id="replay-url" value="${escapeHtml(request.url)}" style="width: 100%; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box;">
            </div>
            <div style="margin-bottom: 12px;">
                <label style="display: block; margin-bottom: 4px; color: #969696;">请求头 (JSON格式)</label>
                <textarea id="replay-headers" style="width: 100%; height: 100px; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box; font-family: monospace;">${escapeHtml(JSON.stringify(request.requestHeaders || {}, null, 2))}</textarea>
            </div>
            <div style="margin-bottom: 12px;">
                <label style="display: block; margin-bottom: 4px; color: #969696;">请求体</label>
                <textarea id="replay-body" style="width: 100%; height: 150px; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; box-sizing: border-box; font-family: monospace;">${request.requestBody ? escapeHtml(typeof request.requestBody === 'object' ? JSON.stringify(request.requestBody, null, 2) : request.requestBody) : ''}</textarea>
            </div>
            <button id="replay-send-btn" style="padding: 8px 24px; background: #007acc; border: none; color: white; border-radius: 3px; cursor: pointer; font-size: 14px;">发送请求</button>
            <div id="replay-result" style="margin-top: 16px; display: none;">
                <h4 style="margin: 0 0 8px 0; color: #9cdcfe;">响应结果</h4>
                <div id="replay-result-content" style="padding: 8px; background: #252526; border-radius: 4px; min-height: 50px;"></div>
            </div>
        `;
        const replaySendBtn = document.getElementById('replay-send-btn');
        if (replaySendBtn) replaySendBtn.onclick = async () => await sendReplayRequest(request);
    }

    // 发送重发请求 (使用 GM_xmlhttpRequest)
    async function sendReplayRequest(originalRequest) {
        const methodEl = document.getElementById('replay-method');
        const urlEl = document.getElementById('replay-url');
        const headersEl = document.getElementById('replay-headers');
        const bodyEl = document.getElementById('replay-body');
        const resultDiv = document.getElementById('replay-result');
        const resultContent = document.getElementById('replay-result-content');
        if (!methodEl || !urlEl || !headersEl || !bodyEl) return;
        
        try {
            const headers = JSON.parse(headersEl.value);
            let body = bodyEl.value;
            try { body = JSON.parse(body); } catch (e) {}
            
            if (resultDiv) resultDiv.style.display = 'block';
            if (resultContent) resultContent.innerHTML = '<span style="color: #969696;">请求中...</span>';
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
                    try { responseData = JSON.parse(response.responseText); } catch (e) {}
                    if (resultContent) {
                        resultContent.innerHTML = `
                            <div style="margin-bottom: 8px;">
                                <span style="color: #969696;">状态: </span>
                                <span style="color: ${response.status >= 400 ? '#d9534f' : '#5cb85c'}">${response.status} ${response.statusText}</span>
                                <span style="color: #969696; margin-left: 16px;">耗时: </span><span>${duration}ms</span>
                            </div>
                            ${formatJSONCollapsible(responseData)}
                        `;
                        setTimeout(bindJsonToggleEvents, 0);
                    }
                },
                onerror: function(error) {
                    if (resultContent) resultContent.innerHTML = `<span style="color: #d9534f;">请求失败</span>`;
                }
            });
        } catch (e) {
            if (resultDiv) resultDiv.style.display = 'block';
            if (resultContent) resultContent.innerHTML = `<span style="color: #d9534f;">参数解析失败: ${e.message}</span>`;
        }
    }

    // 发送自定义请求
    async function sendCustomRequest() {
        // 同重发逻辑结构，简略展示
        const methodEl = document.getElementById('custom-method');
        const urlEl = document.getElementById('custom-url');
        const headersEl = document.getElementById('custom-headers');
        const bodyEl = document.getElementById('custom-body');
        const resultDiv = document.getElementById('custom-result');
        const resultContent = document.getElementById('custom-result-content');
        
        if (!urlEl.value) {
            if (resultDiv) resultDiv.style.display = 'block';
            if (resultContent) resultContent.innerHTML = `<span style="color: #d9534f;">请输入请求URL</span>`;
            return;
        }
        try {
            let headers = headersEl.value.trim() ? JSON.parse(headersEl.value) : {};
            let body = bodyEl.value;
            try { if (body.trim()) body = JSON.parse(body); } catch (e) {}
            
            if (resultDiv) resultDiv.style.display = 'block';
            if (resultContent) resultContent.innerHTML = '<span style="color: #969696;">请求中...</span>';
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
                    try { responseData = JSON.parse(response.responseText); } catch (e) {}
                    if (resultContent) {
                        resultContent.innerHTML = `
                            <div style="margin-bottom: 8px;">
                                <span style="color: #969696;">状态: </span>
                                <span style="color: ${response.status >= 400 ? '#d9534f' : '#5cb85c'}">${response.status} ${response.statusText}</span>
                                <span style="color: #969696; margin-left: 16px;">耗时: </span><span>${duration}ms</span>
                            </div>
                            ${formatJSONCollapsible(responseData)}
                        `;
                        setTimeout(bindJsonToggleEvents, 0);
                    }
                },
                onerror: function(error) {
                    if (resultContent) resultContent.innerHTML = `<span style="color: #d9534f;">请求失败</span>`;
                }
            });
        } catch (e) {
            if (resultDiv) resultDiv.style.display = 'block';
            if (resultContent) resultContent.innerHTML = `<span style="color: #d9534f;">参数解析失败: ${e.message}</span>`;
        }
    }

    // 复制到剪贴板
    function copyToClipboard(text) {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            return true;
        } catch (e) { return false; }
    }

    // 显示通知
    function showNotification(text) {
        try { GM_notification({ title: 'API调试助手', text: text, timeout: 2000 }); } catch (e) { alert(text); }
    }

    // 筛选请求
    function filterRequests() {
        const filterText = config.filterText.toLowerCase();
        const methodFilter = config.methodFilter || '';
        filteredRequests = requests.filter(req => {
            if (methodFilter && req.method !== methodFilter) return false;
            if (filterText) {
                const urlMatch = req.url.toLowerCase().includes(filterText);
                const methodMatch = req.method.toLowerCase().includes(filterText);
                const bodyMatch = req.requestBody && typeof req.requestBody === 'string' ? req.requestBody.toLowerCase().includes(filterText) : JSON.stringify(req.requestBody || '').toLowerCase().includes(filterText);
                return urlMatch || methodMatch || bodyMatch;
            }
            return true;
        });
        updateRequestList();
    }

    // 切换标签页
    function switchTab(tabName) {
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
        document.querySelectorAll('#api-debugger-panel .tab-panel').forEach(p => { if (p && p.style) p.style.display = 'none'; });
        const tabEl = document.getElementById(`tab-${tabName}`);
        if (tabEl && tabEl.style) tabEl.style.display = 'block';
    }

    // 绑定面板事件
    function bindPanelEvents(panel) {
        if (!panel) return;
        panel.querySelectorAll('.tab').forEach(tab => { if (tab) tab.onclick = () => switchTab(tab.dataset.tab); });
        
        const toggleBtn = panel.querySelector('#api-toggle-btn');
        if (toggleBtn) {
            toggleBtn.onclick = () => {
                panel.style.display = 'none';
                config.showPanel = false;
                const btn = document.getElementById('api-debugger-float-btn');
                if (btn) btn.style.display = 'block';
                saveData();
            };
        }
        
        const filterInput = panel.querySelector('#api-filter-input');
        if (filterInput) {
            filterInput.value = config.filterText;
            filterInput.oninput = function() { config.filterText = this.value; filterRequests(); };
        }
        
        const methodFilter = panel.querySelector('#api-method-filter');
        if (methodFilter) {
            methodFilter.value = config.methodFilter || '';
            methodFilter.onchange = function() { config.methodFilter = this.value; filterRequests(); };
        }
        
        const clearBtn = panel.querySelector('#api-clear-btn');
        if (clearBtn) {
            clearBtn.onclick = () => {
                if (confirm('确定要清空所有请求记录吗？')) {
                    requests = []; filteredRequests = []; config.selectedRequest = null;
                    updateRequestList();
                    ['request-content', 'response-content', 'headers-content', 'replay-content'].forEach(id => {
                        const el = document.getElementById(id); if (el) el.innerHTML = '';
                    });
                    saveData();
                    showNotification('已清空所有请求');
                }
            };
        }
        
        // 导出 & 导入...
        const exportBtn = panel.querySelector('#api-export-btn');
        if (exportBtn) {
            exportBtn.onclick = () => {
                const data = { requests: requests, config: config, exportTime: new Date().toISOString(), origin: origin };
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `api-debugger-export-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
                showNotification('导出成功');
            };
        }
        
        const importBtn = panel.querySelector('#api-import-btn');
        if (importBtn) {
            importBtn.onclick = () => {
                const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
                input.onchange = function(e) {
                    const file = e.target.files[0]; if (!file) return;
                    const reader = new FileReader();
                    reader.onload = function(ev) {
                        try {
                            const data = JSON.parse(ev.target.result);
                            requests = data.requests || []; filteredRequests = [...requests];
                            if (data.config) { const { customTableFields, ...restConfig } = data.config; config = { ...config, ...restConfig }; }
                            updateRequestList(); saveData(); showNotification('导入成功');
                        } catch (err) { showNotification('导入失败：文件格式错误'); }
                    };
                    reader.readAsText(file);
                };
                input.click();
            };
        }
        
        const customSendBtn = panel.querySelector('#custom-send-btn');
        if (customSendBtn) customSendBtn.onclick = async () => await sendCustomRequest();
        
        const settingsBtn = panel.querySelector('#api-settings-btn');
        if (settingsBtn) {
            settingsBtn.onclick = () => {
                const dialog = document.createElement('div');
                dialog.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #252526; border: 1px solid #3c3c3c; border-radius: 6px; padding: 20px; z-index: 1000000; min-width: 300px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);`;
                dialog.innerHTML = `
                    <h3 style="margin: 0 0 16px 0; color: #007acc;">设置</h3>
                    <div style="margin-bottom: 16px;"><label style="display: block; margin-bottom: 4px; color: #969696;">面板位置</label><select id="settings-panel-position" style="width: 100%; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px;"><option value="bottom" ${config.panelPosition === 'bottom' ? 'selected' : ''}>底部（可调整高度）</option><option value="side" ${config.panelPosition === 'side' ? 'selected' : ''}>右侧（可调整宽度）</option></select></div>
                    <div style="margin-bottom: 16px;"><label style="display: block; margin-bottom: 4px; color: #969696;">最大保存请求数</label><input type="number" id="settings-max-requests" value="${config.maxRequests}" style="width: 100%; padding: 6px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px;"><div style="font-size: 11px; color: #969696;">0 表示永不主动清除，默认 100</div></div>
                    <div style="display: flex; gap: 8px; justify-content: flex-end;"><button id="settings-cancel" style="padding: 6px 16px; background: #3c3c3c; border: none; color: #d4d4d4; border-radius: 3px; cursor: pointer;">取消</button><button id="settings-save" style="padding: 6px 16px; background: #007acc; border: none; color: white; border-radius: 3px; cursor: pointer;">保存</button></div>
                `;
                const mask = document.createElement('div');
                mask.style.cssText = `position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 999999;`;
                document.body.appendChild(mask);
                document.body.appendChild(dialog);
                
                dialog.querySelector('#settings-cancel').onclick = mask.onclick = () => { document.body.removeChild(dialog); document.body.removeChild(mask); };
                
                dialog.querySelector('#settings-save').onclick = () => {
                    const maxReqInput = document.getElementById('settings-max-requests');
                    config.maxRequests = Math.max(parseInt(maxReqInput?.value) || 0, 0);
                    const positionInput = document.getElementById('settings-panel-position');
                    if (positionInput) config.panelPosition = positionInput.value;
                    
                    saveData();
                    const oldPanel = document.getElementById('api-debugger-panel');
                    if (oldPanel) document.body.removeChild(oldPanel);
                    createPanel();
                    
                    document.body.removeChild(dialog); document.body.removeChild(mask);
                    showNotification('设置已保存');
                };
            };
        }
        
        const resizer = document.getElementById('api-resizer');
        if (resizer) {
            let isResizing = false;
            resizer.addEventListener('mousedown', function(e) {
                isResizing = true;
                document.body.style.cursor = config.panelPosition === 'bottom' ? 'ns-resize' : 'ew-resize';
                document.body.style.userSelect = 'none';
            });
            document.addEventListener('mousemove', function(e) {
                if (!isResizing) return;
                if (config.panelPosition === 'bottom') {
                    const newHeight = ((window.innerHeight - e.clientY) / window.innerHeight) * 100;
                    if (newHeight >= 10 && newHeight <= 80) { panel.style.height = newHeight + '%'; config.panelHeight = newHeight; }
                } else {
                    const newWidth = ((window.innerWidth - e.clientX) / window.innerWidth) * 100;
                    if (newWidth >= 20 && newWidth <= 80) { panel.style.width = newWidth + '%'; config.panelWidth = newWidth; }
                }
            });
            document.addEventListener('mouseup', function() {
                if (isResizing) { isResizing = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; saveData(); }
            });
        }
        filterRequests();
    }

    // 创建面板
    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'api-debugger-panel';
        
        let panelStyle, resizerStyle;
        if (config.panelPosition === 'bottom') {
            panelStyle = `position: fixed; bottom: 0; left: 0; right: 0; height: ${config.panelHeight}%; background: #1e1e1e; color: #d4d4d4; font-family: sans-serif; font-size: 13px; z-index: 999999; display: none; flex-direction: column; box-shadow: 0 -2px 10px rgba(0,0,0,0.3);`;
            resizerStyle = `height: 12px; background: #007acc; cursor: ns-resize; display: flex; align-items: center; justify-content: center; border-bottom: 1px solid #005a9e;`;
        } else {
            panelStyle = `position: fixed; right: 0; top: 0; bottom: 0; width: ${config.panelWidth}%; background: #1e1e1e; color: #d4d4d4; font-family: sans-serif; font-size: 13px; z-index: 999999; display: none; flex-direction: column; box-shadow: -2px 0 10px rgba(0,0,0,0.3);`;
            resizerStyle = `width: 12px; background: #007acc; cursor: ew-resize; display: flex; align-items: center; justify-content: center; border-right: 1px solid #005a9e;`;
        }
        panel.style.cssText = panelStyle;
        
        panel.innerHTML = `
            <div id="api-resizer" style="${resizerStyle}">
                <div style="display: flex; gap: 3px; ${config.panelPosition === 'side' ? 'flex-direction: column;' : ''}">
                    <div style="width: 4px; height: 4px; background: rgba(255,255,255,0.6); border-radius: 50%;"></div>
                    <div style="width: 4px; height: 4px; background: rgba(255,255,255,0.6); border-radius: 50%;"></div>
                    <div style="width: 4px; height: 4px; background: rgba(255,255,255,0.6); border-radius: 50%;"></div>
                </div>
            </div>
            <div class="panel-header" style="padding: 8px 12px; background: #252526; border-bottom: 1px solid #3c3c3c; display: flex; align-items: center; gap: 8px;">
                <div style="font-weight: bold; color: #007acc; font-size: 14px;">API接口调试助手</div>
                <input type="text" id="api-filter-input" placeholder="搜索接口、参数..." style="flex: 1; max-width: 300px; padding: 4px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px; outline: none;">
                <select id="api-method-filter" style="padding: 4px 8px; background: #3c3c3c; border: 1px solid #555; color: #d4d4d4; border-radius: 3px;">
                    <option value="">全部方法</option><option value="GET">GET</option><option value="POST">POST</option><option value="PUT">PUT</option><option value="DELETE">DELETE</option><option value="PATCH">PATCH</option>
                </select>
                <button id="api-settings-btn" style="padding: 4px 12px; background: #6f42c1; border: none; color: white; border-radius: 3px; cursor: pointer;">设置</button>
                <button id="api-clear-btn" style="padding: 4px 12px; background: #d9534f; border: none; color: white; border-radius: 3px; cursor: pointer;">清空</button>
                <button id="api-export-btn" style="padding: 4px 12px; background: #5bc0de; border: none; color: white; border-radius: 3px; cursor: pointer;">导出</button>
                <button id="api-import-btn" style="padding: 4px 12px; background: #5cb85c; border: none; color: white; border-radius: 3px; cursor: pointer;">导入</button>
                <button id="api-toggle-btn" style="padding: 4px 8px; background: #3c3c3c; border: none; color: #d4d4d4; border-radius: 3px; cursor: pointer;">×</button>
            </div>
            <div class="panel-body" style="flex: 1; display: flex; overflow: hidden; ${config.panelPosition === 'side' ? 'flex-direction: column;' : ''}">
                <div class="request-list" style="${config.panelPosition === 'side' ? 'height: 40%; border-bottom: 1px solid #3c3c3c;' : 'width: 40%; border-right: 1px solid #3c3c3c;'} overflow-y: auto;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <thead><tr style="background: #2d2d30; position: sticky; top: 0;"><th style="padding: 6px 8px; text-align: left; border-bottom: 1px solid #3c3c3c;">方法</th><th style="padding: 6px 8px; text-align: left; border-bottom: 1px solid #3c3c3c;">接口</th><th style="padding: 6px 8px; text-align: left; border-bottom: 1px solid #3c3c3c;">状态</th><th style="padding: 6px 8px; text-align: left; border-bottom: 1px solid #3c3c3c;">耗时</th></tr></thead>
                        <tbody id="api-requests-tbody"></tbody>
                    </table>
                </div>
                <div class="request-detail" style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
                    <div class="tabs" style="display: flex; background: #252526; border-bottom: 1px solid #3c3c3c; flex-wrap: wrap;">
                        <div class="tab active" data-tab="request" style="padding: 8px 16px; cursor: pointer; border-bottom: 2px solid #007acc; color: #007acc;">请求</div>
                        <div class="tab" data-tab="response" style="padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; color: #969696;">响应</div>
                        <div class="tab" data-tab="headers" style="padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; color: #969696;">头信息</div>
                        <div class="tab" data-tab="replay" style="padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; color: #969696;">重发</div>
                        <div class="tab" data-tab="custom" style="padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; color: #969696;">自定义</div>
                    </div>
                    <div class="tab-content" style="flex: 1; overflow-y: auto; padding: 12px;">
                        <div id="tab-request" class="tab-panel"><div id="request-content"></div></div>
                        <div id="tab-response" class="tab-panel" style="display: none;"><div id="response-content"></div></div>
                        <div id="tab-headers" class="tab-panel" style="display: none;"><div id="headers-content"></div></div>
                        <div id="tab-replay" class="tab-panel" style="display: none;"><div id="replay-content"></div></div>
                        <div id="tab-custom" class="tab-panel" style="display: none;">
                            <div id="custom-content">
                                <div style="margin-bottom: 12px;"><select id="custom-method" style="width: 100%; padding: 6px; background: #3c3c3c; color: white;"><option>GET</option><option>POST</option></select></div>
                                <div style="margin-bottom: 12px;"><input type="text" id="custom-url" placeholder="https://" style="width: 100%; padding: 6px; background: #3c3c3c; color: white;"></div>
                                <div style="margin-bottom: 12px;"><textarea id="custom-headers" style="width: 100%; height: 60px; padding: 6px; background: #3c3c3c; color: white;">{"Content-Type": "application/json"}</textarea></div>
                                <div style="margin-bottom: 12px;"><textarea id="custom-body" style="width: 100%; height: 100px; padding: 6px; background: #3c3c3c; color: white;"></textarea></div>
                                <button id="custom-send-btn" style="padding: 8px 24px; background: #007acc; color: white; border: none; cursor: pointer;">发送</button>
                                <div id="custom-result" style="margin-top: 16px; display: none;"><div id="custom-result-content"></div></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        bindPanelEvents(panel);
        if (config.showPanel) panel.style.display = 'flex';
        createFloatButton();
    }

    // 创建浮动按钮
    function createFloatButton() {
        // 修复: 避免设置保存后重复生成按钮
        if (document.getElementById('api-debugger-float-btn')) return;
        
        const btn = document.createElement('button');
        btn.id = 'api-debugger-float-btn';
        btn.innerHTML = `🔧 API (${requests.length > 99 ? '99+' : requests.length})`;
        btn.style.cssText = `position: fixed; right: 20px; top: 50%; transform: translateY(-50%); padding: 10px 16px; background: #007acc; color: white; border: none; border-radius: 24px; cursor: pointer; font-size: 14px; font-weight: bold; z-index: 9999999; box-shadow: 0 2px 8px rgba(0,122,204,0.4); transition: all 0.2s;`;
        
        btn.onclick = function() {
            const panel = document.getElementById('api-debugger-panel');
            if (panel && panel.style) {
                if (panel.style.display === 'none') {
                    panel.style.display = 'flex'; config.showPanel = true; btn.style.display = 'none';
                } else {
                    panel.style.display = 'none'; config.showPanel = false; btn.style.display = 'block';
                }
            }
            saveData();
        };
        btn.onmouseover = function() { this.style.transform = 'translateY(-50%) scale(1.05)'; };
        btn.onmouseout = function() { this.style.transform = 'translateY(-50%) scale(1)'; };
        
        if (!config.showPanel) document.body.appendChild(btn);
    }

    // 拦截 XHR (核心修复区)
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
            
            // 修复：改用 readystatechange 替代 load，以便更严谨地捕获不同状态的终止情况
            xhr.addEventListener('readystatechange', function() {
                if (xhr.readyState === 4) {
                    const duration = Date.now() - startTime;
                    let rawResponse = '';
                    let responseData = null;
                    
                    // 修复：严谨判断 responseType，防止浏览器抛出 DOMException
                    try {
                        if (!xhr.responseType || xhr.responseType === 'text') {
                            rawResponse = xhr.responseText;
                            try { responseData = JSON.parse(rawResponse); } catch (e) { responseData = rawResponse; }
                        } else if (xhr.responseType === 'json') {
                            responseData = xhr.response;
                            rawResponse = JSON.stringify(responseData);
                        } else {
                            // blob, arraybuffer, document 等其他类型
                            rawResponse = `[Unsupported Response Type: ${xhr.responseType}]`;
                            responseData = rawResponse;
                        }
                    } catch (e) {
                        rawResponse = '[Error Reading Response: ' + e.message + ']';
                        responseData = rawResponse;
                    }
                    
                    const responseHeaders = {};
                    const headersText = xhr.getAllResponseHeaders();
                    if (headersText) {
                        headersText.split('\r\n').forEach(line => {
                            const parts = line.split(':');
                            if (parts.length >= 2) responseHeaders[parts[0].trim()] = parts.slice(1).join(':').trim();
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
                        response: responseData,
                        rawResponse: rawResponse,
                        duration: duration,
                        timestamp: Date.now()
                    };
                    requests.push(request);
                    filteredRequests.push(request);
                    updateRequestList();
                    saveData();
                }
            });
            return originalSend.call(this, body);
        };
    }

    // 拦截 Fetch (核心修复区)
    function interceptFetch() {
        const originalFetch = window.fetch;
        window.fetch = function(input, init) {
            const startTime = Date.now();
            let method = 'GET';
            let url = '';
            let body = null;
            let headers = {};
            
            // 修复：考虑 input 是 Request 或 URL 对象的情况
            if (input instanceof Request) {
                method = input.method;
                url = input.url;
                input.headers.forEach((v, k) => headers[k] = v);
            } else if (input instanceof URL) {
                url = input.href;
            } else {
                url = String(input);
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
            
            // 修复：确保相对路径转换为绝对路径时更为健壮
            if (!url.startsWith('http')) {
                try { url = new URL(url, window.location.origin).href; } catch(e) {}
            }
            
            return originalFetch.call(this, input, init).then(response => {
                const duration = Date.now() - startTime;
                const clone = response.clone();
                
                // 修复：捕获无法读取 text 的边缘情况（例如跨域无 CORS 的 opaque 响应流或特殊 Blob）
                clone.text().then(text => {
                    let responseData = text;
                    try { responseData = JSON.parse(text); } catch (e) {}
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
                        rawResponse: text,
                        duration: duration,
                        timestamp: Date.now()
                    };
                    requests.push(request);
                    filteredRequests.push(request);
                    updateRequestList();
                    saveData();
                }).catch(err => {
                    console.warn('API Debugger: Fetch response read error', err);
                });
                return response;
            }).catch(error => {
                throw error;
            });
        };
    }

    function setupHotkey() {
        document.addEventListener('keydown', function(e) {
            if (e.ctrlKey && e.shiftKey && e.key === 'A') {
                e.preventDefault();
                const btn = document.getElementById('api-debugger-float-btn');
                if (btn && btn.style.display !== 'none') {
                    btn.click();
                } else {
                    const panel = document.getElementById('api-debugger-panel');
                    if (panel) {
                        const toggleBtn = panel.querySelector('#api-toggle-btn');
                        if (toggleBtn) toggleBtn.click();
                    }
                }
            }
        });
    }

    function init() {
        loadData();
        interceptXHR();
        interceptFetch();
        createPanel();
        setupHotkey();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
