/* 그래서 우리 뭐 먹음? — 주변 식당 자동 수집 + 룰렛
   프로토타입은 키 없이 쓰는 OpenStreetMap(Overpass·Nominatim) 데이터를 씁니다.
   정식 버전은 카카오 로컬 API로 바꿀 계획(국내 가게 정보가 더 많음). 위치는 서버에 저장하지 않습니다. */
'use strict';

const CATS = [
  { id: 'all', name: '전체' }, { id: 'korean', name: '한식' }, { id: 'chinese', name: '중식' }, { id: 'japanese', name: '일식' },
  { id: 'western', name: '양식' }, { id: 'snack', name: '분식·간편식' }, { id: 'chicken', name: '치킨' }, { id: 'cafe', name: '카페' }, { id: 'etc', name: '기타' }
];
const DEMO = [
  ['든든 국밥집', 'korean', 120], ['할머니 김밥', 'snack', 180], ['짜장 명가', 'chinese', 210], ['오늘의 돈카츠', 'japanese', 260],
  ['파스타 공방', 'western', 300], ['바삭 치킨', 'chicken', 330], ['동네 떡볶이', 'snack', 90], ['제육 한 판', 'korean', 150],
  ['라멘 연구소', 'japanese', 410], ['수제버거 하우스', 'western', 380], ['마라 한 그릇', 'chinese', 450], ['우리 카페', 'cafe', 60]
].map(([name, cat, dist], i) => ({ id: 'demo' + i, name, cat, dist, lat: null, lon: null }));
const COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#748ffc', '#da77f2', '#f783ac', '#a9e34b', '#63e6be', '#ffc078'];

const st = store.sget('mr-state', { center: null, label: '', radius: 500, places: [], off: [], cat: 'all', demo: false });
const save = () => store.sset('mr-state', st);

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
async function fetchPlaces(center, radius) {
  const q = `[out:json][timeout:20];(nwr["amenity"~"^(restaurant|fast_food|cafe|food_court)$"](around:${radius},${center.lat},${center.lon}););out center 120;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (!res.ok) throw new Error('가게 정보 서버가 바빠요 (' + res.status + ')');
  const data = await res.json();
  const seen = new Set();
  return data.elements.map(el => {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    const name = el.tags?.['name:ko'] || el.tags?.name;
    if (!name || lat == null || seen.has(name)) return null;
    seen.add(name);
    return { id: el.type + el.id, name, cat: catOf(el.tags), lat, lon, dist: Math.round(dist(center, { lat, lon })) };
  }).filter(Boolean).sort((a, b) => a.dist - b.dist);
}
async function geocode(text) {
  const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=kr&accept-language=ko&q=' + encodeURIComponent(text));
  const d = await res.json();
  if (!d.length) throw new Error('그런 곳을 찾지 못했어요');
  return { lat: Number(d[0].lat), lon: Number(d[0].lon), label: d[0].display_name.split(',').slice(0, 2).join(',') };
}
const candidates = () => st.places.filter(p => !st.off.includes(p.id) && (st.cat === 'all' || p.cat === st.cat));
const catName = id => (CATS.find(c => c.id === id) || CATS[0]).name;
const mapLink = p => 'https://map.kakao.com/link/search/' + encodeURIComponent(p.name);

/* ---------- 랜딩 ---------- */
Router.on('/', root => {
  root.append(h(`
    <section class="hero">
      <div class="wheel-icon">🎡</div>
      <h1>그래서<br>우리 뭐 먹음?</h1>
      <p class="muted">고민은 룰렛에게. 지금 있는 곳 주변 식당을 자동으로 모아서 돌려 드려요.</p>
      <button class="btn primary big block" id="here">📍 내 주변으로 룰렛 만들기</button>
      <form class="row search" id="f"><input type="search" id="q" placeholder="또는 지역 검색 (예: 전주대학교)"><button class="btn">검색</button></form>
      <button class="btn ghost block" id="demo">예시 가게로 먼저 체험하기</button>
      <p class="muted small" id="msg"></p>
    </section>`));
  const msg = t => { $('#msg').textContent = t; };
  async function load(center, label) {
    msg('주변 가게를 모으는 중… (최대 20초)');
    try {
      const places = await fetchPlaces(center, st.radius);
      Object.assign(st, { center, label, places, off: [], cat: 'all', demo: false }); save();
      if (!places.length) { msg('이 근처에서 가게를 찾지 못했어요. 반경을 넓히거나 다른 곳을 검색해 보세요.'); }
      Router.go('/nearby');
    } catch (e) { msg(e.message + ' — 잠시 뒤 다시 하거나 예시 가게로 체험해 보세요.'); }
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
    try { const g = await geocode(q); load({ lat: g.lat, lon: g.lon }, g.label); } catch (err) { msg(err.message); }
  };
  $('#demo').onclick = () => { Object.assign(st, { center: null, label: '예시 동네', places: DEMO, off: [], cat: 'all', demo: true }); save(); Router.go('/nearby'); };
});

/* ---------- 후보 고르기 ---------- */
Router.on('/nearby', root => {
  if (!st.places.length && !st.center) { Router.go('/'); return; }
  root.append(h(`
    <section class="stack">
      <div class="row"><h2 style="margin:0">📍 ${esc(st.label || '내 주변')}</h2><span class="grow"></span><a class="small muted" href="#/">위치 바꾸기</a></div>
      ${st.demo ? '<div class="notice">예시 가게예요. 진짜 주변 가게로 하려면 위치를 허용하거나 지역을 검색하세요.</div>' : `
      <div class="row" id="rad">${[300, 500, 1000].map(r => `<button class="chip ${st.radius === r ? 'on' : ''}" data-r="${r}">${r < 1000 ? r + 'm' : '1km'}</button>`).join('')}</div>`}
      <div class="split s37"><div class="stack sticky">
      <div class="row cats" id="cats">${CATS.map(c => `<button class="chip ${st.cat === c.id ? 'on' : ''}" data-c="${c.id}">${c.name}</button>`).join('')}</div>
      <a class="btn primary big block" id="go" href="#/roulette">룰렛 돌리러 가기</a>
      </div>
      <div class="card list" id="list"></div>
      </div>
      ${st.demo ? '' : '<p class="muted small center">가게 정보 © OpenStreetMap 기여자 · 실제 영업 여부와 다를 수 있어요</p>'}
    </section>`));
  function render() {
    const inCat = st.places.filter(p => st.cat === 'all' || p.cat === st.cat);
    $('#list').innerHTML = inCat.length ? inCat.map(p => `
      <label class="place ${st.off.includes(p.id) ? 'off' : ''}"><input type="checkbox" data-id="${p.id}" ${st.off.includes(p.id) ? '' : 'checked'}>
        <span class="grow"><b>${esc(p.name)}</b><span class="muted small"> · ${catName(p.cat)}</span></span><span class="muted small">${p.dist}m</span></label>`).join('')
      : '<p class="muted">이 종류의 가게가 없어요.</p>';
    $$('#list input').forEach(cb => cb.onchange = () => {
      if (cb.checked) st.off = st.off.filter(x => x !== cb.dataset.id); else st.off.push(cb.dataset.id);
      save(); render();
    });
    const n = candidates().length;
    $('#go').textContent = n ? `후보 ${n}곳으로 룰렛 돌리기` : '후보가 없어요';
    $('#go').classList.toggle('disabled', !n);
  }
  $$('#cats .chip').forEach(b => b.onclick = () => { st.cat = b.dataset.c; save(); $$('#cats .chip').forEach(x => x.classList.toggle('on', x === b)); render(); });
  $$('#rad .chip').forEach(b => b.onclick = async () => {
    st.radius = Number(b.dataset.r); save();
    $$('#rad .chip').forEach(x => x.classList.toggle('on', x === b));
    $('#list').innerHTML = '<p class="muted">다시 모으는 중…</p>';
    try { st.places = await fetchPlaces(st.center, st.radius); save(); } catch (e) { toast(e.message); }
    render();
  });
  $('#go').onclick = e => { if (!candidates().length) { e.preventDefault(); toast('후보를 하나 이상 남겨 주세요'); } };
  render();
});

/* ---------- 룰렛 ---------- */
Router.on('/roulette', root => {
  let pool = candidates();
  if (!pool.length) { Router.go('/nearby'); return; }
  const pickSlots = () => pool.length > 12 ? pool.slice().sort(() => Math.random() - .5).slice(0, 12) : pool.slice();
  let slots = pickSlots();
  root.append(h(`
    <section class="split center rl">
      <div class="wheel-wrap"><div class="pointer"></div><canvas id="w" width="640" height="640"></canvas><button class="spin" id="spin">돌려!</button></div>
      <div class="stack center">
      <div class="pc-only muted">가운데 버튼을 눌러 돌려 보세요</div>
      <div id="win" class="win hidden"></div>
      <div class="row"><button class="btn grow" id="shuffle">${pool.length > 12 ? '후보 다시 뽑기' : '섞기'}</button><a class="btn grow" href="#/nearby">후보 고치기</a></div>
      <p class="muted small">Space 또는 Enter로도 돌릴 수 있어요 · 후보가 12곳보다 많으면 무작위로 12곳만 올려요</p>
      </div>
    </section>`));
  const cv = $('#w'), c2 = cv.getContext('2d');
  let angle = 0, spinning = false, raf = 0;
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
      const name = p.name.length > 9 ? p.name.slice(0, 8) + '…' : p.name;
      c2.fillText(name, R - 18, 0);
      c2.restore();
    });
    c2.beginPath(); c2.arc(cx, cy, 52, 0, Math.PI * 2); c2.fillStyle = '#fff'; c2.fill();
  }
  function spin() {
    if (spinning) return;
    spinning = true; $('#win').classList.add('hidden');
    const n = slots.length, seg = Math.PI * 2 / n;
    const target = Math.floor(Math.random() * n);
    // 포인터(위쪽)가 target 칸의 가운데를 가리키도록 최종 각도 계산
    const final = -(target * seg + seg / 2) + (Math.random() - .5) * seg * .6;
    const start = angle, total = (Math.PI * 2) * (5 + Math.floor(Math.random() * 3)) + ((final - start) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    const dur = 4200, t0 = performance.now();
    let lastSeg = -1;
    const tick = now => {
      const t = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - t, 4);
      angle = start + total * e;
      const s = Math.floor((((-angle) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / seg);
      if (s !== lastSeg) { lastSeg = s; vibrate(5); }
      draw();
      if (t < 1) raf = requestAnimationFrame(tick);
      else { spinning = false; show(slots[target]); }
    };
    raf = requestAnimationFrame(tick);
  }
  function show(p) {
    vibrate([40, 30, 80]);
    const w = $('#win');
    w.innerHTML = `<div class="muted small">오늘은 여기!</div><div class="wn">${esc(p.name)}</div><div class="muted">${catName(p.cat)} · ${p.dist}m</div>
      <div class="row" style="justify-content:center;margin-top:10px">${p.id.startsWith('demo') ? '' : `<a class="btn primary" href="${mapLink(p)}" target="_blank" rel="noopener noreferrer">지도에서 보기</a>`}<button class="btn" id="again">한 번 더</button><button class="btn" id="share">단톡에 보내기</button></div>`;
    w.classList.remove('hidden');
    $('#again').onclick = spin;
    $('#share').onclick = () => shareText('그래서 우리 뭐 먹음?', `룰렛 결과: 오늘은 "${p.name}" (${catName(p.cat)}, ${p.dist}m) 이의 없음?`, location.href.split('#')[0]);
  }
  $('#spin').onclick = spin;
  const onKey = e => {
    if ((e.key !== ' ' && e.key !== 'Enter') || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(e.target.tagName)) return;
    e.preventDefault(); spin();
  };
  addEventListener('keydown', onKey);
  $('#shuffle').onclick = () => { if (spinning) return; slots = pickSlots(); if (pool.length <= 12) slots.sort(() => Math.random() - .5); draw(); };
  draw();
  return () => { cancelAnimationFrame(raf); removeEventListener('keydown', onKey); };
});

Router.start($('#app'));
