-- RLS(Row Level Security) 전용 보안 검증 스크립트.
--
-- 왜 integrity_check.sql과 분리했는가: RLS를 SQL로 검증하려면 `set local role authenticated`
-- 로 세션 역할을 바꿔야 하는데, `reset role`을 한 번이라도 빠뜨리면 그 뒤 모든 테스트가
-- 권한 에러로 무너진다. RLS 실수는 "남의 데이터가 보인다"는 실제 보안 사고로 직결되므로,
-- 무결성 검증(제약/함수)과 섞지 않고 여기서만 다룬다.
--
-- 배경: 2026-09-12 사용자 식별자 분리 이후 RLS 정책 8개가
-- auth.uid() 직접 비교에서 current_profile_id() 경유 비교로 전부 바뀌었다. 이 스크립트는
-- 그 재작성이 "아무에게도 안 보임"도 "누구에게나 보임"도 아니라 "본인에게만 보임"으로
-- 정확히 동작하는지 확인한다.
--
-- 핵심 설계: 픽스처에서 public.users.id와 auth.users.id를 의도적으로 다른 값으로 둔다.
-- 두 값이 같으면 이 작업이 고치려는 버그(예: 정책이 auth.uid()를 profile id에 잘못 비교)를
-- 하나도 잡아낼 수 없다 — 협상 대상이 아니다.
--
-- 실행 방법 (로컬 Supabase가 떠 있어야 함, `npm run db:start`):
--   docker exec -i supabase_db_class-desk psql -U postgres -d postgres \
--     < supabase/tests/rls_check.sql
--
-- 모든 줄이 "RLSn PASS: ..."로 끝나야 정상이다. "FAIL"이 하나라도 보이면 보안 회귀다.

begin;

-- =========================================================
-- 픽스처: 학생 A, 학생 B, 관리자 C — 각각 auth 계정과 프로필의 id가 서로 다르다.
-- =========================================================
insert into public.courses (id, name, category) values
  ('20000000-0000-0000-0000-000000000001', 'RLS검증강의', 'IT');

insert into public.course_offerings
  (id, course_id, label, capacity, remaining_seats, price, recruit_opens_at, opens_at, ends_at, status)
values
  ('20000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000001', 'RLS기', 10, 8, 50000, now() - interval '2 days', now() - interval '1 day', now() + interval '30 days', 'OPEN');

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'rls-a@example.com'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'rls-b@example.com'),
  ('aaaaaaaa-0000-0000-0000-00000000000c', 'rls-admin@example.com'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', 'rls-noprofile@example.com'); -- 프로필 없는 인증 계정(RLS5용)

insert into public.users (id, auth_user_id, email, role) values
  ('11111111-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000a', 'rls-a@example.com', 'STUDENT'),
  ('11111111-0000-0000-0000-00000000000b', 'aaaaaaaa-0000-0000-0000-00000000000b', 'rls-b@example.com', 'STUDENT'),
  ('11111111-0000-0000-0000-00000000000c', 'aaaaaaaa-0000-0000-0000-00000000000c', 'rls-admin@example.com', 'ADMIN');

-- 매니저 픽스처(RLS10~14용, 2026-09-18): e=조회권한 있음, f=권한 전부 꺼짐, g=박탈됨(revoked_at
-- 있지만 can_view_students는 실수로 true인 상태 — has_permission()이 revoked_at을 제대로
-- 보는지 확인하려는 의도적 모순 픽스처).
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000e0', 'rls-manager-view@example.com'),
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'rls-manager-none@example.com'),
  ('aaaaaaaa-0000-0000-0000-0000000000e2', 'rls-manager-revoked@example.com');

insert into public.users (id, auth_user_id, email, role) values
  ('11111111-0000-0000-0000-0000000000e0', 'aaaaaaaa-0000-0000-0000-0000000000e0', 'rls-manager-view@example.com', 'MANAGER'),
  ('11111111-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'rls-manager-none@example.com', 'MANAGER'),
  ('11111111-0000-0000-0000-0000000000e2', 'aaaaaaaa-0000-0000-0000-0000000000e2', 'rls-manager-revoked@example.com', 'MANAGER');

insert into public.manager_permissions (user_id, can_view_students, can_approve_orders, can_approve_payments, granted_by, revoked_at, revoked_reason, revoked_by) values
  ('11111111-0000-0000-0000-0000000000e0', true, false, false, '11111111-0000-0000-0000-00000000000c', null, null, null),
  ('11111111-0000-0000-0000-0000000000e1', false, false, false, '11111111-0000-0000-0000-00000000000c', null, null, null),
  ('11111111-0000-0000-0000-0000000000e2', true, true, false, '11111111-0000-0000-0000-00000000000c', now(), 'RLS 테스트 박탈', '11111111-0000-0000-0000-00000000000c');

-- A, B 각각에 orders/payment_events/entitlements/entitlement_uses/terms_agreements/
-- order_events를 1건씩 만든다.
insert into public.orders (id, user_id, course_offering_id, status, payment_status, approved_at, paid_at, payment_method, list_price, final_amount) values
  ('30000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-000000000010', 'APPROVED', 'PAID', now(), now(), 'CARD', 50000, 50000),
  ('30000000-0000-0000-0000-00000000000b', '11111111-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-000000000010', 'APPROVED', 'PAID', now(), now(), 'CARD', 50000, 50000);

insert into public.order_events (event_type, actor, order_id) values
  ('APPLIED', 'SYSTEM', '30000000-0000-0000-0000-00000000000a'),
  ('APPLIED', 'SYSTEM', '30000000-0000-0000-0000-00000000000b');

-- purpose·user_id는 5단계(물품 추가, 2026-09-23)에서 삭제됐다 — order_id만으로 주문을
-- 안다(orders.user_id를 조인해서 본인 여부를 판정).
insert into public.payment_events (id, provider, provider_event_id, event_type, amount, currency, order_id) values
  ('40000000-0000-0000-0000-00000000000a', 'MOCK', 'rls-evt-a', 'PAYMENT_SUCCEEDED', 50000, 'KRW', '30000000-0000-0000-0000-00000000000a'),
  ('40000000-0000-0000-0000-00000000000b', 'MOCK', 'rls-evt-b', 'PAYMENT_SUCCEEDED', 50000, 'KRW', '30000000-0000-0000-0000-00000000000b');

insert into public.entitlements (id, user_id, type, order_id, payment_event_id, access_code) values
  ('50000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-00000000000a', 'COURSE_ACCESS', '30000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-00000000000a', 'RLSCHECKCODEAAAA'),
  ('50000000-0000-0000-0000-00000000000b', '11111111-0000-0000-0000-00000000000b', 'COURSE_ACCESS', '30000000-0000-0000-0000-00000000000b', '40000000-0000-0000-0000-00000000000b', 'RLSCHECKCODEBBBB');

insert into public.entitlement_uses (entitlement_id) values
  ('50000000-0000-0000-0000-00000000000a'),
  ('50000000-0000-0000-0000-00000000000b');

insert into public.terms_agreements (user_id, terms_id)
select u.id, t.id from public.users u, public.terms t
where u.id in ('11111111-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-00000000000b')
  and t.type = 'SERVICE_USE'
order by t.effective_at desc limit 2;

-- sync_my_email() 픽스처 — auth.users.email과 public.users.email을 의도적으로
-- 다르게 둔다(마치 학생이 Supabase에서 인증 이메일을 바꾼 직후처럼).
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000f0', 'rls-sync-new@example.com');
insert into public.users (id, auth_user_id, email, role) values
  ('11111111-0000-0000-0000-0000000000f0', 'aaaaaaaa-0000-0000-0000-0000000000f0', 'rls-sync-old@example.com', 'STUDENT');

-- =========================================================
-- 공용 헬퍼: 세션을 흉내내고 7개 테이블 행 개수를 한 번에 센다.
-- =========================================================
create temporary table rls_counts (
  users_n integer, enr_n integer, ev_n integer, pay_n integer,
  ent_n integer, uses_n integer, ta_n integer
);

-- =========================================================
-- RLS1~RLS2: 학생 A 세션 — 자기 것만 보이고, 남(B)의 행을 명시 지정해도 0건.
-- =========================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);

do $$
declare
  v_users int; v_enr int; v_ev int; v_pay int; v_ent int; v_uses int; v_ta int;
begin
  select count(*) into v_users from public.users;
  select count(*) into v_enr from public.orders;
  select count(*) into v_ev from public.order_events;
  select count(*) into v_pay from public.payment_events;
  select count(*) into v_ent from public.entitlements;
  select count(*) into v_uses from public.entitlement_uses;
  select count(*) into v_ta from public.terms_agreements;

  if v_users = 1 and v_enr = 1 and v_ev = 1 and v_pay = 1 and v_ent = 1 and v_uses = 1 and v_ta = 1 then
    raise notice 'RLS1 PASS: 학생 A에게는 자기 행만 보인다(7개 테이블 전부 1건씩)';
  else
    raise notice 'RLS1 FAIL: users=%, enr=%, ev=%, pay=%, ent=%, uses=%, ta=%', v_users, v_enr, v_ev, v_pay, v_ent, v_uses, v_ta;
  end if;
end $$;

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.orders where id = '30000000-0000-0000-0000-00000000000b';
  if v_count = 0 then
    raise notice 'RLS2 PASS: B의 행 id를 명시 지정해도 학생 A에게는 0건';
  else
    raise notice 'RLS2 FAIL: B의 enrollment이 A 세션에 %건 보임', v_count;
  end if;
end $$;

-- RLS7: users는 SELECT 정책만 있고 UPDATE/DELETE 정책이 없다. Postgres RLS는 이 경우
-- 예외를 던지지 않는다 — authenticated 롤에는 테이블 수준 UPDATE 권한 자체는 있지만
-- (Supabase 기본 GRANT), 정책이 없는 명령은 대상 행이 0건으로 취급되어 "에러 없이 0행
-- 변경"으로 조용히 끝난다. 그래서 예외가 아니라 실제 변경 여부(row_count/값)로 검증한다.
do $$
declare
  v_row_count int;
  v_name_after text;
begin
  update public.users set name = '해킹시도' where id = '11111111-0000-0000-0000-00000000000b';
  get diagnostics v_row_count = row_count;

  select name into v_name_after from public.users where id = '11111111-0000-0000-0000-00000000000b';

  if v_row_count = 0 and v_name_after is null then
    raise notice 'RLS7 PASS: users UPDATE는 정책이 없어 0행에만 적용됨(B의 데이터는 안 바뀜)';
  else
    raise notice 'RLS7 FAIL: 학생 A가 B의 프로필을 UPDATE함(row_count=%, name=%)', v_row_count, v_name_after;
  end if;
end $$;

-- RLS8: A가 B의 user_id로 terms_agreements를 INSERT하려 하면 with check 위반.
do $$
declare
  v_terms_id uuid;
begin
  select id into v_terms_id from public.terms where type = 'SERVICE_USE' order by effective_at desc limit 1;
  begin
    insert into public.terms_agreements (user_id, terms_id) values ('11111111-0000-0000-0000-00000000000b', v_terms_id);
    raise notice 'RLS8 FAIL: 학생 A가 B 명의로 terms_agreements를 INSERT할 수 있음';
  exception when insufficient_privilege then
    raise notice 'RLS8 PASS: with check(user_id = current_profile_id())가 B 명의 INSERT를 거부함';
  end;
end $$;

-- RLS9: payment_events의 enrollment 경유 경로도 독립적으로 확인 — B의 enrollment을 가진
-- payment_events가 A에게 안 보여야 한다(이 정책은 orders RLS에 의존하므로 따로 검증).
do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.payment_events where order_id = '30000000-0000-0000-0000-00000000000b';
  if v_count = 0 then
    raise notice 'RLS9 PASS: B의 enrollment을 경유한 payment_events도 A에게 0건';
  else
    raise notice 'RLS9 FAIL: %건 보임', v_count;
  end if;
end $$;

reset role;

-- =========================================================
-- RLS3: 관리자 세션 — users 전체가 보여야 한다(is_admin() 재작성 검증).
-- =========================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000c","role":"authenticated"}', true);

do $$
declare
  v_count int;
begin
  -- 절댓값(전체 행 수)이 아니라 이 픽스처 6명(a,b,c,e0,e1,e2 — 학생·관리자·매니저를 고루 섞음)이
  -- 전부 보이는지로 판정한다. 이전엔 users 테이블 전체 행 수를 세서, e2e나 다른 테스트가 남긴
  -- 회원이 있으면 실패했다(D단계 R-STOP의 원인이었다).
  select count(*) into v_count from public.users
  where id in (
    '11111111-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-00000000000b',
    '11111111-0000-0000-0000-00000000000c',
    '11111111-0000-0000-0000-0000000000e0', '11111111-0000-0000-0000-0000000000e1',
    '11111111-0000-0000-0000-0000000000e2'
  );
  if v_count = 6 then
    raise notice 'RLS3 PASS: 관리자에게는 이 픽스처 6명이 전부 보임(역할 3종 포함) — is_admin() 재작성 정상';
  else
    raise notice 'RLS3 FAIL: 관리자에게 픽스처 6명 중 %건만 보임', v_count;
  end if;
end $$;

reset role;

-- =========================================================
-- RLS4: anon(claims 없음) — 전부 0건이어야 한다.
-- =========================================================
set local role authenticated;
select set_config('request.jwt.claims', '{}', true);

do $$
declare
  v_users int; v_enr int;
begin
  select count(*) into v_users from public.users;
  select count(*) into v_enr from public.orders;
  if v_users = 0 and v_enr = 0 then
    raise notice 'RLS4 PASS: claims 없는 세션에는 아무 것도 안 보임';
  else
    raise notice 'RLS4 FAIL: users=%, enr=%', v_users, v_enr;
  end if;
end $$;

reset role;

-- =========================================================
-- RLS5: 프로필 없는 auth 계정(sub는 유효하지만 public.users에 매칭 행 없음) — fail-closed 확인.
-- current_profile_id()가 NULL을 반환할 때 "user_id = NULL"이 false로 평가되어야 한다.
-- coalesce나 "or ... is null" 같은 fail-open 표현이 섞였다면 여기서 전체 노출로 드러난다.
-- =========================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000d","role":"authenticated"}', true);

do $$
declare
  v_users int; v_enr int; v_ent int;
begin
  select count(*) into v_users from public.users;
  select count(*) into v_enr from public.orders;
  select count(*) into v_ent from public.entitlements;
  if v_users = 0 and v_enr = 0 and v_ent = 0 then
    raise notice 'RLS5 PASS: 프로필 없는 인증 계정에는 아무 것도 안 보임(fail-closed 확인)';
  else
    raise notice 'RLS5 FAIL: users=%, enr=%, ent=% — fail-open 의심(coalesce/is null 표현 확인)', v_users, v_enr, v_ent;
  end if;
end $$;

reset role;

-- =========================================================
-- RLS6 (가장 중요 — 롤백 회귀 탐지기): sub에 "프로필 id"를 넣는다(인증 계정 id가 아니라).
-- 만약 정책이 예전처럼 "auth.uid() = id"(즉 users.id를 직접 비교)로 롤백돼 있다면,
-- 프로필 id로 로그인한 것처럼 보여 A의 데이터가 조회된다 — 그게 FAIL이다.
-- 지금 설계(auth_user_id 경유)에서는 이 sub와 매칭되는 auth_user_id가 없으므로 0건이어야 정상.
-- =========================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-0000-0000-0000-00000000000a","role":"authenticated"}', true);

do $$
declare
  v_users int; v_enr int;
begin
  select count(*) into v_users from public.users;
  select count(*) into v_enr from public.orders;
  if v_users = 0 and v_enr = 0 then
    raise notice 'RLS6 PASS: profile id를 auth.uid()에 넣어도 안 보임 — auth_user_id 브릿지가 실제로 쓰이고 있음(auth.uid()=id 롤백 회귀 탐지기)';
  else
    raise notice 'RLS6 FAIL: users=%, enr=% — 정책이 auth.uid()=id로 되돌아갔을 가능성', v_users, v_enr;
  end if;
end $$;

reset role;

-- =========================================================
-- RLS10~14: 매니저 권한(2026-09-18, has_permission()·manager_permissions RLS)
-- =========================================================

-- RLS10: VIEW_STUDENTS 권한이 있는 매니저(e0) — STUDENT 2명(A,B) + 본인 행만 보이고,
-- ADMIN(C)과 다른 매니저(e1,e2)는 안 보여야 한다.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000e0","role":"authenticated"}', true);

do $$
declare
  v_students int;
  v_self int;
  v_admin_visible int;
  v_other_managers int;
begin
  -- 절댓값(전체 행 수)이 아니라 이 픽스처 안에서 보여야 할 것/안 보여야 할 것을 각각 센다
  -- (다른 테스트가 남긴 STUDENT 행에 흔들리지 않게).
  select count(*) into v_students from public.users
    where id in ('11111111-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-00000000000b');
  select count(*) into v_self from public.users where id = '11111111-0000-0000-0000-0000000000e0';
  select count(*) into v_admin_visible from public.users where id = '11111111-0000-0000-0000-00000000000c';
  select count(*) into v_other_managers from public.users
    where id in ('11111111-0000-0000-0000-0000000000e1', '11111111-0000-0000-0000-0000000000e2');
  if v_students = 2 and v_self = 1 and v_admin_visible = 0 and v_other_managers = 0 then
    raise notice 'RLS10 PASS: VIEW 권한 매니저에게 STUDENT 2명+본인만 보이고 ADMIN·다른 매니저는 안 보임';
  else
    raise notice 'RLS10 FAIL: STUDENT=%, 본인=%, ADMIN 노출=%, 다른 매니저 노출=%(기대: 2,1,0,0)',
      v_students, v_self, v_admin_visible, v_other_managers;
  end if;
end $$;

reset role;

-- RLS11: 권한이 전부 꺼진 매니저(e1) — 본인 행만 보이고 STUDENT는 0건.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000e1","role":"authenticated"}', true);

do $$
declare
  v_count int;
  v_a_visible int;
begin
  select count(*) into v_count from public.users;
  select count(*) into v_a_visible from public.users where id = '11111111-0000-0000-0000-00000000000a';
  if v_count = 1 and v_a_visible = 0 then
    raise notice 'RLS11 PASS: 권한 없는 매니저에게는 본인 행(1건)만 보이고 수강생은 0건';
  else
    raise notice 'RLS11 FAIL: 총 %건, A 노출 %건(기대: 1건, 0건)', v_count, v_a_visible;
  end if;
end $$;

reset role;

-- RLS12: 매니저는 관리자 전용 테이블(payment_events, audit_logs)은 여전히 0건 — is_admin()만
-- 쓰는 정책은 has_permission()과 무관하게 매니저를 계속 막아야 한다.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000e0","role":"authenticated"}', true);

do $$
declare
  v_pay int;
  v_audit int;
begin
  select count(*) into v_pay from public.payment_events;
  select count(*) into v_audit from public.audit_logs;
  if v_pay = 0 and v_audit = 0 then
    raise notice 'RLS12 PASS: VIEW 권한 매니저도 payment_events·audit_logs는 0건(is_admin() 전용 유지)';
  else
    raise notice 'RLS12 FAIL: payment_events=%, audit_logs=%', v_pay, v_audit;
  end if;
end $$;

reset role;

-- RLS13: 박탈된 매니저(e2, revoked_at 있음 — can_view_students=true인데도)는 학생·신청 모두 0건.
-- has_permission()이 revoked_at을 실제로 확인하는지 검증한다.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000e2","role":"authenticated"}', true);

do $$
declare
  v_users int;
  v_enr int;
begin
  select count(*) into v_users from public.users where role = 'STUDENT';
  select count(*) into v_enr from public.orders;
  if v_users = 0 and v_enr = 0 then
    raise notice 'RLS13 PASS: 박탈된 매니저(revoked_at 있음)는 can_view_students=true여도 학생·신청 모두 0건';
  else
    raise notice 'RLS13 FAIL: students=%, orders=%', v_users, v_enr;
  end if;
end $$;

reset role;

-- RLS14: manager_permissions 자체도 본인 행만 보인다(다른 매니저의 권한 설정은 안 보임).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000e0","role":"authenticated"}', true);

do $$
declare
  v_count int;
  v_other int;
begin
  select count(*) into v_count from public.manager_permissions;
  select count(*) into v_other from public.manager_permissions where user_id = '11111111-0000-0000-0000-0000000000e1';
  if v_count = 1 and v_other = 0 then
    raise notice 'RLS14 PASS: 매니저는 본인 권한 행(1건)만 보이고 다른 매니저(e1)의 권한은 안 보임';
  else
    raise notice 'RLS14 FAIL: 총 %건, e1 노출 %건(기대: 1건, 0건)', v_count, v_other;
  end if;
end $$;

reset role;

-- RLS15: 승인 권한(APPROVE_ORDERS)만 있는 매니저도 학생 행을 읽는다(2026-09-23 개명 때
-- users 정책이 옛 이름 APPROVE_ENROLLMENTS로 남아 있던 버그의 회귀 테스트).
update public.manager_permissions set can_approve_orders = true
  where user_id = '11111111-0000-0000-0000-0000000000e1' and revoked_at is null;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000e1","role":"authenticated"}', true);

do $$
declare
  v_students int;
begin
  -- 절댓값이 아니라 이 픽스처의 학생 2명(a,b)만 센다.
  select count(*) into v_students from public.users
    where role = 'STUDENT'
      and id in ('11111111-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-00000000000b');
  if v_students = 2 then
    raise notice 'RLS15 PASS: 승인 권한만 있는 매니저에게 픽스처 학생 2명이 보임';
  else
    raise notice 'RLS15 FAIL: 픽스처 학생 %건(기대 2) — users 정책의 권한 이름 확인', v_students;
  end if;
end $$;

reset role;

update public.manager_permissions set can_approve_orders = false
  where user_id = '11111111-0000-0000-0000-0000000000e1' and revoked_at is null;

reset role;

-- =========================================================
-- RLS16~18: sync_my_email() — anon 실행 불가, 본인만, 재호출은 무변화.
-- =========================================================

-- RLS16: anon은 sync_my_email()을 실행할 수 없다(authenticated에만 부여).
set local role anon;

do $$
begin
  begin
    perform public.sync_my_email();
    raise notice 'RLS16 FAIL: anon이 sync_my_email()을 실행할 수 있음';
  exception when insufficient_privilege then
    raise notice 'RLS16 PASS: anon은 sync_my_email() 실행 권한이 없음';
  end;
end $$;

reset role;

-- RLS17: 본인 세션에서 부르면 auth.users.email로 users.email이 동기화되고 이벤트가 남는다.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000f0","role":"authenticated"}', true);

select public.sync_my_email();

reset role;

do $$
declare
  v_email text;
  v_events int;
begin
  select email into v_email from public.users where id = '11111111-0000-0000-0000-0000000000f0';
  select count(*) into v_events from public.account_events
    where user_id = '11111111-0000-0000-0000-0000000000f0' and event_type = 'EMAIL_CHANGED';
  if v_email = 'rls-sync-new@example.com' and v_events = 1 then
    raise notice 'RLS17 PASS: 본인 세션의 sync_my_email()이 users.email을 동기화하고 EMAIL_CHANGED 1건을 남김';
  else
    raise notice 'RLS17 FAIL: email=%, EMAIL_CHANGED 건수=%(기대: rls-sync-new@example.com, 1)', v_email, v_events;
  end if;
end $$;

-- RLS18: 이미 동기화된 상태에서 다시 불러도 변화가 없다(멱등).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000f0","role":"authenticated"}', true);

select public.sync_my_email();

reset role;

do $$
declare
  v_events int;
begin
  select count(*) into v_events from public.account_events
    where user_id = '11111111-0000-0000-0000-0000000000f0' and event_type = 'EMAIL_CHANGED';
  if v_events = 1 then
    raise notice 'RLS18 PASS: 이미 동기화된 이메일로 재호출해도 EMAIL_CHANGED가 다시 쌓이지 않음(1건 유지)';
  else
    raise notice 'RLS18 FAIL: 재호출 후 EMAIL_CHANGED %건(기대 1)', v_events;
  end if;
end $$;

-- =========================================================
-- RLS19~20: payment_settings·set_payment_provider·checkout claim(·F-15)
-- 정책 없음 + EXECUTE revoke → anon/authenticated는 0건·실행 불가.
-- =========================================================

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);

do $$
declare
  v_settings int;
  v_attempts int;
begin
  select count(*) into v_settings from public.payment_settings;
  select count(*) into v_attempts from public.payment_attempts;
  if v_settings = 0 and v_attempts = 0 then
    raise notice 'RLS19 PASS: authenticated 학생에게 payment_settings 0건·payment_attempts 0건(본인 시도 없음)';
  else
    raise notice 'RLS19 FAIL: payment_settings=%, payment_attempts=%(기대 0,0)', v_settings, v_attempts;
  end if;
end $$;

reset role;

do $$
declare
  v_leaks text[];
begin
  select array_agg(fn) into v_leaks from (
    select 'set_payment_provider' as fn
      where has_function_privilege('anon', 'public.set_payment_provider(text,text,uuid)', 'execute')
         or has_function_privilege('authenticated', 'public.set_payment_provider(text,text,uuid)', 'execute')
  ) leaked;

  if v_leaks is null then
    raise notice 'RLS20 PASS: anon/authenticated는 set_payment_provider 실행 권한 없음';
  else
    raise notice 'RLS20 FAIL: 실행 권한이 새고 있는 함수 — %', v_leaks;
  end if;
end $$;

-- =========================================================
-- RLS21~23: 개설강의 함수 6개 DEFINER 전환 — service_role 전용.
-- anon과 authenticated(학생 및 ADMIN 세션 포함)는 직접 실행 권한이 없으며,
-- 오직 service_role 경로(명령 레일)로만 실행 가능하다.
-- =========================================================

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);

do $$
declare
  v_failed boolean := false;
  v_msg text;
  v_label text;
begin
  begin
    perform public.update_course_offering(
      '20000000-0000-0000-0000-000000000010', public.current_profile_id(), 'STUDENT', '학생이 수정 시도',
      '{"label":"HACK"}'::jsonb
    );
  exception when others then
    v_failed := true;
    v_msg := sqlerrm;
  end;
  select label into v_label from public.course_offerings where id = '20000000-0000-0000-0000-000000000010';
  if v_failed and v_label is distinct from 'HACK' and v_msg not like '%does not exist%' then
    raise notice 'RLS21 PASS: 일반 학생의 update_course_offering는 권한 거부되고 개설강의가 바뀌지 않음';
  else
    raise notice 'RLS21 FAIL: 거부=%, label=%(HACK이면 학생이 수정함), 예외=%', v_failed, v_label, v_msg;
  end if;
end $$;

reset role;

do $$
begin
  if has_function_privilege('anon', 'public.update_course_offering(uuid,uuid,text,text,jsonb,boolean)', 'execute') then
    raise notice 'RLS22 FAIL: anon이 update_course_offering 실행 권한을 가짐';
  else
    raise notice 'RLS22 PASS: anon은 update_course_offering 실행 권한 없음';
  end if;
end $$;

-- RLS23: DEFINER 전환 후 관리자 세션(authenticated)도 직접 실행 불가, 오직 service_role만 실행 가능
do $$
declare
  v_leaks text[];
begin
  select array_agg(fn) into v_leaks from (
    select 'create_course_offering' as fn
      where has_function_privilege('authenticated', 'public.create_course_offering(uuid,text,integer,integer,text,text[],jsonb,timestamptz,jsonb,uuid,text,boolean)', 'execute')
         or not has_function_privilege('service_role', 'public.create_course_offering(uuid,text,integer,integer,text,text[],jsonb,timestamptz,jsonb,uuid,text,boolean)', 'execute')
    union all
    select 'update_course_offering' as fn
      where has_function_privilege('authenticated', 'public.update_course_offering(uuid,uuid,text,text,jsonb,boolean)', 'execute')
         or not has_function_privilege('service_role', 'public.update_course_offering(uuid,uuid,text,text,jsonb,boolean)', 'execute')
    union all
    select 'set_course_offering_status' as fn
      where has_function_privilege('authenticated', 'public.set_course_offering_status(uuid,text,text,uuid,text)', 'execute')
         or not has_function_privilege('service_role', 'public.set_course_offering_status(uuid,text,text,uuid,text)', 'execute')
    union all
    select 'delete_course_offering' as fn
      where has_function_privilege('authenticated', 'public.delete_course_offering(uuid,text,uuid,text)', 'execute')
         or not has_function_privilege('service_role', 'public.delete_course_offering(uuid,text,uuid,text)', 'execute')
    union all
    select 'add_course_session' as fn
      where has_function_privilege('authenticated', 'public.add_course_session(uuid,uuid,text,text,date,time,time)', 'execute')
         or not has_function_privilege('service_role', 'public.add_course_session(uuid,uuid,text,text,date,time,time)', 'execute')
    union all
    select 'cancel_course_session' as fn
      where has_function_privilege('authenticated', 'public.cancel_course_session(uuid,uuid,text,text)', 'execute')
         or not has_function_privilege('service_role', 'public.cancel_course_session(uuid,uuid,text,text)', 'execute')
  ) leaked;

  if v_leaks is null then
    raise notice 'RLS23 PASS: 관리자 세션(authenticated) 직접 실행 불가, service_role 경로로만 실행 가능';
  else
    raise notice 'RLS23 FAIL: 실행 권한 이상 함수 — %', v_leaks;
  end if;
end $$;

-- RLS23b: course_offering_events 원장 RLS — ADMIN만 조회 가능, 학생·매니저는 0건
do $$
declare
  v_admin_cnt int;
  v_student_cnt int;
  v_manager_cnt int;
begin
  -- 더미 사건 1건 삽입 (service_role)
  insert into public.course_offering_events (
    course_offering_id, event_type, actor, actor_user_id, reason, before, after
  ) values (
    '20000000-0000-0000-0000-000000000010', 'CREATED', 'ADMIN', '11111111-0000-0000-0000-00000000000c',
    '테스트 사건', null, '{}'::jsonb
  );
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000c","role":"authenticated"}', true);
do $$
declare
  v_cnt int;
begin
  select count(*) into v_cnt from public.course_offering_events;
  if v_cnt >= 1 then
    raise notice 'RLS23b PASS: ADMIN 세션은 course_offering_events 조회 가능 (%건)', v_cnt;
  else
    raise notice 'RLS23b FAIL: ADMIN 세션에서 course_offering_events 0건';
  end if;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);
do $$
declare
  v_cnt int;
begin
  select count(*) into v_cnt from public.course_offering_events;
  if v_cnt = 0 then
    raise notice 'RLS23c PASS: STUDENT 세션은 course_offering_events 0건';
  else
    raise notice 'RLS23c FAIL: STUDENT 세션에서 course_offering_events 노출 (%건)', v_cnt;
  end if;
end $$;
reset role;

-- =========================================================
-- RLS24: payment_attempts 본인 조회(2026-10-02 보정) — 학생 A는 자기 주문의 시도만 본다.
-- 결제 복귀 가드가 학생 세션으로 이 테이블을 읽는다(정책이 없어 성공 복귀가 거부됐던 사고).
-- =========================================================
insert into public.payment_attempts (id, order_id, provider) values
  ('50000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000a', 'TOSS'),
  ('50000000-0000-0000-0000-00000000000b', '30000000-0000-0000-0000-00000000000b', 'TOSS');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);

do $$
declare
  v_total int;
  v_own int;
begin
  select count(*) into v_total from public.payment_attempts;
  select count(*) into v_own from public.payment_attempts where id = '50000000-0000-0000-0000-00000000000a';
  if v_total = 1 and v_own = 1 then
    raise notice 'RLS24 PASS: 학생 A는 자기 주문의 payment_attempts 1건만 보임(B 것 0건)';
  else
    raise notice 'RLS24 FAIL: 보이는 시도=%, 본인 시도=%(기대 1,1)', v_total, v_own;
  end if;
end $$;

reset role;

-- =========================================================
-- RLS25: terms_agreements 관리자 조회 — 관리자는 남(A·B)의 동의 이력을 본다.
-- 관리자 주문 상세의 자격 판정(CS-A)이 관리자 세션으로 학생의 동의를 읽는다(정책이 없어 "약관 미동의"가 거짓으로 보였다).
-- 학생이 자기 것만 보는지는 RLS1이 확인한다.
-- =========================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000c","role":"authenticated"}', true);

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.terms_agreements
  where user_id in ('11111111-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-00000000000b');
  if v_count = 2 then
    raise notice 'RLS25 PASS: 관리자에게 학생 A·B의 terms_agreements 2건이 보임';
  else
    raise notice 'RLS25 FAIL: 관리자에게 보이는 A·B 동의 이력 %건(기대 2)', v_count;
  end if;
end $$;

reset role;

-- =========================================================
-- RLS26: 통제 스위치(rail_switches) — 전원 대상 행은 누구나(비로그인 포함) 보고, 유저 대상 행은 본인과
-- 관리자만 본다. 쓰기 정책이 없어 세션으로는 아무도 쓸 수 없다(쓰기는 service_role만).
-- =========================================================
insert into public.rail_switches (level, target, user_id, reason, set_by) values
  ('MODULE', 'PAYMENT', null, 'RLS26 전원', '11111111-0000-0000-0000-00000000000c'),
  ('COMMAND', 'ORDER_APPLY', '11111111-0000-0000-0000-00000000000a', 'RLS26 A', '11111111-0000-0000-0000-00000000000c'),
  ('COMMAND', 'ORDER_APPLY', '11111111-0000-0000-0000-00000000000b', 'RLS26 B', '11111111-0000-0000-0000-00000000000c');

set local role anon;
select set_config('request.jwt.claims', '{}', true);
do $$
declare v_count int;
begin
  select count(*) into v_count from public.rail_switches where reason like 'RLS26%';
  if v_count = 1 then raise notice 'RLS26a PASS: 비로그인은 전원 대상 스위치 1건만 보임';
  else raise notice 'RLS26a FAIL: 비로그인에게 %건(기대 1)', v_count; end if;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);
do $$
declare v_count int; v_other int; v_write_blocked boolean := false;
begin
  select count(*) into v_count from public.rail_switches where reason like 'RLS26%';
  select count(*) into v_other from public.rail_switches where reason = 'RLS26 B';
  begin
    insert into public.rail_switches (level, reason, set_by) values ('SYSTEM', 'RLS26 학생 쓰기', '11111111-0000-0000-0000-00000000000a');
  exception when insufficient_privilege then v_write_blocked := true;
  end;
  if v_count = 2 and v_other = 0 and v_write_blocked then
    raise notice 'RLS26b PASS: 학생 A는 전원 대상 + 본인 대상 2건만 보이고(B 것 0건) 직접 쓰기는 거부';
  else
    raise notice 'RLS26b FAIL: 보임=%(기대 2), B 노출=%(기대 0), 쓰기 거부=%', v_count, v_other, v_write_blocked;
  end if;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000c","role":"authenticated"}', true);
do $$
declare v_count int;
begin
  select count(*) into v_count from public.rail_switches where reason like 'RLS26%';
  if v_count = 3 then raise notice 'RLS26c PASS: 관리자는 전원·A·B 대상 3건 전부 보임';
  else raise notice 'RLS26c FAIL: 관리자에게 %건(기대 3)', v_count; end if;
end $$;
reset role;

rollback;
