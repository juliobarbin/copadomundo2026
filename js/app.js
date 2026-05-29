import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY, APP_NAME } from './config.js';

// ---------- helpers ----------
const $  = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};
const flag = (iso) => `https://flagcdn.com/h40/${iso}.png`;
const fmtDate = (iso) => iso
  ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  : 'A definir';

// Mesma regra do banco: exato=10, resultado=5, erro=0
const calcPoints = (ph, pa, ah, aa) => {
  if ([ph, pa, ah, aa].some(v => v === null || v === undefined)) return 0;
  if (ph === ah && pa === aa) return 10;
  if (Math.sign(ph - pa) === Math.sign(ah - aa)) return 5;
  return 0;
};

// ---------- estado ----------
const state = {
  session: null,
  profile: null,
  isAdmin: false,
  matches: [],
  preds: new Map(),   // match_id -> {home_score, away_score}
  tab: 'jogos',
};

const configOk = !SUPABASE_URL.includes('SEU_PROJETO') && !SUPABASE_ANON_KEY.includes('SUA_ANON');
const supabase = configOk ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// ============================================================
//  Boot
// ============================================================
async function init() {
  $('#brand-name').textContent = APP_NAME;

  if (!configOk) {
    $('#config-warning').hidden = false;
    return;
  }

  const { data: { session } } = await supabase.auth.getSession();
  state.session = session;

  supabase.auth.onAuthStateChange((_e, s) => {
    state.session = s;
    afterAuth();
  });

  await afterAuth();
  await loadMatches();
  render();
  wireNav();
}

async function afterAuth() {
  if (state.session) {
    await ensureProfile();
    await checkAdmin();
    await loadPredictions();
  } else {
    state.profile = null;
    state.isAdmin = false;
    state.preds.clear();
  }
  renderHeader();
  render();
}

async function ensureProfile() {
  const u = state.session.user;
  const meta = u.user_metadata || {};
  const profile = {
    id: u.id,
    full_name: meta.full_name || meta.name || u.email,
    avatar_url: meta.avatar_url || meta.picture || null,
    email: u.email,
  };
  await supabase.from('profiles').upsert(profile, { onConflict: 'id' });
  state.profile = profile;
}

async function checkAdmin() {
  const { data } = await supabase.from('admins').select('user_id').eq('user_id', state.session.user.id).maybeSingle();
  state.isAdmin = !!data;
}

async function loadMatches() {
  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .order('group_code', { ascending: true })
    .order('matchday', { ascending: true })
    .order('id', { ascending: true });
  if (error) { console.error(error); return; }
  state.matches = data || [];
}

async function loadPredictions() {
  state.preds.clear();
  const { data } = await supabase
    .from('predictions')
    .select('match_id, home_score, away_score')
    .eq('user_id', state.session.user.id);
  (data || []).forEach(p => state.preds.set(p.match_id, { home_score: p.home_score, away_score: p.away_score }));
}

// ============================================================
//  Auth
// ============================================================
async function login() {
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname },
  });
}
async function logout() {
  await supabase.auth.signOut();
}

// ============================================================
//  Render — header
// ============================================================
function renderHeader() {
  const box = $('#auth-box');
  box.innerHTML = '';
  if (state.session && state.profile) {
    const total = myTotalPoints();
    box.append(
      el('span', { className: 'pts-chip', title: 'Seus pontos' }, `${total} pts`),
      state.profile.avatar_url
        ? el('img', { className: 'avatar', src: state.profile.avatar_url, alt: '' })
        : el('span', { className: 'avatar avatar--ph' }, (state.profile.full_name || '?')[0]),
      el('span', { className: 'user-name' }, state.profile.full_name || state.profile.email),
      el('button', { className: 'btn btn--ghost', onclick: logout }, 'Sair'),
    );
  } else {
    box.append(el('button', { className: 'btn btn--google', onclick: login },
      googleIcon(), 'Entrar com Google'));
  }
}

function myTotalPoints() {
  let t = 0;
  for (const m of state.matches) {
    if (m.status !== 'finished') continue;
    const p = state.preds.get(m.id);
    if (p) t += calcPoints(p.home_score, p.away_score, m.home_score, m.away_score);
  }
  return t;
}

// ============================================================
//  Render — roteamento de abas
// ============================================================
function wireNav() {
  $$('.nav-tab').forEach(t => t.onclick = () => { state.tab = t.dataset.tab; render(); });
}

function render() {
  // mostra/esconde aba admin
  $('#tab-admin').hidden = !state.isAdmin;
  $$('.nav-tab').forEach(t => t.classList.toggle('is-active', t.dataset.tab === state.tab));

  const main = $('#content');
  main.innerHTML = '';
  if (!configOk) return;

  if (state.tab === 'jogos')        main.append(renderGroups());
  else if (state.tab === 'ranking') renderRanking(main);
  else if (state.tab === 'regras')  main.append(renderRules());
  else if (state.tab === 'admin')   main.append(renderAdmin());
}

// ---------- aba: grupos & palpites ----------
function renderGroups() {
  const wrap = el('div', { className: 'groups-grid' });
  const byGroup = groupBy(state.matches, m => m.group_code);

  for (const [code, list] of byGroup) {
    const card = el('div', { className: 'card group-card' });
    card.append(el('div', { className: 'group-head' },
      el('span', { className: 'group-badge' }, code),
      el('span', {}, `Grupo ${code}`)));

    // tabela de classificação (zerada / por enquanto baseada em jogos finalizados)
    card.append(renderStandings(list));

    const matches = el('div', { className: 'match-list' });
    for (const m of list) matches.append(renderMatch(m));
    card.append(matches);
    wrap.append(card);
  }
  return wrap;
}

function renderStandings(list) {
  // calcula tabela com base nos jogos finalizados
  const teams = {};
  const ensure = (name, iso) => (teams[name] ??= { name, iso, P: 0, J: 0, V: 0, E: 0, D: 0, GP: 0, GC: 0 });
  for (const m of list) {
    const h = ensure(m.home_team, m.home_iso);
    const a = ensure(m.away_team, m.away_iso);
    if (m.status === 'finished') {
      h.J++; a.J++; h.GP += m.home_score; h.GC += m.away_score; a.GP += m.away_score; a.GC += m.home_score;
      if (m.home_score > m.away_score) { h.V++; a.D++; h.P += 3; }
      else if (m.home_score < m.away_score) { a.V++; h.D++; a.P += 3; }
      else { h.E++; a.E++; h.P++; a.P++; }
    }
  }
  const rows = Object.values(teams).sort((x, y) =>
    y.P - x.P || (y.GP - y.GC) - (x.GP - x.GC) || y.GP - x.GP || x.name.localeCompare(y.name));

  const tbl = el('table', { className: 'standings' });
  tbl.append(el('thead', {}, el('tr', {},
    el('th', {}, '#'), el('th', { className: 'left' }, 'Seleção'),
    el('th', {}, 'P'), el('th', {}, 'J'), el('th', {}, 'SG'))));
  const tb = el('tbody');
  rows.forEach((t, i) => tb.append(el('tr', { className: i < 2 ? 'qualifies' : '' },
    el('td', {}, String(i + 1)),
    el('td', { className: 'left team-cell' },
      el('img', { className: 'flag flag--sm', src: flag(t.iso), alt: '' }),
      el('span', {}, t.name)),
    el('td', { className: 'b' }, String(t.P)),
    el('td', {}, String(t.J)),
    el('td', {}, String(t.GP - t.GC)))));
  tbl.append(tb);
  return tbl;
}

function renderMatch(m) {
  const row = el('div', { className: 'match' });
  const locked = !state.session || (m.match_date && new Date(m.match_date) <= new Date());
  const finished = m.status === 'finished';
  const pred = state.preds.get(m.id);

  row.append(el('div', { className: 'match-date' }, `${fmtDate(m.match_date)} · ${m.matchday}ª rod.`));

  const teamsRow = el('div', { className: 'match-teams' });

  // mandante
  teamsRow.append(el('div', { className: 'team team--home' },
    el('span', { className: 'team-name' }, m.home_team),
    el('img', { className: 'flag', src: flag(m.home_iso), alt: '' })));

  // miolo: inputs ou placar
  const mid = el('div', { className: 'match-mid' });
  if (state.session) {
    const inH = scoreInput(pred?.home_score);
    const inA = scoreInput(pred?.away_score);
    inH.disabled = inA.disabled = locked;
    const status = el('span', { className: 'save-status' });
    const onChange = () => savePrediction(m, inH, inA, status);
    inH.onchange = inA.onchange = onChange;
    mid.append(inH, el('span', { className: 'vs' }, '×'), inA);
    row.dataset.status = '';
    row._status = status;
  } else {
    mid.append(el('span', { className: 'vs' }, '×'));
  }
  teamsRow.append(mid);

  // visitante
  teamsRow.append(el('div', { className: 'team team--away' },
    el('img', { className: 'flag', src: flag(m.away_iso), alt: '' }),
    el('span', { className: 'team-name' }, m.away_team)));

  row.append(teamsRow);

  // rodapé: placar oficial + pontos
  const foot = el('div', { className: 'match-foot' });
  if (finished) {
    foot.append(el('span', { className: 'result' }, `Resultado: ${m.home_score} × ${m.away_score}`));
    if (pred) {
      const pts = calcPoints(pred.home_score, pred.away_score, m.home_score, m.away_score);
      foot.append(el('span', { className: `pts pts--${pts}` }, `+${pts} pts`));
    }
  } else if (locked && state.session) {
    foot.append(el('span', { className: 'lock' }, '🔒 Palpites encerrados'));
  }
  if (row._status) foot.append(row._status);
  row.append(foot);
  return row;
}

function scoreInput(val) {
  return el('input', {
    className: 'score-input', type: 'number', min: 0, max: 99,
    inputMode: 'numeric', placeholder: '–',
    value: (val ?? '') === '' ? '' : String(val),
  });
}

async function savePrediction(m, inH, inA, status) {
  const h = inH.value === '' ? null : parseInt(inH.value, 10);
  const a = inA.value === '' ? null : parseInt(inA.value, 10);
  if (h === null || a === null) { status.textContent = ''; return; }
  status.textContent = 'salvando…';
  status.className = 'save-status saving';
  const { error } = await supabase.from('predictions').upsert(
    { user_id: state.session.user.id, match_id: m.id, home_score: h, away_score: a },
    { onConflict: 'user_id,match_id' });
  if (error) {
    status.textContent = '✕ erro';
    status.className = 'save-status err';
    console.error(error);
  } else {
    state.preds.set(m.id, { home_score: h, away_score: a });
    status.textContent = '✓ salvo';
    status.className = 'save-status ok';
    renderHeader();
  }
}

// ---------- aba: ranking ----------
async function renderRanking(main) {
  main.append(el('div', { className: 'loading' }, 'Carregando ranking…'));
  const { data, error } = await supabase.from('leaderboard').select('*').order('total_points', { ascending: false });
  main.innerHTML = '';
  if (error) { main.append(el('p', { className: 'muted' }, 'Erro ao carregar ranking.')); return; }

  const card = el('div', { className: 'card' });
  card.append(el('h2', { className: 'section-title' }, '🏆 Ranking geral'));
  if (!data || data.length === 0) {
    card.append(el('p', { className: 'muted' }, 'Ninguém pontuou ainda. Faça seus palpites!'));
    main.append(card); return;
  }
  const tbl = el('table', { className: 'ranking' });
  tbl.append(el('thead', {}, el('tr', {},
    el('th', {}, '#'), el('th', { className: 'left' }, 'Participante'),
    el('th', {}, 'Pontos'), el('th', {}, 'Cravadas'))));
  const tb = el('tbody');
  data.forEach((r, i) => {
    const me = state.session && r.user_id === state.session.user.id;
    tb.append(el('tr', { className: me ? 'me' : '' },
      el('td', { className: 'rank-pos' }, medal(i)),
      el('td', { className: 'left team-cell' },
        r.avatar_url ? el('img', { className: 'avatar avatar--sm', src: r.avatar_url, alt: '' })
                     : el('span', { className: 'avatar avatar--sm avatar--ph' }, (r.full_name || '?')[0]),
        el('span', {}, r.full_name || 'Anônimo')),
      el('td', { className: 'b' }, String(r.total_points)),
      el('td', {}, String(r.exact_hits))));
  });
  tbl.append(tb);
  card.append(tbl);
  main.append(card);
}
const medal = (i) => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1);

// ---------- aba: regras ----------
function renderRules() {
  const card = el('div', { className: 'card prose' });
  card.innerHTML = `
    <h2 class="section-title">📋 Como funciona</h2>
    <ul>
      <li>Entre com sua conta <b>Google</b> e dê seu palpite no placar de cada jogo.</li>
      <li>Os palpites de um jogo fecham automaticamente no <b>horário do apito inicial</b>.</li>
    </ul>
    <h3>Pontuação</h3>
    <table class="rules-pts">
      <tr><td><span class="pts pts--10">+10</span></td><td>Cravou o <b>placar exato</b> (ex.: palpitou 2×1 e foi 2×1)</td></tr>
      <tr><td><span class="pts pts--5">+5</span></td><td>Acertou o <b>resultado</b> (vencedor ou empate), mas não o placar</td></tr>
      <tr><td><span class="pts pts--0">+0</span></td><td>Errou o resultado</td></tr>
    </table>
    <h3>Calendário</h3>
    <ul>
      <li><b>Fase de grupos:</b> 11 a 27 de junho de 2026</li>
      <li><b>32-avos:</b> 28/jun a 3/jul · <b>Oitavas:</b> 4–7/jul · <b>Quartas:</b> 9–12/jul</li>
      <li><b>Semifinais:</b> 14–15/jul · <b>3º lugar:</b> 18/jul · <b>Final:</b> 19/jul (Nova York/NJ)</li>
    </ul>
    <p class="muted">Datas/horários da fase de grupos são aproximados, exceto os jogos oficialmente confirmados.</p>`;
  return card;
}

// ---------- aba: admin ----------
function renderAdmin() {
  const card = el('div', { className: 'card' });
  card.append(el('h2', { className: 'section-title' }, '⚙️ Lançar resultados (admin)'));
  card.append(el('p', { className: 'muted' }, 'Preencha o placar oficial e clique em Salvar. Isso recalcula a pontuação de todos.'));

  const list = el('div', { className: 'admin-list' });
  for (const m of state.matches) {
    const inH = scoreInput(m.home_score);
    const inA = scoreInput(m.away_score);
    const st = el('span', { className: 'save-status' });
    const btn = el('button', { className: 'btn btn--sm' }, m.status === 'finished' ? 'Atualizar' : 'Salvar');
    btn.onclick = () => saveResult(m, inH, inA, st, btn);
    list.append(el('div', { className: 'admin-row' },
      el('span', { className: 'admin-grp' }, m.group_code),
      el('span', { className: 'admin-teams' }, `${m.home_team} × ${m.away_team}`),
      inH, el('span', { className: 'vs' }, '×'), inA, btn, st));
  }
  card.append(list);
  return card;
}

async function saveResult(m, inH, inA, st, btn) {
  const h = parseInt(inH.value, 10), a = parseInt(inA.value, 10);
  if (Number.isNaN(h) || Number.isNaN(a)) { st.textContent = 'preencha o placar'; st.className = 'save-status err'; return; }
  btn.disabled = true; st.textContent = 'salvando…'; st.className = 'save-status saving';
  const { error } = await supabase.from('matches')
    .update({ home_score: h, away_score: a, status: 'finished' }).eq('id', m.id);
  btn.disabled = false;
  if (error) { st.textContent = '✕ erro'; st.className = 'save-status err'; console.error(error); return; }
  m.home_score = h; m.away_score = a; m.status = 'finished';
  st.textContent = '✓ salvo'; st.className = 'save-status ok';
  renderHeader();
  render();
}

// ---------- util ----------
function groupBy(arr, fn) {
  const map = new Map();
  for (const x of arr) { const k = fn(x); (map.get(k) || map.set(k, []).get(k)).push(x); }
  return map;
}
function googleIcon() {
  const span = el('span', { className: 'g-icon' });
  span.innerHTML = `<svg viewBox="0 0 48 48" width="18" height="18"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C39.9 36.5 44 31 44 24c0-1.3-.1-2.3-.4-3.5z"/></svg>`;
  return span;
}

init();
