document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);
  const steps = document.querySelectorAll('.step');
  const stepDots = document.querySelectorAll('.step-dot');
  const stepLineFill = $('stepLineFill');

  // window.api exists under Electron; stub it so a plain browser preview still renders.
  const api = window.api || {
    pickKeyFile: async () => null,
    connectVps: async () => ({ ok: false, error: 'preview (нет бэкенда)' }),
    connectRouter: async () => ({ ok: false, error: 'preview (нет бэкенда)' }),
    installServer: async () => ({ ok: false, error: 'preview (нет бэкенда)' }),
    installRouter: async () => ({ ok: false, error: 'preview (нет бэкенда)' }),
    openExternal: () => {},
    onEvent: () => {},
    onLog: () => {},
  };

  const state = {
    vps: { host: '', port: 22, user: 'root', auth: 'password', password: '', key: '', keyPath: '' },
    router: { host: '192.168.1.1', port: 22, password: '' },
    naive: false,
    naiveDomain: '',
    results: {},
  };

  function goToStep(i) {
    steps.forEach((s, idx) => s.classList.toggle('step--active', idx === i));
    stepDots.forEach((d, idx) => {
      d.classList.toggle('step-dot--active', idx === i);
      d.classList.toggle('step-dot--completed', idx < i);
    });
    stepLineFill.style.width = `${(i / (steps.length - 1)) * 100}%`;
  }

  function addLog(containerId, message, type = 'info') {
    const c = $(containerId);
    if (!c) return;
    const line = document.createElement('div');
    line.className = `log-line log-line--${type}`;
    line.textContent = message;
    c.appendChild(line);
    c.scrollTop = c.scrollHeight;
  }

  const STEP_BADGE = {
    'server.awg': 'awg', 'server.naive': 'naive',
    'router.awg': 'awg-client', 'router.naive': 'naive-client',
    'router.pbr': 'pbr', 'router.failover': 'failover-client',
  };
  function setBadge(stepId, text, cls) {
    const key = STEP_BADGE[stepId];
    if (!key) return;
    const el = document.querySelector(`[data-protocol="${key}"] .status-badge`);
    if (el) { el.textContent = text; el.className = `status-badge status-badge--${cls}`; }
  }

  api.onLog(({ phase, message }) => addLog(phase === 'router' ? 'routerLog' : 'serverLog', message, 'command'));
  api.onEvent((e) => {
    const logId = e.stepId && e.stepId.startsWith('router') ? 'routerLog' : 'serverLog';
    if (e.type === 'step-start') { setBadge(e.stepId, 'Установка…', 'active'); addLog(logId, `▶ ${e.stepId}`, 'info'); }
    if (e.type === 'step-done') { setBadge(e.stepId, 'Готово', 'success'); addLog(logId, `✔ ${e.stepId}`, 'success'); }
    if (e.type === 'step-fail') { setBadge(e.stepId, 'Ошибка', 'error'); addLog(logId, `✘ ${e.stepId}: ${e.error}`, 'error'); }
    if (e.type === 'rollback') addLog(logId, `↩ откат ${e.stepId}`, 'warning');
  });

  function vpsPayload() {
    const p = { host: state.vps.host, port: state.vps.port, username: state.vps.user, auth: state.vps.auth };
    if (state.vps.auth === 'key') {
      if (state.vps.keyPath) p.keyPath = state.vps.keyPath; else p.privateKey = state.vps.key;
    } else {
      p.password = state.vps.password;
    }
    return p;
  }

  // ── Step 0 / nav ──
  $('btnStart').addEventListener('click', () => goToStep(1));
  $('btnBackToWelcome').addEventListener('click', () => goToStep(0));
  $('btnBackToServer').addEventListener('click', () => goToStep(1));
  $('btnBackToInstall').addEventListener('click', () => goToStep(3));

  // ── Step 1: VPS ──
  document.querySelectorAll('.auth-toggle__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.auth-toggle__btn').forEach((b) => b.classList.remove('auth-toggle__btn--active'));
      btn.classList.add('auth-toggle__btn--active');
      state.vps.auth = btn.dataset.auth;
      $('passwordGroup').classList.toggle('hidden', state.vps.auth !== 'password');
      $('keyGroup').classList.toggle('hidden', state.vps.auth !== 'key');
    });
  });
  $('toggleVpsPass').addEventListener('click', () => { const i = $('vpsPassword'); i.type = i.type === 'password' ? 'text' : 'password'; });

  const btnPickKey = $('btnPickKey');
  if (btnPickKey) btnPickKey.addEventListener('click', async () => {
    const p = await api.pickKeyFile();
    if (p) { state.vps.keyPath = p; $('keyFilePath').textContent = p; }
  });
  const linkDynu = $('linkDynu');
  if (linkDynu) linkDynu.addEventListener('click', (e) => { e.preventDefault(); api.openExternal('https://www.dynu.com'); });

  $('btnConnectVPS').addEventListener('click', async () => {
    state.vps.host = $('vpsHost').value.trim();
    state.vps.port = parseInt($('vpsPort').value, 10) || 22;
    state.vps.user = $('vpsUser').value.trim() || 'root';
    state.vps.password = $('vpsPassword').value;
    state.vps.key = $('vpsKey').value;

    const dot = $('vpsDot'), txt = $('vpsStatusText'), err = $('vpsError'), spin = $('vpsSpinner');
    err.classList.add('hidden'); spin.classList.remove('hidden');
    dot.className = 'status-dot status-dot--connecting'; txt.textContent = 'Подключение…';
    $('btnConnectVPS').disabled = true;

    const res = await api.connectVps(vpsPayload());
    spin.classList.add('hidden'); $('btnConnectVPS').disabled = false;
    if (res.ok) {
      dot.className = 'status-dot status-dot--connected'; txt.textContent = 'Подключено';
      $('btnToProtocols').disabled = false; $('btnConnectVPS').classList.add('hidden'); $('btnToProtocols').classList.add('btn--glow');
    } else {
      dot.className = 'status-dot status-dot--disconnected'; txt.textContent = 'Ошибка';
      err.classList.remove('hidden'); $('vpsErrorText').textContent = res.error;
    }
  });
  $('btnToProtocols').addEventListener('click', () => goToStep(2));

  // ── Step 2: protocols ──
  const cardNaive = $('cardNaive');
  cardNaive.addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT') return;
    state.naive = !state.naive;
    cardNaive.classList.toggle('protocol-card--selected', state.naive);
    cardNaive.querySelector('.protocol-card__check').className = `protocol-card__check ${state.naive ? 'protocol-card__check--on' : 'protocol-card__check--off'}`;
    $('naiveExtra').classList.toggle('hidden', !state.naive);
  });

  $('btnInstall').addEventListener('click', async () => {
    state.naiveDomain = $('naiveDomain').value.trim();
    if (state.naive && !state.naiveDomain) { alert('Введите домен для NaiveProxy (DNS A-запись на IP сервера)'); return; }
    goToStep(3);
    const res = await api.installServer({ vps: vpsPayload(), naiveDomain: state.naive ? state.naiveDomain : undefined });
    if (res.ok) { state.results = { ...state.results, ...res.results }; $('btnToRouter').classList.remove('hidden'); }
    else addLog('serverLog', `Установка прервана: ${res.error || ''}`, 'error');
  });
  $('btnToRouter').addEventListener('click', () => goToStep(4));

  // ── Step 4: router ──
  $('toggleRouterPass').addEventListener('click', () => { const i = $('routerPassword'); i.type = i.type === 'password' ? 'text' : 'password'; });
  $('btnConnectRouter').addEventListener('click', async () => {
    state.router.host = $('routerHost').value.trim() || '192.168.1.1';
    state.router.port = parseInt($('routerPort').value, 10) || 22;
    state.router.password = $('routerPassword').value;

    const dot = $('routerDot'), txt = $('routerStatusText'), err = $('routerError'), spin = $('routerSpinner');
    err.classList.add('hidden'); spin.classList.remove('hidden');
    dot.className = 'status-dot status-dot--connecting'; txt.textContent = 'Подключение…';
    $('btnConnectRouter').disabled = true;

    const res = await api.connectRouter(state.router);
    spin.classList.add('hidden'); $('btnConnectRouter').disabled = false;
    if (res.ok) {
      dot.className = 'status-dot status-dot--connected'; txt.textContent = 'Подключено';
      $('btnToConfig').disabled = false; $('btnConnectRouter').classList.add('hidden'); $('btnToConfig').classList.add('btn--glow');
    } else {
      dot.className = 'status-dot status-dot--disconnected'; txt.textContent = 'Ошибка';
      err.classList.remove('hidden'); $('routerErrorText').textContent = res.error;
    }
  });
  $('btnToConfig').addEventListener('click', async () => {
    goToStep(5);
    const res = await api.installRouter({ router: state.router, vpsHost: state.vps.host });
    if (res.ok) { state.results = { ...state.results, ...res.results }; $('btnToComplete').classList.remove('hidden'); }
    else if (res.restored) addLog('routerLog', `Настройка прервана: ${res.error || ''} — роутер восстановлен из бэкапа.`, 'error');
    else {
      addLog('routerLog', `Настройка прервана: ${res.error || ''} — АВТОВОССТАНОВЛЕНИЕ НЕ УДАЛОСЬ.`, 'error');
      addLog('routerLog', 'Восстановите вручную по SSH: uci import network < /root/vpn-installer-backup-latest.network && uci commit network && /etc/init.d/network restart (то же для firewall, pbr).', 'error');
    }
  });
  $('btnToComplete').addEventListener('click', () => { goToStep(6); populateSummary(); });

  // ── Step 6: complete ──
  function populateSummary() {
    const r = state.results;
    $('summaryServer').innerHTML = '<li>AmneziaWG (UDP 443)</li>' + (r.naive ? '<li>NaiveProxy (TCP 2053)</li>' : '');
    $('summaryRouter').innerHTML = '<li>AWG client (awg0)</li>' + (r.naive ? '<li>Naive client (tun-naive)</li>' : '') + '<li>Failover awg↔naive</li>';
    if (r.awg) {
      $('credAWGContent').textContent =
        `Server Public Key: ${r.awg.serverPublicKey}\nEndpoint: ${state.vps.host}:443\nClient address: ${r.awg.clientAddress || '10.66.66.2/32'}`;
    }
    if (r.naive) {
      $('credNaive').classList.remove('hidden');
      $('credNaiveContent').textContent =
        `Domain: ${r.naive.domain}\nUsername: ${r.naive.username}\nPassword: ${r.naive.password}\nPort: ${r.naive.port}`;
    }
  }
  $('credentialsToggle').addEventListener('click', () => $('credentialsBody').classList.toggle('hidden'));
  const testBtn = $('btnTestVPN');
  if (testBtn) testBtn.style.display = 'none';
  $('btnFinish').addEventListener('click', () => window.close());
});
