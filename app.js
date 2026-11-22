/* 그래서 우리 뭐 먹음? — 주변 식당 자동 수집 + 룰렛
   프로토타입은 키 없이 쓰는 OpenStreetMap(Overpass·Nominatim) 데이터를 씁니다.
   정식 버전은 카카오 로컬 API로 바꿀 계획(국내 가게 정보가 더 많음). 위치는 서버에 저장하지 않습니다.
   S6: 종류→가게 2단계 룰렛, 직접 추가·고정·영구 제외, 최근 당첨 빼기, 같이 고르기(링크, 서버 없음), 빈 결과 안내 */
'use strict';

const CATS = [
  { id: 'all', name: '전체', ico: '🍽' }, { id: 'korean', name: '한식', ico: '🍚' }, { id: 'chinese', name: '중식', ico: '🥟' }, { id: 'japanese', name: '일식', ico: '🍣' },
  { id: 'western', name: '양식', ico: '🍝' }, { id: 'snack', name: '분식·간편식', ico: '🍙' }, { id: 'chicken', name: '치킨', ico: '🍗' }, { id: 'cafe', name: '카페', ico: '☕' }, { id: 'etc', name: '기타', ico: '🍴' }
];
const CAT_IDS = CATS.map(c => c.id).filter(id => id !== 'all');
const DEMO = [
  ['든든 국밥집', 'korean', 120], ['할머니 김밥', 'snack', 180], ['짜장 명가', 'chinese', 210], ['오늘의 돈카츠', 'japanese', 260],
  ['파스타 공방', 'western', 300], ['바삭 치킨', 'chicken', 330], ['동네 떡볶이', 'snack', 90], ['제육 한 판', 'korean', 150],
  ['라멘 연구소', 'japanese', 410], ['수제버거 하우스', 'western', 380], ['마라 한 그릇', 'chinese', 450], ['우리 카페', 'cafe', 60]
].map(([name, cat, dist], i) => ({ id: 'demo' + i, name, cat, dist, lat: null, lon: null }));
const COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#748ffc', '#da77f2', '#f783ac', '#a9e34b', '#63e6be', '#ffc078'];
const RADII = [300, 500, 1000, 2000];
const RECENT_SKIP = 3;
const MAX_SLOTS = 12;

/* 이번 접속 동안의 상태(세션) */
const st = Object.assign({ center: null, label: '', radius: 500, places: [], off: [], cat: 'all', demo: false, mode: 'place', skipRecent: true, veto: [] },
  store.sget('mr-state', {}));
const save = () => store.sset('mr-state', st);
/* 오래 기억할 것(이 기기): 영구 제외·고정·직접 추가·최근 당첨 — 가게 이름으로 기억 */
const keep = Object.assign({ ban: [], pin: [], custom: [], recent: [] }, store.get('mr-keep', {}));
const saveKeep = () => store.set('mr-keep', keep);

const radLabel = r => r < 1000 ? r + 'm' : (r / 1000) + 'km';
const catOfId = id => CATS.find(c => c.id === id) || CATS[CATS.length - 1];
const catName = id => catOfId(id).name;
const distText = p => p.dist == null ? '직접 추가' : p.dist + 'm';
const mapLink = p => 'https://map.kakao.com/link/search/' + encodeURIComponent(p.name);
const isBanned = p => keep.ban.includes(p.name);
const isPinned = p => keep.pin.includes(p.name);

function catOf(tags) {
  const c = (tags.cuisine || '').toLowerCase();
  if (tags.amenity === 'cafe') return 'cafe';
  if (/chicken/.test(c)) return 'chicken';
  if (/korean/.test(c)) return 'korean';
  if (/chinese/.test(c)) return 'chinese';
  if (/japanese|sushi|ramen|udon/.test(c)) return 'japanese';
  if (/italian|pizza|burger|american|western|steak|french|mexican/.test(c)) return 'western';
  if (tags.amenity === 'fast_food' || /snack|noodle|sandwich/.test(c)) return 'snack';
  return 'etc';
}
function dist(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
/* Overpass 서버가 바쁘면 다른 공개 서버로 한 번 더 */
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
async function fetchPlaces(center, radius) {
  const q = `[out:json][timeout:20];(nwr["amenity"~"^(restaurant|fast_food|cafe|food_court)$"](around:${radius},${center.lat},${center.lon}););out center 150;`;
  let lastErr = null;
  for (const url of OVERPASS) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl && ctl.signal });
      if (!res.ok) throw new Error('가게 정보 서버가 바빠요 (' + res.status + ')');
      const data = await res.json();
      const seen = new Set();
      return (data.elements || []).map(el => {
        const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
        const name = el.tags?.['name:ko'] || el.tags?.name;
        if (!name || lat == null || seen.has(name)) return null;
        seen.add(name);
        return { id: el.type + el.id, name, cat: catOf(el.tags), lat, lon, dist: Math.round(dist(center, { lat, lon })) };
      }).filter(Boolean).sort((a, b) => a.dist - b.dist);
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error('가게 정보 서버가 응답하지 않아요') : e;
    } finally { if (timer) clearTimeout(timer); }
  }
  throw lastErr || new Error('가게 정보를 가져오지 못했어요');
}
async function geocode(text) {
  const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=kr&accept-language=ko&q=' + encodeURIComponent(text));
  const d = await res.json();
  if (!d.length) throw new Error('그런 곳을 찾지 못했어요');
  return { lat: Number(d[0].lat), lon: Number(d[0].lon), label: d[0].display_name.split(',').slice(0, 2).join(',') };
}

/* 수집한 가게 + 직접 추가한 가게(이름 중복 제거) */
function allPlaces() {
  const names = new Set(st.places.map(p => p.name));
  return st.places.concat(keep.custom.filter(p => !names.has(p.name)));
}
const recentNames = () => keep.recent.slice(0, RECENT_SKIP).map(r => r.name);
/* 룰렛 후보: 체크 해제·영구 제외·친구 거부·종류 필터 반영, 최근 당첨은 남는 곳이 있을 때만 뺌 */
function candidates(cat = st.cat) {
  const base = allPlaces().filter(p => !st.off.includes(p.id) && !isBanned(p) && !st.veto.includes(p.name) && (cat === 'all' || p.cat === cat));
  if (!st.skipRecent) return base;
  const rn = recentNames();
  const fresh = base.filter(p => !rn.includes(p.name));
  return fresh.length ? fresh : base;
}
/* 룰렛 칸: 고정한 가게를 먼저, 나머지는 무작위로 채움(최대 12칸) */
function pickSlots(pool) {
  const pinned = pool.filter(isPinned).slice(0, MAX_SLOTS);
  const rest = pool.filter(p => !isPinned(p)).sort(() => Math.random() - .5).slice(0, MAX_SLOTS - pinned.length);
  return pinned.concat(rest).sort(() => Math.random() - .5);
}
function addRecent(p) {
  keep.recent = [{ name: p.name, cat: p.cat, t: Date.now() }].concat(keep.recent.filter(r => r.name !== p.name)).slice(0, 10);
  saveKeep();
}
function toggleIn(list, name) { const i = list.indexOf(name); if (i < 0) list.push(name); else list.splice(i, 1); saveKeep(); return i < 0; }

/* ---------- 같이 고르기 링크 (서버 없이 후보를 링크에 담음) ---------- */
function voteLink(list, veto) {
  const d = encodeData({ l: String(st.label || '').slice(0, 40), x: st.demo ? 1 : 0, p: list.slice(0, 30).map(p => [p.name.slice(0, 40), p.cat, p.dist == null ? -1 : p.dist]), v: veto.slice(0, 30) });
  return location.href.split('#')[0] + '#/vote?d=' + d;
}
function parseVote(str) {
  const d = decodeData(str || '');
  if (!d || !Array.isArray(d.p)) return null;
  const p = d.p.filter(x => Array.isArray(x) && typeof x[0] === 'string' && x[0].trim()).slice(0, 30).map((x, i) => ({
    id: (d.x ? 'demo' : 'v') + i, name: x[0].trim().slice(0, 40), cat: CAT_IDS.includes(x[1]) ? x[1] : 'etc',
    dist: Number.isFinite(x[2]) && x[2] >= 0 ? Math.round(x[2]) : null, lat: null, lon: null
  }));
  if (!p.length) return null;
  const names = p.map(x => x.name);
  const v = Array.isArray(d.v) ? d.v.filter(n => typeof n === 'string' && names.includes(n)) : [];
  return { label: typeof d.l === 'string' ? d.l.slice(0, 40) : '', demo: !!d.x, p, v: [...new Set(v)] };
}
function shareVote(list, veto) {
  shareText('그래서 우리 뭐 먹음? — 같이 고르기', `오늘 후보 ${list.length}곳! 싫은 곳에 거부권 쓰고 돌려 보자 🎡`, voteLink(list, veto));
}

/* ---------- 랜딩 ---------- */
Router.on('/', root => {
  root.append(h(`
    <section class="hero">
      <div class="wheel-icon">🎡</div>
      <h1>그래서<br>우리 뭐 먹음?</h1>
      <p class="muted">고민은 룰렛에게. 지금 있는 곳 주변 식당을 자동으로 모아서 돌려 드려요.</p>
      <button class="btn primary big block" id="here">📍 내 주변으로 룰렛 만들기</button>
      <form class="row search" id="f"><input type="search" id="q" placeholder="또는 지역 검색 (예: 전주대학교)" aria-label="지역 검색"><button class="btn">검색</button></form>
      <button class="btn ghost block" id="demo">예시 가게로 먼저 체험하기</button>
      <p class="muted small" id="msg" role="status"></p>
      <div class="feats"><span>🍱 종류 먼저 → 가게 2단계</span><span>📌 고정 · 🚫 다신 안 감</span><span>🤝 링크로 같이 고르기</span></div>
    </section>`));
  const msg = t => { $('#msg').textContent = t; };
  async function load(center, label) {
    msg('주변 가게를 모으는 중… (최대 30초)');
    try {
      const places = await fetchPlaces(center, st.radius);
      Object.assign(st, { center, label, places, off: [], cat: 'all', demo: false, veto: [], failed: false }); save();
      Router.go('/nearby');
    } catch (e) {
      Object.assign(st, { center, label, places: [], off: [], cat: 'all', demo: false, veto: [], failed: true }); save();
      msg(e.message + ' — 잠시 뒤 다시 하거나 예시 가게로 체험해 보세요.');
    }
  }
  $('#here').onclick = () => {
    if (!navigator.geolocation) { msg('이 기기는 위치를 지원하지 않아요. 지역 검색을 써 주세요.'); return; }
    msg('위치를 확인하는 중…');
    navigator.geolocation.getCurrentPosition(p => load({ lat: p.coords.latitude, lon: p.coords.longitude }, '내 주변'),
      () => msg('위치 권한이 없어요. 지역 검색을 써 주세요.'), { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  };
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const q = $('#q').value.trim(); if (!q) return;
    msg('찾는 중…');
    try { const g = await geocode(q); load({ lat: g.lat, lon: g.lon }, g.label); } catch (err) { msg(err.message === 'Failed to fetch' ? '지역 검색 서버에 연결하지 못했어요. 예시 가게로 체험해 보세요.' : err.message); }
  };
  $('#demo').onclick = () => { Object.assign(st, { center: null, label: '예시 동네', places: DEMO, off: [], cat: 'all', demo: true, veto: [], failed: false }); save(); Router.go('/nearby'); };
});

/* ---------- 후보 고르기 ---------- */
Router.on('/nearby', root => {
  if (!st.places.length && !st.center && !keep.custom.length) { Router.go('/'); return; }
  root.append(h(`
    <section class="stack">
      <div class="row"><h2 style="margin:0">📍 ${esc(st.label || '내 주변')}</h2><span class="grow"></span><a class="small muted" href="#/">위치 바꾸기</a></div>
      ${st.demo ? '<div class="notice">예시 가게예요. 진짜 주변 가게로 하려면 위치를 허용하거나 지역을 검색하세요.</div>' : st.center ? `
      <div class="row" id="rad">${RADII.map(r => `<button class="chip ${st.radius === r ? 'on' : ''}" data-r="${r}">${radLabel(r)}</button>`).join('')}</div>` : '<div class="notice">친구가 보낸 후보예요.</div>'}
      <div class="split s37"><div class="stack sticky">
      <div class="row cats" id="cats">${CATS.map(c => `<button class="chip ${st.cat === c.id ? 'on' : ''}" data-c="${c.id}">${c.name}</button>`).join('')}</div>
      <form class="row addf" id="addf"><input type="text" id="addname" maxlength="30" placeholder="가게 직접 추가 (예: 학교 앞 순대국)" aria-label="추가할 가게 이름">
        <select id="addcat" aria-label="추가할 가게 종류">${CATS.filter(c => c.id !== 'all').map(c => `<option value="${c.id}">${c.name}</option>`).join('')}</select><button class="btn">추가</button></form>
      <a class="btn primary big block" id="go" href="#/roulette">룰렛 돌리러 가기</a>
      <button class="btn block" id="votebtn" type="button">🤝 친구에게 후보 보내기 (같이 고르기)</button>
      <p class="muted small">📌 고정하면 룰렛에 꼭 올라가요 · 🚫 다신 안 감은 이 기기에 계속 기억돼요</p>
      </div>
      <div class="stack"><div class="card list" id="list"></div><div id="banned"></div></div>
      </div>
      ${st.demo || !st.center ? '' : '<p class="muted small center">가게 정보 © OpenStreetMap 기여자 · 실제 영업 여부와 다를 수 있어요</p>'}
    </section>`));
  let loading = false;
  function emptyCard() {
    const bigger = RADII.filter(r => r > st.radius);
    const why = st.failed ? '가게 정보 서버에 연결하지 못했어요.' : `반경 ${radLabel(st.radius)} 안에 OpenStreetMap에 등록된 식당이 없어요.`;
    return `<div class="empty" id="empty"><div class="em">🍽️❓</div><b>${why}</b>
      <p class="muted small">OpenStreetMap은 지역마다 등록된 가게 수가 달라요. 아래 방법으로 이어서 할 수 있어요.</p>
      <div class="stack">${st.center && bigger.length ? `<button class="btn primary block" id="wider" data-r="${bigger[bigger.length - 1]}">반경 ${radLabel(bigger[bigger.length - 1])}로 넓혀 다시 찾기</button>` : ''}
      ${st.failed && st.center ? '<button class="btn block" id="retry">다시 시도</button>' : ''}
      <button class="btn block" id="addfocus">아는 가게를 직접 추가하기</button>
      <a class="btn ghost block" href="#/">다른 지역 검색</a><button class="btn ghost block" id="todemo">예시 가게로 체험</button></div></div>`;
  }
  async function refetch(r) {
    if (loading || !st.center) return;
    loading = true;
    if (r) st.radius = r;
    save();
    $$('#rad .chip').forEach(x => x.classList.toggle('on', Number(x.dataset.r) === st.radius));
    $('#list').innerHTML = '<p class="muted">다시 모으는 중… (최대 30초)</p>';
    try { st.places = await fetchPlaces(st.center, st.radius); st.failed = false; } catch (e) { st.failed = !st.places.length; toast(e.message); }
    save(); loading = false; render();
  }
  function render() {
    const all = allPlaces();
    const inCat = all.filter(p => !isBanned(p) && (st.cat === 'all' || p.cat === st.cat));
    const rn = recentNames();
    const noneHere = (st.center && !st.demo && !st.places.length) || !all.filter(p => !isBanned(p)).length;
    $('#list').innerHTML = (noneHere ? emptyCard() : '') + (inCat.length ? inCat.map(p => `
      <div class="place ${st.off.includes(p.id) ? 'off' : ''} ${isPinned(p) ? 'pinned' : ''}">
        <label class="grow pl"><input type="checkbox" data-id="${esc(p.id)}" ${st.off.includes(p.id) ? '' : 'checked'}>
        <span class="grow"><b>${esc(p.name)}</b><span class="muted small"> · ${catName(p.cat)}${rn.includes(p.name) ? ' · <span class="tag">최근 당첨</span>' : ''}${st.veto.includes(p.name) ? ' · <span class="tag">거부됨</span>' : ''}</span></span><span class="muted small">${distText(p)}</span></label>
        <button class="ib pin ${isPinned(p) ? 'on' : ''}" type="button" data-pin="${esc(p.name)}" aria-pressed="${isPinned(p)}" title="${isPinned(p) ? '고정 풀기' : '룰렛에 꼭 올리기(고정)'}">📌</button>
        <button class="ib ban" type="button" data-ban="${esc(p.name)}" title="다신 안 감(영구 제외)">🚫</button>
      </div>`).join('') : noneHere ? '' : '<p class="muted">이 종류의 가게가 없어요.</p>');
    $$('#list input[type=checkbox]').forEach(cb => cb.onchange = () => {
      if (cb.checked) st.off = st.off.filter(x => x !== cb.dataset.id); else st.off.push(cb.dataset.id);
      save(); render();
    });
    $$('#list [data-pin]').forEach(b => b.onclick = () => { const on = toggleIn(keep.pin, b.dataset.pin); toast(on ? '📌 고정했어요. 룰렛에 꼭 올라가요' : '고정을 풀었어요'); render(); });
    $$('#list [data-ban]').forEach(b => b.onclick = () => { toggleIn(keep.ban, b.dataset.ban); keep.pin = keep.pin.filter(n => n !== b.dataset.ban); saveKeep(); toast('🚫 다신 안 감 목록에 넣었어요'); render(); });
    const e = $('#empty');
    if (e) {
      const w = $('#wider'); if (w) w.onclick = () => refetch(Number(w.dataset.r));
      const rt = $('#retry'); if (rt) rt.onclick = () => refetch();
      $('#addfocus').onclick = () => $('#addname').focus();
      $('#todemo').onclick = () => { Object.assign(st, { center: null, label: '예시 동네', places: DEMO, off: [], cat: 'all', demo: true, veto: [], failed: false }); save(); dispatchEvent(new HashChangeEvent('hashchange')); };
    }
    const banned = keep.ban;
    $('#banned').innerHTML = banned.length ? `<details class="card banned"><summary>🚫 다신 안 감 ${banned.length}곳</summary>
      ${banned.map(n => `<div class="row bn"><span class="grow">${esc(n)}</span><button class="btn" type="button" data-unban="${esc(n)}">되살리기</button></div>`).join('')}</details>` : '';
    $$('#banned [data-unban]').forEach(b => b.onclick = () => { keep.ban = keep.ban.filter(n => n !== b.dataset.unban); saveKeep(); toast('다시 후보에 넣었어요'); render(); });
    const n = candidates().length;
    $('#go').textContent = n ? `후보 ${n}곳으로 룰렛 돌리기` : '후보가 없어요';
    $('#go').classList.toggle('disabled', !n);
  }
  $$('#cats .chip').forEach(b => b.onclick = () => { st.cat = b.dataset.c; save(); $$('#cats .chip').forEach(x => x.classList.toggle('on', x === b)); render(); });
  $$('#rad .chip').forEach(b => b.onclick = () => refetch(Number(b.dataset.r)));
  $('#addf').onsubmit = e => {
    e.preventDefault();
    const name = $('#addname').value.trim().slice(0, 30);
    if (!name) { toast('가게 이름을 적어 주세요'); return; }
    if (allPlaces().some(p => p.name === name)) { toast('이미 있는 가게예요'); return; }
    keep.custom.push({ id: 'my' + Date.now().toString(36), name, cat: $('#addcat').value, dist: null, lat: null, lon: null });
    keep.ban = keep.ban.filter(n => n !== name);
    saveKeep(); $('#addname').value = ''; toast(`"${name}" 추가!`); Sfx.play('ok'); render();
  };
  $('#votebtn').onclick = () => { const list = candidates('all'); if (!list.length) { toast('보낼 후보가 없어요'); return; } shareVote(list, st.veto); };
  $('#go').onclick = e => { if (!candidates().length) { e.preventDefault(); toast('후보를 하나 이상 남겨 주세요'); } };
  render();
});

/* ---------- 같이 고르기: 친구가 보낸 링크 ---------- */
Router.on('/vote', (root, params) => {
  const v = parseVote(params.get('d'));
  if (!v) {
    root.append(h(`<section class="stack center"><div class="em">🔗❓</div><h2>링크가 깨졌어요</h2><p class="muted">후보가 담긴 링크를 다시 받아 주세요.</p><a class="btn primary" href="#/">내 주변으로 새로 만들기</a></section>`));
    return;
  }
  const mine = [];
  root.append(h(`
    <section class="stack">
      <div class="center"><div class="muted small">🤝 같이 고르기</div><h2 style="margin:4px 0">친구가 보낸 후보 ${v.p.length}곳</h2>
      <p class="muted small">${v.label ? esc(v.label) + ' · ' : ''}싫은 곳에 <b>거부권</b>을 써요 (한 사람 2번까지). 거부된 곳은 룰렛에서 빠져요.</p></div>
      <div class="split s37"><div class="stack sticky">
        <div class="card center"><div class="big-n" id="left"></div><div class="muted small">룰렛에 올라갈 곳</div></div>
        <button class="btn primary big block" id="spinit">이 후보로 룰렛 돌리기</button>
        <button class="btn block" id="pass">내 거부권 반영해서 다시 보내기</button>
      </div>
      <div class="card list" id="vlist"></div></div>
    </section>`));
  function render() {
    const vetoed = v.v.concat(mine);
    $('#vlist').innerHTML = v.p.map(p => {
      const byFriend = v.v.includes(p.name), byMe = mine.includes(p.name);
      return `<div class="place ${byFriend || byMe ? 'off' : ''}"><span class="grow"><b>${esc(p.name)}</b><span class="muted small"> · ${catName(p.cat)} · ${distText(p)}</span>
        ${byFriend ? '<span class="tag">누군가 거부함</span>' : ''}</span>
        ${byFriend ? '' : `<button class="btn veto ${byMe ? 'on' : ''}" type="button" data-veto="${esc(p.name)}" aria-pressed="${byMe}">${byMe ? '거부 취소' : '✋ 거부'}</button>`}</div>`;
    }).join('');
    const left = v.p.filter(p => !vetoed.includes(p.name)).length;
    $('#left').textContent = left + '곳';
    $('#spinit').classList.toggle('disabled', !left);
    $$('#vlist [data-veto]').forEach(b => b.onclick = () => {
      const n = b.dataset.veto, i = mine.indexOf(n);
      if (i >= 0) mine.splice(i, 1);
      else if (mine.length >= 2) { toast('거부권은 한 사람 2번까지예요'); return; }
      else if (v.p.length - v.v.length - mine.length <= 1) { toast('한 곳은 남겨 둬야 돌릴 수 있어요'); return; }
      else { mine.push(n); Sfx.play('bad'); }
      render();
    });
  }
  $('#pass').onclick = () => shareVote(v.p, v.v.concat(mine));
  $('#spinit').onclick = () => {
    const vetoed = v.v.concat(mine);
    if (!v.p.some(p => !vetoed.includes(p.name))) { toast('남은 후보가 없어요'); return; }
    Object.assign(st, { center: null, label: v.label || '친구가 보낸 후보', places: v.p, off: [], cat: 'all', demo: v.demo, veto: vetoed, failed: false });
    save(); Router.go('/roulette');
  };
  render();
});

/* ---------- 룰렛 ---------- */
Router.on('/roulette', root => {
  if (!candidates().length) { Router.go('/nearby'); return; }
  let pool, slots, stage = 'place', chosenCat = null;
  root.append(h(`
    <section class="split center rl">
      <div class="stack">
      <div class="seg" role="group" aria-label="룰렛 방식"><button type="button" data-mode="place">🏪 가게 바로</button><button type="button" data-mode="cat">🍱 종류 먼저 → 가게</button></div>
      <div class="stage muted small" id="stage" aria-live="polite"></div>
      <div class="wheel-wrap"><div class="pointer"></div><canvas id="w" width="640" height="640" role="img" aria-label="룰렛 원판"></canvas><button class="spin" id="spin">돌려!</button></div>
      </div>
      <div class="stack center">
      <div class="pc-only muted">가운데 버튼을 눌러 돌려 보세요</div>
      <div id="win" class="win hidden" aria-live="polite"></div>
      <div class="row"><button class="btn grow" id="shuffle">섞기</button><a class="btn grow" href="#/nearby">후보 고치기</a></div>
      <label class="row small opt"><input type="checkbox" id="skip" ${st.skipRecent ? 'checked' : ''}> 최근 당첨 ${RECENT_SKIP}곳은 빼고 돌리기</label>
      <div class="recent small muted" id="recent"></div>
      <button class="btn ghost block" id="votebtn" type="button">🤝 친구에게 후보 보내고 거부권 받기</button>
      <p class="muted small">Space 또는 Enter로도 돌릴 수 있어요 · 후보가 12곳보다 많으면 고정한 곳 + 무작위로 12곳만 올려요</p>
      </div>
    </section>`));
  const cv = $('#w'), c2 = cv.getContext('2d');
  let angle = 0, spinning = false, raf = 0, nextTimer = 0;
  const label = s => s.isCat ? s.ico + ' ' + s.name : (isPinned(s) ? '📌' : '') + s.name;
  function setup(keepStage) {
    if (!keepStage) { stage = st.mode === 'cat' ? 'cat' : 'place'; chosenCat = null; }
    if (stage === 'cat') {
      const all = candidates('all');
      const cats = CAT_IDS.filter(id => all.some(p => p.cat === id));
      slots = cats.map(id => { const c = catOfId(id); return { name: c.name, ico: c.ico, cat: id, isCat: true, n: all.filter(p => p.cat === id).length }; });
      pool = slots;
    } else {
      pool = chosenCat ? candidates('all').filter(p => p.cat === chosenCat) : candidates();
      slots = pickSlots(pool);
    }
    $$('.seg button').forEach(b => { const on = b.dataset.mode === st.mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    $('#stage').innerHTML = stage === 'cat' ? '1단계: 오늘 땡기는 <b>종류</b>부터 정해요' : chosenCat ? `2단계: <b>${catOfId(chosenCat).ico} ${catName(chosenCat)}</b> 가게 중에서 골라요` : `후보 ${pool.length}곳${pool.length > MAX_SLOTS ? ` 중 ${MAX_SLOTS}곳` : ''}`;
    $('#shuffle').textContent = stage === 'place' && pool.length > MAX_SLOTS ? '후보 다시 뽑기' : '섞기';
    renderRecent();
    draw();
  }
  function renderRecent() {
    $('#recent').innerHTML = keep.recent.length ? '최근 당첨: ' + keep.recent.slice(0, 5).map((r, i) => `<span class="${i < RECENT_SKIP && st.skipRecent ? 'rs' : ''}">${esc(r.name)}</span>`).join(' · ') : '';
  }
  function draw() {
    const n = slots.length, R = 300, cx = 320, cy = 320, seg = Math.PI * 2 / n;
    c2.clearRect(0, 0, 640, 640);
    slots.forEach((p, k) => {
      const a0 = angle + k * seg - Math.PI / 2;
      c2.beginPath(); c2.moveTo(cx, cy); c2.arc(cx, cy, R, a0, a0 + seg); c2.closePath();
      c2.fillStyle = COLORS[k % COLORS.length]; c2.fill();
      c2.strokeStyle = '#fff'; c2.lineWidth = 3; c2.stroke();
      c2.save(); c2.translate(cx, cy); c2.rotate(a0 + seg / 2);
      c2.fillStyle = '#1b1b22'; c2.font = `700 ${n > 8 ? 22 : 26}px Pretendard, sans-serif`; c2.textAlign = 'right'; c2.textBaseline = 'middle';
      const t = label(p);
      c2.fillText(t.length > 9 ? t.slice(0, 8) + '…' : t, R - 18, 0);
      c2.restore();
    });
    c2.beginPath(); c2.arc(cx, cy, 52, 0, Math.PI * 2); c2.fillStyle = '#fff'; c2.fill();
  }
  function spin() {
    if (spinning || !slots.length) return;
    clearTimeout(nextTimer);
    spinning = true; $('#win').classList.add('hidden');
    const n = slots.length, seg = Math.PI * 2 / n;
    const target = Math.floor(Math.random() * n);
    // 포인터(위쪽)가 target 칸의 가운데를 가리키도록 최종 각도 계산
    const final = -(target * seg + seg / 2) + (Math.random() - .5) * seg * .6;
    const start = angle, total = (Math.PI * 2) * (5 + Math.floor(Math.random() * 3)) + ((final - start) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    const dur = Motion.reduced ? 1200 : 4200, t0 = performance.now();
    let lastSeg = -1;
    const tick = now => {
      const t = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - t, 4);
      angle = start + total * e;
      const s = Math.floor((((-angle) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / seg);
      if (s !== lastSeg) { lastSeg = s; vibrate(5); Sfx.play('tick'); }
      draw();
      if (t < 1) raf = requestAnimationFrame(tick);
      else { spinning = false; slots[target].isCat ? showCat(slots[target]) : show(slots[target]); }
    };
    raf = requestAnimationFrame(tick);
  }
  function showCat(c) {
    Sfx.play('ok'); vibrate(30);
    const w = $('#win');
    w.innerHTML = `<div class="muted small">1단계 결과</div><div class="wn">${c.ico} 오늘은 ${esc(c.name)}!</div><div class="muted">${c.n}곳 중에서 가게를 골라요</div>
      <div class="row" style="justify-content:center;margin-top:10px"><button class="btn primary" id="next">가게 룰렛으로 →</button><button class="btn" id="again">종류 다시</button></div>`;
    w.classList.remove('hidden');
    const go = () => { clearTimeout(nextTimer); stage = 'place'; chosenCat = c.cat; setup(true); w.classList.add('hidden'); if (slots.length === 1) show(slots[0]); };
    $('#next').onclick = go;
    $('#again').onclick = spin;
    nextTimer = setTimeout(() => { if (!spinning && stage === 'cat') go(); }, 2600);
  }
  function show(p) {
    vibrate([40, 30, 80]); Sfx.play('win');
    addRecent(p); renderRecent();
    const w = $('#win');
    w.innerHTML = `<div class="muted small">오늘은 여기!</div><div class="wn">${esc(p.name)}</div><div class="muted">${catName(p.cat)} · ${distText(p)}</div>
      <div class="row" style="justify-content:center;margin-top:10px">${p.id.startsWith('demo') ? '' : `<a class="btn primary" href="${mapLink(p)}" target="_blank" rel="noopener noreferrer">지도에서 보기</a>`}<button class="btn" id="again">한 번 더</button><button class="btn" id="share">단톡에 보내기</button><button class="btn ghost" id="never" type="button">🚫 다신 안 감</button></div>`;
    w.classList.remove('hidden');
    $('#again').onclick = () => { if (st.mode === 'cat') { setup(); } spin(); };
    $('#share').onclick = () => shareText('그래서 우리 뭐 먹음?', `룰렛 결과: 오늘은 "${p.name}" (${catName(p.cat)}, ${distText(p)}) 이의 없음?`, location.href.split('#')[0]);
    $('#never').onclick = () => {
      if (!isBanned(p)) keep.ban.push(p.name);
      keep.pin = keep.pin.filter(n => n !== p.name); saveKeep();
      toast(`"${p.name}" 다신 안 감! 룰렛에서 뺐어요`);
      w.classList.add('hidden');
      if (!candidates().length) { Router.go('/nearby'); return; }
      if (stage === 'place' && chosenCat && !candidates('all').some(x => x.cat === chosenCat)) setup(); else setup(true);
    };
  }
  $('#spin').onclick = spin;
  $$('.seg button').forEach(b => b.onclick = () => { if (spinning) return; st.mode = b.dataset.mode; save(); $('#win').classList.add('hidden'); clearTimeout(nextTimer); setup(); });
  $('#skip').onchange = () => { st.skipRecent = $('#skip').checked; save(); if (!spinning) setup(stage === 'place' && !!chosenCat); };
  $('#votebtn').onclick = () => shareVote(candidates('all'), st.veto);
  const onKey = e => {
    if ((e.key !== ' ' && e.key !== 'Enter') || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(e.target.tagName)) return;
    e.preventDefault(); spin();
  };
  addEventListener('keydown', onKey);
  $('#shuffle').onclick = () => { if (spinning) return; if (stage === 'place') { slots = pickSlots(pool); } else slots.sort(() => Math.random() - .5); draw(); };
  setup();
  return () => { cancelAnimationFrame(raf); clearTimeout(nextTimer); removeEventListener('keydown', onKey); };
});

Router.start($('#app'));
