// ==UserScript==
// @name         VMOS Cloud Auto Bot v3.5
// @namespace    http://tampermonkey.net/
// @version      3.5
// @description  Đăng ký + Đổi MK + Lưu nhiều tài khoản + Xuất file
// @match        https://*.vmoscloud.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.mail.tm
// @connect      vmoscloud.com
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const DISCORD_WEBHOOK_URL = "DÁN_WEBHOOK_URL_CỦA_BÉ_VÀO_ĐÂY";

    let isRunning = false;
    let emailInputRef = null;
    let clickLock = false;

    // ================================================================
    // STORAGE
    // ================================================================
    const STORAGE_KEY = 'vmos_accounts_list';
    const OLD_KEY = 'vmos_account';

    function loadAll() {
        try {
            let s = GM_getValue(STORAGE_KEY, '');
            let list = s ? JSON.parse(s) : [];
            const old = GM_getValue(OLD_KEY, '');
            if (old) {
                try {
                    const oldAcc = JSON.parse(old);
                    if (oldAcc && oldAcc.email && !list.find(a => a.email === oldAcc.email)) {
                        list.push({
                            email: oldAcc.email, password: oldAcc.password || '',
                            token: '', tokenSource: '',
                            createdAt: oldAcc.time || new Date().toISOString(),
                            updatedAt: new Date().toISOString()
                        });
                    }
                } catch(e) {}
                try { GM_setValue(OLD_KEY, ''); } catch(e) {}
            }
            return list;
        } catch(e) { return []; }
    }

    function saveAll(list) { try { GM_setValue(STORAGE_KEY, JSON.stringify(list)); } catch(e) {} }

    function upsertAccount(acc) {
        const list = loadAll();
        const idx = list.findIndex(a => a.email === acc.email);
        const now = new Date().toISOString();
        if (idx >= 0) list[idx] = { ...list[idx], ...acc, updatedAt: now };
        else list.push({
            email: acc.email, password: acc.password || '',
            token: acc.token || '', tokenSource: acc.tokenSource || '',
            createdAt: now, updatedAt: now
        });
        saveAll(list);
    }

    function deleteAccountByEmail(email) { saveAll(loadAll().filter(a => a.email !== email)); }
    function clearAllAccounts() { saveAll([]); }
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
        if (el.closest('#vmos-menu-panel') || el.closest('#vmos-floating-icon') || el.closest('#vmos-acc-list')) return false;
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

    function isLoginOnlyButton(el) {
        const t = cleanText(el.textContent);
        if (!t) return false;
        if (t.includes('đăng ký') || t.includes('register') || t.includes('sign up')) return false;
        return t === 'đăng nhập' || t === 'login' || t === 'sign in' || t === 'signin' ||
               t.includes('đăng nhập') || t.includes('login');
    }

    function findButtonByText(keywords) {
        const list = (Array.isArray(keywords) ? keywords : [keywords]).map(k => cleanText(k));
        const candidates = [];
        document.querySelectorAll('button, [role="button"], a, span, div, p, label, strong, em').forEach(el => {
            if (!candidates.includes(el)) candidates.push(el);
        });
        for (const el of candidates) {
            if (!isElementVisible(el) || el.clientHeight > 150 || el.clientWidth > 600) continue;
            if (!isClickable(el) || isLoginOnlyButton(el)) continue;
            const t = cleanText(el.textContent);
            for (const k of list) if (t === k) return el;
        }
        for (const el of candidates) {
            if (!isElementVisible(el) || el.clientHeight > 150 || el.clientWidth > 600) continue;
            if (!isClickable(el) || isLoginOnlyButton(el)) continue;
            const t = cleanText(el.textContent);
            for (const k of list) if (t.includes(k)) return el;
        }
        return null;
    }

    function findLinkByText(keywords) {
        const list = (Array.isArray(keywords) ? keywords : [keywords]).map(k => cleanText(k));
        const all = document.querySelectorAll('a, span, div, p, label, strong, em');
        for (const el of all) {
            if (!isElementVisible(el) || el.children.length > 4) continue;
            if (!isClickable(el) || isLoginOnlyButton(el)) continue;
            const t = cleanText(el.textContent);
            for (const k of list) if (t === k) return el.closest('a') || el;
        }
        const cand = [];
        for (const el of all) {
            if (!isElementVisible(el) || el.children.length > 4) continue;
            if (!isClickable(el) || isLoginOnlyButton(el)) continue;
            const t = cleanText(el.textContent);
            for (const k of list) {
                if (t.includes(k)) { cand.push({ el, len: t.length }); break; }
            }
        }
        cand.sort((a, b) => a.len - b.len);
        return cand.length > 0 ? (cand[0].el.closest('a') || cand[0].el) : null;
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

    async function waitForElement(findFn, timeoutMs = 10000, intervalMs = 300) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const el = findFn();
            if (el) return el;
            await sleep(intervalMs);
        }
        return null;
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
    // GIAO DIỆN
    // ================================================================
    const css = `
        #vmos-floating-icon {
            position: fixed; top: 100px; right: 20px; width: 55px; height: 55px;
            background: linear-gradient(135deg, #ff7b00, #ff0055); border-radius: 50%;
            display: flex; align-items: center; justify-content: center; color: white;
            font-size: 24px; font-weight: bold; box-shadow: 0 4px 15px rgba(0,0,0,0.4);
            z-index: 999999; cursor: pointer; user-select: none; touch-action: none;
        }
        #vmos-menu-panel {
            position: fixed; top: 165px; right: 20px; width: 360px; background: #1a1a1a;
            border: 2px solid #ff7b00; border-radius: 12px; color: white;
            font-family: sans-serif; z-index: 999998; box-shadow: 0 8px 25px rgba(0,0,0,0.6);
            display: none; box-sizing: border-box;
            max-height: 80vh; overflow: hidden;
            flex-direction: column;
        }
        #vmos-menu-panel .panel-header { padding: 12px 15px 8px; border-bottom: 1px solid #333; }
        #vmos-menu-panel h3 { margin: 0; font-size: 15px; color: #ff7b00; text-align: center; }
        #vmos-menu-panel .panel-body { padding: 12px 15px; overflow-y: auto; flex: 1; }
        .vmos-btn { width: 100%; padding: 9px; border: none; border-radius: 6px; font-weight: bold; font-size: 13px; cursor: pointer; margin-top: 6px; color: white; }
        #vmos-start-btn { background: #28a745; }
        #vmos-start-btn.running { background: #dc3545; }
        #vmos-pwd-btn { background: #007bff; }
        #vmos-pwd-btn.running { background: #dc3545; }
        #vmos-viewall-btn { background: #6f42c1; }
        #vmos-status-box {
            background: #111; border: 1px solid #333; border-radius: 6px; padding: 8px;
            font-size: 11px; min-height: 50px; max-height: 120px; overflow-y: auto;
            color: #00ffcc; margin-top: 8px; white-space: pre-wrap; word-break: break-all;
        }
        .panel-section-title {
            color: #8b949e; font-size: 11px; font-weight: bold;
            margin: 12px 0 6px; padding-top: 10px; border-top: 1px dashed #333;
            text-transform: uppercase; letter-spacing: 0.5px;
        }
        .vmos-toolbar { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
        .vmos-toolbar button {
            flex: 1; min-width: 80px; padding: 7px; border: none; border-radius: 6px;
            font-size: 11px; font-weight: bold; cursor: pointer; color: white;
        }
        .vmos-toolbar .btn-export { background: #1f6feb; }
        .vmos-toolbar .btn-clear { background: #b91c1c; }
        .vmos-toolbar .btn-refresh { background: #238636; }
        #vmos-acc-list { max-height: 400px; overflow-y: auto; padding-right: 4px; }
        .vmos-acc-card {
            background: #161b22; border: 1px solid #30363d; border-radius: 8px;
            padding: 8px; margin-bottom: 8px;
        }
        .vmos-acc-card .card-header {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 6px; padding-bottom: 5px; border-bottom: 1px solid #21262d;
            gap: 6px;
        }
        .vmos-acc-card .card-index {
            background: #6f42c1; color: white; font-size: 10px; font-weight: bold;
            padding: 2px 7px; border-radius: 10px;
        }
        .vmos-acc-card .card-time { font-size: 10px; color: #8b949e; flex: 1; text-align: right; }
        .vmos-acc-card .vmos-field { margin: 5px 0; }
        .vmos-acc-card .vmos-field label { color: #8b949e; font-size: 10px; display: block; margin-bottom: 3px; }
        .vmos-acc-card .row { display: flex; gap: 4px; align-items: center; }
        .vmos-acc-card input, .vmos-acc-card textarea {
            flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 5px;
            padding: 5px 7px; color: #00ffcc; font-family: monospace; font-size: 10px;
            resize: none; box-sizing: border-box; word-break: break-all; min-width: 0;
        }
        .vmos-acc-card textarea { min-height: 36px; max-height: 70px; }
        .vmos-copy { background: #238636; color: white; border: none; padding: 5px 7px; border-radius: 5px; cursor: pointer; font-size: 10px; font-weight: bold; white-space: nowrap; }
        .vmos-copy:active { background: #2ea043; }
        .vmos-del-btn {
            background: #b91c1c; color: white; border: none; padding: 3px 8px;
            border-radius: 5px; cursor: pointer; font-size: 11px; font-weight: bold;
        }
        #vmos-empty-msg { text-align: center; color: #8b949e; padding: 20px 10px; font-size: 12px; font-style: italic; }
    `;

    const styleEl = document.createElement('style');
    styleEl.innerHTML = css;
    document.head.appendChild(styleEl);

    const iconEl = document.createElement('div');
    iconEl.id = 'vmos-floating-icon';
    iconEl.innerHTML = '☁️';
    document.body.appendChild(iconEl);

    const panelEl = document.createElement('div');
    panelEl.id = 'vmos-menu-panel';
    panelEl.innerHTML = `
        <div class="panel-header">
            <h3>☁️ VMOS Cloud v3.5</h3>
        </div>
        <div class="panel-body">
            <div style="font-size: 12px; margin-bottom: 4px; color:#8b949e;">Tiến trình:</div>
            <div id="vmos-status-box">Đang chờ bấm bắt đầu...</div>

            <button id="vmos-start-btn" class="vmos-btn">🚀 ĐĂNG KÝ</button>
            <button id="vmos-pwd-btn" class="vmos-btn">🔑 ĐỔI MẬT KHẨU (acc mới nhất)</button>
            <button id="vmos-viewall-btn" class="vmos-btn">📚 XEM TẤT CẢ TÀI KHOẢN</button>

            <div id="vmos-acc-section" style="display:none;">
                <div class="panel-section-title">📋 Danh sách tài khoản</div>
                <div class="vmos-toolbar">
                    <button class="btn-export" id="vmos-export-btn">📥 XUẤT .TXT</button>
                    <button class="btn-refresh" id="vmos-refresh-btn">🔃 REFRESH</button>
                    <button class="btn-clear" id="vmos-clear-btn">🗑 XÓA HẾT</button>
                </div>
                <div id="vmos-acc-list"></div>
            </div>
        </div>
    `;
    document.body.appendChild(panelEl);

    const statusBox = document.getElementById('vmos-status-box');
    const startBtn = document.getElementById('vmos-start-btn');
    const pwdBtn = document.getElementById('vmos-pwd-btn');
    const viewAllBtn = document.getElementById('vmos-viewall-btn');
    const accSection = document.getElementById('vmos-acc-section');

    function logStatus(msg) {
        statusBox.innerText = msg;
        statusBox.scrollTop = statusBox.scrollHeight;
        console.log('[VMOS Bot]', msg);
    }

    // ================================================================
    // KÉO THẢ
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
    // HTTP
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
    // MAIL.TM
    // ================================================================
    async function createMailTm() {
        try {
            logStatus("Đang lấy domain mail.tm...");
            let domainsRes = await httpGet("https://api.mail.tm/domains");
            let domain = domainsRes["hydra:member"][0]["domain"];
            let email = `${Math.random().toString(36).substring(2, 12)}@${domain}`;
            let password = "duytoan20009!";
            logStatus(`Tạo email: ${email}`);
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
                logStatus(`Đang chờ OTP từ mail.tm (${i + 1}/${maxTries})...`);
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
            data: JSON.stringify({ embeds: [{ title: "☁️ VMOS Cloud", color: 16744448, fields, timestamp: new Date().toISOString() }] })
        });
    }

    // ================================================================
    // TÌM INPUT
    // ================================================================
    function isEmailLikeInput(inp) {
        if (!isElementVisible(inp)) return false;
        const type = (inp.type || 'text').toLowerCase();
        if (type !== 'text' && type !== 'email' && type !== '') return false;
        const ph = (inp.placeholder || '').toLowerCase();
        const name = (inp.name || '').toLowerCase();
        if (ph.includes('password') || ph.includes('mật khẩu') || name.includes('pass')) return false;
        if (ph.includes('search') || ph.includes('tìm kiếm')) return false;
        if (ph.includes('captcha') || name.includes('captcha')) return false;
        return true;
    }

    function findSubmitButton(anchor) {
        const isRegisterText = (t) => {
            t = (t || '').trim().toLowerCase();
            if (t.includes('đăng nhập/đăng ký') || t.includes('đăng ký/đăng nhập') || t.includes('login/register') || t.includes('register/login')) return true;
            if (t.includes('đăng nhập') || t.includes('login') || t.includes('sign in') || t.includes('signin')) return false;
            return t.includes('đăng ký') || t.includes('register') || t.includes('sign up') || t.includes('signup') || t.includes('tạo tài khoản') || t.includes('create account');
        };
        if (anchor) {
            const form = anchor.closest('form');
            if (form) {
                for (const b of form.querySelectorAll('button, [role="button"], a.btn')) {
                    if (!isElementVisible(b)) continue;
                    if (isRegisterText(b.textContent)) return b;
                }
            }
            let container = anchor.parentElement;
            for (let i = 0; i < 10 && container; i++) {
                for (const b of container.querySelectorAll('button, [role="button"], a.btn')) {
                    if (!isElementVisible(b)) continue;
                    if (isRegisterText(b.textContent)) return b;
                }
                container = container.parentElement;
            }
        }
        for (const b of document.querySelectorAll('button, [role="button"]')) {
            if (!isElementVisible(b) || b.clientHeight > 120) continue;
            if (isRegisterText(b.textContent)) return b;
        }
        return null;
    }

    function findEmailInput() {
        const submitBtn = findSubmitButton(null);
        if (submitBtn) {
            let node = submitBtn.parentElement;
            for (let depth = 0; depth < 12 && node; depth++) {
                const form = node.tagName === 'FORM' ? node : node.querySelector('form');
                const scope = form || node;
                for (const inp of scope.querySelectorAll('input')) {
                    if (!isEmailLikeInput(inp)) continue;
                    if (scope.contains(submitBtn) && scope.contains(inp)) return inp;
                }
                node = node.parentElement;
            }
        }
        let best = null, bestScore = -1;
        for (const inp of document.querySelectorAll('input')) {
            if (!isEmailLikeInput(inp)) continue;
            let score = 0;
            const all = ((inp.placeholder || '') + ' ' + (inp.name || '') + ' ' + (inp.id || '')).toLowerCase();
            if (all.includes('vui lòng nhập') && all.includes('email')) score += 1000;
            if (all.includes('địa chỉ email')) score += 500;
            if (all.includes('email') || all.includes('mail')) score += 100;
            if (inp.closest('[role="dialog"], [aria-modal="true"], .modal, .popup, .overlay')) score += 400;
            if (score > bestScore) { bestScore = score; best = inp; }
        }
        return best;
    }

    async function fillOtpField(otp) {
        const boxes = Array.from(document.querySelectorAll('input')).filter(inp => {
            if (!isElementVisible(inp)) return false;
            const ml = parseInt(inp.getAttribute('maxlength') || inp.maxLength || '0', 10);
            const it = (inp.type || 'text').toLowerCase();
            return ml === 1 && (it === 'text' || it === 'tel' || it === 'number' || inp.inputMode === 'numeric');
        });
        if (boxes.length >= 4) {
            for (let i = 0; i < boxes.length && i < otp.length; i++) {
                const box = boxes[i];
                const ch = otp[i];
                box.focus();
                await sleep(80);
                try {
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    setter.call(box, ch);
                } catch { box.value = ch; }
                box.dispatchEvent(new Event('input', { bubbles: true }));
                box.dispatchEvent(new Event('change', { bubbles: true }));
                box.dispatchEvent(new KeyboardEvent('keydown',  { key: ch, code: 'Digit' + ch, keyCode: ch.charCodeAt(0), which: ch.charCodeAt(0), bubbles: true }));
                box.dispatchEvent(new KeyboardEvent('keyup',    { key: ch, code: 'Digit' + ch, keyCode: ch.charCodeAt(0), which: ch.charCodeAt(0), bubbles: true }));
                await sleep(200);
            }
            return true;
        }
        let otpInput = null;
        for (const inp of document.querySelectorAll('input')) {
            if (inp === emailInputRef || !isElementVisible(inp) || inp.type === 'checkbox') continue;
            const ph = (inp.placeholder || '').toLowerCase();
            const name = (inp.name || '').toLowerCase();
            const id = (inp.id || '').toLowerCase();
            if (ph.includes('password') || ph.includes('mật khẩu') || name.includes('pass')) continue;
            if (ph.includes('xác minh') || ph.includes('mã xác') || ph.includes('otp') || ph.includes('mã') || ph.includes('code')
                || name.includes('otp') || name.includes('code') || id.includes('otp') || id.includes('code')) {
                otpInput = inp; break;
            }
        }
        if (!otpInput) {
            for (const inp of document.querySelectorAll('input')) {
                if (inp === emailInputRef || !isElementVisible(inp) || inp.type === 'checkbox') continue;
                const it = (inp.type || '').toLowerCase();
                if (it === 'tel' || it === 'number' || inp.inputMode === 'numeric') { otpInput = inp; break; }
            }
        }
        if (otpInput) { otpInput.focus(); setInputValue(otpInput, otp); return true; }
        return false;
    }

    function findNewPasswordInput() {
        for (const inp of document.querySelectorAll('input')) {
            if (!isElementVisible(inp)) continue;
            if ((inp.type || '').toLowerCase() !== 'password') continue;
            const ph = (inp.placeholder || '').toLowerCase();
            if (ph.includes('mật khẩu mới') || ph.includes('new password')) return inp;
        }
        let lastPwd = null;
        for (const inp of document.querySelectorAll('input')) {
            if (!isElementVisible(inp)) continue;
            if ((inp.type || '').toLowerCase() !== 'password') continue;
            lastPwd = inp;
        }
        return lastPwd;
    }

    // ================================================================
    // GRAB TOKEN
    // ================================================================
    function grabFromStorage(storageObj, prefix = '') {
        const result = {};
        try {
            for (let i = 0; i < storageObj.length; i++) {
                const key = storageObj.key(i);
                const val = storageObj.getItem(key);
                if (val == null) continue;
                const isJwt = /^eyJ[\w-]+\.[\w-]+\./.test(val);
                const keyLower = key.toLowerCase();
                if (/userlist|loginuser|recentuser|user_list|recent_login|history|userinfo|profile|account_list/i.test(keyLower)) continue;
                const trimmed = String(val).trim();
                if (!isJwt && (trimmed.startsWith('[{') || trimmed.startsWith('{"') ||
                              trimmed.startsWith('[{"') || trimmed.startsWith('{"username"'))) continue;
                if (isJwt ||
                    /token|auth_token|access_token|refresh_token|session_id|bearer|jwt/i.test(keyLower) ||
                    (/(^|_)(auth|session|bearer)(_|$)/i.test(keyLower) && !/list|users|history/i.test(keyLower))) {
                    result[prefix + key] = val;
                }
            }
        } catch(e) {}
        return result;
    }

    function getVmosToken() {
        const result = {};
        const ls = grabFromStorage(localStorage, '');
        const ss = grabFromStorage(sessionStorage, 'session:');
        Object.assign(result, ls, ss);
        const cookieStr = document.cookie || '';
        cookieStr.split(';').forEach(pair => {
            const idx = pair.indexOf('=');
            if (idx < 0) return;
            const k = pair.slice(0, idx).trim();
            const v = pair.slice(idx + 1).trim();
            const isJwt = /^eyJ[\w-]+\.[\w-]+\./.test(v);
            const kLower = k.toLowerCase();
            if (/userlist|loginuser|recent/i.test(kLower)) return;
            if (isJwt || /token|auth|session|bearer|jwt/i.test(kLower)) {
                const trimmed = String(v).trim();
                if (!isJwt && (trimmed.startsWith('[{') || trimmed.startsWith('{"'))) return;
                result['cookie:' + k] = v;
            }
        });
        for (const [k, v] of Object.entries(result)) {
            if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v)) return { token: v, source: k, all: result };
        }
        const priorityKeys = ['token', 'access_token', 'accessToken', 'auth_token', 'authToken', 'refresh_token', 'user_token', 'userToken', 'jwt', 'cookie:token', 'cookie:access_token', 'cookie:auth_token', 'cookie:jwt'];
        for (const pk of priorityKeys) {
            if (result[pk] && String(result[pk]).length > 20) return { token: result[pk], source: pk, all: result };
        }
        for (const [k, v] of Object.entries(result)) {
            const s = String(v);
            if (s.length > 30 && !s.includes('username') && !s.startsWith('[{') && !s.startsWith('{"')) return { token: s, source: k, all: result };
        }
        return null;
    }

    // ================================================================
    // RENDER LIST + XUẤT FILE
    // ================================================================
    function escapeHtml(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function renderList() {
        const list = loadAll();
        const container = document.getElementById('vmos-acc-list');
        if (!container) return;
        if (list.length === 0) {
            container.innerHTML = '<div id="vmos-empty-msg">Chưa có tài khoản nào.<br>Bấm 🚀 ĐĂNG KÝ để tạo mới.</div>';
            return;
        }
        const sorted = [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        container.innerHTML = sorted.map((acc, idx) => {
            const realToken = isRealToken(acc.token) ? acc.token : '';
            const tokenLabel = realToken
                ? `Token ${acc.tokenSource ? '(' + escapeHtml(acc.tokenSource) + ')' : ''}`
                : `Token <span style="color:#f38ba8;">(chưa có)</span>`;
            return `
            <div class="vmos-acc-card" data-email="${escapeHtml(acc.email)}">
                <div class="card-header">
                    <span class="card-index">#${list.length - idx}</span>
                    <span class="card-time">${escapeHtml(acc.createdAt ? new Date(acc.createdAt).toLocaleString('vi-VN') : '')}</span>
                    <button class="vmos-del-btn" data-del="${escapeHtml(acc.email)}">🗑</button>
                </div>
                <div class="vmos-field"><label>Email</label><div class="row">
                    <input class="vmos-acc-email" value="${escapeHtml(acc.email)}">
                    <button class="vmos-copy" data-copy-el="email">Copy</button>
                </div></div>
                <div class="vmos-field"><label>Mật khẩu</label><div class="row">
                    <input class="vmos-acc-pwd" value="${escapeHtml(acc.password)}">
                    <button class="vmos-copy" data-copy-el="pwd">Copy</button>
                </div></div>
                <div class="vmos-field"><label>${tokenLabel}</label><div class="row">
                    <textarea class="vmos-acc-token" placeholder="Chưa có token">${escapeHtml(realToken)}</textarea>
                    <button class="vmos-copy" data-copy-el="token">Copy</button>
                </div></div>
            </div>`;
        }).join('');

        container.querySelectorAll('.vmos-copy').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const card = e.target.closest('.vmos-acc-card');
                const kind = btn.getAttribute('data-copy-el');
                let val = '';
                if (kind === 'email') val = card.querySelector('.vmos-acc-email').value;
                if (kind === 'pwd') val = card.querySelector('.vmos-acc-pwd').value;
                if (kind === 'token') val = card.querySelector('.vmos-acc-token').value;
                navigator.clipboard.writeText(val).then(() => {
                    const old = btn.innerText;
                    btn.innerText = '✅';
                    setTimeout(() => btn.innerText = old, 1000);
                });
            });
        });
        container.querySelectorAll('.vmos-del-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const email = btn.getAttribute('data-del');
                if (confirm(`Xóa tài khoản "${email}"?`)) {
                    deleteAccountByEmail(email);
                    renderList();
                    logStatus(`🗑 Đã xóa ${email}`);
                }
            });
        });
        container.querySelectorAll('.vmos-acc-card').forEach(card => {
            const email = card.getAttribute('data-email');
            card.querySelectorAll('input, textarea').forEach(inp => {
                inp.addEventListener('change', () => {
                    const list2 = loadAll();
                    const idx = list2.findIndex(a => a.email === email);
                    if (idx >= 0) {
                        list2[idx].password = card.querySelector('.vmos-acc-pwd').value;
                        const newToken = card.querySelector('.vmos-acc-token').value.trim();
                        if (isRealToken(newToken) || !newToken) list2[idx].token = newToken;
                        list2[idx].updatedAt = new Date().toISOString();
                        saveAll(list2);
                    }
                });
            });
        });
    }

    function exportToTxt() {
        const list = loadAll();
        if (list.length === 0) return alert('Chưa có tài khoản nào để xuất!');
        const sorted = [...list].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        let content = '';
        content += '═══════════════════════════════════════════════\n';
        content += '        DANH SÁCH TÀI KHOẢN VMOS CLOUD\n';
        content += '        Xuất ngày: ' + new Date().toLocaleString('vi-VN') + '\n';
        content += '        Tổng số: ' + list.length + ' tài khoản\n';
        content += '═══════════════════════════════════════════════\n\n';
        sorted.forEach((acc, i) => {
            content += `───────── TÀI KHOẢN #${i + 1} ─────────\n`;
            content += `📧 Email:     ${acc.email || ''}\n`;
            content += `🔑 Mật khẩu:  ${acc.password || ''}\n`;
            if (isRealToken(acc.token)) content += `🎫 Token (${acc.tokenSource || '?'}):\n${acc.token}\n`;
            else content += `🎫 Token:     (chưa có)\n`;
            content += `⏰ Tạo lúc:   ${acc.createdAt ? new Date(acc.createdAt).toLocaleString('vi-VN') : ''}\n\n`;
        });
        content += '═══════════════════════════════════════════════\n           DẠNG CSV ĐỂ IMPORT EXCEL\n═══════════════════════════════════════════════\n';
        content += 'Email,Mật khẩu,Token,Token Source,Created\n';
        sorted.forEach(acc => {
            const e = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
            content += `${e(acc.email)},${e(acc.password)},${e(acc.token)},${e(acc.tokenSource)},${e(acc.createdAt)}\n`;
        });
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.href = url;
        a.download = `vmos_accounts_${ts}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        logStatus(`📥 Đã xuất ${list.length} tài khoản.`);
    }

    document.getElementById('vmos-export-btn').addEventListener('click', exportToTxt);

    document.getElementById('vmos-refresh-btn').addEventListener('click', () => {
        const tokenInfo = getVmosToken();
        if (tokenInfo && isRealToken(tokenInfo.token)) {
            const latest = getLatestAccount();
            if (latest) {
                if (latest.token && isRealToken(latest.token) && tokenInfo.token.length < latest.token.length * 0.5) {
                    logStatus(`⚠️ Token mới ngắn hơn token cũ, giữ nguyên.`);
                } else {
                    upsertAccount({ email: latest.email, token: tokenInfo.token, tokenSource: tokenInfo.source });
                    logStatus(`🔃 Đã cập nhật token (${tokenInfo.source})`);
                }
            }
        } else logStatus('⚠️ Không tìm thấy token thật.');
        renderList();
    });

    document.getElementById('vmos-clear-btn').addEventListener('click', () => {
        const list = loadAll();
        if (list.length === 0) return alert('Danh sách đã trống.');
        if (confirm(`XÓA TOÀN BỘ ${list.length} tài khoản?`)) {
            if (confirm('Chắc chắn chưa? Bé nên XUẤT FILE trước!')) {
                clearAllAccounts();
                renderList();
                logStatus('🗑 Đã xóa toàn bộ.');
            }
        }
    });

    // ================================================================
    // FLOW ĐĂNG KÝ
    // ================================================================
    startBtn.addEventListener('click', () => {
        if (isRunning) return;
        isRunning = true;
        clickLock = false;
        startBtn.innerText = "⏹️ ĐANG CHẠY...";
        startBtn.classList.add('running');
        logStatus("Bot v3.5 đang đăng ký...");
        startAutomation().finally(() => {
            isRunning = false;
            startBtn.innerText = "🚀 ĐĂNG KÝ";
            startBtn.classList.remove('running');
        });
    });

    async function startAutomation() {
        let account = await createMailTm();
        if (!account) { logStatus("Lỗi tạo email."); return; }

        // Điền form
        logStatus("Đang tìm ô nhập email...");
        let emailInput = null;
        for (let i = 0; i < 20; i++) {
            emailInput = findEmailInput();
            if (emailInput) break;
            await sleep(1000);
        }
        if (!emailInput) { logStatus("Không tìm thấy ô nhập email!"); return; }
        emailInputRef = emailInput;

        emailInput.focus();
        setInputValue(emailInput, account.email);
        logStatus(`Đã điền email: ${account.email}`);

        let checkbox = document.querySelector('input[type="checkbox"]');
        if (checkbox && !checkbox.checked) {
            checkbox.click();
            if (!checkbox.checked) { checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true })); }
            logStatus("Đã tick điều khoản.");
        }
        await sleep(1500);

        const excludeIds = await getCurrentMessageIds(account.email, account.password);

        logStatus("Đang tìm nút Đăng ký...");
        let actionBtn = null;
        for (let i = 0; i < 5; i++) {
            actionBtn = findSubmitButton(emailInput);
            if (actionBtn) break;
            await sleep(800);
        }
        if (!actionBtn) { logStatus("Không tìm thấy nút Đăng ký!"); return; }

        logStatus(`Đã tìm thấy nút: "${actionBtn.textContent.trim()}"\nĐang click...`);
        actionBtn.setAttribute('data-vmos-clicked', '1');
        actionBtn.style.pointerEvents = 'none';
        await hardClick(actionBtn, { lockMs: 5000 });
        logStatus("✅ Đã click Đăng ký!\n👉 Bé giải CAPTCHA nếu có.\nĐang chờ OTP...");

        // Chờ OTP
        const otpResult = await getOtp(account.email, account.password, { excludeIds });
        if (!otpResult) {
            logStatus("❌ Không nhận được OTP đăng ký (timeout)!");
            return;
        }
        const otp = otpResult.otp;
        logStatus(`✅ OTP đăng ký: ${otp}\nĐang điền...`);
        await sleep(2000);

        const okOtp = await fillOtpField(otp);
        if (okOtp) logStatus(`✅ Đã điền OTP: ${otp}\n👉 Bé bấm Xác nhận nếu cần.`);
        else logStatus(`⚠️ Không tìm thấy ô OTP. Mã là: ${otp}`);

        // Lưu account NGAY
        upsertAccount({ email: account.email, password: account.password });

        logStatus("⏳ Đợi 15s để Vmoscloud login & lưu token...");
        await sleep(15000);

        let tokenInfo = null;
        for (let i = 0; i < 15; i++) {
            tokenInfo = getVmosToken();
            if (tokenInfo && isRealToken(tokenInfo.token)) break;
            await sleep(1000);
        }

        if (tokenInfo && isRealToken(tokenInfo.token)) {
            upsertAccount({ email: account.email, token: tokenInfo.token, tokenSource: tokenInfo.source });
            logStatus(`✅ Đã lưu token (${tokenInfo.source})!`);
        } else {
            logStatus("⚠️ Chưa lấy được token.\nBé đăng nhập xong thì bấm 📚 XEM TẤT CẢ → 🔃 REFRESH.");
        }

        sendToDiscord(account.email, account.password, tokenInfo ? tokenInfo.token : null);
        accSection.style.display = 'block';
        renderList();
        logStatus(`🎉 Đăng ký xong! Có ${loadAll().length} tài khoản.`);
    }

    // ================================================================
    // FLOW ĐỔI MẬT KHẨU
    // ================================================================
    pwdBtn.addEventListener('click', () => {
        if (isRunning) return;
        isRunning = true;
        clickLock = false;
        pwdBtn.innerText = "⏹️ ĐANG CHẠY...";
        pwdBtn.classList.add('running');
        (async () => {
            const ok = await doChangePassword();
            accSection.style.display = 'block';
            renderList();
            if (ok) logStatus("🎉 Hoàn tất đổi mật khẩu!");
        })().finally(() => {
            isRunning = false;
            pwdBtn.innerText = "🔑 ĐỔI MẬT KHẨU (acc mới nhất)";
            pwdBtn.classList.remove('running');
        });
    });

    async function doChangePassword() {
        const acc = getLatestAccount();
        if (!acc) { logStatus("⚠️ Chưa có tài khoản."); return false; }

        logStatus("🔑 Bắt đầu đổi mật khẩu...");

        const modalAlreadyOpen = findLinkByText(['chắc chắn', 'xác nhận', 'confirm']) ||
                                 findButtonByText(['chắc chắn', 'xác nhận', 'confirm']);
        if (!modalAlreadyOpen) {
            logStatus("Đang tìm link 'Thay đổi mật khẩu'...");
            let changePwdBtn = findLinkByText(['thay đổi mật khẩu', 'đổi mật khẩu', 'change password']);
            if (!changePwdBtn) changePwdBtn = findButtonByText(['thay đổi mật khẩu', 'đổi mật khẩu', 'change password']);
            if (!changePwdBtn) {
                logStatus("❌ Không thấy link 'Thay đổi mật khẩu'.\n👉 Bé vào trang Cài đặt và cuộn xuống nhé!");
                return false;
            }
            logStatus(`✅ Đã tìm thấy: "${changePwdBtn.textContent.trim()}"\nĐang click...`);
            await hardClick(changePwdBtn);
            await sleep(2500);
        }

        logStatus("Đang tìm nút 'Nhận mã xác minh'...");
        const sendOtpBtn = await waitForElement(
            () => findButtonByText(['nhận mã xác minh', 'gửi mã xác minh', 'gửi mã', 'send code']) ||
                  findLinkByText(['nhận mã xác minh', 'gửi mã xác minh']),
            8000
        );
        if (!sendOtpBtn) { logStatus("❌ Không thấy nút 'Nhận mã xác minh'!"); return false; }

        const excludeIds = await getCurrentMessageIds(acc.email, acc.password);
        await hardClick(sendOtpBtn);
        logStatus("✅ Đã bấm! Đang chờ OTP...");

        const otpResult = await getOtp(acc.email, acc.password, { excludeIds, maxTries: 30, interval: 3000 });
        if (!otpResult) { logStatus("❌ Không nhận được OTP (timeout)!"); return false; }
        const otp = otpResult.otp;
        logStatus(`✅ OTP: ${otp}\nĐang điền...`);

        await sleep(1000);
        const okOtp = await fillOtpField(otp);
        if (!okOtp) { logStatus(`⚠️ Không tìm thấy ô OTP. Mã: ${otp}`); return false; }

        await sleep(500);
        const newPwdInput = findNewPasswordInput();
        if (!newPwdInput) { logStatus("⚠️ Không tìm thấy ô 'Mật khẩu mới'!"); return false; }
        newPwdInput.focus();
        setInputValue(newPwdInput, acc.password);
        logStatus("✅ Đã điền OTP + mật khẩu mới.\nĐang tìm nút 'Chắc chắn'...");

        await sleep(800);
        const confirmBtn = await waitForElement(
            () => findButtonByText(['chắc chắn', 'xác nhận', 'confirm', 'ok']) ||
                  findLinkByText(['chắc chắn', 'xác nhận', 'confirm']),
            5000
        );
        if (!confirmBtn) { logStatus("⚠️ Không tìm thấy nút 'Chắc chắn'."); return false; }
        await hardClick(confirmBtn);
        logStatus("✅ Đã bấm 'Chắc chắn'!");
        await sleep(3000);

        logStatus("Đang lấy token...");
        let tokenInfo = null;
        for (let i = 0; i < 20; i++) {
            tokenInfo = getVmosToken();
            if (tokenInfo && isRealToken(tokenInfo.token)) break;
            await sleep(500);
        }
        if (tokenInfo && isRealToken(tokenInfo.token)) {
            if (acc.token && isRealToken(acc.token) && tokenInfo.token.length < acc.token.length * 0.5) {
                logStatus(`⚠️ Token mới ngắn hơn token cũ, giữ nguyên.`);
            } else {
                upsertAccount({ email: acc.email, token: tokenInfo.token, tokenSource: tokenInfo.source });
                logStatus(`✅ Đã lưu token (${tokenInfo.source})!`);
            }
        } else logStatus("⚠️ Không thấy token thật. Bé REFRESH sau.");

        sendToDiscord(acc.email, acc.password, tokenInfo ? tokenInfo.token : null);
        return true;
    }

    // ================================================================
    // NÚT XEM TẤT CẢ
    // ================================================================
    viewAllBtn.addEventListener('click', () => {
        const list = loadAll();
        if (list.length === 0) { logStatus('📭 Chưa có tài khoản nào.'); return; }
        accSection.style.display = 'block';
        const tokenInfo = getVmosToken();
        if (tokenInfo && isRealToken(tokenInfo.token)) {
            const latest = getLatestAccount();
            if (latest && !isRealToken(latest.token)) {
                upsertAccount({ email: latest.email, token: tokenInfo.token, tokenSource: tokenInfo.source });
                logStatus(`📚 ${list.length} tài khoản. Đã tự update token cho acc mới nhất.`);
            } else logStatus(`📚 Có ${list.length} tài khoản.`);
        } else logStatus(`📚 Có ${list.length} tài khoản. (Chưa thấy token thật)`);
        renderList();
    });

    // ================================================================
    // INIT
    // ================================================================
    setTimeout(() => {
        if (loadAll().length > 0) {
            accSection.style.display = 'block';
            renderList();
        }
    }, 2000);
})();