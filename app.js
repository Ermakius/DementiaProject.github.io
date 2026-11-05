'use strict';

/* ============================================================
   PWA
   ============================================================ */
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol))
  navigator.serviceWorker.register('sw.js').catch(() => {});

/* ============================================================
   КОНФИГ
   ============================================================ */
const $ = id => document.getElementById(id);
const KODIK = 'https://kodik-api.com';
const NTFY = 'https://ntfy.sh';
const PAGE_LIMIT = 100;         // Kodik отдаёт одну строку на озвучку — берём с запасом
const TTL = 15 * 60 * 1000;     // время жизни кеша подборок
const VERSION = 'anime-2.0';

/* Бэкенд (папка server/). Пусто — приложение работает напрямую с Kodik и ntfy.
   DEFAULT_API — адрес для всех посетителей: '' выключен, 'same' — тот же домен.
   Пользователь может переопределить его в настройках («Свой сервер»). */
const DEFAULT_API = 'https://dementiaproject2.cloudpub.ru';
const API_BASE = readApiBase();
const apiReady = API_BASE
  ? getJSON(API_BASE + '/api/health', 4000).then(() => true).catch(() => false)
  : Promise.resolve(false);

function readApiBase(){
  let v = null;
  try{ v = localStorage.getItem('anime_api'); }catch(e){}
  if (v === 'off') return '';
  if (v == null || v === '') v = DEFAULT_API;
  if (!v) return '';
  if (v === 'same') return location.origin;
  return v.replace(/\/+$/, '').replace(/\/api$/, '');
}

/* Токены Kodik зашифрованы (перевёрнутая перестановка base64). */
const ENC_TOKENS = [
  "==QO0ADM3kTZmRTNiRDNjFDM==QOxkDMzQjZ4ADZ4zNhZTN",
  "==QNyE2NzIjM4ETM3MmNklDM==gY5EzNxIzY0gjZ1kDZkFDN",
  "==wMjhDN5QzYkNjZyQmM2ETO==QYjZjYkRjNxMWZ3YTNidzN",
  "==QZiZDNxITZlFDZwIjZ3EjM==AN0UmZlVzN4UWO3EDZ3QDN"
];
function decryptToken(t){
  try{
    const h = Math.floor(t.length / 2);
    const a = t.substring(0, h).split('').reverse().join('');
    const b = t.substring(h).split('').reverse().join('');
    return atob(b) + atob(a);
  }catch(e){ return ''; }
}
const TOKENS = ENC_TOKENS.map(decryptToken).filter(t => /^[0-9a-f]{32}$/.test(t));

const GENRES = ['боевик','комедия','фэнтези','романтика','драма','детектив','приключения','фантастика',
  'сёнен','сёдзё','сэйнэн','дзёсэй','меха','спорт','музыка','ужасы','мистика','повседневность',
  'школа','исэкай','пародия','суперсила','вампиры','демоны','военное','исторический','космос',
  'магия','психологическое','триллер','гарем','киберпанк','самураи','детское'];

const KIND = { 'tv':'ТВ-сериал', 'movie':'Фильм', 'ova':'OVA', 'ona':'ONA', 'special':'Спешл', 'anime-serial':'Сериал' };

/* ============================================================
   ХРАНИЛИЩЕ
   ============================================================ */
const LS = {
  get(k, def){
    try{ const v = JSON.parse(localStorage.getItem('anime_' + k)); return v == null ? def : v; }
    catch(e){ return def; }
  },
  set(k, v){ try{ localStorage.setItem('anime_' + k, JSON.stringify(v)); }catch(e){} },
  del(k){ try{ localStorage.removeItem('anime_' + k); }catch(e){} }
};

const DEFAULTS = { skip:true, skipLen:90, fx:true, resume:true };
let settings = Object.assign({}, DEFAULTS, LS.get('set', {}));
function saveSettings(){ LS.set('set', settings); }

let me = LS.get('me', { name:'Гость', created:Date.now() });
let stats = LS.get('stats', { sec:0, episodes:0, titles:{}, genres:{}, days:{}, flags:{} });
stats.titles = stats.titles || {};
stats.genres = stats.genres || {};
stats.days = stats.days || {};
stats.flags = stats.flags || {};

const LISTS = ['watching','planned','completed','dropped'];
const LIST_NAMES = { watching:'Смотрю', planned:'В планах', completed:'Просмотрено', dropped:'Брошено' };
let lists = LS.get('lists', { watching:[], planned:[], completed:[], dropped:[] });
LISTS.forEach(k => { if (!Array.isArray(lists[k])) lists[k] = []; });

let watched = LS.get('hist', []);
let favs = LS.get('fav', []);
let progress = LS.get('pos', {});       // key -> { t, d, ep, ts }
let imported = LS.get('imported', []);  // [{ id, title, status, ep }]

/* ============================================================
   УТИЛИТЫ
   ============================================================ */
function toast(msg, ms = 2400){
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

async function getJSON(url, ms = 9000){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try{
    const r = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

const qs = obj => new URLSearchParams(obj).toString();
const absUrl = u => !u ? '' : (u.startsWith('//') ? 'https:' + u : u);
const num = v => { const n = parseFloat(v); return isFinite(n) && n > 0 ? n : 0; };
const uniq = a => [...new Set(a)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const todayKey = () => new Date().toISOString().slice(0, 10);
const fmtTime = s => {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2,'0') : m + '') + ':' + String(sec).padStart(2,'0');
};
const fmtHours = s => {
  const h = (s || 0) / 3600;
  return h >= 100 ? Math.round(h) : h >= 10 ? h.toFixed(0) : h.toFixed(1);
};

function stripTags(s){
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ============================================================
   API KODIK (напрямую, CORS открыт)
   ============================================================ */
let tokenIdx = 0;

async function api(path, params = {}){
  // через бэкенд: без токена в браузере, с общим кешем и обрезанным ответом
  if (API_BASE && await apiReady){
    const data = await getJSON(API_BASE + '/api/kodik/' + path + '?' + qs(params), 12000).catch(() => null);
    if (data && Array.isArray(data.results)) return data;
    // сервер не ответил — молча идём напрямую, как раньше
  }
  if (!TOKENS.length) return null;
  for (let i = 0; i < TOKENS.length; i++){
    const idx = (tokenIdx + i) % TOKENS.length;
    let data = null;
    try{
      data = await getJSON(KODIK + '/' + path + '?' + qs({ token: TOKENS[idx], ...params }));
    }catch(e){
      continue;
    }
    if (data && Array.isArray(data.results)){
      tokenIdx = idx;
      return data;
    }
    if (data && (data.error || data.message)) continue;
  }
  return null;
}

function cursorOf(nextPage){
  if (!nextPage) return null;
  try{ return new URL(nextPage).searchParams.get('next'); }catch(e){ return null; }
}

const listParams = extra => ({ limit: PAGE_LIMIT, types: 'anime,anime-serial', with_material_data: 'true', ...extra });

/* ============================================================
   НОРМАЛИЗАЦИЯ
   ============================================================ */
function keyOf(r){
  if (r.shikimori_id) return 's' + r.shikimori_id;
  const base = (r.title_orig || r.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return base + '|' + (r.year || '');
}

function qualityRank(q){
  const s = String(q || '');
  if (/2160|4k/i.test(s)) return 4;
  if (/1080/.test(s)) return 3;
  if (/720/.test(s)) return 2;
  if (/480/.test(s)) return 1;
  return 0;
}

function normalize(r){
  const md = r.material_data || {};
  let poster = absUrl(md.poster_url || md.anime_poster_url || '');
  let posterAlt = absUrl(md.anime_poster_url || md.poster_url || '');
  if (posterAlt === poster) posterAlt = '';
  const allGenres = md.all_genres || [];
  const genres = uniq(allGenres.map(g => String(g).toLowerCase()))
    .filter(g => g && g !== 'аниме' && g !== 'мультфильм');
  return {
    key: keyOf(r),
    sid: r.shikimori_id || null,
    malId: r.imdb_id || null,
    title: r.title || md.title || r.title_orig || 'Без названия',
    orig: r.title_orig || md.title_en || '',
    alt: r.other_title || md.other_titles || '',
    poster, posterAlt,
    year: r.year || md.year || '',
    rating: num(md.shikimori_rating) || num(md.kinopoisk_rating) || 0,
    kind: KIND[md.anime_kind || r.type] || 'Аниме',
    status: md.anime_status || '',
    episodes: md.episodes_total || r.episodes_count || 0,
    duration: md.duration || 0,
    minAge: md.minimal_age || 0,
    studio: md.studio || md.anime_studio || '',
    mpaa: md.rating_mpaa || '',
    desc: stripTags(md.description || md.anime_description || ''),
    genres: genres.slice(0, 8),
    allGenres: genres,
    voices: []
  };
}

function voiceOf(r){
  return {
    id: r.id,
    translation: (r.translation && r.translation.title) || 'Оригинал',
    quality: r.quality || '',
    link: absUrl(r.link),
    episodes: r.episodes_count || 0,
    last: r.last_episode || 0
  };
}

function groupResults(results){
  const map = new Map();
  for (const r of results || []){
    const k = keyOf(r);
    let g = map.get(k);
    if (!g){
      g = { raw: r, voices: [] };
      map.set(k, g);
    }else if (!g.raw.material_data && r.material_data){
      g.raw = r;
    }
    const v = voiceOf(r);
    if (v.link && !g.voices.some(x => x.link === v.link)) g.voices.push(v);
  }
  const out = [];
  for (const g of map.values()){
    const item = normalize(g.raw);
    item.voices = g.voices.sort((a, b) =>
      qualityRank(b.quality) - qualityRank(a.quality) || a.translation.localeCompare(b.translation));
    out.push(item);
    DB.add(item);
  }
  return out;
}

/* ============================================================
   ЛОКАЛЬНЫЙ ИНДЕКС (для мгновенного поиска)
   ============================================================ */
const DB = {
  map: new Map(),
  max: 4000,
  add(items){
    (Array.isArray(items) ? items : [items]).forEach(it => {
      if (!it || !it.key) return;
      if (DB.map.has(it.key)) return;
      if (DB.map.size >= DB.max){
        const first = DB.map.keys().next();
        if (!first.done) DB.map.delete(first.value);
      }
      DB.map.set(it.key, it);
      VOCAB = null;
      try{ directCache.clear(); }catch(e){}
    });
    scheduleIndexSave();
  },
  seed(){
    try{
      for (let i = 0; i < localStorage.length; i++){
        const k = localStorage.key(i);
        if (!k || !k.startsWith('anime_c_')) continue;
        const v = JSON.parse(localStorage.getItem(k));
        if (v && Array.isArray(v.items)) DB.add(v.items);
      }
    }catch(e){}
    DB.add(watched); DB.add(favs);
    LISTS.forEach(k => DB.add(lists[k]));
  },
  save(){
    try{
      const arr = [...DB.map.values()].slice(-1200).map(it => ({
        key: it.key, sid: it.sid, title: it.title, orig: it.orig, alt: it.alt,
        poster: it.poster, posterAlt: it.posterAlt, year: it.year, rating: it.rating,
        kind: it.kind, episodes: it.episodes, status: it.status, genres: it.genres
      }));
      localStorage.setItem('anime_db', JSON.stringify(arr));
    }catch(e){}
  },
  load(){
    try{
      const arr = JSON.parse(localStorage.getItem('anime_db') || '[]');
      arr.forEach(it => { if (it && it.key && !DB.map.has(it.key)) DB.map.set(it.key, it); });
    }catch(e){}
  }
};
let dbSaveT = null;
function scheduleIndexSave(){
  clearTimeout(dbSaveT);
  dbSaveT = setTimeout(() => DB.save(), 4000);
}

/* ============================================================
   КАРТОЧКИ
   ============================================================ */
function imgErr(im){
  const alt = im.dataset.alt;
  if (alt && im.src !== alt){
    delete im.dataset.alt;
    im.src = alt;
    return;
  }
  const d = document.createElement('div');
  d.className = 'ph';
  d.textContent = '🎬';
  im.replaceWith(d);
}

function cardEl(it, opts = {}){
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'card';

  const poster = document.createElement('div');
  poster.className = 'poster';
  if (it.poster){
    const img = document.createElement('img');
    img.src = it.poster;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    if (it.posterAlt) img.dataset.alt = it.posterAlt;
    img.addEventListener('error', () => imgErr(img));
    poster.appendChild(img);
  }else{
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.textContent = '🎬';
    poster.appendChild(ph);
  }
  if (it.rating){
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '★ ' + it.rating.toFixed(1);
    poster.appendChild(badge);
  }
  if (it.status === 'ongoing'){
    const nb = document.createElement('span');
    nb.className = 'badge new';
    nb.textContent = 'ON';
    poster.appendChild(nb);
  }
  b.appendChild(poster);

  const t = document.createElement('div');
  t.className = 'ctitle';
  t.textContent = it.title;
  b.appendChild(t);

  const sub = [it.year || '', it.episodes ? it.episodes + ' эп.' : ''].filter(Boolean).join(' · ');
  if (sub && !opts.noSub){
    const s = document.createElement('div');
    s.className = 'csub';
    s.textContent = sub;
    b.appendChild(s);
  }

  b.addEventListener('click', () => openPlayer(it));
  return b;
}

function skeleton(grid, n = 12){
  let h = '';
  for (let i = 0; i < n; i++) h += '<div><div class="skel"></div><div class="skel skel-line"></div></div>';
  grid.innerHTML = h;
}

function renderInto(grid, items, opts){
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  items.forEach(it => frag.appendChild(cardEl(it, opts)));
  grid.appendChild(frag);
}

/* ============================================================
   ГЛАВНАЯ
   ============================================================ */
const home = {
  sec: 'popular', genre: '',
  items: [], keys: new Set(),
  next: null, done: false, loading: false, req: 0
};

function sectionParams(sec, genre){
  const base = { sort: 'shikimori_rating', order: 'desc' };
  const p = {
    popular: base,
    top:     { sort: 'shikimori_rating', order: 'desc' },
    ongoing: { sort: 'shikimori_rating', order: 'desc', anime_status: 'ongoing' },
    fresh:   { sort: 'updated_at', order: 'desc' }
  }[sec] || base;
  const params = listParams(p);
  if (genre) params.genres = genre;
  return params;
}

async function loadHome(reset = true){
  if (reset){
    home.req++;
    home.items = []; home.keys = new Set(); home.next = null;
    home.done = false; home.loading = true;
    skeleton($('home-grid'));
    $('home-empty').classList.add('hidden');
    $('home-empty').innerHTML = '<span class="big">🔍</span>Ничего не нашлось';
    $('home-more').classList.add('hidden');
  }else if (home.loading){
    return;
  }

  const my = home.req;

  if (home.sec === 'random'){
    const items = await loadRandom(home.genre);
    if (my !== home.req) return;
    home.loading = false;
    home.items = items; home.done = true;
    renderInto($('home-grid'), items);
    $('home-empty').classList.toggle('hidden', items.length > 0);
    return;
  }

  const cached = reset ? cacheGet(home.sec + '|' + home.genre) : null;
  if (cached){
    home.items = cached.items;
    home.keys = new Set(cached.items.map(i => i.key));
    home.next = cached.next || null;
    home.done = !cached.next;
    home.loading = false;
    renderInto($('home-grid'), cached.items);
    refreshHome(my);
    return;
  }

  const chunk = await fetchListChunk(home.sec, home.genre, null, 4, 24);
  if (my !== home.req) return;
  home.loading = false;
  if (!chunk){ homeFail(); return; }

  const items = chunk.items;
  home.items = items;
  home.keys = new Set(items.map(i => i.key));
  home.next = chunk.next;
  home.done = chunk.done;

  renderInto($('home-grid'), items);
  $('home-empty').classList.toggle('hidden', items.length > 0);
  if (items.length) cacheSet(home.sec + '|' + home.genre, items, chunk.next);
}

async function fetchListChunk(sec, genre, startNext, maxPages, target){
  let next = startNext || null;
  let pages = 0, got = false;
  const seen = new Set(), items = [];

  while (pages < maxPages && items.length < target){
    const params = { ...sectionParams(sec, genre), ...(next ? { next } : {}) };
    const res = await api('list', params);
    pages++;
    if (!res) break;
    got = true;
    groupResults(res.results).forEach(it => {
      if (seen.has(it.key)) return;
      seen.add(it.key);
      items.push(it);
    });
    next = cursorOf(res.next_page);
    if (!next) break;
  }
  if (!got) return null;
  return { items, next, done: !next };
}

function homeFail(){
  $('home-grid').innerHTML = '';
  $('home-empty').classList.remove('hidden');
  $('home-empty').innerHTML = '<span class="big">📡</span>Не удалось загрузить каталог<br><span class="empty-sub">Проверьте интернет и обновите ↻</span>';
}

async function refreshHome(my){
  const chunk = await fetchListChunk(home.sec, home.genre, null, 2, 16);
  if (!chunk || my !== home.req) return;
  const fresh = chunk.items;
  if (!fresh.length) return;
  cacheSet(home.sec + '|' + home.genre, fresh, chunk.next);
  if (home.items.length && home.items[0].key === fresh[0].key) return;

  const freshKeys = new Set(fresh.map(i => i.key));
  const merged = fresh.concat(home.items.filter(i => !freshKeys.has(i.key)));
  home.items = merged;
  home.keys = new Set(merged.map(i => i.key));
  if (window.scrollY < 300) renderInto($('home-grid'), merged);
}

async function loadHomeMore(){
  if (home.loading || home.done || home.sec === 'random') return;
  const my = home.req;
  home.loading = true;
  $('home-more').classList.remove('hidden');

  const chunk = await fetchListChunk(home.sec, home.genre, home.next, 3, 18);
  home.loading = false;
  if (my !== home.req) return;
  $('home-more').classList.add('hidden');
  if (!chunk){ home.done = true; return; }

  const fresh = chunk.items.filter(i => !home.keys.has(i.key));
  fresh.forEach(i => home.keys.add(i.key));
  home.next = chunk.next;
  home.done = chunk.done;
  if (!fresh.length && home.done) return;

  const frag = document.createDocumentFragment();
  fresh.forEach(i => { home.items.push(i); frag.appendChild(cardEl(i)); });
  $('home-grid').appendChild(frag);
}

async function loadRandom(genre){
  const items = [];
  const seen = new Set();
  for (let attempt = 0; attempt < 2 && items.length < 12; attempt++){
    const year = 1990 + Math.floor(Math.random() * 37);
    const res = await api('list', listParams({
      sort: 'shikimori_rating', order: 'desc',
      year: String(year),
      ...(genre ? { genres: genre } : {})
    }));
    groupResults(res && res.results).forEach(it => {
      if (seen.has(it.key)) return;
      seen.add(it.key);
      items.push(it);
    });
  }
  if (!items.length){
    const res = await api('list', listParams({ sort: 'views', order: 'desc', ...(genre ? { genres: genre } : {}) }));
    groupResults(res && res.results).forEach(it => {
      if (seen.has(it.key)) return;
      seen.add(it.key);
      items.push(it);
    });
  }
  for (let i = items.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function buildGenrePanel(){
  const panel = $('genre-panel');
  panel.innerHTML = '';
  const all = document.createElement('button');
  all.className = 'chip' + (home.genre ? '' : ' on');
  all.textContent = 'Все';
  all.onclick = () => selectGenre('');
  panel.appendChild(all);
  GENRES.forEach(g => {
    const b = document.createElement('button');
    b.className = 'chip' + (home.genre === g ? ' on' : '');
    b.textContent = g;
    b.onclick = () => selectGenre(g);
    panel.appendChild(b);
  });
}

function selectGenre(g){
  home.genre = g;
  $('genre-label').textContent = g ? '· ' + g : '';
  $('btn-genres').classList.toggle('on', !!g);
  closeSheet('genre-sheet');
  buildGenrePanel();
  loadHome(true);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============================================================
   КЕШ ПОДБОРОК
   ============================================================ */
function cacheGet(k){
  const c = LS.get('c_' + k, null);
  if (!c || !c.items || c.items.length < 6) return null;
  if (Date.now() - (c.t || 0) > TTL) return null;
  return c;
}
function cacheSet(k, items, next){
  LS.set('c_' + k, { t: Date.now(), items: items.slice(0, 60), next: next || null });
}

/* ============================================================
   ПОИСК: нормализация, раскладка, опечатки
   ============================================================ */
const EN_KB = "qwertyuiop[]asdfghjkl;'zxcvbnm,./";
const RU_KB = 'йцукенгшщзхъфывапролджэячсмитьбю.';

function swapLayout(s, toRu){
  const from = toRu ? EN_KB : RU_KB;
  const to   = toRu ? RU_KB : EN_KB;
  let out = '';
  for (const ch of String(s).toLowerCase()){
    const i = from.indexOf(ch);
    out += i >= 0 ? to[i] : ch;
  }
  return out;
}

const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
  н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
function translit(s){
  return String(s).toLowerCase().split('').map(c => TRANSLIT[c] != null ? TRANSLIT[c] : c).join('');
}

/* Популярные тайтлы: ru / romaji / jp — чтобы «титаны» находили Shingeki */
const ALIASES = [
  ['наруто','naruto'], ['боруто','boruto'], ['ван пис','one piece'], ['атака титанов','shingeki no kyojin','титаны'],
  ['фрирен','sousou no frieren','провожающая в последний путь'],
  ['стальной алхимик','fullmetal alchemist','хагурен'],
  ['врата штейна','steins;gate','steins gate'],
  ['клинок рассекающий демонов','kimetsu no yaiba','demon slayer'],
  ['магическая битва','jujutsu kaisen'], ['человек бензопила','chainsaw man'],
  ['токийский гуль','tokyo ghoul'], ['тетрадь смерти','death note'],
  ['код гиас','code geass'], ['тельце','клинок','bleach','балич'],
  ['моя геройская академия','boku no hero academia','my hero academia','мга'],
  ['ре зиро','re:zero','rezero'], ['эльфийская песнь','elfen lied'],
  ['хеллсинг','hellsing'], ['клеймор','claymore'], ['берсерк','berserk'],
  ['джо джо','jojo','jojo no kimyou na bouken','невероятные приключения джоджо'],
  ['гуррен лаганн','gurren lagann'], ['евангелион','evangelion'],
  ['сейлор мун','sailor moon'], ['покемон','pokemon','покемоны'],
  ['драконий жемчуг','dragon ball','дбз'],
  ['хоримия','horimiya'], ['коносуба','konosuba'], ['овеянный','overlord'],
  ['мастера меча онлайн','sword art online','sao'],
  ['реинкарнация безработного','mushoku tensei'],
  ['один удар','one punch man','ванпанчмен'],
  ['кобаяши','kobayashi','дракон горничная'],
  ['принцесса мононоке','mononoke'], ['унесённые призраками','spirited away'],
  ['твоё имя','kimi no na wa','your name']
];

function normText(s){
  return String(s || '').toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[_\-–—:;,.!?()\[\]{}"'«»„“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b){
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++){
    const cur = [i];
    for (let j = 1; j <= n; j++){
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function isSubsequence(q, t){
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) if (t[j] === q[i]) i++;
  return i === q.length;
}

function tokenScore(q, text){
  if (!q || !text) return 0;
  if (text === q) return 1000;
  if (text.startsWith(q)) return 950 - Math.min(60, text.length - q.length);
  const idx = text.indexOf(q);
  if (idx >= 0) return 900 - Math.min(140, idx);

  const tokens = text.split(' ');
  for (const t of tokens) if (t.startsWith(q)) return 830;
  for (const t of tokens) if (t.includes(q)) return 780;

  let fuzzy = 0;
  for (const t of tokens){
    if (!t.length) continue;
    if (Math.abs(t.length - q.length) > 3 && t.length > q.length) continue;
    const d = levenshtein(q, t);
    const ratio = 1 - d / Math.max(q.length, t.length);
    if (ratio > fuzzy) fuzzy = ratio;
  }
  if (fuzzy >= 0.72) return 620 + (fuzzy - 0.72) * 500;

  if (q.length >= 3 && text.length <= q.length * 2 + 4 && isSubsequence(q, text)) return 400;
  return 0;
}

function scoreText(q, text){
  const qt = q.split(' ').filter(Boolean);
  if (qt.length > 1){
    let sum = 0;
    for (const t of qt){
      const s = tokenScore(t, text);
      if (s === 0) return 0;
      sum += s;
    }
    return (sum / qt.length) * 1.04;
  }
  return tokenScore(q, text);
}

let aliasCache = new Map();
function aliasGroup(n){
  if (aliasCache.has(n)) return aliasCache.get(n);
  for (const g of ALIASES){
    const norm = g.map(normText);
    if (norm.some(a => a === n || (n.length >= 4 && a.startsWith(n)) || (a.length >= 4 && n.startsWith(a)))) { aliasCache.set(n, g); return g; }
  }
  aliasCache.set(n, null);
  return null;
}

function variants(q){
  const base = q.trim();
  const out = [base];
  const latin = /[a-z]/i.test(base), cyr = /[а-яё]/i.test(base);
  if (latin && !cyr) out.push(swapLayout(base, true));
  if (cyr && !latin) out.push(swapLayout(base, false));
  out.push(translit(base));
  const g = aliasGroup(normText(base));
  if (g) out.push(...g);
  return uniq(out.map(x => x.trim()).filter(Boolean));
}

function hayOf(it){
  if (it._hay) return it._hay;
  const parts = [it.title, it.orig, it.alt, translit(it.title || '')];
  const h = uniq(parts.map(normText).filter(Boolean));
  try{ it._hay = h; }catch(e){}
  return h;
}

function localSearch(q, limit = 30){
  const v = uniq(variants(q).map(normText).filter(Boolean));
  if (!v.length) return [];
  const scored = [];
  for (const it of DB.map.values()){
    const hay = hayOf(it);
    let best = 0;
    for (const h of hay){
      for (const x of v){
        if (!x) continue;
        const s = scoreText(x, h);
        if (s > best) best = s;
      }
      if (best >= 950) break;
    }
    if (best >= 380) scored.push([best + (it.rating || 0) * 2, it]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(x => x[1]);
}

/* ============================================================
   ОПЕЧАТКИ: словарь из локального индекса + коррекция
   ============================================================ */
let VOCAB = null;
let VOCAB_N = 0;

function vocab(){
  if (VOCAB) return VOCAB;
  VOCAB = new Set();
  for (const it of DB.map.values()){
    const hay = hayOf(it);
    for (const h of hay){
      if (h.length >= 4 && h.length <= 48) VOCAB.add(h);
      for (const t of h.split(' ')){
        if (t.length >= 4) VOCAB.add(t);
      }
    }
  }
  // известные названия — чтобы опечатки исправлялись даже на пустом индексе
  ALIASES.forEach(g => g.forEach(x => {
    const n = normText(x);
    if (n.length >= 4) VOCAB.add(n);
    n.split(' ').forEach(t => { if (t.length >= 4) VOCAB.add(t); });
  }));
  VOCAB_N = 0;
  return VOCAB;
}

/* ближайшие слова словаря к запросу: «натаруто» → «наруто» */
function fuzzyCandidates(q, limit = 3){
  const n = normText(q);
  if (n.length < 4) return [];
  const cyr = /[а-яё]/.test(n);
  const best = [];
  const seen = new Set();

  for (const t of vocab()){
    if (seen.has(t)) continue;
    seen.add(t);
    if (Math.abs(t.length - n.length) > 3) continue;
    if (t === n) continue;
    // «наруто 4» — не опечатка к «наруто», а его продолжение
    if (t.startsWith(n) || n.startsWith(t)) continue;
    // грубый фильтр: первая буква или очень похожая длина+буква
    if (t[0] !== n[0] && Math.abs(t.length - n.length) > 1) continue;
    if (/[а-яё]/.test(t) !== cyr) continue;

    let d;
    if (t.length === n.length){
      // быстрая проверка Хэмминга для равной длины
      d = 0;
      for (let i = 0; i < n.length; i++) if (n[i] !== t[i]) d++;
    }else{
      d = levenshtein(n, t);
    }
    const ratio = 1 - d / Math.max(n.length, t.length);
    if (ratio >= 0.62) best.push([ratio, t]);
  }

  best.sort((a, b) => b[0] - a[0]);
  const out = [];
  for (const [, t] of best){
    if (out.includes(t)) continue;
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/* «натаруто» → «наруто»: похоже по длине и не является расширением запроса */
function typoLike(a, b){
  const na = normText(a), nb = normText(b);
  if (!na || !nb || na === nb) return false;
  if (nb.startsWith(na)) return false;
  if (nb.length > na.length + 1) return false;
  if (Math.abs(na.length - nb.length) > 3) return false;
  const d = levenshtein(na, nb);
  return 1 - d / Math.max(na.length, nb.length) >= 0.55;
}

/* Прямое совпадение без вариантов раскладки/синонимов — чтобы отличить
   осмысленное «yfhenj → наруто» от бессмыслицы «one piece → щту зшусу». */
const directCache = new Map();
function directTopScore(q){
  const n = normText(q);
  if (!n) return 0;
  if (directCache.has(n)) return directCache.get(n);
  let best = 0;
  for (const it of DB.map.values()){
    const hay = hayOf(it);
    for (let i = 0; i < hay.length; i++){
      const s = scoreText(n, hay[i]);
      if (s > best){
        best = s;
        if (best >= 950) break;
      }
    }
    if (best >= 950) break;
  }
  if (directCache.size > 200) directCache.clear();
  directCache.set(n, best);
  return best;
}

/* Порядок запросов к API: сначала то, что вероятнее поймёт Kodik */
function apiQueryCandidates(q){
  const out = [];
  const add = x => { const n = String(x || '').trim(); if (n && !out.includes(n)) out.push(n); };

  // выученные исправления опечаток — сразу первыми
  const learned = LS.get('fix', {});
  if (learned[normText(q)] && typoLike(q, learned[normText(q)])) add(learned[normText(q)]);

  const latin = /[a-z]/i.test(q), cyr = /[а-яё]/i.test(q);
  if (latin && !cyr){
    const ru = swapLayout(q, true);
    // «раскладку» предлагаем только для осмысленно длинного запроса и если такое RU-название есть
    if (q.length >= 4 && /[а-яё]/.test(ru) && directTopScore(ru) >= 700) add(ru);
    add(q);
  }else{
    add(q);
    if (cyr && !latin){
      const en = swapLayout(q, false);
      if (/[a-z]/.test(en)) add(en);
    }
    const g = aliasGroup(normText(q));
    if (g) g.forEach(add);
  }
  // опечатки — в конце, чтобы не тратить запросы зря
  fuzzyCandidates(q, 3).forEach(fix => {
    add(fix);
    const g = aliasGroup(normText(fix));
    if (g) g.forEach(add);
  });
  return out;
}

/* ============================================================
   ПОИСК: состояние и отрисовка
   ============================================================ */
const search = { q: '', items: [], keys: new Set(), next: null, done: false, req: 0,
  apiQuery: '', loadingMore: false };

function setSearchStatus(msg){
  const el = $('search-status');
  el.classList.toggle('hidden', !msg);
  if (msg) $('search-status-text').textContent = msg;
}

function setSearchNote(q, applied){
  const el = $('search-note');
  el.innerHTML = '';
  const latin = /[a-z]/i.test(q), cyr = /[а-яё]/i.test(q);
  const bits = [];
  if (latin && !cyr){
    const ru = swapLayout(q, true);
    if (q.length >= 4 && /[а-яё]/.test(ru) && directTopScore(ru) >= 700) bits.push('раскладка → <b>' + esc(ru) + '</b>');
  }
  const g = aliasGroup(normText(q));
  if (g){
    const extra = g.filter(x => normText(x) !== normText(q)).slice(0, 2);
    if (extra.length) bits.push('синоним → <b>' + esc(extra.join(', ')) + '</b>');
  }
  if (applied && normText(applied) !== normText(q)){
    const already = bits.some(b => b.indexOf(esc(applied)) >= 0);
    if (!already) bits.push('исправлено → <b>' + esc(applied) + '</b>');
  }
  if (!bits.length){ el.classList.add('hidden'); return; }
  el.innerHTML = '<span class="fix">✦</span> ' + bits.join(' · ');
  el.classList.remove('hidden');
}

/* Релевантность выдачи: Kodik любит подмешивать «похожее» —
   пересортировываем и выбрасываем то, что вообще не про запрос. */
function relevanceOf(it, queries){
  const hay = hayOf(it);
  let best = 0;
  for (const h of hay){
    for (const q of queries){
      if (!q) continue;
      const s = scoreText(q, h);
      if (s > best){
        best = s;
        if (best >= 1000) return best;
      }
    }
  }
  return best;
}

function rankSearchItems(){
  if (search.items.length < 2) return;
  const qv = uniq(variants(search.q).map(normText).filter(Boolean));
  const av = search.apiQuery ? uniq(variants(search.apiQuery).map(normText).filter(Boolean)) : [];
  const queries = uniq([...qv, ...av]);
  if (!queries.length) return;

  const scored = search.items.map(it => [relevanceOf(it, queries) + (it.rating || 0) * 2, it]);
  // если выдача совсем маленькая — не режем, лучше показать хоть что-то
  const keep = scored.length <= 4
    ? scored
    : scored.filter(x => x[0] >= 380);
  const final = keep.length ? keep : scored.filter(x => x[0] >= 120);
  final.sort((a, b) => b[0] - a[0]);
  search.items = final.map(x => x[1]);
}

function renderSearchResults(){
  rankSearchItems();
  const grid = $('search-grid');
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  search.items.forEach(i => frag.appendChild(cardEl(i)));
  grid.appendChild(frag);
  $('search-empty').classList.toggle('hidden', search.items.length > 0);
  $('search-hint').classList.add('hidden');
  $('search-more').classList.toggle('hidden', search.done || !search.items.length || !search.apiQuery);
}

function resetSearch(){
  search.req++;
  search.q = ''; search.items = []; search.keys = new Set();
  search.next = null; search.done = false; search.loadingMore = false; search.apiQuery = '';
  $('search-grid').innerHTML = '';
  $('search-empty').classList.add('hidden');
  $('search-more').classList.add('hidden');
  $('search-note').classList.add('hidden');
  setSearchStatus(null);
  $('search-hint').classList.remove('hidden');
}

async function doSearch(q, more = false){
  if (!q){ resetSearch(); return; }
  if (more && (search.loadingMore || search.done)) return;

  if (!more){
    search.req++;
    search.q = q;
    search.items = []; search.keys = new Set(); search.next = null;
    search.done = false; search.loadingMore = false; search.apiQuery = '';
    $('search-empty').classList.add('hidden');
    $('search-hint').classList.add('hidden');
    $('search-more').classList.add('hidden');

    // мгновенный локальный ответ
    const local = localSearch(q, 30);
    local.forEach(i => { search.keys.add(i.key); search.items.push(i); });
    renderSearchResults();
    setSearchNote(q);
    setSearchStatus(local.length ? null : 'Ищем «' + q + '»…');
  }else{
    search.loadingMore = true;
    $('search-more').classList.remove('hidden');
  }

  const my = search.req;
  let added = 0;
  let chosen = '';
  let next = more ? search.next : null;

  if (more){
    const cq = search.apiQuery;
    let pages = 0;
    while (pages < 3 && next){
      const res = await api('search', {
        title: cq, limit: PAGE_LIMIT,
        types: 'anime,anime-serial', with_material_data: 'true',
        next
      });
      pages++;
      if (my !== search.req) return;
      if (!res){ next = null; break; }
      const groups = groupResults(res.results).filter(i => !search.keys.has(i.key));
      groups.forEach(i => { search.keys.add(i.key); search.items.push(i); });
      added += groups.length;
      next = cursorOf(res.next_page);
      if (added >= 18) break;
    }
    search.next = next;
    search.done = !next;
  }else{
    /* Пробуем кандидатов по очереди: раскладка → синоним → опечатка.
       Раньше цикл останавливался на первом кандидате без next_page,
       поэтому до исправления опечаток дело не доходило. */
    const cands = apiQueryCandidates(q);
    let best = { cq: '', got: -1, next: null };
    for (const cq of cands){
      let cnext = null, pages = 0, got = 0, raw = 0;
      while (pages < 2){
        const res = await api('search', {
          title: cq, limit: PAGE_LIMIT,
          types: 'anime,anime-serial', with_material_data: 'true',
          ...(cnext ? { next: cnext } : {})
        });
        pages++;
        if (my !== search.req) return;
        if (!res) break;
        raw += (res.results || []).length;
        const groups = groupResults(res.results).filter(i => !search.keys.has(i.key));
        groups.forEach(i => { search.keys.add(i.key); search.items.push(i); });
        got += groups.length;
        added += groups.length;
        cnext = cursorOf(res.next_page);
        if (!cnext) break;
        if (got >= 18) break;
      }
      if (raw > 0 && got > best.got) best = { cq, got, next: cnext };
      // точное совпадение с запросом — не ищем дальше
      if (raw > 0 && normText(cq) === normText(q)) break;
      // хватит: либо набрали много, либо кандидат уверенно нашёл свой тайтл
      if (added >= 12) break;
      if (best.got >= 8) break;
    }
    if (best.cq){
      chosen = best.cq;
      search.next = best.next;
    }else{
      chosen = cands[0] || q;
      search.next = null;
    }
    search.apiQuery = chosen;
    search.done = !search.next;
  }

  if (my !== search.req) return;

  // запоминаем удачное исправление опечатки (только если это правда опечатка)
  if (!more && chosen && typoLike(q, chosen)){
    const f = LS.get('fix', {});
    if (Object.keys(f).length < 400){
      f[normText(q)] = chosen;
      LS.set('fix', f);
    }
  }

  search.loadingMore = false;
  setSearchStatus(null);
  if (!more) setSearchNote(q, added || chosen ? search.apiQuery : '');
  renderSearchResults();

  if (!search.items.length && search.done){
    $('search-empty').classList.remove('hidden');
    $('search-empty').innerHTML = '<span class="big">😕</span>Ничего не нашлось<br><span class="empty-sub">Попробуйте другое название</span>';
  }
}

async function loadSearchMore(){
  if (!search.q || search.loadingMore || search.done) return;
  await doSearch(search.q, true);
}

/* ============================================================
   ИСТОРИЯ / ИЗБРАННОЕ / СПИСКИ
   ============================================================ */
const slim = it => ({
  key: it.key, sid: it.sid, title: it.title, orig: it.orig, alt: it.alt,
  poster: it.poster, posterAlt: it.posterAlt, year: it.year,
  rating: it.rating, kind: it.kind, episodes: it.episodes,
  status: it.status, desc: it.desc, genres: it.genres,
  voices: it.voices && it.voices.length ? [it.voices[0]] : []
});

function addHistory(it){
  watched = watched.filter(x => x.key !== it.key);
  watched.unshift(slim(it));
  watched = watched.slice(0, 30);
  LS.set('hist', watched);
  DB.add(it);
  renderHistoryRow();
}

function isFav(key){ return favs.some(x => x.key === key); }

function toggleFav(it){
  if (isFav(it.key)) favs = favs.filter(x => x.key !== it.key);
  else { favs.unshift(slim(it)); favs = favs.slice(0, 200); }
  LS.set('fav', favs);
  return isFav(it.key);
}

function listOf(key){
  for (const k of LISTS) if (lists[k].some(x => x.key === key)) return k;
  return '';
}

function setList(it, target){
  const s = slim(it);
  LISTS.forEach(k => { lists[k] = lists[k].filter(x => x.key !== it.key); });
  if (target && LISTS.includes(target)) lists[target].unshift(s);
  LS.set('lists', lists);
  DB.add(it);
}

function addToWatching(it){
  if (listOf(it.key)) return;
  setList(it, 'watching');
}

function renderHistoryRow(){
  const sec = $('continue-sec');
  const row = $('continue-row');
  row.innerHTML = '';
  if (!watched.length){ sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  watched.slice(0, 12).forEach(it => row.appendChild(cardEl(it)));
}

/* ============================================================
   УЧЁТ ВРЕМЕНИ
   ============================================================ */
let statsDirty = false;

function addWatch(sec){
  if (!(sec > 0) || sec > 30) return;
  stats.sec += sec;
  const d = todayKey();
  stats.days[d] = (stats.days[d] || 0) + sec;
  if (current) stats.titles[current.key] = (stats.titles[current.key] || 0) + sec;
  const h = new Date().getHours();
  if (h < 5) stats.flags.night = 1;
  statsDirty = true;
}

function saveStats(){
  LS.set('stats', stats);
  statsDirty = false;
}

setInterval(() => { if (statsDirty) saveStats(); }, 8000);

function trackOpen(it){
  (it.genres || []).slice(0, 6).forEach(g => { stats.genres[g] = (stats.genres[g] || 0) + 1; });
  if (stats.titles[it.key] == null) stats.titles[it.key] = 0;
  if (!stats.firstAt) stats.firstAt = Date.now();
  saveStats();
}

/* ============================================================
   ПЛЕЕР
   ============================================================ */
let current = null;
let loadTimer = null;
let skipArmed = false;
let skipDone = false;
let sourceTouched = false;

/* Второй источник: релиз AniLiberty и его проигрываемые серии. */
const ani = {
  key: '', release: null, episodes: [], loading: false, fallbackActive: false,
  searchCache: new Map(), releaseCache: new Map(),
  hls: null, hlsScript: null, retries: 0, lastVoice: null
};

let watching = {
  lastT: null, lastTs: 0, cur: 0, dur: 0, ep: null, season: null,
  playing: false, started: false,
  resumeTarget: 0, resumeTriedAt: 0, resumeAttempts: 0, resumeDone: true
};

function resetWatchState(it){
  const p = progress[it.key];
  const target = (settings.resume && p && p.t > 25 && (!p.d || p.t < p.d - 20)) ? p.t : 0;
  watching = {
    lastT: null, lastTs: 0, cur: 0, dur: p && p.d ? p.d : 0, ep: it._ep || (p && p.ep ? p.ep : null), season: null,
    playing: false, started: false, tr: '', voice: null, src: 'kodik', aniEp: null,
    resumeTarget: target, resumeTriedAt: 0, resumeAttempts: 0, resumeDone: !target
  };
  skipArmed = settings.skip && !target && it.kind !== 'Фильм';
  skipDone = false;
  $('p-skip').classList.add('hidden');
}

function playerCmd(method, extra){
  if (watching.src === 'ani'){
    const v = $('p-video');
    if (!v) return;
    try{
      if (method === 'seek' && extra && extra.seconds != null) v.currentTime = Math.max(0, Number(extra.seconds) || 0);
      else if (method === 'play') v.play().catch(() => {});
      else if (method === 'pause') v.pause();
      else if (method === 'mute') v.muted = true;
      else if (method === 'unmute') v.muted = false;
      else if (method === 'volume' && extra && extra.volume != null) v.volume = Math.max(0, Math.min(1, Number(extra.volume) || 0));
      else if (method === 'speed' && extra && extra.speed != null) v.playbackRate = Math.max(0.25, Math.min(3, Number(extra.speed) || 1));
    }catch(e){}
    return;
  }
  const f = $('p-iframe');
  if (!f || !f.contentWindow) return;
  try{ f.contentWindow.postMessage({ key: 'kodik_player_api', value: { method, ...(extra || {}) } }, '*'); }catch(e){}
}
function playerSeek(sec){
  const s = Math.max(0, Math.round(sec));
  playerCmd('seek', { seconds: s });
  // если плеер ещё не готов — повторим чуть позже
  setTimeout(() => playerCmd('seek', { seconds: s }), 700);
}

function onPlayerMsg(e){
  const d = e.data;
  if (!d || typeof d !== 'object' || typeof d.key !== 'string') return;
  if (d.key.indexOf('kodik_player_') !== 0) return;
  if (!$('player').classList.contains('open')) return;
  const v = d.value;
  switch (d.key){
    case 'kodik_player_time_update': onPlayerTime(Number(v) || 0); break;
    case 'kodik_player_duration_update': watching.dur = Number(v) || 0; break;
    case 'kodik_player_video_started': onVideoStarted(); break;
    case 'kodik_player_video_ended': onVideoEnded(); break;
    case 'kodik_player_current_episode': onEpisode(v); break;
    case 'kodik_player_play': watching.playing = true; break;
    case 'kodik_player_pause': watching.playing = false; break;
  }
}
window.addEventListener('message', onPlayerMsg);

function onVideoStarted(){
  watching.started = true;
  watching.playing = true;
  $('p-loader').classList.add('hidden');
  if (!watching.counted){
    watching.counted = true;
    stats.episodes = (stats.episodes || 0) + 1;
    saveStats();
  }
  if (party.on && !party.host) askPartyState();
}

function onVideoEnded(){
  watching.playing = false;
  if (!current) return;
  progress[current.key] = { t: 0, d: watching.dur || 0, ep: watching.ep, ts: Date.now() };
  LS.set('pos', progress);
  setList(current, 'completed');
  toast('Серия досмотрена ✓');
  if (current) updateStatusBtn(current);
}

function onEpisode(v){
  if (!v || typeof v !== 'object') return;
  // сразу после переключения серии старый плеер ещё может прислать свою — игнорируем
  if (v.episode != null && (party.host || Date.now() >= (party.epGuardUntil || 0))) watching.ep = v.episode;
  if (v.season != null) watching.season = v.season;
  if (v.translation && v.translation.title) watching.tr = v.translation.title;
  if (current){
    progress[current.key] = { t: watching.cur || 0, d: watching.dur || 0, ep: watching.ep, ts: Date.now() };
    LS.set('pos', progress);
  }
  // серию объявляет только хост — иначе гости начнут переключать друг друга
  if (party.on && party.host){
    partySend({
      k: 'ep',
      ep: watching.ep,
      season: watching.season,
      t: Math.round(watching.cur || 0),
      titleKey: current ? current.key : '',
      translation: watching.tr || ''
    });
  }
}

function onPlayerTime(t){
  if (!current) return;
  const now = Date.now();

  if (watching.lastT != null && t > watching.lastT && t - watching.lastT < 20 && now - watching.lastTs < 30000){
    addWatch(t - watching.lastT);
  }
  watching.lastT = t;
  watching.lastTs = now;
  watching.cur = t;

  // восстановление позиции
  if (!watching.resumeDone && watching.resumeTarget > 20){
    if (t < watching.resumeTarget - 25){
      if (watching.resumeAttempts < 8 && now - watching.resumeTriedAt > 1200){
        watching.resumeAttempts++;
        watching.resumeTriedAt = now;
        if (watching.resumeAttempts === 1){
          toast('Продолжаем с ' + fmtTime(watching.resumeTarget));
          hideResumeRow();
        }
        playerSeek(watching.resumeTarget);
      }
    }else{
      watching.resumeDone = true;
    }
  }

  // пропуск опенинга: у AniLiberty есть точные start/stop серии
  const opening = (watching.src === 'ani' && watching.aniEp && Array.isArray(watching.aniEp.opening))
    ? watching.aniEp.opening : null;
  if (skipArmed && !skipDone && t >= 2){
    if (opening && t < opening[1]){
      skipDone = true;
      skipArmed = false;
      playerSeek(opening[1] + 1);
      stats.flags.skip = 1;
      saveStats();
      toast('Опенинг пропущен ⏭');
    }else if (!opening && t >= 3 && t < 55){
      skipDone = true;
      skipArmed = false;
      playerSeek(settings.skipLen + 2);
      stats.flags.skip = 1;
      saveStats();
      toast('Опенинг пропущен ⏭');
    }
  }

  const showSkip = !skipDone && (
    opening ? t >= 1 && t < opening[1] - 2 : watching.dur > 200 && t >= 3 && t < settings.skipLen
  );
  $('p-skip').classList.toggle('hidden', !showSkip);

  // сохранение позиции
  if (t > 5){
    clearTimeout(onPlayerTime._s);
    onPlayerTime._s = setTimeout(() => {
      if (!current) return;
      progress[current.key] = { t: watching.cur, d: watching.dur || 0, ep: watching.ep, ts: Date.now() };
      LS.set('pos', progress);
    }, 3000);
  }

  partyOnTime(t);
}

async function openPlayer(it){
  if (!it) return;
  current = it;
  $('player').classList.add('open');
  document.body.style.overflow = 'hidden';
  const body = document.querySelector('.p-body');
  if (body) body.scrollTop = 0;

  $('p-title').textContent = it.title;
  $('p-genres').innerHTML = '';
  $('p-meta').innerHTML = '';
  $('p-iframe').src = 'about:blank';
  $('p-iframe').classList.remove('hidden');
  destroyAni();
  const pv = $('p-video');
  if (pv) pv.classList.add('hidden');
  ani.key = it.key;
  ani.release = null;
  ani.episodes = [];
  ani.loading = false;
  ani.fallbackActive = false;
  sourceTouched = false;
  if ($('p-src')) $('p-src').classList.add('hidden');
  if ($('p-eps-sec')) $('p-eps-sec').classList.add('hidden');
  if ($('p-eps')) $('p-eps').innerHTML = '';
  bindAniVideo();

  $('p-error').classList.add('hidden');
  $('p-open').href = '#';
  $('p-open').classList.remove('hidden');
  setDesc(it.desc || 'Загрузка описания…');
  updateFavIcon(it);
  updateStatusBtn(it);
  pushPlayerState();
  resetWatchState(it);
  renderResumeRow(it);
  hideRelated();

  $('p-shiki').href = it.sid ? 'https://shikimori.io/animes/' + it.sid : 'https://shikimori.io';
  $('p-mal').href = 'https://myanimelist.net/search/all?q=' + encodeURIComponent(it.orig || it.title);
  $('p-dub').classList.remove('hidden');
  setTimeout(() => $('p-dub').classList.add('hidden'), 6000);

  if (preferAni(it)){
    renderGenres(it.genres);
    renderMeta(it);
    $('p-open').classList.add('hidden');
    $('p-loader').classList.remove('hidden');
    setTimeout(() => aniFallback(it), 1800);
  }else{
    playItem(it);
  }
  addHistory(it);
  addToWatching(it);
  trackOpen(it);
  loadRelated(it);
  loadChrono(it);
  loadInfo(it);

  if (!it.voices || !it.voices.length){
    $('p-loader').classList.remove('hidden');
    const found = await lookupSources(it);
    if (current !== it) return;
    if (found){
      it.voices = found.voices;
      if (!it.desc && found.desc) it.desc = found.desc;
      if ((!it.genres || !it.genres.length) && found.genres.length) it.genres = found.genres;
      setDesc(it.desc || 'Описание отсутствует');
      renderGenres(it.genres);
      if (watching.src !== 'ani') playItem(it);
    }else{
      $('p-loader').classList.add('hidden');
      $('p-error').classList.remove('hidden');
    }
  }else{
    setDesc(it.desc || 'Описание отсутствует');
  }
}

function setDesc(text){
  const d = $('p-desc');
  d.textContent = text;
  d.classList.add('clamp');
  const btn = $('p-desc-toggle');
  btn.textContent = 'Читать полностью';
  requestAnimationFrame(() => {
    btn.classList.toggle('hidden', d.scrollHeight <= d.clientHeight + 4);
  });
}

function renderResumeRow(it){
  const p = progress[it.key];
  const row = $('p-progress');
  if (!p || !p.t || p.t < 25 || (p.d && p.t > p.d - 20)){ row.classList.add('hidden'); return; }
  $('p-progress-text').textContent = 'Вы остановились на ' + fmtTime(p.t) + (p.ep ? ' · серия ' + p.ep : '');
  row.classList.remove('hidden');
}
function hideResumeRow(){ $('p-progress').classList.add('hidden'); }

async function lookupSources(it){
  const data = it.sid
    ? await api('search', { shikimori_id: it.sid, with_material_data: 'true', limit: 100 })
    : await api('search', { title: it.title, limit: 100, types: 'anime,anime-serial', with_material_data: 'true' });
  const groups = groupResults(data && data.results);
  if (!groups.length) return null;
  return groups.find(g => g.key === it.key) || groups[0];
}

function playItem(it){
  renderGenres(it.genres);
  renderMeta(it);
  if (!it.voices || !it.voices.length){
    $('p-loader').classList.add('hidden');
    showPlayError('Источник Kodik недоступен', 'Проверяем AniLiberty или попробуйте позже');
    $('p-open').href = '#';
    return;
  }
  play(it.voices[0], it._ep);
}

/* Плеер понимает ?episode=N — на этом держится переключение серии в комнате */
function withEpisode(url, ep){
  if (ep == null || ep === '') return url;
  try{
    const u = new URL(url);
    u.searchParams.set('episode', String(ep));
    return u.toString();
  }catch(e){
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'episode=' + encodeURIComponent(ep);
  }
}

/* ============================================================
   ВТОРОЙ ИСТОЧНИК: ANILIBERTY
   ============================================================ */

function aniSearchApi(query, sid, year){
  const key = query + '|' + (sid || '') + '|' + (year || '');
  if (!ani.searchCache.has(key)){
    const p = new URLSearchParams({ q: query });
    if (sid) p.set('sid', String(sid));
    if (year) p.set('year', String(year));
    ani.searchCache.set(key, backend('/api/ani/search?' + p.toString())
      .then(r => r && r.ok && r.data && (r.data.id || r.data.alias) ? r.data : null)
      .catch(() => null));
  }
  return ani.searchCache.get(key);
}

function aniReleaseApi(id){
  const key = String(id || '');
  if (!key) return Promise.resolve(null);
  if (!ani.releaseCache.has(key)){
    ani.releaseCache.set(key, backend('/api/ani/release?id=' + encodeURIComponent(key))
      .then(r => r && r.ok && r.data ? r.data : null)
      .catch(() => null));
  }
  return ani.releaseCache.get(key);
}

/* Пользователь уже выбрал AniLiberty — не запускаем Kodik первым. */
function preferAni(it){
  return !!(API_BASE && it && LS.get('src', 'kodik') === 'ani');
}

/* Страховка: если AniLiberty ничего не нашёл или молчит, включаем Kodik. */
function aniFallback(it){
  if (current !== it || watching.src === 'ani') return;
  if (ani.fallbackActive) return;
  if (watching.started || watching.playing) return;
  ani.fallbackActive = true;
  playItem(it);
}

/* Релиз ищется строго: сначала shikimori_id, потом точное название и год.
   Если AniLiberty не знает тайтл — селектор источника просто не появляется. */
async function loadAni(it){
  if (!it || !API_BASE) return;
  if (ani.key !== it.key){
    ani.key = it.key;
    ani.release = null;
    ani.episodes = [];
  }
  ani.loading = true;
  renderSourceUI();

  const titles = uniq([it.title, it.orig].filter(Boolean));
  let rel = null;
  for (const title of titles){
    rel = await aniSearchApi(title, it.sid, it.year);
    if (rel) break;
  }
  if (current !== it || ani.key !== it.key){ ani.loading = false; return; }
  if (!rel){
    ani.loading = false;
    renderSourceUI();
    aniFallback(it);
    return;
  }

  const full = await aniReleaseApi(rel.id || rel.alias);
  if (current !== it || ani.key !== it.key){ ani.loading = false; return; }

  const episodes = ((full && full.episodes) || []).filter(e => e && e.hls);
  ani.loading = false;
  if (!episodes.length){
    ani.release = full || rel;
    ani.episodes = [];
    renderSourceUI();
    aniFallback(it);
    return;
  }
  ani.release = full || rel;
  ani.episodes = episodes;
  renderSourceUI();

  // сохранённый выбор источника: включаем AniLiberty, если пользователь не трогал переключатель
  if (!ani.fallbackActive && LS.get('src', 'kodik') === 'ani' && !sourceTouched){
    const p = progress[it.key];
    const target = (settings.resume && p && p.t > 25) ? p.t : 0;
    setSource('ani', true, target);
  }
}

function aniEpisodeByOrdinal(n){
  const v = Number(n);
  if (!isFinite(v)) return null;
  return ani.episodes.find(e => Math.abs(Number(e.ordinal) - v) < 0.001) || null;
}

function renderSourceUI(){
  const box = $('p-src');
  if (!box) return;
  const ready = !!(current && ani.key === current.key && ani.episodes.length);
  box.classList.toggle('hidden', !ready);
  const ab = box.querySelector('[data-src="ani"]');
  if (ab){
    ab.disabled = !ready;
    ab.title = ready ? '' : 'Для этого релиза нет серий';
  }
  box.querySelectorAll('button[data-src]').forEach(b => {
    b.classList.toggle('on', b.dataset.src === (watching.src || 'kodik'));
  });
}

function renderEpisodeList(active){
  const sec = $('p-eps-sec'), box = $('p-eps');
  if (!sec || !box) return;
  if (watching.src !== 'ani' || !ani.episodes.length){
    box.innerHTML = '';
    sec.classList.add('hidden');
    return;
  }
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  ani.episodes.forEach(e => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = String(e.ordinal);
    b.title = e.name || ('Серия ' + e.ordinal);
    b.className = Number(e.ordinal) === Number(active) ? 'on' : '';
    b.addEventListener('click', () => switchEpisode(e.ordinal, 0));
    frag.appendChild(b);
  });
  box.appendChild(frag);
  const note = $('p-eps-note');
  if (note) note.textContent = ani.episodes.length + ' ' +
    plural(ani.episodes.length, ['серия', 'серии', 'серий']);
  sec.classList.remove('hidden');
}

function loadHls(){
  if (window.Hls) return Promise.resolve(window.Hls);
  if (ani.hlsScript) return ani.hlsScript;
  ani.hlsScript = new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
    s.async = true;
    s.onload = () => resolve(window.Hls || null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  }).then(Hls => {
    if (!Hls) ani.hlsScript = null;
    return Hls;
  });
  return ani.hlsScript;
}

function destroyAni(){
  if (ani.hls){
    try{ ani.hls.destroy(); }catch(e){}
    ani.hls = null;
  }
  const v = $('p-video');
  if (v){
    try{ v.pause(); }catch(e){}
    v.removeAttribute('src');
    try{ v.load(); }catch(e){}
  }
  ani.retries = 0;
}

function showAniError(title, sub){
  $('p-loader').classList.add('hidden');
  if ($('p-err-title')) $('p-err-title').textContent = title || 'Плеер не загрузился';
  if ($('p-err-sub')) $('p-err-sub').textContent = sub || 'Переключитесь на Kodik или попробуйте позже';
  $('p-error').classList.remove('hidden');
}

/* Переключение источника без перезагрузки страницы. */
function setSource(src, auto, startAt){
  if (!current) return;
  if (src !== 'ani') src = 'kodik';
  if (!auto) sourceTouched = true;
  if (src === 'ani' && !ani.episodes.length){
    if (!auto) toast('Для этого релиза нет серий AniLiberty');
    return;
  }
  if (watching.src === src){ renderSourceUI(); return; }
  if (!auto) LS.set('src', src);

  const target = startAt != null && startAt > 0 ? startAt : (watching.cur > 3 ? watching.cur : 0);
  if (src === 'ani'){
    ani.lastVoice = watching.voice || (current.voices && current.voices[0]) || null;
    watching.src = 'ani';
    $('p-iframe').classList.add('hidden');
    $('p-video').classList.remove('hidden');
    $('p-dub').classList.add('hidden');
    $('p-open').classList.add('hidden');
    const ep = aniEpisodeByOrdinal(watching.ep) || ani.episodes[0];
    playAni(ep.ordinal, target, false);
  }else{
    destroyAni();
    watching.src = 'kodik';
    watching.aniEp = null;
    $('p-video').classList.add('hidden');
    $('p-iframe').classList.remove('hidden');
    $('p-eps-sec').classList.add('hidden');
    $('p-error').classList.add('hidden');
    $('p-open').classList.remove('hidden');
    $('p-dub').classList.remove('hidden');
    setTimeout(() => $('p-dub').classList.add('hidden'), 5000);
    renderSourceUI();
    const voice = ani.lastVoice || (current.voices && current.voices[0]);
    if (!voice){ showPlayError('Источник Kodik недоступен', 'Для этого релиза нет озвучек'); return; }
    play(voice, watching.ep);
  }
}

/* Запуск серии AniLiberty в нативном <video>. hls.js подключается лениво. */
function playAni(epOrdinal, target, noSkip){
  if (!current || !ani.episodes.length) return;
  const ep = aniEpisodeByOrdinal(epOrdinal) || ani.episodes[0];
  if (!ep || !ep.hls){ showAniError('Серия недоступна', 'Выберите другую серию или Kodik'); return; }

  destroyAni();
  watching.src = 'ani';
  watching.aniEp = ep;
  watching.ep = ep.ordinal;
  watching.voice = null;
  watching.cur = 0;
  watching.lastT = null;
  watching.lastTs = 0;
  watching.dur = Number(ep.duration) || 0;
  watching.playing = false;
  watching.started = false;
  watching.resumeTarget = Math.max(0, Number(target) || 0);
  watching.resumeTriedAt = 0;
  watching.resumeAttempts = 0;
  watching.resumeDone = !(watching.resumeTarget > 2);
  party.epGuardUntil = Date.now() + 6000;
  party.lastEpTarget = Number(ep.ordinal) || 0;
  party.lastEpAt = Date.now();
  skipDone = !!noSkip || watching.resumeTarget > 2;
  skipArmed = !skipDone && !!settings.skip;
  $('p-skip').classList.add('hidden');
  $('p-iframe').classList.add('hidden');

  const v = $('p-video');
  v.classList.remove('hidden');
  $('p-error').classList.add('hidden');
  $('p-loader').classList.remove('hidden');
  $('p-open').classList.add('hidden');
  renderEpisodeList(ep.ordinal);
  renderSourceUI();

  const onMeta = () => {
    if (watching.src !== 'ani' || watching.aniEp !== ep) return;
    if (watching.resumeTarget > 2){
      const max = Math.max(0, (v.duration || watching.dur || watching.resumeTarget) - 0.5);
      try{ v.currentTime = Math.min(watching.resumeTarget, max); }catch(e){}
      toast('Продолжаем с ' + fmtTime(watching.resumeTarget));
    }
    watching.resumeDone = true;
    $('p-loader').classList.add('hidden');
  };
  v.addEventListener('loadedmetadata', onMeta, { once: true });
  const start = () => v.play().catch(() => {});
  // Обычный файл — сразу в <video>.
  const isFile = /\.(mp4|webm|mov)(\?|#|$)/i.test(ep.hls);

  if (isFile){
    v.src = ep.hls;
    start();
    return;
  }

  // .m3u8 всегда пытаемся играть через hls.js (MSE): canPlayType здесь ненадёжен
  // и может отдавать "maybe" даже там, где нативного HLS нет.
  loadHls().then(Hls => {
    if (Hls && Hls.isSupported()){
      if (watching.src !== 'ani' || watching.aniEp !== ep) return;
      ani.hls = new Hls({ enableWorker: true });
      ani.hls.loadSource(ep.hls);
      ani.hls.attachMedia(v);
      ani.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        $('p-loader').classList.add('hidden');
        start();
      });
      ani.hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && ani.retries < 2){
          ani.retries++;
          ani.hls.startLoad();
          return;
        }
        showAniError('Серия не загрузилась', 'Переключитесь на Kodik или попробуйте позже');
      });
      return;
    }

    // Запасной путь: Safari и другие браузеры с настоящим нативным HLS.
    if (v.canPlayType('application/vnd.apple.mpegurl')){
      v.src = ep.hls;
      start();
      return;
    }

    showAniError('Не удалось загрузить HLS-плеер', 'Попробуйте Kodik или Safari');
  });
}

/* События нативного видео → те же хуки прогресса, что и у Kodik. */

function bindAniVideo(){
  const v = $('p-video');
  if (!v || v.dataset.bound) return;
  v.dataset.bound = '1';

  v.addEventListener('play', () => {
    if (watching.src !== 'ani') return;
    watching.playing = true;
    onVideoStarted();
  });
  v.addEventListener('pause', () => {
    if (watching.src === 'ani') watching.playing = false;
  });
  v.addEventListener('timeupdate', () => {
    if (watching.src !== 'ani') return;
    if (v.duration && Math.abs((watching.dur || 0) - v.duration) > 1) watching.dur = v.duration;
    onPlayerTime(v.currentTime || 0);
  });
  v.addEventListener('loadedmetadata', () => {
    if (watching.src !== 'ani') return;
    watching.dur = v.duration || watching.dur;
    $('p-loader').classList.add('hidden');
    $('p-error').classList.add('hidden');
  });
  v.addEventListener('ended', () => {
    if (watching.src === 'ani') onVideoEnded();
  });
  v.addEventListener('error', () => {
    if (watching.src !== 'ani' || !v.getAttribute('src')) return;
    showAniError('Серия не загрузилась', 'Переключитесь на Kodik или попробуйте позже');
  });
}

function switchEpisode(ep, target, translationTitle){
  if (!current) return;
  if (watching.src === 'ani'){
    const e = aniEpisodeByOrdinal(ep);
    if (!e) return;
    playAni(e.ordinal, Math.max(0, Number(target) || 0), true);
    if (party.on && party.host) onEpisode({ episode: e.ordinal, translation: 'AniLiberty' });
    return;
  }
  const voices = current.voices || [];
  if (!voices.length) return;
  let voice = voices[0];
  if (translationTitle){
    const nt = normText(translationTitle);
    const found = voices.find(v => normText(v.translation) === nt);
    if (found) voice = found;
  }
  watching.ep = ep;
  watching.lastT = null;
  watching.lastTs = 0;
  watching.cur = 0;
  watching.dur = 0;
  watching.resumeTarget = Math.max(0, target || 0);
  watching.resumeTriedAt = 0;
  watching.resumeAttempts = 0;
  watching.resumeDone = !(target > 20);
  watching.playing = false;
  watching.started = false;
  party.epGuardUntil = Date.now() + 6000;
  party.lastEpTarget = Number(ep) || 0;
  party.lastEpAt = Date.now();
  skipArmed = false;
  skipDone = true;          // при переключении серии опенинг не проматываем
  $('p-skip').classList.add('hidden');
  play(voice, ep);
}

function play(voice, episode){
  watching.src = 'kodik';
  watching.aniEp = null;
  const pv = $('p-video');
  if (pv) pv.classList.add('hidden');
  const pf = $('p-iframe');
  if (pf) pf.classList.remove('hidden');
  if ($('p-eps-sec')) $('p-eps-sec').classList.add('hidden');
  $('p-open').classList.remove('hidden');
  renderSourceUI();
  watching.voice = voice || null;
  if (voice && voice.translation) watching.tr = voice.translation;
  const url = withEpisode(absUrl(voice.link), episode);
  if (!url){ showPlayError(); return; }
  $('p-error').classList.add('hidden');
  $('p-loader').classList.remove('hidden');
  $('p-open').href = url;

  const frame = $('p-iframe');
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    $('p-loader').classList.add('hidden');
    toast('Видео грузится долго — откройте в новой вкладке');
  }, 15000);

  frame.onload = null;
  frame.src = 'about:blank';
  setTimeout(() => {
    frame.onload = () => {
      clearTimeout(loadTimer);
      $('p-loader').classList.add('hidden');
    };
    frame.src = url;
  }, 30);
}

function addMeta(container, value){
  if (!value) return;
  const s = document.createElement('span');
  s.textContent = value;
  container.appendChild(s);
}

function renderMeta(it){
  const meta = $('p-meta');
  meta.innerHTML = '';
  addMeta(meta, it.kind);
  addMeta(meta, it.year);
  if (it.episodes) addMeta(meta, it.episodes + ' эп.');
  if (it.minAge) addMeta(meta, it.minAge + '+');
  if (it.rating) addMeta(meta, '★ ' + it.rating.toFixed(1));
}

function renderGenres(g){
  const box = $('p-genres');
  box.innerHTML = '';
  (g || []).slice(0, 8).forEach(x => {
    const s = document.createElement('span');
    s.className = 'genre';
    s.textContent = x;
    box.appendChild(s);
  });
}

function updateFavIcon(it){
  const btn = $('p-fav');
  const on = isFav(it.key);
  btn.textContent = on ? '♥' : '♡';
  btn.classList.toggle('on', on);
}

function updateStatusBtn(it){
  const btn = $('p-status');
  const cur = listOf(it.key);
  btn.textContent = cur ? '✓ ' + LIST_NAMES[cur] : '+ В список';
  btn.classList.toggle('on', !!cur);
}

function showPlayError(title, sub){
  $('p-loader').classList.add('hidden');
  if ($('p-err-title')) $('p-err-title').textContent = title || 'Источник видео не подключён';
  if ($('p-err-sub')) $('p-err-sub').textContent = sub || 'Попробуйте другой источник или откройте в новой вкладке';
  $('p-error').classList.remove('hidden');
}

function closePlayer(){
  if (current && watching.cur > 5){
    progress[current.key] = { t: watching.cur, d: watching.dur || 0, ep: watching.ep, ts: Date.now() };
    LS.set('pos', progress);
  }
  saveStats();
  destroyAni();
  $('player').classList.remove('open');
  $('p-iframe').onload = null;
  $('p-iframe').src = 'about:blank';
  const pv = $('p-video');
  if (pv){
    pv.classList.add('hidden');
    pv.removeAttribute('src');
  }
  if ($('p-src')) $('p-src').classList.add('hidden');
  if ($('p-eps-sec')) $('p-eps-sec').classList.add('hidden');
  if ($('p-eps')) $('p-eps').innerHTML = '';
  ani.key = '';
  ani.release = null;
  ani.episodes = [];
  ani.loading = false;
  ani.fallbackActive = false;
  document.body.style.overflow = '';
  clearTimeout(loadTimer);
  hideRelated();
  current = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  renderHistoryRow();
  renderProfile();
}

/* ============================================================
   ПРОФИЛЬ
   ============================================================ */
const RANKS = [
  { h: 0,   name: 'Новичок',   icon: '🌱' },
  { h: 5,   name: 'Зритель',   icon: '🍿' },
  { h: 20,  name: 'Отаку',     icon: '🎌' },
  { h: 50,  name: 'Сэмпай',    icon: '🏮' },
  { h: 120, name: 'Легенда',   icon: '⭐' },
  { h: 300, name: 'Хранитель', icon: '👑' }
];

const ACHIEVEMENTS = [
  { id:'first',  icon:'🎬', name:'Первый кадр',   check:() => stats.episodes >= 1 },
  { id:'ten',    icon:'🔟', name:'Десятка',       check:() => stats.episodes >= 10 },
  { id:'hundred',icon:'💯', name:'Сотка',         check:() => stats.episodes >= 100 },
  { id:'h10',    icon:'⏱', name:'10 часов',      check:() => stats.sec >= 36000 },
  { id:'h100',   icon:'🕰', name:'100 часов',     check:() => stats.sec >= 360000 },
  { id:'t10',    icon:'📚', name:'Коллекционер',  check:() => Object.keys(stats.titles).length >= 10 },
  { id:'fav5',   icon:'❤️', name:'Фанат',         check:() => favs.length >= 5 },
  { id:'night',  icon:'🌙', name:'Ночной зритель',check:() => !!stats.flags.night },
  { id:'skip',   icon:'⏭', name:'Без опенинга',  check:() => !!stats.flags.skip },
  { id:'party',  icon:'👥', name:'В компании',    check:() => !!stats.flags.party }
];

function rankOf(hours){
  let i = 0;
  for (let k = 0; k < RANKS.length; k++) if (hours >= RANKS[k].h) i = k;
  const cur = RANKS[i], next = RANKS[i + 1] || null;
  const span = next ? next.h - cur.h : 1;
  const done = next ? (hours - cur.h) / span : 1;
  return { cur, next, progress: Math.max(0, Math.min(1, done)) };
}

function avatarLetter(name){
  const s = String(name || 'Г').trim();
  return (s[0] || 'Г').toUpperCase();
}

function avatarHue(name){
  let h = 0;
  for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

let profileList = 'watching';

function renderProfile(){
  if (!$('prof-name')) return;
  $('prof-name').textContent = me.name || 'Гость';
  $('prof-avatar').textContent = avatarLetter(me.name);
  const hue = avatarHue(me.name);
  $('prof-avatar').style.background = `linear-gradient(135deg, hsl(${hue} 85% 55%), hsl(${(hue + 55) % 360} 80% 50%))`;

  const hours = stats.sec / 3600;
  const r = rankOf(hours);
  $('prof-rank-icon').textContent = r.cur.icon;
  $('prof-rank').textContent = r.cur.name;
  $('rank-fill').style.width = Math.round(r.progress * 100) + '%';
  $('rank-next').textContent = r.next
    ? `До «${r.next.name}» осталось ${(r.next.h - hours).toFixed(1)} ч`
    : 'Максимальный ранг — вы легенда';

  $('st-hours').textContent = fmtHours(stats.sec);
  $('st-titles').textContent = Object.keys(stats.titles).length;
  $('st-ep').textContent = stats.episodes || 0;
  $('st-days').textContent = Object.keys(stats.days).length;

  // любимые жанры
  const gbox = $('prof-genres');
  gbox.innerHTML = '';
  const gs = Object.entries(stats.genres).sort((a, b) => b[1] - a[1]).slice(0, 8);
  gs.forEach(([g, n]) => {
    const s = document.createElement('span');
    s.className = 'genre';
    s.textContent = g + ' · ' + n;
    gbox.appendChild(s);
  });
  gbox.classList.toggle('hidden', !gs.length);
  $('prof-genres-empty').classList.toggle('hidden', !!gs.length);

  // достижения
  const abox = $('prof-achievements');
  abox.innerHTML = '';
  let unlocked = 0;
  ACHIEVEMENTS.forEach(a => {
    let on = false;
    try{ on = !!a.check(); }catch(e){}
    if (on) unlocked++;
    const d = document.createElement('div');
    d.className = 'ach ' + (on ? 'on' : 'off');
    d.innerHTML = `<div class="ach-i">${a.icon}</div><div class="ach-n">${esc(a.name)}</div>`;
    d.title = a.name;
    abox.appendChild(d);
  });
  $('prof-ach-count').textContent = unlocked + ' / ' + ACHIEVEMENTS.length;

  renderList();
  renderFavs();
  renderProfileHistory();
}

function renderList(){
  document.querySelectorAll('#list-tabs .ltab').forEach(b => b.classList.toggle('on', b.dataset.list === profileList));
  const grid = $('list-grid');
  const items = lists[profileList] || [];
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  items.forEach(it => frag.appendChild(cardEl(it)));
  grid.appendChild(frag);
  $('list-empty').classList.toggle('hidden', items.length > 0);
}

function renderFavs(){
  const grid = $('fav-grid');
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  favs.forEach(it => frag.appendChild(cardEl(it)));
  grid.appendChild(frag);
  $('fav-empty').classList.toggle('hidden', favs.length > 0);
}

function renderProfileHistory(){
  const grid = $('hist-grid');
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  watched.forEach(it => frag.appendChild(cardEl(it)));
  grid.appendChild(frag);
  $('hist-empty').classList.toggle('hidden', watched.length > 0);
}

function cycleList(it){
  const order = ['', 'watching', 'completed', 'planned', 'dropped'];
  const cur = listOf(it.key);
  const next = order[(order.indexOf(cur) + 1) % order.length];
  setList(it, next);
  updateStatusBtn(it);
  toast(next ? 'Список: ' + LIST_NAMES[next] : 'Убрано из списков');
  renderProfile();
}

/* ============================================================
   ИМПОРТ SHIKIMORI / MAL (XML)
   ============================================================ */
async function importListFile(file){
  let text = '';
  try{ text = await file.text(); }catch(e){ toast('Не удалось прочитать файл'); return; }
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')){ toast('Это не XML-экспорт списка'); return; }
  const nodes = [...doc.querySelectorAll('anime')];
  if (!nodes.length){ toast('В файле нет аниме'); return; }

  const statusMap = { '1':'watching', '2':'completed', '3':'planned', '4':'dropped', '5':'planned', '6':'planned' };
  const entries = [];
  nodes.forEach(n => {
    const title = (n.querySelector('series_title') || {}).textContent || '';
    const st = ((n.querySelector('my_status') || {}).textContent || '').trim();
    const ep = parseInt(((n.querySelector('my_watched_episodes') || {}).textContent || '0'), 10) || 0;
    if (!title.trim()) return;
    entries.push({ title: title.trim(), status: statusMap[st] || 'planned', ep });
  });
  if (!entries.length){ toast('В файле нет записей'); return; }

  toast('Импортирую ' + entries.length + ' тайтлов…', 4000);
  const queue = entries.slice(0, 120);
  let resolved = 0, done = 0;

  const worker = async () => {
    while (queue.length){
      const e = queue.shift();
      done++;
      if (done % 12 === 0) toast('Синхронизация: ' + resolved + ' из ' + done, 1200);
      const g = await findCatalog(e.title, e.ep);
      if (!g) continue;
      setList(g, e.status);
      resolved++;
    }
  };

  await Promise.all([worker(), worker(), worker()]);
  LS.set('imported', entries);
  renderProfile();
  toast('Готово: ' + resolved + ' из ' + entries.length + ' добавлено', 4000);
}

/* Найти тайтл каталога по названию из внешнего списка (Shikimori/MAL/файл).
   Возвращает группу Kodik или null. */
async function findCatalog(title, epWanted){
  const nt = normText(title);
  // MAL/Shikimori хранят английское или ромадзи-название, а Kodik — русское.
  // Пробуем исходное название, затем синоним из ALIASES.
  const tries = uniq([title, ...(aliasGroup(nt) || [])]).slice(0, 3);
  const groups = [];
  for (const t of tries){
    const res = await api('search', {
      title: t, limit: 50,
      types: 'anime,anime-serial', with_material_data: 'true'
    });
    groupResults(res && res.results).forEach(g => {
      if (!groups.some(x => x.key === g.key)) groups.push(g);
    });
    if (groups.length >= 6) break;
  }
  if (!groups.length) return null;

  const queries = uniq([nt, ...tries.map(normText)]).filter(Boolean);
  let best = null, bestRank = -1e9;
  groups.forEach(g => {
    let s = 0;
    for (const q of queries){
      s = Math.max(s,
        scoreText(q, normText(g.title)),
        scoreText(q, normText(g.orig)),
        scoreText(q, normText(g.alt)),
        scoreText(q, normText(translit(g.title))));
    }
    // при близком совпадении предпочитаем основной сериал, а не спин-офф/сезон
    let lenPen = 999;
    [g.title, g.orig, g.alt].forEach(x => {
      const t = normText(x);
      if (!t) return;
      for (const q of queries) lenPen = Math.min(lenPen, Math.abs(t.length - q.length));
    });
    const epMatch = (epWanted > 0 && g.episodes)
      ? Math.max(0, 1 - Math.abs(g.episodes - epWanted) / Math.max(g.episodes, epWanted))
      : 0;
    // если пользователь досмотрел ровно столько же серий — это сильный признак
    const epBonus = epMatch * 60;
    const seq = (epMatch < 1 && /тв-[2-9]|сезон\s*[2-9]|\b[2-9](nd|rd|th)\b|фильм|movie|\bova\b|\bona\b|спешл|special/i.test(g.title + ' ' + (g.orig || ''))) ? 40 : 0;
    const bonus = (g.rating || 0) * 2 + Math.min(g.episodes || 0, 60) * 0.5
                + epBonus - (lenPen === 999 ? 0 : lenPen) * 3 - seq;
    const rank = s + bonus;
    if (rank > bestRank){ bestRank = rank; best = { g, s }; }
  });
  return best && best.s >= 320 ? best.g : null;
}

/* ============================================================
   ВХОД ЧЕРЕЗ SHIKIMORI / MYANIMELIST
   ============================================================ */
const sync = {
  sid: LS.get('sync_sid', ''),
  info: null,
  providers: [],
  busy: false
};

/* Запрос к своему серверу. Возвращает { ok, status, data } или null,
   если сервера нет — тогда весь блок входа просто не показывается. */
async function backend(path, opts = {}){
  if (!API_BASE) return null;
  try{
    const res = await fetch(API_BASE + path, { cache: 'no-store', ...opts });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  }catch(e){
    return null;
  }
}

function providerLabel(key){
  const p = sync.providers.find(x => x.key === key);
  if (p) return p.label;
  return key === 'mal' ? 'MyAnimeList' : 'Shikimori';
}

/* 1 тайтл · 2 тайтла · 5 тайтлов */
function plural(n, forms){
  const v = Math.abs(Number(n) || 0) % 100;
  const d = v % 10;
  if (v > 10 && v < 20) return forms[2];
  if (d === 1) return forms[0];
  if (d >= 2 && d <= 4) return forms[1];
  return forms[2];
}

function renderAuth(){
  if (!$('auth-box')) return;
  const signed = !!(sync.info && sync.info.user);
  $('auth-guest').classList.toggle('hidden', signed);
  $('auth-user').classList.toggle('hidden', !signed);
  $('auth-actions').classList.toggle('hidden', !signed);

  if (!API_BASE){
    $('auth-buttons').innerHTML = '';
    $('auth-hint').textContent = 'Вход в один клик работает через свой сервер (server/). Пока его нет — используйте импорт файла.';
    return;
  }

  const enabled = sync.providers.filter(p => p.enabled);
  if (!enabled.length){
    $('auth-buttons').innerHTML = '';
    $('auth-hint').textContent = 'Сервер не настроен для входа: нужны SHIKI_CLIENT_ID и SHIKI_CLIENT_SECRET.';
  }else if (!signed){
    $('auth-buttons').innerHTML = enabled
      .map(p => '<button class="btn-ghost" data-auth="' + esc(p.key) + '">Войти через ' + esc(p.label) + '</button>')
      .join('');
    $('auth-buttons').querySelectorAll('[data-auth]').forEach(b => {
      b.onclick = () => authLogin(b.dataset.auth);
    });
    $('auth-hint').textContent = 'Один клик — и списки со сайта подтянутся сюда. Файл экспорта больше не нужен.';
  }

  if (signed){
    const u = sync.info.user;
    $('auth-name').textContent = u.name || 'Профиль';
    $('auth-sub').textContent = providerLabel(sync.info.provider) + ' · ' + (sync.info.count || 0) + ' ' + plural(sync.info.count || 0, ['тайтл', 'тайтла', 'тайтлов']);
    const av = $('auth-avatar');
    if (u.avatar){
      av.src = u.avatar;
      av.classList.remove('hidden');
    }else{
      av.removeAttribute('src');
      av.classList.add('hidden');
    }
  }
}

function authLogin(key){
  if (!API_BASE) return;
  const back = location.origin + location.pathname + location.search;
  location.href = API_BASE + '/api/auth/' + encodeURIComponent(key) + '/start?return=' + encodeURIComponent(back);
}

function authForget(){
  sync.sid = '';
  sync.info = null;
  LS.del('sync_sid');
  renderAuth();
}

async function authRefresh(){
  if (!sync.sid) return;
  const me = await backend('/api/auth/me?sid=' + encodeURIComponent(sync.sid));
  if (me && me.ok){
    sync.info = me.data;
    renderAuth();
  }else if (me && me.status === 401){
    authForget();
  }
}

async function initAuth(){
  // вернулись из OAuth: sid пришёл во фрагменте, чтобы не попасть в логи
  const hash = location.hash || '';
  let fresh = false;
  if (hash.indexOf('#sync=') === 0){
    const sid = hash.slice(6).trim();
    if (sid){
      sync.sid = sid;
      LS.set('sync_sid', sid);
      fresh = true;
    }
    history.replaceState(history.state, '', location.pathname + location.search);
  }

  const pr = await backend('/api/auth/providers');
  if (pr && pr.ok && pr.data) sync.providers = pr.data.providers || [];
  renderAuth();

  if (sync.sid){
    await authRefresh();
    if (fresh && sync.info){
      openSheet('settings-sheet');
      syncLists();
    }else if (sync.info){
      // списки обновляем сами, если давно не виделись
      const meta = LS.get('sync_meta', null);
      const stale = !meta || Date.now() - (meta.at || 0) > 6 * 3600 * 1000;
      if (stale) idle(() => syncLists(true));
    }
  }
  renderAuth();
}

/* Сопоставить запись внешнего списка с тайтлом каталога. */
async function resolveRate(rate){
  if (rate.shikimori_id){
    const res = await api('search', {
      shikimori_id: String(rate.shikimori_id), with_material_data: 'true', limit: 20
    });
    const groups = groupResults(res && res.results);
    const exact = groups.find(g => String(g.sid) === String(rate.shikimori_id));
    if (exact) return exact;
    if (groups.length) return groups[0];
  }
  const title = rate.title_en || rate.title;
  if (!title) return null;
  return findCatalog(title, rate.watched || rate.episodes_total || 0);
}

async function applyRates(rates, silent){
  const queue = rates.slice(0, 400);
  let done = 0, matched = 0;
  const worker = async () => {
    while (queue.length){
      const r = queue.shift();
      done++;
      if (!silent && done % 10 === 0) toast('Синхронизация: ' + matched + ' из ' + done, 900);
      const g = await resolveRate(r);
      if (!g) continue;
      setList(g, r.status || 'planned');
      // сколько серий уже посмотрено — чтобы «продолжить» открывало нужную
      if (r.watched > 0){
        const p = progress[g.key] || {};
        if (!p.ep || p.ep < r.watched){ p.ep = r.watched; p.ts = Date.now(); progress[g.key] = p; }
      }
      matched++;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (matched){
    LS.set('pos', progress);
    LS.set('sync_meta', { from: sync.info && sync.info.provider, at: Date.now() });
    renderHistoryRow();
  }
  return matched;
}

async function syncLists(silent){
  if (!sync.sid || sync.busy) return;
  sync.busy = true;
  const btn = $('btn-auth-sync');
  if (btn) btn.disabled = true;
  try{
    const r = await backend('/api/auth/rates?sid=' + encodeURIComponent(sync.sid));
    if (!r){
      toast('Сервер не отвечает');
      return;
    }
    if (r.status === 401){
      authForget();
      toast('Сессия истекла — войдите заново', 3200);
      return;
    }
    if (!r.ok || !r.data){
      toast('Не удалось получить списки');
      return;
    }
    sync.info = r.data.session || sync.info;
    const rates = r.data.rates || [];
    const matched = await applyRates(rates, silent);
    renderAuth();
    renderProfile();
    if (!silent) toast('Синхронизировано: ' + matched + ' из ' + rates.length, 3200);
  }finally{
    sync.busy = false;
    if (btn) btn.disabled = false;
  }
}

/* ============================================================
   АДРЕС СВОЕГО СЕРВЕРА
   ============================================================ */

function apiAddress(){
  return API_BASE;
}

/* Принимаем и «api.домен», и полный URL, и лишний /api на конце. */
function normalizeApiUrl(raw){
  let v = (raw || '').trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)){
    v = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(v) ? 'http://' + v : 'https://' + v;
  }
  v = v.replace(/\/+$/, '').replace(/\/api$/, '');
  return v;
}

async function renderApi(){
  if (!$('api-url')) return;
  const cur = apiAddress();
  $('api-url').value = cur;
  if (!cur){
    $('api-hint').textContent = 'Без сервера приложение работает как обычно — напрямую с Kodik. С сервером появляется вход в один клик и перенос профиля.';
    return;
  }
  $('api-hint').textContent = 'Сейчас: ' + cur + ' — проверяю…';
  const ok = await getJSON(cur + '/api/health', 4000).then(() => true).catch(() => false);
  if (apiAddress() !== cur) return; // адрес успели поменять
  $('api-hint').textContent = ok
    ? 'Сейчас: ' + cur + ' — сервер отвечает.'
    : 'Сейчас: ' + cur + ' — сервер не отвечает. Проверьте адрес и что он запущен.';
}

/* ============================================================
   ПЕРЕНОС ПРОФИЛЯ МЕЖДУ УСТРОЙСТВАМИ
   ============================================================ */
async function cloudSave(){
  if (!API_BASE){ toast('Нужен свой сервер (server/)'); return; }
  const btn = $('btn-cloud-save');
  if (btn) btn.disabled = true;
  try{
    const r = await backend('/api/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(profileDump())
    });
    if (!r || !r.ok || !r.data || !r.data.code){
      toast((r && r.data && r.data.error) || 'Не удалось сохранить');
      return;
    }
    const code = r.data.code;
    $('cloud-hint').innerHTML = 'Код профиля: <b class="mono">' + esc(code) +
      '</b> — введите его на другом устройстве. Код живёт 30 дней.';
    try{
      await navigator.clipboard.writeText(code);
      toast('Код скопирован: ' + code, 4000);
    }catch(e){
      toast('Код: ' + code, 6000);
    }
  }finally{
    if (btn) btn.disabled = false;
  }
}

async function cloudLoad(){
  if (!API_BASE){ toast('Нужен свой сервер (server/)'); return; }
  const code = ($('cloud-code').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 7){ toast('Код — 7 символов'); return; }
  const btn = $('btn-cloud-load');
  if (btn) btn.disabled = true;
  try{
    const r = await backend('/api/profile/' + code);
    if (!r){
      toast('Сервер не отвечает');
      return;
    }
    if (r.status === 404){ toast('Профиль не найден или истёк'); return; }
    if (!r.ok || !r.data){ toast('Не удалось загрузить'); return; }
    const keys = Object.keys(r.data).filter(k => k.indexOf('anime_') === 0);
    if (!keys.length){ toast('В профиле нет данных'); return; }
    if (!confirm('Заменить текущие списки, историю и настройки профилем с другого устройства?')) return;

    keys.forEach(k => {
      const v = r.data[k];
      localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    });
    toast('Профиль загружен, перезапускаю…', 1500);
    setTimeout(() => location.reload(), 900);
  }finally{
    if (btn) btn.disabled = false;
  }
}

/* Дамп для облака: без кешей каталога — они большие и пересобираются сами. */
function profileDump(){
  const dump = {};
  for (let i = 0; i < localStorage.length; i++){
    const k = localStorage.key(i);
    if (!k || k.indexOf('anime_') !== 0) continue;
    if (/^anime_(db|c_)/.test(k)) continue;
    try{ dump[k] = JSON.parse(localStorage.getItem(k)); }catch(e){ dump[k] = localStorage.getItem(k); }
  }
  return dump;
}

/* Полный дамп — для файла экспорта: там кеш каталога тоже не нужен. */
function fullDump(){
  const dump = {};
  for (let i = 0; i < localStorage.length; i++){
    const k = localStorage.key(i);
    if (k && k.indexOf('anime_') === 0){
      try{ dump[k] = JSON.parse(localStorage.getItem(k)); }catch(e){ dump[k] = localStorage.getItem(k); }
    }
  }
  return dump;
}

function exportData(){
  const blob = new Blob([JSON.stringify(fullDump(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'anime-backup-' + todayKey() + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Данные сохранены');
}

function resetAll(){
  if (!confirm('Удалить профиль, историю, избранное и списки?')) return;
  const keys = [];
  for (let i = 0; i < localStorage.length; i++){
    const k = localStorage.key(i);
    if (k && k.indexOf('anime_') === 0) keys.push(k);
  }
  keys.forEach(k => localStorage.removeItem(k));
  location.reload();
}

/* ============================================================
   WATCH PARTY (ntfy.sh)
   ============================================================ */
const party = {
  on: false, code: '', host: false, name: '',
  es: null, myId: Math.random().toString(36).slice(2, 10),
  members: new Map(), lastPublish: 0, titleKey: '', joining: false,
  epGuardUntil: 0, lastEpTarget: 0, lastEpAt: 0,
  ws: null, wsReady: false, queue: []
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeRoomCode(){
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}
const partyTopic = () => 'anime-party-' + party.code.toLowerCase();

function partyPublish(payload){
  const body = JSON.stringify({ from: party.myId, name: party.name, ...payload });
  if (party.ws && (party.ws.readyState === 0 || party.ws.readyState === 1)){
    if (party.ws.readyState === 1){
      try{ party.ws.send(body); }catch(e){}
    }else{
      party.queue.push(body);
      if (party.queue.length > 40) party.queue.shift();
    }
    return Promise.resolve();
  }
  return fetch(NTFY + '/' + partyTopic(), {
    method: 'POST',
    body,
    headers: { 'X-Title': 'anime', 'X-Tags': 'tv' }
  }).catch(() => {});
}

/* Комната через WebSocket бэкенда (server/) */
function partyConnectWS(attempt = 0){
  if (!API_BASE || typeof WebSocket === 'undefined') return false;
  let ws;
  try{ ws = new WebSocket(API_BASE.replace(/^http/, 'ws') + '/api/ws/party/' + party.code); }
  catch(e){ return false; }

  party.ws = ws;
  party.wsReady = false;
  ws.onopen = () => {
    if (party.ws !== ws) return;
    party.wsReady = true;
    refreshPartyUI();
    const q = party.queue;
    party.queue = [];
    q.forEach(m => { try{ ws.send(m); }catch(e){} });
  };
  ws.onmessage = ev => { try{ partyHandle({ message: ev.data, time: Date.now() / 1000 }); }catch(e){} };
  ws.onclose = () => {
    if (party.ws !== ws) return;
    party.ws = null;
    party.wsReady = false;
    if (!party.on) return;
    if (attempt < 3){
      setTimeout(() => { if (party.on && !party.ws) partyConnectWS(attempt + 1); }, 1200 * (attempt + 1));
    }else{
      partyUseNtfy();      // сервер недоступен — тихо переезжаем на публичный канал
      if (party.on) partyPublish({ k: 'join' });
    }
  };
  ws.onerror = () => {};
  return true;
}

function partyUseNtfy(){
  if (party.es) return;
  try{
    party.es = new EventSource(NTFY + '/' + partyTopic() + '/sse');
    party.es.onmessage = ev => { try{ partyHandle(JSON.parse(ev.data)); }catch(e){} };
    party.es.onerror = () => {
      // EventSource сам переподключается; ругаемся только если совсем долго
    };
  }catch(e){
    toast('Не удалось подключиться к комнате');
  }
  refreshPartyUI();
}

function partySend(payload){
  if (!party.on) return;
  party.lastPublish = Date.now();
  partyPublish(payload);
}

/* Что хост отдаёт гостю при открытии тайтла: ссылка, серия и позиция */
function partyOpenPayload(){
  if (!current) return null;
  const v = watching.voice || (current.voices && current.voices[0]);
  return {
    k: 'open',
    item: slim(current),
    voiceLink: v ? v.link : '',
    src: watching.src || 'kodik',
    ep: watching.ep || null,
    t: Math.round(watching.cur || 0),
    translation: watching.tr || ''
  };
}

/* Гость повторяет переключение серии за хостом */
function partyAdoptEpisode(ep, target, translation){
  ep = Number(ep) || 0;
  if (!ep || !current) return false;
  if (Number(watching.ep) === ep && Date.now() >= (party.epGuardUntil || 0)) return false;
  if (party.lastEpTarget === ep && Date.now() - party.lastEpAt < 60000) return false;
  partyChatLine('', 'Хост переключил на серию ' + ep, true);
  toast('Серия ' + ep);
  switchEpisode(ep, Math.max(0, Number(target) || 0), translation || '');
  return true;
}

function partySyncPublish(){
  if (!party.on || !party.host || !current) return;
  party.lastPublish = 0;
  partyPublish({
    k: 'tick',
    t: Math.round(watching.cur || 0),
    d: Math.round(watching.dur || 0),
    ep: watching.ep,
    paused: !watching.playing,
    titleKey: current.key,
    translation: watching.tr || ''
  });
}

function partyOnTime(t){
  if (!party.on || !party.host) return;
  const now = Date.now();
  if (now - party.lastPublish < 9000) return;
  party.lastPublish = now;
  partyPublish({
    k: 'tick', t: Math.round(t), d: Math.round(watching.dur || 0),
    ep: watching.ep, paused: false, titleKey: current ? current.key : '',
    translation: watching.tr || ''
  });
}

function askPartyState(){
  if (!party.on || party.host) return;
  partyPublish({ k: 'state_req' });
}

function partyMembersText(){
  const now = Date.now();
  let n = party.on ? 1 : 0;   // я сам
  party.members.forEach(m => { if (now - m.ts < 180000) n++; });
  const word = n % 10 === 1 && n % 100 !== 11 ? 'участник' : 'участников';
  return n + ' ' + word;
}

function refreshPartyUI(){
  const inRoom = party.on;
  $('party-setup').classList.toggle('hidden', inRoom);
  $('party-room').classList.toggle('hidden', !inRoom);
  if (!inRoom) return;
  $('party-code').textContent = party.code;
  $('party-role').textContent = (party.host ? 'вы — хост' : 'вы — гость') + (party.wsReady ? ' · сервер' : '');
  $('party-people').textContent = partyMembersText();
  $('party-sync').textContent = party.host ? 'Отправить сигнал' : 'Догнать хоста';
  const url = location.origin + location.pathname + '?party=' + party.code;
  $('party-hint').textContent = 'Ссылка для друзей: ' + url;
}

function partyChatLine(name, text, sys){
  const box = $('party-chat');
  const d = document.createElement('div');
  d.className = 'cmsg' + (sys ? ' sys' : '') + (name === party.name ? ' me' : '');
  d.innerHTML = sys ? esc(text) : '<b>' + esc(name) + '</b> ' + esc(text);
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 200) box.removeChild(box.firstChild);
}

function partyJoin(code, asHost){
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (code.length < 5){ toast('Код комнаты — 5 символов'); return; }
  partyLeave(true);
  party.code = code;
  party.host = !!asHost;
  party.name = ($('party-nick').value || me.name || 'Гость').slice(0, 20);
  party.on = true;
  party.members.clear();
  party.lastSyncMsg = 0;
  if (asHost) stats.flags.party = 1, saveStats();

  $('party-chat').innerHTML = '';
  partyChatLine('', asHost ? 'Комната создана. Код: ' + code : 'Вы вошли в комнату ' + code, true);

  party.queue = [];
  if (!partyConnectWS()) partyUseNtfy();

  partyPublish({ k: 'join' });
  if (asHost){
    partyPublish({ k: 'hi' });
    if (current) setTimeout(() => {
      const p = partyOpenPayload();
      if (p) partyPublish(p);
    }, 400);
  }else{
    setTimeout(askPartyState, 500);
  }

  LS.set('partyName', party.name);
  refreshPartyUI();
  clearInterval(party.uiTick);
  party.uiTick = setInterval(updatePeople, 15000);
  history.replaceState(history.state, '', '?party=' + code);
  toast(asHost ? 'Комната создана' : 'Вы в комнате ' + code);
}

function partyLeave(silent){
  if (party.on && !silent) partyPublish({ k: 'bye' });
  party.on = false;            // до закрытия сокета, иначе сработает переподключение
  if (party.ws){ try{ party.ws.close(); }catch(e){} }
  party.ws = null;
  party.wsReady = false;
  party.queue = [];
  if (party.es){ try{ party.es.close(); }catch(e){} }
  party.es = null;
  party.host = false;
  party.code = '';
  party.titleKey = '';
  party.members.clear();
  clearInterval(party.uiTick);
  if (!silent){
    refreshPartyUI();
    const u = location.origin + location.pathname;
    try{ history.replaceState(history.state, '', u); }catch(e){}
    toast('Вы вышли из комнаты');
  }
}

function partyHandle(env){
  if (!env) return;
  // ntfy присылает конверт { message, time }, WebSocket — само сообщение
  const raw = env.message != null ? env.message : env;
  let m;
  if (typeof raw === 'string'){
    try{ m = JSON.parse(raw); }catch(e){ return; }
  }else{
    m = raw;
  }
  if (!m || typeof m !== 'object' || m.from === party.myId) return;

  const at = (env.time || (Date.now() / 1000)) * 1000;
  party.members.set(m.from, { name: m.name || 'Гость', ts: Date.now() });
  updatePeople();

  switch (m.k){
    case 'join':
      partyChatLine('', (m.name || 'Кто-то') + ' присоединился', true);
      partyPublish({ k: 'hi' });
      if (party.host){
        const p = partyOpenPayload();
        if (p) partyPublish(p);
      }
      break;

    case 'hi':
      partyPublish({ k: 'hi' });
      break;

    case 'chat':
      partyChatLine(m.name || 'Гость', String(m.text || '').slice(0, 300));
      break;

    case 'open': {
      if (!m.item || party.host) break;
      const ep = Number(m.ep) || 0;
      if (current && current.key === m.item.key){
        // тот же тайтл — просто догоняем серию
        if (ep && ep !== Number(watching.ep)) partyAdoptEpisode(ep, m.t, m.translation);
        break;
      }
      const it = m.item;
      it.voices = m.voiceLink ? [{ link: m.voiceLink, translation: m.translation || 'Комната', quality: '' }] : [];
      if (ep) it._ep = ep;
      party.titleKey = it.key;
      partyChatLine('', 'Хост включил: ' + it.title + (ep ? ' · серия ' + ep : ''), true);
      openPlayer(it);
      if (m.src === 'ani'){
        loadAni(it).then(() => {
          if (current !== it || !ani.episodes.length) return;
          sourceTouched = true;
          setSource('ani', true, Math.max(0, Number(m.t) || 0));
        }).catch(() => {});
      }
      break;
    }

    case 'tick': {
      if (party.host) break;
      party.titleKey = m.titleKey || party.titleKey;
      if (!current) break;
      if (m.titleKey && current.key !== m.titleKey) break;

      // серия поменялась — перезагружаем плеер гостя на нужную
      if (m.ep != null && Number(m.ep) !== Number(watching.ep)){
        const age0 = Math.max(0, (Date.now() - at) / 1000);
        const t0 = (m.t || 0) + (m.paused ? 0 : Math.min(age0, 30));
        if (partyAdoptEpisode(m.ep, t0, m.translation)) break;
      }

      const age = Math.max(0, (Date.now() - at) / 1000);
      const target = (m.t || 0) + (m.paused ? 0 : Math.min(age, 30));
      const drift = Math.abs((watching.cur || 0) - target);

      if (m.paused && watching.playing){
        playerCmd('pause');
        watching.playing = false;
      }else if (!m.paused && !watching.playing && drift > 3){
        playerCmd('play');
      }

      if (drift > 7){
        playerSeek(target);
        if (now - (party.lastSyncMsg || 0) > 20000){
          party.lastSyncMsg = now;
          partyChatLine('', 'Синхронизация: ' + (drift > 15 ? 'перемотка' : 'выравнивание'), true);
        }
      }
      break;
    }

    case 'state_req':
      if (party.host){ party.lastPublish = 0; partySyncPublish(); }
      break;

    case 'ep': {
      if (party.host || !current) break;
      if (m.titleKey && current.key !== m.titleKey) break;
      const age = Math.max(0, (Date.now() - at) / 1000);
      const target = (m.t || 0) + Math.min(age, 30);
      partyAdoptEpisode(m.ep, target, m.translation);
      break;
    }

    case 'bye':
      partyChatLine('', (m.name || 'Кто-то') + ' вышел', true);
      break;
  }
}

function updatePeople(){
  const el = $('party-people');
  if (el) el.textContent = partyMembersText();
}

/* ============================================================
   СВЯЗАННЫЕ ТАЙТЛЫ
   ============================================================ */
const related = { key:'', items: [], chrono: [], req: 0, chronoReq: 0, cache: new Map() };

/* ============================================================
   ТОЧНЫЕ СВЯЗИ, ДЕТАЛИ, ПЕРВОИСТОЧНИК
   ============================================================ */

const SHIKI_WEB = 'https://shikimori.io';
const shikiCache = new Map();
const jikanCache = new Map();
const staffCache = new Map();

/* Запрос к Shikimori: через свой сервер, если он есть, иначе напрямую. */
function shikiGet(path){
  if (!shikiCache.has(path)){
    shikiCache.set(path, (async () => {
      let data = null;
      if (API_BASE) data = await backend('/api/shiki' + path).then(r => r && r.ok ? r.data : null).catch(() => null);
      if (!data) data = await getJSON(SHIKI_WEB + '/api' + path, 9000).catch(() => null);
      return data;
    })());
  }
  return shikiCache.get(path);
}

function jikanGet(path){
  if (!jikanCache.has(path)){
    jikanCache.set(path, (async () => {
      let data = null;
      if (API_BASE) data = await backend('/api/jikan' + path).then(r => r && r.ok ? r.data : null).catch(() => null);
      if (!data) data = await getJSON('https://api.jikan.moe/v4' + path, 9000).catch(() => null);
      return data;
    })());
  }
  return jikanCache.get(path);
}

const SHIKI_STATUS = { anons: 'Анонс', ongoing: 'Выходит', released: 'Вышел' };
const SHIKI_AGE = { g: '0+', pg: '6+', pg_13: '12+', r: '16+', r_plus: '18+', rx: '18+' };
const SHIKI_KIND = {
  tv: 'ТВ-сериал', movie: 'Фильм', ova: 'OVA', ona: 'ONA',
  special: 'Спешл', tv_special: 'Спешл', music: 'Клип'
};
const JIKAN_DAY = {
  mondays: 'по понедельникам', tuesdays: 'по вторникам', wednesdays: 'по средам',
  thursdays: 'по четвергам', fridays: 'по пятницам', saturdays: 'по субботам',
  sundays: 'по воскресеньям'
};
const MANGA_KIND = {
  manga: 'Манга', manhwa: 'Манхва', manhua: 'Маньхуа',
  light_novel: 'Ранобэ', novel: 'Роман', one_shot: 'Ваншот', doujin: 'Додзинси'
};

const REL_LABEL = {
  prequel: 'Предыстория', sequel: 'Продолжение', parent: 'Основная история',
  full_story: 'Полная история', side_story: 'Ответвление', spin_off: 'Спин-офф',
  alternative_setting: 'Альтернативная версия', alternative_version: 'Альтернативная версия',
  character: 'Кроссовер', summary: 'Краткое содержание', adaptation: 'Адаптация', other: 'Другое'
};
const REL_SORT = ['prequel','parent','full_story','sequel','side_story','spin_off',
  'alternative_setting','alternative_version','character','summary','other'];

function relKey(s){
  return String(s || '').toLowerCase().replace(/[\s-]+/g, '_');
}

function shikiImg(img){
  const p = img && (img.original || img.preview || img.x96);
  if (!p) return '';
  return p.startsWith('http') ? p : SHIKI_WEB + p;
}

function yearOf(a){
  if (!a) return '';
  if (a.aired_on) return String(a.aired_on).slice(0, 4);
  if (a.year) return String(a.year);
  return '';
}

function fmtNext(iso){
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try{
    return d.toLocaleString('ru-RU', { day:'numeric', month:'long', hour:'2-digit', minute:'2-digit' });
  }catch(e){
    return d.toLocaleDateString('ru-RU');
  }
}

function statusText(a){
  if (!a) return '';
  let s = SHIKI_STATUS[a.status] || a.status || '';
  if (a.status === 'ongoing' && a.episodes && a.episodes_aired != null){
    s += ' · ' + a.episodes_aired + ' из ' + a.episodes;
  }
  return s;
}

function broadcastText(b){
  if (!b) return '';
  const day = JIKAN_DAY[String(b.day || '').toLowerCase()] || '';
  const time = b.time ? 'в ' + b.time : '';
  const tz = /tokyo|jst/i.test(String(b.timezone || '') + ' ' + String(b.string || '')) ? 'по Японии' : '';
  return [day, time, tz].filter(Boolean).join(' ') || '';
}

/* Автор, режиссёр и день выхода серии: Jikan по MAL id из Shikimori.
   Если Jikan молчит — эти строки просто не показываются. */
function staffInfo(a){
  if (!a || !a.myanimelist_id) return Promise.resolve(null);
  const id = String(a.myanimelist_id);
  if (!staffCache.has(id)){
    staffCache.set(id, (async () => {
      const [st, full] = await Promise.all([
        jikanGet('/anime/' + id + '/staff'),
        jikanGet('/anime/' + id + '/full')
      ]);
      const staff = (st && st.data) || [];
      const people = p => (p && p.person && p.person.name) || '';
      const dir = staff.find(x => (x.positions || []).some(p => /^director$/i.test(p)));
      let author = staff.find(x => (x.positions || []).some(p => /original (creator|story|work)/i.test(p)));
      let authorName = author ? people(author) : '';

      if (!authorName && full && full.data){
        const rels = full.data.relations || [];
        const adapt = rels.find(r => /adaptation/i.test(r.relation || '') &&
          (r.entry || []).some(e => /manga|novel/i.test(e.type || '')));
        const entry = adapt && (adapt.entry || []).find(e => /manga|novel/i.test(e.type || ''));
        if (entry){
          const manga = await jikanGet('/manga/' + entry.mal_id);
          const names = ((manga && manga.data && manga.data.authors) || [])
            .map(x => x.name).filter(Boolean);
          if (names.length) authorName = names.slice(0, 2).join(', ');
        }
      }
      return {
        director: dir ? people(dir) : '',
        author: authorName,
        broadcast: broadcastText(full && full.data && full.data.broadcast)
      };
    })());
  }
  return staffCache.get(id);
}

function infoRow(k, v){
  const kd = document.createElement('div');
  kd.className = 'info-k';
  kd.textContent = k;
  const vd = document.createElement('div');
  vd.className = 'info-v';
  vd.textContent = v;
  return [kd, vd];
}

function renderInfo(it, data){
  const grid = $('p-info');
  if (!grid) return;
  const a = data && data.anime;
  const rows = [];

  if (a){
    rows.push(['Статус', statusText(a)]);
    rows.push(['Год', yearOf(a) || it.year]);
    const studio = (a.studios || []).map(s => s.name).filter(Boolean).join(', ');
    rows.push(['Студия', studio || it.studio]);
    const age = SHIKI_AGE[a.rating] || (it.minAge ? it.minAge + '+' : '') || it.mpaa;
    rows.push(['Возраст', age]);
    rows.push(['Серии', a.episodes
      ? a.episodes + (a.status === 'ongoing' && a.episodes_aired != null ? ' (вышло ' + a.episodes_aired + ')' : '')
      : (it.episodes ? it.episodes + ' эп.' : '')]);
    if (a.next_episode_at) rows.push(['Следующая серия', fmtNext(a.next_episode_at)]);
    if (data.broadcast) rows.push(['Расписание', data.broadcast]);
    if (data.director) rows.push(['Режиссёр', data.director]);
    if (data.author) rows.push(['Автор', data.author]);
  }else{
    if (it.year) rows.push(['Год', it.year]);
    if (it.studio) rows.push(['Студия', it.studio]);
    if (it.minAge) rows.push(['Возраст', it.minAge + '+']);
    if (it.episodes) rows.push(['Серии', it.episodes + ' эп.']);
  }

  grid.innerHTML = '';
  rows.filter(r => r[1]).forEach(([k, v]) => {
    const [kd, vd] = infoRow(k, v);
    grid.appendChild(kd);
    grid.appendChild(vd);
  });
  grid.classList.toggle('hidden', !grid.children.length);
}

async function loadInfo(it){
  const grid = $('p-info');
  if (grid){ grid.innerHTML = ''; grid.classList.add('hidden'); }
  if ($('p-origin-sec')) $('p-origin-sec').classList.add('hidden');
  if (!it) return;

  // данные Kodik показываем сразу, не дожидаясь внешних API
  renderInfo(it, null);
  loadAni(it);
  if (!it.sid) return;

  const a = await shikiGet('/animes/' + it.sid);
  if (current !== it) return;
  renderInfo(it, { anime: a });

  staffInfo(a).then(st => {
    if (current !== it || !st) return;
    renderInfo(it, { anime: a, director: st.director, author: st.author, broadcast: st.broadcast });
  }).catch(() => {});

  const rel = await shikiGet('/animes/' + it.sid + '/related');
  if (current !== it) return;
  renderOrigin(rel);
}

function renderOrigin(list){
  const sec = $('p-origin-sec'), box = $('p-origin');
  if (!sec || !box) return;
  box.innerHTML = '';

  // только явная адаптация: спин-офф мангу за первоисточник не выдаём
  const items = (list || []).filter(x => x && x.manga &&
    /adapt|адапт/i.test((x.relation || '') + ' ' + (x.relation_russian || '')));
  if (!items.length){ sec.classList.add('hidden'); return; }

  items.slice(0, 3).forEach(x => {
    const m = x.manga;
    const card = document.createElement('div');
    card.className = 'origin-card';

    const top = document.createElement('div');
    top.className = 'origin-top';
    const kind = document.createElement('span');
    kind.className = 'origin-kind';
    kind.textContent = MANGA_KIND[m.kind] || 'Манга';
    const main = document.createElement('div');
    main.className = 'origin-main';
    const b = document.createElement('b');
    b.textContent = m.russian || m.name || 'Первоисточник';
    const sub = document.createElement('div');
    sub.className = 'setting-sub';
    sub.textContent = [
      m.volumes ? m.volumes + ' т.' : '',
      m.chapters ? m.chapters + ' гл.' : '',
      m.status === 'released' ? 'завершён' : (m.status === 'ongoing' ? 'выходит' : '')
    ].filter(Boolean).join(' · ') || 'первоисточник';
    main.appendChild(b);
    main.appendChild(sub);
    top.appendChild(kind);
    top.appendChild(main);
    card.appendChild(top);

    const links = document.createElement('div');
    links.className = 'origin-links';
    if (m.id){
      const s = document.createElement('a');
      s.href = SHIKI_WEB + '/mangas/' + m.id;
      s.target = '_blank';
      s.rel = 'noopener';
      s.textContent = 'Shikimori ↗';
      links.appendChild(s);
    }
    const ml = document.createElement('a');
    ml.href = 'https://mangalib.me/ru/search?q=' + encodeURIComponent(m.russian || m.name || '');
    ml.target = '_blank';
    ml.rel = 'noopener';
    ml.textContent = 'MangaLib ↗';
    links.appendChild(ml);
    card.appendChild(links);

    box.appendChild(card);
  });
  sec.classList.remove('hidden');
}

/* Точные связи Shikimori: без поиска «похожих» названий. */
function buildRelated(list){
  return (list || [])
    .filter(x => x && x.anime)
    .map(x => {
      const a = x.anime;
      const key = relKey(x.relation);
      return {
        sid: a.id,
        title: a.russian || a.name || 'Без названия',
        poster: shikiImg(a.image),
        year: yearOf(a),
        kind: SHIKI_KIND[a.kind] || '',
        rel: key,
        label: x.relation_russian || REL_LABEL[key] || 'Связанное',
        item: null
      };
    })
    .sort((a, b) => {
      const ai = REL_SORT.indexOf(a.rel), bi = REL_SORT.indexOf(b.rel);
      return (ai < 0 ? 40 : ai) - (bi < 0 ? 40 : bi) ||
        (Number(a.year) || 9999) - (Number(b.year) || 9999);
    })
    .slice(0, 20);
}

/* Переход в связанный релиз строго по shikimori_id: если Kodik такого id не знает,
   ничего не подставляем «похожее». */
async function openExactRelated(rel){
  if (!rel) return;
  if (rel.item){ openPlayer(Object.assign({}, rel.item)); return; }
  if (!rel.sid) return;
  toast('Ищу «' + rel.title + '» в каталоге…', 1400);

  const bySid = async () => {
    const data = await api('search', {
      shikimori_id: String(rel.sid), with_material_data: 'true', limit: 20
    });
    return groupResults(data && data.results).find(x => String(x.sid) === String(rel.sid));
  };

  let g = await bySid();
  if (!g){
    const data = await api('search', { title: rel.title, limit: 50, with_material_data: 'true' });
    g = groupResults(data && data.results).find(x => String(x.sid) === String(rel.sid));
  }
  if (!g || !g.voices || !g.voices.length){
    toast('Этого релиза нет в каталоге Kodik');
    return;
  }
  openPlayer(g);
}

function relCard(it){
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'card rel-card';

  const poster = document.createElement('div');
  poster.className = 'poster';
  if (it.poster){
    const img = document.createElement('img');
    img.src = it.poster;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    if (it.posterAlt) img.dataset.alt = it.posterAlt;
    img.addEventListener('error', () => imgErr(img));
    poster.appendChild(img);
  }else{
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.textContent = '🎬';
    poster.appendChild(ph);
  }
  if (it.label){
    const badge = document.createElement('span');
    badge.className = 'rel-badge';
    badge.textContent = it.label;
    poster.appendChild(badge);
  }
  b.appendChild(poster);

  const t = document.createElement('div');
  t.className = 'ctitle';
  t.textContent = it.title;
  b.appendChild(t);

  b.addEventListener('click', () => openExactRelated(it));
  return b;
}

function renderRelated(){
  const sec = $('p-related-sec'), row = $('p-related');
  if (!sec || !row) return;
  row.innerHTML = '';
  if (!related.items.length){ sec.classList.add('hidden'); return; }
  const frag = document.createDocumentFragment();
  related.items.forEach(it => frag.appendChild(relCard(it)));
  row.appendChild(frag);
  sec.classList.remove('hidden');
}

function renderRelSkeleton(){
  const sec = $('p-related-sec'), row = $('p-related');
  if (!sec || !row) return;
  row.innerHTML = '';
  for (let i = 0; i < 5; i++){
    const d = document.createElement('div');
    d.className = 'rel-skel';
    d.innerHTML = '<div class="skel"></div><div class="skel skel-line"></div>';
    row.appendChild(d);
  }
  sec.classList.remove('hidden');
}

function hideRelated(){
  related.req++;
  related.chronoReq++;
  related.key = '';
  related.items = [];
  related.chrono = [];
  const sec = $('p-related-sec'), row = $('p-related');
  if (sec) sec.classList.add('hidden');
  if (row) row.innerHTML = '';
  const csec = $('p-chrono-sec'), crow = $('p-chrono');
  if (csec) csec.classList.add('hidden');
  if (crow) crow.innerHTML = '';
}

/* Хронология франшизы: цепочка sequel/prequel из /animes/{id}/franchise.
   Если у текущего тайтла нет продолжений/предысторий — блок скрывается. */
function buildChrono(data, sid){
  const nodes = (data && data.nodes) || [];
  const links = (data && data.links) || [];
  if (nodes.length < 2) return [];

  const byId = new Map(nodes.map(n => [String(n.id), n]));
  const next = new Map();   // раньше -> позже
  const prev = new Map();   // позже -> раньше
  links.forEach(l => {
    if (l.relation !== 'sequel' && l.relation !== 'prequel') return;
    const s = String(l.source_id), t = String(l.target_id);
    // sequel s->t: t после s; prequel s->t: t до s
    const [before, after] = l.relation === 'sequel' ? [s, t] : [t, s];
    next.set(before, after);
    prev.set(after, before);
  });
  if (!byId.has(String(sid))) return [];

  // идём назад к началу цепочки
  let root = String(sid);
  const seen = new Set();
  while (prev.has(root) && !seen.has(root)) { seen.add(root); root = prev.get(root); }

  // проходим вперёд
  const chain = [];
  const visited = new Set();
  let cur = root;
  while (cur && byId.has(cur) && !visited.has(cur)) {
    visited.add(cur);
    chain.push(byId.get(cur));
    cur = next.get(cur);
  }

  // текущий тайтл должен быть в цепочке, иначе хронологии нет
  if (!chain.some(n => String(n.id) === String(sid))) return [];

  return chain.map(n => ({
    sid: n.id,
    title: n.name || '',
    year: n.year || yearOf(n),
    cur: String(n.id) === String(sid)
  }));
}

function renderChrono(){
  const sec = $('p-chrono-sec'), box = $('p-chrono');
  if (!sec || !box) return;
  box.innerHTML = '';
  if (!related.chrono.length){ sec.classList.add('hidden'); return; }

  const frag = document.createDocumentFragment();
  related.chrono.forEach((c, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'chrono-item' + (c.cur ? ' cur' : '');
    row.disabled = !!c.cur;

    const num = document.createElement('span');
    num.className = 'chrono-num';
    num.textContent = String(i + 1);

    const body = document.createElement('span');
    body.className = 'chrono-body';
    body.textContent = c.title + (c.year ? ' · ' + c.year : '');

    row.appendChild(num);
    row.appendChild(body);
    if (c.cur){
      const tag = document.createElement('span');
      tag.className = 'chrono-now';
      tag.textContent = 'вы здесь';
      row.appendChild(tag);
    }else{
      row.addEventListener('click', () => openExactRelated({ sid: c.sid, title: c.title, item: null }));
    }
    frag.appendChild(row);
  });
  box.appendChild(frag);
  sec.classList.remove('hidden');
}

async function loadChrono(it){
  if (!it || !it.sid || !$('p-chrono')) return;
  const req = ++related.chronoReq;
  const data = await shikiGet('/animes/' + it.sid + '/franchise');
  if (req !== related.chronoReq) return;
  related.chrono = buildChrono(data, it.sid);
  renderChrono();
}

/* Только официальные связи Shikimori: без поиска «похожих» названий.
   Без shikimori_id блок не показываем вовсе. */
async function loadRelated(it){
  if (!it || !it.sid || !$('p-related')) return;
  const key = 'sid:' + it.sid;
  const req = ++related.req;
  related.key = key;
  related.items = [];

  const cached = related.cache.get(key);
  if (cached){
    related.items = cached;
    renderRelated();
    return;
  }

  renderRelSkeleton();
  const list = await shikiGet('/animes/' + it.sid + '/related');
  if (req !== related.req) return;

  related.items = buildRelated(list);
  if (related.items.length){
    related.cache.set(key, related.items);
    // кэш ограничиваем, чтобы не копить память
    if (related.cache.size > 60){
      const first = related.cache.keys().next();
      if (!first.done) related.cache.delete(first.value);
    }
    renderRelated();
  }else{
    const sec = $('p-related-sec');
    if (sec) sec.classList.add('hidden');
  }
}

/* ============================================================
   ШТОРКИ
   ============================================================ */
function openSheet(id){
  const el = $(id);
  if (!el) return;
  el.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  if (id === 'party-sheet') refreshPartyUI();
}
function closeSheet(id){
  const el = $(id);
  if (!el) return;
  el.classList.add('hidden');
  if (!$('player').classList.contains('open')) document.body.style.overflow = '';
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-close]');
  if (b) closeSheet(b.dataset.close);
});
document.querySelectorAll('.sheet').forEach(s => {
  s.addEventListener('click', e => { if (e.target === s) closeSheet(s.id); });
});

/* ============================================================
   НАСТРОЙКИ
   ============================================================ */
function applySettings(){
  document.body.classList.toggle('no-fx', !settings.fx);
  $('set-skip').classList.toggle('on', settings.skip);
  $('set-skip').setAttribute('aria-checked', String(settings.skip));
  $('set-fx').classList.toggle('on', settings.fx);
  $('set-fx').setAttribute('aria-checked', String(settings.fx));
  $('set-resume').classList.toggle('on', settings.resume);
  $('set-resume').setAttribute('aria-checked', String(settings.resume));
  $('set-skip-len').value = String(settings.skipLen);
}

/* ============================================================
   НАВИГАЦИЯ
   ============================================================ */
function setTab(name){
  const screens = { home: 'screen-home', search: 'screen-search', profile: 'screen-profile' };
  Object.entries(screens).forEach(([k, id]) => $(id).classList.toggle('hidden', k !== name));
  ['home', 'search', 'profile'].forEach(k => $('tab-' + k).classList.toggle('on', k === name));
  window.scrollTo(0, 0);
  if (name === 'search') setTimeout(() => $('search-input').focus(), 60);
  if (name === 'profile') renderProfile();
}

function pushPlayerState(){
  try{ history.pushState({ player: true }, ''); }catch(e){}
}

/* ============================================================
   СОБЫТИЯ
   ============================================================ */
document.querySelectorAll('.sec-chip').forEach(ch => {
  ch.onclick = () => {
    document.querySelectorAll('.sec-chip').forEach(c => c.classList.remove('on'));
    ch.classList.add('on');
    home.sec = ch.dataset.sec;
    window.scrollTo(0, 0);
    loadHome(true);
  };
});

$('tab-home').onclick = () => setTab('home');
$('tab-search').onclick = () => setTab('search');
$('tab-profile').onclick = () => setTab('profile');

$('btn-back').onclick = () => {
  if (history.state && history.state.player){
    history.back();
    setTimeout(() => { if ($('player').classList.contains('open')) closePlayer(); }, 400);
  }else{
    closePlayer();
  }
};

$('btn-refresh').onclick = () => {
  LS.del('c_' + home.sec + '|' + home.genre);
  toast('Обновляем…');
  loadHome(true);
};

$('btn-genres').onclick = () => openSheet('genre-sheet');
$('btn-party-home').onclick = () => openSheet('party-sheet');
$('btn-settings').onclick = () => openSheet('settings-sheet');

$('continue-clear').onclick = () => {
  watched = [];
  LS.set('hist', []);
  renderHistoryRow();
  renderProfile();
  toast('История очищена');
};

$('fav-clear').onclick = () => {
  favs = [];
  LS.set('fav', []);
  renderProfile();
  toast('Избранное очищено');
};

$('hist-clear').onclick = () => {
  watched = [];
  LS.set('hist', []);
  renderProfile();
  renderHistoryRow();
  toast('История очищена');
};

$('p-fav').onclick = () => {
  if (!current) return;
  const on = toggleFav(current);
  updateFavIcon(current);
  toast(on ? 'Добавлено в избранное' : 'Удалено из избранного');
};

$('p-status').onclick = () => { if (current) cycleList(current); };

if ($('p-src')){
  $('p-src').addEventListener('click', e => {
    const b = e.target.closest('button[data-src]');
    if (!b || b.disabled) return;
    setSource(b.dataset.src, false);
  });
}

$('p-party').onclick = () => openSheet('party-sheet');

$('p-retry').onclick = () => {
  if (!current) return;
  if (watching.src === 'ani'){
    playAni(watching.ep, watching.cur > 2 ? watching.cur : 0, true);
    return;
  }
  const voice = watching.voice || (current.voices && current.voices[0]);
  if (voice) play(voice, watching.ep);
};

$('p-full').onclick = () => {
  const el = $('p-wrap');
  if (!document.fullscreenElement){
    (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
  }else{
    document.exitFullscreen().catch(() => {});
  }
};

$('p-skip').onclick = () => {
  skipDone = true;
  skipArmed = false;
  const opening = (watching.src === 'ani' && watching.aniEp && Array.isArray(watching.aniEp.opening))
    ? watching.aniEp.opening : null;
  playerSeek(opening ? opening[1] + 1 : settings.skipLen + 2);
  $('p-skip').classList.add('hidden');
  stats.flags.skip = 1;
  saveStats();
  toast('Опенинг пропущен ⏭');
};

$('p-restart').onclick = () => {
  watching.resumeDone = true;
  hideResumeRow();
  playerSeek(0);
  toast('С начала');
};

$('p-desc-toggle').onclick = () => {
  const d = $('p-desc');
  const clamped = d.classList.toggle('clamp');
  $('p-desc-toggle').textContent = clamped ? 'Читать полностью' : 'Свернуть';
};

/* --- поиск --- */
const searchInput = $('search-input');
let searchTimer = null;
searchInput.addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  $('search-clear').classList.toggle('hidden', !q);
  if (!q){ resetSearch(); return; }
  if (q.length < 2){ setSearchStatus('Введите хотя бы 2 символа'); return; }
  searchTimer = setTimeout(() => doSearch(q), 260);
});
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter'){
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length >= 2){ searchInput.blur(); doSearch(q); }
  }
});
$('search-clear').onclick = () => {
  searchInput.value = '';
  $('search-clear').classList.add('hidden');
  resetSearch();
  searchInput.focus();
};

/* --- голосовой поиск --- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

if (SR){
  $('btn-mic').classList.remove('hidden');
  $('btn-mic').onclick = () => {
    if (recognition){
      try{ recognition.stop(); }catch(e){}
      recognition = null;
      $('btn-mic').classList.remove('rec');
      return;
    }
    try{
      recognition = new SR();
    }catch(e){ toast('Голосовой поиск недоступен'); return; }

    recognition.lang = 'ru-RU';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = ev => {
      const text = (ev.results[0] && ev.results[0][0] ? ev.results[0][0].transcript : '').trim();
      if (!text) return;
      searchInput.value = text;
      $('search-clear').classList.remove('hidden');
      doSearch(text);
      toast('«' + text + '»');
    };
    recognition.onerror = ev => {
      const map = {
        'not-allowed': 'Разрешите доступ к микрофону',
        'no-speech': 'Не услышал — попробуйте ещё раз',
        'audio-capture': 'Микрофон не найден',
        'network': 'Нет связи с сервисом распознавания'
      };
      toast(map[ev.error] || 'Ошибка распознавания');
    };
    recognition.onend = () => {
      recognition = null;
      $('btn-mic').classList.remove('rec');
    };

    try{
      recognition.start();
      $('btn-mic').classList.add('rec');
      toast('Говорите…');
    }catch(e){
      recognition = null;
      toast('Не удалось запустить микрофон');
    }
  };
}

/* --- профиль --- */
document.querySelectorAll('#list-tabs .ltab').forEach(b => {
  b.onclick = () => { profileList = b.dataset.list; renderList(); };
});

$('btn-edit-name').onclick = () => {
  const name = prompt('Ваше имя', me.name || '');
  if (name == null) return;
  me.name = name.trim().slice(0, 24) || 'Гость';
  LS.set('me', me);
  renderProfile();
  toast('Имя обновлено');
};

$('btn-import').onclick = () => $('import-file').click();
$('btn-import-2').onclick = () => $('import-file').click();
$('import-file').onchange = e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) importListFile(f);
};
$('btn-export').onclick = exportData;
$('btn-reset').onclick = resetAll;

/* --- свой сервер --- */
$('btn-api-save').onclick = () => {
  const url = normalizeApiUrl($('api-url').value);
  if (!/^https?:\/\/[^/\s]+$/i.test(url)){
    toast('Адрес вида https://api.домен или localhost:8080');
    return;
  }
  localStorage.setItem('anime_api', url);
  toast('Сервер: ' + url + ' — перезагружаю…', 1500);
  setTimeout(() => location.reload(), 700);
};
$('btn-api-clear').onclick = () => {
  if (!apiAddress()){ toast('Сервер и так отключён'); return; }
  localStorage.setItem('anime_api', 'off');   // перекрывает и DEFAULT_API тоже
  toast('Сервер отключён, перезагружаю…', 1200);
  setTimeout(() => location.reload(), 700);
};
$('api-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-api-save').click();
});

/* --- списки онлайн --- */
$('btn-auth-sync').onclick = () => syncLists(false);
$('btn-auth-out').onclick = async () => {
  if (sync.sid) await backend('/api/auth/logout?sid=' + encodeURIComponent(sync.sid), { method: 'POST' });
  authForget();
  toast('Вы вышли, списки остались');
};

/* --- перенос профиля --- */
$('btn-cloud-save').onclick = cloudSave;
$('btn-cloud-open').onclick = () => {
  const row = $('cloud-row');
  row.classList.toggle('hidden');
  if (!row.classList.contains('hidden')) $('cloud-code').focus();
};
$('btn-cloud-load').onclick = cloudLoad;
$('cloud-code').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
});
$('cloud-code').addEventListener('keydown', e => {
  if (e.key === 'Enter') cloudLoad();
});

/* --- настройки --- */
function bindSwitch(id, key, after){
  $(id).onclick = () => {
    settings[key] = !settings[key];
    saveSettings();
    applySettings();
    if (after) after();
  };
}
bindSwitch('set-skip', 'skip');
bindSwitch('set-fx', 'fx');
bindSwitch('set-resume', 'resume');
$('set-skip-len').onchange = e => {
  settings.skipLen = parseInt(e.target.value, 10) || 90;
  saveSettings();
};
$('settings-version').textContent = 'Версия ' + VERSION;

/* --- watch party --- */
$('party-nick').value = LS.get('partyName', '') || '';
$('party-create').onclick = () => {
  const name = ($('party-nick').value || '').trim();
  if (name){ me.name = name; LS.set('me', me); }
  partyJoin(makeRoomCode(), true);
};
$('party-join-toggle').onclick = () => $('party-join-box').classList.toggle('hidden');
$('party-join').onclick = () => {
  const name = ($('party-nick').value || '').trim();
  if (name){ me.name = name; LS.set('me', me); }
  partyJoin($('party-code-input').value, false);
};
$('party-code-input').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
});
$('party-copy').onclick = async () => {
  const url = location.origin + location.pathname + '?party=' + party.code;
  try{
    await navigator.clipboard.writeText(url);
    toast('Ссылка скопирована');
  }catch(e){
    toast(url, 5000);
  }
};
$('party-send').onclick = () => {
  const inp = $('party-msg');
  const text = inp.value.trim();
  if (!text) return;
  partyPublish({ k: 'chat', text: text.slice(0, 300) });
  partyChatLine(party.name, text);
  inp.value = '';
};
$('party-msg').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('party-send').click();
});
$('party-sync').onclick = () => {
  if (party.host) { party.lastPublish = 0; partySyncPublish(); toast('Сигнал отправлен'); }
  else { askPartyState(); toast('Догоняю хоста…'); }
};
$('party-leave').onclick = () => partyLeave(false);

/* --- скролл --- */
window.addEventListener('scroll', () => {
  if ($('player').classList.contains('open')) return;
  if (window.innerHeight + window.scrollY < document.body.offsetHeight - 700) return;
  if (!$('screen-home').classList.contains('hidden')) loadHomeMore();
  else if (!$('screen-search').classList.contains('hidden')) loadSearchMore();
}, { passive: true });

/* Колесо мыши над горизонтальной лентой листает её по горизонтали —
   иначе на ПК серии/связанные/подборки колесом не прокрутить. */
document.addEventListener('wheel', e => {
  const t = e.target;
  if (!t || !t.closest) return;
  const el = t.closest('.ep-strip, .relrow, .hrow, .chips, .list-tabs');
  if (!el) return;
  if (el.scrollWidth <= el.clientWidth + 1) return;   // некуда листать
  const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (Math.abs(delta) < 1) return;
  el.scrollLeft += delta;
  e.preventDefault();
}, { passive: false });

window.addEventListener('online', () => toast('Соединение восстановлено'));
window.addEventListener('offline', () => toast('Нет соединения — показан кеш'));

document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveStats();
});

window.addEventListener('popstate', () => {
  if ($('player').classList.contains('open')) closePlayer();
});

window.addEventListener('beforeunload', () => {
  if (statsDirty) saveStats();
  if (current && watching.cur > 5){
    progress[current.key] = { t: watching.cur, d: watching.dur || 0, ep: watching.ep, ts: Date.now() };
    LS.set('pos', progress);
  }
});

/* ============================================================
   СТАРТ
   ============================================================ */
(function init(){
  if (!TOKENS.length){
    $('home-empty').classList.remove('hidden');
    $('home-empty').innerHTML = '<span class="big">🔑</span>Не удалось инициализировать доступ к каталогу';
    return;
  }

  DB.load();
  DB.seed();
  applySettings();
  buildGenrePanel();
  setTab('home');
  renderHistoryRow();
  renderProfile();
  initAuth();
  renderApi();
  loadHome(true);

  // ?party=CODE
  const p = new URLSearchParams(location.search).get('party');
  if (p){
    setTimeout(() => {
      $('party-code-input').value = p.toUpperCase();
      $('party-nick').value = LS.get('partyName', '') || me.name || '';
      openSheet('party-sheet');
      $('party-join-box').classList.remove('hidden');
    }, 500);
  }

  idle(() => {
    ['ongoing', 'top'].forEach(async sec => {
      if (cacheGet(sec + '|')) return;
      const chunk = await fetchListChunk(sec, '', null, 2, 16);
      if (chunk && chunk.items.length) cacheSet(sec + '|', chunk.items, chunk.next);
    });
  });
})();

function idle(fn){
  if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 3000 });
  else setTimeout(fn, 1200);
}