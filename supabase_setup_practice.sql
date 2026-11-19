-- ============================================================================
--  한솔 ERP v12 사본 · 연습용 Supabase 스키마
--  원본 앱(zugindaa-maker/hansol-erp, v12 app.js)이 쓰는 표·함수·RLS·실시간을
--  원본과 같은 이름·같은 인자로 만든다. 여러 번 실행해도 안전(idempotent).
--  원본 DB(gzufnyglmvgzqltepock) · 개인 ERP DB(rdzypyfzpdjzgsfsncrq)와 무관.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 0. 도우미
-- ---------------------------------------------------------------------------
create or replace function public.fn_worker_name() returns text
language sql stable as $$
  select coalesce(
    nullif(auth.jwt() -> 'user_metadata' ->> 'name', ''),
    nullif(split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1), ''),
    'system')
$$;

create or replace function public.fn_worker_email() returns text
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email', '')
$$;

create or replace function public.require_login() returns void
language plpgsql stable as $$
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. 원료육 로트
-- ---------------------------------------------------------------------------
create table if not exists public.lots (
  id             bigserial primary key,
  product_name   text        not null,
  meat_type      text        default '',
  origin         text        default '',
  vendor         text        default '',
  brand          text        default '',
  major_category text        not null default '원료육',
  in_date        date,
  exp_date       date,
  frozen_qty     numeric(12,2) not null default 0,
  chilled_qty    numeric(12,2) not null default 0,
  unit_price     numeric(12,2) not null default 0,
  note           text        default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists lots_name_idx  on public.lots (product_name);
create index if not exists lots_exp_idx   on public.lots (exp_date);
create index if not exists lots_key_idx   on public.lots (product_name, vendor, in_date, exp_date);

-- ---------------------------------------------------------------------------
-- 2. 원료육 입출고 이력
-- ---------------------------------------------------------------------------
create table if not exists public.tx_logs (
  id             bigserial primary key,
  tx_date        date        not null default current_date,
  warehouse      text        not null default 'F',
  tx_type        text        not null default 'out',
  product_name   text        not null default '',
  meat_type      text        default '',
  origin         text        default '',
  vendor         text        default '',
  major_category text        not null default '원료육',
  in_date        date,
  exp_date       date,
  qty            numeric(12,2) not null default 0,
  unit_price     numeric(12,2) not null default 0,
  total_amount   numeric(14,2) not null default 0,
  dest_type      text        default '',
  dest_detail    text        default '',
  note           text        default '',
  lot_id         bigint references public.lots(id) on delete set null,
  worker_name    text        default '',
  worker_email   text        default '',
  is_manual      boolean     not null default true,
  created_at     timestamptz not null default now()
);
create index if not exists tx_logs_date_idx on public.tx_logs (tx_date desc);
create index if not exists tx_logs_lot_idx  on public.tx_logs (lot_id);
create index if not exists tx_logs_type_idx on public.tx_logs (tx_type);

-- ---------------------------------------------------------------------------
-- 3. 완제품·부자재 품목
-- ---------------------------------------------------------------------------
create table if not exists public.fp_products (
  code        text primary key,
  category    text        default '완제품',
  name        text        not null default '',
  spec        text        default '',
  unit        text        default '개',
  stock       numeric(14,3) not null default 0,
  in_price    numeric(14,2) not null default 0,
  out_price   numeric(14,2) not null default 0,
  expiry      date,
  supplier    text        default '',
  barcode     text        default '',
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists fp_products_name_idx on public.fp_products (name);

-- ---------------------------------------------------------------------------
-- 4. 완제품·부자재 입출고 이력
-- ---------------------------------------------------------------------------
create table if not exists public.fp_logs (
  id           bigserial primary key,
  tx_date      date        not null default current_date,
  tx_type      text        not null default 'IN',
  code         text        not null default '',
  name         text        default '',
  category     text        default '완제품',
  spec         text        default '',
  unit         text        default '개',
  qty          numeric(14,3) not null default 0,
  in_price     numeric(14,2) not null default 0,
  out_price    numeric(14,2) not null default 0,
  amount       numeric(16,2) not null default 0,
  expiry       date,
  partner      text        default '',
  note         text        default '',
  source       text        default 'manual',
  worker_name  text        default '',
  worker_email text        default '',
  undone       boolean     not null default false,
  lot_id       bigint,
  lot_no       text        default '',
  in_date      date,
  created_at   timestamptz not null default now()
);
create index if not exists fp_logs_date_idx on public.fp_logs (tx_date desc);
create index if not exists fp_logs_code_idx on public.fp_logs (code);
create index if not exists fp_logs_lot_idx  on public.fp_logs (lot_id);

-- ---------------------------------------------------------------------------
-- 5. 완제품·부자재 로트 (v12)
-- ---------------------------------------------------------------------------
create table if not exists public.fp_lots (
  id          bigserial primary key,
  code        text        not null default '',
  lot_no      text        not null default '',
  category    text        default '완제품',
  name        text        default '',
  spec        text        default '',
  unit        text        default '개',
  in_date     date,
  exp_date    date,
  qty         numeric(14,3) not null default 0,
  in_price    numeric(14,2) not null default 0,
  out_price   numeric(14,2) not null default 0,
  supplier    text        default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists fp_lots_code_idx on public.fp_lots (code);
create index if not exists fp_lots_key_idx  on public.fp_lots (code, lot_no, in_date, exp_date);

-- ---------------------------------------------------------------------------
-- 6. 회계 — 매입·매출 전표
-- ---------------------------------------------------------------------------
create table if not exists public.acc_vouchers (
  id            bigserial primary key,
  v_date        date        not null default current_date,
  v_type        text        not null default 'sale',      -- sale / purchase
  partner       text        default '',
  tax_type      text        not null default 'tax',       -- tax / free
  supply_amount numeric(14,2) not null default 0,
  vat_amount    numeric(14,2) not null default 0,
  total_amount  numeric(14,2) not null default 0,
  tax_status    text        default 'none',               -- none / issued / received
  note          text        default '',
  source        text        default 'manual',             -- manual / auto
  source_kind   text        default '',                   -- meat / fp
  source_id     bigint,
  worker_name   text        default '',
  worker_email  text        default '',
  created_at    timestamptz not null default now()
);
create index if not exists acc_vouchers_date_idx on public.acc_vouchers (v_date desc);
create index if not exists acc_vouchers_src_idx  on public.acc_vouchers (source_kind, source_id);
create unique index if not exists acc_vouchers_src_uniq
  on public.acc_vouchers (source_kind, source_id)
  where source_kind is not null and source_kind <> '' and source_id is not null;

-- ---------------------------------------------------------------------------
-- 7. 회계 — 수금·지급
-- ---------------------------------------------------------------------------
create table if not exists public.acc_payments (
  id           bigserial primary key,
  p_date       date        not null default current_date,
  partner      text        default '',
  p_type       text        not null default 'in',        -- in 수금 / out 지급
  amount       numeric(14,2) not null default 0,
  method       text        default '',
  note         text        default '',
  worker_name  text        default '',
  worker_email text        default '',
  created_at   timestamptz not null default now()
);
create index if not exists acc_payments_date_idx on public.acc_payments (p_date desc);

-- ---------------------------------------------------------------------------
-- 8. 회계 — 일반 경비·수입
-- ---------------------------------------------------------------------------
create table if not exists public.acc_expenses (
  id            bigserial primary key,
  e_date        date        not null default current_date,
  e_type        text        not null default 'expense',   -- expense / income
  category      text        default '기타',
  partner       text        default '',
  supply_amount numeric(14,2) not null default 0,
  vat_amount    numeric(14,2) not null default 0,
  amount        numeric(14,2) not null default 0,
  tax_type      text        not null default 'free',
  method        text        default '',
  note          text        default '',
  worker_name   text        default '',
  worker_email  text        default '',
  created_at    timestamptz not null default now()
);
create index if not exists acc_expenses_date_idx on public.acc_expenses (e_date desc);

-- ---------------------------------------------------------------------------
-- 9. 입고 사진 대기함
-- ---------------------------------------------------------------------------
create table if not exists public.inbound_photos (
  id            bigserial primary key,
  image_data    text,
  file_name     text        default '',
  memo          text        default '',
  uploader_name text        default '',
  status        text        not null default 'pending',   -- pending / registered
  lot_id        bigint references public.lots(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists inbound_photos_status_idx on public.inbound_photos (status, created_at);

-- ===========================================================================
-- 10. 원료육 함수
-- ===========================================================================
create or replace function public.lot_add(p_lot_id bigint, p_wh text, p_delta numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_wh = 'C' then
    update lots set chilled_qty = round(chilled_qty + p_delta, 2), updated_at = now() where id = p_lot_id;
  else
    update lots set frozen_qty = round(frozen_qty + p_delta, 2), updated_at = now() where id = p_lot_id;
  end if;
end $$;

create or replace function public.lot_qty(p_lot_id bigint, p_wh text)
returns numeric language sql stable security definer set search_path = public as $$
  select case when p_wh = 'C' then coalesce(chilled_qty, 0) else coalesce(frozen_qty, 0) end
    from lots where id = p_lot_id
$$;

/* 입고 / 해동 / 재냉동 / 출고 — 한 트랜잭션으로 재고와 이력을 함께 처리 */
create or replace function public.tx_apply(
  p_date      date,
  p_type      text,
  p_wh        text,
  p_lot_id    bigint,
  p_kg        numeric,
  p_dest_type text    default '',
  p_dest      text    default '',
  p_note      text    default '',
  p_name      text    default '',
  p_vendor    text    default '',
  p_in_date   date    default null,
  p_exp_date  date    default null,
  p_meat      text    default '',
  p_origin    text    default '',
  p_brand     text    default '',
  p_major     text    default '원료육',
  p_unit_price numeric default 0,
  p_amount    numeric default null
) returns public.tx_logs
language plpgsql security definer set search_path = public as $$
declare
  v_lot    public.lots;
  v_row    public.tx_logs;
  v_kg     numeric := round(coalesce(p_kg, 0), 2);
  v_wh     text    := case when p_wh = 'C' then 'C' else 'F' end;
  v_price  numeric := coalesce(p_unit_price, 0);
  v_amount numeric;
  v_have   numeric;
begin
  perform public.require_login();
  if p_type is null or p_type not in ('in', 'thaw', 're', 'out') then
    raise exception '알 수 없는 입출고 구분입니다.';
  end if;
  if v_kg <= 0 then
    raise exception '중량을 입력하세요.';
  end if;

  if p_type = 'in' then
    if coalesce(trim(p_name), '') = '' then
      raise exception '제품명을 입력하세요.';
    end if;

    if p_lot_id is not null then
      select * into v_lot from lots where id = p_lot_id;
    end if;
    if v_lot.id is null then
      select * into v_lot from lots
       where product_name = trim(p_name)
         and coalesce(vendor, '') = coalesce(trim(p_vendor), '')
         and in_date  is not distinct from p_in_date
         and exp_date is not distinct from p_exp_date
       order by id
       limit 1;
    end if;

    if v_lot.id is null then
      insert into lots (product_name, meat_type, origin, vendor, brand, major_category,
                        in_date, exp_date, frozen_qty, chilled_qty, unit_price)
      values (trim(p_name), coalesce(p_meat, ''), coalesce(p_origin, ''), coalesce(trim(p_vendor), ''),
              coalesce(p_brand, ''), coalesce(nullif(trim(p_major), ''), '원료육'),
              p_in_date, p_exp_date,
              case when v_wh = 'F' then v_kg else 0 end,
              case when v_wh = 'C' then v_kg else 0 end,
              greatest(v_price, 0))
      returning * into v_lot;
    else
      update lots set
        meat_type      = coalesce(nullif(trim(p_meat), ''), meat_type),
        origin         = coalesce(nullif(trim(p_origin), ''), origin),
        brand          = coalesce(nullif(trim(p_brand), ''), brand),
        vendor         = coalesce(nullif(trim(p_vendor), ''), vendor),
        major_category = coalesce(nullif(trim(p_major), ''), major_category),
        unit_price     = case when v_price > 0 then v_price else unit_price end,
        frozen_qty     = round(frozen_qty  + case when v_wh = 'F' then v_kg else 0 end, 2),
        chilled_qty    = round(chilled_qty + case when v_wh = 'C' then v_kg else 0 end, 2),
        updated_at     = now()
      where id = v_lot.id
      returning * into v_lot;
    end if;

    if v_price <= 0 then v_price := coalesce(v_lot.unit_price, 0); end if;

  else
    if p_lot_id is null or p_lot_id <= 0 then
      raise exception '로트를 고르세요.';
    end if;
    select * into v_lot from lots where id = p_lot_id for update;
    if v_lot.id is null then
      raise exception '로트를 찾을 수 없습니다.';
    end if;
    v_have := case when v_wh = 'C' then v_lot.chilled_qty else v_lot.frozen_qty end;

    if p_type = 'thaw' then
      if v_have + 0.004 < v_kg then
        raise exception '냉동고 재고가 모자랍니다. (현재 % kg)', round(v_have, 2);
      end if;
      update lots set frozen_qty = round(frozen_qty - v_kg, 2),
                      chilled_qty = round(chilled_qty + v_kg, 2), updated_at = now()
       where id = v_lot.id returning * into v_lot;

    elsif p_type = 're' then
      if v_have + 0.004 < v_kg then
        raise exception '냉장고 재고가 모자랍니다. (현재 % kg)', round(v_have, 2);
      end if;
      update lots set chilled_qty = round(chilled_qty - v_kg, 2),
                      frozen_qty = round(frozen_qty + v_kg, 2), updated_at = now()
       where id = v_lot.id returning * into v_lot;

    else  -- out
      if v_have + 0.004 < v_kg then
        raise exception '% 재고가 모자랍니다. (현재 % kg)', case when v_wh = 'C' then '냉장고' else '냉동고' end, round(v_have, 2);
      end if;
      update lots set
        frozen_qty  = round(frozen_qty  - case when v_wh = 'F' then v_kg else 0 end, 2),
        chilled_qty = round(chilled_qty - case when v_wh = 'C' then v_kg else 0 end, 2),
        updated_at  = now()
       where id = v_lot.id returning * into v_lot;
    end if;

    if v_price <= 0 then v_price := coalesce(v_lot.unit_price, 0); end if;
  end if;

  v_amount := coalesce(round(p_amount, 2), round(v_kg * v_price, 2));

  insert into tx_logs (tx_date, warehouse, tx_type, product_name, meat_type, origin, vendor,
                       major_category, in_date, exp_date, qty, unit_price, total_amount,
                       dest_type, dest_detail, note, lot_id, worker_name, worker_email, is_manual)
  values (coalesce(p_date, current_date), v_wh, p_type, v_lot.product_name,
          coalesce(v_lot.meat_type, ''), coalesce(v_lot.origin, ''), coalesce(v_lot.vendor, ''),
          coalesce(nullif(v_lot.major_category, ''), '원료육'), v_lot.in_date, v_lot.exp_date,
          v_kg, v_price, v_amount,
          coalesce(p_dest_type, ''), coalesce(p_dest, ''), coalesce(p_note, ''),
          v_lot.id, public.fn_worker_name(), public.fn_worker_email(), true)
  returning * into v_row;

  return v_row;
end $$;

/* 입력한 이력 수정 — 예전 영향을 되돌리고 새 값으로 다시 계산 */
create or replace function public.tx_update(
  p_log_id     bigint,
  p_date       date,
  p_kg         numeric,
  p_unit_price numeric default 0,
  p_amount     numeric default null,
  p_dest_type  text    default '',
  p_dest       text    default '',
  p_note       text    default '',
  p_wh         text    default null
) returns public.tx_logs
language plpgsql security definer set search_path = public as $$
declare
  v_old   public.tx_logs;
  v_kg    numeric := round(coalesce(p_kg, 0), 2);
  v_wh    text;
  v_oldwh text;
  v_price numeric;
  v_have  numeric;
begin
  perform public.require_login();
  if v_kg <= 0 then raise exception '중량을 입력하세요.'; end if;

  select * into v_old from tx_logs where id = p_log_id for update;
  if v_old.id is null then raise exception '이력을 찾을 수 없습니다.'; end if;

  v_oldwh := coalesce(v_old.warehouse, 'F');
  v_wh    := case when p_wh is null then v_oldwh else (case when p_wh = 'C' then 'C' else 'F' end) end;

  -- ① 예전 값 되돌리기
  if v_old.tx_type = 'in' then
    perform public.lot_add(v_old.lot_id, v_oldwh, -v_old.qty);
  elsif v_old.tx_type = 'thaw' then
    perform public.lot_add(v_old.lot_id, 'F', v_old.qty);
    perform public.lot_add(v_old.lot_id, 'C', -v_old.qty);
  elsif v_old.tx_type = 're' then
    perform public.lot_add(v_old.lot_id, 'C', v_old.qty);
    perform public.lot_add(v_old.lot_id, 'F', -v_old.qty);
  else
    perform public.lot_add(v_old.lot_id, v_oldwh, v_old.qty);
  end if;

  -- ② 새 값 적용 (모자라면 여기서 실패하고 함수 전체가 되돌아간다)
  if v_old.tx_type = 'in' then
    perform public.lot_add(v_old.lot_id, v_wh, v_kg);
  elsif v_old.tx_type = 'thaw' then
    v_have := public.lot_qty(v_old.lot_id, 'F');
    if v_have + 0.004 < v_kg then raise exception '냉동고 재고가 모자랍니다. (현재 % kg)', round(v_have, 2); end if;
    perform public.lot_add(v_old.lot_id, 'F', -v_kg);
    perform public.lot_add(v_old.lot_id, 'C', v_kg);
  elsif v_old.tx_type = 're' then
    v_have := public.lot_qty(v_old.lot_id, 'C');
    if v_have + 0.004 < v_kg then raise exception '냉장고 재고가 모자랍니다. (현재 % kg)', round(v_have, 2); end if;
    perform public.lot_add(v_old.lot_id, 'C', -v_kg);
    perform public.lot_add(v_old.lot_id, 'F', v_kg);
  else
    v_have := public.lot_qty(v_old.lot_id, v_wh);
    if v_have + 0.004 < v_kg then
      raise exception '% 재고가 모자랍니다. (현재 % kg)', case when v_wh = 'C' then '냉장고' else '냉동고' end, round(v_have, 2);
    end if;
    perform public.lot_add(v_old.lot_id, v_wh, -v_kg);
  end if;

  v_price := coalesce(nullif(p_unit_price, 0), v_old.unit_price, 0);

  update tx_logs set
    tx_date      = coalesce(p_date, tx_date),
    warehouse    = v_wh,
    qty          = v_kg,
    unit_price   = v_price,
    total_amount = coalesce(round(p_amount, 2), round(v_kg * v_price, 2)),
    dest_type    = case when tx_type = 'out' then coalesce(p_dest_type, '') else '' end,
    dest_detail  = coalesce(p_dest, ''),
    note         = coalesce(p_note, '')
  where id = p_log_id
  returning * into v_old;

  return v_old;
end $$;

/* 로트 정보 수정 — 같은 로트의 이력에도 이름 · 분류를 함께 적용 */
create or replace function public.lot_update(
  p_lot_id     bigint,
  p_major      text    default null,
  p_meat       text    default null,
  p_name       text    default null,
  p_brand      text    default null,
  p_origin     text    default null,
  p_vendor     text    default null,
  p_unit_price numeric default null,
  p_in_date    date    default null,
  p_exp_date   date    default null
) returns public.lots
language plpgsql security definer set search_path = public as $$
declare v_lot public.lots;
begin
  perform public.require_login();
  if coalesce(trim(p_name), '') = '' then raise exception '품목명을 입력하세요.'; end if;

  update lots set
    major_category = coalesce(nullif(trim(p_major), ''), major_category),
    meat_type      = coalesce(p_meat, meat_type),
    product_name   = trim(p_name),
    brand          = coalesce(p_brand, brand),
    origin         = coalesce(p_origin, origin),
    vendor         = coalesce(p_vendor, vendor),
    unit_price     = coalesce(p_unit_price, unit_price),
    in_date        = p_in_date,
    exp_date       = p_exp_date,
    updated_at     = now()
  where id = p_lot_id
  returning * into v_lot;

  if v_lot.id is null then raise exception '로트를 찾을 수 없습니다.'; end if;

  update tx_logs set
    product_name   = v_lot.product_name,
    meat_type      = v_lot.meat_type,
    origin         = v_lot.origin,
    vendor         = v_lot.vendor,
    major_category = v_lot.major_category,
    in_date        = v_lot.in_date,
    exp_date       = v_lot.exp_date
  where lot_id = v_lot.id;

  return v_lot;
end $$;

/* 입력 취소 — 재고를 되돌리고 이력을 지운다 */
create or replace function public.tx_undo(p_log_id bigint)
returns public.tx_logs
language plpgsql security definer set search_path = public as $$
declare v_old public.tx_logs;
begin
  perform public.require_login();
  select * into v_old from tx_logs where id = p_log_id for update;
  if v_old.id is null then raise exception '이력을 찾을 수 없습니다.'; end if;

  if v_old.tx_type = 'in' then
    perform public.lot_add(v_old.lot_id, coalesce(v_old.warehouse, 'F'), -v_old.qty);
  elsif v_old.tx_type = 'thaw' then
    perform public.lot_add(v_old.lot_id, 'F', v_old.qty);
    perform public.lot_add(v_old.lot_id, 'C', -v_old.qty);
  elsif v_old.tx_type = 're' then
    perform public.lot_add(v_old.lot_id, 'C', v_old.qty);
    perform public.lot_add(v_old.lot_id, 'F', -v_old.qty);
  else
    perform public.lot_add(v_old.lot_id, coalesce(v_old.warehouse, 'F'), v_old.qty);
  end if;

  delete from tx_logs where id = p_log_id;
  return v_old;
end $$;

-- ===========================================================================
-- 11. 완제품·부자재 함수
-- ===========================================================================
create or replace function public.fp_next_lot_no(p_code text, p_date date)
returns text language sql immutable as $$
  select p_code || '-' || to_char(coalesce(p_date, current_date), 'YYYYMMDD')
$$;

/* 상품 등록·수정 (재고는 건드리지 않는다) */
create or replace function public.fp_product_save(
  p_code     text,
  p_category text    default '완제품',
  p_name     text    default '',
  p_spec     text    default '',
  p_unit     text    default '개',
  p_in_price numeric default 0,
  p_out_price numeric default 0,
  p_expiry   date    default null,
  p_supplier text    default '',
  p_barcode  text    default '',
  p_active   boolean default true
) returns public.fp_products
language plpgsql security definer set search_path = public as $$
declare v_row public.fp_products;
begin
  perform public.require_login();
  if coalesce(trim(p_code), '') = '' then raise exception '상품코드를 입력하세요.'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception '상품명을 입력하세요.'; end if;

  insert into fp_products (code, category, name, spec, unit, in_price, out_price,
                           expiry, supplier, barcode, active)
  values (trim(p_code), coalesce(nullif(trim(p_category), ''), '완제품'), trim(p_name),
          coalesce(p_spec, ''), coalesce(nullif(trim(p_unit), ''), '개'),
          greatest(coalesce(p_in_price, 0), 0), greatest(coalesce(p_out_price, 0), 0),
          p_expiry, coalesce(p_supplier, ''), coalesce(p_barcode, ''),
          coalesce(p_active, true))
  on conflict (code) do update set
    category   = excluded.category,
    name       = excluded.name,
    spec       = excluded.spec,
    unit       = excluded.unit,
    in_price   = case when coalesce(p_in_price, 0) > 0 then p_in_price else fp_products.in_price end,
    out_price  = case when coalesce(p_out_price, 0) > 0 then p_out_price else fp_products.out_price end,
    expiry     = excluded.expiry,
    supplier   = excluded.supplier,
    barcode    = excluded.barcode,
    active     = excluded.active,
    updated_at = now()
  returning * into v_row;

  return v_row;
end $$;

/* 완제품·부자재 입고 / 출고 (v12 — 로트 단위) */
create or replace function public.fp_tx_apply(
  p_code       text,
  p_type       text,
  p_qty        numeric,
  p_date       date    default null,
  p_price      numeric default null,
  p_expiry     date    default null,
  p_partner    text    default '',
  p_note       text    default '',
  p_allow_negative boolean default false,
  p_source     text    default 'manual',
  p_lot_no     text    default '',
  p_lot_id     bigint  default null,
  p_in_date    date    default null
) returns public.fp_logs
language plpgsql security definer set search_path = public as $$
declare
  v_prod   public.fp_products;
  v_lot    public.fp_lots;
  v_row    public.fp_logs;
  v_qty    numeric := round(coalesce(p_qty, 0), 3);
  v_type   text    := case when upper(coalesce(p_type, 'IN')) = 'OUT' then 'OUT' else 'IN' end;
  v_date   date    := coalesce(p_date, current_date);
  v_in     date;
  v_price  numeric;
  v_amount numeric;
  v_lotno  text;
  v_need   numeric;
  v_take   numeric;
  v_stock  numeric;
  rec      record;
begin
  perform public.require_login();
  if v_qty <= 0 then raise exception '수량을 입력하세요.'; end if;

  select * into v_prod from fp_products where code = p_code for update;
  if v_prod.code is null then
    raise exception '상품을 찾을 수 없습니다: %', coalesce(nullif(trim(p_code), ''), '(코드 없음)');
  end if;
  v_stock := coalesce(v_prod.stock, 0);

  if v_type = 'IN' then
    v_in      := coalesce(p_in_date, v_date);
    v_price   := coalesce(nullif(p_price, 0), nullif(v_prod.in_price, 0), 0);
    v_amount  := round(v_qty * v_price, 2);
    v_lotno   := coalesce(nullif(trim(p_lot_no), ''), public.fp_next_lot_no(v_prod.code, v_in));

    select * into v_lot from fp_lots
     where code = v_prod.code
       and lot_no = v_lotno
       and in_date  is not distinct from v_in
       and exp_date is not distinct from p_expiry
     order by id limit 1;

    if v_lot.id is null then
      insert into fp_lots (code, lot_no, category, name, spec, unit, in_date, exp_date,
                           qty, in_price, out_price, supplier)
      values (v_prod.code, v_lotno, v_prod.category, v_prod.name, v_prod.spec, v_prod.unit,
              v_in, p_expiry, v_qty, v_price, coalesce(v_prod.out_price, 0), coalesce(p_partner, ''))
      returning * into v_lot;
    else
      update fp_lots set qty = round(qty + v_qty, 3),
                         in_price = case when v_price > 0 then v_price else in_price end,
                         out_price = coalesce(v_prod.out_price, out_price),
                         updated_at = now()
       where id = v_lot.id returning * into v_lot;
    end if;

    update fp_products set
      stock     = round(stock + v_qty, 3),
      in_price  = case when v_price > 0 then v_price else in_price end,
      updated_at = now()
    where code = v_prod.code returning * into v_prod;
    v_stock := v_prod.stock;

  else
    v_price  := coalesce(nullif(p_price, 0), nullif(v_prod.out_price, 0), 0);
    v_amount := round(v_qty * v_price, 2);

    if not coalesce(p_allow_negative, false) and v_stock + 0.0004 < v_qty then
      raise exception '재고가 모자랍니다. % % (현재 % %)',
        v_prod.name, round(v_qty, 3), round(v_stock, 3), coalesce(nullif(v_prod.unit, ''), '개');
    end if;

    if p_lot_id is not null then
      select * into v_lot from fp_lots where id = p_lot_id for update;
      if v_lot.id is null then raise exception '출고 로트를 찾을 수 없습니다.'; end if;
      if not coalesce(p_allow_negative, false) and coalesce(v_lot.qty, 0) + 0.0004 < v_qty then
        raise exception '선택한 로트의 재고가 모자랍니다. (로트 %, 현재 % %)',
          v_lot.lot_no, round(coalesce(v_lot.qty, 0), 3), coalesce(nullif(v_lot.unit, ''), '개');
      end if;
      update fp_lots set qty = round(qty - v_qty, 3), updated_at = now()
       where id = v_lot.id returning * into v_lot;

    else
      -- 소비기한이 빠른 로트부터 (없으면 입고일 순)
      v_need := v_qty;
      for rec in
        select * from fp_lots
         where code = v_prod.code and qty > 0
         order by exp_date nulls last, in_date nulls last, id
         for update
      loop
        exit when v_need <= 0.0004;
        v_take := least(rec.qty, v_need);
        update fp_lots set qty = round(qty - v_take, 3), updated_at = now() where id = rec.id;
        if v_lot.id is null or v_need - v_take < 0.0005 then
          select * into v_lot from fp_lots where id = rec.id;
        end if;
        v_need := round(v_need - v_take, 3);
      end loop;

      if v_need > 0.0004 then
        if not coalesce(p_allow_negative, false) then
          raise exception '로트 재고가 모자랍니다. % (필요 % % · 남은 로트 %)',
            v_prod.name, round(v_need, 3), coalesce(nullif(v_prod.unit, ''), '개'),
            (select count(*) from fp_lots where code = v_prod.code and qty > 0);
        end if;
        -- 마이너스 허용: 마지막 로트(또는 자동 로트)에서 부족분을 그대로 뺀다
        if v_lot.id is null then
          insert into fp_lots (code, lot_no, category, name, spec, unit, in_date, exp_date, qty, in_price, out_price)
          values (v_prod.code, public.fp_next_lot_no(v_prod.code, v_date), v_prod.category, v_prod.name,
                  v_prod.spec, v_prod.unit, v_date, p_expiry, 0, v_price, coalesce(v_prod.out_price, 0))
          returning * into v_lot;
        end if;
        update fp_lots set qty = round(qty - v_need, 3), updated_at = now()
         where id = v_lot.id returning * into v_lot;
      end if;
    end if;

    update fp_products set
      stock     = round(stock - v_qty, 3),
      out_price = case when v_price > 0 then v_price else out_price end,
      updated_at = now()
    where code = v_prod.code returning * into v_prod;
    v_stock := v_prod.stock;
  end if;

  insert into fp_logs (tx_date, tx_type, code, name, category, spec, unit, qty,
                       in_price, out_price, amount, expiry, partner, note, source,
                       worker_name, worker_email, undone, lot_id, lot_no, in_date)
  values (v_date, v_type, v_prod.code, v_prod.name, v_prod.category, v_prod.spec, v_prod.unit, v_qty,
          case when v_type = 'IN' then v_price else coalesce(v_prod.in_price, 0) end,
          case when v_type = 'OUT' then v_price else coalesce(v_prod.out_price, 0) end,
          v_amount,
          case when v_type = 'IN' then p_expiry else v_lot.exp_date end,
          coalesce(p_partner, ''), coalesce(p_note, ''), coalesce(nullif(p_source, ''), 'manual'),
          public.fn_worker_name(), public.fn_worker_email(), false,
          v_lot.id, coalesce(v_lot.lot_no, ''), coalesce(v_lot.in_date, v_in))
  returning * into v_row;

  return v_row;
end $$;

/* 완제품 입출고 취소 */
create or replace function public.fp_tx_undo(p_log_id bigint)
returns public.fp_logs
language plpgsql security definer set search_path = public as $$
declare v_log public.fp_logs;
begin
  perform public.require_login();
  select * into v_log from fp_logs where id = p_log_id for update;
  if v_log.id is null then raise exception '이력을 찾을 수 없습니다.'; end if;
  if v_log.undone then raise exception '이미 취소된 이력입니다.'; end if;

  if v_log.tx_type = 'IN' then
    update fp_products set stock = round(stock - v_log.qty, 3), updated_at = now()
     where code = v_log.code;
    if v_log.lot_id is not null then
      update fp_lots set qty = round(qty - v_log.qty, 3), updated_at = now() where id = v_log.lot_id;
    end if;
  else
    update fp_products set stock = round(stock + v_log.qty, 3), updated_at = now()
     where code = v_log.code;
    if v_log.lot_id is not null then
      update fp_lots set qty = round(qty + v_log.qty, 3), updated_at = now() where id = v_log.lot_id;
    end if;
  end if;

  update fp_logs set undone = true where id = p_log_id returning * into v_log;
  return v_log;
end $$;

/* 엑셀 올리기 — 여러 건 입출고 */
create or replace function public.fp_batch(p_rows jsonb, p_allow_negative boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e         jsonb;
  i         int := 0;
  v_ok      int := 0;
  v_fail    int := 0;
  v_amount  numeric := 0;
  v_errs    jsonb := '[]'::jsonb;
  v_code    text;
  v_name    text;
  v_res     public.fp_logs;
  v_prod    public.fp_products;
begin
  perform public.require_login();
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '올릴 줄이 없습니다.';
  end if;

  for e in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_code := coalesce(e ->> 'code', '');
    v_name := coalesce(e ->> 'name', '');
    begin
      if trim(v_code) = '' then
        select * into v_prod from fp_products where trim(name) = trim(v_name) limit 1;
        if v_prod.code is null then
          raise exception '상품을 찾을 수 없습니다: %', coalesce(nullif(trim(v_name), ''), '(이름 없음)');
        end if;
        v_code := v_prod.code;
      end if;

      v_res := public.fp_tx_apply(
        p_code      => v_code,
        p_type      => coalesce(e ->> 'type', 'IN'),
        p_qty       => coalesce((e ->> 'qty')::numeric, 0),
        p_date      => nullif(e ->> 'date', '')::date,
        p_price     => nullif(e ->> 'price', '')::numeric,
        p_expiry    => nullif(e ->> 'expiry', '')::date,
        p_partner   => coalesce(e ->> 'partner', ''),
        p_note      => coalesce(e ->> 'note', ''),
        p_allow_negative => coalesce(p_allow_negative, false),
        p_source    => 'manual',
        p_lot_no    => coalesce(e ->> 'lot_no', ''),
        p_lot_id    => null,
        p_in_date   => nullif(e ->> 'in_date', '')::date
      );
      v_ok := v_ok + 1;
      v_amount := v_amount + coalesce(v_res.amount, 0);
    exception when others then
      v_fail := v_fail + 1;
      v_errs := v_errs || jsonb_build_object('row', i, 'code', v_code, 'name', v_name, 'msg', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('ok', v_ok, 'fail', v_fail, 'amount', v_amount, 'errors', v_errs);
end $$;

/* 엑셀 올리기 — 단가 일괄 수정 */
create or replace function public.fp_batch_price(p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e      jsonb;
  i      int := 0;
  v_ok   int := 0;
  v_fail int := 0;
  v_errs jsonb := '[]'::jsonb;
  v_code text;
  v_name text;
  v_spec text;
  v_in   numeric;
  v_out  numeric;
  v_cnt  int;
begin
  perform public.require_login();
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '올릴 줄이 없습니다.';
  end if;

  for e in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_code := coalesce(e ->> 'code', '');
    v_name := coalesce(e ->> 'name', '');
    v_spec := coalesce(e ->> 'spec', '');
    v_in   := nullif(e ->> 'in_price', '')::numeric;
    v_out  := nullif(e ->> 'out_price', '')::numeric;
    begin
      update fp_products set
        in_price  = coalesce(v_in, in_price),
        out_price = coalesce(v_out, out_price),
        updated_at = now()
      where (trim(v_code) <> '' and code = trim(v_code))
         or (trim(v_code) = '' and trim(name) = trim(v_name)
             and (trim(v_spec) = '' or trim(spec) = trim(v_spec)));
      get diagnostics v_cnt = row_count;
      if v_cnt = 0 then
        raise exception '상품을 찾을 수 없습니다: %', coalesce(nullif(trim(v_code), ''), nullif(trim(v_name), ''), '(빈 줄)');
      end if;
      v_ok := v_ok + 1;
    exception when others then
      v_fail := v_fail + 1;
      v_errs := v_errs || jsonb_build_object('code', v_code, 'name', v_name, 'msg', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('ok', v_ok, 'fail', v_fail, 'errors', v_errs);
end $$;

-- ===========================================================================
-- 12. 회계 함수
-- ===========================================================================
/* 금액 → 공급가·부가세·합계 */
create or replace function public.acc_split(p_amount numeric, p_tax_type text, p_included boolean)
returns table (supply numeric, vat numeric, total numeric)
language sql immutable as $$
  select
    case when p_tax_type = 'free' then round(coalesce(p_amount, 0), 2)
         when p_included then round(coalesce(p_amount, 0) / 1.1, 2)
         else round(coalesce(p_amount, 0), 2) end,
    case when p_tax_type = 'free' then 0
         when p_included then round(coalesce(p_amount, 0) - round(coalesce(p_amount, 0) / 1.1, 2), 2)
         else round(coalesce(p_amount, 0) * 0.1, 2) end,
    case when p_tax_type = 'free' then round(coalesce(p_amount, 0), 2)
         when p_included then round(coalesce(p_amount, 0), 2)
         else round(coalesce(p_amount, 0) + round(coalesce(p_amount, 0) * 0.1, 2), 2) end
$$;

create or replace function public.acc_voucher_save(
  p_id           bigint,
  p_date         date,
  p_type         text,
  p_partner      text,
  p_tax_type     text,
  p_amount       numeric,
  p_vat_included boolean default false,
  p_tax_status   text    default 'none',
  p_note         text    default ''
) returns public.acc_vouchers
language plpgsql security definer set search_path = public as $$
declare
  v_row public.acc_vouchers;
  v_tax text := case when p_tax_type = 'free' then 'free' else 'tax' end;
  v_s   numeric;
  v_v   numeric;
  v_t   numeric;
begin
  perform public.require_login();
  select supply, vat, total into v_s, v_v, v_t
    from public.acc_split(coalesce(p_amount, 0), v_tax, coalesce(p_vat_included, false));

  if p_id is null or p_id <= 0 then
    insert into acc_vouchers (v_date, v_type, partner, tax_type, supply_amount, vat_amount,
                              total_amount, tax_status, note, source, worker_name, worker_email)
    values (coalesce(p_date, current_date),
            case when p_type = 'purchase' then 'purchase' else 'sale' end,
            coalesce(p_partner, ''), v_tax, v_s, v_v, v_t,
            coalesce(nullif(p_tax_status, ''), 'none'), coalesce(p_note, ''), 'manual',
            public.fn_worker_name(), public.fn_worker_email())
    returning * into v_row;
  else
    update acc_vouchers set
      v_date        = coalesce(p_date, v_date),
      v_type        = case when p_type = 'purchase' then 'purchase' else 'sale' end,
      partner       = coalesce(p_partner, partner),
      tax_type      = v_tax,
      supply_amount = v_s,
      vat_amount    = v_v,
      total_amount  = v_t,
      tax_status    = coalesce(nullif(p_tax_status, ''), tax_status),
      note          = coalesce(p_note, note)
    where id = p_id
    returning * into v_row;
    if v_row.id is null then raise exception '전표를 찾을 수 없습니다.'; end if;
  end if;

  return v_row;
end $$;

create or replace function public.acc_voucher_delete(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.require_login();
  delete from acc_vouchers where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.acc_payment_save(
  p_id     bigint,
  p_date   date,
  p_partner text,
  p_type   text,
  p_amount numeric,
  p_method text default '',
  p_note   text default ''
) returns public.acc_payments
language plpgsql security definer set search_path = public as $$
declare v_row public.acc_payments;
begin
  perform public.require_login();
  if coalesce(p_amount, 0) = 0 then raise exception '금액을 입력하세요.'; end if;

  if p_id is null or p_id <= 0 then
    insert into acc_payments (p_date, partner, p_type, amount, method, note, worker_name, worker_email)
    values (coalesce(p_date, current_date), coalesce(p_partner, ''),
            case when p_type = 'out' then 'out' else 'in' end,
            round(p_amount, 2), coalesce(p_method, ''), coalesce(p_note, ''),
            public.fn_worker_name(), public.fn_worker_email())
    returning * into v_row;
  else
    update acc_payments set
      p_date  = coalesce(p_date, p_date),
      partner = coalesce(p_partner, partner),
      p_type  = case when p_type = 'out' then 'out' else 'in' end,
      amount  = round(p_amount, 2),
      method  = coalesce(p_method, method),
      note    = coalesce(p_note, note)
    where id = p_id
    returning * into v_row;
    if v_row.id is null then raise exception '수금·지급 내역을 찾을 수 없습니다.'; end if;
  end if;

  return v_row;
end $$;

create or replace function public.acc_payment_delete(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.require_login();
  delete from acc_payments where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.acc_expense_save(
  p_id           bigint,
  p_date         date,
  p_type         text,
  p_category     text,
  p_partner      text,
  p_amount       numeric,
  p_tax_type     text    default 'free',
  p_vat_included boolean default true,
  p_method       text    default '',
  p_note         text    default ''
) returns public.acc_expenses
language plpgsql security definer set search_path = public as $$
declare
  v_row public.acc_expenses;
  v_tax text := case when p_tax_type = 'tax' then 'tax' else 'free' end;
  v_s   numeric;
  v_v   numeric;
  v_t   numeric;
begin
  perform public.require_login();
  select supply, vat, total into v_s, v_v, v_t
    from public.acc_split(coalesce(p_amount, 0), v_tax, coalesce(p_vat_included, true));

  if p_id is null or p_id <= 0 then
    insert into acc_expenses (e_date, e_type, category, partner, supply_amount, vat_amount,
                              amount, tax_type, method, note, worker_name, worker_email)
    values (coalesce(p_date, current_date),
            case when p_type = 'income' then 'income' else 'expense' end,
            coalesce(nullif(p_category, ''), '기타'), coalesce(p_partner, ''),
            v_s, v_v, v_t, v_tax, coalesce(p_method, ''), coalesce(p_note, ''),
            public.fn_worker_name(), public.fn_worker_email())
    returning * into v_row;
  else
    update acc_expenses set
      e_date        = coalesce(p_date, e_date),
      e_type        = case when p_type = 'income' then 'income' else 'expense' end,
      category      = coalesce(nullif(p_category, ''), category),
      partner       = coalesce(p_partner, partner),
      supply_amount = v_s,
      vat_amount    = v_v,
      amount        = v_t,
      tax_type      = v_tax,
      method        = coalesce(p_method, method),
      note          = coalesce(p_note, note)
    where id = p_id
    returning * into v_row;
    if v_row.id is null then raise exception '경비 내역을 찾을 수 없습니다.'; end if;
  end if;

  return v_row;
end $$;

create or replace function public.acc_expense_delete(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.require_login();
  delete from acc_expenses where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

/* 입출고 이력 → 매입·매출 전표 (source_kind + source_id 로 중복 방지) */
create or replace function public.acc_reflect(p_items jsonb, p_tax_type text default 'auto')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e        jsonb;
  v_kind   text;
  v_id     bigint;
  v_ok     int := 0;
  v_skip   int := 0;
  v_zero   int := 0;
  v_miss   int := 0;
  v_ids    jsonb := '[]'::jsonb;
  v_exist  bigint;
  v_date   date;
  v_type   text;
  v_partner text;
  v_amount numeric;
  v_name   text;
  v_qty    numeric;
  v_unit   text;
  v_tax    text;
  v_s      numeric;
  v_v      numeric;
  v_t      numeric;
  v_lid    bigint;
  v_log    public.tx_logs;
  v_fp     public.fp_logs;
begin
  perform public.require_login();
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return jsonb_build_object('ok', 0, 'skip', 0, 'zero', 0, 'miss', 0, 'ids', v_ids);
  end if;

  for e in select * from jsonb_array_elements(p_items) loop
    v_kind := coalesce(e ->> 'kind', '');
    v_id   := coalesce((e ->> 'id')::bigint, 0);
    v_lid  := null;

    if v_id <= 0 or v_kind not in ('meat', 'fp') then
      v_miss := v_miss + 1;
      v_ids := v_ids || '0'::jsonb;
      continue;
    end if;

    select id into v_exist from acc_vouchers
     where source_kind = v_kind and source_id = v_id limit 1;
    if v_exist is not null then
      v_skip := v_skip + 1;
      v_ids := v_ids || to_jsonb(v_exist);
      continue;
    end if;

    if v_kind = 'meat' then
      select * into v_log from tx_logs where id = v_id;
      if v_log.id is null then
        v_miss := v_miss + 1; v_ids := v_ids || '0'::jsonb; continue;
      end if;
      v_date    := v_log.tx_date;
      v_type    := case when v_log.tx_type = 'in' then 'purchase' else 'sale' end;
      v_partner := case when v_log.tx_type = 'in' then coalesce(v_log.vendor, '') else coalesce(v_log.dest_detail, '') end;
      v_amount  := coalesce(v_log.total_amount, 0);
      v_name    := v_log.product_name;
      v_qty     := v_log.qty;
      v_unit    := 'kg';
      v_tax     := case when p_tax_type in ('tax', 'free') then p_tax_type else 'free' end;
    else
      select * into v_fp from fp_logs where id = v_id;
      if v_fp.id is null then
        v_miss := v_miss + 1; v_ids := v_ids || '0'::jsonb; continue;
      end if;
      if v_fp.undone then
        v_zero := v_zero + 1; v_ids := v_ids || '0'::jsonb; continue;
      end if;
      if v_fp.tx_type = 'IN' and (coalesce(v_fp.partner, '') = '자체생산'
          or position('[자체생산]' in coalesce(v_fp.note, '')) > 0) then
        v_zero := v_zero + 1; v_ids := v_ids || '0'::jsonb; continue;
      end if;
      v_date    := v_fp.tx_date;
      v_type    := case when v_fp.tx_type = 'IN' then 'purchase' else 'sale' end;
      v_partner := coalesce(v_fp.partner, '');
      v_amount  := coalesce(v_fp.amount, 0);
      v_name    := v_fp.name;
      v_qty     := v_fp.qty;
      v_unit    := coalesce(nullif(v_fp.unit, ''), '개');
      v_tax     := case when p_tax_type in ('tax', 'free') then p_tax_type else 'tax' end;
    end if;

    if v_amount <= 0 then
      v_zero := v_zero + 1; v_ids := v_ids || '0'::jsonb; continue;
    end if;

    select supply, vat, total into v_s, v_v, v_t
      from public.acc_split(v_amount, v_tax, false);

    insert into acc_vouchers (v_date, v_type, partner, tax_type, supply_amount, vat_amount,
                              total_amount, tax_status, note, source, source_kind, source_id,
                              worker_name, worker_email)
    values (v_date, v_type, v_partner, v_tax, v_s, v_v, v_t, 'none',
            trim(both ' ' from (coalesce(v_name, '') || ' ' || round(v_qty, 3)::text || v_unit)),
            'auto', v_kind, v_id, public.fn_worker_name(), public.fn_worker_email())
    returning id into v_lid;

    v_ok := v_ok + 1;
    v_ids := v_ids || to_jsonb(v_lid);
  end loop;

  return jsonb_build_object('ok', v_ok, 'skip', v_skip, 'zero', v_zero, 'miss', v_miss, 'ids', v_ids);
end $$;

-- ===========================================================================
-- 13. 입고 사진 대기함 함수
-- ===========================================================================
create or replace function public.photo_upload(
  p_image text,
  p_file  text default '',
  p_memo  text default '',
  p_name  text default ''
) returns public.inbound_photos
language plpgsql security definer set search_path = public as $$
declare v_row public.inbound_photos;
begin
  perform public.require_login();
  if coalesce(p_image, '') = '' then raise exception '사진이 비어 있습니다.'; end if;
  insert into inbound_photos (image_data, file_name, memo, uploader_name, status)
  values (p_image, coalesce(p_file, ''), coalesce(p_memo, ''),
          coalesce(nullif(trim(p_name), ''), public.fn_worker_name()), 'pending')
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.photo_mark(p_id bigint, p_status text default 'registered', p_lot_id bigint default null)
returns public.inbound_photos
language plpgsql security definer set search_path = public as $$
declare v_row public.inbound_photos;
begin
  perform public.require_login();
  update inbound_photos set
    status = case when p_status = 'pending' then 'pending' else 'registered' end,
    lot_id = coalesce(p_lot_id, lot_id)
  where id = p_id
  returning * into v_row;
  if v_row.id is null then raise exception '사진을 찾을 수 없습니다.'; end if;
  return v_row;
end $$;

create or replace function public.photo_delete(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.require_login();
  delete from inbound_photos where id = p_id and status = 'pending';
  return jsonb_build_object('ok', true);
end $$;

-- ===========================================================================
-- 14. RLS · 권한 · 실시간
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['lots','tx_logs','fp_products','fp_logs','fp_lots',
                           'acc_vouchers','acc_payments','acc_expenses','inbound_photos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s_authenticated_all" on public.%I', t, t);
    execute format('create policy "%s_authenticated_all" on public.%I for all to authenticated using (true) with check (true)', t, t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

grant usage on schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

revoke execute on all functions in schema public from anon;
revoke execute on all functions in schema public from public;
grant execute on all functions in schema public to authenticated;

do $$
declare t text;
begin
  foreach t in array array['lots','tx_logs','fp_products','fp_logs','acc_vouchers',
                           'acc_payments','acc_expenses','inbound_photos'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
              when undefined_object then null;
    end;
  end loop;
end $$;

-- ===========================================================================
-- 15. 확인
-- ===========================================================================
select
  (select count(*) from lots)            as 로트수,
  (select coalesce(sum(frozen_qty), 0) from lots)  as 냉동총재고kg,
  (select coalesce(sum(chilled_qty), 0) from lots) as 냉장총재고kg,
  (select count(*) from tx_logs)         as 입출고이력수,
  (select count(*) from fp_products)     as 완제품품목수,
  (select count(*) from fp_lots)         as 완제품로트수,
  (select count(*) from acc_vouchers)    as 회계전표수,
  (select count(*) from inbound_photos)  as 입고사진대기;
