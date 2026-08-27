/* 抖音续火花助手 · 前端主逻辑
 * 视图：overview / friends / settings / logs（hash 路由）
 * 数据：/api/status /api/config /api/contacts /api/logs /api/history
 */
(function () {
  const { createApp, ref, reactive, computed, onMounted, onUnmounted } = Vue;

  const SUN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

  const app = createApp({
    setup() {
      // ---------- 基础状态 ----------
      const icons = window.DS_ICONS || {};
      const views = [
        { name: 'overview', label: '首页总览', icon: icons.home },
        { name: 'friends', label: '好友与消息', icon: icons.category },
        { name: 'settings', label: '定时配置', icon: icons.setting },
        { name: 'logs', label: '发送日志', icon: icons.blogger },
      ];
      const activeView = ref((location.hash || '#/overview').slice(2) || 'overview');
      const theme = ref(document.documentElement.dataset.theme || 'light');
      const token = ref(localStorage.getItem('ds_token') || '');
      const tokenInput = ref('');
      const tokenDialog = ref(false);

      const status = reactive({ state_file_exists: false, session_status: 'unknown', running: false, last_run: null, next_run: null, history_count: 0, auth_required: true });
      const config = reactive({ schedule_time: '21:00', jitter_minutes: 30, send_gap_min: 6, send_gap_max: 12, max_friends_per_run: 20, friends: [], messages: [] });
      const settingsForm = reactive({ schedule_time: '21:00', jitter_minutes: 30, send_gap_min: 6, send_gap_max: 12, max_friends_per_run: 20 });
      const friendsText = ref('');
      const messagesText = ref('');
      const logs = ref('');
      const autoRefresh = ref(false);
      const uploadFile = ref(null);
      const contacts = ref([]);
      const contactsAt = ref('');
      const contactsError = ref('');
      const contactsFetching = ref(false);
      const selectedFriends = ref([]);
      const history = ref([]);

      const nowTick = ref(Date.now());
      const heatYear = ref(new Date().getFullYear());
      const heatMonth = ref(new Date().getMonth() + 1);

      let pollTimer = null;
      let tickTimer = null;

      // ---------- API ----------
      const api = axios.create({ baseURL: '/api', timeout: 900000 });
      api.interceptors.request.use((cfg) => {
        if (token.value) cfg.headers['X-Auth-Token'] = token.value;
        return cfg;
      });
      api.interceptors.response.use(
        (r) => r,
        (err) => {
          if (err.response && err.response.status === 401) tokenDialog.value = true;
          return Promise.reject(err);
        }
      );

      // ---------- 工具 ----------
      function fmt(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        return isNaN(d) ? iso : d.toLocaleString('zh-CN', { hour12: false });
      }
      function fmtShort(iso) {
        const d = new Date(iso);
        if (isNaN(d)) return iso;
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
      }
      function dayKey(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
      function relTime(iso) {
        const diff = Date.now() - new Date(iso).getTime();
        const m = Math.floor(diff / 60000);
        if (m < 1) return '刚刚';
        if (m < 60) return m + ' 分钟前';
        const h = Math.floor(m / 60);
        if (h < 24) return h + ' 小时前';
        return Math.floor(h / 24) + ' 天前';
      }

      // ---------- 主题 ----------
      const themeIcon = computed(() => (theme.value === 'dark' ? SUN_SVG : icons.moon));
      function toggleTheme() {
        theme.value = theme.value === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = theme.value;
        localStorage.setItem('ds_theme', theme.value);
      }

      // ---------- 路由 ----------
      function goView(name) {
        activeView.value = name;
        location.hash = '#/' + name;
        if (name === 'logs') { loadLogs(); loadHistory(); }
      }
      window.addEventListener('hashchange', () => {
        const v = (location.hash || '#/overview').slice(2);
        if (views.some((x) => x.name === v)) activeView.value = v;
      });

      // ---------- 顶部状态 ----------
      const sessionTagClass = computed(() => {
        if (status.session_status === 'expired' || status.session_status === 'failed') return 'expired';
        if (status.session_status === 'partial') return 'warn';
        return '';
      });
      const sessionTagText = computed(() => {
        switch (status.session_status) {
          case 'ok': return '登录状态正常';
          case 'expired': return '登录态已过期';
          case 'partial': return '部分发送成功';
          case 'failed': return '发送失败';
          default: return '状态未知';
        }
      });
      const todayText = computed(() => {
        const d = new Date(nowTick.value);
        const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${week}`;
      });

      // ---------- 今日统计 ----------
      const todayStats = computed(() => {
        const total = (config.friends || []).length;
        const lr = status.last_run;
        const isToday = lr && lr.at && dayKey(new Date(lr.at)) === dayKey(new Date(nowTick.value)) && !lr.dry_run;
        const ok = isToday ? (lr.ok || []).length : 0;
        const fail = isToday ? (lr.failed || []).filter((f) => f.name !== '_system').length : 0;
        const pending = Math.max(0, total - ok - fail);
        const pct = total ? Math.round((ok / total) * 100) : 0;
        return { ok, fail, pending, total, pct };
      });

      // 进度环
      const RING_C = 2 * Math.PI * 64;
      const ringDash = computed(() => `${RING_C}`);
      const ringOffset = computed(() => RING_C * (1 - Math.min(100, todayStats.value.pct) / 100));
      const ringTrack = computed(() => (theme.value === 'dark' ? '#262c38' : '#f0f3f8'));

      // 倒计时
      const countdownText = computed(() => {
        if (!status.next_run) return '保存定时配置后自动计算';
        const diff = new Date(status.next_run).getTime() - nowTick.value;
        if (diff <= 0) return '即将开始';
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        return `倒计时约 ${h} 小时 ${m} 分钟`;
      });

      // ---------- 火花连胜 ----------
      const realRuns = computed(() => history.value.filter((h) => !h.dry_run));
      const streak = computed(() => {
        // 连续天数：从今天/昨天往前，每天至少有 1 条 ok 记录
        const daysWithOk = new Set();
        realRuns.value.forEach((h) => {
          if ((h.ok || []).length > 0 && !h.logged_out) daysWithOk.add(dayKey(new Date(h.at)));
        });
        let days = 0;
        const cursor = new Date(nowTick.value);
        if (!daysWithOk.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1); // 今天还没跑就从昨天起
        while (daysWithOk.has(dayKey(cursor))) {
          days++;
          cursor.setDate(cursor.getDate() - 1);
        }
        // 近 7 天成功率
        const weekAgo = Date.now() - 7 * 86400000;
        let ok7 = 0, fail7 = 0;
        realRuns.value.forEach((h) => {
          if (new Date(h.at).getTime() >= weekAgo) {
            ok7 += (h.ok || []).length;
            fail7 += (h.failed || []).filter((f) => f.name !== '_system').length;
          }
        });
        const weekRate = ok7 + fail7 ? Math.round((ok7 / (ok7 + fail7)) * 100) : 100;
        // 本周（周一起）
        const now = new Date(nowTick.value);
        const monday = new Date(now);
        monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
        monday.setHours(0, 0, 0, 0);
        let weekOk = 0;
        realRuns.value.forEach((h) => {
          if (new Date(h.at).getTime() >= monday.getTime()) weekOk += (h.ok || []).length;
        });
        const daysPassed = Math.floor((now - monday) / 86400000) + 1;
        const weekTotal = daysPassed * (config.friends || []).length;
        return { days, weekRate, weekOk, weekTotal };
      });

      // ---------- 热力图 ----------
      function toggleHeatYear() {
        const cur = new Date().getFullYear();
        heatYear.value = heatYear.value === cur ? cur - 1 : cur;
        if (heatYear.value === cur && heatMonth.value > new Date().getMonth() + 1) {
          heatMonth.value = new Date().getMonth() + 1;
        }
      }
      function isFutureMonth(m) {
        const now = new Date();
        if (heatYear.value < now.getFullYear()) return false;
        return m > now.getMonth() + 1;
      }
      const heatCells = computed(() => {
        // 每天成功次数
        const perDay = {};
        realRuns.value.forEach((h) => {
          const k = dayKey(new Date(h.at));
          perDay[k] = (perDay[k] || 0) + (h.ok || []).length;
        });
        const total = Math.max(1, (config.friends || []).length);
        // GitHub 风格：列=周（周日起），行=星期
        const first = new Date(heatYear.value, heatMonth.value - 1, 1);
        const start = new Date(first);
        start.setDate(first.getDate() - first.getDay()); // 回到本周日
        const cells = [];
        const cursor = new Date(start);
        const now = new Date(nowTick.value);
        while (cursor.getMonth() + 1 !== heatMonth.value || cursor.getFullYear() !== heatYear.value || cursor.getDate() <= new Date(heatYear.value, heatMonth.value, 0).getDate()) {
          const inMonth = cursor.getFullYear() === heatYear.value && cursor.getMonth() + 1 === heatMonth.value;
          const k = dayKey(cursor);
          const count = inMonth ? (perDay[k] || 0) : 0;
          const future = cursor.getTime() > now.getTime();
          let level = 0;
          if (inMonth && !future && count > 0) {
            const ratio = count / total;
            level = ratio >= 1 ? 4 : ratio >= 0.66 ? 3 : ratio >= 0.33 ? 2 : 1;
          }
          cells.push({ date: inMonth ? k : '', count, level: future ? 0 : level });
          cursor.setDate(cursor.getDate() + 1);
          if (cursor.getMonth() + 1 === heatMonth.value + 1 && cursor.getDay() === 0) break;
          if (cells.length > 42) break;
        }
        return cells;
      });

      // ---------- 实时动态 ----------
      const feedItems = computed(() => {
        const items = [];
        for (const h of history.value.slice(0, 3)) {
          const when = relTime(h.at);
          (h.ok || []).slice(0, 1).forEach((n) => {
            items.push({ ok: true, title: `${n} 续火花${h.dry_run ? '（干跑）' : '成功'}`, sub: fmt(h.at), time: when });
          });
          (h.failed || []).filter((f) => f.name !== '_system').slice(0, 1).forEach((f) => {
            items.push({ ok: false, title: `${f.name} 续火花失败`, sub: `${f.reason || ''} · ${fmt(h.at)}`, time: when });
          });
          if (!items.length && ((h.ok || []).length || (h.failed || []).length)) {
            items.push({ ok: !(h.failed || []).length, title: `一次任务：成功 ${(h.ok || []).length} / 失败 ${(h.failed || []).length}`, sub: fmt(h.at), time: when });
          }
        }
        return items.slice(0, 3);
      });

      // ---------- 历史时间线 ----------
      const historyItems = computed(() => {
        return history.value.slice(0, 20).map((h) => {
          const okN = (h.ok || []).length;
          const failN = (h.failed || []).filter((f) => f.name !== '_system').length;
          const sysErr = (h.failed || []).find((f) => f.name === '_system');
          let kind = 'ok', icon = '✓', tag = '全部成功';
          if (h.dry_run) { kind = 'dry'; icon = '🧪'; tag = '干跑'; }
          else if (h.logged_out) { kind = 'fail'; icon = '✕'; tag = '登录过期'; }
          else if (h.rate_limited) { kind = 'fail'; icon = '✕'; tag = '限流停止'; }
          else if (failN && okN) { kind = 'part'; icon = '◐'; tag = '部分成功'; }
          else if (failN || sysErr) { kind = 'fail'; icon = '✕'; tag = '失败'; }
          return {
            kind, icon, tag,
            title: `${h.dry_run ? '干跑测试' : '发送任务'} · ${fmt(h.at)}`,
            sub: `成功 ${okN} 人 · 失败 ${failN} 人${sysErr ? ' · ' + sysErr.reason : ''}${h.rate_limited ? ' · 命中限流' : ''}`,
          };
        });
      });

      // ---------- 数据加载 ----------
      async function loadStatus() {
        try {
          const r = await api.get('/status');
          Object.assign(status, r.data);
          if (r.data.auth_required && !token.value) tokenDialog.value = true;
        } catch (e) { /* 401 handled */ }
      }
      async function loadConfig() {
        try {
          const r = await api.get('/config');
          Object.assign(config, r.data);
          Object.assign(settingsForm, r.data);
          friendsText.value = (r.data.friends || []).join('\n');
          messagesText.value = (r.data.messages || []).join('\n');
          selectedFriends.value = (r.data.friends || []).slice();
        } catch (e) { /* handled */ }
      }
      async function loadContacts() {
        try {
          const r = await api.get('/contacts');
          contacts.value = r.data.contacts || [];
          contactsAt.value = r.data.contacts_at || '';
          contactsError.value = r.data.contacts_error || '';
          contactsFetching.value = !!r.data.fetching;
        } catch (e) { /* handled */ }
      }
      async function loadLogs() {
        try {
          const r = await api.get('/logs');
          logs.value = r.data.logs;
        } catch (e) { /* handled */ }
      }
      async function loadHistory() {
        try {
          const r = await api.get('/history');
          history.value = r.data.history || [];
        } catch (e) { /* handled */ }
      }
      async function loadAll() {
        await loadStatus();
        await loadConfig();
        await loadContacts();
        await loadHistory();
      }

      // ---------- 操作 ----------
      function showTokenDialog() { tokenInput.value = token.value; tokenDialog.value = true; }
      function saveToken() {
        token.value = tokenInput.value.trim();
        localStorage.setItem('ds_token', token.value);
        tokenDialog.value = false;
        loadAll();
      }
      async function fetchContacts() {
        try {
          await api.post('/contacts/fetch');
          contactsFetching.value = true;
          ElementPlus.ElMessage.info('正在读取聊天列表，可能需要半分钟左右…');
          for (let i = 0; i < 80; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            await loadContacts();
            if (!contactsFetching.value) break;
          }
        } catch (e) {
          ElementPlus.ElMessage.error(e.response?.data?.detail || '获取失败');
        }
      }
      function applySelection() {
        friendsText.value = selectedFriends.value.join('\n');
        ElementPlus.ElMessage.success('已把勾选结果写入名单，记得点「保存」');
      }
      function buildConfigPayload(extra) {
        return { config: Object.assign({}, config, settingsForm, {
          friends: friendsText.value.split('\n').map((s) => s.trim()).filter(Boolean),
          messages: messagesText.value.split('\n').map((s) => s.trim()).filter(Boolean),
        }, extra || {}) };
      }
      async function saveFriends() {
        try {
          await api.put('/config', buildConfigPayload());
          await loadConfig();
          ElementPlus.ElMessage.success('好友与消息已保存');
        } catch (e) {
          ElementPlus.ElMessage.error(e.response?.data?.detail || '保存失败');
        }
      }
      async function saveSettings() {
        try {
          await api.put('/config', buildConfigPayload({ schedule_time: settingsForm.schedule_time }));
          await loadConfig();
          await loadStatus();
          ElementPlus.ElMessage.success('定时配置已保存');
        } catch (e) {
          ElementPlus.ElMessage.error(e.response?.data?.detail || '保存失败');
        }
      }
      async function waitForRunFinish(maxSeconds) {
        const start = Date.now();
        while (Date.now() - start < maxSeconds * 1000) {
          await new Promise((r) => setTimeout(r, 5000));
          await loadStatus();
          if (!status.running) return;
        }
        ElementPlus.ElMessage.warning('等待超时，任务可能仍在后台运行');
      }
      async function triggerRun(dry) {
        try {
          const r = await api.post('/run', { dry });
          if (r.data.started) {
            ElementPlus.ElMessage.info(dry ? '干跑测试已启动' : '发送任务已启动');
            await loadStatus();
            await waitForRunFinish(1200);
            await loadHistory();
            await loadLogs();
          }
        } catch (e) {
          ElementPlus.ElMessage.error(e.response?.data?.detail || '启动失败');
        }
      }
      function onFileChange(file) { uploadFile.value = file.raw || null; }
      function onFileRemove() { uploadFile.value = null; }
      async function uploadState() {
        if (!uploadFile.value) return;
        try {
          const fd = new FormData();
          fd.append('file', uploadFile.value);
          const r = await api.post('/upload-state', fd);
          ElementPlus.ElMessage.success('登录态已上传（' + r.data.size + ' 字节）');
          uploadFile.value = null;
          await loadStatus();
        } catch (e) {
          ElementPlus.ElMessage.error(e.response?.data?.detail || '上传失败');
        }
      }

      // ---------- 生命周期 ----------
      onMounted(async () => {
        await loadAll();
        if (activeView.value === 'logs') await loadLogs();
        pollTimer = setInterval(() => {
          loadStatus();
          if (autoRefresh.value && activeView.value === 'logs') loadLogs();
        }, 20000);
        tickTimer = setInterval(() => { nowTick.value = Date.now(); }, 30000);
      });
      onUnmounted(() => {
        if (pollTimer) clearInterval(pollTimer);
        if (tickTimer) clearInterval(tickTimer);
      });

      return {
        icons, views, activeView, theme, themeIcon,
        status, settingsForm, friendsText, messagesText, logs, autoRefresh, uploadFile,
        contacts, contactsAt, contactsError, contactsFetching, selectedFriends,
        tokenDialog, tokenInput,
        sessionTagClass, sessionTagText, todayText,
        todayStats, ringDash, ringOffset, ringTrack, countdownText,
        streak, heatYear, heatMonth, heatCells, feedItems, historyItems,
        fmt, fmtShort, goView, toggleTheme, showTokenDialog, saveToken,
        loadAll, loadLogs, loadHistory, fetchContacts, applySelection,
        saveFriends, saveSettings, triggerRun,
        onFileChange, onFileRemove, uploadState,
        toggleHeatYear, isFutureMonth,
      };
    },
  });

  app.use(ElementPlus);
  app.mount('#app');
})();
