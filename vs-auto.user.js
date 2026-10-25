// ==UserScript==
// @name         VSPhone Auto Reg & Tools
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Tự động đăng ký, lấy OTP mail.tm, quản lý tài khoản & token cho VSPhone Cloud
// @match        https://cloud.vsphone.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.mail.tm
// @connect      cloud.vsphone.com
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Thay đổi link Webhook Discord của bạn ở đây nếu muốn nhận thông báo
    const DISCORD_WEBHOOK_URL = "DÁN_WEBHOOK_URL_CỦA_BÉ_VÀO_ĐÂY";

    let isRunning = false;
    let emailInputRef = null;
    let clickLock = false;

    // ================================================================
    // STORAGE
    // ================================================================
    const STORAGE_KEY = 'vsphone_accounts_list';

    function loadAll() {
        try {
            let s = GM_getValue(STORAGE_KEY, '');
            return s ? JSON.parse(s) : [];
        } catch(e) { return []; }
    }

    function saveAll(list) { 
        try { GM_setValue(STORAGE_KEY, JSON.stringify(list)); } catch(e) {} 
    }

    function upsertAccount(acc) {
        const list = loadAll();
        const idx = list.findIndex(a => a.email === acc.email);
        const now = new Date().toISOString();
        if (idx >= 0) {
            list[idx] = { ...list[idx], ...acc, updatedAt: now };
        } else {
            list.push({
                email: acc.email, 
                password: acc.password || '',
                token: acc.token || '', 
                tokenSource: acc.tokenSource || '',
                createdAt: now, 
                updatedAt: now
            });
        }
        saveAll(list);
    }

    function deleteAccountByEmail(email) { 
        saveAll(loadAll().filter(a => a.email !== email)); 
    }
    
    function clearAllAccounts() { 
        saveAll([]); 
    }
    
    function getLatestAccount() {
        const list = loadAll();
        return list.length > 0 ? list[list.length - 1] : null;
    }

    // ================================================================
    // UTILS
    // ================================================================
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    function isElementVisible(el) {
        if (!el) return false;
        if (el.closest('#vs-menu-panel') || el.closest('#vs-floating-icon') || el.closest('#vs-acc-list')) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        return true;
    }

    function setInputValue(input, value) {
        try {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            setter.call(input, value);
        } catch { input.value = value; }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
    }

    const cleanText = (s) => (s || '')
        .replace(/[✏✎✐✓✔✗✘→←↔•·●○◆◇★☆\-–—:]/g, '')
        .replace(/\s+/g, ' ').trim().toLowerCase();

    function isClickable(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.cursor === 'pointer') return true;
        if (el.onclick || el.getAttribute('onclick')) return true;
        const tag = el.tagName;
        if (tag === 'BUTTON' || tag === 'A') return true;
        if (el.getAttribute('role') === 'button') return true;
        if (el.closest('a')) return true;
        return false;
    }

    async function hardClick(el, opts = {}) {
        if (!el || clickLock) return false;
        el.scrollIntoView({ block: 'center' });
        await sleep(200);
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const evOpts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
        try {
            el.dispatchEvent(new PointerEvent('pointerdown', evOpts));
            el.dispatchEvent(new MouseEvent('mousedown', evOpts));
            el.dispatchEvent(new PointerEvent('pointerup', evOpts));
            el.dispatchEvent(new MouseEvent('mouseup', evOpts));
        } catch(e) {}
        el.click();
        if (opts.lockMs) {
            clickLock = true;
            setTimeout(() => { clickLock = false; }, opts.lockMs);
        }
        return true;
    }

    function isRealToken(token) {
        if (!token) return false;
        const t = String(token).trim();
        if (t.length < 15) return false;
        if (t.startsWith('[{') || t.startsWith('{"')) return false;
        if (t.includes('"username"') || t.includes('"email"')) return false;
        return true;
    }

    // ================================================================
    // GIAO DIỆN (UI)
    // ================================================================
    const css = `
        #vs-floating-icon {
            position: fixed; top: 100px; right: 20px; width: 55px; height: 55px;
            background: linear-gradient(135deg, #00c6ff, #0072ff); border-radius: 50%;
            display: flex; align-items: center; justify-content: center; color: white;
            font-size: 24px; font-weight: bold; box-shadow: 0 4px 15px rgba(0,0,0,0.4);
            z-index: 999999; cursor: pointer; user-select: none; touch-action: none;
        }
        #vs-menu-panel {
            position: fixed; top: 165px; right: 20px; width: 360px; background: #1a1a1a;
            border: 2px solid #00c6ff; border-radius: 12px; color: white;
            font-family: sans-serif; z-index: 999998; box-shadow: 0 8px 25px rgba(0,0,0,0.6);
            display: none; box-sizing: border-box; max-height: 80vh; overflow: hidden;
            flex-direction: column;
        }
        #vs-menu-panel .panel-header { padding: 12px 15px 8px; border-bottom: 1px solid #333; }
        #vs-menu-panel h3 { margin: 0; font-size: 15px; color: #00c6ff; text-align: center; }
        #vs-menu-panel .panel-body { padding: 12px 15px; overflow-y: auto; flex: 1; }
        .vs-btn { width: 100%; padding: 9px; border: none; border-radius: 6px; font-weight: bold; font-size: 13px; cursor: pointer; margin-top: 6px; color: white; }
        #vs-start-btn { background: #28a745; }
        #vs-start-btn.running { background: #dc3545; }
        #vs-viewall-btn { background: #6f42c1; }
        #vs-status-box {
            background: #111; border: 1px solid #333; border-radius: 6px; padding: 8px;
            font-size: 11px; min-height: 50px; max-height: 120px; overflow-y: auto;
            color: #00ffcc; margin-top: 8px; white-space: pre-wrap; word-break: break-all;
        }
        .panel-section-title {
            color: #8b949e; font-size: 11px; font-weight: bold;
            margin: 12px 0 6px; padding-top: 10px; border-top: 1px dashed #333;
            text-transform: uppercase; letter-spacing: 0.5px;
        }
        .vs-toolbar { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
        .vs-toolbar button {
            flex: 1; min-width: 80px; padding: 7px; border: none; border-radius: 6px;
            font-size: 11px; font-weight: bold; cursor: pointer; color: white;
        }
        .vs-toolbar .btn-export { background: #1f6feb; }
        .vs-toolbar .btn-refresh { background: #238636; }
        .vs-toolbar .btn-clear { background: #b91c1c; }
        #vs-acc-list { max-height: 400px; overflow-y: auto; padding-right: 4px; }
        .vs-acc-card {
            background: #161b22; border: 1px solid #30363d; border-radius: 8px;
            padding: 8px; margin-bottom: 8px;
        }
        .vs-acc-card .card-header {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 6px; padding-bottom: 5px; border-bottom: 1px solid #21262d;
            gap: 6px;
        }
        .vs-acc-card .card-index {
            background: #6f42c1; color: white; font-size: 10px; font-weight: bold;
            padding: 2px 7px; border-radius: 10px;
        }
        .vs-acc-card .card-time { font-size: 10px; color: #8b949e; flex: 1; text-align: right; }
        .vs-acc-card .vs-field { margin: 5px 0; }
        .vs-acc-card .vs-field label { color: #8b949e; font-size: 10px; display: block; margin-bottom: 3px; }
        .vs-acc-card .row { display: flex; gap: 4px; align-items: center; }
        .vs-acc-card input, .vs-acc-card textarea {
            flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 5px;
            padding: 5px 7px; color: #00ffcc; font-family: monospace; font-size: 10px;
            resize: none; box-sizing: border-box; word-break: break-all; min-width: 0;
        }
        .vs-acc-card textarea { min-height: 36px; max-height: 70px; }
        .vs-copy { background: #238636; color: white; border: none; padding: 5px 7px; border-radius: 5px; cursor: pointer; font-size: 10px; font-weight: bold; white-space: nowrap; }
        .vs-del-btn {
            background: #b91c1c; color: white; border: none; padding: 3px 8px;
            border-radius: 5px; cursor: pointer; font-size: 11px; font-weight: bold;
        }
        #vs-empty-msg { text-align: center; color: #8b949e; padding: 20px 10px; font-size: 12px; font-style: italic; }
    `;

    const styleEl = document.createElement('style');
    styleEl.innerHTML = css;
    document.head.appendChild(styleEl);

    const iconEl = document.createElement('div');
    iconEl.id = 'vs-floating-icon';
    iconEl.innerHTML = '📱';
    document.body.appendChild(iconEl);

    const panelEl = document.createElement('div');
    panelEl.id = 'vs-menu-panel';
    panelEl.innerHTML = `
        <div class="panel-header">
            <h3>📱 VSPhone Auto</h3>
        </div>
        <div class="panel-body">
            <div style="font-size: 12px; margin-bottom: 4px; color:#8b949e;">Trạng thái:</div>
            <div id="vs-status-box">Đang chờ bấm bắt đầu...</div>

            <button id="vs-start-btn" class="vs-btn">🚀 ĐĂNG KÝ TỰ ĐỘNG</button>
            <button id="vs-viewall-btn" class="vs-btn">📚 XEM TẤT CẢ TÀI KHOẢN</button>

            <div id="vs-acc-section" style="display:none;">
                <div class="panel-section-title">📋 Danh sách tài khoản</div>
                <div class="vs-toolbar">
                    <button class="btn-export" id="vs-export-btn">📥 XUẤT .TXT</button>
                    <button class="btn-refresh" id="vs-refresh-btn">🔃 REFRESH</button>
                    <button class="btn-clear" id="vs-clear-btn">🗑 XÓA HẾT</button>
                </div>
                <div id="vs-acc-list"></div>
            </div>
        </div>
    `;
    document.body.appendChild(panelEl);

    const statusBox = document.getElementById('vs-status-box');
    const startBtn = document.getElementById('vs-start-btn');
    const viewAllBtn = document.getElementById('vs-viewall-btn');
    const accSection = document.getElementById('vs-acc-section');

    function logStatus(msg) {
        statusBox.innerText = msg;
        statusBox.scrollTop = statusBox.scrollHeight;
        console.log('[VSPhone Bot]', msg);
    }

    // ================================================================
    // KÉO THẢ NÚT FLOATING
    // ================================================================
    let isDragging = false, startX, startY, initialX, initialY;
    iconEl.addEventListener('pointerdown', (e) => {
        isDragging = false; startX = e.clientX; startY = e.clientY;
        initialX = iconEl.offsetLeft; initialY = iconEl.offsetTop;
        iconEl.setPointerCapture(e.pointerId);
    });
    iconEl.addEventListener('pointermove', (e) => {
        if (!startX || !startY) return;
        let dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) isDragging = true;
        if (isDragging) {
            iconEl.style.left = (initialX + dx) + 'px';
            iconEl.style.top = (initialY + dy) + 'px';
            iconEl.style.right = 'auto';
            panelEl.style.left = (iconEl.offsetLeft - 305) + 'px';
            panelEl.style.top = (iconEl.offsetTop + 65) + 'px';
            panelEl.style.right = 'auto';
        }
    });
    iconEl.addEventListener('pointerup', () => {
        if (!isDragging) {
            panelEl.style.display = panelEl.style.display === 'flex' ? 'none' : 'flex';
            panelEl.style.left = (iconEl.offsetLeft - 305) + 'px';
            panelEl.style.top = (iconEl.offsetTop + 65) + 'px';
        }
        startX = null; startY = null;
    });

    // ================================================================
    // HTTP REQUESTS
    // ================================================================
    function httpGet(url, headers = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({ method: "GET", url, headers,
                onload: (res) => { try { resolve(JSON.parse(res.responseText)); } catch (e) { reject(res.responseText); } },
                onerror: reject });
        });
    }
    function httpPost(url, data, headers = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({ method: "POST", url, headers, data: JSON.stringify(data),
                onload: (res) => { try { resolve(JSON.parse(res.responseText)); } catch (e) { reject(res.responseText); } },
                onerror: reject });
        });
    }

    // ================================================================
    // MAIL.TM INTEGRATION
    // ================================================================
    async function createMailTm() {
        try {
            logStatus("Đang lấy domain mail.tm...");
            let domainsRes = await httpGet("https://api.mail.tm/domains");
            let domain = domainsRes["hydra:member"][0]["domain"];
            let email = `${Math.random().toString(36).substring(2, 12)}@${domain}`;
            let password = "vsphone2026!";
            logStatus(`Tạo email thành công: ${email}`);
            await httpPost("https://api.mail.tm/accounts", { address: email, password: password }, { "Content-Type": "application/json" });
            return { email, password };
        } catch (e) { console.error(e); return null; }
    }

    async function getMailToken(email, password) {
        try {
            let tokenRes = await httpPost("https://api.mail.tm/token", { address: email, password: password }, { "Content-Type": "application/json" });
            return tokenRes.token || null;
        } catch (e) { return null; }
    }

    async function getOtp(email, password, opts = {}) {
        const excludeIds = new Set(opts.excludeIds || []);
        const maxTries = opts.maxTries || 30;
        const interval = opts.interval || 3000;
        try {
            let token = await getMailToken(email, password);
            if (!token) return null;
            let headers = { "Authorization": `Bearer ${token}` };
            for (let i = 0; i < maxTries; i++) {
                logStatus(`Đang chờ mã OTP từ mail.tm (${i + 1}/${maxTries})...`);
                await sleep(interval);
                let msgsRes = await httpGet("https://api.mail.tm/messages", headers);
                let messages = msgsRes["hydra:member"];
                if (!messages || messages.length === 0) continue;
                for (const msg of messages) {
                    if (excludeIds.has(msg.id)) continue;
                    let msgDetail = await httpGet(`https://api.mail.tm/messages/${msg.id}`, headers);
                    const fullText = (msgDetail.text || "") + " " + (msgDetail.intro || "") + " " + (msgDetail.subject || "");
                    let match = fullText.match(/\b\d{4,8}\b/);
                    if (match) return { otp: match[0], msgId: msg.id };
                }
            }
        } catch (e) { console.error(e); }
        return null;
    }

    async function getCurrentMessageIds(email, password) {
        try {
            const token = await getMailToken(email, password);
            if (!token) return new Set();
            const headers = { "Authorization": `Bearer ${token}` };
            const msgsRes = await httpGet("https://api.mail.tm/messages", headers);
            const messages = msgsRes["hydra:member"] || [];
            return new Set(messages.map(m => m.id));
        } catch(e) { return new Set(); }
    }

    function sendToDiscord(email, password, token) {
        if (!DISCORD_WEBHOOK_URL || DISCORD_WEBHOOK_URL.includes("DÁN_WEBHOOK")) return;
        const fields = [
            { name: "Email", value: `\`${email}\`` },
            { name: "Mật khẩu", value: `\`${password}\`` }
        ];
        if (token && isRealToken(token)) fields.push({ name: "Token", value: `\`\`\`${String(token).slice(0, 1000)}\`\`\`` });
        GM_xmlhttpRequest({
            method: "POST", url: DISCORD_WEBHOOK_URL, headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ embeds: [{ title: "📱 VSPhone Cloud Account", color: 3066993, fields, timestamp: new Date().toISOString() }] })
        });
    }

    // ================================================================
    // TÌM KIẾM PHẦN TỬ TRÊN TRANG (DOM)
    // ================================================================
    function findEmailInput() {
        let best = null, bestScore = -1;
        for (const inp of document.querySelectorAll('input')) {
            if (!isElementVisible(inp)) continue;
            const type = (inp.type || '').toLowerCase();
            if (type === 'password' || type === 'checkbox' || type === 'hidden') continue;
            
            let score = 0;
            const ph = (inp.placeholder || '').toLowerCase();
            const name = (inp.name || '').toLowerCase();
            const id = (inp.id || '').toLowerCase();
            
            if (ph.includes('email') || name.includes('email') || id.includes('email')) score += 500;
            if (ph.includes('nhập') || ph.includes('tài khoản')) score += 100;
            
            if (score > bestScore) {
                bestScore = score;
                best = inp;
            }
        }
        return best;
    }

    function findButtonByText(keywords) {
        const list = (Array.isArray(keywords) ? keywords : [keywords]).map(k => cleanText(k));
        const all = document.querySelectorAll('button, [role="button"], a, span, div');
        for (const el of all) {
            if (!isElementVisible(el) || el.clientHeight > 120 || el.clientWidth > 400) continue;
            if (!isClickable(el)) continue;
            const t = cleanText(el.textContent);
            for (const k of list) {
                if (t === k || t.includes(k)) return el;
            }
        }
        return null;
    }

    async function fillOtpField(otp) {
        // Tìm ô nhập OTP (thường là ô input đơn lẻ hoặc các ô chia nhỏ)
        for (const inp of document.querySelectorAll('input')) {
            if (!isElementVisible(inp)) continue;
            const ph = (inp.placeholder || '').toLowerCase();
            const name = (inp.name || '').toLowerCase();
            if (ph.includes('code') || ph.includes('otp') || ph.includes('mã') || name.includes('code') || name.includes('otp')) {
                inp.focus();
                setInputValue(inp, otp);
                return true;
            }
        }
        // Trường hợp ô input thông thường còn lại
        for (const inp of document.querySelectorAll('input')) {
            if (inp === emailInputRef || !isElementVisible(inp) || inp.type === 'checkbox') continue;
            const type = (inp.type || '').toLowerCase();
            if (type === 'text' || type === 'tel' || type === 'number') {
                inp.focus();
                setInputValue(inp, otp);
                return true;
            }
        }
        return false;
    }

    // ================================================================
    // TOKEN GRABBER
    // ================================================================
    function getVsToken() {
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                const val = localStorage.getItem(key);
                if (val && (/token|auth|jwt|bearer/i.test(key))) {
                    if (isRealToken(val)) return { token: val, source: key };
                }
            }
        } catch(e) {}
        return null;
    }

    // ================================================================
    // RENDER GIAO DIỆN DANH SÁCH
    // ================================================================
    function escapeHtml(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function renderList() {
        const list = loadAll();
        const container = document.getElementById('vs-acc-list');
        if (!container) return;
        if (list.length === 0) {
            container.innerHTML = '<div id="vs-empty-msg">Chưa có tài khoản nào.<br>Bấm 🚀 ĐĂNG KÝ TỰ ĐỘNG để tạo mới.</div>';
            return;
        }
        const sorted = [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        container.innerHTML = sorted.map((acc, idx) => {
            const realToken = isRealToken(acc.token) ? acc.token : '';
            return `
            <div class="vs-acc-card" data-email="${escapeHtml(acc.email)}">
                <div class="card-header">
                    <span class="card-index">#${list.length - idx}</span>
                    <span class="card-time">${escapeHtml(acc.createdAt ? new Date(acc.createdAt).toLocaleString('vi-VN') : '')}</span>
                    <button class="vs-del-btn" data-del="${escapeHtml(acc.email)}">🗑</button>
                </div>
                <div class="vs-field"><label>Email|Mật khẩu</label><div class="row">
                    <input class="vs-acc-combo" readonly value="${escapeHtml(acc.email + '|' + acc.password)}">
                    <button class="vs-copy" data-copy-el="combo">Copy</button>
                </div></div>
                <div class="vs-field"><label>Token xác thực</label><div class="row">
                    <textarea class="vs-acc-token" placeholder="Chưa có token">${escapeHtml(realToken)}</textarea>
                    <button class="vs-copy" data-copy-el="token">Copy</button>
                </div></div>
            </div>`;
        }).join('');

        container.querySelectorAll('.vs-copy').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const card = e.target.closest('.vs-acc-card');
                const kind = btn.getAttribute('data-copy-el');
                let val = '';
                if (kind === 'combo') val = card.querySelector('.vs-acc-combo').value;
                if (kind === 'token') val = card.querySelector('.vs-acc-token').value;
                navigator.clipboard.writeText(val).then(() => {
                    const old = btn.innerText;
                    btn.innerText = '✅';
                    setTimeout(() => btn.innerText = old, 1000);
                });
            });
        });

        container.querySelectorAll('.vs-del-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const email = btn.getAttribute('data-del');
                if (confirm(`Xóa tài khoản "${email}"?`)) {
                    deleteAccountByEmail(email);
                    renderList();
                    logStatus(`🗑 Đã xóa ${email}`);
                }
            });
        });
    }

    function exportToTxt() {
        const list = loadAll();
        if (list.length === 0) return alert('Chưa có tài khoản nào để xuất!');
        let content = 'DANH SÁCH TÀI KHOẢN VSPHONE CLOUD\n=====================================\n\n';
        list.forEach((acc, i) => {
            content += `[${i + 1}] Email: ${acc.email} | Pass: ${acc.password}\nToken: ${acc.token || 'Chưa có'}\n-------------------------------------\n`;
        });
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `vsphone_accounts_${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        logStatus('📥 Đã xuất file thành công.');
    }

    document.getElementById('vs-export-btn').addEventListener('click', exportToTxt);
    document.getElementById('vs-refresh-btn').addEventListener('click', () => {
        renderList();
        logStatus('🔃 Đã làm mới danh sách.');
    });
    document.getElementById('vs-clear-btn').addEventListener('click', () => {
        if (confirm('XÓA TOÀN BỘ danh sách tài khoản?')) {
            clearAllAccounts();
            renderList();
            logStatus('🗑 Đã xóa sạch danh sách.');
        }
    });

    // ================================================================
    // LUỒNG TỰ ĐỘNG ĐĂNG KÝ (AUTOMATION FLOW)
    // ================================================================
    startBtn.addEventListener('click', () => {
        if (isRunning) return;
        isRunning = true;
        clickLock = false;
        startBtn.innerText = "⏹️ ĐANG CHẠY...";
        startBtn.classList.add('running');
        logStatus("Bắt đầu quy trình tự động đăng ký VSPhone...");
        
        startAutomation().finally(() => {
            isRunning = false;
            startBtn.innerText = "🚀 ĐĂNG KÝ TỰ ĐỘNG";
            startBtn.classList.remove('running');
        });
    });

    async function startAutomation() {
        // 1. Tạo mail ảo
        let account = await createMailTm();
        if (!account) { logStatus("❌ Lỗi tạo email tạm thời."); return; }

        // 2. Tìm ô nhập email trên trang web VSPhone
        logStatus("Đang tìm ô nhập email trên trang...");
        let emailInput = null;
        for (let i = 0; i < 15; i++) {
            emailInput = findEmailInput();
            if (emailInput) break;
            await sleep(1000);
        }
        if (!emailInput) { logStatus("❌ Không tìm thấy ô nhập email!"); return; }
        emailInputRef = emailInput;

        // Điền email
        emailInput.focus();
        setInputValue(emailInput, account.email);
        logStatus(`✅ Đã điền email: ${account.email}`);
        await sleep(1000);

        // Lấy danh sách ID tin nhắn cũ để lọc OTP mới đến
        const excludeIds = await getCurrentMessageIds(account.email, account.password);

        // 3. Tìm nút gửi mã / đăng ký
        logStatus("Đang tìm nút Gửi mã / Đăng ký...");
        let sendBtn = findButtonByText(['gửi', 'send', 'get code', 'nhận mã', 'đăng ký', 'register']);
        if (!sendBtn) {
            logStatus("⚠️ Không tìm thấy nút gửi mã tự động. Bé hãy bấm thủ công nút Gửi mã trên web nhé!");
        } else {
            await hardClick(sendBtn, { lockMs: 3000 });
            logStatus("✅ Đã tự động bấm gửi mã!");
        }

        // 4. Chờ nhận OTP từ mail.tm
        const otpResult = await getOtp(account.email, account.password, { excludeIds });
        if (!otpResult) {
            logStatus("❌ Không nhận được mã OTP (timeout)! Kiểm tra lại.");
            return;
        }
        const otp = otpResult.otp;
        logStatus(`✅ Nhận được mã OTP: ${otp}\nĐang điền vào form...`);
        await sleep(1000);

        // Điền OTP
        await fillOtpField(otp);
        logStatus("✅ Đã điền OTP xong. Bé bấm Xác nhận/Đăng nhập tiếp theo trên web nếu cần.");

        // Lưu tài khoản cơ bản
        upsertAccount({ email: account.email, password: account.password });

        // 5. Chờ lấy Token phiên làm việc
        logStatus("⏳ Đợi 10s để hệ thống phản hồi và lưu token...");
        await sleep(10000);

        let tokenInfo = getVsToken();
        if (tokenInfo && isRealToken(tokenInfo.token)) {
            upsertAccount({ email: account.email, token: tokenInfo.token, tokenSource: tokenInfo.source });
            logStatus(`✅ Đã lưu Token thành công từ (${tokenInfo.source})!`);
        } else {
            logStatus("⚠️ Chưa tự bắt được token. Bạn có thể tự lấy trong Storage sau.");
        }

        // Gửi qua Discord nếu có cấu hình
        sendToDiscord(account.email, account.password, tokenInfo ? tokenInfo.token : null);

        accSection.style.display = 'block';
        renderList();
        logStatus(`🎉 Hoàn tất quy trình cho email: ${account.email}`);
    }

    viewAllBtn.addEventListener('click', () => {
        accSection.style.display = 'block';
        renderList();
        logStatus('📚 Đã hiển thị danh sách tài khoản.');
    });

    // Khởi tạo hiển thị danh sách ban đầu nếu có dữ liệu cũ
    setTimeout(() => {
        if (loadAll().length > 0) {
            accSection.style.display = 'block';
            renderList();
        }
    }, 1500);

})();
