/* ============================================================================
   원료육 입출고 ERP · Supabase 연동 웹앱
   ----------------------------------------------------------------------------
   이 파일은 세 부분으로 나뉩니다.
     CORE : 순수 계산(재고 합계·정렬·CSV). 화면/DOM/네트워크를 건드리지 않는다.
     API  : Supabase Auth(로그인) + PostgREST(조회) + RPC(저장/취소) + 실시간
     UI   : 화면 그리기와 입력 처리
   재고 계산과 검증은 Supabase의 tx_apply / tx_undo 함수가 한 트랜잭션에서
   처리합니다(POST /rest/v1/rpc/tx_apply). 그래서 PC와 폰에서 동시에 눌러도
   재고가 어긋나지 않습니다.
   ============================================================================ */

/* ============================== CONFIG ============================== */
var CONFIG = {
  SUPABASE_URL: 'https://wwirbwbppwvvhdllreyu.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3aXJid2JwcHd2dmhkbGxyZXl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUwNjAyNTIsImV4cCI6MjExMDYzNjI1Mn0.LQXPYRnAUdLetlsKwrUxpjk58_Y1ea5UluvVVloMqpU',
  /* 실시간(웹소켓)이 막히면 이 주기로 다시 불러옵니다 */
  POLL_MS: 60000
};

/* ============================== CORE:START ============================== */
var ERP = (function () {
  'use strict';
  var EPS = 0.004;

  function r2(x) {
    var v = Math.round(Number(x) * 100) / 100;
    return v === 0 ? 0 : v;
  }
  function r0(x) { return Math.round(Number(x) || 0); }
  function nz(x) { return x === undefined || x === null ? '' : String(x); }
  function s(x) { return nz(x).replace(/^\s+|\s+$/g, ''); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------- 대분류 / 소분류 ---------- */
  /* v5: 원료육 ERP에서는 대분류를 화면·표·폼·CSV 어디에도 보이지 않는다.
     DB(lots.major_category)에는 예전 값 호환을 위해 '원료육'만 조용히 유지한다. */
  var MAJORS = ['원료육', '완제품(자체생산)', '완제품(매입)', '야채/농산물', '부자재', '소스/양념', '기타'];
  var MAJOR_DEFAULT = '원료육';
  function majorName(v) { var t = s(v); return t || MAJOR_DEFAULT; }

  /* 옛 표기(돈/우/계/양)는 새 표기로 읽는다 (DB 마이그레이션 전 데이터도 안전하게) */
  var MEAT_OLD = { '돈': '돈육', '우': '우육', '계': '계육', '양': '양육' };
  var MEATS = ['돈육', '우육', '계육', '양육'];
  function meatName(v) {
    var t = s(v);
    return MEAT_OLD[t] || t;
  }

  /* 출고처 구분: 현장 / 업체 / 택배 / 기타 */
  var DEST_KEYS = ['site', 'vendor', 'courier', 'other'];
  var DEST_NAME = { site: '현장', vendor: '업체', courier: '택배', other: '기타' };
  var DEST_LABEL = { site: '생산품목', vendor: '업체명 (비고)', courier: '수령처·내역 (비고)', other: '사유 (비고)' };
  var DEST_HINT = {
    site: '현장(생산품목)으로 나간 물량입니다. 적은 생산품목이 입출고 내역의 생산품목 칸에 들어갑니다.',
    vendor: '업체로 판매·이동한 출고입니다. 구분은 [출고]로 기록되고, 업체명은 비고 칸에 적힙니다.',
    courier: '택배로 보낸 출고입니다. 구분은 [택배], 받는 곳·운송장은 비고 칸에 적힙니다.',
    other: '현장·업체·택배 밖의 출고입니다. 구분은 [기타], 사유는 비고 칸에 적힙니다.'
  };
  function destKey(v) {
    v = s(v);
    return Object.prototype.hasOwnProperty.call(DEST_NAME, v) ? v : 'site';
  }
  function destName(v) { return DEST_NAME[destKey(v)]; }

  function typeName(t) {
    return t === 'in' ? '입고' : (t === 'thaw' ? '해동' : (t === 're' ? '재냉동' : (t === 'base' ? '기초재고' : '출고')));
  }
  /* 입출고 내역의 구분은 6가지: 입고 · 출고(업체) · 해동 · 현장 · 택배 · 기타
     (재냉동은 되돌리는 내부 이동이라 '기타'로 묶고, 사유는 비고에 적는다) */
  var KIND_NAME = { in: '입고', vendor: '출고', thaw: '해동', site: '현장', courier: '택배', other: '기타' };
  var KIND_KEYS = ['in', 'vendor', 'thaw', 'site', 'courier', 'other'];
  function kindKey(e) {
    if (!e) return 'other';
    if (e.t === 'in') return 'in';
    if (e.t === 'thaw') return 'thaw';
    if (e.t === 'out') return destKey(e.dt);
    return 'other';
  }
  function kindName(e) { return KIND_NAME[kindKey(e)] || '기타'; }
  /* 생산품목 칸: 현장 출고의 생산품목, 해동의 생산품명만 적는다.
     업체·택배·기타 출고의 업체명·수령처·사유는 비고 칸으로 간다. */
  function prodOf(e) {
    if (!e) return '';
    if (e.t === 'thaw') return e.p || '';
    if (e.t === 'out' && destKey(e.dt) === 'site') return e.p || '';
    return '';
  }
  function noteOf(e) {
    if (!e) return '';
    var parts = [];
    if (e.t === 'out' && destKey(e.dt) !== 'site' && e.p) parts.push(e.p);
    if (e.note) parts.push(e.note);
    return parts.join(' · ').replace(/\s+/g, ' ');
  }
  function whName(w) { return w === 'C' ? '냉장고' : '냉동고'; }
  /* 창고 열: 이동은 어디서 → 어디로, 그 밖엔 재고가 있는 창고 */
  function moveName(e) {
    if (e.t === 'thaw') return '냉동고→냉장고';
    if (e.t === 're') return '냉장고→냉동고';
    return whName(e.w);
  }

  /* ---------- DB 행 → 화면용 상태 ---------- */
  /* 이력의 브랜드: 이력 행에 brand 값이 있으면 그것, 없으면 그 이력이 가리키는 로트의 브랜드.
     (tx_logs에는 브랜드 열이 없고, 브랜드는 로트(lots.brand)에만 있다) */
  function lotKey(n, v, i, e) {
    return [nz(n), nz(v), nz(i), nz(e)].join('\u0001');
  }
  function stateFrom(lotsRows, logRows) {
    var lots = [], logs = [], i, r;
    lotsRows = lotsRows || [];
    logRows = logRows || [];
    for (i = 0; i < lotsRows.length; i++) {
      r = lotsRows[i];
      lots.push({
        id: 'L' + r.id, dbid: Number(r.id), n: nz(r.product_name),
        major: majorName(r.major_category), mt: meatName(r.meat_type),
        o: nz(r.origin), v: nz(r.vendor), b: nz(r.brand),
        i: nz(r.in_date), e: nz(r.exp_date),
        fq: r2(r.frozen_qty), cq: r2(r.chilled_qty),
        price: r2(r.unit_price), up: nz(r.updated_at)
      });
    }
    /* 로트 id·로트 키 → 브랜드 (이력은 lot_id 또는 제품명·업체명·입고일·소비기한으로 로트를 찾는다) */
    var brandById = {}, brandByKey = {};
    for (i = 0; i < lots.length; i++) {
      var L = lots[i];
      if (!L.b) continue;
      if (brandById[L.dbid] === undefined) brandById[L.dbid] = L.b;
      var lk = lotKey(L.n, L.v, L.i, L.e);
      if (brandByKey[lk] === undefined) brandByKey[lk] = L.b;
    }
    for (i = 0; i < logRows.length; i++) {
      r = logRows[i];
      var pr = r2(r.unit_price);
      var lid2 = r.lot_id === null || r.lot_id === undefined ? '' : String(r.lot_id);
      var lbr = lid2 !== '' ? brandById[Number(lid2)] : undefined;
      if (!lbr) lbr = brandByKey[lotKey(r.product_name, r.vendor, r.in_date, r.exp_date)];
      var brand = nz(r.brand) || lbr || '';
      var lt = nz(r.tx_type) || 'out';
      var dtt = nz(r.dest_type);
      logs.push({
        id: 'H' + r.id, dbid: Number(r.id), d: nz(r.tx_date), w: nz(r.warehouse) || 'F',
        t: lt, n: nz(r.product_name),
        major: majorName(r.major_category), mt: meatName(r.meat_type),
        v: nz(r.vendor), b: brand, i: nz(r.in_date), e: nz(r.exp_date), k: r2(r.qty),
        price: pr, amt: r2(r.total_amount),
        p: nz(r.dest_detail), dt: dtt, note: nz(r.note),
        lid: lid2,
        worker: nz(r.worker_name), email: nz(r.worker_email),
        act: r.is_manual !== false, at: nz(r.created_at)
      });
    }
    return { lots: lots, logs: logs, loadedAt: Date.now() };
  }

  function lotValue(l) { return r0((l.fq + l.cq) * l.price); }

  function totals(st) {
    var f = 0, c = 0, lf = 0, lc = 0, live = 0, mine = 0, value = 0, i;
    for (i = 0; i < st.lots.length; i++) {
      var l = st.lots[i];
      f += l.fq; c += l.cq;
      value += (l.fq + l.cq) * l.price;
      if (l.fq > EPS) lf++;
      if (l.cq > EPS) lc++;
      if (l.fq > EPS || l.cq > EPS) live++;
    }
    for (i = 0; i < st.logs.length; i++) if (st.logs[i].act) mine++;
    return { frozen: r2(f), chilled: r2(c), liveFrozen: lf, liveChilled: lc, live: live, manual: mine, value: r0(value) };
  }

  function getLot(st, id) {
    for (var i = 0; i < st.lots.length; i++) if (st.lots[i].id === id) return st.lots[i];
    return null;
  }
  function getLog(st, id) {
    for (var i = 0; i < st.logs.length; i++) if (st.logs[i].dbid === Number(id)) return st.logs[i];
    return null;
  }
  function qtyOf(lot, wh) { return wh === 'F' ? lot.fq : lot.cq; }

  function sortLots(a, b) {
    var an = a.e || '9999-99-99', bn = b.e || '9999-99-99';
    if (an !== bn) return an < bn ? -1 : 1;
    var ai = a.i || '9999-99-99', bi = b.i || '9999-99-99';
    if (ai !== bi) return ai < bi ? -1 : 1;
    return a.v < b.v ? -1 : (a.v > b.v ? 1 : 0);
  }

  /* ---------- 표 컬럼 정의 (머리글 · 정렬 · 필터가 모두 여기서 나온다) ---------- */
  var LOT_COLS = [
    { k: 'mt', t: '육류', w: 96 },
    { k: 'n', t: '제품명', w: 156 },
    { k: 'o', t: '원산지', w: 90 },
    { k: 'v', t: '업체명', w: 104 },
    { k: 'b', t: '브랜드', w: 84 },
    { k: 'i', t: '입고일', w: 96 },
    { k: 'e', t: '소비기한', w: 104 },
    { k: 'qty', t: '재고(kg)', w: 104, num: true },
    { k: 'price', t: '입고단가(원/kg)', w: 112, num: true },
    { k: 'amt', t: '재고금액(원)', w: 112, num: true }
  ];
  var LOG_COLS = [
    { k: 'd', t: '날짜', w: 92 },
    { k: 't', t: '구분', w: 74 },
    { k: 'n', t: '제품명', w: 142 },
    { k: 'v', t: '업체명', w: 100 },
    { k: 'b', t: '브랜드', w: 80 },
    { k: 'i', t: '입고일', w: 92 },
    { k: 'e', t: '소비기한', w: 100 },
    { k: 'k', t: '중량(kg)', w: 80, num: true },
    { k: 'inp', t: '입고단가(원/kg)', w: 96, num: true },
    { k: 'outp', t: '출고단가(원/kg)', w: 96, num: true },
    { k: 'amt', t: '금액(원)', w: 108, num: true },
    { k: 'prod', t: '생산품목', w: 128 },
    { k: 'note', t: '비고', w: 158 },
    { k: 'worker', t: '작업자', w: 78 }
  ];
  function lotCols(wh) {
    var out = [], i, c;
    for (i = 0; i < LOT_COLS.length; i++) {
      c = LOT_COLS[i];
      out.push({ k: c.k, t: c.k === 'qty' ? (wh === 'F' ? '냉동고 재고(kg)' : '냉장고 재고(kg)') : c.t,
        w: c.w, num: !!c.num });
    }
    return out;
  }
  function colDef(list, k) {
    for (var i = 0; i < list.length; i++) if (list[i].k === k) return list[i];
    return null;
  }

  /* 셀에 들어가는 값 (정렬·필터·표시가 같은 값을 쓴다) */
  function lotCell(l, k, wh) {
    if (k === 'mt') return l.mt;
    if (k === 'n') return l.n;
    if (k === 'o') return l.o;
    if (k === 'v') return l.v;
    if (k === 'b') return l.b;
    if (k === 'i') return l.i;
    if (k === 'e') return l.e;
    if (k === 'qty') return qtyOf(l, wh);
    if (k === 'price') return l.price;
    if (k === 'amt') return r0(qtyOf(l, wh) * l.price);
    return '';
  }
  function logCell(e, k) {
    if (k === 'd') return e.d;
    if (k === 't') return kindName(e);
    if (k === 'n') return e.n;
    if (k === 'v') return e.v;
    if (k === 'b') return e.b;
    if (k === 'i') return e.i;
    if (k === 'e') return e.e;
    if (k === 'k') return e.k;
    /* 입고단가·출고단가를 나눠 둔다: 입고 건은 입고단가만, 출고 건은 출고단가만, 해동·재냉동은 둘 다 비운다 */
    if (k === 'inp') return e.t === 'in' ? e.price : '';
    if (k === 'outp') return e.t === 'out' ? e.price : '';
    if (k === 'amt') return e.amt;
    if (k === 'prod') return prodOf(e);
    if (k === 'note') return noteOf(e);
    if (k === 'worker') return e.worker;
    return '';
  }
  /* 필터에 쓰는 값 키 (빈 값은 '-') */
  function cellKey(v) {
    var t = s(v);
    return t === '' ? '-' : t;
  }

  function cmpVal(a, b, numeric) {
    if (numeric) return (Number(a) || 0) - (Number(b) || 0);
    return String(a).localeCompare(String(b), 'ko');
  }

  /* 컬럼 필터: cols = { 컬럼키: [허용값...] }, 비었으면 통과 */
  function passCols(cols, getter) {
    if (!cols) return true;
    for (var k in cols) {
      if (!Object.prototype.hasOwnProperty.call(cols, k)) continue;
      var allow = cols[k];
      if (!allow || !allow.length) continue;
      var v = cellKey(getter(k));
      var hit = false;
      for (var i = 0; i < allow.length; i++) if (String(allow[i]) === v) { hit = true; break; }
      if (!hit) return false;
    }
    return true;
  }

  /* 컬럼에 실제로 나오는 값 목록 (필터 체크박스) */
  function uniqValues(rows, k, cell) {
    var out = [], seen = {}, i, v;
    for (i = 0; i < rows.length; i++) {
      v = cellKey(cell(rows[i], k));
      if (seen[v]) continue;
      seen[v] = 1;
      out.push(v);
    }
    out.sort(function (a, b) {
      var na = /^-?[\d.]+$/.test(a), nb = /^-?[\d.]+$/.test(b);
      if (na && nb) return Number(a) - Number(b);
      return a.localeCompare(b, 'ko');
    });
    return out;
  }

  /* ---------- 기간 ---------- */
  function dateAdd(dstr, days) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s(dstr));
    if (!m) return '';
    var t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    t.setUTCDate(t.getUTCDate() + Number(days || 0));
    return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
  }
  function inRange(d, from, to) {
    var v = s(d);
    if (!s(from) && !s(to)) return true;
    if (!v) return false;
    if (s(from) && v < s(from)) return false;
    if (s(to) && v > s(to)) return false;
    return true;
  }
  /* 오늘 / 이번주(월~일) / 이번달 / 유통임박(30일) */
  function presetRange(key, todayStr) {
    var t = s(todayStr);
    if (key === 'today') return { from: t, to: t };
    if (key === 'week') {
      var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
      if (!m) return { from: '', to: '' };
      var dow = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
      var back = (dow + 6) % 7;
      return { from: dateAdd(t, -back), to: dateAdd(t, 6 - back) };
    }
    if (key === 'month') return monthRange(t);
    if (key === 'soon') return { from: t, to: dateAdd(t, 30) };
    return { from: '', to: '' };
  }
  function monthRange(todayStr) {
    var t = s(todayStr);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return { from: '', to: '' };
    var first = t.slice(0, 8) + '01';
    var next = dateAdd(first, 32).slice(0, 8) + '01';
    return { from: first, to: dateAdd(next, -1) };
  }
  function rangeOf(key, todayStr) {
    if (key === 'month') return monthRange(todayStr);
    return presetRange(key, todayStr);
  }

  /* ---------- 기간 선택 달력 도우미 (2개월 팝업) ---------- */
  function ymd(y, m, d) {
    return String(y) + '-' + pad2(Number(m)) + '-' + pad2(Number(d));
  }
  function ymOf(dstr) {
    var m = /^(\d{4})-(\d{1,2})/.exec(s(dstr) || '');
    return m ? { y: Number(m[1]), m: Number(m[2]) } : { y: 0, m: 0 };
  }
  function lastDay(y, m) {
    return new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
  }
  function monthRangeOf(y, m) {
    return { from: ymd(y, m, 1), to: ymd(y, m, lastDay(y, m)) };
  }
  function fmtKorDate(dstr) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s(dstr));
    if (!m) return '-';
    return m[1] + '년 ' + Number(m[2]) + '월 ' + Number(m[3]) + '일';
  }
  function fmtKorMonth(y, m) { return Number(y) + '년 ' + Number(m) + '월'; }
  var WEEK_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

  /* 달력 한 달치: 7일×여러 주. inMonth=false 는 앞·뒤 달 날짜 */
  function monthMatrix(y, m) {
    y = Number(y); m = Number(m);
    if (!(m >= 1 && m <= 12)) return [];
    var first = new Date(Date.UTC(y, m - 1, 1));
    var startDow = first.getUTCDay();
    var start = Date.UTC(y, m - 1, 1 - startDow);
    var weeks = [], w = [], i, d, dm, dy;
    for (i = 0; i < 42; i++) {
      d = new Date(start + i * 86400000);
      dy = d.getUTCFullYear(); dm = d.getUTCMonth() + 1;
      w.push({ d: ymd(dy, dm, d.getUTCDate()), day: d.getUTCDate(), y: dy, m: dm,
        inMonth: dm === m && dy === y, dow: d.getUTCDay() });
      if (w.length === 7) { weeks.push(w); w = []; }
    }
    while (weeks.length > 4) {
      var last = weeks[weeks.length - 1], any = false;
      for (i = 0; i < last.length; i++) if (last[i].inMonth) any = true;
      if (any) break;
      weeks.pop();
    }
    return weeks;
  }

  /* 기간 선택 팝업의 빠른 버튼 (그림과 같은 3줄) */
  var PERIOD_QUICK = [
    [['today', '오늘'], ['yesterday', '전일'], ['week', '주간'], ['prevweek', '전주'],
      ['month', '당월'], ['prevmonth', '전월'], ['year', '올해']],
    [['h1', '상반기'], ['h2', '하반기'], ['q1', '1/4분기'], ['q2', '2/4분기'],
      ['q3', '3/4분기'], ['q4', '4/4분기'], ['uptoday', '오늘까지']],
    [['m1', '1월'], ['m2', '2월'], ['m3', '3월'], ['m4', '4월'], ['m5', '5월'], ['m6', '6월'],
      ['m7', '7월'], ['m8', '8월'], ['m9', '9월'], ['m10', '10월'], ['m11', '11월'], ['m12', '12월']]
  ];

  /* key → { from, to }  (baseYear 는 팝업의 기준연도)
     today: 오늘 · yesterday: 전일 · week/prevweek: 주간/전주(월~일)
     month/prevmonth: 당월/전월 · year/h1/h2/q1~q4/uptoday: 기준연도 기준
     m1~m12: 기준연도의 그 달 */
  function periodRange(key, todayStr, baseYear) {
    var t = s(todayStr);
    var y = Number(baseYear) || Number(t.slice(0, 4)) || 2026;
    if (key === 'today') return { from: t, to: t };
    if (key === 'yesterday') { var yd = dateAdd(t, -1); return { from: yd, to: yd }; }
    if (key === 'week') return presetRange('week', t);
    if (key === 'prevweek') return presetRange('week', dateAdd(t, -7));
    if (key === 'month') return monthRange(t);
    if (key === 'prevmonth') return monthRange(dateAdd(monthRange(t).from, -1));
    if (key === 'year') return { from: ymd(y, 1, 1), to: ymd(y, 12, 31) };
    if (key === 'h1') return { from: ymd(y, 1, 1), to: ymd(y, 6, 30) };
    if (key === 'h2') return { from: ymd(y, 7, 1), to: ymd(y, 12, 31) };
    if (/^q[1-4]$/.test(key)) {
      var q = Number(key.slice(1));
      return { from: ymd(y, (q - 1) * 3 + 1, 1), to: ymd(y, q * 3, lastDay(y, q * 3)) };
    }
    if (key === 'uptoday') {
      var sameYear = t && t.slice(0, 4) === String(y);
      return { from: ymd(y, 1, 1), to: sameYear ? t : ymd(y, 12, 31) };
    }
    if (/^m(1[0-2]|[1-9])$/.test(key)) {
      var mm = Number(key.slice(1));
      return monthRangeOf(y, mm);
    }
    return { from: '', to: '' };
  }
  /* 그 기간이 어떤 빠른 버튼과 같은지 (팝업에서 선택 표시) */
  function periodKeyOf(from, to, todayStr, baseYear) {
    var all = [], i, j;
    for (i = 0; i < PERIOD_QUICK.length; i++) for (j = 0; j < PERIOD_QUICK[i].length; j++) all.push(PERIOD_QUICK[i][j][0]);
    for (i = 0; i < all.length; i++) {
      var r = periodRange(all[i], todayStr, baseYear);
      if (r.from === s(from) && r.to === s(to)) return all[i];
    }
    return '';
  }

  /* ---------- 재고 묶음 ---------- */
  /* opt: { major, dateField:'in'|'exp', from, to, cols, sortKey, sortDir } */
  function filterLots(st, wh, q, showZero, opt) {
    opt = opt || {};
    var rows = [], i, l, qq = s(q).toLowerCase();
    for (i = 0; i < st.lots.length; i++) {
      l = st.lots[i];
      if (!showZero && qtyOf(l, wh) <= EPS) continue;
      var base = opt.dateField === 'exp' ? l.e : l.i;
      if (!inRange(base, opt.from, opt.to)) continue;
      if (qq) {
        /* v7: 파텔 ↔ PATEL 처럼 한↔영 브랜드를 서로 찾는다 */
        if (!textHit([l.n, l.v, l.o, l.i, l.b, l.e, l.mt].join(' '), q)) continue;
      }
      if (!passCols(opt.cols, function (k) { return lotCell(l, k, wh); })) continue;
      rows.push(l);
    }
    return rows;
  }

  /* 제품명 묶음 + 정렬. wh 재고가 0인 로트는 showZero 일 때만. */
  function grouped(st, wh, q, showZero, opt) {
    opt = opt || {};
    var rows = filterLots(st, wh, q, showZero, opt);
    var i, j, groups = {}, order = [], out = [];
    for (i = 0; i < rows.length; i++) {
      var k = rows[i].n;
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(rows[i]);
    }
    order.sort(function (a, b) { return a.localeCompare(b, 'ko'); });
    if (opt.sortKey === 'n' && opt.sortDir === -1) order.reverse();

    var sk = opt.sortKey, sd = opt.sortDir === -1 ? -1 : 1;
    var def = sk && colDef(LOT_COLS, sk);
    for (i = 0; i < order.length; i++) {
      var list = groups[order[i]];
      if (sk && sk !== 'n') {
        list.sort(function (a, b) {
          var c = cmpVal(lotCell(a, sk, wh), lotCell(b, sk, wh), def && def.num);
          if (c !== 0) return sd * c;
          return sortLots(a, b);
        });
      } else {
        list.sort(sortLots);
      }
      var sum = 0, live = 0, amt = 0;
      for (j = 0; j < list.length; j++) {
        sum += qtyOf(list[j], wh);
        amt += qtyOf(list[j], wh) * list[j].price;
        if (qtyOf(list[j], wh) > EPS) live++;
      }
      out.push({ name: order[i], lots: list, sum: r2(sum), live: live, amt: r0(amt) });
    }
    return out;
  }

  function countLive(st, wh) {
    var n = 0;
    for (var i = 0; i < st.lots.length; i++) if (qtyOf(st.lots[i], wh) > EPS) n++;
    return n;
  }

  /* ---------- 입출고 내역 필터/정렬 ---------- */
  function sortLogsDesc(logs) {
    var out = logs.slice();
    out.sort(function (a, b) {
      if (a.d !== b.d) return a.d < b.d ? 1 : -1;
      return (b.dbid || 0) - (a.dbid || 0);
    });
    return out;
  }
  function sortLogsAsc(logs) {
    var out = logs.slice();
    out.sort(function (a, b) {
      if (a.d !== b.d) return a.d < b.d ? -1 : 1;
      return (a.dbid || 0) - (b.dbid || 0);
    });
    return out;
  }

  /* opt: { q, type(구분 6종 키), from, to, cols, sortKey, sortDir } */
  function filterLogs(st, opt) {
    opt = opt || {};
    var out = [], i, e, qq = s(opt.q).toLowerCase();
    for (i = 0; i < st.logs.length; i++) {
      e = st.logs[i];
      if (opt.type && opt.type !== 'all' && kindKey(e) !== opt.type) continue;
      if (!inRange(e.d, opt.from, opt.to)) continue;
      if (qq) {
        if (!textHit([e.n, e.v, e.b, e.p, e.note, e.i, e.d, e.worker, kindName(e),
          e.t === 'out' ? destName(e.dt) : '', e.mt].join(' '), opt.q)) continue;
      }
      if (!passCols(opt.cols, function (k) { return logCell(e, k); })) continue;
      out.push(e);
    }
    if (opt.sortKey) {
      var def = colDef(LOG_COLS, opt.sortKey), sd = opt.sortDir === -1 ? -1 : 1;
      out.sort(function (a, b) {
        var c = cmpVal(logCell(a, opt.sortKey), logCell(b, opt.sortKey), def && def.num);
        if (c !== 0) return sd * c;
        return (b.dbid || 0) - (a.dbid || 0);
      });
    } else {
      out = sortLogsDesc(out);
    }
    return out;
  }

  /* ==========================================================================
     v7 — 축산 브랜드 한↔영 사전 + 한글 검색 보조(초성·음역)
     같은 브랜드를 파텔로 쳐도 PATEL 로, PATEL 로 쳐도 파텔로 찾는다.
     ========================================================================== */
  var BRANDS = [
    { en: 'PATEL', ko: '파텔' },
    { en: 'SWIFT', ko: '스위프트' },
    { en: 'KILCOY', ko: '킬코이' },
    { en: 'TYSON', ko: '타이슨' },
    { en: 'IBP', ko: '아이비피' },
    { en: 'ABP', ko: '에이비피' },
    { en: 'CARGILL', ko: '카길' },
    { en: 'DANISH CROWN', ko: '데니쉬크라운', alt: ['데니시크라운'] },
    { en: "PILGRIM'S", ko: '필그림', alt: ['PILGRIMS', '필그림스'] },
    { en: 'RIBASAM', ko: '리바삼' },
    { en: 'SEARA', ko: '씨에라', alt: ['시에라'] },
    { en: 'SADIA', ko: '사디아' },
    { en: 'AURORA', ko: '오로라' },
    { en: 'BRF', ko: '비알에프' },
    { en: 'DODRAM', ko: '도드람', alt: ['도드람푸드'] },
    { en: 'HARIM', ko: '하림' },
    { en: 'JBS', ko: '제이비에스' },
    { en: 'VION', ko: '비온' },
    { en: 'TONNIES', ko: '퇴니스', alt: ['TÖNNIES'] },
    { en: 'EL POZO', ko: '엘포소' },
    { en: 'TEYS', ko: '테이스', alt: ['티스'] },
    { en: 'SILVER FERN', ko: '실버펀', alt: ['실버펀팜스'] },
    { en: 'GREENLEA', ko: '그린리' },
    { en: 'SMITHFIELD', ko: '스미스필드' },
    { en: 'CHERRYBRO', ko: '체리부로' },
    { en: 'MANIKER', ko: '마니커' },
    /* 실무에서 함께 쓰는 브랜드 */
    { en: 'KEKEN', ko: '케켄' },
    { en: 'AGROSUPER', ko: '아그로슈퍼' },
    { en: 'SEABOARD', ko: '씨보드' },
    { en: 'ROSIDER', ko: '로시데르' },
    { en: 'CRV', ko: '씨알브이' },
    { en: 'AMH', ko: '에이엠에이치' },
    { en: 'IFT', ko: '아이에프티' },
    { en: 'HKFOODS', ko: '에이치케이푸즈', alt: ['HK FOODS'] },
    { en: 'RALPHS', ko: '랄프스' },
    { en: 'GREEN MOUNTAIN', ko: '그린마운틴' },
    { en: 'INDIANA', ko: '인디아나' },
    { en: 'WESTPORT', ko: '웨스트포트' }
  ];
  /* 비교용 정규화: 대문자 + 공백·따옴표·가운뎃점·붙임표 제거 ('Pilgrim\'s' → 'PILGRIMS') */
  function brandNorm(v) {
    return s(v).toUpperCase().replace(/[\s'`´’".,·\-_()]/g, '');
  }
  var BRAND_INDEX = {};      /* 정규화 토큰 → 사전 항목 */
  var BRAND_EN = [];         /* 표준 영문 브랜드 목록 (자동완성) */
  (function () {
    for (var i = 0; i < BRANDS.length; i++) {
      var b = BRANDS[i];
      b.tokens = [b.en, b.ko].concat(b.alt || []);
      b.keys = [];
      for (var j = 0; j < b.tokens.length; j++) {
        var k = brandNorm(b.tokens[j]);
        if (!k) continue;
        b.keys.push(k);
        if (!BRAND_INDEX[k]) BRAND_INDEX[k] = b;
      }
      BRAND_EN.push(b.en);
    }
  })();
  /* 검색어를 브랜드 사전으로 넓힌다: '파텔' → [파텔, PATEL] / 'patel' → [PATEL, 파텔] */
  function brandTerms(q) {
    var out = [], seen = {}, push = function (v) {
      var t = brandNorm(v);
      if (!t || seen[t]) return;
      seen[t] = 1; out.push(t);
    };
    var raw = s(q);
    if (!raw) return out;
    push(raw);
    var n = brandNorm(raw);
    if (!n) return out;
    var hit = BRAND_INDEX[n];
    if (hit) { for (var i = 0; i < hit.keys.length; i++) push(hit.keys[i]); return out; }
    if (n.length >= 2) {
      for (var j = 0; j < BRANDS.length; j++) {
        var keys = BRANDS[j].keys, on = false;
        for (var k = 0; k < keys.length; k++) {
          if (keys[k].length >= 2 && (keys[k].indexOf(n) >= 0 || n.indexOf(keys[k]) >= 0)) { on = true; break; }
        }
        if (on) for (var m = 0; m < keys.length; m++) push(keys[m]);
      }
    }
    return out;
  }
  /* 표준 영문 브랜드명 (모르면 입력값 그대로) */
  function brandStandard(v) {
    var raw = s(v);
    if (!raw) return '';
    var part = raw.split('/')[0];
    var hit = BRAND_INDEX[brandNorm(raw)] || BRAND_INDEX[brandNorm(part)];
    return hit ? hit.en : raw;
  }
  function brandKoOf(v) {
    var hit = BRAND_INDEX[brandNorm(String(v).split('/')[0])] || BRAND_INDEX[brandNorm(v)];
    return hit ? hit.ko : '';
  }
  function brandList() { return BRAND_EN.slice(); }

  /* ---------- 한글 검색 보조 ---------- */
  var CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
  /* 문자열의 초성만: '파텔' → 'ㅍㅌ' */
  function chosung(v) {
    var t = s(v), out = '', i, c;
    for (i = 0; i < t.length; i++) {
      c = t.charCodeAt(i);
      if (c >= 0xAC00 && c <= 0xD7A3) out += CHO[Math.floor((c - 0xAC00) / 588)];
      else if (c >= 0x3131 && c <= 0x314E) out += t.charAt(i);
      else out += ' ';
    }
    return out;
  }
  /* 한글 → 로마자(국어의 로마자 표기법 축약) : 사전에 없는 브랜드도 '파텔'→'patel' 로 맞춰 본다 */
  var R_CHO = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
  var R_JUNG = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
  var R_JONG = ['', 'k', 'k', 'ks', 'n', 'nj', 'nh', 't', 'l', 'lk', 'lm', 'lb', 'ls', 'lt', 'lp', 'lh', 'm', 'p', 'ps', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 'h'];
  function romanizeKo(v) {
    var t = s(v), out = '', i, c;
    for (i = 0; i < t.length; i++) {
      c = t.charCodeAt(i);
      if (c >= 0xAC00 && c <= 0xD7A3) {
        var n = c - 0xAC00;
        out += R_CHO[Math.floor(n / 588)] + R_JUNG[Math.floor((n % 588) / 28)] + R_JONG[n % 28];
      } else out += t.charAt(i);
    }
    return out;
  }
  /* 검색어 하나가 글뭉치에 걸리는지 — 직접 포함 + 브랜드 사전 + 초성 + 음역 */
  function textHit(hay, q) {
    var qq = s(q);
    if (!qq) return true;
    var h = s(hay);
    if (!h) return false;
    var hl = h.toLowerCase(), ql = qq.toLowerCase();
    if (hl.indexOf(ql) >= 0) return true;
    var hn = brandNorm(h).toLowerCase(), qn = brandNorm(qq).toLowerCase();
    if (hn && qn && hn.indexOf(qn) >= 0) return true;
    var terms = brandTerms(qq), i;
    for (i = 0; i < terms.length; i++) {
      var tk = terms[i].toLowerCase();
      if (tk !== qn && (hl.indexOf(tk) >= 0 || hn.indexOf(tk) >= 0)) return true;
    }
    if (/^[ㄱ-ㅎ]+$/.test(qq) && chosung(h).indexOf(qq) >= 0) return true;
    if (/[가-힣]/.test(qq)) {
      var rq = romanizeKo(qq).replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (rq.length >= 3 && hn.indexOf(rq) >= 0) return true;
    }
    return false;
  }

  /* ==========================================================================
     v7 — 거래명세표 (A4 인쇄)
       o = { kind:'meat'|'fp'|'voucher', ref, logs, fpLogs }
     ref 의 날짜 + 거래처가 같은 출고를 묶어 품목 줄을 만들고,
     직접 입력한 매출 전표는 전표 금액 한 줄로 채운다.
     ========================================================================== */
  var STMT_MERGE = true;
  function stmtLine(o) {
    var qty = Math.round((Number(o.qty) || 0) * 1000) / 1000;
    var price = r0(o.price);
    var supply = r0(o.supply);
    if (!supply && qty > 0 && price > 0) supply = Math.round(qty * price);
    var vat = 0;
    if (o.tax === 'tax') vat = (o.vat === undefined || o.vat === null) ? Math.round(supply * VAT_RATE) : r0(o.vat);
    return {
      name: s(o.name), spec: s(o.spec), qty: qty, unit: s(o.unit) || 'kg',
      price: price, supply: supply, vat: vat, total: r0(supply + vat), note: s(o.note)
    };
  }
  function stmtSum(lines) {
    var supply = 0, vat = 0, total = 0, i;
    for (i = 0; i < lines.length; i++) { supply += lines[i].supply; vat += lines[i].vat; total += lines[i].total; }
    return { supply: r0(supply), vat: r0(vat), total: r0(total) };
  }
  /* 같은 품목·규격·단가는 한 줄로 합친다 (로트가 여러 개여도 명세표는 한 줄) */
  function stmtMerge(lines) {
    if (!STMT_MERGE) return lines;
    var out = [], map = {}, i, k, l;
    for (i = 0; i < lines.length; i++) {
      l = lines[i];
      k = [l.name, l.spec, l.price, l.unit].join('\u0001');
      if (!map[k]) { map[k] = { name: l.name, spec: l.spec, qty: 0, unit: l.unit, price: l.price, supply: 0, vat: 0, total: 0, note: l.note }; out.push(map[k]); }
      var t = map[k];
      t.qty = Math.round((t.qty + l.qty) * 1000) / 1000;
      t.supply += l.supply; t.vat += l.vat; t.total += l.total;
      if (!t.note && l.note) t.note = l.note;
    }
    for (i = 0; i < out.length; i++) { out[i].supply = r0(out[i].supply); out[i].vat = r0(out[i].vat); out[i].total = r0(out[i].total); }
    return out;
  }
  function stmtMeat(o) {
    var ref = o.ref || {}, d = s(ref.d), partner = s(ref.p), rows = [], i, e;
    for (i = 0; i < (o.logs || []).length; i++) {
      e = o.logs[i];
      if (e.t !== 'out') continue;
      if (d && s(e.d) !== d) continue;
      if (partner && s(e.p) !== partner) continue;
      rows.push(stmtLine({
        name: e.n, spec: whName(e.w) + (e.mt ? ' · ' + e.mt : ''), qty: e.k, unit: 'kg',
        price: e.price, supply: e.amt, tax: 'free', note: noteOf(e)
      }));
    }
    return rows;
  }
  function stmtFp(o) {
    var ref = o.ref || {}, d = s(ref.d), partner = s(ref.p), rows = [], i, g;
    for (i = 0; i < (o.fpLogs || []).length; i++) {
      g = o.fpLogs[i];
      if (g.undone || g.t !== 'OUT') continue;
      if (d && s(g.d) !== d) continue;
      if (partner && s(g.p) !== partner) continue;
      rows.push(stmtLine({
        name: g.n, spec: g.spec, qty: g.q, unit: g.unit || '개',
        price: g.outp, supply: g.amt, tax: 'tax', note: g.note
      }));
    }
    return rows;
  }
  function stmtVoucher(o) {
    var v = o.ref || {};
    return [stmtLine({
      name: v.note || (v.t === 'purchase' ? '매입' : '매출'), spec: '',
      qty: 0, unit: '', price: 0, supply: v.supply, vat: v.vat, tax: v.tax === 'free' ? 'free' : 'tax',
      note: v.note || ''
    })];
  }
  /* kind = 'meat' | 'fp' | 'voucher' */
  function stmtData(o) {
    o = o || {};
    var kind = o.kind || 'meat', ref = o.ref || {};
    var lines = [], date = '', partner = '', srcName = '출고';
    if (kind === 'meat') {
      lines = stmtMeat(o); date = s(ref.d); partner = s(ref.p); srcName = '원료육 출고';
    } else if (kind === 'fp') {
      lines = stmtFp(o); date = s(ref.d); partner = s(ref.p); srcName = '완제품 출고';
    } else {
      lines = stmtVoucher(o); date = s(ref.d); partner = s(ref.partner); srcName = '전표';
    }
    lines = stmtMerge(lines);
    var sum = stmtSum(lines);
    var tax = 'free';
    for (var i = 0; i < lines.length; i++) if (lines[i].vat > 0) tax = 'tax';
    return {
      date: date, partner: partner, tax: tax, lines: lines,
      supply: sum.supply, vat: sum.vat, total: sum.total,
      source: srcName, note: s(ref.note)
    };
  }

  /* v10 — 한 거래(전표 여러 건)의 품목 줄들을 한 장의 거래명세표로 묶는다 */
  function stmtGroupData(v, lines) {
    v = v || {};
    var out = [], sum, i, l, tax = 'free';
    for (i = 0; i < (lines || []).length; i++) {
      l = lines[i] || {};
      out.push(stmtLine({
        name: l.name, spec: l.spec, qty: l.qty, unit: l.unit, price: l.price,
        supply: l.supply, vat: l.vat, tax: l.tax === 'free' ? 'free' : 'tax', note: l.note
      }));
      if (out[out.length - 1].vat > 0) tax = 'tax';
    }
    sum = stmtSum(out);
    return {
      date: s(v.d), partner: s(v.partner), tax: tax, lines: out,
      supply: sum.supply, vat: sum.vat, total: sum.total,
      source: '전표', note: s(v.note)
    };
  }

  /* ---------- CSV ---------- */
  function csvQuote(rows) {
    var out = [], r, c, cells, v;
    for (r = 0; r < rows.length; r++) {
      cells = [];
      for (c = 0; c < rows[r].length; c++) {
        v = rows[r][c] === null || rows[r][c] === undefined ? '' : String(rows[r][c]);
        cells.push('"' + v.replace(/"/g, '""') + '"');
      }
      out.push(cells.join(','));
    }
    return out.join('\r\n');
  }

  /* 입출고 내역 CSV — 날짜, 구분, 제품명, 업체명, 브랜드, 입고일, 소비기한, 중량, 입고단가, 출고단가, 금액, 생산품목, 비고, 작업자 */
  function csv(st) {
    var head = ['날짜', '구분', '제품명', '업체명', '브랜드', '입고일', '소비기한', '중량(kg)',
      '입고단가(원/kg)', '출고단가(원/kg)', '금액(원)', '생산품목', '비고', '작업자'];
    var rows = [head];
    var list = sortLogsDesc(st.logs);
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var isIn = e.t === 'in', isOut = e.t === 'out';
      rows.push([
        e.d, kindName(e), e.n, e.v, e.b || '', e.i, e.e, Number(e.k).toFixed(2),
        isIn ? Number(e.price || 0).toFixed(2) : '',
        isOut ? Number(e.price || 0).toFixed(2) : '',
        r0(e.amt),
        prodOf(e), noteOf(e), e.worker || ''
      ]);
    }
    return csvQuote(rows);
  }

  /* 재고 CSV — 제품명, 육류, 원산지, 업체명, 브랜드, 입고일, 소비기한, 재고(kg), 단가, 금액 */
  function stockCsv(st, wh) {
    var head = ['제품명', '육류', '원산지', '업체명', '브랜드', '입고일', '소비기한',
      wh === 'F' ? '냉동고 재고(kg)' : '냉장고 재고(kg)', '단가(원/kg)', '재고금액(원)'];
    var rows = [head];
    var groups = grouped(st, wh, '', false);
    for (var i = 0; i < groups.length; i++) {
      for (var j = 0; j < groups[i].lots.length; j++) {
        var l = groups[i].lots[j];
        var q = qtyOf(l, wh);
        if (q <= EPS) continue;
        rows.push([l.n, l.mt, l.o, l.v, l.b, l.i, l.e, Number(q).toFixed(2),
          Number(l.price || 0).toFixed(2), r0(q * l.price)]);
      }
    }
    return csvQuote(rows);
  }

  /* ==========================================================================
     실무 양식 내보내기
       · 사방넷 풀필먼트 엑셀입고   : 시트 '엑셀입고',   1행 헤더 8열
       · 경리나라 매출거래명세표     : 시트 '일괄등록',   1행 헤더 20열
     헤더 이름과 순서는 사용자가 준 원본 양식과 똑같이 맞춘다. 바꾸지 말 것.
     ========================================================================== */

  /* 'YYYY-MM-DD' → 'YYYYMMDD' (사방넷 소비기한·제조일자 형식) */
  function ymd8(v) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s(v));
    if (!m) return '';
    return m[1] + pad2(Number(m[2])) + pad2(Number(m[3]));
  }
  /* 'YYYY-MM-DD' → 'MMDD' (경리나라 품목월일 형식) */
  function mmdd(v) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s(v));
    if (!m) return '';
    return pad2(Number(m[2])) + pad2(Number(m[3]));
  }
  /* 값이 있는 것만 '/'로 잇는다 */
  function joinSlash(parts) {
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var v = s(parts[i]);
      if (v) out.push(v);
    }
    return out.join('/');
  }

  /* 이력 한 건이 가리키는 로트 (원산지·브랜드는 로트에만 있다) */
  function lotOf(st, e) {
    var i, l;
    if (e.lid) {
      for (i = 0; i < st.lots.length; i++) if (st.lots[i].id === 'L' + e.lid) return st.lots[i];
    }
    for (i = 0; i < st.lots.length; i++) {
      l = st.lots[i];
      if (l.n === e.n && l.v === e.v && l.i === e.i && l.e === e.e) return l;
    }
    return null;
  }

  /* 날짜 범위 조건 — opt.range: 'today' | 'range' | 'all' */
  function inDateRange(d, opt) {
    opt = opt || {};
    d = s(d);
    if (opt.range === 'all') return true;
    if (opt.range === 'range') {
      if (!s(opt.from) && !s(opt.to)) return true;
      if (s(opt.from) && d < s(opt.from)) return false;
      if (s(opt.to) && d > s(opt.to)) return false;
      return true;
    }
    return d === s(opt.today);
  }

  /* 사방넷 풀필먼트 '엑셀입고' 양식 — 헤더 8열 */
  var SABANG_HEAD = ['매입처', '출고상품코드', '출고상품명', '수량', '제조일자', '유통기한', '로케이션', '입고메모'];
  function sabangnetRows(st, opt) {
    opt = opt || {};
    var rows = [SABANG_HEAD.slice()];
    var list = sortLogsAsc(st.logs);
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var isIn = e.t === 'in';
      var isThaw = e.t === 'thaw';
      if (!isIn && !(opt.thaw && isThaw)) continue;
      if (!inDateRange(e.d, opt)) continue;
      var lot = lotOf(st, e);
      var qty = Math.abs(Number(e.k) || 0);
      if (!(qty > 0)) continue;
      /* 해동은 냉장고로 들어오는 입고라 로케이션을 냉장고로 적는다 */
      var wh = isThaw ? 'C' : e.w;
      rows.push([
        s(e.v),                                        /* 매입처 (업체명) */
        '',                                            /* 출고상품코드 */
        s(e.n),                                        /* 출고상품명 */
        qty,                                           /* 수량 (양수 kg) */
        '',                                            /* 제조일자 */
        ymd8(e.e),                                     /* 소비기한 YYYYMMDD */
        whName(wh),                                    /* 로케이션 냉동고 / 냉장고 */
        joinSlash([lot ? lot.o : '', lot ? lot.b : '', e.note]) /* 입고메모 원산지/브랜드/비고 */
      ]);
    }
    return rows;
  }

  /* 경리나라 '매출거래명세표 일괄등록' 양식 — 헤더 20열
     단가가 있으면 단가·공급가액·세액을 채운다 (부가세 별도면 10%) */
  var SALES_HEAD = ['거래일자', '구분', '거래처명', '사업자번호', '부가세구분', '프로젝트/현장', '창고',
    '품목월일', '품목코드', '품목명', '규격', '수량', '단위', '단가', '공급가액', '세액', '품목비고',
    '입금액', '인수자', '공통메모'];
  function salesRows(st, opt) {
    opt = opt || {};
    var vat = s(opt.vat) || '면세';
    var rows = [SALES_HEAD.slice()];
    var list = sortLogsAsc(st.logs);
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.t !== 'out') continue;
      if (!opt.allOut && e.dt !== 'vendor') continue;
      if (!inDateRange(e.d, opt)) continue;
      var qty = Math.abs(Number(e.k) || 0);
      if (!(qty > 0)) continue;
      var lot = lotOf(st, e);
      var price = Number(e.price || 0) > 0 ? Number(e.price) : (lot ? Number(lot.price || 0) : 0);
      var supply = r0(qty * price);
      var tax = vat === '별도' ? r0(supply * 0.1) : 0;
      rows.push([
        s(e.d),                                        /* 거래일자 YYYY-MM-DD */
        '사업자',                                      /* 구분 */
        s(e.p) || destName(e.dt),                      /* 거래처명 */
        '',                                            /* 사업자번호 */
        vat,                                           /* 부가세구분 면세/별도/없음 */
        e.dt === 'site' ? '현장' : '',                 /* 프로젝트/현장 */
        whName(e.w),                                   /* 창고 */
        mmdd(e.d),                                     /* 품목월일 MMDD */
        '',                                            /* 품목코드 */
        s(e.n),                                        /* 품목명 */
        joinSlash([lot ? lot.o : '', lot ? lot.b : '']), /* 규격 원산지/브랜드 */
        qty,                                           /* 수량 (양수) */
        'kg',                                          /* 단위 */
        price,                                         /* 단가 */
        supply,                                        /* 공급가액 */
        tax,                                           /* 세액 */
        s(e.note),                                     /* 품목비고 */
        '', '', ''                                     /* 입금액·인수자·공통메모 */
      ]);
    }
    return rows;
  }

  /* ---------- 입고 단가 이력 (가격 변동·오타 확인) ---------- */
  /* 같은 품목(대분류 포함)의 과거 입고 단가를 날짜·번호 순으로 모은다. 단가 0(미입력)은 뺀다. */
  function priceStats(st, name, major) {
    var key = s(name).toLowerCase();
    var res = { count: 0, last: 0, lastDate: '', prev: 0, prevDate: '', min: 0, max: 0, avg: 0,
      firstDate: '', first: 0 };
    if (!key) return res;
    var rows = [], i, e;
    for (i = 0; i < st.logs.length; i++) {
      e = st.logs[i];
      if (e.t !== 'in') continue;
      if (!(Number(e.price) > 0)) continue;
      if (s(e.n).toLowerCase() !== key) continue;
      if (major && major !== 'all' && e.major !== major) continue;
      rows.push(e);
    }
    rows.sort(function (a, b) {
      if (a.d !== b.d) return a.d < b.d ? -1 : 1;
      return (a.dbid || 0) - (b.dbid || 0);
    });
    if (!rows.length) return res;
    var sum = 0, min = Infinity, max = -Infinity;
    for (i = 0; i < rows.length; i++) {
      var p = Number(rows[i].price);
      sum += p;
      if (p < min) min = p;
      if (p > max) max = p;
    }
    var lastRow = rows[rows.length - 1];
    res.count = rows.length;
    res.min = r0(min);
    res.max = r0(max);
    res.avg = r0(sum / rows.length);
    res.last = r0(lastRow.price);
    res.lastDate = lastRow.d;
    res.first = r0(rows[0].price);
    res.firstDate = rows[0].d;
    if (rows.length > 1) {
      res.prev = r0(rows[rows.length - 2].price);
      res.prevDate = rows[rows.length - 2].d;
    }
    return res;
  }
  /* 새로 입력한 단가를 직전가와 비교 */
  function priceCompare(stat, price) {
    var p = Number(price) || 0;
    var res = { has: !!(stat && stat.count > 0), base: 0, delta: 0, pct: 0, dir: 'none', warn: false, warnAvg: false };
    if (!res.has || !(p > 0)) return res;
    var base = Number(stat.last) || 0;
    res.base = base;
    res.delta = r0(p - base);
    res.pct = base > 0 ? Math.round((p - base) / base * 1000) / 10 : 0;
    res.dir = p > base + 0.004 ? 'up' : (p < base - 0.004 ? 'down' : 'same');
    res.warn = base > 0 && Math.abs(res.pct) >= 30;
    res.warnAvg = Number(stat.avg) > 0 && Math.abs(Math.round((p - stat.avg) / stat.avg * 1000) / 10) >= 30;
    res.warn = res.warn || res.warnAvg;
    return res;
  }

  /* ---------- 입고 단가 변동 표 (v6) ----------
     tx_logs 의 입고(type='in', 단가>0)만 품목명으로 묶어 직전 입고가와 최근 입고가를 비교한다.
     입고가 2번 이상인 품목만 나온다(비교할 직전가가 있어야 변동을 말할 수 있다). */
  var CHG_COLS = [
    { k: 'n', t: '제품명', w: 160 },
    { k: 'mt', t: '육류', w: 92 },
    { k: 'v', t: '최근 업체', w: 128 },
    { k: 'prev', t: '직전 단가(원/kg)', w: 118, num: true },
    { k: 'last', t: '최근 단가(원/kg)', w: 118, num: true },
    { k: 'delta', t: '변동액(원/kg)', w: 112, num: true },
    { k: 'pct', t: '변동률(%)', w: 100, num: true },
    { k: 'd', t: '최근 입고일', w: 110 },
    { k: 'cnt', t: '입고 횟수', w: 86, num: true }
  ];
  function chgRows(st) {
    var byKey = {}, out = [], i, e, key, rows, j;
    var logs = (st && st.logs) || [];
    for (i = 0; i < logs.length; i++) {
      e = logs[i];
      if (e.t !== 'in') continue;
      if (!(Number(e.price) > 0)) continue;
      key = s(e.n).toLowerCase();
      if (!key) continue;
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push(e);
    }
    for (key in byKey) {
      if (!Object.prototype.hasOwnProperty.call(byKey, key)) continue;
      rows = byKey[key];
      if (rows.length < 2) continue;
      rows.sort(function (a, b) {
        if (a.d !== b.d) return a.d < b.d ? -1 : 1;
        return (a.dbid || 0) - (b.dbid || 0);
      });
      var last = rows[rows.length - 1], prev = rows[rows.length - 2];
      var lp = Number(last.price) || 0, pp = Number(prev.price) || 0;
      var delta = r0(lp - pp);
      var pct = pp > 0 ? Math.round((lp - pp) / pp * 1000) / 10 : 0;
      out.push({
        n: last.n, mt: last.mt, v: last.v, prev: r0(pp), last: r0(lp),
        delta: delta, pct: pct, d: last.d, cnt: rows.length,
        dir: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'same')
      });
    }
    out.sort(function (a, b) {
      var c = Math.abs(b.pct) - Math.abs(a.pct);
      if (c !== 0) return c;
      return a.d < b.d ? 1 : (a.d > b.d ? -1 : 0);
    });
    return out;
  }
  function chgCell(r, k) {
    if (k === 'n') return r.n;
    if (k === 'mt') return r.mt;
    if (k === 'v') return r.v;
    if (k === 'prev') return r.prev;
    if (k === 'last') return r.last;
    if (k === 'delta') return r.delta;
    if (k === 'pct') return r.pct;
    if (k === 'd') return r.d;
    if (k === 'cnt') return r.cnt;
    return '';
  }
  /* opt: { q, from, to, cols, sortKey, sortDir } — 정렬을 고르지 않으면 |변동률| 큰 순 */
  function filterChg(list, opt) {
    opt = opt || {};
    var out = [], i, r, qq = s(opt.q).toLowerCase();
    for (i = 0; i < (list || []).length; i++) {
      r = list[i];
      if (!inRange(r.d, opt.from, opt.to)) continue;
      if (qq) {
        if (!textHit([r.n, r.mt, r.v, r.d, String(r.prev), String(r.last)].join(' '), opt.q)) continue;
      }
      if (!passCols(opt.cols, function (k) { return chgCell(r, k); })) continue;
      out.push(r);
    }
    if (opt.sortKey) {
      var def = colDef(CHG_COLS, opt.sortKey), sd = opt.sortDir === -1 ? -1 : 1;
      out.sort(function (a, b) {
        var c = cmpVal(chgCell(a, opt.sortKey), chgCell(b, opt.sortKey), def && def.num);
        if (c !== 0) return sd * c;
        return Math.abs(b.pct) - Math.abs(a.pct);
      });
    } else {
      out.sort(function (a, b) {
        var c = Math.abs(b.pct) - Math.abs(a.pct);
        if (c !== 0) return c;
        return a.d < b.d ? 1 : (a.d > b.d ? -1 : 0);
      });
    }
    return out;
  }
  /* 같은 기간 원료육 현장(생산 투입) 출고 합계 — 완제품 자체생산 참고용 */
  function siteInput(st, from, to) {
    var cnt = 0, kg = 0, amt = 0, i, e;
    var logs = (st && st.logs) || [];
    for (i = 0; i < logs.length; i++) {
      e = logs[i];
      if (e.t !== 'out' || destKey(e.dt) !== 'site') continue;
      if (!inRange(e.d, from, to)) continue;
      cnt++;
      kg += Number(e.k) || 0;
      amt += Number(e.amt) || 0;
    }
    return { cnt: cnt, kg: r2(kg), amt: r0(amt) };
  }

  /* ==========================================================================
     v8 · 생산·원가 (현장 투입) + 입출고 → 회계 자동 연동
     ----------------------------------------------------------------------------
     현장 출고는 매출이 아니라 생산투입이다. 원료육(tx_logs, dest=현장)과
     완제품·부자재(박스·포장지·소스 등, fp_logs source=site)를 한데 모아
     일별·월별 투입금액과 품목별 실제 제조원가를 낸다.
     ========================================================================== */
  var FP_SITE_SRC = 'site';

  /* 자체생산 입고인가 — 거래처가 '자체생산'이거나 비고에 [자체생산]이 있다(기존 기록 호환) */
  function selfMadeLog(g) {
    if (!g || g.t !== 'IN') return false;
    if (s(g.p) === '자체생산') return true;
    return s(g.note).indexOf('[자체생산]') >= 0;
  }
  /* 완제품·부자재 현장소모(생산투입)인가 — source='site' 또는 예전 기록의 거래처 '현장…' */
  function isFpSiteUse(g) {
    if (!g || g.t !== 'OUT' || g.undone) return false;
    if (s(g.src) === FP_SITE_SRC) return true;
    return s(g.p).indexOf('현장') === 0;
  }

  /* 현장 투입 한 줄기 — 원료육 · 완제품·부자재를 같은 모양으로 만든다 */
  function siteCostRows(st) {
    var out = [], i, e, g;
    st = st || {};
    for (i = 0; i < (st.logs || []).length; i++) {
      e = st.logs[i];
      if (!e || e.t !== 'out' || destKey(e.dt) !== 'site') continue;
      out.push({
        kind: 'meat', id: e.dbid, d: nz(e.d), item: s(prodOf(e)), name: nz(e.n),
        qty: Number(e.k) || 0, unit: 'kg', amount: r0(e.amt), worker: nz(e.worker)
      });
    }
    for (i = 0; i < (st.fpLogs || []).length; i++) {
      g = st.fpLogs[i];
      if (!isFpSiteUse(g)) continue;
      out.push({
        kind: 'fp', id: g.id, d: nz(g.d), item: s(g.p).replace(/^현장\s*:?\s*/, ''), name: nz(g.n),
        qty: Number(g.q) || 0, unit: nz(g.unit) || '개', amount: r0(g.amt), worker: nz(g.worker)
      });
    }
    return out;
  }

  function prodRows(st, from, to) {
    var all = siteCostRows(st), out = [], i;
    for (i = 0; i < all.length; i++) if (inRange(all[i].d, from, to)) out.push(all[i]);
    return out;
  }

  /* 기간 전체 생산투입 요약 — 매출·미수금은 항상 0원(분리 집계) */
  function prodSummary(st, from, to) {
    var rows = prodRows(st, from, to);
    var meat = 0, fp = 0, cntM = 0, cntF = 0, i, r;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      if (r.kind === 'meat') { meat += r.amount; cntM++; } else { fp += r.amount; cntF++; }
    }
    return { meat: r0(meat), fp: r0(fp), total: r0(meat + fp), cntM: cntM, cntF: cntF,
      cnt: cntM + cntF, sales: 0, rows: rows };
  }

  /* 일별·월별 생산투입 표 */
  function prodByPeriod(st, from, to, unit) {
    var rows = prodRows(st, from, to), map = {}, order = [], i, r, key;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      key = unit === 'month' ? ymKey(r.d) : (s(r.d) || '날짜 없음');
      if (!map[key]) { map[key] = { period: key, meat: 0, fp: 0, total: 0, cnt: 0, cntM: 0, cntF: 0 }; order.push(key); }
      if (r.kind === 'meat') { map[key].meat += r.amount; map[key].cntM++; } else { map[key].fp += r.amount; map[key].cntF++; }
      map[key].cnt++;
    }
    var out = [];
    for (i = 0; i < order.length; i++) {
      r = map[order[i]];
      r.meat = r0(r.meat); r.fp = r0(r.fp); r.total = r0(r.meat + r.fp);
      out.push(r);
    }
    out.sort(function (a, b) { return a.period < b.period ? 1 : (a.period > b.period ? -1 : 0); });
    return out;
  }

  function normName(v) { return s(v).toLowerCase().replace(/\s+/g, ''); }
  function nameMatch(a, b) {
    var x = normName(a), y = normName(b);
    if (!x || !y) return false;
    return x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
  }

  /* 품목별 실제 제조원가 — 생산품목으로 모은 현장 투입원가 ÷ 자체생산 입고수량 */
  function prodCostItems(st, from, to) {
    var rows = prodRows(st, from, to), map = {}, order = [], i, j, g, key;
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      key = s(r.item);
      if (!map[key]) { map[key] = { item: key, cost: 0, cnt: 0, kg: 0, rows: [] }; order.push(key); }
      map[key].cost += r.amount;
      map[key].cnt++;
      if (r.kind === 'meat') map[key].kg += r.qty;
      map[key].rows.push(r);
    }
    var out = [];
    for (i = 0; i < order.length; i++) {
      var m = map[order[i]];
      var produced = 0, unit = '개', code = '', name = m.item;
      if (m.item) {
        for (j = 0; j < (st.fpLogs || []).length; j++) {
          g = st.fpLogs[j];
          if (!selfMadeLog(g)) continue;
          if (!inRange(g.d, from, to)) continue;
          if (!nameMatch(g.n, m.item)) continue;
          produced += Number(g.q) || 0;
          unit = nz(g.unit) || unit;
          if (!code) code = nz(g.code);
          name = nz(g.n) || name;
        }
        var p = code ? fpProductOf(st.fps, code) : null;
        if (!p) {
          for (j = 0; j < (st.fps || []).length; j++) {
            if (nameMatch(st.fps[j].n, m.item)) { p = st.fps[j]; break; }
          }
        }
        if (p) { unit = nz(p.unit) || unit; code = nz(p.code) || code; name = nz(p.n) || name; }
      }
      var salePrice = p ? (Number(p.outp) || 0) : 0;
      var cost = r0(m.cost);
      var unitCost = produced > 0.0001 ? Math.round(cost / produced) : 0;
      var margin = (produced > 0.0001 && salePrice > 0) ? Math.round(salePrice - unitCost) : 0;
      out.push({
        item: m.item, name: name, cost: cost, cnt: m.cnt, kg: r2(m.kg),
        produced: r3(produced), unit: unit, unitCost: unitCost,
        salePrice: salePrice, margin: margin,
        marginPct: (salePrice > 0 && produced > 0.0001) ? Math.round(margin / salePrice * 1000) / 10 : 0,
        code: code, missing: !m.item
      });
    }
    out.sort(function (a, b) {
      if (a.missing !== b.missing) return a.missing ? 1 : -1;
      return b.cost - a.cost;
    });
    return out;
  }

  /* 입출고 → 전표 자동 연동 규칙 (프론트 전용 · DB 변경 없음)
     acc_reflect(kind='meat'|'fp', id) 가 source_kind+source_id 로 중복을 막는다. */
  function linkItemOf(kind, id) {
    var n = Number(id);
    if (!kind || !(n > 0)) return null;
    if (kind !== 'meat' && kind !== 'fp') return null;
    return { kind: kind, id: n };
  }
  function linkOfMeat(e) {
    if (!e || !(Number(e.amt) > 0)) return null;
    if (e.t === 'in') return linkItemOf('meat', e.dbid);
    if (e.t === 'out' && destKey(e.dt) !== 'site') return linkItemOf('meat', e.dbid);
    return null;                      /* 현장 출고는 매출 전표를 만들지 않는다 */
  }
  function linkOfFp(g) {
    if (!g || g.undone || !(Number(g.amt) > 0)) return null;
    if (g.t === 'IN') return selfMadeLog(g) ? null : linkItemOf('fp', g.id);
    if (isFpSiteUse(g)) return null;  /* 현장소모·생산투입은 매출 전표를 만들지 않는다 */
    return linkItemOf('fp', g.id);
  }

  var PROD_COLS = {
    day: [
      { k: 'period', t: '날짜', w: 118 },
      { k: 'meat', t: '원료육 투입', w: 150, num: true },
      { k: 'fp', t: '완제품·부자재 투입', w: 176, num: true },
      { k: 'total', t: '합계', w: 150, num: true },
      { k: 'cnt', t: '건수', w: 84, num: true }
    ],
    month: [
      { k: 'period', t: '월', w: 118 },
      { k: 'meat', t: '원료육 투입', w: 150, num: true },
      { k: 'fp', t: '완제품·부자재 투입', w: 176, num: true },
      { k: 'total', t: '합계', w: 150, num: true },
      { k: 'cnt', t: '건수', w: 84, num: true }
    ],
    cost: [
      { k: 'item', t: '생산품목', w: 210 },
      { k: 'cost', t: '투입원가', w: 140, num: true },
      { k: 'produced', t: '자체생산 수량', w: 138, num: true },
      { k: 'unitCost', t: '1단위당 제조원가', w: 168, num: true },
      { k: 'salePrice', t: '판매단가', w: 130, num: true },
      { k: 'margin', t: '예상 마진', w: 130, num: true },
      { k: 'marginPct', t: '마진율(%)', w: 110, num: true }
    ]
  };
  function prodCell(r, k) {
    if (!r) return '';
    if (k === 'item') return s(r.item) || '(미지정)';
    if (k === 'total') return String(r.total);
    if (k === 'cnt') return String(r.cnt);
    return String(r[k] === undefined || r[k] === null ? '' : r[k]);
  }

  /* ---------- xlsx 만들기 (외부 라이브러리·CDN 없이 ZIP store + OOXML) ---------- */
  var CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = [];
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        CRC_TABLE[n] = c >>> 0;
      }
    }
    var v = -1;
    for (var i = 0; i < bytes.length; i++) v = (v >>> 8) ^ CRC_TABLE[(v ^ bytes[i]) & 0xFF];
    return (v ^ -1) >>> 0;
  }
  function utf8(sv) {
    var out = [], i, c, c2, cp;
    for (i = 0; i < sv.length; i++) {
      c = sv.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < sv.length) {
        c2 = sv.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
          out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
          i++;
        } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return out;
  }
  function push16(a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF); }
  function push32(a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }
  /* 파일 목록 → ZIP(무압축 store) 바이트 배열. [ {name:'a.xml', data:'<xml/>'} ] */
  function zipStore(files) {
    var out = [], central = [], i, f, nameB, dataB, crc, off = 0;
    var DOS_TIME = 0, DOS_DATE = 0x21; /* 1980-01-01 00:00 */
    for (i = 0; i < files.length; i++) {
      f = files[i];
      nameB = utf8(f.name);
      dataB = utf8(f.data);
      crc = crc32(dataB);
      f._off = off;
      push32(out, 0x04034b50);
      push16(out, 20); push16(out, 0x0800); push16(out, 0);
      push16(out, DOS_TIME); push16(out, DOS_DATE);
      push32(out, crc); push32(out, dataB.length); push32(out, dataB.length);
      push16(out, nameB.length); push16(out, 0);
      for (var k = 0; k < nameB.length; k++) out.push(nameB[k]);
      for (var d = 0; d < dataB.length; d++) out.push(dataB[d]);
      off += 30 + nameB.length + dataB.length;
    }
    var cdStart = off, cdSize = 0;
    for (i = 0; i < files.length; i++) {
      f = files[i];
      nameB = utf8(f.name);
      dataB = utf8(f.data);
      crc = crc32(dataB);
      push32(central, 0x02014b50);
      push16(central, 20); push16(central, 20); push16(central, 0x0800); push16(central, 0);
      push16(central, DOS_TIME); push16(central, DOS_DATE);
      push32(central, crc); push32(central, dataB.length); push32(central, dataB.length);
      push16(central, nameB.length); push16(central, 0); push16(central, 0);
      push16(central, 0); push16(central, 0); push32(central, 0);
      push32(central, f._off);
      for (var j = 0; j < nameB.length; j++) central.push(nameB[j]);
      cdSize += 46 + nameB.length;
    }
    for (var m = 0; m < central.length; m++) out.push(central[m]);
    push32(out, 0x06054b50);
    push16(out, 0); push16(out, 0);
    push16(out, files.length); push16(out, files.length);
    push32(out, cdSize); push32(out, cdStart); push16(out, 0);
    return out;
  }

  function xmlEsc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      .replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
      });
  }
  function colName(n) {
    var out = '';
    while (n > 0) { var m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); }
    return out;
  }
  function numStr(v) {
    var n = Number(v);
    if (!isFinite(n)) return '0';
    return String(n);
  }
  function cellXml(ref, v, style) {
    var st2 = style ? ' s="' + style + '"' : '';
    if (v === null || v === undefined || v === '') return '<c r="' + ref + '"' + st2 + '/>';
    if (typeof v === 'number' && isFinite(v)) return '<c r="' + ref + '"' + st2 + '><v>' + numStr(v) + '</v></c>';
    return '<c r="' + ref + '"' + st2 + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
  }
  function sheetXml(sheet) {
    var rows = sheet.rows || [], widths = sheet.widths || [], out = [], i, j, r;
    var maxCol = 1;
    for (i = 0; i < rows.length; i++) if (rows[i] && rows[i].length > maxCol) maxCol = rows[i].length;
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
    out.push('<dimension ref="A1:' + colName(maxCol) + Math.max(1, rows.length) + '"/>');
    out.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
    out.push('<sheetFormatPr defaultRowHeight="15"/>');
    if (widths.length) {
      out.push('<cols>');
      for (i = 0; i < widths.length; i++) {
        out.push('<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + widths[i] + '" customWidth="1"/>');
      }
      out.push('</cols>');
    }
    out.push('<sheetData>');
    for (i = 0; i < rows.length; i++) {
      r = rows[i] || [];
      out.push('<row r="' + (i + 1) + '">');
      for (j = 0; j < r.length; j++) out.push(cellXml(colName(j + 1) + (i + 1), r[j], i === 0 ? 1 : 0));
      out.push('</row>');
    }
    out.push('</sheetData></worksheet>');
    return out.join('');
  }
  var XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  function stylesXml() {
    return XML_HEAD +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font>' +
      '<font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';
  }
  /* sheets: [ {name:'엑셀입고', rows:[[...],...], widths:[14,12,...]} ] → xlsx 바이트(숫자 배열) */
  function xlsxBytes(sheets) {
    var files = [], i, n = sheets.length;
    var ct = [XML_HEAD, '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'];
    for (i = 0; i < n; i++) {
      ct.push('<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
    }
    ct.push('</Types>');
    files.push({ name: '[Content_Types].xml', data: ct.join('') });
    files.push({ name: '_rels/.rels', data: XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>' });
    var wb = [XML_HEAD, '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ',
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'];
    for (i = 0; i < n; i++) wb.push('<sheet name="' + xmlEsc(sheets[i].name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>');
    wb.push('</sheets></workbook>');
    files.push({ name: 'xl/workbook.xml', data: wb.join('') });
    var rels = [XML_HEAD, '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'];
    for (i = 0; i < n; i++) {
      rels.push('<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>');
    }
    rels.push('<Relationship Id="rId' + (n + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');
    rels.push('</Relationships>');
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: rels.join('') });
    files.push({ name: 'xl/styles.xml', data: stylesXml() });
    for (i = 0; i < n; i++) files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(sheets[i]) });
    return zipStore(files);
  }

  /* 자동완성·필터 목록 (지금 데이터에서 뽑는다) */
  function dict(st) {
    var names = [], vendors = [], origins = [], brands = [], products = [], majors = [], meats = [];
    var seen = { n: {}, v: {}, o: {}, b: {}, p: {}, m: {}, t: {} };
    /* majors 는 완제품·회계 모드 호환용으로만 남기고 화면에는 쓰지 않는다 */
    function add(arr, seenMap, v) {
      v = s(v);
      if (!v || seenMap[v]) return;
      seenMap[v] = 1;
      arr.push(v);
    }
    var i, l, e;
    for (i = 0; i < MAJORS.length; i++) add(majors, seen.m, MAJORS[i]);
    for (i = 0; i < MEATS.length; i++) add(meats, seen.t, MEATS[i]);
    for (i = 0; i < st.lots.length; i++) {
      l = st.lots[i];
      add(names, seen.n, l.n);
      add(vendors, seen.v, l.v);
      add(origins, seen.o, l.o);
      add(brands, seen.b, l.b);
      add(majors, seen.m, l.major);
      add(meats, seen.t, l.mt);
    }
    for (i = 0; i < st.logs.length; i++) {
      e = st.logs[i];
      add(names, seen.n, e.n);
      add(vendors, seen.v, e.v);
      add(meats, seen.t, e.mt);
      add(products, seen.p, prodOf(e));
    }
    return { names: names, vendors: vendors, origins: origins, brands: brands,
      products: products, majors: majors, meats: meats };
  }

  /* 택배·기타 출고처는 그동안 쓴 이름을 자동완성으로 재사용한다. */
  function destHistory(st) {
    var courier = [], other = [], seenC = {}, seenO = {}, i, e, v;
    for (i = 0; i < st.logs.length; i++) {
      e = st.logs[i];
      if (e.t !== 'out' || !e.p) continue;
      v = s(e.p);
      if (e.dt === 'courier' && !seenC[v]) { seenC[v] = 1; courier.push(v); }
      if (e.dt === 'other' && !seenO[v]) { seenO[v] = 1; other.push(v); }
    }
    return { courier: courier, other: other };
  }

  /* 서버에 보내기 전에 비어 있는 필수칸만 먼저 걸러 준다 (최종 검증은 서버 함수) */
  function precheck(p) {
    if (p.type === 'in') {
      if (!s(p.name)) return { msg: '제품명을 입력하세요.', field: 'name' };
      if (p.wh !== 'F' && p.wh !== 'C') return { msg: '받는 창고를 선택하세요.', field: 'wh' };
      if (!s(p.in_date)) return { msg: '입고일을 입력하세요.', field: 'inDate' };
      if (!s(p.exp_date)) return { msg: '소비기한을 입력하세요.', field: 'expiry' };
    } else if (p.type === 'out') {
      if (!s(p.lot_id)) return { msg: '먼저 재고표에서 출고할 로트를 선택하세요.', field: 'lot' };
      if (p.wh !== 'F' && p.wh !== 'C') return { msg: '냉동고·냉장고 중에서 고르세요.', field: 'wh' };
      if (!s(p.dest)) {
        return { msg: '출고처를 입력하세요. (' + destName(p.dest_type) + ' · ' + DEST_LABEL[destKey(p.dest_type)] + ')', field: 'dest' };
      }
    } else {
      if (!s(p.lot_id)) return { msg: '먼저 재고표에서 ' + (p.type === 'thaw' ? '해동' : '재냉동') + '할 로트를 선택하세요.', field: 'lot' };
    }
    if (!(Number(p.kg) > 0)) return { msg: '중량(kg)은 0보다 커야 합니다.', field: 'kg' };
    if (p.price !== undefined && p.price !== '' && Number(p.price) < 0) {
      return { msg: '단가(원/kg)는 0보다 작을 수 없습니다.', field: 'price' };
    }
    if (p.amount !== undefined && p.amount !== '' && Number(p.amount) < 0) {
      return { msg: '금액(원)은 0보다 작을 수 없습니다.', field: 'amount' };
    }
    return null;
  }

  /* 수정 모달에서 저장하기 전 확인 */
  function precheckUpdate(p) {
    if (!s(p.date)) return { msg: '거래일을 입력하세요.', field: 'date' };
    if (!(Number(p.kg) > 0)) return { msg: '중량(kg)은 0보다 커야 합니다.', field: 'kg' };
    if (Number(p.price) < 0) return { msg: '단가(원/kg)는 0보다 작을 수 없습니다.', field: 'price' };
    if (Number(p.amount) < 0) return { msg: '금액(원)은 0보다 작을 수 없습니다.', field: 'amount' };
    if (p.type === 'out' && !s(p.dest)) return { msg: '출고처를 입력하세요.', field: 'dest' };
    return null;
  }

  /* ==========================================================================
     v4 · 완제품 ERP (fp_products · fp_logs)
     ========================================================================== */
  var FP_CATS = ['완제품', '소스', '부재료', '향신료', '야채류'];
  /* v8: 재고관리 대분류 묶음 — 전체 / 완제품 / 부자재·포장지 / 야채·소스 */
  var FP_CAT_GROUPS = {
    '완제품': ['완제품'],
    '부자재·포장지': ['부재료', '부자재', '포장지', '포장', '박스', '향신료'],
    '야채·소스': ['야채류', '야채', '소스', '양념']
  };
  function fpCatGroup(cat) {
    var c = s(cat), g;
    for (g in FP_CAT_GROUPS) {
      if (!Object.prototype.hasOwnProperty.call(FP_CAT_GROUPS, g)) continue;
      if (FP_CAT_GROUPS[g].indexOf(c) >= 0) return g;
    }
    if (/포장|박스|부재|향신/.test(c)) return '부자재·포장지';
    if (/야채|소스|양념/.test(c)) return '야채·소스';
    return '기타';
  }
  function fpCatMatch(cat, sel) {
    if (!sel || sel === 'all') return true;
    sel = s(sel);
    if (Object.prototype.hasOwnProperty.call(FP_CAT_GROUPS, sel)) return fpCatGroup(cat) === sel;
    return s(cat) === sel;
  }
  var FP_UNITS = ['개', '팩', '박스', '봉', '병', 'kg', 'g', 'L', 'ml'];
  function r3(x) { var v = Math.round(Number(x) * 1000) / 1000; return v === 0 ? 0 : v; }
  function fpTypeKey(t) { return String(t === undefined || t === null ? '' : t).toUpperCase() === 'OUT' ? 'OUT' : 'IN'; }
  function fpTypeName(t) { return fpTypeKey(t) === 'OUT' ? '출고' : '입고'; }

  function fpProductFrom(r) {
    var q = r3(r.stock);
    var ip = Number(r.in_price) || 0, op = Number(r.out_price) || 0;
    return {
      code: nz(r.code), cat: nz(r.category) || '완제품', n: nz(r.name),
      spec: nz(r.spec), unit: nz(r.unit) || '개',
      stock: q, inp: r2(ip), outp: r2(op), amt: Math.round(q * ip),
      e: nz(r.expiry), sup: nz(r.supplier), bc: nz(r.barcode),
      active: r.active !== false
    };
  }
  function fpLogFrom(r) {
    return {
      id: Number(r.id), d: nz(r.tx_date), t: fpTypeKey(r.tx_type),
      code: nz(r.code), n: nz(r.name), cat: nz(r.category),
      spec: nz(r.spec), unit: nz(r.unit) || '개', q: r3(r.qty),
      inp: r2(r.in_price), outp: r2(r.out_price), amt: r2(r.amount),
      e: nz(r.expiry), p: nz(r.partner), note: nz(r.note), src: nz(r.source) || 'manual',
      worker: nz(r.worker_name), email: nz(r.worker_email), undone: r.undone === true,
      at: nz(r.created_at), lotId: r.lot_id === null || r.lot_id === undefined ? null : Number(r.lot_id),
      lot: nz(r.lot_no), inD: nz(r.in_date)
    };
  }
  /* v6 — 완제품·부자재 로트 한 줄 */
  function fpLotFrom(r) {
    return {
      id: Number(r.id), code: nz(r.code), lot: nz(r.lot_no), cat: nz(r.category) || '완제품',
      n: nz(r.name), spec: nz(r.spec), unit: nz(r.unit) || '개',
      inD: nz(r.in_date), e: nz(r.exp_date), qty: r3(r.qty),
      inp: r2(r.in_price), outp: r2(r.out_price), sup: nz(r.supplier)
    };
  }
  function fpStateFrom(prodRows, logRows, lotRows) {
    var fps = [], fpLogs = [], fpLots = [], i;
    prodRows = prodRows || []; logRows = logRows || [];
    for (i = 0; i < prodRows.length; i++) fps.push(fpProductFrom(prodRows[i]));
    for (i = 0; i < logRows.length; i++) fpLogs.push(fpLogFrom(logRows[i]));
    for (i = 0; i < (lotRows || []).length; i++) fpLots.push(fpLotFrom(lotRows[i]));
    return { fps: fps, fpLogs: fpLogs, fpLots: fpLots };
  }
  /* 한 상품의 로트(소비기한 빠른 순) */
  function fpLotsOf(fps, code) {
    var out = [], i, L;
    for (i = 0; i < (fps.fpLots || []).length; i++) {
      L = fps.fpLots[i];
      if (L.code === code) out.push(L);
    }
    out.sort(function (a, b) {
      var ae = a.e || '9999-99-99', be = b.e || '9999-99-99';
      if (ae !== be) return ae < be ? -1 : 1;
      var ai = a.inD || '9999-99-99', bi = b.inD || '9999-99-99';
      if (ai !== bi) return ai < bi ? -1 : 1;
      return a.id - b.id;
    });
    return out;
  }
  /* 재고 표에 뿌릴 줄 — 로트가 있으면 로트 단위, 없으면(v6 전 DB) 품목 단위 */
  function fpStockList(fps, fpLots) {
    fps = fps || []; fpLots = fpLots || [];
    if (!fpLots.length) return fps.slice();
    var out = [], byCode = {}, has = {}, i, p, L;
    var sorted = fpLots.slice().sort(function (a, b) {
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      var ae = a.e || '9999-99-99', be = b.e || '9999-99-99';
      if (ae !== be) return ae < be ? -1 : 1;
      var ai = a.inD || '9999-99-99', bi = b.inD || '9999-99-99';
      if (ai !== bi) return ai < bi ? -1 : 1;
      return Number(a.id) - Number(b.id);
    });
    for (i = 0; i < fps.length; i++) byCode[fps[i].code] = fps[i];
    for (i = 0; i < sorted.length; i++) {
      L = sorted[i];
      p = byCode[L.code];
      if (!p) continue;
      has[L.code] = 1;
      out.push({
        code: p.code, cat: p.cat, n: p.n, spec: p.spec || L.spec, unit: p.unit || L.unit,
        stock: L.qty, inp: L.inp > 0 ? L.inp : p.inp, outp: p.outp,
        amt: Math.round(L.qty * (L.inp > 0 ? L.inp : p.inp)),
        e: L.e, lot: L.lot, inD: L.inD, lotId: L.id, sup: p.sup, bc: p.bc, active: p.active,
        _lot: true
      });
    }
    /* 로트 줄이 하나도 없는 품목(초기 등록만 하고 입고 전)도 보이게 */
    for (i = 0; i < fps.length; i++) {
      p = fps[i];
      if (has[p.code]) continue;
      out.push({ code: p.code, cat: p.cat, n: p.n, spec: p.spec, unit: p.unit, stock: p.stock,
        inp: p.inp, outp: p.outp, amt: p.amt, e: p.e, lot: '', inD: '', lotId: null,
        sup: p.sup, bc: p.bc, active: p.active, _lot: false });
    }
    return out;
  }

  function fpTotals(fps) {
    var stock = 0, amt = 0, hold = 0, noPrice = 0, total = 0, active = 0, i, p;
    fps = fps || [];
    for (i = 0; i < fps.length; i++) {
      p = fps[i];
      total++;
      if (p.active) active++;
      if (p.stock > 0.0004) {
        hold++;
        stock += p.stock;
        amt += p.stock * p.inp;
        if (p.inp <= 0) noPrice++;
      }
    }
    return { stock: r3(stock), amount: Math.round(amt), hold: hold, noPrice: noPrice,
      total: total, active: active, priced: total - noPrice };
  }
  function fpToday(fps, fpLogs, d0) {
    var cnt = 0, amt = 0, i, g;
    for (i = 0; i < (fpLogs || []).length; i++) {
      g = fpLogs[i];
      if (g.d !== d0 || g.undone) continue;
      cnt++;
      amt += g.amt;
    }
    return { cnt: cnt, amount: Math.round(amt) };
  }

  /* ---------- 표 열 ---------- */
  var FP_COLS = {
    G: [
      { k: 'cat', t: '대분류', w: 86 },
      { k: 'code', t: '상품코드', w: 110 },
      { k: 'n', t: '상품명', w: 200 },
      { k: 'spec', t: '규격', w: 110 },
      { k: 'unit', t: '단위', w: 58 },
      { k: 'lot', t: '로트', w: 150 },
      { k: 'inD', t: '입고일', w: 104 },
      { k: 'e', t: '소비기한', w: 126 },
      { k: 'stock', t: '재고', w: 82, num: true },
      { k: 'inp', t: '입고단가', w: 96, num: true },
      { k: 'outp', t: '출고단가', w: 96, num: true },
      { k: 'amt', t: '재고금액', w: 112, num: true }
    ],
    L: [
      { k: 'd', t: '날짜', w: 100 },
      { k: 't', t: '구분', w: 62 },
      { k: 'code', t: '상품코드', w: 108 },
      { k: 'n', t: '상품명', w: 190 },
      { k: 'spec', t: '규격', w: 110 },
      { k: 'unit', t: '단위', w: 58 },
      { k: 'lot', t: '로트', w: 150 },
      { k: 'q', t: '수량', w: 78, num: true },
      { k: 'inp', t: '입고단가', w: 94, num: true },
      { k: 'outp', t: '출고단가', w: 94, num: true },
      { k: 'amt', t: '금액', w: 108, num: true },
      { k: 'e', t: '소비기한', w: 104 },
      { k: 'p', t: '거래처 · 비고', w: 170 },
      { k: 'worker', t: '작업자', w: 96 }
    ],
    P: [
      { k: 'cat', t: '대분류', w: 86 },
      { k: 'code', t: '상품코드', w: 110 },
      { k: 'n', t: '상품명', w: 220 },
      { k: 'spec', t: '규격', w: 120 },
      { k: 'unit', t: '단위', w: 58 },
      { k: 'stock', t: '재고', w: 82, num: true },
      { k: 'inp', t: '입고단가', w: 96, num: true },
      { k: 'outp', t: '출고단가', w: 96, num: true },
      { k: 'amt', t: '재고금액', w: 112, num: true }
    ]
  };
  function fpCols(tab) { return FP_COLS[tab] || FP_COLS.G; }

  function fpCell(p, k) {
    if (!p) return '';
    if (k === 'cat') return s(p.cat);
    if (k === 'code') return s(p.code);
    if (k === 'n') return s(p.n);
    if (k === 'spec') return s(p.spec);
    if (k === 'unit') return s(p.unit);
    if (k === 'stock') return r3(p.stock);
    if (k === 'inp') return p.inp > 0 ? String(p.inp) : '';
    if (k === 'outp') return p.outp > 0 ? String(p.outp) : '';
    if (k === 'amt') return p.inp > 0 ? String(p.amt) : '';
    if (k === 'e') return s(p.e);
    if (k === 'lot') return s(p.lot);
    if (k === 'inD') return s(p.inD);
    if (k === 'sup') return s(p.sup);
    if (k === 'bc') return s(p.bc);
    return '';
  }
  function fpLogCell(g, k) {
    if (!g) return '';
    if (k === 'd') return s(g.d);
    if (k === 't') return fpTypeName(g.t);
    if (k === 'code') return s(g.code);
    if (k === 'n') return s(g.n);
    if (k === 'spec') return s(g.spec);
    if (k === 'unit') return s(g.unit);
    if (k === 'q') return r3(g.q);
    if (k === 'inp') return g.t === 'IN' && g.inp > 0 ? String(g.inp) : '';
    if (k === 'outp') return g.t === 'OUT' && g.outp > 0 ? String(g.outp) : '';
    if (k === 'amt') return g.amt > 0 ? String(g.amt) : '';
    if (k === 'e') return s(g.e);
    if (k === 'lot') return s(g.lot);
    if (k === 'inD') return s(g.inD);
    if (k === 'p') return s(g.p) + (g.note ? ' · ' + s(g.note) : '');
    if (k === 'worker') return s(g.worker);
    return '';
  }

  function fpMatch(p, q) {
    if (!q) return true;
    if (!q) return true;
    return textHit([p.code, p.n, p.cat, p.spec, p.unit, p.sup, p.bc].join(' '), q);
  }
  function fpMoveCodes(fpLogs, from, to) {
    var m = {}, i, g;
    if (!from && !to) return null;
    for (i = 0; i < (fpLogs || []).length; i++) {
      g = fpLogs[i];
      if (g.undone) continue;
      if (from && g.d < from) continue;
      if (to && g.d > to) continue;
      m[g.code] = 1;
    }
    return m;
  }
  function fpFilteredProducts(fps, fpLogs, o) {
    o = o || {};
    var q = s(o.q).toLowerCase(), out = [], i, p, moved = fpMoveCodes(fpLogs, o.from, o.to);
    for (i = 0; i < (fps || []).length; i++) {
      p = fps[i];
      if (o.cat && o.cat !== 'all' && !fpCatMatch(p.cat, o.cat)) continue;
      if (o.activeOnly && !p.active) continue;
      if (!o.showZero && !(p.stock > 0.0004)) continue;
      if (moved && !moved[p.code]) continue;
      if (!fpMatch(p, q)) continue;
      out.push(p);
    }
    var key = o.sortKey || '', dir = o.sortDir === -1 ? -1 : 1;
    out.sort(function (a, b) {
      if (key) {
        var av = fpCell(a, key), bv = fpCell(b, key);
        var an = Number(av), bn = Number(bv);
        var c = (av !== '' && bv !== '' && isFinite(an) && isFinite(bn)) ? (an - bn) : String(av).localeCompare(String(bv), 'ko');
        if (c !== 0) return c * dir;
      }
      if (a.cat !== b.cat) return a.cat < b.cat ? -1 : 1;
      var an = String(a.n), bn = String(b.n);
      if (an !== bn) return an.localeCompare(bn, 'ko');
      var ae2 = a.e || '9999-99-99', be2 = b.e || '9999-99-99';
      if (ae2 !== be2) return ae2 < be2 ? -1 : 1;
      return String(a.lot || '').localeCompare(String(b.lot || ''));
    });
    return out;
  }
  function fpFilteredLogs(fpLogs, o) {
    o = o || {};
    var q = s(o.q).toLowerCase(), out = [], i, g, cols = o.cols || {};
    for (i = 0; i < (fpLogs || []).length; i++) {
      g = fpLogs[i];
      if (o.type && o.type !== 'all' && g.t !== o.type) continue;
      if (o.cat && o.cat !== 'all' && !fpCatMatch(g.cat, o.cat)) continue;
      if (o.from && g.d < o.from) continue;
      if (o.to && g.d > o.to) continue;
      if (q) {
        if (!textHit([g.d, fpTypeName(g.t), g.code, g.n, g.cat, g.spec, g.p, g.note, g.worker].join(' '), o.q)) continue;
      }
      var skip = false;
      for (var k in cols) {
        if (!Object.prototype.hasOwnProperty.call(cols, k)) continue;
        if (cols[k] && cols[k].length && cols[k].indexOf(String(fpLogCell(g, k))) < 0) { skip = true; break; }
      }
      if (skip) continue;
      out.push(g);
    }
    var key = o.sortKey || 'd', dir = o.sortKey ? (o.sortDir === -1 ? -1 : 1) : -1;
    out.sort(function (a, b) {
      var av = fpLogCell(a, key), bv = fpLogCell(b, key);
      var an = Number(av), bn = Number(bv);
      var c = (av !== '' && bv !== '' && isFinite(an) && isFinite(bn)) ? (an - bn) : String(av).localeCompare(String(bv), 'ko');
      if (c !== 0) return c * dir;
      return (b.id || 0) - (a.id || 0);
    });
    return out;
  }
  function fpProductOf(fps, code) {
    for (var i = 0; i < (fps || []).length; i++) if (fps[i].code === code) return fps[i];
    return null;
  }
  /* 상품명·코드로 찾기 (정확 → 부분, 하나만 남으면 그 상품) */
  function fpFind(fps, q) {
    q = s(q);
    if (!q) return null;
    var i, p, qu = q.toUpperCase(), hits = [];
    for (i = 0; i < (fps || []).length; i++) if (String(fps[i].code).toUpperCase() === qu) return fps[i];
    for (i = 0; i < (fps || []).length; i++) if (fps[i].n === q) return fps[i];
    var ql = q.toLowerCase();
    for (i = 0; i < (fps || []).length; i++) {
      p = fps[i];
      if ((p.n + ' ' + p.spec).toLowerCase().indexOf(ql) >= 0 || String(p.code).toLowerCase().indexOf(ql) >= 0) hits.push(p);
    }
    if (hits.length === 1) return hits[0];
    for (i = 0; i < hits.length; i++) if (hits[i].n.toLowerCase() === ql) return hits[i];
    return null;
  }
  /* 새 상품코드 — 기존 코드가 W00100016 형식이면 다음 번호, 아니면 P0001 형식 */
  function fpNextCode(fps) {
    var i, m, max = 0, allW = true, p;
    for (i = 0; i < (fps || []).length; i++) {
      p = fps[i];
      m = /^W(\d{8,})$/.exec(String(p.code).toUpperCase());
      if (!m) { allW = false; continue; }
      if (Number(m[1]) > max) max = Number(m[1]);
    }
    if (!(fps || []).length || allW) {
      var next = max ? max + 1 : 1;
      var pad = '00000000' + next;
      return 'W' + pad.slice(-8);
    }
    var n = 0;
    for (i = 0; i < fps.length; i++) {
      m = /^P(\d+)$/.exec(String(fps[i].code).toUpperCase());
      if (m && Number(m[1]) > n) n = Number(m[1]);
    }
    var t = '0000' + (n + 1);
    return 'P' + t.slice(-4);
  }

  /* ---------- 완제품 엑셀 양식 ---------- */
  var FP_TX_HEAD = ['날짜', '구분', '상품코드', '상품명', '규격', '단위', '수량', '입고단가', '출고단가', '로트번호', '입고일', '소비기한', '거래처', '비고'];
  var FP_PRICE_HEAD = ['상품코드', '상품명', '규격', '단위', '입고단가', '출고단가', '현재고'];
  function fpTxRows(fps, opt) {
    opt = opt || {};
    var rows = [FP_TX_HEAD.slice()];
    rows.push([s(opt.today) || ymd(new Date()), '입고', s(opt.sampleCode) || 'W00000001', s(opt.sampleName) || '예시 상품 — 지우고 쓰세요',
      '500g*2', '팩', 10, 3000, '', '', s(opt.today) || ymd(new Date()), '2027-01-01', '삼양사', '예시 줄입니다']);
    rows.push([s(opt.today) || ymd(new Date()), '출고', s(opt.sampleCode) || 'W00000001', '', '', '', 2, '', 4500, '', '', '', '미트박스', '상품명은 비워도 코드로 찾습니다']);
    return rows;
  }
  function fpPriceRows(fps) {
    var rows = [FP_PRICE_HEAD.slice()], list = (fps || []).slice().sort(function (a, b) { return a.code < b.code ? -1 : 1; }), i, p;
    for (i = 0; i < list.length; i++) {
      p = list[i];
      rows.push([p.code, p.n, p.spec, p.unit, p.inp > 0 ? p.inp : '', p.outp > 0 ? p.outp : '', p.stock]);
    }
    return rows;
  }
  function fpStockRows(list) {
    var rows = [['대분류', '상품코드', '상품명', '규격', '단위', '로트', '입고일', '소비기한', '재고', '입고단가', '출고단가', '재고금액', '매입처']];
    var q = 0, a = 0, i, p;
    for (i = 0; i < (list || []).length; i++) {
      p = list[i];
      q += p.stock; a += p.amt;
      rows.push([p.cat, p.code, p.n, p.spec, p.unit, p.lot || '', p.inD || '', p.e || '', p.stock, p.inp, p.outp, p.amt, p.sup]);
    }
    rows.push(['합계', '', '', '', '', '', '', '', r3(q), '', '', Math.round(a), '']);
    return rows;
  }
  function fpLogRows(list) {
    var rows = [['날짜', '구분', '상품코드', '상품명', '규격', '단위', '수량', '입고단가', '출고단가', '금액', '소비기한', '거래처', '비고', '작업자', '취소']];
    var i, g;
    for (i = 0; i < (list || []).length; i++) {
      g = list[i];
      rows.push([g.d, fpTypeName(g.t), g.code, g.n, g.spec, g.unit, g.q, g.inp || '', g.outp || '', g.amt || '',
        g.e, g.p, g.note, g.worker, g.undone ? '취소됨' : '']);
    }
    return rows;
  }

  /* ==========================================================================
     v4 · 회계 ERP (acc_vouchers · acc_payments · acc_expenses)
     ========================================================================== */
  var VAT_RATE = 0.1;
  var ACC_TYPE = { sale: '매출', purchase: '매입' };
  var ACC_TAX = { tax: '과세', free: '면세' };
  var ACC_DOC = { none: '미발행', issued: '발행', received: '수령' };
  var ACC_DOC_SHORT = { none: '미발행', issued: '발행완료', received: '수령완료' };
  var ACC_PAY = { 'in': '수금', out: '지급' };
  var ACC_METHODS = ['계좌이체', '카드', '현금', '어음', '기타'];
  var ACC_EXPENSE_CATS = ['택배비', '부자재', '전기세', '수도·가스', '임대료', '급여', '식대', '차량유지비', '수수료', '통신비', '세금·공과', '기타'];
  var ACC_INCOME_CATS = ['이자수익', '보조금', '기타수입', '기타'];

  function accTypeName(t) { return ACC_TYPE[t] || '매출'; }
  function accDocName(t, v) {
    if (t === 'purchase') return v === 'received' ? '수령완료' : '미수령';
    return v === 'issued' ? '발행완료' : '미발행';
  }
  /* 부가세 계산 — 과세면 10%, 금액이 부가세 포함이면 거꾸로 계산 */
  function accVat(amount, taxType, included) {
    var a = r2(amount), supply, vat;
    if (taxType === 'free') return { supply: a, vat: 0, total: a };
    if (included) {
      supply = Math.round(a / 1.1 * 100) / 100;
      vat = r2(a - supply);
      return { supply: supply, vat: vat, total: a };
    }
    vat = Math.round(a * VAT_RATE * 100) / 100;
    return { supply: a, vat: vat, total: r2(a + vat) };
  }
  function accVoucherFrom(r) {
    return {
      id: Number(r.id), d: nz(r.v_date), t: r.v_type === 'purchase' ? 'purchase' : 'sale',
      partner: nz(r.partner), tax: r.tax_type === 'free' ? 'free' : 'tax',
      supply: r2(r.supply_amount), vat: r2(r.vat_amount), total: r2(r.total_amount),
      doc: nz(r.tax_status) || 'none', note: nz(r.note), src: nz(r.source) || 'manual',
      srcKind: nz(r.source_kind), srcId: r.source_id === null || r.source_id === undefined ? null : Number(r.source_id),
      worker: nz(r.worker_name), at: nz(r.created_at)
    };
  }
  function accPaymentFrom(r) {
    return {
      id: Number(r.id), d: nz(r.p_date), partner: nz(r.partner),
      t: r.p_type === 'out' ? 'out' : 'in', amount: r2(r.amount),
      method: nz(r.method), note: nz(r.note), worker: nz(r.worker_name), at: nz(r.created_at)
    };
  }
  function accExpenseFrom(r) {
    return {
      id: Number(r.id), d: nz(r.e_date), t: r.e_type === 'income' ? 'income' : 'expense',
      cat: nz(r.category) || '기타', partner: nz(r.partner),
      supply: r2(r.supply_amount), vat: r2(r.vat_amount), amount: r2(r.amount),
      tax: r.tax_type === 'tax' ? 'tax' : 'free', method: nz(r.method), note: nz(r.note),
      worker: nz(r.worker_name), at: nz(r.created_at)
    };
  }
  function accStateFrom(vRows, pRows, eRows) {
    var vouchers = [], payments = [], expenses = [], i;
    for (i = 0; i < (vRows || []).length; i++) vouchers.push(accVoucherFrom(vRows[i]));
    for (i = 0; i < (pRows || []).length; i++) payments.push(accPaymentFrom(pRows[i]));
    for (i = 0; i < (eRows || []).length; i++) expenses.push(accExpenseFrom(eRows[i]));
    return { vouchers: vouchers, payments: payments, expenses: expenses };
  }

  function inPeriod(d, from, to) {
    d = s(d);
    if (!d) return true;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  }

  /* 거래처별 원장 — 매출·수금·미수 / 매입·지급·미지급 */
  function accLedger(acc, from, to, q) {
    var map = {}, order = [], i, row, k;
    function get(name) {
      k = s(name) || '(거래처 없음)';
      if (!map[k]) { map[k] = { partner: k, sale: 0, received: 0, receivable: 0, purchase: 0, paid: 0, payable: 0 }; order.push(k); }
      return map[k];
    }
    for (i = 0; i < acc.vouchers.length; i++) {
      row = acc.vouchers[i];
      if (!inPeriod(row.d, from, to)) continue;
      var L = get(row.partner);
      if (row.t === 'sale') L.sale += row.total; else L.purchase += row.total;
    }
    for (i = 0; i < acc.payments.length; i++) {
      row = acc.payments[i];
      if (!inPeriod(row.d, from, to)) continue;
      var P = get(row.partner);
      if (row.t === 'in') P.received += row.amount; else P.paid += row.amount;
    }
    var out = [], qq = s(q).toLowerCase();
    for (i = 0; i < order.length; i++) {
      var r = map[order[i]];
      r.sale = r2(r.sale); r.received = r2(r.received); r.purchase = r2(r.purchase); r.paid = r2(r.paid);
      r.receivable = r2(r.sale - r.received);
      r.payable = r2(r.purchase - r.paid);
      r.balance = r2(r.receivable - r.payable);
      if (qq && !textHit(r.partner, q)) continue;
      out.push(r);
    }
    out.sort(function (a, b) {
      var av = Math.abs(a.balance), bv = Math.abs(b.balance);
      if (av !== bv) return bv - av;
      return a.partner.localeCompare(b.partner, 'ko');
    });
    return out;
  }
  /* 전체 미수·미지급 합계 (기간 무관 — 지금 남은 돈) */
  function accBalance(acc) {
    var receivable = 0, payable = 0, i, r;
    var led = accLedger(acc, '', '', '');
    for (i = 0; i < led.length; i++) {
      r = led[i];
      if (r.receivable > 0) receivable += r.receivable;
      if (r.payable > 0) payable += r.payable;
    }
    return { receivable: Math.round(receivable), payable: Math.round(payable) };
  }
  /* 세금계산서 미발행(매출) / 미수령(매입) */
  function accTaxPending(acc, from, to) {
    var saleCnt = 0, saleAmt = 0, buyCnt = 0, buyAmt = 0, i, v;
    for (i = 0; i < acc.vouchers.length; i++) {
      v = acc.vouchers[i];
      if (!inPeriod(v.d, from, to)) continue;
      if (v.tax !== 'tax' || v.doc !== 'none') continue;
      if (v.t === 'sale') { saleCnt++; saleAmt += v.total; }
      else { buyCnt++; buyAmt += v.total; }
    }
    return { saleCnt: saleCnt, saleAmount: Math.round(saleAmt), buyCnt: buyCnt, buyAmount: Math.round(buyAmt) };
  }
  function ymKey(d) { return s(d).slice(0, 7); }
  function accMonthly(acc, from, to) {
    var map = {}, order = [], i, v, m;
    function get(mm) {
      if (!map[mm]) { map[mm] = { ym: mm, sale: 0, purchase: 0, expense: 0, income: 0, profit: 0 }; order.push(mm); }
      return map[mm];
    }
    for (i = 0; i < acc.vouchers.length; i++) {
      v = acc.vouchers[i];
      if (!inPeriod(v.d, from, to)) continue;
      m = get(ymKey(v.d));
      if (v.t === 'sale') m.sale += v.supply; else m.purchase += v.supply;
    }
    for (i = 0; i < acc.expenses.length; i++) {
      v = acc.expenses[i];
      if (!inPeriod(v.d, from, to)) continue;
      m = get(ymKey(v.d));
      if (v.t === 'income') m.income += v.supply; else m.expense += v.supply;
    }
    var out = [];
    for (i = 0; i < order.length; i++) {
      var r = map[order[i]];
      r.sale = Math.round(r.sale); r.purchase = Math.round(r.purchase);
      r.expense = Math.round(r.expense); r.income = Math.round(r.income);
      r.profit = Math.round(r.sale + r.income - r.purchase - r.expense);
      out.push(r);
    }
    out.sort(function (a, b) { return a.ym < b.ym ? 1 : (a.ym > b.ym ? -1 : 0); });
    return out;
  }
  /* 이번 달 요약 */
  function accTotals(acc, ym) {
    var sale = 0, purchase = 0, expense = 0, income = 0, i, v;
    for (i = 0; i < acc.vouchers.length; i++) {
      v = acc.vouchers[i];
      if (ymKey(v.d) !== ym) continue;
      if (v.t === 'sale') sale += v.supply; else purchase += v.supply;
    }
    for (i = 0; i < acc.expenses.length; i++) {
      v = acc.expenses[i];
      if (ymKey(v.d) !== ym) continue;
      if (v.t === 'income') income += v.supply; else expense += v.supply;
    }
    return { sale: Math.round(sale), purchase: Math.round(purchase), expense: Math.round(expense),
      income: Math.round(income), profit: Math.round(sale + income - purchase - expense) };
  }
  function accSum(acc, from, to) {
    var sale = 0, purchase = 0, expense = 0, income = 0, i, v;
    for (i = 0; i < acc.vouchers.length; i++) {
      v = acc.vouchers[i];
      if (!inPeriod(v.d, from, to)) continue;
      if (v.t === 'sale') sale += v.total; else purchase += v.total;
    }
    for (i = 0; i < acc.expenses.length; i++) {
      v = acc.expenses[i];
      if (!inPeriod(v.d, from, to)) continue;
      if (v.t === 'income') income += v.amount; else expense += v.amount;
    }
    return { sale: Math.round(sale), purchase: Math.round(purchase), expense: Math.round(expense), income: Math.round(income) };
  }

  /* ---------- 회계 표 열 ---------- */
  var ACC_COLS = {
    V: [
      { k: 'd', t: '전표일자', w: 104 },
      { k: 't', t: '구분', w: 74 },
      { k: 'partner', t: '거래처', w: 180 },
      { k: 'tax', t: '과세', w: 72 },
      { k: 'supply', t: '공급가액', w: 116, num: true },
      { k: 'vat', t: '부가세', w: 104, num: true },
      { k: 'total', t: '합계금액', w: 120, num: true },
      { k: 'doc', t: '세금계산서', w: 112 },
      { k: 'src', t: '출처', w: 92 },
      { k: 'note', t: '적요', w: 210 }
    ],
    R: [
      { k: 'partner', t: '거래처', w: 180 },
      { k: 'sale', t: '총 매출', w: 116, num: true },
      { k: 'received', t: '총 수금', w: 116, num: true },
      { k: 'receivable', t: '남은 미수금', w: 126, num: true },
      { k: 'purchase', t: '총 매입', w: 116, num: true },
      { k: 'paid', t: '총 지급', w: 116, num: true },
      { k: 'payable', t: '남은 미지급금', w: 130, num: true },
      { k: 'balance', t: '미수금−미지급금', w: 130, num: true }
    ],
    E: [
      { k: 'd', t: '날짜', w: 104 },
      { k: 't', t: '구분', w: 62 },
      { k: 'cat', t: '항목', w: 116 },
      { k: 'partner', t: '거래처 · 적요', w: 200 },
      { k: 'supply', t: '공급가액', w: 112, num: true },
      { k: 'vat', t: '부가세', w: 100, num: true },
      { k: 'amount', t: '금액', w: 118, num: true },
      { k: 'method', t: '수단', w: 88 }
    ],
    M: [
      { k: 'ym', t: '월', w: 96 },
      { k: 'sale', t: '매출', w: 130, num: true },
      { k: 'purchase', t: '매입원가', w: 130, num: true },
      { k: 'expense', t: '일반경비', w: 130, num: true },
      { k: 'income', t: '기타수입', w: 110, num: true },
      { k: 'profit', t: '순이익', w: 130, num: true }
    ],
    /* v8: 구매관리 · 판매관리 전용 (같은 전표를 종류별로 나눠 본다) */
    B: [
      { k: 'd', t: '전표일자', w: 104 },
      { k: 'partner', t: '거래처', w: 180 },
      { k: 'supply', t: '공급가액', w: 116, num: true },
      { k: 'vat', t: '부가세', w: 100, num: true },
      { k: 'total', t: '합계금액', w: 120, num: true },
      { k: 'doc', t: '세금계산서', w: 112 },
      { k: 'src', t: '출처', w: 92 },
      { k: 'note', t: '적요', w: 200 }
    ],
    S: [
      { k: 'd', t: '전표일자', w: 104 },
      { k: 'partner', t: '거래처', w: 180 },
      { k: 'supply', t: '공급가액', w: 116, num: true },
      { k: 'vat', t: '부가세', w: 100, num: true },
      { k: 'total', t: '합계금액', w: 120, num: true },
      { k: 'doc', t: '세금계산서', w: 112 },
      { k: 'src', t: '출처', w: 92 },
      { k: 'note', t: '적요', w: 200 }
    ]
  };
  function accCols(tab) { return ACC_COLS[tab] || ACC_COLS.V; }
  function voucherCols(kind) { return ACC_COLS[kind === 'buy' ? 'B' : 'S']; }
  function accCell(r, k) {
    if (!r) return '';
    if (k === 'd') return s(r.d);
    if (k === 't') return ACC_TYPE[r.t] || (r.t === 'income' ? '수입' : '경비');
    if (k === 'partner') return s(r.partner);
    if (k === 'tax') return ACC_TAX[r.tax] || '';
    if (k === 'supply') return String(r.supply);
    if (k === 'vat') return String(r.vat);
    if (k === 'total') return String(r.total);
    if (k === 'doc') return ACC_DOC[r.doc] || '';
    if (k === 'src') return r.src === 'meat' ? '원료육' : (r.src === 'fp' ? '완제품' : '직접');
    if (k === 'note') return s(r.note);
    if (k === 'sale') return String(r.sale);
    if (k === 'received') return String(r.received);
    if (k === 'receivable') return String(r.receivable);
    if (k === 'purchase') return String(r.purchase);
    if (k === 'paid') return String(r.paid);
    if (k === 'payable') return String(r.payable);
    if (k === 'balance') return String(r.balance);
    if (k === 'cat') return s(r.cat);
    if (k === 'amount') return String(r.amount);
    if (k === 'method') return s(r.method);
    if (k === 'ym') return s(r.ym);
    if (k === 'expense') return String(r.expense);
    if (k === 'income') return String(r.income);
    if (k === 'profit') return String(r.profit);
    return '';
  }
  function accFilterVouchers(acc, o) {
    o = o || {};
    var q = s(o.q).toLowerCase(), out = [], i, v, cols = o.cols || {};
    for (i = 0; i < acc.vouchers.length; i++) {
      v = acc.vouchers[i];
      if (o.type && o.type !== 'all' && v.t !== o.type) continue;
      if (!inPeriod(v.d, o.from, o.to)) continue;
      if (q) {
        if (!textHit([v.d, accTypeName(v.t), v.partner, ACC_TAX[v.tax], v.note, accDocName(v.t, v.doc)].join(' '), o.q)) continue;
      }
      var skip = false;
      for (var k in cols) {
        if (!Object.prototype.hasOwnProperty.call(cols, k)) continue;
        if (cols[k] && cols[k].length && cols[k].indexOf(String(accCell(v, k))) < 0) { skip = true; break; }
      }
      if (skip) continue;
      out.push(v);
    }
    var key = o.sortKey || 'd', dir = o.sortKey ? (o.sortDir === -1 ? -1 : 1) : -1;
    out.sort(function (a, b) {
      var av = accCell(a, key), bv = accCell(b, key);
      var an = Number(av), bn = Number(bv);
      var c = (av !== '' && bv !== '' && isFinite(an) && isFinite(bn)) ? (an - bn) : String(av).localeCompare(String(bv), 'ko');
      if (c !== 0) return c * dir;
      return (b.id || 0) - (a.id || 0);
    });
    return out;
  }
  function accFilterExpenses(acc, o) {
    o = o || {};
    var q = s(o.q).toLowerCase(), out = [], i, v, cols = o.cols || {};
    for (i = 0; i < acc.expenses.length; i++) {
      v = acc.expenses[i];
      if (o.type && o.type !== 'all' && v.t !== o.type) continue;
      if (!inPeriod(v.d, o.from, o.to)) continue;
      if (q) {
        if (!textHit([v.d, v.cat, v.partner, v.note, v.method, v.t === 'income' ? '수입' : '경비'].join(' '), o.q)) continue;
      }
      var skip = false;
      for (var k in cols) {
        if (!Object.prototype.hasOwnProperty.call(cols, k)) continue;
        if (cols[k] && cols[k].length && cols[k].indexOf(String(accCell(v, k))) < 0) { skip = true; break; }
      }
      if (skip) continue;
      out.push(v);
    }
    out.sort(function (a, b) {
      if (a.d !== b.d) return a.d < b.d ? 1 : -1;
      return (b.id || 0) - (a.id || 0);
    });
    return out;
  }

  /* 회계 내려받기용 행 */
  function accVoucherRows(list) {
    var rows = [['전표일자', '구분', '거래처', '과세구분', '공급가액', '부가세', '합계금액', '세금계산서', '출처', '적요']];
    for (var i = 0; i < (list || []).length; i++) {
      var v = list[i];
      rows.push([v.d, accTypeName(v.t), v.partner, ACC_TAX[v.tax], v.supply, v.vat, v.total,
        accDocName(v.t, v.doc), accCell(v, 'src'), v.note]);
    }
    return rows;
  }
  function accLedgerRows(list) {
    var rows = [['거래처', '총 매출', '총 수금', '남은 미수금', '총 매입', '총 지급', '남은 미지급금', '미수금−미지급금']];
    for (var i = 0; i < (list || []).length; i++) {
      var r = list[i];
      rows.push([r.partner, r.sale, r.received, r.receivable, r.purchase, r.paid, r.payable, r.balance]);
    }
    return rows;
  }
  function accExpenseRows(list) {
    var rows = [['날짜', '구분', '항목', '거래처', '공급가액', '부가세', '금액', '수단', '적요']];
    for (var i = 0; i < (list || []).length; i++) {
      var v = list[i];
      rows.push([v.d, v.t === 'income' ? '수입' : '경비', v.cat, v.partner, v.supply, v.vat, v.amount, v.method, v.note]);
    }
    return rows;
  }
  function accMonthRows(list) {
    var rows = [['월', '매출', '매입원가', '일반경비', '기타수입', '순이익']], sum = [0, 0, 0, 0, 0], i, r;
    for (i = 0; i < (list || []).length; i++) {
      r = list[i];
      rows.push([r.ym, r.sale, r.purchase, r.expense, r.income, r.profit]);
      sum[0] += r.sale; sum[1] += r.purchase; sum[2] += r.expense; sum[3] += r.income; sum[4] += r.profit;
    }
    if (list && list.length) rows.push(['합계', sum[0], sum[1], sum[2], sum[3], sum[4]]);
    return rows;
  }

  /* ==========================================================================
     엑셀 읽기 — 외부 라이브러리 없이 ZIP + deflate 를 직접 푼다
     (인터넷이 막혀도 .xlsx 업로드가 된다. .csv 도 받는다)
     ========================================================================== */
  function inflateRaw(src, outLen) {
    var out = new Uint8Array(outLen > 0 ? outLen + 64 : Math.max(256, src.length * 8 + 256));
    var op = 0, pos = 0, bitbuf = 0, bitcnt = 0;
    var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    function ensure(n) {
      if (op + n <= out.length) return;
      var o2 = new Uint8Array(Math.max(out.length * 2, op + n + 256));
      o2.set(out);
      out = o2;
    }
    function bits(n) {
      while (bitcnt < n) {
        if (pos >= src.length) throw new Error('압축 데이터가 일찍 끝났습니다.');
        bitbuf |= src[pos++] << bitcnt;
        bitcnt += 8;
      }
      var v = bitbuf & ((1 << n) - 1);
      bitbuf >>>= n;
      bitcnt -= n;
      return v;
    }
    function buildHuff(lens) {
      var counts = [], maxBits = 0, i, sym;
      for (i = 0; i < 16; i++) counts[i] = 0;
      for (sym = 0; sym < lens.length; sym++) {
        if (lens[sym] > 0) { counts[lens[sym]]++; if (lens[sym] > maxBits) maxBits = lens[sym]; }
      }
      var next = [], code = 0;
      counts[0] = 0;
      for (i = 1; i <= 15; i++) { code = (code + counts[i - 1]) << 1; next[i] = code; }
      var map = {};
      for (sym = 0; sym < lens.length; sym++) {
        var len = lens[sym];
        if (!len) continue;
        map[len * 65536 + next[len]] = sym;
        next[len]++;
      }
      return { maxBits: maxBits, map: map };
    }
    function decode(h) {
      var code = 0, len;
      for (len = 1; len <= h.maxBits; len++) {
        code = (code << 1) | bits(1);
        var sym = h.map[len * 65536 + code];
        if (sym !== undefined) return sym;
      }
      throw new Error('압축 데이터를 읽지 못했습니다.');
    }
    var fixedLit = null, fixedDist = null;
    function fixed() {
      if (!fixedLit) {
        var l = [], i;
        for (i = 0; i < 144; i++) l[i] = 8;
        for (i = 144; i < 256; i++) l[i] = 9;
        for (i = 256; i < 280; i++) l[i] = 7;
        for (i = 280; i < 288; i++) l[i] = 8;
        fixedLit = buildHuff(l);
        var d = [];
        for (i = 0; i < 30; i++) d[i] = 5;
        fixedDist = buildHuff(d);
      }
    }
    var last = 0;
    while (!last) {
      last = bits(1);
      var type = bits(2);
      if (type === 0) {
        bitbuf = 0; bitcnt = 0;
        if (pos + 4 > src.length) throw new Error('압축 데이터가 일찍 끝났습니다.');
        var len = src[pos] | (src[pos + 1] << 8);
        pos += 4;
        ensure(len);
        for (var s0 = 0; s0 < len; s0++) out[op++] = src[pos++];
      } else if (type === 1) {
        fixed();
        for (;;) {
          var sym1 = decode(fixedLit);
          if (sym1 < 256) { ensure(1); out[op++] = sym1; }
          else if (sym1 === 256) break;
          else {
            var li = sym1 - 257;
            var length = LBASE[li] + bits(LEXT[li]);
            var ds = decode(fixedDist);
            var dist = DBASE[ds] + bits(DEXT[ds]);
            ensure(length);
            for (var k1 = 0; k1 < length; k1++) { out[op] = out[op - dist]; op++; }
          }
        }
      } else if (type === 2) {
        var hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
        var order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        var clens = [], i2;
        for (i2 = 0; i2 < 19; i2++) clens[i2] = 0;
        for (i2 = 0; i2 < hclen; i2++) clens[order[i2]] = bits(3);
        var ch = buildHuff(clens);
        var lens2 = [], n2 = 0;
        while (n2 < hlit + hdist) {
          var cs = decode(ch);
          if (cs < 16) { lens2[n2++] = cs; }
          else if (cs === 16) {
            var rep = 3 + bits(2), pv = lens2[n2 - 1];
            while (rep--) lens2[n2++] = pv;
          } else if (cs === 17) {
            var rep2 = 3 + bits(3);
            while (rep2--) lens2[n2++] = 0;
          } else {
            var rep3 = 11 + bits(7);
            while (rep3--) lens2[n2++] = 0;
          }
        }
        var litLens = lens2.slice(0, hlit), distLens = lens2.slice(hlit, hlit + hdist);
        var litH = buildHuff(litLens), distH = buildHuff(distLens);
        for (;;) {
          var sym2 = decode(litH);
          if (sym2 < 256) { ensure(1); out[op++] = sym2; }
          else if (sym2 === 256) break;
          else {
            var li2 = sym2 - 257;
            var length2 = LBASE[li2] + bits(LEXT[li2]);
            var dcode = decode(distH);
            var dist2 = DBASE[dcode] + bits(DEXT[dcode]);
            ensure(length2);
            for (var k2 = 0; k2 < length2; k2++) { out[op] = out[op - dist2]; op++; }
          }
        }
      } else {
        throw new Error('지원하지 않는 압축 방식입니다.');
      }
    }
    return out.subarray(0, op);
  }

  function unzip(bytes) {
    var i, eocd = -1;
    for (i = bytes.length - 22; i >= 0 && i >= bytes.length - 66000; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('엑셀(ZIP) 파일이 아닙니다.');
    function u16(p) { return bytes[p] | (bytes[p + 1] << 8); }
    function u32(p) { return (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0; }
    var count = u16(eocd + 10), cdOff = u32(eocd + 16), p = cdOff, files = {};
    for (i = 0; i < count; i++) {
      if (u32(p) !== 0x02014b50) break;
      var nameLen = u16(p + 28), extraLen = u16(p + 30), cmtLen = u16(p + 32);
      var method = u16(p + 10), csize = u32(p + 20), usize = u32(p + 24), lho = u32(p + 42);
      var name = '';
      for (var j = 0; j < nameLen; j++) name += String.fromCharCode(bytes[p + 46 + j]);
      var lnl = u16(lho + 26), lel = u16(lho + 28), start = lho + 30 + lnl + lel;
      var raw = bytes.subarray(start, start + csize);
      var data;
      if (method === 0) data = raw;
      else if (method === 8) data = inflateRaw(raw, usize);
      else throw new Error('엑셀 안의 압축 방식을 풀 수 없습니다.');
      files[name] = data;
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return files;
  }
  function bytesToStr(b) {
    var out = [], i, c, c2;
    for (i = 0; i < b.length; i++) {
      c = b[i];
      if (c < 0x80) out.push(String.fromCharCode(c));
      else if (c < 0xE0) out.push(String.fromCharCode(((c & 0x1F) << 6) | (b[++i] & 0x3F)));
      else if (c < 0xF0) { c2 = b[++i]; out.push(String.fromCharCode(((c & 0x0F) << 12) | ((c2 & 0x3F) << 6) | (b[++i] & 0x3F))); }
      else {
        var cp = ((c & 0x07) << 18) | ((b[++i] & 0x3F) << 12) | ((b[++i] & 0x3F) << 6) | (b[++i] & 0x3F);
        cp -= 0x10000;
        out.push(String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)));
      }
    }
    return out.join('');
  }
  function xmlText(v) {
    return String(v || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(Number(d)); })
      .replace(/&amp;/g, '&');
  }
  function tagTexts(sv, tag) {
    var re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'g'), m, out = [];
    while ((m = re.exec(sv))) out.push(xmlText(m[1].replace(/<[^>]+>/g, '')));
    return out;
  }
  function colIndex(ref) {
    var m = /^([A-Z]+)/.exec(String(ref || '').toUpperCase());
    if (!m) return -1;
    var n = 0;
    for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
    return n - 1;
  }
  /* .xlsx 바이트 → 2차원 배열 (첫 시트) */
  function xlsxRows(bytes) {
    var files = unzip(bytes);
    var shared = [];
    if (files['xl/sharedStrings.xml']) {
      var ss = bytesToStr(files['xl/sharedStrings.xml']);
      var re = /<si[^>]*>([\s\S]*?)<\/si>/g, m;
      while ((m = re.exec(ss))) {
        var ts = tagTexts(m[1], 't');
        shared.push(ts.join(''));
      }
    }
    var sheetName = 'xl/worksheets/sheet1.xml';
    if (!files[sheetName]) {
      for (var k in files) if (Object.prototype.hasOwnProperty.call(files, k) && /^xl\/worksheets\/sheet\d+\.xml$/.test(k)) { sheetName = k; break; }
    }
    if (!files[sheetName]) throw new Error('엑셀에서 표(시트)를 찾지 못했습니다.');
    var sx = bytesToStr(files[sheetName]);
    var rows = [], rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g, rm;
    while ((rm = rowRe.exec(sx))) {
      var cells = [], cellRe = /<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cm;
      while ((cm = cellRe.exec(rm[1]))) {
        var attrs = cm[1] || '', inner = cm[2] || '';
        var refM = /r="([A-Z]+\d+)"/.exec(attrs);
        var idx = refM ? colIndex(refM[1]) : cells.length;
        if (idx < 0) idx = cells.length;
        var tM = /t="([^"]+)"/.exec(attrs);
        var type = tM ? tM[1] : 'n';
        var val = '';
        if (type === 'inlineStr') {
          val = tagTexts(inner, 't').join('');
        } else {
          var vm = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner);
          var raw = vm ? xmlText(vm[1]) : '';
          if (type === 's') val = shared[Number(raw)] !== undefined ? shared[Number(raw)] : '';
          else if (type === 'b') val = raw === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'str') val = raw;
          else if (raw === '') val = '';
          else val = isFinite(Number(raw)) ? Number(raw) : raw;
        }
        while (cells.length < idx) cells.push('');
        cells[idx] = val;
      }
      rows.push(cells);
    }
    return rows;
  }
  /* .csv 텍스트 → 2차원 배열 */
  function csvRows(text) {
    text = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var rows = [], row = [], cell = '', q = false, i, ch;
    for (i = 0; i < text.length; i++) {
      ch = text.charAt(i);
      if (q) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { cell += '"'; i++; }
          else q = false;
        } else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',' || ch === '\t') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /* ---------- 업로드 양식 읽기 (머리글 이름은 조금 달라도 된다) ---------- */
  function toDateStr(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' && v > 20000 && v < 80000) {
      var dt = new Date(Math.round((v - 25569) * 86400 * 1000));
      return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
    }
    var t = String(v).replace(/^\s+|\s+$/g, '');
    var m = /^(\d{4})[.\-\/년\s]+(\d{1,2})[.\-\/월\s]+(\d{1,2})/.exec(t);
    if (m) return m[1] + '-' + pad2(Number(m[2])) + '-' + pad2(Number(m[3]));
    m = /^(\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})$/.exec(t);
    if (m) return (Number(m[1]) < 70 ? '20' : '19') + m[1] + '-' + pad2(Number(m[2])) + '-' + pad2(Number(m[3]));
    return '';
  }
  function toNum(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var t = String(v).replace(/[, \u20a9\ufeff]/g, '').replace(/원|개|kg|팩|박스|봉|병|g|L|ml/gi, '');
    var neg = /^\(.*\)$/.test(t);
    t = t.replace(/[()]/g, '');
    var n = Number(t);
    if (!isFinite(n)) return 0;
    return neg ? -n : n;
  }
  function normHead(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[\s\(\)\[\]\/\*\-]/g, '').toLowerCase();
  }
  var HEAD_MAP = {
    date: ['날짜', '일자', '거래일', '거래일자', '입출고일', '전표일자', 'txdate', 'date'],
    type: ['구분', '입출고', '입출고구분', '종류', 'type'],
    code: ['상품코드', '코드', '출고상품코드', '품목코드', 'code'],
    name: ['상품명', '품목명', '출고상품명', '품명', 'name', '적요', '내용'],
    spec: ['규격', '사이즈', 'spec'],
    unit: ['단위', 'unit'],
    qty: ['수량', '중량', 'qty', '입출고수량'],
    inprice: ['입고단가', '매입단가', '원가', 'inprice'],
    outprice: ['출고단가', '판매단가', '단가', 'outprice', 'price'],
    expiry: ['소비기한', 'expiry'],
    lot: ['로트', '로트번호', '로트번호/코드', 'lot', 'lotno'],
    ind: ['입고일', '입고일자', 'indate'],
    partner: ['거래처', '거래처명', '업체명', '매입처', 'partner', '사용처'],
    note: ['비고', '메모', 'note'],
    amount: ['금액', '합계', '합계금액', 'amount', 'total'],
    supply: ['공급가액', '공급가', 'supply'],
    vat: ['부가세', '세액', '부가세액', 'vat'],
    out: ['출금', '지출', '출금액', 'withdraw'],
    'in': ['입금', '수입', '입금액', 'deposit'],
    category: ['항목', '분류', '카테고리', 'category'],
    method: ['수단', '결제수단', '카드', 'method']
  };
  function mapHeader(row) {
    var map = {}, i, key, list, j, h;
    for (i = 0; i < row.length; i++) {
      h = normHead(row[i]);
      if (!h) continue;
      for (key in HEAD_MAP) {
        if (!Object.prototype.hasOwnProperty.call(HEAD_MAP, key)) continue;
        if (map[key] !== undefined) continue;
        list = HEAD_MAP[key];
        for (j = 0; j < list.length; j++) {
          if (h === normHead(list[j])) { map[key] = i; break; }
        }
      }
      /* '기한'으로 끝나는 열은 소비기한 열로 본다 (예전 양식의 머리글도 읽는다) */
      if (map.expiry === undefined && h.length >= 2 && h.slice(-2) === '기한') map.expiry = i;
    }
    return map;
  }
  /* kind: 'fp_tx' | 'fp_price' | 'acc_expense' */
  function parseSheet(rows, kind) {
    var out = [], skipped = 0, i, headIdx = -1, map = null, m;
    if (!rows || !rows.length) return { rows: out, skipped: 0, error: '읽을 줄이 없습니다.' };
    for (i = 0; i < Math.min(15, rows.length); i++) {
      m = mapHeader(rows[i] || []);
      if (m.qty !== undefined || m.price !== undefined || m.name !== undefined || m.code !== undefined ||
          m.amount !== undefined || m.out !== undefined || m['in'] !== undefined) {
        headIdx = i; map = m; break;
      }
    }
    if (headIdx < 0) return { rows: out, skipped: 0, error: '머리글 줄을 찾지 못했습니다. 양식의 열 이름을 확인해 주세요.' };
    function cell(row, k) { return map[k] === undefined ? '' : row[map[k]]; }
    for (i = headIdx + 1; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r.length) continue;
      if (kind === 'fp_tx') {
        var qty = toNum(cell(r, 'qty'));
        var code = s(cell(r, 'code')), name = s(cell(r, 'name'));
        if (!(qty > 0) || (!code && !name)) { if (name || code) skipped++; continue; }
        var tn = s(cell(r, 'type'));
        var type = (/출고|OUT|판매|반품|출하/i.test(tn)) ? 'OUT' : 'IN';
        out.push({
          date: toDateStr(cell(r, 'date')), type: type, code: code, name: name,
          spec: s(cell(r, 'spec')), unit: s(cell(r, 'unit')), qty: qty,
          price: toNum(cell(r, 'inprice')) || toNum(cell(r, 'outprice')) || 0,
          expiry: toDateStr(cell(r, 'expiry')), partner: s(cell(r, 'partner')),
          lot_no: s(cell(r, 'lot')), in_date: toDateStr(cell(r, 'ind')),
          note: s(cell(r, 'note'))
        });
      } else if (kind === 'fp_price') {
        var c2 = s(cell(r, 'code')), n2 = s(cell(r, 'name'));
        if (!c2 && !n2) { skipped++; continue; }
        var ip = cell(r, 'inprice'), op = cell(r, 'outprice');
        out.push({
          code: c2, name: n2, spec: s(cell(r, 'spec')), unit: s(cell(r, 'unit')),
          in_price: ip === '' ? null : toNum(ip), out_price: op === '' ? null : toNum(op)
        });
      } else {
        var outAmt = toNum(cell(r, 'out')), inAmt = toNum(cell(r, 'in'));
        var amt = toNum(cell(r, 'amount'));
        var isIncome = inAmt > 0 && outAmt <= 0;
        var val = outAmt > 0 ? outAmt : (inAmt > 0 ? inAmt : amt);
        if (!(val > 0)) { skipped++; continue; }
        out.push({
          date: toDateStr(cell(r, 'date')), type: isIncome ? 'income' : 'expense',
          category: s(cell(r, 'category')), partner: s(cell(r, 'partner')),
          amount: val, tax_type: 'free', method: s(cell(r, 'method')),
          note: s(cell(r, 'name')) || s(cell(r, 'note'))
        });
      }
    }
    return { rows: out, skipped: skipped, error: out.length ? '' : '올릴 줄이 없습니다. 양식의 열 이름을 확인해 주세요.' };
  }

  /* ==========================================================================
     v8.1 — 거래처 DB(2,350) + 스마트 부분검색(공백 토큰 AND)
       partners_data.js 가 window.MIRS_PARTNERS 에 [열 배열] 로 담아 둔다.
       검색은 '알전' → '알전각', '자 슈프' → '탐나는피자 슈프림불고기' 처럼
       공백으로 나눈 모든 토큰이 들어 있으면 맞는 것으로 본다.
     ========================================================================== */
  var PARTNER_KEYS = ['no', 'n', 'a', 'k', 'tel', 'hp', 'fax', 'own', 'addr', 'biz', 'item', 'acct', 'email', 'mgr', 'mgrTel'];
  var PARTNERS = [], PARTNER_BY_NAME = {};
  function bizDigits(v) { return String(v === null || v === undefined ? '' : v).replace(/[^0-9]/g, ''); }
  function bizFmt(v) {
    var d = bizDigits(v);
    if (d.length === 10) return d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5);
    return s(v);
  }
  function partnerLoad(head, rows) {
    var keys = (head && head.length) ? head : PARTNER_KEYS;
    var out = [], map = {}, i, j, r, p, hay;
    for (i = 0; i < (rows || []).length; i++) {
      r = rows[i] || [];
      p = {};
      for (j = 0; j < keys.length; j++) p[keys[j]] = s(r[j]);
      if (!p.n && !p.no) continue;
      p.noFmt = bizFmt(p.no);
      p.off = /^\(사용안함\)/.test(p.a) || /^\(사용안함\)/.test(p.n);
      hay = [p.n, p.a, p.own, p.biz, p.item, p.addr, p.tel, p.fax, p.no, p.noFmt].join(' ').toLowerCase();
      p.hay = hay;
      out.push(p);
      if (p.n && !map[p.n]) map[p.n] = p;
      if (p.a && !map[p.a]) map[p.a] = p;
    }
    PARTNERS = out; PARTNER_BY_NAME = map;
    return out.length;
  }
  function partnerList() { return PARTNERS; }
  function partnerCount() { return PARTNERS.length; }
  function partnerByName(name) { var t = s(name); return t ? (PARTNER_BY_NAME[t] || null) : null; }
  /* ---------- 공백 토큰 AND 검색 ---------- */
  function smartTokens(q) {
    var t = String(q === null || q === undefined ? '' : q).toLowerCase();
    t = t.replace(/[·,;:\/\\()\[\]{}"'`]+/g, ' ');
    var arr = t.split(/\s+/), out = [], i;
    for (i = 0; i < arr.length; i++) if (arr[i]) out.push(arr[i]);
    return out;
  }
  function smartHit(hay, q) {
    var toks = smartTokens(q), i, h = String(hay === null || hay === undefined ? '' : hay).toLowerCase();
    if (!toks.length) return true;
    for (i = 0; i < toks.length; i++) {
      if (h.indexOf(toks[i]) >= 0) continue;
      if (/^[ㄱ-ㅎ]+$/.test(toks[i]) && chosung(h).indexOf(toks[i]) >= 0) continue;
      return false;
    }
    return true;
  }
  /* 0 = 정확히 같음 · 1 = 앞에서 시작 · 2 = 통째로 포함 · 3 = 토큰이 단어 앞 · 4 = 토큰 포함 · -1 = 안 맞음 */
  function smartScore(hay, q, label) {
    var qq = s(q).toLowerCase();
    if (!qq) return 0;
    var h = String(hay === null || hay === undefined ? '' : hay).toLowerCase();
    var l = String(label === null || label === undefined ? '' : label).toLowerCase();
    if (l === qq) return 0;
    if (l.indexOf(qq) === 0) return 1;
    if (h.indexOf(qq) >= 0) return 2;
    if (!smartHit(h, q)) return -1;
    var toks = smartTokens(q), i, atStart = true, tk;
    for (i = 0; i < toks.length; i++) {
      tk = toks[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp('(^|[\\s·,;:/(\\[-])' + tk).test(h)) { atStart = false; break; }
    }
    return atStart ? 3 : 4;
  }
  /* items: [{v: 값, t: 제목, s: 보조설명, h: 검색용 문자열}] → 순위 정렬 */
  function smartPick(items, q, limit) {
    var qq = s(q), out = [], i, it, sc;
    var list = items || [];
    if (!qq) { for (i = 0; i < list.length && (!limit || out.length < limit); i++) out.push(list[i]); return out; }
    var ranked = [];
    for (i = 0; i < list.length; i++) {
      it = list[i];
      sc = smartScore(it.h || it.v, qq, it.t || it.v);
      if (sc < 0) continue;
      ranked.push({ it: it, sc: sc, len: String(it.t || it.v || '').length, ord: i });
    }
    ranked.sort(function (a, b) {
      if (a.sc !== b.sc) return a.sc - b.sc;
      if (a.len !== b.len) return a.len - b.len;
      return a.ord - b.ord;
    });
    for (i = 0; i < ranked.length && (!limit || out.length < limit); i++) out.push(ranked[i].it);
    return out;
  }
  /* 거래처 이름·별칭·사업자번호로 한 건 찾기 */
  function partnerOf(q) {
    var t = s(q);
    if (!t) return null;
    var i, p, d = bizDigits(t);
    if (d.length === 10) for (i = 0; i < PARTNERS.length; i++) if (PARTNERS[i].no === d) return PARTNERS[i];
    p = partnerByName(t);
    if (p) return p;
    var hit = smartPick(partnerItems(), t, 1);
    return hit.length ? hit[0].p : null;
  }
  function partnerItems() {
    var out = [], i, p;
    for (i = 0; i < PARTNERS.length; i++) {
      p = PARTNERS[i];
      out.push({
        p: p, v: p.n, t: p.n, h: p.hay,
        s: [p.a && p.a !== p.n ? p.a : '', p.noFmt, p.own, p.addr].filter(function (x) { return !!x; }).join(' · ')
          + (p.off ? '  (사용안함)' : '')
      });
    }
    return out;
  }
  function partnerSuggest(q, limit) {
    return smartPick(partnerItems(), q, limit || 12);
  }
  /* 명세표 공급받는자 칸 — 거래처 DB에서 등록번호·상호·주소·전화·팩스·대표자를 채운다 */
  function partnerBuyer(nameOrPartner) {
    var p = (nameOrPartner && nameOrPartner.n !== undefined) ? nameOrPartner : partnerOf(nameOrPartner);
    if (!p) return { name: s(nameOrPartner && nameOrPartner.n !== undefined ? nameOrPartner.n : nameOrPartner), bizNo: '', owner: '', addr: '', tel: '', fax: '', found: false };
    return {
      name: p.n, alias: p.a, bizNo: p.noFmt, owner: p.own, addr: p.addr,
      tel: p.tel || p.hp || '', fax: p.fax, biz: p.biz, item: p.item, found: true
    };
  }

  return {
    EPS: EPS, r2: r2, r0: r0, MAJORS: MAJORS, MAJOR_DEFAULT: MAJOR_DEFAULT, majorName: majorName,
    MEATS: MEATS, meatName: meatName,
    DESTS: DEST_KEYS, DEST_NAME: DEST_NAME, DEST_LABEL: DEST_LABEL, DEST_HINT: DEST_HINT,
    destKey: destKey, destName: destName, typeName: typeName, whName: whName, moveName: moveName,
    KIND_NAME: KIND_NAME, KIND_KEYS: KIND_KEYS, kindKey: kindKey, kindName: kindName,
    prodOf: prodOf, noteOf: noteOf,
    stateFrom: stateFrom, totals: totals, getLot: getLot, getLog: getLog, qtyOf: qtyOf, lotValue: lotValue,
    sortLots: sortLots, LOT_COLS: LOT_COLS, LOG_COLS: LOG_COLS, lotCols: lotCols,
    lotCell: lotCell, logCell: logCell, cellKey: cellKey, passCols: passCols, uniqValues: uniqValues,
    dateAdd: dateAdd, inRange: inRange, presetRange: presetRange, rangeOf: rangeOf, monthRange: monthRange,
    ymd: ymd, ymOf: ymOf, lastDay: lastDay, monthRangeOf: monthRangeOf, fmtKorDate: fmtKorDate,
    fmtKorMonth: fmtKorMonth, WEEK_NAMES: WEEK_NAMES, monthMatrix: monthMatrix,
    PERIOD_QUICK: PERIOD_QUICK, periodRange: periodRange, periodKeyOf: periodKeyOf,
    grouped: grouped, filterLots: filterLots, countLive: countLive,
    /* v7 브랜드 한↔영 · 거래명세표 */
    BRANDS: BRANDS, brandNorm: brandNorm, brandTerms: brandTerms, brandStandard: brandStandard,
    brandKoOf: brandKoOf, brandList: brandList, chosung: chosung, romanizeKo: romanizeKo,
    textHit: textHit, stmtLine: stmtLine, stmtSum: stmtSum, stmtMerge: stmtMerge, stmtData: stmtData,
    stmtGroupData: stmtGroupData,
    sortLogsDesc: sortLogsDesc, sortLogsAsc: sortLogsAsc, filterLogs: filterLogs,
    priceStats: priceStats, priceCompare: priceCompare,
    CHG_COLS: CHG_COLS, chgRows: chgRows, chgCell: chgCell, filterChg: filterChg, siteInput: siteInput,
    csv: csv, stockCsv: stockCsv, csvQuote: csvQuote, dict: dict, destHistory: destHistory,
    precheck: precheck, precheckUpdate: precheckUpdate,
    SABANG_HEAD: SABANG_HEAD, SALES_HEAD: SALES_HEAD, sabangnetRows: sabangnetRows, salesRows: salesRows,
    lotOf: lotOf, ymd8: ymd8, mmdd: mmdd, inDateRange: inDateRange,
    xlsxBytes: xlsxBytes, zipStore: zipStore, crc32: crc32, colName: colName,
    /* v4 완제품 */
    FP_CATS: FP_CATS, FP_UNITS: FP_UNITS, fpTypeKey: fpTypeKey, fpTypeName: fpTypeName,
    fpStateFrom: fpStateFrom, fpTotals: fpTotals, fpToday: fpToday,
    fpLotFrom: fpLotFrom, fpLotsOf: fpLotsOf, fpStockList: fpStockList,
    FP_COLS: FP_COLS, fpCols: fpCols, fpCell: fpCell, fpLogCell: fpLogCell,
    fpFilteredProducts: fpFilteredProducts, fpFilteredLogs: fpFilteredLogs,
    fpProductOf: fpProductOf, fpFind: fpFind, fpNextCode: fpNextCode,
    FP_TX_HEAD: FP_TX_HEAD, FP_PRICE_HEAD: FP_PRICE_HEAD,
    fpTxRows: fpTxRows, fpPriceRows: fpPriceRows, fpStockRows: fpStockRows, fpLogRows: fpLogRows,
    /* v4 회계 */
    VAT_RATE: VAT_RATE, ACC_TYPE: ACC_TYPE, ACC_TAX: ACC_TAX, ACC_DOC: ACC_DOC,
    ACC_PAY: ACC_PAY, ACC_METHODS: ACC_METHODS, ACC_EXPENSE_CATS: ACC_EXPENSE_CATS,
    ACC_INCOME_CATS: ACC_INCOME_CATS, ACC_COLS: ACC_COLS, accCols: accCols,
    accTypeName: accTypeName, accDocName: accDocName, accVat: accVat,
    accStateFrom: accStateFrom, accLedger: accLedger, accBalance: accBalance,
    accTaxPending: accTaxPending, accMonthly: accMonthly, accTotals: accTotals, accSum: accSum,
    accCell: accCell, accFilterVouchers: accFilterVouchers, accFilterExpenses: accFilterExpenses,
    accVoucherRows: accVoucherRows, accLedgerRows: accLedgerRows,
    accExpenseRows: accExpenseRows, accMonthRows: accMonthRows, ymKey: ymKey, inPeriod: inPeriod,
    /* v8 생산·원가 · 자동 연동 */
    FP_CAT_GROUPS: FP_CAT_GROUPS, fpCatGroup: fpCatGroup, fpCatMatch: fpCatMatch,
    selfMadeLog: selfMadeLog, isFpSiteUse: isFpSiteUse, siteCostRows: siteCostRows,
    prodRows: prodRows, prodSummary: prodSummary, prodByPeriod: prodByPeriod,
    prodCostItems: prodCostItems, nameMatch: nameMatch,
    /* v8.1 거래처 DB · 스마트 부분검색 */
    partnerLoad: partnerLoad, partnerList: partnerList, partnerCount: partnerCount, partnerByName: partnerByName,
    partnerOf: partnerOf, partnerSuggest: partnerSuggest, partnerBuyer: partnerBuyer, partnerItems: partnerItems,
    bizFmt: bizFmt, bizDigits: bizDigits,
    smartTokens: smartTokens, smartHit: smartHit, smartScore: smartScore, smartPick: smartPick,
    linkItemOf: linkItemOf, linkOfMeat: linkOfMeat, linkOfFp: linkOfFp,
    PROD_COLS: PROD_COLS, prodCell: prodCell, voucherCols: voucherCols,
    /* 엑셀 읽기 */
    inflateRaw: inflateRaw, unzip: unzip, xlsxRows: xlsxRows, csvRows: csvRows,
    parseSheet: parseSheet, toDateStr: toDateStr, toNum: toNum, mapHeader: mapHeader
  };
})();
/* ============================== CORE:END ============================== */

/* ============================== API:START ============================== */
var SB = (function () {
  'use strict';
  var URL_ = String(CONFIG.SUPABASE_URL).replace(/\/+$/, '');
  var KEY = CONFIG.SUPABASE_ANON_KEY;
  var SESKEY = 'meatERP.session.v1';
  var ses = null;

  /* ---------- 도우미 ---------- */
  function errOf(msg, kind, status) {
    var e = new Error(msg);
    e.kind = kind || 'app';
    e.status = status || 0;
    return e;
  }
  function readBody(res) {
    var ct = res.headers && res.headers.get('content-type') || '';
    if (ct.indexOf('json') >= 0) return res.json().catch(function () { return null; });
    return res.text().then(function (t) { return t; });
  }
  function errMessage(body, status) {
    var m = body && (body.msg || body.message || body.error_description || body.error);
    if (typeof m !== 'string') m = '';
    if (/Invalid login credentials/i.test(m)) return '이메일 또는 비밀번호가 맞지 않습니다.';
    if (/Email not confirmed/i.test(m)) return '이메일 확인이 아직 안 됐습니다. 받은 메일의 확인 링크를 누르거나, 관리자에게 계정 확인을 요청하세요.';
    if (/User already registered|already been registered/i.test(m)) return '이미 가입된 이메일입니다. 위의 로그인 탭에서 로그인해 주세요.';
    if (/Password should be at least|password.*too short/i.test(m)) return '비밀번호가 너무 짧습니다. 6자 이상으로 만들어 주세요.';
    if (/Unable to validate email|invalid.*email/i.test(m)) return '이메일 형식이 올바르지 않습니다.';
    if (/For security purposes|only request this after/i.test(m)) return '잠시 뒤 다시 시도해 주세요. (연속 요청 제한)';
    if (status === 429) return '시도가 너무 잦습니다. 1분 뒤 다시 시도해 주세요.';
    if (status === 401) return '로그인이 만료되었습니다. 다시 로그인해 주세요.';
    if (/Could not find the table|relation .* does not exist|PGRST205|schema cache/i.test(m)) {
      return 'DB 표를 찾을 수 없습니다. supabase_setup.sql을 먼저 실행해 주세요.';
    }
    if (/Could not find the function|PGRST202/i.test(m)) {
      return 'DB 함수를 찾을 수 없습니다. Supabase SQL Editor에서 supabase_migrate_v4.sql을 실행해 주세요.';
    }
    if (/column .* does not exist|PGRST204/i.test(m)) {
      return 'DB에 새 열이 없습니다. supabase_migrate_v4.sql을 실행해 주세요.';
    }
    if (/permission denied/i.test(m)) return '이 작업을 할 권한이 없습니다. 로그인 상태를 확인해 주세요.';
    if (/JWT expired|invalid JWT|token is expired/i.test(m)) return '로그인이 만료되었습니다. 다시 로그인해 주세요.';
    if (/duplicate key value/i.test(m)) return '같은 내용이 이미 있습니다. 새로고침 후 다시 시도해 주세요.';
    if (m) return m;
    return '요청을 처리하지 못했습니다. (' + status + ')';
  }
  function request(url, opts) {
    return fetch(url, opts).then(function (res) {
      return readBody(res).then(function (body) {
        if (res.ok) return body;
        throw errOf(errMessage(body, res.status), 'http', res.status);
      });
    }, function () {
      throw errOf('인터넷 연결을 확인해 주세요. (서버에 닿지 않습니다)', 'network', 0);
    });
  }
  function authUrl(path) { return URL_ + '/auth/v1/' + path; }
  function authReq(path, body, token) {
    var h = { apikey: KEY, 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    var opts = { method: body ? 'POST' : 'GET', headers: h };
    if (body) opts.body = JSON.stringify(body);
    return request(authUrl(path), opts);
  }

  /* ---------- 세션 ---------- */
  function sesFrom(tok) {
    var u = (tok && tok.user) || {};
    var meta = u.user_metadata || {};
    var email = u.email || '';
    return {
      access: tok.access_token, refresh: tok.refresh_token,
      exp: Date.now() + Number(tok.expires_in || 3600) * 1000,
      email: email, name: meta.name || meta.full_name || email.split('@')[0], uid: u.id || ''
    };
  }
  function persist() {
    try {
      if (ses) localStorage.setItem(SESKEY, JSON.stringify(ses));
      else localStorage.removeItem(SESKEY);
    } catch (e) { /* 저장 못 하는 환경 무시 */ }
  }
  function readStored() {
    try {
      var raw = localStorage.getItem(SESKEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (s && s.access && s.refresh) return s;
    } catch (e) { /* 무시 */ }
    return null;
  }
  function signIn(email, pw) {
    return authReq('token?grant_type=password', { email: email, password: pw }).then(function (r) {
      if (!r || !r.access_token) throw errOf('로그인하지 못했습니다. 계정 확인 상태를 확인해 주세요.', 'auth');
      ses = sesFrom(r); persist(); return ses;
    });
  }
  function signUp(email, pw, name) {
    return authReq('signup', { email: email, password: pw, data: { name: name || '' } }).then(function (r) {
      if (r && r.access_token) { ses = sesFrom(r); persist(); return { session: ses }; }
      return { confirm: true, email: (r && r.email) || email };
    });
  }
  function refresh() {
    if (!ses || !ses.refresh) return Promise.reject(errOf('다시 로그인해 주세요.', 'auth', 401));
    return authReq('token?grant_type=refresh_token', { refresh_token: ses.refresh }).then(function (r) {
      ses = sesFrom(r); persist(); return ses;
    }, function (e) {
      ses = null; persist();
      throw errOf('로그인이 만료되었습니다. 다시 로그인해 주세요.', 'auth', 401);
    });
  }
  function signOut() {
    var t = ses && ses.access;
    ses = null; persist();
    if (!t) return Promise.resolve();
    return request(authUrl('logout'), { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + t } })
      .catch(function () { /* 서버 로그아웃 실패해도 기기에서는 지운다 */ });
  }
  function ensure() {
    if (!ses) return Promise.reject(errOf('로그인이 필요합니다.', 'auth', 401));
    if (ses.exp - Date.now() > 60000) return Promise.resolve(ses);
    return refresh();
  }

  /* ---------- 데이터 ---------- */
  function rest(path, opts, retried) {
    opts = opts || {};
    return ensure().then(function (s) {
      var h = { apikey: KEY, Authorization: 'Bearer ' + s.access };
      if (opts.body) h['Content-Type'] = 'application/json';
      if (opts.headers) for (var k in opts.headers) if (opts.headers.hasOwnProperty(k)) h[k] = opts.headers[k];
      var o = { method: opts.method || 'GET', headers: h };
      if (opts.body) o.body = JSON.stringify(opts.body);
      return fetch(URL_ + '/rest/v1/' + path, o).then(function (res) {
        if (res.status === 401 && !retried) {
          return refresh().then(function () { return rest(path, opts, true); });
        }
        return readBody(res).then(function (body) {
          if (res.ok) return body;
          throw errOf(errMessage(body, res.status), 'http', res.status);
        });
      }, function () {
        throw errOf('인터넷 연결을 확인해 주세요.', 'network', 0);
      });
    });
  }
  var PAGE = 1000;
  function selectAll(table, order, keyCol) {
    var keyName = keyCol || 'id';
    var out = [];
    var seen = {};
    function step(from, pageNo) {
      if (pageNo > 40) return out;
      var headers = { Range: from + '-' + (from + PAGE - 1), 'Range-Unit': 'items' };
      return rest(table + '?select=*&order=' + order, { headers: headers }).then(function (rows) {
        rows = rows || [];
        for (var i = 0; i < rows.length; i++) {
          var key = String(rows[i][keyName]);
          if (seen[key]) continue;
          seen[key] = 1;
          out.push(rows[i]);
        }
        if (rows.length < PAGE) return out;
        return step(from + PAGE, pageNo + 1);
      });
    }
    return step(0, 0);
  }
  function loadAll() {
    return Promise.all([selectAll('lots', 'id.asc'), selectAll('tx_logs', 'id.asc')])
      .then(function (r) { return { lots: r[0] || [], logs: r[1] || [] }; });
  }
  /* v4: 완제품·회계 표는 아직 없는 DB(v3)일 수 있으므로 실패해도 앱이 멈추지 않게 따로 읽는다 */
  function loadAllV4() {
    var names = ['fp_products', 'fp_logs', 'fp_lots', 'acc_vouchers', 'acc_payments', 'acc_expenses'];
    return Promise.all(names.map(function (t) {
      return selectAll(t, t === 'fp_products' ? 'code.asc' : 'id.asc',
                       t === 'fp_products' ? 'code' : 'id').then(function (rows) {
        return { ok: true, rows: rows || [] };
      }, function () { return { ok: false, rows: [] }; });
    })).then(function (r) {
      return {
        fps: r[0].rows, fpLogs: r[1].rows, fpLots: r[2].rows, vouchers: r[3].rows,
        payments: r[4].rows, expenses: r[5].rows,
        /* fp_lots 는 v6 표라 아직 없는 DB(v5)도 있다 — 없어도 앱은 그대로 돈다 */
        v6: r[2].ok,
        v4: r[0].ok && r[1].ok && r[3].ok && r[4].ok && r[5].ok
      };
    });
  }
  /* 저장: 화면 파라미터 → DB 함수 파라미터 */
  function apply(p) {
    return rest('rpc/tx_apply', {
      method: 'POST', body: {
        p_date: p.date || null,
        p_type: p.type,
        p_wh: p.wh || null,
        p_lot_id: p.lot_id === null || p.lot_id === undefined || p.lot_id === '' ? null : Number(p.lot_id),
        p_kg: Number(p.kg || 0),
        p_dest_type: p.dest_type || '',
        p_dest: p.dest || '',
        p_note: p.note || '',
        p_name: p.name || '',
        p_vendor: p.vendor || '',
        p_in_date: p.in_date || null,
        p_exp_date: p.exp_date || null,
        p_meat: p.meat || '',
        p_origin: p.origin || '',
        p_brand: p.brand || '',
        p_major: p.major || '원료육',
        p_unit_price: Number(p.price || 0),
        p_amount: p.amount === undefined || p.amount === null || p.amount === '' ? null : Number(p.amount)
      }
    });
  }
  /* 입력한 이력 수정 (서버가 예전 영향을 되돌리고 새 값으로 다시 계산) */
  function update(p) {
    return rest('rpc/tx_update', {
      method: 'POST', body: {
        p_log_id: Number(p.logId),
        p_date: p.date || null,
        p_kg: Number(p.kg || 0),
        p_unit_price: Number(p.price || 0),
        p_amount: p.amount === undefined || p.amount === null || p.amount === '' ? null : Number(p.amount),
        p_dest_type: p.dest_type || '',
        p_dest: p.dest || '',
        p_note: p.note || '',
        p_wh: p.wh || null
      }
    });
  }
  /* 로트 정보(대분류·소분류·품목명·브랜드·원산지·업체·기준단가·날짜) 수정 */
  function lotUpdate(p) {
    return rest('rpc/lot_update', {
      method: 'POST', body: {
        p_lot_id: Number(p.lotId),
        p_major: p.major || null,
        p_meat: p.meat === undefined ? null : String(p.meat || ''),
        p_name: p.name || null,
        p_brand: p.brand === undefined ? null : String(p.brand || ''),
        p_origin: p.origin === undefined ? null : String(p.origin || ''),
        p_vendor: p.vendor === undefined ? null : String(p.vendor || ''),
        p_unit_price: p.price === undefined || p.price === null || p.price === '' ? null : Number(p.price),
        p_in_date: p.in_date || null,
        p_exp_date: p.exp_date || null
      }
    });
  }
  function undo(logId) { return rest('rpc/tx_undo', { method: 'POST', body: { p_log_id: Number(logId) } }); }

  /* ---------- v4 완제품 ---------- */
  function fpProductSave(p) {
    return rest('rpc/fp_product_save', { method: 'POST', body: {
      p_code: p.code || '', p_category: p.cat || '완제품', p_name: p.name || '',
      p_spec: p.spec || '', p_unit: p.unit || '개',
      p_in_price: Number(p.inp || 0), p_out_price: Number(p.outp || 0),
      p_expiry: p.expiry || null, p_supplier: p.sup || '', p_barcode: p.bc || '',
      p_active: p.active !== false
    } });
  }
  function fpApply(p) {
    return rest('rpc/fp_tx_apply', { method: 'POST', body: {
      p_code: p.code || '', p_type: p.type || 'IN', p_qty: Number(p.qty || 0),
      p_date: p.date || null,
      p_price: p.price === undefined || p.price === null || p.price === '' ? null : Number(p.price),
      p_expiry: p.expiry || null, p_partner: p.partner || '', p_note: p.note || '',
      p_allow_negative: !!p.allowNegative, p_source: p.source || 'manual',
      p_lot_no: p.lotNo || '',
      p_lot_id: p.lotId === null || p.lotId === undefined || p.lotId === '' ? null : Number(p.lotId),
      p_in_date: p.inDate || null
    } });
  }
  function fpUndo(id) { return rest('rpc/fp_tx_undo', { method: 'POST', body: { p_log_id: Number(id) } }); }
  function fpBatch(rows, allowNegative) {
    return rest('rpc/fp_batch', { method: 'POST', body: { p_rows: rows || [], p_allow_negative: !!allowNegative } });
  }
  function fpBatchPrice(rows) {
    return rest('rpc/fp_batch_price', { method: 'POST', body: { p_rows: rows || [] } });
  }

  /* ---------- v4 회계 ---------- */
  function accVoucherSave(p) {
    return rest('rpc/acc_voucher_save', { method: 'POST', body: {
      p_id: p.id === null || p.id === undefined || p.id === '' ? null : Number(p.id),
      p_date: p.date || null, p_type: p.type || 'sale', p_partner: p.partner || '',
      p_tax_type: p.tax || 'tax', p_amount: Number(p.amount || 0),
      p_vat_included: !!p.vatIncluded, p_tax_status: p.doc || 'none', p_note: p.note || ''
    } });
  }
  function accVoucherDelete(id) { return rest('rpc/acc_voucher_delete', { method: 'POST', body: { p_id: Number(id) } }); }
  function accReflect(items, taxType) {
    return rest('rpc/acc_reflect', { method: 'POST', body: { p_items: items || [], p_tax_type: taxType || 'auto' } });
  }
  function accPaymentSave(p) {
    return rest('rpc/acc_payment_save', { method: 'POST', body: {
      p_id: p.id === null || p.id === undefined || p.id === '' ? null : Number(p.id),
      p_date: p.date || null, p_partner: p.partner || '', p_type: p.type || 'in',
      p_amount: Number(p.amount || 0), p_method: p.method || '', p_note: p.note || ''
    } });
  }
  function accPaymentDelete(id) { return rest('rpc/acc_payment_delete', { method: 'POST', body: { p_id: Number(id) } }); }
  function accExpenseSave(p) {
    return rest('rpc/acc_expense_save', { method: 'POST', body: {
      p_id: p.id === null || p.id === undefined || p.id === '' ? null : Number(p.id),
      p_date: p.date || null, p_type: p.type || 'expense', p_category: p.cat || '기타',
      p_partner: p.partner || '', p_amount: Number(p.amount || 0),
      p_tax_type: p.tax || 'free', p_vat_included: p.vatIncluded !== false,
      p_method: p.method || '', p_note: p.note || ''
    } });
  }
  function accExpenseDelete(id) { return rest('rpc/acc_expense_delete', { method: 'POST', body: { p_id: Number(id) } }); }

  /* ---------- v5 입고 사진 대기함 (inbound_photos) ---------- */
  function photoIds() {
    return rest('inbound_photos?select=id&status=eq.pending&order=created_at.asc&limit=100');
  }
  function photoList() {
    return rest('inbound_photos?select=id,image_data,file_name,memo,uploader_name,status,lot_id,created_at&status=eq.pending&order=created_at.asc&limit=20');
  }
  function photoUpload(p) {
    return rest('rpc/photo_upload', { method: 'POST', body: {
      p_image: p.image || '', p_file: p.file || '', p_memo: p.memo || '', p_name: p.name || ''
    } });
  }
  function photoMark(id, status, lotId) {
    return rest('rpc/photo_mark', { method: 'POST', body: {
      p_id: Number(id), p_status: status || 'registered', p_lot_id: lotId === null || lotId === undefined ? null : Number(lotId)
    } });
  }
  function photoDelete(id) {
    return rest('rpc/photo_delete', { method: 'POST', body: { p_id: Number(id) } });
  }

  function restore() {
    ses = readStored();
    return ses;
  }

  return {
    auth: { signIn: signIn, signUp: signUp, signOut: signOut, refresh: refresh, ensure: ensure, restore: restore, session: function () { return ses; } },
    db: { loadAll: loadAll, apply: apply, update: update, lotUpdate: lotUpdate, undo: undo, rest: rest,
      loadAllV4: loadAllV4,
      fpProductSave: fpProductSave, fpApply: fpApply, fpUndo: fpUndo,
      fpBatch: fpBatch, fpBatchPrice: fpBatchPrice,
      accVoucherSave: accVoucherSave, accVoucherDelete: accVoucherDelete, accReflect: accReflect,
      accPaymentSave: accPaymentSave, accPaymentDelete: accPaymentDelete,
      accExpenseSave: accExpenseSave, accExpenseDelete: accExpenseDelete,
      photoIds: photoIds, photoList: photoList, photoUpload: photoUpload, photoMark: photoMark, photoDelete: photoDelete },
    errOf: errOf
  };
})();

/* ---------- 실시간(웹소켓) + 주기 재조회 ---------- */
var LIVE = (function () {
  'use strict';
  var ws = null, ref = 0, joined = false, topic = 'realtime:erp', hb = null, retry = 0;
  var onChange = null, onState = null, stopped = true, stateText = 'off';

  function wsUrl() {
    var base = String(CONFIG.SUPABASE_URL).replace(/^http/, 'ws').replace(/\/+$/, '');
    return base + '/realtime/v1/websocket?apikey=' + encodeURIComponent(CONFIG.SUPABASE_ANON_KEY) + '&vsn=1.0.0';
  }
  function send(obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) { } }
  function join() {
    var s = SB.auth.session();
    if (!s) return;
    ref += 1;
    send({
      topic: topic, event: 'phx_join', ref: String(ref), join_ref: String(ref),
      payload: {
        config: {
          broadcast: { ack: false, self: false },
          presence: { key: '' },
          postgres_changes: [
            { event: '*', schema: 'public', table: 'lots' },
            { event: '*', schema: 'public', table: 'tx_logs' },
            { event: '*', schema: 'public', table: 'fp_products' },
            { event: '*', schema: 'public', table: 'fp_logs' },
            { event: '*', schema: 'public', table: 'acc_vouchers' },
            { event: '*', schema: 'public', table: 'acc_payments' },
            { event: '*', schema: 'public', table: 'acc_expenses' },
            { event: '*', schema: 'public', table: 'inbound_photos' }
          ]
        },
        access_token: s.access
      }
    });
  }
  function setState(t) {
    stateText = t;
    if (typeof onState === 'function') onState(t);
  }
  function connect() {
    if (stopped) return;
    if (typeof WebSocket === 'undefined') { setState('poll'); return; }
    try { ws = new WebSocket(wsUrl()); } catch (e) { setState('poll'); return; }
    ws.onopen = function () {
      joined = false; retry = 0; join(); setState('connecting');
      hb = setInterval(function () { ref += 1; send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(ref) }); }, 25000);
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || !msg.event) return;
      if (msg.event === 'phx_reply' && msg.payload && msg.payload.status === 'ok') {
        if (msg.topic === topic) { joined = true; setState('live'); }
      } else if (msg.event === 'phx_error' || msg.event === 'phx_close') {
        setState('poll');
      } else if (msg.event === 'postgres_changes') {
        if (typeof onChange === 'function') onChange();
      }
    };
    ws.onclose = function () {
      if (hb) { clearInterval(hb); hb = null; }
      joined = false;
      setState('poll');
      if (stopped) return;
      retry += 1;
      var wait = Math.min(30000, 1500 * retry);
      setTimeout(connect, wait);
    };
    ws.onerror = function () { /* onclose가 이어서 처리 */ };
  }
  function start(cb, stCb) {
    onChange = cb; onState = stCb || null; stopped = false; retry = 0;
    connect();
  }
  function stop() {
    stopped = true; onChange = null;
    if (hb) { clearInterval(hb); hb = null; }
    try { if (ws) ws.close(); } catch (e) { }
    ws = null; joined = false; stateText = 'off';
  }
  function state() { return stateText; }
  return { start: start, stop: stop, state: state };
})();
/* ============================== API:END ============================== */

/* ============================== UI:START ============================== */
(function () {
  'use strict';
  var st = { lots: [], logs: [], fps: [], fpLogs: [], fpLots: [], vouchers: [], payments: [], expenses: [], loadedAt: 0 };
  var cur = {
    mode: 'in', tab: 'F', wh: 'F', whIn: 'F', whOut: 'C', dest: 'site',
    search: '', showZero: false, hFilter: 'all', hLimit: 250, lotId: null,
    photoId: null,
    stock: { preset: 'all', field: 'in', from: '', to: '' },
    hist: { preset: 'all', from: '', to: '' },
    sortLot: { k: '', dir: 1 },
    sortLog: { k: '', dir: -1 },
    sortChg: { k: '', dir: -1 },
    fLot: {}, fLog: {}, fChg: {},
    /* v4 */
    erp: 'meat',
    /* v8 */
    pane: 'stock', prodView: 'sum', prodPeriod: 'day',
    prodRange: { preset: 'all', from: '', to: '' },
    buyRange: { preset: 'all', from: '', to: '' }, saleRange: { preset: 'all', from: '', to: '' },
    buySearch: '', saleSearch: '', buyView: 'list', saleView: 'list',
    sortB: { k: '', dir: -1 }, sortS: { k: '', dir: -1 },
    fAccB: {}, fAccS: {}, reflectMode: 'all',
    fgType: 'IN', fgSrc: 'buy', fgUse: 'sale', fgTab: 'G', fgCode: '', fgSearch: '', fgCat: 'all', fgShowZero: false,
    fgTypeF: 'all', fgLimit: 300,
    fgRange: { preset: 'all', from: '', to: '' },
    fgSortG: { k: '', dir: 1 }, fgSortL: { k: '', dir: -1 }, fgSortP: { k: '', dir: 1 },
    fFgG: {}, fFgL: {}, fFgP: {},
    accTab: 'V', accSearch: '', accType: 'all', accLimit: 300,
    accRange: { preset: 'all', from: '', to: '' },
    accSortV: { k: '', dir: -1 }, accSortE: { k: '', dir: -1 }, accSortR: { k: '', dir: -1 },
    fAccV: {}, fAccE: {}, fAccR: {},
    stlDraft: {},
    fgCats: [], v4ok: true, v6ok: true, reflectOpen: false, reflectSel: {}, payOpen: {},
    /* v8.3 — 왼쪽 메뉴로 열어 둔 팝업 기억(같은 메뉴를 다시 누르면 닫기) */
    sidePop: '', sidePopId: ''
  };
  var prev = {};
  var loading = false, again = false;
  var pollTimer = null, photoPollTimer = null;
  var editing = null, lotEditing = null;
  var fpop = { open: false, tbl: '', key: '', rect: null, all: [], sel: {}, q: '' };

  function $(id) { return document.getElementById(id); }

  /* ---------- 열 너비 (엑셀처럼 머리글을 끌어서 조절 · localStorage 저장) ---------- */
  var COLW = { lot: {}, log: {}, chg: {}, fpG: {}, fpL: {}, fpP: {}, accV: {}, accR: {}, accE: {}, accM: {}, accB: {}, accS: {}, prodD: {}, prodM: {}, prodC: {} };
  var COL_MIN = 44, COL_MAX = 720;
  var ACT_DEF = { lot: 78, log: 84, fpG: 78, fpL: 112, fpP: 96, accV: 156, accR: 132, accE: 96, accB: 156, accS: 156 };
  var COLW_KEYS = ['lot', 'log', 'chg', 'fpG', 'fpL', 'fpP', 'accV', 'accR', 'accE', 'accM', 'accB', 'accS', 'prodD', 'prodM', 'prodC'];
  var COLW_KEY = 'meatERP.colw.v4';
  function tblOf(tab) { return tab === 'H' ? 'log' : (tab === 'V' ? 'chg' : 'lot'); }
  function loadColW() {
    try {
      var raw = localStorage.getItem(COLW_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      COLW_KEYS.forEach(function (t) {
        if (!o || !o[t]) return;
        for (var k in o[t]) {
          if (!Object.prototype.hasOwnProperty.call(o[t], k)) continue;
          var w = Math.round(Number(o[t][k]));
          if (w >= COL_MIN && w <= COL_MAX) COLW[t][k] = w;
        }
      });
    } catch (e) { /* 저장 못 하는 환경 무시 */ }
  }
  function saveColW() {
    try {
      var empty = true;
      COLW_KEYS.forEach(function (t) { for (var k in COLW[t]) if (Object.prototype.hasOwnProperty.call(COLW[t], k)) empty = false; });
      if (empty) { localStorage.removeItem(COLW_KEY); return; }
      localStorage.setItem(COLW_KEY, JSON.stringify(COLW));
    } catch (e) { }
  }
  function colWidth(tbl, key, def) {
    var w = COLW[tbl] && COLW[tbl][key];
    return w > 0 ? w : (def || 100);
  }
  function setColWidth(tbl, key, w, wrapId) {
    w = Math.round(w);
    if (!isFinite(w)) return;
    w = Math.max(COL_MIN, Math.min(COL_MAX, w));
    if (!COLW[tbl]) COLW[tbl] = {};
    COLW[tbl][key] = w;
    var col = document.querySelector('#' + (wrapId || 'tableWrap') + ' col[data-colwrap="' + key + '"]');
    if (col) col.style.width = w + 'px';
    syncTableWidth(wrapId);
  }
  function syncTableWidth(wrapId) {
    var t = document.querySelector('#' + (wrapId || 'tableWrap') + ' table');
    if (!t) return;
    var cols = t.querySelectorAll('colgroup col'), sum = 0, i, w;
    for (i = 0; i < cols.length; i++) {
      w = parseFloat(cols[i].style.width) || 0;
      sum += w;
    }
    if (sum > 0) {
      t.style.width = sum + 'px';
      t.style.minWidth = sum + 'px';
    }
  }
  /* 현재 화면(모드)의 표들만 기본 너비로 되돌린다 */
  function resetColWidth(mode) {
    var tables = mode === 'fg' ? ['fpG', 'fpL', 'fpP']
      : (mode === 'acc' ? ['accV', 'accR', 'accE', 'accM'] : ['lot', 'log', 'chg']);
    tables.forEach(function (t) { COLW[t] = {}; });
    saveColW();
    if (mode === 'fg') renderFgTable();
    else if (mode === 'acc') renderAccTable();
    else renderTable();
    toast('열 너비를 기본값으로 되돌렸습니다.', 'ok');
  }
  /* 글자 폭 계산 (열 더블클릭 = 내용에 맞춤) */
  var MEASURE = null;
  function textWidth(txt, font) {
    try {
      if (!MEASURE) MEASURE = document.createElement('canvas').getContext('2d');
      MEASURE.font = font || '13px -apple-system,BlinkMacSystemFont,"Malgun Gothic","Noto Sans KR",sans-serif';
      return MEASURE.measureText(String(txt || '')).width;
    } catch (e) { return String(txt || '').length * 12; }
  }
  function autoFitCol(tbl, key, wrapId) {
    var wrap = wrapId || 'tableWrap';
    var cols = key === '_act' ? null : colsOfTable(tbl);
    var idx = -1, i;
    if (cols) {
      for (i = 0; i < cols.length; i++) if (cols[i].k === key) idx = i;
      if (idx < 0) return;
    }
    var th = document.querySelector('#' + wrap + ' th[data-col="' + key + '"]');
    var label = th ? (th.querySelector('.ht') ? th.querySelector('.ht').textContent : th.textContent) : '';
    var max = textWidth(label, '700 11.5px -apple-system,BlinkMacSystemFont,"Malgun Gothic","Noto Sans KR",sans-serif') + 46;
    var cells = document.querySelectorAll('#' + wrap + ' tbody tr td');
    var seen = 0;
    for (i = 0; i < cells.length; i++) {
      var td = cells[i];
      if (td.colSpan > 1) continue;
      var cellIdx = Array.prototype.indexOf.call(td.parentNode.children, td);
      if (cellIdx !== idx) continue;
      seen++;
      if (seen > 400) break;
      var w = textWidth(td.textContent.trim()) + 22;
      if (w > max) max = w;
    }
    setColWidth(tbl, key, Math.max(COL_MIN, Math.ceil(max) + 2), wrap);
    saveColW();
  }
  function colsOfTable(tbl) {
    if (tbl === 'lot') return ERP.lotCols(cur.tab === 'C' ? 'C' : 'F');
    if (tbl === 'log') return ERP.LOG_COLS;
    if (tbl === 'chg') return ERP.CHG_COLS;
    if (tbl === 'fpG' || tbl === 'fpL' || tbl === 'fpP') return ERP.fpCols(tbl.charAt(2));
    if (tbl === 'accV' || tbl === 'accR' || tbl === 'accE' || tbl === 'accM') return ERP.accCols(tbl.charAt(3));
    if (tbl === 'accB') return ERP.voucherCols('buy');
    if (tbl === 'accS') return ERP.voucherCols('sale');
    if (tbl === 'prodD') return ERP.PROD_COLS.day;
    if (tbl === 'prodM') return ERP.PROD_COLS.month;
    if (tbl === 'prodC') return ERP.PROD_COLS.cost;
    return ERP.LOG_COLS;
  }

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtInt(x) {
    var n = Math.round(Number(x || 0));
    var neg = n < 0;
    return (neg ? '-' : '') + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmt(x) {
    var n = Number(x || 0);
    var neg = n < 0;
    var s = Math.abs(n).toFixed(2).split('.');
    return (neg ? '-' : '') + s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + s[1];
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function clock() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function daysLeft(exp) {
    if (!exp) return null;
    var parts = String(exp).split('-');
    if (parts.length < 3) return null;
    var t = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var n = new Date();
    n.setHours(0, 0, 0, 0);
    return Math.round((t.getTime() - n.getTime()) / 86400000);
  }
  function ddayHtml(exp) {
    var d = daysLeft(exp);
    if (d === null) return '';
    if (d < 0) return '<span class="dday danger">만료 ' + Math.abs(d) + '일</span>';
    if (d <= 30) return '<span class="dday warn">D-' + d + '</span>';
    if (d <= 90) return '<span class="dday ok">D-' + d + '</span>';
    return '';
  }

  /* ---------- 토스트 ---------- */
  function toast(msg, kind, ms) {
    var box = $('toast');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'tmsg ' + (kind || '');
    el.textContent = msg;
    box.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
    }, Number(ms) > 0 ? Number(ms) : 3600);
  }

  /* ---------- 동기화 상태 ---------- */
  function setSync(kind, text) {
    var el = $('syncState');
    if (!el) return;
    el.className = 'sync ' + kind;
    $('syncText').textContent = text;
  }
  function liveLabel(kind) {
    if (kind === 'live') setSync('ok', '실시간 연결됨 · ' + clock());
    else if (kind === 'connecting') setSync('wait', '실시간 연결 중…');
    else if (kind === 'poll') setSync('poll', '자동 새로고침(1분) · ' + clock());
  }
  function showBanner(html) {
    var b = $('banner');
    b.innerHTML = html;
    b.classList.remove('hidden');
  }
  function hideBanner() { $('banner').classList.add('hidden'); }
  function isSetupError(e) {
    return e && (/supabase_setup\.sql|supabase_migrate_v3\.sql|만들 수 없습니다|DB 표를 찾을 수 없습니다|DB 함수|DB에 새 열/.test(e.message || ''));
  }

  /* ---------- KPI ---------- */
  function kpi(id, val, dp) {
    var el = $(id);
    var txt = dp === 0 ? fmtInt(val) : fmt(val);
    if (prev[id] !== undefined && prev[id] !== txt) {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
    el.textContent = txt;
    prev[id] = txt;
  }
  function kpiRaw(id, txt) {
    var el = $(id);
    if (!el) return;
    if (prev[id] !== undefined && prev[id] !== txt) {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
    el.textContent = txt;
    prev[id] = txt;
  }
  function renderKPI() {
    var t = ERP.totals(st);
    kpi('kFree', t.frozen);
    kpi('kChill', t.chilled);
    kpi('kValue', t.value, 0);
    kpi('kLive', t.live, 0);
    var tp = 0, d0 = today(), priced = 0, i;
    for (i = 0; i < st.logs.length; i++) if (st.logs[i].d === d0) tp++;
    for (i = 0; i < st.lots.length; i++) if (st.lots[i].price > 0 && (st.lots[i].fq + st.lots[i].cq) > ERP.EPS) priced++;
    kpi('kToday', tp, 0);
    $('kFreeSub').textContent = '보관 로트 ' + t.liveFrozen + '개';
    $('kChillSub').textContent = '보관 로트 ' + t.liveChilled + '개';
    $('kValueSub').textContent = '단가 있는 로트 ' + priced + '개 기준';
    $('kLiveSub').textContent = '전체 ' + st.lots.length + '개 로트 중';
    $('kTodaySub').textContent = d0 + ' 입력 기준';
    if ($('cntM')) $('cntM').textContent = ERP.countLive(st, cur.tab === 'C' ? 'C' : 'F');
    if ($('cntH')) $('cntH').textContent = st.logs.length;
    if ($('cntV')) $('cntV').textContent = ERP.chgRows(st).length;
  }

  /* ---------- 표 머리글 (화살표 하나로 정렬 · 값 필터) ---------- */
  function thHtml(c, sort, filt) {
    var on = !!(sort && sort.k === c.k);
    var arrow = on ? (sort.dir === -1 ? '▼' : '▲') : '▾';
    var onF = !!(filt && filt[c.k] && filt[c.k].length);
    return '<th class="' + (c.num ? 'num' : '') + '" data-col="' + c.k + '">' +
      '<div class="hdbox">' +
      '<button type="button" class="hdfilt' + (on || onF ? ' on' : '') + '" data-filter="' + c.k + '" title="' + esc(c.t) + ' — 정렬 · 갑 필터">' +
      '<span class="ht">' + esc(c.t) + '</span><span class="harrow">' + arrow + '</span></button>' +
      '</div><span class="colrz" data-rz="' + c.k + '" title="드래그: 열 너비 조절 / 더블클릭: 내용에 맞춤"></span></th>';
  }
  function actTh() {
    return '<th class="num actcol"><span class="th-plain">작업</span>' +
      '<span class="colrz" data-rz="_act" title="드래그: 열 너비 조절"></span></th>';
  }
  function colGroup(tbl, cols, actDef) {
    var out = ['<colgroup>'], i;
    for (i = 0; i < cols.length; i++) {
      out.push('<col data-colwrap="' + cols[i].k + '" style="width:' + colWidth(tbl, cols[i].k, cols[i].w) + 'px">');
    }
    if (actDef) out.push('<col data-colwrap="_act" style="width:' + colWidth(tbl, '_act', actDef) + 'px">');
    out.push('</colgroup>');
    return out.join('');
  }
  function tableOpen(cls, tbl, cols, actDef) {
    var w = 0, i;
    for (i = 0; i < cols.length; i++) w += colWidth(tbl, cols[i].k, cols[i].w);
    if (actDef) w += colWidth(tbl, '_act', actDef);
    return '<table class="fixed ' + cls + '" style="width:' + w + 'px;min-width:' + w + 'px">' +
      colGroup(tbl, cols, actDef);
  }

  /* ---------- 재고표 ---------- */
  function lotOpts() {
    return {
      dateField: cur.stock.field, from: cur.stock.from, to: cur.stock.to,
      cols: cur.fLot, sortKey: cur.sortLot.k, sortDir: cur.sortLot.dir
    };
  }
  function renderStock(wh) {
    var wrap = $('tableWrap');
    var keep = wrap.scrollTop, keepL = wrap.scrollLeft;
    var cols = ERP.lotCols(wh);
    var groups = ERP.grouped(st, wh, cur.search, cur.showZero, lotOpts());

    var nRow = 0, kg = 0, amt = 0, i, j;
    for (i = 0; i < groups.length; i++) { nRow += groups[i].lots.length; kg += groups[i].sum; amt += groups[i].amt; }
    setRangeSum(nRow + '개 로트', kg, amt);

    if (!groups.length) {
      wrap.innerHTML = '<table><tbody><tr class="empty-row"><td>조건에 맞는 로트가 없습니다. 기간을 넓히거나 검색어·필터를 지워 보세요.</td></tr></tbody></table>';
      wrap.scrollTop = 0;
      return;
    }
    var html = [tableOpen('t-lot', 'lot', cols, ACT_DEF.lot),
      '<thead><tr>'];
    for (i = 0; i < cols.length; i++) html.push(thHtml(cols[i], cur.sortLot, cur.fLot));
    html.push(actTh() + '</tr></thead><tbody>');

    for (i = 0; i < groups.length; i++) {
      var g = groups[i];
      html.push('<tr class="group"><td colspan="' + (cols.length + 1) + '"><span class="g-name">' + esc(g.name) + '</span>' +
        '<span class="g-meta">' + g.lots.length + '개 로트 · 보관 ' + g.live + '개 · <b>' + fmt(g.sum) + '</b> kg' +
        (g.amt ? ' · <b>' + fmtInt(g.amt) + '</b>원' : '') + '</span></td></tr>');
      for (j = 0; j < g.lots.length; j++) {
        var lot = g.lots[j];
        var qv = ERP.qtyOf(lot, wh);
        var sel = cur.lotId === lot.id ? ' sel' : '';
        html.push('<tr class="lot' + sel + '" data-lot="' + lot.id + '">');
        for (var c = 0; c < cols.length; c++) {
          html.push(lotCellHtml(lot, cols[c].k, wh, qv));
        }
        html.push('<td class="actcell actcol"><button type="button" class="actmenu' + (qv <= ERP.EPS ? ' dis' : '') +
          '" data-menu="lot" data-lot="' + lot.id + '" data-wh="' + wh + '"' + (qv <= ERP.EPS ? ' disabled' : '') +
          ' title="해동·출고·수정">작업 ▾</button></td>');
        html.push('</tr>');
      }
    }
    html.push('</tbody></table>');
    wrap.innerHTML = html.join('');
    wrap.scrollTop = keep;
    wrap.scrollLeft = keepL;
  }

  function lotCellHtml(lot, k, wh, qv) {
    if (k === 'mt') return '<td><span class="mtag mt-' + esc(lot.mt || '기타') + '">' + esc(lot.mt || '-') + '</span></td>';
    if (k === 'n') return '<td class="ellip"><b>' + esc(lot.n) + '</b></td>';
    if (k === 'qty') return '<td class="num' + (qv <= ERP.EPS ? ' zero' : '') + '">' + fmt(qv) + '</td>';
    if (k === 'price') return '<td class="num">' + (lot.price > 0 ? fmtInt(lot.price) : '<span class="ttag">-</span>') + '</td>';
    if (k === 'amt') return '<td class="num" title="' + (lot.price > 0 ? fmtInt(Math.round(qv * lot.price)) + '원' : '단가 미입력') + '">' +
      (lot.price > 0 ? fmtInt(Math.round(qv * lot.price)) : '<span class="ttag">-</span>') + '</td>';
    if (k === 'e') return '<td>' + esc(lot.e || '-') + ddayHtml(lot.e) + '</td>';
    if (k === 'i') return '<td>' + esc(lot.i || '-') + '</td>';
    return '<td class="ellip">' + esc(ERP.lotCell(lot, k, wh) || '-') + '</td>';
  }

  /* ---------- 입출고 내역 ---------- */
  function setRangeSum(n, kg, amt) {
    var el = $('rangeSum');
    if (!el) return;
    el.textContent = n + ' · ' + fmt(kg) + ' kg' + (amt ? ' · ' + fmtInt(amt) + '원' : '');
  }
  function renderHistNote() {
    var orig = 0, mine = 0, i;
    for (i = 0; i < st.logs.length; i++) {
      if (st.logs[i].act) mine++; else orig++;
    }
    $('histNote').textContent = '처음 엑셀에서 옮긴 이력 ' + orig + '건 + 화면에서 입력한 이력 ' + mine + '건. ' +
      '화면에서 입력한 건은 행의 [작업 ▾]에서 [수정]으로 고치거나 [취소]로 되돌릴 수 있고, 취소하면 재고도 함께 원복됩니다. ' +
      '원본 엑셀 이력은 보존을 위해 수정·취소할 수 없습니다.';
  }
  function logCellHtml(e, k) {
    if (k === 'd') return '<td>' + esc(e.d || '-') + '</td>';
    if (k === 't') return '<td><span class="badge ' + esc(ERP.kindKey(e)) + '">' + ERP.kindName(e) + '</span></td>';
    if (k === 'n') return '<td class="ellip"><b>' + esc(e.n) + '</b></td>';
    if (k === 'k') return '<td class="num">' + fmt(e.k) + '</td>';
    if (k === 'inp') return unitPriceCell(e.t === 'in' ? e.price : 0, '입고단가');
    if (k === 'outp') return unitPriceCell(e.t === 'out' ? e.price : 0, '출고단가');
    if (k === 'amt') return '<td class="num" title="' + (e.amt > 0 ? fmtInt(e.amt) + '원' : '금액 미입력') + '">' +
      (e.amt > 0 ? fmtInt(e.amt) : '<span class="ttag">-</span>') + '</td>';
    if (k === 'prod') {
      var pv = ERP.prodOf(e);
      return '<td class="ellip" title="' + esc(pv) + '">' + (pv ? esc(pv) : '<span class="ttag">-</span>') + '</td>';
    }
    if (k === 'note') {
      var nv = ERP.noteOf(e);
      return '<td class="ellip" title="' + esc(nv) + '">' + (nv ? esc(nv) : '<span class="ttag">-</span>') + '</td>';
    }
    if (k === 'worker') return '<td class="ellip">' + (e.worker ? '<span class="worker" title="' + esc(e.email) + '">' + esc(e.worker) + '</span>' : '<span class="ttag">-</span>') + '</td>';
    return '<td class="ellip">' + esc(ERP.logCell(e, k) || '-') + '</td>';
  }
  /* 입고단가·출고단가 칸 — 그 방향의 건이 아니거나 단가가 없으면 - */
  function unitPriceCell(price, label) {
    if (!(Number(price) > 0)) return '<td class="num"><span class="ttag">-</span></td>';
    return '<td class="num" title="' + label + ' ' + fmtInt(price) + '원/kg">' + fmtInt(price) + '</td>';
  }
  function renderHistory() {
    var wrap = $('tableWrap');
    renderHistNote();
    var list = ERP.filterLogs(st, {
      q: cur.search, type: cur.hFilter, from: cur.hist.from, to: cur.hist.to,
      cols: cur.fLog, sortKey: cur.sortLog.k, sortDir: cur.sortLog.dir
    });
    var kg = 0, amt = 0, i;
    for (i = 0; i < list.length; i++) { kg += Number(list[i].k) || 0; amt += Number(list[i].amt) || 0; }
    setRangeSum(list.length + '건', kg, amt);

    if (!list.length) {
      wrap.innerHTML = '<table><tbody><tr class="empty-row"><td>조건에 맞는 내역이 없습니다. 기간을 넓히거나 검색어·필터를 지워 보세요.</td></tr></tbody></table>';
      return;
    }
    var cols = ERP.LOG_COLS;
    var page = list.slice(0, cur.hLimit);
    var html = [tableOpen('t-log', 'log', cols, ACT_DEF.log), '<thead><tr>'];
    for (i = 0; i < cols.length; i++) html.push(thHtml(cols[i], cur.sortLog, cur.fLog));
    html.push(actTh() + '</tr></thead><tbody>');
    for (i = 0; i < page.length; i++) {
      var e = page[i];
      html.push('<tr class="hrow">');
      for (var c = 0; c < cols.length; c++) html.push(logCellHtml(e, cols[c].k));
      html.push('<td class="actcell actcol">' +
        (e.act
          ? '<button type="button" class="actmenu" data-menu="log" data-log="' + e.dbid + '" title="수정·취소">작업 ▾</button>'
          : '<span class="ttag">원본</span>') +
        '</td>');
      html.push('</tr>');
    }
    html.push('</tbody></table>');
    if (list.length > cur.hLimit) {
      html.push('<button class="more" id="btnMore">더 보기 (' + (list.length - cur.hLimit) + '건 남음)</button>');
    }
    wrap.innerHTML = html.join('');
    var more = $('btnMore');
    if (more) more.addEventListener('click', function () { cur.hLimit += 250; renderHistory(); });
  }

  function renderTable() {
    var anyF = hasCols(cur.fLot) || hasCols(cur.fLog) || hasCols(cur.fChg);
    var btn = $('btnResetFilters');
    if (btn) btn.classList.toggle('hidden', !anyF);
    if (cur.tab === 'H') { renderHistory(); return; }
    if (cur.tab === 'V') { renderChg(); return; }
    renderStock(cur.tab);
  }

  /* ---------- 📈 단가 변동 (v6) ---------- */
  function fmtPct(v) {
    var n = Number(v) || 0;
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function chgCellHtml(r, k) {
    if (k === 'n') return '<td class="ellip" title="' + esc(r.n) + '"><b>' + esc(r.n) + '</b></td>';
    if (k === 'mt') return '<td><span class="mtag mt-' + esc(r.mt || '기타') + '">' + esc(r.mt || '-') + '</span></td>';
    if (k === 'v') return '<td class="ellip">' + (r.v ? esc(r.v) : '<span class="ttag">-</span>') + '</td>';
    if (k === 'prev') return '<td class="num">' + fmtInt(r.prev) + '</td>';
    if (k === 'last') return '<td class="num">' + fmtInt(r.last) + '</td>';
    if (k === 'delta') {
      var cls = r.dir === 'up' ? 'chg-up' : (r.dir === 'down' ? 'chg-down' : 'chg-same');
      var sign = r.delta > 0 ? '+' : (r.delta < 0 ? '−' : '');
      return '<td class="num"><span class="' + cls + '">' + sign + fmtInt(Math.abs(r.delta)) + '</span></td>';
    }
    if (k === 'pct') {
      var c2 = r.dir === 'up' ? 'chg-up' : (r.dir === 'down' ? 'chg-down' : 'chg-same');
      var ar = r.dir === 'up' ? '▲ ' : (r.dir === 'down' ? '▼ ' : '');
      return '<td class="num"><span class="delta-badge ' + c2 + '">' + ar + fmtPct(r.pct) + '</span></td>';
    }
    if (k === 'd') return '<td>' + esc(r.d || '-') + '</td>';
    if (k === 'cnt') return '<td class="num">' + r.cnt + '</td>';
    return '<td class="ellip">' + esc(ERP.chgCell(r, k) || '-') + '</td>';
  }
  function renderChg() {
    var wrap = $('tableWrap');
    var keep = wrap.scrollTop, keepL = wrap.scrollLeft;
    var cols = ERP.CHG_COLS;
    var list = ERP.filterChg(ERP.chgRows(st), {
      q: cur.search, from: cur.hist.from, to: cur.hist.to,
      cols: cur.fChg, sortKey: cur.sortChg.k, sortDir: cur.sortChg.dir
    });
    var up = 0, down = 0, i;
    for (i = 0; i < list.length; i++) { if (list[i].dir === 'up') up++; else if (list[i].dir === 'down') down++; }
    if ($('rangeSum')) {
      $('rangeSum').textContent = list.length + '품목 · ▲ ' + up + ' · ▼ ' + down;
    }
    if (!list.length) {
      wrap.innerHTML = '<table><tbody><tr class="empty-row"><td>단가 변동을 볼 품목이 없습니다. 같은 품목을 두 번 이상 입고하면 여기에 모입니다.</td></tr></tbody></table>';
      wrap.scrollTop = 0;
      return;
    }
    var html = [tableOpen('t-chg', 'chg', cols, 0), '<thead><tr>'];
    for (i = 0; i < cols.length; i++) html.push(thHtml(cols[i], cur.sortChg, cur.fChg));
    html.push('</tr></thead><tbody>');
    for (i = 0; i < list.length; i++) {
      html.push('<tr class="chgrow">');
      for (var c = 0; c < cols.length; c++) html.push(chgCellHtml(list[i], cols[c].k));
      html.push('</tr>');
    }
    html.push('</tbody></table>');
    wrap.innerHTML = html.join('');
    wrap.scrollTop = keep;
    wrap.scrollLeft = keepL;
  }

  function hasCols(o) {
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k) && o[k] && o[k].length) return true;
    return false;
  }

  /* ---------- 기간 바 ---------- */
  function rangeTarget() {
    if (cur.erp === 'fg') return cur.fgRange;
    if (cur.erp === 'acc') return cur.accRange;
    if (cur.erp === 'buy') return cur.buyRange;
    if (cur.erp === 'sale') return cur.saleRange;
    if (cur.erp === 'prod') return cur.prodRange;
    if (cur.tab === 'H' || cur.tab === 'V') return cur.hist;
    return cur.stock;
  }
  function rangeUI() {
    if (cur.erp === 'fg') return { presets: 'fgPresets', from: 'fgFrom', to: 'fgTo', display: '', sum: 'fgRangeSum' };
    if (cur.erp === 'acc') return { presets: 'accPresets', from: 'accFrom', to: 'accTo', display: 'accRangeDisplay', sum: 'accRangeSum' };
    if (cur.erp === 'buy') return { presets: '', from: 'buyFrom', to: 'buyTo', display: 'buyRangeDisplay', sum: 'buyRangeSum' };
    if (cur.erp === 'sale') return { presets: '', from: 'saleFrom', to: 'saleTo', display: 'saleRangeDisplay', sum: 'saleRangeSum' };
    if (cur.erp === 'prod') return { presets: '', from: 'prodFrom', to: 'prodTo', display: 'prodRangeDisplay', sum: 'prodRangeSum' };
    /* 원료육은 📅 기간선택 · 전체/오늘/이번주/이번달 · 날짜칸 · 검색 · 초기화 */
    return { presets: 'rangePresets', from: 'rangeFrom', to: 'rangeTo', display: '', sum: 'rangeSum' };
  }
  function afterRange() {
    renderRangeBar();
    if (cur.erp === 'fg') renderFgTable();
    else if (cur.erp === 'acc') renderAccTable();
    else if (cur.erp === 'buy') renderBuy();
    else if (cur.erp === 'sale') renderSale();
    else if (cur.erp === 'prod') renderProd();
    else renderTable();
  }
  function rangeLabel(r) {
    if (!r.from && !r.to) return '전체 기간';
    return (r.from || '처음') + ' ~ ' + (r.to || '오늘');
  }
  function renderRangeBar() {
    var ui = rangeUI(), r = rangeTarget();
    if (cur.erp === 'meat') {
      var isH = cur.tab === 'H' || cur.tab === 'V';
      if ($('dateFieldWrap')) $('dateFieldWrap').classList.toggle('hidden', isH);
      var soon = document.querySelector('#rangePresets [data-preset="soon"]');
      if (soon) soon.classList.toggle('hidden', isH);
      if ($('dateField')) $('dateField').value = cur.stock.field || 'in';
    }
    var btns = ui.presets ? document.querySelectorAll('#' + ui.presets + ' .pr') : [];
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-preset') === r.preset);
    }
    var fEl = $(ui.from), tEl = $(ui.to);
    if (fEl) fEl.value = r.from || '';
    if (tEl) tEl.value = r.to || '';
    var disp = ui.display ? $(ui.display) : null;
    if (disp) {
      disp.textContent = rangeLabel(r);
      disp.classList.toggle('set', !!(r.from || r.to));
    }
  }
  function setPreset(key) {
    var r = rangeTarget();
    r.preset = key;
    if (key === 'soon') cur.stock.field = 'exp';
    var rg = ERP.rangeOf(key, today());
    r.from = rg.from;
    r.to = rg.to;
    cur.hLimit = 250; cur.fgLimit = 300; cur.accLimit = 300;
    afterRange();
  }
  function setCustomRange(fromId, toId) {
    var r = rangeTarget();
    r.preset = 'custom';
    r.from = $(fromId || rangeUI().from).value || '';
    r.to = $(toId || rangeUI().to).value || '';
    cur.hLimit = 250; cur.fgLimit = 300; cur.accLimit = 300;
    afterRange();
  }

  /* ---------- 기간 선택 팝업 (그림과 같은 2개월 달력) ----------
     왼쪽·오른쪽 달력은 각자 연도·월을 바꿀 수 있다(연속 2개월로 고정되지 않음).
     그래서 1년 넘는 긴 기간도 클릭으로 고를 수 있다. */
  var rngm = { open: false, from: '', to: '', year: 2026, anchor: 'from', calL: { y: 2026, m: 1 }, calR: { y: 2026, m: 2 } };

  function shiftMonth(y, m, step) {
    var yy = Number(y), mm = Number(m) + Number(step);
    while (mm < 1) { mm += 12; yy -= 1; }
    while (mm > 12) { mm -= 12; yy += 1; }
    return { y: yy, m: mm };
  }
  function yearOptions(y) {
    var out = [], c = Number(y), i;
    for (i = c - 12; i <= c + 8; i++) {
      out.push('<option value="' + i + '"' + (i === c ? ' selected' : '') + '>' + i + '</option>');
    }
    return out.join('');
  }
  function monthOptions(m) {
    var out = [], i;
    for (i = 1; i <= 12; i++) out.push('<option value="' + i + '"' + (i === Number(m) ? ' selected' : '') + '>' + i + '월</option>');
    return out.join('');
  }
  function calHtml(which) {
    var c = which === 'L' ? rngm.calL : rngm.calR;
    var weeks = ERP.monthMatrix(c.y, c.m);
    var html = ['<div class="cal-head">',
      '<button type="button" class="cal-nav" data-cal="' + which + '" data-step="-1" aria-label="이전 달">◀</button>',
      '<select class="cal-y" data-cal="' + which + '" aria-label="연도">' + yearOptions(c.y) + '</select>',
      '<select class="cal-m" data-cal="' + which + '" aria-label="월">' + monthOptions(c.m) + '</select>',
      '<button type="button" class="cal-nav" data-cal="' + which + '" data-step="1" aria-label="다음 달">▶</button>',
      '</div><div class="cal-dow">'];
    var i, j, w;
    for (i = 0; i < 7; i++) {
      html.push('<span class="' + (i === 0 ? 'sun' : (i === 6 ? 'sat' : '')) + '">' + ERP.WEEK_NAMES[i] + '</span>');
    }
    html.push('</div><div class="cal-grid">');
    var t = today();
    for (w = 0; w < weeks.length; w++) {
      for (j = 0; j < 7; j++) {
        var d = weeks[w][j];
        var cls = 'cal-day' + (d.inMonth ? '' : ' other') + (d.d === t ? ' today' : '');
        if (rngm.from && rngm.to) {
          if (d.d === rngm.from) cls += ' start';
          if (d.d === rngm.to) cls += ' end';
          if (d.d > rngm.from && d.d < rngm.to) cls += ' range';
        }
        html.push('<button type="button" class="' + cls + '" data-day="' + d.d + '">' + d.day + '</button>');
      }
    }
    html.push('</div>');
    return html.join('');
  }
  function renderRangeModal() {
    if (!rngm.open) return;
    $('rmYear').textContent = rngm.year;
    $('rmCurrent').textContent = ERP.fmtKorDate(rngm.from) + ' ~ ' + ERP.fmtKorDate(rngm.to);
    var picked = ERP.periodKeyOf(rngm.from, rngm.to, today(), rngm.year);
    var rows = [['rmQ1', 0], ['rmQ2', 1], ['rmQ3', 2]];
    for (var r = 0; r < rows.length; r++) {
      var list = ERP.PERIOD_QUICK[rows[r][1]], html = [];
      for (var i = 0; i < list.length; i++) {
        html.push('<button type="button" class="rq' + (picked === list[i][0] ? ' on' : '') +
          '" data-period="' + list[i][0] + '">' + list[i][1] + '</button>');
      }
      $(rows[r][0]).innerHTML = html.join('');
    }
    $('rmCalL').innerHTML = calHtml('L');
    $('rmCalR').innerHTML = calHtml('R');
  }
  function openRange() {
    var r = rangeTarget();
    var t = today();
    var from = r.from || t, to = r.to || t;
    rngm.open = true;
    rngm.from = from;
    rngm.to = to;
    rngm.year = Number(from.slice(0, 4)) || Number(t.slice(0, 4));
    rngm.anchor = 'from';
    rngm.calL = ERP.ymOf(from);
    rngm.calR = ERP.ymOf(to);
    if (rngm.calL.y === rngm.calR.y && rngm.calL.m === rngm.calR.m) {
      rngm.calR = shiftMonth(rngm.calR.y, rngm.calR.m, 1);
    }
    $('rangeModal').classList.remove('hidden');
    renderRangeModal();
  }
  function closeRange() {
    rngm.open = false;
    $('rangeModal').classList.add('hidden');
  }
  /* 시작일 → 종료일 차례로 클릭. 범위가 완성된 뒤 다음 클릭은 새 범위로 다시 시작. */
  function pickDay(d) {
    if (rngm.anchor !== 'to') {
      rngm.from = d; rngm.to = d; rngm.anchor = 'to';
    } else if (d < rngm.from) {
      rngm.to = rngm.from; rngm.from = d; rngm.anchor = 'from';
    } else {
      rngm.to = d; rngm.anchor = 'from';
    }
    renderRangeModal();
  }
  function quickPeriod(key) {
    var r = ERP.periodRange(key, today(), rngm.year);
    if (!r.from && !r.to) return;
    rngm.from = r.from;
    rngm.to = r.to;
    var a = ERP.ymOf(r.from), b = ERP.ymOf(r.to);
    rngm.calL = a;
    rngm.calR = (a.y === b.y && a.m === b.m) ? shiftMonth(b.y, b.m, 1) : b;
    renderRangeModal();
  }
  function applyRange() {
    var r = rangeTarget();
    r.from = rngm.from;
    r.to = rngm.to;
    r.preset = 'custom';
    cur.hLimit = 250; cur.fgLimit = 300; cur.accLimit = 300;
    closeRange();
    afterRange();
    toast('기간 적용: ' + rangeLabel(r), 'ok');
  }

  /* ---------- 컬럼 필터 팝오버 ---------- */
  function rowsForFilter(tbl, key) {
    var base = filterStore(tbl);
    var cols = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k) && k !== key) cols[k] = base[k];
    if (tbl === 'lot') {
      return ERP.filterLots(st, cur.tab, cur.search, cur.showZero, {
        dateField: cur.stock.field, from: cur.stock.from, to: cur.stock.to, cols: cols
      });
    }
    if (tbl === 'log') {
      return ERP.filterLogs(st, {
        q: cur.search, type: cur.hFilter, from: cur.hist.from, to: cur.hist.to, cols: cols
      });
    }
    if (tbl === 'chg') {
      return ERP.filterChg(ERP.chgRows(st), {
        q: cur.search, from: cur.hist.from, to: cur.hist.to, cols: cols
      });
    }
    if (tbl === 'fpL') {
      return ERP.fpFilteredLogs(st.fpLogs, {
        q: cur.fgSearch, type: cur.fgTypeF, cat: cur.fgCat, from: cur.fgRange.from, to: cur.fgRange.to, cols: cols
      });
    }
    if (tbl === 'fpG' || tbl === 'fpP') {
      return ERP.fpFilteredProducts(tbl === 'fpG' ? ERP.fpStockList(st.fps, st.fpLots) : st.fps, st.fpLogs, {
        q: cur.fgSearch, cat: cur.fgCat, showZero: cur.fgShowZero,
        from: cur.fgRange.from, to: cur.fgRange.to, cols: cols
      });
    }
    if (tbl === 'accV') {
      return ERP.accFilterVouchers(acc(), {
        q: cur.accSearch, type: cur.accType, from: cur.accRange.from, to: cur.accRange.to, cols: cols
      });
    }
    if (tbl === 'accE') {
      return ERP.accFilterExpenses(acc(), {
        q: cur.accSearch, type: cur.accType, from: cur.accRange.from, to: cur.accRange.to, cols: cols
      });
    }
    if (tbl === 'accR') return accLedgerList();
    if (tbl === 'accB' || tbl === 'accS') return voucherPaneList(tbl === 'accB' ? 'buy' : 'sale', cols);
    if (tbl === 'prodD' || tbl === 'prodM' || tbl === 'prodC') return [];
    return [];
  }
  function filterStore(tbl) {
    if (tbl === 'lot') return cur.fLot;
    if (tbl === 'log') return cur.fLog;
    if (tbl === 'chg') return cur.fChg;
    if (tbl === 'fpG') return cur.fFgG;
    if (tbl === 'fpL') return cur.fFgL;
    if (tbl === 'fpP') return cur.fFgP;
    if (tbl === 'accV') return cur.fAccV;
    if (tbl === 'accE') return cur.fAccE;
    if (tbl === 'accR') return cur.fAccR;
    if (tbl === 'accB') return cur.fAccB;
    if (tbl === 'accS') return cur.fAccS;
    return cur.fLog;
  }
  function cellOf(tbl) {
    if (tbl === 'lot') return function (l, k) { return ERP.lotCell(l, k, cur.tab); };
    if (tbl === 'log') return function (e, k) { return ERP.logCell(e, k); };
    if (tbl === 'chg') return function (r, k) { return ERP.chgCell(r, k); };
    if (tbl === 'fpG' || tbl === 'fpP') return function (p, k) { return ERP.fpCell(p, k); };
    if (tbl === 'fpL') return function (g, k) { return ERP.fpLogCell(g, k); };
    if (tbl === 'accR') return function (r, k) { return ERP.accCell(r, k); };
    if (tbl === 'prodD' || tbl === 'prodM' || tbl === 'prodC') return function (r, k) { return ERP.prodCell(r, k); };
    return function (e, k) { return ERP.accCell(e, k); };
  }
  function colLabel(tbl, key) {
    var list = colsOfTable(tbl);
    for (var i = 0; i < list.length; i++) if (list[i].k === key) return list[i].t;
    return key;
  }
  function openFilter(tbl, key, btn) {
    var rect = btn.getBoundingClientRect();
    var vals = ERP.uniqValues(rowsForFilter(tbl, key), key, cellOf(tbl));
    var allow = filterStore(tbl)[key];
    var sel = {};
    for (var i = 0; i < vals.length; i++) sel[vals[i]] = !allow || allow.length === 0 || allow.indexOf(vals[i]) >= 0;
    fpop = { open: true, tbl: tbl, key: key, rect: rect, all: vals, sel: sel, q: '' };
    $('fpopTitle').textContent = colLabel(tbl, key) + ' 값 선택';
    $('fpopSearch').value = '';
    renderFpop();
    markFpopSort();
    $('fpop').classList.remove('hidden');
    placeFpop();
    setTimeout(function () { try { $('fpopSearch').focus(); } catch (e) { } }, 40);
  }
  /* 팝오버 맨 위의 오름차순·내림차순 버튼에 지금 정렬 상태를 표시한다 */
  function markFpopSort() {
    var s0 = sortStateOf(fpop.tbl);
    var on = !!(s0 && s0.k === fpop.key);
    var asc = $('fpopAsc'), desc = $('fpopDesc'), un = $('fpopUnsort');
    if (asc) asc.classList.toggle('on', on && s0.dir === 1);
    if (desc) desc.classList.toggle('on', on && s0.dir !== 1);
    if (un) un.classList.toggle('hidden', !on);
  }
  function sortStateOf(tbl) {
    if (tbl === 'lot') return cur.sortLot;
    if (tbl === 'log') return cur.sortLog;
    if (tbl === 'chg') return cur.sortChg;
    if (tbl === 'fpG') return cur.fgSortG;
    if (tbl === 'fpL') return cur.fgSortL;
    if (tbl === 'fpP') return cur.fgSortP;
    if (tbl === 'accV') return cur.accSortV;
    if (tbl === 'accE') return cur.accSortE;
    if (tbl === 'accR') return cur.accSortR;
    return null;
  }
  /* 팝오버에서 바로 정렬 (dir 0 이면 해제) */
  function fpopSort(dir) {
    var s0 = sortStateOf(fpop.tbl);
    if (!s0) return;
    if (!dir) { s0.k = ''; s0.dir = 1; }
    else { s0.k = fpop.key; s0.dir = dir; }
    renderCurrent();
    markFpopSort();
  }
  function renderFpop() {
    var list = $('fpopList');
    var q = fpop.q;
    var shown = 0, html = [], i;
    for (i = 0; i < fpop.all.length; i++) {
      var v = fpop.all[i];
      /* v7: 값 목록에서도 파텔 ↔ PATEL 로 찾는다 */
      if (q && !ERP.textHit(v, q)) continue;
      shown++;
      html.push('<label class="fitem"><input type="checkbox" data-val="' + esc(v) + '"' +
        (fpop.sel[v] ? ' checked' : '') + '><span>' + esc(v) + '</span></label>');
    }
    if (!shown) html.push('<div class="fempty">해당하는 값이 없습니다.</div>');
    list.innerHTML = html.join('');
    var on = 0;
    for (i = 0; i < fpop.all.length; i++) if (fpop.sel[fpop.all[i]]) on++;
    $('fpopTitle').textContent = colLabel(fpop.tbl, fpop.key) + ' · ' + on + '/' + fpop.all.length + ' 선택';
  }
  function placeFpop() {
    var el = $('fpop');
    if (!el || !fpop.open || !fpop.rect) return;
    if (window.innerWidth <= 640) {
      el.classList.add('sheet');
      el.style.left = '';
      el.style.top = '';
      return;
    }
    el.classList.remove('sheet');
    var r = fpop.rect;
    var w = el.offsetWidth || 268, h = el.offsetHeight || 340;
    var left = Math.min(Math.max(8, r.left - 40), window.innerWidth - w - 10);
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }
  function closeFilter() {
    fpop.open = false;
    $('fpop').classList.add('hidden');
  }
  function applyFilter() {
    var store = filterStore(fpop.tbl);
    var on = [], off = 0, i;
    for (i = 0; i < fpop.all.length; i++) {
      if (fpop.sel[fpop.all[i]]) on.push(fpop.all[i]); else off++;
    }
    if (!off) delete store[fpop.key];
    else store[fpop.key] = on;
    renderCurrent();
    if (fpop.open) $('fpop').classList.remove('hidden');
  }

  /* ---------- 행 작업 메뉴 (작업 ▾) ---------- */
  var rowMenu = { open: false, items: [], btn: null };
  function openRowMenu(btn, items) {
    var el = $('rowMenu');
    if (!el) return;
    rowMenu.open = true; rowMenu.items = items; rowMenu.btn = btn;
    var html = [], i, it;
    for (i = 0; i < items.length; i++) {
      it = items[i];
      if (it.sep) { html.push('<div class="rm-sep"></div>'); continue; }
      html.push('<button type="button" class="' + (it.danger ? 'danger' : '') + '" role="menuitem" data-mi="' + i + '">' + esc(it.label) + '</button>');
    }
    el.innerHTML = html.join('');
    el.classList.remove('hidden');
    var r = btn.getBoundingClientRect();
    var w = el.offsetWidth || 124, h = el.offsetHeight || 40 * items.length;
    var left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    var top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    btn.classList.add('on');
  }
  function closeRowMenu() {
    var el = $('rowMenu');
    if (!el) return;
    el.classList.add('hidden');
    el.innerHTML = '';
    if (rowMenu.btn) rowMenu.btn.classList.remove('on');
    rowMenu.open = false; rowMenu.items = []; rowMenu.btn = null;
  }
  function stockMenuItems(lot, wh) {
    var items = [];
    if (wh === 'F') items.push({ label: '🧊→❄️ 해동', act: 'thaw', lot: lot.id });
    else items.push({ label: '❄️→🧊 재냉동', act: 're', lot: lot.id });
    items.push({ label: '📤 출고', act: 'out', lot: lot.id });
    items.push({ sep: true });
    items.push({ label: '✏️ 수정', act: 'lotedit', lot: lot.id });
    return items;
  }
  function logMenuItems(e) {
    var items = [];
    /* v7: 출고 건은 거래명세표를 바로 인쇄할 수 있다 */
    if (e.t === 'out') items.push({ label: '📄 명세표', act: 'stmt', id: e.dbid });
    if (items.length) items.push({ sep: true });
    items.push({ label: '✏️ 수정', act: 'edit', id: e.dbid });
    items.push({ label: '↩️ 취소', act: 'undo', id: e.dbid, danger: true });
    return items;
  }

  /* ==========================================================================
     v5 입고 사진 대기함 — 누구나 올리고, 확인 후 입고로 등록
     ========================================================================== */
  var photo = { list: [], count: 0, loaded: false, open: null, lastAlert: 0 };
  var PHOTO_NOTIFY_KEY = 'erp.photoNotify';

  function photoNotifyOn() {
    try { return localStorage.getItem(PHOTO_NOTIFY_KEY) !== '0'; } catch (e) { return true; }
  }
  function photoSetNotify(on) {
    try { localStorage.setItem(PHOTO_NOTIFY_KEY, on ? '1' : '0'); } catch (e) { }
  }
  function beep() {
    if (!photoNotifyOn()) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = beep.ctx || (beep.ctx = new AC());
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.value = 0.06;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      o.frequency.setValueAtTime(1180, ctx.currentTime + 0.12);
      o.stop(ctx.currentTime + 0.26);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    } catch (e) { }
  }
  function pushNote(n) {    if (!photoNotifyOn()) return;
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission !== 'granted') return;
      new Notification('📷 입고 사진 ' + n + '건 대기', {
        body: '전표 사진을 확인하고 입고를 등록하세요.',
        tag: 'erp-inbound-photo'
      });
    } catch (e) { }
  }
  function requestNotifyPermission() {
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'default') Notification.requestPermission();
    } catch (e) { }
  }
  function photoBadge(n) {
    var b = $('photoBadge');
    if (b) { b.textContent = n; b.classList.toggle('zero', !n); }
    var p = $('photoPending');
    if (p) p.textContent = n;
    var btn = $('btnPhotoInbox');
    if (btn) btn.classList.toggle('has', n > 0);
    /* v7: 왼쪽 세로 메뉴의 대기함 */
    var sp = $('sidePhotoCnt');
    if (sp) sp.textContent = n;
    var sb = $('sidePhotoInbox');
    if (sb) sb.classList.toggle('has', n > 0);
  }
  function fmtWhen(v) {
    var t = String(v || '');
    if (t.length < 16) return t || '-';
    return t.slice(5, 10).replace('-', '/') + ' ' + t.slice(11, 16);
  }
  function renderPhotos() {
    photoBadge(photo.count);
    var grid = $('photoGrid');
    if (!grid) return;
    if (!photo.list.length) {
      grid.innerHTML = '<div class="photo-empty">대기 중인 입고 사진이 없습니다. 입고 탭의 <b>📷 입고 사진 업로드</b>로 올리면 여기 쌓입니다.</div>';
      return;
    }
    var html = [], i, p;
    for (i = 0; i < photo.list.length; i++) {
      p = photo.list[i];
      html.push('<button type="button" class="photo-item" data-photo="' + p.id + '">' +
        '<img src="' + esc(p.image_data || '') + '" alt="입고 전표 사진">' +
        '<span class="pi-body"><b>' + esc(p.memo || p.file_name || ('사진 #' + p.id)) + '</b>' +
        '<span>' + esc(p.uploader_name || '-') + ' · ' + esc(fmtWhen(p.created_at)) + '</span></span></button>');
    }
    grid.innerHTML = html.join('');
  }
  /* 대기 건수만 가볍게 확인하고, 늘었을 때만 목록(사진)을 다시 받는다 */
  function photoTick(quiet) {
    if (!SB.auth.session()) return Promise.resolve();
    return SB.db.photoIds().then(function (rows) {
      var n = (rows || []).length;
      var had = photo.count;
      if (n === had && photo.loaded) return;
      return SB.db.photoList().then(function (list) {
        photo.list = list || [];
        photo.count = n;
        photo.loaded = true;
        renderPhotos();
        if (n > had && n > 0 && !quiet) {
          toast('📷 입고 사진 ' + n + '건이 대기 중입니다. 확인하고 입고를 등록하세요.', 'warn', 5000);
          var now = Date.now();
          if (now - photo.lastAlert > 8000) { photo.lastAlert = now; beep(); pushNote(n); }
        }
      });
    }, function () { /* 표가 아직 없으면 조용히 넘어간다 (SQL 재실행 안내는 배너가 한다) */ });
  }
  function openPhotoInbox() {
    var cb = $('photoNotify');
    if (cb) cb.checked = photoNotifyOn();
    if (photoNotifyOn()) requestNotifyPermission();
    renderPhotos();
    $('photoInboxModal').classList.remove('hidden');
    photoTick(true);
  }
  function closePhotoInbox() { $('photoInboxModal').classList.add('hidden'); }
  function openPhoto(id) {
    var p = null, i;
    for (i = 0; i < photo.list.length; i++) if (Number(photo.list[i].id) === Number(id)) p = photo.list[i];
    if (!p) { toast('사진을 찾을 수 없습니다. 대기함을 새로고침해 주세요.', 'warn'); return; }
    photo.open = p;
    $('pvTitle').textContent = '입고 전표 사진 #' + p.id;
    $('photoViewSub').textContent = (p.uploader_name || '-') + ' · ' + fmtWhen(p.created_at) + (p.file_name ? ' · ' + p.file_name : '');
    $('photoBigImg').src = p.image_data || '';
    $('photoMemo').value = p.memo || '';
    $('photoViewModal').classList.remove('mini');
    if ($('photoPin')) $('photoPin').textContent = '🪟 작게 띄우기';
    $('photoViewModal').classList.remove('hidden');
  }
  function closePhoto() {
    $('photoViewModal').classList.add('hidden');
    $('photoViewModal').classList.remove('mini');
    document.body.classList.remove('photo-beside');
    photo.open = null;
  }
  function pinPhoto(on) {
    var m = $('photoViewModal');
    if (!m) return;
    m.classList.toggle('mini', !!on);
    if ($('photoPin')) $('photoPin').textContent = on ? '🔍 크게 보기' : '🪟 작게 띄우기';
  }
  /* 사진을 보면서 왼쪽 입고 폼을 채운다. 저장하면 이 사진은 처리 완료(registered)가 된다. */
  function photoLoadToForm() {
    var p = photo.open;
    if (!p) return;
    if (cur.erp !== 'meat') setErpMode('meat');
    openMeatForm('in');
    cur.photoId = p.id;
    if ($('photoState')) {
      $('photoState').classList.remove('hidden');
      $('photoStateImg').src = p.image_data || '';
      $('photoStateTitle').textContent = '사진 #' + p.id + ' 보고 입력 중';
      $('photoStateSub').textContent = (p.uploader_name || '-') + ' · ' + fmtWhen(p.created_at) + ' — [입고 저장]하면 처리 완료로 바뀝니다.';
    }
    if (p.memo && $('inNote') && !$('inNote').value) $('inNote').value = p.memo;
    pinPhoto(true);
    /* 사진은 오른쪽에 작게, 입력 팝업은 왼쪽에 — 서로 가리지 않는다 */
    document.body.classList.add('photo-beside');
    closePhotoInbox();
    var card = $('meatFormPanel');
    if (card) card.scrollTop = 0;
    toast('사진을 오른쪽에 띄웠습니다. 사진을 보며 입고 내용을 적고 [입고 저장]을 누르세요.', 'ok');
  }
  function clearPhotoPick() {
    cur.photoId = null;
    if ($('photoState')) $('photoState').classList.add('hidden');
    if ($('photoStateImg')) $('photoStateImg').removeAttribute('src');
  }
  function photoDeleteOpen() {
    var p = photo.open;
    if (!p) return;
    if (!window.confirm('이 사진을 대기함에서 지울까요?\n(입고 등록 전 사진만 지울 수 있습니다)')) return;
    SB.db.photoDelete(p.id).then(function () {
      toast('사진을 지웠습니다.', 'ok');
      closePhoto();
      photo.loaded = false;
      photo.count = -1;
      return photoTick(true);
    }, function (e) { toast(e.message, 'err'); });
  }
  /* 사진을 화면 크기에 맞게 줄여 JPEG(최대 1280px)로 만든다 */
  function compressImage(file, cb) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var max = 1280, w = img.width, h = img.height;
      if (w > max || h > max) { var r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
      var cv = document.createElement('canvas');
      cv.width = Math.max(1, w); cv.height = Math.max(1, h);
      var ctx = cv.getContext('2d');
      try { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height); } catch (e) { }
      var out = '';
      try { out = cv.toDataURL('image/jpeg', 0.72); } catch (e) { out = ''; }
      URL.revokeObjectURL(url);
      cb(out || '');
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(''); };
    img.src = url;
  }
  function uploadPhotoFile(f) {
    if (!f) return;
    if (!/^image\//.test(String(f.type || ''))) { toast('사진 파일(jpg·png·heic)만 올릴 수 있습니다.', 'err'); return; }
    compressImage(f, function (dataUrl) {
      if (!dataUrl) { toast('사진을 읽지 못했습니다. 다른 사진으로 다시 시도해 주세요.', 'err'); return; }
      var ses = SB.auth.session();
      toast('사진을 줄여 올리는 중…', 'ok');
      SB.db.photoUpload({ image: dataUrl, file: f.name || '', memo: '', name: ses ? ses.name : '' })
        .then(function (row) {
          toast('입고 사진을 대기함에 올렸습니다.', 'ok');
          photo.loaded = false; photo.count = -1;
          return photoTick(true).then(function () { if (row && row.id) openPhoto(row.id); });
        }, function (e) {
          toast('사진 업로드 실패: ' + e.message, 'err');
        });
    });
  }

  /* ---------- 로트 선택 ---------- */
  function fillLotSelect(sel, wh) {
    var prevVal = sel.value;
    var list = [], i, l;
    for (i = 0; i < st.lots.length; i++) {
      l = st.lots[i];
      if (ERP.qtyOf(l, wh) <= ERP.EPS) continue;
      list.push(l);
    }
    list.sort(function (a, b) {
      var c = a.n.localeCompare(b.n, 'ko');
      if (c !== 0) return c;
      return ERP.sortLots(a, b);
    });
    var html = ['<option value="">— 로트 선택 (' + list.length + '개 보관중) —</option>'];
    var curName = null;
    for (i = 0; i < list.length; i++) {
      l = list[i];
      if (l.n !== curName) { html.push('<option disabled>■ ' + esc(l.n) + '</option>'); curName = l.n; }
      html.push('<option value="' + l.id + '">' + esc(l.n) + ' · ' + esc(l.v || '업체없음') +
        ' · ' + esc(l.i || '?') + ' · ' + fmt(ERP.qtyOf(l, wh)) + 'kg</option>');
    }
    sel.innerHTML = html.join('');
    if (prevVal && ERP.getLot(st, prevVal)) sel.value = prevVal;
    else sel.value = '';
  }

  function lotInfoHtml(lot, wh, id) {
    var att = id ? ' id="' + id + '"' : '';
    if (!lot) return '<div' + att + ' class="lotinfo empty">' + (wh === 'C' ? '냉장고' : '냉동고') + ' 재고표에서 로트 행을 클릭하거나 위에서 선택하세요.</div>';
    var q = ERP.qtyOf(lot, wh);
    return '<div' + att + ' class="lotinfo"><b>' + esc(lot.n) + '</b> · ' + esc(lot.v || '업체없음') +
      ' · ' + esc(lot.mt || '-') + '/' + esc(lot.o || '-') + '<br>' +
      '입고 ' + esc(lot.i || '-') + ' · 소비기한 ' + esc(lot.e || '-') + ddayHtml(lot.e) +
      ' · 단가 ' + (lot.price > 0 ? fmtInt(lot.price) + '원/kg' : '미입력') + '<br>' +
      (wh === 'F' ? '냉동고' : '냉장고') + ' 현재고 <b>' + fmt(q) + ' kg</b>' +
      (wh === 'C' && lot.fq > ERP.EPS ? ' <span class="ttag">(냉동고 ' + fmt(lot.fq) + 'kg 보유)</span>' : '') +
      (wh === 'F' && lot.cq > ERP.EPS ? ' <span class="ttag">(냉장고 ' + fmt(lot.cq) + 'kg 보유)</span>' : '') +
      '</div>';
  }

  function syncLotViews() {
    var thSel = $('thLot'), reSel = $('reLot'), outSel = $('outLot');
    fillLotSelect(thSel, 'F');
    fillLotSelect(reSel, 'C');
    fillLotSelect(outSel, cur.whOut);
    if (cur.lotId) {
      if (thSel.querySelector('option[value="' + cur.lotId + '"]')) thSel.value = cur.lotId;
      if (reSel.querySelector('option[value="' + cur.lotId + '"]')) reSel.value = cur.lotId;
      if (outSel.querySelector('option[value="' + cur.lotId + '"]')) outSel.value = cur.lotId;
    }
    $('thInfo').outerHTML = lotInfoHtml(ERP.getLot(st, thSel.value), 'F', 'thInfo');
    $('reInfo').outerHTML = lotInfoHtml(ERP.getLot(st, reSel.value), 'C', 'reInfo');
    $('outInfo').outerHTML = lotInfoHtml(ERP.getLot(st, outSel.value), cur.whOut, 'outInfo');
  }

  /* ---------- 단가 ↔ 금액 양방향 ---------- */
  var PRICE_IDS = {
    in: { kg: 'inKg', price: 'inPrice', amount: 'inAmount' },
    thaw: { kg: 'thKg', price: 'thPrice', amount: 'thAmount' },
    re: { kg: 'reKg', price: 'rePrice', amount: 'reAmount' },
    out: { kg: 'outKg', price: 'outPrice', amount: 'outAmount' }
  };
  function priceSync(mode, src) {
    var ids = PRICE_IDS[mode || cur.mode];
    if (!ids) return;
    var kg = Number($(ids.kg).value || 0);
    var pr = Number($(ids.price).value || 0);
    var am = Number($(ids.amount).value || 0);
    if (src === 'amount') {
      if (kg > 0) {
        var p2 = Math.round(am / kg);
        $(ids.price).value = am > 0 ? String(p2) : '';
      }
    } else {
      var v = Math.round(kg * pr);
      $(ids.amount).value = (kg > 0 && pr > 0) ? String(v) : '';
    }
    if ((mode || cur.mode) === 'in') updatePriceHint();
  }
  function fillLotPrice(mode, lot) {
    var ids = PRICE_IDS[mode];
    if (!ids) return;
    $(ids.price).value = lot && lot.price > 0 ? String(lot.price) : '';
    priceSync(mode, 'price');
  }

  /* ---------- 입고 단가 비교 (요구 8 + v6 등락률 배지) ---------- */
  function setDeltaBadge(c) {
    var badge = $('inPriceBadge');
    if (!badge) return;
    if (!c || !c.has || c.dir === 'same' || Math.abs(c.pct) < 5) {
      badge.className = 'delta-badge hidden';
      badge.textContent = '';
      return;
    }
    badge.className = 'delta-badge ' + (c.dir === 'up' ? 'chg-up' : 'chg-down');
    badge.textContent = (c.dir === 'up' ? '▲ +' : '▼ ') + c.pct.toFixed(1) + '%';
    badge.title = '직전 입고단가 ' + fmtInt(c.base) + '원/kg → ' + fmtInt(c.base + c.delta) + '원/kg (' + (c.pct > 0 ? '+' : '') + c.pct + '%)';
  }
  function updatePriceHint() {
    var box = $('priceHint');
    if (!box) return;
    if (cur.mode !== 'in') { box.className = 'pricebox hidden'; box.innerHTML = ''; setDeltaBadge(null); return; }
    var name = ($('inName').value || '').replace(/^\s+|\s+$/g, '');
    var major = '';
    var price = Number($('inPrice').value || 0);
    box.className = 'pricebox';
    if (!name) {
      box.innerHTML = '<span class="pb-empty">품목명을 입력하면 지난 입고 단가와 비교해 드립니다.</span>';
      setDeltaBadge(null);
      return;
    }
    var stat = ERP.priceStats(st, name, major);
    if (!stat.count) {
      box.innerHTML = '<div class="pb-line"><b>' + esc(name) + '</b> <span class="pb-new">첫 단가 입력(비교 이력 없음)</span></div>' +
        '<div class="pb-range">지난 입고 단가 기록이 없어 오타 여부를 비교할 수 없습니다.</div>';
      setDeltaBadge(null);
      return;
    }
    var html = ['<div class="pb-line"><b>' + esc(name) + '</b> 지난 입고 <b>' + stat.count + '</b>건 · 최근 ' +
      esc(stat.lastDate) + ' <b>' + fmtInt(stat.last) + '</b>원/kg</div>'];
    var cmp = null;
    if (price > 0) {
      var c = ERP.priceCompare(stat, price);
      cmp = c;
      var arrow = c.dir === 'up' ? '▲ +' : (c.dir === 'down' ? '▼ −' : '＝ ');
      var body;
      if (c.dir === 'same') body = '변동 없음';
      else body = arrow + fmtInt(Math.abs(c.delta)) + '원 (' + (c.pct > 0 ? '+' : '') + c.pct + '%) ' +
        (c.dir === 'up' ? '올랐습니다' : '내렸습니다');
      html.push('<div class="pb-cmp ' + c.dir + '">직전 입고가 <b>' + fmtInt(c.base) + '</b>원 → 지금 <b>' +
        fmtInt(price) + '</b>원 · ' + body + '</div>');
      if (c.warn) {
        html.push('<div class="pb-warn">⚠ 단가 급변 — 오타(0을 하나 더 입력 등)인지 확인하세요. ' +
          (c.warnAvg ? '평균 ' + fmtInt(stat.avg) + '원과 30% 이상 차이' : '직전가와 30% 이상 차이') + '</div>');
      }
    }
    html.push('<div class="pb-range">과거 입고 최저 <b>' + fmtInt(stat.min) + '</b> · 평균 <b>' + fmtInt(stat.avg) +
      '</b> · 최고 <b>' + fmtInt(stat.max) + '</b> 원/kg</div>');
    box.innerHTML = html.join('');
    setDeltaBadge(cmp);
  }

  /* ---------- 모드 ---------- */
  function submitLabel() {
    if (cur.mode === 'in') return (cur.whIn === 'F' ? '냉동고' : '냉장고') + '로 입고 저장';
    if (cur.mode === 'thaw') return '해동 저장 (냉동 → 냉장)';
    if (cur.mode === 're') return '재냉동 저장 (냉장 → 냉동)';
    return '출고 저장';
  }
  /* v7: 입력 팝업 제목·안내 (왼쪽 사이드바에서 연다) */
  var MEAT_FORM_INFO = {
    in: { t: '📥 입고 등록', s: '입고할 로트를 적고 저장하면 재고와 입출고 내역에 바로 쌓입니다.' },
    thaw: { t: '❄️ 해동 이동', s: '냉동고 재고를 냉장고로 옮깁니다. 로트를 고르면 단가가 채워집니다.' },
    re: { t: '🧊 재냉동 이동', s: '해동한 로트를 다시 냉동고로 되돌립니다. 사유를 비고에 남기세요.' },
    out: { t: '🚚 출고 등록', s: '창고 재고를 줄이고 출고처(현장·업체·택배·기타)를 남깁니다.' }
  };
  function setMode(mode) {
    cur.mode = mode;
    var btns = document.querySelectorAll('#meatFormPanel .mode');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-mode') === mode);
    var panes = document.querySelectorAll('#meatFormPanel [data-pane]');
    for (var j = 0; j < panes.length; j++) panes[j].classList.toggle('hidden', panes[j].getAttribute('data-pane') !== mode);
    var sub = $('btnSave');
    sub.className = 'submit ' + (mode === 'in' ? '' : (mode === 'thaw' ? 't-thaw' : (mode === 're' ? 't-re' : 't-out')));
    sub.textContent = submitLabel();
    $('formMsg').textContent = '';
    var info = MEAT_FORM_INFO[mode] || MEAT_FORM_INFO.in;
    if ($('meatFormTitle')) $('meatFormTitle').textContent = info.t;
    if ($('meatFormSub')) $('meatFormSub').textContent = info.s;
    updatePriceHint();
    return mode;
  }
  /* ---------- v7: 입력 팝업 열기/닫기 ---------- */
  function openMeatForm(mode) {
    if (cur.erp !== 'meat') setErpMode('meat');
    setMode(mode || 'in');
    var m = $('meatFormModal');
    if (m) m.classList.remove('hidden');
    var card = $('meatFormPanel');
    if (card) card.scrollTop = 0;
    if ($('meatFormTitle')) {
      try { $('meatFormTitle').scrollIntoView({ block: 'start' }); } catch (e) { }
    }
  }
  function closeMeatForm() {
    var m = $('meatFormModal');
    if (m) m.classList.add('hidden');
    document.body.classList.remove('photo-beside');
  }
  function meatFormOpen() {
    var m = $('meatFormModal');
    return !!m && !m.classList.contains('hidden');
  }
  function setOutWh(wh) {
    cur.whOut = wh;
    var btns = document.querySelectorAll('#whSegOut button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-wh') === wh);
  }
  function setInWh(wh) {
    cur.whIn = wh;
    var btns = document.querySelectorAll('#whSegIn button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-wh') === wh);
    if (cur.mode === 'in') $('btnSave').textContent = submitLabel();
  }
  /* v7: 브랜드를 한글로 적어도 표준 영문명으로 바꿔 준다 (파텔 → PATEL) */
  function normalizeBrandInput(el) {
    if (!el) return;
    var v = el.value || '';
    if (!v.replace(/\s+/g, '')) return;
    var std = ERP.brandStandard(v);
    if (!std || std === v) return;
    el.value = std;
    toast('브랜드를 표준 영문명 ' + std + ' 로 맞췄습니다.', 'ok');
  }
  function setDest(d) {
    cur.dest = ERP.destKey(d);
    var btns = document.querySelectorAll('#destSeg button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-dest') === cur.dest);
    $('destLabel').textContent = ERP.DEST_LABEL[cur.dest];
    var inp = $('outDest');
    var listId = cur.dest === 'vendor' ? 'dlVendors' : (cur.dest === 'courier' ? 'dlCourier' : (cur.dest === 'other' ? 'dlOther' : 'dlProducts'));
    inp.setAttribute('list', listId);
    inp.placeholder = {
      site: '예: 선진바베큐폭립', vendor: '예: 미트박스',
      courier: '예: 김사장님(김포) · 운송장 1234-5678', other: '예: 샘플 제공 · 폐기'
    }[cur.dest];
    $('destHint').textContent = ERP.DEST_HINT[cur.dest];
    fillDatalists();
  }

  function bindLot(lotId, act) {
    var lot = ERP.getLot(st, lotId);
    if (!lot) return;
    cur.lotId = lotId;
    if (act === 'thaw') {
      setMode('thaw');
      $('thLot').value = lotId;
      fillLotPrice('thaw', lot);
    } else if (act === 're') {
      setMode('re');
      $('reLot').value = lotId;
      fillLotPrice('re', lot);
    } else if (act === 'out') {
      cur.whOut = cur.tab === 'C' ? 'C' : (cur.tab === 'F' ? 'F' : cur.whOut);
      setMode('out');
      setOutWh(cur.whOut);
      $('outLot').value = lotId;
      fillLotPrice('out', lot);
    } else if (cur.mode === 'thaw') {
      if (lot.fq <= ERP.EPS) {
        toast('이 로트는 냉동고 재고가 0입니다. 출고로 전환합니다.', 'warn');
        setOutWh('F');
        setMode('out');
      } else {
        $('thLot').value = lotId;
        fillLotPrice('thaw', lot);
      }
    } else if (cur.mode === 're') {
      if (lot.cq <= ERP.EPS) {
        toast('이 로트는 냉장고 재고가 0입니다. 출고로 전환합니다.', 'warn');
        setOutWh('C');
        setMode('out');
      } else {
        $('reLot').value = lotId;
        fillLotPrice('re', lot);
      }
    }
    syncLotViews();
    renderTable();
    var kg = cur.mode === 'thaw' ? $('thKg') : (cur.mode === 're' ? $('reKg') : (cur.mode === 'out' ? $('outKg') : null));
    if (kg) { kg.value = ''; priceSync(cur.mode, 'kg'); }
  }

  /* ---------- 새로고침 ---------- */
  function refresh() {
    renderKPI();
    renderTable();
    syncLotViews();
    fillDatalists();
    fillFgDatalists();
    fillAccDatalists();
    renderRangeBar();
    renderFgKPI();
    renderFgCatBar();
    renderFgTable();
    renderAccKPI();
    renderAccTable();
    renderBuy();
    renderSale();
    renderProd();
    if (cur.reflectOpen) renderAccReflect();
    updatePriceHint();
    photoTick(false);
    if (xls.kind) renderXls();
  }

  function reload(opts) {
    opts = opts || {};
    if (!SB.auth.session()) return Promise.resolve();
    if (loading) { again = true; return Promise.resolve(); }
    loading = true;
    if (!opts.silent) setSync('wait', '불러오는 중…');
    return Promise.all([SB.db.loadAll(), SB.db.loadAllV4()]).then(function (pair) {
      var res = pair[0], v4 = pair[1] || {};
      st = ERP.stateFrom(res.lots, res.logs);
      var f = ERP.fpStateFrom(v4.fps, v4.fpLogs, v4.fpLots);
      var a = ERP.accStateFrom(v4.vouchers, v4.payments, v4.expenses);
      st.fps = f.fps; st.fpLogs = f.fpLogs; st.fpLots = f.fpLots;
      st.vouchers = a.vouchers; st.payments = a.payments; st.expenses = a.expenses;
      cur.v4ok = v4.v4 !== false;
      cur.v6ok = v4.v6 !== false;
      acCache = {};          /* v8.1 자동완성 후보를 다시 만든다 */
      refresh();
      if (!opts.silent) setSync('ok', '동기화 ' + clock());
      hideBanner();
      $('baseLabel').textContent = 'Supabase 실시간 공유 · 원료육 로트 ' + st.lots.length + ' · 완제품 ' + st.fps.length +
        ' · 회계 전표 ' + st.vouchers.length;
      if (!st.lots.length) {
        showBanner('아직 재고 데이터가 없습니다. Supabase SQL Editor에서 <b>supabase_setup.sql</b>을 실행했는지 확인해 주세요.');
      }
    }, function (e) {
      setSync('err', '동기화 실패');
      if (isSetupError(e)) {
        showBanner('DB 표·함수를 찾을 수 없습니다. Supabase SQL Editor에서 <b>supabase_setup.sql</b>(기존 DB라면 <b>supabase_migrate_v6.sql</b>)을 한 번 실행해 주세요.<br><span class="banner-sub">' + esc(e.message) + '</span>');
      } else if (e.status === 401 || e.kind === 'auth') {
        toast(e.message, 'err');
        doLogout(true);
      } else {
        toast(e.message, 'err');
      }
    }).then(function () {
      loading = false;
      if (again) { again = false; return reload({ silent: true }); }
    });
  }

  function enterApp(ses) {
    $('loginView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    $('whoami').innerHTML = '<b>' + esc(ses.name) + '</b><span>' + esc(ses.email) + '</span>';
    var d = today();
    ['inDate', 'inInDate', 'thDate', 'reDate', 'outDate', 'fgDate', 'accVDate', 'accPDate', 'accEDate'].forEach(function (id) {
      if ($(id) && !$(id).value) $(id).value = d;
    });
    if ($('accReflectFrom')) { $('accReflectFrom').value = d.slice(0, 8) + '01'; $('accReflectTo').value = d; }
    if ($('fgNewCat') && !$('fgNewCat').value) $('fgNewCat').value = '완제품';
    setInWh('F'); setOutWh('C'); setDest('site'); setMode('in');
    var savedMode = 'meat';
    try { savedMode = localStorage.getItem(MODE_KEY) || 'meat'; } catch (e) { }
    setErpMode(savedMode);
    setFgType('IN');
    reload().then(function () {
      LIVE.start(function () { reload({ silent: true }); }, liveLabel);
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(function () {
        if (document.visibilityState === 'visible' && SB.auth.session()) reload({ silent: true });
      }, CONFIG.POLL_MS);
      /* 입고 사진은 화면을 보고 있지 않아도 빠르게 알 수 있게 따로 확인한다 */
      photoTick(true);
      if (photoPollTimer) clearInterval(photoPollTimer);
      photoPollTimer = setInterval(function () {
        if (document.visibilityState === 'visible' && SB.auth.session()) photoTick(false);
      }, 20000);
    });
  }

  function doLogout(silent) {
    LIVE.stop();
    if (xls.kind) closeXls();
    closeFilter();
    closeRange();
    closeEdit(); closeLot();
    closeFgNew(); closeFgPrice(); closeUpload(); closeAccVoucher(); closeAccPay(); closeAccExpense();
    closeRowMenu(); closePhoto(); closePhotoInbox();
    closeMeatForm(); closeFgForm(); closeStmt(); closeSupplier(); closeAccHelp();
    photo.list = []; photo.count = 0; photo.loaded = false; photo.open = null;
    clearPhotoPick();
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (photoPollTimer) { clearInterval(photoPollTimer); photoPollTimer = null; }
    SB.auth.signOut().then(function () {
      $('appView').classList.add('hidden');
      $('loginView').classList.remove('hidden');
      $('liPw').value = '';
      setLoginMsg(silent ? '다시 로그인해 주세요.' : '로그아웃했습니다.', 'warn');
    });
  }

  function setLoginMsg(text, kind) {
    var el = $('loginMsg');
    el.textContent = text || '';
    el.className = 'lmsg ' + (kind || '');
  }

  /* ---------- 저장 ---------- */
  function clearErrs() {
    var errs = document.querySelectorAll('.err');
    for (var i = 0; i < errs.length; i++) errs[i].classList.remove('err');
  }
  function fieldId(name) {
    if (name === 'name') return 'inName';
    if (name === 'inDate') return 'inInDate';
    if (name === 'expiry') return 'inExpiry';
    if (name === 'dest') return 'outDest';
    if (name === 'date') return cur.mode === 'in' ? 'inDate' : (cur.mode === 'thaw' ? 'thDate' : (cur.mode === 're' ? 'reDate' : 'outDate'));
    if (name === 'kg') return cur.mode === 'in' ? 'inKg' : (cur.mode === 'thaw' ? 'thKg' : (cur.mode === 're' ? 'reKg' : 'outKg'));
    if (name === 'price') return cur.mode === 'in' ? 'inPrice' : (cur.mode === 'thaw' ? 'thPrice' : (cur.mode === 're' ? 'rePrice' : 'outPrice'));
    if (name === 'amount') return cur.mode === 'in' ? 'inAmount' : (cur.mode === 'thaw' ? 'thAmount' : (cur.mode === 're' ? 'reAmount' : 'outAmount'));
    return null;
  }
  function fieldFromMsg(msg) {
    if (/제품명/.test(msg)) return 'name';
    if (/입고일/.test(msg)) return 'inDate';
    if (/소비기한/.test(msg)) return 'expiry';
    if (/출고처/.test(msg)) return 'dest';
    if (/날짜/.test(msg)) return 'date';
    if (/중량/.test(msg)) return 'kg';
    if (/단가/.test(msg)) return 'price';
    if (/금액/.test(msg)) return 'amount';
    if (/창고/.test(msg)) return 'wh';
    return null;
  }
  function fail(msg, field) {
    $('formMsg').textContent = msg;
    if (field) {
      var id = fieldId(field);
      if (id && $(id)) { $(id).classList.add('err'); $(id).focus(); }
    }
    toast(msg, 'err');
  }
  function busy(on) {
    var b = $('btnSave');
    b.disabled = !!on;
    b.textContent = on ? '저장 중…' : submitLabel();
  }
  function numOrNull(id) {
    var v = $(id).value;
    return v === '' || v === null ? null : Number(v);
  }
  function params() {
    var p = { date: today(), type: cur.mode, wh: cur.whIn, lot_id: null, kg: 0, price: 0, amount: null };
    var ids = PRICE_IDS[cur.mode];
    p.price = Number($(ids.price).value || 0);
    p.amount = numOrNull(ids.amount);
    if (cur.mode === 'in') {
      p.date = $('inDate').value || today();
      p.name = $('inName').value;
      p.meat = $('inMeat').value;
      p.origin = $('inOrigin').value;
      p.vendor = $('inVendor').value;
      p.brand = $('inBrand').value;
      p.in_date = $('inInDate').value || null;
      p.exp_date = $('inExpiry').value || null;
      p.kg = Number($('inKg').value || 0);
      p.note = $('inNote').value;
    } else if (cur.mode === 'thaw') {
      p.date = $('thDate').value || today();
      p.wh = 'F';
      p.lot_id = dbId($('thLot').value);
      p.kg = Number($('thKg').value || 0);
      /* 생산품명 → 입출고 내역의 생산품목 칸 */
      p.dest_type = '';
      p.dest = $('thProd') ? $('thProd').value : '';
      p.note = $('thNote').value;
    } else if (cur.mode === 're') {
      p.date = $('reDate').value || today();
      p.wh = 'C';
      p.lot_id = dbId($('reLot').value);
      p.kg = Number($('reKg').value || 0);
      p.note = $('reNote').value;
    } else {
      p.date = $('outDate').value || today();
      p.wh = cur.whOut;
      p.lot_id = dbId($('outLot').value);
      p.dest_type = cur.dest;
      p.dest = $('outDest').value;
      p.kg = Number($('outKg').value || 0);
      p.note = $('outNote').value;
    }
    return p;
  }
  function dbId(lotId) {
    var lot = ERP.getLot(st, lotId);
    return lot ? lot.dbid : null;
  }
  function okMessage(p, row) {
    var kg = Number(row && row.qty || p.kg).toFixed(2);
    var name = (row && row.product_name) || p.name || '';
    var money = '';
    if (row && Number(row.total_amount) > 0) money = ' · ' + fmtInt(row.total_amount) + '원';
    if (p.type === 'in') {
      var isNew = !st.lots.some(function (l) { return l.dbid === Number(row.lot_id); });
      return '입고 완료: ' + name + ' ' + kg + 'kg' + money + ' → ' + (p.wh === 'F' ? '냉동고' : '냉장고') + (isNew ? ' (신규 로트)' : ' (기존 로트 합산)');
    }
    if (p.type === 'thaw') return '해동 완료: ' + name + ' ' + kg + 'kg' + money + ' (냉동고 → 냉장고)' + (p.dest ? ' · 생산품목 ' + p.dest : '');
    if (p.type === 're') return '재냉동 완료: ' + name + ' ' + kg + 'kg' + money + ' (냉장고 → 냉동고)';
    return '출고 완료: ' + name + ' ' + kg + 'kg' + money + ' (' + (p.wh === 'F' ? '냉동고' : '냉장고') +
      ' → [' + ERP.KIND_NAME[ERP.destKey(p.dest_type)] + '] ' + p.dest + ')';
  }
  function clearAfterSave() {
    var ids = PRICE_IDS[cur.mode];
    $(ids.price).value = '';
    $(ids.amount).value = '';
    if (cur.mode === 'in') {
      ['inName', 'inKg', 'inNote', 'inOrigin', 'inVendor', 'inBrand', 'inExpiry'].forEach(function (id) { $(id).value = ''; });
      $('inInDate').value = today();
      clearPhotoPick();
      updatePriceHint();
    } else if (cur.mode === 'thaw') {
      $('thKg').value = ''; $('thNote').value = '';
      if ($('thProd')) $('thProd').value = '';
      var tl = ERP.getLot(st, $('thLot').value);
      if (tl && tl.fq <= ERP.EPS) { $('thLot').value = ''; cur.lotId = null; }
    } else if (cur.mode === 're') {
      $('reKg').value = ''; $('reNote').value = '';
      var rl = ERP.getLot(st, $('reLot').value);
      if (rl && rl.cq <= ERP.EPS) { $('reLot').value = ''; cur.lotId = null; }
    } else {
      $('outKg').value = ''; $('outNote').value = ''; $('outDest').value = '';
      var ol = ERP.getLot(st, $('outLot').value);
      if (ol && ERP.qtyOf(ol, cur.whOut) <= ERP.EPS) { $('outLot').value = ''; cur.lotId = null; }
    }
  }

  /* v8: 저장과 동시에 구매·판매 전표 자동 반영 (실패해도 입출고 저장은 유지) */
  function autoLinkVoucher(link, taxType, label) {
    if (!link || typeof SB === 'undefined' || !SB.db || !SB.db.accReflect) return Promise.resolve(null);
    return SB.db.accReflect([link], taxType || 'auto').then(function (res) {
      if (res && Number(res.ok) > 0) {
        toast('🔄 ' + (label || '전표') + ' 자동 반영 — 구매·판매·회계관리에 함께 들어갔습니다.', 'ok');
      } else if (res && Number(res.skip) > 0) {
        toast('이미 전표가 있어 건너뛰었습니다. (' + (label || '전표') + ')', 'warn');
      }
      return res;
    }, function () {
      toast('저장은 됐지만 자동 전표 반영이 실패했습니다. 구매·판매관리에서 [⚡ 미반영 가져오기]를 눌러 주세요.', 'warn', 7000);
      return null;
    });
  }

  function submit() {
    if (!SB.auth.session()) { toast('먼저 로그인해 주세요.', 'err'); return; }
    $('formMsg').textContent = '';
    clearErrs();
    var p = params();
    var bad = ERP.precheck(p);
    if (bad) { fail(bad.msg, bad.field); return; }

    var pid = cur.mode === 'in' ? cur.photoId : null;
    busy(true);
    SB.db.apply(p).then(function (row) {
      var msg = okMessage(p, row);
      /* 입고를 저장하면서 대기 사진을 처리 완료로 바꿨다 */
      var mark = (pid && row)
        ? SB.db.photoMark(pid, 'registered', row.lot_id || null).then(function () { cur.photoId = null; photo.loaded = false; photo.count = -1; closePhoto(); },
          function () { toast('입고는 저장됐지만 사진 처리 표시가 실패했습니다. 대기함에서 삭제하거나 다시 등록해 주세요.', 'warn', 6000); })
        : Promise.resolve();
      /* v8: 입고=매입, 업체·택배·기타 출고=매출 자동 전표 (현장은 매출 없음) */
      var link = null;
      if (row && Number(row.total_amount) > 0) {
        if (cur.mode === 'in' && $('inAutoBuy') && $('inAutoBuy').checked) {
          link = ERP.linkOfMeat({ t: 'in', amt: Number(row.total_amount), dbid: row.id });
        } else if (cur.mode === 'out' && $('outAutoSale') && $('outAutoSale').checked) {
          link = ERP.linkOfMeat({ t: 'out', dt: p.dest_type, amt: Number(row.total_amount), dbid: row.id });
        }
      }
      return mark.then(function () {
        toast(msg, cur.mode);
        var lab = cur.mode === 'in' ? '매입 전표' : '매출 전표';
        if (p.dest_type === 'site' && cur.mode === 'out') lab = '';
        return autoLinkVoucher(link, 'free', lab);
      }).then(function () {
        clearAfterSave();
        cur.hLimit = 250;
        closeMeatForm();
        return reload({ silent: true });
      });
    }).then(function () {
      busy(false);
    }, function (e) {
      busy(false);
      fail(e.message, fieldFromMsg(e.message));
    });
  }

  /* ---------- 입력 수정 모달 ---------- */
  function openEdit(logId) {
    var e = ERP.getLog(st, logId);
    if (!e) { toast('내역을 찾을 수 없습니다. 새로고침 후 다시 시도하세요.', 'err'); return; }
    if (!e.act) { toast('엑셀에서 옮긴 원본 이력은 수정할 수 없습니다.', 'warn'); return; }
    editing = e;
    $('editSub').textContent = e.n + ' · ' + ERP.typeName(e.t) + ' · ' + ERP.moveName(e) +
      (e.worker ? ' · 작업자 ' + e.worker : '');
    $('edDate').value = e.d || '';
    $('edKg').value = e.k;
    $('edPrice').value = e.price > 0 ? e.price : '';
    /* 그 건의 방향에 맞는 단가 이름을 쓴다 (입고단가 / 출고단가 / 이동 단가) */
    if ($('edPriceLabel')) {
      $('edPriceLabel').textContent = e.t === 'in' ? '입고단가(원/kg)' : (e.t === 'out' ? '출고단가(원/kg)' : '단가(원/kg)');
    }
    $('edAmount').value = e.amt > 0 ? e.amt : (e.price > 0 ? Math.round(e.k * e.price) : '');
    $('edWh').value = e.w;
    $('edWh').disabled = (e.t === 'thaw' || e.t === 're');
    $('edDest').value = ERP.destKey(e.dt);
    $('edDestDetail').value = e.p || '';
    var isOut = e.t === 'out';
    var isThaw = e.t === 'thaw';
    $('edDestWrap').classList.toggle('hidden', !isOut);
    $('edDestDetailWrap').classList.toggle('hidden', !(isOut || isThaw));
    if ($('edDestDetailLabel')) {
      $('edDestDetailLabel').textContent = isThaw ? '생산품목'
        : (ERP.destKey(e.dt) === 'site' ? '생산품목' : '비고(업체명·수령처·사유)');
    }
    $('edNote').value = e.note || '';
    $('editMsg').textContent = '';
    $('editModal').classList.remove('hidden');
    setTimeout(function () { try { $('edKg').focus(); } catch (err) { } }, 40);
  }
  function closeEdit() {
    $('editModal').classList.add('hidden');
    editing = null;
  }
  function saveEdit() {
    if (!editing) return;
    var p = {
      logId: editing.dbid, type: editing.t,
      date: $('edDate').value, kg: Number($('edKg').value || 0),
      price: Number($('edPrice').value || 0), amount: $('edAmount').value === '' ? null : Number($('edAmount').value),
      wh: $('edWh').value, dest_type: editing.t === 'out' ? $('edDest').value : '', dest: $('edDestDetail').value,
      note: $('edNote').value
    };
    var bad = ERP.precheckUpdate(p);
    if (bad) { $('editMsg').textContent = bad.msg; return; }
    var b = $('editSave');
    b.disabled = true; b.textContent = '저장 중…';
    SB.db.update(p).then(function (row) {
      closeEdit();
      toast('수정 완료: ' + (row && row.product_name || editing && editing.n) + ' ' +
        Number(row && row.qty || p.kg).toFixed(2) + 'kg', 'ok');
      return reload({ silent: true });
    }).then(function () {
      b.disabled = false; b.textContent = '수정 저장';
    }, function (e) {
      b.disabled = false; b.textContent = '수정 저장';
      $('editMsg').textContent = e.message;
    });
  }

  /* ---------- 로트 정보 수정 ---------- */
  function openLot(lotId) {
    var lot = ERP.getLot(st, lotId);
    if (!lot) return;
    lotEditing = lot;
    $('lotSub').textContent = '로트 #' + lot.dbid + ' · 이 로트의 이력에도 같은 이름·분류가 적용됩니다.';
    $('ltMeat').value = lot.mt || '';
    $('ltName').value = lot.n || '';
    $('ltVendor').value = lot.v || '';
    $('ltBrand').value = lot.b || '';
    $('ltOrigin').value = lot.o || '';
    $('ltPrice').value = lot.price > 0 ? lot.price : '';
    $('ltInDate').value = lot.i || '';
    $('ltExp').value = lot.e || '';
    $('lotMsg').textContent = '';
    $('lotModal').classList.remove('hidden');
  }
  function closeLot() {
    $('lotModal').classList.add('hidden');
    lotEditing = null;
  }
  function saveLot() {
    if (!lotEditing) return;
    var name = ($('ltName').value || '').replace(/^\s+|\s+$/g, '');
    if (!name) { $('lotMsg').textContent = '품목명을 입력하세요.'; return; }
    var p = {
      lotId: lotEditing.dbid,
      meat: $('ltMeat').value, name: name,
      vendor: $('ltVendor').value, brand: $('ltBrand').value, origin: $('ltOrigin').value,
      price: $('ltPrice').value === '' ? null : Number($('ltPrice').value),
      in_date: $('ltInDate').value || null, exp_date: $('ltExp').value || null
    };
    var b = $('lotSave');
    b.disabled = true; b.textContent = '저장 중…';
    SB.db.lotUpdate(p).then(function (row) {
      closeLot();
      toast('로트 수정 완료: ' + (row && row.product_name || name), 'ok');
      return reload({ silent: true });
    }).then(function () {
      b.disabled = false; b.textContent = '수정 저장';
    }, function (e) {
      b.disabled = false; b.textContent = '수정 저장';
      $('lotMsg').textContent = e.message;
    });
  }

  /* ---------- CSV ---------- */
  function download(text, name) {
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 400);
  }
  function csvHistory() {
    download(ERP.csv(st), '입출고내역_' + today().replace(/-/g, '') + '.csv');
    toast('입출고 내역 ' + st.logs.length + '건을 CSV로 내려받았습니다.', 'ok');
  }
  function csvStock(wh) {
    var g = ERP.grouped(st, wh, '', false);
    var n = 0;
    for (var i = 0; i < g.length; i++) n += g[i].live;
    var kg = 0, amt = 0;
    for (var j = 0; j < st.lots.length; j++) {
      if (ERP.qtyOf(st.lots[j], wh) > ERP.EPS) { kg += ERP.qtyOf(st.lots[j], wh); amt += ERP.qtyOf(st.lots[j], wh) * st.lots[j].price; }
    }
    download(ERP.stockCsv(st, wh), (wh === 'F' ? '냉동고' : '냉장고') + '재고_' + today().replace(/-/g, '') + '.csv');
    toast((wh === 'F' ? '냉동고' : '냉장고') + ' 재고 ' + n + '개 로트 · ' + fmt(kg) + 'kg · ' + fmtInt(amt) + '원을 CSV로 내려받았습니다.', 'ok');
  }

  /* ---------- 사방넷 · 경리나라 양식 내려받기 ---------- */
  var xls = { kind: null, range: 'today' };

  function firstOfMonth() {
    var d = today().split('-');
    return d[0] + '-' + d[1] + '-01';
  }
  function rangeText(opt) {
    if (opt.range === 'all') return '전체 기간';
    if (opt.range === 'range') return (opt.from || '처음') + ' ~ ' + (opt.to || '오늘');
    return '오늘 (' + opt.today + ')';
  }
  function rangeTag(opt) {
    if (opt.range === 'all') return '전체';
    if (opt.range === 'range') return (opt.from || 'first') + '_' + (opt.to || 'last');
    return opt.today;
  }
  function xlsOpts() {
    return {
      range: xls.range,
      from: xls.range === 'range' ? ($('xlsFrom').value || '') : '',
      to: xls.range === 'range' ? ($('xlsTo').value || '') : '',
      today: today(),
      thaw: !!($('xlsThaw') && $('xlsThaw').checked),
      allOut: !!($('xlsAllOut') && $('xlsAllOut').checked),
      vat: ($('xlsVat') && $('xlsVat').value) || '면세'
    };
  }
  function xlsRows(kind, opt) {
    return kind === 'sales' ? ERP.salesRows(st, opt) : ERP.sabangnetRows(st, opt);
  }

  function renderXls() {
    if (!xls.kind) return;
    var isSales = xls.kind === 'sales';
    $('xlsRangeBox').classList.toggle('hidden', xls.range !== 'range');
    var opt = xlsOpts();
    var rows = xlsRows(xls.kind, opt);
    var n = rows.length - 1, qtyCol = isSales ? 11 : 3, f = 0, ch = 0, kg = 0, won = 0, i;
    for (i = 1; i < rows.length; i++) {
      if (rows[i][6] === '냉동고') f++; else if (rows[i][6] === '냉장고') ch++;
      kg += Number(rows[i][qtyCol]) || 0;
      if (isSales) won += Number(rows[i][14]) || 0;
    }
    var box = $('xlsCount');
    if (!n) {
      box.className = 'xls-count none';
      box.textContent = rangeText(opt) + '에 해당하는 ' + (isSales ? '출고' : '입고') +
        ' 내역이 없습니다. 날짜 범위를 [전체]로 바꾸거나 기간을 넓혀 보세요.';
    } else {
      box.className = 'xls-count';
      box.textContent = rangeText(opt) + ' · ' + (isSales ? '매출' : '입고') + ' ' + n + '건 · 냉동고 ' + f +
        ' / 냉장고 ' + ch + ' · 합계 ' + fmt(kg) + 'kg' + (isSales && won ? ' · 공급가액 ' + fmtInt(won) + '원' : '');
    }
    $('xlsGo').disabled = !n;
    return n;
  }

  function openXls(kind) {
    xls.kind = kind;
    var isSales = kind === 'sales';
    $('xlsTitle').textContent = isSales ? '경리나라 매출 양식 내려받기' : '사방넷 입고 양식 내려받기';
    $('xlsSub').textContent = isSales
      ? '업체 출고를 경리나라 [매출거래명세표 일괄등록] 양식(.xlsx, 시트 일괄등록)으로 만듭니다. 출고 단가가 있으면 단가·공급가액·세액을 계산해 넣고, 단가가 없으면 0으로 두니 업로드한 뒤 입력하세요.'
      : '입고를 사방넷 풀필먼트 [엑셀입고] 양식(.xlsx, 시트 엑셀입고)으로 만듭니다. 매입처는 업체명, 로케이션은 냉동고·냉장고, 소비기한은 8자리(YYYYMMDD)로 들어갑니다.';
    $('xlsOptSabang').classList.toggle('hidden', isSales);
    $('xlsOptSales').classList.toggle('hidden', !isSales);
    if (xls.range === 'range') {
      if (!$('xlsFrom').value) $('xlsFrom').value = firstOfMonth();
      if (!$('xlsTo').value) $('xlsTo').value = today();
    }
    var segs = document.querySelectorAll('#xlsRangeSeg button');
    for (var i = 0; i < segs.length; i++) {
      segs[i].classList.toggle('active', segs[i].getAttribute('data-range') === xls.range);
    }
    $('xlsModal').classList.remove('hidden');
    renderXls();
    if (!$('xlsGo').disabled) $('xlsGo').focus();
  }
  function closeXls() {
    $('xlsModal').classList.add('hidden');
    xls.kind = null;
  }

  function downloadXls() {
    if (!xls.kind) return;
    var isSales = xls.kind === 'sales';
    var opt = xlsOpts();
    var rows = xlsRows(xls.kind, opt);
    if (rows.length < 2) { toast('내려받을 내역이 없습니다. 날짜 범위를 넓혀 보세요.', 'warn'); return; }
    var bytes = ERP.xlsxBytes([{
      name: isSales ? '일괄등록' : '엑셀입고',
      rows: rows,
      widths: isSales
        ? [12, 8, 20, 14, 10, 12, 9, 9, 10, 24, 16, 9, 7, 9, 11, 9, 26, 10, 10, 20]
        : [16, 14, 26, 10, 11, 11, 10, 34]
    }]);
    var blob = new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (isSales ? '매출거래명세표_일괄등록_' : '사방넷_엑셀입고_') + rangeTag(opt).replace(/-/g, '') + '.xlsx';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 600);
    toast((isSales ? '경리나라 매출 양식' : '사방넷 입고 양식') + ' ' + (rows.length - 1) + '건을 엑셀로 내려받았습니다.', 'ok');
    closeXls();
  }

  /* ---------- 자동완성 ---------- */
  function datalist(id, arr) {
    var el = $(id);
    if (!el) return;
    var html = [], seen = {}, i;
    for (i = 0; i < arr.length; i++) {
      var v = String(arr[i] === null || arr[i] === undefined ? '' : arr[i]).replace(/^\s+|\s+$/g, '');
      if (!v || seen[v]) continue;
      seen[v] = 1;
      html.push('<option value="' + esc(v) + '"></option>');
    }
    el.innerHTML = html.join('');
  }
  function fillDatalists() {
    var d = ERP.dict(st), h = ERP.destHistory(st);
    datalist('dlNames', d.names);
    datalist('dlVendors', d.vendors);
    datalist('dlOrigins', d.origins);
    /* v7: 표준 영문 브랜드를 먼저 보여 주고, DB에 있는 브랜드도 함께 제안한다 */
    datalist('dlBrands', ERP.brandList().concat(d.brands));
    datalist('dlProducts', d.products);
    datalist('dlCourier', h.courier);
    datalist('dlOther', h.other);
    datalist('dlMeats', d.meats);
  }

  /* ---------- 이벤트 ---------- */
  /* ---------- 검색 버튼 · Enter ---------- */
  function doSearch(id) {
    var sumId = typeof id === 'string' ? id : 'search';
    var el = $(sumId);
    if (sumId === 'fgSearch') {
      cur.fgSearch = el ? el.value || '' : '';
      cur.fgLimit = 300;
      renderFgTable();
      toast('완제품 ' + (cur.fgSearch ? '검색: ' + cur.fgSearch : '검색') + ' · ' + ($('fgRangeSum').textContent || '결과'), 'ok');
      return;
    }
    if (sumId === 'accSearch') {
      cur.accSearch = el ? el.value || '' : '';
      cur.accLimit = 300;
      renderAccTable();
      toast('회계 ' + (cur.accSearch ? '검색: ' + cur.accSearch : '검색') + ' · ' + ($('accRangeSum').textContent || '결과'), 'ok');
      return;
    }
    cur.search = el ? el.value || '' : '';
    cur.hLimit = 250;
    renderTable();
    var sum = $('rangeSum') ? $('rangeSum').textContent : '';
    toast((cur.search ? '검색: ' + cur.search + ' · ' : '검색 ') + (sum || '결과를 표에 보여줍니다'), 'ok');
  }

  /* ---------- 열 너비 드래그 ---------- */
  function bindColResize() {
    var drag = null;
    var wrapEl = $('tableWrap');
    wrapEl.addEventListener('pointerdown', function (ev) {
      var h = ev.target.closest ? ev.target.closest('.colrz') : null;
      if (!h) return;
      var key = h.getAttribute('data-rz');
      var col = wrapEl.querySelector('col[data-colwrap="' + key + '"]');
      if (!col) return;
      ev.preventDefault();
      ev.stopPropagation();
      var w0 = parseFloat(col.style.width) || col.getBoundingClientRect().width;
      drag = { key: key, tbl: tblOf(cur.tab), col: col, x: ev.clientX, w: w0, cur: w0, h: h };
      try { h.setPointerCapture(ev.pointerId); } catch (e) { }
      h.classList.add('on');
      document.body.classList.add('colresizing');
    });
    document.addEventListener('pointermove', function (ev) {
      if (!drag) return;
      var dx = ev.clientX - drag.x;
      var w = Math.round(drag.w + dx);
      w = Math.max(COL_MIN, Math.min(COL_MAX, w));
      if (w === drag.cur) return;
      drag.cur = w;
      drag.col.style.width = w + 'px';
      syncTableWidth();
    });
    function endDrag() {
      if (!drag) return;
      if (!COLW[drag.tbl]) COLW[drag.tbl] = {};
      COLW[drag.tbl][drag.key] = Math.round(drag.cur);
      saveColW();
      drag.h.classList.remove('on');
      drag = null;
      document.body.classList.remove('colresizing');
    }
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
    wrapEl.addEventListener('dblclick', function (ev) {
      var h = ev.target.closest ? ev.target.closest('.colrz') : null;
      if (!h) return;
      ev.preventDefault();
      ev.stopPropagation();
      autoFitCol(tblOf(cur.tab), h.getAttribute('data-rz'));
    });
    wrapEl.addEventListener('click', function (ev) {
      if (ev.target.closest && ev.target.closest('.colrz')) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    }, true);
  }

  /* ==========================================================================
     v4 화면 — 🥩 원료육 | 📦 완제품 | 💰 회계 3모드
     ========================================================================== */
  function acc() {
    return { vouchers: st.vouchers || [], payments: st.payments || [], expenses: st.expenses || [] };
  }
  function fmtQty(v) {
    var n = Math.round((Number(v) || 0) * 1000) / 1000;
    var neg = n < 0;
    var s2 = Math.abs(n).toString();
    var parts = s2.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + parts.join('.');
  }
  function won(n) { return fmtInt(n) + '원'; }
  function downloadXlsxFile(sheets, filename) {
    var bytes = ERP.xlsxBytes(sheets);
    var blob = new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 600);
  }
  function ymdTag() { return today().replace(/-/g, ''); }

  /* ---------- v8: 6대 메뉴 · 화면 전환 ---------- */
  var MODE_KEY = 'meatERP.erpMode.v2';
  var PANE_HOSTS = { meat: 'meatMode', fg: 'fgMode', buy: 'buyPane', sale: 'salePane', prod: 'prodPane', acc: 'accMode' };
  var PANE_CAT = { meat: 'stock', fg: 'stock', buy: 'buy', sale: 'sale', prod: 'prod', acc: 'acc' };
  var PANE_HEAD = {
    meat: ['재고관리 · 원료육 재고', '원료육 재고를 냉동고·냉장고로 나눠 보고, 표에서 바로 해동·출고로 이어집니다.', '2. 재고관리'],
    fg: ['재고관리 · 완제품·부자재 재고', '완제품·부자재를 대분류로 나눠 보고, 단가와 재고금액을 확인합니다.', '2. 재고관리'],
    buy: ['구매관리 · 매입 전표 · 미지급금', '입고는 매입 전표로 자동 이어지고, 지급하면 미지급금이 줄어듭니다.', '3. 구매관리'],
    sale: ['판매관리 · 매출 전표 · 미수금', '업체·택배 출고는 매출로 자동 이어지고, 거래명세표를 A4로 바로 찍습니다.', '4. 판매관리'],
    prod: ['생산·원가관리 · 현장 투입', '현장 출고만 모아 생산투입금액과 품목별 실제 제조원가를 냅니다. 매출은 0원입니다.', '5. 생산·원가관리'],
    acc: ['회계·손익 · 종합 KPI', '미수금·미지급금·이번 달 매출·매입·생산투입·예상 순이익을 한눈에 봅니다.', '6. 회계·손익']
  };
  function paneName(p) {
    return p === 'meat' ? 'stock' : p;
  }
  /* v8: 재고관리 하위 메뉴 · 내역 전환 */
  function setStockView(key, keepGroup) {
    var o = { keepGroup: !!keepGroup };
    if (key === 'meat') { cur.tab = cur.wh || 'F'; setPane('meat', o); }
    else if (key === 'freeze') { cur.wh = 'F'; cur.tab = 'F'; setPane('meat', o); }
    else if (key === 'chill') { cur.wh = 'C'; cur.tab = 'C'; setPane('meat', o); }
    else if (key === 'price') { cur.tab = 'V'; setPane('meat', o); }
    else if (key === 'fg') { cur.fgTab = 'G'; setPane('fg', o); }
    else if (key === 'hist') { setHist(cur.histView || 'meat', keepGroup); }
  }
  /* v12: 원료육 재고 화면 안의 🧊 냉동고 / ❄️ 냉장고 구분 버튼 */
  function setMeatWh(wh, keepGroup) {
    cur.wh = wh === 'C' ? 'C' : 'F';
    cur.tab = cur.wh;
    cur.hLimit = 250;
    setPane('meat', { keepGroup: !!keepGroup });
  }
  function renderMeatWhTabs() {
    var box = $('meatWhTabs');
    if (!box) return;
    box.classList.toggle('hidden', !(cur.erp === 'meat' && (cur.tab === 'F' || cur.tab === 'C')));
    var btns = box.querySelectorAll('[data-wh]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-wh') === (cur.tab === 'C' ? 'C' : 'F'));
    }
  }
  /* 재고 화면 · 내역 화면에 따라 검색·필터 자리를 맞춘다 */
  function syncMeatTabUI() {
    if (cur.erp !== 'meat') return;
    var isH = cur.tab === 'H', isV = cur.tab === 'V';
    if ($('zeroWrap')) $('zeroWrap').classList.toggle('hidden', isH || isV);
    if ($('typeFilter')) $('typeFilter').classList.toggle('hidden', !isH);
    if ($('histNote')) $('histNote').classList.toggle('hidden', !isH);
    if ($('chgNote')) $('chgNote').classList.toggle('hidden', !isV);
    if ($('search')) $('search').placeholder = isV
      ? '🔍 품목명 · 육류 · 업체명 검색'
      : '🔍 제품명 · 업체명 · 브랜드(한/영) · 날짜 검색';
    renderMeatWhTabs();
  }
  function setHist(view, keepGroup) {
    cur.histView = view === 'fg' ? 'fg' : 'meat';
    var o = { keepGroup: !!keepGroup };
    if (cur.histView === 'fg') { cur.fgTab = 'L'; setPane('fg', o); }
    else { cur.tab = 'H'; setPane('meat', o); }
    renderHistSwitch();
  }
  function renderHistSwitch() {
    var on = (cur.erp === 'meat' && cur.tab === 'H') || (cur.erp === 'fg' && cur.fgTab === 'L');
    if ($('histSwitch')) $('histSwitch').classList.toggle('hidden', !on);
    var btns = document.querySelectorAll('#histSwitch [data-hist]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-hist') === (cur.histView || 'meat'));
    }
    var ft = document.querySelectorAll('#fgTabs [data-ftab]');
    for (var j = 0; j < ft.length; j++) {
      ft[j].classList.toggle('active', cur.erp === 'fg' && ft[j].getAttribute('data-ftab') === cur.fgTab);
    }
  }

  function markSide(onCat, onItem) {
    var cats = document.querySelectorAll('#v8Side .v8cat');
    for (var i = 0; i < cats.length; i++) cats[i].classList.toggle('on', cats[i].getAttribute('data-cat') === onCat);
    var items = document.querySelectorAll('#v8Side .v8item');
    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var isOn = false;
      if (onItem && it.hasAttribute(onItem.key)) isOn = it.getAttribute(onItem.key) === onItem.val;
      it.classList.toggle('on', isOn);
      if (isOn) it.classList.add('active');
    }
  }
  function openGroup(cat) {
    var grps = document.querySelectorAll('#v8Side .v8grp');
    for (var i = 0; i < grps.length; i++) {
      var g = grps[i];
      var on = g.getAttribute('data-grp') === cat;
      g.classList.toggle('open', on);
      var btn = g.querySelector('.v8cat');
      if (btn) btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
  }
  /* v8.4: 그 대메뉴의 하위 메뉴 목록이 지금 펼쳐져 있는지 */
  function groupOpen(cat) {
    var g = document.querySelector('#v8Side .v8grp[data-grp="' + cat + '"]');
    return !!(g && g.classList.contains('open'));
  }
  /* v8.4: 대메뉴를 다시 눌렀을 때 — 여섯 대메뉴의 하위 목록을 모두 접는다 */
  function closeAllGroups() {
    var grps = document.querySelectorAll('#v8Side .v8grp');
    for (var i = 0; i < grps.length; i++) {
      grps[i].classList.remove('open');
      var b = grps[i].querySelector('.v8cat');
      if (b) b.setAttribute('aria-expanded', 'false');
    }
  }
  /* 접는 대메뉴가 열어 둔 팝업(허브·입력·전표·명세표 등)도 같이 닫는다 */
  function closeCatPop(cat) {
    var key = cur.sidePop || '';
    if (key !== 'cat:' + cat && key.indexOf(cat + ':') !== 0) return;
    if (cur.sidePopId) popClose(cur.sidePopId);
    cur.sidePop = ''; cur.sidePopId = '';
    markSidePop(null);
  }
  /* 폰에서는 하위 메뉴가 드롭다운이라, 하나 고르면 접어 준다 */
  function closeMobileGroups() {
    if (window.innerWidth > 768) return;
    var grps = document.querySelectorAll('#v8Side .v8grp');
    for (var i = 0; i < grps.length; i++) {
      grps[i].classList.remove('open');
      var b = grps[i].querySelector('.v8cat');
      if (b) b.setAttribute('aria-expanded', 'false');
    }
  }
  function updatePageHead() {
    var h = PANE_HEAD[cur.erp] || PANE_HEAD.meat;
    /* v11 — 회계는 탭마다 머리말이 다르다(받을돈·줄돈 정산) */
    if (cur.erp === 'acc' && cur.accTab === 'S') {
      h = ['회계·손익 · 받을돈·줄돈 정산', '거래처별 받을돈·줄돈을 한 표에서 보고, 줄마다 금액을 적어 그 자리에서 수금·지급을 저장합니다.', '6. 회계·손익'];
    }
    if ($('v8Title')) $('v8Title').textContent = h[0];
    if ($('v8Desc')) $('v8Desc').textContent = h[1];
    if ($('v8Crumb')) $('v8Crumb').textContent = h[2];
  }
  function setErpMode(m) {
    if (m === 'fg') return setPane('fg');
    if (m === 'acc') return setPane('acc');
    return setPane(m && PANE_HOSTS[m] ? m : 'meat');
  }
  function setPane(p, opt) {
    opt = opt || {};
    if (!PANE_HOSTS[p]) p = 'meat';
    cur.erp = p;
    cur.pane = paneName(p);
    try { localStorage.setItem(MODE_KEY, p); } catch (e) { }
    for (var k in PANE_HOSTS) {
      if (!Object.prototype.hasOwnProperty.call(PANE_HOSTS, k)) continue;
      var el = $(PANE_HOSTS[k]);
      if (el) el.classList.toggle('hidden', k !== p);
    }
    if ($('meatKpi')) $('meatKpi').classList.toggle('hidden', p !== 'meat');
    if ($('fgKpi')) $('fgKpi').classList.toggle('hidden', p !== 'fg');
    if ($('accKpi')) $('accKpi').classList.toggle('hidden', p !== 'acc');
    openGroup(PANE_CAT[p] || 'stock');
    var item = null;
    if (p === 'meat') item = { key: 'data-tab', val: (cur.tab === 'H' ? 'H' : (cur.tab === 'V' ? 'V' : 'M')) };
    else if (p === 'fg') item = { key: 'data-ftab', val: cur.fgTab };
    else if (p === 'buy') item = { key: 'data-buy', val: cur.buyView === 'status' ? 'status' : 'list' };
    else if (p === 'sale') item = { key: 'data-sale', val: cur.saleView === 'status' ? 'status' : 'list' };
    else if (p === 'prod') item = { key: 'data-prod', val: cur.prodView || 'sum' };
    else if (p === 'acc') item = { key: 'data-atab', val: cur.accTab };
    markSide(PANE_CAT[p] || 'stock', item);
    closeFilter();
    closeRange();
    updatePageHead();
    updateQuickLabels();
    if (!$('appView').classList.contains('hidden')) {
      renderRangeBar();
      if (p === 'meat') { syncMeatTabUI(); renderTable(); }
      else if (p === 'fg') { renderFgKPI(); renderFgCatBar(); renderFgTable(); }
      else if (p === 'buy') renderBuy();
      else if (p === 'sale') renderSale();
      else if (p === 'prod') renderProd();
      else if (p === 'acc') { renderAccKPI(); renderAccTable(); }
      renderHistSwitch();
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
    }
    if (!opt.keepGroup) closeMobileGroups();
  }
  function updateQuickLabels() {
    var f = $('qbForm'), l = $('qbList');
    if (!f) return;
    f.textContent = '📝 입출고 입력';
    l.textContent = '📋 6대 메뉴';
  }
  function openMeatQuick() {
    openIoHub();
  }
  function scrollPanel(which) {
    if (which === 'form') { openIoHub(); return; }
    var side = $('v8Side');
    if (side) { try { side.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { side.scrollIntoView(); } }
  }
  function renderCurrent() {
    if (cur.erp === 'fg') renderFgTable();
    else if (cur.erp === 'buy') renderBuy();
    else if (cur.erp === 'sale') renderSale();
    else if (cur.erp === 'prod') renderProd();
    else if (cur.erp === 'acc') renderAccTable();
    else renderTable();
  }

  /* ---------- v8: 입출고 입력 허브 ---------- */
  function openIoHub() {
    var m = $('ioHubModal');
    if (m) m.classList.remove('hidden');
  }
  function closeIoHub() {
    var m = $('ioHubModal');
    if (m) m.classList.add('hidden');
  }
  function doIoAction(a) {
    closeIoHub();
    closeMobileGroups();
    if (a === 'photo') { openPhotoInbox(); return; }
    if (a === 'sheet-in') { openIoSheet('IN'); return; }
    if (a === 'sheet-out') { openIoSheet('OUT'); return; }
    if (a === 'fp-in' || a === 'fp-out' || a === 'fp-new') {
      openFgForm(a === 'fp-new' ? 'new' : (a === 'fp-out' ? 'OUT' : 'IN'));
      return;
    }
    openMeatForm(a);
  }


  /* ---------- 표 머리글 (필터가 없는 표: 제목만) ---------- */
  function thPlain(c) {
    return '<th class="' + (c.num ? 'num' : '') + '" data-col="' + c.k + '">' +
      '<div class="hdbox"><span class="th-plain" style="flex:1 1 auto;overflow:hidden;text-overflow:ellipsis">' + esc(c.t) + '</span></div>' +
      '<span class="colrz" data-rz="' + c.k + '" title="드래그: 열 너비 조절 / 더블클릭: 내용에 맞춤"></span></th>';
  }
  function setFgSum(n, qty, amt) {
    var el = $('fgRangeSum');
    if (el) el.textContent = n + (qty !== null && qty !== undefined ? ' · ' + fmtQty(qty) + '개' : '') + (amt ? ' · ' + fmtInt(amt) + '원' : '');
  }
  function setAccSum(text) {
    var el = $('accRangeSum');
    if (el) el.textContent = text || '';
  }
  function noV4(text) {
    return '<div class="setuptip">' + text + '</div>';
  }

  /* ==========================================================================
     📦 완제품 ERP
     ========================================================================== */
  var FG_CATS_KEY = 'meatERP.fgCats.v1';
  function loadFgCats() {
    try {
      var raw = localStorage.getItem(FG_CATS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      cur.fgCats = [];
      for (var i = 0; i < (arr || []).length; i++) if (typeof arr[i] === 'string' && arr[i]) cur.fgCats.push(arr[i]);
    } catch (e) { cur.fgCats = []; }
  }
  function saveFgCats() {
    try { localStorage.setItem(FG_CATS_KEY, JSON.stringify(cur.fgCats)); } catch (e) { }
  }
  function addFgCat() {
    var wrap = $('fgCatExtra');
    if (!wrap) return;
    if (wrap.getAttribute('data-on') === '1') return;
    wrap.setAttribute('data-on', '1');
    wrap.innerHTML = '<input id="fgCatNew" class="catchip-input" placeholder="대분류 이름" maxlength="12">' +
      '<button class="catchip add" id="fgCatNewGo" type="button">추가</button>';
    var inp = $('fgCatNew');
    try { inp.focus(); } catch (e) { }
    function done() {
      var v = (inp.value || '').replace(/^\s+|\s+$/g, '');
      wrap.removeAttribute('data-on');
      wrap.innerHTML = '';
      if (!v) return;
      if (ERP.FP_CATS.indexOf(v) < 0 && cur.fgCats.indexOf(v) < 0) cur.fgCats.push(v);
      saveFgCats();
      renderFgCatBar();
      cur.fgCat = v;
      renderFgCatBar();
      renderFgTable();
      toast('대분류 "' + v + '" 로 봅니다.', 'ok');
    }
    $('fgCatNewGo').addEventListener('click', done);
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); done(); }
      if (ev.key === 'Escape') { wrap.removeAttribute('data-on'); wrap.innerHTML = ''; }
    });
  }
  function fgCatsAll() {
    var out = ERP.FP_CATS.slice(), i;
    for (i = 0; i < cur.fgCats.length; i++) if (out.indexOf(cur.fgCats[i]) < 0) out.push(cur.fgCats[i]);
    for (i = 0; i < st.fps.length; i++) if (st.fps[i].cat && out.indexOf(st.fps[i].cat) < 0) out.push(st.fps[i].cat);
    return out;
  }
  function renderFgCatBar() {
    var bar = $('fgCatBar');
    if (!bar) return;
    var counts = {}, total = 0, groups = {}, i, p;
    for (i = 0; i < st.fps.length; i++) {
      p = st.fps[i];
      counts[p.cat] = (counts[p.cat] || 0) + 1;
      total++;
      var gg = ERP.fpCatGroup(p.cat);
      groups[gg] = (groups[gg] || 0) + 1;
    }
    var chips = bar.querySelectorAll('[data-fgcat]');
    for (i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('active', chips[i].getAttribute('data-fgcat') === (cur.fgCat || 'all'));
    }
    if ($('fgCatAll')) $('fgCatAll').textContent = total + '품목';
    if ($('fgCat1')) $('fgCat1').textContent = (groups['완제품'] || 0) + '개';
    if ($('fgCat2')) $('fgCat2').textContent = (groups['부자재·포장지'] || 0) + '개';
    if ($('fgCat3')) $('fgCat3').textContent = (groups['야채·소스'] || 0) + '개';
    var extra = $('fgCatExtra');
    if (extra) {
      var html = [], list = cur.fgCats.slice();
      for (i = 0; i < st.fps.length; i++) {
        var c = st.fps[i].cat;
        if (list.indexOf(c) < 0 && ERP.fpCatGroup(c) === '기타') list.push(c);
      }
      for (i = 0; i < list.length; i++) {
        if (ERP.fpCatGroup(list[i]) !== '기타') continue;
        html.push('<button class="catchip' + (cur.fgCat === list[i] ? ' active' : '') + '" data-fgcat="' + esc(list[i]) + '" type="button"><b>' +
          esc(list[i]) + '</b><span>' + (counts[list[i]] || 0) + '개</span></button>');
      }
      if (extra.getAttribute('data-on') !== '1') extra.innerHTML = html.join('');
    }
  }

  function renderFgKPI() {
    if (!$('kFgStock')) return;
    var t = ERP.fpTotals(st.fps);
    var td = ERP.fpToday(st.fps, st.fpLogs, today());
    kpiRaw('kFgStock', fmtQty(t.stock));
    kpi('kFgHold', t.hold, 0);
    kpi('kFgValue', t.amount, 0);
    kpi('kFgToday', td.cnt, 0);
    kpi('kFgNoPrice', t.noPrice, 0);
    $('kFgStockSub').textContent = '보유 품목 ' + t.hold + '개';
    $('kFgHoldSub').textContent = '전체 ' + t.total + '품목 중';
    $('kFgValueSub').textContent = '입고단가 있는 ' + (t.total - t.noPrice) + '품목 기준';
    $('kFgTodaySub').textContent = '오늘 금액 ' + fmtInt(td.amount) + '원';
    if ($('fgCountBadge')) $('fgCountBadge').textContent = String(t.hold);
    if ($('cntFg')) $('cntFg').textContent = String(t.total);
    if ($('cntFgLog')) $('cntFgLog').textContent = String(st.fpLogs.length);
    if ($('cntFgPrice')) $('cntFgPrice').textContent = String(t.total - t.noPrice);
  }

  function fgCellHtml(p, k) {
    if (k === 'cat') return '<td><span class="cat-tag">' + esc(p.cat || '-') + '</span></td>';
    if (k === 'code') return '<td class="code-cell">' + esc(p.code) + '</td>';
    if (k === 'n') return '<td class="ellip" title="' + esc(p.n) + '"><b>' + esc(p.n) + '</b>' + (p.active ? '' : ' <span class="ttag">비활성</span>') + '</td>';
    if (k === 'spec') return '<td class="ellip">' + esc(p.spec || '-') + '</td>';
    if (k === 'unit') return '<td>' + esc(p.unit || '-') + '</td>';
    if (k === 'stock') return '<td class="num' + (p.stock <= 0.0004 ? ' zero' : '') + '">' + fmtQty(p.stock) + '</td>';
    if (k === 'inp') return '<td class="num">' + (p.inp > 0 ? fmtInt(p.inp) : '<span class="ttag">-</span>') + '</td>';
    if (k === 'outp') return '<td class="num">' + (p.outp > 0 ? fmtInt(p.outp) : '<span class="ttag">-</span>') + '</td>';
    if (k === 'amt') return '<td class="num" title="' + (p.inp > 0 ? fmtInt(p.amt) + '원' : '단가 미입력') + '">' +
      (p.inp > 0 ? fmtInt(p.amt) : '<span class="ttag">-</span>') + '</td>';
    if (k === 'lot') return '<td class="ellip" title="' + esc(p.lot || '') + '">' + (p.lot ? '<span class="lotno">' + esc(p.lot) + '</span>' : '<span class="ttag">-</span>') + '</td>';
    if (k === 'inD') return '<td>' + (p.inD ? esc(p.inD) : '<span class="ttag">-</span>') + '</td>';
    if (k === 'e') return '<td>' + (p.e ? esc(p.e) + ddayHtml(p.e) : '<span class="ttag">-</span>') + '</td>';
    return '<td class="ellip">' + esc(ERP.fpCell(p, k) || '-') + '</td>';
  }
  function fgLogCellHtml(g, k) {
    if (k === 'd') return '<td>' + esc(g.d || '-') + '</td>';
    if (k === 't') return '<td><span class="badge ' + (g.t === 'IN' ? 'in' : 'out') + '">' + ERP.fpTypeName(g.t) + '</span></td>';
    if (k === 'code') return '<td class="code-cell">' + esc(g.code) + '</td>';
    if (k === 'n') return '<td class="ellip" title="' + esc(g.n) + '"><b>' + esc(g.n) + '</b></td>';
    if (k === 'spec') return '<td class="ellip">' + esc(g.spec || '-') + '</td>';
    if (k === 'unit') return '<td>' + esc(g.unit || '-') + '</td>';
    if (k === 'q') return '<td class="num">' + (g.t === 'IN' ? '+' : '-') + fmtQty(g.q) + '</td>';
    if (k === 'inp') return '<td class="num">' + (g.t === 'IN' && g.inp > 0 ? fmtInt(g.inp) : '<span class="ttag">-</span>') + '</td>';
    if (k === 'outp') return '<td class="num">' + (g.t === 'OUT' && g.outp > 0 ? fmtInt(g.outp) : '<span class="ttag">-</span>') + '</td>';
    if (k === 'amt') return '<td class="num">' + (g.amt > 0 ? fmtInt(g.amt) : '<span class="ttag">-</span>') + '</td>';
    if (k === 'lot') return '<td class="ellip" title="' + esc(g.lot || '') + '">' + (g.lot ? '<span class="lotno">' + esc(g.lot) + '</span>' : '<span class="ttag">-</span>') + '</td>';
    if (k === 'e') return '<td>' + (g.e ? esc(g.e) : '<span class="ttag">-</span>') + '</td>';
    if (k === 'p') {
      var t = [g.p, g.note].filter(function (v) { return !!v; }).join(' · ');
      return '<td class="ellip" title="' + esc(t) + '">' + (t ? (g.p ? esc(g.p) : '') + (g.note ? ' <span class="ttag">' + esc(g.note) + '</span>' : '') : '<span class="ttag">-</span>') + '</td>';
    }
    if (k === 'worker') return '<td class="ellip">' + (g.worker ? '<span class="worker">' + esc(g.worker) + '</span>' : '<span class="ttag">-</span>') + '</td>';
    return '<td class="ellip">' + esc(ERP.fpLogCell(g, k) || '-') + '</td>';
  }
  function fgFiltered(kind) {
    if (kind === 'L') {
      return ERP.fpFilteredLogs(st.fpLogs, {
        q: cur.fgSearch, type: cur.fgTypeF, cat: cur.fgCat,
        from: cur.fgRange.from, to: cur.fgRange.to, cols: cur.fFgL,
        sortKey: cur.fgSortL.k, sortDir: cur.fgSortL.dir
      });
    }
    return ERP.fpFilteredProducts(kind === 'P' ? st.fps : ERP.fpStockList(st.fps, st.fpLots), st.fpLogs, {
      q: cur.fgSearch, cat: cur.fgCat, showZero: cur.fgShowZero,
      from: cur.fgRange.from, to: cur.fgRange.to, cols: kind === 'P' ? cur.fFgP : cur.fFgG,
      sortKey: kind === 'P' ? cur.fgSortP.k : cur.fgSortG.k,
      sortDir: kind === 'P' ? cur.fgSortP.dir : cur.fgSortG.dir
    });
  }
  function renderFgStock() {
    var wrap = $('fgTableWrap');
    var cols = ERP.fpCols('G');
    var list = fgFiltered('G');
    var qty = 0, amt = 0, i;
    for (i = 0; i < list.length; i++) { qty += list[i].stock; amt += list[i].amt; }
    setFgSum(list.length + '품목', qty, amt);
    if (!st.fps.length) {
      wrap.innerHTML = (cur.v4ok ? '' : noV4('완제품 표가 아직 없습니다. Supabase SQL Editor에서 <b>supabase_migrate_v4.sql</b>을 실행해 주세요.')) +
        '<table><tbody><tr class="empty-row"><td>등록된 완제품이 없습니다. 왼쪽 <b>＋ 새 상품 등록</b>으로 시작하세요.</td></tr></tbody></table>';
      return;
    }
    if (!list.length) {
      wrap.innerHTML = (cur.v6ok === false ? noV4('로트 표(<b>fp_lots</b>)가 아직 없습니다. Supabase SQL Editor에서 <b>supabase_migrate_v6.sql</b>을 실행하면 로트번호·입고일·소비기한으로 재고를 봅니다.') : '') +
        '<table><tbody><tr class="empty-row"><td>조건에 맞는 품목이 없습니다. 대분류·검색·기간을 넓혀 보세요.</td></tr></tbody></table>';
      return;
    }
    var page = list.slice(0, cur.fgLimit);
    var html = [(cur.v6ok === false ? noV4('로트 표(<b>fp_lots</b>)가 아직 없어 품목 단위로 보입니다. <b>supabase_migrate_v6.sql</b>을 실행하면 로트번호·입고일·소비기한 열이 채워집니다.') : ''), tableOpen('t-fg', 'fpG', cols, ACT_DEF.fpG), '<thead><tr>'], c;
    for (c = 0; c < cols.length; c++) html.push(thHtml(cols[c], cur.fgSortG, cur.fFgG));
    html.push(actTh() + '</tr></thead><tbody>');
    for (i = 0; i < page.length; i++) {
      var p = page[i];
      html.push('<tr class="fgrow" data-fgcode="' + esc(p.code) + '">');
      for (c = 0; c < cols.length; c++) html.push(fgCellHtml(p, cols[c].k));
      /* v8.2 — 원료육과 같은 [작업 ▾] 한 버튼 (입고 / 출고 / 수정) */
      html.push('<td class="actcell actcol"><button type="button" class="actmenu" data-menu="fg" data-fgcode="' +
        esc(p.code) + '" title="입고·출고·수정">작업 ▾</button></td></tr>');
    }
    html.push('</tbody></table>');
    if (list.length > cur.fgLimit) {
      html.push('<button class="more" id="btnFgMore">더 보기 (' + (list.length - cur.fgLimit) + '품목 남음)</button>');
    }
    wrap.innerHTML = html.join('');
    var more = $('btnFgMore');
    if (more) more.addEventListener('click', function () { cur.fgLimit += 300; renderFgStock(); });
  }
  function renderFgLogs() {
    var wrap = $('fgTableWrap');
    var cols = ERP.fpCols('L');
    var list = fgFiltered('L');
    var qty = 0, amt = 0, i;
    for (i = 0; i < list.length; i++) { qty += list[i].q; amt += list[i].amt; }
    setFgSum(list.length + '건', null, amt);
    if (!list.length) {
      wrap.innerHTML = '<table><tbody><tr class="empty-row"><td>조건에 맞는 이력이 없습니다. 기간·구분·검색을 넓혀 보세요.</td></tr></tbody></table>';
      return;
    }
    var page = list.slice(0, cur.fgLimit);
    var html = [tableOpen('t-fg', 'fpL', cols, ACT_DEF.fpL), '<thead><tr>'], c;
    for (c = 0; c < cols.length; c++) html.push(thHtml(cols[c], cur.fgSortL, cur.fFgL));
    html.push(actTh() + '</tr></thead><tbody>');
    for (i = 0; i < page.length; i++) {
      var g = page[i];
      html.push('<tr class="fgrow' + (g.undone ? ' undone' : '') + '" data-fgcode="' + esc(g.code) + '">');
      for (c = 0; c < cols.length; c++) html.push(fgLogCellHtml(g, cols[c].k));
      html.push('<td class="actcell actcol"><div class="acts">' + (g.undone
        ? '<span class="ttag">취소됨</span>'
        : (g.t === 'OUT' ? '<button class="act stmt" data-fgstmt="' + g.id + '" title="거래명세표">📄</button>' : '') +
          '<button class="cancel" data-fgundo="' + g.id + '">취소</button>') + '</div></td></tr>');
    }
    html.push('</tbody></table>');
    if (list.length > cur.fgLimit) {
      html.push('<button class="more" id="btnFgLogMore">더 보기 (' + (list.length - cur.fgLimit) + '건 남음)</button>');
    }
    wrap.innerHTML = html.join('');
    var more = $('btnFgLogMore');
    if (more) more.addEventListener('click', function () { cur.fgLimit += 300; renderFgLogs(); });
  }
  function renderFgPrices() {
    var wrap = $('fgTableWrap');
    var cols = ERP.fpCols('P');
    var list = fgFiltered('P');
    setFgSum(list.length + '품목', null, null);
    if (!list.length) {
      wrap.innerHTML = '<table><tbody><tr class="empty-row"><td>조건에 맞는 품목이 없습니다.</td></tr></tbody></table>';
      return;
    }
    var page = list.slice(0, cur.fgLimit);
    var html = [tableOpen('t-fg', 'fpP', cols, ACT_DEF.fpP), '<thead><tr>'], c;
    for (c = 0; c < cols.length; c++) html.push(thHtml(cols[c], cur.fgSortP, cur.fFgP));
    html.push(actTh() + '</tr></thead><tbody>');
    for (var i = 0; i < page.length; i++) {
      var p = page[i];
      html.push('<tr class="fgrow" data-fgcode="' + esc(p.code) + '">');
      for (c = 0; c < cols.length; c++) html.push(fgCellHtml(p, cols[c].k));
      html.push('<td class="actcell actcol"><div class="acts"><button class="act edit" data-fgprice="' + esc(p.code) + '">수정</button></div></td></tr>');
    }
    html.push('</tbody></table>');
    if (list.length > cur.fgLimit) {
      html.push('<button class="more" id="btnFgPriceMore">더 보기 (' + (list.length - cur.fgLimit) + '품목 남음)</button>');
    }
    wrap.innerHTML = html.join('');
    var more = $('btnFgPriceMore');
    if (more) more.addEventListener('click', function () { cur.fgLimit += 300; renderFgPrices(); });
  }
  function renderFgTable() {
    if (!$('fgTableWrap')) return;
    var isL = cur.fgTab === 'L', isP = cur.fgTab === 'P';
    $('fgZeroWrap').classList.toggle('hidden', isL);
    $('fgLogFilter').classList.toggle('hidden', !isL);
    $('fgNoteBar').textContent = isL
      ? '기간·검색은 이력 표에 적용됩니다. 왼쪽 위 [날짜]와 [기간선택]으로 조회하세요.'
      : '기간을 고르면 그 기간에 입출고가 있었던 품목만 보여줍니다.';
    var anyF = hasCols(cur.fFgG) || hasCols(cur.fFgL) || hasCols(cur.fFgP);
    $('btnFgResetFilters').classList.toggle('hidden', !anyF);
    if (isL) { renderFgLogs(); return; }
    if (isP) { renderFgPrices(); return; }
    renderFgStock();
  }

  /* ---------- 완제품 상품 선택 · 입력 ---------- */
  function fgPickProduct(silent) {
    var q = $('fgQuery').value || '';
    var head = String(q).split('·')[0].replace(/^\s+|\s+$/g, '');
    var p = ERP.fpFind(st.fps, q) || ERP.fpFind(st.fps, head);
    cur.fgCode = p ? p.code : '';
    if (p) {
      $('fgQuery').value = p.code + ' · ' + p.n;
      $('fgSpec').value = p.spec || '';
      $('fgUnit').value = p.unit || '개';
      $('fgPrice').placeholder = (cur.fgType === 'IN' ? p.inp : p.outp) > 0
        ? fmtInt(cur.fgType === 'IN' ? p.inp : p.outp) : '비우면 상품단가';
    }
    renderFgInfo();
    renderFgLotPick();
    if (!silent && !p && q) toast('일치하는 상품이 없습니다. 새 상품이면 [＋ 새 상품 등록]을 눌러 주세요.', 'warn');
    fgSyncAmount();
  }
  function renderFgInfo() {
    var box = $('fgInfo');
    if (!box) return;
    var p = cur.fgCode ? ERP.fpProductOf(st.fps, cur.fgCode) : null;
    cur.fgStockRef = p;
    var q = ($('fgQuery').value || '').replace(/^\s+|\s+$/g, '');
    if (!p) {
      box.className = 'lotinfo empty';
      box.innerHTML = q ? '일치하는 상품이 없습니다. 목록에서 정확한 상품을 골라 주세요.' : '상품을 고르면 현재고·단가가 보입니다.';
      return;
    }
    box.className = 'lotinfo';
    var lots = ERP.fpLotsOf(st, p.code), ltxt = '', i, L;
    for (i = 0; i < lots.length && i < 3; i++) {
      L = lots[i];
      if (!(L.qty > 0.0004)) continue;
      ltxt += '<br><span class="tiny-hint">로트</span> ' + esc(L.lot || '-') +
        (L.inD ? ' · 입고 ' + esc(L.inD) : '') + (L.e ? ' · ~' + esc(L.e) : '') +
        ' · <b>' + fmtQty(L.qty) + esc(L.unit) + '</b>';
    }
    if (lots.length > 3) ltxt += '<br><span class="tiny-hint">로트 ' + lots.length + '개 중 3개만 표시</span>';
    box.innerHTML = '<b>' + esc(p.n) + '</b> · ' + esc(p.cat || '-') + (p.spec ? ' · ' + esc(p.spec) : '') +
      '<br>상품코드 ' + esc(p.code) + ' · 현재고 <b>' + fmtQty(p.stock) + esc(p.unit || '개') + '</b>' +
      '<br>입고단가 <b>' + (p.inp > 0 ? won(p.inp) : '미입력') + '</b> · 출고단가 <b>' + (p.outp > 0 ? won(p.outp) : '미입력') + '</b>' +
      (p.e ? '<br>소비기한 ' + esc(p.e) + ddayHtml(p.e) : '') +
      (p.sup ? ' · 매입처 ' + esc(p.sup) : '') + ltxt;
  }
  function fgSyncAmount() {
    var q = Number($('fgQty').value || 0);
    var p = currentFgPrice();
    $('fgAmount').value = q > 0 && p > 0 ? String(Math.round(q * p)) : '';
  }
  function currentFgPrice() {
    var v = $('fgPrice').value;
    if (v !== '' && Number(v) >= 0) return Number(v);
    var p = cur.fgCode ? ERP.fpProductOf(st.fps, cur.fgCode) : null;
    if (!p) return 0;
    return cur.fgType === 'IN' ? p.inp : p.outp;
  }
  function setFgType(t) {
    cur.fgType = t === 'OUT' ? 'OUT' : 'IN';
    /* 출고에는 자체생산 구분이 없다 — 거래처가 '자체생산'으로 남아 있으면 비운다 */
    if (cur.fgType === 'OUT' && cur.fgSrc === 'self') setFgSrc('buy');
    if ($('fgTypeIN')) $('fgTypeIN').classList.toggle('active', cur.fgType === 'IN');
    if ($('fgTypeOUT')) $('fgTypeOUT').classList.toggle('active', cur.fgType === 'OUT');
    $('fgQtyLabel').innerHTML = (cur.fgType === 'IN' ? '입고 수량' : '출고 수량') + ' <span class="req">*</span>';
    $('fgPriceLabel').textContent = cur.fgType === 'IN' ? '입고단가(원)' : '출고단가(원)';
    $('btnFgSave').textContent = cur.fgType === 'IN' ? '입고 저장' : '출고 저장';
    $('fgNegWrap').classList.toggle('hidden', cur.fgType !== 'OUT');
    if ($('fgFormTitle')) $('fgFormTitle').textContent = cur.fgType === 'IN' ? '📥 완제품·부자재 입고 등록' : '🚚 완제품·부자재 출고 등록';
    if ($('fgFormSub')) $('fgFormSub').textContent = cur.fgType === 'IN'
      ? '상품을 고르면 규격·단가가 채워집니다. 로트번호를 비우면 상품코드-입고일로 자동 채워집니다.'
      : '출고할 상품·로트·수량을 적습니다. 로트를 비우면 소비기한이 빠른 로트부터 나갑니다.';
    if ($('fgSrcWrap')) $('fgSrcWrap').classList.toggle('hidden', cur.fgType !== 'IN');
    if ($('fgUseWrap')) $('fgUseWrap').classList.toggle('hidden', cur.fgType !== 'OUT');
    if ($('fgAutoBuyWrap')) $('fgAutoBuyWrap').classList.toggle('hidden', cur.fgType !== 'IN');
    if ($('fgAutoSaleWrap')) $('fgAutoSaleWrap').classList.toggle('hidden', cur.fgType !== 'OUT' || cur.fgUse === 'site');
    if ($('fgLotInWrap')) $('fgLotInWrap').classList.toggle('hidden', cur.fgType !== 'IN');
    if ($('fgLotPickWrap')) $('fgLotPickWrap').classList.toggle('hidden', cur.fgType !== 'OUT');
    if (cur.fgType === 'OUT') setFgUse(cur.fgUse);
    renderFgLotPick();
    var p = cur.fgCode ? ERP.fpProductOf(st.fps, cur.fgCode) : null;
    if (p) $('fgPrice').placeholder = (cur.fgType === 'IN' ? p.inp : p.outp) > 0 ? fmtInt(cur.fgType === 'IN' ? p.inp : p.outp) : '비우면 상품단가';
    renderFgProdRef();
    fgSyncAmount();
  }
  /* v6 — 고른 상품의 로트 목록을 출고 로트 칸에 채운다 */
  function renderFgLotPick() {
    var sel = $('fgLotPick');
    if (!sel) return;
    var html = ['<option value="">자동 · 소비기한 빠른 로트부터</option>'];
    var list = cur.fgCode ? ERP.fpLotsOf(st, cur.fgCode) : [], i, L;
    for (i = 0; i < list.length; i++) {
      L = list[i];
      if (!(L.qty > 0.0004)) continue;
      html.push('<option value="' + L.id + '">' + esc(L.lot || '로트') +
        (L.inD ? ' · 입고 ' + esc(L.inD) : '') + (L.e ? ' · ~' + esc(L.e) : '') +
        ' · ' + fmtQty(L.qty) + esc(L.unit) + '</option>');
    }
    sel.innerHTML = html.join('');
  }
  /* v8: 완제품 출고 구분 — 판매 출고 / 현장소모·생산투입 */
  function setFgUse(u) {
    cur.fgUse = u === 'site' ? 'site' : 'sale';
    var btns = document.querySelectorAll('#fgUseSeg button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-use') === cur.fgUse);
    var site = cur.fgUse === 'site';
    if ($('fgPartnerLabel')) $('fgPartnerLabel').textContent = site ? '생산품목' : '거래처';
    var pt = $('fgPartner');
    if (pt) {
      pt.placeholder = site ? '예: 선진바베큐폭립' : '매입처 / 납품처';
      pt.setAttribute('list', site ? 'dlProducts' : 'dlFgPartners');
      if (pt.value === '자체생산') pt.value = '';
    }
    if ($('fgAutoSaleWrap')) $('fgAutoSaleWrap').classList.toggle('hidden', cur.fgType !== 'OUT' || site);
    if ($('fgNote')) $('fgNote').placeholder = site ? '예: 박스·포장지 현장 투입' : '선택 입력';
  }
  function openFgForm(type) {
    if (type === 'new') { openFgNew(null); return; }
    if (cur.erp !== 'fg') setErpMode('fg');
    setFgType(type === 'OUT' ? 'OUT' : 'IN');
    if ($('fgLotNo')) $('fgLotNo').value = '';
    if ($('fgInDate') && !$('fgInDate').value) $('fgInDate').value = $('fgDate').value || today();
    if ($('fgLotPick')) $('fgLotPick').value = '';
    var m = $('fgFormModal');
    if (m) m.classList.remove('hidden');
    var card = $('fgFormPanel');
    if (card) card.scrollTop = 0;
    setTimeout(function () { try { $('fgQuery').focus(); } catch (e) { } }, 60);
  }
  function closeFgForm() {
    var m = $('fgFormModal');
    if (m) m.classList.add('hidden');
  }
  /* v8.1 — 재고 표의 [입고]/[출고]: 그 품목이 선택된 채로 팝업을 연다 */
  function openFgFor(code, type) {
    var p = ERP.fpProductOf(st.fps, code);
    if (!p) { toast('품목을 찾지 못했습니다: ' + code, 'err'); return; }
    openFgForm(type);
    $('fgQuery').value = p.code + ' · ' + p.n;
    cur.fgCode = p.code;
    renderFgInfo();
    fgSyncAmount();
    var f = $('fgQty');
    if (f) setTimeout(function () { try { f.focus(); } catch (e) { } }, 80);
  }
  function fgFormOpen() {
    var m = $('fgFormModal');
    return !!m && !m.classList.contains('hidden');
  }

  /* ---------- 완제품 입고구분: 자체생산 / 외부매입 (v6, SQL 변경 없이 partner·note로 구분) ---------- */
  function setFgSrc(src) {
    cur.fgSrc = src === 'self' ? 'self' : 'buy';
    var btns = document.querySelectorAll('#fgSrcSeg button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-src') === cur.fgSrc);
    var pt = $('fgPartner');
    if (pt) {
      if (cur.fgSrc === 'self') {
        pt.value = '자체생산';
        pt.placeholder = '자체생산';
      } else if (pt.value === '자체생산') {
        pt.value = '';
        pt.placeholder = '매입처 / 납품처';
      }
    }
    renderFgProdRef();
  }
  /* 자체생산을 고르면 왼쪽 폼에 최근 원료육 현장 투입(생산 투입) 합계를 가벼게 보여준다 */
  function renderFgProdRef() {
    var box = $('fgProdRef');
    if (!box) return;
    if (cur.fgType !== 'IN' || cur.fgSrc !== 'self') {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    var d = ($('fgDate') && $('fgDate').value) || today();
    var t = ERP.siteInput(st, ERP.dateAdd(d, -7), d);
    box.classList.remove('hidden');
    box.innerHTML = t.cnt
      ? '참고: 최근 원료육 현장 투입 <b>' + t.cnt + '건</b> · <b>' + fmt(t.kg) + ' kg</b> · <b>' + fmtInt(t.amt) + '원</b> <span class="tiny-hint">(' + ERP.dateAdd(d, -7) + ' ~ ' + d + ')</span>'
      : '참고: 최근 7일 원료육 현장 투입 기록이 없습니다. (' + ERP.dateAdd(d, -7) + ' ~ ' + d + ')';
  }
  function isSelfSrc(v) { return String(v === null || v === undefined ? '' : v).replace(/^\s+|\s+$/g, '') === '자체생산'; }
  function fgSubmit() {
    var p = cur.fgCode ? ERP.fpProductOf(st.fps, cur.fgCode) : null;
    if (!p) { $('fgMsg').textContent = '상품을 먼저 정확히 골라 주세요.'; toast('상품을 골라 주세요.', 'warn'); return; }
    var qty = Number($('fgQty').value || 0);
    if (!(qty > 0)) { $('fgMsg').textContent = '수량을 입력하세요.'; $('fgQty').focus(); return; }
    if (cur.fgType === 'OUT' && !$('fgNeg').checked && qty > p.stock + 0.0004) {
      $('fgMsg').textContent = '재고(' + fmtQty(p.stock) + p.unit + ')보다 많이 출고할 수 없습니다. 필요하면 아래 [재고보다 많이 출고 허용]을 켜세요.';
      toast('재고보다 많이 출고할 수 없습니다.', 'warn');
      return;
    }
    $('fgMsg').textContent = '';
    var b = $('btnFgSave');
    b.disabled = true;
    var label = b.textContent;
    b.textContent = '저장 중…';
    var selfMade = cur.fgType === 'IN' && cur.fgSrc === 'self';
    var siteUse = cur.fgType === 'OUT' && cur.fgUse === 'site';
    var partner = selfMade ? '자체생산' : ($('fgPartner').value || '');
    if (siteUse && !partner.replace(/^\s+|\s+$/g, '')) {
      b.disabled = false; b.textContent = label;
      $('fgMsg').textContent = '현장소모·생산투입은 생산품목을 적어 주세요. (품목별 원가가 이 이름으로 모입니다)';    $('fgPartner').focus();
      return;
    }
    var note = $('fgNote').value || '';
    if (selfMade) note = note.indexOf('[자체생산]') >= 0 ? note : ('[자체생산] ' + note).replace(/\s+$/, '');
    SB.db.fpApply({
      code: p.code, type: cur.fgType, qty: qty, date: $('fgDate').value || today(),
      price: $('fgPrice').value === '' ? null : Number($('fgPrice').value),
      expiry: $('fgExpiry').value || null, partner: partner,
      note: note, allowNegative: $('fgNeg').checked,
      source: siteUse ? 'site' : 'manual',
      lotNo: cur.fgType === 'IN' ? (($('fgLotNo') && $('fgLotNo').value) || '') : '',
      lotId: cur.fgType === 'OUT' && $('fgLotPick') && $('fgLotPick').value ? Number($('fgLotPick').value) : null,
      inDate: cur.fgType === 'IN' ? (($('fgInDate') && $('fgInDate').value) || $('fgDate').value || null) : null
    }).then(function (row) {
      toast('완제품 ' + ERP.fpTypeName(cur.fgType) + (selfMade ? ' · 🏭 자체생산' : (siteUse ? ' · 🏭 현장소모(생산투입)' : '')) + ' 완료: ' +
        (row && row.name || p.n) + ' ' + fmtQty(qty) + p.unit +
        (row && Number(row.amount) ? ' · ' + won(row.amount) : '') +
        (siteUse ? ' · 매출 전표 없이 생산·원가에만 집계' : ''), cur.fgType === 'IN' ? 'in' : 'out');
      $('fgQty').value = ''; $('fgNote').value = ''; $('fgPrice').value = ''; $('fgAmount').value = '';
      cur.fgLimit = 300;
      closeFgForm();
      var g = { t: cur.fgType, amt: Number(row && row.amount) || 0, p: partner, note: note,
        src: siteUse ? 'site' : 'manual', id: row && row.id, undone: false };
      var link = null;
      if (cur.fgType === 'IN' && !selfMade && $('fgAutoBuy') && $('fgAutoBuy').checked) link = ERP.linkOfFp(g);
      if (cur.fgType === 'OUT' && !siteUse && $('fgAutoSale') && $('fgAutoSale').checked) link = ERP.linkOfFp(g);
      /* 현장소모는 투입단가로 저장되어 상품의 판매단가가 덮어써진다 — 원래 판매단가를 되돁린다 */
      var restore = (siteUse && p && Number(p.outp) > 0)
        ? SB.db.fpProductSave({ code: p.code, cat: p.cat, name: p.n, spec: p.spec, unit: p.unit,
            inp: p.inp, outp: p.outp, expiry: p.e || null, sup: p.sup, bc: p.bc, active: p.active !== false })
        : Promise.resolve();
      return restore.then(function () {
        return autoLinkVoucher(link, 'tax', cur.fgType === 'IN' ? '매입 전표' : '매출 전표');
      }).then(function () {
        return reload({ silent: true });
      });
    }).then(function () {
      b.disabled = false; b.textContent = label;
      fgPickProduct(true);
    }, function (e) {
      b.disabled = false; b.textContent = label;
      $('fgMsg').textContent = e.message;
      toast(e.message, 'err');
    });
  }
  function fgUndo(id, btn) {
    if (!window.confirm('이 완제품 입출고를 취소할까요?\n재고가 입력 전으로 돌아가고, 이력에는 취소 표시가 남습니다.')) return;
    if (btn) btn.disabled = true;
    var lv = linkedVoucher('fp', id);
    SB.db.fpUndo(id).then(function (row) {
      toast('취소됨: ' + (row && row.name ? row.name + ' ' + fmtQty(row.qty) + (row.unit || '') : '완제품 이력') +
        (lv ? ' · 자동으로 만들어진 ' + (lv.t === 'sale' ? '매출' : '매입') + ' 전표는 구매·판매관리에서 삭제해 주세요.' : ''),
        lv ? 'warn' : 'ok', lv ? 7000 : undefined);
      return reload({ silent: true });
    }).then(function () { if (btn) btn.disabled = false; }, function (e) {
      if (btn) btn.disabled = false;
      toast(e.message, 'err');
    });
  }

  /* ==========================================================================
     v12 — 🧾 명세서형 다중 품목 입출고 (1. 입출고관리)
       · 상단 공통: 입고일(날짜) · 업체/거래처 · 창고(원료육) · 비고
       · 가운데 명세서 표: 구분(원료육 / 완제품·부자재) · 품목명 · 로트번호 · 소비기한 ·
         수량 · 단가 · 금액  (기본 3줄 · ＋ 줄 추가 · × 줄 삭제 · 합계는 실시간)
       · 저장: 줄마다 원료육(tx_apply) 또는 완제품·부자재(fp_tx_apply) 재고를 입·출고
               원료육은 이름·업체·입고일·소비기한이 같은 로트로 모이고,
               출고는 고른 로트(없으면 소비기한 빠른 로트)에서 나갑니다.
               매입·매출 전표는 구매·판매관리의 [미반영 입고 가져오기]로 한 번에 넘길 수 있습니다.
     ========================================================================== */
  var ios = { type: 'IN', wh: 'F', rows: [], seq: 0 };
  var IOS_MAX = 30;
  function iosTrim(v) { return String(v === null || v === undefined ? '' : v).replace(/^\s+|\s+$/g, ''); }
  function iosRow(i) { return ios.rows[i] || null; }
  function iosNewRow(kind) {
    ios.seq += 1;
    return { key: ios.seq, kind: kind === 'fp' ? 'fp' : 'meat', name: '', lotNo: '', lotId: null,
      expiry: '', qty: '', price: '' };
  }
  function iosResetRows(n) {
    ios.rows = [];
    for (var i = 0; i < (n || 3); i++) ios.rows.push(iosNewRow('meat'));
  }
  function iosIsIn() { return ios.type === 'IN'; }
  function iosAmt(r) {
    var q = Number(r && r.qty || 0), p = Number(r && r.price || 0);
    return q > 0 ? Math.round(q * p) : 0;
  }
  function iosWhName(wh) { return wh === 'C' ? '냉장고' : '냉동고'; }

  /* 원료육 — 그 이름의 재고 있는 로트 (소비기한 빠른 순) */
  function iosMeatLots(name, wh) {
    var out = [], i, L, q, n = iosTrim(name);
    if (!n) return out;
    for (i = 0; i < st.lots.length; i++) {
      L = st.lots[i];
      if (L.n !== n) continue;
      q = wh === 'C' ? L.cq : L.fq;
      if (!(q > ERP.EPS)) continue;
      out.push(L);
    }
    out.sort(function (a, b) {
      var ae = a.e || '9999-99-99', be = b.e || '9999-99-99';
      if (ae !== be) return ae < be ? -1 : 1;
      return a.dbid - b.dbid;
    });
    return out;
  }
  /* 원료육 출고 — 고른 로트, 없으면 소비기한 빠른 로트 */
  function iosPickMeatLot(r) {
    var list = iosMeatLots(r.name, ios.wh), i;
    for (i = 0; i < list.length; i++) if (Number(list[i].dbid) === Number(r.lotId)) return list[i];
    return list.length ? list[0] : null;
  }
  function iosProduct(r) {
    var q = iosTrim(r && r.name);
    if (!q) return null;
    if (r.code) {
      var p0 = ERP.fpProductOf(st.fps, r.code);
      if (p0) return p0;
    }
    var p = ERP.fpFind(st.fps, q);
    if (p) return p;
    var parts = q.split('·'), i;
    for (i = 0; i < parts.length; i++) {
      p = ERP.fpFind(st.fps, parts[i]);
      if (p) return p;
    }
    return null;
  }
  /* 로트번호 칸 */
  function iosLotCellHtml(r) {
    var i, h;
    if (r.kind === 'fp') {
      if (iosIsIn()) {
        return '<input data-f="lot" value="' + esc(r.lotNo) + '" placeholder="비우면 자동" title="로트번호">';
      }
      var p = iosProduct(r);
      if (!p) return '<span class="vlotro muted">품목을 먼저 고르세요</span>';
      var lots = ERP.fpLotsOf(st, p.code);
      h = ['<select data-f="lotpick"><option value="">자동 · 소비기한 빠른 로트</option>'];
      for (i = 0; i < lots.length; i++) {
        if (!(lots[i].qty > 0.0004)) continue;
        h.push('<option value="' + lots[i].id + '"' + (Number(r.lotId) === Number(lots[i].id) ? ' selected' : '') + '>' +
          esc(lots[i].lot || '로트') + (lots[i].e ? ' · ~' + esc(lots[i].e) : '') + ' · ' + fmtQty(lots[i].qty) + esc(lots[i].unit) + '</option>');
      }
      h.push('</select>');
      return h.join('');
    }
    if (iosIsIn()) return '<span class="vlotro muted">자동</span><span class="vlotstock">입고일·소비기한으로 묶임</span>';
    var list = iosMeatLots(r.name, ios.wh);
    if (!list.length) return '<span class="vlotro muted">재고 없음</span>';
    h = ['<select data-f="lotpick">'];
    for (i = 0; i < list.length; i++) {
      h.push('<option value="' + list[i].dbid + '"' + (Number(r.lotId) === Number(list[i].dbid) ? ' selected' : '') + '>' +
        (list[i].e ? '~' + esc(list[i].e) : '기한없음') + ' · ' + fmtQty(ios.wh === 'C' ? list[i].cq : list[i].fq) + 'kg</option>');
    }
    h.push('</select>');
    return h.join('');
  }
  /* 소비기한 칸 */
  function iosExpCellHtml(r) {
    if (iosIsIn()) {
      return '<input type="date" data-f="expiry" value="' + esc(r.expiry) + '" title="소비기한">';
    }
    if (r.kind === 'fp') {
      var p = iosProduct(r);
      if (!p) return '<span class="vlotro muted">—</span>';
      var lots = ERP.fpLotsOf(st, p.code), L = null, i;
      for (i = 0; i < lots.length; i++) if (Number(lots[i].id) === Number(r.lotId)) L = lots[i];
      if (!L) for (i = 0; i < lots.length; i++) if (lots[i].qty > 0.0004) { L = lots[i]; break; }
      return '<span class="vlotro">' + esc(L ? (L.e || '—') : '—') + '</span>' +
        '<span class="vlotstock">' + (L ? '현재고 ' + fmtQty(L.qty) + esc(L.unit) : '재고 없음') + '</span>';
    }
    var mLot = iosPickMeatLot(r);
    return '<span class="vlotro">' + esc(mLot ? (mLot.e || '—') : '—') + '</span>' +
      '<span class="vlotstock">' + (mLot ? '재고 ' + fmtQty(ios.wh === 'C' ? mLot.cq : mLot.fq) + 'kg' : '로트를 고르세요') + '</span>';
  }
  function iosNameCellHtml(r) {
    var ph = r.kind === 'fp' ? '예: 떡갈비 / W00100016' : '예: 등갈비';
    return '<input data-f="name" class="vnamein" value="' + esc(r.name) + '" placeholder="' + esc(ph) + '" autocomplete="off"' +
      ' list="' + (r.kind === 'fp' ? 'dlFgNames' : 'dlNames') + '">';
  }
  function iosRowHtml(r, i) {
    return '<tr data-r="' + i + '" data-kind="' + esc(r.kind) + '">' +
      '<td class="c"><select data-f="kind">' +
        '<option value="meat"' + (r.kind === 'meat' ? ' selected' : '') + '>원료육</option>' +
        '<option value="fp"' + (r.kind === 'fp' ? ' selected' : '') + '>완제품·부자재</option>' +
      '</select></td>' +
      '<td>' + iosNameCellHtml(r) + '</td>' +
      '<td data-cell="lot">' + iosLotCellHtml(r) + '</td>' +
      '<td data-cell="exp">' + iosExpCellHtml(r) + '</td>' +
      '<td class="r"><input type="number" data-f="qty" step="0.001" min="0" value="' + esc(r.qty) + '" placeholder="0"></td>' +
      '<td class="r"><input type="number" data-f="price" step="1" min="0" value="' + esc(r.price) + '" placeholder="0"></td>' +
      '<td class="r num b" data-num="amt">' + (iosAmt(r) ? fmtInt(iosAmt(r)) : '') + '</td>' +
      '<td class="c"><button type="button" class="vdel" data-delrow="' + i + '" aria-label="줄 삭제" title="줄 삭제">×</button></td>' +
      '</tr>';
  }
  function iosRenderRows() {
    var body = $('ioSheetBody');
    if (!body) return;
    var h = [], i;
    for (i = 0; i < ios.rows.length; i++) h.push(iosRowHtml(ios.rows[i], i));
    body.innerHTML = h.join('');
    iosPaint();
  }
  function iosPaint() {
    var q = 0, amt = 0, i, r, n, tr, cell;
    for (i = 0; i < ios.rows.length; i++) {
      r = ios.rows[i];
      n = Number(r.qty || 0);
      q += n > 0 ? n : 0;
      amt += iosAmt(r);
      tr = document.querySelector('#ioSheetBody tr[data-r="' + i + '"]');
      if (tr) {
        cell = tr.querySelector('[data-num="amt"]');
        if (cell) cell.textContent = iosAmt(r) ? fmtInt(iosAmt(r)) : '';
      }
    }
    if ($('ioSheetSumQty')) $('ioSheetSumQty').textContent = fmtQty(q);
    if ($('ioSheetSumAmt')) $('ioSheetSumAmt').textContent = amt ? fmtInt(amt) : '0';
  }
  /* 한 줄의 로트·소비기한 칸만 다시 그린다 */
  function iosRefreshRow(i) {
    var r = iosRow(i);
    var tr = document.querySelector('#ioSheetBody tr[data-r="' + i + '"]');
    if (!r || !tr) return;
    var ni = tr.querySelector('[data-f="name"]');
    if (ni) {
      var isFp = r.kind === 'fp';
      ni.setAttribute('list', isFp ? 'dlFgNames' : 'dlNames');
      ni.placeholder = isFp ? '예: 떡갈비 / W00100016' : '예: 등갈비';
      if (document.activeElement !== ni && ni.value !== r.name) ni.value = r.name;
    }
    var lc = tr.querySelector('[data-cell="lot"]');
    if (lc) lc.innerHTML = iosLotCellHtml(r);
    var ec = tr.querySelector('[data-cell="exp"]');
    if (ec) ec.innerHTML = iosExpCellHtml(r);
    tr.setAttribute('data-kind', r.kind);
    iosPaint();
  }
  function iosSetType(t) {
    ios.type = t === 'OUT' ? 'OUT' : 'IN';
    var isIn = iosIsIn();
    if ($('ioSheetTitle')) $('ioSheetTitle').textContent = isIn ? '🧾 여러 품목 한 번에 입고' : '🧾 여러 품목 한 번에 출고';
    if ($('ioSheetSub')) $('ioSheetSub').textContent = isIn
      ? '한 업체에서 원료육·완제품·소스·야채가 같이 들어오면 이 표에 줄로 적고 한 번에 저장합니다.'
      : '한 업체로 여러 품목이 같이 나가면 이 표에 줄로 적고 한 번에 출고합니다.';
    if ($('ioSheetDateLabel')) $('ioSheetDateLabel').innerHTML = (isIn ? '입고일' : '출고일') + ' <span class="req">*</span>';
    if ($('ioSheetSave')) $('ioSheetSave').textContent = isIn ? '입고 저장' : '출고 저장';
    if ($('ioSheetHint')) $('ioSheetHint').innerHTML = isIn
      ? '원료육은 <b>이름·업체·입고일·소비기한</b>이 같으면 같은 로트로 모입니다. 완제품·부자재 로트번호를 비우면 <b>상품코드-입고일</b>로 자동 채워집니다.'
      : '출고는 고른 로트에서 나가고, 로트를 비우면 <b>소비기한이 빠른 로트</b>부터 나갑니다. 재고보다 많으면 그 줄만 실패합니다.';
  }
  function openIoSheet(type) {
    iosSetType(type);
    ios.rows = [];
    iosResetRows(3);
    if ($('ioSheetDate')) $('ioSheetDate').value = today();
    if ($('ioSheetPartner')) $('ioSheetPartner').value = '';
    if ($('ioSheetNote')) $('ioSheetNote').value = '';
    if ($('ioSheetMsg')) $('ioSheetMsg').textContent = '';
    iosRenderRows();
    var m = $('ioSheetModal');
    if (m) m.classList.remove('hidden');
    setTimeout(function () { try { document.querySelector('#ioSheetBody [data-f="name"]').focus(); } catch (e) { } }, 60);
  }
  function closeIoSheet() {
    var m = $('ioSheetModal');
    if (m) m.classList.add('hidden');
  }
  function iosSetWh(wh) {
    ios.wh = wh === 'C' ? 'C' : 'F';
    var btns = document.querySelectorAll('#ioSheetWhSeg [data-wh]');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-wh') === ios.wh);
    for (var k = 0; k < ios.rows.length; k++) iosRefreshRow(k);
  }
  /* 저장 — 줄마다 재고를 움직인다 */
  function iosSave() {
    var date = $('ioSheetDate') ? $('ioSheetDate').value : today();
    if (!date) { $('ioSheetMsg').textContent = '날짜를 입력하세요.'; return; }
    var partner = iosTrim($('ioSheetPartner') ? $('ioSheetPartner').value : '');
    var note = iosTrim($('ioSheetNote') ? $('ioSheetNote').value : '');
    var lines = [], i, r, q;
    for (i = 0; i < ios.rows.length; i++) {
      r = ios.rows[i];
      q = Number(r.qty || 0);
      if (!(q > 0)) continue;
      if (!iosTrim(r.name)) {
        $('ioSheetMsg').textContent = (i + 1) + '번째 줄: 품목명을 입력하세요.';
        return;
      }
      lines.push({ i: i, r: r, qty: q });
    }
    if (!lines.length) { $('ioSheetMsg').textContent = '수량이 있는 줄이 없습니다.'; return; }
    $('ioSheetMsg').textContent = '';
    var b = $('ioSheetSave');
    b.disabled = true; b.textContent = '저장 중…';
    var ok = 0, fail = 0, errs = [];
    var chain = Promise.resolve();
    lines.forEach(function (ln) {
      chain = chain.then(function () {
        var rw = ln.r;
        if (rw.kind === 'fp') {
          var p = iosProduct(rw);
          if (!p) throw new Error((ln.i + 1) + '번째 줄: 완제품·부자재 품목을 찾을 수 없습니다.');
          return SB.db.fpApply({
            code: p.code, type: ios.type, qty: ln.qty, date: date,
            price: Number(rw.price || 0) > 0 ? Number(rw.price) : null,
            expiry: iosIsIn() ? (rw.expiry || null) : null,
            partner: partner, note: note, allowNegative: false, source: 'manual',
            lotNo: iosIsIn() ? iosTrim(rw.lotNo) : '',
            lotId: iosIsIn() || !rw.lotId ? null : Number(rw.lotId),
            inDate: iosIsIn() ? date : null
          });
        }
        if (iosIsIn()) {
          return SB.db.apply({
            date: date, type: 'in', wh: ios.wh, name: iosTrim(rw.name), vendor: partner,
            in_date: date, exp_date: rw.expiry || null, kg: ln.qty,
            price: Number(rw.price || 0), note: note
          });
        }
        var lot = iosPickMeatLot(rw);
        if (!lot) throw new Error((ln.i + 1) + '번째 줄: ' + iosWhName(ios.wh) + '에 출고할 ' + iosTrim(rw.name) + ' 재고가 없습니다.');
        return SB.db.apply({
          date: date, type: 'out', wh: ios.wh, lot_id: Number(lot.dbid),
          dest_type: 'vendor', dest: partner || '업체', kg: ln.qty,
          price: Number(rw.price || 0), note: note
        });
      }).then(function () {
        ok += 1;
      }, function (e) {
        fail += 1;
        errs.push(e && e.message ? e.message : String(e));
      });
    });
    chain.then(function () {
      b.disabled = false; b.textContent = iosIsIn() ? '입고 저장' : '출고 저장';
      var msg = (iosIsIn() ? '입고 ' : '출고 ') + ok + '줄 저장' + (fail ? ' · 실패 ' + fail + '줄' : '');
      toast(msg, fail ? 'warn' : 'in');
      if (errs.length) $('ioSheetMsg').textContent = errs.slice(0, 3).join(' / ');
      cur.hLimit = 250; cur.fgLimit = 300;
      return reload({ silent: true }).then(function () {
        if (!fail) closeIoSheet();
        else iosRenderRows();
      });
    });
  }
  function bindIoSheet() {
    if ($('ioSheetClose')) $('ioSheetClose').addEventListener('click', closeIoSheet);
    if ($('ioSheetCancel')) $('ioSheetCancel').addEventListener('click', closeIoSheet);
    if ($('ioSheetModal')) $('ioSheetModal').addEventListener('click', function (ev) { if (ev.target === this) closeIoSheet(); });
    if ($('ioSheetAdd')) $('ioSheetAdd').addEventListener('click', function () {
      if (ios.rows.length >= IOS_MAX) { toast('한 번에 ' + IOS_MAX + '줄까지 적을 수 있습니다.', 'warn'); return; }
      ios.rows.push(iosNewRow('meat'));
      iosRenderRows();
    });
    if ($('ioSheetSave')) $('ioSheetSave').addEventListener('click', iosSave);
    var whb = document.querySelectorAll('#ioSheetWhSeg [data-wh]');
    for (var i = 0; i < whb.length; i++) {
      whb[i].addEventListener('click', function () { iosSetWh(this.getAttribute('data-wh')); });
    }
    var body = $('ioSheetBody');
    if (!body) return;
    body.addEventListener('input', function (ev) {
      var el = ev.target;
      if (!el || !el.getAttribute) return;
      var tr = el.closest ? el.closest('tr[data-r]') : null;
      if (!tr) return;
      var r = iosRow(Number(tr.getAttribute('data-r')));
      if (!r) return;
      var f = el.getAttribute('data-f');
      if (f === 'name') { r.name = el.value; iosRefreshRow(Number(tr.getAttribute('data-r'))); }
      else if (f === 'qty') { r.qty = el.value; iosPaint(); }
      else if (f === 'price') { r.price = el.value; iosPaint(); }
      else if (f === 'lot') { r.lotNo = el.value; }
      else if (f === 'expiry') { r.expiry = el.value; }
    });
    body.addEventListener('change', function (ev) {
      var el = ev.target;
      if (!el || !el.getAttribute) return;
      var tr = el.closest ? el.closest('tr[data-r]') : null;
      if (!tr) return;
      var idx = Number(tr.getAttribute('data-r')), r = iosRow(idx);
      if (!r) return;
      var f = el.getAttribute('data-f');
      if (f === 'kind') {
        r.kind = el.value === 'fp' ? 'fp' : 'meat';
        r.lotId = null; r.lotNo = '';
        iosRefreshRow(idx);
      } else if (f === 'lotpick') {
        r.lotId = el.value ? Number(el.value) : null;
        iosRefreshRow(idx);
      } else if (f === 'name') {
        r.name = el.value;
        r.lotId = null;
        iosRefreshRow(idx);
      } else if (f === 'expiry') {
        r.expiry = el.value;
      }
    });
    body.addEventListener('click', function (ev) {
      var del = ev.target && ev.target.closest ? ev.target.closest('[data-delrow]') : null;
      if (!del) return;
      var idx = Number(del.getAttribute('data-delrow'));
      if (ios.rows.length <= 1) { ios.rows[0] = iosNewRow('meat'); }
      else ios.rows.splice(idx, 1);
      iosRenderRows();
    });
  }

  /* ---------- 새 상품 등록 / 수정 ---------- */
  var fgNewEditing = null;
  function openFgNew(code) {
    fgNewEditing = null;
    $('fgNewMsg').textContent = '';
    if (code) {
      var p = ERP.fpProductOf(st.fps, code);
      if (!p) return;
      fgNewEditing = p;
      $('fgNewTitle').textContent = '상품 정보 수정';
      $('fgNewSub').textContent = '이 상품의 이름·규격·단가를 고칩니다. 재고는 입출고로만 바뀝니다.';
      $('fgNewCode').value = p.code; $('fgNewCode').disabled = true;
      $('fgNewCat').value = p.cat; $('fgNewName').value = p.n;
      $('fgNewSpec').value = p.spec; $('fgNewUnit').value = p.unit || '개';
      $('fgNewIn').value = p.inp > 0 ? p.inp : ''; $('fgNewOut').value = p.outp > 0 ? p.outp : '';
      $('fgNewExpiry').value = p.e || ''; $('fgNewSupplier').value = p.sup; $('fgNewBarcode').value = p.bc;
      $('fgNewStockWrap').classList.add('hidden');
      $('fgNewHint').textContent = '단가를 비워 두면 기존 단가가 그대로 남습니다.';
      $('fgNewSave').textContent = '수정 저장';
    } else {
      $('fgNewTitle').textContent = '＋ 새 상품 등록';
      $('fgNewSub').textContent = '상품코드는 다음 번호로 자동 채워집니다. 필요하면 직접 고쳐 주세요.';
      $('fgNewCode').value = ERP.fpNextCode(st.fps); $('fgNewCode').disabled = false;
      $('fgNewCat').value = cur.fgCat !== 'all' ? cur.fgCat : '완제품';
      $('fgNewName').value = ''; $('fgNewSpec').value = ($('fgSpec') && $('fgSpec').value) || '';
      $('fgNewUnit').value = '개'; $('fgNewIn').value = ''; $('fgNewOut').value = '';
      $('fgNewExpiry').value = ''; $('fgNewSupplier').value = ''; $('fgNewBarcode').value = '';
      $('fgNewStock').value = '';
      $('fgNewStockWrap').classList.remove('hidden');
      $('fgNewHint').innerHTML = '초기재고를 넣으면 상품을 만든 뒤 <b>입고</b>로 기록해 입출고 이력에도 남깁니다.';
      $('fgNewSave').textContent = '등록';
    }
    $('fgNewModal').classList.remove('hidden');
    setTimeout(function () { try { $('fgNewName').focus(); } catch (e) { } }, 60);
  }
  function closeFgNew() { $('fgNewModal').classList.add('hidden'); fgNewEditing = null; }
  function saveFgNew() {
    var code = ($('fgNewCode').value || '').replace(/^\s+|\s+$/g, '');
    var name = ($('fgNewName').value || '').replace(/^\s+|\s+$/g, '');
    if (!code) { $('fgNewMsg').textContent = '상품코드를 입력하세요.'; return; }
    if (!name) { $('fgNewMsg').textContent = '상품명을 입력하세요.'; return; }
    var p = {
      code: code, cat: ($('fgNewCat').value || '완제품').replace(/^\s+|\s+$/g, '') || '완제품',
      name: name, spec: $('fgNewSpec').value || '', unit: $('fgNewUnit').value || '개',
      inp: Number($('fgNewIn').value || 0), outp: Number($('fgNewOut').value || 0),
      expiry: $('fgNewExpiry').value || null, sup: $('fgNewSupplier').value || '',
      bc: $('fgNewBarcode').value || '', active: true
    };
    var stock = Number($('fgNewStock').value || 0);
    var b = $('fgNewSave');
    b.disabled = true; b.textContent = '저장 중…';
    SB.db.fpProductSave(p).then(function () {
      if (!fgNewEditing && stock > 0) {
        return SB.db.fpApply({
          code: p.code, type: 'IN', qty: stock, date: today(),
          price: p.inp > 0 ? p.inp : null, expiry: p.expiry, partner: p.sup, note: '초기재고'
        });
      }
      return null;
    }).then(function () {
      b.disabled = false;
      closeFgNew();
      toast((fgNewEditing ? '상품 정보를 고쳤습니다: ' : '새 상품 등록: ') + name, 'ok');
      cur.fgLimit = 300;
      return reload({ silent: true }).then(function () {
        $('fgQuery').value = p.code + ' · ' + name;
        fgPickProduct(true);
      });
    }, function (e) {
      b.disabled = false; b.textContent = fgNewEditing ? '수정 저장' : '등록';
      $('fgNewMsg').textContent = e.message;
      toast(e.message, 'err');
    });
  }

  /* ---------- 단가 수정 ---------- */
  var fgPriceCode = '';
  function openFgPrice(code) {
    var p = ERP.fpProductOf(st.fps, code);
    if (!p) return;
    fgPriceCode = code;
    $('fgPriceSub').textContent = p.n + ' · ' + p.code + (p.spec ? ' · ' + p.spec : '');
    $('fgPriceIn').value = p.inp > 0 ? p.inp : '';
    $('fgPriceOut').value = p.outp > 0 ? p.outp : '';
    $('fgPriceMsg').textContent = '';
    $('fgPriceModal').classList.remove('hidden');
    setTimeout(function () { try { $('fgPriceIn').focus(); } catch (e) { } }, 60);
  }
  function closeFgPrice() { $('fgPriceModal').classList.add('hidden'); fgPriceCode = ''; }
  function saveFgPrice() {
    var p = ERP.fpProductOf(st.fps, fgPriceCode);
    if (!p) { closeFgPrice(); return; }
    var b = $('fgPriceSave');
    b.disabled = true; b.textContent = '저장 중…';
    SB.db.fpProductSave({
      code: p.code, cat: p.cat, name: p.n, spec: p.spec, unit: p.unit,
      inp: Number($('fgPriceIn').value || 0), outp: Number($('fgPriceOut').value || 0),
      expiry: p.e || null, sup: p.sup, bc: p.bc, active: p.active
    }).then(function () {
      b.disabled = false; b.textContent = '저장';
      closeFgPrice();
      toast('단가를 저장했습니다: ' + p.n, 'ok');
      return reload({ silent: true });
    }, function (e) {
      b.disabled = false; b.textContent = '저장';
      $('fgPriceMsg').textContent = e.message;
      toast(e.message, 'err');
    });
  }

  /* ---------- 완제품 엑셀 ---------- */
  function fgTxTemplate() {
    downloadXlsxFile([{ name: '입출고', rows: ERP.fpTxRows(st.fps, { today: today(), sampleCode: ERP.fpNextCode(st.fps), sampleName: '예시 상품 — 지우고 쓰세요' }), widths: [12, 8, 14, 30, 12, 8, 9, 10, 10, 16, 12, 12, 18, 24] }],
      '완제품_입출고_양식_' + ymdTag() + '.xlsx');
    toast('입출고 양식을 내려받았습니다.', 'ok');
  }
  function fgPriceTemplate() {
    downloadXlsxFile([{ name: '단가표', rows: ERP.fpPriceRows(st.fps), widths: [14, 30, 12, 8, 11, 11, 10] }],
      '완제품_단가표_' + ymdTag() + '.xlsx');
    toast('단가표 양식(' + st.fps.length + '품목)을 내려받았습니다. 단가 칸만 채워 올려 주세요.', 'ok');
  }
  function fgStockXls() {
    var list = fgFiltered('G');
    downloadXlsxFile([{ name: '완제품재고', rows: ERP.fpStockRows(list), widths: [12, 14, 34, 14, 8, 18, 12, 12, 10, 11, 11, 13, 18] }],
      '완제품_재고_' + ymdTag() + '.xlsx');
    toast('완제품 재고 ' + list.length + '품목을 엑셀로 내려받았습니다.', 'ok');
  }
  function fgLogXls() {
    var list = ERP.fpFilteredLogs(st.fpLogs, { q: '', type: 'all', cat: 'all', from: cur.fgRange.from, to: cur.fgRange.to });
    downloadXlsxFile([{ name: '완제품입출고', rows: ERP.fpLogRows(list), widths: [12, 8, 14, 32, 12, 8, 9, 10, 10, 12, 12, 18, 24, 10, 8] }],
      '완제품_입출고이력_' + ymdTag() + '.xlsx');
    toast('완제품 입출고 이력 ' + list.length + '건을 엑셀로 내려받았습니다.', 'ok');
  }

  /* ---------- 엑셀 올리기 ---------- */
  var upload = { kind: '', rows: null };
  var UPLOAD_INFO = {
    fp_tx: {
      title: '완제품 입출고 엑셀 올리기',
      sub: '열 이름: 날짜 · 구분(입고/출고) · 상품코드 · 상품명 · 규격 · 단위 · 수량 · 입고단가 · 출고단가 · 로트번호 · 입고일 · 소비기한 · 거래처 · 비고. 코드가 비면 상품명으로 찾고, 로트번호를 비우면 자동으로 만듭니다.',
      neg: true
    },
    fp_price: {
      title: '완제품 단가표 올리기',
      sub: '열 이름: 상품코드 · 상품명 · 규격 · 단위 · 입고단가 · 출고단가. 코드가 있으면 코드로, 없으면 상품명으로 찾습니다.',
      neg: false
    },
    acc_expense: {
      title: '통장·카드 내역 올리기',
      sub: '열 이름: 날짜 · 적요(내용) · 거래처 · 출금 · 입금 · 항목. 출금은 경비, 입금은 수입으로 들어갑니다.',
      neg: false
    }
  };
  function openUpload(kind) {
    upload.kind = kind;
    upload.rows = null;
    var info = UPLOAD_INFO[kind];
    $('uploadTitle').textContent = info.title;
    $('uploadSub').textContent = info.sub;
    $('uploadNegWrap').classList.toggle('hidden', !info.neg);
    $('uploadNeg').checked = false;
    $('uploadFile').value = '';
    $('uploadPreview').innerHTML = '';
    $('uploadGo').disabled = true;
    $('uploadModal').classList.remove('hidden');
  }
  function closeUpload() {
    $('uploadModal').classList.add('hidden');
    upload.kind = ''; upload.rows = null;
  }
  function readFileRows(file, cb) {
    var name = String(file.name || '').toLowerCase();
    var isText = /\.(csv|txt)$/.test(name);
    var rdr = new FileReader();
    rdr.onload = function (ev) {
      try {
        var rows = isText ? ERP.csvRows(String(ev.target.result || '')) : ERP.xlsxRows(new Uint8Array(ev.target.result));
        cb(null, rows);
      } catch (err) {
        cb(new Error('엑셀을 읽지 못했습니다. .xlsx 또는 .csv 파일인지 확인해 주세요. (' + (err.message || err) + ')'));
      }
    };
    rdr.onerror = function () { cb(new Error('파일을 읽지 못했습니다.')); };
    if (isText) rdr.readAsText(file, 'utf-8');
    else rdr.readAsArrayBuffer(file);
  }
  function renderUploadPreview(parsed) {
    var box = $('uploadPreview');
    if (parsed.error || !parsed.rows.length) {
      box.innerHTML = '<div class="uerr">' + esc(parsed.error || '올릴 줄이 없습니다.') + '</div>';
      $('uploadGo').disabled = true;
      upload.rows = null;
      return;
    }
    var rows = parsed.rows, lines = [], i, inN = 0, outN = 0, qty = 0, amt = 0, expN = 0, incN = 0;
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (upload.kind === 'fp_tx') {
        if (r.type === 'IN') inN++; else outN++;
        qty += r.qty; amt += r.qty * (Number(r.price) || 0);
      } else if (upload.kind === 'acc_expense') {
        if (r.type === 'income') incN++; else expN++;
        amt += r.amount;
      }
    }
    var head = '<div class="usum">' + rows.length + '줄 인식' + (parsed.skipped ? ' · 건너뜀 ' + parsed.skipped + '줄' : '');
    if (upload.kind === 'fp_tx') head += ' · 입고 ' + inN + ' / 출고 ' + outN + ' · 수량 합 ' + fmtQty(qty) + (amt ? ' · 금액 ' + won(amt) : '');
    if (upload.kind === 'acc_expense') head += ' · 경비 ' + expN + ' / 수입 ' + incN + ' · 합계 ' + won(amt);
    head += '</div>';
    for (i = 0; i < Math.min(8, rows.length); i++) {
      var x = rows[i];
      if (upload.kind === 'fp_tx') lines.push('<div class="urow"><span>' + esc(x.code || x.name) + ' · ' + ERP.fpTypeName(x.type) + '</span><b>' + fmtQty(x.qty) + '</b></div>');
      else if (upload.kind === 'fp_price') lines.push('<div class="urow"><span>' + esc(x.code || x.name) + (x.spec ? ' · ' + esc(x.spec) : '') + '</span><b>' + fmtInt(x.in_price || 0) + '원</b></div>');
      else lines.push('<div class="urow"><span>' + esc(x.date) + ' · ' + esc(x.note || x.partner) + '</span><b>' + won(x.amount) + '</b></div>');
    }
    if (rows.length > 8) lines.push('<div class="urow"><span>… 외 ' + (rows.length - 8) + '줄</span><span></span></div>');
    box.innerHTML = head + lines.join('');
    upload.rows = rows;
    $('uploadGo').disabled = false;
  }
  function handleUploadFile() {
    var f = $('uploadFile').files && $('uploadFile').files[0];
    if (!f) return;
    $('uploadPreview').innerHTML = '<div class="urow"><span>읽는 중…</span></div>';
    $('uploadGo').disabled = true;
    readFileRows(f, function (err, rows) {
      if (err) {
        $('uploadPreview').innerHTML = '<div class="uerr">' + esc(err.message) + '</div>';
        return;
      }
      renderUploadPreview(ERP.parseSheet(rows, upload.kind));
    });
  }
  function doUpload() {
    if (!upload.rows || !upload.rows.length) return;
    var kind = upload.kind, b = $('uploadGo');
    b.disabled = true; b.textContent = '올리는 중…';
    function finish(text, ok) {
      b.disabled = false; b.textContent = '올리기';
      $('uploadPreview').innerHTML = text;
      toast(ok ? '엑셀 업로드 완료' : '엑셀 업로드에 실패한 줄이 있습니다', ok ? 'ok' : 'warn');
      cur.fgLimit = 300;
      return reload({ silent: true });
    }
    if (kind === 'fp_tx') {
      SB.db.fpBatch(upload.rows, $('uploadNeg').checked).then(function (res) {
        var errs = (res && res.errors) || [];
        var html = '<div class="usum">완료: 성공 ' + (res.ok || 0) + '건' + (res.fail ? ' · 실패 ' + res.fail + '건' : '') +
          (res.amount ? ' · 금액 ' + won(res.amount) : '') + '</div>';
        for (var i = 0; i < Math.min(10, errs.length); i++) {
          html += '<div class="urow uerr"><span>행 ' + esc(errs[i].row) + ' · ' + esc(errs[i].code || errs[i].name || '') + '</span><span>' + esc(errs[i].msg || '') + '</span></div>';
        }
        return finish(html, !res.fail);
      }, function (e) { b.disabled = false; b.textContent = '올리기'; $('uploadPreview').innerHTML = '<div class="uerr">' + esc(e.message) + '</div>'; toast(e.message, 'err'); });
    } else if (kind === 'fp_price') {
      SB.db.fpBatchPrice(upload.rows).then(function (res) {
        var html = '<div class="usum">완료: 성공 ' + (res.ok || 0) + '건' + (res.fail ? ' · 실패 ' + res.fail + '건' : '') + '</div>';
        var errs = (res && res.errors) || [];
        for (var i = 0; i < Math.min(8, errs.length); i++) html += '<div class="urow uerr"><span>' + esc(errs[i].code || errs[i].name || '') + '</span><span>' + esc(errs[i].msg || '') + '</span></div>';
        return finish(html, !res.fail);
      }, function (e) { b.disabled = false; b.textContent = '올리기'; $('uploadPreview').innerHTML = '<div class="uerr">' + esc(e.message) + '</div>'; toast(e.message, 'err'); });
    } else {
      var rows = upload.rows.slice(), ok = 0, fail = 0, errs2 = [], idx = 0;
      function step() {
        if (idx >= rows.length) {
          var html = '<div class="usum">완료: 성공 ' + ok + '건' + (fail ? ' · 실패 ' + fail + '건' : '') + '</div>';
          for (var i = 0; i < Math.min(8, errs2.length); i++) html += '<div class="urow uerr"><span>' + esc(errs2[i]) + '</span></div>';
          return finish(html, !fail);
        }
        var r = rows[idx++];
        SB.db.accExpenseSave({
          date: r.date || today(), type: r.type, cat: r.category || '기타', partner: r.partner || '',
          amount: r.amount, tax: r.tax_type || 'free', vatIncluded: true, method: r.method || '', note: r.note || ''
        }).then(function () { ok++; step(); }, function (e) {
          fail++;
          if (errs2.length < 30) errs2.push((r.date || '') + ' ' + (r.note || r.partner || '') + ' — ' + e.message);
          step();
        });
      }
      step();
    }
  }

  /* ==========================================================================
     💰 회계 ERP
     ========================================================================== */
  /* ==========================================================================
     v8 · 구매관리 · 판매관리 · 생산·원가관리 화면
     ========================================================================== */
  function voucherPaneList(kind, cols) {
    var r = kind === 'buy' ? cur.buyRange : cur.saleRange;
    var q = kind === 'buy' ? cur.buySearch : cur.saleSearch;
    var fl = cols || (kind === 'buy' ? cur.fAccB : cur.fAccS);
    var sort = kind === 'buy' ? cur.sortB : cur.sortS;
    return ERP.accFilterVouchers(acc(), {
      q: q, type: kind === 'buy' ? 'purchase' : 'sale', from: r.from, to: r.to,
      cols: fl, sortKey: sort.k, sortDir: sort.dir
    });
  }
  function renderVoucherPane(kind) {
    var isBuy = kind === 'buy';
    var wrap = $(isBuy ? 'buyTableWrap' : 'saleTableWrap');
    if (!wrap) return;
    var tbl = isBuy ? 'accB' : 'accS';
    var cols = ERP.voucherCols(kind);
    var list = voucherPaneList(kind);
    var sort = isBuy ? cur.sortB : cur.sortS;
    var fl = isBuy ? cur.fAccB : cur.fAccS;
    var sum = 0, i, c;
    for (i = 0; i < list.length; i++) sum += list[i].total;
    var sumEl = $(isBuy ? 'buyRangeSum' : 'saleRangeSum');
    if (sumEl) sumEl.textContent = list.length + '건 · 합계 ' + fmtInt(sum) + '원';
    if (!list.length) {
      wrap.innerHTML = '<table><tbody><tr class="empty-row"><td>' +
        (isBuy ? '매입 전표가 없습니다. 원료육·완제품 입고를 저장하면 <b>자동으로</b> 매입 전표가 생깁니다.'
               : '매출 전표가 없습니다. 업체·택배 출고를 저장하면 <b>자동으로</b> 매출 전표가 생깁니다.') +
        '</td></tr></tbody></table>';
      return;
    }
    var shown = list.slice(0, 400);
    var html = [tableOpen('t-acc ' + (isBuy ? 't-buy' : 't-sale'), tbl, cols, ACT_DEF[tbl]), '<thead><tr>'];
    for (c = 0; c < cols.length; c++) html.push(thHtml(cols[c], sort, fl));
    html.push(actTh() + '</tr></thead><tbody>');
    for (i = 0; i < shown.length; i++) {
      var v = shown[i];
      html.push('<tr class="accrow ' + (isBuy ? 'vbuy' : 'vsale') + '" data-vrow="' + v.id + '">');
      for (c = 0; c < cols.length; c++) html.push(accCellHtml(v, cols[c].k, isBuy ? 'B' : 'S'));
      html.push('<td class="actcell actcol"><div class="acts">' +
        (isBuy ? '' : '<button class="act stmt" data-vstmt="' + v.id + '" title="거래명세표 인쇄">📄</button>') +
        '<button class="act edit" data-vedit="' + v.id + '">수정</button>' +
        '<button class="cancel" data-vdel="' + v.id + '">삭제</button></div></td></tr>');
    }
    html.push('</tbody></table>');
    if (list.length > shown.length) {
      html.push('<div class="v8hint">… 외 ' + (list.length - shown.length) + '건 (기간을 좁히거나 검색하세요)</div>');
    }
    wrap.innerHTML = html.join('');
  }
  function renderVoucherCards(kind) {
    var isBuy = kind === 'buy';
    var box = $(isBuy ? 'buyPayList' : 'saleRecvList');
    var sumEl = $(isBuy ? 'buyPaySum' : 'saleRecvSum');
    if (!box) return;
    var led = ERP.accLedger(acc(), '', '', '');
    var arr = [], total = 0, i, v;
    for (i = 0; i < led.length; i++) {
      v = isBuy ? led[i].payable : led[i].receivable;
      if (Number(v) > 0.5) { arr.push({ partner: led[i].partner, amt: Math.round(Number(v)) }); total += Number(v); }
    }
    arr.sort(function (a, b) { return b.amt - a.amt; });
    if (sumEl) sumEl.textContent = won(total);
    if (!arr.length) {
      box.innerHTML = '<div class="v8cardempty">' +
        (isBuy ? '미지급금이 없습니다. 매입 전표를 넣으면 거래처별로 모입니다.'
               : '미수금이 없습니다. 매출 전표를 넣으면 거래처별로 모입니다.') + '</div>';
      return;
    }
    var html = [];
    for (i = 0; i < Math.min(30, arr.length); i++) {
      html.push('<div class="v8card ' + (isBuy ? 'pay' : 'recv') + '">' +
        '<b title="' + esc(arr[i].partner) + '">' + esc(arr[i].partner || '거래처 없음') + '</b>' +
        '<span class="amt">' + fmtInt(arr[i].amt) + '<small>원</small></span>' +
        '<button type="button" class="v8cardbtn ' + (isBuy ? 'payout' : 'payin') + '" ' +
        (isBuy ? 'data-payout' : 'data-payin') + '="' + esc(arr[i].partner) + '">' +
        (isBuy ? '＋ 지급' : '＋ 수금') + '</button></div>');
    }
    if (arr.length > 30) html.push('<div class="v8cardempty">… 외 ' + (arr.length - 30) + '거래처</div>');
    box.innerHTML = html.join('');
  }
  /* ---------- v9: 미지급금 · 미수금 현황 (입력과 구분해서 보는 화면) ---------- */
  function payLogsOf(kind, limit) {
    var out = [], i, p;
    for (i = 0; i < st.payments.length; i++) {
      p = st.payments[i];
      if (p.t !== kind) continue;
      out.push(p);
    }
    out.sort(function (a, b) { if (a.d !== b.d) return a.d < b.d ? 1 : -1; return (b.id || 0) - (a.id || 0); });
    return limit ? out.slice(0, limit) : out;
  }
  function renderBalanceStatus(kind) {
    var isBuy = kind === 'buy';
    var on = (isBuy ? cur.buyView : cur.saleView) === 'status';
    var box = $(isBuy ? 'buyPayStatus' : 'saleRecvStatus');
    if (box) box.classList.toggle('hidden', !on);
    if (!on) return;
    var wrap = $(isBuy ? 'buyPayStatusWrap' : 'saleRecvStatusWrap');
    var logWrap = $(isBuy ? 'buyPayLogWrap' : 'saleRecvLogWrap');
    if (!wrap) return;
    var mainKey = isBuy ? 'purchase' : 'sale';
    var payKey = isBuy ? 'paid' : 'received';
    var balKey = isBuy ? 'payable' : 'receivable';
    var led = ERP.accLedger(acc(), '', '', '');
    var rows = [], i, r;
    for (i = 0; i < led.length; i++) {
      r = led[i];
      if (isBuy ? (r.purchase > 0 || r.paid > 0) : (r.sale > 0 || r.received > 0)) rows.push(r);
    }
    rows.sort(function (a, b) { return (b[balKey] - a[balKey]) || (b[mainKey] - a[mainKey]); });
    if (!rows.length) {
      wrap.innerHTML = '<table><tbody><tr class="empty-row"><td>' +
        (isBuy ? '아직 매입 전표가 없습니다. 원료육·완제품 입고를 저장하거나 <b>＋ 매입 전표 직접 입력</b>으로 넣으면 거래처별로 모입니다.'
               : '아직 매출 전표가 없습니다. 원료육·완제품 판매 출고를 저장하거나 <b>＋ 매출 전표 직접 입력</b>으로 넣으면 거래처별로 모입니다.') +
        '</td></tr></tbody></table>';
    } else {
      var tMain = 0, tPay = 0, tBal = 0;
      var html = ['<table class="t-bal"><thead><tr>' +
        '<th>거래처</th><th class="num">' + (isBuy ? '총 매입' : '총 매출') + '</th>' +
        '<th class="num">' + (isBuy ? '총 지급' : '총 수금') + '</th>' +
        '<th class="num">' + (isBuy ? '남은 미지급금' : '남은 미수금') + '</th><th>작업</th></tr></thead><tbody>'];
      for (i = 0; i < rows.length; i++) {
        r = rows[i];
        tMain += r[mainKey]; tPay += r[payKey]; tBal += r[balKey];
        html.push('<tr>' +
          '<td><b>' + esc(r.partner) + '</b></td>' +
          '<td class="num">' + (r[mainKey] ? fmtInt(Math.round(r[mainKey])) : '-') + '</td>' +
          '<td class="num">' + (r[payKey] ? fmtInt(Math.round(r[payKey])) : '-') + '</td>' +
          '<td class="num ' + (isBuy ? 'pay' : 'recv') + '"><b>' + fmtInt(Math.round(r[balKey])) + '</b></td>' +
          '<td class="actcell"><div class="acts">' +
          '<button class="act ' + (isBuy ? 'out' : 'in') + '" data-bpay="' + esc(r.partner) + '">' +
          (isBuy ? '지급' : '수금') + '</button>' +
          '<button class="act" data-bledger="' + esc(r.partner) + '">원장</button></div></td></tr>');
      }
      html.push('<tr class="sumrow"><td><b>합계</b></td><td class="num"><b>' + fmtInt(Math.round(tMain)) + '</b></td>' +
        '<td class="num"><b>' + fmtInt(Math.round(tPay)) + '</b></td>' +
        '<td class="num ' + (isBuy ? 'pay' : 'recv') + '"><b>' + fmtInt(Math.round(tBal)) + '</b></td><td></td></tr>');
      html.push('</tbody></table>');
      wrap.innerHTML = html.join('');
    }
    if (!logWrap) return;
    var pays = payLogsOf(isBuy ? 'out' : 'in', 20);
    if (!pays.length) {
      logWrap.innerHTML = '<table><tbody><tr class="empty-row"><td>' +
        (isBuy ? '지급 내역이 없습니다. 위 표의 [지급]을 누르면 그 거래처 지급을 바로 넣습니다.'
               : '수금 내역이 없습니다. 위 표의 [수금]을 누르면 그 거래처 수금을 바로 넣습니다.') + '</td></tr></tbody></table>';
      return;
    }
    var h2 = ['<table class="t-bal"><thead><tr><th>날짜</th><th>거래처</th><th class="num">금액</th><th>수단</th><th>메모</th><th></th></tr></thead><tbody>'];
    for (i = 0; i < pays.length; i++) {
      var p = pays[i];
      h2.push('<tr><td>' + esc(p.d) + '</td><td>' + esc(p.partner) + '</td>' +
        '<td class="num"><b>' + fmtInt(p.amount) + '</b></td><td>' + esc(p.method || '-') + '</td>' +
        '<td>' + esc(p.note || '') + '</td>' +
        '<td class="actcell"><button class="cancel" data-bpaydel="' + p.id + '">삭제</button></td></tr>');
    }
    h2.push('</tbody></table>');
    if (payLogsOf(isBuy ? 'out' : 'in', 0).length > pays.length) {
      h2.push('<div class="v8hint">최근 20건만 보입니다. 전체 내역은 <b>6. 회계·손익 → 거래처별 원장 → 내역</b>에서 봅니다.</div>');
    }
    logWrap.innerHTML = h2.join('');
  }
  function balanceStatusClick(ev, t, kind) {
    var isBuy = kind === 'buy';
    var pay = t.closest ? t.closest('[data-bpay]') : null;
    if (pay) { openAccPay(isBuy ? 'out' : 'in', pay.getAttribute('data-bpay')); return true; }
    var del = t.closest ? t.closest('[data-bpaydel]') : null;
    if (del) { accDelete('p', Number(del.getAttribute('data-bpaydel'))); return true; }
    var led = t.closest ? t.closest('[data-bledger]') : null;
    if (led) {
      cur.accTab = 'R'; cur.accSearch = led.getAttribute('data-bledger') || ''; cur.accType = 'all';
      if ($('accSearch')) $('accSearch').value = cur.accSearch;
      setPane('acc');
      return true;
    }
    return false;
  }
  function renderBuy() { renderVoucherCards('buy'); renderVoucherPane('buy'); renderBalanceStatus('buy'); }
  function renderSale() { renderVoucherCards('sale'); renderVoucherPane('sale'); renderBalanceStatus('sale'); }

  /* ---------- 생산·원가관리 ---------- */
  function renderProd() {
    var from = cur.prodRange.from, to = cur.prodRange.to;
    var su = ERP.prodSummary(st, from, to);
    if ($('prodTotal')) $('prodTotal').textContent = won(su.total);
    if ($('prodTotalSub')) $('prodTotalSub').textContent = '원료육 ' + fmtInt(su.meat) + ' · 완제품·부자재 ' + fmtInt(su.fp);
    if ($('prodMeat')) $('prodMeat').textContent = won(su.meat);
    if ($('prodMeatSub')) $('prodMeatSub').textContent = su.cntM + '건';
    if ($('prodFp')) $('prodFp').textContent = won(su.fp);
    if ($('prodFpSub')) $('prodFpSub').textContent = su.cntF + '건';
    if ($('prodSales')) $('prodSales').textContent = '0원';
    var seg = document.querySelectorAll('#prodPeriodSeg button');
    for (var i = 0; i < seg.length; i++) seg[i].classList.toggle('active', seg[i].getAttribute('data-prodperiod') === cur.prodPeriod);
    renderProdTable();
    renderProdCost();
  }
  function renderProdTable() {
    var wrap = $('prodTableWrap');
    if (!wrap) return;
    var unit = cur.prodPeriod === 'month' ? 'month' : 'day';
    var tbl = unit === 'month' ? 'prodM' : 'prodD';
    var cols = ERP.PROD_COLS[unit];
    var list = ERP.prodByPeriod(st, cur.prodRange.from, cur.prodRange.to, unit);
    var sum = 0, meat = 0, fp = 0, i, c;
    for (i = 0; i < list.length; i++) { sum += list[i].total; meat += list[i].meat; fp += list[i].fp; }
    if ($('prodRangeSum')) $('prodRangeSum').textContent = list.length + (unit === 'month' ? '개월' : '일') + ' · 합계 ' + fmtInt(sum) + '원';
    if (!list.length) {
      wrap.innerHTML = '<table><tbody><tr class="empty-row"><td>기간에 현장 출고가 없습니다. 원료육 출고처 <b>🏭 현장</b>과 완제품 출고 <b>🏭 현장소모</b>가 여기에 모입니다.</td></tr></tbody></table>';
      return;
    }
    var html = [tableOpen('t-prod', tbl, cols, 0), '<thead><tr>'];
    for (c = 0; c < cols.length; c++) html.push(thPlain(cols[c]));
    html.push('</tr></thead><tbody>');
    for (i = 0; i < list.length; i++) {
      var r = list[i];
      html.push('<tr class="prodrow"><td><b>' + esc(r.period) + '</b></td>' +
        '<td class="num meat">' + (r.meat ? fmtInt(r.meat) : '-') + '</td>' +
        '<td class="num fp">' + (r.fp ? fmtInt(r.fp) : '-') + '</td>' +
        '<td class="num total"><b>' + fmtInt(r.total) + '</b></td>' +
        '<td class="num">' + r.cnt + '</td></tr>');
    }
    html.push('<tr class="prodrow sumrow"><td><b>합계</b></td><td class="num meat"><b>' + fmtInt(meat) + '</b></td>' +
      '<td class="num fp"><b>' + fmtInt(fp) + '</b></td><td class="num total"><b>' + fmtInt(sum) + '</b></td>' +
      '<td class="num">' + (function () { var n = 0; for (var j = 0; j < list.length; j++) n += list[j].cnt; return n; })() + '</td></tr>');
    html.push('</tbody></table>');
    wrap.innerHTML = html.join('');
  }
  function renderProdCost() {
    var wrap = $('prodCostWrap');
    if (!wrap) return;
    var cols = ERP.PROD_COLS.cost;
    var list = ERP.prodCostItems(st, cur.prodRange.from, cur.prodRange.to);
    if (!list.length) {
      wrap.innerHTML = '<table><tbody><tr class="empty-row"><td>현장 투입 기록이 없습니다. 출고할 때 <b>생산품목</b>을 적으면 품목별 원가가 계산됩니다.</td></tr></tbody></table>';
      return;
    }
    var html = [], c;
    var anyProd = false;
    for (c = 0; c < list.length; c++) if (list[c].produced > 0) anyProd = true;
    if (!anyProd) {
      html.push('<div class="v8note">아직 <b>자체생산</b> 입고가 없어 1단위당 제조원가를 계산할 수 없습니다. 완제품 입고에서 <b>🏭 자체생산</b>으로 등록하면 이 표에 단위원가·마진이 자동으로 채워집니다.</div>');
    }
    html.push(tableOpen('t-prod', 'prodC', cols, 0), '<thead><tr>');
    for (c = 0; c < cols.length; c++) html.push(thPlain(cols[c]));
    html.push('</tr></thead><tbody>');
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var name = r.missing ? '<span class="v8tag warn">미지정 현장 출고</span>' : '<b>' + esc(r.item) + '</b>' + (r.code ? ' <span class="ttag">' + esc(r.code) + '</span>' : '');
      var prod = r.produced > 0 ? fmtQty(r.produced) + esc(r.unit) : '<span class="v8tag warn">생산입고 없음</span>';
      var uc = r.produced > 0 ? fmtInt(r.unitCost) + '원' : '-';
      var sp = r.salePrice > 0 ? fmtInt(r.salePrice) + '원' : '-';
      var mg = r.salePrice > 0 && r.produced > 0 ? '<b class="' + (r.margin >= 0 ? 'pos' : 'neg') + '">' + fmtInt(r.margin) + '원</b>' : '-';
      var mp = r.salePrice > 0 && r.produced > 0 ? '<span class="' + (r.margin >= 0 ? 'pos' : 'neg') + '">' + r.marginPct + '%</span>' : '-';
      html.push('<tr class="prodrow costrow' + (r.missing ? ' miss' : '') + '">' +
        '<td>' + name + '</td>' +
        '<td class="num">' + fmtInt(r.cost) + '</td>' +
        '<td class="num">' + prod + '</td>' +
        '<td class="num"><b>' + uc + '</b></td>' +
        '<td class="num">' + sp + '</td>' +
        '<td class="num">' + mg + '</td>' +
        '<td class="num">' + mp + '</td></tr>');
    }
    html.push('</tbody></table>');
    wrap.innerHTML = html.join('');
  }

  function renderAccKPI() {
    if (!$('kAccRecv')) return;
    var a = acc();
    var bal = ERP.accBalance(a);
    var tax = ERP.accTaxPending(a, '', '');
    var mon = ERP.accTotals(a, today().slice(0, 7));
    var sp = ERP.prodSummary(st, today().slice(0, 8) + '01', today());
    kpi('kAccRecv', bal.receivable, 0);
    kpi('kAccPay', bal.payable, 0);
    kpi('kAccTax', tax.saleCnt + tax.buyCnt, 0);
    kpi('kAccSale', mon.sale, 0);
    kpi('kAccBuy', mon.purchase + mon.expense, 0);
    kpi('kAccProd', sp.total, 0);
    kpi('kAccProfit', mon.profit, 0);
    if ($('kAccProdSub')) $('kAccProdSub').textContent = '원료육 ' + fmtInt(sp.meat) + ' · 완제품·부자재 ' + fmtInt(sp.fp);
    if ($('kAccTaxSub')) $('kAccTaxSub').textContent = '미발행 ' + tax.saleCnt + '건 · 미수령 ' + tax.buyCnt + '건';
    $('kAccSaleSub').textContent = today().slice(0, 7) + ' · 공급가액 기준';
    $('kAccBuySub').textContent = '매입 ' + fmtInt(mon.purchase) + ' · 경비 ' + fmtInt(mon.expense);
    if ($('accBadge')) $('accBadge').textContent = String(a.vouchers.length);
    if ($('cntAccV')) $('cntAccV').textContent = a.vouchers.length;
    if ($('cntAccR')) $('cntAccR').textContent = ERP.accLedger(a, '', '', '').length;
    if ($('cntAccS')) {          /* v11 — 받을돈·줄돈이 남아 있는 거래처 수 */
      var ledS = ERP.accLedger(a, '', '', ''), openS = 0, iS;
      for (iS = 0; iS < ledS.length; iS++) if (ledS[iS].receivable > 0.004 || ledS[iS].payable > 0.004) openS++;
      $('cntAccS').textContent = String(openS);
    }
    if ($('cntAccE')) $('cntAccE').textContent = a.expenses.length;
    if ($('cntAccM')) $('cntAccM').textContent = ERP.accMonthly(a, '', '').length;
    if ($('accBadge')) $('accBadge').classList.toggle('neg', mon.profit < 0);
  }
  function accLedgerList() {
    return ERP.accLedger(acc(), cur.accRange.from, cur.accRange.to, cur.accSearch);
  }
  function accCellHtml(r, k, tab) {
    if (k === 'd') return '<td>' + esc(r.d || '-') + '</td>';
    if (k === 't') {
      var cls = r.t === 'sale' ? 'in' : (r.t === 'purchase' ? 'out' : (r.t === 'income' ? 'in' : 'out'));
      return '<td><span class="badge ' + cls + '">' + esc(ERP.accCell(r, 't')) + '</span></td>';
    }
    if (k === 'partner') {
      var sub = r.note ? ' <span class="ttag">' + esc(r.note) + '</span>' : '';
      return '<td class="ellip" title="' + esc(r.partner + (r.note ? ' · ' + r.note : '')) + '"><b>' + esc(r.partner || '-') + '</b>' + sub + '</td>';
    }
    if (k === 'tax') return '<td><span class="tax-tag ' + (r.tax === 'tax' ? 'tax' : 'free') + '">' + esc(ERP.ACC_TAX[r.tax] || '-') + '</span></td>';
    if (k === 'doc') {
      var label = ERP.accDocName(r.t, r.doc);
      return '<td><button class="docbtn' + (r.doc === 'none' ? ' none' : '') + '" data-doc="' + r.id + '" title="누르면 발행/수령 상태를 바꿉니다">' + esc(label) + '</button></td>';
    }
    if (k === 'src') {
      var src = r.src === 'meat' ? '원료육' : (r.src === 'fp' ? '완제품' : '직접');
      return '<td><span class="src-tag ' + esc(r.src) + '">' + esc(src) + '</span></td>';
    }
    if (k === 'note') return '<td class="ellip" title="' + esc(r.note) + '">' + esc(r.note || '-') + '</td>';
    if (k === 'cat') return '<td><span class="cat-tag">' + esc(r.cat || '-') + '</span></td>';
    if (k === 'method') return '<td>' + esc(r.method || '-') + '</td>';
    if (k === 'ym') return '<td><b>' + esc(r.ym) + '</b></td>';
    if (k === 'balance') {
      var v = Number(r.balance) || 0;
      return '<td class="num ' + (v > 0 ? 'pos' : (v < 0 ? 'neg' : '')) + '">' + fmtInt(v) + '</td>';
    }
    if (k === 'profit') {
      var p = Number(r.profit) || 0;
      return '<td class="num ' + (p < 0 ? 'neg' : 'pos') + '"><b>' + fmtInt(p) + '</b></td>';
    }
    if (k === 'sale' || k === 'purchase' || k === 'expense' || k === 'received' || k === 'paid' ||
        k === 'receivable' || k === 'payable' || k === 'supply' || k === 'vat' || k === 'total' ||
        k === 'amount' || k === 'income') {
      var n = Number(r[k]) || 0;
      if (!n) return '<td class="num zero">-</td>';
      return '<td class="num">' + fmtInt(n) + '</td>';
    }
    return '<td class="ellip">' + esc(ERP.accCell(r, k) || '-') + '</td>';
  }
  function renderAccVouchers() {
    var wrap = $('accTableWrap');
    var cols = ERP.accCols('V');
    var list = ERP.accFilterVouchers(acc(), {
      q: cur.accSearch, type: cur.accType, from: cur.accRange.from, to: cur.accRange.to,
      cols: cur.fAccV, sortKey: cur.accSortV.k, sortDir: cur.accSortV.dir
    });
    var sale = 0, buy = 0, i;
    for (i = 0; i < list.length; i++) { if (list[i].t === 'sale') sale += list[i].total; else buy += list[i].total; }
    setAccSum(list.length + '건 · 매출 ' + fmtInt(sale) + '원 · 매입 ' + fmtInt(buy) + '원');
    if (!list.length) {
      wrap.innerHTML = (cur.v4ok ? '' : noV4('회계 표가 아직 없습니다. Supabase SQL Editor에서 <b>supabase_migrate_v4.sql</b>을 실행해 주세요.')) +
        '<table><tbody><tr class="empty-row"><td>전표가 없습니다. 위 <b>＋ 매출·매입 전표</b>로 넣거나 <b>⚡ 입출고 일괄 반영</b>을 눌러 보세요.</td></tr></tbody></table>';
      return;
    }
    var page = list.slice(0, cur.accLimit);
    var html = [tableOpen('t-acc', 'accV', cols, ACT_DEF.accV), '<thead><tr>'], c;
    for (c = 0; c < cols.length; c++) html.push(thHtml(cols[c], cur.accSortV, cur.fAccV));
    html.push(actTh() + '</tr></thead><tbody>');
    for (i = 0; i < page.length; i++) {
      var v = page[i];
      html.push('<tr class="accrow" data-vrow="' + v.id + '">');
      for (c = 0; c < cols.length; c++) html.push(accCellHtml(v, cols[c].k, 'V'));
      html.push('<td class="actcell actcol"><div class="acts">' +
        (v.t === 'sale' ? '<button class="act stmt" data-vstmt="' + v.id + '" title="거래명세표 인쇄">📄</button>' : '') +
        '<button class="act edit" data-vedit="' + v.id + '">수정</button>' +
        '<button class="cancel" data-vdel="' + v.id + '">삭제</button></div></td></tr>');
    }
    html.push('</tbody></table>');
    if (list.length > cur.accLimit) {
      html.push('<button class="more" id="btnAccMore">더 보기 (' + (list.length - cur.accLimit) + '건 남음)</button>');
    }
    wrap.innerHTML = html.join('');
    var moreV = $('btnAccMore');
    if (moreV) moreV.addEventListener('click', function () { cur.accLimit += 300; renderAccVouchers(); });
  }
  function renderAccLedger() {
    var wrap = $('accTableWrap');
    var cols = ERP.accCols('R');
    var list = accLedgerList();
    var sk = cur.accSortR.k, dir = cur.accSortR.dir === -1 ? -1 : 1;
    if (sk) {
      list = list.slice().sort(function (a, b) {
        var av = ERP.accCell(a, sk), bv = ERP.accCell(b, sk);
        var an = Number(av), bn = Number(bv);
        var c = (av !== '' && bv !== '' && isFinite(an) && isFinite(bn)) ? (an - bn) : String(av).localeCompare(String(bv), 'ko');
        return c * dir;
      });
    }
    var recv = 0, pay = 0, i;
    for (i = 0; i < list.length; i++) { recv += list[i].receivable; pay += list[i].payable; }
    setAccSum(list.length + '거래처 · 미수 ' + fmtInt(recv) + '원 · 미지급 ' + fmtInt(pay) + '원');
    if (!list.length) {
      wrap.innerHTML = '<table><tbody><tr class="empty-row"><td>거래처별 원장이 비어 있습니다. 전표를 넣으면 자동으로 모입니다.</td></tr></tbody></table>';
      return;
    }
    var html = [tableOpen('t-acc', 'accR', cols, ACT_DEF.accR), '<thead><tr>'], c;
    for (c = 0; c < cols.length; c++) html.push(thPlain(cols[c], cur.accSortR));
    html.push(actTh() + '</tr></thead><tbody>');
    for (i = 0; i < list.length; i++) {
      var r = list[i];
      html.push('<tr class="accrow" data-partner="' + esc(r.partner) + '">');
      for (c = 0; c < cols.length; c++) html.push(accCellHtml(r, cols[c].k, 'R'));
      html.push('<td class="actcell actcol"><div class="acts">' +
        '<button class="act in" data-payin="' + esc(r.partner) + '">수금</button>' +
        '<button class="act out" data-payout="' + esc(r.partner) + '">지급</button>' +
        '<button class="act" data-paylist="' + esc(r.partner) + '">내역</button></div></td></tr>');
      if (cur.payOpen[r.partner]) {
        var pays = [], k;
        for (k = 0; k < st.payments.length; k++) {
          var pm = st.payments[k];
          if (pm.partner !== r.partner) continue;
          if (!ERP.inPeriod(pm.d, cur.accRange.from, cur.accRange.to)) continue;
          pays.push(pm);
        }
        pays.sort(function (a, b) { return a.d < b.d ? 1 : (a.d > b.d ? -1 : b.id - a.id); });
        var lines = [];
        if (!pays.length) lines.push('<div class="payrow empty">수금·지급 기록이 없습니다.</div>');
        for (k = 0; k < pays.length; k++) {
          var q = pays[k];
          lines.push('<div class="payrow"><span>' + esc(q.d) + '</span>' +
            '<span class="' + (q.t === 'in' ? 'pos' : 'neg') + '">' + (q.t === 'in' ? '수금' : '지급') + '</span>' +
            '<b>' + fmtInt(q.amount) + '원</b>' +
            '<span class="ttag">' + esc(q.method || '-') + (q.note ? ' · ' + esc(q.note) : '') + '</span>' +
            '<button class="cancel" data-pdel="' + q.id + '">삭제</button></div>');
        }
        html.push('<tr class="subrow"><td colspan="' + (cols.length + 1) + '"><div class="sublist">' +
          '<div class="subhead">' + esc(r.partner) + ' 수금·지급 기록 (' + pays.length + '건)</div>' + lines.join('') + '</div></td></tr>');
      }
    }
    html.push('</tbody></table>');
    wrap.innerHTML = html.join('');
  }
  function renderAccExpenses() {
    var wrap = $('accTableWrap');
    var cols = ERP.accCols('E');
    var list = ERP.accFilterExpenses(acc(), {
      q: cur.accSearch, type: cur.accType, from: cur.accRange.from, to: cur.accRange.to, cols: cur.fAccE
    });
    var exp = 0, inc = 0, i;
    for (i = 0; i < list.length; i++) { if (list[i].t === 'income') inc += list[i].amount; else exp += list[i].amount; }
    setAccSum(list.length + '건 · 경비 ' + fmtInt(exp) + '원 · 수입 ' + fmtInt(inc) + '원');
    if (!list.length) {
      wrap.innerHTML = '<table><tbody><tr class="empty-row"><td>경비·수입 기록이 없습니다. 위 <b>＋ 경비·수입</b>으로 넣거나 통장·카드 엑셀을 올려 보세요.</td></tr></tbody></table>';
      return;
    }
    var html = [tableOpen('t-acc', 'accE', cols, ACT_DEF.accE), '<thead><tr>'], c;
    for (c = 0; c < cols.length; c++) html.push(thHtml(cols[c], cur.accSortE, cur.fAccE));
    html.push(actTh() + '</tr></thead><tbody>');
    for (i = 0; i < list.length; i++) {
      var e = list[i];
      html.push('<tr class="accrow" data-erow="' + e.id + '">');
      for (c = 0; c < cols.length; c++) html.push(accCellHtml(e, cols[c].k, 'E'));
      html.push('<td class="actcell actcol"><div class="acts"><button class="act edit" data-eedit="' + e.id + '">수정</button>' +
        '<button class="cancel" data-edel="' + e.id + '">삭제</button></div></td></tr>');
    }
    html.push('</tbody></table>');
    if (list.length > cur.accLimit) {
      html.push('<button class="more" id="btnAccMore">더 보기 (' + (list.length - cur.accLimit) + '건 남음)</button>');
    }
    wrap.innerHTML = html.join('');
    var moreE = $('btnAccMore');
    if (moreE) moreE.addEventListener('click', function () { cur.accLimit += 300; renderAccExpenses(); });
  }
  function renderAccMonths() {
    var wrap = $('accTableWrap');
    var cols = ERP.accCols('M');
    var list = ERP.accMonthly(acc(), cur.accRange.from, cur.accRange.to);
    var q = cur.accSearch.toLowerCase(), shown = [], i;
    for (i = 0; i < list.length; i++) if (!q || list[i].ym.indexOf(q) >= 0) shown.push(list[i]);
    var sum = 0, i2;
    for (i2 = 0; i2 < shown.length; i2++) sum += shown[i2].profit;
    setAccSum(shown.length + '개월 · 순이익 합 ' + fmtInt(sum) + '원');
    if (!shown.length) {
      wrap.innerHTML = '<table><tbody><tr class="empty-row"><td>표시할 손익이 없습니다. 전표·경비를 넣으면 월별로 모입니다.</td></tr></tbody></table>';
      return;
    }
    var html = [tableOpen('t-acc', 'accM', cols, 0), '<thead><tr>'], c;
    for (c = 0; c < cols.length; c++) html.push(thPlain(cols[c], { k: '', dir: 1 }));
    html.push('</tr></thead><tbody>');
    for (i = 0; i < shown.length; i++) {
      var m = shown[i];
      html.push('<tr class="accrow">');
      for (c = 0; c < cols.length; c++) html.push(accCellHtml(m, cols[c].k, 'M'));
      html.push('</tr>');
    }
    html.push('</tbody></table>');
    wrap.innerHTML = html.join('');
  }

  /* ==========================================================================
     v11 — 💳 받을돈·줄돈 정산: 표에서 그 자리에서 바로 수금(IN)·지급(OUT) 저장
     ========================================================================== */
  var STL_LIMIT = 40;
  function stlKey(t, partner) { return t + '|' + partner; }
  /* 거래처별 매출·수금·매입·지급을 한 번에 모은다 (기간 무관 — 지금 남은 돈) */
  function stlPartners() {
    var map = {}, order = [], i, r, L, P;
    function get(name) {
      var k = trimV(name) || '(거래처 없음)';
      if (!map[k]) { map[k] = { partner: k, sale: 0, received: 0, purchase: 0, paid: 0 }; order.push(k); }
      return map[k];
    }
    for (i = 0; i < st.vouchers.length; i++) {
      r = st.vouchers[i];
      L = get(r.partner);
      if (r.t === 'sale') L.sale += Number(r.total) || 0; else L.purchase += Number(r.total) || 0;
    }
    for (i = 0; i < st.payments.length; i++) {
      r = st.payments[i];
      P = get(r.partner);
      if (r.t === 'in') P.received += Number(r.amount) || 0; else P.paid += Number(r.amount) || 0;
    }
    var out = [];
    for (i = 0; i < order.length; i++) {
      var o = map[order[i]];
      o.sale = Math.round(o.sale); o.received = Math.round(o.received);
      o.purchase = Math.round(o.purchase); o.paid = Math.round(o.paid);
      o.receivable = o.sale - o.received;
      o.payable = o.purchase - o.paid;
      out.push(o);
    }
    return out;
  }
  /* 한 거래처의 지금 남은 받을돈(in) / 줄돈(out) */
  function stlRemainOf(t, partner) {
    var sale = 0, received = 0, purchase = 0, paid = 0, i, r, pn = trimV(partner);
    for (i = 0; i < st.vouchers.length; i++) {
      r = st.vouchers[i];
      if (trimV(r.partner) !== pn) continue;
      if (r.t === 'sale') sale += Number(r.total) || 0; else purchase += Number(r.total) || 0;
    }
    for (i = 0; i < st.payments.length; i++) {
      r = st.payments[i];
      if (trimV(r.partner) !== pn) continue;
      if (r.t === 'in') received += Number(r.amount) || 0; else paid += Number(r.amount) || 0;
    }
    return Math.round(t === 'out' ? purchase - paid : sale - received);
  }
  function stlDraft(t, partner) {
    var d = cur.stlDraft[stlKey(t, partner)];
    return d || { amt: '', date: today(), method: '계좌이체' };
  }
  function stlDraftSet(t, partner, patch) {
    var k = stlKey(t, partner);
    var d = cur.stlDraft[k] || { amt: '', date: today(), method: '계좌이체' };
    if (patch.amt !== undefined) d.amt = patch.amt;
    if (patch.date !== undefined) d.date = patch.date;
    if (patch.method !== undefined) d.method = patch.method;
    cur.stlDraft[k] = d;
  }
  function stlMethodsHtml(t, curMethod) {
    var out = '', i, m = ERP.ACC_METHODS;
    for (i = 0; i < m.length; i++) {
      out += '<option value="' + esc(m[i]) + '"' + (m[i] === curMethod ? ' selected' : '') + '>' + esc(m[i]) + '</option>';
    }
    return out;
  }
  function stlHeadHtml(t) {
    var isIn = t !== 'out';
    return '<thead><tr>' +
      '<th class="stlp">거래처</th>' +
      '<th class="num">' + (isIn ? '총 매출' : '총 매입') + '</th>' +
      '<th class="num">' + (isIn ? '받은 돈' : '보낸 돈') + '</th>' +
      '<th class="num">' + (isIn ? '남은 받을돈' : '남은 줄돈') + '</th>' +
      '<th class="num">' + (isIn ? '수금 금액' : '지급 금액') + '</th>' +
      '<th></th><th>날짜</th><th>수단</th><th></th>' +
      '</tr></thead>';
  }
  function stlRowHtml(t, r) {
    var isIn = t !== 'out';
    var left = isIn ? r.receivable : r.payable;
    var d = stlDraft(t, r.partner);
    var has = left > 0.004;
    return '<tr class="stlrow' + (has ? '' : ' zerorow') + '" data-stl="' + t + '" data-partner="' + esc(r.partner) + '">' +
      '<td class="stlp ellip"><b>' + esc(r.partner) + '</b></td>' +
      '<td class="num">' + fmtInt(isIn ? r.sale : r.purchase) + '</td>' +
      '<td class="num">' + fmtInt(isIn ? r.received : r.paid) + '</td>' +
      '<td class="num ' + (has ? (isIn ? 'pos' : 'warn') : 'zero') + '"><b class="stlleft">' + fmtInt(left) + '</b></td>' +
      '<td class="stlin"><input type="number" class="stlamt" data-amt="' + t + '" min="0" step="1" placeholder="0" value="' + esc(d.amt) + '"></td>' +
      '<td class="stlbal"><button class="btn tiny stlall" type="button" data-settle-all="' + t + '"' + (has ? '' : ' disabled') + '>전액</button></td>' +
      '<td class="stldt"><input type="date" class="stldate" data-date="' + t + '" value="' + esc(d.date) + '"></td>' +
      '<td class="stlmd"><select class="stlmethod" data-method="' + t + '">' + stlMethodsHtml(t, d.method) + '</select></td>' +
      '<td class="stlgo"><button class="btn tiny primary stlsave" type="button" data-settle-save="' + t + '">' + (isIn ? '수금 저장' : '지급 저장') + '</button></td>' +
      '</tr>';
  }
  function stlLeftClass(t, v) {
    if (!(Math.abs(v) > 0.004)) return 'num zero';
    return 'num ' + (t === 'out' ? 'warn' : 'pos');
  }
  function stlTableHtml(t, rows, sum) {
    var isIn = t !== 'out';
    var html = ['<div class="stlwrap"><table class="stltbl t-' + (isIn ? 'in' : 'out') + '" id="' + (isIn ? 'stlInTbl' : 'stlOutTbl') + '">',
      '<colgroup><col><col style="width:112px"><col style="width:112px"><col style="width:122px">' +
      '<col style="width:132px"><col style="width:70px"><col style="width:152px"><col style="width:108px"><col style="width:102px"></colgroup>',
      stlHeadHtml(t), '<tbody>'];
    for (var i = 0; i < rows.length; i++) html.push(stlRowHtml(t, rows[i]));
    html.push('<tr class="stltotal"><td class="stlp">필터 합계 · ' + rows.length + '곳</td>' +
      '<td class="num">' + fmtInt(isIn ? sum.sale : sum.purchase) + '</td>' +
      '<td class="num">' + fmtInt(isIn ? sum.received : sum.paid) + '</td>' +
      '<td class="num"><b>' + fmtInt(isIn ? sum.receivable : sum.payable) + '</b></td>' +
      '<td colspan="5"></td></tr>');
    html.push('</tbody></table></div>');
    return html.join('');
  }
  /* 다시 그려도 입력 중이던 칸의 커서를 잃지 않게 기억한다 */
  function stlFocusInfo() {
    var el = document.activeElement;
    if (!el || !el.getAttribute) return null;
    var tr = stlRowOf(el);
    if (!tr) return null;
    var f = el.hasAttribute('data-amt') ? 'amt' : (el.hasAttribute('data-date') ? 'date' : (el.hasAttribute('data-method') ? 'method' : ''));
    if (!f) return null;
    var pos = null;
    try { pos = el.selectionStart; } catch (e) { pos = null; }
    return { t: tr.getAttribute('data-stl'), p: tr.getAttribute('data-partner'), f: f, pos: pos };
  }
  function stlFocusRestore(f) {
    if (!f) return;
    var tbl = $(f.t === 'out' ? 'stlOutTbl' : 'stlInTbl');
    if (!tbl) return;
    var rows = tbl.querySelectorAll('tbody tr[data-stl]'), tr = null, i;
    for (i = 0; i < rows.length; i++) if (rows[i].getAttribute('data-partner') === f.p) tr = rows[i];
    if (!tr) return;
    var el = tr.querySelector('[data-' + f.f + ']');
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) { } }
    if (f.pos !== null && f.pos !== undefined && f.f === 'amt') {
      try { el.setSelectionRange(f.pos, f.pos); } catch (e) { }
    }
  }
  function renderAccSettle() {
    var wrap = $('accTableWrap');
    if (!wrap) return;
    var focus = stlFocusInfo();
    var q = String(cur.accSearch || '').toLowerCase();
    var list = stlPartners(), i, r;
    var sumIn = 0, sumOut = 0, cntIn = 0, cntOut = 0;
    var inRows = [], outRows = [];
    for (i = 0; i < list.length; i++) {
      r = list[i];
      if (r.receivable > 0.004) { sumIn += r.receivable; cntIn++; }
      if (r.payable > 0.004) { sumOut += r.payable; cntOut++; }
      if (q && r.partner.toLowerCase().indexOf(q) < 0) continue;
      if (r.sale > 0 || r.received > 0 || r.receivable !== 0) inRows.push(r);
      if (r.purchase > 0 || r.paid > 0 || r.payable !== 0) outRows.push(r);
    }
    function byLeft(k) {
      return function (a, b) {
        var d = Math.abs(Number(b[k]) || 0) - Math.abs(Number(a[k]) || 0);
        if (d) return d;
        return String(a.partner).localeCompare(String(b.partner), 'ko');
      };
    }
    inRows.sort(byLeft('receivable'));
    outRows.sort(byLeft('payable'));
    var tIn = { sale: 0, received: 0, receivable: 0 }, tOut = { purchase: 0, paid: 0, payable: 0 };
    for (i = 0; i < inRows.length; i++) { tIn.sale += inRows[i].sale; tIn.received += inRows[i].received; tIn.receivable += inRows[i].receivable; }
    for (i = 0; i < outRows.length; i++) { tOut.purchase += outRows[i].purchase; tOut.paid += outRows[i].paid; tOut.payable += outRows[i].payable; }
    setAccSum('받을돈 ' + fmtInt(sumIn) + '원 · 줄돈 ' + fmtInt(sumOut) + '원');

    var html = [];
    html.push('<div class="stlsum">' +
      '<div class="stlbox in"><span>📥 받을돈 합계</span><b id="stlSumIn">' + fmtInt(sumIn) + '원</b><small>거래처 ' + cntIn + '곳의 남은 미수금</small></div>' +
      '<div class="stlbox out"><span>📤 줄돈 합계</span><b id="stlSumOut">' + fmtInt(sumOut) + '원</b><small>거래처 ' + cntOut + '곳의 남은 미지급금</small></div>' +
      '<div class="stlbox net"><span>⚖️ 받을돈 − 줄돈</span><b id="stlSumNet">' + fmtInt(sumIn - sumOut) + '원</b><small>양수면 받을 돈이 더 많습니다</small></div>' +
      '</div>');

    html.push('<section class="stlsec in" id="stlInSec">' +
      '<div class="stlhead"><h3>📥 받을돈 (미수금)</h3>' +
      '<span class="hint">거래처별 <b>총 매출 − 받은 돈</b>입니다. 줄마다 <b>수금 금액</b>을 적고 <b>[수금 저장]</b>을 누르면 그 자리에서 수금이 기록되고 남은 받을돈·회계 KPI가 바로 줄어듭니다.</span></div>');
    if (!inRows.length) html.push('<div class="stlempty">받을돈이 없습니다. 판매관리에서 매출 전표를 넣으면 여기에 모입니다.</div>');
    else html.push(stlTableHtml('in', inRows, tIn));
    html.push('</section>');

    html.push('<section class="stlsec out" id="stlOutSec">' +
      '<div class="stlhead"><h3>📤 줄돈 (미지급금)</h3>' +
      '<span class="hint">거래처별 <b>총 매입 − 보낸 돈</b>입니다. 줄마다 <b>지급 금액</b>을 적고 <b>[지급 저장]</b>을 누르면 그 자리에서 지급이 기록되고 남은 줄돈·회계 KPI가 바로 줄어듭니다.</span></div>');
    if (!outRows.length) html.push('<div class="stlempty">줄돈이 없습니다. 구매관리에서 매입 전표를 넣으면 여기에 모입니다.</div>');
    else html.push(stlTableHtml('out', outRows, tOut));
    html.push('</section>');

    var recent = [], p;
    for (i = 0; i < st.payments.length; i++) {
      p = st.payments[i];
      if (!ERP.inPeriod(p.d, cur.accRange.from, cur.accRange.to)) continue;
      if (q && String(p.partner || '').toLowerCase().indexOf(q) < 0) continue;
      recent.push(p);
    }
    recent.sort(function (a, b) { return a.d < b.d ? 1 : (a.d > b.d ? -1 : (b.id - a.id)); });
    html.push('<section class="stlsec rec" id="stlRecSec">' +
      '<div class="stlhead"><h3>💵 최근 수금·지급 내역</h3>' +
      '<span class="hint">방금 저장한 건이 맨 위에 나옵니다. <b>[삭제]</b>하면 그 거래처의 남은 받을돈·줄돈이 다시 늘어납니다. (기간·검색이 적용됩니다)</span></div>');
    if (!recent.length) html.push('<div class="stlempty">수금·지급 기록이 없습니다.</div>');
    else {
      html.push('<div class="stlwrap"><table class="stltbl t-rec" id="stlRecTbl">' +
        '<colgroup><col style="width:114px"><col style="width:78px"><col><col style="width:126px">' +
        '<col style="width:104px"><col><col style="width:74px"></colgroup>' +
        '<thead><tr>' +
        '<th>날짜</th><th>구분</th><th class="stlp">거래처</th><th class="num">금액</th><th>수단</th><th>메모</th><th></th>' +
        '</tr></thead><tbody>');
      var shown = recent.length > STL_LIMIT ? recent.slice(0, STL_LIMIT) : recent;
      for (i = 0; i < shown.length; i++) {
        p = shown[i];
        html.push('<tr class="stlrec" data-payrow="' + p.id + '">' +
          '<td>' + esc(p.d) + '</td>' +
          '<td><span class="badge ' + (p.t === 'in' ? 'in' : 'out') + '">' + (p.t === 'in' ? '수금' : '지급') + '</span></td>' +
          '<td class="stlp ellip"><b>' + esc(p.partner) + '</b></td>' +
          '<td class="num"><b>' + fmtInt(p.amount) + '</b></td>' +
          '<td>' + esc(p.method || '-') + '</td>' +
          '<td class="ellip">' + esc(p.note || '-') + '</td>' +
          '<td class="stlgo"><button class="cancel" type="button" data-pdel="' + p.id + '">삭제</button></td></tr>');
      }
      html.push('</tbody></table></div>');
      if (recent.length > STL_LIMIT) html.push('<div class="stlmore">최근 ' + STL_LIMIT + '건만 보입니다. (전체 ' + recent.length + '건)</div>');
    }
    html.push('</section>');
    wrap.innerHTML = html.join('');
    stlFocusRestore(focus);
  }
  function stlRowOf(el) { return el && el.closest ? el.closest('tr[data-stl]') : null; }
  /* 같은 줄의 남은 받을돈·줄돈 칸을 입력한 금액만큼 미리 줄여 보여 준다 */
  function stlPreview(tr, t, partner) {
    if (!tr) return;
    var leftEl = tr.querySelector('.stlleft'), amtEl = tr.querySelector('[data-amt]');
    if (!leftEl || !amtEl) return;
    var base = stlRemainOf(t, partner);
    var n = Number(amtEl.value || 0) || 0;
    leftEl.textContent = fmtInt(base - n);
    var td = leftEl.parentNode;
    if (td && td.className) td.className = stlLeftClass(t, base - n);
  }
  function stlFillAll(btn) {
    var tr = stlRowOf(btn);
    if (!tr) return;
    var t = tr.getAttribute('data-stl'), partner = tr.getAttribute('data-partner');
    var amtEl = tr.querySelector('[data-amt]');
    var left = stlRemainOf(t, partner);
    if (amtEl) amtEl.value = left > 0.004 ? String(left) : '';
    stlDraftSet(t, partner, { amt: amtEl ? amtEl.value : '' });
    stlPreview(tr, t, partner);
  }
  function stlSaveRow(btn) {
    var tr = stlRowOf(btn);
    if (!tr) return;
    var t = tr.getAttribute('data-stl'), partner = tr.getAttribute('data-partner');
    var amtEl = tr.querySelector('[data-amt]'), dateEl = tr.querySelector('[data-date]'), mEl = tr.querySelector('[data-method]');
    var amount = Math.round(Number((amtEl && amtEl.value) || 0));
    var date = (dateEl && dateEl.value) || today();
    var method = (mEl && mEl.value) || '계좌이체';
    if (!(amount > 0)) { toast('금액을 입력하세요.', 'err'); if (amtEl) { try { amtEl.focus(); } catch (e) { } } return; }
    var left = stlRemainOf(t, partner);
    if (left > 0.004 && amount > left) {
      if (!window.confirm('남은 ' + (t === 'out' ? '줄돈' : '받을돈') + ' ' + fmtInt(left) + '원보다 큰 금액입니다.\n' +
        fmtInt(amount) + '원으로 저장할까요?\n(선수금·선지급이면 남은 금액이 마이너스로 바뀝니다)')) return;
    }
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '저장 중…';
    SB.db.accPaymentSave({
      id: null, date: date, partner: partner, type: t, amount: amount, method: method, note: ''
    }).then(function () {
      btn.disabled = false; btn.textContent = label;
      delete cur.stlDraft[stlKey(t, partner)];
      toast((t === 'in' ? '수금' : '지급') + ' 저장: ' + partner + ' ' + won(amount), 'ok');
      return reload({ silent: true });
    }, function (e) {
      btn.disabled = false; btn.textContent = label;
      toast(e.message, 'err');
    });
  }
  /* 받을돈·줄돈 표 클릭 — 전액 채우기 / 바로 저장 (return true면 처리됨) */
  function settleClick(t) {
    var allBtn = t.closest ? t.closest('[data-settle-all]') : null;
    if (allBtn) { stlFillAll(allBtn); return true; }
    var saveBtn = t.closest ? t.closest('[data-settle-save]') : null;
    if (saveBtn) { stlSaveRow(saveBtn); return true; }
    return false;
  }
  /* 받을돈·줄돈 표 입력 — 적은 값을 기억해 두고 남은 금액을 미리 보여 준다 */
  function settleInput(ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var tr = stlRowOf(t);
    if (!tr) return;
    var ty = tr.getAttribute('data-stl'), partner = tr.getAttribute('data-partner');
    var patch = {};
    if (t.hasAttribute('data-amt')) patch.amt = t.value;
    else if (t.hasAttribute('data-date')) patch.date = t.value;
    else if (t.hasAttribute('data-method')) patch.method = t.value;
    else return;
    stlDraftSet(ty, partner, patch);
    if (patch.amt !== undefined) stlPreview(tr, ty, partner);
  }
  function renderAccTable() {
    if (!$('accTableWrap')) return;
    var tab = cur.accTab;
    var isV = tab === 'V', isR = tab === 'R', isE = tab === 'E', isS = tab === 'S';
    $('accTypeFilter').classList.toggle('hidden', isR || isS || tab === 'M');
    $('accTypeFilter').innerHTML = isE
      ? '<option value="all">전체 구분</option><option value="expense">경비</option><option value="income">수입</option>'
      : '<option value="all">전체 구분</option><option value="sale">매출</option><option value="purchase">매입</option>';
    if (cur.accType !== 'all' && (isR || isS || tab === 'M')) cur.accType = 'all';
    $('accTypeFilter').value = cur.accType;
    var anyF = hasCols(cur.fAccV) || hasCols(cur.fAccE);
    $('btnAccResetFilters').classList.toggle('hidden', !anyF);
    $('accNoteBar').textContent = isS
      ? '받을돈·줄돈은 기간과 상관없이 지금 남은 금액입니다. 검색은 거래처 이름에, 기간은 맨 아래 최근 수금·지급 내역에 적용됩니다.'
      : (isR
        ? '거래처별로 매출·수금·미수, 매입·지급·미지급을 모아 보여줍니다. [수금]·[지급]을 누르면 바로 등록됩니다.'
        : (tab === 'M' ? '월별 매출 − 매입원가 − 일반경비 = 순이익입니다. (부가세 제외, 공급가액 기준)'
          : '기간·검색은 전표·원장·경비·손익 표에 함께 적용됩니다.'));
    if (isS) { renderAccSettle(); return; }
    if (isV) { renderAccVouchers(); return; }
    if (isR) { renderAccLedger(); return; }
    if (isE) { renderAccExpenses(); return; }
    renderAccMonths();
  }

  /* ---------- 입출고 → 전표 일괄 반영 ---------- */
  /* 자체생산 완제품 입고인가 — 사내 생산 이동이라 매입 전표에서 뺄다(원가·매입 이중집계 방지) */
  function fpSelfMade(g) {
    if (!g || g.t !== 'IN') return false;
    if (isSelfSrc(g.p)) return true;
    return String(g.note || '').indexOf('[자체생산]') >= 0;
  }
  function reflectCandidates() {
    var out = [], i, e, g, selfMade = 0, siteUse = 0;
    var from = cur.accRange.from || '', to = cur.accRange.to || '';
    var done = {};
    for (i = 0; i < st.vouchers.length; i++) {
      var v = st.vouchers[i];
      if (v.srcId !== null && v.srcId !== undefined) done[v.srcKind + ':' + v.srcId] = 1;
    }
    for (i = 0; i < st.logs.length; i++) {
      e = st.logs[i];
      /* 회계로 넘기는 원료육 이력은 입고(매입)와 업체 등 판매 출고만 */
      if (e.t !== 'in' && !(e.t === 'out' && ERP.destKey(e.dt) !== 'site')) continue;
      if (!(Number(e.amt) > 0)) continue;
      if (!ERP.inPeriod(e.d, from, to)) continue;
      if (done['meat:' + e.dbid]) continue;
      out.push({
        kind: 'meat', id: e.dbid, d: e.d, type: e.t === 'in' ? 'purchase' : 'sale',
        partner: e.t === 'in' ? e.v : (e.p || ''), label: e.n + ' ' + fmt(e.k) + 'kg',
        amt: Number(e.amt) || 0
      });
    }
    for (i = 0; i < st.fpLogs.length; i++) {
      g = st.fpLogs[i];
      if (g.undone) continue;
      if (!(Number(g.amt) > 0)) continue;
      if (!ERP.inPeriod(g.d, from, to)) continue;
      if (done['fp:' + g.id]) continue;
      if (fpSelfMade(g)) { selfMade++; continue; }
      if (ERP.isFpSiteUse(g)) { siteUse++; continue; }
      out.push({
        kind: 'fp', id: g.id, d: g.d, type: g.t === 'IN' ? 'purchase' : 'sale',
        partner: g.p || '', label: g.n + ' ' + fmtQty(g.q) + (g.unit || ''),
        amt: Number(g.amt) || 0
      });
    }
    out.sort(function (a, b) { return a.d < b.d ? 1 : (a.d > b.d ? -1 : 0); });
    out.selfMade = selfMade;
    out.siteUse = siteUse;
    return out;
  }
  function renderAccReflect() {
    var box = $('accReflectList');
    if (!box) return;
    var list = reflectCandidates();
    var selfMade = list.selfMade || 0;
    if (cur.reflectMode === 'purchase' || cur.reflectMode === 'sale') {
      var want = cur.reflectMode === 'purchase' ? 'purchase' : 'sale';
      var keep = [];
      for (var q = 0; q < list.length; q++) if (list[q].type === want) keep.push(list[q]);
      list = keep;
    }
    if ($('accReflectFrom') && !$('accReflectFrom').value) $('accReflectFrom').value = today().slice(0, 8) + '01';
    if ($('accReflectTo') && !$('accReflectTo').value) $('accReflectTo').value = today();
    if (!list.length) {
      box.innerHTML = '<div class="rempty">가져올 입출고가 없습니다. (금액이 입력된 입고·출고만 전표가 됩니다. 기간을 넓혀 보세요.)' +
        (selfMade ? '<br>🏭 자체생산 완제품 입고 ' + selfMade + '건은 사내 생산 이동이라 자동 제외했습니다.' : '') + '</div>';
      return;
    }
    var html = ['<div class="reflect-row head"><span class="chk"></span><span>날짜</span><span>구분</span><span>거래처</span><span>품목</span><span class="num">금액</span></div>'];
    if (selfMade && cur.reflectMode !== 'sale') html.push('<div class="rempty">🏭 자체생산 완제품 입고 <b>' + selfMade + '건</b>은 사내 생산 이동이라 목록에서 자동 제외했습니다.</div>');
    for (var i = 0; i < Math.min(200, list.length); i++) {
      var c = list[i];
      html.push('<label class="reflect-row"><input type="checkbox" data-reflect="' + c.kind + ':' + c.id + '"' +
        (cur.reflectSel[c.kind + ':' + c.id] ? ' checked' : '') + '>' +
        '<span>' + esc(c.d) + '</span>' +
        '<span><span class="src-tag ' + esc(c.kind) + '">' + (c.kind === 'meat' ? '원료육' : '완제품') + '</span> ' +
        (c.type === 'sale' ? '매출' : '매입') + '</span>' +
        '<span class="ellip">' + esc(c.partner || '거래처 미입력') + '</span>' +
        '<span class="ellip">' + esc(c.label) + '</span>' +
        '<span class="num">' + fmtInt(c.amt) + '</span></label>');
    }
    if (list.length > 200) html.push('<div class="rempty">… 외 ' + (list.length - 200) + '건 (기간을 좁히면 모두 볼 수 있습니다)</div>');
    box.innerHTML = html.join('');
  }
  function openReflect(mode) {
    cur.reflectMode = mode || 'all';
    cur.reflectOpen = true;
    cur.reflectSel = {};
    if ($('reflectTitle')) {
      $('reflectTitle').textContent = cur.reflectMode === 'purchase' ? '⚡ 미반영 입고 가져오기'
        : (cur.reflectMode === 'sale' ? '⚡ 미반영 판매출고 가져오기' : '⚡ 미반영 입출고 가져오기');
    }
    if ($('reflectSub')) {
      $('reflectSub').textContent = cur.reflectMode === 'purchase'
        ? '금액이 있는 입고(원료육·완제품 외부매입)를 골라 매입 전표로 넘깁니다. 자체생산 입고는 자동 제외됩니다.'
        : (cur.reflectMode === 'sale'
          ? '금액이 있는 판매 출고(업체·택배·기타)를 골라 매출 전표로 넘깁니다. 현장 출고는 자동 제외됩니다.'
          : '금액이 있는 입출고를 골라 매입·매출 전표로 한 번에 넘깁니다. 이미 전표가 있는 건은 다시 들어가지 않습니다.');
    }
    var m = $('reflectModal');
    if (m) m.classList.remove('hidden');
    renderAccReflect();
  }
  function closeReflect() {
    cur.reflectOpen = false;
    var m = $('reflectModal');
    if (m) m.classList.add('hidden');
  }
  function toggleReflect(kind, id, on) {
    var k = kind + ':' + id;
    if (on) cur.reflectSel[k] = 1; else delete cur.reflectSel[k];
  }
  function accReflectGo() {
    var items = [], k, parts;
    for (k in cur.reflectSel) {
      if (!Object.prototype.hasOwnProperty.call(cur.reflectSel, k)) continue;
      if (!cur.reflectSel[k]) continue;
      parts = k.split(':');
      items.push({ kind: parts[0], id: Number(parts[1]) });
    }
    if (!items.length) { toast('반영할 줄을 먼저 체크하세요.', 'warn'); return; }
    var b = $('accReflectGo');
    b.disabled = true; b.textContent = '반영 중…';
    SB.db.accReflect(items, $('accReflectTax').value || 'auto').then(function (res) {
      b.disabled = false; b.textContent = '선택 반영';
      var msg = '전표 ' + (res.ok || 0) + '건 반영';
      if (res.skip) msg += ' · 이미 반영 ' + res.skip + '건';
      if (res.zero) msg += ' · 금액 없음 ' + res.zero + '건';
      if (res.miss) msg += ' · 찾을 수 없음 ' + res.miss + '건';
      toast(msg, res.ok ? 'ok' : 'warn');
      cur.reflectSel = {};
      closeReflect();
      return reload({ silent: true });
    }, function (e) {
      b.disabled = false; b.textContent = '선택 반영';
      toast(e.message, 'err');
    });
  }

  /* ==========================================================================
     v10 — 명세서형 다중 품목 매입·매출 전표 입력창
       · 상단 공통: 전표 종류 · 전표일자 · 거래처 · 세금계산서 · 비고
       · 가운데 명세서 표: 구분(원료육 / 완제품·부자재 / 기타) · 창고/로트 · 품목명 ·
         소비기한/규격 · 수량(kg/개) · 단가(원) · 과세 · 공급가액 · 세액 · 합계
         (기본 3줄 · ＋ 줄 추가 · × 줄 삭제 · 아래 합계 줄은 실시간 합산)
       · 저장: 줄마다 재고 입·출고(tx_apply / fp_tx_apply)
               → acc_reflect 로 그 재고 이력에 묶인 전표(줄마다 1건 · source_kind+source_id 중복 방지)
               → 같은 거래에서 적은 줄들이 한 장의 2부 거래명세표(openStmt)에 그대로 찍힌다
       · 기존 전표를 고칠 때는 예전처럼 단일 전표 화면(재고는 건드리지 않는다)
     ========================================================================== */
  var accV = { id: null, type: 'sale', mode: '', rows: [], seq: 0 };
  var ACCV_ROWS_MAX = 30;
  function trimV(v) { return String(v === null || v === undefined ? '' : v).replace(/^\s+|\s+$/g, ''); }
  function accVIsBuy() { return accV.type === 'purchase'; }
  function accVKindName(k) { return k === 'fp' ? '완제품·부자재' : (k === 'etc' ? '기타' : '원료육'); }
  function accVKindTax(k) { return k === 'meat' ? 'free' : 'tax'; }
  function accVRow(i) { return accV.rows[i] || null; }

  /* ---------- 줄(행) 모델 ---------- */
  function accVNewRow(kind) {
    accV.seq += 1;
    kind = (kind === 'fp' || kind === 'etc') ? kind : 'meat';
    return {
      key: accV.seq, kind: kind, wh: 'F', lotId: null, lotWh: '', code: '',
      name: '', meat: '', origin: '', brand: '', expiry: '', spec: '',
      qty: '', price: '', tax: accVKindTax(kind)
    };
  }
  function accVResetRows(n) {
    accV.rows = [];
    for (var i = 0; i < (n || 3); i++) accV.rows.push(accVNewRow('meat'));
  }
  /* 수량 × 단가 = 공급가액 · 과세면 세액 10% · 합계 */
  function accVRowNums(r) {
    var qty = Number(r && r.qty || 0), price = Number(r && r.price || 0);
    var supply = 0;
    if (qty > 0 && price > 0) supply = Math.round(qty * price);
    else if (r && r.kind === 'etc' && price > 0) supply = Math.round(price);
    var vat = (r && r.tax === 'tax') ? Math.round(supply * ERP.VAT_RATE * 100) / 100 : 0;
    return { qty: qty > 0 ? qty : 0, price: price, supply: supply, vat: vat, total: supply + vat };
  }

  /* ---------- 후보(자동완성) ---------- */
  /* 원료육 품목 — 로트·이력에서 육류·원산지·브랜드·최근 단가·소비기한 기본값을 모은다 */
  function accVMeatMeta(name) {
    var q = trimV(name), i, L, m = null;
    if (!q) return null;
    for (i = 0; i < st.lots.length; i++) {
      L = st.lots[i];
      if (trimV(L.n) !== q) continue;
      if (!m) m = { mt: '', o: '', b: '', price: 0, e: '' };
      if (!m.mt && L.mt) m.mt = L.mt;
      if (!m.o && L.o) m.o = L.o;
      if (!m.b && L.b) m.b = L.b;
      if (!(m.price > 0) && Number(L.price) > 0) m.price = Number(L.price);
      if ((L.e || '') > (m.e || '')) m.e = L.e || '';
    }
    return m;
  }
  function accVMeatProductCands() {
    return acCached('vmeatprod', function () {
      var map = {}, out = [], i, L, m, k;
      for (i = 0; i < st.lots.length; i++) {
        L = st.lots[i];
        k = trimV(L.n);
        if (!k) continue;
        if (!map[k]) {
          m = { v: k, t: k, h: [k, L.mt, L.o, L.b].join(' '), mt: '', o: '', b: '', price: 0, e: '' };
          map[k] = m; out.push(m);
        }
        m = map[k];
        if (!m.mt && L.mt) m.mt = L.mt;
        if (!m.o && L.o) m.o = L.o;
        if (!m.b && L.b) m.b = L.b;
        if (!(m.price > 0) && Number(L.price) > 0) m.price = Number(L.price);
        if ((L.e || '') > (m.e || '')) m.e = L.e || '';
      }
      for (i = 0; i < out.length; i++) {
        out[i].s = [out[i].mt, out[i].o, out[i].b,
          out[i].price > 0 ? fmtInt(out[i].price) + '원/kg' : ''].filter(function (x) { return !!x; }).join(' · ');
      }
      return out;
    });
  }
  /* 매출 — 지금 재고가 있는 원료육 로트(창고별). 소비기한이 빠른 순 */
  function accVLotCands() {
    var out = [], i, w, L, q, wh;
    for (i = 0; i < st.lots.length; i++) {
      L = st.lots[i];
      for (w = 0; w < 2; w++) {
        wh = w === 0 ? 'F' : 'C';
        q = wh === 'F' ? L.fq : L.cq;
        if (!(q > ERP.EPS)) continue;
        out.push({
          v: L.n, t: L.n,
          h: [L.n, L.mt, L.o, L.b, L.e, wh === 'F' ? '냉동고' : '냉장고'].join(' '),
          s: (wh === 'F' ? '🧊 냉동 ' : '❄️ 냉장 ') + fmtQty(q) + 'kg' +
            (L.e ? ' · ~' + L.e : '') + (L.price > 0 ? ' · ' + fmtInt(L.price) + '원/kg' : ''),
          lot: L, wh: wh
        });
      }
    }
    out.sort(function (a, b) {
      var ae = a.lot.e || '9999-99-99', be = b.lot.e || '9999-99-99';
      if (ae !== be) return ae < be ? -1 : 1;
      return a.lot.n < b.lot.n ? -1 : (a.lot.n > b.lot.n ? 1 : 0);
    });
    return out;
  }
  /* 창고/로트 칸의 로트 목록 (매출) */
  function accVLotList() {
    return acCached('vlotlist', function () {
      var out = [], i, w, L, q, wh;
      for (i = 0; i < st.lots.length; i++) {
        L = st.lots[i];
        for (w = 0; w < 2; w++) {
          wh = w === 0 ? 'F' : 'C';
          q = wh === 'F' ? L.fq : L.cq;
          if (!(q > ERP.EPS)) continue;
          out.push({
            id: Number(L.dbid), wh: wh, lot: L, q: q,
            label: (wh === 'F' ? '냉동' : '냉장') + ' · ' + L.n + (L.e ? ' · ~' + L.e : '') + ' · ' + fmtQty(q) + 'kg'
          });
        }
      }
      out.sort(function (a, b) {
        var ae = a.lot.e || '9999-99-99', be = b.lot.e || '9999-99-99';
        if (ae !== be) return ae < be ? -1 : 1;
        return a.lot.n < b.lot.n ? -1 : (a.lot.n > b.lot.n ? 1 : 0);
      });
      return out;
    });
  }
  function accVLotOf(r) {
    if (!r || !(Number(r.lotId) > 0)) return null;
    for (var i = 0; i < st.lots.length; i++) {
      if (Number(st.lots[i].dbid) === Number(r.lotId)) {
        return { lot: st.lots[i], wh: r.lotWh === 'C' ? 'C' : 'F' };
      }
    }
    return null;
  }
  function accVResolveLot(r) {
    var pk = accVLotOf(r);
    if (pk) return pk;
    var q = trimV(r && r.name);
    if (!q) return null;
    var hit = ERP.smartPick(accVLotCands(), q, 1);
    return hit.length ? { lot: hit[0].lot, wh: hit[0].wh } : null;
  }
  /* 완제품·부자재 — 코드 또는 상품명으로 찾는다 */
  function accVRowProduct(r) {
    if (!r) return null;
    var q = trimV(r.name);
    if (r.code) {
      var p0 = ERP.fpProductOf(st.fps, r.code);
      if (p0) return p0;
    }
    if (!q) return null;
    var p = ERP.fpFind(st.fps, q);
    if (p) return p;
    var parts = q.split('·'), i;
    for (i = 0; i < parts.length; i++) {
      p = ERP.fpFind(st.fps, parts[i]);
      if (p) return p;
    }
    return null;
  }
  function accVNameCands(r) {
    if (!r) return [];
    if (r.kind === 'fp') return acFgCands();
    if (r.kind === 'meat') return accVIsBuy() ? accVMeatProductCands() : accVLotCands();
    return [];
  }

  /* ---------- 명세서 표 그리기 ---------- */
  function accVOpts(field, cur, list) {
    var h = ['<select data-f="' + field + '">'], i, o;
    for (i = 0; i < list.length; i++) {
      o = list[i];
      h.push('<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(cur === null || cur === undefined ? '' : cur) ? ' selected' : '') +
        '>' + esc(o[1]) + '</option>');
    }
    h.push('</select>');
    return h.join('');
  }
  /* 창고/로트 칸 — 입력칸(창고 select · 로트 select)은 그대로 두고 안내 글만 따로 그린다 */
  function accVLotInfoHtml(r) {
    if (r.kind === 'meat') {
      if (accVIsBuy()) return '';
      var n = accVLotList().length;
      return n ? '' : '<span class="vlotstock">보유 로트가 없습니다</span>';
    }
    if (r.kind === 'fp') {
      var p = accVRowProduct(r);
      return '<span class="vlotro">완제품창고</span>' +
        '<span class="vlotstock">' + (p ? '현재고 ' + fmtQty(p.stock) + esc(p.unit) : '품목을 고르면 현재고') + '</span>';
    }
    return '<span class="vlotro muted">재고 없음</span><span class="vlotstock">전표만</span>';
  }
  function accVLotCellHtml(r) {
    var i, opts;
    if (r.kind === 'meat') {
      if (accVIsBuy()) return accVOpts('wh', r.wh, [['F', '🧊 냉동고'], ['C', '❄️ 냉장고']]);
      var list = accVLotList();
      opts = [['', '로트 선택']];
      for (i = 0; i < list.length; i++) opts.push([String(list[i].id) + '|' + list[i].wh, list[i].label]);
      return accVOpts('lot', r.lotId ? String(r.lotId) + '|' + (r.lotWh || 'F') : '', opts) +
        '<div data-cell="lotro">' + accVLotInfoHtml(r) + '</div>';
    }
    return '<div data-cell="lotro">' + accVLotInfoHtml(r) + '</div>';
  }
  function accVNameCellHtml(r) {
    var ph = r.kind === 'fp' ? '예: 떡갈비 / W00100016'
      : (r.kind === 'meat' ? (accVIsBuy() ? '예: 등갈비' : '예: 등갈비 (보유 로트)') : '예: 운송비');
    var meta = r.kind === 'meat' ? [r.meat, r.origin, r.brand].filter(function (x) { return !!x; }).join(' · ') : '';
    return '<input data-f="name" class="vnamein" value="' + esc(r.name) + '" placeholder="' + esc(ph) + '" autocomplete="off">' +
      '<span class="vrowmeta" data-cell="meta">' + esc(meta) + '</span>';
  }
  function accVExpInfoHtml(r) {
    if (r.kind === 'meat') {
      var pk = accVLotOf(r);
      return '<span class="vlotro">' + (pk ? esc(pk.lot.e || '—') : '—') + '</span>' +
        '<span class="vlotstock">' + (pk ? (pk.wh === 'F' ? '냉동고' : '냉장고') + ' 재고 ' + fmtQty(pk.wh === 'F' ? pk.lot.fq : pk.lot.cq) + 'kg'
          : (accVIsBuy() ? '소비기한' : '로트를 고르세요')) + '</span>';
    }
    if (r.kind === 'fp') {
      var p = accVRowProduct(r);
      return '<span class="vlotro">' + esc(p ? (p.spec || '—') : '—') + '</span>' +
        '<span class="vlotstock">' + (p ? '단위 ' + esc(p.unit) : '규격') + '</span>';
    }
    return '<span class="vlotro muted">—</span>';
  }
  function accVExpCellHtml(r) {
    if (r.kind === 'meat' && accVIsBuy()) {
      return '<input type="date" data-f="expiry" value="' + esc(r.expiry) + '" title="소비기한">';
    }
    return '<div data-cell="exp">' + accVExpInfoHtml(r) + '</div>';
  }
  function accVRowHtml(r, i) {
    var n = accVRowNums(r);
    return '<tr data-r="' + i + '" data-kind="' + esc(r.kind) + '">' +
      '<td class="c">' + accVOpts('kind', r.kind, [['meat', '원료육'], ['fp', '완제품·부자재'], ['etc', '기타']]) + '</td>' +
      '<td>' + accVLotCellHtml(r) + '</td>' +
      '<td>' + accVNameCellHtml(r) + '</td>' +
      '<td>' + accVExpCellHtml(r) + '</td>' +
      '<td class="r"><input type="number" data-f="qty" step="0.001" min="0" value="' + esc(r.qty) + '" placeholder="0"></td>' +
      '<td class="r"><input type="number" data-f="price" step="1" min="0" value="' + esc(r.price) + '" placeholder="0"></td>' +
      '<td class="c">' + accVOpts('tax', r.tax, [['tax', '과세'], ['free', '면세']]) + '</td>' +
      '<td class="r num" data-num="supply">' + (n.supply ? fmtInt(n.supply) : '') + '</td>' +
      '<td class="r num" data-num="vat">' + (n.vat ? fmtInt(n.vat) : '') + '</td>' +
      '<td class="r num b" data-num="total">' + (n.total ? fmtInt(n.total) : '') + '</td>' +
      '<td class="c"><button type="button" class="vdel" data-delrow="' + i + '" aria-label="줄 삭제" title="줄 삭제">×</button></td>' +
      '</tr>';
  }
  /* 입력칸은 그대로 두고 안내 글(육류·원산지·브랜드 · 소비기한 · 현재고)과 빈 단가만 채운다 */
  function accVRowRefresh(i) {
    var r = accVRow(i);
    var tr = document.querySelector('#accVSheetBody tr[data-r="' + i + '"]');
    if (!r || !tr) return;
    var ni = tr.querySelector('[data-f="name"]');
    if (ni && ni.value !== r.name && (document.activeElement !== ni)) ni.value = r.name;
    var meta = tr.querySelector('[data-cell="meta"]');
    if (meta) meta.textContent = r.kind === 'meat' ? [r.meat, r.origin, r.brand].filter(function (x) { return !!x; }).join(' · ') : '';
    var lc = tr.querySelector('[data-cell="lotro"]');
    if (lc) lc.innerHTML = accVLotInfoHtml(r);
    var ec = tr.querySelector('[data-cell="exp"]');
    if (ec) ec.innerHTML = accVExpInfoHtml(r);
    var ei = tr.querySelector('[data-f="expiry"]');
    if (ei && !ei.value && r.expiry) ei.value = r.expiry;
    var pi = tr.querySelector('[data-f="price"]');
    if (pi && !pi.value && r.price !== '' && r.price !== null && r.price !== undefined) pi.value = r.price;
    var ls = tr.querySelector('[data-f="lot"]');
    if (ls && r.lotId) {
      var v = String(r.lotId) + '|' + (r.lotWh || 'F'), found = false;
      for (var k = 0; k < ls.options.length; k++) if (ls.options[k].value === v) { found = true; break; }
      if (found) ls.value = v;
    }
    accVSheetPaint();
  }
  function accVSheetPaint() {
    var sumQ = 0, sumS = 0, sumV = 0, sumT = 0, i, r, n, tr, cell;
    for (i = 0; i < accV.rows.length; i++) {
      r = accV.rows[i]; n = accVRowNums(r);
      tr = document.querySelector('#accVSheetBody tr[data-r="' + i + '"]');
      if (tr) {
        cell = tr.querySelector('[data-num="supply"]'); if (cell) cell.textContent = n.supply ? fmtInt(n.supply) : '';
        cell = tr.querySelector('[data-num="vat"]'); if (cell) cell.textContent = n.vat ? fmtInt(n.vat) : '';
        cell = tr.querySelector('[data-num="total"]'); if (cell) cell.textContent = n.total ? fmtInt(n.total) : '';
      }
      sumQ += n.qty; sumS += n.supply; sumV += n.vat; sumT += n.total;
    }
    var saveBtn = $('accVoucherSave');
    if (saveBtn && !saveBtn.disabled) {
      var lab = accVSaveLabel();
      if (saveBtn.textContent !== lab) saveBtn.textContent = lab;
    }
    if ($('accVSumQty')) $('accVSumQty').textContent = sumQ ? fmtQty(sumQ) : '0';
    if ($('accVSumSupply')) $('accVSumSupply').textContent = fmtInt(sumS);
    if ($('accVSumVat')) $('accVSumVat').textContent = fmtInt(sumV);
    if ($('accVSumTotal')) $('accVSumTotal').textContent = fmtInt(sumT);
  }
  function accVRowBind(i) {
    var tr = document.querySelector('#accVSheetBody tr[data-r="' + i + '"]');
    if (!tr) return;
    var r = accVRow(i), inp = tr.querySelector('[data-f="name"]');
    if (!r || !inp) return;
    acWire(inp, function () { return accVNameCands(r); }, function (it) { accVPickItem(i, it); });
  }
  function accVBindAll() {
    for (var i = 0; i < accV.rows.length; i++) accVRowBind(i);
  }
  function accVSheetRender() {
    var body = $('accVSheetBody');
    if (!body) return;
    var h = [], i;
    for (i = 0; i < accV.rows.length; i++) h.push(accVRowHtml(accV.rows[i], i));
    body.innerHTML = h.join('');
    accVBindAll();
    accVSheetPaint();
  }
  function accVRowRepaint(i) {
    var tr = document.querySelector('#accVSheetBody tr[data-r="' + i + '"]');
    if (!tr || !accVRow(i)) return;
    tr.outerHTML = accVRowHtml(accV.rows[i], i);
    accVRowBind(i);
    accVSheetPaint();
  }
  /* 품목명·로트를 고르면 육류·원산지·브랜드·단가·소비기한 기본값을 채운다 */
  function accVPickItem(i, it) {
    var r = accVRow(i);
    if (!r || !it) return;
    if (r.kind === 'fp') {
      var p = it.p || ERP.fpFind(st.fps, it.v);
      if (p) {
        r.code = p.code; r.name = p.n; r.spec = p.spec || '';
        var pr = accVIsBuy() ? p.inp : p.outp;
        if (!(Number(r.price) > 0) && pr > 0) r.price = String(Math.round(pr));
      } else { r.name = it.v; }
    } else if (r.kind === 'meat') {
      if (!accVIsBuy() && it.lot) {
        r.lotId = it.lot.dbid; r.lotWh = it.wh; r.name = it.lot.n;
        if (!(Number(r.price) > 0) && it.lot.price > 0) r.price = String(Math.round(it.lot.price));
      } else {
        r.name = it.v;
        var m = accVMeatMeta(it.v);
        if (m) {
          if (!r.meat && m.mt) r.meat = m.mt;
          if (!r.origin && m.o) r.origin = m.o;
          if (!r.brand && m.b) r.brand = m.b;
          if (!(Number(r.price) > 0) && m.price > 0) r.price = String(Math.round(m.price));
          if (!r.expiry && m.e) r.expiry = m.e;
        }
      }
    } else { r.name = it.v; }
    accVRowRefresh(i);
  }
  /* 품목명을 직접 치고 칸을 나올 때 — 아는 품목이면 같은 자동 채움 */
  function accVRowResolve(i) {
    var r = accVRow(i);
    if (!r) return;
    var q = trimV(r.name);
    if (!q) return;
    if (r.kind === 'fp') {
      var p = accVRowProduct(r);
      if (p) {
        r.code = p.code; r.name = p.n; r.spec = p.spec || '';
        if (!(Number(r.price) > 0)) {
          var pr = accVIsBuy() ? p.inp : p.outp;
          if (pr > 0) r.price = String(Math.round(pr));
        }
      }
    } else if (r.kind === 'meat') {
      if (!accVIsBuy() && !accVLotOf(r)) {
        var pk = accVResolveLot(r);
        if (pk) {
          r.lotId = pk.lot.dbid; r.lotWh = pk.wh;
          if (!(Number(r.price) > 0) && pk.lot.price > 0) r.price = String(Math.round(pk.lot.price));
        }
      } else {
        var m = accVMeatMeta(q);
        if (m) {
          if (!r.meat && m.mt) r.meat = m.mt;
          if (!r.origin && m.o) r.origin = m.o;
          if (!r.brand && m.b) r.brand = m.b;
          if (!(Number(r.price) > 0) && m.price > 0) r.price = String(Math.round(m.price));
          if (!r.expiry && m.e) r.expiry = m.e;
        }
      }
    }
    accVRowRefresh(i);
  }
  function accVRowDelete(i) {
    if (accV.rows.length <= 1) {
      accV.rows[0] = accVNewRow('meat');
    } else {
      accV.rows.splice(i, 1);
    }
    accVSheetRender();
  }
  function accVAddLine() {
    if (accV.rows.length >= ACCV_ROWS_MAX) { toast('한 번에 ' + ACCV_ROWS_MAX + '줄까지 입력할 수 있습니다.', 'warn'); return; }
    var last = accV.rows[accV.rows.length - 1];
    accV.rows.push(accVNewRow(last ? last.kind : 'meat'));
    accVSheetRender();
    var tr = document.querySelector('#accVSheetBody tr[data-r="' + (accV.rows.length - 1) + '"]');
    if (tr) { var inp = tr.querySelector('[data-f="name"]'); if (inp) { try { inp.focus(); } catch (e) { } } }
  }

  /* ---------- 저장 ---------- */
  function accVSaveLabel() {
    if (accV.id) return '저장';
    var rows = 0, i, r;
    for (i = 0; i < accV.rows.length; i++) {
      r = accV.rows[i];
      if (trimV(r.name) && (Number(r.qty) > 0)) rows += 1;
    }
    return rows > 1
      ? '저장 (재고 + ' + (accVIsBuy() ? '매입' : '매출') + ' 전표 ' + rows + '건)'
      : '저장 (재고 + ' + (accVIsBuy() ? '매입' : '매출') + ' 전표)';
  }
  function accVBusy(on) {
    var b = $('accVoucherSave');
    if (!b) return;
    b.disabled = !!on;
    b.textContent = on ? '저장 중…' : accVSaveLabel();
  }
  function accVMsg(text) {
    if ($('accVMsg')) $('accVMsg').textContent = text || '';
    if (text) toast(text, 'warn');
  }
  function accVLineSpec(L) {
    var r = L.row;
    if (L.kind === 'meat') {
      var pk = L.lot || accVLotOf(r);
      var wh = accVIsBuy() ? (r.wh === 'C' ? 'C' : 'F') : (pk ? pk.wh : '');
      return [wh ? ERP.whName(wh) : '', trimV(r.meat)].filter(function (x) { return !!x; }).join(' · ');
    }
    if (L.kind === 'fp') {
      var p = L.prod || accVRowProduct(r);
      return (p && p.spec) || r.spec || '';
    }
    return r.spec || '';
  }
  function accVLineUnit(L) {
    if (L.kind === 'meat') return 'kg';
    if (L.kind === 'fp') { var p = L.prod || accVRowProduct(L.row); return (p && p.unit) || '개'; }
    return '';
  }
  function accVLineLabel(L) {
    var u = accVLineUnit(L);
    return L.name + ' ' + fmtQty(L.qty) + u;
  }
  /* 입력한 줄을 검사하고 저장할 줄만 골라낸다 */
  function accVSheetLines() {
    var lines = [], i, r, name, qty, price, n, no;
    for (i = 0; i < accV.rows.length; i++) {
      r = accV.rows[i];
      name = trimV(r.name); qty = Number(r.qty || 0); price = Number(r.price || 0);
      if (!name && !trimV(r.qty) && !trimV(r.price)) continue;   /* 빈 줄은 건너뛴다 */
      no = (i + 1) + '번째 줄';
      if (!name && r.kind !== 'etc') return { err: no + ': 품목명을 입력하세요.' };
      if (r.kind === 'meat') {
        if (accVIsBuy()) {
          if (!r.expiry) return { err: no + ': 소비기한을 입력하세요. (원료육 입고는 재고 로트에 꼭 들어갑니다)' };
        } else {
          var pk = accVResolveLot(r);
          if (!pk) return { err: no + ': 출고할 원료육 로트를 고르세요. (재고가 있는 로트만 됩니다)' };
          var have = pk.wh === 'F' ? pk.lot.fq : pk.lot.cq;
          if (qty > have + ERP.EPS) {
            return { err: no + ': ' + (pk.wh === 'F' ? '냉동고' : '냉장고') + ' 재고(' + fmt(have) + 'kg)보다 많이 출고할 수 없습니다.' };
          }
        }
      } else if (r.kind === 'fp') {
        var p = accVRowProduct(r);
        if (!p) return { err: no + ': \'' + name + '\'을(를) 완제품·부자재에서 찾을 수 없습니다. (품목 등록 후 다시 입력하세요)' };
        if (!accVIsBuy() && qty > p.stock + 0.0004) {
          return { err: no + ': 현재고(' + fmtQty(p.stock) + p.unit + ')보다 많이 출고할 수 없습니다.' };
        }
      }
      if (r.kind === 'etc') {
        if (!(price > 0) && !(qty > 0 && price > 0)) return { err: no + ': 금액(단가)을 입력하세요.' };
        if (!name) { name = '기타'; r.name = name; }
      } else {
        if (!(qty > 0)) return { err: no + ': 수량(' + (r.kind === 'meat' ? 'kg' : '개') + ')을 입력하세요.' };
        if (!(price > 0)) return { err: no + ': 단가를 입력하세요. (전표 금액이 됩니다)' };
      }
      n = accVRowNums(r);
      if (!(n.supply > 0)) return { err: no + ': 공급가액이 0원입니다. 수량·단가를 확인하세요.' };
      lines.push({
        i: i, kind: r.kind, row: r, name: name, qty: qty, price: price, tax: r.tax,
        supply: n.supply, vat: n.vat, total: n.total,
        lot: r.kind === 'meat' ? accVResolveLot(r) : null,
        prod: r.kind === 'fp' ? accVRowProduct(r) : null
      });
    }
    if (!lines.length) return { err: '명세서에 품목을 한 줄 이상 입력하세요.' };
    return { lines: lines };
  }
  function accVStockMeat(L, head) {
    var r = L.row;
    if (accVIsBuy()) {
      return SB.db.apply({
        date: head.date, type: 'in', wh: r.wh === 'C' ? 'C' : 'F',
        name: L.name, meat: trimV(r.meat), origin: trimV(r.origin), brand: trimV(r.brand),
        vendor: head.partner, in_date: head.date, exp_date: r.expiry,
        kg: L.qty, price: L.price, amount: L.supply, note: head.note
      }).then(function (row) { return row && Number(row.id); });
    }
    var pk = L.lot || accVResolveLot(r);
    if (!pk) throw new Error((L.i + 1) + '번째 줄: 출고할 원료육 로트를 고르세요.');
    return SB.db.apply({
      date: head.date, type: 'out', wh: pk.wh, lot_id: Number(pk.lot.dbid),
      dest_type: 'vendor', dest: head.partner, kg: L.qty, price: L.price,
      amount: L.supply, note: head.note
    }).then(function (row) { return row && Number(row.id); });
  }
  function accVStockFp(L, head) {
    var p = L.prod || accVRowProduct(L.row);
    if (!p) throw new Error((L.i + 1) + '번째 줄: 완제품·부자재 품목을 찾을 수 없습니다.');
    return SB.db.fpApply({
      code: p.code, type: accVIsBuy() ? 'IN' : 'OUT', qty: L.qty, date: head.date,
      price: L.price, expiry: null, partner: head.partner, note: head.note,
      allowNegative: false, source: 'manual'
    }).then(function (row) { return row && Number(row.id); });
  }
  /* 저장된 줄 → 거래명세표에 찍을 줄 (같은 거래의 줄을 한 장에 모은다) */
  function accVStmtLines(saved) {
    var out = [], i, s, L;
    for (i = 0; i < saved.length; i++) {
      s = saved[i]; L = s.L;
      if (!s.vid) continue;
      out.push({
        vid: Number(s.vid), name: L.name, spec: accVLineSpec(L), unit: accVLineUnit(L),
        qty: L.qty, price: L.price, supply: L.supply, vat: L.vat, tax: L.tax, note: ''
      });
    }
    return out;
  }
  function saveAccVSheet() {
    var partner = trimV($('accVPartner').value);
    var date = $('accVDate').value || today();
    var head = { partner: partner, date: date, doc: $('accVDoc').value || 'none', note: trimV($('accVNote').value) };
    if (!partner) { accVMsg('거래처를 입력하세요.'); return; }
    var chk = accVSheetLines();
    if (chk.err) { accVMsg(chk.err); return; }
    var lines = chk.lines, saved = [], failed = null;
    accVBusy(true);
    $('accVMsg').textContent = '';
    var chain = Promise.resolve();
    lines.forEach(function (L) {
      chain = chain.then(function () {
        if (L.kind === 'meat') {
          return accVStockMeat(L, head).then(function (id) { saved.push({ L: L, kind: 'meat', id: Number(id) || 0, vid: 0 }); });
        }
        if (L.kind === 'fp') {
          return accVStockFp(L, head).then(function (id) { saved.push({ L: L, kind: 'fp', id: Number(id) || 0, vid: 0 }); });
        }
        saved.push({ L: L, kind: 'etc', id: 0, vid: 0 });
        return null;
      }).catch(function (e) {
        if (!failed) { failed = e; e.savedRows = saved.length; e.lineNo = L.i + 1; }
        throw e;
      });
    });
    chain.then(function () {
      /* ① 재고 이력 → acc_reflect (과세구분별로 묶어 줄마다 전표 1건, 중복 방지) */
      var groups = { free: [], tax: [] }, i;
      for (i = 0; i < saved.length; i++) {
        if (saved[i].kind === 'etc') continue;
        groups[saved[i].L.tax === 'free' ? 'free' : 'tax'].push(saved[i]);
      }
      var p = Promise.resolve();
      ['free', 'tax'].forEach(function (tx) {
        if (!groups[tx].length) return;
        p = p.then(function () {
          var items = groups[tx].map(function (s) { return { kind: s.kind, id: Number(s.id) }; });
          return SB.db.accReflect(items, tx).then(function (res) {
            var ids = (res && res.ids) || [];
            for (var k = 0; k < groups[tx].length; k++) {
              groups[tx][k].vid = (ids.length === groups[tx].length) ? Number(ids[k]) || 0 : 0;
            }
            return res;
          });
        });
      });
      return p;
    }).then(function () {
      /* ② 기타(재고 없음) 줄은 전표만 만든다 */
      var p = Promise.resolve();
      saved.forEach(function (s) {
        if (s.kind !== 'etc') return;
        p = p.then(function () {
          return SB.db.accVoucherSave({
            id: null, date: head.date, type: accV.type, partner: head.partner, tax: s.L.tax,
            amount: s.L.supply, vatIncluded: false, doc: head.doc, note: head.note || s.L.name
          }).then(function (row) { s.vid = Number(row && row.id) || 0; });
        });
      });
      return p;
    }).then(function () {
      /* ③ 세금계산서 상태·적요를 전표에 반영 (실패해도 전표는 남긴다) */
      var p = Promise.resolve();
      saved.forEach(function (s) {
        if (!s.vid || s.kind === 'etc') return;
        if (head.doc === 'none' && !head.note) return;
        p = p.then(function () {
          return SB.db.accVoucherSave({
            id: s.vid, date: head.date, type: accV.type, partner: head.partner, tax: s.L.tax,
            amount: s.L.supply, vatIncluded: false, doc: head.doc, note: head.note || accVLineLabel(s.L)
          }).then(function () { }, function () { });
        });
      });
      return p;
    }).then(function () {
      var stl = accVStmtLines(saved);
      accVRememberGroup(stl);
      var sum = 0, i;
      for (i = 0; i < stl.length; i++) sum += stl[i].supply + stl[i].vat;
      var kindName = accVIsBuy() ? '매입' : '매출';
      var moved = 0, k2;
      for (k2 = 0; k2 < saved.length; k2++) if (saved[k2].kind !== 'etc') moved += 1;
      accVBusy(false);
      closeAccVoucher();
      toast((moved ? '재고 + ' : '') + kindName + ' 전표 ' + stl.length + '건 + 거래명세표 1장: ' + head.partner + ' ' + won(sum), 'ok', 6000);
      return reload({ silent: true });
    }, function (e) {
      accVBusy(false);
      var msg = e && e.message ? e.message : '저장하지 못했습니다.';
      $('accVMsg').textContent = msg;
      toast(msg, 'err', 8000);
      if (saved.length) {
        /* 앞의 줄은 이미 저장됐다 — 같은 저장을 다시 눌러 재고가 두 번 들어가지 않게 창을 닫는다 */
        closeAccVoucher();
        reload({ silent: true });
        toast('앞의 ' + saved.length + '줄은 이미 저장됐습니다. 남은 줄은 다시 입력해 주세요.', 'warn', 9000);
      }
    });
  }

  /* ---------- 거래명세표용 줄 기억 (같은 거래 = 한 장) ---------- */
  var VGROUP_KEY = 'mirsfood.vstmt.v1';
  function accVGroups() {
    var a = [];
    try { a = JSON.parse(localStorage.getItem(VGROUP_KEY) || '[]') || []; } catch (e) { a = []; }
    return Object.prototype.toString.call(a) === '[object Array]' ? a : [];
  }
  function accVGroupsSave(a) {
    try { localStorage.setItem(VGROUP_KEY, JSON.stringify(a)); } catch (e) { }
  }
  function accVRememberGroup(stl) {
    if (!stl || !stl.length) return;
    var lines = {}, i, ln;
    for (i = 0; i < stl.length; i++) {
      ln = stl[i];
      lines[ln.vid] = { name: ln.name, spec: ln.spec, qty: ln.qty, unit: ln.unit, price: ln.price,
        supply: ln.supply, vat: ln.vat, tax: ln.tax, note: ln.note };
    }
    var all = accVGroups();
    all.push({ t: Date.now(), lines: lines });
    if (all.length > 400) all = all.slice(all.length - 400);
    accVGroupsSave(all);
  }
  /* 전표 하나에 찍을 줄들 — 같은 거래의 줄이면 여러 줄, 아니면 null(원래 방식대로) */
  function accVGroupLines(vid) {
    var id = Number(vid);
    if (!(id > 0)) return null;
    var all = accVGroups(), i, k, out, g;
    for (i = 0; i < all.length; i++) {
      g = all[i];
      if (!g || !g.lines || !g.lines[id]) continue;
      out = [];
      for (k in g.lines) {
        if (!Object.prototype.hasOwnProperty.call(g.lines, k)) continue;
        if (!voucherOf(k)) continue;        /* 지워진 전표는 빼고 */
        out.push(g.lines[k]);
      }
      return out.length ? out : null;
    }
    return null;
  }
  /* 전표 금액을 고치거나 지우면 그 전표의 줄은 잊는다(명세표가 옛 금액을 찍지 않게) */
  function accVGroupDrop(vid) {
    var id = Number(vid), all = accVGroups(), keep = [], i, g, k, hit;
    if (!(id > 0)) return;
    for (i = 0; i < all.length; i++) {
      g = all[i];
      if (!g || !g.lines) continue;
      hit = false;
      for (k in g.lines) if (Object.prototype.hasOwnProperty.call(g.lines, k) && Number(k) === id) hit = true;
      if (hit) { delete g.lines[id]; }
      var any = false;
      for (k in g.lines) if (Object.prototype.hasOwnProperty.call(g.lines, k)) any = true;
      if (any) keep.push(g);
    }
    accVGroupsSave(keep);
  }

  /* ---------- 전표 입력창 열기 / 닫기 ---------- */
  function updateAccVDoc() {
    var isSale = accV.type === 'sale';
    var edit = !!accV.id;
    if ($('accVoucherTitle')) {
      $('accVoucherTitle').textContent = edit
        ? (isSale ? '매출 전표 수정' : '매입 전표 수정')
        : (accV.mode === 'buy' ? '매입 전표 입력'
          : (accV.mode === 'sale' ? '매출 전표 입력' : (isSale ? '매출 전표 입력' : '매입 전표 입력')));
    }
    var segs = $('accVoucherSeg') ? $('accVoucherSeg').querySelectorAll('button') : [];
    for (var i = 0; i < segs.length; i++) {
      var vt = segs[i].getAttribute('data-vtype');
      segs[i].classList.toggle('active', vt === accV.type);
      segs[i].classList.toggle('hidden',
        (accV.mode === 'buy' && vt !== 'purchase') || (accV.mode === 'sale' && vt !== 'sale'));
    }
    if ($('accVDoc')) {
      $('accVDoc').innerHTML = isSale
        ? '<option value="none">미발행</option><option value="issued">발행완료</option>'
        : '<option value="none">미수령</option><option value="received">수령완료</option>';
    }
    /* 신규 입력 = 명세서형 다중 품목 / 기존 전표 수정 = 단일 전표 화면 */
    var vcard = $('accVoucherModal') ? $('accVoucherModal').querySelector('.modal-card') : null;
    if (vcard) vcard.classList.toggle('sheetcard', !edit);   /* 명세서형은 넓게, 수정은 예전 폭으로 */
    if ($('accVSheetWrap')) $('accVSheetWrap').classList.toggle('hidden', edit);
    if ($('accVSimpleBox')) $('accVSimpleBox').classList.toggle('hidden', !edit);
    if ($('accVTypeField')) $('accVTypeField').classList.toggle('hidden', edit);
    if ($('accVoucherSub')) {
      $('accVoucherSub').textContent = edit
        ? '전표 금액만 고칩니다. 재고는 입출고 내역에서 따로 고칩니다.'
        : '한 장에 여러 품목을 적으면 재고·전표·거래명세표가 한 번에 처리됩니다.';
    }
    if ($('accVPartnerLabel')) $('accVPartnerLabel').innerHTML = (isSale ? '거래처(출고처)' : '거래처(매입처)') + ' <span class="req">*</span>';
    if ($('accVPartner')) $('accVPartner').placeholder = isSale ? '예: 미트박스' : '예: 도드람푸드';
    if ($('accVHint')) {
      $('accVHint').innerHTML = edit
        ? '기존 전표는 <b>전표 금액만</b> 고칩니다. 재고 수량은 <b>입출고 내역</b>에서 고치세요.'
        : (isSale
          ? '원료육은 <b>보유 로트에서 차감</b>, 완제품·부자재는 <b>재고에서 차감</b>되고 같은 금액으로 매출 전표·거래명세표가 만들어집니다. (원료육 기본 면세 · 완제품 기본 과세)'
          : '원료육은 <b>냉동고·냉장고 재고가 늘고</b>, 완제품·부자재는 <b>재고가 늘고</b> 같은 금액으로 매입 전표가 만들어집니다. (원료육 기본 면세 · 완제품 기본 과세)');
    }
    if ($('accVoucherSave')) $('accVoucherSave').textContent = accVSaveLabel();
  }
  function accVCurTax() {
    var b = $('accVTaxSeg') ? $('accVTaxSeg').querySelector('.active') : null;
    return b ? b.getAttribute('data-vtax') : 'tax';
  }
  function setAccVTax(v) {
    var segs = $('accVTaxSeg') ? $('accVTaxSeg').querySelectorAll('button') : [];
    for (var i = 0; i < segs.length; i++) segs[i].classList.toggle('active', segs[i].getAttribute('data-vtax') === v);
  }
  function accVatPreview() {
    var amount = Number(($('accVAmount') || {}).value || 0);
    var v = ERP.accVat(amount, accVCurTax(), $('accVVatIncluded') ? $('accVVatIncluded').checked : false);
    if ($('accVVat')) $('accVVat').value = v.vat ? fmtInt(v.vat) + '원 (합계 ' + fmtInt(v.total) + '원)' : '0원';
  }
  function openAccVoucher(type, row, mode) {
    var d = today();
    popCloseOthers('accVoucherModal');
    accV = { id: row ? row.id : null, type: row ? row.t : (type === 'purchase' ? 'purchase' : 'sale'),
             mode: row ? '' : (mode || ''), rows: [], seq: 0 };
    accVResetRows(3);
    $('accVDate').value = row ? row.d : d;
    $('accVPartner').value = row ? row.partner : '';
    $('accVNote').value = row ? row.note : '';
    $('accVAmount').value = row ? row.supply : '';
    $('accVVatIncluded').checked = false;
    $('accVMsg').textContent = '';
    setAccVTax(row ? (row.tax === 'free' ? 'free' : 'tax') : 'tax');
    updateAccVDoc();
    $('accVDoc').value = row ? (row.doc || 'none') : 'none';
    accVatPreview();
    accVSheetRender();
    $('accVoucherModal').classList.remove('hidden');
    setTimeout(function () { try { $('accVPartner').focus(); } catch (e) { } }, 60);
  }
  function closeAccVoucher() {
    $('accVoucherModal').classList.add('hidden');
    accV = { id: null, type: 'sale', mode: '', rows: [], seq: 0 };
  }
  /* 전표 종류를 바꾸면 재고 방향이 반대가 되므로 줄을 새로 시작한다 */
  function accVTypeSet(v) {
    var t = v === 'purchase' ? 'purchase' : 'sale';
    if (t === accV.type) return;
    accV.type = t;
    accVResetRows(3);
    accVSheetRender();
    updateAccVDoc();
    $('accVDoc').value = 'none';
  }
  function saveAccVoucher() {
    if (!accV.id) { saveAccVSheet(); return; }
    var partner = trimV($('accVPartner').value);
    var amount = Number($('accVAmount').value || 0);
    if (!partner) { $('accVMsg').textContent = '거래처를 입력하세요.'; return; }
    if (!(amount > 0)) { $('accVMsg').textContent = '금액을 입력하세요.'; return; }
    var b = $('accVoucherSave');
    var wasEdit = !!accV.id, vid = accV.id;
    b.disabled = true; b.textContent = '저장 중…';
    SB.db.accVoucherSave({
      id: accV.id, date: $('accVDate').value || today(), type: accV.type, partner: partner,
      tax: accVCurTax(), amount: amount, vatIncluded: $('accVVatIncluded').checked,
      doc: $('accVDoc').value || 'none', note: $('accVNote').value || ''
    }).then(function (row) {
      accVBusy(false);
      accVGroupDrop(vid);        /* 금액이 바뀌었으니 거래명세표 줄은 다시 만들지 않는다 */
      closeAccVoucher();
      toast((wasEdit ? '전표를 고쳤습니다: ' : '전표 등록: ') + partner + ' ' + won(row && row.total_amount || amount), 'ok');
      return reload({ silent: true });
    }, function (e) {
      accVBusy(false);
      $('accVMsg').textContent = e.message;
      toast(e.message, 'err');
    });
  }

  /* ---------- 수금 · 지급 ---------- */
  var accP = { id: null, type: 'in' };
  /* v11 — 모달에서 거래처의 지금 남은 미수금(in)·미지급금(out) */
  function accPayRemain(type, partner) {
    var p = trimV(partner);
    if (!p) return 0;
    return stlRemainOf(type === 'out' ? 'out' : 'in', p);
  }
  function accPayBalRefresh() {
    var p = trimV($('accPPartner') ? $('accPPartner').value : '');
    var isOut = accP.type === 'out';
    var el = $('accPBal'), full = $('accPFull');
    var r = p ? accPayRemain(accP.type, p) : 0;
    if (el) {
      el.innerHTML = !p
        ? '거래처를 입력하거나 고르면 그 거래처의 남은 ' + (isOut ? '미지급금' : '미수금') + '이 여기 표시됩니다.'
        : '이 거래처의 남은 ' + (isOut ? '미지급금(줄돈)' : '미수금(받을돈)') +
          ' <b class="' + (Math.abs(r) > 0.004 ? (isOut ? 'neg' : 'pos') : 'zero') + '">' + fmtInt(r) + '원</b>';
      el.classList.toggle('on', !!p);
    }
    if (full) full.disabled = !(r > 0.004);
  }
  function openAccPay(type, partner) {
    popCloseOthers('accPayModal');
    accP = { id: null, type: type === 'out' ? 'out' : 'in' };
    $('accPayTitle').textContent = accP.type === 'out' ? '＋ 지급 입력' : '＋ 수금 입력';
    $('accPDate').value = today();
    $('accPPartner').value = partner || '';
    $('accPAmount').value = ''; $('accPMethod').value = '계좌이체'; $('accPNote').value = '';
    $('accPMsg').textContent = '';
    var segs = $('accPaySeg').querySelectorAll('button');
    for (var i = 0; i < segs.length; i++) segs[i].classList.toggle('active', segs[i].getAttribute('data-ptype') === accP.type);
    accPayBalRefresh();
    $('accPayModal').classList.remove('hidden');
    setTimeout(function () { try { $('accPAmount').focus(); } catch (e) { } }, 60);
  }
  function closeAccPay() { $('accPayModal').classList.add('hidden'); accP = { id: null, type: 'in' }; }
  function saveAccPay() {
    var partner = ($('accPPartner').value || '').replace(/^\s+|\s+$/g, '');
    var amount = Number($('accPAmount').value || 0);
    if (!partner) { $('accPMsg').textContent = '거래처를 입력하세요.'; return; }
    if (!(amount > 0)) { $('accPMsg').textContent = '금액을 입력하세요.'; return; }
    var b = $('accPaySave');
    b.disabled = true; b.textContent = '저장 중…';
    SB.db.accPaymentSave({
      id: accP.id, date: $('accPDate').value || today(), partner: partner, type: accP.type,
      amount: amount, method: $('accPMethod').value || '', note: $('accPNote').value || ''
    }).then(function () {
      b.disabled = false; b.textContent = '저장';
      var t = accP.type;
      closeAccPay();
      toast((t === 'in' ? '수금' : '지급') + ' 등록: ' + partner + ' ' + won(amount), 'ok');
      return reload({ silent: true });
    }, function (e) {
      b.disabled = false; b.textContent = '저장';
      $('accPMsg').textContent = e.message;
      toast(e.message, 'err');
    });
  }

  /* ---------- 경비 · 수입 ---------- */
  var accE = { id: null, type: 'expense' };
  function updateAccECats() {
    var list = accE.type === 'income' ? ERP.ACC_INCOME_CATS : ERP.ACC_EXPENSE_CATS;
    datalist('dlAccCats', list);
    if (!accE.id) $('accECat').value = list[0];
  }
  function openAccExpense(row, type) {
    accE = { id: row ? row.id : null, type: row ? row.t : (type === 'income' ? 'income' : 'expense') };
    $('accExpTitle').textContent = row ? (accE.type === 'income' ? '기타 입금 수정' : '일반 출금(경비) 수정')
      : (accE.type === 'income' ? '＋ 기타 입금' : '＋ 일반 출금(경비)');
    if ($('accExpSub')) {
      $('accExpSub').innerHTML = accE.type === 'income'
        ? '외상(미수금)과 상관없이 <b>들어온 돈</b>입니다. 잡수입·환급·이자처럼 거래처 외상 잔액을 건드리지 않는 수입입니다.'
        : '외상(미지급금)과 상관없이 <b>나간 돈</b>입니다. 월세·택배비·식대·유류비처럼 거래처 외상 잔액을 건드리지 않는 지출입니다.';
    }
    $('accEDate').value = row ? row.d : today();
    $('accEAmount').value = row ? row.amount : '';
    $('accEPartner').value = row ? row.partner : '';
    $('accENote').value = row ? row.note : '';
    $('accEMethod').value = row ? row.method : '카드';
    $('accETax').value = row ? row.tax : 'free';
    $('accEVatIncluded').checked = true;
    $('accEMsg').textContent = '';
    var segs = $('accExpSeg').querySelectorAll('button');
    for (var i = 0; i < segs.length; i++) segs[i].classList.toggle('active', segs[i].getAttribute('data-etype') === accE.type);
    updateAccECats();
    if (row) $('accECat').value = row.cat;
    $('accExpModal').classList.remove('hidden');
    setTimeout(function () { try { $('accEAmount').focus(); } catch (e) { } }, 60);
  }
  function closeAccExpense() { $('accExpModal').classList.add('hidden'); accE = { id: null, type: 'expense' }; }
  function saveAccExpense() {
    var amount = Number($('accEAmount').value || 0);
    if (!(amount > 0)) { $('accEMsg').textContent = '금액을 입력하세요.'; return; }
    var b = $('accESave');
    b.disabled = true; b.textContent = '저장 중…';
    SB.db.accExpenseSave({
      id: accE.id, date: $('accEDate').value || today(), type: accE.type,
      cat: $('accECat').value || '기타', partner: $('accEPartner').value || '',
      amount: amount, tax: $('accETax').value, vatIncluded: $('accEVatIncluded').checked,
      method: $('accEMethod').value || '', note: $('accENote').value || ''
    }).then(function () {
      b.disabled = false; b.textContent = '저장';
      var t = accE.type;
      closeAccExpense();
      toast((t === 'income' ? '수입' : '경비') + ' 등록: ' + won(amount), 'ok');
      return reload({ silent: true });
    }, function (e) {
      b.disabled = false; b.textContent = '저장';
      $('accEMsg').textContent = e.message;
      toast(e.message, 'err');
    });
  }

  /* ---------- 회계 삭제 / 상태 토글 ---------- */
  function accDelete(kind, id) {
    var msg = kind === 'v' ? '이 전표를 삭제할까요?\n(원료육·완제품에서 넘어온 전표는 다시 반영할 수 있습니다)'
      : (kind === 'e' ? '이 경비·수입 기록을 삭제할까요?' : '이 기록을 삭제할까요?');
    if (!window.confirm(msg)) return;
    var p = kind === 'v' ? SB.db.accVoucherDelete(id) : (kind === 'e' ? SB.db.accExpenseDelete(id) : SB.db.accPaymentDelete(id));
    p.then(function () {
      if (kind === 'v') accVGroupDrop(id);
      toast('삭제했습니다.', 'ok');
      return reload({ silent: true });
    }, function (e) { toast(e.message, 'err'); });
  }
  /* v8: 구매·판매관리 표 작업 — 수정·삭제·세금계산서·명세표 */
  function voucherOf(id) {
    for (var i = 0; i < st.vouchers.length; i++) if (Number(st.vouchers[i].id) === Number(id)) return st.vouchers[i];
    return null;
  }
  function voucherPaneClick(ev, t) {
    var docBtn = t.closest ? t.closest('[data-doc]') : null;
    if (docBtn) { toggleAccDoc(Number(docBtn.getAttribute('data-doc'))); return; }
    var ve = t.closest ? t.closest('[data-vedit]') : null;
    if (ve) { var v = voucherOf(ve.getAttribute('data-vedit')); if (v) openAccVoucher(v.t, v); return; }
    var vd = t.closest ? t.closest('[data-vdel]') : null;
    if (vd) { accDelete('v', Number(vd.getAttribute('data-vdel'))); return; }
    var vst = t.closest ? t.closest('[data-vstmt]') : null;
    if (vst) { var vv = voucherOf(vst.getAttribute('data-vstmt')); if (vv) openStmt('voucher', vv); return; }
  }
  function openSaleStmt() {
    var list = ERP.accFilterVouchers(acc(), { type: 'sale', q: '', from: '', to: '', sortKey: 'd', sortDir: -1 });
    if (list.length) { openStmt('voucher', list[0]); return; }
    openStmt('voucher', { id: null, d: today(), partner: '', t: 'sale', tax: 'tax', supply: 0, vat: 0, total: 0, doc: 'none', note: '' });
  }

  function toggleAccDoc(id) {
    var v = null, i;
    for (i = 0; i < st.vouchers.length; i++) if (st.vouchers[i].id === id) v = st.vouchers[i];
    if (!v) return;
    var next = v.doc === 'none' ? (v.t === 'sale' ? 'issued' : 'received') : 'none';
    SB.db.accVoucherSave({
      id: v.id, date: v.d, type: v.t, partner: v.partner, tax: v.tax,
      amount: v.supply, vatIncluded: false, doc: next, note: v.note
    }).then(function () {
      toast('세금계산서 상태: ' + ERP.accDocName(v.t, next), 'ok');
      return reload({ silent: true });
    }, function (e) { toast(e.message, 'err'); });
  }

  /* ==========================================================================
     v8.1 — 2부 거래명세표(공급자·공급받는자 보관용) A4 1장 · 공급자 정보 설정
       · 공급자 기본값 : (주)미르스타푸드 212-86-12646 · 성명 조욱 · 광주공장
       · 성명 옆에 붉은 직인(stamp.png). 설정에서 바꾸거나 숨길 수 있다.
       · 공급받는자 등록번호·상호·주소·전화·팩스는 거래처 DB(2,350)에서 자동으로 채운다.
     ========================================================================== */
  var SUP_KEY = 'mirsfood.supplier.v1';
  var STAMP_DEFAULT = 'stamp.png?v=20261118_10';
  var SUP_DEFAULT = {
    name: '(주)미르스타푸드', bizNo: '212-86-12646', owner: '조욱',
    addr: '경기도 광주시 초월읍 무들로 84-11 (대쌍령리)',
    tel: '031-767-5517', fax: '070-4109-5522', email: '',
    biz: '도소매외', item: '식육가공외', project: '광주공장',
    bank: '국민은행 348301-04-270779 (주)미르스타푸드',
    stampOn: '1', stampUrl: STAMP_DEFAULT
  };
  function loadSup() {
    var o = {};
    try { o = JSON.parse(localStorage.getItem(SUP_KEY) || '{}') || {}; } catch (e) { o = {}; }
    var out = {}, k;
    for (k in SUP_DEFAULT) if (Object.prototype.hasOwnProperty.call(SUP_DEFAULT, k)) out[k] = SUP_DEFAULT[k];
    /* 저장된 값이 비어 있으면 내장 기본값을 그대로 둔다(v7에서 상호만 넣어 둔 경우에도 등록번호·계좌가 살아 있다) */
    for (k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k) || !(k in SUP_DEFAULT)) continue;
      var sv = String(o[k] === null || o[k] === undefined ? '' : o[k]);
      if (sv !== '') out[k] = sv;
    }
    /* v7에 '업태 · 종목' 한 칸으로 저장한 값은 두 칸으로 나눠 준다 */
    if (o.biz && !o.item && String(o.biz).indexOf('·') >= 0) {
      var sp = String(o.biz).split('·');
      out.biz = sp[0].replace(/^\s+|\s+$/g, '');
      out.item = sp.slice(1).join('·').replace(/^\s+|\s+$/g, '');
    }
    if (!out.name) out.name = SUP_DEFAULT.name;
    if (!out.stampUrl) out.stampUrl = STAMP_DEFAULT;
    return out;
  }
  function saveSup(o) {
    try { localStorage.setItem(SUP_KEY, JSON.stringify(o)); } catch (e) { }
  }
  var supStampTmp = '';   /* 설정에서 고른 직인 이미지(저장 전) */
  function supStampSrc() {
    var o = loadSup();
    return supStampTmp || o.stampUrl || STAMP_DEFAULT;
  }
  function openSupplier() {
    var o = loadSup();
    $('supName').value = o.name; $('supBizNo').value = o.bizNo; $('supOwner').value = o.owner;
    $('supAddr').value = o.addr; $('supTel').value = o.tel; $('supEmail').value = o.email;
    $('supBiz').value = o.biz; $('supBank').value = o.bank;
    if ($('supItem')) $('supItem').value = o.item;
    if ($('supFax')) $('supFax').value = o.fax;
    if ($('supProject')) $('supProject').value = o.project;
    if ($('supStampOn')) $('supStampOn').checked = o.stampOn !== '0';
    supStampTmp = '';
    if ($('supStampImg')) $('supStampImg').src = o.stampUrl || STAMP_DEFAULT;
    if ($('supStampHint')) $('supStampHint').textContent = '직인을 바꾸려면 흰 배경 PNG를 고르세요.';
    $('supplierMsg').textContent = '';
    $('supplierModal').classList.remove('hidden');
    setTimeout(function () { try { $('supName').focus(); } catch (e) { } }, 60);
  }
  function closeSupplier() { $('supplierModal').classList.add('hidden'); }
  function saveSupplier() {
    var name = ($('supName').value || '').replace(/^\s+|\s+$/g, '');
    if (!name) { $('supplierMsg').textContent = '상호를 입력하세요.'; return; }
    var o = {
      name: name, bizNo: $('supBizNo').value || '', owner: $('supOwner').value || '',
      addr: $('supAddr').value || '', tel: $('supTel').value || '', email: $('supEmail').value || '',
      biz: $('supBiz').value || '', bank: $('supBank').value || '',
      item: $('supItem') ? ($('supItem').value || '') : '',
      fax: $('supFax') ? ($('supFax').value || '') : '',
      project: $('supProject') ? ($('supProject').value || '') : '',
      stampOn: ($('supStampOn') && !$('supStampOn').checked) ? '0' : '1',
      stampUrl: supStampTmp || (loadSup().stampUrl || STAMP_DEFAULT)
    };
    saveSup(o);
    supStampTmp = '';
    closeSupplier();
    toast('공급자 정보를 저장했습니다. 다음 명세표부터 그대로 찍힙니다.', 'ok');
    if (!$('stmtModal').classList.contains('hidden') && stmtNow) renderStmt();
  }
  function pickStampFile(ev) {
    var f = ev.target && ev.target.files && ev.target.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type || '')) { toast('이미지 파일(PNG)을 골라 주세요.', 'warn'); return; }
    var rd = new FileReader();
    rd.onload = function () {
      supStampTmp = String(rd.result || '');
      if ($('supStampImg')) $('supStampImg').src = supStampTmp;
      if ($('supStampHint')) $('supStampHint').textContent = '새 직인을 골랐습니다. [저장]을 누르면 이 직인이 찍힙니다.';
      toast('직인 이미지를 골랐습니다. [저장]을 눌러 주세요.', 'ok');
    };
    rd.readAsDataURL(f);
    try { ev.target.value = ''; } catch (e) { }
  }
  function resetStamp() {
    supStampTmp = '';
    saveSup((function () { var o = loadSup(); o.stampUrl = STAMP_DEFAULT; o.stampOn = '1'; return o; })());
    if ($('supStampImg')) $('supStampImg').src = STAMP_DEFAULT;
    if ($('supStampOn')) $('supStampOn').checked = true;
    if ($('supStampHint')) $('supStampHint').textContent = '기본 직인으로 되돌렸습니다.';
    if (stmtNow && !$('stmtModal').classList.contains('hidden')) renderStmt();
  }

  var stmtNow = null;   /* 지금 열려 있는 명세표 데이터 */
  function stmtEsc(v) { return esc(v === null || v === undefined ? '' : v); }
  function stmtDash(v) { var t = String(v === null || v === undefined ? '' : v).replace(/^\s+|\s+$/g, ''); return t ? t : '—'; }
  function wonOrDash(n) { return Number(n) > 0 ? fmtInt(n) : '—'; }
  function stmtTime() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function stmtDocNo(d) {
    var base = String(d.date || today()).replace(/[^0-9]/g, '');
    var id = Number(d.id || 0);
    return base + '-' + (id > 0 ? ('000' + id).slice(-3) : '001');
  }
  function stmtBuyer(d) {
    if (d && d.buyer) return d.buyer;
    return { name: d ? d.partner : '', bizNo: '', owner: '', addr: '', tel: '', fax: '' };
  }
  /* 품목 줄 — 월일 · 품목 · 규격 · 수량 · 단가 · 공급가액 · 세액 · 비고 */
  function stmtItemRows(d) {
    var rows = [], i, l, pad, mm = ERP.mmdd(d.date);
    if (mm.length === 4) mm = mm.slice(0, 2) + '-' + mm.slice(2);
    for (i = 0; i < d.lines.length; i++) {
      l = d.lines[i];
      rows.push('<tr><td class="c">' + stmtEsc(mm) + '</td>' +
        '<td class="nm">' + stmtEsc(l.name || '') + '</td>' +
        '<td class="c">' + stmtEsc(l.spec || '') + '</td>' +
        '<td class="r">' + (l.qty > 0 ? stmtEsc(fmtQty(l.qty)) : '') + '</td>' +
        '<td class="r">' + wonOrDash(l.price) + '</td>' +
        '<td class="r">' + wonOrDash(l.supply) + '</td>' +
        '<td class="r">' + (l.vat ? fmtInt(l.vat) : '') + '</td>' +
        '<td class="c">' + stmtEsc(l.note || '') + '</td></tr>');
    }
    pad = Math.max(0, 7 - d.lines.length);
    for (i = 0; i < pad; i++) {
      rows.push('<tr class="blank"><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>');
    }
    return rows.join('');
  }
  /* 명세표 한 부 — tone: 'sup'(빨강 공급자 보관용) | 'buy'(파랑 공급 받는자 보관용) */
  function stmtPartHtml(tone, label, d, sup, buyer) {
    var qtySum = 0, i;
    for (i = 0; i < d.lines.length; i++) qtySum += Number(d.lines[i].qty) || 0;
    var stamp = (sup.stampOn !== '0' && sup.stampUrl)
      ? '<img class="stmt-stamp" src="' + stmtEsc(sup.stampUrl) + '" alt="직인">' : '';
    var h = [];
    h.push('<section class="stmt-part ' + tone + '">');
    h.push('<div class="sp-head"><div class="sp-title">거래명세표</div>' +
      '<div class="sp-keep">(' + stmtEsc(label) + ')</div>' +
      '<div class="sp-page">PAGE&nbsp;&nbsp;1 / 1</div></div>');
    /* 왼쪽 거래 정보 · 오른쪽 공급자 정보 */
    /* v8.6 — 왼쪽 공급받는자 칸은 표 테두리 없이 텍스트 줄로만 (원본 양식과 동일) */
    h.push('<div class="sp-top"><div class="sp-left">' +
      '<div class="sp-line"><span class="k">프로젝트/현장</span><span class="v">' + stmtEsc(stmtDash(sup.project)) + '</span></div>' +
      '<div class="sp-line"><span class="k">일 자</span><span class="v">' + stmtEsc(d.date || '') + '</span>' +
        '<span class="k sub">등록번호</span><span class="v">' + stmtEsc(stmtDash(buyer.bizNo)) + '</span></div>' +
      '<div class="sp-line"><span class="k">거래처</span><span class="v grow"><b>' + stmtEsc(stmtDash(buyer.name || d.partner)) + '</b>' +
        (buyer.owner ? ' / ' + stmtEsc(buyer.owner) : '') + '</span></div>' +
      '<div class="sp-line"><span class="k">주 소</span><span class="v grow">' + stmtEsc(stmtDash(buyer.addr)) + '</span></div>' +
      '<div class="sp-line"><span class="k">전화번호</span><span class="v">' + stmtEsc(stmtDash(buyer.tel)) + '</span>' +
        '<span class="k sub">팩스번호</span><span class="v">' + stmtEsc(stmtDash(buyer.fax)) + '</span></div>' +
      '<div class="sp-sum"><span class="lab">합계금액</span><span class="amt">' + fmtInt(d.total) + '</span></div>' +
      '</div><div class="sp-right"><div class="sp-sup">' +
      '<div class="k">등록번호</div><div class="v span3">' + stmtEsc(stmtDash(sup.bizNo)) + '</div>' +
      '<div class="k">상 호</div><div class="v">' + stmtEsc(stmtDash(sup.name)) + '</div>' +
      '<div class="k">성 명</div><div class="v own">' + stmtEsc(stmtDash(sup.owner)) + stamp + '</div>' +
      '<div class="k">사업장주소</div><div class="v span3 addr">' + stmtEsc(stmtDash(sup.addr)) + '</div>' +
      '<div class="k">업 태</div><div class="v">' + stmtEsc(stmtDash(sup.biz)) + '</div>' +
      '<div class="k">종 목</div><div class="v">' + stmtEsc(stmtDash(sup.item)) + '</div>' +
      '<div class="k">전화번호</div><div class="v">' + stmtEsc(stmtDash(sup.tel)) + '</div>' +
      '<div class="k">팩스번호</div><div class="v">' + stmtEsc(stmtDash(sup.fax)) + '</div>' +
      '</div></div></div>');
    /* 품목 표 */
    h.push('<table class="sp-items"><colgroup><col style="width:7.5%"><col style="width:30%"><col style="width:12%">' +
      '<col style="width:9%"><col style="width:9.5%"><col style="width:13%"><col style="width:11%"><col style="width:8%">' +
      '</colgroup><thead><tr><th>월일</th><th>품목</th><th>규격</th><th>수량</th><th>단가</th>' +
      '<th>공급가액</th><th>세액</th><th>비고</th></tr></thead><tbody>' + stmtItemRows(d) +
      '<tr class="qsum"><td colspan="3" class="c">수량총계</td><td class="r">' + (qtySum ? fmtQty(qtySum) : '') +
      '</td><td colspan="4"></td></tr></tbody></table>');
    /* 하단 합계·입금·미수·인수자 */
    /* v8.6 — 하단 합계는 원본 그대로 2줄 (결제수단란 없음) */
    h.push('<table class="sp-bottom">' +
      '<colgroup><col style="width:14%"><col style="width:21%"><col style="width:12%"><col style="width:16%">' +
      '<col style="width:11%"><col style="width:12%"><col style="width:7%"><col style="width:7%"></colgroup>' +
      '<tr><td class="lb">전미수잔액</td><td colspan="2"></td>' +
      '<td class="lb">합 계</td><td class="num">' + wonOrDash(d.supply) + '</td>' +
      '<td class="num">' + (d.vat ? fmtInt(d.vat) : '') + '</td><td colspan="2"></td></tr>' +
      '<tr><td class="lb">총합계</td><td class="num b">' + fmtInt(d.total) + '</td>' +
      '<td class="lb">입금액</td><td></td>' +
      '<td class="lb">총미수잔액</td><td></td>' +
      '<td class="lb">인수자</td><td></td></tr></table>');
    h.push('<div class="sp-foot"><span>' + stmtEsc(sup.bank || '') + '</span>' +
      '<span>Print Date : ' + stmtEsc(d.printedAt || '') + '</span></div>');
    h.push('</section>');
    return h.join('');
  }
  /* 화면에 띄울 명세표 — A4 한 장에 두 부 */
  function renderStmt() {
    if (!stmtNow || !$('stmtSheet')) return;
    var d = stmtNow, sup = loadSup(), buyer = stmtBuyer(d);
    if (!d.printedAt) d.printedAt = stmtTime();
    $('stmtSheet').innerHTML = stmtPartHtml('sup', '공급자 보관용', d, sup, buyer) +
      '<div class="stmt-cut"></div>' +
      stmtPartHtml('buy', '공급 받는자 보관용', d, sup, buyer);
    if ($('stmtSub')) {
      $('stmtSub').textContent = (buyer.name || d.partner || '거래처') + ' · ' + (d.date || today()) + ' · ' +
        d.lines.length + '개 품목 · 합계 ' + fmtInt(d.total) + '원 · A4 한 장에 [공급자 보관용]·[공급 받는자 보관용] 2부가 함께 인쇄됩니다.';
    }
  }
  function stmtFillBuyer() {
    var b = stmtBuyer(stmtNow || {});
    if ($('stmtBuyerName')) $('stmtBuyerName').value = b.name || '';
    if ($('stmtBuyerBizNo')) $('stmtBuyerBizNo').value = b.bizNo || '';
    if ($('stmtBuyerOwner')) $('stmtBuyerOwner').value = b.owner || '';
    if ($('stmtBuyerTel')) $('stmtBuyerTel').value = b.tel || '';
    if ($('stmtBuyerAddr')) $('stmtBuyerAddr').value = b.addr || '';
    if ($('stmtBuyerFax')) $('stmtBuyerFax').value = b.fax || '';
  }
  /* 거래처 DB에서 공급받는자 칸을 다시 채운다 */
  function stmtReloadBuyer() {
    if (!stmtNow) return;
    stmtNow.buyer = ERP.partnerBuyer(stmtNow.partner);
    stmtFillBuyer();
    renderStmt();
  }
  function stmtEditBuyer() {
    if (!stmtNow) return;
    stmtNow.buyer = {
      name: $('stmtBuyerName') ? $('stmtBuyerName').value : '', bizNo: $('stmtBuyerBizNo') ? $('stmtBuyerBizNo').value : '',
      owner: $('stmtBuyerOwner') ? $('stmtBuyerOwner').value : '', tel: $('stmtBuyerTel') ? $('stmtBuyerTel').value : '',
      addr: $('stmtBuyerAddr') ? $('stmtBuyerAddr').value : '', fax: $('stmtBuyerFax') ? $('stmtBuyerFax').value : ''
    };
    renderStmt();
  }
  function openStmt(kind, ref) {
    /* v10 — 같은 거래에서 여러 품목을 적었으면 그 줄들을 한 장에 모두 찍는다 */
    if (kind === 'voucher' && ref && ref.id) {
      var glines = accVGroupLines(ref.id);
      if (glines) {
        var gd = ERP.stmtGroupData(ref, glines);
        gd.id = ref.id;
        gd.printedAt = stmtTime();
        gd.buyer = ERP.partnerBuyer(gd.partner);
        stmtNow = gd;
        stmtFillBuyer();
        $('stmtModal').classList.remove('hidden');
        document.body.classList.add('stmt-open');
        renderStmt();
        var gsheet = document.querySelector('.stmt-scroll');
        if (gsheet) gsheet.scrollTop = 0;
        return;
      }
    }
    var o = { kind: kind, ref: ref || {}, logs: st.logs, fpLogs: st.fpLogs };
    /* 일괄 반영으로 만든 전표는 원본 출고를 찾아 품목을 채운다 */
    if (kind === 'voucher' && ref) {
      var srcKind = ref.srcKind, srcId = ref.srcId;
      if (srcKind === 'meat' && srcId) {
        var lg = null, i;
        for (i = 0; i < st.logs.length; i++) if (Number(st.logs[i].dbid) === Number(srcId)) lg = st.logs[i];
        if (lg) o = { kind: 'meat', ref: lg, logs: st.logs, fpLogs: st.fpLogs };
      } else if (srcKind === 'fp' && srcId) {
        var fg = null, j;
        for (j = 0; j < st.fpLogs.length; j++) if (Number(st.fpLogs[j].id) === Number(srcId)) fg = st.fpLogs[j];
        if (fg) o = { kind: 'fp', ref: fg, logs: st.logs, fpLogs: st.fpLogs };
      }
    }
    var data = ERP.stmtData(o);
    if (kind === 'voucher' && !(ref && ref.srcKind)) {
      data.partner = ref.partner || '';
      data.note = ref.note || '';
    }
    data.id = (ref && (ref.id || ref.dbid)) || '';
    data.printedAt = stmtTime();
    /* v8.1 — 공급받는자 칸을 거래처 DB에서 자동으로 채운다 */
    data.buyer = ERP.partnerBuyer(data.partner);
    stmtNow = data;
    stmtFillBuyer();
    $('stmtModal').classList.remove('hidden');
    document.body.classList.add('stmt-open');
    renderStmt();
    var sheet = document.querySelector('.stmt-scroll');
    if (sheet) sheet.scrollTop = 0;
  }
  function closeStmt() {
    $('stmtModal').classList.add('hidden');
    document.body.classList.remove('stmt-open');
    stmtNow = null;
  }
  function printStmt() {
    if (!stmtNow) return;
    document.body.classList.add('stmt-open');
    try { window.print(); } catch (e) { toast('이 브라우저에서는 인쇄 창을 열 수 없습니다. PDF 저장을 이용해 주세요.', 'warn'); }
    setTimeout(function () { if ($('stmtModal').classList.contains('hidden')) document.body.classList.remove('stmt-open'); }, 800);
  }

  /* ---------- ❓ 회계 사용법 ---------- */
  function openAccHelp() { $('accHelpModal').classList.remove('hidden'); }
  function closeAccHelp() { $('accHelpModal').classList.add('hidden'); }

  /* ---------- 회계 엑셀 ---------- */
  function accXls() {
    var tab = cur.accTab, rows, name;
    if (tab === 'V') {
      rows = ERP.accVoucherRows(ERP.accFilterVouchers(acc(), { q: cur.accSearch, type: cur.accType, from: cur.accRange.from, to: cur.accRange.to }));
      name = '회계_전표_';
    } else if (tab === 'R') {
      rows = ERP.accLedgerRows(accLedgerList());
      name = '회계_거래처원장_';
    } else if (tab === 'E') {
      rows = ERP.accExpenseRows(ERP.accFilterExpenses(acc(), { q: cur.accSearch, type: cur.accType, from: cur.accRange.from, to: cur.accRange.to }));
      name = '회계_경비_';
    } else {
      rows = ERP.accMonthRows(ERP.accMonthly(acc(), cur.accRange.from, cur.accRange.to));
      name = '회계_월별손익_';
    }
    downloadXlsxFile([{ name: '회계', rows: rows, widths: [12, 10, 20, 10, 13, 13, 14, 12, 10, 26] }], name + ymdTag() + '.xlsx');
    toast('회계 ' + tab + ' 표를 엑셀로 내려받았습니다.', 'ok');
    return;
  }

  /* ---------- 자동완성 (완제품 · 회계) ---------- */
  function fillFgDatalists() {
    var names = [], partners = [], cats = ERP.FP_CATS.slice(), units = ERP.FP_UNITS.slice(), specs = [], i, p, seen = {};
    for (i = 0; i < st.fps.length; i++) {
      p = st.fps[i];
      if (p.n && !seen['n' + p.n]) { seen['n' + p.n] = 1; names.push(p.n); }
      if (p.code) names.push(p.code);
      if (p.sup && !seen['p' + p.sup]) { seen['p' + p.sup] = 1; partners.push(p.sup); }
      if (p.cat && cats.indexOf(p.cat) < 0) cats.push(p.cat);
      if (p.unit && units.indexOf(p.unit) < 0) units.push(p.unit);
      if (p.spec && specs.indexOf(p.spec) < 0) specs.push(p.spec);
    }
    for (i = 0; i < st.fpLogs.length; i++) {
      p = st.fpLogs[i];
      if (p.p && !seen['p' + p.p]) { seen['p' + p.p] = 1; partners.push(p.p); }
      if (p.spec && specs.indexOf(p.spec) < 0) specs.push(p.spec);
    }
    datalist('dlFgNames', names);
    datalist('dlFgPartners', partners);
    datalist('dlFgCats', cats);
    datalist('dlFgUnits', units);
    datalist('dlFgSpecs', specs);
  }
  function fillAccDatalists() {
    var partners = [], seen = {}, i, v;
    var srcs = [st.vouchers, st.payments, st.expenses, st.fps, st.logs];
    for (var s2 = 0; s2 < srcs.length; s2++) {
      for (i = 0; i < srcs[s2].length; i++) {
        v = srcs[s2][i];
        var name = v.partner || v.sup || v.v || '';
        if (name && !seen[name]) { seen[name] = 1; partners.push(name); }
      }
    }
    datalist('dlAccPartners', partners);
    datalist('dlAccMethods', ERP.ACC_METHODS);
    datalist('dlAccCats', ERP.ACC_EXPENSE_CATS);
  }

  /* ==========================================================================
     v8.1 — 스마트 자동완성 (공백 토큰 AND · Enter = 1순위 · 폼 전송 없음)
       입력하는 동안 후보가 아래에 뜨고, ↑↓ 로 고르고 Enter 로 넣는다.
       Enter 는 후보를 넣기만 하고 폼을 보내지 않는다.
     ========================================================================== */
  var acCache = {}, ACEL = null;
  var acNow = { items: [], idx: 0, open: false, input: null, opts: null, mute: false };
  function acPopEl() {
    if (!ACEL) {
      ACEL = document.createElement('div');
      ACEL.className = 'acpop hidden';
      ACEL.setAttribute('role', 'listbox');
      ACEL.addEventListener('mousedown', function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-aci]') : null;
        if (!b) return;
        ev.preventDefault();
        ev.stopPropagation();
        acSelect(Number(b.getAttribute('data-aci')));
      });
      document.body.appendChild(ACEL);
    }
    return ACEL;
  }
  function acHide() {
    acNow.open = false; acNow.items = []; acNow.idx = 0;
    if (ACEL) ACEL.classList.add('hidden');
  }
  function acPaint() {
    var el = acPopEl(), h = [], i, it;
    for (i = 0; i < acNow.items.length; i++) {
      it = acNow.items[i];
      h.push('<button type="button" class="acitem' + (i === acNow.idx ? ' on' : '') + '" role="option" data-aci="' + i + '">' +
        '<b class="act">' + esc(it.t || it.v) + '</b>' +
        (it.s ? '<span class="acs">' + esc(it.s) + '</span>' : '') +
        '</button>');
    }
    el.innerHTML = h.join('');
  }
  function acPlace() {
    var el = acPopEl(), inp = acNow.input;
    if (!inp || !inp.getBoundingClientRect) return;
    var r = inp.getBoundingClientRect();
    var w = Math.max(240, Math.round(r.width));
    el.style.width = w + 'px';
    el.style.left = Math.round(Math.min(r.left, (window.innerWidth || 1200) - w - 8)) + 'px';
    var top = Math.round(r.bottom + 3);
    var hgt = el.offsetHeight || 0;
    if (top + hgt > (window.innerHeight || 800) - 10 && r.top > hgt + 12) top = Math.round(r.top - hgt - 3);
    el.style.top = top + 'px';
  }
  function acMove(d) {
    if (!acNow.open || !acNow.items.length) return;
    acNow.idx = (acNow.idx + d + acNow.items.length) % acNow.items.length;
    acPaint();
    var on = ACEL ? ACEL.querySelector('.acitem.on') : null;
    if (on && on.scrollIntoView) { try { on.scrollIntoView({ block: 'nearest' }); } catch (e) { } }
  }
  function acSelect(i) {
    var it = acNow.items[i], inp = acNow.input, opts = acNow.opts;
    if (!it || !inp) return null;
    inp.value = it.v;
    acHide();
    acNow.mute = true;
    try { inp.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { }
    try { inp.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { }
    acNow.mute = false;
    if (opts && opts.onPick) opts.onPick(it, inp);
    return it;
  }
  /* 후보를 만들고 목록을 연다 (force=true 면 검색어가 비어 있어도 강제로) */
  function acRun(inp, force) {
    if (!inp || acNow.mute) return [];
    var opts = inp.__ac;
    if (!opts) return [];
    var q = inp.value || '';
    var cands = opts.cands ? opts.cands() : [];
    var items = ERP.smartPick(cands, q, 9);
    if (!items.length) { acHide(); return []; }
    acNow.items = items; acNow.idx = 0; acNow.open = true; acNow.input = inp; acNow.opts = opts;
    acPaint(); acPopEl().classList.remove('hidden'); acPlace();
    return items;
  }
  /* 입력칸에 스마트 자동완성을 붙인다 (줄마다 새로 만들어지는 입력칸도 acWire 로 붙인다) */
  function acWire(inp, cands, onPick) {
    if (!inp) return;
    inp.removeAttribute('list');     /* 브라우저 기본 목록과 겹치지 않게 */
    inp.setAttribute('autocomplete', 'off');
    inp.__ac = { cands: cands, onPick: onPick };
    /* 실제로 타자를 칠 때만 목록을 연다 — 프로그램이 값을 넣은 경우(붙여넣기 제외)는 열지 않는다 */
    inp.addEventListener('keydown', function () { inp.__acAt = Date.now(); }, true);
    inp.addEventListener('input', function () {
      if (Date.now() - (inp.__acAt || 0) < 500) acRun(inp, false); else acHide();
    });
    inp.addEventListener('blur', function () { setTimeout(function () { if (acNow.input === inp) acHide(); }, 140); });
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { if (acNow.open && acNow.input === inp) acMove(1); else acRun(inp, false); ev.preventDefault(); return; }
      if (ev.key === 'ArrowUp') { if (acNow.open && acNow.input === inp) acMove(-1); ev.preventDefault(); return; }
      if (ev.key === 'Escape') { if (acNow.open) { acHide(); ev.preventDefault(); } return; }
      if (ev.key === 'Enter') {
        var list = (acNow.open && acNow.input === inp && acNow.items.length) ? acNow.items : acRun(inp, false);
        if (list && list.length) {
          ev.preventDefault();     /* 폼 전송 금지 — 1순위를 그 자리에 넣는다 */
          ev.stopPropagation();
          acSelect(acNow.open ? acNow.idx : 0);
        }
      }
    });
  }
  function acAttach(id, cands, onPick) {
    acWire($(id), cands, onPick);
  }
  function acShowAll(id) {
    var inp = $(id);
    if (inp && inp.__ac) acRun(inp, true);
  }

  /* ---------- 후보 목록 ---------- */
  function acCached(key, build) {
    if (!acCache[key]) acCache[key] = build();
    return acCache[key];
  }
  function acFromList(arr, sub) {
    var out = [], seen = {}, i, v;
    for (i = 0; i < arr.length; i++) {
      v = String(arr[i] === null || arr[i] === undefined ? '' : arr[i]).replace(/^\s+|\s+$/g, '');
      if (!v || seen[v]) continue;
      seen[v] = 1;
      out.push({ v: v, t: v, s: sub || '', h: v });
    }
    return out;
  }
  function acPartnerCands() {
    return acCached('partners', function () {
      var out = [], i, hit = ERP.partnerItems();
      for (i = 0; i < hit.length; i++) {
        out.push({ v: hit[i].v, t: hit[i].t, s: hit[i].s, h: hit[i].h });
      }
      return out;
    });
  }
  /* 거래처 DB + 지금까지 쓴 거래처(장부·입출고)를 함께 제안 */
  function acPartnerAll() {
    return acCached('partnerAll', function () {
      var out = acPartnerCands().slice(), seen = {}, i, list = [];
      for (i = 0; i < out.length; i++) seen[out[i].v] = 1;
      var d = ERP.dict(st);
      var arrs = [d.vendors, st.vouchers.map(function (v) { return v.partner; }),
        st.payments.map(function (p) { return p.partner; }), st.expenses.map(function (x) { return x.partner; }),
        st.fpLogs.map(function (g) { return g.p; })];
      for (var a = 0; a < arrs.length; a++) {
        for (i = 0; i < arrs[a].length; i++) {
          var v = String(arrs[a][i] || '').replace(/^\s+|\s+$/g, '');
          if (!v || seen[v] || v === '자체생산') continue;
          seen[v] = 1;
          list.push(v);
        }
      }
      return out.concat(acFromList(list, '장부·입출고 거래처'));
    });
  }
  function acProductCands() {
    return acCached('products', function () {
      var d = ERP.dict(st);
      return acFromList(d.names, '원료육 품목').concat(acFromList(d.products, '생산품목'))
        .concat(acFromList(st.fps.map(function (p) { return p.n; }), '완제품·부자재'));
    });
  }
  function acFgCands() {
    return acCached('fg', function () {
      var out = [], i, p;
      for (i = 0; i < st.fps.length; i++) {
        p = st.fps[i];
        out.push({
          v: p.code + ' · ' + p.n, t: p.n, h: p.n + ' ' + p.code + ' ' + (p.spec || '') + ' ' + (p.cat || ''),
          s: p.code + (p.spec ? ' · ' + p.spec : '') + (p.cat ? ' · ' + p.cat : '') + ' · 재고 ' + fmtQty(p.stock) + (p.unit || '')
        });
      }
      return out;
    });
  }
  function acSiteCands() {
    /* 현장 출고 = 생산품목, 그 밖의 출고 = 거래처 */
    var isSite = true;
    try { isSite = (document.querySelector('#destSeg button.active') || {}).getAttribute('data-dest') === 'site'; } catch (e) { isSite = true; }
    return isSite ? acProductCands() : acPartnerAll();
  }
  /* 목록 밖을 누르거나 화면이 움직이면 닫는다 */
  function acBindGlobal() {
    document.addEventListener('pointerdown', function (ev) {
      if (!acNow.open) return;
      var t = ev.target;
      if (t && (t === acNow.input || (t.closest && t.closest('.acpop')))) return;
      acHide();
    }, true);
    window.addEventListener('scroll', function () { if (acNow.open) acPlace(); }, true);
    window.addEventListener('resize', function () { if (acNow.open) acPlace(); });
  }
  function acSetupAll() {
    acBindGlobal();
    acAttach('inName', acProductCands, function () { });
    acAttach('inVendor', acPartnerAll, function () { });
    acAttach('inBrand', function () { return acCached('brands', function () { return acFromList(ERP.brandList().concat(ERP.dict(st).brands), '표준 브랜드'); }); }, function () { });
    acAttach('inOrigin', function () { return acCached('origins', function () { return acFromList(ERP.dict(st).origins, '원산지'); }); }, function () { });
    acAttach('thProd', acProductCands, function () { });
    acAttach('outDest', acSiteCands, function () { });
    acAttach('fgQuery', acFgCands, function () { fgPickProduct(true); });
    acAttach('fgPartner', acPartnerAll, function () { });
    acAttach('fgNewSupplier', acPartnerAll, function () { });
    acAttach('accVPartner', acPartnerAll, function () { });
    acAttach('accPPartner', acPartnerAll, function () { });
    acAttach('accEPartner', acPartnerAll, function () { });
    if ($('stmtBuyerName')) {
      /* 명세표 공급받는자 칸 — 고르면 DB 값으로 다시 채운다 */
      acAttach('stmtBuyerName', acPartnerCands, function (it) {
        var p = ERP.partnerOf(it.v);
        if (p && stmtNow) {
          stmtNow.partner = p.n;
          stmtNow.buyer = ERP.partnerBuyer(p);
          stmtFillBuyer();
          renderStmt();
        }
      });
    }
  }

  /* ==========================================================================
     v4 이벤트
     ========================================================================== */
  function bindResize(wrapId, tableOf) {
    var wrapEl = $(wrapId);
    if (!wrapEl) return;
    var drag = null;
    wrapEl.addEventListener('pointerdown', function (ev) {
      var h = ev.target.closest ? ev.target.closest('.colrz') : null;
      if (!h) return;
      var key = h.getAttribute('data-rz');
      var col = wrapEl.querySelector('col[data-colwrap="' + key + '"]');
      if (!col) return;
      ev.preventDefault();
      ev.stopPropagation();
      var w0 = parseFloat(col.style.width) || col.getBoundingClientRect().width;
      drag = { key: key, tbl: tableOf(), col: col, x: ev.clientX, w: w0, cur: w0, h: h };
      try { h.setPointerCapture(ev.pointerId); } catch (e) { }
      h.classList.add('on');
      document.body.classList.add('colresizing');
    });
    document.addEventListener('pointermove', function (ev) {
      if (!drag) return;
      var w = Math.round(drag.w + (ev.clientX - drag.x));
      w = Math.max(COL_MIN, Math.min(COL_MAX, w));
      if (w === drag.cur) return;
      drag.cur = w;
      drag.col.style.width = w + 'px';
      syncTableWidth(wrapId);
    });
    function endDrag() {
      if (!drag) return;
      if (!COLW[drag.tbl]) COLW[drag.tbl] = {};
      COLW[drag.tbl][drag.key] = Math.round(drag.cur);
      saveColW();
      drag.h.classList.remove('on');
      drag = null;
      document.body.classList.remove('colresizing');
    }
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
    wrapEl.addEventListener('dblclick', function (ev) {
      var h = ev.target.closest ? ev.target.closest('.colrz') : null;
      if (!h) return;
      ev.preventDefault();
      ev.stopPropagation();
      autoFitCol(tableOf(), h.getAttribute('data-rz'), wrapId);
    });
    wrapEl.addEventListener('click', function (ev) {
      if (ev.target.closest && ev.target.closest('.colrz')) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    }, true);
  }
  function fgTableOf() { return cur.fgTab === 'L' ? 'fpL' : (cur.fgTab === 'P' ? 'fpP' : 'fpG'); }
  function accTableOf() {
    return cur.accTab === 'R' ? 'accR' : (cur.accTab === 'E' ? 'accE' : (cur.accTab === 'M' ? 'accM' : 'accV'));
  }
  function bindTableClicks(wrapId, handler) {
    var el = $(wrapId);
    if (!el) return;
    el.addEventListener('click', function (ev) {
      var t = ev.target;
      var filtBtn = t.closest ? t.closest('[data-filter]') : null;
      if (filtBtn) {
        ev.preventDefault();
        openFilter(wrapId === 'fgTableWrap' ? fgTableOf() : accTableOf(), filtBtn.getAttribute('data-filter'), filtBtn);
        return;
      }
      handler(ev, t);
    });
  }

  /* ==========================================================================
     v8.3 — 팝업 창 세 가지 동작
       ① 제목 줄(.modal-head)을 잡고 끌면 창이 따라 움직인다. 새 팝업은 늘 가운데에서 시작한다.
       ② 오버레이는 투명·클릭 통과(CSS) — 뒤쪽 표를 보면서 입력한다.
       ③ 왼쪽 메뉴에서 방금 눌렀던 그 메뉴를 한 번 더 누르면 열려 있던 팝업이 닫힌다.
     ========================================================================== */
  var POP_CLOSERS = {
    ioHubModal: function () { closeIoHub(); },
    meatFormModal: function () { closeMeatForm(); },
    fgFormModal: function () { closeFgForm(); },
    fgNewModal: function () { closeFgNew(); },
    photoInboxModal: function () { closePhotoInbox(); },
    accVoucherModal: function () { closeAccVoucher(); },
    reflectModal: function () { closeReflect(); },
    accPayModal: function () { closeAccPay(); },
    stmtModal: function () { closeStmt(); },
    accHelpModal: function () { closeAccHelp(); }
  };
  var POP_ORDER = ['ioHubModal', 'meatFormModal', 'fgFormModal', 'fgNewModal', 'photoInboxModal',
    'accVoucherModal', 'reflectModal', 'accPayModal', 'stmtModal', 'accHelpModal'];

  function popOpen(id) {
    var m = $(id);
    return !!m && !m.classList.contains('hidden');
  }
  function popClose(id) {
    var f = POP_CLOSERS[id];
    if (f) { try { f(); } catch (e) { } return; }
    var m = $(id);
    if (m) m.classList.add('hidden');
  }
  /* 다른 팝업을 열 때 먼저 떠 있던 팝업은 닫아, 창이 겹쳐 쌓이지 않게 한다 */
  function popCloseOthers(keepId) {
    for (var i = 0; i < POP_ORDER.length; i++) {
      if (POP_ORDER[i] === keepId) continue;
      if (popOpen(POP_ORDER[i])) popClose(POP_ORDER[i]);
    }
  }
  function markSidePop(el) {
    var on = document.querySelectorAll('#v8Side .popon');
    for (var i = 0; i < on.length; i++) on[i].classList.remove('popon');
    if (el && el.classList) el.classList.add('popon');
  }
  /* 목록에서 현황으로 넘어갈 때 그 카드를 한 번 번쩍이게 한다 */
  function flashEl(el) {
    if (!el || !el.classList) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(function () { if (el.classList) el.classList.remove('flash'); }, 1400);
  }
  /* 이미 그 팝업이 열려 있으면 닫고 true. 아니면 다른 팝업을 닫고 false(이어서 연다). */
  function sidePopToggle(el, key, id) {
    if (popOpen(id) && cur.sidePop === key) {
      popClose(id);
      cur.sidePop = ''; cur.sidePopId = '';
      markSidePop(null);
      return true;
    }
    popCloseOthers(id);
    cur.sidePop = key; cur.sidePopId = id;
    markSidePop(el);
    return false;
  }
  /* 팝업이 닫히면(✕·ESC·저장 후) 메뉴 강조도 같이 지운다 */
  function popForgot(id) {
    if (cur.sidePopId !== id) return;
    cur.sidePop = ''; cur.sidePopId = '';
    markSidePop(null);
  }

  /* ---------- ① 팝업 창 드래그 이동 ---------- */
  var DRAG = { card: null, head: null, baseL: 0, baseT: 0, w: 0, h: 0, px: 0, py: 0, tx: 0, ty: 0 };

  function popClamp(d, tx, ty) {
    var M = 6, vw = window.innerWidth, vh = window.innerHeight;
    var minX = M - d.baseL, maxX = vw - M - d.baseL - d.w;
    if (maxX < minX) tx = (vw - d.w) / 2 - d.baseL;           /* 창이 화면보다 넓으면 가운데 */
    else tx = Math.max(minX, Math.min(maxX, tx));
    var minY = M - d.baseT, maxY = vh - M - d.baseT - d.h;
    if (maxY < minY) ty = (vh - d.h) / 2 - d.baseT;
    else ty = Math.max(minY, Math.min(maxY, ty));
    return [Math.round(tx), Math.round(ty)];
  }
  function popMove(card, tx, ty) {
    card._px = tx || 0; card._py = ty || 0;
    card.style.transform = (tx || ty) ? 'translate(' + tx + 'px,' + ty + 'px)' : '';
  }
  function popBindDrag(m) {
    var card = m.querySelector('.modal-card');
    if (!card) return;
    var head = card.querySelector('.modal-head');
    if (!head) return;
    head.classList.add('popgrab');
    head.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      var t = ev.target;
      if (t && t.closest && t.closest('button,a,input,textarea,select,label,option')) return;
      var r = card.getBoundingClientRect();
      var tx = card._px || 0, ty = card._py || 0;
      DRAG.card = card; DRAG.head = head;
      DRAG.baseL = r.left - tx; DRAG.baseT = r.top - ty;
      DRAG.w = r.width; DRAG.h = r.height;
      DRAG.px = ev.clientX; DRAG.py = ev.clientY;
      DRAG.tx = tx; DRAG.ty = ty;
      card.classList.add('popmoving');
      head.classList.add('grabbing');
      try { head.setPointerCapture(ev.pointerId); } catch (e) { }
      ev.preventDefault();
    });
    head.addEventListener('pointermove', function (ev) {
      if (DRAG.card !== card) return;
      var c = popClamp(DRAG, DRAG.tx + (ev.clientX - DRAG.px), DRAG.ty + (ev.clientY - DRAG.py));
      popMove(card, c[0], c[1]);
      ev.preventDefault();
    });
    function endDrag() {
      if (DRAG.card !== card) return;
      card.classList.remove('popmoving');
      head.classList.remove('grabbing');
      DRAG.card = null; DRAG.head = null;
    }
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);
  }
  function popInit() {
    var ms = document.querySelectorAll('.modal');
    for (var i = 0; i < ms.length; i++) {
      (function (m) {
        popBindDrag(m);
        var card = m.querySelector('.modal-card');
        var wasHidden = m.classList.contains('hidden');
        function sync() {
          var hid = m.classList.contains('hidden');
          if (hid === wasHidden) return;
          wasHidden = hid;
          if (!hid) { if (card) popMove(card, 0, 0); }   /* 새 팝업은 기본 위치(가운데)에서 */
          else popForgot(m.id);
        }
        if (window.MutationObserver) new MutationObserver(sync).observe(m, { attributes: true, attributeFilter: ['class'] });
      })(ms[i]);
    }
    /* 창 크기가 바뀌면 옮겨 둔 팝업이 화면 밖에 남지 않게 다시 붙잡아 준다 */
    window.addEventListener('resize', function () {
      var cards = document.querySelectorAll('.modal:not(.hidden) .modal-card');
      for (var j = 0; j < cards.length; j++) {
        var card = cards[j];
        if (!card._px && !card._py) continue;
        var r = card.getBoundingClientRect();
        var d = { baseL: r.left - (card._px || 0), baseT: r.top - (card._py || 0), w: r.width, h: r.height };
        var c = popClamp(d, card._px || 0, card._py || 0);
        popMove(card, c[0], c[1]);
      }
    });
  }

  function bindV4Events() {
    /* v8: 단일 통합 사이드바 — 6대 메뉴 */
    var cats = document.querySelectorAll('#v8Nav .v8cat');
    for (var ci = 0; ci < cats.length; ci++) {
      cats[ci].addEventListener('click', function () {
        var cat = this.getAttribute('data-cat');
        /* v8.4: 펼쳐진 대메뉴를 한 번 더 누르면 하위 목록이 접히고,
           그 대메뉴가 열어 둔 팝업(1번 허브 포함)도 함께 닫힌다 */
        if (groupOpen(cat)) {
          closeAllGroups();
          closeCatPop(cat);
          return;
        }
        if (cat === 'io') {
          /* v8.5: 1번 대메뉴는 다른 대메뉴와 같게 하위 메뉴 목록만 펼친다.
             입출고 입력 허브(ioHubModal)는 자동으로 띄우지 않는다 */
          openGroup('io');
          return;
        }
        openGroup(cat);
        if (cat === 'stock') setStockView(cur.tab === 'H' ? 'hist' : (cur.tab === 'V' ? 'price' : 'meat'), true);
        else setPane(cat === 'acc' ? 'acc' : cat, { keepGroup: true });
      });
    }
    var ioBtns = document.querySelectorAll('#v8Side [data-io]');
    for (var io = 0; io < ioBtns.length; io++) {
      ioBtns[io].addEventListener('click', function () {
        var a = this.getAttribute('data-io');
        var pid = a === 'photo' ? 'photoInboxModal'
          : (a === 'fp-new' ? 'fgNewModal' : ((a === 'fp-in' || a === 'fp-out') ? 'fgFormModal'
            : ((a === 'sheet-in' || a === 'sheet-out') ? 'ioSheetModal' : 'meatFormModal')));
        if (sidePopToggle(this, 'io:' + a, pid)) { closeMobileGroups(); return; }  /* 같은 메뉴 재클릭 → 닫기 */
        doIoAction(a);
        /* 입력 팝업이 뜨면 오른쪽 화면(창고 표)으로 넘어가면서 이 메뉴가 접힌다 →
           방금 누른 메뉴를 다시 누를 수 있게 입력 메뉴는 펼쳐 둔다 (PC에서만) */
        if (window.innerWidth > 768) openGroup('io');
      });
    }
    var ioHubBtns = document.querySelectorAll('#ioHubModal [data-io]');
    for (var ih = 0; ih < ioHubBtns.length; ih++) {
      ioHubBtns[ih].addEventListener('click', function () { doIoAction(this.getAttribute('data-io')); });
    }
    if ($('ioHubClose')) $('ioHubClose').addEventListener('click', closeIoHub);
    if ($('ioHubModal')) $('ioHubModal').addEventListener('click', function (ev) { if (ev.target === this) closeIoHub(); });

    var stockBtns = document.querySelectorAll('[data-stock]');
    for (var sb2 = 0; sb2 < stockBtns.length; sb2++) {
      stockBtns[sb2].addEventListener('click', function (ev) {
        ev.preventDefault();
        var key = this.getAttribute('data-stock');
        if (key === 'fg' && this.getAttribute('data-ftab') === 'L') { setHist('fg'); return; }
        if (key === 'hist' && this.getAttribute('data-ftab') === 'L') { setHist('fg'); closeMobileGroups(); return; }
        setStockView(key);
        closeMobileGroups();
      });
    }
    var histBtns = document.querySelectorAll('#histSwitch [data-hist]');
    for (var hb = 0; hb < histBtns.length; hb++) {
      histBtns[hb].addEventListener('click', function () { setHist(this.getAttribute('data-hist')); closeMobileGroups(); });
    }

    /* 구매관리 */
    var buyBtns = document.querySelectorAll('#v8Side [data-buy]');
    for (var bb = 0; bb < buyBtns.length; bb++) {
      buyBtns[bb].addEventListener('click', function () {
        var a = this.getAttribute('data-buy');
        openGroup('buy');
        var pid = a === 'new' ? 'accVoucherModal' : (a === 'reflect' ? 'reflectModal' : (a === 'pay' ? 'accPayModal' : ''));
        if (pid && sidePopToggle(this, 'buy:' + a, pid)) { closeMobileGroups(); return; }
        /* v9 — 미지급금 현황: 입력창 없이 카드 + 거래처별 원장으로 바로 간다 */
        if (a === 'status') {
          cur.buyView = 'status';
          popCloseOthers(''); cur.sidePop = ''; cur.sidePopId = ''; markSidePop(null);
          setPane('buy');
          closeMobileGroups();
          var card = $('buyPayCard');
          if (card) {
            try { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { card.scrollIntoView(); }
            flashEl(card);
          }
          return;
        }
        cur.buyView = 'list';
        if (a === 'new') { setPane('buy'); openAccVoucher('purchase', null, 'buy'); return; }
        if (a === 'reflect') { setPane('buy'); openReflect('purchase'); return; }
        if (a === 'pay') { setPane('buy'); openAccPay('out', ''); closeMobileGroups(); return; }
        setPane('buy');
        closeMobileGroups();
      });
    }
    if ($('btnBuyNew')) $('btnBuyNew').addEventListener('click', function () { openAccVoucher('purchase', null, 'buy'); });
    if ($('btnBuyReflect')) $('btnBuyReflect').addEventListener('click', function () { openReflect('purchase'); });
    if ($('btnBuyPay')) $('btnBuyPay').addEventListener('click', function () { openAccPay('out', ''); });
    if ($('btnBuyStatusPay')) $('btnBuyStatusPay').addEventListener('click', function () { openAccPay('out', ''); });
    if ($('btnBuyStatusLedger')) $('btnBuyStatusLedger').addEventListener('click', function () {
      cur.accTab = 'R'; cur.accSearch = ''; if ($('accSearch')) $('accSearch').value = ''; setPane('acc');
    });
    ['buyPayStatusWrap', 'buyPayLogWrap'].forEach(function (id) {
      if ($(id)) $(id).addEventListener('click', function (ev) { balanceStatusClick(ev, ev.target, 'buy'); });
    });
    if ($('buySearch')) $('buySearch').addEventListener('input', function () { cur.buySearch = this.value; renderBuy(); });
    if ($('buyBtnSearch')) $('buyBtnSearch').addEventListener('click', function () { cur.buySearch = $('buySearch').value || ''; renderBuy(); });
    if ($('buyBtnPeriod')) $('buyBtnPeriod').addEventListener('click', openRange);
    if ($('buyRangeDisplay')) $('buyRangeDisplay').addEventListener('click', openRange);
    if ($('buyRangeClear')) $('buyRangeClear').addEventListener('click', function () { cur.buyRange = { preset: 'all', from: '', to: '' }; renderRangeBar(); renderBuy(); });
    ['buyFrom', 'buyTo'].forEach(function (id) {
      if (!$(id)) return;
      $(id).addEventListener('change', function () { setCustomRange('buyFrom', 'buyTo'); });
      $(id).addEventListener('mousedown', function (ev) { ev.preventDefault(); openRange(); });
      $(id).addEventListener('focus', function () { if (!rngm.open) openRange(); });
    });
    if ($('btnBuyColReset')) $('btnBuyColReset').addEventListener('click', function () { COLW.accB = {}; COLW.accS = {}; saveColW(); renderBuy(); toast('열 너비를 기본값으로 돌렸습니다.', 'ok'); });

    /* 판매관리 */
    var saleBtns = document.querySelectorAll('#v8Side [data-sale]');
    for (var sl = 0; sl < saleBtns.length; sl++) {
      saleBtns[sl].addEventListener('click', function () {
        var a = this.getAttribute('data-sale');
        openGroup('sale');
        var pid = a === 'new' ? 'accVoucherModal' : (a === 'reflect' ? 'reflectModal'
          : (a === 'pay' ? 'accPayModal' : (a === 'stmt' ? 'stmtModal' : '')));
        if (pid && sidePopToggle(this, 'sale:' + a, pid)) { closeMobileGroups(); return; }
        /* v9 — 미수금 현황: 입력창 없이 카드 + 거래처별 원장으로 바로 간다 */
        if (a === 'status') {
          cur.saleView = 'status';
          popCloseOthers(''); cur.sidePop = ''; cur.sidePopId = ''; markSidePop(null);
          setPane('sale');
          closeMobileGroups();
          var card2 = $('saleRecvCard');
          if (card2) {
            try { card2.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { card2.scrollIntoView(); }
            flashEl(card2);
          }
          return;
        }
        cur.saleView = 'list';
        if (a === 'new') { setPane('sale'); openAccVoucher('sale', null, 'sale'); return; }
        if (a === 'reflect') { setPane('sale'); openReflect('sale'); return; }
        if (a === 'pay') { setPane('sale'); openAccPay('in', ''); return; }
        if (a === 'stmt') { setPane('sale'); openSaleStmt(); closeMobileGroups(); return; }
        setPane('sale');
        closeMobileGroups();
      });
    }
    if ($('btnSaleNew')) $('btnSaleNew').addEventListener('click', function () { openAccVoucher('sale', null, 'sale'); });
    if ($('btnSaleReflect')) $('btnSaleReflect').addEventListener('click', function () { openReflect('sale'); });
    if ($('btnSalePay')) $('btnSalePay').addEventListener('click', function () { openAccPay('in', ''); });
    if ($('btnSaleStatusPay')) $('btnSaleStatusPay').addEventListener('click', function () { openAccPay('in', ''); });
    if ($('btnSaleStatusLedger')) $('btnSaleStatusLedger').addEventListener('click', function () {
      cur.accTab = 'R'; cur.accSearch = ''; if ($('accSearch')) $('accSearch').value = ''; setPane('acc');
    });
    ['saleRecvStatusWrap', 'saleRecvLogWrap'].forEach(function (id) {
      if ($(id)) $(id).addEventListener('click', function (ev) { balanceStatusClick(ev, ev.target, 'sale'); });
    });
    if ($('btnSaleStmt')) $('btnSaleStmt').addEventListener('click', openSaleStmt);
    if ($('saleSearch')) $('saleSearch').addEventListener('input', function () { cur.saleSearch = this.value; renderSale(); });
    if ($('saleBtnSearch')) $('saleBtnSearch').addEventListener('click', function () { cur.saleSearch = $('saleSearch').value || ''; renderSale(); });
    if ($('saleBtnPeriod')) $('saleBtnPeriod').addEventListener('click', openRange);
    if ($('saleRangeDisplay')) $('saleRangeDisplay').addEventListener('click', openRange);
    if ($('saleRangeClear')) $('saleRangeClear').addEventListener('click', function () { cur.saleRange = { preset: 'all', from: '', to: '' }; renderRangeBar(); renderSale(); });
    ['saleFrom', 'saleTo'].forEach(function (id) {
      if (!$(id)) return;
      $(id).addEventListener('change', function () { setCustomRange('saleFrom', 'saleTo'); });
      $(id).addEventListener('mousedown', function (ev) { ev.preventDefault(); openRange(); });
      $(id).addEventListener('focus', function () { if (!rngm.open) openRange(); });
    });
    if ($('btnSaleColReset')) $('btnSaleColReset').addEventListener('click', function () { COLW.accS = {}; saveColW(); renderSale(); toast('열 너비를 기본값으로 돌렸습니다.', 'ok'); });

    /* 생산·원가 */
    var prodBtns = document.querySelectorAll('#v8Side [data-prod]');
    for (var pb = 0; pb < prodBtns.length; pb++) {
      prodBtns[pb].addEventListener('click', function () {
        cur.prodView = this.getAttribute('data-prod');
        openGroup('prod');
        setPane('prod');
        closeMobileGroups();
        if (cur.prodView === 'cost') {
          var el = $('prodCostWrap');
          if (el) { try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { el.scrollIntoView(); } }
        }
      });
    }
    var pseg = document.querySelectorAll('#prodPeriodSeg button');
    for (var ps = 0; ps < pseg.length; ps++) {
      pseg[ps].addEventListener('click', function () {
        cur.prodPeriod = this.getAttribute('data-prodperiod') === 'month' ? 'month' : 'day';
        renderProd();
      });
    }
    if ($('prodBtnPeriod')) $('prodBtnPeriod').addEventListener('click', openRange);
    if ($('prodRangeDisplay')) $('prodRangeDisplay').addEventListener('click', openRange);
    if ($('prodRangeClear')) $('prodRangeClear').addEventListener('click', function () { cur.prodRange = { preset: 'all', from: '', to: '' }; renderRangeBar(); renderProd(); });
    if ($('prodBtnSearch')) $('prodBtnSearch').addEventListener('click', function () { renderProd(); });
    ['prodFrom', 'prodTo'].forEach(function (id) {
      if (!$(id)) return;
      $(id).addEventListener('change', function () { setCustomRange('prodFrom', 'prodTo'); });
      $(id).addEventListener('mousedown', function (ev) { ev.preventDefault(); openRange(); });
      $(id).addEventListener('focus', function () { if (!rngm.open) openRange(); });
    });

    /* 회계 메뉴 */
    var accBtns = document.querySelectorAll('#v8Side [data-acc]');
    for (var ab = 0; ab < accBtns.length; ab++) {
      accBtns[ab].addEventListener('click', function () {
        var a = this.getAttribute('data-acc');
        openGroup('acc');
        if (a === 'help') {
          if (sidePopToggle(this, 'acc:help', 'accHelpModal')) return;   /* 같은 메뉴 재클릭 → 닫기 */
          openAccHelp(); return;
        }
        cur.accTab = this.getAttribute('data-atab') || 'V';
        setPane('acc');
        markSide('acc', { key: 'data-atab', val: cur.accTab });
        var pt = document.querySelectorAll('#accPaneTabs .tab');
        for (var i = 0; i < pt.length; i++) pt[i].classList.toggle('active', pt[i].getAttribute('data-atab') === cur.accTab);
        renderAccTable();
        closeMobileGroups();
      });
    }
    if ($('qbForm')) $('qbForm').addEventListener('click', openIoHub);
    if ($('qbList')) $('qbList').addEventListener('click', scrollPanel);

    if ($('meatFormClose')) $('meatFormClose').addEventListener('click', closeMeatForm);
    if ($('meatFormModal')) $('meatFormModal').addEventListener('click', function (ev) {
      if (ev.target === this) closeMeatForm();
    });
    if ($('fgFormClose')) $('fgFormClose').addEventListener('click', closeFgForm);
    if ($('fgFormModal')) $('fgFormModal').addEventListener('click', function (ev) {
      if (ev.target === this) closeFgForm();
    });

    /* 회계 사용법 · 4종 입출금 */
    if ($('btnAccHelp')) $('btnAccHelp').addEventListener('click', openAccHelp);
    if ($('accHelpClose')) $('accHelpClose').addEventListener('click', closeAccHelp);
    if ($('accHelpClose2')) $('accHelpClose2').addEventListener('click', closeAccHelp);
    if ($('accHelpModal')) $('accHelpModal').addEventListener('click', function (ev) { if (ev.target === this) closeAccHelp(); });
    if ($('accHelpGoSale')) $('accHelpGoSale').addEventListener('click', function () { closeAccHelp(); openAccVoucher('sale'); });
    if ($('btnAccExtraIn')) $('btnAccExtraIn').addEventListener('click', function () { openAccExpense(null, 'income'); });

    /* 거래명세표 · 공급자 정보 */
    if ($('stmtClose')) $('stmtClose').addEventListener('click', closeStmt);
    if ($('stmtPrint')) $('stmtPrint').addEventListener('click', printStmt);
    if ($('stmtSupBtn')) $('stmtSupBtn').addEventListener('click', openSupplier);
    if ($('stmtModal')) $('stmtModal').addEventListener('click', function (ev) { if (ev.target === this) closeStmt(); });
    if ($('supplierClose')) $('supplierClose').addEventListener('click', closeSupplier);
    if ($('supplierCancel')) $('supplierCancel').addEventListener('click', closeSupplier);
    if ($('supplierSave')) $('supplierSave').addEventListener('click', saveSupplier);
    /* v8.1 — 직인 이미지 · 공급받는자 칸 */
    if ($('supplierModal')) $('supplierModal').addEventListener('click', function (ev) { if (ev.target === this) closeSupplier(); });
    if ($('stmtModal')) $('stmtModal').addEventListener('click', function (ev) { if (ev.target === this) closeStmt(); });
    if ($('supStampPick')) $('supStampPick').addEventListener('click', function () { if ($('supStampFile')) $('supStampFile').click(); });
    if ($('supStampFile')) $('supStampFile').addEventListener('change', pickStampFile);
    if ($('supStampReset')) $('supStampReset').addEventListener('click', resetStamp);
    var bEdit = ['stmtBuyerName', 'stmtBuyerBizNo', 'stmtBuyerOwner', 'stmtBuyerTel', 'stmtBuyerAddr', 'stmtBuyerFax'];
    for (var bi = 0; bi < bEdit.length; bi++) {
      if ($(bEdit[bi])) $(bEdit[bi]).addEventListener('input', function () { stmtEditBuyer(); });
    }
    if ($('supplierModal')) $('supplierModal').addEventListener('click', function (ev) { if (ev.target === this) closeSupplier(); });

    /* 완제품 탭 */
    var ftabs = document.querySelectorAll('#fgTabs .tab');
    for (var i = 0; i < ftabs.length; i++) {
      ftabs[i].addEventListener('click', function () {
        cur.fgTab = this.getAttribute('data-ftab');
        cur.fgLimit = 300;
        for (var k = 0; k < ftabs.length; k++) ftabs[k].classList.toggle('active', ftabs[k] === this);
        closeFilter();
        closeFgForm();
        renderRangeBar();
        renderFgTable();
        $('fgTableWrap').scrollTop = 0;
        $('fgTableWrap').scrollLeft = 0;
      });
    }
    var fm = document.querySelectorAll('#fgFormPanel .fmode');
    for (var j = 0; j < fm.length; j++) {
      fm[j].addEventListener('click', function () { setFgType(this.getAttribute('data-ftype')); });
    }
    var fsrc = document.querySelectorAll('#fgSrcSeg button');
    for (var js = 0; js < fsrc.length; js++) {
      fsrc[js].addEventListener('click', function () { setFgSrc(this.getAttribute('data-src')); });
    }
    var fuse = document.querySelectorAll('#fgUseSeg button');
    for (var ju = 0; ju < fuse.length; ju++) {
      fuse[ju].addEventListener('click', function () { setFgUse(this.getAttribute('data-use')); });
    }
    if ($('fgDate')) $('fgDate').addEventListener('change', renderFgProdRef);
    if ($('fgForm')) $('fgForm').addEventListener('submit', function (e) { e.preventDefault(); fgSubmit(); });
    if ($('btnFgFind')) $('btnFgFind').addEventListener('click', function () { fgPickProduct(false); });
    if ($('fgQuery')) {
      $('fgQuery').addEventListener('change', function () { fgPickProduct(false); });
      $('fgQuery').addEventListener('input', function () { cur.fgCode = ''; renderFgInfo(); });
    }
    if ($('fgQty')) $('fgQty').addEventListener('input', fgSyncAmount);
    if ($('fgPrice')) $('fgPrice').addEventListener('input', fgSyncAmount);
    if ($('btnFgNew')) $('btnFgNew').addEventListener('click', function () { openFgNew(null); });
    if ($('fgNewClose')) $('fgNewClose').addEventListener('click', closeFgNew);
    if ($('fgNewCancel')) $('fgNewCancel').addEventListener('click', closeFgNew);
    if ($('fgNewSave')) $('fgNewSave').addEventListener('click', saveFgNew);
    if ($('fgNewModal')) $('fgNewModal').addEventListener('click', function (ev) { if (ev.target === this) closeFgNew(); });
    if ($('btnFgCatAdd')) $('btnFgCatAdd').addEventListener('click', addFgCat);
    var chips = document.querySelectorAll('#fgCatBar [data-fgcat]');
    for (var c = 0; c < chips.length; c++) {
      chips[c].addEventListener('click', function () {
        cur.fgCat = this.getAttribute('data-fgcat');
        cur.fgLimit = 300;
        renderFgCatBar();
        renderFgTable();
      });
    }
    if ($('fgCatBar')) $('fgCatBar').addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-fgcat]') : null;
      if (!b || b.id === 'btnFgCatAdd') return;
      cur.fgCat = b.getAttribute('data-fgcat');
      cur.fgLimit = 300;
      renderFgCatBar();
      renderFgTable();
    });
    if ($('fgSearch')) {
      $('fgSearch').addEventListener('input', function () { cur.fgSearch = this.value; cur.fgLimit = 300; renderFgTable(); });
      $('fgSearch').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); doSearch('fgSearch'); } });
    }
    if ($('fgShowZero')) $('fgShowZero').addEventListener('change', function () { cur.fgShowZero = this.checked; cur.fgLimit = 300; renderFgTable(); });
    if ($('fgLogFilter')) $('fgLogFilter').addEventListener('change', function () { cur.fgTypeF = this.value; cur.fgLimit = 300; renderFgTable(); });
    if ($('btnFgResetFilters')) $('btnFgResetFilters').addEventListener('click', function () {
      cur.fFgG = {}; cur.fFgL = {}; cur.fFgP = {}; renderFgTable();
    });
    if ($('btnFgColReset')) $('btnFgColReset').addEventListener('click', function () { resetColWidth('fg'); });
    if ($('fgBtnSearch')) $('fgBtnSearch').addEventListener('click', function () { doSearch('fgSearch'); });
    if ($('fgRangeClear')) $('fgRangeClear').addEventListener('click', function () { setPreset('all'); });
    if ($('fgBtnPeriod')) $('fgBtnPeriod').addEventListener('click', openRange);
    if ($('fgRangeDisplay')) $('fgRangeDisplay').addEventListener('click', openRange);
    ['fgFrom', 'fgTo'].forEach(function (id) {
      $(id).addEventListener('change', function () { setCustomRange('fgFrom', 'fgTo'); });
      $(id).addEventListener('mousedown', function (ev) { ev.preventDefault(); openRange(); });
      $(id).addEventListener('focus', function () { if (!rngm.open) openRange(); });
    });
    var fpresets = document.querySelectorAll('#fgPresets .pr');
    for (var p1 = 0; p1 < fpresets.length; p1++) {
      fpresets[p1].addEventListener('click', function () { setPreset(this.getAttribute('data-preset')); });
    }
    if ($('btnFgTpl')) $('btnFgTpl').addEventListener('click', fgTxTemplate);
    if ($('btnFgPriceTpl')) $('btnFgPriceTpl').addEventListener('click', fgPriceTemplate);
    if ($('btnFgStockXls')) $('btnFgStockXls').addEventListener('click', fgStockXls);
    if ($('btnFgLogXls')) $('btnFgLogXls').addEventListener('click', fgLogXls);
    if ($('btnFgUpload')) $('btnFgUpload').addEventListener('click', function () { openUpload('fp_tx'); });
    if ($('btnFgPriceUpload')) $('btnFgPriceUpload').addEventListener('click', function () { openUpload('fp_price'); });
    if ($('uploadClose')) $('uploadClose').addEventListener('click', closeUpload);
    if ($('uploadCancel')) $('uploadCancel').addEventListener('click', closeUpload);
    if ($('uploadFile')) $('uploadFile').addEventListener('change', handleUploadFile);
    if ($('uploadGo')) $('uploadGo').addEventListener('click', doUpload);
    if ($('uploadModal')) $('uploadModal').addEventListener('click', function (ev) { if (ev.target === this) closeUpload(); });
    if ($('fgPriceClose')) $('fgPriceClose').addEventListener('click', closeFgPrice);
    if ($('fgPriceCancel')) $('fgPriceCancel').addEventListener('click', closeFgPrice);
    if ($('fgPriceSave')) $('fgPriceSave').addEventListener('click', saveFgPrice);
    if ($('fgPriceModal')) $('fgPriceModal').addEventListener('click', function (ev) { if (ev.target === this) closeFgPrice(); });

    bindResize('fgTableWrap', fgTableOf);
    bindTableClicks('fgTableWrap', function (ev, t) {
      var fgMenu = t.closest ? t.closest('[data-menu="fg"]') : null;
      if (fgMenu) {
        ev.preventDefault(); ev.stopPropagation();
        var fc = fgMenu.getAttribute('data-fgcode');
        openRowMenu(fgMenu, [
          { label: '입고', act: 'fgin', code: fc },
          { label: '출고', act: 'fgout', code: fc },
          { label: '수정', act: 'fgedit', code: fc }
        ]);
        return;
      }
      var fin = t.closest ? t.closest('[data-fgin]') : null;
      if (fin) { ev.preventDefault(); openFgFor(fin.getAttribute('data-fgin'), 'IN'); return; }
      var fout = t.closest ? t.closest('[data-fgout]') : null;
      if (fout) { ev.preventDefault(); openFgFor(fout.getAttribute('data-fgout'), 'OUT'); return; }
      var price = t.closest ? t.closest('[data-fgprice]') : null;
      if (price) { openFgPrice(price.getAttribute('data-fgprice')); return; }
      var edit = t.closest ? t.closest('[data-fgedit]') : null;
      if (edit) { openFgNew(edit.getAttribute('data-fgedit')); return; }
      var undoBtn = t.closest ? t.closest('[data-fgundo]') : null;
      if (undoBtn) { fgUndo(Number(undoBtn.getAttribute('data-fgundo')), undoBtn); return; }
      var stmtBtn = t.closest ? t.closest('[data-fgstmt]') : null;
      if (stmtBtn) {
        var sid = Number(stmtBtn.getAttribute('data-fgstmt'));
        var sg = null;
        for (var si = 0; si < st.fpLogs.length; si++) if (Number(st.fpLogs[si].id) === sid) sg = st.fpLogs[si];
        if (sg) openStmt('fp', sg);
        return;
      }
      var row = t.closest ? t.closest('tr.fgrow') : null;
      if (row) {
        var code = row.getAttribute('data-fgcode');
        if (code && cur.fgTab !== 'L') {
          var pr = ERP.fpProductOf(st.fps, code);
          if (pr && !pr.undone) {
            $('fgQuery').value = pr.code + ' · ' + pr.n;
            cur.fgCode = pr.code;
            renderFgInfo();
            fgSyncAmount();
            openFgForm(cur.fgType);   /* v7: 입력은 팝업으로 */
          }
        }
      }
    });

    /* 회계 탭 */
    var atabs = document.querySelectorAll('#accPaneTabs .tab');
    for (var a1 = 0; a1 < atabs.length; a1++) {
      atabs[a1].addEventListener('click', function () {
        cur.accTab = this.getAttribute('data-atab');
        cur.accLimit = 300;
        for (var k = 0; k < atabs.length; k++) atabs[k].classList.toggle('active', atabs[k] === this);
        closeFilter();
        renderRangeBar();
        updatePageHead();
        renderAccTable();
        markSide('acc', { key: 'data-atab', val: cur.accTab });
        $('accTableWrap').scrollTop = 0;
        $('accTableWrap').scrollLeft = 0;
      });
    }
    if ($('accSearch')) {
      $('accSearch').addEventListener('input', function () { cur.accSearch = this.value; cur.accLimit = 300; renderAccTable(); });
      $('accSearch').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); doSearch('accSearch'); } });
    }
    if ($('accTypeFilter')) $('accTypeFilter').addEventListener('change', function () { cur.accType = this.value; cur.accLimit = 300; renderAccTable(); });
    if ($('btnAccResetFilters')) $('btnAccResetFilters').addEventListener('click', function () {
      cur.fAccV = {}; cur.fAccE = {}; renderAccTable();
    });
    if ($('btnAccColReset')) $('btnAccColReset').addEventListener('click', function () { resetColWidth('acc'); });
    if ($('accBtnSearch')) $('accBtnSearch').addEventListener('click', function () { doSearch('accSearch'); });
    if ($('accRangeClear')) $('accRangeClear').addEventListener('click', function () { setPreset('all'); });
    if ($('accBtnPeriod')) $('accBtnPeriod').addEventListener('click', openRange);
    if ($('accRangeDisplay')) $('accRangeDisplay').addEventListener('click', openRange);
    ['accFrom', 'accTo'].forEach(function (id) {
      $(id).addEventListener('change', function () { setCustomRange('accFrom', 'accTo'); });
      $(id).addEventListener('mousedown', function (ev) { ev.preventDefault(); openRange(); });
      $(id).addEventListener('focus', function () { if (!rngm.open) openRange(); });
    });
    var apresets = document.querySelectorAll('#accPresets .pr');
    for (var p2 = 0; p2 < apresets.length; p2++) {
      apresets[p2].addEventListener('click', function () { setPreset(this.getAttribute('data-preset')); });
    }
    if ($('btnAccSale')) $('btnAccSale').addEventListener('click', function () { openAccVoucher('sale'); });
    if ($('btnAccBuy')) $('btnAccBuy').addEventListener('click', function () { openAccVoucher('purchase'); });
    if ($('btnAccPayIn')) $('btnAccPayIn').addEventListener('click', function () { openAccPay('in', ''); });
    if ($('btnAccPayOut')) $('btnAccPayOut').addEventListener('click', function () { openAccPay('out', ''); });
    if ($('btnAccExpense')) $('btnAccExpense').addEventListener('click', function () { openAccExpense(null); });
    if ($('btnAccXls')) $('btnAccXls').addEventListener('click', accXls);
    if ($('btnAccUpload')) $('btnAccUpload').addEventListener('click', function () { openUpload('acc_expense'); });

    /* 전표 모달 — v10 명세서형 다중 품목 */
    if ($('accVoucherSeg')) {
      var vs = $('accVoucherSeg').querySelectorAll('button');
      for (var v1 = 0; v1 < vs.length; v1++) vs[v1].addEventListener('click', function () {
        accVTypeSet(this.getAttribute('data-vtype'));
      });
    }
    if ($('accVAddRow')) $('accVAddRow').addEventListener('click', accVAddLine);
    if ($('accVSheet')) {
      var sheet = $('accVSheet');
      sheet.addEventListener('input', function (ev) {
        var t = ev.target, tr = t.closest ? t.closest('tr[data-r]') : null;
        if (!tr) return;
        var f = t.getAttribute('data-f'), r = accVRow(Number(tr.getAttribute('data-r')));
        if (!r || !f) return;
        if (f === 'name') {
          r.name = t.value;
          if (r.kind === 'meat' && !accVIsBuy()) { r.lotId = null; r.lotWh = ''; }
          if (r.kind === 'fp') r.code = '';
          accVSheetPaint();
        } else if (f === 'qty' || f === 'price') {
          r[f] = t.value;
          accVSheetPaint();
        } else if (f === 'expiry') {
          r.expiry = t.value;
        }
      });
      sheet.addEventListener('change', function (ev) {
        var t = ev.target, tr = t.closest ? t.closest('tr[data-r]') : null;
        if (!tr) return;
        var i = Number(tr.getAttribute('data-r')), r = accVRow(i), f = t.getAttribute('data-f');
        if (!r || !f) return;
        if (f === 'kind') {
          r.kind = (t.value === 'fp' || t.value === 'etc') ? t.value : 'meat';
          r.tax = accVKindTax(r.kind);
          r.lotId = null; r.lotWh = ''; r.code = ''; r.spec = '';
          accVRowRepaint(i);
          return;
        }
        if (f === 'tax') { r.tax = t.value === 'free' ? 'free' : 'tax'; accVSheetPaint(); return; }
        if (f === 'wh') { r.wh = t.value === 'C' ? 'C' : 'F'; return; }
        if (f === 'lot') {
          var parts = String(t.value || '').split('|');
          r.lotId = parts[0] ? Number(parts[0]) : null;
          r.lotWh = parts[1] === 'C' ? 'C' : 'F';
          var pk = accVLotOf(r);
          if (pk) {
            r.name = pk.lot.n;
            if (!(Number(r.price) > 0) && pk.lot.price > 0) r.price = String(Math.round(pk.lot.price));
          }
          accVRowRepaint(i);
          return;
        }
        if (f === 'expiry') { r.expiry = t.value; return; }
        if (f === 'name') { accVRowResolve(i); return; }
      });
      sheet.addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-delrow]') : null;
        if (!b) return;
        ev.preventDefault();
        accVRowDelete(Number(b.getAttribute('data-delrow')));
      });
    }
    if ($('accVTaxSeg')) {
      var ts = $('accVTaxSeg').querySelectorAll('button');
      for (var v2 = 0; v2 < ts.length; v2++) ts[v2].addEventListener('click', function () {
        for (var q = 0; q < ts.length; q++) ts[q].classList.toggle('active', ts[q] === this);
        accVatPreview();
      });
    }
    ['accVAmount', 'accVVatIncluded'].forEach(function (id) {
      if ($(id)) { $(id).addEventListener('input', accVatPreview); $(id).addEventListener('change', accVatPreview); }
    });
    if ($('accVoucherClose')) $('accVoucherClose').addEventListener('click', closeAccVoucher);
    if ($('accVoucherCancel')) $('accVoucherCancel').addEventListener('click', closeAccVoucher);
    if ($('accVoucherSave')) $('accVoucherSave').addEventListener('click', saveAccVoucher);
    if ($('accVoucherModal')) $('accVoucherModal').addEventListener('click', function (ev) { if (ev.target === this) closeAccVoucher(); });

    /* 수금·지급 모달 */
    if ($('accPaySeg')) {
      var ps = $('accPaySeg').querySelectorAll('button');
      for (var p3 = 0; p3 < ps.length; p3++) ps[p3].addEventListener('click', function () {
        accP.type = this.getAttribute('data-ptype');
        for (var q = 0; q < ps.length; q++) ps[q].classList.toggle('active', ps[q] === this);
        $('accPayTitle').textContent = accP.type === 'out' ? '＋ 지급 입력' : '＋ 수금 입력';
        accPayBalRefresh();
      });
    }
    /* v11 — 거래처를 넣으면 남은 미수금·미지급금 표시 · [전액 채우기] */
    if ($('accPPartner')) {
      $('accPPartner').addEventListener('input', accPayBalRefresh);
      $('accPPartner').addEventListener('change', accPayBalRefresh);
    }
    if ($('accPFull')) $('accPFull').addEventListener('click', function () {
      var r = accPayRemain(accP.type, $('accPPartner').value);
      if (r > 0.004) $('accPAmount').value = String(r);
      try { $('accPAmount').focus(); } catch (e) { }
    });
    if ($('accPayClose')) $('accPayClose').addEventListener('click', closeAccPay);
    if ($('accPayCancel')) $('accPayCancel').addEventListener('click', closeAccPay);
    if ($('accPaySave')) $('accPaySave').addEventListener('click', saveAccPay);
    if ($('accPayModal')) $('accPayModal').addEventListener('click', function (ev) { if (ev.target === this) closeAccPay(); });

    /* 경비 모달 */
    if ($('accExpSeg')) {
      var es = $('accExpSeg').querySelectorAll('button');
      for (var e1 = 0; e1 < es.length; e1++) es[e1].addEventListener('click', function () {
        accE.type = this.getAttribute('data-etype');
        for (var q = 0; q < es.length; q++) es[q].classList.toggle('active', es[q] === this);
        updateAccECats();
      });
    }
    if ($('accExpClose')) $('accExpClose').addEventListener('click', closeAccExpense);
    if ($('accECancel')) $('accECancel').addEventListener('click', closeAccExpense);
    if ($('accESave')) $('accESave').addEventListener('click', saveAccExpense);
    if ($('accExpModal')) $('accExpModal').addEventListener('click', function (ev) { if (ev.target === this) closeAccExpense(); });

    /* 일괄 반영 (모달) */
    if ($('btnAccReflect')) $('btnAccReflect').addEventListener('click', function () { openReflect('all'); });
    if ($('accReflectClose')) $('accReflectClose').addEventListener('click', closeReflect);
    if ($('reflectModal')) $('reflectModal').addEventListener('click', function (ev) { if (ev.target === this) closeReflect(); });
    if ($('accReflectList')) $('accReflectList').addEventListener('change', function (ev) {
      var cb = ev.target.closest ? ev.target.closest('[data-reflect]') : null;
      if (!cb) return;
      var parts = cb.getAttribute('data-reflect').split(':');
      toggleReflect(parts[0], parts[1], cb.checked);
    });
    if ($('accReflectAll')) $('accReflectAll').addEventListener('click', function () {
      var list = reflectCandidates(), i;
      var allOn = true;
      for (i = 0; i < list.length; i++) if (!cur.reflectSel[list[i].kind + ':' + list[i].id]) allOn = false;
      cur.reflectSel = {};
      if (!allOn) for (i = 0; i < list.length; i++) cur.reflectSel[list[i].kind + ':' + list[i].id] = 1;
      renderAccReflect();
    });
    if ($('accReflectGo')) $('accReflectGo').addEventListener('click', accReflectGo);
    ['accReflectFrom', 'accReflectTo'].forEach(function (id) {
      if ($(id)) $(id).addEventListener('change', function () {
        cur.accRange.from = $('accReflectFrom').value || '';
        cur.accRange.to = $('accReflectTo').value || '';
        cur.accRange.preset = 'custom';
        renderAccReflect();
        renderRangeBar();
      });
    });

    /* 회계 표 클릭 */
    bindResize('accTableWrap', accTableOf);
    bindTableClicks('accTableWrap', function (ev, t) {
      if (settleClick(t)) return;     /* v11 — 전액 · 바로 수금/지급 저장 */
      var docBtn = t.closest ? t.closest('[data-doc]') : null;
      if (docBtn) { toggleAccDoc(Number(docBtn.getAttribute('data-doc'))); return; }
      var ve = t.closest ? t.closest('[data-vedit]') : null;
      if (ve) {
        var id = Number(ve.getAttribute('data-vedit'));
        var v = null;
        for (var i = 0; i < st.vouchers.length; i++) if (st.vouchers[i].id === id) v = st.vouchers[i];
        if (v) openAccVoucher(v.t, v);
        return;
      }
      var vd = t.closest ? t.closest('[data-vdel]') : null;
      if (vd) { accDelete('v', Number(vd.getAttribute('data-vdel'))); return; }
      var vst = t.closest ? t.closest('[data-vstmt]') : null;
      if (vst) {
        var vsid = Number(vst.getAttribute('data-vstmt'));
        var vv = null;
        for (var vi = 0; vi < st.vouchers.length; vi++) if (Number(st.vouchers[vi].id) === vsid) vv = st.vouchers[vi];
        if (vv) openStmt('voucher', vv);
        return;
      }
      var ee = t.closest ? t.closest('[data-eedit]') : null;
      if (ee) {
        var eid = Number(ee.getAttribute('data-eedit'));
        var e = null;
        for (var i2 = 0; i2 < st.expenses.length; i2++) if (st.expenses[i2].id === eid) e = st.expenses[i2];
        if (e) openAccExpense(e);
        return;
      }
      var ed = t.closest ? t.closest('[data-edel]') : null;
      if (ed) { accDelete('e', Number(ed.getAttribute('data-edel'))); return; }
      var pi = t.closest ? t.closest('[data-payin]') : null;
      if (pi) { openAccPay('in', pi.getAttribute('data-payin')); return; }
      var po = t.closest ? t.closest('[data-payout]') : null;
      if (po) { openAccPay('out', po.getAttribute('data-payout')); return; }
      var pl = t.closest ? t.closest('[data-paylist]') : null;
      if (pl) {
        var pn = pl.getAttribute('data-paylist');
        cur.payOpen[pn] = !cur.payOpen[pn];
        renderAccLedger();
        return;
      }
      var pd = t.closest ? t.closest('[data-pdel]') : null;
      if (pd) { accDelete('p', Number(pd.getAttribute('data-pdel'))); return; }
    });
    /* v11 — 받을돈·줄돈 표의 금액·날짜·수단 입력을 기억하고 남은 금액을 미리 보여 준다 */
    if ($('accTableWrap')) {
      $('accTableWrap').addEventListener('input', settleInput);
      $('accTableWrap').addEventListener('change', settleInput);
    }

    /* v8: 구매·판매·생산 표 */
    bindResize('buyTableWrap', function () { return 'accB'; });
    bindTableClicks('buyTableWrap', voucherPaneClick);
    bindResize('saleTableWrap', function () { return 'accS'; });
    bindTableClicks('saleTableWrap', voucherPaneClick);
    bindResize('prodTableWrap', function () { return cur.prodPeriod === 'month' ? 'prodM' : 'prodD'; });
    bindResize('prodCostWrap', function () { return 'prodC'; });
    ['buyPayList', 'saleRecvList'].forEach(function (id) {
      var box = $(id);
      if (!box) return;
      box.addEventListener('click', function (ev) {
        var t = ev.target;
        var pi = t.closest ? t.closest('[data-payin]') : null;
        if (pi) { openAccPay('in', pi.getAttribute('data-payin')); return; }
        var po = t.closest ? t.closest('[data-payout]') : null;
        if (po) { openAccPay('out', po.getAttribute('data-payout')); return; }
      });
    });
  }

  function bindAppEvents() {
    var modes = document.querySelectorAll('.mode');
    for (var i = 0; i < modes.length; i++) {
      modes[i].addEventListener('click', function () { setMode(this.getAttribute('data-mode')); });
    }
    var tabs = document.querySelectorAll('#meatTabs .tab');
    for (var j = 0; j < tabs.length; j++) {
      tabs[j].addEventListener('click', function () {
        var key = this.getAttribute('data-tab');
        setStockView(key === 'H' ? 'hist' : (key === 'V' ? 'price' : 'meat'));
        closeFilter();
        closeMeatForm();
        if ($('tableWrap')) { $('tableWrap').scrollTop = 0; $('tableWrap').scrollLeft = 0; }
        closeMobileGroups();
      });
    }
    /* 원료육 재고 화면 안의 🧊 냉동고 / ❄️ 냉장고 */
    var whBtns = document.querySelectorAll('#meatWhTabs [data-wh]');
    for (var wb = 0; wb < whBtns.length; wb++) {
      whBtns[wb].addEventListener('click', function () { setMeatWh(this.getAttribute('data-wh')); });
    }
    $('entryForm').addEventListener('submit', function (e) { e.preventDefault(); submit(); });

    /* 표 클릭: 정렬 / 필터 / 행 동작 */
    $('tableWrap').addEventListener('click', function (ev) {
      var t = ev.target;
      var menuBtn = t.closest ? t.closest('[data-menu]') : null;
      if (menuBtn) {
        ev.preventDefault(); ev.stopPropagation();
        if (menuBtn.getAttribute('data-menu') === 'lot') {
          var lot = ERP.getLot(st, menuBtn.getAttribute('data-lot'));
          if (lot) openRowMenu(menuBtn, stockMenuItems(lot, menuBtn.getAttribute('data-wh') || cur.tab));
        } else {
          var le0 = ERP.getLog(st, menuBtn.getAttribute('data-log'));
          if (le0) openRowMenu(menuBtn, logMenuItems(le0));
        }
        return;
      }
      var filtBtn = t.closest ? t.closest('[data-filter]') : null;
      if (filtBtn) {
        ev.preventDefault();
        openFilter(tblOf(cur.tab), filtBtn.getAttribute('data-filter'), filtBtn);
        return;
      }
      var und = t.closest ? t.closest('[data-undo]') : null;
      if (und) {
        ev.stopPropagation();
        undoEntry(Number(und.getAttribute('data-undo')), und);
        return;
      }
      var ed = t.closest ? t.closest('[data-edit]') : null;
      if (ed) {
        ev.stopPropagation();
        openEdit(Number(ed.getAttribute('data-edit')));
        return;
      }
      var le = t.closest ? t.closest('[data-lot-edit]') : null;
      if (le) {
        ev.stopPropagation();
        openLot(le.getAttribute('data-lot-edit'));
        return;
      }
      var act = t.closest ? t.closest('[data-act]') : null;
      if (act) {
        ev.stopPropagation();
        bindLot(act.getAttribute('data-lot'), act.getAttribute('data-act'));
        return;
      }
      var tr = t.closest ? t.closest('tr.lot') : null;
      if (tr) bindLot(tr.getAttribute('data-lot'), null);
    });

    $('search').addEventListener('input', function () { cur.search = this.value; cur.hLimit = 250; renderTable(); });
    $('search').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); doSearch(); }
    });
    $('btnSearch').addEventListener('click', doSearch);
    $('showZero').addEventListener('change', function () { cur.showZero = this.checked; renderTable(); });
    $('typeFilter').addEventListener('change', function () { cur.hFilter = this.value; cur.hLimit = 250; renderTable(); });
    $('btnResetFilters').addEventListener('click', function () {
      cur.fLot = {}; cur.fLog = {};
      renderTable();
    });
    $('btnColReset').addEventListener('click', resetColWidth);

    var presets = document.querySelectorAll('#rangePresets .pr');
    for (var p = 0; p < presets.length; p++) {
      presets[p].addEventListener('click', function () { setPreset(this.getAttribute('data-preset')); });
    }
    ['rangeFrom', 'rangeTo'].forEach(function (id) {
      $(id).addEventListener('change', function () { setCustomRange('rangeFrom', 'rangeTo'); });
      /* 날짜칸을 눌러도 2개월 달력이 열린다 (브라우저 기본 달력 대신) */
      $(id).addEventListener('mousedown', function (ev) { ev.preventDefault(); openRange(); });
      $(id).addEventListener('focus', function () { if (!rngm.open) openRange(); });
    });
    $('rangeClear').addEventListener('click', function () { setPreset('all'); });

    /* 기간 선택 달력 팝업 */
    $('btnPeriod').addEventListener('click', openRange);
    if ($('rangeDisplay')) $('rangeDisplay').addEventListener('click', openRange);
    $('rmClose').addEventListener('click', closeRange);
    $('rmCancel').addEventListener('click', closeRange);
    $('rmApply').addEventListener('click', applyRange);
    $('rangeModal').addEventListener('click', function (ev) { if (ev.target === this) closeRange(); });
    $('rmPrevY').addEventListener('click', function () {
      rngm.year -= 1;
      rngm.calL = shiftMonth(rngm.calL.y, rngm.calL.m, -12);
      rngm.calR = shiftMonth(rngm.calR.y, rngm.calR.m, -12);
      renderRangeModal();
    });
    $('rmNextY').addEventListener('click', function () {
      rngm.year += 1;
      rngm.calL = shiftMonth(rngm.calL.y, rngm.calL.m, 12);
      rngm.calR = shiftMonth(rngm.calR.y, rngm.calR.m, 12);
      renderRangeModal();
    });
    ['rmQ1', 'rmQ2', 'rmQ3'].forEach(function (id) {
      $(id).addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-period]') : null;
        if (!b) return;
        quickPeriod(b.getAttribute('data-period'));
      });
    });
    ['rmCalL', 'rmCalR'].forEach(function (id) {
      var box = $(id);
      box.addEventListener('click', function (ev) {
        var t2 = ev.target;
        var nav = t2.closest ? t2.closest('[data-step]') : null;
        if (nav) {
          var w = nav.getAttribute('data-cal');
          var c = w === 'L' ? rngm.calL : rngm.calR;
          var nx = shiftMonth(c.y, c.m, Number(nav.getAttribute('data-step')));
          if (w === 'L') rngm.calL = nx; else rngm.calR = nx;
          renderRangeModal();
          return;
        }
        var day = t2.closest ? t2.closest('[data-day]') : null;
        if (day) { ev.preventDefault(); pickDay(day.getAttribute('data-day')); }
      });
      box.addEventListener('change', function (ev) {
        var sel = ev.target;
        if (!sel || !sel.getAttribute) return;
        var w = sel.getAttribute('data-cal');
        var c = w === 'L' ? rngm.calL : rngm.calR;
        if (sel.classList.contains('cal-y')) c.y = Number(sel.value);
        else if (sel.classList.contains('cal-m')) c.m = Number(sel.value);
        renderRangeModal();
      });
    });

    /* 열 너비: 머리글 오른쪽 경계 드래그 / 더블클릭 = 내용에 맞춤 */
    bindColResize();

    /* 필터 팝오버 */
    $('fpopSearch').addEventListener('input', function () { fpop.q = this.value; renderFpop(); });
    $('fpopList').addEventListener('change', function (ev) {
      var cb = ev.target;
      if (!cb || !cb.getAttribute) return;
      var v = cb.getAttribute('data-val');
      if (v === null) return;
      fpop.sel[v] = !!cb.checked;
      applyFilter();
      renderFpop();
    });
    $('fpopAll').addEventListener('click', function () {
      for (var i = 0; i < fpop.all.length; i++) fpop.sel[fpop.all[i]] = true;
      applyFilter(); renderFpop();
    });
    $('fpopNone').addEventListener('click', function () {
      for (var i = 0; i < fpop.all.length; i++) fpop.sel[fpop.all[i]] = false;
      applyFilter(); renderFpop();
    });
    $('fpopReset').addEventListener('click', function () {
      delete filterStore(fpop.tbl)[fpop.key];
      renderCurrent(); closeFilter();
    });
    if ($('fpopAsc')) $('fpopAsc').addEventListener('click', function () { fpopSort(1); });
    if ($('fpopDesc')) $('fpopDesc').addEventListener('click', function () { fpopSort(-1); });
    if ($('fpopUnsort')) $('fpopUnsort').addEventListener('click', function () { fpopSort(0); });
    $('fpopDone').addEventListener('click', closeFilter);
    $('fpopClose').addEventListener('click', closeFilter);
    document.addEventListener('click', function (ev) {
      if (!fpop.open) return;
      var el = $('fpop');
      if (el.contains(ev.target)) return;
      var tf = ev.target.closest ? ev.target.closest('[data-filter]') : null;
      if (tf) return;
      closeFilter();
    });
    window.addEventListener('resize', function () { if (fpop.open) placeFpop(); });
    window.addEventListener('scroll', function () { if (fpop.open) placeFpop(); }, true);

    var inBtns = document.querySelectorAll('#whSegIn button');
    for (var a = 0; a < inBtns.length; a++) inBtns[a].addEventListener('click', function () { setInWh(this.getAttribute('data-wh')); });
    var outBtns = document.querySelectorAll('#whSegOut button');
    for (var b = 0; b < outBtns.length; b++) outBtns[b].addEventListener('click', function () {
      setOutWh(this.getAttribute('data-wh'));
      fillLotSelect($('outLot'), cur.whOut);
      syncLotViews();
      fillLotPrice('out', ERP.getLot(st, $('outLot').value));
    });
    var dBtns = document.querySelectorAll('#destSeg button');
    for (var c = 0; c < dBtns.length; c++) dBtns[c].addEventListener('click', function () { setDest(this.getAttribute('data-dest')); });

    /* 행 작업 메뉴 (해동 / 출고 / 수정) */
    if ($('rowMenu')) {
      $('rowMenu').addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-mi]') : null;
        if (!b) return;
        var it = rowMenu.items[Number(b.getAttribute('data-mi'))];
        closeRowMenu();
        if (!it) return;
        if (it.act === 'thaw' || it.act === 're' || it.act === 'out') {
          bindLot(it.lot, it.act);
          openMeatForm(it.act);
          if (it.act === 'out') toast('출고 등록 — 고른 로트가 자동으로 선택됐습니다.', 'out');
        } else if (it.act === 'lotedit') {
          openLot(it.lot);
        } else if (it.act === 'fgin') {
          openFgFor(it.code, 'IN');
        } else if (it.act === 'fgout') {
          openFgFor(it.code, 'OUT');
        } else if (it.act === 'fgprice') {
          openFgPrice(it.code);
        } else if (it.act === 'fgedit') {
          openFgNew(it.code);
        } else if (it.act === 'edit') {
          openEdit(it.id);
        } else if (it.act === 'undo') {
          undoEntry(it.id, null);
        } else if (it.act === 'stmt') {
          var stmtLog = ERP.getLog(st, it.id);
          if (stmtLog) {
            if (stmtLog.t === 'out') openStmt('meat', stmtLog);
            else toast('출고 건에서만 명세표를 열 수 있습니다.', 'warn');
          }
        }
      });
    }
    document.addEventListener('click', function (ev) {
      if (!rowMenu.open) return;
      if (ev.target.closest && (ev.target.closest('#rowMenu') || ev.target.closest('[data-menu]'))) return;
      closeRowMenu();
    });
    window.addEventListener('resize', function () { if (rowMenu.open) closeRowMenu(); });

    /* 입고 사진 */
    if ($('btnPhotoUp')) $('btnPhotoUp').addEventListener('click', function () { if ($('photoFile')) $('photoFile').click(); });
    if ($('photoFile')) $('photoFile').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      uploadPhotoFile(f);
    });
    ['btnPhotoInbox', 'btnPhotoInbox2', 'photoInboxUpload'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('click', function () {
        if (id === 'photoInboxUpload') { if ($('photoFile')) $('photoFile').click(); return; }
        openPhotoInbox();
      });
    });
    if ($('photoInboxClose')) $('photoInboxClose').addEventListener('click', closePhotoInbox);
    if ($('photoInboxDone')) $('photoInboxDone').addEventListener('click', closePhotoInbox);
    if ($('photoInboxModal')) $('photoInboxModal').addEventListener('click', function (ev) { if (ev.target === this) closePhotoInbox(); });
    if ($('photoGrid')) $('photoGrid').addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-photo]') : null;
      if (b) openPhoto(b.getAttribute('data-photo'));
    });
    if ($('photoViewClose')) $('photoViewClose').addEventListener('click', closePhoto);
    if ($('photoViewClose2')) $('photoViewClose2').addEventListener('click', closePhoto);
    if ($('photoViewModal')) $('photoViewModal').addEventListener('click', function (ev) { if (ev.target === this && !this.classList.contains('mini')) closePhoto(); });
    if ($('photoPin')) $('photoPin').addEventListener('click', function () {
      var m = $('photoViewModal');
      pinPhoto(!m.classList.contains('mini'));
    });
    if ($('photoDelete')) $('photoDelete').addEventListener('click', photoDeleteOpen);
    if ($('photoLoad')) $('photoLoad').addEventListener('click', photoLoadToForm);
    if ($('photoStateClear')) $('photoStateClear').addEventListener('click', clearPhotoPick);
    if ($('photoNotify')) $('photoNotify').addEventListener('change', function () {
      photoSetNotify(this.checked);
      if (this.checked) requestNotifyPermission();
    });

    [['thLot', 'thaw', 'F'], ['outLot', 'out', null], ['reLot', 're', 'C']].forEach(function (pair) {
      $(pair[0]).addEventListener('change', function () {
        cur.lotId = this.value || null;
        syncLotViews();
        renderTable();
        fillLotPrice(pair[1], ERP.getLot(st, this.value));
      });
    });
    $('thAll').addEventListener('click', function () {
      var lot = ERP.getLot(st, $('thLot').value);
      if (!lot) { toast('먼저 로트를 선택하세요.', 'warn'); return; }
      $('thKg').value = lot.fq.toFixed(2);
      fillLotPrice('thaw', lot);
    });
    $('outAll').addEventListener('click', function () {
      var lot = ERP.getLot(st, $('outLot').value);
      if (!lot) { toast('먼저 로트를 선택하세요.', 'warn'); return; }
      $('outKg').value = ERP.qtyOf(lot, cur.whOut).toFixed(2);
      fillLotPrice('out', lot);
    });
    $('reAll').addEventListener('click', function () {
      var lot = ERP.getLot(st, $('reLot').value);
      if (!lot) { toast('먼저 로트를 선택하세요.', 'warn'); return; }
      $('reKg').value = lot.cq.toFixed(2);
      fillLotPrice('re', lot);
    });

    /* 단가 ↔ 금액 */
    ['in', 'thaw', 're', 'out'].forEach(function (m) {
      var ids = PRICE_IDS[m];
      $(ids.kg).addEventListener('input', function () { priceSync(m, 'kg'); });
      $(ids.price).addEventListener('input', function () { priceSync(m, 'price'); });
      $(ids.amount).addEventListener('input', function () { priceSync(m, 'amount'); });
    });
    ['inName'].forEach(function (id) {
      $(id).addEventListener('input', function () { updatePriceHint(); });
      $(id).addEventListener('change', function () { updatePriceHint(); });
    });
    /* v7: 브랜드는 표준 영문명으로 맞춘다 (파텔 → PATEL) */
    [['inBrand', 'inName'], ['ltBrand', null]].forEach(function (pair) {
      var el = $(pair[0]);
      if (!el) return;
      el.addEventListener('change', function () { normalizeBrandInput(el); });
      el.addEventListener('blur', function () { normalizeBrandInput(el); });
      if (pair[1]) el.addEventListener('input', function () { if ($(pair[1])) updatePriceHint(); });
    });

    $('btnCsvF').addEventListener('click', function () { csvStock('F'); });
    $('btnCsvC').addEventListener('click', function () { csvStock('C'); });
    $('btnCsvH').addEventListener('click', function () { csvHistory(); });
    $('btnXlsSabang').addEventListener('click', function () { openXls('sabang'); });
    $('btnXlsSales').addEventListener('click', function () { openXls('sales'); });

    /* 📊 엑셀 ▾ 드롭다운 (원료육 · 완제품 · 회계 공통) */
    var xlLast = null;
    function closeXlMenus(except) {
      var menus = document.querySelectorAll('.xlmenu');
      for (var i = 0; i < menus.length; i++) {
        if (menus[i] === except) continue;
        var pop = menus[i].querySelector('.xlpop');
        var btn = menus[i].querySelector('.xlbtn');
        if (pop) pop.classList.add('hidden');
        if (btn) { btn.classList.remove('on'); btn.setAttribute('aria-expanded', 'false'); }
        if (xlLast && xlLast.pop === pop) xlLast = null;
      }
    }
    function placeXlPop(btn, pop) {
      var r = btn.getBoundingClientRect();
      var w = pop.offsetWidth || 238, h = pop.offsetHeight || 240;
      var left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
      var top = r.bottom + 6;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
    }
    var xlMenus = document.querySelectorAll('.xlmenu');
    for (var xm = 0; xm < xlMenus.length; xm++) {
      (function (menu) {
        var btn = menu.querySelector('.xlbtn'), pop = menu.querySelector('.xlpop');
        if (!btn || !pop) return;
        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          var willOpen = pop.classList.contains('hidden');
          closeXlMenus(menu);
          pop.classList.toggle('hidden', !willOpen);
          btn.classList.toggle('on', willOpen);
          btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
          if (willOpen) { xlLast = { btn: btn, pop: pop }; placeXlPop(btn, pop); }
          else if (xlLast && xlLast.pop === pop) xlLast = null;
        });
        pop.addEventListener('click', function (ev) {
          if (ev.target.closest && ev.target.closest('[data-xl]')) closeXlMenus(null);
        });
      })(xlMenus[xm]);
    }
    document.addEventListener('click', function (ev) {
      if (ev.target.closest && ev.target.closest('.xlmenu')) return;
      closeXlMenus(null);
    });
    window.addEventListener('resize', function () { closeXlMenus(null); });
    window.addEventListener('scroll', function () {
      /* 메뉴는 버튼에 붙어 있으므로 스크롤하면 바로 따라 옮긴다 */
      if (xlLast && !xlLast.pop.classList.contains('hidden')) placeXlPop(xlLast.btn, xlLast.pop);
      else if (document.querySelector('.xlpop:not(.hidden)')) closeXlMenus(null);
    }, true);
    $('xlsClose').addEventListener('click', closeXls);
    $('xlsCancel').addEventListener('click', closeXls);
    $('xlsGo').addEventListener('click', downloadXls);
    $('xlsModal').addEventListener('click', function (ev) { if (ev.target === this) closeXls(); });

    /* 수정 모달 */
    $('editClose').addEventListener('click', closeEdit);
    $('editCancel').addEventListener('click', closeEdit);
    $('editSave').addEventListener('click', saveEdit);
    $('editModal').addEventListener('click', function (ev) { if (ev.target === this) closeEdit(); });
    $('edKg').addEventListener('input', function () {
      var kg = Number(this.value || 0), pr = Number($('edPrice').value || 0);
      $('edAmount').value = kg > 0 && pr > 0 ? String(Math.round(kg * pr)) : '';
    });
    $('edPrice').addEventListener('input', function () {
      var kg = Number($('edKg').value || 0), pr = Number(this.value || 0);
      $('edAmount').value = kg > 0 && pr > 0 ? String(Math.round(kg * pr)) : '';
    });
    $('edAmount').addEventListener('input', function () {
      var kg = Number($('edKg').value || 0), am = Number(this.value || 0);
      if (kg > 0) $('edPrice').value = am > 0 ? String(Math.round(am / kg)) : '';
    });

    /* 로트 모달 */
    $('lotClose').addEventListener('click', closeLot);
    $('lotCancel').addEventListener('click', closeLot);
    $('lotSave').addEventListener('click', saveLot);
    $('lotModal').addEventListener('click', function (ev) { if (ev.target === this) closeLot(); });
    if ($('edDest')) $('edDest').addEventListener('change', function () {
      if ($('edDestDetailLabel')) {
        $('edDestDetailLabel').textContent = ERP.destKey(this.value) === 'site' ? '생산품목' : '비고(업체명·수령처·사유)';
      }
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      var openX = document.querySelector('.xlpop:not(.hidden)');
      if (openX) { closeXlMenus(null); return; }
      if (rowMenu.open) { closeRowMenu(); return; }
      if (rngm.open) { closeRange(); return; }
      if (!$('photoViewModal').classList.contains('hidden')) { closePhoto(); return; }
      if (!$('photoInboxModal').classList.contains('hidden')) { closePhotoInbox(); return; }
      if (!$('xlsModal').classList.contains('hidden')) { closeXls(); return; }
      if (!$('editModal').classList.contains('hidden')) { closeEdit(); return; }
      if (!$('lotModal').classList.contains('hidden')) { closeLot(); return; }
      if (!$('fgNewModal').classList.contains('hidden')) { closeFgNew(); return; }
      if (!$('fgPriceModal').classList.contains('hidden')) { closeFgPrice(); return; }
      if (!$('uploadModal').classList.contains('hidden')) { closeUpload(); return; }
      if (!$('accVoucherModal').classList.contains('hidden')) { closeAccVoucher(); return; }
      if (!$('accPayModal').classList.contains('hidden')) { closeAccPay(); return; }
      if (!$('accExpModal').classList.contains('hidden')) { closeAccExpense(); return; }
      if (!$('stmtModal').classList.contains('hidden')) { closeStmt(); return; }
      if (!$('supplierModal').classList.contains('hidden')) { closeSupplier(); return; }
      if (!$('accHelpModal').classList.contains('hidden')) { closeAccHelp(); return; }
      if (!$('meatFormModal').classList.contains('hidden')) { closeMeatForm(); return; }
      if (!$('fgFormModal').classList.contains('hidden')) { closeFgForm(); return; }
      if (fpop.open) closeFilter();
    });
    var xlsSegs = document.querySelectorAll('#xlsRangeSeg button');
    for (var s2 = 0; s2 < xlsSegs.length; s2++) {
      xlsSegs[s2].addEventListener('click', function () {
        xls.range = this.getAttribute('data-range');
        for (var q = 0; q < xlsSegs.length; q++) xlsSegs[q].classList.toggle('active', xlsSegs[q] === this);
        if (xls.range === 'range') {
          if (!$('xlsFrom').value) $('xlsFrom').value = firstOfMonth();
          if (!$('xlsTo').value) $('xlsTo').value = today();
        }
        renderXls();
      });
    }
    ['xlsFrom', 'xlsTo', 'xlsThaw', 'xlsAllOut', 'xlsVat'].forEach(function (id) {
      $(id).addEventListener('change', renderXls);
      $(id).addEventListener('input', renderXls);
    });
    $('btnLogout').addEventListener('click', function () { doLogout(false); });

    var nums = document.querySelectorAll('#entryForm input[type=number]');
    for (var d = 0; d < nums.length; d++) nums[d].addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && SB.auth.session()) reload({ silent: true });
    });
  }

  function linkedVoucher(kind, id) {
    for (var i = 0; i < st.vouchers.length; i++) {
      var v = st.vouchers[i];
      if (v.srcKind === kind && Number(v.srcId) === Number(id)) return v;
    }
    return null;
  }
  function undoEntry(logId, btn) {
    if (!window.confirm('이 입력을 취소할까요?\n재고가 입력 전으로 되돌아가고, 이력에서 사라집니다.')) return;
    if (btn) btn.disabled = true;
    var lv = linkedVoucher('meat', logId);
    SB.db.undo(logId).then(function (row) {
      toast('취소됨: ' + (row && row.product_name ? row.product_name + ' ' + Number(row.qty).toFixed(2) + 'kg' : '입력 건') +
        (lv ? ' · 자동으로 만들어진 ' + (lv.t === 'sale' ? '매출' : '매입') + ' 전표는 구매·판매관리에서 삭제해 주세요.' : ''),
        lv ? 'warn' : 'ok', lv ? 7000 : undefined);
      return reload({ silent: true });
    }).then(function () {
      if (btn) btn.disabled = false;
    }, function (e) {
      if (btn) btn.disabled = false;
      toast(e.message, 'err');
    });
  }

  function bindLoginEvents() {
    var ltab = document.querySelectorAll('.ltab');
    for (var i = 0; i < ltab.length; i++) {
      ltab[i].addEventListener('click', function () {
        var which = this.getAttribute('data-ltab');
        for (var k = 0; k < ltab.length; k++) ltab[k].classList.toggle('active', ltab[k] === this);
        $('loginForm').classList.toggle('hidden', which !== 'in');
        $('signupForm').classList.toggle('hidden', which !== 'up');
        setLoginMsg('');
      });
    }
    $('loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = $('liEmail').value.replace(/^\s+|\s+$/g, '');
      var pw = $('liPw').value;
      if (!email || !pw) { setLoginMsg('이메일과 비밀번호를 입력해 주세요.', 'err'); return; }
      var b = $('btnLogin');
      b.disabled = true; b.textContent = '로그인 중…';
      setLoginMsg('');
      SB.auth.signIn(email, pw).then(function (ses) {
        setLoginMsg('');
        enterApp(ses);
        toast(ses.name + ' 님, 반갑습니다.', 'ok');
      }).then(function () {
        b.disabled = false; b.textContent = '로그인';
      }, function (err) {
        b.disabled = false; b.textContent = '로그인';
        setLoginMsg(err.message, 'err');
      });
    });
    $('signupForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = $('suName').value.replace(/^\s+|\s+$/g, '');
      var email = $('suEmail').value.replace(/^\s+|\s+$/g, '');
      var pw = $('suPw').value;
      if (!email || !pw) { setLoginMsg('이메일과 비밀번호를 입력해 주세요.', 'err'); return; }
      if (pw.length < 6) { setLoginMsg('비밀번호는 6자 이상으로 만들어 주세요.', 'err'); return; }
      var b = $('btnSignup');
      b.disabled = true; b.textContent = '만드는 중…';
      setLoginMsg('');
      SB.auth.signUp(email, pw, name).then(function (r) {
        b.disabled = false; b.textContent = '계정 만들기';
        if (r.session) {
          enterApp(r.session);
          toast('계정이 만들어졌습니다. ' + r.session.name + ' 님 반갑습니다.', 'ok');
        } else {
          setLoginMsg('확인 메일을 ' + r.email + ' 로 보냈습니다. 메일의 확인 링크를 누른 뒤 로그인해 주세요.\n' +
            '(회사 내부용이라면 Supabase → Authentication → Sign In / Providers에서 “Confirm email”을 끄면 바로 쓸 수 있습니다)', 'warn');
        }
      }, function (err) {
        b.disabled = false; b.textContent = '계정 만들기';
        setLoginMsg(err.message, 'err');
      });
    });
  }

  /* ---------- 시작 ---------- */
  /* v8.1 — partners_data.js 의 거래처 2,350건을 CORE에 올린다 */
  function partnersInit() {
    try {
      var head = (typeof window !== 'undefined' && window.MIRS_PARTNER_HEAD) || null;
      var rows = (typeof window !== 'undefined' && window.MIRS_PARTNERS) || [];
      return ERP.partnerLoad(head, rows);
    } catch (e) { return 0; }
  }
  function boot() {
    loadColW();
    loadFgCats();
    partnersInit();
    bindLoginEvents();
    bindAppEvents();
    bindV4Events();
    bindIoSheet();
    popInit();
    acSetupAll();
    setSync('wait', '확인 중');
    var ses = SB.auth.restore();
    if (ses) {
      enterApp(ses);
    } else {
      $('loginView').classList.remove('hidden');
      $('appView').classList.add('hidden');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
/* ============================== UI:END ============================== */

/* ============================================================================
   v13 · 폰 화면(≤768px) 개선 — 부속 스크립트
   ----------------------------------------------------------------------------
   완제품 입출고 내역의 구분 필터를 [전체 / 입고만 / 출고만] 칩으로 보여 줍니다.
   기존 <select id="fgLogFilter"> 가 값의 주인이고, 칩은 그 값을 바꿔 주기만
   하므로 앱의 기존 필터 로직(구분 변경 → 표 다시 그리기)을 그대로 씁니다.
   ============================================================================ */
(function () {
  'use strict';
  function el(id) { return document.getElementById(id); }

  function syncChips() {
    var chips = el('fgDirChips'), sel = el('fgLogFilter');
    if (!chips || !sel) return;
    /* 앱은 입출고 내역 탭에서만 select 의 hidden 을 뺀다 → 칩도 같은 시점에 보인다 */
    var open = !sel.classList.contains('hidden');
    chips.classList.toggle('hidden', !open);
    var v = sel.value || 'all';
    var btns = chips.querySelectorAll('.dirchip');
    for (var i = 0; i < btns.length; i++) {
      var on = (btns[i].getAttribute('data-dir') || 'all') === v;
      btns[i].classList.toggle('active', on);
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function choose(dir) {
    var sel = el('fgLogFilter');
    if (!sel) return;
    if (sel.value !== dir) {
      sel.value = dir;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    syncChips();
  }

  function init() {
    var chips = el('fgDirChips'), sel = el('fgLogFilter');
    if (!chips || !sel) return;
    chips.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.dirchip') : null;
      if (!b) return;
      choose(b.getAttribute('data-dir') || 'all');
    });
    if (window.MutationObserver) {
      new MutationObserver(syncChips).observe(sel, { attributes: true, attributeFilter: ['class'] });
    }
    syncChips();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

/* ============================================================================
   v13 · 폰 메뉴 시트 — 5장 카드형 메뉴(.nav-card)가 있는 버전에서만 켜집니다.
   하단 [메뉴] 버튼을 누르면 메뉴가 아래에서 올라오고, 항목을 고르면 닫힙니다.
   ============================================================================ */
(function () {
  'use strict';
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  ready(function () {
    var side = document.getElementById('v8Side');
    /* 사본 v12처럼 .nav-card 가 없는 메뉴는 손대지 않습니다 */
    if (!side || !side.querySelector('.nav-card')) return;

    document.body.classList.add('v13-msheet');

    var back = document.createElement('div');
    back.className = 'v13-msheet-back';
    back.setAttribute('aria-hidden', 'true');
    back.addEventListener('click', close);
    document.body.appendChild(back);

    var head = document.createElement('div');
    head.className = 'v13-msheet-head';
    var ttl = document.createElement('b');
    ttl.textContent = '메뉴';
    /* 로그인한 작업자 이름 (좁은 폰에서는 상단에서 숨김) */
    var whoEl = document.querySelector('#whoami b');
    if (whoEl && whoEl.textContent) {
      var who = document.createElement('span');
      who.className = 'v13-msheet-who';
      who.textContent = whoEl.textContent;
      ttl.appendChild(who);
    }
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'v13-msheet-x'; x.setAttribute('aria-label', '메뉴 닫기');
    x.textContent = '✕';
    x.addEventListener('click', close);
    head.appendChild(ttl); head.appendChild(x);
    side.insertBefore(head, side.firstChild);

    function open() {
      document.body.classList.add('menu-open');
      side.scrollTop = 0;
    }
    function close() { document.body.classList.remove('menu-open'); }

    /* 하단 바 [메뉴] = 시트 열기 (원래는 왼쪽 메뉴로 스크롤) */
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#qbList')) {
        e.preventDefault();
        e.stopPropagation();
        open();
        return;
      }
      if (t.closest('#v8Side .nitem,#v8Side [data-nav],#v8Side [data-io],#v8Side [data-trade],#v8Side [data-prod],#v8Side [data-acc]')) {
        close();
      }
    }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  });
})();
