// ==UserScript==
// @name         百度网盘 · 群组共享文件清单导出器
// @namespace    workbuddy.local/baidu-group-exporter
// @version      1.3.8
// @description  遍历通讯录中各群组的共享文件目录，导出所选共享目录的全部文件明细（CSV / JSON / 目录树），内置完整性自检。与 LinkSwift 并存互不干扰。
// @author       WorkBuddy
// @match        https://pan.baidu.com/*
// @match        https://yun.baidu.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * 原理说明（便于后续维护 / 接口变更时自行调整）
 * ---------------------------------------------------------------
 * 群组共享文件（通讯录 -> 群组 -> 群文件）使用的接口链路：
 *   1) GET  /mbox/group/list          列出我加入的所有群组（gid / name / uk）
 *   2) GET  /mbox/group/listshare     列出某个群里的「分享消息」，用 last_msg_time 游标翻页
 *   3) GET|POST /mbox/msg/shareinfo  列出某个分享文件夹下的子项（可分页，递归调用）
 *
 * 所有请求都在页面同源发起，自动携带已登录的 Cookie。
 * 脚本在 document-start 劫持 XHR / fetch 只读地「观察」页面自身发出的网盘请求，
 * 自动提取 bdstoken / dp-logid / logid / jsToken 等参数并保存完整 URL 模板，
 * 因此即使百度调整了参数名，只要用户点开过一次群文件页面，脚本就能自动适配。
 * ---------------------------------------------------------------
 *
 * 快速上手
 * ---------------------------------------------------------------
 * 1) 在 Tampermonkey 中安装本脚本，打开并登录 pan.baidu.com
 * 2) 先在网页左侧点开一次「通讯录 -> 群组 -> 群文件」，让脚本捕获页面请求参数
 * 3) 点右下角「清单 / 群文件」浮标打开面板
 * 4) 勾选要导出的群 ->「① 读取目录结构」-> 勾选目录 ->「② 开始扫描（边扫边写）」-> 导出 CSV / JSON / 目录树
 *    （导出文件名：群名称_文件夹名_时间_明细.csv）
 *
 * v1.0.9 起不再提供下载链接导出：百度对群分享里的大文件不签发 dlink，
 * 需要下载请在群里点「保存到我的网盘」，再用百度客户端或下载助手处理。
 * v1.1.0 新增：扫描进度自动存盘（断点续抓）、有界并发扫描（默认约 3~5 倍速）、
 * 触发限流时自动降回单路。
 * v1.1.1 修正：进度快照改为列式压缩并转存 IndexedDB，大目录不再因 localStorage
 * 5MB 配额而丢失断点。
 * v1.1.2 界面：四段参数说明改为默认收起的一行概要条，点击展开/收起并记住状态。
 * v1.1.3 新增：每次扫描自动归档一条「任务台账」（目录级统计 + 完整事件日志 + 导出记录 +
 * 完整性结论），长期保存在本地，可在「6. 日志 → 扫描记录」查看或导出核对报告 CSV。
 * 请遵守百度网盘服务条款，不要外发含令牌的 Cookie。
 * ---------------------------------------------------------------
 */
(function () {
    'use strict';

    if (window.__BPGEX_LOADED__) return;
    window.__BPGEX_LOADED__ = true;

    /* ============================================================
     * 0. 常量与工具
     * ============================================================ */

    var VERSION = '1.3.8';
    var CFG_KEY = 'bpgEx.cfg.v1';
    var SNAP_KEY = 'bpgEx.snapshot.v2';
    var SNAP_VER = 2;
    var RUN_KEY = 'bpgEx.runs.v1';   // 台账摘要索引（localStorage，同步可读）
    var RUN_MAX = 20;                 // 最多保留 20 条历史任务
    // 台账使用独立数据库：绝不升级「快照库」的版本。真机实测，只要旧版页面还持有
    // 快照库连接，升版本会触发挂起的 versionchange，之后该库任何 open() 都永久 pending。
    var RUN_DB = 'bpgEx_runs', RUN_STORE = 'runs';
    // 三档速度：delay=每请求等待，concurrency=并发路数，minInterval=全局最小请求间隔。
    // 倍数为「不含网络往返」的理论上限，真实加速以进度栏「实测 请求/秒」为准。
    var SPEED_PRESETS = {
        safe:     { label: '保守（原速度）', delay: 350, batchSize: 40, batchPause: 2500, concurrency: 1, minInterval: 120 },
        standard: { label: '标准 · 约 3~5 倍（推荐）', delay: 120, batchSize: 60, batchPause: 1200, concurrency: 2, minInterval: 45 },
        fast:     { label: '极速 · 约 6~8 倍（可能触发风控）', delay: 60, batchSize: 100, batchPause: 800, concurrency: 3, minInterval: 25 }
    };
    var SPEED_SHORT = { safe: '保守', standard: '标准', fast: '极速' };
    var API = {
        groups: '/mbox/group/list',
        listshare: '/mbox/group/listshare',
        shareinfo: '/mbox/msg/shareinfo'
    };
    var DEFAULT_COMMON = {
        app_id: '250528',
        clienttype: '0',
        web: '1',
        channel: 'chunlei'
    };
    var COMMON_KEYS = [
        'bdstoken', 'app_id', 'clienttype', 'web', 'channel',
        'dp-logid', 'logid', 'jsToken', 'js_token', 'appid', 'bdstoken_'
    ];
    var TPL_STRIP_KEYS = [
        'page', 'start', 'num', 'limit', 'fs_id', 'gid', 'msg_id',
        'from_uk', 'to_uk', 'cursor', 't', '_', 'sign', 'timestamp',
        'fid_list', 'primaryid', 'desc', 'type', 'fields', 'view_mode',
        'last_msg_time', '__bpg'
    ];

    var DEFAULT_CFG = {
        delay: 120,          // 每次请求间隔 ms
        batchSize: 60,       // 每 N 次请求休息一次
        batchPause: 1200,    // 休息时长 ms
        pageSize: 100,       // 单页条数
        maxPages: 300,       // 单个目录最大翻页数（防死循环）
        listShareMaxPages: 20, // 「读取目录结构」最多翻几页分享消息（listshare 用 last_msg_time 游标翻页）
        maxDepth: 20,        // 最大递归深度
        reqTimeout: 20000,   // 单个请求超时 ms（浏览器 fetch 默认永不超时，必须自带）
        includeDirs: true,   // 导出结果是否包含文件夹行
        speed: 'standard',   // 速度档位：safe | standard | fast | 自定义
        concurrency: 2,      // 同时展开几个目录（1~4）
        minInterval: 45,     // 全局最小请求间隔 ms，防止并发请求同一瞬间打出
        override: {}         // 请求公共参数兜底（界面已移除手动入口，全部自动嗅探）
    };
    // 真机实测：/mbox/msg/shareinfo 单页硬上限 100（num=1000 也只返回 100），
    // 且只返回 has_more、不返回总数；所以 pageSize 上限必须是 100，填更大值无效且会误判翻页。
    // 数字参数一律钳制，避免误填 0/负数导致「静默抓不到数据」。
    var CFG_RANGE = {
        delay: [0, 60000], batchSize: [0, 10000], batchPause: [0, 600000],
        pageSize: [10, 100], maxDepth: [1, 100], maxPages: [1, 2000],
        listShareMaxPages: [1, 500], reqTimeout: [5000, 120000],
        concurrency: [1, 4], minInterval: [0, 500]
    };
    function clampCfg(key, v) {
        var r = CFG_RANGE[key];
        if (!r) return v;
        var n = num(v);
        return Math.max(r[0], Math.min(r[1], n));
    }

    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, Math.max(0, ms | 0)); }); }
    function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
    function str(v) { return v === undefined || v === null ? '' : String(v); }
    function esc(s) {
        return str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function fmtSize(b) {
        b = num(b);
        if (b <= 0) return '0 B';
        var u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'], i = Math.floor(Math.log(b) / Math.log(1024));
        i = Math.min(i, u.length - 1);
        var v = b / Math.pow(1024, i);
        return (i === 0 ? v : v.toFixed(2)) + ' ' + u[i];
    }
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function fmtTime(sec) {
        sec = num(sec);
        if (!sec) return '';
        if (sec < 1e11) sec *= 1000;
        var d = new Date(sec);
        if (isNaN(d.getTime())) return '';
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    function stamp() {
        var d = new Date();
        return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' +
            pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    }
    function safeName(s) {
        return str(s).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/^\.+/, '_').trim().slice(0, 180) || 'unnamed';
    }
    // 百度 shareinfo/listshare 返回的 item.path 常是 URL 百分号编码（%2F%E4%B9%A6%E7%B1%8D%2F...），
    // 直接写进 CSV 看起来就是「乱码」，其实是分享者网盘里的原始完整路径，解码后非常有用。
    // 只解一次；没有合法 %XX 序列就当明文原样返回；非法编码/解码异常回退原文，绝不丢数据。
    function decodePath(s) {
        var v = str(s);
        if (!/%[0-9a-fA-F]{2}/.test(v)) return v;
        try {
            var d = decodeURIComponent(v);
            return d.indexOf('\uFFFD') >= 0 ? v : d;
        } catch (e) { return v; }
    }
    function joinPath(parent, name) {
        var base = str(parent).replace(/\/+$/, '');
        return (base ? base : '') + '/' + str(name).replace(/^\/+/, '');
    }
    function isDir(v) {
        return v === true || v === 1 || v === '1' || v === 'true';
    }
    // 兼容 errno 为数字 / 字符串的情况
    function errnoOk(r) {
        return !!r && (r.errno === undefined || r.errno === null || num(r.errno) === 0);
    }
    function getCookie(name) {
        try {
            var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
            return m ? m[1] : '';
        } catch (e) { return ''; }
    }

    /* ============================================================
     * 1. 全局状态
     * ============================================================ */

    var state = {
        cfg: loadCfg(),
        cap: {
            common: {},
            templates: {},
            currentGid: '',
            currentGidAt: 0,     // 最近一次确认当前群 gid 的时间戳
            currentGidSrc: '',   // 来源：'sniff'（接口嗅探）/ 'dom-hi'（高置信 DOM）/ 'dom'（兜底 DOM）
            domHiConf: false,    // 本次 DOM 推断是否来自百度自己标记的“当前会话”元素（真机实测最权威）
            activeGid: '',       // 由页面 DOM 内容推断的“正在查看的群”，纯 SPA 下 URL 不变时的兜底
            activeView: '',      // 人类可读的当前视图描述
            hits: 0,
            allUrls: []          // 诊断用：最近同源请求路径滚动记录
        },
        groups: [],
        selected: new Set(),
        groupFilter: '',
        records: [],
        seen: new Set(),
        queue: [],
        errors: [],
        logs: [],
        running: false,
        paused: false,
        aborted: false,
        streamDraining: false,  // 流式边扫边写进行中：采集层不再触发内存护栏硬暂停
        stream: null,           // 当前流式任务句柄（供状态查询）
        reqCount: 0,
        scannedDirs: 0,
        startedAt: 0,
        currentReq: null,     // 当前在途请求 { url, at } —— 用于心跳显示与超时诊断
        heartbeat: null,      // 心跳定时器句柄
        shareinfoBroken: false, // 子目录接口连续失败 → 熔断，避免空等半天
        dirFailStreak: 0,
        scannedFsIds: new Set(), // 已展开目录的 fs_id，用于「完整性自检」精确算出漏扫目录数
        truncated: { pages: 0, depth: 0 }, // 触及 maxPages / maxDepth 的次数（>0 即可能不完整）
        incomplete: false,       // 上次扫描是否未跑完（手动停止 / 队列残留 / 请求错误）
        verifying: false,        // 接口复核进行中
        methodShareinfo: 'GET',
        methodListshare: 'GET',
        topDirs: [],          // 顶层目录清单（供用户勾选）
        topItems: [],         // 读取结构时缓存的顶层条目（目录+直接文件），扫描时才并入结果
        topDirSeq: 0,
        selectedDirs: new Set(),       // 已勾选要导出的顶层目录 cid 集合
        structureRead: false,  // 是否已经执行过「读取目录结构」（用于区分「没点过」和「点了但 0 个目录」）
        structureError: '',    // 读取结构的明确失败原因（例如「未选择目标群」），直接显示在第 3 栏
        structureIncomplete: false, // 读取结构时分享消息没翻完（触顶/游标丢失）→ 后面可能还有目录
        structurePages: 0,     // 本次读取结构翻了几页分享消息
        structureMsgs: 0,      // 本次读取结构共读到多少条分享消息
        phase: 'idle',        // idle | select(已读结构待选) | scanning | done
        stats: { files: 0, dirs: 0, bytes: 0 },
        eff: { delay: 350, minInterval: 120, concurrency: 1, slow: false }, // 本轮实际生效的速度参数（可被自动降速改写，不污染用户配置）
        inFlight: [],         // 已被 worker 取走、尚未写完结果的目录；快照时必须并回队列，否则恢复后会整层漏扫
        failedJobs: [],       // 本轮请求失败的目录：本轮不重试（避免死循环），但写入断点供下次续抓重试
        run: null             // 当前/最近一次扫描的「任务台账」，持久化供事后核对
    };

    function loadCfg() {
        try {
            var raw = localStorage.getItem(CFG_KEY);
            var c = raw ? JSON.parse(raw) : {};
            var merged = Object.assign(clone(DEFAULT_CFG), c, { override: c.override || {} });
            // 从 1.0.x 升级：旧配置里没有 speed，若直接沿用旧的 350ms 间隔会拖慢新并发，
            // 因此老用户也自动套用标准档（用户之后手动改档会写入 speed，不再被覆盖）。
            if (!c.speed) {
                var p = SPEED_PRESETS.standard;
                Object.keys(p).forEach(function (k) { if (k !== 'label') merged[k] = p[k]; });
                merged.speed = 'standard';
            }
            Object.keys(CFG_RANGE).forEach(function (k) { merged[k] = clampCfg(k, merged[k]); });
            return merged;
        } catch (e) { return clone(DEFAULT_CFG); }
    }
    function saveCfg() {
        try { localStorage.setItem(CFG_KEY, JSON.stringify(state.cfg)); } catch (e) { }
    }
    function speedLabel() { return SPEED_SHORT[state.cfg.speed] || '自定义'; }
    function applySpeedPreset(name) {
        var p = SPEED_PRESETS[name];
        if (!p) return;
        state.cfg.speed = name;
        Object.keys(p).forEach(function (k) { if (k !== 'label') state.cfg[k] = p[k]; });
        saveCfg();
    }
    function resetEff() {
        state.eff = {
            delay: num(state.cfg.delay),
            minInterval: num(state.cfg.minInterval),
            concurrency: Math.max(1, Math.min(4, num(state.cfg.concurrency) || 1)),
            slow: false
        };
    }
    // 触发百度限流时自动退到单路并拉长间隔；只影响本轮，不改用户选的档位。
    function slowDown(reason) {
        if (state.eff.slow) return;
        state.eff.slow = true;
        state.eff.concurrency = 1;
        state.eff.delay = Math.max(num(state.eff.delay) * 2, 300);
        state.eff.minInterval = Math.max(num(state.eff.minInterval) * 2, 100);
        log('⚠ 触发限流（' + reason + '），已自动降为单路 + 请求间隔 ' + state.eff.delay +
            'ms；本轮不再提速，建议改用「保守」档位。', 'warn');
    }
    resetEff();

    function log(msg, level) {
        level = level || 'info';
        var line = { t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: level, msg: str(msg) };
        state.logs.push(line);
        if (state.logs.length > 400) state.logs.shift();
        // 面板日志只留 400 条且刷新即丢；任务台账另存全量（上限 8000 行），供事后核对。
        if (state.run && state.run.events.length < 8000) state.run.events.push(line);
        if (level === 'error') console.error('[群清单]', msg);
        renderLog();
    }

    /* ============================================================
     * 2. 网络嗅探：只读地观察页面自己的请求，自动取参数
     * ============================================================ */

    // 放宽嗅探范围：捕获百度网盘所有「疑似接口」的请求（不再只认 /mbox/），避免漏掉改版后的子目录接口
    function isApiUrl(rawUrl) {
        if (!rawUrl || typeof rawUrl !== 'string') return false;
        if (rawUrl.indexOf('__bpg=1') >= 0) return false;        // 跳过脚本自己发的请求
        if (rawUrl.indexOf(location.origin) < 0 &&
            rawUrl.indexOf('//pan.baidu.com') < 0 && rawUrl.indexOf('//yun.baidu.com') < 0) return false;
        var lower = rawUrl.toLowerCase();
        if (/\.(js|css|png|jpe?g|gif|webp|woff2?|ttf|svg|ico|mp3|mp4|bam|map)(\?|$)/.test(lower)) return false;
        return /(mbox|share|group|box|cast|msg|filelist|file_list|list|dir)/.test(lower);
    }

    function pushAllUrl(s) {
        if (!state.cap.allUrls) state.cap.allUrls = [];
        if (state.cap.allUrls[state.cap.allUrls.length - 1] === s) return; // 去重相邻重复
        state.cap.allUrls.push(s);
        if (state.cap.allUrls.length > 40) state.cap.allUrls.shift();
    }

    var _statThrottle = 0;
    function captureUrl(rawUrl) {
        // 诊断：记录最近同源请求路径，便于确认百度实际调用的接口（网盘是单页应用，地址栏可能始终为 /disk/main）
        try {
            if (rawUrl && (rawUrl.indexOf(location.origin) >= 0 ||
                rawUrl.indexOf('//pan.baidu.com') >= 0 || rawUrl.indexOf('//yun.baidu.com') >= 0)) {
                var _u = new URL(rawUrl, location.origin);
                pushAllUrl(_u.pathname + (_u.search ? _u.search.slice(0, 80) : ''));
                var _now = Date.now();
                if (_now - _statThrottle > 400) { _statThrottle = _now; if (el && el.status) renderStatus(); }
            }
        } catch (e) { }
        if (!isApiUrl(rawUrl)) return;
        try {
            var u = new URL(rawUrl, location.origin);
            var path = u.pathname;
            state.cap.hits++;
            state.cap.templates[path] = u.href;
            // 保留原始 URL（未剥离参数），供探针直接重放
            if (!state.cap.rawUrls) state.cap.rawUrls = {};
            if (!state.cap.rawUrls[path]) state.cap.rawUrls[path] = u.href;
            if (!state.cap.loggedPaths) state.cap.loggedPaths = {};
            if (!state.cap.loggedPaths[path]) {
                state.cap.loggedPaths[path] = 1;
                log('嗅探到页面接口：' + path + (u.search ? '  参数=' + decodeURIComponent(u.search.slice(0, 200)) : ''));
            }
            for (var i = 0; i < COMMON_KEYS.length; i++) {
                var k = COMMON_KEYS[i];
                if (u.searchParams.has(k)) state.cap.common[k] = u.searchParams.get(k);
            }
            // 当前群：任何带 gid / group_id 的接口请求都代表“正在查看该群”，
            // 切换群组时页面必发此类请求，据此实时更新（比 DOM 推断更权威）。
            var reqGid = u.searchParams.get('gid') || u.searchParams.get('group_id');
            if (reqGid) {
                state.cap.currentGid = reqGid;
                state.cap.currentGidAt = Date.now();
                state.cap.currentGidSrc = 'sniff';
            }
            renderStatus();
        } catch (e) { }
    }

    function captureResponse(rawUrl, text) {
        if (!rawUrl || !text || text.length > 2e6) return;
        try {
            var u = new URL(rawUrl, location.origin);
            if (u.searchParams.get('__bpg') === '1') return;
            var j = JSON.parse(text);
            if (rawUrl.indexOf(API.listshare) >= 0) {
                var recs = j && j.records;
                var gid = recs && (recs.gid || recs.group_id);
                if (gid) { state.cap.currentGid = str(gid); state.cap.currentGidAt = Date.now(); state.cap.currentGidSrc = 'sniff'; }
            }
            if (rawUrl.indexOf(API.shareinfo) >= 0) {
                var list = j && (j.list || (j.records && (j.records.list || j.records.msg_list)) || j.msg_list || (j.data && j.data.list));
                var n = (list && list.length) || 0;
                var sample = n ? JSON.stringify(Object.keys(list[0]).slice(0, 24)) : '(空)';
                log('[嗅探] shareinfo 响应 errno=' + j.errno + ' 子项=' + n +
                    ' 顶层字段=' + JSON.stringify(Object.keys(j).slice(0, 20)) +
                    (n ? ' 首条字段=' + sample : ''), n ? 'info' : 'warn');
                if (n) state.cap.lastShareinfoSample = { errno: j.errno, keys: Object.keys(j), itemKeys: Object.keys(list[0]) };
            }
            // 通用：任何疑似接口响应都记录顶层结构，便于发现改版后的新路径。
            // 下载类响应可能携带临时令牌，不写进日志。
            if (!/tplconfig|sharedownload/.test(rawUrl)) {
                log('[嗅探] 响应 ' + u.pathname + ' errno=' + j.errno +
                    ' 字段=' + JSON.stringify(Object.keys(j).slice(0, 16)) +
                    (text.length > 260 ? ' 体长度=' + text.length : ' 体=' + text.slice(0, 200)),
                    j.errno === 0 || j.errno === undefined ? 'info' : 'warn');
            }
        } catch (e) { }
    }

    function installSniffer() {
        try {
            var OrigXHR = window.XMLHttpRequest;
            if (OrigXHR && OrigXHR.prototype) {
                var origOpen = OrigXHR.prototype.open;
                var origSend = OrigXHR.prototype.send;
                OrigXHR.prototype.open = function (method, url) {
                    try { this.__bpgUrl = typeof url === 'string' ? url : (url && url.href) || ''; captureUrl(this.__bpgUrl); } catch (e) { }
                    return origOpen.apply(this, arguments);
                };
                OrigXHR.prototype.send = function () {
                    var self = this;
                    try {
                        if (self.__bpgUrl && isApiUrl(self.__bpgUrl)) {
                            self.addEventListener('load', function () {
                                try { captureResponse(self.__bpgUrl, self.responseText); } catch (e) { }
                            });
                        }
                    } catch (e) { }
                    return origSend.apply(this, arguments);
                };
            }
        } catch (e) { console.warn('[群清单] XHR 嗅探安装失败', e); }

        try {
            var origFetch = window.fetch;
            if (typeof origFetch === 'function') {
                window.fetch = function (input, init) {
                    var url = typeof input === 'string' ? input : (input && input.url) || '';
                    captureUrl(url);
                    var p = origFetch.apply(this, arguments);
                    if (url && isApiUrl(url)) {
                        try {
                            p.then(function (r) {
                                try { r.clone().text().then(function (t) { captureResponse(url, t); }).catch(function () { }); } catch (e) { }
                            }).catch(function () { });
                        } catch (e) { }
                    }
                    return p;
                };
            }
        } catch (e) { console.warn('[群清单] fetch 嗅探安装失败', e); }
    }

    /* ============================================================
     * 导航监听：网盘是 SPA，点进群文件时 URL 走 pushState 切换，
     *      页面不会刷新，脚本必须主动监听 URL 变化并刷新状态面板，
     *      同时尽量从地址栏直接识别当前群组 gid
     * ============================================================ */

    var _lastHref = '';
    var _lastPath = '';

    function extractGidFromUrl() {
        try {
            // 1) query 中的 gid / group_id / groupid
            var q = new URLSearchParams(location.search);
            var g = q.get('gid') || q.get('group_id') || q.get('groupid');
            if (g) return str(g);
            // 2) hash 路由（现代 SPA 常把上下文放 hash）
            var h = location.hash || '';
            var m = h.match(/[?&]gid=([^&]+)/i) || h.match(/(?:^|[/-])gid[-_]?([0-9]{6,})/i) ||
                    h.match(/group[-_]?([0-9]{6,})/i);
            if (m) return m[1];
            // 3) path 中的 gid
            var pm = location.pathname.match(/[?&]gid=([^&\/]+)/i) || location.pathname.match(/group\/([0-9]{6,})/i);
            if (pm) return pm[1];
        } catch (e) { }
        return '';
    }

    var _lastGid = '';
    function onUrlChange(silent) {
        try {
            _lastHref = location.href;
            var g = extractGidFromUrl();
            if (g && g !== _lastGid) {
                _lastGid = g;
                state.cap.currentGid = g;
                log('从页面地址识别到当前群 gid=' + g, 'info');
            }
            var p = location.pathname;
            if (p !== _lastPath) {
                _lastPath = p;
                if (!silent) log('页面已切换到：' + location.pathname + (location.search ? location.search.slice(0, 60) : ''), 'info');
            }
            if (el && el.status) renderStatus();
        } catch (e) { }
    }

    // 百度网盘是“纯内部 SPA”：进入群文件时 URL/pathname/hash 都不变，pushState 也不触发。
    // 因此只能从“页面上正在渲染的内容”推断当前群。我们在左侧群组列表、面包屑、主区标题里
    // 寻找与已加载群组名称一致的文本，从而让状态面板实时反映“正在查看哪个群”。
    function groupNameById(gid) {
        for (var i = 0; i < state.groups.length; i++) {
            if (state.groups[i].gid === gid) return state.groups[i].name;
        }
        return '';
    }

    // 群名 → gid。百度接口返回的群名可能与页面显示不完全一致（真机实测：接口返回
    // "200T分布式本地化小组(秘" 缺右括号，页面/会话列表显示可能是完整名或带省略号截断），
    // 故依次尝试：精确相等 → 忽略标点/大小写的规范化相等 → 唯一前缀匹配（页面名被截断时）。
    // 前缀匹配仅在文本长度 ≥4 时启用，避免 DX 与 DX2 这类短名互相误吞。
    function normName(s) {
        return str(s).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]/g, '');
    }
    function matchGroupName(text) {
        var t = str(text).trim();
        if (!t || t.length > 80) return '';
        var i;
        for (i = 0; i < state.groups.length; i++) {
            if (state.groups[i].name === t) return state.groups[i].gid;
        }
        var nt = normName(t);
        if (!nt) return '';
        for (i = 0; i < state.groups.length; i++) {
            if (normName(state.groups[i].name) === nt) return state.groups[i].gid;
        }
        if (nt.length >= 4) {
            var cands = [];
            for (i = 0; i < state.groups.length; i++) {
                var gn = normName(state.groups[i].name);
                if (gn && (gn.indexOf(nt) === 0 || nt.indexOf(gn) === 0)) cands.push(state.groups[i].gid);
            }
            if (cands.length === 1) return cands[0];
        }
        return '';
    }

    // 识别“当前正在查看的群”。
    // 真机实测结论（2026-11-08，Edge + pan.baidu.com 消息视图）：
    //   · 百度自己把当前会话写在 DOM 上：.message-header .title-text（聊天窗口头部，唯一）
    //     与 .im-list-card.active .im-list-card__cov--title（左侧选中会话卡片），二者随点击实时变化。
    //   · 左侧 .im-list-card 列表里塞着所有群名，不能靠“扫全页文本”判断当前群。
    //   · 旧代码用 el.root 排除脚本面板，但 el.root 从未赋值（实际是 el.panel），
    //     导致面板自己渲染的状态栏 <b>群名</b> 与群列表第一项 span.gname 被反复读到，
    //     形成自反馈锁死 —— 这就是「当前群永远显示第一个群组、切群不变」的真正根因。
    //   · 旧的宽泛排除选择器（[class*="list"] 等）在真机命中 242 个元素，连主内容标题一起排掉，已弃用。
    function detectActiveGroup() {
        state.cap.domHiConf = false;
        if (!state.groups || !state.groups.length) return '';
        try {
            // 1) 高置信：百度标记的当前会话（真机验证：切到 笔墨/音乐022/DX2 均实时跟随）
            var hiSels = [
                '.message-header .title-text',
                '.im-m-contain__header .title-text',
                '.im-list-card.active .im-list-card__cov--title'
            ];
            for (var h = 0; h < hiSels.length; h++) {
                var nodes = document.querySelectorAll(hiSels[h]);
                for (var j = 0; j < nodes.length; j++) {
                    var gid = matchGroupName(nodes[j].textContent || '');
                    if (gid) { state.cap.domHiConf = true; return gid; }
                }
            }

            // 2) 兜底：群文件等其它视图。必须排除脚本面板自身（防自反馈）与会话列表容器。
            //    这里只用精确类名，不用宽泛的 [class*="list"]，避免误伤主内容标题。
            var excludeEls = [];
            var panel = (el && (el.panel || el.root)) || document.getElementById('bpgEx-panel');
            if (panel) excludeEls.push(panel);
            var preciseSel = '.im-list-card,.im-recycle-dom__item,.im-recycle-dom__transition,.bpgEx-groups,.bpgEx-status,[class*="sidebar"],[class*="Sidebar"],[class*="nav-menu"],[class*="NavMenu"],[class*="contact-list"],[class*="ContactList"]';
            var lns = document.querySelectorAll(preciseSel);
            for (var s = 0; s < lns.length; s++) excludeEls.push(lns[s]);
            function insideExclude(node) {
                for (var i = 0; i < excludeEls.length; i++) {
                    if (excludeEls[i] && excludeEls[i].contains && excludeEls[i].contains(node)) return true;
                }
                return false;
            }
            // 2a) 标题/面包屑类元素优先
            var headers = document.querySelectorAll('h1,h2,h3,.title,[class*="Title"],[class*="title"],[class*="crumb"],[class*="Crumb"],[class*="path"],[class*="Path"]');
            for (var q = 0; q < headers.length; q++) {
                if (insideExclude(headers[q])) continue;
                var ht = (headers[q].textContent || '').trim();
                if (!ht || ht.length > 120) continue;
                var r = matchGroupName(ht);
                if (r) return r;
            }
            // 2b) 主内容区叶子文本
            var main = document.querySelector('#fileList,.file-list,[class*="fileList"],[class*="FileList"]') || document.body;
            if (main !== document.body) {
                var texts = main.querySelectorAll('*');
                for (var n = 0; n < texts.length; n++) {
                    if (insideExclude(texts[n])) continue;
                    if (texts[n].children && texts[n].children.length !== 0) continue;
                    var tx = (texts[n].textContent || '').trim();
                    if (tx.length >= 2 && tx.length <= 60) {
                        var r2 = matchGroupName(tx);
                        if (r2) return r2;
                    }
                }
            }
            // 2c) 文档标题
            var title = (document.title || '').trim();
            if (title) {
                for (var k = 0; k < state.groups.length; k++) {
                    if (title.indexOf(state.groups[k].name) >= 0) return state.groups[k].gid;
                }
            }
        } catch (e) { }
        return '';
    }

    function watchNavigation() {
        try {
            _lastHref = location.href; _lastPath = location.pathname;
            // 初始先静默识别一次（处理“刷新后直接停在群文件页”的情况）
            try { onUrlChange(true); } catch (e) { }
            var _ps = history.pushState, _rs = history.replaceState;
            if (typeof _ps === 'function') {
                history.pushState = function () {
                    var r = _ps.apply(this, arguments);
                    _lastHref = location.href; onUrlChange(); return r;
                };
            }
            if (typeof _rs === 'function') {
                history.replaceState = function () {
                    var r = _rs.apply(this, arguments);
                    _lastHref = location.href; onUrlChange(); return r;
                };
            }
            window.addEventListener('popstate', function () { onUrlChange(); });
            window.addEventListener('hashchange', function () { onUrlChange(); });
        } catch (e) { console.warn('[群清单] 导航监听安装失败', e); }
        // 兜底轮询：百度是“纯内部 SPA”，进入群文件时 URL 完全不变；
        // 因此除 URL 检测外，还需轮询页面 DOM 内容来识别“正在查看哪个群”，让状态面板实时反应。
        try {
            setInterval(function () {
                try {
                    if (location.href !== _lastHref) { _lastHref = location.href; onUrlChange(); }
                    var g = detectActiveGroup();
                    var now = Date.now();
                    // 高置信 DOM（百度自己标记的 .message-header/.im-list-card.active）随切会话实时变化，
                    // 是最高权威，必须穿透 4s 嗅探锁；只有低置信兜底 DOM 才让位给新鲜的接口嗅探。
                    var hiConf = state.cap.domHiConf === true;
                    var sniffFresh = (state.cap.currentGidSrc === 'sniff') && (now - state.cap.currentGidAt < 4000);
                    if (g && g !== state.cap.currentGid && (hiConf || !sniffFresh)) {
                        state.cap.currentGid = g;
                        state.cap.currentGidAt = now;
                        state.cap.currentGidSrc = hiConf ? 'dom-hi' : 'dom';
                        var nm = groupNameById(g);
                        log('识别到当前群：' + (nm ? nm + ' (' + g + ')' : g) + (hiConf ? ' [页面会话标题]' : ''), 'info');
                        if (el && el.status) renderStatus();
                    }
                } catch (e) { }
            }, 1000);
        } catch (e) { }
    }

    /* ============================================================
     * 3. 参数与请求层
     * ============================================================ */

    function detectBdstoken() {
        try {
            var l = window.locals && window.locals.dump && window.locals.dump();
            if (l && l.bdstoken) return str(l.bdstoken.value || l.bdstoken);
        } catch (e) { }
        try {
            if (window.bdstoken) return str(window.bdstoken);
            if (window.jsToken) { /* jsToken 不是 bdstoken，仅作占位 */ }
        } catch (e) { }
        try {
            var html = document.documentElement ? document.documentElement.innerHTML : '';
            var m = html.match(/["']?bdstoken["']?\s*[:=]\s*["']([a-zA-Z0-9]{16,64})["']/);
            if (m) return m[1];
            var el = document.querySelector('input[name="bdstoken"], #bdstoken');
            if (el && el.value) return el.value;
        } catch (e) { }
        return '';
    }

    function makeLogid() {
        var id = getCookie('BAIDUID') || String(Date.now());
        try { return btoa(unescape(encodeURIComponent(id))); } catch (e) { return ''; }
    }

    function commonParams(extra) {
        var p = Object.assign({}, DEFAULT_COMMON, state.cap.common, state.cfg.override, extra || {});
        if (!p.bdstoken) p.bdstoken = detectBdstoken();
        if (!p.logid) p.logid = makeLogid();
        p.t = Date.now();
        return p;
    }

    function buildUrl(path, params, allowEmptyKeys) {
        var tpl = state.cap.templates[path];
        var u = tpl ? new URL(tpl, location.origin) : new URL(path, location.origin);
        if (tpl) TPL_STRIP_KEYS.forEach(function (k) { u.searchParams.delete(k); });
        var p = commonParams(params);
        var allow = allowEmptyKeys || [];
        Object.keys(p).forEach(function (k) {
            var v = p[k];
            if (v === undefined || v === null) return;
            if (v === '' && allow.indexOf(k) < 0) return;
            u.searchParams.set(k, str(v));
        });
        u.searchParams.set('__bpg', '1');
        return u;
    }

    async function api(path, params, opts) {
        opts = opts || {};
        var u = buildUrl(path, params, opts.allowEmptyKeys);
        var init = {
            method: opts.method || 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'X-Requested-With': 'XMLHttpRequest'
            }
        };
        if (opts.body !== undefined && opts.body !== null) {
            init.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
            init.body = typeof opts.body === 'string' ? opts.body : new URLSearchParams(opts.body).toString();
        }
        // 浏览器 fetch 默认永不超时：自带 AbortController，避免请求被服务器挂起时无限转圈
        var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
        var timer = setTimeout(function () { try { ctrl && ctrl.abort(); } catch (e) { } }, state.cfg.reqTimeout);
        state.currentReq = { url: u.href, at: Date.now(), path: u.pathname };
        try {
            var resp = await window.fetch(u.href, ctrl ? Object.assign({}, init, { signal: ctrl.signal }) : init);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            var text = await resp.text();
            var json;
            try { json = JSON.parse(text); }
            catch (e) { throw new Error('响应不是 JSON（可能登录失效或触发风控）: ' + text.slice(0, 120)); }
            return json;
        } catch (e) {
            if (e && e.name === 'AbortError') {
                throw new Error('请求超时（>' + Math.round(state.cfg.reqTimeout / 1000) + 's 无响应）→ ' +
                    u.pathname + ' — 请复制下方诊断信息反馈');
            }
            throw e;
        } finally {
            clearTimeout(timer);
            if (state.currentReq && state.currentReq.url === u.href) state.currentReq = null;
        }
    }

    // 需要限流/重试/暂停感知的请求包装：自动在 GET/POST 之间切换，超时或失败后快速换方法重试
    async function apiThrottled(path, params, opts, label) {
        opts = opts || {};
        var base = (opts.method || 'GET').toUpperCase();
        var lastErr = null;
        for (var attempt = 0; attempt < 2; attempt++) {
            // 第 0 次用既定方法；第 1 次自动切换 GET/POST（很多百度接口仅一种方法可用）
            var m = attempt === 0 ? base : (base === 'GET' ? 'POST' : 'GET');
            var ro = Object.assign({}, opts, { method: m });
            if (m !== 'POST') delete ro.body; else if (ro.body === undefined) ro.body = {};
            try {
                await gate();
                var r = await api(path, params, ro);
                if (r && [4, 9013, 31034, 9019].indexOf(num(r.errno)) >= 0) {
                    slowDown('errno=' + r.errno);
                    throw new Error('接口限流/令牌异常 errno=' + r.errno + '，稍后重试');
                }
                if (errnoOk(r)) {
                    if (path === API.listshare) state.methodListshare = m;
                    if (path === API.shareinfo) state.methodShareinfo = m;
                }
                return r;
            } catch (e) {
                lastErr = e;
                log((label || path) + ' 第 ' + (attempt + 1) + ' 次失败(' + m + ')：' + e.message, 'warn');
                await sleep(700 * Math.pow(2, attempt));
            }
        }
        throw lastErr || new Error('请求失败');
    }

    var nextSlot = 0;
    async function gate() {
        state.reqCount++;
        // 并发时给每个请求分配一个全局时隙：即使多路同时到达，也至少错开 minInterval，
        // 避免同一瞬间打出一批请求触发风控（这是并发不翻车的关键）。
        var now = Date.now();
        var at = Math.max(now, nextSlot);
        nextSlot = at + state.eff.minInterval;
        var wait = Math.max(at - now, state.eff.delay);
        if (state.cfg.batchSize > 0 && state.reqCount % state.cfg.batchSize === 0) {
            log('已连续请求 ' + state.reqCount + ' 次，休息 ' + state.cfg.batchPause + 'ms 防风控');
            wait += state.cfg.batchPause;
        }
        if (wait > 0) await sleep(wait);
        while (state.paused && !state.aborted) await sleep(200);
        if (state.aborted) throw new Error('已停止');
    }

    function pickList(r) {
        if (!r) return [];
        if (Array.isArray(r.msg_list)) return r.msg_list;
        if (Array.isArray(r.records)) return r.records;
        if (Array.isArray(r.list)) return r.list;
        var recs = r.records;
        if (recs && Array.isArray(recs.msg_list)) return recs.msg_list;
        if (recs && Array.isArray(recs.list)) return recs.list;
        if (recs && Array.isArray(recs.file_list)) return recs.file_list;
        if (recs && recs.filelist && Array.isArray(recs.filelist.list)) return recs.filelist.list;
        return [];
    }
    function rawHasMore(r) {
        if (!r) return undefined;
        var cands = [r.has_more, r.hasMore, r.records && r.records.has_more,
            r.records && r.records.hasMore, r.data && r.data.has_more];
        for (var i = 0; i < cands.length; i++) {
            if (cands[i] !== undefined && cands[i] !== null) return num(cands[i]) === 1;
        }
        return undefined;
    }
    function pickMsgFiles(msg) {
        if (!msg) return [];
        if (Array.isArray(msg.file_list)) return msg.file_list;
        if (msg.filelist && Array.isArray(msg.filelist.list)) return msg.filelist.list;
        if (Array.isArray(msg.files)) return msg.files;
        if (Array.isArray(msg.filelist)) return msg.filelist;
        return [];
    }

    /* ============================================================
     * 4. 扫描引擎
     * ============================================================ */

    function normalizeItem(item, ctx, parentPath, depth) {
        var name = item.server_filename || item.filename || item.name || '(未命名)';
        var fsId = str(item.fs_id !== undefined ? item.fs_id : (item.fsId || ''));
        var full = joinPath(parentPath, name);
        return {
            idx: 0,
            groupName: ctx.groupName,
            gid: ctx.gid,
            msgId: ctx.msgId,
            fromUk: ctx.fromUk,
            shareUname: ctx.uname,
            depth: depth,
            isDir: isDir(item.isdir),
            name: name,
            path: full,
            parent: parentPath || '/',
            size: num(item.size),
            category: str(item.category || ''),
            md5: str(item.md5 || ''),
            fsId: fsId,
            ctime: num(item.server_ctime || item.local_ctime || 0),
            mtime: num(item.server_mtime || item.local_mtime || 0),
            rawPath: decodePath(item.path)
        };
    }

    function addRecord(rec) {
        var key = rec.gid + '|' + rec.fsId + '|' + rec.path;
        if (state.seen.has(key)) return null;
        state.seen.add(key);
        rec.idx = state.records.length + 1;
        state.records.push(rec);
        if (rec.isDir) state.stats.dirs++;
        else { state.stats.files++; state.stats.bytes += rec.size; }
        if (state.records.length >= MEM_GUARD && state.running) {
            if (state.streamDraining) {
                // 流式边扫边写：不锁死 memGuardHit，只软暂停；定时 drain 清空内存后自动解除，
                // 因此无论总量多大，内存峰值都恒定在 MEM_GUARD 量级，不会撑爆浏览器。
                state.paused = true;
            } else if (!memGuardHit) {
                memGuardHit = true;
                state.paused = true;   // 请求层会停在下一个 gate，内存不再增长
                log('⚠ 已抓 ' + MEM_GUARD + ' 条明细，为避免浏览器内存不足已自动暂停。请先「导出 CSV」保存这批结果，再清空结果、分批勾选目录重扫；手动点「暂停/继续」可强行继续（不推荐）。', 'warn');
            }
        }
        return rec;
    }

    async function fetchGroups() {
        var out = [], start = 0, limit = 200;
        for (var i = 0; i < 50; i++) {
            if (state.aborted) break;
            var r = await apiThrottled(API.groups, { start: start, limit: limit }, {}, '群组列表');
            if (!errnoOk(r)) {
                throw new Error('获取群组列表失败：errno=' + (r && r.errno) + ' ' + (r && (r.errmsg || r.show_msg) || ''));
            }
            var recs = Array.isArray(r.records) ? r.records
                : (r.records && r.records.list) || (r.list) || [];
            out = out.concat(recs);
            var total = num(r.count || (r.records && r.records.count));
            if (recs.length < limit || (total && out.length >= total)) break;
            start += limit;
        }
        // 去重 + 规范化。注意：不按名称形态过滤——短名（如 AB、DX）也可能是真实群，
        // 误删正是“漏掉个别群”的根因。只丢弃空名 / 纯数字 / 纯符号这类明显垃圾。
        var map = new Map();
        out.forEach(function (g) {
            if (!g) return;
            var gid = str(g.gid || g.group_id || g.id);
            if (!gid) return;
            // 显示名优先用群名本身（接口字段实测为 name）；group_name/remark/uname 仅作兜底
            var name = str(g.name || g.group_name || g.remark || g.uname || ('群组 ' + gid));
            if (!name) return;
            if (/^\d+$/.test(name)) return;                                 // 纯数字（gid 残留等）丢弃
            if (!/[0-9a-zA-Z一-鿿]/.test(name)) return;   // 既无字母/数字也无汉字 → 纯符号垃圾丢弃（保留中文群名）
            if (map.has(gid)) {
                var ex = map.get(gid);
                if (!ex.name || ex.name.indexOf('群组 ') === 0) ex.name = name; // 用更可读的名字补全
                return;
            }
            map.set(gid, {
                gid: gid,
                name: name,
                uk: str(g.uk || g.owner_uk || ''),
                uname: str(g.uname || g.owner_name || ''),
                count: num(g.count || g.file_count || g.member_count)
            });
        });
        return Array.from(map.values());
    }

    // 真机实测（2026-11-08）：/mbox/group/listshare 完全忽略 page / start 参数 ——
    // 传 page=2 或 start=100 返回的仍是第一页。唯一有效的翻页游标是响应顶层的
    // last_msg_time：把上一页返回的 last_msg_time 作为下一页的 last_msg_time 传入，
    // 才会拿到更早的 100 条消息。旧版用 page/start 翻页，第二页内容重复即被判「无新数据」
    // 而提前结束，导致「读取目录结构」只读到第一页（交流互助群实测至少 6 页且 has_more=1）。
    async function fetchListShare(gid) {
        var msgs = [], seenMsg = new Set(), cursor = '', prevFirst = '';
        var baseMsgs = state.structureMsgs; // 多群时累加；每页实时回写，界面计数才会动
        var maxP = Math.max(1, Math.floor(num(state.cfg.listShareMaxPages) || 20));
        // 结构与消息计数由 readStructure 统一清零，这里累加以支持「一次勾选多个群」
        for (var page = 1; page <= maxP; page++) {
            if (state.aborted) { state.structureIncomplete = true; break; }
            var extra = { gid: gid, type: 2, limit: state.cfg.pageSize, desc: 1, page: page };
            if (cursor) extra.last_msg_time = cursor;
            else if (page > 1) extra.start = (page - 1) * state.cfg.pageSize; // 兼容旧版服务端
            var r;
            try {
                r = await apiThrottled(API.listshare, extra, { method: state.methodListshare }, '群分享列表');
            } catch (e) { state.structureIncomplete = true; throw e; }
            if (!errnoOk(r)) {
                state.errors.push({ where: 'listshare gid=' + gid, msg: 'errno=' + (r && r.errno) + ' ' + (r && r.errmsg || '') });
                state.structureIncomplete = true;
                break;
            }
            var list = pickList(r);
            var fresh = 0;
            list.forEach(function (m) {
                var mid = str(m.msg_id || m.id);
                if (!mid || seenMsg.has(mid)) return;
                seenMsg.add(mid); msgs.push(m); fresh++;
            });
            state.structurePages++;
            state.structureMsgs = baseMsgs + msgs.length;
            var first = list.length ? str(list[0].msg_id || list[0].id) : '';
            log('读取分享消息 ' + page + '/' + maxP + ' 页：本页 ' + list.length + ' 条、新增 ' + fresh +
                ' 条，累计 ' + msgs.length + ' 条' + (cursor ? '（游标 ' + cursor + '）' : ''), 'info');
            var more = rawHasMore(r);
            // 接口未返回 has_more 时，按「满页」推断
            if (more === undefined) more = fresh > 0 && (list.length >= 50 || list.length >= state.cfg.pageSize);
            if (!list.length || fresh === 0 || !more) {
                // 旧版正是栽在这里：第二页返回第一页的内容，fresh=0 就静默收尾，
                // 用户完全看不出「只读了一页」。只要 has_more 仍为 1，就必须告警。
                if (more && (!list.length || fresh === 0)) {
                    state.structureIncomplete = true;
                    log('⚠ 第 ' + page + ' 页没有新增消息，但接口仍返回 has_more=1（多半是服务端忽略了翻页游标）；' +
                        '已停止翻页，已读 ' + msgs.length + ' 条消息，后面的内容可能缺失。', 'warn');
                }
                break;
            }
            if (first && first === prevFirst) {
                log('⚠ 第 ' + page + ' 页与上一页首条消息相同，游标未推进，已停止翻页（避免死循环）', 'warn');
                state.structureIncomplete = true;
                break;
            }
            prevFirst = first;
            var nextCursor = str(r.last_msg_time || (r.records && r.records.last_msg_time) ||
                (r.records && (r.records.cursor || r.records.next_cursor)) || r.cursor || '');
            if (!nextCursor || nextCursor === cursor) {
                log('⚠ 接口未返回可用的 last_msg_time 游标，无法继续翻页；已读 ' + msgs.length +
                    ' 条消息，后面可能还有内容', 'warn');
                state.structureIncomplete = true;
                break;
            }
            cursor = nextCursor;
            if (page === maxP && more) {
                state.structureIncomplete = true;
                log('⚠ 已达到「读取结构最大页数 ' + maxP + '」，接口仍返回 has_more=1，后面的消息尚未读取；' +
                    '若目录没出现，请调大「2. 扫描设置 → 读取结构最大页数」后重新读取。', 'warn');
            }
        }
        return msgs;
    }

    async function fetchShareInfo(ctx, fsId) {
        var out = [], prevHash = '', seen = new Set(), hitCap = false, pagesRead = 0;
        for (var page = 1; page <= state.cfg.maxPages; page++) {
            if (state.aborted) break;
            var extra = {
                msg_id: ctx.msgId,
                from_uk: ctx.fromUk,
                gid: ctx.gid,
                type: 2,
                fs_id: fsId,
                page: page,
                num: state.cfg.pageSize,
                limit: state.cfg.pageSize,
                desc: 1
            };
            var r;
            try {
                r = await apiThrottled(API.shareinfo, extra, { method: state.methodShareinfo }, '目录 ' + fsId);
                pagesRead++;
            } catch (e) { throw e; }
            if (!errnoOk(r)) {
                state.errors.push({ where: 'shareinfo fs_id=' + fsId, msg: 'errno=' + (r && r.errno) + ' ' + (r && r.errmsg || '') });
                break;
            }
            var list = pickList(r);
            if (list.length === 0) break;
            var hash = list.map(function (x) { return str(x.fs_id); }).join(',');
            var fresh = 0;
            // 跨页去重：以 fs_id 为准，避免分页边界重叠时同一文件被计两次
            list.forEach(function (x) {
                var id = str(x.fs_id);
                if (id && seen.has(id)) return;
                if (id) seen.add(id);
                out.push(x); fresh++;
            });
            var more = rawHasMore(r);
            if (more === undefined) more = fresh > 0 && (list.length >= 50 || list.length >= state.cfg.pageSize);
            if (page === state.cfg.maxPages && more) hitCap = true;
            if (!more || fresh === 0 || hash === prevHash) break;
            prevHash = hash;
        }
        if (hitCap) {
            if (state.truncated) state.truncated.pages++;
            log('⚠ 目录 fs_id=' + fsId + ' 翻页达到「最大翻页 ' + state.cfg.maxPages +
                '」上限仍未结束，结果可能不完整；请调大「最大翻页」后重扫。', 'warn');
        }
        return { items: out, pages: pagesRead, cap: hitCap };
    }

    function pushDirJob(ctx, rec) {
        if (!rec.isDir || !rec.fsId) return;
        if (rec.depth >= state.cfg.maxDepth) {
            if (state.truncated) state.truncated.depth++;
            return;
        }
        state.queue.push({ ctx: ctx, fsId: rec.fsId, path: rec.path, depth: rec.depth });
    }

    // 收集顶层目录（供用户在第二阶段勾选）。顶层文件（非目录）始终直接加入结果，不进入选择清单。
    // 顶层目录必须始终列出（否则 maxDepth 填小时用户会一个目录都选不了）；深度限制只作用于递归。
    function collectTopDir(ctx, rec) {
        if (!rec.isDir || !rec.fsId) return;
        var cid = 'd' + (state.topDirSeq++);
        state.topDirs.push({
            cid: cid,
            ctx: ctx,
            fsId: rec.fsId,
            path: rec.path,
            name: rec.name,
            groupName: rec.groupName,
            gid: rec.gid
        });
        state.selectedDirs.add(cid); // 默认全选
    }

    async function scanGroupListShare(group) {
        log('开始读取群组「' + group.name + '」的分享列表');
        var msgs = await fetchListShare(group.gid);
        log('群组「' + group.name + '」共 ' + msgs.length + ' 条分享消息');
        for (var i = 0; i < msgs.length; i++) {
            if (state.aborted) break;
            var m = msgs[i];
            var ctx = {
                gid: group.gid,
                groupName: group.name,
                msgId: str(m.msg_id || m.id || ''),
                fromUk: str(m.uk !== undefined ? m.uk : (m.from_uk || m.fromUk || group.uk || '')),
                uname: str(m.uname || m.from_uname || m.nick_name || '')
            };
            if (!ctx.msgId) continue;
            var files = pickMsgFiles(m);
            for (var j = 0; j < files.length; j++) {
                var rec = normalizeItem(files[j], ctx, '', 1);
                state.topItems.push(rec);          // 暂存，扫描时才并入结果（不污染 3/4）
                collectTopDir(ctx, rec);           // 顶层目录入「选择导出目录」清单（仅目录）
                renderProgressThrottled();
            }
        }
    }

    // 连通性探针：优先用已抓到的目录测试；若无扫描结果，则直接重放页面真实抓到的 shareinfo 请求
    async function probeShareInfo() {
        var dir = null;
        for (var i = 0; i < state.records.length; i++) {
            var r = state.records[i];
            if (r.isDir && r.fsId) { dir = r; break; }
        }
        if (dir) {
            var ctx = { msgId: dir.msgId, fromUk: dir.fromUk, gid: dir.gid, groupName: dir.groupName, uname: dir.shareUname };
            log('探针：对目录「' + dir.path + '」(fs_id=' + dir.fsId + ') 发起 shareinfo 探测…');
            var t0 = Date.now();
            try {
                var list = (await fetchShareInfo(ctx, dir.fsId)).items;
                log('探针成功 ✓ 用时 ' + (Date.now() - t0) + 'ms，返回 ' + list.length + ' 条子项', 'info');
                if (list.length) log('  首条示例：' + JSON.stringify({ fs_id: list[0].fs_id, name: list[0].server_filename, isdir: list[0].isdir }).slice(0, 200));
            } catch (e) {
                log('探针失败 ✗ 用时 ' + (Date.now() - t0) + 'ms：' + e.message, 'error');
                log('  复制下方「诊断信息」粘贴反馈，便于定位接口/参数问题', 'warn');
            }
            return;
        }
        // 没有扫描结果：尝试直接重放页面真实抓到的 shareinfo 请求
        var raw = state.cap.rawUrls && state.cap.rawUrls[API.shareinfo];
        if (!raw) {
            log('探针无可用目标：请任选其一 —— ①先点「① 读取目录结构」拿到顶层目录；②在群文件页点开任意子文件夹，让脚本嗅探到真实请求后再点此按钮', 'warn');
            return;
        }
        log('探针：重放页面真实抓到的 shareinfo 请求（无需先扫描）…');
        log('  URL = ' + raw.replace(location.origin, ''));
        var t1 = Date.now();
        try {
            var resp = await window.fetch(raw, { method: 'GET', credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/plain, */*' } });
            var txt = await resp.text();
            var j;
            try { j = JSON.parse(txt); } catch (e) { throw new Error('响应非 JSON（登录失效/风控？）: ' + txt.slice(0, 160)); }
            var list2 = j && (j.list || (j.records && (j.records.list || j.records.msg_list)) || j.msg_list || (j.data && j.data.list));
            var n = (list2 && list2.length) || 0;
            log('探针成功 ✓ 用时 ' + (Date.now() - t1) + 'ms，errno=' + j.errno + '，子项=' + n, n ? 'info' : 'warn');
            log('  顶层字段=' + JSON.stringify(Object.keys(j).slice(0, 20)) + (n ? ' 首条字段=' + JSON.stringify(Object.keys(list2[0]).slice(0, 24)) : ' 响应体=' + txt.slice(0, 240)));
        } catch (e) {
            log('探针失败 ✗ 用时 ' + (Date.now() - t1) + 'ms：' + e.message, 'error');
            log('  把这条日志和「诊断信息」一起反馈', 'warn');
        }
    }

    async function walkDir(job) {
        state.scannedDirs++;
        if (state.scannedFsIds) state.scannedFsIds.add(str(job.fsId));
        log('扫描目录 (' + state.scannedDirs + ') ' + job.path);
        var t0 = Date.now();
        var children, meta = { items: [], pages: 0, cap: false };
        try { meta = await fetchShareInfo(job.ctx, job.fsId); children = meta.items; }
        catch (e) {
            state.errors.push({ where: job.path, msg: e.message });
            // walkDir 在这里吞掉异常并 return（不会传到 worker 的 catch），
            // 所以必须就地记账：本轮不重试，但写入断点让「继续上次扫描」重试这一层。
            ledgerPush({ path: job.path, fsId: str(job.fsId), pages: 0, items: 0, added: 0,
                files: 0, dirs: 0, ms: Date.now() - t0, status: '失败', cap: false, note: e.message });
            if (state.failedJobs) state.failedJobs.push(job);
            state.dirFailStreak++;
            if (state.dirFailStreak >= 3 && !state.shareinfoBroken) {
                state.shareinfoBroken = true;
                log('⚠ 连续 ' + state.dirFailStreak + ' 个子目录请求失败，判定「子目录接口不可用」，已停止遍历子目录以节省时间。' +
                    '顶层文件已保留，请点「测试子目录接口」诊断并修复后再扫。', 'warn');
            }
            return;
        }
        state.dirFailStreak = 0; // 成功一次即清零连败计数
        var addedN = 0, filesN = 0, dirsN = 0;
        for (var i = 0; i < children.length; i++) {
            if (state.aborted) break;
            var rec = normalizeItem(children[i], job.ctx, job.path, job.depth + 1);
            var added = addRecord(rec);
            if (added) {
                addedN++;
                if (added.isDir) dirsN++; else filesN++;
                pushDirJob(job.ctx, added);
            }
            renderProgressThrottled();
        }
        ledgerPush({ path: job.path, fsId: str(job.fsId), pages: meta.pages,
            items: children.length, added: addedN, files: filesN, dirs: dirsN,
            ms: Date.now() - t0, status: meta.cap ? '触顶翻页' : '完成',
            cap: !!meta.cap, note: '' });
    }

    // 点击页面左侧导航项进入某群，等待脚本识别出新群 gid（最多约 3 秒）
    function navigateToGroup(group) {
        return new Promise(function (resolve) {
            try {
                var before = state.cap.currentGid || state.cap.activeGid;
                var elx = group.el;
                if (elx && elx.click) elx.click();
                else if (elx && elx.dispatchEvent) { try { elx.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch (e) { elx.dispatchEvent(new Event('click', { bubbles: true })); } }
                var tries = 0;
                var timer = setInterval(function () {
                    tries++;
                    var now = state.cap.currentGid || state.cap.activeGid;
                    if (now && now !== before) {
                        clearInterval(timer);
                        resolve({ gid: now, name: groupNameById(now) || group.name, uk: state.cap.common.uk || '', uname: state.cap.common.uname || '' });
                    } else if (tries >= 30) { clearInterval(timer); resolve(null); }
                }, 100);
            } catch (e) { resolve(null); }
        });
    }

    // 第一步：读取目录结构（轻量，只抓顶层，不递归）。
    // 抓完后在「选择导出目录」列出各顶层目录供用户勾选，等待用户点「开始扫描（边扫边写）」。
    async function readStructure() {
        if (state.running) { log('请等待当前任务结束', 'warn'); return; }
        state.running = true; state.paused = false; state.aborted = false;
        // 注意：读取目录结构只重建「选择导出目录」清单，绝不清空下方结果数据
        state.topItems = [];
        state.topDirs = []; state.topDirSeq = 0; state.selectedDirs = new Set();
        state.structureRead = false; state.structureIncomplete = false;
        state.structureError = ''; state.structurePages = 0; state.structureMsgs = 0;
        state.phase = 'select';
        state.shareinfoBroken = false; state.dirFailStreak = 0;
        state.reqCount = 0; state.scannedDirs = 0; state.startedAt = Date.now();
        state.errors = [];
        setButtons();
        renderTopDirs();      // 立刻显示「正在读取…」，让按钮点击有即时反馈
        renderProgress(true);
        startHeartbeat();
        // 整个函数体统一包进 try/finally：旧版把「未选择目标群」的 throw 放在 try 之外，
        // 异常逃出 async 函数后 finally 不执行，state.running 会永久卡在 true，
        // 表现就是「点了按钮完全没反应、之后所有按钮都是灰的」。
        try {
            var manualGid = ((el.gidInput && el.gidInput.value) || '').trim();
            var selectedGroups = state.groups.filter(function (g) { return state.selected.has(g.gid || ('side:' + g.name)); });
            var targets = [];
            var needNav = [];
            if (manualGid) {
                targets.push({ gid: manualGid, name: groupNameById(manualGid) || state.cap.activeView || '', uk: state.cap.common.uk || '', uname: state.cap.common.uname || '' });
            } else if (selectedGroups.length) {
                selectedGroups.forEach(function (g) {
                    if (g.gid) targets.push(g);
                    else if (g.el) needNav.push(g);
                    else log('群「' + g.name + '」缺少 gid 且无法定位，已跳过（可手动填 gid）', 'warn');
                });
            } else {
                var curGid = state.cap.currentGid || state.cap.activeGid;
                if (curGid) targets.push({ gid: curGid, name: groupNameById(curGid) || state.cap.activeView || '', uk: state.cap.common.uk || '', uname: state.cap.common.uname || '' });
            }
            // 处理仅从左侧读到的、暂无 gid 的群：点击左侧导航进入该群，等待页面识别 gid
            if (needNav.length) {
                log('正在从左侧导航进入 ' + needNav.length + ' 个群以读取其 gid…', 'info');
                for (var ni = 0; ni < needNav.length; ni++) {
                    var navG = needNav[ni];
                    try {
                        var ng = await navigateToGroup(navG);
                        if (ng) { targets.push(ng); log('已进入群「' + ng.name + '」(' + ng.gid + ')', 'info'); }
                        else log('无法进入群「' + navG.name + '」，已跳过（可手动填 gid）', 'warn');
                    } catch (e) { log('进入群「' + navG.name + '」失败：' + e.message, 'warn'); }
                }
            }
            if (!targets.length) {
                state.structureError = '⚠ <b>未选择目标群</b>：请在「1. 选择群组」勾选要导出的群，' +
                    '或先在百度网盘左侧点开目标群让脚本识别当前群，或在「3. 选择导出目录」手动填写群 gid。' +
                    '<br/>（刷新页面后勾选状态会重置，需重新勾选一次。）';
                log('⚠ 未选择目标群：请在「1. 选择群组」勾选要导出的群，或先在百度网盘左侧进入目标群（脚本自动识别），或在「3. 选择导出目录」手动填写群 gid。刷新页面后勾选状态会重置。', 'warn');
                return;
            }
            // 确保这些群都在 state.groups 中（供名称匹配 / 展示 / 导出）
            targets.forEach(function (t) {
                if (!state.groups.some(function (g) { return g.gid === t.gid; })) {
                    state.groups = state.groups.concat([t]); saveGroups();
                }
            });
            log('=== 读取目录结构，目标群：' + targets.map(function (t) { return (t.name ? t.name + ' (' + t.gid + ')' : t.gid); }).join('；') + ' ===');
            if (state.groups.length === 0) {
                try { state.groups = await fetchGroups(); saveGroups(); } catch (e) { /* 静默，DOM 检测仍可工作 */ }
            }
            for (var i = 0; i < targets.length; i++) {
                if (state.aborted) break;
                try { await scanGroupListShare(targets[i]); }
                catch (e) {
                    state.errors.push({ where: targets[i].name, msg: e.message });
                    log('群组「' + targets[i].name + '」读取失败：' + e.message, 'error');
                }
            }
            if (state.aborted) state.structureIncomplete = true;
            if (state.topDirs.length === 0) {
                if (state.topItems.length === 0) {
                    log('⚠ 未抓到任何顶层条目：请确认已在「通讯录 / 群组 / 群文件」页面、且群组勾选正确。', 'warn');
                } else {
                    log('ℹ 读取完成：这个群的文件库里没有可展开的共享文件夹，只有 ' + state.topItems.length +
                        ' 个直接分享的文件（来自 ' + state.structureMsgs + ' 条分享消息 / ' + state.structurePages +
                        ' 页）。无需勾选目录，直接点「② 开始扫描（边扫边写）」即可导出这些文件；' +
                        '想选共享文件夹请改勾「1. 选择群组」里的其它群。', 'info');
                }
            } else {
                log('✓ 目录结构读取完成：' + state.topDirs.length + ' 个共享目录，另有 ' +
                    (state.topItems.length - state.topDirs.length) + ' 个顶层直接文件（勾选目录时不会导出）；' +
                    '共读 ' + state.structureMsgs + ' 条分享消息 / ' + state.structurePages +
                    ' 页。请在「选择导出目录」勾选后点「② 开始扫描（边扫边写）」。', 'info');
            }
            if (state.structureIncomplete) {
                log('⚠ 分享消息可能没读完（触顶 / 游标丢失 / 手动停止），后面的消息里可能还有共享目录；' +
                    '可调大「2. 扫描设置 → 读取结构最大页数」后重新读取。', 'warn');
            }
        } catch (e) {
            var emsg = String((e && e.message) || e);
            state.structureError = '⚠ <b>读取失败</b>：' + esc(emsg) + '。详细原因见「6. 日志」。';
            log('读取失败：' + emsg, 'error');
            state.errors.push({ where: '读取结构', msg: emsg });
        } finally {
            state.running = false; state.paused = false;
            state.structureRead = true;
            stopHeartbeat();
            setButtons(); renderStatus(); renderProgress(true); renderTopDirs(); focusTopDirsSection();
        }
    }

    /* ---------- 断点续抓：进度快照 ----------
     * v1.1.1：明细改成「列式 + 字典」压缩，主存转 IndexedDB。
     *   - 每条记录 18 个字段名，光 key 名就占约 40% 体积；改成定长数组后省一半。
     *   - 同一目录里 groupName/gid/msgId/fromUk/shareUname 完全相同，抽成 ctx 字典只存下标。
     *   - seen 可从 records 重建（gid|fsId|path），不再重复存一整份路径清单。
     *   - localStorage 单域约 5MB（UTF-16 约 260 万字符），上万条明细必然溢出；
     *     超过安全阈值时 localStorage 只留摘要，完整数据进 IndexedDB（容量按磁盘配额算）。
     * 快照不含任何 bdstoken / Cookie / sign：恢复后参数由页面自身的请求嗅探重新提供。 */
    var SNAP_LOCAL_LIMIT = 2000000;   // 字符数，低于浏览器 5MB 配额并留出余量
    // 百万级明细会撑爆渲染进程：全量快照的 JSON 可达数百 MB，导出又要复制好几份。
    // 护栏 = 把单次任务规模卡住 + 快照降频加背压 + 导出分片，不让峰值无界增长。
    var MEM_GUARD = 250000;           // 内存护栏：单次扫描在内存里最多保留的明细条数
    var SNAP_MIN_MS = 30000, SNAP_MIN_DIRS = 40;
    var SNAP_MAX_RECORDS = 300000, SNAP_MAX_CHARS = 60000000;
    var IDB_NAME = 'bpgEx_snapshots', IDB_STORE = 'snap', IDB_KEY = 'current';
    var lastSnapAt = 0, lastSnapDirs = 0, warnedBig = false;
    var snapBusy = false, memGuardHit = false;
    var idbPromise = null;

    // 打开（或升级）被别的标签页阻塞时，Chrome 可能连 onblocked 都不触发，
    // open() 永远 pending；必须有超时兜底，否则「继续上次扫描」「导出报告」会点了没反应。
    function openIDBWith(name, ver, stores, ms) {
        return new Promise(function (resolve) {
            var factory = (typeof indexedDB !== 'undefined') ? indexedDB : null;
            if (!factory) { resolve(null); return; }
            var done = false;
            var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, ms || 1500);
            function ok(v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } }
            try {
                // ver 为空时不指定版本：库不存在则以 v1 新建并触发 onupgradeneeded 建 store，
                // 库已存在则用其当前版本打开。绝不显式升版本——旧标签页持有的连接会阻塞
                // versionchange，导致后续所有 open()（连无版本 open）永久排队。
                var req = ver ? factory.open(name, ver) : factory.open(name);
                req.onupgradeneeded = function () {
                    var db = req.result;
                    (stores || []).forEach(function (n) {
                        if (!db.objectStoreNames.contains(n)) db.createObjectStore(n);
                    });
                };
                req.onsuccess = function () { ok(req.result); };
                req.onerror = req.onblocked = function () { ok(null); };
            } catch (e) { ok(null); }
        });
    }
    function openIDB() {
        if (!idbPromise) idbPromise = openIDBWith(IDB_NAME, null, [IDB_STORE], 1500);
        return idbPromise;
    }
    var runIdbPromise = null;
    function openRunIDB() {
        if (!runIdbPromise) runIdbPromise = openIDBWith(RUN_DB, null, [RUN_STORE], 1200);
        return runIdbPromise;
    }
    function idbPut(payload) {
        return openIDB().then(function (db) {
            if (!db) return false;
            return new Promise(function (resolve) {
                try {
                    var tx = db.transaction(IDB_STORE, 'readwrite');
                    tx.objectStore(IDB_STORE).put(payload, IDB_KEY);
                    tx.oncomplete = function () { resolve(true); };
                    tx.onerror = tx.onabort = function () { resolve(false); };
                } catch (e) { resolve(false); }
            });
        });
    }
    function idbGet() {
        return openIDB().then(function (db) {
            if (!db) return null;
            return new Promise(function (resolve) {
                try {
                    var tx = db.transaction(IDB_STORE, 'readonly');
                    var r = tx.objectStore(IDB_STORE).get(IDB_KEY);
                    r.onsuccess = function () { resolve(r.result || null); };
                    r.onerror = function () { resolve(null); };
                } catch (e) { resolve(null); }
            });
        });
    }
    function idbClear() {
        openIDB().then(function (db) {
            if (!db) return;
            try { db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).delete(IDB_KEY); } catch (e) { }
        });
    }


    /* ============================================================
     * 扫描台账：一次扫描 = 一条可长期留存的记录，用于事后核对「导出少了哪些」
     * ---------------------------------------------------------------
     * 摘要（几百字符）写 localStorage，列表同步可读；完整台账（目录级统计 +
     * 事件日志 + 导出记录 + 错误明细）写 IndexedDB，不受 5MB 配额限制。
     * IndexedDB 不可用时降级到 localStorage，只留最近 2 份完整台账。
     * 台账只记录数量、路径、错误码与参数档位：绝不写 bdstoken / Cookie / URL 模板。
     * ============================================================ */
    var RUN_FULL_PREFIX = 'bpgEx.runfull.';

    function currentGroupLabel() {
        var gid = state.cap.currentGid || state.cap.activeGid || '';
        var names = [];
        state.records.slice(0, 300).forEach(function (r) {
            var n = str(r.groupName).trim();
            if (n && names.indexOf(n) < 0) names.push(n);
        });
        if (!names.length && gid) names.push(groupNameById(gid) || ('群组 ' + gid.slice(0, 8)));
        return names.join('、').slice(0, 120) || '未识别';
    }
    function pickedDirNames() {
        return (state.topDirs || []).filter(function (d) { return state.selectedDirs.has(d.cid); })
            .map(function (d) { return str(d.name); }).slice(0, 200);
    }
    function makeRun(snapRun) {
        return {
            id: (snapRun && snapRun.id) || ('R' + Date.now() + Math.random().toString(36).slice(2, 6)),
            version: VERSION,
            startedAt: (snapRun && num(snapRun.startedAt)) || Date.now(),
            endedAt: 0,
            group: (snapRun && snapRun.group) || currentGroupLabel(),
            gid: state.cap.currentGid || state.cap.activeGid || '',
            dirs: (snapRun && snapRun.dirs) || pickedDirNames(),
            base: (snapRun && snapRun.base) || '',
            speed: speedLabel(), concurrency: workerCount(),
            cfg: {
                pageSize: state.cfg.pageSize, maxPages: state.cfg.maxPages,
                maxDepth: state.cfg.maxDepth, delay: state.cfg.delay,
                minInterval: state.cfg.minInterval, includeDirs: !!state.cfg.includeDirs
            },
            resumed: (snapRun && num(snapRun.resumed)) || 0,
            status: 'running',
            dirLedger: (snapRun && snapRun.dirLedger) || [],
            events: (snapRun && snapRun.events) || [],
            exports: (snapRun && snapRun.exports) || [],
            issues: [], errorsDetail: [], stats: null, note: ''
        };
    }
    function ledgerPush(e) {
        if (!state.run) return;
        e.at = Date.now();
        state.run.dirLedger.push(e);
    }
    function runSummary(r) {
        return {
            id: r.id, start: r.startedAt, end: r.endedAt, version: r.version,
            group: r.group || currentGroupLabel(), dirs: (r.dirs || []).slice(0, 4),
            dirCount: (r.dirs || []).length, base: r.base, status: r.status,
            records: r.stats ? r.stats.records : state.records.length,
            files: r.stats ? r.stats.files : state.stats.files,
            bytes: r.stats ? r.stats.bytes : state.stats.bytes,
            scannedDirs: r.stats ? r.stats.scannedDirs : state.scannedDirs,
            reqs: r.stats ? r.stats.reqCount : state.reqCount,
            errors: r.stats ? r.stats.errors : state.errors.length,
            sec: r.endedAt ? Math.round((r.endedAt - r.startedAt) / 1000) : 0,
            ok: r.status === 'done' && !(r.issues || []).length,
            issues: (r.issues || []).slice(0, 4),
            exports: (r.exports || []).length,
            ledger: (r.dirLedger || []).length,
            events: (r.events || []).length,
            resumed: r.resumed || 0
        };
    }
    function loadRuns() {
        try {
            var a = JSON.parse(localStorage.getItem(RUN_KEY) || '[]');
            return Array.isArray(a) ? a : [];
        } catch (e) { return []; }
    }
    function idbPutKey(store, key, val) {
        return openRunIDB().then(function (db) {
            if (!db) return false;
            return new Promise(function (resolve) {
                try {
                    var tx = db.transaction(store, 'readwrite');
                    tx.objectStore(store).put(val, key);
                    tx.oncomplete = function () { resolve(true); };
                    tx.onerror = tx.onabort = function () { resolve(false); };
                } catch (e) { resolve(false); }
            });
        });
    }
    function idbGetKey(store, key) {
        return openRunIDB().then(function (db) {
            if (!db) return null;
            return new Promise(function (resolve) {
                try {
                    var r = db.transaction(store, 'readonly').objectStore(store).get(key);
                    r.onsuccess = function () { resolve(r.result || null); };
                    r.onerror = function () { resolve(null); };
                } catch (e) { resolve(null); }
            });
        });
    }
    function idbDelKey(store, key) {
        openRunIDB().then(function (db) {
            if (!db) return;
            try { db.transaction(store, 'readwrite').objectStore(store).delete(key); } catch (e) { }
        });
    }
    function storeRunFull(r) {
        var txt;
        try { txt = JSON.stringify(r); } catch (e) { return Promise.resolve(false); }
        return idbPutKey(RUN_STORE, 'run:' + r.id, txt).then(function (ok) {
            if (ok) return true;
            // 降级：本地存储只留最近 2 份完整台账
            try {
                localStorage.setItem(RUN_FULL_PREFIX + r.id, txt);
                var keys = [];
                for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i);
                    if (k && k.indexOf(RUN_FULL_PREFIX) === 0) keys.push(k);
                }
                var keep = Object.create(null);
                loadRuns().slice(0, 2).forEach(function (x) { keep[RUN_FULL_PREFIX + x.id] = 1; });
                keys.forEach(function (k) { if (!keep[k]) localStorage.removeItem(k); });
            } catch (e) { }
            return false;
        });
    }
    function loadRunFull(id) {
        // 本地降级副本先读出来兜底；IDB 快就用 IDB（可能更新），慢/被阻塞就 1.5s 后用本地副本。
        // 双保险：绝不因为另一个标签页占着数据库连接，让「查看 / 导出报告」点了没反应。
        var local = null;
        try {
            var t2 = localStorage.getItem(RUN_FULL_PREFIX + id);
            if (t2) local = JSON.parse(t2);
        } catch (e) { }
        var fromIdb = idbGetKey(RUN_STORE, 'run:' + id).then(function (txt) {
            if (!txt) return local;
            try { return JSON.parse(txt) || local; } catch (e) { return local; }
        }, function () { return local; });
        return Promise.race([
            fromIdb,
            new Promise(function (r) { setTimeout(function () { r(local); }, 1500); })
        ]);
    }
    function saveRun() {
        if (!state.run) return Promise.resolve(false);
        var sum = runSummary(state.run);
        var list = loadRuns().filter(function (x) { return x && x.id !== sum.id; });
        list.unshift(sum);
        var dropped = list.slice(RUN_MAX);
        list = list.slice(0, RUN_MAX);
        try { localStorage.setItem(RUN_KEY, JSON.stringify(list)); } catch (e) { }
        dropped.forEach(function (x) {
            idbDelKey(RUN_STORE, 'run:' + x.id);
            try { localStorage.removeItem(RUN_FULL_PREFIX + x.id); } catch (e) { }
        });
        return storeRunFull(state.run);
    }
    function finishRun(reasons) {
        if (!state.run) return Promise.resolve(false);
        var r = state.run;
        r.endedAt = Date.now();
        r.status = reasons && reasons.length ? 'incomplete' : 'done';
        r.issues = (reasons || []).slice();
        r.errorsDetail = (state.errors || []).slice(0, 200);
        r.stats = {
            records: state.records.length, files: state.stats.files, dirs: state.stats.dirs,
            bytes: state.stats.bytes, scannedDirs: state.scannedDirs,
            reqCount: state.reqCount, errors: state.errors.length
        };
        try { r.base = exportBaseName(); } catch (e) { }
        if (!r.group || r.group === '未识别') r.group = currentGroupLabel();
        r.note = r.status === 'done'
            ? '队列已清空、无请求错误、无参数截断；完整性自检未发现不完整迹象。'
            : '结果不完整，详见「完整性结论与异常」；可用恢复横幅续抓。';
        return saveRun();
    }
    function recordExport(kind, rows, base, filename) {
        if (!state.run) return;
        var scoped = state.phase === 'done' && state.selectedDirs && state.selectedDirs.size > 0;
        var scopeN = 0, dirN = 0;
        state.records.forEach(function (r) {
            if (scoped && r.depth <= 1) { scopeN++; return; }
            if (!state.cfg.includeDirs && r.isDir) dirN++;
        });
        state.run.exports.push({
            at: Date.now(), kind: kind, file: filename || (base + '_' + kind), rows: rows.length,
            all: state.records.length, scopeExcluded: scopeN, dirExcluded: dirN,
            expected: state.records.length - scopeN - dirN
        });
        saveRun();
    }

    /* ---------- 核对报告 CSV ----------
     * 一个文件分 5 段：任务摘要 / 核对要点 / 目录台账 / 导出记录 / 完整性结论 / 事件日志。
     * 「核对要点」专门解释「扫描 N 条、导出 M 条」的差值来源，避免把导出范围过滤误判成漏抓。 */
    function buildRunReport(full, sum) {
        var r = full || {
            id: sum.id, version: sum.version, startedAt: sum.start, endedAt: sum.end,
            group: sum.group, gid: '', dirs: sum.dirs || [], base: sum.base, status: sum.status,
            speed: '', concurrency: 0, cfg: {}, resumed: sum.resumed,
            dirLedger: [], events: [], exports: [], issues: sum.issues || [],
            errorsDetail: [], stats: {
                records: num(sum.records), files: num(sum.files), dirs: 0, bytes: num(sum.bytes),
                scannedDirs: num(sum.scannedDirs), reqCount: num(sum.reqs), errors: num(sum.errors)
            }, note: ''
        };
        var st = r.stats || {}, L = [];
        function row() { L.push([].slice.call(arguments).map(csvCell).join(',')); }
        function blank() { L.push(''); }
        row('【扫描核对报告】区段', '字段', '值', '说明');
        row('任务摘要', '任务ID', r.id, '断点续抓沿用同一任务ID');
        row('任务摘要', '脚本版本', r.version);
        row('任务摘要', '开始时间', fmtTime(r.startedAt));
        row('任务摘要', '结束时间', r.endedAt ? fmtTime(r.endedAt) : '未结束');
        row('任务摘要', '耗时(秒)', r.endedAt ? Math.round((r.endedAt - r.startedAt) / 1000) : '');
        row('任务摘要', '任务状态', r.status === 'done' ? '完成' : r.status === 'running' ? '进行中/中断' : '未完成');
        row('任务摘要', '群名称', r.group, '导出范围由勾选的目录决定');
        row('任务摘要', '群ID', r.gid);
        row('任务摘要', '勾选目录', (r.dirs || []).join('、'), '共 ' + (r.dirs || []).length + ' 个');
        row('任务摘要', '速度档位', r.speed, '并发 ' + r.concurrency + ' 路');
        row('任务摘要', '单页条数', num(r.cfg.pageSize));
        row('任务摘要', '最大翻页', num(r.cfg.maxPages));
        row('任务摘要', '最大深度', num(r.cfg.maxDepth));
        row('任务摘要', '请求间隔(ms)', num(r.cfg.delay), '全局最小间隔 ' + num(r.cfg.minInterval) + 'ms');
        row('任务摘要', '导出含文件夹行', r.cfg.includeDirs ? '是' : '否', '关闭时 CSV 不含文件夹行');
        row('任务摘要', '断点续抓次数', num(r.resumed));
        row('任务摘要', '扫描总记录', num(st.records), '含文件夹行与根目录条目');
        row('任务摘要', '文件数', num(st.files));
        row('任务摘要', '目录行数', num(st.dirs));
        row('任务摘要', '总字节', num(st.bytes), fmtSize(st.bytes));
        row('任务摘要', '已展开目录', num(st.scannedDirs));
        row('任务摘要', '接口请求数', num(st.reqCount));
        row('任务摘要', '请求错误数', num(st.errors));
        row('任务摘要', '目录台账行数', (r.dirLedger || []).length);
        row('任务摘要', '事件日志行数', (r.events || []).length);
        row('任务摘要', '导出次数', (r.exports || []).length);
        row('任务摘要', '结论', r.note || '');
        blank();
        row('【核对要点】', '指标', '数值', '说明');
        row('核对', '扫描总记录', num(st.records), '脚本内存里的全部记录');
        (r.exports || []).length ? (r.exports || []).forEach(function (e, i) {
            row('核对', '第 ' + (i + 1) + ' 次导出行数', num(e.rows),
                '扫描 ' + num(e.all) + ' 条 − 根目录范围排除 ' + num(e.scopeExcluded) +
                ' − 文件夹行排除 ' + num(e.dirExcluded) + ' = 预期 ' + num(e.expected));
        }) : row('核对', '导出行数', '无导出记录', '本任务没有导出过明细');
        row('核对', '差值来源1', '勾选目录时排除 depth<=1 的根目录条目',
            '你扫描某个目录时，同级目录与顶层直接分享的文件不算导出范围');
        row('核对', '差值来源2', '「导出包含文件夹行」关闭时不计入文件夹行', '在 2. 扫描设置里');
        row('核对', '差值来源3', '明细 CSV 首行是表头', 'Excel 数行数时别把表头算进文件数');
        row('核对', '差值来源4', '以上都解释不了 → 看下面目录台账',
            '状态=失败 / 触顶翻页 的目录，内部文件可能整层缺失；再看完整性结论');
        blank();
        row('【目录台账】', '每个展开过的目录一行', '', '接口返回条数 vs 新增记录数的差值 = 跨目录重复被去重');
        row('序号', '目录路径', 'fs_id', '翻页数', '接口返回条数', '新增记录数', '文件数', '子目录数', '状态', '备注');
        (r.dirLedger || []).forEach(function (d, i) {
            row(i + 1, d.path, d.fsId, num(d.pages), num(d.items), num(d.added),
                num(d.files), num(d.dirs), d.status, d.note || (d.cap ? '触及最大翻页上限' : ''));
        });
        blank();
        row('【导出记录】');
        row('时间', '类型', '文件名', '导出行数', '扫描总记录', '范围排除', '文件夹行排除', '预期行数');
        (r.exports || []).forEach(function (e) {
            row(fmtTime(e.at), e.kind, e.file, num(e.rows), num(e.all),
                num(e.scopeExcluded), num(e.dirExcluded), num(e.expected));
        });
        blank();
        row('【完整性结论与异常】');
        row('结论', (r.issues || []).length ? '不完整' : '未发现不完整迹象',
            (r.issues || []).join('；') || r.note || '');
        (r.errorsDetail || []).forEach(function (e) { row('请求错误', e.where, e.msg); });
        blank();
        row('【事件日志】', '面板日志的完整归档（最多 8000 行）');
        row('时间', '级别', '内容');
        (r.events || []).forEach(function (e) { row(e.t, e.level, e.msg); });
        return L.join('\r\n');
    }

    function renderRuns(html) {
        var box = el.panel && el.panel.querySelector('#bpgEx-runs');
        if (!box) return;
        box.innerHTML = html;
        box.style.display = '';
    }
    function showRuns() {
        var list = loadRuns();
        if (!list.length) {
            renderRuns('<b>扫描记录</b><br/>还没有留存的任务。每次开始扫描会自动生成一条台账，' +
                '扫描结束即归档，刷新页面也不会丢。<br/>' +
                '<button class="bpgEx-btn mini" data-act="hideRuns">收起</button>');
            return;
        }
        var h = ['<b>扫描记录</b>（最近 ' + list.length + ' 条，最多保留 ' + RUN_MAX + ' 条）',
            '点「查看」看摘要，点「导出报告」得到该任务的核对 CSV。',
            '<button class="bpgEx-btn mini" data-act="hideRuns">收起</button>　' +
            '<button class="bpgEx-btn mini" data-act="clearRuns">清空记录</button>'];
        list.forEach(function (x) {
            h.push('<div style="border-top:1px solid #e2e8f0;padding:4px 0;margin-top:4px">' +
                '<b>' + esc(fmtTime(x.start)) + '</b>　' + esc(x.group || '') + '　' +
                (x.ok ? '<span class="ok">完成</span>' : '<span class="warn">' +
                    (x.status === 'running' ? '进行中/中断' : '未完成') + '</span>') +
                '　' + num(x.records) + ' 条 / ' + num(x.files) + ' 文件 / ' +
                num(x.scannedDirs) + ' 目录 / ' + num(x.sec) + 's　导出 ' + num(x.exports) + ' 次' +
                ((x.issues || []).length ? '<br/><span class="warn">异常：' + esc(x.issues.join('；')) + '</span>' : '') +
                '<br/><button class="bpgEx-btn mini" data-act="runView" data-runid="' + esc(x.id) + '">查看</button> ' +
                '<button class="bpgEx-btn mini" data-act="runReport" data-runid="' + esc(x.id) + '">导出报告</button></div>');
        });
        h.push('<div id="bpgEx-run-detail" style="margin-top:6px"></div>');
        renderRuns(h.join(''));
    }
    function viewRun(id) {
        var x = loadRuns().filter(function (a) { return a.id === id; })[0];
        if (!x) return;
        var h = ['<b>任务 ' + esc(x.id) + '</b>　' + esc(fmtTime(x.start)) + ' → ' +
            (x.end ? esc(fmtTime(x.end)) : '未结束'),
            '群：' + esc(x.group) + '　勾选目录：' + esc((x.dirs || []).join('、') || '（未勾选，仅顶层文件）') +
            (x.dirCount > 4 ? ' 等 ' + x.dirCount + ' 个' : ''),
            '结果：' + num(x.records) + ' 条 / ' + num(x.files) + ' 文件 / ' + fmtSize(x.bytes) +
            '　已展开 ' + num(x.scannedDirs) + ' 目录 / ' + num(x.reqs) + ' 请求 / ' + num(x.errors) + ' 错误',
            '目录台账 ' + num(x.ledger) + ' 行　事件日志 ' + num(x.events) + ' 行　导出 ' +
            num(x.exports) + ' 次　断点续抓 ' + num(x.resumed) + ' 次',
            x.ok ? '<span class="ok">✓ 完整性自检未发现异常</span>'
                : '<span class="warn">⚠ ' + esc((x.issues || []).join('；') || '任务未正常结束') + '</span>',
            '<b>核对提示</b>：明细行数 = 扫描记录 − 根目录范围排除 − 文件夹行排除；' +
            '对不上先看目录台账里「失败 / 触顶翻页」的目录。'];
        var d = el.panel && el.panel.querySelector('#bpgEx-run-detail');
        if (d) d.innerHTML = h.join('<br/>');
        loadRunFull(id).then(function (full) {
            if (!full) h.push('<span class="warn">详细台账不可用（浏览器清理了存储），仅剩上方摘要。</span>');
            else (full.exports || []).forEach(function (e) {
                h.push('导出：' + esc(fmtTime(e.at)) + '　' + esc(e.kind) + '　' + esc(e.file) +
                    '　' + num(e.rows) + ' 行（扫描 ' + num(e.all) + ' 条，范围排除 ' +
                    num(e.scopeExcluded) + '，文件夹行排除 ' + num(e.dirExcluded) + '）');
            });
            var d2 = el.panel && el.panel.querySelector('#bpgEx-run-detail');
            if (d2) d2.innerHTML = h.join('<br/>');
        });
    }
    function exportRunReport(id) {
        var list = loadRuns();
        var sum = id ? list.filter(function (a) { return a.id === id; })[0] : list[0];
        if (!sum && !state.run) { log('还没有可导出的扫描台账，先跑一次扫描', 'warn'); return; }
        var targetId = sum ? sum.id : state.run.id;
        Promise.resolve(loadRunFull(targetId)).then(function (full) {
            if (!full && state.run && state.run.id === targetId) full = state.run;
            var txt = buildRunReport(full, sum || runSummary(state.run));
            var base = (sum && sum.base) || (state.run && state.run.base) ||
                (currentGroupLabel() + '_' + stamp());
            var name = safeName(base + '_核对报告') + '.csv';
            download(name, '\uFEFF' + txt, 'text/csv;charset=utf-8');
            log('已导出核对报告 → ' + name + (full ? '' : '（详细日志不可用，仅含摘要）'), 'info');
        });
    }
    function clearRuns() {
        loadRuns().forEach(function (x) {
            idbDelKey(RUN_STORE, 'run:' + x.id);
            try { localStorage.removeItem(RUN_FULL_PREFIX + x.id); } catch (e) { }
        });
        try { localStorage.removeItem(RUN_KEY); } catch (e) { }
        renderRuns('<b>扫描记录已清空</b>　<button class="bpgEx-btn mini" data-act="hideRuns">收起</button>');
        log('已清空全部扫描台账');
    }

    // 列式打包：c = 共享上下文字典，r = 定长数组行
    var REC_KEYS = ['groupName', 'gid', 'msgId', 'fromUk', 'shareUname'];
    function packRecords(list) {
        var c = [], map = Object.create(null);
        var r = (list || []).map(function (rec) {
            var key = REC_KEYS.map(function (k) { return str(rec[k]); }).join('\u0001');
            var ci = map[key];
            if (ci === undefined) {
                ci = c.length; map[key] = ci;
                c.push(REC_KEYS.map(function (k) { return rec[k]; }));
            }
            return [ci, num(rec.depth), rec.isDir ? 1 : 0, str(rec.name), str(rec.path),
                    str(rec.parent), num(rec.size), str(rec.category), str(rec.md5),
                    str(rec.fsId), num(rec.ctime), num(rec.mtime), str(rec.rawPath)];
        });
        return { c: c, r: r };
    }
    function unpackRecords(packed) {
        if (!packed || !Array.isArray(packed.r)) return [];
        var c = packed.c || [];
        return packed.r.map(function (a, i) {
            var ctx = c[a[0]] || ['', '', '', '', ''];
            return {
                idx: i + 1, groupName: ctx[0], gid: ctx[1], msgId: ctx[2], fromUk: ctx[3],
                shareUname: ctx[4], depth: num(a[1]), isDir: !!a[2], name: a[3], path: a[4],
                parent: a[5], size: num(a[6]), category: a[7], md5: a[8], fsId: a[9],
                ctime: num(a[10]), mtime: num(a[11]), rawPath: a[12] || ''
            };
        });
    }
    function rebuildSeen() {
        state.seen = new Set();
        state.records.forEach(function (r) { state.seen.add(r.gid + '|' + r.fsId + '|' + r.path); });
    }

    function readSnapshot() {
        try {
            var txt = localStorage.getItem(SNAP_KEY);
            if (!txt) return null;
            var p = JSON.parse(txt);
            if (!p || p.v !== SNAP_VER || !p.savedAt) return null;
            return p;
        } catch (e) { return null; }
    }
    function clearSnapshot() {
        try { localStorage.removeItem(SNAP_KEY); } catch (e) { }
        idbClear();
        clearStreamHandle();
        lastSnapAt = 0; lastSnapDirs = 0;
        renderResumeBanner();
    }
    // 仅清快照（localStorage + 快照库），不动「流式写盘句柄」。
    // 恢复断点时若用 clearSnapshot() 会把持久化的文件句柄一起删掉，
    // 导致「继续上次扫描」取不到句柄、无法续写同一份 CSV，静默回退内存模式。
    function clearSnapshotOnly() {
        try { localStorage.removeItem(SNAP_KEY); } catch (e) { }
        idbClear();
        lastSnapAt = 0; lastSnapDirs = 0;
        renderResumeBanner();
    }
    async function loadSnapshotAsync() {
        var p = readSnapshot();
        if (!p) return null;
        if (p.full) return p;              // localStorage 里就是完整快照
        // 超大断点若强行读回并 unpack，光 JSON.parse 就能再次撑爆渲染进程
        if (num(p.records) > SNAP_MAX_RECORDS) {
            log('⚠ 断点含 ' + num(p.records) + ' 条明细，一次性恢复可能触发内存不足，已跳过。请分批勾选目录重新扫描。', 'warn');
            return null;
        }
        var txt = await idbGet();          // 摘要模式：完整数据在 IndexedDB（存的是 JSON 字符串）
        if (!txt) return null;
        try {
            var full = JSON.parse(txt);
            return (full && full.v === SNAP_VER && full.full) ? full : null;
        } catch (e) { return null; }
    }
    function saveSnapshot(force) {
        if (!state.running || state.phase !== 'scanning') return;
        var now = Date.now();
        if (!force && (snapBusy || now - lastSnapAt < SNAP_MIN_MS)) return;
        if (!force && state.scannedDirs - lastSnapDirs < SNAP_MIN_DIRS) return;
        // 记录数预估超限就不做全量打包：packRecords + JSON.stringify 本身会制造数百 MB 临时对象
        if (state.records.length > SNAP_MAX_RECORDS) {
            if (!warnedBig) {
                warnedBig = true;
                log('⚠ 明细已达 ' + state.records.length + ' 条，超过断点安全上限，本轮不再保存完整明细断点；请先导出 CSV 并分批扫描。', 'warn');
            }
            return;
        }
        // inFlight 里的目录已被取走但结果还没落盘；failedJobs 是请求失败、本轮不再重试的目录。
        // 两者都必须并回队列，否则恢复后会整层漏扫。
        var pending = state.queue.concat(state.inFlight || [], state.failedJobs || []);
        try {
            var payload = {
                v: SNAP_VER, savedAt: now, version: VERSION, full: 1,
                streaming: !!state.stream, writtenRows: streamMeta ? streamMeta.writtenRows : 0,
                fileName: streamMeta ? streamMeta.fileName : '',
                queue: pending,
                records: packRecords(state.records),
                scannedFsIds: Array.from(state.scannedFsIds || []),
                stats: state.stats, scannedDirs: state.scannedDirs, reqCount: state.reqCount,
                startedAt: state.startedAt, errors: state.errors, truncated: state.truncated,
                topDirs: state.topDirs, topItems: packRecords(state.topItems),
                selectedDirs: Array.from(state.selectedDirs), topDirSeq: state.topDirSeq,
                structureRead: state.structureRead, shareinfoBroken: state.shareinfoBroken,
                dirFailStreak: state.dirFailStreak, methodShareinfo: state.methodShareinfo,
                run: state.run ? {
                    id: state.run.id, startedAt: state.run.startedAt, group: state.run.group,
                    dirs: state.run.dirs, base: state.run.base, resumed: state.run.resumed,
                    dirLedger: state.run.dirLedger, events: state.run.events, exports: state.run.exports
                } : null
            };
            var txt = JSON.stringify(payload);
            if (txt.length > SNAP_MAX_CHARS) {
                lastSnapAt = now; lastSnapDirs = state.scannedDirs;
                if (!warnedBig) {
                    warnedBig = true;
                    log('⚠ 本轮断点约 ' + (txt.length / 1e6).toFixed(0) + 'M 字符，跳过写入以免撑爆浏览器内存；请先导出 CSV 并分批扫描。', 'warn');
                }
                return;
            }
            // 完整数据写 IndexedDB；加背压锁，上一笔没落地前不再生成下一份巨型字符串
            snapBusy = true;
            var snapReleased = false;
            var releaseSnap = function () { if (!snapReleased) { snapReleased = true; snapBusy = false; } };
            try { idbPut(txt).then(releaseSnap, releaseSnap); } catch (e) { releaseSnap(); }
            setTimeout(releaseSnap, 6000);
            // localStorage：放得下就存完整（同步最可靠），放不下只留摘要，恢复时走 IndexedDB
            var stored = false;
            if (txt.length <= SNAP_LOCAL_LIMIT) {
                try { localStorage.setItem(SNAP_KEY, txt); stored = true; } catch (e) { }
            }
            if (!stored) {
                var meta = {
                    v: SNAP_VER, savedAt: now, version: VERSION,
                    records: state.records.length, scannedDirs: state.scannedDirs,
                    queue: pending.length, src: 'idb',
                    streaming: !!state.stream, writtenRows: streamMeta ? streamMeta.writtenRows : 0,
                    fileName: streamMeta ? streamMeta.fileName : ''
                };
                try { localStorage.setItem(SNAP_KEY, JSON.stringify(meta)); }
                catch (e) { log('⚠ 连进度摘要都写不进本地存储，断点可能不可用', 'warn'); }
                if (!warnedBig) {
                    warnedBig = true;
                    log('本轮明细较大，断点已转存 IndexedDB（不再受本地存储 5MB 限制），可继续放心扫描。', 'info');
                }
            }
            lastSnapAt = now; lastSnapDirs = state.scannedDirs;
        } catch (e) {
            log('进度保存失败（不影响本次扫描）：' + e.message, 'warn');
        }
    }
    function maybeSnapshot() { saveSnapshot(false); }
    function restoreFromSnapshot(p) {
        state.queue = (p.queue || []).slice();
        state.records = unpackRecords(p.records);
        state.topItems = unpackRecords(p.topItems);
        rebuildSeen();
        state.scannedFsIds = new Set(p.scannedFsIds || []);
        state.stats = p.stats || { files: 0, dirs: 0, bytes: 0 };
        state.scannedDirs = num(p.scannedDirs);
        state.reqCount = num(p.reqCount);
        state.errors = p.errors || [];
        state.truncated = p.truncated || { pages: 0, depth: 0 };
        state.topDirs = p.topDirs || [];
        state.selectedDirs = new Set(p.selectedDirs || []);
        state.topDirSeq = num(p.topDirSeq);
        state.structureRead = !!p.structureRead;
        state.shareinfoBroken = !!p.shareinfoBroken;
        state.dirFailStreak = num(p.dirFailStreak);
        state.methodShareinfo = p.methodShareinfo || 'GET';
        // 断点续抓算同一个任务：沿用任务ID、目录台账、事件日志与导出记录
        state.run = makeRun(p.run || null);
        state.run.resumed += 1;
        state.run.status = 'running';
        // 累计耗时保持连贯，但不把「关掉页面那段时间」算进去
        state.startedAt = Date.now() - Math.max(0, num(p.savedAt) - num(p.startedAt));
        state.inFlight = [];
        state.failedJobs = [];
        state.incomplete = false;
        state.phase = 'scanning';
        clearSnapshotOnly();
    }

    /* ---------- 有界并发 worker 池 ----------
     * 旧版是 while 串行 await walkDir，所有请求排队等 delay；现在按 concurrency 开 2~3 个
     * worker 同时展开不同目录，单目录内部仍然按页串行（分页游标不能并发）。 */
    var activeWorkers = 0;
    function workerCount() { return Math.max(1, Math.min(4, num(state.cfg.concurrency) || 1)); }
    async function runWorkers() {
        activeWorkers = 0;
        var n = workerCount(), ws = [];
        for (var i = 0; i < n; i++) ws.push(workerLoop(i));
        await Promise.all(ws);
    }
    async function workerLoop(id) {
        while (!state.aborted) {
            if (state.shareinfoBroken) return;
            // 其它 worker 正在展开的目录稍后还会 push 子目录，
            // 只有「队列空 且 没有任何 worker 在跑」才是真结束，否则会漏扫动态产生的子目录。
            // 这个判断必须放在 slow 挂起之前，否则降速后多余的 worker 会永远空转、Promise.all 不返回。
            if (state.queue.length === 0 && activeWorkers === 0) return;
            if (state.eff.slow && id > 0) { await sleep(200); continue; } // 降速后只保留 0 号 worker
            var job = state.queue.shift();
            if (!job) { await sleep(25); continue; }
            state.inFlight.push(job);
            activeWorkers++;
            try {
                await walkDir(job);
                maybeSnapshot();
            } catch (e) {
                state.errors.push({ where: job.path, msg: e.message });
                state.failedJobs.push(job);   // 留给断点续抓重试，本轮不再排回队列以免死循环
                log('目录遍历出错 ' + job.path + '：' + e.message + '（已记入断点，续抓时会重试）', 'warn');
            } finally {
                var k = state.inFlight.indexOf(job);
                if (k >= 0) state.inFlight.splice(k, 1);
                activeWorkers--;
            }
        }
    }

    // 第二步：只递归用户勾选的顶层目录，导出明细。勾选发生在扫描之前。
    // resuming=true 时从本地快照恢复，只跑剩余队列，不重扫已完成目录。
    async function startScan(resuming) {
        if (state.running) { log('任务进行中，请先停止', 'warn'); return; }
        var snap = null;
        if (resuming) {
            snap = await loadSnapshotAsync();
            if (!snap) { log('没有可恢复的扫描进度', 'warn'); return; }
        } else if (state.phase !== 'select' && state.phase !== 'done') {
            log('请先点「读取目录结构」生成目录清单，再勾选要导出的目录', 'warn');
            return;
        }
        state.running = true; state.paused = false; state.aborted = false;
        resetEff();
        nextSlot = 0;
        var pickedDirs = [];
        if (snap) {
            restoreFromSnapshot(snap);
        } else {
            state.queue = []; state.seen.clear();
            state.records = []; state.stats = { files: 0, dirs: 0, bytes: 0 };   // 每次扫描都从干净结果开始
            memGuardHit = false; warnedBig = false;
            state.reqCount = 0; state.scannedDirs = 0; state.startedAt = Date.now();
            state.shareinfoBroken = false; state.dirFailStreak = 0;
            state.scannedFsIds = new Set(); state.truncated = { pages: 0, depth: 0 };
            state.incomplete = false;
            state.phase = 'scanning';
            state.run = makeRun(null);   // 每次全新扫描生成一条独立台账
            // 导出范围：勾选了目录时，只导出这些目录「内部」的文件与子目录，
            // 根目录下的条目（同级目录、顶层直接分享的文件）一律不计入结果。
            pickedDirs = state.topDirs.filter(function (d) { return state.selectedDirs.has(d.cid); });
            if (pickedDirs.length === 0) {
                state.topItems.forEach(function (r) { if (!r.isDir) addRecord(r); });
            }
            pickedDirs.forEach(function (d) {
                state.queue.push({ ctx: d.ctx, fsId: d.fsId, path: d.path, depth: d.depth || 1 });
            });
        }
        // 若上次是「全自动边扫边写」被意外中断，则续写同一份 CSV（需浏览器重新授权一次）
        if (resuming && snap && snap.streaming) {
            var streamOk = await tryAttachResumeStream(snap);
            if (!streamOk) {
                state.stream = null; state.streamDraining = false;
                clearStreamHandle();
                log('⚠ 无法恢复「边扫边写」原文件（未授权或句柄失效），已回退为普通断点续扫：结果存内存，扫完请点「导出 CSV」。', 'warn');
            }
        }
        state.inFlight = [];
        if (!snap) state.failedJobs = [];
        if (!state.run) state.run = makeRun(null);   // 兜底：老格式快照没有 run 字段
        saveRun();                                      // 任务一开始就落摘要，中途关页面也有痕迹
        setButtons();
        renderProgress(true);
        startHeartbeat();
        log((snap
            ? '=== 从断点继续：已恢复 ' + state.records.length + ' 条记录 / ' + state.scannedDirs +
              ' 个已展开目录，剩余 ' + state.queue.length + ' 个目录待扫描'
            : (pickedDirs.length
                ? '=== 开始扫描选中的 ' + pickedDirs.length + ' 个目录（仅导出目录内部内容，不含根目录条目）=== '
                : '=== 未勾选任何目录，仅导出顶层直接分享的文件（' + state.records.length + ' 条）=== ')) +
            '　速度档位「' + speedLabel() + '」/ 并发 ' + workerCount() + ' 路，进度自动存盘 ===', 'info');
        try {
            await runWorkers();
        } catch (e) {
            log('扫描中断：' + e.message, 'error');
            state.errors.push({ where: '扫描', msg: e.message });
        } finally {
            stopHeartbeat();
            var sec = Math.round((Date.now() - state.startedAt) / 1000);
            // 明确区分「跑完」与「中断」：手动停止时队列里往往还剩大量目录，旧版仍显示「扫描结束 / 错误 0 个」
            var reasons = [];
            var leftDirs = state.queue.length + (state.inFlight || []).length + (state.failedJobs || []).length;
            if (state.aborted || leftDirs > 0) {
                reasons.push('任务被中断，尚有 ' + leftDirs + ' 个目录未展开（含请求失败、待续抓重试的目录）');
            }
            if (state.errors.length) reasons.push('有 ' + state.errors.length + ' 个请求错误（对应目录可能整层缺失）');
            if (state.shareinfoBroken) reasons.push('子目录接口曾被判定不可用（熔断）');
            if (state.truncated && state.truncated.pages) reasons.push('有 ' + state.truncated.pages + ' 个目录翻页触及「最大翻页」上限');
            if (state.truncated && state.truncated.depth) reasons.push('有 ' + state.truncated.depth + ' 个子目录触及「最大深度」上限');
            state.incomplete = reasons.length > 0;
            // 中断时强制存盘（供下次续抓），完整跑完则清除断点
            if (state.incomplete) saveSnapshot(true); else clearSnapshot();
            state.running = false; state.paused = false;
            state.phase = 'done';
            log('=== 扫描' + (state.incomplete ? '【未完成·已存断点】' : '完成') + '：' + state.records.length + ' 条记录，' + state.stats.files +
                ' 个文件 / ' + state.stats.dirs + ' 个目录，' + state.scannedDirs +
                ' 个目录已展开，耗时 ' + sec + 's，错误 ' + state.errors.length + ' 个 ===',
                state.incomplete ? 'warn' : 'info');
            if (state.incomplete) {
                log('⚠ 结果不完整：' + reasons.join('；') + '。刷新或关掉页面后，面板顶部会出现「继续上次扫描」，从断点接着跑。', 'warn');
            } else {
                log('✓ 队列已清空、无请求错误、无参数截断；断点已清除。如需核对，可点「5. 导出文件明细 → 完整性自检」（离线，秒出）。', 'info');
            }
            log('扫描台账已归档（任务 ' + state.run.id + '）：目录台账 ' +
                state.run.dirLedger.length + ' 行、事件日志 ' + state.run.events.length +
                ' 行，可在「6. 日志 → 扫描记录」查看或导出核对报告。', 'info');
            try { await finishRun(reasons); } catch (e) { log('台账保存失败：' + e.message, 'warn'); }
            setButtons(); renderProgress(true); renderPreview(); renderStatus(); renderResumeBanner();
        }
    }

    // 渲染顶层目录勾选清单
    function renderTopDirs() {
        var box = el.panel && el.panel.querySelector('#bpgExTopDirs');
        if (!box) return;
        if (!state.topDirs.length) {
            if (state.running && state.phase === 'select') {
                box.innerHTML = '<div class="bpgEx-status">⏳ 正在读取目录结构…已读 ' + state.structureMsgs +
                    ' 条分享消息 / ' + state.structurePages + ' 页。下方「4. 执行与进度」和「6. 日志」有实时进度。</div>';
            } else if (state.structureRead) {
                var n = state.topItems.filter(function (r) { return !r.isDir; }).length;
                var tip = state.structureError
                    ? state.structureError
                    : (n
                        ? '✓ <b>读取完成</b>：这个群的文件库里<b>没有可展开的共享文件夹</b>，只有 <b>' + n +
                          '</b> 个直接分享的文件（来自 ' + state.structureMsgs + ' 条分享消息 / ' + state.structurePages +
                          ' 页）。<br/>→ 这里没有目录可勾选，<b>直接点「② 开始扫描（边扫边写）」</b>即可导出这 ' + n +
                          ' 个文件。想导出共享文件夹，请到「1. 选择群组」改勾其它群再读一次。'
                        : '⚠ <b>读取完成，但没有抓到任何条目</b>：请确认群组勾选是否正确、是否已打开群文件页；详细原因见「6. 日志」。');
                if (state.structureIncomplete) {
                    tip += '<br/><span class="warn">⚠ 分享消息可能没读完，后面的消息里可能还有共享目录：' +
                        '可调大「2. 扫描设置 → 读取结构最大页数」后重新读取。</span>';
                }
                if (state.errors.length) {
                    tip += '<br/><span class="warn">读取过程中有 ' + state.errors.length + ' 个错误，详见「6. 日志」。</span>';
                }
                box.innerHTML = '<div class="bpgEx-status">' + tip + '</div>';
            } else {
                box.innerHTML = '<div class="bpgEx-hint">请先点「读取目录结构」：读取完成后，这里会列出各共享目录，可勾选要导出的目录。</div>';
            }
            updateDirCount();
            return;
        }
        var groups = {};
        state.topDirs.forEach(function (d) { (groups[d.groupName] = groups[d.groupName] || []).push(d); });
        var html = '';
        Object.keys(groups).forEach(function (gname) {
            html += '<div class="bpgEx-dirgrp">▸ ' + esc(gname) + '（' + groups[gname].length + '）</div>';
            groups[gname].forEach(function (d) {
                var checked = state.selectedDirs.has(d.cid) ? ' checked' : '';
                html += '<label class="bpgEx-dir"><input type="checkbox" data-cid="' + d.cid + '"' + checked + '/>' +
                    esc(d.path) + '</label>';
            });
        });
        box.innerHTML = html;
        box.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var cid = cb.getAttribute('data-cid');
                if (cb.checked) state.selectedDirs.add(cid); else state.selectedDirs.delete(cid);
                updateDirCount();
            });
        });
        updateDirCount();
    }

    function updateDirCount() {
        var c = el.panel && el.panel.querySelector('#bpgExDirCount');
        if (!c) return;
        var files = state.topItems.filter(function (r) { return !r.isDir; }).length;
        var s;
        if (state.running && state.phase === 'select' && !state.structureRead) {
            s = '⏳ 正在读取…已读 ' + state.structureMsgs + ' 条消息 / ' + state.structurePages + ' 页';
        } else {
            s = '已选 ' + state.selectedDirs.size + ' / ' + state.topDirs.length + ' 个目录';
            if (state.structureRead) {
                s += '　顶层直接文件 ' + files + ' 个　已读 ' + state.structureMsgs + ' 条消息 / ' + state.structurePages + ' 页';
            }
        }
        if (state.structureIncomplete) s += '　⚠ 可能未读完';
        c.textContent = s;
    }

    // 展开「选择导出目录」并滚动到该区块，确保用户一定能看到勾选框与确认按钮
    function focusTopDirsSection() {
        var sec = el.panel && el.panel.querySelector('#bpgExTopDirSec');
        if (!sec) return;
        sec.classList.remove('fold'); // 强制展开
        var btn = sec.querySelector('.foldBtn');
        if (btn) btn.textContent = '收起';
        if (el.body) {
            // 仅滚动面板内部，避免带动百度页面一起滚；用 getBoundingClientRect 计算相对偏移
            try {
                var br = sec.getBoundingClientRect();
                var bbr = el.body.getBoundingClientRect();
                var delta = (br.top - bbr.top) + el.body.scrollTop - 8;
                el.body.scrollTop = delta;
                setTimeout(function () { el.body.scrollTop = delta; }, 30);
            } catch (e) { }
        }
    }

    // 心跳：扫描期间每秒刷新一次，显示「正在请求哪个接口 + 已等待几秒」，避免误以为卡死
    function startHeartbeat() {
        stopHeartbeat();
        state.heartbeat = setInterval(tickHeartbeat, 1000);
    }
    function stopHeartbeat() {
        if (state.heartbeat) { clearInterval(state.heartbeat); state.heartbeat = null; }
    }
    function tickHeartbeat() {
        renderProgress(false);
        if (el && el.cur) {
            if (state.phase === 'select' && !state.running && state.structureRead &&
                !state.errors.length && !state.structureError) {
                el.cur.textContent = state.topDirs.length
                    ? '⏸ 目录结构已读取，请在「选择导出目录」勾选要导出的目录，然后点「② 开始扫描（边扫边写）」'
                    : '⏸ 结构已读取：本群没有共享文件夹，直接点「② 开始扫描（边扫边写）」即可导出顶层分享文件';
            } else if (state.currentReq) {
                var wait = Math.round((Date.now() - state.currentReq.at) / 1000);
                el.cur.textContent = '⏳ 正在请求 ' +
                    str(state.currentReq.url).replace(location.origin, '') + ' （已等待 ' + wait + 's）';
            }
        }
    }

    function saveGroups() {
        try { localStorage.setItem(CFG_KEY + '.groups', JSON.stringify(state.groups.slice(0, 500))); } catch (e) { }
    }
    function loadGroups() {
        try {
            var g = JSON.parse(localStorage.getItem(CFG_KEY + '.groups') || '[]');
            if (Array.isArray(g) && g.length) return g;
        } catch (e) { }
        return [];
    }

    /* ============================================================
     * 5. 导出（文件明细）
     * ============================================================ */

    /* ---------- 结果完整性校验（离线自检 + 独立重抓对账） ---------- */
    function renderVerifyReport(html) {
        var box = el.panel && el.panel.querySelector('#bpgExVerify');
        if (box) box.innerHTML = html;
    }

    function integritySummary() {
        var dupId = 0, dupPath = 0, dirs = 0, seenId = new Set(), seenPath = new Set(), byParent = {};
        state.records.forEach(function (r) {
            var id = str(r.fsId);
            if (id) { if (seenId.has(id)) dupId++; else seenId.add(id); }
            if (seenPath.has(r.path)) dupPath++; else seenPath.add(r.path);
            if (r.isDir) dirs++;
            byParent[r.parent] = (byParent[r.parent] || 0) + 1;
        });
        var unexpanded = null;
        if (state.scannedFsIds && state.scannedFsIds.size) {
            unexpanded = state.records.filter(function (r) {
                return r.isDir && r.fsId && !state.scannedFsIds.has(str(r.fsId));
            }).length;
        }
        var issues = [];
        if (state.running) issues.push('扫描仍在进行中');
        if (state.aborted) issues.push('本次扫描被手动停止');
        if (state.queue.length) issues.push('还有 ' + state.queue.length + ' 个目录未展开');
        if (state.errors.length) issues.push('有 ' + state.errors.length + ' 个请求错误');
        if (state.shareinfoBroken) issues.push('子目录接口曾被熔断');
        if (state.truncated && state.truncated.pages) issues.push(state.truncated.pages + ' 个目录触及「最大翻页」上限');
        if (state.truncated && state.truncated.depth) issues.push(state.truncated.depth + ' 个子目录触及「最大深度」上限');
        if (dupId) issues.push('重复 fs_id ' + dupId + ' 条');
        if (dupPath) issues.push('重复路径 ' + dupPath + ' 条');
        if (unexpanded !== null && unexpanded > 0) issues.push(unexpanded + ' 个目录从未展开（其内部文件必然缺失）');
        var top = Object.keys(byParent).map(function (k) { return { path: k, n: byParent[k] }; })
            .sort(function (a, b) { return b.n - a.n; }).slice(0, 5);
        return {
            issues: issues, ok: issues.length === 0, dupId: dupId, dupPath: dupPath,
            dirs: dirs, unexpanded: unexpanded, scanned: state.scannedDirs,
            queue: state.queue.length, errors: state.errors.length, top: top
        };
    }

    function selfCheck() {
        if (!state.records.length) {
            renderVerifyReport('<span class="warn">当前没有扫描结果，请先「读取目录结构 → 开始扫描（边扫边写）」后再自检。</span>');
            log('完整性自检：当前没有扫描结果', 'warn');
            return;
        }
        var s = integritySummary();
        var h = ['<b>完整性自检</b>（离线，未发起请求）',
            '记录 <b>' + state.records.length + '</b> 条　目录行 <b>' + s.dirs + '</b> 个　已展开 <b>' + s.scanned +
            '</b> 个　待处理 <b>' + s.queue + '</b> 个　请求错误 <b>' + s.errors + '</b> 个',
            '重复 fs_id：<b>' + s.dupId + '</b>　重复路径：<b>' + s.dupPath + '</b>　结果中未展开的目录：<b>' +
            (s.unexpanded === null ? '未知（刷新后重扫才有记录）' : s.unexpanded) + '</b>',
            '结论：' + (s.ok ? '<span class="ok">✓ 未发现不完整迹象</span>'
                : '<span class="warn">⚠ 结果不完整：' + esc(s.issues.join('；')) + '</span>'),
            '子项最多的目录（便于核对此范围是否已完整展开）：'];
        s.top.forEach(function (t) { h.push('　' + esc(t.path) + ' — ' + t.n + ' 条'); });
        renderVerifyReport(h.join('<br/>'));
        log('【完整性自检】' + (s.ok ? '✓ 未发现不完整迹象' : '⚠ 不完整：' + s.issues.join('；')), s.ok ? 'info' : 'warn');
        log('　记录 ' + state.records.length + ' 条，已展开目录 ' + s.scanned + '，未展开 ' +
            (s.unexpanded === null ? '未知' : s.unexpanded) + '，队列残留 ' + s.queue, 'info');
    }

    // 用「与扫描不同的单页条数」独立重抓一个目录的全部直接子项，返回 fs_id 集合。
    // 不经过 gate()/fetchShareInfo，避免污染扫描统计；仍遵守请求间隔。
    async function refetchChildren(ctx, fsId, ps, maxP) {
        var ids = new Set(), pages = 0, lastMore = null, lastLen = 0;
        for (var page = 1; page <= maxP; page++) {
            var extra = {
                msg_id: ctx.msgId, from_uk: ctx.fromUk, gid: ctx.gid, type: 2,
                fs_id: fsId, page: page, num: ps, limit: ps, desc: 1
            };
            var r = await api(API.shareinfo, extra, { method: state.methodShareinfo || 'GET' }, '复核');
            if (!errnoOk(r)) throw new Error('errno=' + (r && r.errno));
            var list = pickList(r);
            list.forEach(function (x) { var id = str(x.fs_id); if (id) ids.add(id); });
            pages++; lastLen = list.length;
            var more = rawHasMore(r);
            if (more === undefined) more = list.length >= Math.min(ps, 50);
            lastMore = more;
            if (!more || list.length === 0) break;
            await sleep(Math.max(200, num(state.cfg.delay)));
        }
        return { ids: ids, pages: pages, lastMore: lastMore, lastLen: lastLen };
    }

    // 注：v1.0.6 起界面已移除「接口复核」入口（重抓大目录太慢，用户不需要）。
    // 下面两个函数保留为内部能力，仅供回归测试 / 控制台高级排障使用，不发起任何自动调用。
    async function verifyResults() {
        if (state.running) { log('扫描进行中，请先停止再复核', 'warn'); return; }
        if (state.verifying) return;
        if (!state.records.length) { log('没有可复核的结果，请先扫描', 'warn'); return; }
        var pathInput = el.panel && el.panel.querySelector('#bpgEx-verifyPath');
        var cntInput = el.panel && el.panel.querySelector('#bpgEx-verifyCount');
        var want = pathInput ? str(pathInput.value).trim() : '';
        var limit = Math.max(1, Math.min(10, num(cntInput && cntInput.value) || 3));
        var cand = [];
        if (want) {
            for (var w = 0; w < state.records.length && cand.length === 0; w++) {
                var rw = state.records[w];
                if (rw.isDir && rw.fsId && (rw.path === want || rw.path.indexOf(want) >= 0)) cand.push(rw);
            }
            if (!cand.length) {
                renderVerifyReport('<span class="warn">未找到目录「' + esc(want) + '」：请填「5. 导出文件明细」里显示的完整路径，或从完整性自检给出的路径复制。</span>');
                log('接口复核：未找到目录 ' + want, 'warn');
                return;
            }
        } else {
            var byParent = {};
            state.records.forEach(function (r) { byParent[r.parent] = (byParent[r.parent] || 0) + 1; });
            var keys = Object.keys(byParent).sort(function (a, b) { return byParent[b] - byParent[a]; }).slice(0, limit);
            keys.forEach(function (k) {
                for (var i = 0; i < state.records.length; i++) {
                    var r2 = state.records[i];
                    if (r2.isDir && r2.fsId && r2.path === k) { cand.push(r2); break; }
                }
            });
            if (!cand.length) cand = state.records.filter(function (r) { return r.isDir && r.fsId; }).slice(0, limit);
        }
        var ps = num(state.cfg.pageSize) >= 100 ? 50 : 100;   // 必须与扫描时不同，才能达到交叉验证效果
        state.verifying = true; setButtons();
        var rows = [], allOk = true;
        renderVerifyReport('正在独立重抓 <b>' + cand.length + '</b> 个目录（单页 ' + ps + ' 条，扫描时 ' + state.cfg.pageSize + ' 条）…');
        log('=== 开始接口复核：' + cand.length + ' 个目录，单页 ' + ps + ' 条（扫描时 ' + state.cfg.pageSize + ' 条）===', 'info');
        try {
            for (var i2 = 0; i2 < cand.length; i2++) {
                var d = cand[i2];
                var ctx = { msgId: d.msgId, fromUk: d.fromUk, gid: d.gid, groupName: d.groupName, uname: d.shareUname };
                if (!ctx.msgId || !d.fsId) { rows.push({ dir: d.path, err: '缺少 msgId / fs_id，无法复核' }); allOk = false; continue; }
                var mine = state.records.filter(function (r) { return r.parent === d.path; })
                    .map(function (r) { return str(r.fsId); }).filter(Boolean);
                var mineSet = new Set(mine);
                var maxP = Math.min(num(state.cfg.maxPages) || 300, Math.max(60, Math.ceil((mine.length + 10) / ps) * 2 + 5));
                try {
                    var got = await refetchChildren(ctx, d.fsId, ps, maxP);
                    var onlyMine = [], onlyGot = [];
                    mineSet.forEach(function (id) { if (!got.ids.has(id)) onlyMine.push(id); });
                    got.ids.forEach(function (id) { if (!mineSet.has(id)) onlyGot.push(id); });
                    var ok = onlyMine.length === 0 && onlyGot.length === 0 && mine.length === got.ids.size;
                    if (!ok) allOk = false;
                    rows.push({
                        dir: d.path, mine: mine.length, got: got.ids.size, pages: got.pages,
                        lastLen: got.lastLen, lastMore: got.lastMore,
                        onlyMine: onlyMine.length, onlyGot: onlyGot.length,
                        sample: onlyGot.slice(0, 3), ok: ok
                    });
                    log('复核 ' + (i2 + 1) + '/' + cand.length + '「' + d.path + '」：脚本 ' + mine.length +
                        ' 条 / 重抓 ' + got.ids.size + ' 条（' + got.pages + ' 页）' + (ok ? ' ✓ 完全一致' : ' ⚠ 有差异'), ok ? 'info' : 'warn');
                } catch (e) {
                    allOk = false;
                    rows.push({ dir: d.path, err: e.message });
                    log('复核失败「' + d.path + '」：' + e.message, 'error');
                }
            }
        } finally {
            state.verifying = false; setButtons();
        }
        var h = ['<b>接口复核报告</b>　单页 ' + ps + ' 条（扫描时 ' + state.cfg.pageSize + ' 条）　结论：' +
            (allOk ? '<span class="ok">✓ 抽样目录全部一致</span>' : '<span class="warn">⚠ 存在不一致</span>')];
        rows.forEach(function (r) {
            if (r.err) { h.push('　' + esc(r.dir) + ' → <span class="warn">' + esc(r.err) + '</span>'); return; }
            h.push('　' + esc(r.dir) + '　脚本 <b>' + r.mine + '</b> / 重抓 <b>' + r.got + '</b>（' + r.pages +
                ' 页，末页 ' + r.lastLen + ' 条 has_more=' + (r.lastMore ? 1 : 0) + '）　仅脚本 ' + r.onlyMine +
                ' / 仅重抓 ' + r.onlyGot + ' → ' + (r.ok ? '<span class="ok">✓ 一致</span>' : '<span class="warn">⚠ 有差异</span>'));
            if (!r.ok && r.sample && r.sample.length) h.push('　　漏抓 fs_id 示例：' + esc(r.sample.join(', ')));
        });
        renderVerifyReport(h.join('<br/>'));
        log('=== 接口复核结束：' + (allOk ? '✓ 抽样目录与独立重抓完全一致' : '⚠ 发现差异，见「5. 导出文件明细」报告') + ' ===', allOk ? 'info' : 'warn');
    }

    function exportRows() {
        // 勾选目录扫描时，根目录下的条目不属于导出范围（兼容旧结果 / 热更新后的内存数据）
        var scoped = state.phase === 'done' && state.selectedDirs && state.selectedDirs.size > 0;
        return state.records.filter(function (r) {
            if (scoped && r.depth <= 1) return false;
            return state.cfg.includeDirs || !r.isDir;
        });
    }

    function download(filename, content, mime) {
        var blob = new Blob(Array.isArray(content) ? content : [content], { type: mime || 'text/plain;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 3000);
    }

    function csvCell(v) {
        var s = v === undefined || v === null ? '' : str(v);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 防 CSV 公式注入
        return '"' + s.replace(/"/g, '""') + '"';
    }

    var CSV_HEAD = ['序号', '群名称', '群ID', '分享消息ID', '分享者', '层级', '类型', '文件名',
        '完整路径', '父目录', '大小(字节)', '大小(可读)', '分类', 'MD5', 'fs_id',
        '创建时间', '修改时间', '原始路径'];

    function toCSV(rows) {
        // 返回 Blob parts：每 2000 行拼一段就释放临时行，
        // 避免「百万行数组 → join 大字符串 → 拼接 → Blob 编码」的多份巨型副本
        var parts = ['\uFEFF' + CSV_HEAD.map(csvCell).join(',') + '\r\n'];
        var chunk = [];
        rows.forEach(function (r, i) {
            chunk.push([
                i + 1, r.groupName, r.gid, r.msgId, r.shareUname, r.depth,
                r.isDir ? '文件夹' : '文件', r.name, r.path, r.parent,
                r.size, fmtSize(r.size), r.category, r.md5, r.fsId,
                fmtTime(r.ctime), fmtTime(r.mtime), r.rawPath
            ].map(csvCell).join(','));
            if (chunk.length >= 2000) { parts.push(chunk.join('\r\n') + '\r\n'); chunk = []; }
        });
        if (chunk.length) parts.push(chunk.join('\r\n') + '\r\n');
        return parts;
    }

    function toJSON(rows) {
        var plain = rows.map(function (r) {
            var o = {};
            Object.keys(r).forEach(function (k) { if (k !== 'raw') o[k] = r[k]; });
            o.sizeReadable = fmtSize(r.size);
            o.createTime = fmtTime(r.ctime);
            o.modifyTime = fmtTime(r.mtime);
            return o;
        });
        return JSON.stringify({
            generator: '百度网盘群组文件清单导出器 v' + VERSION,
            exportedAt: new Date().toISOString(),
            accountHint: { bdstoken: detectBdstoken() ? '已检测' : '未检测', captuerHits: state.cap.hits },
            groups: (function () {
                var g = state.cap.currentGid || state.cap.activeGid;
                return (g ? state.groups.filter(function (x) { return x.gid === g; }) : [])
                    .map(function (x) { return { gid: x.gid, name: x.name }; });
            })(),
            stats: {
                total: plain.length,
                files: state.stats.files,
                dirs: state.stats.dirs,
                bytes: state.stats.bytes,
                readable: fmtSize(state.stats.bytes),
                scannedDirs: state.scannedDirs,
                errors: state.errors
            },
            files: plain
        }, null, 2);
    }

    function toTree(rows) {
        var root = { children: new Map(), rec: null };
        rows.forEach(function (r) {
            var parts = r.path.split('/').filter(Boolean);
            var node = root;
            for (var i = 0; i < parts.length; i++) {
                if (!node.children.has(parts[i])) node.children.set(parts[i], { children: new Map(), rec: null });
                node = node.children.get(parts[i]);
            }
            node.rec = r;
        });
        // 按群分组输出
        var byGroup = new Map();
        rows.forEach(function (r) {
            if (!byGroup.has(r.groupName)) byGroup.set(r.groupName, []);
            byGroup.get(r.groupName).push(r);
        });
        var out = ['百度网盘 · 群组共享文件目录树', '导出时间：' + new Date().toLocaleString('zh-CN'),
            '共 ' + rows.length + ' 条记录 / ' + fmtSize(state.stats.bytes), ''];

        function emit(node, prefix, name, isLast, groupFilter) {
            if (name) {
                var rec = node.rec;
                var mark = node.children.size > 0 || (rec && rec.isDir) ? '/' : '';
                var size = rec && !rec.isDir ? '  [' + fmtSize(rec.size) + ']' : '';
                out.push(prefix + (isLast ? '└── ' : '├── ') + name + mark + size);
            }
            var kids = Array.from(node.children.entries());
            kids.sort(function (a, b) {
                var ad = a[1].rec && a[1].rec.isDir ? 0 : 1;
                var bd = b[1].rec && b[1].rec.isDir ? 0 : 1;
                return ad - bd || a[0].localeCompare(b[0], 'zh-CN');
            });
            var childPrefix = name ? prefix + (isLast ? '    ' : '│   ') : prefix;
            kids.forEach(function (kv, i) { emit(kv[1], childPrefix, kv[0], i === kids.length - 1, groupFilter); });
        }

        byGroup.forEach(function (list, gname) {
            out.push('', '=== ' + gname + ' (' + list.length + ' 条) ===');
            // 为该群重建子树
            var sub = { children: new Map(), rec: null };
            list.forEach(function (r) {
                var parts = r.path.split('/').filter(Boolean), node = sub;
                parts.forEach(function (p) {
                    if (!node.children.has(p)) node.children.set(p, { children: new Map(), rec: null });
                    node = node.children.get(p);
                });
                node.rec = r;
            });
            emit(sub, '', '', false, gname);
        });
        return out.join('\r\n') + '\r\n';
    }

    /* ============================================================
     * 6. 界面
     * ============================================================ */

    var CSS = `
#bpgEx-launcher{position:fixed;right:18px;bottom:88px;z-index:2147483000;width:52px;height:52px;
  border-radius:14px;background:#2b6cf5;color:#fff;box-shadow:0 6px 18px rgba(43,108,245,.35);
  display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:grab;
  font:600 11px/1.25 -apple-system,"Microsoft YaHei",sans-serif;user-select:none;letter-spacing:.5px;touch-action:none}
#bpgEx-launcher:active{cursor:grabbing}
#bpgEx-launcher .grip{position:absolute;top:3px;right:5px;font-size:9px;line-height:1;opacity:.7}
#bpgEx-launcher:hover{background:#1f5ae0;transform:translateY(-2px)}
#bpgEx-launcher b{font-size:15px;line-height:1;margin-bottom:2px}
#bpgEx-panel{position:fixed;right:18px;top:12px;bottom:auto;z-index:2147483001;width:430px;max-width:calc(100vw - 36px);
  max-height:calc(100vh - 24px);min-width:360px;min-height:240px;resize:both;background:#fff;color:#24292f;
  border:1px solid #d8dee6;border-radius:12px;
  box-shadow:0 12px 40px rgba(20,40,80,.22);font:13px/1.5 -apple-system,"Microsoft YaHei",sans-serif;
  display:flex;flex-direction:column;overflow:hidden}
#bpgEx-panel.bpgEx-hide{display:none}
#bpgEx-panel.bpgEx-min .bpgEx-body{display:none}
.bpgEx-hd{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;
  background:linear-gradient(90deg,#2b6cf5,#4a86f7);color:#fff;flex:none;cursor:move;user-select:none;touch-action:none}
.bpgEx-hd .t{font-weight:700;font-size:14px}
.bpgEx-hd .v{font-size:11px;opacity:.85;margin-left:6px;font-weight:400}
.bpgEx-hd button{background:transparent;border:0;color:#fff;font-size:16px;cursor:pointer;
  width:24px;height:24px;line-height:1;border-radius:5px;margin-left:4px}
.bpgEx-hd button:hover{background:rgba(255,255,255,.22)}
.bpgEx-body{overflow-y:auto;padding:10px 14px 14px;flex:1}
.bpgEx-body::-webkit-scrollbar{width:8px}
.bpgEx-body::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:4px}
.bpgEx-sec{border:1px solid #e6eaf0;border-radius:8px;margin-bottom:10px;overflow:hidden}
.bpgEx-sec>.h{padding:7px 10px;background:#f6f8fb;font-weight:600;font-size:12px;color:#334155;
  display:flex;justify-content:space-between;align-items:center;cursor:default}
.bpgEx-sec>.c{padding:9px 10px}
.bpgEx-sec.fold .c{display:none}
.bpgEx-sec>.h .foldBtn{cursor:pointer;color:#64748b;font-weight:400;font-size:11px}
.bpgEx-status{font-size:12px;color:#475569;line-height:1.7}
.bpgEx-status .ok{color:#0a8f4e;font-weight:600}
.bpgEx-status .warn{color:#c2410c;font-weight:600}
.bpgEx-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:7px}
.bpgEx-row:last-child{margin-bottom:0}
.bpgEx-btn{border:1px solid #d5dce5;background:#fff;color:#334155;border-radius:6px;padding:5px 10px;
  font-size:12px;cursor:pointer;white-space:nowrap}
.bpgEx-btn:hover{background:#f1f5f9;border-color:#aab7c6}
.bpgEx-btn.primary{background:#2b6cf5;border-color:#2b6cf5;color:#fff;font-weight:600}
.bpgEx-btn.primary:hover{background:#1f5ae0}
.bpgEx-btn.danger{color:#c0392b;border-color:#eec7c1}
.bpgEx-btn:disabled{opacity:.5;cursor:not-allowed}
.bpgEx-btn.mini{padding:3px 7px;font-size:11px}
.bpgEx-input,.bpgEx-select{border:1px solid #d5dce5;border-radius:6px;padding:5px 7px;font-size:12px;
  background:#fff;color:#24292f;outline:none;max-width:100%}
.bpgEx-input:focus,.bpgEx-select:focus{border-color:#2b6cf5}
.bpgEx-input.w60{width:62px}.bpgEx-input.w90{width:88px}.bpgEx-input.full{width:100%;box-sizing:border-box}
.bpgEx-label{font-size:12px;color:#475569;white-space:nowrap}
.bpgEx-groups{max-height:180px;overflow-y:auto;border:1px solid #eef1f5;border-radius:6px;padding:4px}
.bpgEx-group{display:flex;align-items:center;gap:7px;padding:4px 6px;border-radius:5px;font-size:12px}
.bpgEx-group:hover{background:#f6f8fb}
.bpgEx-group input{accent-color:#2b6cf5;margin:0}
.bpgEx-group .gname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bpgEx-group .gid{color:#94a3b8;font-size:10px}
.bpgEx-bar{height:8px;background:#eef2f7;border-radius:5px;overflow:hidden;margin:8px 0 6px}
.bpgEx-bar>i{display:block;height:100%;background:linear-gradient(90deg,#2b6cf5,#59a0ff);width:0;transition:width .25s}
.bpgEx-stat{font-size:12px;color:#334155;line-height:1.8;word-break:break-all}
.bpgEx-stat b{color:#2b6cf5}
.bpgEx-cur{font-size:11px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.bpgEx-table{width:100%;border-collapse:collapse;font-size:11px}
.bpgEx-table th,.bpgEx-table td{border-bottom:1px solid #eef1f5;padding:4px 5px;text-align:left;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}
.bpgEx-table th{color:#64748b;font-weight:600;background:#fafbfd;position:sticky;top:0}
.bpgEx-preview{max-height:200px;overflow:auto;border:1px solid #eef1f5;border-radius:6px;margin-top:6px}
.bpgEx-log{max-height:130px;overflow-y:auto;background:#f8fafc;border-radius:6px;padding:6px 8px;
  font:11px/1.6 Consolas,Monaco,monospace;color:#475569}
.bpgEx-log .e{color:#c0392b}.bpgEx-log .w{color:#c2410c}
.bpgEx-note{font-size:11px;color:#64748b;line-height:1.65;background:#fffbeb;border:1px solid #fde68a;
  border-radius:6px;margin-top:7px;padding:0;overflow:hidden}
.bpgEx-noteHead{display:flex;align-items:center;gap:8px;padding:5px 9px;cursor:pointer;user-select:none}
.bpgEx-noteHead:hover{background:#fef3c7}
.bpgEx-noteTitle{flex:none;font-weight:600;color:#92400e;white-space:nowrap}
.bpgEx-noteHint{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#a16207}
.bpgEx-noteBtn{flex:none;font-size:11px;font-weight:600;color:#b45309;white-space:nowrap}
.bpgEx-noteBody{padding:6px 9px 8px;border-top:1px solid #fde68a}
.bpgEx-note.folded .bpgEx-noteBody{display:none}
.bpgEx-kv{display:grid;grid-template-columns:96px 1fr;gap:5px 6px;font-size:11px;align-items:center}
.bpgEx-kv .bpgEx-input{width:100%;box-sizing:border-box}
.bpgEx-flex{display:flex;gap:6px;flex-wrap:wrap}
.bpgEx-sp{flex:1}
.bpgEx-hint{font-size:11px;color:#94a3b8;line-height:1.5;padding:4px 2px}
#bpgExTopDirs{max-height:210px;overflow-y:auto;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:6px 8px;margin:6px 0}
.bpgEx-dirgrp{font-size:11px;font-weight:600;color:#1e293b;margin:6px 0 2px}
.bpgEx-dir{display:block;font-size:11px;line-height:1.5;color:#334155;padding:2px 4px;border-radius:4px;cursor:pointer;word-break:break-all}
.bpgEx-dir:hover{background:#eef2ff}
.bpgEx-dir input{margin-right:6px;vertical-align:middle}
.bpgEx-resume{background:#fff8e8;border:1px solid #f0c36d;border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:12px;color:#7a4a00;line-height:1.6}
.bpgEx-resume b{color:#8a4b00}
.bpgEx-select{padding:3px 6px;border:1px solid #cfd8e3;border-radius:5px;background:#fff;color:#24292f;font-size:12px;max-width:210px}
`;

    var UI_HTML = `
<div id="bpgEx-launcher" title="点击展开/收起 · 拖动可移动"><span class="grip">⠿</span><b>清单</b><span>群文件</span></div>
<div id="bpgEx-panel" class="bpgEx-hide">
  <div class="bpgEx-hd">
    <div><span class="t">群组共享文件清单</span><span class="v">v${VERSION}</span></div>
    <div><button data-act="min" title="折叠">—</button><button data-act="hide" title="关闭">×</button></div>
  </div>
  <div class="bpgEx-body">

    <div id="bpgEx-resume" class="bpgEx-resume" style="display:none">
      <div id="bpgEx-resume-text"></div>
      <div class="bpgEx-row" style="margin-top:6px">
        <button class="bpgEx-btn primary mini" data-act="resume">继续上次扫描</button>
        <button class="bpgEx-btn mini" data-act="discardSnap">丢弃进度</button>
      </div>
    </div>

    <div class="bpgEx-sec"><div class="h">状态 <span class="foldBtn" data-act="fold">收起</span></div><div class="c">
      <div class="bpgEx-status" id="bpgEx-status"></div>
    </div></div>

    <div class="bpgEx-sec"><div class="h">1. 选择群组 <span class="foldBtn" data-act="fold">收起</span></div><div class="c">
      <div class="bpgEx-row">
        <button class="bpgEx-btn primary mini" data-act="loadGroups">刷新群组（接口·最全）</button>
        <button class="bpgEx-btn mini" data-act="scrapeSidebar">从左侧读取（兜底）</button>
        <button class="bpgEx-btn mini" data-act="selectAll">全选</button>
        <button class="bpgEx-btn mini" data-act="selectNone">清空</button>
        <button class="bpgEx-btn mini" data-act="selectCurrent">只选当前群</button>
      </div>
      <div class="bpgEx-row">
        <input class="bpgEx-input w90" id="bpgEx-filter" placeholder="搜索群名" />
        <input class="bpgEx-input w80" id="bpgEx-addGid" placeholder="手动添加群 gid" />
        <button class="bpgEx-btn mini" data-act="addGroup">添加</button>
      </div>
      <div class="bpgEx-groups" id="bpgEx-groups"><div class="bpgEx-status">点击「刷新群组」或「从左侧读取」获取群组列表。</div></div>
      <div class="bpgEx-note folded" data-note="groups">
        <div class="bpgEx-noteHead" data-act="toggleNote"><span class="bpgEx-noteTitle">群组选择说明</span><span class="bpgEx-noteHint">勾选规则 · 刷新群组最可靠 · 侧栏读取仅兜底</span><span class="bpgEx-noteBtn">展开</span></div>
        <div class="bpgEx-noteBody">勾选要导出的群组（可多选）；未勾选时默认导出「当前正在浏览的群」。<b>「刷新群组」走接口获取完整列表，是最可靠的来源</b>（已实测返回 10 个群、字段含 gid/name）。「从左侧读取」仅作兜底：新版百度侧栏的群入口链接里不再带 gid，抓不到时会自动回退到接口，请优先用「刷新群组」。</div>
      </div>
    </div></div>

    <div class="bpgEx-sec"><div class="h">2. 扫描设置 <span class="foldBtn" data-act="fold">收起</span></div><div class="c">
      <div class="bpgEx-row">
        <span class="bpgEx-label">扫描速度</span>
        <select class="bpgEx-select" data-cfg="speed">
          <option value="safe">保守（原速度）</option>
          <option value="standard">标准 · 约 3~5 倍（推荐）</option>
          <option value="fast">极速 · 约 6~8 倍（可能触发风控）</option>
        </select>
        <span class="bpgEx-hint">触发限流会自动降回单路</span>
      </div>
      <div class="bpgEx-row">
        <span class="bpgEx-label">请求间隔</span><input class="bpgEx-input w60" data-cfg="delay" type="number" min="0" step="50" /> ms
        <span class="bpgEx-label">每</span><input class="bpgEx-input w60" data-cfg="batchSize" type="number" min="0" step="10" />
        <span class="bpgEx-label">次休息</span><input class="bpgEx-input w60" data-cfg="batchPause" type="number" min="0" step="500" /> ms
      </div>
      <div class="bpgEx-row">
        <span class="bpgEx-label">单页条数</span><input class="bpgEx-input w60" data-cfg="pageSize" type="number" min="10" max="100" />
        <span class="bpgEx-label">单请求超时</span><input class="bpgEx-input w60" data-cfg="reqTimeout" type="number" min="5000" max="120000" step="5000" /> ms
      </div>
      <div class="bpgEx-row">
        <span class="bpgEx-label">最大深度</span><input class="bpgEx-input w60" data-cfg="maxDepth" type="number" min="1" max="100" />
        <span class="bpgEx-label">最大翻页</span><input class="bpgEx-input w60" data-cfg="maxPages" type="number" min="1" max="2000" />
      </div>
      <div class="bpgEx-row">
        <span class="bpgEx-label">读取结构最大页数</span><input class="bpgEx-input w60" data-cfg="listShareMaxPages" type="number" min="1" max="500" />
        <span class="bpgEx-hint">「① 读取目录结构」最多翻几页群分享消息（每页 100 条）</span>
      </div>
      <div class="bpgEx-row">
        <label class="bpgEx-label"><input type="checkbox" data-cfg="includeDirs" /> 导出包含文件夹行</label>
      </div>
      <div class="bpgEx-note folded" data-note="scan">
        <div class="bpgEx-noteHead" data-act="toggleNote"><span class="bpgEx-noteTitle">扫描参数说明</span><span class="bpgEx-noteHint">请求间隔 / 单页条数 / 最大翻页 / 扫描速度 / 断点续抓 …</span><span class="bpgEx-noteBtn">展开</span></div>
        <div class="bpgEx-noteBody">
        <b>请求间隔</b>=每次接口请求前等待（防风控）；<b>每 N 次休息</b>=连续请求 N 次后改为长休息，避免高频；<b>单页条数</b>=每个目录一次抓多少条，<b>百度服务端硬上限 100</b>（填 1000 实测仍只返回 100），默认 100 最优。<br/>
        <b>单请求超时</b>=单次请求最长等待（浏览器 fetch 默认永不超时，超时会挂起）；<b>最大深度</b>=最多递归到第几层子目录；<b>最大翻页</b>=单个目录最多翻几页（100×300=3 万条/目录，触顶会告警为「可能不完整」）。<br/>
        <b>读取结构最大页数</b>=「① 读取目录结构」最多翻几页群分享消息。真机实测该接口忽略 page/start，只能用响应里的 <b>last_msg_time</b> 游标翻页；每页 100 条消息，页数不够会漏掉后面的共享目录，触顶时日志与第 3 栏都会告警。默认 20 页（约 2000 条消息），群消息很多时请调大。<br/>
        <b>导出包含文件夹行</b>=CSV/JSON 里是否列出文件夹本身；关闭后只输出文件行。<br/>
        默认限流已按账号安全设置，不建议把间隔调到 0；数字参数会自动钳制在合法范围，误填 0 不会导致静默漏抓。<br/>
        <b>扫描速度</b>=一键切换并发路数与请求间隔。倍数是「不含网络等待」的理论值，真实速度看第 4 栏「实测 请求/秒」。并发只作用于<b>不同目录之间</b>，单个目录的翻页仍严格串行；触发限流（errno 4/9013/31034/9019）时会自动降回单路并拉长间隔，不会硬扛风控。<br/>
        <b>断点续抓</b>=扫描每 30 秒且新增 40 个目录时，把进度压缩后存到 IndexedDB（不受本地 5MB 限制）。关页面 / 刷新 / 手动停止后，面板顶部会出现「继续上次扫描」，从剩余目录接着跑，<b>不会重扫已完成目录</b>。存的是文件明细与待办队列，不含任何登录令牌。<br/><b>内存护栏</b>=单次扫描达 <b>25 万条</b>明细会<b>自动暂停</b>，避免撑爆浏览器内存；此时先导出 CSV、清空结果，再分批勾选目录重扫。超过 30 万条的断点不会一次性恢复（会明确提示），JSON / 目录树 / 剪贴板在 5 万条以上也建议改用 CSV。
        </div>
      </div>
    </div></div>

    <div class="bpgEx-sec" id="bpgExTopDirSec"><div class="h">3. 选择导出目录 <span class="foldBtn" data-act="fold">收起</span></div><div class="c">
      <div class="bpgEx-row">
        <button class="bpgEx-btn primary" data-act="readStructure">① 读取目录结构</button>
        <span class="bpgEx-label">目标群 gid（可选）</span><input class="bpgEx-input w90" id="bpgEx-gid" placeholder="留空=当前浏览的群" />
      </div>
      <div id="bpgExDirCount" class="bpgEx-hint">点「① 读取目录结构」：读取完成后，这里会列出各共享目录，可勾选要导出的目录。</div>
      <div id="bpgExTopDirs"><div class="bpgEx-hint">点「① 读取目录结构」：读取完成后，这里会列出各共享目录，可勾选要导出的目录。</div></div>
      <div class="bpgEx-row">
        <button class="bpgEx-btn mini" data-act="dirAll">全选</button>
        <button class="bpgEx-btn mini" data-act="dirNone">清空</button>
      </div>
      <div class="bpgEx-note folded" data-note="dirs">
        <div class="bpgEx-noteHead" data-act="toggleNote"><span class="bpgEx-noteTitle">导出范围与操作流程</span><span class="bpgEx-noteHint">只导出勾选目录内部 · 先读结构再勾选 · 读取结构不清空结果</span><span class="bpgEx-noteBtn">展开</span></div>
        <div class="bpgEx-noteBody">勾选目录后，导出明细只包含这些目录内部的文件与子目录，<b>不含根目录下的条目</b>（同级的其它目录、顶层直接分享的文件）；若一个目录都不勾选，则只导出顶层直接分享的文件。流程：在「1. 选择群组」勾选要导出的群 → 点「① 读取目录结构」→ 在这里勾选要导出的目录 → 在下方「4. 执行与进度」点「② 开始扫描（边扫边写）」。扫描结束后按钮会恢复，可改勾选后直接重扫。读取结构只刷新本清单，不会清空下方结果。若脚本未能自动识别，可在上方手动填写群 gid。</div>
      </div>
    </div></div>

    <div class="bpgEx-sec"><div class="h">4. 执行与进度 <span class="foldBtn" data-act="fold">收起</span></div><div class="c">
      <div class="bpgEx-row">
        <button class="bpgEx-btn primary" data-act="autoStream" style="font-size:15px;padding:12px 16px;width:100%">② 开始扫描（边扫边写·自动存盘，整晚不用管）</button>
      </div>
      <div class="bpgEx-hint">点此按钮后，脚本会自动：读取目录结构 → 沿用你已勾选的目录（没勾选则自动全选）→ 让你选一个 CSV 保存位置 → 开始扫描。扫描时每几秒把结果追加写入<strong>同一个 CSV 文件</strong>并清空内存，不论总量多大都不会卡死；全部目录扫完自动保存关闭，整个过程无需再点确认。<strong>注意：浏览器规定「选保存位置」必须由你本人点一次</strong>（之后全自动）；建议保持百度网盘标签页在前台、不要最小化。<br/><strong>勾选规则：</strong>若你已在「3. 选择导出目录」里勾选了部分目录，只扫这些；若完全没勾选，才自动扫描全部共享目录。</div>
      <div class="bpgEx-row">
        <button class="bpgEx-btn" data-act="pause">暂停 / 继续</button>
        <button class="bpgEx-btn danger" data-act="stop">停止</button>
        <button class="bpgEx-btn" data-act="clear">清空结果</button>
        <button class="bpgEx-btn mini" data-act="probe">测试子目录接口</button>
      </div>
      <div class="bpgEx-bar"><i id="bpgEx-bar"></i></div>
      <div class="bpgEx-stat" id="bpgEx-progress"></div>
      <div class="bpgEx-cur" id="bpgEx-cur"></div>
    </div></div>

    <div class="bpgEx-sec"><div class="h">5. 导出文件明细 <span class="foldBtn" data-act="fold">收起</span></div><div class="c">
      <div class="bpgEx-row">
        <button class="bpgEx-btn primary" data-act="expCsv">导出 CSV (Excel)</button>
        <button class="bpgEx-btn" data-act="expJson">导出 JSON</button>
        <button class="bpgEx-btn" data-act="expTree">导出目录树 TXT</button>
        <button class="bpgEx-btn mini" data-act="copyCsv">复制 CSV</button>
      </div>
      <div class="bpgEx-row">
        <button class="bpgEx-btn" data-act="selfCheck">完整性自检（离线，秒出）</button>
      </div>
      <div id="bpgExVerify" class="bpgEx-status"></div>
      <div class="bpgEx-note folded" data-note="export">
        <div class="bpgEx-noteHead" data-act="toggleNote"><span class="bpgEx-noteTitle">结果校验与导出说明</span><span class="bpgEx-noteHint">每页 100 条无总数 · 完整性自检 · 路径列含义 · 文件名格式</span><span class="bpgEx-noteBtn">展开</span></div>
        <div class="bpgEx-noteBody">
        百度 shareinfo 接口<b>每页最多 100 条、只返回 has_more、不返回总数</b>，所以网页和接口都看不到「某文件夹共 1000 个文件」这个数字，只能翻页数完。<br/>
        <b>完整性自检</b>（不发任何请求，秒出）：核对是否被中断、队列是否残留、请求错误、重复 fs_id、是否触及最大翻页/深度、有多少目录未展开。这几项全过，翻页逻辑就没有漏抓的理由；<b>不需要重扫一遍</b>。<br/>
        <b>完整路径</b>列是相对本次共享目录的逻辑路径；<b>原始路径</b>列是分享者网盘里的原始完整路径（百度接口返回的是 URL 百分号编码，脚本已自动解码成中文，例如 <b>/书籍/读秀4.0/数据库25-1/xxx.zip</b>）。<br/>
        导出文件名格式：<b>群名称_文件夹名_时间_类型.扩展名</b>，例如 <b>音乐022_单曲2_20261108_204900_明细.csv</b>。多群或多目录时名称会缩写为「群A+群B等N群」「目录A+目录B等N个目录」。
        </div>
      </div>
      <div class="bpgEx-preview" id="bpgEx-preview"></div>
    </div></div>

    <div class="bpgEx-sec fold"><div class="h">6. 日志 <span class="foldBtn" data-act="fold">展开</span></div><div class="c">
      <div class="bpgEx-log" id="bpgEx-log"></div>
      <div class="bpgEx-row" style="margin-top:6px"><button class="bpgEx-btn mini" data-act="showRuns">扫描记录（历史台账）</button>
      <button class="bpgEx-btn mini" data-act="expReport">导出核对报告</button>
      <button class="bpgEx-btn mini" data-act="clearLog">清空日志</button>
      <button class="bpgEx-btn mini" data-act="copyLog">复制日志</button>
      <button class="bpgEx-btn mini" data-act="dumpDiag">复制诊断信息（排障用）</button></div>
      <div id="bpgEx-runs" class="bpgEx-status" style="display:none;margin-top:6px"></div>
    </div></div>

  </div>
</div>`;

    var el = {};

    function $(sel) { return document.querySelector(sel); }

    function addStyle() {
        var s = document.createElement('style');
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }

    function buildUI() {
        var wrap = document.createElement('div');
        wrap.innerHTML = UI_HTML;
        while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
        el.panel = $('#bpgEx-panel');
        el.body = el.panel && el.panel.querySelector('.bpgEx-body');
        el.launcher = $('#bpgEx-launcher');
        el.status = $('#bpgEx-status');
        el.progress = $('#bpgEx-progress');
        el.cur = $('#bpgEx-cur');
        el.bar = $('#bpgEx-bar');
        el.preview = $('#bpgEx-preview');
        el.logBox = $('#bpgEx-log');
        el.gidInput = $('#bpgEx-gid');
        el.groups = $('#bpgEx-groups');
        el.filter = $('#bpgEx-filter');
        el.addGid = $('#bpgEx-addGid');

        el.launcher.addEventListener('click', function (e) { e.preventDefault(); });
        el.panel.addEventListener('click', onClick);
        el.panel.addEventListener('change', onChange);
        if (el.gidInput) el.gidInput.addEventListener('change', function () { renderStatus(); });
        if (el.filter) el.filter.addEventListener('input', function () {
            state.groupFilter = el.filter.value.trim();
            renderGroups();
        });
        if (el.addGid) el.addGid.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addManualGroup(); } });
        syncCfgInputs();
        renderStatus(); renderGroups(); renderProgress(true); renderPreview(); renderLog(); renderTopDirs();
        renderResumeBanner();
        initPanelDnD();
        initLauncherDnD();
    }

    // 面板拖动 + 尺寸记忆：用鼠标/触摸拖动标题栏移动，右下角原生手柄缩放，位置与尺寸写入 localStorage
    function initPanelDnD() {
        var panel = el.panel;
        if (!panel) return;
        try {
            var saved = JSON.parse(localStorage.getItem(CFG_KEY + '.ui') || '{}');
            if (saved.left != null && saved.top != null) {
                panel.style.left = saved.left + 'px'; panel.style.top = saved.top + 'px';
                panel.style.right = 'auto'; panel.style.bottom = 'auto';
                // 防止保存的位置把面板推出视口（尤其头部被顶到屏外）
                var w = panel.offsetWidth || 430, h = panel.offsetHeight || 360;
                var L = parseFloat(panel.style.left), T = parseFloat(panel.style.top);
                if (L > window.innerWidth - 40 || T > window.innerHeight - 60 || L < -40) {
                    panel.style.left = Math.max(8, window.innerWidth - w - 18) + 'px';
                    panel.style.top = '12px';
                }
            }
            if (saved.width) panel.style.width = saved.width + 'px';
            if (saved.height) { panel.style.height = saved.height + 'px'; panel.style.maxHeight = saved.height + 'px'; }
        } catch (e) { }

        var hd = panel.querySelector('.bpgEx-hd');
        if (!hd) return;
        var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        hd.addEventListener('pointerdown', function (e) {
            if (e.target.closest('button')) return; // 标题栏上的按钮不触发拖拽
            dragging = true;
            var r = panel.getBoundingClientRect();
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
            panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
            sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
            document.body.style.userSelect = 'none';
            try { hd.setPointerCapture(e.pointerId); } catch (err) { }
            e.preventDefault();
        });
        hd.addEventListener('pointermove', function (e) {
            if (!dragging) return;
            var nx = ox + (e.clientX - sx);
            var ny = oy + (e.clientY - sy);
            nx = Math.max(4, Math.min(nx, window.innerWidth - panel.offsetWidth - 4));
            ny = Math.max(4, Math.min(ny, window.innerHeight - panel.offsetHeight - 4));
            panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
        });
        function endDrag() {
            if (!dragging) return;
            dragging = false; document.body.style.userSelect = ''; savePanelUI();
        }
        hd.addEventListener('pointerup', endDrag);
        hd.addEventListener('pointercancel', endDrag);

        if (typeof ResizeObserver !== 'undefined') {
            var ro = new ResizeObserver(function () { savePanelUI(); });
            ro.observe(panel);
        } else {
            panel.addEventListener('mouseup', savePanelUI);
        }
    }

    // 启动图标同样可拖动：拖动改变位置并记忆；未移动的轻点仍当作“展开/收起”面板
    function initLauncherDnD() {
        var lb = el.launcher;
        if (!lb) return;
        try {
            var s = JSON.parse(localStorage.getItem(CFG_KEY + '.launcher') || '{}');
            if (s.left != null && s.top != null) {
                lb.style.left = s.left + 'px'; lb.style.top = s.top + 'px';
                lb.style.right = 'auto'; lb.style.bottom = 'auto';
            }
        } catch (e) { }
        var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
        lb.addEventListener('pointerdown', function (e) {
            dragging = true; moved = false;
            var r = lb.getBoundingClientRect();
            lb.style.right = 'auto'; lb.style.bottom = 'auto';
            lb.style.left = r.left + 'px'; lb.style.top = r.top + 'px';
            sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
            document.body.style.userSelect = 'none';
            try { lb.setPointerCapture(e.pointerId); } catch (err) { }
            e.preventDefault();
        });
        lb.addEventListener('pointermove', function (e) {
            if (!dragging) return;
            var nx = ox + (e.clientX - sx);
            var ny = oy + (e.clientY - sy);
            if (Math.abs(e.clientX - sx) > 4 || Math.abs(e.clientY - sy) > 4) moved = true;
            nx = Math.max(0, Math.min(nx, window.innerWidth - lb.offsetWidth));
            ny = Math.max(0, Math.min(ny, window.innerHeight - lb.offsetHeight));
            lb.style.left = nx + 'px'; lb.style.top = ny + 'px';
        });
        function end() {
            if (!dragging) return;
            dragging = false; document.body.style.userSelect = '';
            if (moved) {
                try { localStorage.setItem(CFG_KEY + '.launcher', JSON.stringify({ left: lb.offsetLeft, top: lb.offsetTop })); } catch (e) { }
            } else {
                el.panel.classList.toggle('bpgEx-hide');
                if (!el.panel.classList.contains('bpgEx-hide')) renderStatus();
            }
        }
        lb.addEventListener('pointerup', end);
        lb.addEventListener('pointercancel', end);
    }
    function savePanelUI() {
        try {
            var panel = el.panel; if (!panel || panel.classList.contains('bpgEx-min')) return;
            var s = {
                left: parseFloat(panel.style.left) || null,
                top: parseFloat(panel.style.top) || null,
                width: panel.offsetWidth || null,
                height: panel.offsetHeight || null
            };
            localStorage.setItem(CFG_KEY + '.ui', JSON.stringify(s));
        } catch (e) { }
    }

    function syncCfgInputs() {
        el.panel.querySelectorAll('[data-cfg]').forEach(function (input) {
            var key = input.getAttribute('data-cfg');
            var v = key.indexOf('override.') === 0
                ? state.cfg.override[key.slice(9)]
                : state.cfg[key];
            if (input.type === 'checkbox') input.checked = !!v;
            else input.value = v === undefined ? '' : v;
        });
    }

    function setButtons() {
        if (!el.panel) return;
        var running = state.running;
        // 只要目录结构还在（已读取 / 扫描中 / 已扫完），「开始扫描」就应可用：
        // 扫描结束后保持可用，用户改勾选后可直接重扫，不必再读一次结构。
        var structureReady = state.phase === 'select' || state.phase === 'scanning' || state.phase === 'done';
        var read = el.panel.querySelector('[data-act="readStructure"]');
        if (read) read.disabled = running;
        var auto = el.panel.querySelector('[data-act="autoStream"]');
        if (auto) auto.disabled = running;
        var pause = el.panel.querySelector('[data-act="pause"]');
        if (pause) {
            pause.disabled = !running;
            pause.textContent = state.paused ? '继续' : '暂停 / 继续';
        }
        // 停止 / 清空结果 / 测试子目录接口：只在任务进行中或空闲时给出正确可用状态
        el.panel.querySelectorAll('[data-act="stop"]').forEach(function (b) { b.disabled = !running; });
        el.panel.querySelectorAll('[data-act="probe"]').forEach(function (b) { b.disabled = running; });
        el.panel.querySelectorAll('[data-act="clear"]').forEach(function (b) { b.disabled = running; });
        el.panel.querySelectorAll('[data-act="selfCheck"]').forEach(function (b) {
            b.disabled = running;
        });
        el.panel.querySelectorAll('[data-act="resume"],[data-act="discardSnap"]').forEach(function (b) {
            b.disabled = running;
        });
    }

    function renderGroups() {
        if (!el.groups) return;
        var list = state.groups.filter(function (g) {
            return !state.groupFilter || g.name.indexOf(state.groupFilter) >= 0 || g.gid.indexOf(state.groupFilter) >= 0;
        });
        if (!state.groups.length) {
            el.groups.innerHTML = '<div class="bpgEx-status">尚未读取群组列表，点击上方「刷新群组」或「从左侧读取」。</div>';
            return;
        }
        if (!list.length) {
            el.groups.innerHTML = '<div class="bpgEx-status">没有匹配的群组（搜索词：' + esc(state.groupFilter) + '）。</div>';
            return;
        }
        var cur = state.cap.currentGid || state.cap.activeGid;
        el.groups.innerHTML = list.map(function (g) {
            var key = g.gid || ('side:' + g.name);
            var checked = state.selected.has(key) ? ' checked' : '';
            var isCur = (g.gid && g.gid === cur) ? ' bpgEx-cur' : '';
            var gidTxt = g.gid ? (g.gid.slice(0, 12) + '…') : '（从左侧读取）';
            return '<label class="bpgEx-group' + isCur + '"><input type="checkbox" data-key="' + esc(key) + '"' + checked + '/>' +
                '<span class="gname" title="' + esc(g.name) + '">' + esc(g.name) + '</span>' +
                '<span class="gid">' + esc(gidTxt) + '</span></label>';
        }).join('');
        el.groups.querySelectorAll('input[data-key]').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var key = cb.getAttribute('data-key');
                if (cb.checked) state.selected.add(key); else state.selected.delete(key);
                renderStatus();
            });
        });
    }

    function renderStatus() {
        if (!el.status) return;
        var token = detectBdstoken();
        var gid = state.cap.currentGid || state.cap.activeGid;
        var gname = gid ? groupNameById(gid) : '';
        var onGroup = !!gid;
        var viewTxt = gname ? esc(gname) : (onGroup ? '群/分享上下文' : '未识别当前群');
        el.status.innerHTML =
            '当前群：<b>' + viewTxt + '</b> <span class="' + (onGroup ? 'ok' : 'warn') + '">' +
            (onGroup ? '✓ 已识别' : '（进入某群「群文件」后自动识别）') + '</span><br/>' +
            '登录令牌：<span class="' + (token ? 'ok' : 'warn') + '">' + (token ? '已检测' : '未检测') + '</span>　' +
            '群 gid：<b>' + (gid ? esc(gid) : '—') + '</b><br/>' +
            '已选 <b>' + state.selected.size + '</b> / ' + state.groups.length + ' 个群组，结果 <b>' + state.records.length + '</b> 条' +
            (state.phase === 'done' || state.phase === 'scanning'
                ? '<br/>结果完整性：' + (state.incomplete
                    ? '<span class="warn">⚠ 不完整（剩 ' + state.queue.length + ' 个目录未展开）</span>'
                    : (state.running ? '<span class="warn">扫描中…</span>' : '<span class="ok">✓ 队列已清空、无错误</span>'))
                : '');
    }

    var lastRender = 0;
    function renderProgressThrottled() {
        var now = Date.now();
        if (now - lastRender > 250) { lastRender = now; renderProgress(false); }
    }

    function renderProgress(force) {
        if (!el.progress) return;
        var total = state.records.length;
        var pending = state.queue.length;
        var sec = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
        var pct = state.running && pending > 0
            ? Math.min(99, Math.round(state.scannedDirs / (state.scannedDirs + pending) * 100))
            : (total ? 100 : 0);
        el.bar.style.width = pct + '%';
        el.progress.innerHTML =
            '<b>' + total + '</b> 条记录　文件 <b>' + state.stats.files + '</b>　目录 <b>' + state.stats.dirs + '</b>　' +
            '合计 <b>' + fmtSize(state.stats.bytes) + '</b><br/>' +
            '已展开目录 <b>' + state.scannedDirs + '</b>　待处理 <b>' + pending + '</b>　请求 <b>' + state.reqCount + '</b>　' +
            '耗时 <b>' + sec + 's</b>　错误 <b>' + state.errors.length + '</b><br/>' +
            '速度：<b>' + speedLabel() + '</b>　并发 <b>' +
            (state.eff.slow ? 1 : workerCount()) + '</b>　实测 <b>' +
            (sec > 0 ? (state.reqCount / sec).toFixed(1) : '0') + '</b> 请求/秒' +
            (state.eff.slow ? ' <span class="warn">（已自动降速）</span>' : '') + '<br/>' +
            '状态：<b>' + (state.running
                ? (state.paused ? '已暂停' : (state.currentReq ? '请求中…' : '运行中'))
                : (state.phase === 'select'
                    ? (state.structureRead
                        ? (state.structureError ? '⚠ 未选择目标群 / 读取失败'
                            : (state.topDirs.length ? '结构已读取，待勾选扫描' : '结构已读取（本群无共享文件夹）'))
                        : '读取目录结构中…')
                    : (state.phase === 'done' ? (state.incomplete ? '⚠ 未完成（结果不完整）' : '已完成（完整）') : '空闲'))) + '</b>';
        if (state.phase === 'select' && state.structurePages) {
            el.progress.innerHTML += '<br/>结构读取进度：<b>' + state.structurePages + '</b> 页 / <b>' +
                state.structureMsgs + '</b> 条分享消息' + (state.structureIncomplete ? ' <span class="warn">（可能未读完）</span>' : '');
        }
        if (!state.currentReq) {
            var last = state.logs.length ? state.logs[state.logs.length - 1].msg : '';
            el.cur.textContent = last;
        }
        updateDirCount();
        if (force) renderPreview();
    }

    function renderPreview() {
        if (!el.preview) return;
        // 预览只要前 100 条：不要对全量 filter（百万级会白白生成百万元素数组）
        var rows = [];
        var scoped = state.phase === 'done' && state.selectedDirs && state.selectedDirs.size > 0;
        for (var ri = 0; ri < state.records.length && rows.length < 100; ri++) {
            var rr = state.records[ri];
            if (scoped && rr.depth <= 1) continue;
            if (!state.cfg.includeDirs && rr.isDir) continue;
            rows.push(rr);
        }
        if (!rows.length) {
            el.preview.innerHTML = '<div class="bpgEx-status" style="padding:8px">扫描后这里会显示前 100 条结果预览。</div>';
            return;
        }
        var head = '<tr><th>#</th><th>类型</th><th>文件名</th><th>路径</th><th>大小</th></tr>';
        var body = rows.slice(0, 100).map(function (r) {
            return '<tr><td>' + r.idx + '</td><td>' + (r.isDir ? '目录' : '文件') + '</td><td title="' +
                esc(r.name) + '">' + esc(r.name) + '</td><td title="' + esc(r.path) + '">' + esc(r.path) +
                '</td><td>' + (r.isDir ? '-' : fmtSize(r.size)) + '</td></tr>';
        }).join('');
        el.preview.innerHTML = '<table class="bpgEx-table">' + head + body + '</table>' +
            (state.records.length > 100 ? '<div class="bpgEx-status" style="padding:5px">仅预览前 100 条，共 ' + state.records.length + ' 条。</div>' : '');
    }

    function renderLog() {
        if (!el.logBox) return;
        el.logBox.innerHTML = state.logs.slice(-80).map(function (l) {
            return '<div class="' + (l.level === 'error' ? 'e' : l.level === 'warn' ? 'w' : '') + '">' +
                esc(l.t) + ' ' + esc(l.msg) + '</div>';
        }).join('');
        el.logBox.scrollTop = el.logBox.scrollHeight;
    }

    function copyText(text, tip) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { log(tip || '已复制到剪贴板'); })
                .catch(function () { fallbackCopy(text, tip); });
        } else fallbackCopy(text, tip);
    }
    function fallbackCopy(text, tip) {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); log(tip || '已复制到剪贴板'); }
        catch (e) { log('复制失败，请改用导出文件', 'warn'); }
        ta.remove();
    }

    function diagnosis() {
        return JSON.stringify({
            version: VERSION,
            url: location.href,
            time: new Date().toISOString(),
            bdstoken: detectBdstoken(),
            cookieBduss: !!getCookie('BDUSS'),
            cap: {
                hits: state.cap.hits,
                common: state.cap.common,
                templates: state.cap.templates,
                currentGid: state.cap.currentGid
            },
            cfg: state.cfg,
            methods: { shareinfo: state.methodShareinfo, listshare: state.methodListshare },
            currentReq: state.currentReq,
            stats: { records: state.records.length, scannedDirs: state.scannedDirs, errors: state.errors },
            errors: state.errors.slice(0, 30),
            logs: state.logs.slice(-60)
        }, null, 2);
    }

    // 兜底：任何 async 动作若抛出未捕获异常，必须给出可见日志并复位状态，
    // 否则 state.running 会一直为 true，界面表现就是「按钮全灰、点了没反应」。
    function safeAsync(p, label) {
        Promise.resolve(p).catch(function (e) {
            var msg = (e && e.message) ? e.message : String(e);
            log('⚠ ' + label + '出现未捕获异常：' + msg + '（已自动复位按钮状态）', 'error');
            state.running = false; state.paused = false;
            stopHeartbeat();
            setButtons(); renderStatus(); renderProgress(true); renderTopDirs();
        });
    }

    /* ============================================================
     * 全自动边扫边写（流式单文件，整晚无人值守）
     * ------------------------------------------------------------
     * 点一次按钮（真人手势触发 showSaveFilePicker），脚本自动：
     *   读取目录结构 → 沿用你已勾选的目录(若未勾选则自动勾选全部) → 开扫 → 每数秒把明细追加写入
     *   同一个 CSV 文件并清空内存 → 扫完自动关闭。无论总量多大都不会因
     *   内存爆掉而崩（采集层持续 drain，内存峰值恒定在 MEM_GUARD 量级）。
     * 浏览器硬性限制：showSaveFilePicker 必须由真人点击触发，无法脚本代点，
     *   所以「选保存位置」这一步需本人点一次，之后全自动、无需任何确认。
     * 安全：每 2 万行做一次检查点（close+以 keepExistingData 重新打开并
     *   seek 到末尾），标签页意外关闭最多丢一个检查点（<2 万行），非整文件。
     * ============================================================ */
    var streamActive = false;
    /* ---------- 流式文件句柄持久化：支持关页后「继续上次扫描」续写同一份 CSV ---------- */
    var STREAM_KEY = 'stream:handle';
    var streamMeta = null;   // { handle, fileName, writtenRows, startedAt }
    function persistStreamHandle(handle) {
        streamMeta = { handle: handle, fileName: (handle && handle.name) || '', writtenRows: 0, startedAt: Date.now() };
        idbPutKey(RUN_STORE, STREAM_KEY, streamMeta);
    }
    function updateStreamWritten(n) {
        if (!streamMeta) return;
        streamMeta.writtenRows = n;
        idbPutKey(RUN_STORE, STREAM_KEY, streamMeta);
    }
    function loadStreamHandle() {
        return idbGetKey(RUN_STORE, STREAM_KEY).then(function (m) { return (m && m.handle) ? m : null; });
    }
    function clearStreamHandle() {
        streamMeta = null;
        idbDelKey(RUN_STORE, STREAM_KEY);
    }

    // 尝试把中断的「全自动边扫边写」恢复到同一份文件：重新授权 → 以追加方式重开 → 续扫。
    // 返回 true 表示已接上流式写盘；false 表示应回退为普通内存续扫。
    async function tryAttachResumeStream(snap) {
        if (!window.showSaveFilePicker) return false;
        // 优先：用上次持久化的句柄静默续写（已授权则零弹窗）
        var meta = await loadStreamHandle();
        if (meta && meta.handle) {
            var writable = null;
            try {
                writable = await meta.handle.createWritable({ keepExistingData: true });
            } catch (e) {
                var needPerm = (e && e.name) === 'NotAllowedError' || /permission|notallowed/i.test((e && e.message) || '');
                if (needPerm) {
                    try {
                        var perm = await meta.handle.requestPermission({ mode: 'readwrite' });
                        if (perm === 'granted') { try { writable = await meta.handle.createWritable({ keepExistingData: true }); } catch (_) { writable = null; } }
                    } catch (_) { writable = null; }
                }
            }
            if (writable) {
                try {
                    await attachStreamWriter(meta.handle, { resume: true, initialWrittenRows: meta.writtenRows || 0, fileName: meta.fileName, writable: writable });
                    return true;
                } catch (e) {
                    try { writable.close(); } catch (_) { }
                    log('⚠ 续写原文件失败：' + (e && e.message || e) + '，尝试改用重新选择文件续写。', 'warn');
                }
            }
        }
        // 兜底：句柄不可用（被清 / 权限丢失 / 跨会话失效）→ 让用户重新选一次【原文件】，继续边扫边写。
        // 选同一个 CSV 即可从断点续写（脚本会自动截掉未写完的半行再追加），不会重扫已完成目录。
        log('未找到可静默续写的文件句柄（可能权限被清或跨会话失效）。请在弹出的保存框中选择【原来的那个 CSV 文件】，即可从断点继续边扫边写（只需这一次）。', 'warn');
        var handle;
        try {
            handle = await window.showSaveFilePicker({
                suggestedName: safeName((snap && snap.fileName) || ((state.cap.currentGid ? groupNameById(state.cap.currentGid) : '群文件') + '_全量_流式_续写.csv')),
                types: [{ description: 'CSV 明细', accept: { 'text/csv': ['.csv'] } }]
            });
        } catch (e) {
            log('已取消选择文件，无法续写原 CSV，已回退为普通续扫（结果存内存，扫完请点「导出 CSV」）。', 'warn');
            return false;
        }
        persistStreamHandle(handle);
        await attachStreamWriter(handle, { resume: true, initialWrittenRows: 0, fileName: handle.name });
        return true;
    }

    async function streamEnable() {
        if (streamActive) { log('全自动边扫边写已在进行中', 'warn'); return; }
        if (state.running) { log('请先停止当前任务，或等待其结束后再开始全自动模式', 'warn'); return; }
        if (!window.showSaveFilePicker) {
            log('⚠ 当前浏览器不支持 File System Access API（需 Edge/Chrome 桌面版、且页面为 HTTPS 或 localhost），无法使用边扫边写模式；请换用受支持的浏览器，或改用其它手动导出方式。', 'error');
            return;
        }
        log('全自动边扫边写：先自动读取当前群的目录结构…', 'info');
        if (!state.structureRead || state.topDirs.length === 0) {
            await readStructure();
        }
        if (state.topDirs.length === 0) {
            log('⚠ 未读到任何共享目录：请确认你正停留在目标群的「群文件」页面、且该群确有共享文件夹；或在「1. 选择群组」勾选目标群后重试。', 'error');
            return;
        }
        // 尊重用户手动勾选：若已在「选择导出目录」勾选了部分目录，则只扫这些；
        // 若未勾选任何目录，才自动勾选全部（并跳过 fsId 相同的重复分享）。
        var seenFs = new Set(), cids = [];
        if (state.selectedDirs.size > 0) {
            state.topDirs.forEach(function (d) {
                if (!state.selectedDirs.has(d.cid)) return;
                var fs = d.fsId || d.fs_id || '';
                if (seenFs.has(fs)) return;            // 同一目录被多次分享时只取一条
                seenFs.add(fs); cids.push(d.cid);
            });
            state.selectedDirs = new Set(cids);        // 用去重后的集合，避免同一目录扫两次
            log('全自动：沿用你已勾选的 ' + cids.length + ' 个目录（已去掉重复分享）。接下来请在系统保存框选择 CSV 保存位置（只需这一次）。', 'info');
        } else {
            state.topDirs.forEach(function (d) {
                var fs = d.fsId || d.fs_id || '';
                if (seenFs.has(fs)) return;
                seenFs.add(fs); cids.push(d.cid); state.selectedDirs.add(d.cid);
            });
            log('全自动：未勾选目录，已自动勾选全部 ' + cids.length + ' 个共享目录（已跳过重复分享）。接下来请在系统保存框选择 CSV 保存位置（只需这一次）。', 'info');
        }
        renderTopDirs();
        var handle;
        try {
            handle = await window.showSaveFilePicker({
                suggestedName: safeName((state.cap.currentGid ? groupNameById(state.cap.currentGid) : '群文件') + '_全量_流式_' + stamp() + '.csv'),
                types: [{ description: 'CSV 明细', accept: { 'text/csv': ['.csv'] } }]
            });
        } catch (e) {
            log('已取消保存（未选择文件，全自动模式未启动）。', 'warn');
            state.selectedDirs.clear(); renderTopDirs();
            return;
        }
        persistStreamHandle(handle);   // 持久化句柄，供意外关页后「继续上次扫描」续写同一份 CSV
        await startStreamWriter(handle, cids);
    }

    // 挂接流式写盘：resume=false 全新（写表头）；resume=true 续写（保留数据、截掉可能的半行后追加）
    // 注意：本函数只负责写盘，扫描由调用方（startScan / streamEnable）负责启动。
    async function attachStreamWriter(handle, opts) {
        opts = opts || {};
        var resume = !!opts.resume;
        var writer;
        if (!resume) {
            writer = await handle.createWritable();
            await writer.write('\uFEFF' + CSV_HEAD.map(csvCell).join(',') + '\r\n');
        } else {
            // 续写：保留磁盘已有内容，重新打开后截掉最后一个可能未落盘的半行，再从完整行末追加
            var f0 = await handle.getFile();
            var size0 = f0.size;
            // 若调用方已预先取得可写流（已在无权限时提前申请过授权），则复用，避免再次触发权限弹窗
            writer = opts.writable || await handle.createWritable({ keepExistingData: true });
            var cut = size0;
            try {
                var tailLen = Math.min(size0, 8192);
                var ab = await f0.slice(size0 - tailLen).arrayBuffer();
                var bytes = new Uint8Array(ab);
                for (var i = bytes.length - 1; i >= 1; i--) {
                    if (bytes[i - 1] === 0x0D && bytes[i] === 0x0A) { cut = (size0 - tailLen) + i + 1; break; }
                }
                if (cut < size0) {
                    await writer.truncate(cut);
                    log('全自动续写：检测到上次可能未写完的最后一行，已安全截去 ' + (size0 - cut) + ' 字节，从完整行末尾续写。', 'info');
                }
            } catch (e) { /* 截断失败则直接追加，风险极低 */ }
            await writer.seek(cut);
        }
        state.streamDraining = true;
        streamActive = true;
        state.stream = { active: true, handle: handle, startedAt: Date.now(), writtenRows: opts.initialWrittenRows || 0 };
        var seq = (opts.initialWrittenRows || 0) + 1, rowsSinceCkpt = 0, finished = false, closing = false;
        var ledger = {
            startedAt: Date.now(),
            file: (opts.fileName || (handle && handle.name) || ''),
            writtenRows: opts.initialWrittenRows || 0,
            checkpoints: 0, errors: []
        };
        var chain = Promise.resolve();
        var box = makeStreamBox();
        function enqueue(fn) { chain = chain.then(fn).catch(function (e) { ledger.errors.push(String((e && e.message) || e)); }); return chain; }
        function rowText(r) {
            return [seq++, r.groupName, r.gid, r.msgId, r.shareUname, r.depth,
                r.isDir ? '文件夹' : '文件', r.name, r.path, r.parent,
                r.size, fmtSize(r.size), r.category, r.md5, r.fsId,
                fmtTime(r.ctime), fmtTime(r.mtime), r.rawPath
            ].map(csvCell).join(',') + '\r\n';
        }
        function drain() {
            if (!state.records.length) return 0;
            var batch = state.records.slice();
            state.records.length = 0;
            try { state.seen.clear(); } catch (e) { }
            state.stats.files = 0; state.stats.dirs = 0; state.stats.bytes = 0;
            var rows = state.cfg.includeDirs ? batch : batch.filter(function (r) { return !r.isDir; });
            if (!rows.length) return 0;
            var text = rows.map(rowText).join('');
            enqueue(function () { return writer.write(text); });
            ledger.writtenRows += rows.length; rowsSinceCkpt += rows.length;
            updateStreamWritten(ledger.writtenRows);
            if (rowsSinceCkpt >= 20000) checkpoint();
            // 流式模式：若采集层被护栏软暂停，内存已清空则自动恢复继续扫
            if (state.streamDraining && state.paused) state.paused = false;
            return rows.length;
        }
        function checkpoint() {
            if (!writer || !handle || closing) return;
            rowsSinceCkpt = 0;
            enqueue(async function () {
                await writer.close();
                var f = await handle.getFile();
                writer = await handle.createWritable({ keepExistingData: true });
                await writer.seek(f.size);
                ledger.checkpoints++;
            });
            updateStreamWritten(ledger.writtenRows);
        }
        function closeFile(finish) {
            if (!writer) {
                if (finish) { streamActive = false; state.streamDraining = false; state.stream = null; clearStreamHandle(); }
                return;
            }
            closing = true;
            enqueue(async function () {
                await writer.close();
                writer = null;
                if (finish) { streamActive = false; state.streamDraining = false; state.stream = null; clearStreamHandle(); ledger.finishedAt = Date.now(); finished = true; }
                closing = false;
                paint();
            });
        }
        function dirName(cid) {
            var d = (state.topDirs || []).filter(function (x) { return x.cid === cid; })[0];
            return d ? d.name : cid;
        }
        function paint() {
            if (!box) return;
            if (finished) {
                box.btn.textContent = '✓ 全自动边扫边写已完成';
                box.btn.style.background = '#52c41a';
                box.tip.innerHTML = '共写入 <b>' + ledger.writtenRows + '</b> 行到：<br/>' + esc(ledger.file) +
                    '<br/>检查点 ' + ledger.checkpoints + ' 次，错误 ' + ledger.errors.length + ' 个。文件已保存，可关闭本页。';
            } else {
                box.btn.textContent = '⏳ 全自动边扫边写进行中…';
                box.btn.style.background = '#1677ff';
                var st = state.running ? (state.paused ? '软暂停(自动恢复)' : '扫描中') : (state.phase === 'done' ? '收尾中' : '准备中');
                box.tip.innerHTML = '文件：<br/>' + esc(ledger.file) +
                    '<br/>已写 <b>' + ledger.writtenRows + '</b> 行　状态：' + st +
                    '　队列剩 <b>' + state.queue.length + '</b>　已展开 <b>' + state.scannedDirs + '</b>　请求 <b>' + state.reqCount + '</b>' +
                    (ledger.errors.length ? '<br/>⚠ 错误 ' + ledger.errors.length + ' 个' : '');
            }
        }
        function tick() {
            if (finished || closing) return;
            try {
                if (state.running && state.phase === 'scanning') {
                    drain();
                } else if (!state.running && state.phase === 'done' && !finished) {
                    drain();
                    finished = true;
                    clearInterval(timer);
                    closeFile(true);
                    log('=== 全自动边扫边写完成：共写入 ' + ledger.writtenRows + ' 行到 ' + ledger.file +
                        '，检查点 ' + ledger.checkpoints + ' 次，请求 ' + state.reqCount + ' 次，错误 ' + ledger.errors.length +
                        ' 个，耗时 ' + Math.round((Date.now() - ledger.startedAt) / 1000) + 's ===', 'info');
                }
                paint();
            } catch (e) { ledger.errors.push(String((e && e.message) || e)); }
        }
        var timer = setInterval(tick, 3000);
        paint();
        if (!resume) {
            log('全自动：已打开文件 ' + handle.name + '，开始扫描并边扫边写（保持此标签页在前台）。', 'info');
            // 标签页意外关闭时尽量 flush 最后一次写入
            function onHide() { if (writer) { try { writer.close(); } catch (e) { } } }
            window.addEventListener('pagehide', onHide);
        } else {
            log('全自动：已重新授权并接上原文件「' + ledger.file + '」，从断点继续扫描并落盘。', 'info');
        }
    }

    async function startStreamWriter(handle, cids) {
        await attachStreamWriter(handle, { resume: false });
        safeAsync(startScan(false), '全自动扫描');
    }

    function makeStreamBox() {
        // 避免多次启动扫描时叠加多个浮窗：创建前先移除旧实例
        try { var oldBox = document.querySelector('div[style*="2147483646"]'); if (oldBox && oldBox.parentNode) oldBox.parentNode.removeChild(oldBox); } catch (e) { }
        var box = document.createElement('div');
        box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;font:13px/1.5 system-ui,sans-serif;max-width:320px;cursor:move;user-select:none;-webkit-user-select:none;touch-action:none';
        var btn = document.createElement('button');
        // 关键：按钮本身不接收鼠标/指针事件（pointer-events:none），事件直接穿透到外层 box，
        // 这样即使按钮被「禁用」外观，按在按钮这一大块区域上也能正常触发 box 的拖动。
        btn.style.cssText = 'padding:10px 14px;background:#1677ff;color:#fff;border:0;border-radius:8px;font-size:13px;cursor:move;box-shadow:0 2px 10px rgba(0,0,0,.25);width:100%;user-select:none;-webkit-user-select:none;pointer-events:none;touch-action:none';
        var tip = document.createElement('div');
        tip.style.cssText = 'margin-top:6px;background:#fff;border:1px solid #ddd;border-radius:6px;padding:7px 9px;color:#333;box-shadow:0 2px 8px rgba(0,0,0,.12);user-select:none;-webkit-user-select:none';
        box.appendChild(btn); box.appendChild(tip);
        document.body.appendChild(box);
        // 恢复上次记忆的位置（若有），避免每次都挡在角落
        try {
            var pos = JSON.parse(localStorage.getItem(CFG_KEY + '.streamBoxPos') || 'null');
            if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
                box.style.left = pos.left + 'px';
                box.style.top = pos.top + 'px';
                box.style.right = 'auto';
                box.style.bottom = 'auto';
            }
        } catch (e) { }
        // 拖动：在浮窗任意位置（含「全自动边扫边写」这一行）按下即可拖动，并记住位置。
        // 使用 Pointer Events + setPointerCapture：即使指针移出浮窗或移得很快，move/up 仍会
        // 准确派发到 box，不会被页面其它元素吞掉；也不受按钮 disabled 影响。
        (function () {
            var sx, sy, ox, oy, dragging = false;
            box.addEventListener('pointerdown', function (e) {
                dragging = true;
                var rect = box.getBoundingClientRect();
                box.style.left = rect.left + 'px';
                box.style.top = rect.top + 'px';
                box.style.right = 'auto';
                box.style.bottom = 'auto';
                sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top;
                try { box.setPointerCapture(e.pointerId); } catch (err) { }
                e.preventDefault();
            });
            box.addEventListener('pointermove', function (e) {
                if (!dragging) return;
                var nx = Math.max(0, Math.min(ox + (e.clientX - sx), window.innerWidth - box.offsetWidth));
                var ny = Math.max(0, Math.min(oy + (e.clientY - sy), window.innerHeight - box.offsetHeight));
                box.style.left = nx + 'px';
                box.style.top = ny + 'px';
            });
            function endDrag(e) {
                if (!dragging) return;
                dragging = false;
                try { if (e && e.pointerId != null) box.releasePointerCapture(e.pointerId); } catch (err) { }
                try { localStorage.setItem(CFG_KEY + '.streamBoxPos', JSON.stringify({ left: parseInt(box.style.left, 10), top: parseInt(box.style.top, 10) })); } catch (e2) { }
            }
            box.addEventListener('pointerup', endDrag);
            box.addEventListener('pointercancel', endDrag);
        })();
        return { box: box, btn: btn, tip: tip };
    }

    // 说明块折叠状态：默认全部收起，展开过的按 data-note 记住，刷新后保持
    var NOTE_KEY = CFG_KEY + '.notes';
    function noteList() {
        return (el.panel && el.panel.querySelectorAll) ? el.panel.querySelectorAll('.bpgEx-note[data-note]') : [];
    }
    function loadNoteState() {
        try {
            var m = JSON.parse(localStorage.getItem(NOTE_KEY) || '{}');
            Array.prototype.forEach.call(noteList(), function (n) {
                var open = !!m[n.getAttribute('data-note')];
                n.classList.toggle('folded', !open);
                var b = n.querySelector('.bpgEx-noteBtn');
                if (b) b.textContent = open ? '收起' : '展开';
            });
        } catch (e) { }
    }
    function saveNoteState() {
        try {
            var m = {};
            Array.prototype.forEach.call(noteList(), function (n) {
                if (!n.classList.contains('folded')) m[n.getAttribute('data-note')] = 1;
            });
            localStorage.setItem(NOTE_KEY, JSON.stringify(m));
        } catch (e) { }
    }

    function onClick(e) {
        var t = e.target.closest('[data-act]');
        if (!t) return;
        var act = t.getAttribute('data-act');
        e.preventDefault();
        switch (act) {
            case 'hide': el.panel.classList.add('bpgEx-hide'); break;
            case 'min': el.panel.classList.toggle('bpgEx-min'); break;
            case 'fold': {
                var sec = t.closest('.bpgEx-sec');
                sec.classList.toggle('fold');
                t.textContent = sec.classList.contains('fold') ? '展开' : '收起';
                break;
            }
            case 'toggleNote': {
                var note = t.closest('.bpgEx-note');
                if (!note) break;
                note.classList.toggle('folded');
                var nb = note.querySelector('.bpgEx-noteBtn');
                if (nb) nb.textContent = note.classList.contains('folded') ? '展开' : '收起';
                saveNoteState();
                break;
            }
            case 'readStructure': safeAsync(readStructure(), '读取目录结构'); break;
            case 'loadGroups': safeAsync(loadGroupsAction(true, 'api'), '刷新群组'); break;
            case 'scrapeSidebar': safeAsync(loadGroupsAction(true, 'sidebar'), '从左侧读取群组'); break;
            case 'selectAll': state.groups.forEach(function (g) { state.selected.add(g.gid || ('side:' + g.name)); }); renderGroups(); renderStatus(); break;
            case 'selectNone': state.selected.clear(); renderGroups(); renderStatus(); break;
            case 'selectCurrent':
                if (!state.cap.currentGid && !state.cap.activeGid) { log('尚未识别当前群，请先点开一个群文件页面', 'warn'); break; }
                state.selected.clear();
                state.selected.add(state.cap.currentGid || state.cap.activeGid);
                if (!state.groups.some(function (g) { return g.gid === (state.cap.currentGid || state.cap.activeGid); })) {
                    state.groups.push({ gid: state.cap.currentGid || state.cap.activeGid, name: groupNameById(state.cap.currentGid || state.cap.activeGid) || state.cap.activeView || '当前群', uk: '', uname: '', count: 0 });
                    saveGroups();
                }
                renderGroups(); renderStatus(); break;
            case 'addGroup': addManualGroup(); break;
            case 'startScan': safeAsync(startScan(), '开始扫描'); break;
            case 'autoStream': safeAsync(streamEnable(), '全自动边扫边写'); break;
            case 'resume': safeAsync(startScan(true), '继续上次扫描'); break;
            case 'discardSnap': clearSnapshot(); log('已丢弃上次未完成的扫描进度'); break;
            case 'dirAll': state.topDirs.forEach(function (d) { state.selectedDirs.add(d.cid); }); renderTopDirs(); break;
            case 'dirNone': state.selectedDirs.clear(); renderTopDirs(); break;
            case 'probe': if (!state.running) safeAsync(probeShareInfo(), '测试子目录接口'); else log('扫描进行中，请先停止', 'warn'); break;
            case 'pause': state.paused = !state.paused; setButtons(); renderProgress(true); log(state.paused ? '已暂停' : '已继续'); break;
            case 'stop': state.aborted = true; state.paused = false; setButtons(); log('已请求停止（当前请求结束后生效）', 'warn'); break;
            case 'clear':
                clearSnapshot();
                state.records = []; state.seen.clear(); state.queue = [];
                state.errors = []; state.stats = { files: 0, dirs: 0, bytes: 0 };
                state.scannedDirs = 0; state.reqCount = 0; state.startedAt = 0;
                state.scannedFsIds = new Set(); state.truncated = { pages: 0, depth: 0 };
                state.incomplete = false; state.aborted = false;
                renderVerifyReport('');
                // 目录结构仍在时可立即重扫；没有结构则必须先「读取目录结构」
                state.phase = state.topItems.length ? 'select' : 'idle';
                log('已清空结果'); setButtons(); renderProgress(true); renderPreview(); renderStatus(); break;
            case 'selfCheck': if (!state.running) safeAsync(selfCheck(), '完整性自检'); break;
            case 'expCsv': doExport('csv'); break;
            case 'expJson': doExport('json'); break;
            case 'expTree': doExport('tree'); break;
            case 'copyCsv': doExport('copyCsv'); break;
            case 'dumpDiag': copyText(diagnosis(), '诊断信息已复制（粘贴给技术支持时请注意隐去令牌中的账号信息）'); break;
            case 'clearLog': state.logs = []; renderLog(); break;
            case 'copyLog': copyText(state.logs.map(function (l) { return l.t + ' ' + l.msg; }).join('\n'), '日志已复制'); break;
            case 'showRuns': showRuns(); break;
            case 'hideRuns': { var rb = el.panel.querySelector('#bpgEx-runs'); if (rb) rb.style.display = 'none'; break; }
            case 'clearRuns': clearRuns(); break;
            case 'runView': viewRun(t.getAttribute('data-runid')); break;
            case 'runReport': exportRunReport(t.getAttribute('data-runid')); break;
            case 'expReport': exportRunReport(null); break;
        }
    }

    function onChange(e) {
        var input = e.target.closest('[data-cfg]');
        if (!input) return;
        var key = input.getAttribute('data-cfg');
        var isNum = /^(delay|batchSize|batchPause|pageSize|maxPages|maxDepth|reqTimeout|listShareMaxPages)$/.test(key);
        var val = input.type === 'checkbox' ? input.checked
            : (isNum ? clampCfg(key, input.value) : input.value);
        if (isNum && num(input.value) !== val) input.value = val;   // 回写钳制结果，避免界面与生效值不一致
        if (key === 'speed') {
            applySpeedPreset(val);
            syncCfgInputs();   // 档位会覆盖 delay / batchPause 等输入框，回写保持一致
            log('扫描速度已切换为「' + speedLabel() + '」：并发 ' + state.cfg.concurrency +
                ' 路 / 请求间隔 ' + state.cfg.delay + 'ms', 'info');
        } else if (key.indexOf('override.') === 0) {
            var k = key.slice(9);
            if (val) state.cfg.override[k] = val; else delete state.cfg.override[k];
        } else state.cfg[key] = val;
        if (key !== 'speed') saveCfg();
    }

    // 静默预取群组列表：仅用于「从页面内容识别当前群」的名称匹配，不渲染任何勾选 UI
    // mode: 'api'（刷新群组，接口权威完整）| 'sidebar'（从左侧读取，先扫页面再回退接口）
    async function loadGroupsAction(showLog, mode) {
        if (state.running) { log('请等待当前任务结束', 'warn'); return; }
        if (mode === 'sidebar') {
            // 从左侧读取：抓取页面里带 gid 的群入口（天然排除导航菜单）
            var sideGroups = scrapeSidebarGroups();
            if (sideGroups && sideGroups.length) {
                sideGroups.forEach(function (s) {
                    var hit = state.groups.filter(function (g) { return g.gid === s.gid || g.name === s.name; })[0];
                    if (hit) {
                        if (s.gid && !hit.gid) { hit.gid = s.gid; hit.fromSidebar = true; }
                    } else {
                        state.groups.push({ gid: s.gid || '', name: s.name, uk: '', uname: '', count: 0, fromSidebar: true });
                    }
                });
                var seenN = {}, dedup = [];
                state.groups.forEach(function (g) { if (!seenN[g.gid || g.name]) { seenN[g.gid || g.name] = 1; dedup.push(g); } });
                state.groups = dedup;
                saveGroups();
                if (showLog) log('已从页面左侧读取 ' + sideGroups.length + ' 个群组（带 gid 的群入口，已排除导航菜单）。', 'info');
                renderGroups(); renderStatus();
                return;
            }
            if (showLog) log('左侧未识别到带 gid 的群入口（新版百度侧栏不再把 gid 写进链接），已自动回退接口完整拉取。建议直接点「刷新群组」。', 'warn'); }
        // 接口拉取（权威、完整）
        try {
            var gs = await fetchGroups();
            if (gs && gs.length) { state.groups = gs; saveGroups(); if (showLog) log('已通过接口获取 ' + gs.length + ' 个群组（完整列表）。', 'info'); }
            else if (showLog) log('接口未返回群组，请先进入任意群文件页，或用「从左侧读取」/手动添加。', 'warn');
        } catch (e) {
            if (showLog) log('获取群组列表失败：' + e.message + '（可用「从左侧读取」或手动添加群 gid）', 'warn');
        }
        renderGroups(); renderStatus();
    }

    // 百度网盘左侧导航词黑名单：这些永远是菜单项而非群组，出现即排除
    var NAV_LABEL = /^(首页|团队空间|收发|同步|工具|库库AI|个人空间|我的网盘|共享|群文件|通讯录|最近|收藏|回收站|更多|订阅|推荐|消息|通知|帮助|设置|传输列表|好友|关注|退出登录|下载|缓存|全部分类|我的资源|我的分享|我的应用|我的下载|文档|图片|视频|音乐|其他|全部|正在下载|认证空间|发现|活动|会员|订单|客服|我的|全部文件)$/;

    // 从页面左侧真实群组入口抓取（最准确来源）。
    // 关键：群组入口的链接/节点必带 gid，而左侧导航菜单不带 —— 据此天然区分，不再误抓 首页/工具 等。
    function scrapeSidebarGroups() {
        try {
            var out = [], seen = {};
            function pushItem(node, gid) {
                if (!node) return;
                if (node.closest && node.closest('.bpgEx-panel')) return; // 排除本脚本面板
                var t = (node.textContent || '').trim();
                if (!t || t.length < 2 || t.length > 40) return;
                if (NAV_LABEL.test(t)) return;                            // 防御：即便误命中也排除导航词
                if (seen[t]) return;
                seen[t] = 1;
                out.push({ name: t, gid: gid || '', el: node });
            }
            function hrefGid(href) {
                if (!href) return '';
                try {
                    var hu = new URL(href, location.origin);
                    return hu.searchParams.get('gid') || hu.searchParams.get('group_id') || '';
                } catch (e) { return ''; }
            }
            // 主策略：抓取所有 <a>，只保留链接里带 gid / group 的（群组入口；导航菜单无 gid）
            var links = document.querySelectorAll('a[href]');
            for (var i = 0; i < links.length; i++) {
                var a = links[i];
                var href = a.getAttribute('href') || '';
                if (href.indexOf('gid=') < 0 && href.indexOf('group') < 0 && href.indexOf('group_id') < 0) continue;
                var gid = hrefGid(href);
                // 仍要求能解析出 gid，否则可能是其它含 group 字样的链接
                if (!gid) {
                    var dg = a.closest ? (a.closest('[data-gid]') || a.closest('[data-id]')) : null;
                    gid = dg ? (dg.getAttribute('data-gid') || dg.getAttribute('data-id') || '') : '';
                }
                if (!gid) continue;
                pushItem(a, gid);
            }
            // 兜底：部分版本群入口不带 gid 在 href，而是用 data-gid 属性
            if (!out.length) {
                var dgs = document.querySelectorAll('[data-gid],[data-groupid],[data-group-id]');
                for (var j = 0; j < dgs.length; j++) {
                    var dnode = dgs[j];
                    var gid2 = dnode.getAttribute('data-gid') || dnode.getAttribute('data-groupid') || dnode.getAttribute('data-group-id') || '';
                    pushItem(dnode, gid2);
                }
            }
            return out;
        } catch (e) { return []; }
    }

    function addManualGroup() {
        if (!el.addGid) return;
        var gid = (el.addGid.value || '').trim();
        if (!gid) { log('请先填写群 gid', 'warn'); return; }
        if (!state.groups.some(function (g) { return g.gid === gid; })) {
            state.groups.push({ gid: gid, name: groupNameById(gid) || ('群组 ' + gid.slice(0, 8)), uk: '', uname: '', count: 0 });
            saveGroups();
        }
        state.selected.add(gid);
        el.addGid.value = '';
        renderGroups(); renderStatus();
        log('已添加并勾选群 gid：' + gid);
    }

    // 导出文件名：群名称_文件夹名_时间（多群 / 多目录时缩写为「A+B等N群」「A+B等N个目录」）
    function exportBaseName() {
        var rows = exportRows();
        var gnames = [], seenG = new Set();
        rows.forEach(function (r) {
            var g = str(r.groupName).trim();
            if (g && !seenG.has(g)) { seenG.add(g); gnames.push(g); }
        });
        if (!gnames.length) {
            var gid = state.cap.currentGid || state.cap.activeGid;
            var gn = gid ? groupNameById(gid) : '';
            if (gn) gnames.push(gn);
        }
        var dnames = [], seenD = new Set();
        (state.topDirs || []).forEach(function (d) {
            if (!state.selectedDirs || !state.selectedDirs.has(d.cid)) return;
            var n = str(d.name).trim();
            if (n && !seenD.has(n)) { seenD.add(n); dnames.push(n); }
        });
        function joinNames(a, unit) {
            if (!a.length) return '';
            if (a.length === 1) return safeName(a[0]);
            return safeName(a.slice(0, 2).map(safeName).join('+') + '等' + a.length + unit);
        }
        // 分别限长再拼接，保证「_时间」永远完整保留在文件名里
        var g = (joinNames(gnames, '群') || '群组文件').slice(0, 40);
        var d = (joinNames(dnames, '个目录') || (rows.length ? '共享文件' : '未扫描')).slice(0, 60);
        return safeName(g + '_' + d + '_' + stamp());
    }

    function doExport(kind) {
        var rows = exportRows();
        var base = exportBaseName();
        if ((kind === 'json' || kind === 'tree' || kind === 'copyCsv') && rows.length > 50000) {
            log('⚠ 当前 ' + rows.length + ' 条，JSON / 目录树 / 剪贴板会生成超大字符串，容易撑爆内存；请改用 CSV 导出或分批扫描。', 'warn');
            return;
        }
        if (kind === 'csv' || kind === 'json' || kind === 'tree') {
            if (!rows.length) { log('没有可导出的记录，请先扫描', 'warn'); return; }
            if (kind === 'csv') { download(base + '_明细.csv', toCSV(rows), 'text/csv;charset=utf-8'); }
            if (kind === 'json') { download(base + '_明细.json', toJSON(rows), 'application/json;charset=utf-8'); }
            if (kind === 'tree') { download(base + '_目录树.txt', toTree(rows), 'text/plain;charset=utf-8'); }
            recordExport(kind, rows, base, base + '_明细.' + (kind === 'csv' ? 'csv' : kind === 'json' ? 'json' : 'txt'));
            log('已导出 ' + rows.length + ' 条记录（' + kind + '）→ ' + base);
            return;
        }
        if (kind === 'copyCsv') {
            if (!rows.length) { log('没有可复制的记录', 'warn'); return; }
            recordExport('复制CSV', rows, base, '剪贴板');
            copyText(toCSV(rows).join('').replace(/^\uFEFF/, ''), 'CSV 内容已复制');
            return;
        }
        log('不支持的导出类型：' + kind + '（本版本仅提供 CSV / JSON / 目录树）', 'warn');
    }

    /* ============================================================
     * 7. 启动
     * ============================================================ */

    // 关页面 / 刷新是同步事件，来不及等节流，必须在 beforeunload 里强制存一次断点
    try {
        window.addEventListener('beforeunload', function () {
            if (state.running && state.phase === 'scanning') { saveSnapshot(true); saveRun(); }
        });
    } catch (e) { }

    installSniffer();
    watchNavigation();
    state.groups = loadGroups();
    // 静默预取群组列表，供「从页面内容识别当前群」做名称匹配（不渲染 UI）
    try {
        fetchGroups().then(function (gs) { if (gs && gs.length) { state.groups = gs; saveGroups(); } }).catch(function () { });
    } catch (e) { }

    function renderResumeBanner() {
        var box = el.panel && el.panel.querySelector('#bpgEx-resume');
        if (!box) return;
        var p = readSnapshot();
        if (!p || state.running) { box.style.display = 'none'; return; }
        box.style.display = '';
        var t = el.panel.querySelector('#bpgEx-resume-text');
        if (t) {
            var recN = p.full ? ((p.records && p.records.r) || []).length : num(p.records);
            var queueN = p.full ? (p.queue || []).length : num(p.queue);
            var streaming = !!p.streaming;
            var head = streaming
                ? '<b>发现上次未完成的「全自动边扫边写」</b><br/>'
                : '<b>发现上次未完成的扫描</b><br/>';
            var prog = streaming
                ? '已写入 <b>' + num(p.writtenRows) + '</b> 行到文件 <b>' + esc(p.fileName || '') + '</b>、已展开 <b>' + num(p.scannedDirs) + '</b> 个目录，还剩 <b>' + queueN + '</b> 个目录未扫描。'
                : '已抓 <b>' + recN + '</b> 条记录、已展开 <b>' + num(p.scannedDirs) + '</b> 个目录，还剩 <b>' + queueN + '</b> 个目录未扫描。';
            t.innerHTML = head + prog + '<br/>保存于 ' +
                new Date(num(p.savedAt)).toLocaleString('zh-CN') +
                '。<br/>点「继续上次扫描」' +
                (streaming
                    ? '将<b>重新授权并续写同一份 CSV</b>（无需重新选文件），从断点接着跑。'
                    : '从断点接着跑，<b>不会重扫已完成的目录</b>。') +
                (recN > SNAP_MAX_RECORDS && !streaming
                    ? '<br/><span class="warn">⚠ 该断点含 ' + recN + ' 条明细，超过安全上限，点「继续」不会恢复明细（避免再次内存不足）。建议分批勾选目录重扫。</span>'
                    : '');
        }
    }

    function initUI() {
        if (!document.body || el.panel) return;
        try { addStyle(); buildUI(); loadNoteState(); setButtons(); log('脚本已就绪，版本 ' + VERSION); }
        catch (e) { console.error('[群清单] UI 初始化失败', e); }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI, { once: true });
    } else initUI();
    setTimeout(initUI, 1200);
    setTimeout(initUI, 3500);

    // 暴露一个最小调试接口（控制台可用），不污染页面全局命名空间
    window.BPGroupExporter = {
        version: VERSION,
        state: state,
        diagnose: diagnosis,
        readStructure: readStructure,
        startScan: startScan,
        resumeScan: function () { return startScan(true); },
        saveSnapshot: saveSnapshot,
        readSnapshot: readSnapshot,
        loadSnapshotAsync: loadSnapshotAsync,
        packRecords: packRecords,
        unpackRecords: unpackRecords,
        clearSnapshot: clearSnapshot,
        runs: loadRuns,
        loadRunFull: loadRunFull,
        saveRun: saveRun,
        finishRun: finishRun,
        buildRunReport: buildRunReport,
        exportRunReport: exportRunReport,
        currentRun: function () { return state.run; },
        runWorkers: runWorkers,
        scan: readStructure,          // 兼容旧调用
        loadGroups: loadGroupsAction,
        export: doExport,
        exportCSV: function () { doExport('csv'); }
    };
})();
