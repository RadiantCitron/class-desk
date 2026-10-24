-- class-desk 데이터 무결성 검증 스크립트
--
-- 목적: 설계에서 "DB가 보장한다"고 선언한 제약들이 실제로 동작하는지
-- 재현 가능하게 확인한다. 앱 코드 테스트(vitest·Playwright)와 별개로 DB 계층만 직접 검증한다.
-- 전체를 하나의 트랜잭션으로 감싸고 끝에 ROLLBACK하므로, 실행해도 DB에 어떤 흔적도
-- 남기지 않는다 — 로컬 개발 DB든, 실 데이터가 든 DB든 안전하게 반복 실행할 수 있다.
--
-- 실행 방법 (로컬 Supabase가 떠 있어야 함, `npm run db:start`):
--   docker exec -i supabase_db_class-desk psql -U postgres -d postgres \
--     < supabase/tests/integrity_check.sql
--
-- 모든 줄이 "... PASS: ..."로 끝나야 정상이다. "FAIL"이 하나라도 보이면 회귀(regression)다.

begin;

-- 아웃박스 러너가 결제 사실을 주문 핸들러에 배달하는 것을 SQL로 흉내 낸다.
-- 실제 배달은 lib/outbox/drain.ts(TS)가 연동표(lib/wiring/outbox.ts)대로 한다. 이 스크립트는
-- DB 함수의 판단만 검증하므로, 결제 사실 2종만 주문 핸들러로 넘기고 처리 완료로 표시한다.
-- (이용권 부여·회수는 TS라 여기서 검증하지 않는다 — ORDER_PAID/ORDER_REFUNDED 적재까지만 본다.)
create function pg_temp.deliver_payment_facts() returns void
language plpgsql
as $$
declare
  v_msg record;
begin
  for v_msg in
    select id, topic, payload from public.outbox_messages
    where processed_at is null and topic in ('PAYMENT_SUCCEEDED', 'PAYMENT_REFUNDED')
    order by created_at
  loop
    if v_msg.topic = 'PAYMENT_SUCCEEDED' then
      perform public.on_payment_succeeded(
        (v_msg.payload->>'payment_event_id')::uuid,
        (v_msg.payload->>'order_id')::uuid,
        v_msg.payload->>'provider',
        (v_msg.payload->>'amount')::integer,
        v_msg.payload->>'currency',
        v_msg.payload->>'payment_method',
        coalesce(v_msg.payload->'metadata', '{}'::jsonb)
      );
    else
      perform public.on_payment_refunded(
        (v_msg.payload->>'payment_event_id')::uuid,
        (v_msg.payload->>'order_id')::uuid,
        v_msg.payload->>'provider',
        (v_msg.payload->>'amount')::integer,
        v_msg.payload->>'currency',
        -- 실제 핸들러(lib/orders/handlers.ts onPaymentRefunded)처럼 환불 사실의 원인·사유도 넘긴다. 빼면 cause가 null이 되어
        -- TEST95·98·100의 원인 단정이 NULL 논리로 공허하게 통과한다(S-5에서 발견).
        v_msg.payload->>'cause',
        v_msg.payload->>'reason',
        coalesce((v_msg.payload->>'keep_order')::boolean, false)
      );
    end if;
    update public.outbox_messages set processed_at = clock_timestamp() where id = v_msg.id;
  end loop;
end;
$$;

-- 이미 처리를 마친 메시지를 "다시 배달"하는 걸 흉내 낸다(러너 재시도 시나리오). 마지막으로
-- 적재된 같은 토픽·같은 payment_event_id의 outbox 행에서 페이로드를 그대로 다시 쓴다.
create function pg_temp.redeliver_payment_fact(p_topic text, p_payment_event_id uuid) returns void
language plpgsql
as $$
declare
  v_payload jsonb;
begin
  select payload into v_payload from public.outbox_messages
    where topic = p_topic and payload->>'payment_event_id' = p_payment_event_id::text
    order by created_at desc limit 1;

  if v_payload is null then
    raise exception 'redeliver_payment_fact: % 토픽의 %에 대한 outbox 행을 찾을 수 없습니다', p_topic, p_payment_event_id;
  end if;

  if p_topic = 'PAYMENT_SUCCEEDED' then
    perform public.on_payment_succeeded(
      p_payment_event_id, (v_payload->>'order_id')::uuid, v_payload->>'provider',
      (v_payload->>'amount')::integer, v_payload->>'currency', v_payload->>'payment_method',
      coalesce(v_payload->'metadata', '{}'::jsonb));
  else
    perform public.on_payment_refunded(
      p_payment_event_id, (v_payload->>'order_id')::uuid, v_payload->>'provider',
      (v_payload->>'amount')::integer, v_payload->>'currency', v_payload->>'cause', v_payload->>'reason',
      coalesce((v_payload->>'keep_order')::boolean, false));
  end if;
end;
$$;


-- create_course_offering()이 날짜별 회차(p_sessions)를 받는 새 시그니처로 바뀌었다.
-- 이 스크립트의 기존 호출 약 56곳은 옛 인자(개강·종료·요일·시각)를 쓰므로, 같은 인자를 받아 새 함수를 부르는
-- 시험용 래퍼를 둔다(호출 쪽은 이름만 바꿨다). 래퍼가 하는 일:
--   · 시각·요일을 준 호출: 옛 의미대로 개강일~종료일 중 해당 요일 날짜마다 회차 1행.
--   · 시각을 안 준 호출(옛 의미 「회차 없음」): 서로 겹치지 않는 2100년대의 1분짜리 회차 1행(새 함수는 회차 1개 이상이 필수).
--   · 만든 뒤 개설강의의 opens_at/ends_at을 호출이 준 값으로 되돌려 옛 시험이 전제한 시각(과거 개강 등)을 유지한다.
-- 새 시그니처 자체는 TEST 96이 pg_temp 래퍼 없이 직접 검증한다.
create temp sequence legacy_offering_seq;
create function pg_temp.create_offering_legacy(
  p_course_id uuid, p_label text, p_capacity integer, p_price integer, p_location text,
  p_is_one_time boolean, p_opens_at timestamptz, p_ends_at timestamptz, p_terms text[], p_grants jsonb,
  p_st time, p_et time, p_days smallint[], p_recruit timestamptz, p_auto boolean default false
) returns uuid
language plpgsql
as $$
declare
  v_id uuid;
  v_sessions jsonb;
  v_days smallint[];
begin
  if p_recruit >= p_opens_at then
    raise exception '모집 시작은 개강보다 앞이어야 합니다.';
  end if;
  if p_st is not null and p_et is not null then
    v_days := case when p_is_one_time then array[extract(dow from p_opens_at)::smallint] else p_days end;
    if v_days is not null and array_length(v_days, 1) > 0 then
      select jsonb_agg(jsonb_build_object('date', d::date, 'start', to_char(p_st, 'HH24:MI'), 'end', to_char(p_et, 'HH24:MI')) order by d)
        into v_sessions
      from generate_series(p_opens_at::date, coalesce(p_ends_at::date, p_opens_at::date), interval '1 day') d
      where extract(dow from d)::smallint = any(v_days);
    end if;
  end if;
  if v_sessions is null then
    v_sessions := jsonb_build_array(jsonb_build_object(
      'date', (date '2100-01-01' + nextval('legacy_offering_seq')::integer), 'start', '00:00', 'end', '00:01'));
  end if;

  v_id := public.create_course_offering(
    p_course_id, p_label, p_capacity, p_price, p_location, p_terms, p_grants, p_recruit, v_sessions,
    '00000000-0000-0000-0000-00000000000a'::uuid, 'ADMIN', p_auto);
  update public.course_offerings set opens_at = p_opens_at, ends_at = p_ends_at where id = v_id;
  return v_id;
end;
$$;

-- =========================================================
-- 준비: 테스트용 강의/개설강의/학생 데이터
-- =========================================================
insert into public.users (id, auth_user_id, email, role) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000aa', 'legacy-admin@example.com', 'ADMIN')
on conflict (id) do nothing;

insert into public.courses (id, name, category) values
  ('00000000-0000-0000-0000-000000000001', '테스트강의A', 'IT');

-- 신청 기간 = 모집 시작 ≤ 지금 < 개강. "모집 중" 픽스처는 모집 시작 과거·개강 미래로 둔다.
insert into public.course_offerings
  (id, course_id, label, capacity, remaining_seats, price, recruit_opens_at, opens_at, ends_at, status)
values
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', '1기(화 20-22시)', 2, 2, 100000, now() - interval '2 days', now() + interval '1 day', now() + interval '90 days', 'OPEN'),
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', '2기(겹치는 시도)', 2, 2, 100000, now() - interval '2 days', now() + interval '1 day', now() + interval '90 days', 'OPEN'),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', '3기(수 20-22시)', 2, 2, 100000, now() - interval '2 days', now() + interval '1 day', now() + interval '90 days', 'OPEN');

-- auth.users(Supabase 인증 계정)와 public.users(우리 회원부)는 2026-09-12부터 서로 다른
-- id를 쓴다(auth_user_id 컬럼으로만 연결, FK 없음). 이 스크립트 전체에서
-- 두 값을 의도적으로 다르게 둔다: 같게 두면 이 분리 작업이 고치려는 버그를 하나도 못 잡는다.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000001aa', 'test-student@example.com');
insert into public.users (id, auth_user_id, email, role) values
  ('00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-0000000001aa', 'test-student@example.com', 'STUDENT');

-- =========================================================
-- TEST 1: 강사 스케줄 겹침 — 같은 날 20-22시 회차를 두 개설강의에 각각 등록하면 두 번째가 거부되어야 함
-- =========================================================
insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
values ('00000000-0000-0000-0000-000000000010', '2026-11-03', '20:00', '22:00');

do $$
begin
  begin
    insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
    values ('00000000-0000-0000-0000-000000000011', '2026-11-03', '21:00', '23:00'); -- 같은 날 21-23시, 시간 겹침
    raise notice 'TEST1 FAIL: 겹치는 회차가 저장되어버림 (EXCLUDE가 안 먹음)';
  exception when exclusion_violation then
    raise notice 'TEST1 PASS: 겹치는 회차(EXCLUDE) 정상 차단됨';
  end;
end $$;

-- =========================================================
-- TEST 2: 날짜가 다르면 같은 시각대라도 정상 등록되어야 함(과잉 차단 방지 확인)
-- =========================================================
do $$
begin
  begin
    insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
    values ('00000000-0000-0000-0000-000000000012', '2026-11-04', '20:00', '22:00'); -- 다음 날 같은 20-22시
    raise notice 'TEST2 PASS: 날짜가 다르면 같은 시각대도 정상 등록됨';
  exception when others then
    raise notice 'TEST2 FAIL: 요일이 다른데도 거부됨 (%)', sqlerrm;
  end;
end $$;

-- =========================================================
-- TEST 3: 정원(재고 차감 패턴) — 2석짜리 개설강의에서 3번째 예약은 거부되어야 함
-- =========================================================
do $$
declare
  r1 boolean;
  r2 boolean;
  r3 boolean;
begin
  select public.reserve_course_offering_seat('00000000-0000-0000-0000-000000000010') into r1;
  select public.reserve_course_offering_seat('00000000-0000-0000-0000-000000000010') into r2;
  select public.reserve_course_offering_seat('00000000-0000-0000-0000-000000000010') into r3;

  if r1 and r2 and not coalesce(r3, false) then
    raise notice 'TEST3 PASS: 정원 2석 중 2건은 성공, 3번째는 정원마감으로 거부됨';
  else
    raise notice 'TEST3 FAIL: r1=%, r2=%, r3=%', r1, r2, r3;
  end if;
end $$;

-- =========================================================
-- TEST 4: 결제 정합성 CHECK — 결제방법 없이 결제일시만 넣으면 거부되어야 함
-- =========================================================
do $$
begin
  begin
    insert into public.orders (user_id, course_offering_id, paid_at)
    values ('00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000012', now());
    raise notice 'TEST4 FAIL: 결제방법 없이 결제일시만 있는 행이 저장됨';
  exception when check_violation then
    raise notice 'TEST4 PASS: 결제방법 없이 결제일시만 있으면 CHECK로 차단됨';
  end;
end $$;

-- =========================================================
-- TEST 5: 상태-시각 정합성 CHECK — ENROLLED인데 approved_at 없으면 거부되어야 함
-- =========================================================
do $$
begin
  begin
    insert into public.orders (user_id, course_offering_id, status)
    values ('00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000012', 'APPROVED');
    raise notice 'TEST5 FAIL: approved_at 없이 ENROLLED 상태가 저장됨';
  exception when check_violation then
    raise notice 'TEST5 PASS: approved_at 없이 ENROLLED면 CHECK로 차단됨';
  end;
end $$;

-- =========================================================
-- TEST 6 (발견한 사실을 그대로 검증에 편입): 학생 개인 스케줄 겹침 방지 트리거를 독립적으로
-- 재현하려면 "서로 다른 두 개설강의가 같은 요일·시간대"여야 하는데, 그 상태 자체가 TEST1의
-- EXCLUDE 제약(강사 1인 전제)에서 이미 막힌다 — 즉 강사가 1인인 지금은 학생 트리거가 발동할
-- 상황 자체가 구조적으로 존재할 수 없다(도달 불가능한 백업 방어선). 이 사실을 그대로 확인한다.
-- (트리거 코드 자체는 제거하지 않고 유지 — 강사가
-- 여러 명으로 늘면 그 즉시 유효해지는 저비용 안전장치이기 때문.)
-- =========================================================
do $$
begin
  begin
    insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
    values ('00000000-0000-0000-0000-000000000011', '2026-11-03', '20:00', '22:00'); -- offering 10과 완전히 동일한 같은 날 20-22시
    raise notice 'TEST6 FAIL: 서로 다른 개설강의가 같은 시간대 회차를 둘 다 가짐 (강사 1인 전제가 깨짐)';
  exception when exclusion_violation then
    raise notice 'TEST6 PASS: 강사가 1인인 한, 학생이 겹칠 수 있는 두 개설강의 자체가 존재할 수 없음 (course_sessions EXCLUDE가 선제 차단 — 학생 트리거는 현재 도달 불가능한 백업 방어선)';
  end;
end $$;

-- =========================================================
-- TEST 7: complete_signup() — 계정 생성 + 약관동의(SERVICE_USE+PRIVACY_USE 둘 다, 2026-09-11
-- "약관 체계" 확장)가 항상 함께(원자적으로) 일어나야 함.
-- "동의 없이 계정만 존재"하는 상태가 나오면 안 된다.
--
-- complete_signup()이 이제 p_auth_user_id(인증 계정 id)를 받아 독자 발급한
-- public.users.id를 반환한다(v_profile_id). 두 값이 자동으로 다르다는 것 자체가 이번
-- 식별자 분리 작업이 실제로 적용됐다는 증거다.
-- =========================================================
do $$
declare
  v_auth_user_id uuid := '00000000-0000-0000-0000-0000000002aa';
  v_profile_id uuid;
  v_service_terms_id uuid;
  v_privacy_terms_id uuid;
begin
  select id into v_service_terms_id from public.terms where type = 'SERVICE_USE' order by effective_at desc limit 1;
  select id into v_privacy_terms_id from public.terms where type = 'PRIVACY_USE' order by effective_at desc limit 1;
  insert into auth.users (id, email) values (v_auth_user_id, 'test-signup@example.com');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data)
    values (gen_random_uuid(), v_auth_user_id, v_auth_user_id::text, 'email', jsonb_build_object('sub', v_auth_user_id::text, 'email', 'test-signup@example.com'));

  select public.complete_signup(v_auth_user_id, 'test-signup@example.com', v_service_terms_id, v_privacy_terms_id) into v_profile_id;

  if v_profile_id is not null and v_profile_id <> v_auth_user_id
     and (select count(*) from public.users where id = v_profile_id and auth_user_id = v_auth_user_id) = 1
     and (select count(*) from public.terms_agreements where user_id = v_profile_id) = 2 then
    raise notice 'TEST7a PASS: complete_signup()이 독자 발급한 profile id(auth 계정 id와 다른 값)로 계정과 동의 기록(SERVICE_USE+PRIVACY_USE 2건)이 함께 생성됨';
  else
    raise notice 'TEST7a FAIL: profile_id=%, auth_user_id=%', v_profile_id, v_auth_user_id;
  end if;

  -- 같은 인증 계정으로 다시 호출하면(예: 중복 제출) users_auth_user_id_key 충돌로 전체가
  -- 실패해야 하고, 그 실패로 이미 만들어진 계정/동의 기록이 훼손되지 않아야 한다.
  -- (예전엔 users_pkey가 이 방어선이었으나, id가 매번 새로 발급되므로 이제 pkey는 절대
  -- 충돌하지 않는다 — auth_user_id/discord_id 유니크가 새 방어선이다.)
  begin
    perform public.complete_signup(v_auth_user_id, 'test-signup@example.com', v_service_terms_id, v_privacy_terms_id);
    raise notice 'TEST7b FAIL: 같은 인증 계정으로 재호출했는데 에러 없이 통과함';
  exception when unique_violation then
    raise notice 'TEST7b PASS: 중복 호출은 unique_violation(auth_user_id 유니크)으로 거부되고, 기존 계정/동의 기록은 그대로 유지됨';
  end;

  if (select count(*) from public.users where id = v_profile_id) = 1
     and (select count(*) from public.terms_agreements where user_id = v_profile_id) = 2 then
    raise notice 'TEST7c PASS: 중복 호출 실패 이후에도 계정/동의 기록이 정확히 유지됨(부분 반영 없음)';
  else
    raise notice 'TEST7c FAIL: 중복 호출 실패가 기존 기록에 영향을 줌';
  end if;
end $$;

-- =========================================================
-- TEST 8~11: 결제 원장 설계 검증
-- 준비: 결제 테스트 전용 ENROLLED 수강신청 1건을 직접 만든다.
-- =========================================================
create temporary table test_payment_ctx (order_id uuid);

do $$
declare
  v_order_id uuid;
begin
  insert into public.orders (user_id, course_offering_id, status, approved_at, list_price, final_amount)
  values ('00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000012', 'APPROVED', now(), 100000, 100000)
  returning id into v_order_id;

  insert into test_payment_ctx values (v_order_id);
end $$;

-- TEST 8: 멱등성 — 같은 (provider, provider_event_id)로 두 번 호출하면 두 번째는 조용히 무시되고
-- payment_events 행이 1개만 남아야 한다.
do $$
declare
  v_order_id uuid;
  v_processed1 boolean;
  v_processed2 boolean;
  v_count integer;
begin
  select order_id into v_order_id from test_payment_ctx limit 1;

  select public.record_payment_event('MOCK', 'evt-idem-1', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb) into v_processed1;
  select public.record_payment_event('MOCK', 'evt-idem-1', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb) into v_processed2;

  select count(*) into v_count from public.payment_events where provider = 'MOCK' and provider_event_id = 'evt-idem-1';

  if v_processed1 and not v_processed2 and v_count = 1 then
    raise notice 'TEST8 PASS: 같은 provider_event_id 재호출(웹훅 재시도 시뮬레이션)이 멱등 처리되어 행이 1개만 남음';
  else
    raise notice 'TEST8 FAIL: processed1=%, processed2=%, count=%', v_processed1, v_processed2, v_count;
  end if;
  perform pg_temp.deliver_payment_facts();
end $$;

-- TEST 9: 기존 버그 해소 — 같은 거래(수강신청)에 승인 이벤트에 이어 환불 이벤트가 공존해야 한다.
-- (재설계 전엔 payapp_transaction_id UNIQUE 때문에 이게 물리적으로 불가능했다.)
do $$
declare
  v_order_id uuid;
  v_count integer;
begin
  select order_id into v_order_id from test_payment_ctx limit 1;

  perform public.record_payment_event('MOCK', 'evt-refund-1', 'REFUNDED', 100000, 'KRW', v_order_id, null, '{}'::jsonb, '{}'::jsonb);

  select count(*) into v_count from public.payment_events where order_id = v_order_id;

  if v_count = 2 then
    raise notice 'TEST9 PASS: 같은 수강신청에 PAYMENT_SUCCEEDED+REFUNDED 두 이벤트가 공존함(재설계 전엔 UNIQUE(거래번호)로 불가능했던 버그가 해소됨)';
  else
    raise notice 'TEST9 FAIL: payment_events 행 개수=%(기대값 2)', v_count;
  end if;
  perform pg_temp.deliver_payment_facts();
end $$;

-- TEST 10: 2축 분리 검증. 수강 상태와 결제 상태가 서로 독립된 축이라는 것이 요지다 — 한
-- 컬럼이던 시절엔 표현 자체가 불가능했다.
--
-- 2026-09-23 정책 변경: **환불 = 수강 종료**로 확정돼, 환불 웹훅이 만들어내는 결과는
-- 이제 (ENROLLED, REFUNDED)가 아니라 (CANCELLED, REFUNDED)다. 스키마가 (ENROLLED, REFUNDED)를
-- 표현할 수 있다는 사실 자체는 변하지 않았으므로, 그 부분도 함께 확인한다.
-- (: 이 상태 변화는 이제 주문 핸들러 on_payment_refunded가 만든다 — TEST9 끝에서 배달됨.)
do $$
declare
  v_order_id uuid;
  v_status text;
  v_payment_status text;
  v_combo_allowed boolean := false;
begin
  select order_id into v_order_id from test_payment_ctx limit 1;
  select status, payment_status into v_status, v_payment_status
  from public.orders where id = v_order_id;

  -- 스키마가 (ENROLLED, REFUNDED)를 여전히 표현할 수 있는지(2축 분리의 본래 취지) 확인
  begin
    update public.orders
    set status = 'APPROVED', cancelled_at = null
    where id = v_order_id;
    v_combo_allowed := true;
    -- 원래 상태로 되돌린다(뒤 테스트에 영향 주지 않도록)
    update public.orders
    set status = v_status, cancelled_at = now()
    where id = v_order_id;
  exception when others then
    v_combo_allowed := false;
  end;

  if v_status = 'CANCELLED' and v_payment_status = 'REFUNDED' and v_combo_allowed then
    raise notice 'TEST10 PASS: 환불이 (CANCELLED, REFUNDED)를 만들고, 스키마는 (ENROLLED, REFUNDED)도 여전히 표현 가능 — 2축 분리 유지';
  else
    raise notice 'TEST10 FAIL: status=%, payment_status=%, combo_allowed=%',
      v_status, v_payment_status, v_combo_allowed;
  end if;
end $$;

-- TEST 11: record_payment_event()의 원자성 — 존재하지 않는 수강신청으로 호출하면 예외가 나고,
-- payment_events/outbox_messages 둘 다 부분 반영 없이 그대로 유지돼야 한다.
do $$
declare
  v_before_pe integer;
  v_before_ob integer;
  v_after_pe integer;
  v_after_ob integer;
begin
  select count(*) into v_before_pe from public.payment_events;
  select count(*) into v_before_ob from public.outbox_messages;

  begin
    perform public.record_payment_event('MOCK', 'evt-invalid-1', 'PAYMENT_SUCCEEDED', 50000, 'KRW', '00000000-0000-0000-0000-00000000ffff', 'CARD', '{}'::jsonb, '{}'::jsonb);
    raise notice 'TEST11 FAIL: 존재하지 않는 order_id로 호출했는데 에러 없이 통과함';
  exception when others then
    select count(*) into v_after_pe from public.payment_events;
    select count(*) into v_after_ob from public.outbox_messages;

    if v_after_pe = v_before_pe and v_after_ob = v_before_ob then
      raise notice 'TEST11 PASS: 존재하지 않는 수강신청으로 호출하면 예외가 나고, payment_events/outbox_messages 둘 다 부분 반영 없이 그대로 유지됨';
    else
      raise notice 'TEST11 FAIL: 부분 반영 발생 (payment_events %->%, outbox_messages %->%)', v_before_pe, v_after_pe, v_before_ob, v_after_ob;
    end if;
  end;
end $$;

-- =========================================================
-- TEST 12~14: 이중결제 방지, 모집기간 강제, 학생 본인 취소 지원 검증
-- =========================================================

-- TEST 12: 이중결제 방지(결함 B) — 서로 다른 두 결제성공 이벤트가 같은 신청건에 들어오면,
-- 원장엔 둘 다 사실대로 기록되지만(이벤트소싱 원칙 유지) orders는 한 번만 PAID로
-- 갱신되고 두 번째 건은 DLQ(dead_letters)에 남아야 한다.
do $$
declare
  v_order_id uuid;
  v_r1 boolean;
  v_r2 boolean;
  v_payment_status text;
  v_succeeded_count integer;
  v_grant_count integer;
  v_dlq_count integer;
begin
  -- offering 012가 아니라 011을 쓴다: 012는 test_payment_ctx가 이미 같은 사용자로 점유 중이라
  -- 여기서 또 넣으면 학생 스케줄 겹침 트리거(자기 자신의 offering과 겹침)에 먼저 걸린다.
  -- 011은 course_sessions가 비어있는 채로 남아있어(TEST6에서 겹침으로 등록 자체가 막혔음) 안전하다.
  insert into public.orders (user_id, course_offering_id, status, approved_at, list_price, final_amount)
  values ('00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000011', 'APPROVED', now(), 100000, 100000)
  returning id into v_order_id;

  select public.record_payment_event('MOCK', 'evt-dup-1', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb) into v_r1;
  perform pg_temp.deliver_payment_facts();
  select public.record_payment_event('MOCK', 'evt-dup-2', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb) into v_r2;
  perform pg_temp.deliver_payment_facts();

  select payment_status into v_payment_status from public.orders where id = v_order_id;
  select count(*) into v_succeeded_count from public.payment_events where order_id = v_order_id and event_type = 'PAYMENT_SUCCEEDED';
  -- 첫 결제 성공 시 주문 핸들러가 ORDER_PAID를 1건 적재한다.
  -- 두 번째(이중결제 의심) 건은 ORDER_PAID 없이 DLQ로만 간다.
  select count(*) into v_grant_count from public.outbox_messages where topic = 'ORDER_PAID' and payload->>'order_id' = v_order_id::text;
  select count(*) into v_dlq_count from public.dead_letters where error_message like '%이중결제 의심%' and error_message like '%' || v_order_id::text || '%';

  if v_r1 and v_r2 and v_succeeded_count = 2 and v_payment_status = 'PAID' and v_grant_count = 1 and v_dlq_count = 1 then
    raise notice 'TEST12 PASS: 이중결제 방지 — 원장엔 성공 이벤트 2건 다 기록되지만 entitlements 지급(아웃박스)은 1번만, 두 번째는 DLQ로 감';
  else
    raise notice 'TEST12 FAIL: r1=%, r2=%, succeeded=%, payment_status=%, grant=%, dlq=%', v_r1, v_r2, v_succeeded_count, v_payment_status, v_grant_count, v_dlq_count;
  end if;
end $$;

-- TEST 13: 모집기간(recruit_opens_at ≤ 지금 < opens_at) 강제(결함 A) — status='OPEN'이어도 기간 밖이면 신청 거부.
do $$
declare
  v_offering_future uuid := '00000000-0000-0000-0000-000000000013';
  v_offering_past uuid := '00000000-0000-0000-0000-000000000014';
begin
  insert into public.course_offerings (id, course_id, label, capacity, remaining_seats, price, recruit_opens_at, opens_at, ends_at, status)
  values
    (v_offering_future, '00000000-0000-0000-0000-000000000001', '미래기수', 5, 5, 50000, now() + interval '7 days', now() + interval '14 days', now() + interval '30 days', 'OPEN'),
    (v_offering_past, '00000000-0000-0000-0000-000000000001', '개강한기수', 5, 5, 50000, now() - interval '30 days', now() - interval '1 days', now() + interval '30 days', 'OPEN');

  -- 예전엔 create_order 관련 옛 오버로드가 공존해서 타입 없는
  -- null을 넘기면 "function is not unique"(42883)로 터졌는데, 그걸 "when others"가 삼켜
  -- 거짓 PASS를 냈었다(버그 C). 오버로드를 정리(20260912130200)했으니 undefined_function은
  -- 이제 FAIL로 구분해 같은 사고가 재발하면 바로 드러나게 한다.
  begin
    perform public.create_order('00000000-0000-0000-0000-000000000100', v_offering_future, null, null::uuid[]);
    raise notice 'TEST13a FAIL: 모집 시작 전(recruit_opens_at 미래)인데 신청이 성공함';
  exception
    when undefined_function then
      raise notice 'TEST13a FAIL: create_order 호출이 모호하거나 함수를 찾지 못함(오버로드 정리 확인 필요) — %', sqlerrm;
    when others then
      raise notice 'TEST13a PASS: 모집 시작 전에는 신청이 거부됨';
  end;

  begin
    perform public.create_order('00000000-0000-0000-0000-000000000100', v_offering_past, null, null::uuid[]);
    raise notice 'TEST13b FAIL: 개강(opens_at 과거) 후인데 신청이 성공함';
  exception
    when undefined_function then
      raise notice 'TEST13b FAIL: create_order 호출이 모호하거나 함수를 찾지 못함(오버로드 정리 확인 필요) — %', sqlerrm;
    when others then
      raise notice 'TEST13b PASS: 개강 후(모집 마감)에는 신청이 거부됨';
  end;
end $$;

-- TEST 14: 학생 본인 취소 지원 — order_events.actor에 'STUDENT'가 허용돼야 한다.
do $$
declare
  v_order_id uuid;
begin
  select order_id into v_order_id from test_payment_ctx limit 1;
  begin
    insert into public.order_events (event_type, actor, actor_user_id, order_id)
    values ('CANCELLED', 'STUDENT', '00000000-0000-0000-0000-000000000100', v_order_id);
    raise notice 'TEST14 PASS: actor=STUDENT 이벤트가 정상 저장됨(학생 본인 취소 지원)';
  exception when check_violation then
    raise notice 'TEST14 FAIL: actor=STUDENT가 여전히 CHECK로 거부됨';
  end;
end $$;

-- =========================================================
-- TEST 15: 약관 체계 확장(2026-09-11) — create_order()이 PRIVACY_USE뿐 아니라 그
-- 개설강의가 요구하는 조건부 약관(예: SOFTWARE_LICENSE_USE)까지 배열로 받아 한 번에
-- 원자적으로 기록해야 한다.
-- =========================================================
do $$
declare
  v_offering_id uuid := '00000000-0000-0000-0000-000000000015';
  v_privacy_terms_id uuid;
  v_license_terms_id uuid;
  v_order_id uuid;
  v_agreement_count integer;
begin
  select id into v_privacy_terms_id from public.terms where type = 'PRIVACY_USE' order by effective_at desc limit 1;
  select id into v_license_terms_id from public.terms where type = 'SOFTWARE_LICENSE_USE' order by effective_at desc limit 1;

  insert into public.course_offerings
    (id, course_id, label, capacity, remaining_seats, price, recruit_opens_at, opens_at, ends_at, status, required_terms_types)
  values
    (v_offering_id, '00000000-0000-0000-0000-000000000001', '소스코드결합기', 5, 5, 80000, now() - interval '2 days', now() + interval '1 day', now() + interval '30 days', 'OPEN', array['SOFTWARE_LICENSE_USE']);

  select public.create_order('00000000-0000-0000-0000-000000000100', v_offering_id, null, array[v_privacy_terms_id, v_license_terms_id]) into v_order_id;

  select count(*) into v_agreement_count
  from public.terms_agreements
  where user_id = '00000000-0000-0000-0000-000000000100'
    and terms_id in (v_privacy_terms_id, v_license_terms_id);

  if v_order_id is not null and v_agreement_count = 2 then
    raise notice 'TEST15 PASS: 조건부 약관(SOFTWARE_LICENSE_USE)을 포함한 배열이 신청과 함께 원자적으로 기록됨';
  else
    raise notice 'TEST15 FAIL: order_id=%, agreement_count=%', v_order_id, v_agreement_count;
  end if;
end $$;

-- =========================================================
-- TEST 16~19: 사용자 식별자 분리 — 이번 작업이 실제로
-- 의도한 대로 동작하는지 확인한다. 전용 픽스처를 새로 만든다(TEST16/17이 실제 DELETE를
-- 수행하므로 앞선 테스트들이 공유하는 000100 사용자를 건드리면 안 된다).
-- =========================================================
do $$
declare
  v_auth_user_id uuid := '00000000-0000-0000-0000-0000000003aa';
  v_profile_id uuid := '00000000-0000-0000-0000-000000000300';
  v_order_id uuid;
  v_users_after integer;
  v_enr_after integer;
begin
  insert into auth.users (id, email) values (v_auth_user_id, 'test-decouple@example.com');
  insert into public.users (id, auth_user_id, email, role)
  values (v_profile_id, v_auth_user_id, 'test-decouple@example.com', 'STUDENT');

  insert into public.orders (user_id, course_offering_id, status, approved_at, list_price, final_amount)
  values (v_profile_id, '00000000-0000-0000-0000-000000000012', 'APPROVED', now(), 100000, 100000)
  returning id into v_order_id;

  -- TEST 16: auth.users 삭제가 public.users/orders에 영향을 주지 않아야 한다
  -- (이 작업의 목적 그 자체 — 예전엔 on delete cascade 때문에 이 DELETE 한 줄이 프로필과
  -- 그 밑에 매달린 업무 데이터를 통째로 날렸다).
  delete from auth.users where id = v_auth_user_id;

  select count(*) into v_users_after from public.users where id = v_profile_id;
  select count(*) into v_enr_after from public.orders where user_id = v_profile_id;

  if v_users_after = 1 and v_enr_after = 1 then
    raise notice 'TEST16 PASS: auth.users 삭제가 public.users/orders에 아무 영향을 주지 않음(cascade 단절 확인)';
  else
    raise notice 'TEST16 FAIL: users=%, orders=%', v_users_after, v_enr_after;
  end if;

  -- TEST 17: public.users 하드 삭제 자체가 트리거로 물리적으로 거부돼야 한다
  -- ("규율이 아니라 구조적으로 불가능하게").
  begin
    delete from public.users where id = v_profile_id;
    raise notice 'TEST17 FAIL: 회원 행이 삭제되어버림 — 삭제 차단 트리거가 없거나 비활성화됨';
  exception when restrict_violation then
    raise notice 'TEST17 PASS: public.users DELETE가 트리거로 차단됨';
  end;
end $$;

-- TEST 18: 인증 계정 하나당 프로필 하나 — 이미 쓰이고 있는 auth_user_id로 새 프로필을
-- 또 만들려 하면 users_auth_user_id_key 유니크 제약이 거부해야 한다.
do $$
begin
  begin
    insert into public.users (auth_user_id, email, role)
    values ('00000000-0000-0000-0000-0000000001aa', 'dup@example.com', 'STUDENT');
    raise notice 'TEST18 FAIL: 이미 쓰이고 있는 auth_user_id로 두 번째 프로필이 생성됨';
  exception when unique_violation then
    raise notice 'TEST18 PASS: auth_user_id는 유니크 — 인증 계정 하나당 프로필 하나만 허용됨';
  end;
end $$;

-- TEST 19: public.users.id는 이제 auth.users.id와 무관하게 독자 발급된다(gen_random_uuid()
-- 기본값). id를 안 넣고 INSERT해도 채워지고, 우리가 지정한 auth_user_id와는 값이 다르다.
do $$
declare
  v_auth_user_id uuid := '00000000-0000-0000-0000-0000000004aa';
  v_generated_id uuid;
begin
  insert into auth.users (id, email) values (v_auth_user_id, 'test-autoid@example.com');
  insert into public.users (auth_user_id, email, role)
  values (v_auth_user_id, 'test-autoid@example.com', 'STUDENT')
  returning id into v_generated_id;

  if v_generated_id is not null and v_generated_id <> v_auth_user_id then
    raise notice 'TEST19 PASS: public.users.id가 auth_user_id와 무관하게 독자 발급됨(id=%)', v_generated_id;
  else
    raise notice 'TEST19 FAIL: id=%, auth_user_id=%', v_generated_id, v_auth_user_id;
  end if;
end $$;

-- TEST 20: 결함 A 회귀 — 숨긴(deleted_at) 개설강의는 URL 직접 호출로도 신청이 거부돼야 한다.
-- create_order(옛 apply_for_offering) 오버로드 정리(20260912130200) 이전엔 앱이 실제로 호출하는 배열 버전에
-- deleted_at 검사가 없어서, 관리자가 "삭제(숨김)"한 개설강의도 신청 자체는 그대로 성공했다.
do $$
declare
  v_hidden_offering uuid := '00000000-0000-0000-0000-000000000016';
begin
  insert into public.course_offerings
    (id, course_id, label, capacity, remaining_seats, price, recruit_opens_at, opens_at, ends_at, status, deleted_at, deleted_reason, deleted_by)
  values
    (v_hidden_offering, '00000000-0000-0000-0000-000000000001', '숨긴기수', 5, 5, 50000, now() - interval '7 days', now() + interval '1 day', now() + interval '30 days', 'OPEN', now(), 'TEST20 숨김', '00000000-0000-0000-0000-000000000100');

  begin
    perform public.create_order('00000000-0000-0000-0000-000000000100', v_hidden_offering, null, null::uuid[]);
    raise notice 'TEST20 FAIL: 숨긴(deleted_at) 개설강의에 신청이 성공함 — 버그 A 재발';
  exception
    when undefined_function then
      raise notice 'TEST20 FAIL: create_order 호출이 모호하거나 함수를 찾지 못함 — %', sqlerrm;
    when others then
      raise notice 'TEST20 PASS: 숨긴(deleted_at) 개설강의는 신청이 거부됨';
  end;
end $$;

-- TEST 21: consume_entitlement() — 다운로드 클릭 1번이 사용 횟수 1회로 원자적으로 남는지.
-- 읽기→판단→insert를 애플리케이션에서 나누면 더블클릭이 횟수를 두 번 쓸 수 있어서
-- 이 함수가 FOR UPDATE로 잠근 뒤 entitlement_uses에 1건만 넣어야 한다(2026-09-15 D).
-- download_count 컬럼은 없다. 횟수는 이력 행 개수다.
do $$
declare
  v_ent_id uuid := '00000000-0000-0000-0000-000000000210';
  v_revoked_id uuid := '00000000-0000-0000-0000-000000000211';
  v_expired_id uuid := '00000000-0000-0000-0000-000000000212';
  v_result jsonb;
  v_use_count integer;
  v_product uuid;
  v_order uuid;
  v_pe1 uuid;
  v_pe2 uuid;
  v_pe3 uuid;
begin
  -- E-1(ADR-0019)부터 모든 이용권은 부여 근거(결제 원장 행)를 가진다(entitlements_grant_source_pair).
  -- 같은 근거에 같은 종류를 두 번 넣을 수 없어(멱등 인덱스) 이용권마다 결제 원장 행을 하나씩 만든다.
  insert into public.products (name, price) values ('TEST21 상품', 1000) returning id into v_product;
  insert into public.orders (user_id, product_id, status, approved_at)
  values ('00000000-0000-0000-0000-000000000100', v_product, 'APPROVED', now()) returning id into v_order;
  insert into public.payment_events (order_id, event_type, amount, provider, provider_event_id)
  values (v_order, 'PAYMENT_SUCCEEDED', 1000, 'MOCK', 'test21-pe-1') returning id into v_pe1;
  insert into public.payment_events (order_id, event_type, amount, provider, provider_event_id)
  values (v_order, 'PAYMENT_SUCCEEDED', 1000, 'MOCK', 'test21-pe-2') returning id into v_pe2;
  insert into public.payment_events (order_id, event_type, amount, provider, provider_event_id)
  values (v_order, 'PAYMENT_SUCCEEDED', 1000, 'MOCK', 'test21-pe-3') returning id into v_pe3;

  insert into public.entitlements
    (id, user_id, type, order_id, payment_event_id, max_uses, access_code, metadata)
  values
    (v_ent_id, '00000000-0000-0000-0000-000000000100', 'SOURCE_DOWNLOAD', v_order, v_pe1, 1, 'TEST21CODE000001', '{"blob_pathname":"source-packs/a.zip"}'::jsonb),
    (v_revoked_id, '00000000-0000-0000-0000-000000000100', 'SOURCE_DOWNLOAD', v_order, v_pe2, 1, 'TEST21CODE000002', '{}'::jsonb),
    (v_expired_id, '00000000-0000-0000-0000-000000000100', 'SOURCE_DOWNLOAD', v_order, v_pe3, 1, 'TEST21CODE000003', '{}'::jsonb);

  update public.entitlements set revoked_at = now(), revoked_reason = 'REFUNDED' where id = v_revoked_id;
  update public.entitlements set expires_at = now() - interval '1 day' where id = v_expired_id;

  -- 21a: 본인 권한 1회 소비 성공, 이력 1건
  v_result := public.consume_entitlement(v_ent_id, '00000000-0000-0000-0000-000000000100', null, null);
  select count(*) into v_use_count from public.entitlement_uses where entitlement_id = v_ent_id;
  if v_use_count = 1 and v_result->>'type' = 'SOURCE_DOWNLOAD' then
    raise notice 'TEST21a PASS: 첫 소비가 이력 1건을 남김';
  else
    raise notice 'TEST21a FAIL: use_count=%, result=%', v_use_count, v_result;
  end if;

  -- 21b: max_uses=1 인데 두 번째 소비는 거부, 이력은 그대로 1건
  begin
    perform public.consume_entitlement(v_ent_id, '00000000-0000-0000-0000-000000000100', null, null);
    raise notice 'TEST21b FAIL: 횟수 소진 후에도 소비가 성공함';
  exception when others then
    select count(*) into v_use_count from public.entitlement_uses where entitlement_id = v_ent_id;
    if v_use_count = 1 then
      raise notice 'TEST21b PASS: 횟수 소진 후 거부되고 이력은 1건 유지';
    else
      raise notice 'TEST21b FAIL: 거부됐지만 이력 개수가 변함(%)', v_use_count;
    end if;
  end;

  -- 21c: 다른 사람 id로 소비 시도 거부
  begin
    perform public.consume_entitlement(v_ent_id, '00000000-0000-0000-0000-0000000000ff', null, null);
    raise notice 'TEST21c FAIL: 남의 권한이 소비됨';
  exception when others then
    raise notice 'TEST21c PASS: 본인 아닌 user_id는 거부됨';
  end;

  -- 21d: 회수된 권한 거부
  begin
    perform public.consume_entitlement(v_revoked_id, '00000000-0000-0000-0000-000000000100', null, null);
    raise notice 'TEST21d FAIL: 회수된 권한이 소비됨';
  exception when others then
    raise notice 'TEST21d PASS: 회수된 권한은 거부됨';
  end;

  -- 21e: 만료된 권한 거부
  begin
    perform public.consume_entitlement(v_expired_id, '00000000-0000-0000-0000-000000000100', null, null);
    raise notice 'TEST21e FAIL: 만료된 권한이 소비됨';
  exception when others then
    raise notice 'TEST21e PASS: 만료된 권한은 거부됨';
  end;

  -- 21f: 없는 id 거부
  begin
    perform public.consume_entitlement('00000000-0000-0000-0000-000000000299', '00000000-0000-0000-0000-000000000100', null, null);
    raise notice 'TEST21f FAIL: 없는 권한이 소비됨';
  exception when others then
    raise notice 'TEST21f PASS: 없는 권한 id는 거부됨';
  end;
end $$;

-- =========================================================
-- TEST 22~27: 매니저 역할·권한 (2026-09-18, supabase/migrations/20260918100000_manager_permissions.sql)
-- =========================================================

-- 준비: 매니저 테스트 전용 회원 3명(승격 대상 학생, 별도 ADMIN, 탈퇴한 학생)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000005aa', 'test-manager-target@example.com'),
  ('00000000-0000-0000-0000-0000000005ab', 'test-manager-admin@example.com'),
  ('00000000-0000-0000-0000-0000000005ac', 'test-manager-withdrawn@example.com');

insert into public.users (id, auth_user_id, email, role, withdrawn_at) values
  ('00000000-0000-0000-0000-000000000500', '00000000-0000-0000-0000-0000000005aa', 'test-manager-target@example.com', 'STUDENT', null),
  ('00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-0000000005ab', 'test-manager-admin@example.com', 'ADMIN', null),
  ('00000000-0000-0000-0000-000000000502', '00000000-0000-0000-0000-0000000005ac', 'test-manager-withdrawn@example.com', 'STUDENT', now());

-- TEST 22: users.role CHECK 제약이 MANAGER를 허용해야 한다.
do $$
begin
  begin
    update public.users set role = 'MANAGER' where id = '00000000-0000-0000-0000-000000000500';
    update public.users set role = 'STUDENT' where id = '00000000-0000-0000-0000-000000000500';
    raise notice 'TEST22 PASS: users.role CHECK 제약이 MANAGER 값을 허용함';
  exception when check_violation then
    raise notice 'TEST22 FAIL: MANAGER 값이 CHECK 제약에 거부됨';
  end;
end $$;

-- TEST 23~24: ADMIN은 앱 경로(service_role)로 부여·변경할 수 없다("규율이 아니라 구조적으로
-- 불가능하게", 2026-09-18). set local role로 실제 앱이 쓰는 권한을 흉내 낸다(rls_check.sql과
-- 동일한 방식). 각 서브테스트 뒤 반드시 reset role — 빠뜨리면 이후 테스트가 전부 무너진다.
set local role service_role;

do $$
begin
  begin
    insert into public.users (auth_user_id, email, role)
    values (null, 'hacker@example.com', 'ADMIN');
    raise notice 'TEST23 FAIL: service_role이 ADMIN 행을 직접 insert함';
  exception when insufficient_privilege then
    raise notice 'TEST23 PASS: service_role의 ADMIN insert가 트리거로 차단됨';
  end;
end $$;

do $$
begin
  begin
    update public.users set role = 'MANAGER' where id = '00000000-0000-0000-0000-000000000501';
    raise notice 'TEST24 FAIL: 기존 ADMIN(501)의 role이 service_role로 바뀜';
  exception when insufficient_privilege then
    raise notice 'TEST24 PASS: 기존 ADMIN(501)의 role 변경이 트리거로 차단됨';
  end;
end $$;

reset role;

-- TEST 25: set_manager()는 ADMIN과 탈퇴자를 대상으로 거부해야 한다.
do $$
begin
  begin
    perform public.set_manager('00000000-0000-0000-0000-000000000501'::uuid, '00000000-0000-0000-0000-000000000501'::uuid, true, true, true);
    raise notice 'TEST25a FAIL: ADMIN 대상 set_manager가 성공함';
  exception when others then
    raise notice 'TEST25a PASS: ADMIN 대상 set_manager 거부됨 — %', sqlerrm;
  end;

  begin
    perform public.set_manager('00000000-0000-0000-0000-000000000502'::uuid, '00000000-0000-0000-0000-000000000501'::uuid, true, false, false);
    raise notice 'TEST25b FAIL: 탈퇴자 대상 set_manager가 성공함';
  exception when others then
    raise notice 'TEST25b PASS: 탈퇴자 대상 set_manager 거부됨 — %', sqlerrm;
  end;
end $$;

-- TEST 26: complete_signup()은 p_role 파라미터가 없고 항상 STUDENT로만 가입시킨다.
do $$
declare
  v_auth_id uuid := '00000000-0000-0000-0000-0000000006aa';
  v_new_id uuid;
  v_role text;
begin
  insert into auth.users (id, email) values (v_auth_id, 'test-signup-always-student@example.com');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data)
    values (gen_random_uuid(), v_auth_id, v_auth_id::text, 'email', jsonb_build_object('sub', v_auth_id::text, 'email', 'test-signup-always-student@example.com'));

  v_new_id := public.complete_signup(
    v_auth_id, 'test-signup-always-student@example.com',
    (select id from public.terms where type = 'SERVICE_USE' order by effective_at desc limit 1),
    (select id from public.terms where type = 'PRIVACY_USE' order by effective_at desc limit 1)
  );

  select role into v_role from public.users where id = v_new_id;

  if v_role = 'STUDENT' then
    raise notice 'TEST26 PASS: complete_signup()은 항상 STUDENT로 가입시킴(role 파라미터 없음)';
  else
    raise notice 'TEST26 FAIL: role=%', v_role;
  end if;
end $$;

-- TEST 27: anon/authenticated는 민감한 함수(가입·신청·결제·권한소비·좌석·매니저 승격·박탈)를
-- 직접 호출할 실행 권한이 없어야 한다(전수조사에서 발견된 구멍, 2026-09-18). 2026-09-25 : 주문 핸들러 2개 추가.
do $$
declare
  v_leaks text[];
begin
  select array_agg(fn) into v_leaks from (
    select 'complete_signup' as fn where has_function_privilege('anon', 'public.complete_signup(uuid,text,uuid,uuid,uuid)', 'execute')
       or has_function_privilege('authenticated', 'public.complete_signup(uuid,text,uuid,uuid,uuid)', 'execute')
    union all
    select 'create_order' where has_function_privilege('anon', 'public.create_order(uuid,uuid,uuid,uuid[],text)', 'execute')
       or has_function_privilege('authenticated', 'public.create_order(uuid,uuid,uuid,uuid[],text)', 'execute')
    union all
    select 'record_payment_event' where has_function_privilege('anon', 'public.record_payment_event(text,text,text,integer,text,uuid,text,jsonb,jsonb,text)', 'execute')
       or has_function_privilege('authenticated', 'public.record_payment_event(text,text,text,integer,text,uuid,text,jsonb,jsonb,text)', 'execute')
    union all
    select 'consume_entitlement' where has_function_privilege('anon', 'public.consume_entitlement(uuid,uuid,text,text)', 'execute')
       or has_function_privilege('authenticated', 'public.consume_entitlement(uuid,uuid,text,text)', 'execute')
    union all
    select 'reserve_course_offering_seat' where has_function_privilege('anon', 'public.reserve_course_offering_seat(uuid)', 'execute')
       or has_function_privilege('authenticated', 'public.reserve_course_offering_seat(uuid)', 'execute')
    union all
    select 'release_course_offering_seat' where has_function_privilege('anon', 'public.release_course_offering_seat(uuid)', 'execute')
       or has_function_privilege('authenticated', 'public.release_course_offering_seat(uuid)', 'execute')
    union all
    select 'set_manager' where has_function_privilege('anon', 'public.set_manager(uuid,uuid,boolean,boolean,boolean)', 'execute')
       or has_function_privilege('authenticated', 'public.set_manager(uuid,uuid,boolean,boolean,boolean)', 'execute')
    union all
    select 'revoke_manager' where has_function_privilege('anon', 'public.revoke_manager(uuid,text,uuid)', 'execute')
       or has_function_privilege('authenticated', 'public.revoke_manager(uuid,text,uuid)', 'execute')
    union all
    select 'on_payment_succeeded' where has_function_privilege('anon', 'public.on_payment_succeeded(uuid,uuid,text,integer,text,text,jsonb)', 'execute')
       or has_function_privilege('authenticated', 'public.on_payment_succeeded(uuid,uuid,text,integer,text,text,jsonb)', 'execute')
    union all
    select 'on_payment_refunded' where has_function_privilege('anon', 'public.on_payment_refunded(uuid,uuid,text,integer,text,text,text,boolean)', 'execute')
       or has_function_privilege('authenticated', 'public.on_payment_refunded(uuid,uuid,text,integer,text,text,text,boolean)', 'execute')
    union all
    select 'withdraw_user' where has_function_privilege('anon', 'public.withdraw_user(uuid)', 'execute')
       or has_function_privilege('authenticated', 'public.withdraw_user(uuid)', 'execute')
    union all
    select 'reactivate_user' where has_function_privilege('anon', 'public.reactivate_user(uuid,uuid,uuid)', 'execute')
       or has_function_privilege('authenticated', 'public.reactivate_user(uuid,uuid,uuid)', 'execute')
    union all
    select 'link_discord_identity' where has_function_privilege('anon', 'public.link_discord_identity(uuid,text)', 'execute')
       or has_function_privilege('authenticated', 'public.link_discord_identity(uuid,text)', 'execute')
    union all
    select 'grant_entitlements_for_order' where has_function_privilege('anon', 'public.grant_entitlements_for_order(uuid,uuid,text,uuid,jsonb)', 'execute')
       or has_function_privilege('authenticated', 'public.grant_entitlements_for_order(uuid,uuid,text,uuid,jsonb)', 'execute')
    union all
    select 'revoke_entitlements' where has_function_privilege('anon', 'public.revoke_entitlements(uuid,uuid,text,text)', 'execute')
       or has_function_privilege('authenticated', 'public.revoke_entitlements(uuid,uuid,text,text)', 'execute')
    union all
    select 'mark_discord_role_removed' where has_function_privilege('anon', 'public.mark_discord_role_removed(uuid)', 'execute')
       or has_function_privilege('authenticated', 'public.mark_discord_role_removed(uuid)', 'execute')
    union all
    select 'generate_access_code' where has_function_privilege('anon', 'public.generate_access_code()', 'execute')
       or has_function_privilege('authenticated', 'public.generate_access_code()', 'execute')
    union all
    select 'reset_dead_outbox_message' where has_function_privilege('anon', 'public.reset_dead_outbox_message(uuid)', 'execute')
       or has_function_privilege('authenticated', 'public.reset_dead_outbox_message(uuid)', 'execute')
    union all
    select 'cancel_orders_for_withdrawn_user' where has_function_privilege('anon', 'public.cancel_orders_for_withdrawn_user(uuid)', 'execute')
       or has_function_privilege('authenticated', 'public.cancel_orders_for_withdrawn_user(uuid)', 'execute')
    union all
    select 'assert_manager_eligible' where has_function_privilege('anon', 'public.assert_manager_eligible(uuid)', 'execute')
       or has_function_privilege('authenticated', 'public.assert_manager_eligible(uuid)', 'execute')
    union all
    select 'auth_account_state_by_email' where has_function_privilege('anon', 'public.auth_account_state_by_email(text)', 'execute')
       or has_function_privilege('authenticated', 'public.auth_account_state_by_email(text)', 'execute')
    union all
    select 'claim_outbox_messages' where has_function_privilege('anon', 'public.claim_outbox_messages(integer,integer)', 'execute')
       or has_function_privilege('authenticated', 'public.claim_outbox_messages(integer,integer)', 'execute')
    union all
    select 'set_payment_provider' where has_function_privilege('anon', 'public.set_payment_provider(text,text,uuid)', 'execute')
       or has_function_privilege('authenticated', 'public.set_payment_provider(text,text,uuid)', 'execute')
    union all
    select 'sync_my_email' where has_function_privilege('anon', 'public.sync_my_email()', 'execute')
  ) leaked;

  if v_leaks is null then
    raise notice 'TEST27 PASS: anon/authenticated는 민감한 함수에 실행 권한 없음(sync_my_email은 authenticated 허용이 설계 — 별도 확인)';
  else
    raise notice 'TEST27 FAIL: 실행 권한이 새고 있는 함수 — %', v_leaks;
  end if;
end $$;

-- =========================================================
-- TEST 28~31: 감사 모듈 재설계(2026-09-20) — audit_logs/order_events 위변조 방지
-- + dead_letters.source='AUDIT' 확장이 실제로 동작하는지 확인한다.
-- =========================================================

-- TEST 28~29: audit_logs는 postgres(테이블 소유자)로도 UPDATE/DELETE할 수 없다.
-- REVOKE는 anon/authenticated/service_role에서만 걷었으므로(소유자는 여전히 권한이 있다),
-- 이 트리거가 진짜 마지막 방어선이다(forbid_users_hard_delete.sql과 동일 원칙).
do $$
declare
  v_actor_id uuid;
  v_log_id uuid;
begin
  select id into v_actor_id from public.users where email = 'test-signup@example.com' limit 1;

  insert into public.audit_logs (actor_user_id, action, target_table, phase)
  values (v_actor_id, 'TEST_AUDIT_IMMUTABILITY', 'courses', 'SUCCEEDED')
  returning id into v_log_id;

  begin
    update public.audit_logs set action = 'TAMPERED' where id = v_log_id;
    raise notice 'TEST28 FAIL: audit_logs 행이 UPDATE됨';
  exception when restrict_violation then
    raise notice 'TEST28 PASS: audit_logs UPDATE가 트리거로 차단됨';
  end;

  begin
    delete from public.audit_logs where id = v_log_id;
    raise notice 'TEST29 FAIL: audit_logs 행이 DELETE됨';
  exception when restrict_violation then
    raise notice 'TEST29 PASS: audit_logs DELETE가 트리거로 차단됨';
  end;
end $$;

-- TEST 30: order_events는 앱 경로(service_role)로 UPDATE할 수 없다. audit_logs와 달리
-- REVOKE를 안 걸었으므로(과거 백필 마이그레이션 같은 소유자 작업 여지를 남김), 방어는
-- 트리거의 current_user 검사뿐이다 — set local role로 실제 앱이 쓰는 권한을 흉내 낸다.
set local role service_role;

do $$
begin
  begin
    update public.order_events set event_type = 'CANCELLED'
    where event_type = 'APPLIED';
    raise notice 'TEST30 FAIL: order_events 행이 service_role로 UPDATE됨';
  exception when restrict_violation then
    raise notice 'TEST30 PASS: order_events UPDATE가 트리거로 차단됨(service_role)';
  end;
end $$;

reset role;

-- TEST 31: dead_letters.source='AUDIT'는 이제 유효한 값이다(감사 기록 실패를 DLQ로
-- 흘리기 위한 확장, 2026-09-20).
do $$
begin
  begin
    insert into public.dead_letters (source, payload, error_message)
    values ('AUDIT', '{"action":"TEST"}'::jsonb, '테스트');
    raise notice 'TEST31 PASS: source=AUDIT INSERT가 CHECK 제약을 통과함';
  exception when check_violation then
    raise notice 'TEST31 FAIL: source=AUDIT가 여전히 CHECK 제약에 막힘';
  end;
end $$;

-- =========================================================
-- TEST 32~34: 원자성 위험 유형 2 해결 — 관리자 커맨드
-- 3개를 여러 번의 순차 호출에서 단일 RPC로 옮겼다. 중간 실패 시 전부 롤백되는지 확인한다.
-- =========================================================

-- TEST 32: create_course_offering() — 회차가 겹쳐서 실패하면 방금 만든 개설강의도 함께
-- 롤백돼 고아 데이터가 안 남는다.
do $$
declare
  v_course_id uuid;
  v_count_before integer;
  v_count_after integer;
begin
  insert into public.courses (name, category) values ('TEST32강의', 'TEST') returning id into v_course_id;

  perform pg_temp.create_offering_legacy(
    v_course_id, 'A반', 10, 10000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    '14:00'::time, '16:00'::time, array[2]::smallint[]
  , now() - interval '2 days');

  select count(*) into v_count_before from public.course_offerings;

  begin
    perform pg_temp.create_offering_legacy(
      v_course_id, 'B반(겹침)', 10, 10000, null, false,
      now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
      '15:00'::time, '17:00'::time, array[2]::smallint[]
    , now() - interval '2 days');
    raise notice 'TEST32 FAIL: 겹치는 시간대인데 생성이 성공함';
  exception when exclusion_violation then
    select count(*) into v_count_after from public.course_offerings;
    if v_count_after = v_count_before then
      raise notice 'TEST32 PASS: 회차 겹침 실패 시 개설강의도 함께 롤백됨(고아 데이터 없음)';
    else
      raise notice 'TEST32 FAIL: 개설강의가 고아로 남음(before=%, after=%)', v_count_before, v_count_after;
    end if;
  end;
end $$;

-- TEST 33: delete_course_offering() — 신청 내역이 있으면 거부하고, 회차·개설강의 둘 다
-- 그대로 남긴다(부분 삭제 없음).
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
begin
  insert into public.courses (name, category) values ('TEST33강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 10000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    '09:00'::time, '10:00'::time, array[4]::smallint[]
  , now() - interval '2 days');

  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test33@example.com', 'STUDENT')
    returning id into v_user_id;
  insert into public.orders (user_id, course_offering_id) values (v_user_id, v_offering_id);

  begin
    perform public.delete_course_offering(v_offering_id, 'TEST33 삭제 시도', v_user_id);
    raise notice 'TEST33 FAIL: 신청 내역이 있는데 삭제됨';
  exception when others then
    if (select count(*) from public.course_sessions where course_offering_id = v_offering_id) >= 1
       and (select count(*) from public.course_sessions where course_offering_id = v_offering_id and deactivated_at is not null) = 0
       and (select deleted_at from public.course_offerings where id = v_offering_id) is null then
      raise notice 'TEST33 PASS: 신청 내역 있으면 삭제 거부되고 회차·개설강의 둘 다 그대로 남음';
    else
      raise notice 'TEST33 FAIL: 부분 삭제 발생 — %', sqlerrm;
    end if;
  end;
end $$;

-- =========================================================
-- TEST35~36: 신청 상태 전이 검증 (2026-09-23 크리티컬 수정 1단계)
-- =========================================================

-- TEST 35: 같은 건을 두 번 반려하면 두 번째는 거부되고, 좌석은 한 번만 반환된다.
-- (낡은 탭에서 반려 버튼을 다시 누르면 좌석이 뻥튀기되던 구멍 — 정원 붕괴로 직결됐다.)
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_admin_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_seats_after_first integer;
  v_seats_after_second integer;
  v_status text;
begin
  insert into public.courses (name, category) values ('TEST35강의', 'TEST') returning id into v_course_id;
  -- 실제로 create_order()을 호출하므로 모집기간이 열려 있어야 한다(TEST34와 다른 점).
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 10000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');

  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test35a@example.com', 'STUDENT')
    returning id into v_admin_id;
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test35@example.com', 'STUDENT')
    returning id into v_user_id;

  -- 신청(좌석 1 차감)
  v_order_id := public.create_order(v_user_id, v_offering_id, null, null);

  -- 1차 반려 — 성공해야 하고 좌석이 돌아와야 한다
  perform public.transition_order(v_order_id, v_admin_id, 'ADMIN', 'REJECTED', 'REJECTED', 'TEST35 반려');
  select remaining_seats into v_seats_after_first from public.course_offerings where id = v_offering_id;

  -- 2차 반려 — 거부돼야 한다
  begin
    perform public.transition_order(v_order_id, v_admin_id, 'ADMIN', 'REJECTED', 'REJECTED', 'TEST35 재반려');
    raise notice 'TEST35 FAIL: 이미 반려된 건이 또 반려됨';
  exception when restrict_violation then
    select remaining_seats into v_seats_after_second from public.course_offerings where id = v_offering_id;
    select status into v_status from public.orders where id = v_order_id;
    if v_seats_after_first = 10 and v_seats_after_second = 10 and v_status = 'REJECTED' then
      raise notice 'TEST35 PASS: 반려 재실행 거부, 좌석 1회만 반환(10 유지)';
    else
      raise notice 'TEST35 FAIL: 좌석/상태 이상(first=%, second=%, status=%)',
        v_seats_after_first, v_seats_after_second, v_status;
    end if;
  end;
end $$;

-- TEST 36: 반려된 건을 승인으로 되살릴 수 없다(REJECTED -> ENROLLED 차단).
-- 예전엔 통과됐고, 좌석 재차감도 없어 정원 초과 등록 + 결제까지 가능했다.
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_admin_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_status text;
begin
  insert into public.courses (name, category) values ('TEST36강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 10000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test36a@example.com', 'STUDENT')
    returning id into v_admin_id;
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test36@example.com', 'STUDENT')
    returning id into v_user_id;

  v_order_id := public.create_order(v_user_id, v_offering_id, null, null);
  perform public.transition_order(v_order_id, v_admin_id, 'ADMIN', 'REJECTED', 'REJECTED', 'TEST36 반려');

  begin
    perform public.transition_order(v_order_id, v_admin_id, 'ADMIN', 'APPROVED', 'APPROVED');
    raise notice 'TEST36 FAIL: 반려된 건이 승인으로 되살아남';
  exception when restrict_violation then
    select status into v_status from public.orders where id = v_order_id;
    if v_status = 'REJECTED' then
      raise notice 'TEST36 PASS: REJECTED -> ENROLLED 전이 차단됨';
    else
      raise notice 'TEST36 FAIL: 상태가 %로 바뀜', v_status;
    end if;
  end;
end $$;

-- =========================================================
-- TEST39~41: 결제 확정 가드 (2026-09-23 크리티컬 수정 2단계)
-- TEST35~38과 같이 각 테스트가 자기 강의·학생을 만든다. 시드 학생(...000100)은 offering
-- 011을 TEST12가 이미 점유해 unique (user_id, course_offering_id)에 걸리기 때문이다.
-- 회차(course_sessions)를 만들지 않으므로 학생 스케줄 겹침 트리거에도 걸리지 않는다.
-- =========================================================

-- TEST 39: 청구 금액과 다른 금액으로 결제성공 웹훅이 오면 반영하지 않는다(금액 대사).
-- 예전엔 비교 자체가 없어서, PG가 1000원짜리 성공을 보내도 10만원 강의가 PAID로 찍히고
-- 권한까지 부여됐다.
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_result boolean;
  v_payment_status text;
  v_grant_count integer;
  v_dlq_count integer;
  v_event_count integer;
begin
  insert into public.courses (name, category) values ('TEST39강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test39@example.com', 'STUDENT')
    returning id into v_user_id;

  insert into public.orders (user_id, course_offering_id, status, approved_at, list_price, final_amount)
  values (v_user_id, v_offering_id, 'APPROVED', now(), 100000, 100000)
  returning id into v_order_id;

  -- 청구는 100000인데 1000이 들어온다
  select public.record_payment_event('MOCK', 'evt-amount-mismatch', 'PAYMENT_SUCCEEDED', 1000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb) into v_result;
  perform pg_temp.deliver_payment_facts();

  select payment_status into v_payment_status from public.orders where id = v_order_id;
  select count(*) into v_grant_count from public.outbox_messages
    where topic = 'ORDER_PAID' and payload->>'order_id' = v_order_id::text;
  select count(*) into v_dlq_count from public.dead_letters
    where error_message like '%결제 금액이 청구 금액과 다름%' and error_message like '%' || v_order_id::text || '%';
  -- 원장에는 사실 그대로 남아야 한다(이벤트소싱 원칙)
  select count(*) into v_event_count from public.payment_events where order_id = v_order_id;

  if v_result and v_payment_status = 'UNPAID' and v_grant_count = 0 and v_dlq_count = 1 and v_event_count = 1 then
    raise notice 'TEST39 PASS: 금액 불일치 — 원장엔 기록, 상태는 UNPAID 유지, 권한 미지급, DLQ 1건';
  else
    raise notice 'TEST39 FAIL: result=%, payment_status=%, grant=%, dlq=%, events=%',
      v_result, v_payment_status, v_grant_count, v_dlq_count, v_event_count;
  end if;
end $$;

-- TEST 40: 수강 상태가 ENROLLED가 아닌 건(결제 진행 중 관리자가 취소)에 결제성공이 오면
-- 반영하지 않는다. 예전엔 payment_status만 보고 PAID를 찍어 (CANCELLED, PAID) 행이
-- 만들어지고 entitlements·디스코드 역할까지 부여됐다.
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_result boolean;
  v_payment_status text;
  v_status text;
  v_grant_count integer;
  v_dlq_count integer;
begin
  insert into public.courses (name, category) values ('TEST40강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test40@example.com', 'STUDENT')
    returning id into v_user_id;

  insert into public.orders (user_id, course_offering_id, status, cancelled_at, list_price, final_amount)
  values (v_user_id, v_offering_id, 'CANCELLED', now(), 100000, 100000)
  returning id into v_order_id;

  select public.record_payment_event('MOCK', 'evt-cancelled-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb) into v_result;
  perform pg_temp.deliver_payment_facts();

  select payment_status, status into v_payment_status, v_status
    from public.orders where id = v_order_id;
  select count(*) into v_grant_count from public.outbox_messages
    where topic = 'ORDER_PAID' and payload->>'order_id' = v_order_id::text;
  select count(*) into v_dlq_count from public.dead_letters
    where error_message like '%주문 상태가 APPROVED가 아닌%' and error_message like '%' || v_order_id::text || '%';

  if v_result and v_payment_status = 'UNPAID' and v_status = 'CANCELLED' and v_grant_count = 0 and v_dlq_count = 1 then
    raise notice 'TEST40 PASS: 취소된 신청건의 결제성공 — PAID 미반영, 권한 미지급, DLQ에 환불검토 경고';
  else
    raise notice 'TEST40 FAIL: result=%, payment=%, enrollment=%, grant=%, dlq=%',
      v_result, v_payment_status, v_status, v_grant_count, v_dlq_count;
  end if;
end $$;

-- TEST 41: 결제완료가 아닌 건에 환불 이벤트가 오면 조용히 무시하고 DLQ에만 남긴다.
-- 예전엔 가드가 없어 CHECK 위반으로 트랜잭션 전체가 롤백돼, 환불 시도 사실이 원장에도
-- 안 남았다(= 아무 흔적 없이 사라짐).
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_result boolean;
  v_payment_status text;
  v_event_count integer;
  v_revoke_count integer;
  v_dlq_count integer;
begin
  insert into public.courses (name, category) values ('TEST41강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test41@example.com', 'STUDENT')
    returning id into v_user_id;

  insert into public.orders (user_id, course_offering_id, status, approved_at, list_price, final_amount)
  values (v_user_id, v_offering_id, 'APPROVED', now(), 100000, 100000)
  returning id into v_order_id;

  -- UNPAID 상태인데 환불 웹훅이 들어온다
  select public.record_payment_event('MOCK', 'evt-refund-unpaid', 'REFUNDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb) into v_result;
  perform pg_temp.deliver_payment_facts();

  select payment_status into v_payment_status from public.orders where id = v_order_id;
  select count(*) into v_event_count from public.payment_events where order_id = v_order_id;
  select count(*) into v_revoke_count from public.outbox_messages
    where topic = 'ORDER_REFUNDED' and payload->>'order_id' = v_order_id::text;
  select count(*) into v_dlq_count from public.dead_letters
    where error_message like '%결제완료 상태가 아닌%' and error_message like '%' || v_order_id::text || '%';

  if v_result and v_payment_status = 'UNPAID' and v_event_count = 1 and v_revoke_count = 0 and v_dlq_count = 1 then
    raise notice 'TEST41 PASS: UNPAID 건 환불 이벤트 — 롤백 없이 원장 기록 유지, 상태 불변, DLQ 1건';
  else
    raise notice 'TEST41 FAIL: result=%, payment_status=%, events=%, revoke=%, dlq=%',
      v_result, v_payment_status, v_event_count, v_revoke_count, v_dlq_count;
  end if;
end $$;

-- =========================================================
-- TEST42~43: 학생 본인 취소 RPC (2026-09-23 크리티컬 수정 3단계)
-- =========================================================

-- TEST 42: 같은 건을 두 번 취소하면 두 번째는 거부되고 좌석은 한 번만 반환된다.
-- 예전엔 앱이 상태를 읽고 UPDATE하는 사이가 열려 있어(TOCTOU), "신청 취소"를 더블클릭하면
-- 두 요청이 각자 좌석을 반환해 +2가 됐다.
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_seats_after_first integer;
  v_seats_after_second integer;
  v_event_count integer;
begin
  insert into public.courses (name, category) values ('TEST42강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 10000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  -- 이메일 미인증 학생으로 만든다 — 취소는 인증과 무관하게 돼야 한다(③).
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test42@example.com', 'STUDENT')
    returning id into v_user_id;

  v_order_id := public.create_order(v_user_id, v_offering_id, null, null);

  perform public.cancel_own_order(v_order_id, v_user_id);
  select remaining_seats into v_seats_after_first from public.course_offerings where id = v_offering_id;

  begin
    perform public.cancel_own_order(v_order_id, v_user_id);
    raise notice 'TEST42 FAIL: 이미 취소된 건이 또 취소됨';
  exception when restrict_violation then
    select remaining_seats into v_seats_after_second from public.course_offerings where id = v_offering_id;
    select count(*) into v_event_count from public.order_events
      where order_id = v_order_id and event_type = 'CANCELLED';
    if v_seats_after_first = 10 and v_seats_after_second = 10 and v_event_count = 1 then
      raise notice 'TEST42 PASS: 취소 재실행 거부 — 좌석 1회만 반환(10 유지), 이벤트도 1건';
    else
      raise notice 'TEST42 FAIL: first=%, second=%, events=%',
        v_seats_after_first, v_seats_after_second, v_event_count;
    end if;
  end;
end $$;

-- TEST 43: 남의 신청 건은 취소할 수 없다(소유권 검사가 함수 안에 있다).
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_owner_id uuid;
  v_other_id uuid;
  v_order_id uuid;
  v_status text;
begin
  insert into public.courses (name, category) values ('TEST43강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 10000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test43o@example.com', 'STUDENT')
    returning id into v_owner_id;
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test43x@example.com', 'STUDENT')
    returning id into v_other_id;

  v_order_id := public.create_order(v_owner_id, v_offering_id, null, null);

  begin
    perform public.cancel_own_order(v_order_id, v_other_id);
    raise notice 'TEST43 FAIL: 남의 신청 건이 취소됨';
  exception when others then
    select status into v_status from public.orders where id = v_order_id;
    if v_status = 'PENDING' then
      raise notice 'TEST43 PASS: 남의 신청 건 취소 거부, 상태 그대로 유지';
    else
      raise notice 'TEST43 FAIL: 상태가 %로 바뀜', v_status;
    end if;
  end;
end $$;

-- TEST 44: 환불 = 수강 종료. 결제완료 건을 환불하면 결제상태만
-- 바뀌는 게 아니라 수강도 취소되고 좌석이 반환된다. 예전엔 payment_status만 바뀌어
-- "환불받고 나간 학생이 정원 1자리를 영구 점유"했다.
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_seats_after_apply integer;
  v_seats_after_refund integer;
  v_status text;
  v_payment_status text;
  v_revoke_count integer;
begin
  insert into public.courses (name, category) values ('TEST44강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test44@example.com', 'STUDENT')
    returning id into v_user_id;

  -- 실제 신청(좌석 -1) → 승인 → 결제완료
  v_order_id := public.create_order(v_user_id, v_offering_id, null, null);
  select remaining_seats into v_seats_after_apply from public.course_offerings where id = v_offering_id;

  update public.orders
  set status = 'APPROVED', approved_at = now()
  where id = v_order_id;

  perform public.record_payment_event('MOCK', 'evt-test44-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();

  -- 환불
  perform public.record_payment_event('MOCK', 'evt-test44-refund', 'REFUNDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();

  select status, payment_status into v_status, v_payment_status
    from public.orders where id = v_order_id;
  select remaining_seats into v_seats_after_refund from public.course_offerings where id = v_offering_id;
  select count(*) into v_revoke_count from public.outbox_messages
    where topic = 'ORDER_REFUNDED' and payload->>'order_id' = v_order_id::text;

  if v_status = 'CANCELLED' and v_payment_status = 'REFUNDED'
     and v_seats_after_apply = 9 and v_seats_after_refund = 10 and v_revoke_count = 1 then
    raise notice 'TEST44 PASS: 환불 시 수강도 취소되고 좌석 반환(9 -> 10), 권한 회수 아웃박스 1건';
  else
    raise notice 'TEST44 FAIL: enrollment=%, payment=%, seats_apply=%, seats_refund=%, revoke=%',
      v_status, v_payment_status, v_seats_after_apply, v_seats_after_refund, v_revoke_count;
  end if;
end $$;

-- =========================================================
-- TEST 45~48: DB 구조 재정립 1단계(2026-09-23) — 이력을 신청서 번호로 연결.
-- order_events.order_id / terms_agreements.order_id가 NOT NULL 제약만으로도
-- 채워지긴 하지만, 여기서는 "값이 정확히 그 신청서를 가리키는지"까지 확인한다.
-- =========================================================
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
  v_privacy_terms_id uuid;
  v_license_terms_id uuid;
  v_order_id uuid;
  v_event_order_id uuid;
  v_agreement_count integer;
begin
  select id into v_privacy_terms_id from public.terms where type = 'PRIVACY_USE' order by effective_at desc limit 1;
  select id into v_license_terms_id from public.terms where type = 'SOFTWARE_LICENSE_USE' order by effective_at desc limit 1;

  insert into public.courses (name, category) values ('TEST45강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 80000, null, false,
    now() + interval '1 day', now() + interval '31 days', array['SOFTWARE_LICENSE_USE'], '[]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test45@example.com', 'STUDENT')
    returning id into v_user_id;

  v_order_id := public.create_order(v_user_id, v_offering_id, null, array[v_privacy_terms_id, v_license_terms_id]);

  select order_id into v_event_order_id
    from public.order_events where order_id = v_order_id and event_type = 'APPLIED';
  select count(*) into v_agreement_count
    from public.terms_agreements
    where user_id = v_user_id and order_id = v_order_id
      and terms_id in (v_privacy_terms_id, v_license_terms_id);

  if v_event_order_id = v_order_id and v_agreement_count = 2 then
    raise notice 'TEST45 PASS: 신청 이벤트와 신청 시 약관 동의 둘 다 order_id로 신청서를 정확히 가리킴';
  else
    raise notice 'TEST45 FAIL: event_order_id=%, expected=%, agreement_count=%',
      v_event_order_id, v_order_id, v_agreement_count;
  end if;
end $$;

do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_admin_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_event_order_id uuid;
begin
  select id into v_admin_id from public.users where role = 'ADMIN' limit 1;

  insert into public.courses (name, category) values ('TEST46강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 50000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test46@example.com', 'STUDENT')
    returning id into v_user_id;

  v_order_id := public.create_order(v_user_id, v_offering_id, null, null);
  perform public.transition_order(v_order_id, v_admin_id, 'ADMIN', 'APPROVED', 'APPROVED');

  select order_id into v_event_order_id
    from public.order_events where order_id = v_order_id and event_type = 'APPROVED';

  if v_event_order_id = v_order_id then
    raise notice 'TEST46 PASS: 관리자 승인 이벤트가 order_id로 신청서를 정확히 가리킴';
  else
    raise notice 'TEST46 FAIL: event_order_id=%, expected=%', v_event_order_id, v_order_id;
  end if;
end $$;

do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_event_order_id uuid;
begin
  insert into public.courses (name, category) values ('TEST47강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 50000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test47@example.com', 'STUDENT')
    returning id into v_user_id;

  v_order_id := public.create_order(v_user_id, v_offering_id, null, null);
  perform public.cancel_own_order(v_order_id, v_user_id);

  select order_id into v_event_order_id
    from public.order_events where order_id = v_order_id and event_type = 'CANCELLED' and actor = 'STUDENT';

  if v_event_order_id = v_order_id then
    raise notice 'TEST47 PASS: 학생 본인 취소 이벤트가 order_id로 신청서를 정확히 가리킴';
  else
    raise notice 'TEST47 FAIL: event_order_id=%, expected=%', v_event_order_id, v_order_id;
  end if;
end $$;

-- 2026-09-23 2단계(D3, 결제 이력 단일화)로 이 테스트의 전제가 바뀌었다. 예전에는
-- record_payment_event()가 결제 성공/환불 때 payment_events(원장)와 order_events
-- (PAID/REFUNDED 미러) 둘 다에 기록했다. 이제는 payment_events에만 남긴다 —
-- order_events는 신청서의 업무 이력(신청/승인/반려/취소)만 담는다.
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_mirror_count integer;
  v_payment_event_count integer;
begin
  insert into public.courses (name, category) values ('TEST48강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test48@example.com', 'STUDENT')
    returning id into v_user_id;

  v_order_id := public.create_order(v_user_id, v_offering_id, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_order_id;

  perform public.record_payment_event('MOCK', 'evt-test48-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  perform public.record_payment_event('MOCK', 'evt-test48-refund', 'REFUNDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();

  select count(*) into v_mirror_count
    from public.order_events where order_id = v_order_id and event_type in ('PAID', 'REFUNDED');
  select count(*) into v_payment_event_count
    from public.payment_events where order_id = v_order_id and event_type in ('PAYMENT_SUCCEEDED', 'REFUNDED');

  if v_mirror_count = 0 and v_payment_event_count = 2 then
    raise notice 'TEST48 PASS: 결제성공/환불이 payment_events에만 남고 order_events 미러는 더 만들어지지 않음';
  else
    raise notice 'TEST48 FAIL: mirror_count=%(기대 0), payment_event_count=%(기대 2)',
      v_mirror_count, v_payment_event_count;
  end if;
end $$;

-- =========================================================
-- TEST 49~50: DB 구조 재정립 5단계(2026-09-23) — 물품 추가.
-- TEST49: 물품 주문(구매 → 승인 → 결제)까지 DB 레벨에서 정상 처리되고, 결제성공 시
-- ORDER_PAID 아웃박스 메시지(상품 grants 스냅샷 포함)가 쌓이는지 확인한다. 실제 entitlements 지급은
-- DB 함수가 아니라 lib/outbox/drain.ts(앱 레이어)의 책임이라(TEST12·39 등과 같은 경계),
-- 여기서는 TEST12와 같은 패턴으로 아웃박스 메시지 적재까지만 SQL로 검증한다 — 지급 자체는
-- e2e(product 화면이 생기면 추가)나 lib/outbox 통합테스트가 맡는다.
-- =========================================================
do $$
declare
  v_product_id uuid;
  v_admin_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_paid boolean;
  v_grant_count integer;
begin
  select id into v_admin_id from public.users where role = 'ADMIN' limit 1;

  insert into public.products (name, price, status, grants, required_terms_types)
    values ('TEST49상품', 30000, 'OPEN', '[{"type":"SOURCE_DOWNLOAD"}]'::jsonb, '{}'::text[])
    returning id into v_product_id;
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test49@example.com', 'STUDENT')
    returning id into v_user_id;

  v_order_id := public.create_order(v_user_id, null, v_product_id, null);
  perform public.transition_order(v_order_id, v_admin_id, 'ADMIN', 'APPROVED', 'APPROVED');

  select public.record_payment_event('MOCK', 'evt-test49-paid', 'PAYMENT_SUCCEEDED', 30000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb) into v_paid;
  perform pg_temp.deliver_payment_facts();

  select count(*) into v_grant_count from public.outbox_messages
    where topic = 'ORDER_PAID' and payload->>'order_id' = v_order_id::text
    and payload->'grants' = '[{"type":"SOURCE_DOWNLOAD"}]'::jsonb;

  if v_paid and v_grant_count = 1 then
    raise notice 'TEST49 PASS: 물품 주문(구매→승인→결제)이 좌석 로직 없이 정상 처리되고 ORDER_PAID가 grants 스냅샷과 함께 1건 적재됨';
  else
    raise notice 'TEST49 FAIL: paid=%, grant_count=%(기대 1)', v_paid, v_grant_count;
  end if;
end $$;

-- =========================================================
-- TEST 50: orders_item_exactly_one CHECK — 강의·상품 둘 다 null이거나 둘 다 채워진 주문은
-- 거부된다(안티패턴인 다형 참조 대신 둔 CHECK).
-- =========================================================
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_product_id uuid;
  v_user_id uuid;
  v_both_null_rejected boolean := false;
  v_both_set_rejected boolean := false;
begin
  insert into public.courses (name, category) values ('TEST50강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 50000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.products (name, price, status) values ('TEST50상품', 10000, 'OPEN') returning id into v_product_id;
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test50@example.com', 'STUDENT')
    returning id into v_user_id;

  begin
    insert into public.orders (user_id, course_offering_id, product_id, list_price, final_amount)
    values (v_user_id, null, null, 10000, 10000);
  exception when check_violation then
    v_both_null_rejected := true;
  end;

  begin
    insert into public.orders (user_id, course_offering_id, product_id, list_price, final_amount)
    values (v_user_id, v_offering_id, v_product_id, 10000, 10000);
  exception when check_violation then
    v_both_set_rejected := true;
  end;

  if v_both_null_rejected and v_both_set_rejected then
    raise notice 'TEST50 PASS: orders_item_exactly_one CHECK이 둘 다 null·둘 다 채워진 주문을 모두 거부함';
  else
    raise notice 'TEST50 FAIL: both_null_rejected=%, both_set_rejected=%', v_both_null_rejected, v_both_set_rejected;
  end if;
end $$;

-- =========================================================
-- TEST 51~54: — 결제↔주문 분리.
-- =========================================================

-- TEST 51: record_payment_event()는 orders를 건드리지 않고 결제 사실만 남긴다(배달 전 상태를 본다).
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_payment_status text;
  v_fact_count integer;
  v_order_paid_count integer;
begin
  insert into public.courses (name, category) values ('TEST51강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test51@example.com', 'STUDENT')
    returning id into v_user_id;
  insert into public.orders (user_id, course_offering_id, status, approved_at, list_price, final_amount)
  values (v_user_id, v_offering_id, 'APPROVED', now(), 100000, 100000)
  returning id into v_order_id;

  perform public.record_payment_event('MOCK', 'evt-test51-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);

  select payment_status into v_payment_status from public.orders where id = v_order_id;
  select count(*) into v_fact_count from public.outbox_messages
    where topic = 'PAYMENT_SUCCEEDED' and payload->>'order_id' = v_order_id::text and processed_at is null;
  select count(*) into v_order_paid_count from public.outbox_messages
    where topic = 'ORDER_PAID' and payload->>'order_id' = v_order_id::text;

  if v_payment_status = 'UNPAID' and v_fact_count = 1 and v_order_paid_count = 0 then
    raise notice 'TEST51 PASS: 결제 함수는 원장+PAYMENT_SUCCEEDED 사실만 남기고 주문은 그대로(UNPAID) — 반영은 주문 핸들러 몫';
  else
    raise notice 'TEST51 FAIL: payment_status=%, fact=%, order_paid=%', v_payment_status, v_fact_count, v_order_paid_count;
  end if;

  perform pg_temp.deliver_payment_facts();
end $$;

-- TEST 52: 주문 핸들러는 같은 결제 이벤트를 두 번 받아도(러너의 재배달) 한 번만 반영한다.
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_pe_id uuid;
  v_payment_status text;
  v_order_paid_count integer;
  v_dlq_count integer;
begin
  insert into public.courses (name, category) values ('TEST52강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test52@example.com', 'STUDENT')
    returning id into v_user_id;
  insert into public.orders (user_id, course_offering_id, status, approved_at, list_price, final_amount)
  values (v_user_id, v_offering_id, 'APPROVED', now(), 100000, 100000)
  returning id into v_order_id;

  perform public.record_payment_event('MOCK', 'evt-test52-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  select id into v_pe_id from public.payment_events where provider = 'MOCK' and provider_event_id = 'evt-test52-paid';

  perform pg_temp.redeliver_payment_fact('PAYMENT_SUCCEEDED', v_pe_id);
  perform pg_temp.redeliver_payment_fact('PAYMENT_SUCCEEDED', v_pe_id);

  select payment_status into v_payment_status from public.orders where id = v_order_id;
  select count(*) into v_order_paid_count from public.outbox_messages
    where topic = 'ORDER_PAID' and payload->>'order_id' = v_order_id::text;
  select count(*) into v_dlq_count from public.dead_letters
    where payload->>'order_id' = v_order_id::text;

  if v_payment_status = 'PAID' and v_order_paid_count = 1 and v_dlq_count = 0 then
    raise notice 'TEST52 PASS: 같은 결제 사실 재배달 — PAID 1회 반영, ORDER_PAID 1건, 이중결제 오탐 DLQ 없음';
  else
    raise notice 'TEST52 FAIL: payment_status=%, order_paid=%, dlq=%', v_payment_status, v_order_paid_count, v_dlq_count;
  end if;

  update public.outbox_messages set processed_at = clock_timestamp()
    where processed_at is null and topic = 'PAYMENT_SUCCEEDED' and payload->>'order_id' = v_order_id::text;
end $$;

-- TEST 53: 환불 핸들러 — 취소 이력(SYSTEM)이 1건 남고, 재배달돼도 좌석은 한 번만 돌아온다.
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_refund_pe_id uuid;
  v_seats_after_apply integer;
  v_seats_after_refund integer;
  v_status text;
  v_payment_status text;
  v_cancel_events integer;
  v_refunded_facts integer;
  v_dlq_count integer;
begin
  insert into public.courses (name, category) values ('TEST53강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test53@example.com', 'STUDENT')
    returning id into v_user_id;

  v_order_id := public.create_order(v_user_id, v_offering_id, null, null);
  select remaining_seats into v_seats_after_apply from public.course_offerings where id = v_offering_id;
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_order_id;

  perform public.record_payment_event('MOCK', 'evt-test53-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  perform public.record_payment_event('MOCK', 'evt-test53-refund', 'REFUNDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();

  -- 러너의 재배달을 흉내 낸다
  select id into v_refund_pe_id from public.payment_events where provider = 'MOCK' and provider_event_id = 'evt-test53-refund';
  perform pg_temp.redeliver_payment_fact('PAYMENT_REFUNDED', v_refund_pe_id);

  select status, payment_status into v_status, v_payment_status from public.orders where id = v_order_id;
  select remaining_seats into v_seats_after_refund from public.course_offerings where id = v_offering_id;
  select count(*) into v_cancel_events from public.order_events
    where order_id = v_order_id and event_type = 'CANCELLED' and actor = 'SYSTEM';
  select count(*) into v_refunded_facts from public.outbox_messages
    where topic = 'ORDER_REFUNDED' and payload->>'order_id' = v_order_id::text;
  select count(*) into v_dlq_count from public.dead_letters
    where payload->>'order_id' = v_order_id::text;

  if v_status = 'CANCELLED' and v_payment_status = 'REFUNDED'
     and v_seats_after_apply = 9 and v_seats_after_refund = 10
     and v_cancel_events = 1 and v_refunded_facts = 1 and v_dlq_count = 0 then
    raise notice 'TEST53 PASS: 환불 반영 — 취소 이력(SYSTEM) 1건, 좌석 1회 반환(9->10), ORDER_REFUNDED 1건, 재배달에도 중복 없음';
  else
    raise notice 'TEST53 FAIL: status=%, payment=%, seats_apply=%, seats_refund=%, cancel_events=%, refunded_facts=%, dlq=%',
      v_status, v_payment_status, v_seats_after_apply, v_seats_after_refund, v_cancel_events, v_refunded_facts, v_dlq_count;
  end if;
end $$;

-- TEST 54: 옛 명령형 토픽은 새로 적재할 수 없다(이미 처리된 과거 행만 허용).
do $$
begin
  begin
    insert into public.outbox_messages (topic, payload)
    values ('GRANT_ENTITLEMENTS', '{}'::jsonb);
    raise notice 'TEST54 FAIL: 옛 명령형 토픽이 미처리 상태로 적재됨';
  exception when check_violation then
    raise notice 'TEST54 PASS: 옛 명령형 토픽(GRANT_ENTITLEMENTS) 신규 적재는 CHECK로 거부됨';
  end;
end $$;

-- =========================================================
-- TEST 55~61: — 테이블 정규화.
-- =========================================================

-- TEST 55: 약관 동의 기록은 앱 역할(service_role)로 UPDATE할 수 없다(2-2). TEST30과 같은 방식 —
-- set local role로 앱 권한을 흉내 내고, 블록 뒤 반드시 reset role. 대상 행은 TEST7이 만든 가입
-- 동의 2건(auth 계정 ...2aa의 회원)이다 — 행이 있어야 행 트리거가 발동한다.
set local role service_role;

do $$
begin
  begin
    update public.terms_agreements set terms_id = terms_id
    where user_id = (select id from public.users where auth_user_id = '00000000-0000-0000-0000-0000000002aa');
    raise notice 'TEST55 FAIL: terms_agreements 행이 service_role로 UPDATE됨';
  exception when restrict_violation then
    raise notice 'TEST55 PASS: terms_agreements UPDATE가 트리거로 차단됨(service_role)';
  end;
end $$;

reset role;

-- TEST 56: 사유 없이 소프트 삭제하면 거부된다(2-3, 패턴 A).
do $$
declare
  v_course_id uuid;
begin
  insert into public.courses (name, category) values ('TEST56강의', 'TEST') returning id into v_course_id;
  begin
    update public.courses set deleted_at = now() where id = v_course_id;
    raise notice 'TEST56 FAIL: 사유 없는 삭제가 저장됨';
  exception when check_violation then
    raise notice 'TEST56 PASS: 사유·행위자 없는 소프트 삭제는 CHECK로 거부됨';
  end;
end $$;

-- TEST 57: 단계 — 개설강의 상태 전이는 방향과 무관하게 매번 사유·행위자·새 변경
-- 시각이 있어야 한다(전이 트리거). 사유 "문구"가 직전과 같은 것은 허용한다(2026-09-25).
-- DB 함수(set_course_offering_status)를 거치지 않고 직접 UPDATE로 우회하는
-- 경로도 트리거가 막는지까지 확인한다.
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_admin_id uuid;
  v_closed_without_reason_blocked boolean := false;
  v_status_only_bypass_blocked boolean := false;
  v_null_reason_reopen_blocked boolean := false;
  v_reopened_same_reason boolean := false;
begin
  select id into v_admin_id from public.users where role = 'ADMIN' limit 1;
  insert into public.courses (name, category) values ('TEST57강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 10000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[]'::jsonb,
    null, null, null
  , now() - interval '2 days');

  begin
    update public.course_offerings set status = 'CLOSED' where id = v_offering_id;
  exception when others then
    v_closed_without_reason_blocked := true;
  end;

  perform public.set_course_offering_status(v_offering_id, 'CLOSED', 'TEST57 마감', v_admin_id, 'ADMIN');

  begin
    update public.course_offerings set status = 'OPEN' where id = v_offering_id;
  exception when others then
    v_status_only_bypass_blocked := true;
  end;

  begin
    update public.course_offerings
    set status = 'OPEN', status_reason = null, status_changed_by = v_admin_id, status_changed_at = clock_timestamp()
    where id = v_offering_id;
  exception when others then
    v_null_reason_reopen_blocked := true;
  end;

  perform public.set_course_offering_status(v_offering_id, 'OPEN', 'TEST57 마감', v_admin_id, 'ADMIN');
  select (status = 'OPEN') into v_reopened_same_reason from public.course_offerings where id = v_offering_id;

  if v_closed_without_reason_blocked
     and v_status_only_bypass_blocked
     and v_null_reason_reopen_blocked
     and v_reopened_same_reason then
    raise notice 'TEST57 PASS: 사유 없는 마감 거부, 상태만 바꾸는 우회 거부, 사유 없는 재개 거부, 같은 사유 문구 재개는 허용';
  else
    raise notice 'TEST57 FAIL: closed_without_reason_blocked=%, status_only_blocked=%, null_reason_blocked=%, reopened_same_reason=%',
      v_closed_without_reason_blocked, v_status_only_bypass_blocked, v_null_reason_reopen_blocked, v_reopened_same_reason;
  end if;
end $$;

-- TEST 58: 매니저 박탈 후 재지정 — 박탈 이력 행이 남고 새 행이 생긴다(2-4). 사유 없는 박탈은 거부.
do $$
declare
  v_admin_id uuid;
  v_user_id uuid;
  v_rows integer;
  v_revoked_rows integer;
  v_active_rows integer;
  v_no_reason_rejected boolean := false;
begin
  select id into v_admin_id from public.users where role = 'ADMIN' limit 1;
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test58@example.com', 'STUDENT')
    returning id into v_user_id;

  perform public.set_manager(v_user_id, v_admin_id, true, false, false);

  begin
    perform public.revoke_manager(v_user_id, '  ', v_admin_id);
  exception when others then
    v_no_reason_rejected := true;
  end;

  perform public.revoke_manager(v_user_id, 'TEST58 박탈', v_admin_id);
  perform public.set_manager(v_user_id, v_admin_id, false, true, false);

  select count(*) into v_rows from public.manager_permissions where user_id = v_user_id;
  select count(*) into v_revoked_rows from public.manager_permissions
    where user_id = v_user_id and revoked_at is not null and revoked_reason = 'TEST58 박탈' and revoked_by = v_admin_id;
  select count(*) into v_active_rows from public.manager_permissions
    where user_id = v_user_id and revoked_at is null and can_approve_orders;

  if v_no_reason_rejected and v_rows = 2 and v_revoked_rows = 1 and v_active_rows = 1 then
    raise notice 'TEST58 PASS: 박탈 이력(사유·행위자) 보존 + 재지정은 새 행, 사유 없는 박탈 거부';
  else
    raise notice 'TEST58 FAIL: no_reason_rejected=%, rows=%, revoked=%, active=%',
      v_no_reason_rejected, v_rows, v_revoked_rows, v_active_rows;
  end if;
end $$;

-- TEST 59: 학생 제한 — 해제는 기록으로 남고, 유효한 제한은 사람·축당 하나(2-6).
-- 명령 레일 CR-2(2026-10-07)부터 제한은 통제 스위치(rail_switches)의 유저 대상 행이다(APPLY = COMMAND ORDER_APPLY).
-- 옛 student_restrictions는 쓰기를 멈췄다 — 그 사실도 함께 확인한다.
do $$
declare
  v_admin_id uuid;
  v_user_id uuid;
  v_dup_rejected boolean := false;
  v_old_rejected boolean := false;
  v_rows integer;
  v_active integer;
begin
  select id into v_admin_id from public.users where role = 'ADMIN' limit 1;
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test59@example.com', 'STUDENT')
    returning id into v_user_id;

  insert into public.rail_switches (level, target, user_id, reason, set_by)
    values ('COMMAND', 'ORDER_APPLY', v_user_id, 'TEST59 1차', v_admin_id);
  begin
    insert into public.rail_switches (level, target, user_id, reason, set_by)
      values ('COMMAND', 'ORDER_APPLY', v_user_id, 'TEST59 중복', v_admin_id);
  exception when unique_violation then
    v_dup_rejected := true;
  end;

  update public.rail_switches
  set cleared_at = now(), cleared_reason = 'TEST59 해제', cleared_by = v_admin_id
  where user_id = v_user_id and level = 'COMMAND' and target = 'ORDER_APPLY' and cleared_at is null;

  insert into public.rail_switches (level, target, user_id, reason, set_by)
    values ('COMMAND', 'ORDER_APPLY', v_user_id, 'TEST59 2차', v_admin_id);

  select count(*) into v_rows from public.rail_switches where user_id = v_user_id and target = 'ORDER_APPLY';
  select count(*) into v_active from public.rail_switches
    where user_id = v_user_id and target = 'ORDER_APPLY' and cleared_at is null;

  begin
    insert into public.student_restrictions (user_id, scope, reason, restricted_by)
      values (v_user_id, 'PAYMENT', 'TEST59 옛 테이블', v_admin_id);
  exception when restrict_violation then
    v_old_rejected := true;
  end;

  if v_dup_rejected and v_rows = 2 and v_active = 1 and v_old_rejected then
    raise notice 'TEST59 PASS: 해제 이력 보존, 재제한은 새 행, 유효 제한 중복은 거부, 옛 student_restrictions 쓰기 거부';
  else
    raise notice 'TEST59 FAIL: dup_rejected=%, rows=%, active=%, old_rejected=%', v_dup_rejected, v_rows, v_active, v_old_rejected;
  end if;
end $$;

-- TEST 60: 개설강의 삭제는 회차를 지우지 않고 비활성으로 남기며, 같은 시간대를 다시 쓸 수 있다(2-8).
do $$
declare
  v_admin_id uuid;
  v_course_id uuid;
  v_first uuid;
  v_second uuid;
  v_kept integer;
  v_second_sessions integer;
begin
  select id into v_admin_id from public.users where role = 'ADMIN' limit 1;
  insert into public.courses (name, category) values ('TEST60강의', 'TEST') returning id into v_course_id;
  v_first := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 10000, null, false,
    '2027-03-01T00:00:00Z', '2027-05-31T00:00:00Z', '{}'::text[], '[]'::jsonb,
    '09:00'::time, '10:00'::time, array[6]::smallint[]
  , now() - interval '2 days');

  perform public.delete_course_offering(v_first, 'TEST60 삭제', v_admin_id, 'ADMIN');

  v_second := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 10000, null, false,
    '2027-03-01T00:00:00Z', '2027-05-31T00:00:00Z', '{}'::text[], '[]'::jsonb,
    '09:00'::time, '10:00'::time, array[6]::smallint[]
  , now() - interval '2 days');

  select count(*) into v_kept from public.course_sessions
    where course_offering_id = v_first and deactivated_at is not null and deactivated_reason = 'TEST60 삭제';
  select count(*) into v_second_sessions from public.course_sessions
    where course_offering_id = v_second and deactivated_at is null;

  if v_kept > 0 and v_kept = v_second_sessions
     and (select deleted_reason from public.course_offerings where id = v_first) = 'TEST60 삭제' then
    raise notice 'TEST60 PASS: 삭제된 개설강의의 회차는 비활성으로 보존, 같은 시간대에 새 개설강의 등록 가능';
  else
    raise notice 'TEST60 FAIL: kept=%, second_sessions=%', v_kept, v_second_sessions;
  end if;
end $$;

-- TEST 61: 게이트 봉쇄는 사유·행위자 없이 안 된다(2-9).
-- 명령 레일 CR-2부터 봉쇄는 통제 스위치(rail_switches) 행이다 — 사유 없는 행·행위자 없는 행은 거부된다.
-- 옛 system_gates의 PAYMENT/SIGNUP/LOGIN은 쓰기를 멈췄다(AUDIT만 계속 쓴다).
do $$
declare
  v_admin_id uuid;
  v_no_reason boolean := false;
  v_no_actor boolean := false;
  v_old_rejected boolean := false;
begin
  select id into v_admin_id from public.users where role = 'ADMIN' limit 1;
  begin
    insert into public.rail_switches (level, target, reason, set_by) values ('MODULE', 'PAYMENT', '  ', v_admin_id);
  exception when check_violation then
    v_no_reason := true;
  end;
  begin
    insert into public.rail_switches (level, target, reason, set_by) values ('MODULE', 'PAYMENT', 'TEST61', null);
  exception when not_null_violation then
    v_no_actor := true;
  end;
  begin
    update public.system_gates set status = 'CLOSED', reason = 'TEST61', changed_by = v_admin_id where code = 'PAYMENT';
  exception when restrict_violation then
    v_old_rejected := true;
  end;
  if v_no_reason and v_no_actor and v_old_rejected then
    raise notice 'TEST61 PASS: 사유·행위자 없는 봉쇄는 거부, 옛 system_gates PAYMENT 쓰기도 거부';
  else
    raise notice 'TEST61 FAIL: no_reason=%, no_actor=%, old_rejected=%', v_no_reason, v_no_actor, v_old_rejected;
  end if;
end $$;

-- =========================================================
-- TEST 62~67: — 회원 모듈(2026-09-25 재설계).
-- =========================================================

-- TEST 62: complete_signup()은 이메일 신원이 없는 인증 계정(예: 디스코드로만 만들어진 계정)을 거부한다.
do $$
declare
  v_auth_id uuid := '00000000-0000-0000-0000-0000000062aa';
begin
  insert into auth.users (id, email) values (v_auth_id, 'test62@example.com');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data)
    values (gen_random_uuid(), v_auth_id, 'discord-62', 'discord', jsonb_build_object('sub', 'discord-62'));
  begin
    perform public.complete_signup(v_auth_id, 'test62@example.com',
      (select id from public.terms where type = 'SERVICE_USE' order by effective_at desc limit 1),
      (select id from public.terms where type = 'PRIVACY_USE' order by effective_at desc limit 1));
    raise notice 'TEST62 FAIL: 이메일 신원 없는 계정이 가입됨';
  exception when insufficient_privilege then
    if not exists (select 1 from public.users where auth_user_id = v_auth_id) then
      raise notice 'TEST62 PASS: 이메일 신원 없는 인증 계정은 회원이 될 수 없음';
    else
      raise notice 'TEST62 FAIL: 거부됐는데 회원 행이 남음';
    end if;
  end;
end $$;

-- TEST 63: 탈퇴는 표시·이벤트·USER_WITHDRAWN 사실이 한 번에, 복구는 같은 id로 되돌리고 이벤트를 남긴다.
do $$
declare
  v_user_id uuid;
  v_withdraw_events integer;
  v_facts integer;
  v_reactivate_events integer;
  v_withdrawn_after timestamptz;
begin
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test63@example.com', 'STUDENT')
    returning id into v_user_id;

  perform public.withdraw_user(v_user_id);
  select count(*) into v_withdraw_events from public.account_events where user_id = v_user_id and event_type = 'WITHDRAWN';
  select count(*) into v_facts from public.outbox_messages where topic = 'USER_WITHDRAWN' and payload->>'user_id' = v_user_id::text;

  perform public.reactivate_user(v_user_id,
    (select id from public.terms where type = 'SERVICE_USE' order by effective_at desc limit 1),
    (select id from public.terms where type = 'PRIVACY_USE' order by effective_at desc limit 1));
  select count(*) into v_reactivate_events from public.account_events where user_id = v_user_id and event_type = 'REACTIVATED';
  select withdrawn_at into v_withdrawn_after from public.users where id = v_user_id;

  if v_withdraw_events = 1 and v_facts = 1 and v_reactivate_events = 1 and v_withdrawn_after is null then
    raise notice 'TEST63 PASS: 탈퇴(이벤트+사실 원자적) → 같은 id로 복구(이벤트)';
  else
    raise notice 'TEST63 FAIL: withdraw_events=%, facts=%, reactivate_events=%, withdrawn_after=%',
      v_withdraw_events, v_facts, v_reactivate_events, v_withdrawn_after;
  end if;
end $$;

-- TEST 64: 디스코드 연결 — 한 번 연결되면 다른 디스코드로 바꿀 수 없고, 다른 회원의 디스코드는 연결 불가.
-- DISCORD_LINKED 아웃박스는 제거됨(link_discord_identity가 ENTITLEMENT 모듈에서
-- discord_accounts를 직접 씀). 연결 사실 확인은 discord_accounts 행으로 한다.
do $$
declare
  v_a uuid;
  v_b uuid;
  v_change_rejected boolean := false;
  v_taken_rejected boolean := false;
  v_link_events integer;
  v_discord_rows integer;
begin
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test64a@example.com', 'STUDENT') returning id into v_a;
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test64b@example.com', 'STUDENT') returning id into v_b;

  perform public.link_discord_identity(v_a, 'discord-64a');
  perform public.link_discord_identity(v_a, 'discord-64a'); -- 같은 값 재연결은 멱등
  begin
    perform public.link_discord_identity(v_a, 'discord-64x');
  exception when others then
    v_change_rejected := true;
  end;
  begin
    perform public.link_discord_identity(v_b, 'discord-64a');
  exception when unique_violation then
    v_taken_rejected := true;
  end;
  select count(*) into v_link_events from public.account_events where user_id = v_a and event_type = 'IDENTITY_LINKED';
  select count(*) into v_discord_rows from public.discord_accounts
    where user_id = v_a and discord_id = 'discord-64a';

  if v_change_rejected and v_taken_rejected and v_link_events = 1 and v_discord_rows = 1 then
    raise notice 'TEST64 PASS: 연결 1회 기록, 교체 거부, 다른 회원의 디스코드 연결 거부, discord_accounts 1건';
  else
    raise notice 'TEST64 FAIL: change_rejected=%, taken_rejected=%, link_events=%, discord_rows=%',
      v_change_rejected, v_taken_rejected, v_link_events, v_discord_rows;
  end if;
end $$;

-- TEST 65: 회원 이벤트는 앱 역할(service_role)로 UPDATE할 수 없다(불변성 트리거).
set local role service_role;

do $$
begin
  begin
    update public.account_events set detail = detail where event_type = 'WITHDRAWN';
    raise notice 'TEST65 FAIL: account_events 행이 service_role로 UPDATE됨';
  exception when restrict_violation then
    raise notice 'TEST65 PASS: account_events UPDATE가 트리거로 차단됨(service_role)';
  end;
end $$;

reset role;

-- TEST 66: users.email은 중복 가입될 수 없다.
do $$
begin
  begin
    insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test66@example.com', 'STUDENT');
    insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test66@example.com', 'STUDENT');
    raise notice 'TEST66 FAIL: 같은 이메일로 두 회원이 만들어짐';
  exception when unique_violation then
    raise notice 'TEST66 PASS: 같은 이메일 중복 가입이 유니크 제약으로 거부됨';
  end;
end $$;

-- TEST 67: 매니저 자격 검증 함수는 set_manager와 같은 기준으로 ADMIN·탈퇴자를 거부한다.
-- 디스코드 연결 여부는 검사하지 않는다(디스코드 미연결 상태 그대로 시도).
do $$
declare
  v_ok boolean := false;
  v_no_discord uuid;
begin
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test67@example.com', 'STUDENT')  -- discord_id 없음
    returning id into v_no_discord;

  begin
    perform public.assert_manager_eligible('00000000-0000-0000-0000-000000000501'); -- ADMIN(TEST22~24 준비 데이터)
    raise notice 'TEST67a FAIL: ADMIN 대상이 통과함';
  exception when others then
    raise notice 'TEST67a PASS: ADMIN 대상 거부됨 — %', sqlerrm;
  end;

  begin
    perform public.assert_manager_eligible('00000000-0000-0000-0000-000000000502'); -- 탈퇴자(TEST22~24 준비 데이터)
    raise notice 'TEST67b FAIL: 탈퇴자 대상이 통과함';
  exception when others then
    raise notice 'TEST67b PASS: 탈퇴자 대상 거부됨 — %', sqlerrm;
  end;

  begin
    perform public.assert_manager_eligible(v_no_discord); -- 정상 STUDENT, 디스코드 미연결
    v_ok := true;
  exception when others then
    v_ok := false;
  end;
  if v_ok then
    raise notice 'TEST67c PASS: 디스코드 미연결 STUDENT도 자격 검증 통과(디스코드는 매니저 자격과 무관)';
  else
    raise notice 'TEST67c FAIL: 디스코드 미연결이라는 이유로 거부됨(있으면 안 되는 검사)';
  end if;
end $$;

-- TEST 68: 부분 환불 = 수강 포기(옛 「유지」를 대체) — 주문 CANCELLED, 결제 PARTIALLY_REFUNDED, 좌석 반환, ORDER_REFUNDED 1건.
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_pe_id uuid;
  v_status text;
  v_payment_status text;
  v_refunded_amount integer;
  v_seats integer;
  v_refunded_facts integer;
begin
  insert into public.courses (name, category) values ('TEST68강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test68@example.com', 'STUDENT')
    returning id into v_user_id;

  v_order_id := public.create_order(v_user_id, v_offering_id, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_order_id;

  perform public.record_payment_event('MOCK', 'evt-test68-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();

  -- 3만원만 부분 환불
  perform public.record_payment_event('MOCK', 'evt-test68-refund1', 'REFUNDED', 30000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();

  select status, payment_status, refunded_amount into v_status, v_payment_status, v_refunded_amount
    from public.orders where id = v_order_id;
  select remaining_seats into v_seats from public.course_offerings where id = v_offering_id;
  select count(*) into v_refunded_facts from public.outbox_messages
    where topic = 'ORDER_REFUNDED' and payload->>'order_id' = v_order_id::text;

  if v_status = 'CANCELLED' and v_payment_status = 'PARTIALLY_REFUNDED' and v_refunded_amount = 30000
     and v_seats = 10 and v_refunded_facts = 1 then
    raise notice 'TEST68 PASS: 부분 환불(3만원) — 주문 종료(CANCELLED), PARTIALLY_REFUNDED, 좌석 반환, ORDER_REFUNDED 1건';
  else
    raise notice 'TEST68 FAIL: status=%, payment=%, refunded_amount=%, seats=%, refunded_facts=%',
      v_status, v_payment_status, v_refunded_amount, v_seats, v_refunded_facts;
  end if;

  -- TEST 69: 끝난 주문에 남은 7만원을 마저 환불하면 DLQ 없이 누적되어 전액 환불(REFUNDED)로 마무리되고, 좌석·ORDER_REFUNDED는 다시 만들지 않는다.
  perform public.record_payment_event('MOCK', 'evt-test68-refund2', 'REFUNDED', 70000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();

  select status, payment_status, refunded_amount into v_status, v_payment_status, v_refunded_amount
    from public.orders where id = v_order_id;
  select remaining_seats into v_seats from public.course_offerings where id = v_offering_id;
  select count(*) into v_refunded_facts from public.outbox_messages
    where topic = 'ORDER_REFUNDED' and payload->>'order_id' = v_order_id::text;

  if v_status = 'CANCELLED' and v_payment_status = 'REFUNDED' and v_refunded_amount = 100000
     and v_seats = 10 and v_refunded_facts = 1 then
    raise notice 'TEST69 PASS: 누적 환불이 결제액과 같아지면 REFUNDED로 마무리(좌석·ORDER_REFUNDED 중복 없음)';
  else
    raise notice 'TEST69 FAIL: status=%, payment=%, refunded_amount=%, seats=%, refunded_facts=%',
      v_status, v_payment_status, v_refunded_amount, v_seats, v_refunded_facts;
  end if;

  -- TEST 70: 같은 환불 이벤트가 재배달돼도(러너 재시도 흉내) 다시 반영되지 않는다.
  select id into v_pe_id from public.payment_events where provider = 'MOCK' and provider_event_id = 'evt-test68-refund1';
  perform pg_temp.redeliver_payment_fact('PAYMENT_REFUNDED', v_pe_id);
  select refunded_amount into v_refunded_amount from public.orders where id = v_order_id;
  if v_refunded_amount = 100000 then
    raise notice 'TEST70 PASS: 부분 환불 이벤트 재배달에도 refunded_amount 중복 반영 없음';
  else
    raise notice 'TEST70 FAIL: 재배달 후 refunded_amount=%(기대 100000)', v_refunded_amount;
  end if;
end $$;

-- TEST 71: 환불 누적액이 결제액을 초과하면 반영하지 않고 DLQ에 남긴다.
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_payment_status text;
  v_refunded_amount integer;
  v_dlq_count integer;
begin
  insert into public.courses (name, category) values ('TEST71강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test71@example.com', 'STUDENT')
    returning id into v_user_id;

  v_order_id := public.create_order(v_user_id, v_offering_id, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_order_id;
  perform public.record_payment_event('MOCK', 'evt-test71-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();

  perform public.record_payment_event('MOCK', 'evt-test71-refund', 'REFUNDED', 150000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();

  select payment_status, refunded_amount into v_payment_status, v_refunded_amount from public.orders where id = v_order_id;
  select count(*) into v_dlq_count from public.dead_letters
    where payload->>'handler' = 'on_payment_refunded' and payload->>'order_id' = v_order_id::text;

  if v_payment_status = 'PAID' and v_refunded_amount = 0 and v_dlq_count = 1 then
    raise notice 'TEST71 PASS: 결제액(10만원) 초과 환불(15만원)은 반영되지 않고 DLQ에 남음';
  else
    raise notice 'TEST71 FAIL: payment_status=%, refunded_amount=%, dlq=%', v_payment_status, v_refunded_amount, v_dlq_count;
  end if;
end $$;

-- TEST 72: 통화가 KRW가 아닌 결제 성공 이벤트는 반영되지 않고 DLQ에 남긴다.
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_payment_status text;
  v_dlq_count integer;
begin
  insert into public.courses (name, category) values ('TEST72강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test72@example.com', 'STUDENT')
    returning id into v_user_id;

  v_order_id := public.create_order(v_user_id, v_offering_id, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_order_id;
  perform public.record_payment_event('MOCK', 'evt-test72-paid', 'PAYMENT_SUCCEEDED', 100000, 'USD', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();

  select payment_status into v_payment_status from public.orders where id = v_order_id;
  select count(*) into v_dlq_count from public.dead_letters
    where payload->>'handler' = 'on_payment_succeeded' and payload->>'order_id' = v_order_id::text;

  if v_payment_status = 'UNPAID' and v_dlq_count = 1 then
    raise notice 'TEST72 PASS: 통화가 KRW가 아닌 결제 성공 이벤트는 반영되지 않고 DLQ에 남음';
  else
    raise notice 'TEST72 FAIL: payment_status=%, dlq=%', v_payment_status, v_dlq_count;
  end if;
end $$;

-- TEST 73: claim_outbox_messages()는 미처리 메시지를 골라 next_attempt_at을 임대 시간만큼
-- 미룬다(임대 중에는 다시 고르지 않는다) — 동시 러너의 이중 처리 방지.
do $$
declare
  v_msg_id uuid;
  v_claimed_first integer;
  v_claimed_second integer;
  v_next_attempt timestamptz;
begin
  insert into public.outbox_messages (id, topic, payload)
    values (gen_random_uuid(), 'USER_WITHDRAWN', '{"user_id":"00000000-0000-0000-0000-000000000000"}'::jsonb)
    returning id into v_msg_id;

  -- limit을 크게 잡는다 — 이 스크립트의 앞선 테스트들이 남긴, 아직 처리 완료 표시가 안 된
  -- outbox_messages 행(예: on_payment_succeeded/refunded가 남긴 ORDER_PAID·ORDER_REFUNDED —
  -- 이용권 반응은 TS 전용이라 이 SQL 스크립트에서는 처리 완료 처리를 안 한다)이 함께 select되면,
  -- limit이 작을 때 created_at 오름차순 정렬에서 오래된 그 행들에 밀려 방금 만든 v_msg_id가
  -- 첫 호출에서 안 뽑히는 오탐이 났다. 실제 러너(lib/outbox/drain.ts)의 limit=10은 그대로다 —
  -- 이건 이 테스트만의 조정이다.
  select count(*) into v_claimed_first
    from public.claim_outbox_messages(100000, 300)
    where id = v_msg_id;

  -- 임대 중이므로 곧바로 다시 부르면 이번엔 안 걸린다(next_attempt_at이 미래).
  select count(*) into v_claimed_second
    from public.claim_outbox_messages(100000, 300)
    where id = v_msg_id;

  select next_attempt_at into v_next_attempt from public.outbox_messages where id = v_msg_id;

  if v_claimed_first = 1 and v_claimed_second = 0 and v_next_attempt > now() then
    raise notice 'TEST73 PASS: claim_outbox_messages가 선점한 메시지는 임대 기간 동안 다시 골라지지 않음';
  else
    raise notice 'TEST73 FAIL: 첫 선점=%, 재선점=%, next_attempt_at=%', v_claimed_first, v_claimed_second, v_next_attempt;
  end if;

  update public.outbox_messages set processed_at = clock_timestamp() where id = v_msg_id;
end $$;

-- =========================================================
-- TEST 74~78: — 탈퇴 시 주문 취소·ADMIN 거부·매니저 자동 강등·환불 경쟁.
-- =========================================================

-- TEST 74: ADMIN은 앱에서 탈퇴할 수 없다.
do $$
declare
  v_admin_id uuid;
begin
  select id into v_admin_id from public.users where role = 'ADMIN' limit 1;
  begin
    perform public.withdraw_user(v_admin_id);
    raise notice 'TEST74 FAIL: ADMIN 탈퇴가 통과함';
  exception when others then
    if sqlerrm like '%ADMIN 계정은 앱에서 탈퇴할 수 없습니다%' then
      raise notice 'TEST74 PASS: ADMIN 탈퇴 거부됨';
    else
      raise notice 'TEST74 FAIL: 예상과 다른 예외 — %', sqlerrm;
    end if;
  end;
end $$;

-- TEST 75: 매니저가 탈퇴하면 revoke_manager가 자동 호출돼 role·지정이 닫힌다(§17-4·§17-9).
do $$
declare
  v_admin_id uuid;
  v_manager_id uuid;
  v_role text;
  v_open_perms integer;
begin
  select id into v_admin_id from public.users where role = 'ADMIN' limit 1;
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test75mgr@example.com', 'STUDENT')
    returning id into v_manager_id;

  perform public.set_manager(v_manager_id, v_admin_id, true, true, false);
  perform public.withdraw_user(v_manager_id);

  select role into v_role from public.users where id = v_manager_id;
  select count(*) into v_open_perms from public.manager_permissions
    where user_id = v_manager_id and revoked_at is null;

  if v_role = 'STUDENT' and v_open_perms = 0 then
    raise notice 'TEST75 PASS: 매니저 탈퇴 시 role=STUDENT, manager_permissions 유효 행 0건';
  else
    raise notice 'TEST75 FAIL: role=%, open_perms=%', v_role, v_open_perms;
  end if;
end $$;

-- TEST 76: cancel_orders_for_withdrawn_user — PENDING·APPROVED(미결제·결제완료·부분환불) 전부
-- CANCELLED+좌석 반환, payment_status는 그대다(§17-6). 강의마다 1건씩(동일 개설강의 중복 신청 불가).
do $$
declare
  v_course_id uuid;
  v_offering_pending uuid;
  v_offering_unpaid uuid;
  v_offering_paid uuid;
  v_offering_partial uuid;
  v_user_id uuid;
  v_pending_id uuid;
  v_unpaid_id uuid;
  v_paid_id uuid;
  v_partial_id uuid;
  v_seats_pending integer;
  v_pending_ps text;
  v_paid_ps text;
  v_partial_ps text;
begin
  insert into public.courses (name, category) values ('TEST76강의', 'TEST') returning id into v_course_id;
  v_offering_pending := pg_temp.create_offering_legacy(
    v_course_id, 'PENDING', 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  v_offering_unpaid := pg_temp.create_offering_legacy(
    v_course_id, 'UNPAID', 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  v_offering_paid := pg_temp.create_offering_legacy(
    v_course_id, 'PAID', 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  v_offering_partial := pg_temp.create_offering_legacy(
    v_course_id, 'PARTIAL', 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test76@example.com', 'STUDENT')
    returning id into v_user_id;

  v_pending_id := public.create_order(v_user_id, v_offering_pending, null, null);
  v_unpaid_id := public.create_order(v_user_id, v_offering_unpaid, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_unpaid_id;

  v_paid_id := public.create_order(v_user_id, v_offering_paid, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_paid_id;
  perform public.record_payment_event('MOCK', 'evt-test76-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_paid_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();

  v_partial_id := public.create_order(v_user_id, v_offering_partial, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_partial_id;
  perform public.record_payment_event('MOCK', 'evt-test76-partial-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_partial_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  perform public.record_payment_event('MOCK', 'evt-test76-partial-refund', 'REFUNDED', 30000, 'KRW', v_partial_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();

  perform public.cancel_orders_for_withdrawn_user(v_user_id);

  select payment_status into v_pending_ps from public.orders where id = v_pending_id;
  select payment_status into v_paid_ps from public.orders where id = v_paid_id;
  select payment_status into v_partial_ps from public.orders where id = v_partial_id;
  select remaining_seats into v_seats_pending from public.course_offerings where id = v_offering_pending;

  if (select count(*) from public.orders where id in (v_pending_id, v_unpaid_id, v_paid_id, v_partial_id) and status = 'CANCELLED') = 4
     and v_pending_ps = 'UNPAID' and v_paid_ps = 'PAID' and v_partial_ps = 'PARTIALLY_REFUNDED'
     and v_seats_pending = 10 then
    raise notice 'TEST76 PASS: 탈퇴 주문 취소 — 4건 CANCELLED, payment_status 유지, 좌석 전부 반환';
  else
    raise notice 'TEST76 FAIL: cancelled=%, pending_ps=%, paid_ps=%, partial_ps=%, seats_pending=%',
      (select count(*) from public.orders where id in (v_pending_id, v_unpaid_id, v_paid_id, v_partial_id) and status = 'CANCELLED'),
      v_pending_ps, v_paid_ps, v_partial_ps, v_seats_pending;
  end if;
end $$;

-- TEST 77: 탈퇴로 취소된 주문에 환불이 뒤늦게 오면 DLQ로 빠지고 반영되지 않는다(§17-12).
do $$
declare
  v_course_id uuid;
  v_offering_id uuid;
  v_user_id uuid;
  v_order_id uuid;
  v_payment_status text;
  v_dlq_count integer;
begin
  insert into public.courses (name, category) values ('TEST77강의', 'TEST') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test77@example.com', 'STUDENT')
    returning id into v_user_id;

  v_order_id := public.create_order(v_user_id, v_offering_id, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_order_id;
  perform public.record_payment_event('MOCK', 'evt-test77-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  perform public.cancel_orders_for_withdrawn_user(v_user_id);

  perform public.record_payment_event('MOCK', 'evt-test77-refund', 'REFUNDED', 100000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb);
  -- 실제 경로와 같이 5인자 on_payment_refunded로 배달한다(1인자 오버로드는 20260926093000에서 제거).
  perform pg_temp.deliver_payment_facts();

  select payment_status into v_payment_status from public.orders where id = v_order_id;
  select count(*) into v_dlq_count from public.dead_letters
    where payload->>'handler' = 'on_payment_refunded' and payload->>'order_id' = v_order_id::text;

  if v_payment_status = 'PAID' and v_dlq_count >= 1 then
    raise notice 'TEST77 PASS: 취소된 주문에 환불 이벤트 — payment_status 유지, DLQ 적재';
  else
    raise notice 'TEST77 FAIL: payment_status=%, dlq=%', v_payment_status, v_dlq_count;
  end if;
end $$;

-- TEST 78: REJECTED·CANCELLED 주문은 cancel_orders_for_withdrawn_user가 건드리지 않는다.
do $$
declare
  v_course_id uuid;
  v_offering_rejected uuid;
  v_offering_cancelled uuid;
  v_user_id uuid;
  v_rejected_id uuid;
  v_cancelled_id uuid;
  v_admin_id uuid;
begin
  select id into v_admin_id from public.users where role = 'ADMIN' limit 1;
  insert into public.courses (name, category) values ('TEST78강의', 'TEST') returning id into v_course_id;
  v_offering_rejected := pg_temp.create_offering_legacy(
    v_course_id, 'REJECTED', 10, 10000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  v_offering_cancelled := pg_temp.create_offering_legacy(
    v_course_id, 'CANCELLED', 10, 10000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null
  , now() - interval '2 days');
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test78@example.com', 'STUDENT')
    returning id into v_user_id;

  v_rejected_id := public.create_order(v_user_id, v_offering_rejected, null, null);
  perform public.transition_order(v_rejected_id, v_admin_id, 'ADMIN', 'REJECTED', 'REJECTED', 'TEST78 반려');

  v_cancelled_id := public.create_order(v_user_id, v_offering_cancelled, null, null);
  update public.orders set status = 'CANCELLED', cancelled_at = now() where id = v_cancelled_id;

  perform public.cancel_orders_for_withdrawn_user(v_user_id);

  if (select status from public.orders where id = v_rejected_id) = 'REJECTED'
     and (select status from public.orders where id = v_cancelled_id) = 'CANCELLED' then
    raise notice 'TEST78 PASS: REJECTED·CANCELLED 주문은 탈퇴 주문 취소 대상이 아님';
  else
    raise notice 'TEST78 FAIL: rejected=%, cancelled=%',
      (select status from public.orders where id = v_rejected_id),
      (select status from public.orders where id = v_cancelled_id);
  end if;
end $$;

-- TEST 79: 탈퇴한 ADMIN은 is_admin이 false(I단계).
-- withdraw_user()는 ADMIN을 거부하므로 withdrawn_at만 직접 세팅한다(테스트 전용).
-- 픽스처 ADMIN은 TEST22 준비 구간(501/5ab) — auth_user_id가 있는 계정만 쓴다.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000005ab","role":"authenticated"}',
  true
);

do $$
declare
  v_is_admin_active boolean;
begin
  select public.is_admin() into v_is_admin_active;
  if not v_is_admin_active then
    raise notice 'TEST79 FAIL: 활성 ADMIN인데 is_admin=false';
    return;
  end if;
  raise notice 'TEST79a PASS: 활성 ADMIN is_admin=true';
end $$;

reset role;

-- withdrawn_at은 RLS 때문에 authenticated로는 못 바꾼다 — DB 직접 검증용(탈퇴 경로는 withdraw_user).
update public.users set withdrawn_at = now()
where id = '00000000-0000-0000-0000-000000000501' and withdrawn_at is null;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000005ab","role":"authenticated"}',
  true
);

do $$
declare
  v_is_admin_withdrawn boolean;
begin
  select public.is_admin() into v_is_admin_withdrawn;
  if v_is_admin_withdrawn then
    raise notice 'TEST79 FAIL: 탈퇴 후에도 is_admin=true';
  else
    raise notice 'TEST79 PASS: 탈퇴한 ADMIN is_admin=false';
  end if;
end $$;

reset role;

-- =========================================================
-- TEST 80: payment_settings 싱글턴·사유 필수·set_payment_provider
-- =========================================================
do $$
declare
  v_count int;
  v_provider text;
  v_reason text;
  v_actor uuid;
begin
  select count(*) into v_count from public.payment_settings;
  if v_count <> 1 then
    raise notice 'TEST80 FAIL: payment_settings 행 수=%(기대 1)', v_count;
    return;
  end if;

  begin
    insert into public.payment_settings (id, active_provider, reason)
    values ('SINGLETON', 'TOSS', '중복 싱글턴');
    raise notice 'TEST80 FAIL: payment_settings INSERT가 통과함';
    return;
  exception when others then
    if sqlerrm not like '%결제 설정 행은%' then
      raise notice 'TEST80 FAIL: INSERT 예외 예상과 다름 — %', sqlerrm;
      return;
    end if;
  end;

  begin
    delete from public.payment_settings where id = 'SINGLETON';
    raise notice 'TEST80 FAIL: payment_settings DELETE가 통과함';
    return;
  exception when others then
    if sqlerrm not like '%결제 설정 행은%' then
      raise notice 'TEST80 FAIL: DELETE 예외 예상과 다름 — %', sqlerrm;
      return;
    end if;
  end;

  begin
    update public.payment_settings set reason = null where id = 'SINGLETON';
    raise notice 'TEST80 FAIL: reason null UPDATE가 통과함';
    return;
  exception when check_violation then
    null;
  end;

  begin
    update public.payment_settings set reason = '   ' where id = 'SINGLETON';
    raise notice 'TEST80 FAIL: reason 공백 UPDATE가 통과함';
    return;
  exception when check_violation then
    null;
  end;

  select id into v_actor from public.users where role = 'ADMIN' limit 1;
  perform public.set_payment_provider('TOSS', 'TEST80 PG 설정', v_actor);
  select active_provider, reason into v_provider, v_reason
    from public.payment_settings where id = 'SINGLETON';
  if v_provider is distinct from 'TOSS' or v_reason is distinct from 'TEST80 PG 설정' then
    raise notice 'TEST80 FAIL: set_payment_provider 후 provider=%, reason=%', v_provider, v_reason;
    return;
  end if;

  begin
    perform public.set_payment_provider('STEPPAY', '잘못된 PG', v_actor);
    raise notice 'TEST80 FAIL: 알 수 없는 provider가 통과함';
    return;
  exception when others then
    if sqlerrm not like '%알 수 없는 결제 제공자%' then
      raise notice 'TEST80 FAIL: 잘못된 provider 예외 예상과 다름 — %', sqlerrm;
      return;
    end if;
  end;

  -- 페이앱 폐기(2026-10-02): PAYAPP은 이제 알 수 없는 결제 제공자다(원장·DLQ CHECK의 과거 값과는 별개).
  begin
    perform public.set_payment_provider('PAYAPP', '페이앱 폐기 후 선택 시도', v_actor);
    raise notice 'TEST80 FAIL: 폐기된 PAYAPP이 활성 PG로 선택됨';
    return;
  exception when others then
    if sqlerrm not like '%알 수 없는 결제 제공자%' then
      raise notice 'TEST80 FAIL: PAYAPP 거부 예외 예상과 다름 — %', sqlerrm;
      return;
    end if;
  end;

  begin
    perform public.set_payment_provider('TOSS', '', v_actor);
    raise notice 'TEST80 FAIL: 빈 사유 set_payment_provider가 통과함';
    return;
  exception when others then
    if sqlerrm not like '%사유%' then
      raise notice 'TEST80 FAIL: 빈 사유 예외 예상과 다름 — %', sqlerrm;
      return;
    end if;
  end;

  perform public.set_payment_provider(
    null,
    '초기값 — PG 미설정(결제 자체가 막힌 상태, 2026-09-18 확정 원칙과 동일)',
    v_actor
  );

  raise notice 'TEST80 PASS: payment_settings 싱글턴·사유 필수·set_payment_provider';
end $$;

-- =========================================================
-- TEST 81: course_offerings.auto_approve → create_order가 APPROVED
-- =========================================================
do $$
declare
  v_course_id uuid;
  v_offering_auto uuid;
  v_offering_manual uuid;
  v_user_auto uuid;
  v_user_manual uuid;
  v_order_auto uuid;
  v_order_manual uuid;
  v_status text;
  v_approved_at timestamptz;
  v_approved_events int;
begin
  insert into public.courses (name, category) values ('TEST81강의', 'TEST') returning id into v_course_id;

  v_offering_auto := pg_temp.create_offering_legacy(
    v_course_id, 'AUTO', 10, 10000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null, now() - interval '2 days', true
  );
  v_offering_manual := pg_temp.create_offering_legacy(
    v_course_id, 'MANUAL', 10, 10000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null, now() - interval '2 days', false
  );

  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test81a@example.com', 'STUDENT')
    returning id into v_user_auto;
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test81b@example.com', 'STUDENT')
    returning id into v_user_manual;

  v_order_auto := public.create_order(v_user_auto, v_offering_auto, null, null);
  select status, approved_at into v_status, v_approved_at from public.orders where id = v_order_auto;
  select count(*) into v_approved_events from public.order_events
    where order_id = v_order_auto and event_type = 'APPROVED' and actor = 'SYSTEM';
  if v_status is distinct from 'APPROVED' or v_approved_at is null or v_approved_events <> 1 then
    raise notice 'TEST81 FAIL: auto_approve 주문 status=%, approved_at=%, APPROVED events=%',
      v_status, v_approved_at, v_approved_events;
    return;
  end if;

  v_order_manual := public.create_order(v_user_manual, v_offering_manual, null, null);
  select status, approved_at into v_status, v_approved_at from public.orders where id = v_order_manual;
  select count(*) into v_approved_events from public.order_events
    where order_id = v_order_manual and event_type = 'APPROVED';
  if v_status is distinct from 'PENDING' or v_approved_at is not null or v_approved_events <> 0 then
    raise notice 'TEST81 FAIL: 수동승인 주문 status=%, approved_at=%, APPROVED events=%',
      v_status, v_approved_at, v_approved_events;
    return;
  end if;

  raise notice 'TEST81 PASS: auto_approve on→APPROVED, off→PENDING';
end $$;

-- =========================================================
-- TEST 83~87: update_course_offering(p_offering_id, p_actor, p_reason, p_patch) — 개설강의 수정(U 단계 6)
-- "개설강의 조회·변경 페이지가 가장 중요". 허용 키 화이트리스트 + 없는 키 불변 +
-- 정원은 이 함수 한 곳에서만(잔여석 동반 조정) + 상태·grants·잔여석 직접 수정 거부.
-- =========================================================

-- TEST 83: 정상 수정 — 바뀐 필드만 반환·반영, 안 건드린 필드 불변
do $$
declare
  v_course uuid;
  v_off uuid;
  v_admin uuid;
  v_ret jsonb;
  v_row public.course_offerings%rowtype;
begin
  insert into public.courses (name, category) values ('TEST83강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test83-admin@example.com', 'ADMIN') returning id into v_admin;
  v_off := pg_temp.create_offering_legacy(
    v_course, 'OLD', 10, 10000, '옛 위치', false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null, now() - interval '2 days', false
  );

  v_ret := public.update_course_offering(v_off, v_admin, 'ADMIN', '라벨·위치·자동승인 수정',
    '{"label":"NEW","location":"새 위치","auto_approve":true}'::jsonb);

  select * into v_row from public.course_offerings where id = v_off;
  if v_row.label is distinct from 'NEW' or v_row.location is distinct from '새 위치' or v_row.auto_approve is not true then
    raise notice 'TEST83 FAIL: 반영 label=%, location=%, auto_approve=%', v_row.label, v_row.location, v_row.auto_approve;
    return;
  end if;
  if v_row.capacity <> 10 or v_row.remaining_seats <> 10 or v_row.price <> 10000 or v_row.status <> 'OPEN' then
    raise notice 'TEST83 FAIL: 안 건드린 필드가 바뀜 capacity=%, remaining=%, price=%, status=%',
      v_row.capacity, v_row.remaining_seats, v_row.price, v_row.status;
    return;
  end if;
  if (select count(*) from jsonb_object_keys(v_ret)) <> 3
     or v_ret->'label'->>'from' is distinct from 'OLD' or v_ret->'label'->>'to' is distinct from 'NEW'
     or (v_ret->'auto_approve'->>'to')::boolean is not true then
    raise notice 'TEST83 FAIL: 반환 변경 목록이 이상함 — %', v_ret;
    return;
  end if;

  -- JSON null로 위치를 지울 수 있다(키가 없으면 불변, null이면 지움).
  perform public.update_course_offering(v_off, v_admin, 'ADMIN', '위치 지움', '{"location":null}'::jsonb);
  if (select location from public.course_offerings where id = v_off) is not null then
    raise notice 'TEST83 FAIL: location null 지정이 반영되지 않음';
    return;
  end if;

  raise notice 'TEST83 PASS: 바뀐 필드만 반영·반환, 안 건드린 필드 불변, JSON null로 지우기';
end $$;

-- TEST 84: 정원 — 증가는 잔여 동반 증가, 점유 이하 감소 거부, 점유와 같게까지는 허용
do $$
declare
  v_course uuid;
  v_off uuid;
  v_admin uuid;
  v_user1 uuid;
  v_user2 uuid;
  v_cap int;
  v_rem int;
begin
  insert into public.courses (name, category) values ('TEST84강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test84-admin@example.com', 'ADMIN') returning id into v_admin;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test84a@example.com', 'STUDENT') returning id into v_user1;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test84b@example.com', 'STUDENT') returning id into v_user2;
  v_off := pg_temp.create_offering_legacy(
    v_course, 'CAP', 5, 10000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null, now() - interval '2 days', false
  );
  perform public.create_order(v_user1, v_off, null, null);
  perform public.create_order(v_user2, v_off, null, null);   -- 점유 2, 잔여 3

  perform public.update_course_offering(v_off, v_admin, 'ADMIN', '정원 증가', '{"capacity":8}'::jsonb);
  select capacity, remaining_seats into v_cap, v_rem from public.course_offerings where id = v_off;
  if v_cap <> 8 or v_rem <> 6 then
    raise notice 'TEST84 FAIL: 정원 5→8 후 capacity=%, remaining=%(기대 8, 6)', v_cap, v_rem;
    return;
  end if;

  begin
    perform public.update_course_offering(v_off, v_admin, 'ADMIN', '정원 과감소', '{"capacity":1}'::jsonb);
    raise notice 'TEST84 FAIL: 점유(2) 아래로 정원을 줄였는데 거부되지 않음';
    return;
  exception when others then
    if sqlerrm not like '%점유%' then
      raise notice 'TEST84 FAIL: 점유 이하 감소 예외 문구가 예상과 다름 — %', sqlerrm;
      return;
    end if;
  end;
  select capacity, remaining_seats into v_cap, v_rem from public.course_offerings where id = v_off;
  if v_cap <> 8 or v_rem <> 6 then
    raise notice 'TEST84 FAIL: 거부된 호출이 값을 바꿈 capacity=%, remaining=%', v_cap, v_rem;
    return;
  end if;

  perform public.update_course_offering(v_off, v_admin, 'ADMIN', '정원을 점유와 같게', '{"capacity":2}'::jsonb);
  select capacity, remaining_seats into v_cap, v_rem from public.course_offerings where id = v_off;
  if v_cap <> 2 or v_rem <> 0 then
    raise notice 'TEST84 FAIL: 정원 8→2 후 capacity=%, remaining=%(기대 2, 0)', v_cap, v_rem;
    return;
  end if;

  raise notice 'TEST84 PASS: 정원 증가 시 잔여 동반 증가, 점유 이하 감소 거부(값 불변), 점유와 같게까지 허용';
end $$;

-- TEST 85: 거부 규칙 — 사유 공백·빈 패치·변경 없음·허용 밖 키(status/grants/remaining_seats)·폐강·삭제·시간 역순·채널만
do $$
declare
  v_course uuid;
  v_off uuid;
  v_cancelling uuid;
  v_deleted uuid;
  v_admin uuid;
  v_case text;
  v_failed text[] := '{}';
begin
  insert into public.courses (name, category) values ('TEST85강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test85-admin@example.com', 'ADMIN') returning id into v_admin;
  v_off := pg_temp.create_offering_legacy(v_course, 'R', 5, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '2 days', false);
  v_cancelling := pg_temp.create_offering_legacy(v_course, 'C', 5, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '2 days', false);
  v_deleted := pg_temp.create_offering_legacy(v_course, 'D', 5, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '2 days', false);
  update public.course_offerings
    set status = 'CANCELLING', status_reason = '테스트', status_changed_by = v_admin, status_changed_at = clock_timestamp()
    where id = v_cancelling;
  update public.course_offerings
    set deleted_at = now(), deleted_reason = '테스트', deleted_by = v_admin
    where id = v_deleted;

  -- 각 시도는 예외가 나야 통과한다. 예외가 안 나면 그 케이스 이름을 모은다.
  foreach v_case in array array['blank_reason','empty_patch','no_change','status_key','grants_key','remaining_key','cancelling','deleted','time_reverse','channel_only','negative_price','unknown_key'] loop
    begin
      if v_case = 'blank_reason' then perform public.update_course_offering(v_off, v_admin, 'ADMIN', '  ', '{"label":"X"}'::jsonb);
      elsif v_case = 'empty_patch' then perform public.update_course_offering(v_off, v_admin, 'ADMIN', '사유', '{}'::jsonb);
      elsif v_case = 'no_change' then perform public.update_course_offering(v_off, v_admin, 'ADMIN', '사유', '{"label":"R","price":10000}'::jsonb);
      elsif v_case = 'status_key' then perform public.update_course_offering(v_off, v_admin, 'ADMIN', '사유', '{"status":"CLOSED"}'::jsonb);
      elsif v_case = 'grants_key' then perform public.update_course_offering(v_off, v_admin, 'ADMIN', '사유', '{"grants":[]}'::jsonb);
      elsif v_case = 'remaining_key' then perform public.update_course_offering(v_off, v_admin, 'ADMIN', '사유', '{"remaining_seats":99}'::jsonb);
      elsif v_case = 'cancelling' then perform public.update_course_offering(v_cancelling, v_admin, 'ADMIN', '사유', '{"label":"X"}'::jsonb);
      elsif v_case = 'deleted' then perform public.update_course_offering(v_deleted, v_admin, 'ADMIN', '사유', '{"label":"X"}'::jsonb);
      elsif v_case = 'time_reverse' then perform public.update_course_offering(v_off, v_admin, 'ADMIN', '사유', jsonb_build_object('ends_at', (now() - interval '2 days')::text));
      elsif v_case = 'channel_only' then perform public.update_course_offering(v_off, v_admin, 'ADMIN', '사유', '{"discord_channel_id":"123"}'::jsonb);
      elsif v_case = 'negative_price' then perform public.update_course_offering(v_off, v_admin, 'ADMIN', '사유', '{"price":-1}'::jsonb);
      elsif v_case = 'unknown_key' then perform public.update_course_offering(v_off, v_admin, 'ADMIN', '사유', '{"nope":1}'::jsonb);
      end if;
      v_failed := v_failed || v_case;   -- 예외 없이 통과 = 거부 실패
    exception when others then
      null;
    end;
  end loop;

  if array_length(v_failed, 1) is not null then
    raise notice 'TEST85 FAIL: 거부돼야 하는데 통과한 케이스 — %', v_failed;
    return;
  end if;
  if (select label from public.course_offerings where id = v_off) is distinct from 'R'
     or (select status from public.course_offerings where id = v_off) <> 'OPEN' then
    raise notice 'TEST85 FAIL: 거부된 호출이 값을 바꿈';
    return;
  end if;

  raise notice 'TEST85 PASS: 사유 공백·빈 패치·변경 없음·status/grants/remaining_seats/미지 키·폐강·삭제·시간 역순·채널만·음수 가격 12가지 거부';
end $$;

-- TEST 86: 가격 변경은 기존 주문의 금액을 바꾸지 않고, 새 주문부터 새 가격이다
do $$
declare
  v_course uuid;
  v_off uuid;
  v_admin uuid;
  v_user1 uuid;
  v_user2 uuid;
  v_order1 uuid;
  v_order2 uuid;
  v_amount1 int;
  v_amount2 int;
begin
  insert into public.courses (name, category) values ('TEST86강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test86-admin@example.com', 'ADMIN') returning id into v_admin;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test86a@example.com', 'STUDENT') returning id into v_user1;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test86b@example.com', 'STUDENT') returning id into v_user2;
  v_off := pg_temp.create_offering_legacy(v_course, 'P', 5, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '2 days', false);

  v_order1 := public.create_order(v_user1, v_off, null, null);
  perform public.update_course_offering(v_off, v_admin, 'ADMIN', '가격 인상', '{"price":25000}'::jsonb);
  v_order2 := public.create_order(v_user2, v_off, null, null);

  select final_amount into v_amount1 from public.orders where id = v_order1;
  select final_amount into v_amount2 from public.orders where id = v_order2;
  if v_amount1 <> 10000 or v_amount2 <> 25000 then
    raise notice 'TEST86 FAIL: 기존 주문=%(기대 10000), 새 주문=%(기대 25000)', v_amount1, v_amount2;
    return;
  end if;
  if (select price from public.course_offerings where id = v_off) <> 25000 then
    raise notice 'TEST86 FAIL: 개설강의 가격이 반영되지 않음';
    return;
  end if;

  raise notice 'TEST86 PASS: 가격 변경은 기존 주문 금액 불변, 새 주문부터 새 가격';
end $$;

-- TEST 87: 디스코드 역할·채널 — 설정·교체·삭제 시 COURSE_ACCESS 등 다른 grants 보존, 형태 검사 통과
do $$
declare
  v_course uuid;
  v_off uuid;
  v_admin uuid;
  v_grants jsonb;
begin
  insert into public.courses (name, category) values ('TEST87강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test87-admin@example.com', 'ADMIN') returning id into v_admin;
  v_off := pg_temp.create_offering_legacy(
    v_course, 'G', 5, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[],
    '[{"type":"COURSE_ACCESS"},{"type":"SOURCE_DOWNLOAD","blob_pathname":"a/b.zip","max_uses":1}]'::jsonb,
    null, null, null, now() - interval '2 days', false
  );

  perform public.update_course_offering(v_off, v_admin, 'ADMIN', '역할 설정', '{"discord_role_id":"1111","discord_channel_id":"2222"}'::jsonb);
  select grants into v_grants from public.course_offerings where id = v_off;
  if not (v_grants @> '[{"type":"COURSE_ACCESS"}]'::jsonb)
     or not (v_grants @> '[{"type":"SOURCE_DOWNLOAD","blob_pathname":"a/b.zip"}]'::jsonb)
     or not (v_grants @> '[{"type":"DISCORD_ROLE","discord_role_id":"1111","discord_channel_id":"2222"}]'::jsonb)
     or jsonb_array_length(v_grants) <> 3 then
    raise notice 'TEST87 FAIL: 역할 설정 후 grants=%', v_grants;
    return;
  end if;

  perform public.update_course_offering(v_off, v_admin, 'ADMIN', '역할 교체(채널은 그대로)', '{"discord_role_id":"3333"}'::jsonb);
  select grants into v_grants from public.course_offerings where id = v_off;
  if not (v_grants @> '[{"type":"DISCORD_ROLE","discord_role_id":"3333","discord_channel_id":"2222"}]'::jsonb)
     or jsonb_array_length(v_grants) <> 3 then
    raise notice 'TEST87 FAIL: 역할 교체 후 grants=%', v_grants;
    return;
  end if;

  perform public.update_course_offering(v_off, v_admin, 'ADMIN', '역할·채널 삭제', '{"discord_role_id":null,"discord_channel_id":null}'::jsonb);
  select grants into v_grants from public.course_offerings where id = v_off;
  if exists (select 1 from jsonb_array_elements(v_grants) e where e->>'type' = 'DISCORD_ROLE')
     or not (v_grants @> '[{"type":"COURSE_ACCESS"}]'::jsonb)
     or jsonb_array_length(v_grants) <> 2 then
    raise notice 'TEST87 FAIL: 역할 삭제 후 grants=%', v_grants;
    return;
  end if;

  raise notice 'TEST87 PASS: 역할·채널 설정/교체/삭제가 COURSE_ACCESS·SOURCE_DOWNLOAD를 보존하고 grants 형태 검사를 통과';
end $$;

-- =========================================================
-- TEST 88~89: payment_attempts(결제 요청 이력)는 앱 경로로 삭제할 수 없고, 승인 요청 시각 UPDATE는 된다
-- set local role로 실제 앱 권한(service_role)을 흉내 낸다.
-- =========================================================
do $$
declare
  v_order uuid;
begin
  select id into v_order from public.orders order by created_at desc limit 1;
  if v_order is null then
    raise notice 'TEST88 FAIL: 주문 픽스처가 없다';
    return;
  end if;
  insert into public.payment_attempts (id, order_id, provider)
  values ('88888888-0000-4000-8000-000000000088', v_order, 'TOSS');
end $$;

set local role service_role;

do $$
begin
  begin
    delete from public.payment_attempts where id = '88888888-0000-4000-8000-000000000088';
    raise notice 'TEST88 FAIL: payment_attempts 행이 service_role로 DELETE됨';
  exception when restrict_violation then
    raise notice 'TEST88 PASS: payment_attempts DELETE가 트리거로 차단됨(service_role)';
  end;

  update public.payment_attempts set confirm_requested_at = now()
  where id = '88888888-0000-4000-8000-000000000088' and confirm_requested_at is null;
  if found then
    raise notice 'TEST89 PASS: payment_attempts 승인 요청 시각 UPDATE는 허용됨(service_role)';
  else
    raise notice 'TEST89 FAIL: 승인 요청 시각 UPDATE가 반영되지 않음';
  end if;
end $$;

reset role;

-- TEST 90: 모집 시작·개강 분리(2026-10-07) — 개강 후 핵심 정보 잠금, 모집 시작 < 개강 강제.
do $$
declare
  v_course uuid;
  v_started uuid;
  v_admin uuid;
begin
  insert into public.courses (name, category) values ('TEST90강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test90-admin@example.com', 'ADMIN') returning id into v_admin;

  begin
    perform pg_temp.create_offering_legacy(v_course, 'X', 5, 10000, null, false, now() + interval '1 day', now() + interval '31 days',
      '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() + interval '2 days', false);
    raise notice 'TEST90a FAIL: 모집 시작이 개강보다 늦은데 생성됨';
  exception when others then
    if sqlerrm like '%모집 시작은 개강보다 앞%' then
      raise notice 'TEST90a PASS: 모집 시작 ≥ 개강이면 생성 거부';
    else
      raise notice 'TEST90a FAIL: 예외 문구가 예상과 다름 — %', sqlerrm;
    end if;
  end;

  v_started := pg_temp.create_offering_legacy(v_course, 'S', 5, 10000, null, false, now() - interval '1 day', now() + interval '31 days',
    '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '10 days', false);
  begin
    perform public.update_course_offering(v_started, v_admin, 'ADMIN', '개강 후 정원 변경', '{"capacity":8}'::jsonb);
    raise notice 'TEST90b FAIL: 개강 후인데 정원이 바뀜';
  exception when others then
    if sqlerrm like '%핵심 정보%' then
      raise notice 'TEST90b PASS: 개강 후 정원 수정 거부';
    else
      raise notice 'TEST90b FAIL: 예외 문구가 예상과 다름 — %', sqlerrm;
    end if;
  end;
  begin
    perform public.update_course_offering(v_started, v_admin, 'ADMIN', '개강 후 모집 시작 변경', jsonb_build_object('recruit_opens_at', (now() - interval '5 days')::text));
    raise notice 'TEST90c FAIL: 개강 후인데 모집 시작이 바뀜';
  exception when others then
    raise notice 'TEST90c PASS: 개강 후 모집 시작 수정 거부';
  end;
  begin
    perform public.update_course_offering(v_started, v_admin, 'ADMIN', '개강 후 라벨 변경', '{"label":"S2"}'::jsonb);
    raise notice 'TEST90d PASS: 개강 후에도 라벨은 수정 가능';
  exception when others then
    raise notice 'TEST90d FAIL: 라벨 수정이 거부됨 — %', sqlerrm;
  end;
end $$;

-- TEST 91: 명령 레일 통제 스위치(ADR-0015) — 공리 보호, 층별 대상 규칙, 삭제·변경 금지, 가입 DB 방어선(gate_open).
do $$
declare
  v_admin uuid;
  v_student uuid;
  v_id uuid;
  v_ok boolean;
begin
  select id into v_admin from public.users where role = 'ADMIN' limit 1;
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test91@example.com', 'STUDENT') returning id into v_student;

  -- a 공리(통제실 통로)를 대상으로 한 스위치는 거부
  v_ok := false;
  begin
    insert into public.rail_switches (level, target, reason, set_by) values ('COMMAND', 'RAIL_SWITCH_SET', 'TEST91', v_admin);
  exception when check_violation then v_ok := true;
  end;
  if v_ok then raise notice 'TEST91a PASS: 공리 명령 대상 스위치 거부'; else raise notice 'TEST91a FAIL: 공리 명령에 스위치가 걸림'; end if;

  -- b 층별 대상 규칙: SYSTEM에 대상, MODULE 미등록 이름, MODULE·COMMAND 대상 없음은 거부
  v_ok := true;
  begin insert into public.rail_switches (level, target, reason, set_by) values ('SYSTEM', 'X', 'TEST91', v_admin); v_ok := false;
  exception when check_violation then null; end;
  begin insert into public.rail_switches (level, target, reason, set_by) values ('MODULE', 'FOO', 'TEST91', v_admin); v_ok := false;
  exception when check_violation then null; end;
  begin insert into public.rail_switches (level, target, reason, set_by) values ('MODULE', null, 'TEST91', v_admin); v_ok := false;
  exception when check_violation then null; end;
  begin insert into public.rail_switches (level, target, reason, set_by) values ('COMMAND', null, 'TEST91', v_admin); v_ok := false;
  exception when check_violation then null; end;
  if v_ok then raise notice 'TEST91b PASS: 층별 대상 규칙 위반 4종 거부'; else raise notice 'TEST91b FAIL: 대상 규칙 위반이 저장됨'; end if;

  -- c 삭제 금지·대상 변경 금지·해제는 사유와 행위자 필수
  insert into public.rail_switches (level, target, user_id, reason, set_by)
    values ('COMMAND', 'COURSE_CREATE', v_student, 'TEST91', v_admin) returning id into v_id;
  v_ok := true;
  begin delete from public.rail_switches where id = v_id; v_ok := false;
  exception when restrict_violation then null; end;
  begin update public.rail_switches set target = 'COURSE_DELETE' where id = v_id; v_ok := false;
  exception when restrict_violation then null; end;
  begin update public.rail_switches set cleared_at = now(), cleared_by = v_admin where id = v_id; v_ok := false;
  exception when check_violation then null; end;
  update public.rail_switches set cleared_at = now(), cleared_by = v_admin, cleared_reason = 'TEST91 해제' where id = v_id;
  begin update public.rail_switches set cleared_reason = '바꿈' where id = v_id; v_ok := false;
  exception when restrict_violation then null; end;
  if v_ok and (select cleared_reason from public.rail_switches where id = v_id) = 'TEST91 해제' then
    raise notice 'TEST91c PASS: 삭제·대상 변경·사유 없는 해제·해제 후 변경 거부, 정상 해제는 기록';
  else
    raise notice 'TEST91c FAIL: 보호 규칙 위반이 통과함';
  end if;

  -- d 가입 DB 방어선: 전원 대상 SYSTEM / MODULE MEMBER / COMMAND ACCOUNT_SIGNUP 각각 닫힘, 유저 대상 SYSTEM은 무관
  v_ok := public.gate_open('SIGNUP');
  insert into public.rail_switches (level, reason, set_by) values ('SYSTEM', 'TEST91', v_admin) returning id into v_id;
  v_ok := v_ok and not public.gate_open('SIGNUP');
  update public.rail_switches set cleared_at = now(), cleared_by = v_admin, cleared_reason = 'TEST91' where id = v_id;
  insert into public.rail_switches (level, target, reason, set_by) values ('MODULE', 'MEMBER', 'TEST91', v_admin) returning id into v_id;
  v_ok := v_ok and not public.gate_open('SIGNUP');
  update public.rail_switches set cleared_at = now(), cleared_by = v_admin, cleared_reason = 'TEST91' where id = v_id;
  insert into public.rail_switches (level, target, reason, set_by) values ('COMMAND', 'ACCOUNT_SIGNUP', 'TEST91', v_admin) returning id into v_id;
  v_ok := v_ok and not public.gate_open('SIGNUP');
  update public.rail_switches set cleared_at = now(), cleared_by = v_admin, cleared_reason = 'TEST91' where id = v_id;
  insert into public.rail_switches (level, user_id, reason, set_by) values ('SYSTEM', v_student, 'TEST91', v_admin) returning id into v_id;
  v_ok := v_ok and public.gate_open('SIGNUP');
  update public.rail_switches set cleared_at = now(), cleared_by = v_admin, cleared_reason = 'TEST91' where id = v_id;
  if v_ok then raise notice 'TEST91d PASS: gate_open(SIGNUP)이 SYSTEM·MODULE MEMBER·COMMAND ACCOUNT_SIGNUP(전원)에서 닫히고 유저 대상은 무관';
  else raise notice 'TEST91d FAIL: gate_open(SIGNUP) 판정이 다름'; end if;

  -- e system_gates의 AUDIT 행은 계속 쓸 수 있다(감사 on/off는 0층 스위치)
  begin
    update public.system_gates set status = 'OPEN', reason = 'TEST91', changed_by = v_admin where code = 'AUDIT';
    raise notice 'TEST91e PASS: AUDIT 행은 계속 갱신 가능';
  exception when others then
    raise notice 'TEST91e FAIL: AUDIT 갱신 거부 — %', sqlerrm;
  end;
end $$;

-- TEST 91f: complete_signup() "호출 자체"가 가입 스위치로 거부된다(명령 레일 CR-2 DB 최후 방어선, 2026-10-07 보강).
-- TEST91d는 gate_open() 함수까지만 봤다. 여기서는 가입 RPC를 실제로 불러, 이메일 identity·약관 검사에 걸리는 것이 아니라
-- 오직 스위치 때문에 거부됨(insufficient_privilege)과 회원 행이 안 생김을 확인하고, 스위치를 해제하면 같은 호출이 성공함(대조)을 본다.
-- 계정 3개: u1 = SYSTEM(전원) 거부 → 해제 후 성공 / u2 = COMMAND ACCOUNT_SIGNUP(전원) 거부 / u3 = 다른 유저 대상 SYSTEM → 무관하게 성공.
do $$
declare
  v_admin uuid;
  v_service uuid;
  v_privacy uuid;
  v_u1 uuid := '00000000-0000-0000-0000-0000000091f1';
  v_u2 uuid := '00000000-0000-0000-0000-0000000091f2';
  v_u3 uuid := '00000000-0000-0000-0000-0000000091f3';
  v_sw uuid;
  v_ok boolean := true;
  v_denied boolean;
  v_profile uuid;
begin
  select id into v_admin from public.users where role = 'ADMIN' limit 1;
  -- complete_signup()이 "현재 유효한 약관"으로 인정하는 조건과 똑같이 고른다(20261006093816).
  select id into v_service from public.terms where type = 'SERVICE_USE' and effective_at <= now() order by effective_at desc, created_at desc limit 1;
  select id into v_privacy from public.terms where type = 'PRIVACY_USE' and effective_at <= now() order by effective_at desc, created_at desc limit 1;

  insert into auth.users (id, email) values (v_u1, 'test91f-1@example.com'), (v_u2, 'test91f-2@example.com'), (v_u3, 'test91f-3@example.com');
  insert into auth.identities (id, user_id, provider_id, provider, identity_data) values
    (gen_random_uuid(), v_u1, v_u1::text, 'email', jsonb_build_object('sub', v_u1::text, 'email', 'test91f-1@example.com')),
    (gen_random_uuid(), v_u2, v_u2::text, 'email', jsonb_build_object('sub', v_u2::text, 'email', 'test91f-2@example.com')),
    (gen_random_uuid(), v_u3, v_u3::text, 'email', jsonb_build_object('sub', v_u3::text, 'email', 'test91f-3@example.com'));

  -- ① SYSTEM 전원: 거부 → 회원 행 없음 → 해제 → 같은 호출 성공
  insert into public.rail_switches (level, reason, set_by) values ('SYSTEM', 'TEST91f', v_admin) returning id into v_sw;
  v_denied := false;
  begin
    perform public.complete_signup(v_u1, 'test91f-1@example.com', v_service, v_privacy);
  exception when insufficient_privilege then
    v_denied := sqlerrm like '%신규 가입이 일시 중단%';
  end;
  v_ok := v_ok and v_denied and not exists (select 1 from public.users where auth_user_id = v_u1);
  update public.rail_switches set cleared_at = now(), cleared_by = v_admin, cleared_reason = 'TEST91f' where id = v_sw;
  select public.complete_signup(v_u1, 'test91f-1@example.com', v_service, v_privacy) into v_profile;
  v_ok := v_ok and v_profile is not null and exists (select 1 from public.users where id = v_profile and auth_user_id = v_u1);

  -- ② COMMAND ACCOUNT_SIGNUP 전원: 거부 → 회원 행 없음
  insert into public.rail_switches (level, target, reason, set_by) values ('COMMAND', 'ACCOUNT_SIGNUP', 'TEST91f', v_admin) returning id into v_sw;
  v_denied := false;
  begin
    perform public.complete_signup(v_u2, 'test91f-2@example.com', v_service, v_privacy);
  exception when insufficient_privilege then
    v_denied := sqlerrm like '%신규 가입이 일시 중단%';
  end;
  v_ok := v_ok and v_denied and not exists (select 1 from public.users where auth_user_id = v_u2);
  update public.rail_switches set cleared_at = now(), cleared_by = v_admin, cleared_reason = 'TEST91f' where id = v_sw;

  -- ③ 다른 유저 대상 SYSTEM: 가입 방어선과 무관 → 성공
  insert into public.rail_switches (level, user_id, reason, set_by) values ('SYSTEM', v_admin, 'TEST91f', v_admin) returning id into v_sw;
  select public.complete_signup(v_u3, 'test91f-3@example.com', v_service, v_privacy) into v_profile;
  v_ok := v_ok and v_profile is not null and exists (select 1 from public.users where id = v_profile and auth_user_id = v_u3);
  update public.rail_switches set cleared_at = now(), cleared_by = v_admin, cleared_reason = 'TEST91f' where id = v_sw;

  if v_ok then
    raise notice 'TEST91f PASS: complete_signup() 호출이 SYSTEM·COMMAND ACCOUNT_SIGNUP(전원)에서 insufficient_privilege로 거부(회원 행 없음), 해제하면 같은 호출 성공, 다른 유저 대상 스위치는 무관';
  else
    raise notice 'TEST91f FAIL: complete_signup() 가입 방어선 판정이 다름';
  end if;
end $$;

-- =========================================================
-- TEST 92: 직권 수강 부여 grant_order_access() (ADR-0020)
-- 승인된 미결제 신청서에 결제 없이 수강권을 준다 — 결제 상태 WAIVED + 주문 이벤트 ACCESS_GRANTED + 아웃박스 사실
-- ORDER_ACCESS_GRANTED를 한 트랜잭션으로 남기고, 결제 원장에는 아무것도 쓰지 않는다.
-- =========================================================
do $$
declare
  v_course uuid;
  v_off uuid;
  v_admin uuid;
  v_student uuid;
  v_order uuid;
  v_event uuid;
  v_ok boolean := true;
begin
  insert into public.courses (name, category) values ('TEST92강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test92-admin@example.com', 'ADMIN') returning id into v_admin;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test92-student@example.com', 'STUDENT') returning id into v_student;
  v_off := pg_temp.create_offering_legacy(v_course, 'W', 5, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '2 days', false);
  v_order := public.create_order(v_student, v_off, null, null);
  perform public.transition_order(v_order, v_admin, 'ADMIN', 'APPROVED', 'APPROVED');

  v_event := public.grant_order_access(v_order, v_admin, 'ADMIN', '  초대 수강생  ');

  -- 92a: 결제 상태 WAIVED, 돈 필드 비어 있음, 수강 상태는 그대로 APPROVED
  if not exists (select 1 from public.orders where id = v_order and payment_status = 'WAIVED' and status = 'APPROVED'
                   and paid_at is null and payment_method is null and refunded_at is null) then
    v_ok := false; raise notice 'TEST92a FAIL: 직권 부여 뒤 주문 상태가 기대와 다름';
  end if;
  -- 92b: 주문 이벤트 ACCESS_GRANTED(ADMIN, 행위자 id, 사유는 공백 제거) 1건 = 반환값
  if not exists (select 1 from public.order_events where id = v_event and order_id = v_order and event_type = 'ACCESS_GRANTED'
                   and actor = 'ADMIN' and actor_user_id = v_admin and payload = jsonb_build_object('reason', '초대 수강생')) then
    v_ok := false; raise notice 'TEST92b FAIL: ACCESS_GRANTED 이벤트가 기대와 다름';
  end if;
  -- 92c: 아웃박스 사실 ORDER_ACCESS_GRANTED 1건 — grant_event_id가 그 이벤트, grants 스냅샷은 개설강의 grants
  if (select count(*) from public.outbox_messages where topic = 'ORDER_ACCESS_GRANTED' and payload->>'order_id' = v_order::text) <> 1
     or not exists (select 1 from public.outbox_messages where topic = 'ORDER_ACCESS_GRANTED' and payload->>'order_id' = v_order::text
                      and payload->>'grant_event_id' = v_event::text and payload->>'user_id' = v_student::text
                      and payload->'grants' = '[{"type":"COURSE_ACCESS"}]'::jsonb) then
    v_ok := false; raise notice 'TEST92c FAIL: ORDER_ACCESS_GRANTED 사실이 기대와 다름';
  end if;
  -- 92d: 결제 원장에는 아무것도 쓰지 않는다(거짓 입금 기록 없음)
  if exists (select 1 from public.payment_events where order_id = v_order) then
    v_ok := false; raise notice 'TEST92d FAIL: 직권 부여가 결제 원장에 행을 남김';
  end if;

  if v_ok then
    raise notice 'TEST92 PASS: 직권 부여 = WAIVED(돈 필드 null)·ACCESS_GRANTED(ADMIN, 사유)·ORDER_ACCESS_GRANTED 1건(grants 스냅샷)·결제 원장 0건';
  end if;
end $$;

-- TEST 92e: 거부 — 사유 공백·매니저 역할·승인 전(PENDING)·이미 부여(WAIVED)·이미 결제(PAID)·폐강 중·없는 주문. 거부된 호출은 아무것도 바꾸지 않는다.
do $$
declare
  v_course uuid;
  v_off uuid;
  v_off_cancelling uuid;
  v_admin uuid;
  v_u1 uuid; v_u2 uuid; v_u3 uuid; v_u4 uuid; v_u5 uuid;
  v_approved uuid; v_approved2 uuid; v_pending uuid; v_paid uuid; v_cancelling_order uuid;
  v_case text;
  v_failed text[] := '{}';
  v_outbox_before int;
  v_events_before int;
begin
  insert into public.courses (name, category) values ('TEST92e강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test92e-admin@example.com', 'ADMIN') returning id into v_admin;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test92e-1@example.com', 'STUDENT') returning id into v_u1;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test92e-2@example.com', 'STUDENT') returning id into v_u2;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test92e-3@example.com', 'STUDENT') returning id into v_u3;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test92e-4@example.com', 'STUDENT') returning id into v_u4;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test92e-5@example.com', 'STUDENT') returning id into v_u5;
  v_off := pg_temp.create_offering_legacy(v_course, 'A', 9, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '2 days', false);
  v_off_cancelling := pg_temp.create_offering_legacy(v_course, 'B', 9, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '2 days', false);

  -- v_approved는 먼저 정상 부여해 둔다(이중 부여 거부 확인용). v_approved2는 승인 상태를 유지해 사유·역할 검사가 상태 검사 때문이 아니라 그 검사 자체로 거부되는지 본다.
  v_approved := public.create_order(v_u1, v_off, null, null);
  perform public.transition_order(v_approved, v_admin, 'ADMIN', 'APPROVED', 'APPROVED');
  perform public.grant_order_access(v_approved, v_admin, 'ADMIN', '첫 부여');
  v_approved2 := public.create_order(v_u5, v_off, null, null);
  perform public.transition_order(v_approved2, v_admin, 'ADMIN', 'APPROVED', 'APPROVED');
  v_pending := public.create_order(v_u2, v_off, null, null);
  v_paid := public.create_order(v_u3, v_off, null, null);
  perform public.transition_order(v_paid, v_admin, 'ADMIN', 'APPROVED', 'APPROVED');
  update public.orders set payment_status = 'PAID', paid_at = now(), payment_method = 'CARD' where id = v_paid;
  v_cancelling_order := public.create_order(v_u4, v_off_cancelling, null, null);
  perform public.transition_order(v_cancelling_order, v_admin, 'ADMIN', 'APPROVED', 'APPROVED');
  update public.course_offerings
    set status = 'CANCELLING', status_reason = '테스트', status_changed_by = v_admin, status_changed_at = clock_timestamp()
    where id = v_off_cancelling;

  select count(*) into v_outbox_before from public.outbox_messages where topic = 'ORDER_ACCESS_GRANTED';  -- 첫 부여 이후 기준
  select count(*) into v_events_before from public.order_events where event_type = 'ACCESS_GRANTED';

  foreach v_case in array array['blank_reason','null_reason','manager_role','pending','paid','cancelling','missing_order','twice'] loop
    begin
      if v_case = 'blank_reason' then perform public.grant_order_access(v_approved2, v_admin, 'ADMIN', '   ');
      elsif v_case = 'null_reason' then perform public.grant_order_access(v_approved2, v_admin, 'ADMIN', null);
      elsif v_case = 'manager_role' then perform public.grant_order_access(v_approved2, v_admin, 'MANAGER', '사유');
      elsif v_case = 'pending' then perform public.grant_order_access(v_pending, v_admin, 'ADMIN', '사유');
      elsif v_case = 'paid' then perform public.grant_order_access(v_paid, v_admin, 'ADMIN', '사유');
      elsif v_case = 'cancelling' then perform public.grant_order_access(v_cancelling_order, v_admin, 'ADMIN', '사유');
      elsif v_case = 'missing_order' then perform public.grant_order_access(gen_random_uuid(), v_admin, 'ADMIN', '사유');
      elsif v_case = 'twice' then perform public.grant_order_access(v_approved, v_admin, 'ADMIN', '두 번째 부여');
      end if;
      v_failed := v_failed || v_case;   -- 예외 없이 통과 = 거부 실패
    exception when others then
      null;
    end;
  end loop;

  if array_length(v_failed, 1) is not null then
    raise notice 'TEST92e FAIL: 거부돼야 하는데 통과한 케이스: %', v_failed;
    return;
  end if;
  -- 거부된 호출은 이벤트·사실을 하나도 남기지 않았고, 대상 주문의 결제 상태도 그대로다.
  if (select count(*) from public.outbox_messages where topic = 'ORDER_ACCESS_GRANTED') <> v_outbox_before
     or (select count(*) from public.order_events where event_type = 'ACCESS_GRANTED') <> v_events_before
     or (select payment_status from public.orders where id = v_approved2) <> 'UNPAID'
     or (select payment_status from public.orders where id = v_approved) <> 'WAIVED'
     or (select payment_status from public.orders where id = v_pending) <> 'UNPAID'
     or (select payment_status from public.orders where id = v_paid) <> 'PAID'
     or (select payment_status from public.orders where id = v_cancelling_order) <> 'UNPAID' then
    raise notice 'TEST92e FAIL: 거부된 호출이 상태·기록을 바꿈';
    return;
  end if;

  raise notice 'TEST92e PASS: 사유 공백/null·매니저 역할·승인 전·이미 결제·폐강 중·없는 주문·이중 부여 8가지 거부, 거부는 기록을 남기지 않음';
end $$;

-- TEST 92f: WAIVED 제약 + WAIVED 주문은 결제 흐름에서 닫혀 있다 — 돈 필드가 있는 WAIVED 거부, 학생 취소·관리자 취소 거부,
-- PG 결제 성공 사실이 와도 상태를 바꾸지 않고 DLQ로 보낸다(이중 결제 방어).
do $$
declare
  v_course uuid;
  v_off uuid;
  v_admin uuid;
  v_student uuid;
  v_order uuid;
  v_ok boolean := true;
  v_dlq_before int;
begin
  insert into public.courses (name, category) values ('TEST92f강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test92f-admin@example.com', 'ADMIN') returning id into v_admin;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test92f-student@example.com', 'STUDENT') returning id into v_student;
  v_off := pg_temp.create_offering_legacy(v_course, 'F', 5, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '2 days', false);
  v_order := public.create_order(v_student, v_off, null, null);
  perform public.transition_order(v_order, v_admin, 'ADMIN', 'APPROVED', 'APPROVED');
  perform public.grant_order_access(v_order, v_admin, 'ADMIN', 'TEST92f');

  -- 돈 필드가 있는 WAIVED는 제약이 거부한다
  begin
    update public.orders set paid_at = now() where id = v_order;
    v_ok := false; raise notice 'TEST92f FAIL: WAIVED인데 paid_at이 채워짐';
  exception when check_violation then null;
  end;
  begin
    update public.orders set payment_method = 'CARD' where id = v_order;
    v_ok := false; raise notice 'TEST92f FAIL: WAIVED인데 payment_method가 채워짐';
  exception when check_violation then null;
  end;

  -- 학생 본인 취소·관리자 취소는 「이미 결제된 건」으로 거부된다
  begin
    perform public.cancel_own_order(v_order, v_student);
    v_ok := false; raise notice 'TEST92f FAIL: WAIVED 주문을 학생이 취소함';
  exception when others then null;
  end;
  begin
    perform public.transition_order(v_order, v_admin, 'ADMIN', 'CANCELLED', 'CANCELLED', 'TEST92 취소');
    v_ok := false; raise notice 'TEST92f FAIL: WAIVED 주문을 관리자가 취소함';
  exception when others then null;
  end;

  -- PG 결제 성공 사실이 와도 WAIVED는 그대로 + DLQ 1건(이중 결제 의심)
  select count(*) into v_dlq_before from public.dead_letters where payload->>'order_id' = v_order::text;
  perform public.on_payment_succeeded(gen_random_uuid(), v_order, 'TOSS', 10000, 'KRW', 'CARD', '{}'::jsonb);
  if (select payment_status from public.orders where id = v_order) <> 'WAIVED'
     or (select count(*) from public.dead_letters where payload->>'order_id' = v_order::text) <> v_dlq_before + 1
     or not exists (select 1 from public.dead_letters where payload->>'order_id' = v_order::text
                      and error_message like '%이중결제 의심%' and error_message like '%payment_status=WAIVED%')
     or exists (select 1 from public.outbox_messages where topic = 'ORDER_PAID' and payload->>'order_id' = v_order::text) then
    v_ok := false; raise notice 'TEST92f FAIL: WAIVED 주문에 결제 성공 사실이 와서 상태가 바뀌거나 DLQ가 안 남음';
  end if;

  if v_ok then
    raise notice 'TEST92f PASS: WAIVED는 paid_at/payment_method를 허용하지 않고, 학생·관리자 취소 거부, 이중 PG 결제는 DLQ(상태·ORDER_PAID 불변)';
  end if;
end $$;

-- TEST 92g: grant_order_access() 실행 권한 — service_role만. anon·authenticated는 직접 부를 수 없다.
do $$
begin
  if not has_function_privilege('anon', 'public.grant_order_access(uuid,uuid,text,text)', 'execute')
     and not has_function_privilege('authenticated', 'public.grant_order_access(uuid,uuid,text,text)', 'execute')
     and has_function_privilege('service_role', 'public.grant_order_access(uuid,uuid,text,text)', 'execute') then
    raise notice 'TEST92g PASS: grant_order_access()는 service_role만 실행 가능(anon·authenticated 불가)';
  else
    raise notice 'TEST92g FAIL: grant_order_access() 실행 권한이 기대와 다름';
  end if;
end $$;

-- =========================================================
-- TEST 93: 폐강 = 학생별 명시 처리 (ADR-0021)
-- 폐강 시작은 OPEN·CLOSED에서 가능하고 결제 전 신청만 자동 정리한다. 결제 완료·부분 환불·결제 면제 수강생은 건드리지 않고
-- ACTION_REQUIRED로 알린다(자동 환불·ORDER_OFFERING_CANCELLED 없음). close_order_without_refund()로 학생별로 종료하고,
-- 승인 대기·승인됨 주문이 0일 때만 폐강이 완료된다.
-- =========================================================
do $$
declare
  v_course uuid;
  v_off uuid;
  v_off_closed uuid;
  v_admin uuid;
  v_u1 uuid; v_u2 uuid; v_u3 uuid; v_u4 uuid; v_u5 uuid; v_u6 uuid;
  v_paid uuid; v_waived uuid; v_pending uuid; v_unpaid uuid; v_partial uuid; v_extra uuid;
  v_ok boolean := true;
  v_actions jsonb;
  v_outbox_before int;
  v_seats_before int;
  v_event uuid;
  v_msg text;
begin
  insert into public.courses (name, category) values ('TEST93강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test93-admin@example.com', 'ADMIN') returning id into v_admin;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test93-1@example.com', 'STUDENT') returning id into v_u1;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test93-2@example.com', 'STUDENT') returning id into v_u2;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test93-3@example.com', 'STUDENT') returning id into v_u3;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test93-4@example.com', 'STUDENT') returning id into v_u4;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test93-5@example.com', 'STUDENT') returning id into v_u5;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test93-6@example.com', 'STUDENT') returning id into v_u6;
  v_off := pg_temp.create_offering_legacy(v_course, 'O', 9, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '2 days', false);

  v_paid := public.create_order(v_u1, v_off, null, null);
  perform public.transition_order(v_paid, v_admin, 'ADMIN', 'APPROVED', 'APPROVED');
  update public.orders set payment_status = 'PAID', paid_at = now(), payment_method = 'CARD' where id = v_paid;
  v_partial := public.create_order(v_u5, v_off, null, null);
  perform public.transition_order(v_partial, v_admin, 'ADMIN', 'APPROVED', 'APPROVED');
  update public.orders set payment_status = 'PARTIALLY_REFUNDED', paid_at = now(), payment_method = 'CARD', refunded_amount = 3000 where id = v_partial;
  v_waived := public.create_order(v_u2, v_off, null, null);
  perform public.transition_order(v_waived, v_admin, 'ADMIN', 'APPROVED', 'APPROVED');
  perform public.grant_order_access(v_waived, v_admin, 'ADMIN', 'TEST93');
  -- v_extra: 결제 완료 주문 하나를 93d의 사유·역할 거부 확인용으로 끝까지 승인 상태로 둔다(93e 직전에 종료).
  v_extra := public.create_order(v_u6, v_off, null, null);
  perform public.transition_order(v_extra, v_admin, 'ADMIN', 'APPROVED', 'APPROVED');
  update public.orders set payment_status = 'PAID', paid_at = now(), payment_method = 'CARD' where id = v_extra;
  v_pending := public.create_order(v_u3, v_off, null, null);
  v_unpaid := public.create_order(v_u4, v_off, null, null);
  perform public.transition_order(v_unpaid, v_admin, 'ADMIN', 'APPROVED', 'APPROVED');

  select count(*) into v_outbox_before from public.outbox_messages where topic = 'ORDER_OFFERING_CANCELLED';

  -- 93a: 폐강 시작 — 결제 전 신청만 자동 정리, 결제·부분 환불·결제 면제는 ACTION_REQUIRED, 상태 불변, 환불 사실 미적재
  select jsonb_object_agg(order_id::text, action) into v_actions from public.cancel_course_offering(v_off, '테스트 폐강', v_admin, 'ADMIN');
  if v_actions->>(v_pending::text) <> 'REJECTED' or v_actions->>(v_unpaid::text) <> 'CANCELLED'
     or v_actions->>(v_paid::text) <> 'ACTION_REQUIRED' or v_actions->>(v_waived::text) <> 'ACTION_REQUIRED' or v_actions->>(v_extra::text) <> 'ACTION_REQUIRED'
     or v_actions->>(v_partial::text) <> 'ACTION_REQUIRED' then
    v_ok := false; raise notice 'TEST93a FAIL: 폐강 시작 반환 action=%', v_actions;
  end if;
  if (select status from public.course_offerings where id = v_off) <> 'CANCELLING'
     or exists (select 1 from public.orders where id in (v_paid, v_waived, v_partial) and status <> 'APPROVED')
     or (select payment_status from public.orders where id = v_paid) <> 'PAID'
     or (select payment_status from public.orders where id = v_waived) <> 'WAIVED'
     or (select payment_status from public.orders where id = v_partial) <> 'PARTIALLY_REFUNDED'
     or (select count(*) from public.outbox_messages where topic = 'ORDER_OFFERING_CANCELLED') <> v_outbox_before then
    v_ok := false; raise notice 'TEST93a FAIL: 결제·면제 수강생 상태가 바뀌었거나 환불 사실이 적재됨';
  end if;

  -- 93b: 처리 안 된 수강생이 있으면 폐강 완료 거부(승인됨 4명)
  begin
    perform public.complete_course_offering_cancel(v_off, v_admin, 'ADMIN');
    v_ok := false; raise notice 'TEST93b FAIL: 처리 안 된 수강생이 있는데 폐강 완료됨';
  exception when others then
    if sqlerrm not like '%남은 4건%' then v_ok := false; raise notice 'TEST93b FAIL: 문구=%', sqlerrm; end if;
  end;

  -- 93c: 환불 없이 종료 — 정상(결제·부분 환불·결제 면제 각각): CANCELLED, 결제 필드 불변, CLOSED 이벤트(사유·모드), ORDER_CLOSED 사실, 좌석 반환
  select remaining_seats into v_seats_before from public.course_offerings where id = v_off;
  v_event := public.close_order_without_refund(v_paid, v_admin, 'ADMIN', ' 정산 완료 ');
  perform public.close_order_without_refund(v_partial, v_admin, 'ADMIN', '부분 환불 후 종료');
  perform public.close_order_without_refund(v_waived, v_admin, 'ADMIN', '직권 부여 종료');
  if exists (select 1 from public.orders where id in (v_paid, v_partial, v_waived) and (status <> 'CANCELLED' or cancelled_at is null))
     or (select payment_status from public.orders where id = v_paid) <> 'PAID'
     or (select paid_at is null from public.orders where id = v_paid)
     or (select refunded_amount from public.orders where id = v_partial) <> 3000
     or (select payment_status from public.orders where id = v_partial) <> 'PARTIALLY_REFUNDED'
     or (select payment_status from public.orders where id = v_waived) <> 'WAIVED' then
    v_ok := false; raise notice 'TEST93c FAIL: 종료 뒤 주문 상태가 기대와 다름';
  end if;
  if not exists (select 1 from public.order_events where id = v_event and order_id = v_paid and event_type = 'CLOSED' and actor = 'ADMIN'
                   and actor_user_id = v_admin and payload->>'reason' = '정산 완료' and payload->>'mode' = 'NO_REFUND' and payload->>'payment_status' = 'PAID')
     or (select count(*) from public.outbox_messages where topic = 'ORDER_CLOSED' and payload->>'order_id' in (v_paid::text, v_partial::text, v_waived::text)) <> 3
     or not exists (select 1 from public.outbox_messages where topic = 'ORDER_CLOSED' and payload->>'order_id' = v_paid::text and payload->>'close_event_id' = v_event::text and payload->>'user_id' = v_u1::text) then
    v_ok := false; raise notice 'TEST93c FAIL: CLOSED 이벤트·ORDER_CLOSED 사실이 기대와 다름';
  end if;
  if (select remaining_seats from public.course_offerings where id = v_off) <> v_seats_before + 3 then
    v_ok := false; raise notice 'TEST93c FAIL: 좌석이 3석 반환되지 않음';
  end if;

  -- 93d: 거부 — 이중 종료, 사유 공백, 매니저 역할, 폐강 중 아닌 개설강의, 없는 주문, 결제 전 정리된 주문(CANCELLED)
  foreach v_msg in array array['twice','blank','manager','not_cancelling','missing','already_cancelled'] loop
    begin
      if v_msg = 'twice' then perform public.close_order_without_refund(v_paid, v_admin, 'ADMIN', '다시');
      elsif v_msg = 'blank' then perform public.close_order_without_refund(v_extra, v_admin, 'ADMIN', '  ');
      elsif v_msg = 'manager' then perform public.close_order_without_refund(v_extra, v_admin, 'MANAGER', '사유');
      elsif v_msg = 'missing' then perform public.close_order_without_refund(gen_random_uuid(), v_admin, 'ADMIN', '사유');
      elsif v_msg = 'already_cancelled' then perform public.close_order_without_refund(v_unpaid, v_admin, 'ADMIN', '사유');
      elsif v_msg = 'not_cancelling' then
        v_off_closed := pg_temp.create_offering_legacy(v_course, 'N', 9, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '2 days', false);
        perform public.close_order_without_refund(
          (select o from (select public.create_order(v_u1, v_off_closed, null, null) as o) x), v_admin, 'ADMIN', '사유');
      end if;
      v_ok := false; raise notice 'TEST93d FAIL: 거부돼야 하는데 통과: %', v_msg;
    exception when others then null;
    end;
  end loop;

  -- 거부된 호출은 v_extra를 바꾸지 않았다. 이제 종료해 처리 대기를 0으로 만든다.
  if (select status from public.orders where id = v_extra) <> 'APPROVED' then
    v_ok := false; raise notice 'TEST93d FAIL: 거부된 호출이 주문을 바꿈';
  end if;
  perform public.close_order_without_refund(v_extra, v_admin, 'ADMIN', '마지막 학생 종료');

  -- 93e: 모두 처리됨(승인 대기·승인됨 0) → 폐강 완료 가능(결제 상태가 PAID여도)
  perform public.complete_course_offering_cancel(v_off, v_admin, 'ADMIN');
  if (select status from public.course_offerings where id = v_off) <> 'CANCELLED' then
    v_ok := false; raise notice 'TEST93e FAIL: 처리가 끝났는데 폐강 완료가 안 됨';
  end if;

  -- 93f: 마감(CLOSED) 개설강의도 폐강 시작 가능, 폐강 중·완료는 거부
  v_off_closed := pg_temp.create_offering_legacy(v_course, 'C', 9, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '2 days', false);
  update public.course_offerings set status = 'CLOSED', status_reason = '마감', status_changed_by = v_admin, status_changed_at = clock_timestamp() where id = v_off_closed;
  perform public.cancel_course_offering(v_off_closed, 'CLOSED에서 폐강', v_admin, 'ADMIN');
  if (select status from public.course_offerings where id = v_off_closed) <> 'CANCELLING' then
    v_ok := false; raise notice 'TEST93f FAIL: 마감 상태에서 폐강 시작이 안 됨';
  end if;
  begin
    perform public.cancel_course_offering(v_off_closed, '다시', v_admin, 'ADMIN');
    v_ok := false; raise notice 'TEST93f FAIL: 폐강 중인 개설강의를 다시 폐강함';
  exception when others then null;
  end;
  begin
    perform public.cancel_course_offering(v_off, '다시', v_admin, 'ADMIN');
    v_ok := false; raise notice 'TEST93f FAIL: 폐강 완료된 개설강의를 다시 폐강함';
  exception when others then null;
  end;

  -- 93g: 권한 — service_role만
  if has_function_privilege('anon', 'public.close_order_without_refund(uuid,uuid,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.close_order_without_refund(uuid,uuid,text,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.close_order_without_refund(uuid,uuid,text,text,text)', 'execute') then
    v_ok := false; raise notice 'TEST93g FAIL: close_order_without_refund() 실행 권한이 기대와 다름';
  end if;

  if v_ok then
    raise notice 'TEST93 PASS: 폐강 시작(OPEN·CLOSED)은 결제 전만 정리·결제/부분환불/면제는 ACTION_REQUIRED·상태 불변·자동 환불 없음, 환불 없이 종료(CLOSED 이벤트·ORDER_CLOSED·좌석 반환·결제 필드 불변), 미처리가 있으면 완료 거부·0이면 완료, 권한 service_role만';
  end if;
end $$;

-- =========================================================
-- TEST 94: 강의 종료 = 전부 회수, 그리고 종료 취소 (ADR-0022)
-- end_course_offering(): 종강일이 지난(또는 종강일 없이 개강한) 강의만 종료 — 결제 전 신청 정리 + 승인된 주문마다 ORDER_COURSE_ENDED,
-- 주문·결제 상태 불변. reopen_course_offering(): 종료 기록을 비우고 manual_end를 켜며 승인된 주문마다 ACCESS_GRANTED+ORDER_ACCESS_GRANTED.
-- =========================================================
do $$
declare
  v_course uuid;
  v_a uuid;
  v_admin uuid;
  v_u1 uuid; v_u2 uuid; v_u3 uuid; v_u4 uuid; v_u5 uuid;
  v_paid uuid; v_partial uuid; v_waived uuid; v_pending uuid; v_unpaid uuid;
  v_ok boolean := true;
  v_n integer;
  v_seats_before integer;
  v_case text;
  v_b uuid;
  v_off uuid;
  v_changes jsonb;
begin
  insert into public.courses (name, category) values ('TEST94강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test94-admin@example.com', 'ADMIN') returning id into v_admin;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test94-1@example.com', 'STUDENT') returning id into v_u1;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test94-2@example.com', 'STUDENT') returning id into v_u2;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test94-3@example.com', 'STUDENT') returning id into v_u3;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test94-4@example.com', 'STUDENT') returning id into v_u4;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test94-5@example.com', 'STUDENT') returning id into v_u5;
  v_a := pg_temp.create_offering_legacy(v_course, 'E', 9, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '2 days', false);

  v_paid := public.create_order(v_u1, v_a, null, null);
  perform public.transition_order(v_paid, v_admin, 'ADMIN', 'APPROVED', 'APPROVED');
  update public.orders set payment_status = 'PAID', paid_at = now(), payment_method = 'CARD' where id = v_paid;
  v_partial := public.create_order(v_u2, v_a, null, null);
  perform public.transition_order(v_partial, v_admin, 'ADMIN', 'APPROVED', 'APPROVED');
  update public.orders set payment_status = 'PARTIALLY_REFUNDED', paid_at = now(), payment_method = 'CARD', refunded_amount = 2000 where id = v_partial;
  v_waived := public.create_order(v_u3, v_a, null, null);
  perform public.transition_order(v_waived, v_admin, 'ADMIN', 'APPROVED', 'APPROVED');
  perform public.grant_order_access(v_waived, v_admin, 'ADMIN', 'TEST94');
  v_pending := public.create_order(v_u4, v_a, null, null);
  v_unpaid := public.create_order(v_u5, v_a, null, null);
  perform public.transition_order(v_unpaid, v_admin, 'ADMIN', 'APPROVED', 'APPROVED');

  -- 시간을 흘려 보낸다: 모집 10일 전, 개강 5일 전, 종강 1일 전 (직접 UPDATE — 함수 경로의 동결 규칙은 update_course_offering에만 있다)
  update public.course_offerings set recruit_opens_at = now() - interval '10 days', opens_at = now() - interval '5 days', ends_at = now() - interval '1 day' where id = v_a;
  select remaining_seats into v_seats_before from public.course_offerings where id = v_a;

  -- 94a: 자동(SYSTEM) 종료 — 승인된 3명(결제·부분 환불·결제 면제)에 회수 사실, 결제 전 2명은 정리, 주문·결제 상태 불변, 좌석 2석 반환
  v_n := public.end_course_offering(v_a, null, 'SYSTEM', null);
  if v_n <> 3 then v_ok := false; raise notice 'TEST94a FAIL: 회수 사실 건수=%', v_n; end if;
  if not exists (select 1 from public.course_offerings where id = v_a and ended_at is not null and ended_by is null and end_note = '기간 만료 자동 종료' and status = 'OPEN') then
    v_ok := false; raise notice 'TEST94a FAIL: 종료 기록이 기대와 다름';
  end if;
  if (select status from public.orders where id = v_pending) <> 'REJECTED' or (select status from public.orders where id = v_unpaid) <> 'CANCELLED'
     or exists (select 1 from public.orders where id in (v_paid, v_partial, v_waived) and status <> 'APPROVED')
     or (select payment_status from public.orders where id = v_paid) <> 'PAID'
     or (select payment_status from public.orders where id = v_partial) <> 'PARTIALLY_REFUNDED'
     or (select payment_status from public.orders where id = v_waived) <> 'WAIVED' then
    v_ok := false; raise notice 'TEST94a FAIL: 주문 상태가 기대와 다름';
  end if;
  if (select remaining_seats from public.course_offerings where id = v_a) <> v_seats_before + 2 then
    v_ok := false; raise notice 'TEST94a FAIL: 결제 전 신청의 좌석 2석이 반환되지 않음';
  end if;
  if (select count(*) from public.outbox_messages where topic = 'ORDER_COURSE_ENDED' and payload->>'offering_id' = v_a::text) <> 3
     or exists (select 1 from public.outbox_messages where topic = 'ORDER_COURSE_ENDED' and payload->>'offering_id' = v_a::text and payload->>'order_id' not in (v_paid::text, v_partial::text, v_waived::text)) then
    v_ok := false; raise notice 'TEST94a FAIL: ORDER_COURSE_ENDED 사실이 기대와 다름';
  end if;

  -- 94b: 이미 종료 / 종료된 강의는 폐강 불가
  begin
    perform public.end_course_offering(v_a, v_admin, 'ADMIN', '다시');
    v_ok := false; raise notice 'TEST94b FAIL: 이미 종료된 강의를 다시 종료함';
  exception when others then null;
  end;
  begin
    perform public.cancel_course_offering(v_a, '종료 뒤 폐강', v_admin, 'ADMIN');
    v_ok := false; raise notice 'TEST94b FAIL: 종료된 강의를 폐강함';
  exception when others then
    if sqlerrm not like '%이미 종료된 개설강의는 폐강할 수 없습니다%' then v_ok := false; raise notice 'TEST94b FAIL: 문구=%', sqlerrm; end if;
  end;

  -- 94c: 종료 거부 케이스(각각 알맞은 상태의 새 강의로) + 종강일 없는 강의의 수동 종료만 허용
  foreach v_case in array array['blank_note','manager','before_end','before_open','system_no_end_date','cancelling','deleted','missing'] loop
    v_b := pg_temp.create_offering_legacy(v_course, 'X-' || v_case, 9, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '2 days', false);
    if v_case in ('blank_note','manager','cancelling','deleted') then
      update public.course_offerings set recruit_opens_at = now() - interval '10 days', opens_at = now() - interval '5 days', ends_at = now() - interval '1 day' where id = v_b;
    elsif v_case = 'before_end' then
      update public.course_offerings set recruit_opens_at = now() - interval '10 days', opens_at = now() - interval '5 days' where id = v_b;
    elsif v_case = 'system_no_end_date' then
      update public.course_offerings set recruit_opens_at = now() - interval '10 days', opens_at = now() - interval '5 days', ends_at = null where id = v_b;
    end if;
    if v_case = 'cancelling' then
      update public.course_offerings set status = 'CANCELLING', status_reason = '테스트', status_changed_by = v_admin, status_changed_at = clock_timestamp() where id = v_b;
    elsif v_case = 'deleted' then
      update public.course_offerings set deleted_at = now(), deleted_reason = '테스트', deleted_by = v_admin where id = v_b;
    end if;
    begin
      if v_case = 'blank_note' then perform public.end_course_offering(v_b, v_admin, 'ADMIN', '  ');
      elsif v_case = 'manager' then perform public.end_course_offering(v_b, v_admin, 'MANAGER', '비고');
      elsif v_case = 'missing' then perform public.end_course_offering(gen_random_uuid(), v_admin, 'ADMIN', '비고');
      elsif v_case = 'system_no_end_date' then perform public.end_course_offering(v_b, null, 'SYSTEM', null);
      else perform public.end_course_offering(v_b, v_admin, 'ADMIN', '비고');
      end if;
      v_ok := false; raise notice 'TEST94c FAIL: 거부돼야 하는데 통과: %', v_case;
    exception when others then null;
    end;
    if v_case = 'system_no_end_date' then
      -- 같은 강의를 관리자가 수동으로 종료하는 것은 된다(종강일 없는 강의는 수동 종료만)
      perform public.end_course_offering(v_b, v_admin, 'ADMIN', '종강일 없는 강의 수동 종료');
      if not exists (select 1 from public.course_offerings where id = v_b and ended_at is not null and ended_by = v_admin and end_note = '종강일 없는 강의 수동 종료') then
        v_ok := false; raise notice 'TEST94c FAIL: 종강일 없는 강의의 수동 종료 기록이 기대와 다름';
      end if;
    end if;
  end loop;

  -- 94d: 종료 취소 — 종료 뒤 환불로 취소된 주문(partial)은 대상 아님, 나머지 승인된 2건에 재부여 사실
  update public.orders set status = 'CANCELLED', cancelled_at = now() where id = v_partial;
  v_n := public.reopen_course_offering(v_a, v_admin, 'ADMIN', ' 종강일 입력 오류 ');
  if v_n <> 2 then v_ok := false; raise notice 'TEST94d FAIL: 재부여 사실 건수=%', v_n; end if;
  if not exists (select 1 from public.course_offerings where id = v_a and ended_at is null and ended_by is null and end_note is null and manual_end = true) then
    v_ok := false; raise notice 'TEST94d FAIL: 종료 취소 뒤 강의 기록이 기대와 다름';
  end if;
  if (select count(*) from public.order_events where event_type = 'ACCESS_GRANTED' and payload->>'mode' = 'END_CANCELLED' and order_id in (v_paid, v_waived, v_partial)) <> 2
     or exists (select 1 from public.order_events where event_type = 'ACCESS_GRANTED' and payload->>'mode' = 'END_CANCELLED' and order_id in (v_paid, v_waived)
                  and (actor <> 'ADMIN' or actor_user_id <> v_admin or payload->>'reason' <> '종강일 입력 오류' or payload->'previous_end'->>'end_note' <> '기간 만료 자동 종료')) then
    v_ok := false; raise notice 'TEST94d FAIL: 종료 취소 이벤트(사유·이전 종료 기록)가 기대와 다름';
  end if;
  if (select count(*) from public.outbox_messages om join public.order_events oe on oe.id::text = om.payload->>'grant_event_id'
        where om.topic = 'ORDER_ACCESS_GRANTED' and oe.payload->>'mode' = 'END_CANCELLED' and om.payload->'grants' = '[{"type":"COURSE_ACCESS"}]'::jsonb) <> 2 then
    v_ok := false; raise notice 'TEST94d FAIL: ORDER_ACCESS_GRANTED 재부여 사실이 기대와 다름';
  end if;
  if (select payment_status from public.orders where id = v_paid) <> 'PAID' or (select payment_status from public.orders where id = v_waived) <> 'WAIVED' then
    v_ok := false; raise notice 'TEST94d FAIL: 종료 취소가 결제 상태를 바꿈';
  end if;
  -- 종료 취소 뒤에는 다시 종료·폐강 가능(기록이 비었으므로), manual_end가 켜져 있다
  perform public.end_course_offering(v_a, v_admin, 'ADMIN', '다시 종료');
  if (select end_note from public.course_offerings where id = v_a) <> '다시 종료' then v_ok := false; raise notice 'TEST94d FAIL: 재종료 안 됨'; end if;

  -- 94e: 종료 취소 거부 — 종료 안 된 강의, 사유 공백, 행위자 없음, 폐강 중
  v_b := pg_temp.create_offering_legacy(v_course, 'R', 9, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '2 days', false);
  foreach v_case in array array['not_ended','blank_reason','no_actor','cancelling'] loop
    begin
      if v_case = 'not_ended' then perform public.reopen_course_offering(v_b, v_admin, 'ADMIN', '사유');
      elsif v_case = 'blank_reason' then perform public.reopen_course_offering(v_a, v_admin, 'ADMIN', '  ');
      elsif v_case = 'no_actor' then perform public.reopen_course_offering(v_a, null, 'ADMIN', '사유');
      elsif v_case = 'cancelling' then
        update public.course_offerings set status = 'CANCELLING', status_reason = '테스트', status_changed_by = v_admin, status_changed_at = clock_timestamp(), ended_at = now(), end_note = '테스트 종료' where id = v_b;
        perform public.reopen_course_offering(v_b, v_admin, 'ADMIN', '사유');
      end if;
      v_ok := false; raise notice 'TEST94e FAIL: 거부돼야 하는데 통과: %', v_case;
    exception when others then null;
    end;
  end loop;

  -- 94f: update_course_offering의 manual_end — 개강 뒤에도 토글 가능, boolean 아니면 거부, 같은 값이면 「변경된 값이 없습니다」, 다른 키 회귀
  v_off := pg_temp.create_offering_legacy(v_course, 'M', 9, 10000, null, false, now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, null, null, null, now() - interval '2 days', false);
  update public.course_offerings set recruit_opens_at = now() - interval '10 days', opens_at = now() - interval '5 days' where id = v_off;
  v_changes := public.update_course_offering(v_off, v_admin, 'ADMIN', 'manual_end 켜기', '{"manual_end":true}'::jsonb);
  if v_changes->'manual_end' is distinct from jsonb_build_object('from', false, 'to', true) or not (select manual_end from public.course_offerings where id = v_off) then
    v_ok := false; raise notice 'TEST94f FAIL: manual_end 토글 결과=%', v_changes;
  end if;
  begin
    perform public.update_course_offering(v_off, v_admin, 'ADMIN', '사유', '{"manual_end":"yes"}'::jsonb);
    v_ok := false; raise notice 'TEST94f FAIL: boolean이 아닌 manual_end를 받아들임';
  exception when others then null;
  end;
  begin
    perform public.update_course_offering(v_off, v_admin, 'ADMIN', '사유', '{"manual_end":true}'::jsonb);
    v_ok := false; raise notice 'TEST94f FAIL: 같은 값인데 거부되지 않음';
  exception when others then
    if sqlerrm not like '%변경된 값이 없습니다%' then v_ok := false; raise notice 'TEST94f FAIL: 문구=%', sqlerrm; end if;
  end;
  begin
    perform public.update_course_offering(v_off, v_admin, 'ADMIN', '사유', '{"price":20000}'::jsonb);
    v_ok := false; raise notice 'TEST94f FAIL: 개강 뒤 가격 수정이 허용됨(동결 회귀)';
  exception when others then null;
  end;

  -- 94g: CHECK(종료에는 비고 필수), 권한(service_role만)
  begin
    update public.course_offerings set ended_at = now() where id = v_off;
    v_ok := false; raise notice 'TEST94g FAIL: 비고 없는 종료 기록이 저장됨';
  exception when check_violation then null;
  end;
  if has_function_privilege('anon', 'public.end_course_offering(uuid,uuid,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.end_course_offering(uuid,uuid,text,text)', 'execute')
     or has_function_privilege('anon', 'public.reopen_course_offering(uuid,uuid,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.reopen_course_offering(uuid,uuid,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.settle_unpaid_orders_of_offering(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.end_course_offering(uuid,uuid,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.reopen_course_offering(uuid,uuid,text,text)', 'execute') then
    v_ok := false; raise notice 'TEST94g FAIL: 실행 권한이 기대와 다름';
  end if;

  if v_ok then
    raise notice 'TEST94 PASS: 종료(자동/수동) = 기록+결제 전 정리+승인된 주문마다 회수 사실·주문/결제 상태 불변, 거부 8가지, 종료 후 폐강 불가, 종료 취소 = 기록 비움+manual_end+재부여 사실(취소된 주문 제외), manual_end 토글, CHECK, 권한';
  end if;
end $$;

-- =========================================================
-- TEST 95: 부분 환불 = 수강 포기 사실 기록 (ADR-0026)
-- 원인(cause)은 결제 모듈이 원장에서 정해 PAYMENT_REFUNDED 사실에 싣고, 주문 모듈은 CANCELLED 사건 payload에 기록한다.
-- =========================================================
do $$
declare
  v_course uuid;
  v_off uuid;
  v_ok boolean := true;
  v_u uuid; v_o uuid; v_o2 uuid; v_o3 uuid; v_o4 uuid;
  v_admin uuid;
  v_payload jsonb;
  v_n integer;
  v_status text; v_ps text; v_amt integer;
  v_dlq integer;
begin
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test95admin@example.com', 'ADMIN') returning id into v_admin;
  insert into public.courses (name, category) values ('TEST95강의', 'TEST') returning id into v_course;
  v_off := pg_temp.create_offering_legacy(
    v_course, null, 10, 100000, null, false,
    now() + interval '1 day', now() + interval '31 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null, now() - interval '2 days');

  -- (a) 관리자 환불(REFUND_REQUESTED source=ADMIN) 뒤 부분 환불 → cause ADMIN_REFUND, 사건 payload에 사실
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test95a@example.com', 'STUDENT') returning id into v_u;
  v_o := public.create_order(v_u, v_off, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_o;
  perform public.record_payment_event('MOCK', 'evt-t95a-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_o, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  perform public.begin_refund_request(v_o, 'req-t95a', 40000, '수강생 요청', 'ADMIN', null, null, false, v_admin);
  perform public.record_payment_event('MOCK', 'evt-t95a-ref', 'REFUNDED', 40000, 'KRW', v_o, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  select payload into v_payload from public.order_events where order_id = v_o and event_type = 'CANCELLED';
  select status, payment_status, refunded_amount into v_status, v_ps, v_amt from public.orders where id = v_o;
  if not (v_status = 'CANCELLED' and v_ps = 'PARTIALLY_REFUNDED' and v_amt = 40000
          and v_payload->>'cause' = 'ADMIN_REFUND' and v_payload->>'reason' = '수강생 요청'
          and (v_payload->>'refund_amount')::int = 40000 and (v_payload->>'refunded_total')::int = 40000
          and (v_payload->>'final_amount')::int = 100000 and (v_payload->>'partial')::boolean = true
          and v_payload->>'first_class_date' is not null
          and (v_payload->>'total_sessions')::int = 1 and (v_payload->>'past_sessions')::int = 0) then
    v_ok := false; raise notice 'TEST95a FAIL: status=%, ps=%, amt=%, payload=%', v_status, v_ps, v_amt, v_payload;
  end if;

  -- (b) 남은 금액 추가 환불 → DLQ 없음, 누적·REFUNDED, 사건·ORDER_REFUNDED 중복 없음
  perform public.begin_refund_request(v_o, 'req-t95b', null, '잔액 환불', 'ADMIN', null, null, false, v_admin);
  perform public.record_payment_event('MOCK', 'evt-t95b-ref', 'REFUNDED', 60000, 'KRW', v_o, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  select payment_status, refunded_amount into v_ps, v_amt from public.orders where id = v_o;
  select count(*) into v_n from public.order_events where order_id = v_o and event_type = 'CANCELLED';
  select count(*) into v_dlq from public.dead_letters where payload->>'order_id' = v_o::text;
  if not (v_ps = 'REFUNDED' and v_amt = 100000 and v_n = 1 and v_dlq = 0
          and (select count(*) from public.outbox_messages where topic = 'ORDER_REFUNDED' and payload->>'order_id' = v_o::text) = 1) then
    v_ok := false; raise notice 'TEST95b FAIL: ps=%, amt=%, 사건=%, dlq=%', v_ps, v_amt, v_n, v_dlq;
  end if;

  -- (c) 폐강 환불(source=OFFERING_CANCEL) → cause OFFERING_CANCELLED
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test95c@example.com', 'STUDENT') returning id into v_u;
  v_o2 := public.create_order(v_u, v_off, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_o2;
  perform public.record_payment_event('MOCK', 'evt-t95c-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_o2, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  perform public.begin_refund_request(v_o2, 'req-t95c', null, '폐강', 'OFFERING_CANCEL', null, null, false, v_admin);
  perform public.record_payment_event('MOCK', 'evt-t95c-ref', 'REFUNDED', 100000, 'KRW', v_o2, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  select payload into v_payload from public.order_events where order_id = v_o2 and event_type = 'CANCELLED';
  if not (v_payload->>'cause' = 'OFFERING_CANCELLED' and (v_payload->>'partial')::boolean = false) then
    v_ok := false; raise notice 'TEST95c FAIL: payload=%', v_payload;
  end if;

  -- (d) 요청 없이 들어온 PG 취소 → EXTERNAL_REFUND, 종료는 동일
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test95d@example.com', 'STUDENT') returning id into v_u;
  v_o3 := public.create_order(v_u, v_off, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_o3;
  perform public.record_payment_event('MOCK', 'evt-t95d-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_o3, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  perform public.record_payment_event('MOCK', 'evt-t95d-ref', 'REFUNDED', 25000, 'KRW', v_o3, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  select payload into v_payload from public.order_events where order_id = v_o3 and event_type = 'CANCELLED';
  select status into v_status from public.orders where id = v_o3;
  if not (v_status = 'CANCELLED' and v_payload->>'cause' = 'EXTERNAL_REFUND' and v_payload->'reason' = 'null'::jsonb) then
    v_ok := false; raise notice 'TEST95d FAIL: status=%, payload=%', v_status, v_payload;
  end if;

  -- (e) PG 외 환불 반영(source ADMIN_MANUAL_REFUND) → cause ADMIN_REFUND, reason은 메타데이터에서
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test95e@example.com', 'STUDENT') returning id into v_u;
  v_o4 := public.create_order(v_u, v_off, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_o4;
  perform public.record_payment_event('MOCK', 'evt-t95e-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_o4, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  perform public.record_payment_event('MANUAL', 'evt-t95e-ref', 'REFUNDED', 10000, 'KRW', v_o4, 'BANK_TRANSFER',
    '{"reason":"계좌이체 환불","source":"ADMIN_MANUAL_REFUND"}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  select payload into v_payload from public.order_events where order_id = v_o4 and event_type = 'CANCELLED';
  if not (v_payload->>'cause' = 'ADMIN_REFUND' and v_payload->>'reason' = '계좌이체 환불') then
    v_ok := false; raise notice 'TEST95e FAIL: payload=%', v_payload;
  end if;

  -- (f) 같은 환불 사실이 재배달돼도 멱등(누적 중복 없음)
  perform pg_temp.redeliver_payment_fact('PAYMENT_REFUNDED', (select id from public.payment_events where provider = 'MANUAL' and provider_event_id = 'evt-t95e-ref'));
  select refunded_amount into v_amt from public.orders where id = v_o4;
  if v_amt <> 10000 then v_ok := false; raise notice 'TEST95f FAIL: 재배달 후 refunded_amount=%', v_amt; end if;

  -- (g) 탈퇴 등으로 취소된 PAID 주문에 환불이 오면 지금처럼 DLQ(금액 미반영)
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test95g@example.com', 'STUDENT') returning id into v_u;
  v_o := public.create_order(v_u, v_off, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_o;
  perform public.record_payment_event('MOCK', 'evt-t95g-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_o, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  update public.orders set status = 'CANCELLED', cancelled_at = now() where id = v_o;
  perform public.record_payment_event('MOCK', 'evt-t95g-ref', 'REFUNDED', 30000, 'KRW', v_o, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  select payment_status, refunded_amount into v_ps, v_amt from public.orders where id = v_o;
  select count(*) into v_dlq from public.dead_letters where payload->>'handler' = 'on_payment_refunded' and payload->>'order_id' = v_o::text;
  if not (v_ps = 'PAID' and v_amt = 0 and v_dlq = 1) then
    v_ok := false; raise notice 'TEST95g FAIL: ps=%, amt=%, dlq=%', v_ps, v_amt, v_dlq;
  end if;

  -- (h) 구버전 사실(cause·reason 없음)도 동작: 5인자 호출
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test95h@example.com', 'STUDENT') returning id into v_u;
  v_o := public.create_order(v_u, v_off, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_o;
  perform public.record_payment_event('MOCK', 'evt-t95h-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_o, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  perform public.on_payment_refunded(gen_random_uuid(), v_o, 'MOCK', 5000, 'KRW');
  select payload into v_payload from public.order_events where order_id = v_o and event_type = 'CANCELLED';
  if not (v_payload->'cause' = 'null'::jsonb and (select status from public.orders where id = v_o) = 'CANCELLED') then
    v_ok := false; raise notice 'TEST95h FAIL: payload=%', v_payload;
  end if;

  if v_ok then
    raise notice 'TEST95 PASS: 부분 환불 = 수강 포기 사실 기록 — 원인 4경로(ADMIN/OFFERING_CANCEL/외부/PG 외)·payload 사실·추가 환불 누적(중복 없음)·재배달 멱등·탈퇴 DLQ 유지·구버전 호환';
  end if;
end $$;

-- =========================================================
-- TEST 101: 수강생이 있는 수업의 일정 변경 · 안내 · 응답 · 제외
-- 이 시험의 단정은 NULL-안전하게 쓴다(`coalesce(조건, false)` 또는 `is not distinct from`) — `NOT (… NULL …)`이 실패 알림 없이 통과하던 약점(S-5 발견) 방지.
-- =========================================================
do $$
declare
  v_ok boolean := true;
  v_course uuid; v_off uuid; v_started uuid;
  v_admin uuid; v_s1 uuid; v_s2 uuid; v_s3 uuid; v_s4 uuid; v_s5 uuid; v_other uuid;
  v_o1 uuid; v_o2 uuid; v_o3 uuid; v_o4 uuid; v_o5 uuid;
  v_sess1 uuid; v_sess2 uuid;
  v_res jsonb; v_res2 jsonb;
  v_n1 uuid; v_n2 uuid; v_n3 uuid; v_n4 uuid; v_n5 uuid; v_n1b uuid;
  v_ev uuid; v_payload jsonb; v_cnt integer;
  v_seats_before integer; v_seats_after integer;
  v_open timestamptz; v_end timestamptz;
begin
  insert into public.courses (name, category) values ('TEST101강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test101-admin@example.com', 'ADMIN') returning id into v_admin;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test101-s1@example.com', 'STUDENT') returning id into v_s1;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test101-s2@example.com', 'STUDENT') returning id into v_s2;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test101-s3@example.com', 'STUDENT') returning id into v_s3;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test101-s4@example.com', 'STUDENT') returning id into v_s4;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test101-s5@example.com', 'STUDENT') returning id into v_s5;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test101-other@example.com', 'STUDENT') returning id into v_other;

  v_off := public.create_course_offering(v_course, 'C', 9, 100000, null, '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, now() - interval '2 days',
    '[{"date":"2040-03-05","start":"03:10","end":"03:40"},{"date":"2040-03-12","start":"03:10","end":"03:40"}]'::jsonb,
    v_admin, 'ADMIN');
  select id into v_sess1 from public.course_sessions where course_offering_id = v_off and session_date = date '2040-03-05';
  select id into v_sess2 from public.course_sessions where course_offering_id = v_off and session_date = date '2040-03-12';

  -- 주문: o1 카드 결제완료, o2 승인됨 미결제, o3 무료(WAIVED), o4 승인 대기, o5 승인됨 미결제(동의할 사람)
  v_o1 := public.create_order(v_s1, v_off, null, null::uuid[], '2026-10-v1');
  v_o2 := public.create_order(v_s2, v_off, null, null::uuid[], '2026-10-v1');
  v_o3 := public.create_order(v_s3, v_off, null, null::uuid[], '2026-10-v1');
  v_o4 := public.create_order(v_s4, v_off, null, null::uuid[], '2026-10-v1');
  v_o5 := public.create_order(v_s5, v_off, null, null::uuid[], '2026-10-v1');
  update public.orders set status = 'APPROVED', approved_at = now(), payment_status = 'PAID', paid_at = now(), payment_method = 'CARD' where id = v_o1;
  update public.orders set status = 'APPROVED', approved_at = now() where id in (v_o2, v_o5);
  update public.orders set status = 'APPROVED', approved_at = now(), payment_status = 'WAIVED' where id = v_o3;

  -- (a) 거부 사유: 관리자 아님 / 사유 없음 / 변경 없음 / 남의 회차 / 모양 오류
  begin perform public.apply_schedule_change(v_off, v_admin, 'STUDENT', '권한', array[v_sess2], '[]'::jsonb);
    v_ok := false; raise notice 'TEST101a FAIL: 관리자가 아닌데 변경됨';
  exception when others then if coalesce(sqlerrm not like '%관리자만 일정을 변경%', true) then v_ok := false; raise notice 'TEST101a FAIL: 권한 문구 — %', sqlerrm; end if; end;
  begin perform public.apply_schedule_change(v_off, v_admin, 'ADMIN', '  ', array[v_sess2], '[]'::jsonb);
    v_ok := false; raise notice 'TEST101a FAIL: 사유 없이 변경됨';
  exception when others then if coalesce(sqlerrm not like '%변경 사유를 입력%', true) then v_ok := false; raise notice 'TEST101a FAIL: 사유 문구 — %', sqlerrm; end if; end;
  begin perform public.apply_schedule_change(v_off, v_admin, 'ADMIN', '변경 없음', '{}'::uuid[], '[]'::jsonb);
    v_ok := false; raise notice 'TEST101a FAIL: 빈 변경이 허용됨';
  exception when others then if coalesce(sqlerrm not like '%변경할 내용이 없습니다%', true) then v_ok := false; raise notice 'TEST101a FAIL: 빈 변경 문구 — %', sqlerrm; end if; end;
  begin perform public.apply_schedule_change(v_off, v_admin, 'ADMIN', '남의 회차', array[gen_random_uuid()], '[]'::jsonb);
    v_ok := false; raise notice 'TEST101a FAIL: 없는 회차가 취소됨';
  exception when others then if coalesce(sqlerrm not like '%활성 회차가 아닙니다%', true) then v_ok := false; raise notice 'TEST101a FAIL: 회차 문구 — %', sqlerrm; end if; end;
  begin perform public.apply_schedule_change(v_off, v_admin, 'ADMIN', '모양', '{}'::uuid[], '[{"date":"2040-03-19"}]'::jsonb);
    v_ok := false; raise notice 'TEST101a FAIL: 모양 오류가 허용됨';
  exception when others then if coalesce(sqlerrm not like '%객체여야%', true) then v_ok := false; raise notice 'TEST101a FAIL: 모양 문구 — %', sqlerrm; end if; end;
  -- 모든 회차를 취소하고 추가가 없으면 활성 회차 0개 → 거부(그리고 트랜잭션 로컬 설정이 새지 않아 보호 트리거가 다시 동작해야 한다)
  begin perform public.apply_schedule_change(v_off, v_admin, 'ADMIN', '전부 취소', array[v_sess1, v_sess2], '[]'::jsonb);
    v_ok := false; raise notice 'TEST101a FAIL: 활성 회차 0개가 허용됨';
  exception when others then if coalesce(sqlerrm not like '%활성 회차가 1개 이상%', true) then v_ok := false; raise notice 'TEST101a FAIL: 0개 문구 — %', sqlerrm; end if; end;
  select count(*) into v_cnt from public.course_sessions where course_offering_id = v_off and deactivated_at is null;
  if v_cnt is distinct from 2 then v_ok := false; raise notice 'TEST101a FAIL: 거부된 변경이 회차를 바꿈(활성 %)', v_cnt; end if;

  -- (b) 변경: 둘째 날짜를 다른 날로 옮김 → 안내 5건(승인 대기·승인됨 전원), 회차·개강·종료 재계산
  v_res := public.apply_schedule_change(v_off, v_admin, 'ADMIN', '강사 사정으로 날짜 변경', array[v_sess2],
    '[{"date":"2040-03-19","start":"03:10","end":"03:40"}]'::jsonb);
  if coalesce(jsonb_array_length(v_res->'notified'), -1) is distinct from 5 then
    v_ok := false; raise notice 'TEST101b FAIL: 안내 수 %', jsonb_array_length(v_res->'notified');
  end if;
  select opens_at, ends_at into v_open, v_end from public.course_offerings where id = v_off;
  if (v_open is distinct from timestamptz '2040-03-05 03:10+09') or (v_end is distinct from timestamptz '2040-03-19 03:40+09') then
    v_ok := false; raise notice 'TEST101b FAIL: opens_at=%, ends_at=%', v_open, v_end;
  end if;
  if coalesce((select deactivated_reason from public.course_sessions where id = v_sess2), '') is distinct from '강사 사정으로 날짜 변경' then
    v_ok := false; raise notice 'TEST101b FAIL: 취소된 회차 사유';
  end if;
  select id, payload into v_n1, v_payload from public.order_events where order_id = v_o1 and event_type = 'SCHEDULE_CHANGE_NOTICE';
  if not coalesce(
       (v_payload->>'reason') = '강사 사정으로 날짜 변경'
       and jsonb_array_length(v_payload->'before') = 2 and jsonb_array_length(v_payload->'after') = 2
       and (v_payload->'before'->1->>'date') = '2040-03-12' and (v_payload->'after'->1->>'date') = '2040-03-19'
       and (v_payload->>'change_id') = (v_res->>'change_id'), false) then
    v_ok := false; raise notice 'TEST101b FAIL: 안내 payload %', v_payload;
  end if;
  select id into v_n2 from public.order_events where order_id = v_o2 and event_type = 'SCHEDULE_CHANGE_NOTICE';
  select id into v_n3 from public.order_events where order_id = v_o3 and event_type = 'SCHEDULE_CHANGE_NOTICE';
  select id into v_n4 from public.order_events where order_id = v_o4 and event_type = 'SCHEDULE_CHANGE_NOTICE';
  select id into v_n5 from public.order_events where order_id = v_o5 and event_type = 'SCHEDULE_CHANGE_NOTICE';
  -- 마지막 활성 회차 보호는 변경 뒤에도 그대로(트랜잭션 로컬 설정이 새지 않았다)
  select id into v_sess2 from public.course_sessions where course_offering_id = v_off and session_date = date '2040-03-19';
  update public.course_sessions set deactivated_at = now(), deactivated_reason = 'TEST101' where id = v_sess1; -- 둘 중 하나는 가능
  begin update public.course_sessions set deactivated_at = now(), deactivated_reason = 'TEST101 마지막' where id = v_sess2;
    v_ok := false; raise notice 'TEST101b FAIL: 변경 뒤 마지막 활성 회차 보호가 꺼져 있음';
  exception when others then if coalesce(sqlerrm not like '%마지막 남은 회차%', true) then v_ok := false; raise notice 'TEST101b FAIL: 보호 문구 — %', sqlerrm; end if; end;
  update public.course_sessions set deactivated_at = null, deactivated_reason = null where id = v_sess1; -- 원복

  -- (c) [A-6] 응답 수집 폐지: 동의/미동의 절차 대신 안내(NOTIFIED) 및 학생 환불 신청 또는 관리자 제외 처리

  -- (d) 제외 처리 거부: 관리자 아님 / 사유 없음 / 안내 없는 주문 / 결제 완료 건(환불 경로)
  begin perform public.exclude_order_for_schedule_change(v_o2, v_admin, 'MANAGER', '권한');
    v_ok := false; raise notice 'TEST101d FAIL: 관리자 아닌데 제외됨';
  exception when others then if coalesce(sqlerrm not like '%관리자만%', true) then v_ok := false; raise notice 'TEST101d FAIL: 권한 문구 — %', sqlerrm; end if; end;
  begin perform public.exclude_order_for_schedule_change(v_o2, v_admin, 'ADMIN', '   ');
    v_ok := false; raise notice 'TEST101d FAIL: 사유 없이 제외됨';
  exception when others then if coalesce(sqlerrm not like '%제외 사유를 입력%', true) then v_ok := false; raise notice 'TEST101d FAIL: 사유 문구 — %', sqlerrm; end if; end;
  begin perform public.exclude_order_for_schedule_change(v_o1, v_admin, 'ADMIN', '결제 완료 건');
    v_ok := false; raise notice 'TEST101d FAIL: 결제 완료 건이 환불 없이 제외됨';
  exception when others then if coalesce(sqlerrm not like '%환불 경로%', true) then v_ok := false; raise notice 'TEST101d FAIL: 결제 완료 문구 — %', sqlerrm; end if; end;
  begin perform public.exclude_order_for_schedule_change(gen_random_uuid(), v_admin, 'ADMIN', '없는 주문');
    v_ok := false; raise notice 'TEST101d FAIL: 없는 주문이 제외됨';
  exception when others then if coalesce(sqlerrm not like '%신청 건을 찾을 수 없습니다%', true) then v_ok := false; raise notice 'TEST101d FAIL: 없는 주문 문구 — %', sqlerrm; end if; end;

  -- (e) 제외 처리 성공: 미결제(o2)·무료(o3)·승인 대기(o4) — 환불 없이 종료, 취소 사건 원인 SCHEDULE_CHANGE, 좌석 반환, ORDER_CLOSED 사실
  select remaining_seats into v_seats_before from public.course_offerings where id = v_off;
  v_ev := public.exclude_order_for_schedule_change(v_o2, v_admin, 'ADMIN', ' 일정 변경으로 인한 제외 ');
  select payload into v_payload from public.order_events where id = v_ev;
  if not coalesce(
       (select status from public.orders where id = v_o2) = 'CANCELLED'
       and (select cancelled_at from public.orders where id = v_o2) is not null
       and (select payment_status from public.orders where id = v_o2) = 'UNPAID'
       and (v_payload->>'cause') = 'SCHEDULE_CHANGE' and (v_payload->>'mode') = 'NO_REFUND'
       and (v_payload->>'reason') = '일정 변경으로 인한 제외'
       and (v_payload->>'notice_event_id') = v_n2::text
       and (v_payload->>'total_sessions')::int = 2 and (v_payload->>'past_sessions')::int = 0
       and (select count(*) from public.outbox_messages where topic = 'ORDER_CLOSED' and payload->>'order_id' = v_o2::text and payload->>'close_event_id' = v_ev::text) = 1, false) then
    v_ok := false; raise notice 'TEST101e FAIL: o2 제외 %', v_payload;
  end if;
  perform public.exclude_order_for_schedule_change(v_o3, v_admin, 'ADMIN', '미결제 무료 제외');
  perform public.exclude_order_for_schedule_change(v_o4, v_admin, 'ADMIN', '승인 대기 제외');
  select remaining_seats into v_seats_after from public.course_offerings where id = v_off;
  if (v_seats_after - v_seats_before) is distinct from 3 then v_ok := false; raise notice 'TEST101e FAIL: 좌석 반환 % → %', v_seats_before, v_seats_after; end if;
  begin perform public.exclude_order_for_schedule_change(v_o2, v_admin, 'ADMIN', '또 제외');
    v_ok := false; raise notice 'TEST101e FAIL: 이미 제외된 주문이 다시 제외됨';
  exception when others then if coalesce(sqlerrm not like '%이미 종료된 신청 건입니다%', true) then v_ok := false; raise notice 'TEST101e FAIL: 재제외 문구 — %', sqlerrm; end if; end;

  -- (f) 또 일정이 바뀌면 새 안내 발송: 남은 살아 있는 주문(o1·o5)에게 새 안내 전달
  v_res2 := public.apply_schedule_change(v_off, v_admin, 'ADMIN', '또 변경', '{}'::uuid[],
    '[{"date":"2040-03-26","start":"03:10","end":"03:40"}]'::jsonb);
  if coalesce(jsonb_array_length(v_res2->'notified'), -1) is distinct from 2 then
    v_ok := false; raise notice 'TEST101f FAIL: 두 번째 변경의 안내 수 %(남은 살아 있는 주문 o1·o5)', jsonb_array_length(v_res2->'notified');
  end if;

  -- (g) 개강한 수업이라도 시작된 회차 취소는 거부, 시작되지 않은 미래 회차 취소/추가는 허용
  -- 1) 시작된 회차(어제) 취소 시도시 거부
  v_started := public.create_course_offering(
    v_course, 'S', 5, 10000, null, '{}'::text[], '[]'::jsonb,
    (now() - interval '10 days')::timestamptz,
    jsonb_build_array(
      jsonb_build_object('date', ((now() at time zone 'Asia/Seoul')::date - 1)::text, 'start', '10:00', 'end', '12:00'),
      jsonb_build_object('date', ((now() at time zone 'Asia/Seoul')::date + 5)::text, 'start', '10:00', 'end', '12:00')
    ),
    v_admin, 'ADMIN'
  );
  declare
    v_started_sess_id uuid;
  begin
    select id into v_started_sess_id from public.course_sessions where course_offering_id = v_started and deactivated_at is null order by session_date asc limit 1;
    perform public.apply_schedule_change(v_started, v_admin, 'ADMIN', '시작된회차취소시도', array[v_started_sess_id], '[{"date":"2040-04-02","start":"04:10","end":"04:40"}]'::jsonb);
    v_ok := false; raise notice 'TEST101g FAIL: 시작된 회차가 취소됨';
  exception when others then
    if coalesce(sqlerrm not like '%이미 시작한 회차%', true) then v_ok := false; raise notice 'TEST101g FAIL: 시작된 회차 취소 거부 문구 — %', sqlerrm; end if;
  end;
  -- 2) 변경 후 첫 회차가 과거가 되는 변경은 거부: 활성 회차를 모두 취소하고 과거 날짜만 추가
  begin perform public.apply_schedule_change(v_off, v_admin, 'ADMIN', '과거로',
    (select array_agg(id) from public.course_sessions where course_offering_id = v_off and deactivated_at is null),
    jsonb_build_array(jsonb_build_object('date', (current_date - 3), 'start', '03:10', 'end', '03:40')));
    v_ok := false; raise notice 'TEST101g FAIL: 과거 첫 회차로 변경됨';
  exception when others then if coalesce(sqlerrm not like '%현재 이후여야 합니다%' and sqlerrm not like '%이미 지난 시각%' and sqlerrm not like '%모집 시작은 개강%', true) then v_ok := false; raise notice 'TEST101g FAIL: 과거 문구 — %', sqlerrm; end if; end;

  -- (h) 환불 경로 원인: 카드 결제 완료 건(o1)을 일정 변경 안내에 연결해 환불하면 취소 사건 원인이 SCHEDULE_CHANGE
  select id into v_n1b from public.order_events where order_id = v_o1 and event_type = 'SCHEDULE_CHANGE_NOTICE' order by created_at desc, id desc limit 1;
  perform public.record_payment_event('MOCK', 'evt-t101h-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_o1, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  perform public.begin_refund_request(v_o1, 'req-t101h', null, '일정 변경 미동의 처리', 'ADMIN', null, v_n1b, false, v_admin);
  perform public.record_payment_event('MOCK', 'evt-t101h-ref', 'REFUNDED', 100000, 'KRW', v_o1, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  select payload into v_payload from public.order_events where order_id = v_o1 and event_type = 'CANCELLED';
  if not coalesce((v_payload->>'cause') = 'SCHEDULE_CHANGE' and (v_payload->>'partial')::boolean = false
                  and (select status from public.orders where id = v_o1) = 'CANCELLED', false) then
    v_ok := false; raise notice 'TEST101h FAIL: 환불 원인 %', v_payload;
  end if;

  -- (i) 권한 — 서버 액션(service_role)만
  if has_function_privilege('anon', 'public.apply_schedule_change(uuid,uuid,text,text,uuid[],jsonb,text,text,boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.apply_schedule_change(uuid,uuid,text,text,uuid[],jsonb,text,text,boolean)', 'execute')
     or not has_function_privilege('service_role', 'public.apply_schedule_change(uuid,uuid,text,text,uuid[],jsonb,text,text,boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.exclude_order_for_schedule_change(uuid,uuid,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.exclude_order_for_schedule_change(uuid,uuid,text,text)', 'execute') then
    v_ok := false; raise notice 'TEST101i FAIL: 실행 권한이 의도와 다름';
  end if;
  select count(*) into v_cnt from pg_proc where proname = 'begin_refund_request';
  if v_cnt is distinct from 1 then v_ok := false; raise notice 'TEST101i FAIL: begin_refund_request가 %개', v_cnt; end if;

  if v_ok then
    raise notice 'TEST101 PASS: 일정 변경 — 거부 사유 6종·변경 시 살아 있는 주문 전원에게 안내(전후 일정·사유)·개강/종료 재계산·보호 트리거 유지·결제 완료/종료 건 제외 거부·미결제/무료/승인 대기 제외(사건 원인·좌석·ORDER_CLOSED)·재변경 시 새 안내 전송·개강 후/과거 첫 회차 거부·카드 환불 원인 SCHEDULE_CHANGE·권한';
  end if;
end $$;

-- =========================================================
-- TEST 100: 수강생 환불 신청·관리자 거절·학생 신청에서 시작된 환불의 원인
-- =========================================================
do $$
declare
  v_ok boolean := true;
  v_course uuid; v_off uuid; v_prod uuid;
  v_admin uuid; v_s1 uuid; v_s2 uuid; v_s3 uuid; v_s4 uuid; v_s5 uuid; v_s6 uuid;
  v_o1 uuid; v_o2 uuid; v_o3 uuid; v_o4 uuid; v_o5 uuid; v_o6 uuid;
  v_req uuid; v_req2 uuid; v_rej uuid;
  v_payload jsonb;
  v_actor text;
  v_n integer;
begin
  insert into public.courses (name, category) values ('TEST100강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test100-admin@example.com', 'ADMIN') returning id into v_admin;
  v_off := public.create_course_offering(v_course, 'R', 9, 100000, null, '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, now() - interval '2 days',
    '[{"date":"2039-03-01","start":"03:10","end":"03:40"}]'::jsonb,
    v_admin, 'ADMIN');
  insert into public.products (name, price) values ('TEST100상품', 5000) returning id into v_prod;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test100-s1@example.com', 'STUDENT') returning id into v_s1;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test100-s2@example.com', 'STUDENT') returning id into v_s2;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test100-s3@example.com', 'STUDENT') returning id into v_s3;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test100-s4@example.com', 'STUDENT') returning id into v_s4;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test100-s5@example.com', 'STUDENT') returning id into v_s5;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test100-s6@example.com', 'STUDENT') returning id into v_s6;

  -- 승인됨 + 결제완료 + 카드 주문(o1), 계좌이체(o2), 결제 전(o3), 승인 대기(o4), 물품(o5), 무료(o6)
  v_o1 := public.create_order(v_s1, v_off, null, null::uuid[], '2026-10-v1');
  v_o2 := public.create_order(v_s2, v_off, null, null::uuid[], '2026-10-v1');
  v_o3 := public.create_order(v_s3, v_off, null, null::uuid[], '2026-10-v1');
  v_o4 := public.create_order(v_s4, v_off, null, null::uuid[], '2026-10-v1');
  v_o5 := public.create_order(v_s5, null, v_prod, null::uuid[]);
  v_o6 := public.create_order(v_s6, v_off, null, null::uuid[], '2026-10-v1');
  update public.orders set status = 'APPROVED', approved_at = now(), payment_status = 'PAID', paid_at = now(), payment_method = 'CARD' where id = v_o1;
  update public.orders set status = 'APPROVED', approved_at = now(), payment_status = 'PAID', paid_at = now(), payment_method = 'BANK_TRANSFER' where id = v_o2;
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_o3;
  update public.orders set status = 'APPROVED', approved_at = now(), payment_status = 'WAIVED' where id = v_o6;

  -- (a) 신청: 사건 기록(행위자 STUDENT, 사유 공백 제거, 제안 요약은 그대로 저장, 신청일)
  v_req := public.request_order_refund(v_o1, v_s1, '  개인 사정  ', '{"amount":10000,"stage":"BEFORE_START","policyId":"2026-10-v1"}'::jsonb);
  select payload, actor into v_payload, v_actor from public.order_events where id = v_req;
  if v_actor <> 'STUDENT' or v_payload->>'reason' <> '개인 사정' or (v_payload->'proposal'->>'amount')::int <> 10000
     or (v_payload->>'requested_on')::date <> (now() at time zone 'Asia/Seoul')::date
     or (select actor_user_id from public.order_events where id = v_req) <> v_s1 then
    v_ok := false; raise notice 'TEST100a FAIL: %, actor=%', v_payload, v_actor;
  end if;

  -- (b) 열린 신청이 있으면 중복 거부
  begin
    perform public.request_order_refund(v_o1, v_s1, '또', '{}'::jsonb);
    v_ok := false; raise notice 'TEST100b FAIL: 중복 신청이 허용됨';
  exception when others then
    if sqlerrm not like '%이미 환불을 신청했습니다%' then v_ok := false; raise notice 'TEST100b FAIL: 문구 — %', sqlerrm; end if;
  end;

  -- (c) 다른 학생의 주문 / 없는 주문
  begin
    perform public.request_order_refund(v_o1, v_s2, '남의 것', '{}'::jsonb);
    v_ok := false; raise notice 'TEST100c FAIL: 남의 주문에 신청됨';
  exception when others then
    if sqlerrm not like '%내 신청 건이 아닙니다%' then v_ok := false; raise notice 'TEST100c FAIL: 문구 — %', sqlerrm; end if;
  end;
  begin
    perform public.request_order_refund(gen_random_uuid(), v_s1, '없음', '{}'::jsonb);
    v_ok := false; raise notice 'TEST100c FAIL: 없는 주문에 신청됨';
  exception when others then
    if sqlerrm not like '%내 신청 건이 아닙니다%' then v_ok := false; raise notice 'TEST100c FAIL: 없는 주문 문구 — %', sqlerrm; end if;
  end;

  -- (d) 카드·결제완료·승인됨·수업 주문이 아니면 거부(계좌이체·결제 전·승인 대기·물품·무료)
  begin perform public.request_order_refund(v_o2, v_s2, '계좌이체', '{}'::jsonb);
    v_ok := false; raise notice 'TEST100d FAIL: 계좌이체 주문이 신청됨';
  exception when others then if sqlerrm not like '%카드로 결제한 건만%' then v_ok := false; raise notice 'TEST100d FAIL: 계좌이체 문구 — %', sqlerrm; end if; end;
  begin perform public.request_order_refund(v_o3, v_s3, '결제 전', '{}'::jsonb);
    v_ok := false; raise notice 'TEST100d FAIL: 결제 전 주문이 신청됨';
  exception when others then if sqlerrm not like '%결제가 완료된 신청 건만%' then v_ok := false; raise notice 'TEST100d FAIL: 결제 전 문구 — %', sqlerrm; end if; end;
  begin perform public.request_order_refund(v_o4, v_s4, '승인 대기', '{}'::jsonb);
    v_ok := false; raise notice 'TEST100d FAIL: 승인 대기 주문이 신청됨';
  exception when others then if sqlerrm not like '%승인된 신청 건만%' then v_ok := false; raise notice 'TEST100d FAIL: 승인 대기 문구 — %', sqlerrm; end if; end;
  begin perform public.request_order_refund(v_o5, v_s5, '물품', '{}'::jsonb);
    v_ok := false; raise notice 'TEST100d FAIL: 물품 주문이 신청됨';
  exception when others then if sqlerrm not like '%수업 신청 건만%' then v_ok := false; raise notice 'TEST100d FAIL: 물품 문구 — %', sqlerrm; end if; end;
  begin perform public.request_order_refund(v_o6, v_s6, '무료', '{}'::jsonb);
    v_ok := false; raise notice 'TEST100d FAIL: 무료(직권 부여) 주문이 신청됨';
  exception when others then if sqlerrm not like '%결제가 완료된 신청 건만%' then v_ok := false; raise notice 'TEST100d FAIL: 무료 문구 — %', sqlerrm; end if; end;

  -- (e) 사유 없음·너무 김
  update public.orders set payment_method = 'CARD' where id = v_o2;
  begin perform public.request_order_refund(v_o2, v_s2, '   ', '{}'::jsonb);
    v_ok := false; raise notice 'TEST100e FAIL: 사유 없이 신청됨';
  exception when others then if sqlerrm not like '%환불 사유를 입력%' then v_ok := false; raise notice 'TEST100e FAIL: 사유 문구 — %', sqlerrm; end if; end;
  begin perform public.request_order_refund(v_o2, v_s2, repeat('가', 1001), '{}'::jsonb);
    v_ok := false; raise notice 'TEST100e FAIL: 1001자 사유가 신청됨';
  exception when others then if sqlerrm not like '%1000자 이하%' then v_ok := false; raise notice 'TEST100e FAIL: 길이 문구 — %', sqlerrm; end if; end;

  -- (f) 거절: 관리자만 / 열린 신청이 있을 때만 / 사유 필수 / 거절 뒤 재신청 가능 / 거절 사건이 신청을 가리킴
  begin perform public.reject_order_refund_request(v_o1, v_s1, 'STUDENT', '학생이 거절');
    v_ok := false; raise notice 'TEST100f FAIL: 학생이 거절함';
  exception when others then if sqlerrm not like '%관리자만%' then v_ok := false; raise notice 'TEST100f FAIL: 권한 문구 — %', sqlerrm; end if; end;
  begin perform public.reject_order_refund_request(v_o1, v_admin, 'ADMIN', '  ');
    v_ok := false; raise notice 'TEST100f FAIL: 사유 없이 거절됨';
  exception when others then if sqlerrm not like '%거절 사유를 입력%' then v_ok := false; raise notice 'TEST100f FAIL: 사유 문구 — %', sqlerrm; end if; end;
  begin perform public.reject_order_refund_request(v_o2, v_admin, 'ADMIN', '신청 없음');
    v_ok := false; raise notice 'TEST100f FAIL: 신청이 없는데 거절됨';
  exception when others then if sqlerrm not like '%거절할 환불 신청이 없습니다%' then v_ok := false; raise notice 'TEST100f FAIL: 신청 없음 문구 — %', sqlerrm; end if; end;
  v_rej := public.reject_order_refund_request(v_o1, v_admin, 'ADMIN', ' 개강 임박 ');
  select payload, actor into v_payload, v_actor from public.order_events where id = v_rej;
  if v_actor <> 'ADMIN' or v_payload->>'reason' <> '개강 임박' or v_payload->>'request_event_id' <> v_req::text then
    v_ok := false; raise notice 'TEST100f FAIL: 거절 사건 %', v_payload;
  end if;
  begin perform public.reject_order_refund_request(v_o1, v_admin, 'ADMIN', '또 거절');
    v_ok := false; raise notice 'TEST100f FAIL: 이미 거절된 신청이 다시 거절됨';
  exception when others then if sqlerrm not like '%거절할 환불 신청이 없습니다%' then v_ok := false; raise notice 'TEST100f FAIL: 재거절 문구 — %', sqlerrm; end if; end;
  v_req2 := public.request_order_refund(v_o1, v_s1, '다시 신청', '{}'::jsonb); -- 거절 뒤 재신청 가능
  if v_req2 is null or v_req2 = v_req then v_ok := false; raise notice 'TEST100f FAIL: 재신청 실패'; end if;

  -- (g) 학생 신청에서 시작된 환불 → 원인 STUDENT_REFUND(신청 id 연결), 연결 없는 관리자 환불은 ADMIN_REFUND(TEST95a)
  perform public.record_payment_event('MOCK', 'evt-t100g-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_o1, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  perform public.begin_refund_request(v_o1, 'req-t100g', 30000, '학생 신청 처리', 'ADMIN', v_req2, null, false, v_admin);
  perform public.record_payment_event('MOCK', 'evt-t100g-ref', 'REFUNDED', 30000, 'KRW', v_o1, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  select payload into v_payload from public.order_events where order_id = v_o1 and event_type = 'CANCELLED';
  if v_payload->>'cause' is distinct from 'STUDENT_REFUND' then
    v_ok := false; raise notice 'TEST100g FAIL: 원인 %', v_payload;
  end if;
  -- 종료된 주문에는 신청도 거절도 못 한다
  begin perform public.reject_order_refund_request(v_o1, v_admin, 'ADMIN', '종료 뒤');
    v_ok := false; raise notice 'TEST100g FAIL: 종료된 주문의 신청이 거절됨';
  exception when others then if sqlerrm not like '%이미 종료된%' then v_ok := false; raise notice 'TEST100g FAIL: 종료 문구 — %', sqlerrm; end if; end;
  begin perform public.request_order_refund(v_o1, v_s1, '종료 뒤', '{}'::jsonb);
    v_ok := false; raise notice 'TEST100g FAIL: 종료된 주문에 신청됨';
  exception when others then if sqlerrm not like '%승인된 신청 건만%' then v_ok := false; raise notice 'TEST100g FAIL: 종료 신청 문구 — %', sqlerrm; end if; end;

  -- (h) 권한 — 학생·익명은 직접 못 부른다(서버 액션만, service_role), 옛 5인자 begin_refund_request는 사라짐
  if has_function_privilege('anon', 'public.request_order_refund(uuid,uuid,text,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.request_order_refund(uuid,uuid,text,jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.request_order_refund(uuid,uuid,text,jsonb)', 'execute')
     or has_function_privilege('anon', 'public.reject_order_refund_request(uuid,uuid,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.reject_order_refund_request(uuid,uuid,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.reject_order_refund_request(uuid,uuid,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.begin_refund_request(uuid,text,integer,text,text,uuid,uuid,boolean,uuid,uuid,boolean,boolean)', 'execute')
     or not has_function_privilege('service_role', 'public.begin_refund_request(uuid,text,integer,text,text,uuid,uuid,boolean,uuid,uuid,boolean,boolean)', 'execute') then
    v_ok := false; raise notice 'TEST100h FAIL: 실행 권한이 의도와 다름';
  end if;
  select count(*) into v_n from pg_proc where proname = 'begin_refund_request';
  if v_n <> 1 then v_ok := false; raise notice 'TEST100h FAIL: begin_refund_request가 %개(오버로드 모호)', v_n; end if;

  if v_ok then
    raise notice 'TEST100 PASS: 수강생 환불 신청 — 신청 사건(사유·제안·신청일)·중복 거부·남의 주문/없는 주문·계좌이체/결제 전/승인 대기/물품/무료 거부·사유 검증·관리자만 거절·신청 없으면 거절 불가·거절 뒤 재신청·학생 신청에서 시작된 환불은 STUDENT_REFUND·종료 뒤 신청/거절 불가·권한';
  end if;
end $$;

-- =========================================================
-- TEST 99: 환불 정책 버전을 주문에 고정 (ADR-0025)
-- create_order의 5번째 인자 p_refund_policy_version: 수업 주문에만 저장, 4인자 호출(옛 호출)은 null, 공백·41자 이상 거부(좌석 차감 전에 거부).
-- =========================================================
do $$
declare
  v_ok boolean := true;
  v_course uuid; v_off uuid; v_prod uuid;
  v_admin uuid;
  v_u1 uuid; v_u2 uuid; v_u3 uuid; v_u4 uuid;
  v_o1 uuid; v_o2 uuid; v_o3 uuid;
  v_seats_before integer; v_seats_after integer;
begin
  insert into public.courses (name, category) values ('TEST99강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test99-admin@example.com', 'ADMIN') returning id into v_admin;
  v_off := public.create_course_offering(v_course, 'V', 5, 10000, null, '{}'::text[], '[]'::jsonb, now() - interval '2 days',
    '[{"date":"2038-03-01","start":"03:10","end":"03:40"}]'::jsonb,
    v_admin, 'ADMIN');
  insert into public.products (name, price) values ('TEST99상품', 5000) returning id into v_prod;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test99a@example.com', 'STUDENT') returning id into v_u1;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test99b@example.com', 'STUDENT') returning id into v_u2;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test99c@example.com', 'STUDENT') returning id into v_u3;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test99d@example.com', 'STUDENT') returning id into v_u4;

  -- (a) 옛 4인자 호출 → null
  v_o1 := public.create_order(v_u1, v_off, null, null::uuid[]);
  if (select refund_policy_version from public.orders where id = v_o1) is not null then
    v_ok := false; raise notice 'TEST99a FAIL: 4인자 호출인데 버전이 저장됨';
  end if;

  -- (b) 5인자 → 저장
  v_o2 := public.create_order(v_u2, v_off, null, null::uuid[], '2026-10-v1');
  if (select refund_policy_version from public.orders where id = v_o2) is distinct from '2026-10-v1' then
    v_ok := false; raise notice 'TEST99b FAIL: 버전이 저장되지 않음';
  end if;

  -- (c) 물품 주문은 버전을 넘겨도 null
  v_o3 := public.create_order(v_u3, null, v_prod, null::uuid[], '2026-10-v1');
  if (select refund_policy_version from public.orders where id = v_o3) is not null then
    v_ok := false; raise notice 'TEST99c FAIL: 물품 주문에 버전이 저장됨';
  end if;

  -- (d) 공백·41자 이상은 거부하고 좌석을 차감하지 않는다
  select remaining_seats into v_seats_before from public.course_offerings where id = v_off;
  begin
    perform public.create_order(v_u4, v_off, null, null::uuid[], '   ');
    v_ok := false; raise notice 'TEST99d FAIL: 공백 버전이 허용됨';
  exception when others then
    if sqlerrm not like '%환불 정책 버전이 올바르지 않습니다%' then v_ok := false; raise notice 'TEST99d FAIL: 공백 문구 — %', sqlerrm; end if;
  end;
  begin
    perform public.create_order(v_u4, v_off, null, null::uuid[], repeat('x', 41));
    v_ok := false; raise notice 'TEST99d FAIL: 41자 버전이 허용됨';
  exception when others then
    if sqlerrm not like '%환불 정책 버전이 올바르지 않습니다%' then v_ok := false; raise notice 'TEST99d FAIL: 길이 문구 — %', sqlerrm; end if;
  end;
  select remaining_seats into v_seats_after from public.course_offerings where id = v_off;
  if v_seats_after is distinct from v_seats_before then
    v_ok := false; raise notice 'TEST99d FAIL: 거부됐는데 좌석이 차감됨 (% → %)', v_seats_before, v_seats_after;
  end if;
  perform public.create_order(v_u4, v_off, null, null::uuid[], repeat('x', 40)); -- 40자는 허용

  -- (e) 권한: 옛 4인자 시그니처는 사라졌고, 5인자는 service_role만
  if exists (select 1 from pg_proc where proname = 'create_order' and pronargs = 4) then
    v_ok := false; raise notice 'TEST99e FAIL: 4인자 create_order가 남아 있음(오버로드 모호)';
  end if;
  if has_function_privilege('anon', 'public.create_order(uuid,uuid,uuid,uuid[],text)', 'execute')
     or has_function_privilege('authenticated', 'public.create_order(uuid,uuid,uuid,uuid[],text)', 'execute')
     or not has_function_privilege('service_role', 'public.create_order(uuid,uuid,uuid,uuid[],text)', 'execute') then
    v_ok := false; raise notice 'TEST99e FAIL: 실행 권한이 의도와 다름';
  end if;

  if v_ok then
    raise notice 'TEST99 PASS: 환불 정책 버전 고정 — 4인자 호출 null·5인자 저장·물품 주문 null·공백/41자 거부(좌석 불변)·40자 허용·4인자 오버로드 없음·권한 service_role만';
  end if;
end $$;

-- =========================================================
-- TEST 98: 회차 파생값 offering_session_stats + 취소 사건의 총/지난 회차 기록
-- 활성 회차만, 한국 날짜, 지난 회차 = 오늘 이하(당일 포함), 다음 회차 = 오늘 이후 가장 이른 날짜.
-- =========================================================
do $$
declare
  v_ok boolean := true;
  v_course uuid; v_admin uuid; v_user uuid;
  v_a uuid; v_b uuid; v_p uuid; v_legacy uuid;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  r record;
  v_order uuid;
  v_payload jsonb;
  v_sess uuid;
begin
  insert into public.courses (name, category) values ('TEST98강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test98-admin@example.com', 'ADMIN') returning id into v_admin;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test98-student@example.com', 'STUDENT') returning id into v_user;

  v_a := public.create_course_offering(v_course, 'A', 5, 10000, null, '{}'::text[], '[]'::jsonb, now() - interval '2 days',
    '[{"date":"2035-03-03","start":"03:10","end":"03:40"},{"date":"2035-03-10","start":"03:10","end":"03:40"},
      {"date":"2035-03-17","start":"03:10","end":"03:40"},{"date":"2035-03-24","start":"03:10","end":"03:40"}]'::jsonb,
    v_admin, 'ADMIN');

  -- (a) 기준 날짜별: 개강 전 / 첫 회차 당일 / 둘째 회차 당일 / 마지막 당일 / 마지막 다음 날
  select * into r from public.offering_session_stats(v_a, date '2035-03-02');
  if (r.total_count, r.past_count, r.first_date, r.last_date, r.next_date) is distinct from (4, 0, date '2035-03-03', date '2035-03-24', date '2035-03-03') then
    v_ok := false; raise notice 'TEST98a FAIL(개강 전): %', r;
  end if;
  select * into r from public.offering_session_stats(v_a, date '2035-03-03');
  if (r.past_count, r.next_date) is distinct from (1, date '2035-03-10') then v_ok := false; raise notice 'TEST98a FAIL(첫 회차 당일): %', r; end if;
  select * into r from public.offering_session_stats(v_a, date '2035-03-10');
  if (r.total_count, r.past_count, r.next_date) is distinct from (4, 2, date '2035-03-17') then v_ok := false; raise notice 'TEST98a FAIL(둘째 당일): %', r; end if;
  select * into r from public.offering_session_stats(v_a, date '2035-03-24');
  if (r.past_count, r.next_date) is distinct from (4, null::date) then v_ok := false; raise notice 'TEST98a FAIL(마지막 당일): %', r; end if;
  select * into r from public.offering_session_stats(v_a, date '2035-03-25');
  if (r.past_count, r.next_date) is distinct from (4, null::date) then v_ok := false; raise notice 'TEST98a FAIL(마지막 다음 날): %', r; end if;

  -- (b) 취소(비활성) 회차는 총·지난·다음에서 제외
  select id into v_sess from public.course_sessions where course_offering_id = v_a and session_date = date '2035-03-17';
  update public.course_sessions set deactivated_at = now(), deactivated_reason = 'TEST98' where id = v_sess;
  select * into r from public.offering_session_stats(v_a, date '2035-03-10');
  if (r.total_count, r.past_count, r.next_date) is distinct from (3, 2, date '2035-03-24') then v_ok := false; raise notice 'TEST98b FAIL: %', r; end if;

  -- (c) 기준 날짜를 안 주면 한국 날짜 오늘 — 어제·오늘·내일 회차 3개 → 지난 2(당일 포함), 다음 = 내일
  v_b := public.create_course_offering(v_course, 'B', 5, 10000, null, '{}'::text[], '[]'::jsonb, now() - interval '10 days',
    jsonb_build_array(
      jsonb_build_object('date', v_today - 1, 'start', '03:10', 'end', '03:40'),
      jsonb_build_object('date', v_today, 'start', '03:10', 'end', '03:40'),
      jsonb_build_object('date', v_today + 1, 'start', '03:10', 'end', '03:40')),
    v_admin, 'ADMIN');
  select * into r from public.offering_session_stats(v_b);
  if (r.total_count, r.past_count, r.next_date) is distinct from (3, 2, v_today + 1) then v_ok := false; raise notice 'TEST98c FAIL: %', r; end if;

  -- (d) 활성 회차 0개(삭제된 개설강의) → 0과 null
  perform public.delete_course_offering(v_a, 'TEST98 삭제', v_admin, 'ADMIN');
  select * into r from public.offering_session_stats(v_a, date '2035-03-10');
  if (r.total_count, r.past_count) is distinct from (0, 0) or r.first_date is not null or r.last_date is not null or r.next_date is not null then
    v_ok := false; raise notice 'TEST98d FAIL: %', r;
  end if;

  -- (e) 부분 환불 취소 사건에 총/지난 회차와 첫 수업 날짜가 회차에서 계산돼 기록된다.
  --     (create_order는 개강 전에만 되므로 미래 회차로 신청·결제한 뒤 회차 날짜를 과거로 옮긴다.)
  v_p := public.create_course_offering(v_course, 'P', 5, 100000, null, '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb, now() - interval '10 days',
    '[{"date":"2036-05-01","start":"04:10","end":"04:40"},{"date":"2036-05-02","start":"04:10","end":"04:40"},{"date":"2036-05-10","start":"04:10","end":"04:40"}]'::jsonb,
    v_admin, 'ADMIN');
  v_order := public.create_order(v_user, v_p, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_order;
  perform public.record_payment_event('MOCK', 'evt-t98-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_order, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  update public.course_sessions set session_date = v_today - 2 where course_offering_id = v_p and session_date = date '2036-05-01';
  update public.course_sessions set session_date = v_today where course_offering_id = v_p and session_date = date '2036-05-02';
  update public.course_sessions set session_date = v_today + 5 where course_offering_id = v_p and session_date = date '2036-05-10';
  perform public.record_payment_event('MOCK', 'evt-t98-ref', 'REFUNDED', 30000, 'KRW', v_order, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  select payload into v_payload from public.order_events where order_id = v_order and event_type = 'CANCELLED';
  if not ((v_payload->>'total_sessions')::int = 3 and (v_payload->>'past_sessions')::int = 2
          and (v_payload->>'first_class_date')::date = v_today - 2
          and v_payload->>'cause' = 'EXTERNAL_REFUND' and (v_payload->>'partial')::boolean = true) then
    v_ok := false; raise notice 'TEST98e FAIL: %', v_payload;
  end if;

  -- (f) 회차가 없는 옛 개설강의: 첫 수업 날짜는 캐시 opens_at의 한국 날짜로 대신하고 총·지난은 0
  insert into public.course_offerings (course_id, label, capacity, remaining_seats, price, recruit_opens_at, opens_at, ends_at, status)
    values (v_course, 'L', 5, 5, 100000, now() - interval '2 days', timestamptz '2037-04-01 10:00+09', timestamptz '2037-04-01 12:00+09', 'OPEN')
    returning id into v_legacy;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test98-legacy@example.com', 'STUDENT') returning id into v_user;
  v_order := public.create_order(v_user, v_legacy, null, null);
  update public.orders set status = 'APPROVED', approved_at = now() where id = v_order;
  perform public.record_payment_event('MOCK', 'evt-t98l-paid', 'PAYMENT_SUCCEEDED', 100000, 'KRW', v_order, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  perform public.record_payment_event('MOCK', 'evt-t98l-ref', 'REFUNDED', 100000, 'KRW', v_order, 'CARD', '{}'::jsonb, '{}'::jsonb);
  perform pg_temp.deliver_payment_facts();
  select payload into v_payload from public.order_events where order_id = v_order and event_type = 'CANCELLED';
  if not ((v_payload->>'first_class_date')::date = date '2037-04-01' and (v_payload->>'total_sessions')::int = 0 and (v_payload->>'past_sessions')::int = 0) then
    v_ok := false; raise notice 'TEST98f FAIL: %', v_payload;
  end if;

  -- (g) 권한: anon 불가, authenticated·service_role 가능
  if has_function_privilege('anon', 'public.offering_session_stats(uuid,date)', 'execute')
     or not has_function_privilege('authenticated', 'public.offering_session_stats(uuid,date)', 'execute')
     or not has_function_privilege('service_role', 'public.offering_session_stats(uuid,date)', 'execute') then
    v_ok := false; raise notice 'TEST98g FAIL: 실행 권한이 의도와 다름';
  end if;

  if v_ok then
    raise notice 'TEST98 PASS: 회차 파생값 — 기준 날짜별 총/지난/다음(당일 포함)·취소 회차 제외·기본 기준=한국 오늘·활성 0개·취소 사건에 total/past/first_class_date 기록·옛 개설강의 대체값·권한';
  end if;
end $$;

-- =========================================================
-- TEST 97: 개설 후 회차 추가·취소
-- 허용: 개강 전 + 살아 있는 신청 없음 + 사유. 거부: 개강 후, 신청 있음, 삭제/폐강/종료, 사유 없음, 겹침, 모집 시작 위반,
-- 마지막 활성 회차 취소, 이미 취소된 회차. 개강·종료는 S-1 트리거가 다시 계산한다.
-- =========================================================
do $$
declare
  v_ok boolean := true;
  v_course uuid;
  v_admin uuid;
  v_off uuid; v_other uuid; v_started uuid; v_cancelled uuid; v_deleted uuid; v_ended uuid;
  v_s1 uuid; v_s2 uuid; v_new uuid;
  v_open timestamptz; v_end timestamptz;
  v_user uuid;
  v_order uuid;
begin
  insert into public.courses (name, category) values ('TEST97강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test97-admin@example.com', 'ADMIN') returning id into v_admin;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test97-student@example.com', 'STUDENT') returning id into v_user;

  v_off := public.create_course_offering(v_course, 'A', 5, 10000, null, '{}'::text[], '[]'::jsonb, now() - interval '2 days',
    '[{"date":"2033-03-07","start":"19:00","end":"21:00"},{"date":"2033-03-14","start":"19:00","end":"21:00"}]'::jsonb,
    v_admin, 'ADMIN');
  select id into v_s1 from public.course_sessions where course_offering_id = v_off and session_date = date '2033-03-07';

  -- (a) 추가: 가장 이른 날짜를 더하면 개강이 앞당겨지고 종료는 그대로
  v_new := public.add_course_session(v_off, v_admin, 'ADMIN', '보강 추가', date '2033-03-01', time '10:00', time '12:00');
  select opens_at, ends_at into v_open, v_end from public.course_offerings where id = v_off;
  if v_new is null or v_open <> timestamptz '2033-03-01 10:00+09' or v_end <> timestamptz '2033-03-14 21:00+09' then
    v_ok := false; raise notice 'TEST97a FAIL: opens_at=%, ends_at=%', v_open, v_end;
  end if;

  -- (b) 취소(사유): 비활성 + 사유(공백 제거), 개강이 다시 계산된다
  perform public.cancel_course_session(v_new, v_admin, 'ADMIN', '  보강 취소  ');
  select opens_at, ends_at into v_open, v_end from public.course_offerings where id = v_off;
  if v_open <> timestamptz '2033-03-07 19:00+09'
     or (select deactivated_reason from public.course_sessions where id = v_new) <> '보강 취소'
     or (select deactivated_at from public.course_sessions where id = v_new) is null then
    v_ok := false; raise notice 'TEST97b FAIL: opens_at=%', v_open;
  end if;

  -- (c) 이미 취소된 회차 / 없는 회차
  begin
    perform public.cancel_course_session(v_new, v_admin, 'ADMIN', '또 취소');
    v_ok := false; raise notice 'TEST97c FAIL: 취소된 회차를 다시 취소함';
  exception when others then
    if sqlerrm not like '%이미 취소된 회차%' then v_ok := false; raise notice 'TEST97c FAIL: 문구 — %', sqlerrm; end if;
  end;
  begin
    perform public.cancel_course_session(gen_random_uuid(), v_admin, 'ADMIN', '없음');
    v_ok := false; raise notice 'TEST97c FAIL: 없는 회차가 취소됨';
  exception when others then
    if sqlerrm not like '%회차를 찾을 수 없습니다%' then v_ok := false; raise notice 'TEST97c FAIL: 없는 회차 문구 — %', sqlerrm; end if;
  end;

  -- (d) 같은 시간대 겹침 / 모집 시작 위반 / 시각 오류 / 사유·행위자 없음
  begin
    perform public.add_course_session(v_off, v_admin, 'ADMIN', '겹침', date '2033-03-07', time '20:00', time '22:00');
    v_ok := false; raise notice 'TEST97d FAIL: 겹치는 회차가 추가됨';
  exception when exclusion_violation then null;
  end;
  begin
    perform public.add_course_session(v_off, v_admin, 'ADMIN', '모집 시작 위반', current_date - 5, time '10:00', time '12:00');
    v_ok := false; raise notice 'TEST97d FAIL: 모집 시작보다 앞선 회차가 추가됨';
  exception when others then
    if sqlerrm not like '%모집 시작은 개강%' then v_ok := false; raise notice 'TEST97d FAIL: 모집 시작 문구 — %', sqlerrm; end if;
  end;
  begin
    perform public.add_course_session(v_off, v_admin, 'ADMIN', 'x', date '2033-04-01', time '12:00', time '12:00');
    v_ok := false; raise notice 'TEST97d FAIL: 종료=시작이 추가됨';
  exception when others then
    if sqlerrm not like '%종료 시각은 시작 시각보다%' then v_ok := false; raise notice 'TEST97d FAIL: 시각 문구 — %', sqlerrm; end if;
  end;
  begin
    perform public.add_course_session(v_off, v_admin, 'ADMIN', '   ', date '2033-04-01', time '10:00', time '12:00');
    v_ok := false; raise notice 'TEST97d FAIL: 사유 없이 추가됨';
  exception when others then
    if sqlerrm not like '%사유를 입력%' then v_ok := false; raise notice 'TEST97d FAIL: 사유 문구 — %', sqlerrm; end if;
  end;
  begin
    perform public.add_course_session(v_off, null, 'ADMIN', '행위자 없음', date '2033-04-01', time '10:00', time '12:00');
    v_ok := false; raise notice 'TEST97d FAIL: 행위자 없이 추가됨';
  exception when others then
    if sqlerrm not like '%관리자만%' and sqlerrm not like '%행위자가 필요%' then v_ok := false; raise notice 'TEST97d FAIL: 행위자 문구 — %', sqlerrm; end if;
  end;

  -- (e) 마지막 활성 회차 취소 거부(S-1 가드), 그 전까지는 허용
  select id into v_s2 from public.course_sessions where course_offering_id = v_off and session_date = date '2033-03-14';
  perform public.cancel_course_session(v_s2, v_admin, 'ADMIN', '하나 취소');
  begin
    perform public.cancel_course_session(v_s1, v_admin, 'ADMIN', '마지막 취소');
    v_ok := false; raise notice 'TEST97e FAIL: 마지막 활성 회차가 취소됨';
  exception when others then
    if sqlerrm not like '%마지막 남은 회차%' then v_ok := false; raise notice 'TEST97e FAIL: 문구 — %', sqlerrm; end if;
  end;

  -- (f) 살아 있는 신청이 있으면 추가·취소 모두 거부, 신청이 취소되면 다시 허용
  insert into public.orders (user_id, course_offering_id) values (v_user, v_off) returning id into v_order;
  begin
    perform public.add_course_session(v_off, v_admin, 'ADMIN', '신청 있음', date '2033-05-02', time '10:00', time '12:00');
    v_ok := false; raise notice 'TEST97f FAIL: 신청이 있는데 추가됨';
  exception when others then
    if sqlerrm not like '%신청(승인 대기·승인됨)이 있는 수업은 개별%' then v_ok := false; raise notice 'TEST97f FAIL: 추가 문구 — %', sqlerrm; end if;
  end;
  begin
    perform public.cancel_course_session(v_s2, v_admin, 'ADMIN', '신청 있음');
    v_ok := false; raise notice 'TEST97f FAIL: 신청이 있는데 취소됨';
  exception when others then
    if sqlerrm not like '%신청(승인 대기·승인됨)이 있는 수업은 개별%' then v_ok := false; raise notice 'TEST97f FAIL: 취소 문구 — %', sqlerrm; end if;
  end;
  update public.orders set status = 'CANCELLED', cancelled_at = now() where id = v_order;
  perform public.add_course_session(v_off, v_admin, 'ADMIN', '신청 취소 뒤', date '2033-05-02', time '10:00', time '12:00');

  -- (g) 개강 후 / 삭제 / 폐강 / 종료된 개설강의는 거부
  v_started := pg_temp.create_offering_legacy(v_course, 'S', 5, 10000, null, false, now() - interval '1 day', now() + interval '31 days',
    '{}'::text[], '[]'::jsonb, null, null, null, now() - interval '10 days', false);
  begin
    perform public.add_course_session(v_started, v_admin, 'ADMIN', '개강 후', date '2033-06-01', time '10:00', time '12:00');
    v_ok := false; raise notice 'TEST97g FAIL: 개강 후 추가됨';
  exception when others then
    if sqlerrm not like '%개강한 수업%' then v_ok := false; raise notice 'TEST97g FAIL: 개강 후 문구 — %', sqlerrm; end if;
  end;
  v_deleted := public.create_course_offering(v_course, 'D', 5, 10000, null, '{}'::text[], '[]'::jsonb, now() - interval '2 days',
    '[{"date":"2033-07-04","start":"10:00","end":"12:00"}]'::jsonb, v_admin, 'ADMIN');
  perform public.delete_course_offering(v_deleted, 'TEST97 삭제', v_admin, 'ADMIN');
  begin
    perform public.add_course_session(v_deleted, v_admin, 'ADMIN', '삭제됨', date '2033-07-11', time '10:00', time '12:00');
    v_ok := false; raise notice 'TEST97g FAIL: 삭제된 개설강의에 추가됨';
  exception when others then
    if sqlerrm not like '%삭제된 개설강의%' then v_ok := false; raise notice 'TEST97g FAIL: 삭제 문구 — %', sqlerrm; end if;
  end;
  v_cancelled := public.create_course_offering(v_course, 'C', 5, 10000, null, '{}'::text[], '[]'::jsonb, now() - interval '2 days',
    '[{"date":"2033-08-01","start":"10:00","end":"12:00"}]'::jsonb, v_admin, 'ADMIN');
  update public.course_offerings set status = 'CANCELLING', status_reason = 'TEST97', status_changed_by = v_admin, status_changed_at = now() where id = v_cancelled;
  begin
    perform public.add_course_session(v_cancelled, v_admin, 'ADMIN', '폐강 중', date '2033-08-08', time '10:00', time '12:00');
    v_ok := false; raise notice 'TEST97g FAIL: 폐강 중인 개설강의에 추가됨';
  exception when others then
    if sqlerrm not like '%폐강된 개설강의%' then v_ok := false; raise notice 'TEST97g FAIL: 폐강 문구 — %', sqlerrm; end if;
  end;
  v_ended := public.create_course_offering(v_course, 'E', 5, 10000, null, '{}'::text[], '[]'::jsonb, now() - interval '2 days',
    '[{"date":"2033-09-05","start":"10:00","end":"12:00"}]'::jsonb, v_admin, 'ADMIN');
  update public.course_offerings set ended_at = now(), end_note = 'TEST97' where id = v_ended;
  begin
    perform public.add_course_session(v_ended, v_admin, 'ADMIN', '종료됨', date '2033-09-12', time '10:00', time '12:00');
    v_ok := false; raise notice 'TEST97g FAIL: 종료된 개설강의에 추가됨';
  exception when others then
    if sqlerrm not like '%종료된 개설강의%' then v_ok := false; raise notice 'TEST97g FAIL: 종료 문구 — %', sqlerrm; end if;
  end;

  -- (h) 권한: anon·authenticated 불가, service_role만 가능
  if has_function_privilege('anon', 'public.add_course_session(uuid,uuid,text,text,date,time,time)', 'execute')
     or has_function_privilege('anon', 'public.cancel_course_session(uuid,uuid,text,text)', 'execute')
     or has_function_privilege('anon', 'public.assert_course_sessions_editable(uuid,uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.add_course_session(uuid,uuid,text,text,date,time,time)', 'execute')
     or has_function_privilege('authenticated', 'public.cancel_course_session(uuid,uuid,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.assert_course_sessions_editable(uuid,uuid,text)', 'execute')
     or not has_function_privilege('service_role', 'public.add_course_session(uuid,uuid,text,text,date,time,time)', 'execute')
     or not has_function_privilege('service_role', 'public.cancel_course_session(uuid,uuid,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.assert_course_sessions_editable(uuid,uuid,text)', 'execute') then
    v_ok := false; raise notice 'TEST97h FAIL: 실행 권한이 의도와 다름';
  end if;

  if v_ok then
    raise notice 'TEST97 PASS: 개설 후 회차 추가·취소 — 추가 시 개강 재계산·취소(사유 보존)·재취소/없는 회차 거부·겹침/모집 시작/시각/사유/행위자 검증·마지막 회차 보호·신청 있으면 거부(취소되면 허용)·개강 후/삭제/폐강/종료 거부·권한';
  end if;
end $$;

-- =========================================================
-- TEST 96: 회차 = 날짜별 행, 개강·종료는 회차에서 계산 (ADR-0023)
-- 래퍼(pg_temp.create_offering_legacy) 없이 새 시그니처 create_course_offering(p_sessions jsonb)를 직접 검증한다.
-- =========================================================
do $$
declare
  v_ok boolean := true;
  v_course uuid;
  v_admin uuid;
  v_a uuid; v_b uuid; v_c uuid;
  v_open timestamptz; v_end timestamptz;
  v_n integer;
  v_sess uuid;
  v_u1 uuid;
  v_o1 uuid; v_o2 uuid;
begin
  insert into public.courses (name, category) values ('TEST96강의', 'TEST') returning id into v_course;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test96-admin@example.com', 'ADMIN') returning id into v_admin;

  -- (a) 하루짜리: 회차 1개 → 개강 = 시작, 종료 = 끝 (한국 시각)
  v_a := public.create_course_offering(v_course, 'A', 5, 10000, null, '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    now() - interval '2 days', '[{"date":"2031-03-03","start":"19:00","end":"21:00"}]'::jsonb,
    v_admin, 'ADMIN');
  select opens_at, ends_at into v_open, v_end from public.course_offerings where id = v_a;
  if v_open <> timestamptz '2031-03-03 19:00+09' or v_end <> timestamptz '2031-03-03 21:00+09' then
    v_ok := false; raise notice 'TEST96a FAIL: opens_at=%, ends_at=%', v_open, v_end;
  end if;

  -- (b) 여러 회차(회차마다 시각이 달라도 됨, 입력 순서 무관): 개강 = 가장 이른 시작, 종료 = 가장 늦은 끝
  v_b := public.create_course_offering(v_course, 'B', 5, 10000, null, '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    now() - interval '2 days',
    '[{"date":"2031-03-17","start":"10:00","end":"12:00"},{"date":"2031-03-10","start":"14:00","end":"16:30"},{"date":"2031-03-12","start":"09:00","end":"10:00"}]'::jsonb,
    v_admin, 'ADMIN');
  select opens_at, ends_at into v_open, v_end from public.course_offerings where id = v_b;
  select count(*) into v_n from public.course_sessions where course_offering_id = v_b and deactivated_at is null;
  if v_n <> 3 or v_open <> timestamptz '2031-03-10 14:00+09' or v_end <> timestamptz '2031-03-17 12:00+09' then
    v_ok := false; raise notice 'TEST96b FAIL: n=%, opens_at=%, ends_at=%', v_n, v_open, v_end;
  end if;

  -- (c) 다른 개설강의의 같은 시간대와 겹치면 거부되고 개설강의도 만들어지지 않는다(전역 겹침, 원자성)
  select count(*) into v_n from public.course_offerings where label = 'C-겹침';
  begin
    perform public.create_course_offering(v_course, 'C-겹침', 5, 10000, null, '{}'::text[], '[]'::jsonb,
      now() - interval '2 days', '[{"date":"2031-03-03","start":"20:00","end":"22:00"}]'::jsonb,
      v_admin, 'ADMIN');
    v_ok := false; raise notice 'TEST96c FAIL: 겹치는 회차가 저장됨';
  exception when exclusion_violation then null;
  end;
  if (select count(*) from public.course_offerings where label = 'C-겹침') <> v_n then
    v_ok := false; raise notice 'TEST96c FAIL: 회차 실패 뒤 개설강의가 남음';
  end if;
  -- 같은 배열 안의 겹침도 거부
  begin
    perform public.create_course_offering(v_course, 'C2', 5, 10000, null, '{}'::text[], '[]'::jsonb,
      now() - interval '2 days', '[{"date":"2031-04-01","start":"10:00","end":"12:00"},{"date":"2031-04-01","start":"11:00","end":"13:00"}]'::jsonb,
      v_admin, 'ADMIN');
    v_ok := false; raise notice 'TEST96c FAIL: 한 배열 안의 겹침이 저장됨';
  exception when exclusion_violation then null;
  end;
  -- 시간대가 맞닿기만 하면(끝 = 다음 시작) 겹침이 아니다
  perform public.create_course_offering(v_course, 'C3', 5, 10000, null, '{}'::text[], '[]'::jsonb,
    now() - interval '2 days', '[{"date":"2031-03-03","start":"21:00","end":"22:00"}]'::jsonb,
    v_admin, 'ADMIN');

  -- (d) 입력 검증: 빈 배열·배열 아님·객체 모양 오류·모집 시작 ≥ 첫 회차·101개
  begin
    perform public.create_course_offering(v_course, 'D', 5, 10000, null, '{}'::text[], '[]'::jsonb, now() - interval '2 days', '[]'::jsonb, v_admin, 'ADMIN');
    v_ok := false; raise notice 'TEST96d FAIL: 빈 회차 배열 허용';
  exception when others then
    if sqlerrm not like '%회차가 1개 이상%' then v_ok := false; raise notice 'TEST96d FAIL: 빈 배열 문구 — %', sqlerrm; end if;
  end;
  begin
    perform public.create_course_offering(v_course, 'D', 5, 10000, null, '{}'::text[], '[]'::jsonb, now() - interval '2 days', '{"date":"2031-05-01"}'::jsonb, v_admin, 'ADMIN');
    v_ok := false; raise notice 'TEST96d FAIL: 배열 아닌 회차 허용';
  exception when others then
    if sqlerrm not like '%회차 목록(배열)%' then v_ok := false; raise notice 'TEST96d FAIL: 배열 아님 문구 — %', sqlerrm; end if;
  end;
  begin
    perform public.create_course_offering(v_course, 'D', 5, 10000, null, '{}'::text[], '[]'::jsonb, now() - interval '2 days', '[{"date":"2031-05-01","start":"10:00"}]'::jsonb, v_admin, 'ADMIN');
    v_ok := false; raise notice 'TEST96d FAIL: end 없는 회차 허용';
  exception when others then
    if sqlerrm not like '%객체여야%' then v_ok := false; raise notice 'TEST96d FAIL: 객체 모양 문구 — %', sqlerrm; end if;
  end;
  begin
    perform public.create_course_offering(v_course, 'D', 5, 10000, null, '{}'::text[], '[]'::jsonb, now() - interval '2 days', '[{"date":"2031-05-01","start":"12:00","end":"10:00"}]'::jsonb, v_admin, 'ADMIN');
    v_ok := false; raise notice 'TEST96d FAIL: 종료가 시작보다 이른 회차 허용';
  exception when check_violation then null;
  end;
  begin
    perform public.create_course_offering(v_course, 'D', 5, 10000, null, '{}'::text[], '[]'::jsonb,
      timestamptz '2031-05-01 10:00+09', '[{"date":"2031-05-01","start":"10:00","end":"12:00"}]'::jsonb,
      v_admin, 'ADMIN');
    v_ok := false; raise notice 'TEST96d FAIL: 모집 시작 = 개강인데 생성됨';
  exception when others then
    if sqlerrm not like '%모집 시작은 개강%' then v_ok := false; raise notice 'TEST96d FAIL: 모집 시작 문구 — %', sqlerrm; end if;
  end;
  begin
    perform public.create_course_offering(v_course, 'D', 5, 10000, null, '{}'::text[], '[]'::jsonb, now() - interval '2 days',
      (select jsonb_agg(jsonb_build_object('date', date '2032-01-01' + g, 'start', '10:00', 'end', '11:00')) from generate_series(0, 100) g),
      v_admin, 'ADMIN');
    v_ok := false; raise notice 'TEST96d FAIL: 회차 101개 허용';
  exception when others then
    if sqlerrm not like '%최대 100개%' then v_ok := false; raise notice 'TEST96d FAIL: 101개 문구 — %', sqlerrm; end if;
  end;

  -- (e) 회차 비활성화: 마지막 활성 회차는 거부, 그 밖에는 허용되고 개강·종료가 다시 계산된다. 비활성 회차와 같은 시간대 등록은 허용
  select id into v_sess from public.course_sessions where course_offering_id = v_b and session_date = date '2031-03-10';
  update public.course_sessions set deactivated_at = now(), deactivated_reason = 'TEST96 휴강' where id = v_sess;
  select opens_at, ends_at into v_open, v_end from public.course_offerings where id = v_b;
  if v_open <> timestamptz '2031-03-12 09:00+09' or v_end <> timestamptz '2031-03-17 12:00+09' then
    v_ok := false; raise notice 'TEST96e FAIL: 첫 회차 비활성 뒤 opens_at=%, ends_at=%', v_open, v_end;
  end if;
  v_c := public.create_course_offering(v_course, 'E-재사용', 5, 10000, null, '{}'::text[], '[]'::jsonb,
    now() - interval '2 days', '[{"date":"2031-03-10","start":"14:00","end":"16:30"}]'::jsonb,
    v_admin, 'ADMIN');
  update public.course_sessions set deactivated_at = now(), deactivated_reason = 'TEST96' where course_offering_id = v_b and session_date = date '2031-03-12';
  begin
    update public.course_sessions set deactivated_at = now(), deactivated_reason = 'TEST96 마지막'
      where course_offering_id = v_b and session_date = date '2031-03-17';
    v_ok := false; raise notice 'TEST96e FAIL: 마지막 활성 회차가 비활성화됨';
  exception when others then
    if sqlerrm not like '%마지막 남은 회차%' then v_ok := false; raise notice 'TEST96e FAIL: 문구 — %', sqlerrm; end if;
  end;
  select opens_at, ends_at into v_open, v_end from public.course_offerings where id = v_b;
  if v_open <> timestamptz '2031-03-17 10:00+09' or v_end <> timestamptz '2031-03-17 12:00+09' then
    v_ok := false; raise notice 'TEST96e FAIL: 남은 회차 1개로 계산 opens_at=%, ends_at=%', v_open, v_end;
  end if;

  -- (f) update_course_offering는 opens_at/ends_at를 더 받지 않는다(회차에서 계산되는 값)
  begin
    perform public.update_course_offering(v_a, v_admin, 'ADMIN', 'TEST96', jsonb_build_object('opens_at', '2031-06-01T00:00:00Z'));
    v_ok := false; raise notice 'TEST96f FAIL: opens_at 패치가 허용됨';
  exception when others then
    if sqlerrm not like '%수정할 수 없는 항목%' then v_ok := false; raise notice 'TEST96f FAIL: opens_at 문구 — %', sqlerrm; end if;
  end;
  begin
    perform public.update_course_offering(v_a, v_admin, 'ADMIN', 'TEST96', jsonb_build_object('ends_at', null));
    v_ok := false; raise notice 'TEST96f FAIL: ends_at 패치가 허용됨';
  exception when others then
    if sqlerrm not like '%수정할 수 없는 항목%' then v_ok := false; raise notice 'TEST96f FAIL: ends_at 문구 — %', sqlerrm; end if;
  end;
  perform public.update_course_offering(v_a, v_admin, 'ADMIN', 'TEST96 라벨', '{"label":"A2"}'::jsonb);

  -- (g) 삭제: 회차가 여러 개여도 삭제되고(마지막 회차 보호 면제) 회차는 비활성으로 보존된다
  perform public.delete_course_offering(v_b, 'TEST96 삭제', v_admin, 'ADMIN');
  select count(*) into v_n from public.course_sessions where course_offering_id = v_b and deactivated_at is null;
  if v_n <> 0 or (select count(*) from public.course_sessions where course_offering_id = v_b) <> 3 then
    v_ok := false; raise notice 'TEST96g FAIL: 삭제 뒤 활성 회차=%', v_n;
  end if;

  -- (h) 권한: service_role만 실행, anon·authenticated 불가
  if has_function_privilege('anon', 'public.create_course_offering(uuid,text,integer,integer,text,text[],jsonb,timestamptz,jsonb,uuid,text,boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.create_course_offering(uuid,text,integer,integer,text,text[],jsonb,timestamptz,jsonb,uuid,text,boolean)', 'execute')
     or not has_function_privilege('service_role', 'public.create_course_offering(uuid,text,integer,integer,text,text[],jsonb,timestamptz,jsonb,uuid,text,boolean)', 'execute') then
    v_ok := false; raise notice 'TEST96h FAIL: create_course_offering 실행 권한이 의도와 다름';
  end if;

  -- (i) 학생 시간 충돌: 같은 날짜 + 겹치는 시각이면 거부, 날짜가 다르거나 시각이 맞닿기만 하면 허용.
  --     강사 1인 전제의 전역 겹침 제약이 먼저 막는 상황이라(TEST6) 이 시험만 제약을 잠시 내려 트리거를 직접 확인한다
  --     (이 스크립트는 ROLLBACK으로 끝나고, TEST96이 마지막이라 뒤에 영향이 없다).
  alter table public.course_sessions drop constraint course_sessions_no_overlap_active;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test96-student@example.com', 'STUDENT') returning id into v_u1;
  v_o1 := public.create_course_offering(v_course, 'S1', 5, 10000, null, '{}'::text[], '[]'::jsonb, now() - interval '2 days',
    '[{"date":"2031-07-01","start":"10:00","end":"12:00"},{"date":"2031-07-08","start":"10:00","end":"12:00"}]'::jsonb,
    v_admin, 'ADMIN');
  v_o2 := public.create_course_offering(v_course, 'S2', 5, 10000, null, '{}'::text[], '[]'::jsonb, now() - interval '2 days',
    '[{"date":"2031-07-01","start":"11:00","end":"13:00"}]'::jsonb,
    v_admin, 'ADMIN');
  insert into public.orders (user_id, course_offering_id) values (v_u1, v_o1);
  begin
    insert into public.orders (user_id, course_offering_id) values (v_u1, v_o2);
    v_ok := false; raise notice 'TEST96i FAIL: 같은 날 겹치는 시각의 다른 신청이 허용됨';
  exception when others then
    if sqlerrm not like '%겹치는 시간대%' then v_ok := false; raise notice 'TEST96i FAIL: 문구 — %', sqlerrm; end if;
  end;
  update public.course_sessions set start_time = '12:00', end_time = '13:00' where course_offering_id = v_o2;
  insert into public.orders (user_id, course_offering_id) values (v_u1, v_o2); -- 맞닿기만(12:00) → 허용

  if v_ok then
    raise notice 'TEST96 PASS: 회차 날짜별 행 — 개강·종료 계산(KST)·여러 회차·전역 겹침 거부와 원자성·입력 검증 6종·마지막 활성 회차 보호와 재계산·비활성 회차와 같은 시간대 허용·opens_at/ends_at 패치 거부·삭제·권한·학생 같은 날 시간 충돌';
  end if;
end $$;

-- =========================================================
-- TEST 102: 이용권 부여 정합성 — grant_entitlements_for_order는 살아 있는(revoked_at is null) 행만 반환한다.
-- 회수된 행을 다시 내주지 않고, 이미 근거가 있으면 새 행도 만들지 않는다(0행 반환).
-- 새 근거(종료 취소 등)로 호출할 때만 새 활성 행을 반환한다.
-- =========================================================
do $$
declare
  v_admin uuid;
  v_user uuid;
  v_order uuid;
  v_course uuid;
  v_offering uuid;
  v_pay1 uuid := gen_random_uuid();
  v_grant_evt uuid := gen_random_uuid();
  v_grants jsonb := '[{"type":"COURSE_ACCESS"},{"type":"DISCORD_ROLE","discord_role_id":"role-t102"}]'::jsonb;
  v_cnt integer;
  v_ok boolean := true;
begin
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test102-admin@example.com', 'ADMIN') returning id into v_admin;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test102-student@example.com', 'STUDENT') returning id into v_user;
  insert into public.courses (name, category) values ('TEST102강의', 'TEST') returning id into v_course;
  v_offering := public.create_course_offering(v_course, 'TEST102', 5, 10000, null, '{}'::text[], '[]'::jsonb,
    now() - interval '2 days', '[{"date":"2035-10-01","start":"10:00","end":"12:00"}]'::jsonb,
    v_admin, 'ADMIN');
  insert into public.orders (user_id, course_offering_id, status, approved_at) values (v_user, v_offering, 'APPROVED', now()) returning id into v_order;
  insert into public.payment_events (id, order_id, event_type, amount, provider, provider_event_id)
    values (v_pay1, v_order, 'PAYMENT_SUCCEEDED', 10000, 'MOCK', 'mock-t102');

  -- 1) 첫 부여: 활성 행 2개 반환
  select count(*) into v_cnt from public.grant_entitlements_for_order(v_order, v_user, 'PAYMENT', v_pay1, v_grants);
  if v_cnt is distinct from 2 then
    v_ok := false; raise notice 'TEST102a FAIL: 첫 부여 반환 행 수(기대 2, 실제 %)', v_cnt;
  end if;

  -- 2) 멱등 재호출(회수 전): 같은 활성 행 2개 반환
  select count(*) into v_cnt from public.grant_entitlements_for_order(v_order, v_user, 'PAYMENT', v_pay1, v_grants);
  if v_cnt is distinct from 2 then
    v_ok := false; raise notice 'TEST102b FAIL: 회수 전 재호출 반환 행 수(기대 2, 실제 %)', v_cnt;
  end if;

  -- 3) 회수 실행
  perform public.revoke_entitlements(v_user, v_order, 'REFUNDED');

  -- 4) 회수 후 같은 근거 재호출: 0행 반환 (회수된 행을 내주지 않고 새 행도 만들지 않음)
  select count(*) into v_cnt from public.grant_entitlements_for_order(v_order, v_user, 'PAYMENT', v_pay1, v_grants);
  if v_cnt is distinct from 0 then
    v_ok := false; raise notice 'TEST102c FAIL: 회수 후 재호출인데 회수된 행이 반환됨(기대 0, 실제 %)', v_cnt;
  end if;

  -- 5) 테이블 전체 확인: v_pay1에 연결된 행은 여전히 2개이고 둘 다 revoked_at is not null이어야 함
  select count(*) into v_cnt from public.entitlements where payment_event_id = v_pay1 and revoked_at is null;
  if v_cnt is distinct from 0 then
    v_ok := false; raise notice 'TEST102d FAIL: 회수 후 재호출이 새 활성 행을 만듦(기대 0, 실제 %)', v_cnt;
  end if;

  -- 6) 새 근거(예: 직권 부여 또는 새 이벤트)로 호출 시 새 활성 행 반환
  insert into public.order_events (order_id, event_type, actor, actor_user_id)
    values (v_order, 'ACCESS_GRANTED', 'ADMIN', v_admin)
    returning id into v_grant_evt;
  select count(*) into v_cnt from public.grant_entitlements_for_order(v_order, v_user, 'ADMIN_GRANT', v_grant_evt, v_grants);
  if v_cnt is distinct from 2 then
    v_ok := false; raise notice 'TEST102e FAIL: 새 근거 부여 반환 행 수(기대 2, 실제 %)', v_cnt;
  end if;

  -- 7) 권한 검증: service_role만 실행 가능, anon/authenticated/public은 불가
  if has_function_privilege('anon', 'public.grant_entitlements_for_order(uuid,uuid,text,uuid,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.grant_entitlements_for_order(uuid,uuid,text,uuid,jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.grant_entitlements_for_order(uuid,uuid,text,uuid,jsonb)', 'execute') then
    v_ok := false; raise notice 'TEST102f FAIL: grant_entitlements_for_order 실행 권한이 의도와 다름';
  end if;

  if v_ok then
    raise notice 'TEST102 PASS: 이용권 부여 정합성 — 회수 전 활성 행 반환·회수 후 재호출 0행 반환 및 되살림/새 생성 없음·새 근거 정상 부여·권한';
  end if;
end $$;

-- TEST 103: 개설강의 사건 원장 (course_offering_events) 및 DEFINER 전환 검증
do $$
declare
  v_admin uuid;
  v_student uuid;
  v_course uuid;
  v_offering uuid;
  v_session_id uuid;
  v_order uuid;
  v_cnt integer;
  v_evt_id uuid;
  v_evt_rec record;
  v_ok boolean := true;
  v_err boolean := false;
  v_notice_change_id text;
begin
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test103-admin@example.com', 'ADMIN') returning id into v_admin;
  insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test103-student@example.com', 'STUDENT') returning id into v_student;
  insert into public.courses (name, category) values ('TEST103강의', 'TEST') returning id into v_course;

  -- 1) create_course_offering -> CREATED 사건 1건
  v_offering := public.create_course_offering(
    v_course, 'TEST103반', 10, 50000, null, '{}'::text[], '[]'::jsonb,
    now() - interval '2 days', '[{"date":"2035-10-01","start":"10:00","end":"12:00"}]'::jsonb,
    v_admin, 'ADMIN'
  );

  select count(*) into v_cnt from public.course_offering_events
    where course_offering_id = v_offering and event_type = 'CREATED';
  if v_cnt is distinct from 1 then
    v_ok := false; raise notice 'TEST103a FAIL: CREATED 사건 1건 기대, 실제 %', v_cnt;
  end if;

  -- 2) update_course_offering -> UPDATED 사건 1건 (가격 50000 -> 45000)
  perform public.update_course_offering(
    v_offering, v_admin, 'ADMIN', '가격 인하', jsonb_build_object('price', 45000)
  );
  select count(*) into v_cnt from public.course_offering_events
    where course_offering_id = v_offering and event_type = 'UPDATED';
  if v_cnt is distinct from 1 then
    v_ok := false; raise notice 'TEST103b FAIL: UPDATED 사건 1건 기대, 실제 %', v_cnt;
  end if;

  -- 3) set_course_offering_status -> STATUS_CHANGED 사건 1건
  perform public.set_course_offering_status(v_offering, 'CLOSED', '모집 마감', v_admin, 'ADMIN');
  select count(*) into v_cnt from public.course_offering_events
    where course_offering_id = v_offering and event_type = 'STATUS_CHANGED';
  if v_cnt is distinct from 1 then
    v_ok := false; raise notice 'TEST103c FAIL: STATUS_CHANGED 사건 1건 기대, 실제 %', v_cnt;
  end if;
  perform public.set_course_offering_status(v_offering, 'OPEN', '모집 재개', v_admin, 'ADMIN');

  -- 4) add_course_session -> SESSION_ADDED 사건 1건
  v_session_id := public.add_course_session(v_offering, v_admin, 'ADMIN', '보강 추가', '2035-10-08'::date, '10:00'::time, '12:00'::time);
  select count(*) into v_cnt from public.course_offering_events
    where course_offering_id = v_offering and event_type = 'SESSION_ADDED';
  if v_cnt is distinct from 1 then
    v_ok := false; raise notice 'TEST103d FAIL: SESSION_ADDED 사건 1건 기대, 실제 %', v_cnt;
  end if;

  -- 5) cancel_course_session -> SESSION_CANCELLED 사건 1건
  perform public.cancel_course_session(v_session_id, v_admin, 'ADMIN', '보강 취소');
  select count(*) into v_cnt from public.course_offering_events
    where course_offering_id = v_offering and event_type = 'SESSION_CANCELLED';
  if v_cnt is distinct from 1 then
    v_ok := false; raise notice 'TEST103e FAIL: SESSION_CANCELLED 사건 1건 기대, 실제 %', v_cnt;
  end if;

  -- 6) apply_schedule_change: 신청자 있는 상태에서 일정 변경 -> SCHEDULE_CHANGED 사건 1건 + 안내 change_id 일치
  insert into public.orders (user_id, course_offering_id, status, approved_at, payment_status, paid_at, payment_method)
    values (v_student, v_offering, 'APPROVED', now(), 'PAID', now(), 'CARD') returning id into v_order;

  perform public.apply_schedule_change(
    v_offering,
    v_admin,
    'ADMIN',
    '일정 전면 조정',
    '{}'::uuid[],
    '[{"date":"2035-10-15","start":"14:00","end":"16:00"}]'::jsonb
  );

  select id into v_evt_id from public.course_offering_events
    where course_offering_id = v_offering and event_type = 'SCHEDULE_CHANGED';
  if v_evt_id is null then
    v_ok := false; raise notice 'TEST103f FAIL: SCHEDULE_CHANGED 사건 없음';
  else
    -- 안내 payload의 change_id 확인
    select payload->>'change_id' into v_notice_change_id
      from public.order_events
      where order_id = v_order and event_type = 'SCHEDULE_CHANGE_NOTICE';
    if v_notice_change_id is distinct from v_evt_id::text then
      v_ok := false; raise notice 'TEST103g FAIL: 안내 change_id (%) != 원장 사건 id (%)', v_notice_change_id, v_evt_id;
    end if;
  end if;

  -- 7) end_course_offering (크론/SYSTEM) -> ENDED 사건 1건
  update public.course_offerings set recruit_opens_at = now() - interval '20 days' where id = v_offering;
  update public.course_sessions set session_date = current_date - 10 where course_offering_id = v_offering;
  perform public.end_course_offering(v_offering, null, 'SYSTEM', '종강 자동 종료');
  select count(*) into v_cnt from public.course_offering_events
    where course_offering_id = v_offering and event_type = 'ENDED' and actor = 'SYSTEM';
  if v_cnt is distinct from 1 then
    v_ok := false; raise notice 'TEST103h FAIL: ENDED (SYSTEM) 사건 1건 기대, 실제 %', v_cnt;
  end if;

  -- 8) reopen_course_offering -> END_CANCELLED 사건 1건 (before에 이전 ended 정보)
  perform public.reopen_course_offering(v_offering, v_admin, 'ADMIN', '종강일 오류로 재개');
  select count(*) into v_cnt from public.course_offering_events
    where course_offering_id = v_offering and event_type = 'END_CANCELLED';
  if v_cnt is distinct from 1 then
    v_ok := false; raise notice 'TEST103i FAIL: END_CANCELLED 사건 1건 기대, 실제 %', v_cnt;
  end if;

  -- 9) cancel_course_offering -> CANCEL_STARTED 사건 1건
  -- F-8: 종강(ends_at <= now()) 후 폐강은 거부되므로, 회차 날짜를 미래로 복원 후 폐강
  update public.course_sessions set session_date = current_date + 10 where course_offering_id = v_offering;
  perform public.cancel_course_offering(v_offering, '모집 미달 폐강', v_admin, 'ADMIN');
  select count(*) into v_cnt from public.course_offering_events
    where course_offering_id = v_offering and event_type = 'CANCEL_STARTED';
  if v_cnt is distinct from 1 then
    v_ok := false; raise notice 'TEST103j FAIL: CANCEL_STARTED 사건 1건 기대, 실제 %', v_cnt;
  end if;

  -- 10) complete_course_offering_cancel -> CANCEL_COMPLETED 사건 1건
  -- 먼저 주문 정리
  perform public.close_order_without_refund(v_order, v_admin, 'ADMIN', '폐강 처리');
  perform public.complete_course_offering_cancel(v_offering, v_admin, 'ADMIN');
  select count(*) into v_cnt from public.course_offering_events
    where course_offering_id = v_offering and event_type = 'CANCEL_COMPLETED';
  if v_cnt is distinct from 1 then
    v_ok := false; raise notice 'TEST103k FAIL: CANCEL_COMPLETED 사건 1건 기대, 실제 %', v_cnt;
  end if;

  -- 11) delete_course_offering -> DELETED 사건 1건 (신규 강의로 테스트)
  declare
    v_del_offering uuid;
  begin
    v_del_offering := public.create_course_offering(
      v_course, '삭제테스트반', 5, 10000, null, '{}'::text[], '[]'::jsonb,
      now() - interval '1 day', '[{"date":"2035-11-01","start":"10:00","end":"12:00"}]'::jsonb,
      v_admin, 'ADMIN'
    );
    perform public.delete_course_offering(v_del_offering, '오등록 삭제', v_admin, 'ADMIN');
    select count(*) into v_cnt from public.course_offering_events
      where course_offering_id = v_del_offering and event_type = 'DELETED';
    if v_cnt is distinct from 1 then
      v_ok := false; raise notice 'TEST103l FAIL: DELETED 사건 1건 기대, 실제 %', v_cnt;
    end if;
  end;

  -- 12) 원장 불변성 검증: UPDATE / DELETE 거부 (service_role)
  execute 'set local role service_role';
  v_err := false;
  begin
    update public.course_offering_events set reason = '변조 시도' where id = v_evt_id;
  exception when others then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST103m FAIL: course_offering_events UPDATE가 거부되지 않음';
  end if;

  v_err := false;
  begin
    delete from public.course_offering_events where id = v_evt_id;
  exception when others then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST103n FAIL: course_offering_events DELETE가 거부되지 않음';
  end if;
  execute 'reset role';

  -- 13) 비관리자 역할 인자 거부 검증
  v_err := false;
  begin
    perform public.set_course_offering_status(v_offering, 'OPEN', '부정 상태전이', v_admin, 'MANAGER');
  exception when others then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST103o FAIL: p_actor_role = MANAGER 호출이 거부되지 않음';
  end if;

  -- 14) 실행 권한 검증: authenticated, anon은 6개 함수 실행 불가
  if has_function_privilege('authenticated', 'public.create_course_offering(uuid,text,integer,integer,text,text[],jsonb,timestamptz,jsonb,uuid,text,boolean)', 'execute')
     or has_function_privilege('anon', 'public.create_course_offering(uuid,text,integer,integer,text,text[],jsonb,timestamptz,jsonb,uuid,text,boolean)', 'execute')
     or not has_function_privilege('service_role', 'public.create_course_offering(uuid,text,integer,integer,text,text[],jsonb,timestamptz,jsonb,uuid,text,boolean)', 'execute') then
    v_ok := false; raise notice 'TEST103p FAIL: create_course_offering 권한이 service_role 전용이 아님';
  end if;

  if v_ok then
    raise notice 'TEST103 PASS: 개설강의 사건 원장 — 11종 사건 기록·before/after·SCHEDULE_CHANGED change_id 일치·원장 불변성·DEFINER 역할 검증·service_role 권한';
  end if;
end $$;

-- =========================================================
-- TEST 107: : 설계된 예외 경로 검증
-- 1. session_has_started 판정 (과거 true, 미래 false)
-- 2. correct_past_session (시작된 회차 정정, 겹침/권한/시작전 검증, 원장 SESSION_CORRECTED 기록)
-- 3. course_offering_events 제약 (SESSION_CORRECTED, MANUAL_CORRECTION 허용)
-- 4. 종결 주문 사후 환불 (begin_refund_request post_close -> record_payment_event POST_CLOSE_REFUND -> on_payment_refunded 누적 및 REFUND_APPLIED 사건 기록, DLQ 미발생)
-- 5. 부분 환불 후 추가 환불 (A', REFUND_APPLIED 사건)
-- 6. 종결 표지 없는 취소 주문 환불 -> DLQ
-- 7. 살아있는 주문에 종결 표지 붙은 환불 -> ADMIN_REFUND로 정상 처리
-- 8. PG 외 환불의 post_close 표지 -> POST_CLOSE_REFUND
-- =========================================================
do $$
declare
  v_admin uuid;
  v_user uuid;
  v_course uuid;
  v_offering uuid;
  v_session_id uuid;
  v_new_session_id uuid;
  v_order_id uuid;
  v_ok boolean := true;
  v_err boolean;
  v_cnt integer;
  v_order record;
  v_evt record;
begin
  select id into v_admin from public.users where role = 'ADMIN' limit 1;
  insert into public.users (auth_user_id, email, role)
  values (gen_random_uuid(), 'test107-student@example.com', 'STUDENT')
  returning id into v_user;

  insert into public.courses (name, category) values ('TEST107강의', 'TEST') returning id into v_course;

  -- 1) session_has_started 함수 검증
  if not public.session_has_started('2020-01-01'::date, '10:00'::time) then
    v_ok := false; raise notice 'TEST107a FAIL: 과거 시각 session_has_started가 false 반환';
  end if;
  if public.session_has_started('2035-01-01'::date, '10:00'::time) then
    v_ok := false; raise notice 'TEST107b FAIL: 미래 시각 session_has_started가 true 반환';
  end if;

  -- 2) 개설강의 생성 (어제 회차 1개)
  -- create_course_offering을 통해 어제 회차 생성
  v_offering := public.create_course_offering(
    v_course, 'TEST107개설', 10, 50000, null, '{}'::text[], '[]'::jsonb,
    now() - interval '5 days',
    jsonb_build_array(jsonb_build_object(
      'date', (current_date - interval '1 day')::date::text,
      'start', '10:00',
      'end', '12:00'
    )),
    v_admin, 'ADMIN'
  );

  select id into v_session_id from public.course_sessions
  where course_offering_id = v_offering and deactivated_at is null limit 1;

  -- 2-1) 비관리자 역할 거부
  v_err := false;
  begin
    perform public.correct_past_session(
      v_session_id, (current_date - interval '1 day')::date, '09:00'::time, '11:00'::time,
      v_admin, 'MANAGER', '정정 사유'
    );
  exception when others then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST107c FAIL: 비관리자 correct_past_session 호출 미거부';
  end if;

  -- 2-2) 미래 시각으로 정정 거부
  v_err := false;
  begin
    perform public.correct_past_session(
      v_session_id, (current_date + interval '2 days')::date, '09:00'::time, '11:00'::time,
      v_admin, 'ADMIN', '미래로 정정 시도'
    );
  exception when others then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST107d FAIL: 미래 시각으로의 correct_past_session 미거부';
  end if;

  -- 2-3) 동일한 일정 정정 거부
  v_err := false;
  begin
    perform public.correct_past_session(
      v_session_id, (current_date - interval '1 day')::date, '10:00'::time, '12:00'::time,
      v_admin, 'ADMIN', '동일 일정 정정'
    );
  exception when others then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST107e FAIL: 동일 일정 correct_past_session 미거부';
  end if;

  -- 2-4) 정상 정정 (어제 10~12 -> 어제 09~11)
  v_new_session_id := public.correct_past_session(
    v_session_id, (current_date - interval '1 day')::date, '09:00'::time, '11:00'::time,
    v_admin, 'ADMIN', '실제 강의 시작시간 09시 진행 반영'
  );
  if v_new_session_id is null then
    v_ok := false; raise notice 'TEST107f FAIL: correct_past_session 반환 id null';
  end if;

  -- 구 회차 비활성화 및 사유 확인
  select count(*) into v_cnt from public.course_sessions
  where id = v_session_id and deactivated_at is not null and deactivated_reason like '기록 정정:%';
  if v_cnt <> 1 then
    v_ok := false; raise notice 'TEST107g FAIL: 구 회차 비활성화 및 정정 사유 미기록';
  end if;

  -- 신규 회차 활성 확인
  select count(*) into v_cnt from public.course_sessions
  where id = v_new_session_id and deactivated_at is null and start_time = '09:00'::time;
  if v_cnt <> 1 then
    v_ok := false; raise notice 'TEST107h FAIL: 신규 회차 활성화 미반영';
  end if;

  -- 원장 course_offering_events에 SESSION_CORRECTED 기록 확인
  select count(*) into v_cnt from public.course_offering_events
  where course_offering_id = v_offering and event_type = 'SESSION_CORRECTED' and actor = 'ADMIN';
  if v_cnt <> 1 then
    v_ok := false; raise notice 'TEST107i FAIL: SESSION_CORRECTED 사건 미기록';
  end if;

  -- 3) MANUAL_CORRECTION 이벤트 종류 제약 허용 확인
  insert into public.course_offering_events (
    course_offering_id, event_type, actor, actor_user_id, reason, before, after
  ) values (
    v_offering, 'MANUAL_CORRECTION', 'ADMIN', v_admin, '런북에 따른 수동 정정 테스트', '{}'::jsonb, '{}'::jsonb
  );

  -- 4) 종결 주문 사후 환불 (A) — 주문 가능한 미래 개설강의 생성
  declare
    v_offering_future uuid;
    v_u1 uuid;
    v_u2 uuid;
    v_u3 uuid;
    v_u4 uuid;
    v_u5 uuid;
    v_order2_id uuid;
    v_order3_id uuid;
    v_order4_id uuid;
    v_order5_id uuid;
  begin
    insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test107-u1@example.com', 'STUDENT') returning id into v_u1;
    insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test107-u2@example.com', 'STUDENT') returning id into v_u2;
    insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test107-u3@example.com', 'STUDENT') returning id into v_u3;
    insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test107-u4@example.com', 'STUDENT') returning id into v_u4;
    insert into public.users (auth_user_id, email, role) values (gen_random_uuid(), 'test107-u5@example.com', 'STUDENT') returning id into v_u5;

    v_offering_future := public.create_course_offering(
      v_course, 'TEST107주문용개설', 10, 50000, null, '{}'::text[], '[]'::jsonb,
      now() - interval '1 day',
      jsonb_build_array(jsonb_build_object(
        'date', (current_date + interval '10 days')::date::text,
        'start', '10:00',
        'end', '12:00'
      )),
      v_admin, 'ADMIN'
    );

    v_order_id := public.create_order(v_u1, v_offering_future, null, null);
    update public.orders set status = 'APPROVED', approved_at = now() where id = v_order_id;
    perform public.record_payment_event('MOCK', 'evt-test107-paid', 'PAYMENT_SUCCEEDED', 50000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tid-107');
    perform pg_temp.deliver_payment_facts();

    -- 주문을 환불 없이 취소(종결) 상태로 변경 (예: 수강종료 또는 직권취소)
    update public.orders set status = 'CANCELLED', cancelled_at = now() where id = v_order_id;

    -- 관리자가 post_close: true로 환불 개시
    perform public.begin_refund_request(v_order_id, 'test107-post-req-1', 50000, '종결 후 사후 환불 테스트', 'ADMIN', null, null, true, v_admin);

    -- 환불 결제 이벤트 기록 및 전달
    perform public.record_payment_event('MOCK', 'evt-test107-ref-1', 'REFUNDED', 50000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tid-107');
    perform pg_temp.deliver_payment_facts();

    -- 주문 상태 및 REFUND_APPLIED 이벤트 확인
    select * into v_order from public.orders where id = v_order_id;
    if v_order.status <> 'CANCELLED' or v_order.payment_status <> 'REFUNDED' or v_order.refunded_amount <> 50000 then
      v_ok := false; raise notice 'TEST107j FAIL: 종결 주문 사후 전액환불 미반영 (status=%, payment_status=%, refunded=%)',
        v_order.status, v_order.payment_status, v_order.refunded_amount;
    end if;

    select count(*) into v_cnt from public.order_events
    where order_id = v_order_id and event_type = 'REFUND_APPLIED' and payload->>'cause' = 'POST_CLOSE_REFUND' and (payload->>'post_close')::boolean is true;
    if v_cnt <> 1 then
      v_ok := false; raise notice 'TEST107k FAIL: REFUND_APPLIED 사건 미기록 (count=%)', v_cnt;
    end if;

    -- DLQ에 쌓이지 않았는지 확인
    select count(*) into v_cnt from public.dead_letters where payload->>'order_id' = v_order_id::text;
    if v_cnt <> 0 then
      v_ok := false; raise notice 'TEST107l FAIL: 정상 사후 환불인데 DLQ 발생 (count=%)', v_cnt;
    end if;

    -- 5) 부분 환불 후 추가 환불 (A')
    v_order2_id := public.create_order(v_u2, v_offering_future, null, null);
    update public.orders set status = 'APPROVED', approved_at = now() where id = v_order2_id;
    perform public.record_payment_event('MOCK', 'evt-test107-paid-2', 'PAYMENT_SUCCEEDED', 50000, 'KRW', v_order2_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tid-107-2');
    perform pg_temp.deliver_payment_facts();

    -- 첫 부분환불 20000원 (일반 환불)
    perform public.begin_refund_request(v_order2_id, 'test107-req-part', 20000, '첫 부분환불', 'ADMIN', null, null, false, v_admin);
    perform public.record_payment_event('MOCK', 'evt-test107-ref-2a', 'REFUNDED', 20000, 'KRW', v_order2_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tid-107-2');
    perform pg_temp.deliver_payment_facts();

    -- 이제 주문은 CANCELLED + PARTIALLY_REFUNDED
    -- 추가 환불 30000원 진행
    perform public.begin_refund_request(v_order2_id, 'test107-req-add', 30000, '추가 환불', 'ADMIN', null, null, false, v_admin);
    perform public.record_payment_event('MOCK', 'evt-test107-ref-2b', 'REFUNDED', 30000, 'KRW', v_order2_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tid-107-2');
    perform pg_temp.deliver_payment_facts();

    select * into v_order from public.orders where id = v_order2_id;
    if v_order.payment_status <> 'REFUNDED' or v_order.refunded_amount <> 50000 then
      v_ok := false; raise notice 'TEST107m FAIL: 부분환불 후 추가환불 미반영 (payment_status=%, refunded=%)',
        v_order.payment_status, v_order.refunded_amount;
    end if;

    -- 추가 환불에 대해 REFUND_APPLIED 사건 기록 확인
    select count(*) into v_cnt from public.order_events
    where order_id = v_order2_id and event_type = 'REFUND_APPLIED';
    if v_cnt <> 1 then
      v_ok := false; raise notice 'TEST107n FAIL: 추가 환불에 대한 REFUND_APPLIED 사건 미기록 (count=%)', v_cnt;
    end if;

    -- 6) 종결 표지 없는 취소 주문 환불 -> DLQ 발생 확인
    v_order3_id := public.create_order(v_u3, v_offering_future, null, null);
    update public.orders set status = 'APPROVED', approved_at = now() where id = v_order3_id;
    perform public.record_payment_event('MOCK', 'evt-test107-paid-3', 'PAYMENT_SUCCEEDED', 50000, 'KRW', v_order3_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tid-107-3');
    perform pg_temp.deliver_payment_facts();

    -- 임의 취소 (결제상태는 PAID인 채로)
    update public.orders set status = 'CANCELLED', cancelled_at = now() where id = v_order3_id;

    -- post_close false로 외부 환불 도착 시뮬레이션
    perform public.record_payment_event('MOCK', 'evt-test107-ref-ext', 'REFUNDED', 50000, 'KRW', v_order3_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tid-107-3');
    perform pg_temp.deliver_payment_facts();

    -- DLQ 확인
    select count(*) into v_cnt from public.dead_letters where payload->>'order_id' = v_order3_id::text;
    if v_cnt <> 1 then
      v_ok := false; raise notice 'TEST107o FAIL: 표지 없는 취소 주문 환불이 DLQ에 기록되지 않음 (count=%)', v_cnt;
    end if;

    -- 7) 살아있는 주문(APPROVED)에 post_close가 잘못 붙은 경우 -> ADMIN_REFUND로 정상 전이
    v_order4_id := public.create_order(v_u4, v_offering_future, null, null);
    update public.orders set status = 'APPROVED', approved_at = now() where id = v_order4_id;
    perform public.record_payment_event('MOCK', 'evt-test107-paid-4', 'PAYMENT_SUCCEEDED', 50000, 'KRW', v_order4_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tid-107-4');
    perform pg_temp.deliver_payment_facts();

    perform public.begin_refund_request(v_order4_id, 'test107-req-alive-pc', 50000, '오기입 환불', 'ADMIN', null, null, true, v_admin);
    perform public.record_payment_event('MOCK', 'evt-test107-ref-4', 'REFUNDED', 50000, 'KRW', v_order4_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tid-107-4');
    perform pg_temp.deliver_payment_facts();

    select * into v_order from public.orders where id = v_order4_id;
    if v_order.status <> 'CANCELLED' or v_order.payment_status <> 'REFUNDED' then
      v_ok := false; raise notice 'TEST107p FAIL: post_close 붙은 살아있는 주문 환불 전이 실패';
    end if;
    select count(*) into v_cnt from public.order_events
    where order_id = v_order4_id and event_type = 'CANCELLED' and payload->>'cause' = 'ADMIN_REFUND';
    if v_cnt <> 1 then
      v_ok := false; raise notice 'TEST107q FAIL: 원인이 ADMIN_REFUND로 다운그레이드되지 않음 (count=%)', v_cnt;
    end if;

    -- 8) PG 외 환불의 post_close 표지 반영
    v_order5_id := public.create_order(v_u5, v_offering_future, null, null);
    update public.orders set status = 'APPROVED', approved_at = now() where id = v_order5_id;
    perform public.record_payment_event('MANUAL', 'evt-test107-paid-5', 'PAYMENT_SUCCEEDED', 50000, 'KRW', v_order5_id, 'BANK_TRANSFER', '{}'::jsonb, '{}'::jsonb);
    perform pg_temp.deliver_payment_facts();

    update public.orders set status = 'CANCELLED', cancelled_at = now() where id = v_order5_id;

    perform public.record_payment_event('MANUAL', 'evt-test107-ref-5', 'REFUNDED', 50000, 'KRW', v_order5_id, 'BANK_TRANSFER',
      '{"source":"ADMIN_MANUAL_REFUND","post_close":true,"reason":"수동 계좌이체 환불"}'::jsonb, '{}'::jsonb);
    perform pg_temp.deliver_payment_facts();

    select * into v_order from public.orders where id = v_order5_id;
    if v_order.payment_status <> 'REFUNDED' or v_order.refunded_amount <> 50000 then
      v_ok := false; raise notice 'TEST107r FAIL: 수동 종결 후 환불 미반영';
    end if;
    select count(*) into v_cnt from public.order_events
    where order_id = v_order5_id and event_type = 'REFUND_APPLIED' and payload->>'cause' = 'POST_CLOSE_REFUND';
    if v_cnt <> 1 then
      v_ok := false; raise notice 'TEST107s FAIL: 수동 환불 REFUND_APPLIED 미기록';
    end if;
  end;

  if v_ok then
    raise notice 'TEST107 PASS: 설계된 예외 경로 — session_has_started·correct_past_session·SESSION_CORRECTED·MANUAL_CORRECTION·종결주문 사후환불·REFUND_APPLIED 사건·A추가환불·DLQ 격리';
  end if;
end $$;

-- TEST104: 개설강의·회차 직접 쓰기 차단
-- (1) authenticated(관리자 세션)의 개설강의·회차 직접 insert/update/delete 거부 및 select 허용
-- (2) service_role의 상태 전이 순서 강제 (OPEN↔CLOSED, OPEN|CLOSED→CANCELLING, CANCELLING→CANCELLED 허용, 그 외 거부, 상태 미변경 update 허용)
-- (3) service_role의 회차 불변성 (DELETE 거부, session_date/start_time/end_time/course_offering_id UPDATE 거부, 되살리기 거부, 비활성화 허용)
-- (4) 정상 RPC 흐름 및 정정(correct_past_session, apply_schedule_change) 정상 동작 확인
do $$
declare
  v_ok boolean := true;
  v_err boolean;
  v_admin_auth uuid := gen_random_uuid();
  v_admin_id uuid;
  v_course_id uuid;
  v_off_id uuid;
  v_sess_id uuid;
  v_sess2_id uuid;
  v_cnt integer;
  v_res jsonb;
  v_today_date date := (now() at time zone 'Asia/Seoul')::date;
begin
  -- 준비: 관리자 유저 및 기본 강의
  insert into public.users (auth_user_id, email, role)
    values (v_admin_auth, 'test104adm@example.com', 'ADMIN')
    returning id into v_admin_id;

  insert into public.courses (name, category)
    values ('TEST104강의', 'TEST')
    returning id into v_course_id;

  -- RPC로 정상 개설강의 생성
  v_off_id := public.create_course_offering(
    v_course_id, 'TEST104개설', 10, 50000, null, '{}'::text[], '[]'::jsonb,
    (now() - interval '1 hour')::timestamptz,
    jsonb_build_array(
      jsonb_build_object('date', (v_today_date + 5)::text, 'start', '10:00', 'end', '12:00'),
      jsonb_build_object('date', (v_today_date + 6)::text, 'start', '10:00', 'end', '12:00')
    ),
    v_admin_id, 'ADMIN'
  );

  select id into v_sess_id from public.course_sessions
  where course_offering_id = v_off_id and deactivated_at is null
  order by session_date asc limit 1;

  select id into v_sess2_id from public.course_sessions
  where course_offering_id = v_off_id and deactivated_at is null
  order by session_date desc limit 1;

  -- =========================================================
  -- Part 1: authenticated(관리자 세션) 직접 쓰기 차단 검증
  -- =========================================================
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin_auth, 'role', 'authenticated')::text, true);

  -- 1-1) course_offerings 직접 INSERT 거부
  v_err := false;
  begin
    insert into public.course_offerings (course_id, label, capacity, remaining_seats, price, status, recruit_opens_at, opens_at, grants, required_terms_types)
      values (v_course_id, '직접추가시도', 5, 5, 10000, 'OPEN', now(), now() + interval '1 day', '[]'::jsonb, '{}'::text[]);
  exception when others then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104a FAIL: authenticated의 course_offerings 직접 INSERT가 거부되지 않음';
  end if;

  -- 1-2) course_offerings 직접 UPDATE 거부
  v_err := false;
  begin
    update public.course_offerings set label = '직접수정시도' where id = v_off_id;
  exception when others then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104b FAIL: authenticated의 course_offerings 직접 UPDATE가 거부되지 않음';
  end if;

  -- 1-3) course_offerings 직접 DELETE 거부
  v_err := false;
  begin
    delete from public.course_offerings where id = v_off_id;
  exception when others then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104c FAIL: authenticated의 course_offerings 직접 DELETE가 거부되지 않음';
  end if;

  -- 1-4) course_sessions 직접 INSERT 거부
  v_err := false;
  begin
    insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
      values (v_off_id, v_today_date + 10, '10:00', '12:00');
  exception when others then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104d FAIL: authenticated의 course_sessions 직접 INSERT가 거부되지 않음';
  end if;

  -- 1-5) course_sessions 직접 UPDATE 거부
  v_err := false;
  begin
    update public.course_sessions set deactivated_at = now() where id = v_sess_id;
  exception when others then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104e FAIL: authenticated의 course_sessions 직접 UPDATE가 거부되지 않음';
  end if;

  -- 1-6) course_sessions 직접 DELETE 거부
  v_err := false;
  begin
    delete from public.course_sessions where id = v_sess_id;
  exception when others then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104f FAIL: authenticated의 course_sessions 직접 DELETE가 거부되지 않음';
  end if;

  -- 1-7) authenticated SELECT는 여전히 허용
  select count(*) into v_cnt from public.course_offerings where id = v_off_id;
  if v_cnt <> 1 then
    v_ok := false; raise notice 'TEST104g FAIL: authenticated의 course_offerings SELECT 실패';
  end if;
  select count(*) into v_cnt from public.course_sessions where course_offering_id = v_off_id;
  if v_cnt <> 2 then
    v_ok := false; raise notice 'TEST104h FAIL: authenticated의 course_sessions SELECT 실패';
  end if;

  execute 'reset role';

  -- =========================================================
  -- Part 2: service_role 상태 전이 순서 규칙 검증
  -- =========================================================
  execute 'set local role service_role';

  -- 2-1) 금지 전이: OPEN -> CANCELLED 직접 전이 거부
  v_err := false;
  begin
    update public.course_offerings
    set status = 'CANCELLED', status_reason = '직접취소', status_changed_by = v_admin_id, status_changed_at = clock_timestamp()
    where id = v_off_id;
  exception when check_violation then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104i FAIL: OPEN -> CANCELLED 직접 전이가 거부되지 않음';
  end if;

  -- 2-2) 상태 미변경 UPDATE 허용 (label 등 일반 컬럼 수정)
  update public.course_offerings set label = '라벨변경성공' where id = v_off_id;

  -- 2-3) 허용 전이: OPEN -> CLOSED
  update public.course_offerings
  set status = 'CLOSED', status_reason = '마감', status_changed_by = v_admin_id, status_changed_at = clock_timestamp()
  where id = v_off_id;

  -- 2-4) 금지 전이: CLOSED -> CANCELLED 직접 전이 거부
  v_err := false;
  begin
    update public.course_offerings
    set status = 'CANCELLED', status_reason = '마감후직접취소', status_changed_by = v_admin_id, status_changed_at = clock_timestamp()
    where id = v_off_id;
  exception when check_violation then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104j FAIL: CLOSED -> CANCELLED 직접 전이가 거부되지 않음';
  end if;

  -- 2-5) 허용 전이: CLOSED -> OPEN
  update public.course_offerings
  set status = 'OPEN', status_reason = '재개', status_changed_by = v_admin_id, status_changed_at = clock_timestamp()
  where id = v_off_id;

  -- 2-6) 허용 전이: OPEN -> CANCELLING
  update public.course_offerings
  set status = 'CANCELLING', status_reason = '폐강시작', status_changed_by = v_admin_id, status_changed_at = clock_timestamp()
  where id = v_off_id;

  -- 2-7) 금지 전이: CANCELLING -> OPEN 역행 거부
  v_err := false;
  begin
    update public.course_offerings
    set status = 'OPEN', status_reason = '폐강중재개시도', status_changed_by = v_admin_id, status_changed_at = clock_timestamp()
    where id = v_off_id;
  exception when check_violation then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104k FAIL: CANCELLING -> OPEN 역행이 거부되지 않음';
  end if;

  -- 2-8) 허용 전이: CANCELLING -> CANCELLED
  update public.course_offerings
  set status = 'CANCELLED', status_reason = '폐강완료', status_changed_by = v_admin_id, status_changed_at = clock_timestamp()
  where id = v_off_id;

  -- 2-9) 금지 전이: CANCELLED -> OPEN 거부
  v_err := false;
  begin
    update public.course_offerings
    set status = 'OPEN', status_reason = '취소후재개시도', status_changed_by = v_admin_id, status_changed_at = clock_timestamp()
    where id = v_off_id;
  exception when check_violation then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104l FAIL: CANCELLED -> OPEN 전이가 거부되지 않음';
  end if;

  -- =========================================================
  -- Part 3: service_role 회차 불변 규칙 검증
  -- =========================================================
  -- 3-1) 회차 DELETE 거부
  v_err := false;
  begin
    delete from public.course_sessions where id = v_sess_id;
  exception when restrict_violation then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104m FAIL: 회차 DELETE가 거부되지 않음';
  end if;

  -- 3-2) session_date 고쳐쓰기 거부
  v_err := false;
  begin
    update public.course_sessions set session_date = v_today_date + 20 where id = v_sess_id;
  exception when restrict_violation then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104n FAIL: 회차 session_date UPDATE가 거부되지 않음';
  end if;

  -- 3-3) start_time 고쳐쓰기 거부
  v_err := false;
  begin
    update public.course_sessions set start_time = '09:00:00' where id = v_sess_id;
  exception when restrict_violation then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104o FAIL: 회차 start_time UPDATE가 거부되지 않음';
  end if;

  -- 3-4) end_time 고쳐쓰기 거부
  v_err := false;
  begin
    update public.course_sessions set end_time = '13:00:00' where id = v_sess_id;
  exception when restrict_violation then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104p FAIL: 회차 end_time UPDATE가 거부되지 않음';
  end if;

  -- 3-5) course_offering_id 고쳐쓰기 거부
  v_err := false;
  begin
    update public.course_sessions set course_offering_id = gen_random_uuid() where id = v_sess_id;
  exception when restrict_violation then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104q FAIL: 회차 course_offering_id UPDATE가 거부되지 않음';
  end if;

  -- 3-6) 회차 비활성화(deactivated_at 설정) 허용
  update public.course_sessions
  set deactivated_at = now(), deactivated_reason = '정상 비활성화'
  where id = v_sess_id;

  -- 3-7) 취소된 회차 되살리기(deactivated_at = null) 거부
  v_err := false;
  begin
    update public.course_sessions set deactivated_at = null where id = v_sess_id;
  exception when restrict_violation then
    v_err := true;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST104r FAIL: 비활성화 회차의 deactivated_at null 복원이 거부되지 않음';
  end if;

  execute 'reset role';

  -- =========================================================
  -- Part 4: 정상 RPC 경로(F-7 correct_past_session, apply_schedule_change) 통과 확인
  -- =========================================================
  -- 4-1) 새 개설강의 준비 (미래 회차들)
  v_off_id := public.create_course_offering(
    v_course_id, 'TEST104RPC검증', 10, 50000, null, '{}'::text[], '[]'::jsonb,
    (now() - interval '1 hour')::timestamptz,
    jsonb_build_array(
      jsonb_build_object('date', (v_today_date + 3)::text, 'start', '10:00', 'end', '12:00'),
      jsonb_build_object('date', (v_today_date + 4)::text, 'start', '10:00', 'end', '12:00')
    ),
    v_admin_id, 'ADMIN'
  );

  select id into v_sess_id from public.course_sessions
  where course_offering_id = v_off_id and deactivated_at is null
  order by session_date asc limit 1;

  -- 4-2) apply_schedule_change (일정 변경: 취소 1건 + 추가 1건) 정상 통과
  v_res := public.apply_schedule_change(
    v_off_id,
    v_admin_id,
    'ADMIN',
    'F-3 트리거 공존 테스트',
    array[v_sess_id],
    jsonb_build_array(jsonb_build_object('date', (v_today_date + 7)::text, 'start', '14:00', 'end', '16:00'))
  );
  if v_res is null then
    v_ok := false; raise notice 'TEST104s FAIL: apply_schedule_change 실패';
  end if;

  -- 4-3) correct_past_session (과거 회차 정정: 취소 + 추가) 정상 통과
  -- 과거 개설강의 별도 준비
  v_off_id := public.create_course_offering(
    v_course_id, 'TEST104정정용개설', 10, 50000, null, '{}'::text[], '[]'::jsonb,
    now() - interval '10 days',
    jsonb_build_array(jsonb_build_object(
      'date', (v_today_date - 2)::text,
      'start', '10:00',
      'end', '12:00'
    )),
    v_admin_id, 'ADMIN'
  );

  select id into v_sess2_id from public.course_sessions
  where course_offering_id = v_off_id and deactivated_at is null limit 1;

  declare
    v_new_session_id uuid;
  begin
    v_new_session_id := public.correct_past_session(
      v_sess2_id,
      (v_today_date - 1)::date,
      '10:00'::time,
      '12:00'::time,
      v_admin_id,
      'ADMIN',
      'F-3 트리거 검증 정정'
    );
    if v_new_session_id is null then
      v_ok := false; raise notice 'TEST104t FAIL: correct_past_session 실패';
    end if;
  end;

  if v_ok then
    raise notice 'TEST104 PASS: 개설강의·회차 직접 쓰기 차단 — 관리자 직접쓰기 RLS·권한 회수·상태전이 순서·회차불변(삭제/수정/되살리기 금지)·정상 RPC(apply_schedule_change, correct_past_session) 공존 확인';
  end if;
end $$;

-- =========================================================
-- TEST 105: 개강 후 시작하지 않은 회차 변경 + N4 종료/폐강 개설강의 응답·제외 거부
-- =========================================================
do $$
declare
  v_ok boolean := true;
  v_err boolean;
  v_admin_id uuid;
  v_user_id uuid;
  v_course_id uuid;
  v_off_id uuid;
  v_sess_past uuid;
  v_sess_future1 uuid;
  v_sess_future2 uuid;
  v_today_date date;
  v_res jsonb;
  v_order_id uuid;
  v_notice_id uuid;
  v_opens_before timestamptz;
  v_opens_after timestamptz;
  v_cancel_res uuid;
begin
  insert into public.users (auth_user_id, email, role)
  values (gen_random_uuid(), 'f4-adm@example.com', 'ADMIN')
  returning id into v_admin_id;

  execute 'set local role service_role';

  insert into public.users (auth_user_id, email, role)
  values (gen_random_uuid(), 'f4-stu@example.com', 'STUDENT')
  returning id into v_user_id;

  insert into public.courses (name, category)
  values ('TEST105강의', 'TEST')
  returning id into v_course_id;

  v_today_date := (now() at time zone 'Asia/Seoul')::date;

  -- 1) 개설강의 준비: 첫 회차는 과거(어제, 이미 시작됨), 2·3회차는 미래
  v_off_id := public.create_course_offering(
    v_course_id, 'TEST105개설강의', 10, 50000, null, '{}'::text[], '[]'::jsonb,
    (now() - interval '10 days')::timestamptz,
    jsonb_build_array(
      jsonb_build_object('date', (v_today_date - 1)::text, 'start', '10:00', 'end', '12:00'),
      jsonb_build_object('date', (v_today_date + 3)::text, 'start', '10:00', 'end', '12:00'),
      jsonb_build_object('date', (v_today_date + 5)::text, 'start', '10:00', 'end', '12:00')
    ),
    v_admin_id, 'ADMIN'
  );

  select opens_at into v_opens_before from public.course_offerings where id = v_off_id;

  -- 각 회차 ID 조회
  select id into v_sess_past from public.course_sessions
  where course_offering_id = v_off_id and session_date = (v_today_date - 1);

  select id into v_sess_future1 from public.course_sessions
  where course_offering_id = v_off_id and session_date = (v_today_date + 3);

  select id into v_sess_future2 from public.course_sessions
  where course_offering_id = v_off_id and session_date = (v_today_date + 5);

  -- 주문 생성 (신청 1건 - 직권부여 WAIVED로 설정하여 폐강 시 자동 정리되지 않고 유지되도록 함)
  insert into public.orders (user_id, course_offering_id, status, approved_at, payment_status, list_price, final_amount, refund_policy_version)
  values (v_user_id, v_off_id, 'APPROVED', now(), 'WAIVED', 50000, 50000, '2026-10-08-standard')
  returning id into v_order_id;

  -- 1-1) 시작된 회차(v_sess_past) 취소 시도 거부
  v_err := false;
  begin
    perform public.apply_schedule_change(
      v_off_id, v_admin_id, 'ADMIN', '시작된회차취소',
      array[v_sess_past],
      jsonb_build_array(jsonb_build_object('date', (v_today_date + 7)::text, 'start', '10:00', 'end', '12:00'))
    );
  exception when others then
    if sqlerrm like '%이미 시작한 회차%' then v_err := true; end if;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST105a FAIL: 이미 시작한 회차 취소가 거부되지 않음';
  end if;

  -- 1-2) 과거 시각으로 회차 추가 시도 거부
  v_err := false;
  begin
    perform public.apply_schedule_change(
      v_off_id, v_admin_id, 'ADMIN', '과거회차추가',
      array[v_sess_future1],
      jsonb_build_array(jsonb_build_object('date', (v_today_date - 2)::text, 'start', '10:00', 'end', '12:00'))
    );
  exception when others then
    if sqlerrm like '%현재 이후여야 합니다%' then v_err := true; end if;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST105b FAIL: 과거 시각 회차 추가가 거부되지 않음';
  end if;

  -- 1-3) 시작 전 회차 모두 취소하여 미래 활성 회차 0개 남기기 거부 (중도 폐강 유도 안내)
  v_err := false;
  begin
    perform public.apply_schedule_change(
      v_off_id, v_admin_id, 'ADMIN', '미래회차전부취소',
      array[v_sess_future1, v_sess_future2],
      '[]'::jsonb
    );
  exception when others then
    if sqlerrm like '%시작하지 않은 활성 회차가 1개 이상%' then v_err := true; end if;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST105c FAIL: 미래 활성 회차 0개 남기기가 거부되지 않음';
  end if;

  -- 1-4) 정상 변경: 미래 회차 1건 취소 + 새 미래 회차 1건 추가 -> 허용, opens_at 불변, 원장 및 안내에 started: true 기록
  v_res := public.apply_schedule_change(
    v_off_id, v_admin_id, 'ADMIN', '미래회차정상변경',
    array[v_sess_future2],
    jsonb_build_array(jsonb_build_object('date', (v_today_date + 7)::text, 'start', '14:00', 'end', '16:00'))
  );

  select opens_at into v_opens_after from public.course_offerings where id = v_off_id;
  if v_opens_after is distinct from v_opens_before then
    v_ok := false; raise notice 'TEST105d FAIL: 개강 후 변경 시 opens_at이 변경됨';
  end if;

  -- 원장 event 확인 (started: true)
  declare
    v_after_payload jsonb;
    v_notice_payload jsonb;
  begin
    select after into v_after_payload from public.course_offering_events where id = (v_res->>'change_id')::uuid;
    if (v_after_payload->>'started')::boolean is not true then
      v_ok := false; raise notice 'TEST105e FAIL: 원장 after에 started=true 없음: %', v_after_payload;
    end if;

    select id, payload into v_notice_id, v_notice_payload from public.order_events
    where order_id = v_order_id and event_type = 'SCHEDULE_CHANGE_NOTICE'
    order by created_at desc limit 1;

    if (v_notice_payload->>'started')::boolean is not true then
      v_ok := false; raise notice 'TEST105f FAIL: 안내 payload에 started=true 없음: %', v_notice_payload;
    end if;
  end;

  -- =========================================================
  -- Part 2: N4 개설강의 상태 확인 (종료 또는 폐강 시 응답 및 제외 거부)
  -- =========================================================

  -- 2-1) 폐강 진행 중(CANCELLING) 상태로 전이
  perform public.cancel_course_offering(v_off_id, 'TEST105폐강테스트', v_admin_id, 'ADMIN');

  -- 폐강 중 강의에 대해 exclude_order_for_schedule_change 시도 -> 거부
  v_err := false;
  begin
    perform public.exclude_order_for_schedule_change(v_order_id, v_admin_id, 'ADMIN', '폐강중제외시도');
  exception when others then
    if sqlerrm like '%폐강 중인 수업%' then v_err := true; end if;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST105h FAIL: 폐강 중 개설강의 일정변경 제외가 거부되지 않음';
  end if;

  -- 2-2) 종료(ended_at is not null) 상태인 별도 개설강의 생성
  declare
    v_ended_off_id uuid;
    v_ended_order_id uuid;
    v_ended_notice_id uuid;
  begin
    v_ended_off_id := public.create_course_offering(
      v_course_id, 'TEST105종료개설', 10, 50000, null, '{}'::text[], '[]'::jsonb,
      (now() - interval '20 days')::timestamptz,
      jsonb_build_array(
        jsonb_build_object('date', (v_today_date - 15)::text, 'start', '10:00', 'end', '12:00'),
        jsonb_build_object('date', (v_today_date - 10)::text, 'start', '10:00', 'end', '12:00')
      ),
      v_admin_id, 'ADMIN'
    );

    insert into public.orders (user_id, course_offering_id, status, approved_at, payment_status, list_price, final_amount, refund_policy_version)
    values (v_user_id, v_ended_off_id, 'APPROVED', now(), 'WAIVED', 50000, 50000, '2026-10-08-standard')
    returning id into v_ended_order_id;

    -- 가짜 안내 사건 삽입 (종료 전 생성된 안내 시뮬레이션)
    insert into public.order_events (order_id, event_type, actor, actor_user_id, payload)
    values (v_ended_order_id, 'SCHEDULE_CHANGE_NOTICE', 'ADMIN', v_admin_id, jsonb_build_object('change_id', gen_random_uuid()))
    returning id into v_ended_notice_id;

    -- 강의 종료 수행
    perform public.end_course_offering(v_ended_off_id, v_admin_id, 'ADMIN', 'TEST105 정상 종료');

    -- 종료된 개설강의의 안내에 exclude_order_for_schedule_change 시도 -> 거부
    v_err := false;
    begin
      perform public.exclude_order_for_schedule_change(v_ended_order_id, v_admin_id, 'ADMIN', '종료된강의제외시도');
    exception when others then
      if sqlerrm like '%종료된 수업%' then v_err := true; end if;
    end;
    if not v_err then
      v_ok := false; raise notice 'TEST105j FAIL: 종료된 개설강의 일정변경 제외가 거부되지 않음';
    end if;
  end;

  if v_ok then
    raise notice 'TEST105 PASS: F-4 개강 후 미래 회차 변경(시작시각 기준)·시작 회차 취소 차단·과거 추가 차단·미래 회차 소진 차단·opens_at 불변·원장/안내 started 표기 및 N4 종료/폐강 개설강의 응답/제외 차단 검증 완료';
  end if;
end $$;

-- TEST 109: F-9 계약 조건 변경(장소 안내·동의, 디스코드 재부여), 탈퇴 원인, 종료 뒤 환불 사실, decide_no_refund
do $$
declare
  v_admin_id uuid := gen_random_uuid();
  v_user1_id uuid := gen_random_uuid();
  v_user2_id uuid := gen_random_uuid();
  v_course_id uuid;
  v_off_id uuid;
  v_order1_id uuid;
  v_order2_id uuid;
  v_order1_num text := 'ORD-TEST109-1';
  v_order2_num text := 'ORD-TEST109-2';
  v_sess1_id uuid;
  v_sess2_id uuid;
  v_res jsonb;
  v_err boolean;
  v_ok boolean := true;
  v_ent1_id uuid;
  v_ent2_id uuid;
  v_ev record;
  v_outbox record;
  v_pe_id uuid := gen_random_uuid();
begin
  reset role;

  -- 1) 사용자 및 과목 준비: ADMIN은 postgres 역할에서 생성 후 service_role로 전환
  insert into public.users (auth_user_id, email, role)
  values (gen_random_uuid(), 'admin109@test.com', 'ADMIN')
  returning id into v_admin_id;

  execute 'set local role service_role';

  insert into public.users (auth_user_id, email, role)
  values (gen_random_uuid(), 'user109_1@test.com', 'STUDENT')
  returning id into v_user1_id;

  insert into public.users (auth_user_id, email, role)
  values (gen_random_uuid(), 'user109_2@test.com', 'STUDENT')
  returning id into v_user2_id;

  insert into public.courses (name, category) values ('TEST109 과목', 'TEST') returning id into v_course_id;

  -- 2) 개설강의 생성 (오프라인, 강남역, 미래 회차 2개)
  insert into public.course_offerings (
    id, course_id, label, location, recruit_opens_at, opens_at, ends_at, capacity, remaining_seats, price, status,
    grants
  ) values (
    gen_random_uuid(), v_course_id, '109기', '강남역 강의실', now() - interval '1 hour',
    now() + interval '2 days', now() + interval '5 days', 10, 8, 100000, 'OPEN',
    jsonb_build_array(
      jsonb_build_object('type', 'COURSE_ACCESS'),
      jsonb_build_object('type', 'DISCORD_ROLE', 'discord_role_id', 'role_old')
    )
  ) returning id into v_off_id;

  insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
  values (v_off_id, (now() + interval '2 days')::date, '14:00', '16:00')
  returning id into v_sess1_id;

  insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
  values (v_off_id, (now() + interval '5 days')::date, '14:00', '16:00')
  returning id into v_sess2_id;

  -- 3) 주문 2건 생성 및 승인/결제완료 처리
  insert into public.orders (id, user_id, course_offering_id, status, approved_at, payment_status, paid_at, payment_method, final_amount, list_price, refund_policy_version)
  values (gen_random_uuid(), v_user1_id, v_off_id, 'APPROVED', now(), 'PAID', now(), 'CARD', 100000, 100000, '2026-10-09-standard')
  returning id into v_order1_id;

  insert into public.orders (id, user_id, course_offering_id, status, approved_at, payment_status, paid_at, payment_method, final_amount, list_price, refund_policy_version)
  values (gen_random_uuid(), v_user2_id, v_off_id, 'APPROVED', now(), 'PAID', now(), 'CARD', 100000, 100000, '2026-10-09-standard')
  returning id into v_order2_id;

  -- 4) 경계 사례 1: 살아있는 신청자가 있을 때 update_course_offering 으로 location 변경 시 거부 확인
  v_err := false;
  begin
    perform public.update_course_offering(
      v_off_id, v_admin_id, 'ADMIN', '장소 임의 변경',
      jsonb_build_object('location', '역삼역 강의실')
    );
  exception when others then
    if sqlerrm like '%신청자가 있는 수업의 장소는 「수업 조건 변경」으로 바꿉니다%' then
      v_err := true;
    end if;
  end;
  if not v_err then
    v_ok := false; raise notice 'TEST109a FAIL: 살아있는 신청자가 있는데 update_course_offering location 변경이 거부되지 않음';
  end if;

  -- 5) apply_schedule_change 를 통해 수업 조건 변경(장소 변경 포함)
  v_res := public.apply_schedule_change(
    v_off_id, v_admin_id, 'ADMIN', '장소 및 일정 변경 안내',
    '{}'::uuid[], '[]'::jsonb, '역삼역 강의실'
  );

  if (select location from public.course_offerings where id = v_off_id) <> '역삼역 강의실' then
    v_ok := false; raise notice 'TEST109b FAIL: apply_schedule_change 후 location 이 갱신되지 않음';
  end if;

  -- 원장 SCHEDULE_CHANGED 및 주문 안내 SCHEDULE_CHANGE_NOTICE 에 location 기록 확인
  if not exists (
    select 1 from public.course_offering_events
    where id = (v_res->>'change_id')::uuid
      and event_type = 'SCHEDULE_CHANGED'
      and (after->>'location') = '역삼역 강의실'
  ) then
    v_ok := false; raise notice 'TEST109c FAIL: 원장 사건에 변경된 location 이 없음';
  end if;

  if not exists (
    select 1 from public.order_events
    where order_id = v_order1_id
      and event_type = 'SCHEDULE_CHANGE_NOTICE'
      and (payload->>'after_location') = '역삼역 강의실'
  ) then
    v_ok := false; raise notice 'TEST109d FAIL: 주문 안내 사건에 after_location 이 없음';
  end if;

  -- 6) 경계 사례 6: 디스코드 역할 변경 + 재부여(p_reissue_discord=true)
  -- 주문 1에 payment_event 생성 후 이용권(COURSE_ACCESS 및 DISCORD_ROLE role_old) 부여
  insert into public.payment_events (id, order_id, event_type, provider, provider_event_id, amount)
  values (v_pe_id, v_order1_id, 'PAYMENT_SUCCEEDED', 'TOSS', gen_random_uuid()::text, 100000);

  insert into public.entitlements (user_id, order_id, type, grant_source, payment_event_id, metadata, access_code)
  values (v_user1_id, v_order1_id, 'COURSE_ACCESS', 'PAYMENT', v_pe_id, '{}'::jsonb, public.generate_access_code())
  returning id into v_ent1_id;

  insert into public.entitlements (user_id, order_id, type, grant_source, payment_event_id, metadata, access_code)
  values (v_user1_id, v_order1_id, 'DISCORD_ROLE', 'PAYMENT', v_pe_id, jsonb_build_object('discord_role_id', 'role_old'), public.generate_access_code())
  returning id into v_ent2_id;

  perform public.update_course_offering(
    v_off_id, v_admin_id, 'ADMIN', '디스코드 역할 교체',
    jsonb_build_object('discord_role_id', 'role_new'),
    true
  );

  -- 주문 사건 GRANTS_REISSUED 및 outbox ORDER_GRANTS_REISSUED 확인
  if not exists (
    select 1 from public.order_events
    where order_id = v_order1_id
      and event_type = 'GRANTS_REISSUED'
      and (payload->>'to_role') = 'role_new'
  ) then
    v_ok := false; raise notice 'TEST109e FAIL: GRANTS_REISSUED 주문 사건이 기록되지 않음';
  end if;

  if not exists (
    select 1 from public.outbox_messages
    where topic = 'ORDER_GRANTS_REISSUED'
      and (payload->>'order_id') = v_order1_id::text
      and (payload->>'to_role') = 'role_new'
  ) then
    v_ok := false; raise notice 'TEST109f FAIL: ORDER_GRANTS_REISSUED outbox 메시지가 발행되지 않음';
  end if;

  -- 7) revoke_entitlements p_type 인자 테스트: 디스코드 역할만 회수되고 COURSE_ACCESS 는 불변
  perform public.revoke_entitlements(v_user1_id, v_order1_id, 'GRANTS_REISSUED', 'DISCORD_ROLE');

  if (select revoked_at from public.entitlements where id = v_ent1_id) is not null then
    v_ok := false; raise notice 'TEST109g FAIL: COURSE_ACCESS 이용권이 회수되어버림';
  end if;

  if (select revoked_at from public.entitlements where id = v_ent2_id) is null then
    v_ok := false; raise notice 'TEST109h FAIL: DISCORD_ROLE 이용권이 회수되지 않음';
  end if;

  -- 8) 탈퇴 취소 사건 원인 기록 (cancel_orders_for_withdrawn_user)
  perform public.cancel_orders_for_withdrawn_user(v_user2_id);

  if not exists (
    select 1 from public.order_events
    where order_id = v_order2_id
      and event_type = 'CANCELLED'
      and (payload->>'cause') = 'WITHDRAWN'
  ) then
    v_ok := false; raise notice 'TEST109i FAIL: 탈퇴 취소 주문 사건에 cause: WITHDRAWN 이 기록되지 않음';
  end if;

  -- 9) decide_no_refund 테스트: 취소된 주문2에 환불하지 않고 마무리 결정 기록
  perform public.decide_no_refund(v_order2_id, v_admin_id, 'ADMIN', '탈퇴로 인한 종결 확인');

  if not exists (
    select 1 from public.order_events
    where order_id = v_order2_id
      and event_type = 'NO_REFUND_DECIDED'
      and (payload->>'reason') = '탈퇴로 인한 종결 확인'
  ) then
    v_ok := false; raise notice 'TEST109j FAIL: NO_REFUND_DECIDED 사건이 기록되지 않음';
  end if;

  -- 10) 종료 뒤 환불 사실: 개설강의 종료 후 on_payment_refunded 호출 시 offering_ended: true 확인
  update public.course_offerings set ended_at = now(), end_note = '종료 테스트' where id = v_off_id;

  -- 주문1 환불 처리
  declare
    v_rf_id uuid := gen_random_uuid();
  begin
    insert into public.payment_events (id, order_id, event_type, provider, provider_event_id, amount)
    values (v_rf_id, v_order1_id, 'REFUNDED', 'TOSS', gen_random_uuid()::text, 100000);

    perform public.on_payment_refunded(v_rf_id, v_order1_id, 'TOSS', 100000, 'KRW', 'ADMIN_REFUND', '종료 후 환불 테스트');
  end;

  if not exists (
    select 1 from public.order_events
    where order_id = v_order1_id
      and event_type = 'CANCELLED'
      and (payload->>'offering_ended')::boolean = true
  ) then
    v_ok := false; raise notice 'TEST109k FAIL: on_payment_refunded 취소 사건에 offering_ended: true 가 기록되지 않음';
  end if;

  if v_ok then
    raise notice 'TEST109 PASS: F-9 계약 조건 변경(장소 안내·동의, 디스코드 재부여), 탈퇴 원인, 종료 뒤 환불 사실, decide_no_refund 검증 완료';
  end if;
end $$;

-- =====================================================================
-- TEST108: 판매 창구 하나 · 재신청 허용 · 사유 필수 · 개설강의 상태 일관성
-- =====================================================================
do $$
declare
  v_admin_id uuid := '00000000-0000-0000-0000-000000000001';
  v_user_id uuid := '00000000-0000-0000-0000-000000000002';
  v_course_id uuid;
  v_off_id uuid;
  v_order1_id uuid;
  v_order2_id uuid;
  v_ok boolean := true;
  v_payload jsonb;
begin
  reset role;

  insert into public.users (auth_user_id, email, role)
  values (gen_random_uuid(), 'admin-t108@test.com', 'ADMIN')
  returning id into v_admin_id;

  insert into public.users (auth_user_id, email, role)
  values (gen_random_uuid(), 'student-t108@test.com', 'STUDENT')
  returning id into v_user_id;

  execute 'set local role service_role';

  insert into public.courses (name, category) values ('TEST108 과목', 'TEST') returning id into v_course_id;

  -- 1) 개설강의 생성 (모집 시작 어제, 개강 10일 후, 종강 20일 후)
  v_off_id := public.create_course_offering(
    v_course_id, 'TEST108개설', 10, 50000, null, '{}'::text[], '[]'::jsonb,
    (now() - interval '1 day')::timestamptz,
    jsonb_build_array(
      jsonb_build_object('date', ((now() at time zone 'Asia/Seoul')::date + 10)::text, 'start', '10:00', 'end', '12:00'),
      jsonb_build_object('date', ((now() at time zone 'Asia/Seoul')::date + 20)::text, 'start', '10:00', 'end', '12:00')
    ),
    v_admin_id, 'ADMIN'
  );

  -- 2) 부분 유니크 인덱스 검증:
  --   a) 신청 1 생성 (PENDING)
  v_order1_id := public.create_order(v_user_id, v_off_id, null, null, null);

  --   b) 같은 유저가 살아있는 신청(PENDING)이 있는 상태에서 또 신청 시 unique 위반으로 create_order 내부 예외
  begin
    perform public.create_order(v_user_id, v_off_id, null, null, null);
    v_ok := false; raise notice 'TEST108a FAIL: 살아있는 주문이 있는데 또 신청됨';
  exception when others then
    if coalesce(sqlerrm not like '%이미 신청%', true) then
      v_ok := false; raise notice 'TEST108a FAIL: 중복 신청 예외 문구 다름: %', sqlerrm;
    end if;
  end;

  -- 3) transition_order 거절/취소 사유 필수 검증:
  --   a) 거절 시 사유 없으면 거부
  begin
    perform public.transition_order(v_order1_id, v_admin_id, 'ADMIN', 'REJECTED', 'REJECTED', null);
    v_ok := false; raise notice 'TEST108b FAIL: 거절 사유 없는데 성공함';
  exception when others then
    if coalesce(sqlerrm not like '%거절 사유를 입력해야 합니다%', true) then
      v_ok := false; raise notice 'TEST108b FAIL: 거절 사유 검증 문구 다름: %', sqlerrm;
    end if;
  end;

  --   b) 거절 시 빈 공백 사유도 거부
  begin
    perform public.transition_order(v_order1_id, v_admin_id, 'ADMIN', 'REJECTED', 'REJECTED', '   ');
    v_ok := false; raise notice 'TEST108c FAIL: 거절 공백 사유인데 성공함';
  exception when others then
    if coalesce(sqlerrm not like '%거절 사유를 입력해야 합니다%', true) then
      v_ok := false; raise notice 'TEST108c FAIL: 거절 공백 사유 검증 문구 다름: %', sqlerrm;
    end if;
  end;

  --   c) 유효한 사유로 거절 성공 및 order_events payload {reason} 검증
  perform public.transition_order(v_order1_id, v_admin_id, 'ADMIN', 'REJECTED', 'REJECTED', '사전 자격 미달로 거절');

  select payload into v_payload
  from public.order_events
  where order_id = v_order1_id and event_type = 'REJECTED'
  order by created_at desc limit 1;

  if (v_payload->>'reason') is distinct from '사전 자격 미달로 거절' then
    v_ok := false; raise notice 'TEST108d FAIL: 거절 사건에 사유 미기록: %', v_payload;
  end if;

  -- 4) 재신청 검증: 거절된 상태(REJECTED)에서 새 주문 생성 성공 (부분 유니크)
  v_order2_id := public.create_order(v_user_id, v_off_id, null, null, null);
  if v_order2_id is null then
    v_ok := false; raise notice 'TEST108e FAIL: 거절 후 재신청 실패';
  end if;

  -- 5) 취소 시 사유 검증:
  --   a) 취소 시 사유 없으면 거부
  begin
    perform public.transition_order(v_order2_id, v_admin_id, 'ADMIN', 'CANCELLED', 'CANCELLED', '');
    v_ok := false; raise notice 'TEST108f FAIL: 취소 사유 없는데 성공함';
  exception when others then
    if coalesce(sqlerrm not like '%취소 사유를 입력해야 합니다%', true) then
      v_ok := false; raise notice 'TEST108f FAIL: 취소 사유 검증 문구 다름: %', sqlerrm;
    end if;
  end;

  --   b) 유효한 사유로 취소 성공
  perform public.transition_order(v_order2_id, v_admin_id, 'ADMIN', 'CANCELLED', 'CANCELLED', '관리자 직권 취소');
  select payload into v_payload
  from public.order_events
  where order_id = v_order2_id and event_type = 'CANCELLED'
  order by created_at desc limit 1;

  if (v_payload->>'reason') is distinct from '관리자 직권 취소' then
    v_ok := false; raise notice 'TEST108g FAIL: 취소 사건에 사유 미기록: %', v_payload;
  end if;

  -- 6) 개강 전 마감(CLOSED) 상태 수정 허용 검증:
  --   a) 마감으로 변경
  perform public.set_course_offering_status(v_off_id, 'CLOSED', '모집 임시 마감', v_admin_id, 'ADMIN');

  --   b) 개강 전이므로 price, capacity, recruit_opens_at 수정 가능해야 함
  perform public.update_course_offering(
    v_off_id, v_admin_id, 'ADMIN', '마감 중 정원 및 가격 변경',
    jsonb_build_object('price', 60000, 'capacity', 12)
  );

  --   c) 만약 개강 시각(opens_at)이 과거면 price 등 수정 거부 확인
  update public.course_offerings set opens_at = now() - interval '1 hour' where id = v_off_id;
  begin
    perform public.update_course_offering(
      v_off_id, v_admin_id, 'ADMIN', '개강 후 가격 변경 시도',
      jsonb_build_object('price', 70000)
    );
    v_ok := false; raise notice 'TEST108h FAIL: 개강 후 가격 변경이 허용됨';
  exception when others then
    if coalesce(sqlerrm not like '%개강했거나 마감된 수업의 핵심 정보%', true) then
      v_ok := false; raise notice 'TEST108h FAIL: 개강 후 수정 거부 문구 다름: %', sqlerrm;
    end if;
  end;
  update public.course_offerings set opens_at = now() + interval '10 days' where id = v_off_id;

  -- 7) 종강 뒤 폐강 거부 검증:
  --   ends_at이 과거이면 cancel_course_offering 거부
  update public.course_offerings set ends_at = now() - interval '1 hour' where id = v_off_id;
  begin
    perform public.cancel_course_offering(v_off_id, '종강 후 폐강 시도', v_admin_id, 'ADMIN');
    v_ok := false; raise notice 'TEST108i FAIL: 종강 후 폐강이 허용됨';
  exception when others then
    if coalesce(sqlerrm not like '%모든 회차가 끝난 수업은 폐강이 아니라 종료합니다%', true) then
      v_ok := false; raise notice 'TEST108i FAIL: 종강 후 폐강 거부 문구 다름: %', sqlerrm;
    end if;
  end;

  -- 8) 종료 뒤 명령 거부 검증:
  --   a) 정상 종료 처리: end_course_offering은 개강(opens_at <= now()) 후여야 함
  --   회차 불변 트리거는 service_role에서 날짜 수정을 막으므로 postgres 역할로 날짜 과거 조정
  reset role;
  update public.course_offerings
  set recruit_opens_at = now() - interval '10 days',
      opens_at = now() - interval '2 days',
      ends_at = now() - interval '1 hour'
  where id = v_off_id;
  update public.course_sessions set session_date = (current_date - 1) where course_offering_id = v_off_id;
  execute 'set local role service_role';

  perform public.end_course_offering(v_off_id, v_admin_id, 'ADMIN', '정상 종료 처리');

  --   b) 종료된 강의 상태 변경(set_course_offering_status) 시 거부
  begin
    perform public.set_course_offering_status(v_off_id, 'OPEN', '종료 후 재개 시도', v_admin_id, 'ADMIN');
    v_ok := false; raise notice 'TEST108j FAIL: 종료 후 상태 변경이 허용됨';
  exception when others then
    if coalesce(sqlerrm not like '%종료된 수업입니다. 종료를 취소한 뒤에 상태를 변경하세요.%', true) then
      v_ok := false; raise notice 'TEST108j FAIL: 종료 후 상태 변경 거부 문구 다름: %', sqlerrm;
    end if;
  end;

  --   c) 종료된 강의의 별칭(label)과 장소(location) 수정은 허용
  perform public.update_course_offering(
    v_off_id, v_admin_id, 'ADMIN', '종료 후 별칭 수정',
    jsonb_build_object('label', '종료후수정라벨')
  );

  --   d) 종료된 강의의 다른 필드(auto_approve 등) 수정 시 거부
  begin
    perform public.update_course_offering(
      v_off_id, v_admin_id, 'ADMIN', '종료 후 자동승인 변경 시도',
      jsonb_build_object('auto_approve', true)
    );
    v_ok := false; raise notice 'TEST108k FAIL: 종료 후 다른 필드 수정이 허용됨';
  exception when others then
    if coalesce(sqlerrm not like '%종료된 수업은 별칭(label)과 장소(location) 외에는 수정할 수 없습니다.%', true) then
      v_ok := false; raise notice 'TEST108k FAIL: 종료 후 수정 거부 문구 다름: %', sqlerrm;
    end if;
  end;

  if v_ok then
    raise notice 'TEST108 PASS: F-8 판매 창구·재신청 허용(부분 유니크)·사유 필수·개강전 마감 수정 허용·종강후 폐강 거부·종료후 상태 전이 거부 검증 완료';
  end if;
end $$;

-- =========================================================
-- TEST 106: : 폐강 완료 조건 보강 · PG 외 환불 상한 · 환불 원장 행위자 · 이용권 행 불변 검증
-- =========================================================
do $$
declare
  v_admin_id uuid;
  v_student_id uuid;
  v_course_id uuid;
  v_off_id uuid;
  v_order_id uuid;
  v_ent_id uuid;
  v_pe_paid_id uuid;
  v_outcome text;
  v_evt_id uuid;
  v_ok boolean := true;
begin
  reset role;

  insert into public.users (auth_user_id, email, role)
  values (gen_random_uuid(), 'admin-t106@test.com', 'ADMIN')
  returning id into v_admin_id;

  insert into public.users (auth_user_id, email, role)
  values (gen_random_uuid(), 'student-t106@test.com', 'STUDENT')
  returning id into v_student_id;

  insert into public.courses (name, category) values ('F6과목', 'TEST') returning id into v_course_id;

  -- 1) orders CHECK 제약: refunded_amount > final_amount 거부
  v_off_id := public.create_course_offering(
    v_course_id, 'F6검증반', 10, 50000, '강남', '{}'::text[], '[]'::jsonb,
    now() - interval '2 days',
    jsonb_build_array(
      jsonb_build_object('date', (current_date + interval '5 days')::text, 'start', '14:00', 'end', '16:00')
    ),
    v_admin_id, 'ADMIN', false
  );

  v_order_id := public.create_order(v_student_id, v_off_id, null, null, null);
  perform public.transition_order(v_order_id, v_admin_id, 'ADMIN', 'APPROVED', 'APPROVED');

  -- 정상 결제 시뮬레이션
  update public.orders set payment_status = 'PAID', paid_at = now(), payment_method = 'CARD' where id = v_order_id;
  insert into public.payment_events (
    provider, provider_event_id, event_type, amount, currency, order_id, payment_method, metadata, raw_payload
  ) values (
    'TOSS', 'toss-paid-' || gen_random_uuid(), 'PAYMENT_SUCCEEDED', 50000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb
  ) returning id into v_pe_paid_id;

  -- 1-a) refunded_amount > final_amount 직접 update 시도 -> check 위반 거부
  begin
    update public.orders set refunded_amount = 50001 where id = v_order_id;
    v_ok := false; raise notice 'TEST106a FAIL: orders_refunded_amount_lte_final CHECK가 위반을 허용함';
  exception when check_violation then
    -- 정상 거부
  end;

  -- 2) begin_refund_request 행위자(p_actor_id) 검증
  -- 2-a) p_source = 'ADMIN' 인데 p_actor_id 가 null 이면 거부
  begin
    select outcome into v_outcome from public.begin_refund_request(
      v_order_id, 'req-f6-noactor', 10000, '사유', 'ADMIN', null, null, false, null
    );
    v_ok := false; raise notice 'TEST106b FAIL: begin_refund_request 에 p_actor_id 없는 ADMIN 요청이 허용됨';
  exception when others then
    if coalesce(sqlerrm not like '%행위자 ID(p_actor_id)가 필수입니다.%', true) then
      v_ok := false; raise notice 'TEST106b FAIL: 거부 문구 다름: %', sqlerrm;
    end if;
  end;

  -- 2-b) p_actor_id 제공 시 성공 및 metadata 에 actor_user_id 기록 확인
  select request_event_id into v_evt_id from public.begin_refund_request(
    v_order_id, 'req-f6-withactor', 10000, '정상환불', 'ADMIN', null, null, false, v_admin_id
  );
  if not exists (
    select 1 from public.payment_events
    where id = v_evt_id and metadata->>'actor_user_id' = v_admin_id::text
  ) then
    v_ok := false; raise notice 'TEST106c FAIL: begin_refund_request metadata에 actor_user_id가 없음';
  end if;

  -- 3) record_payment_event: MANUAL 환불 상한 검사
  -- 현재 주문의 결제액: 50,000, 기환불액: 0 (위 요청은 아직 REFUNDED 안 됨).
  -- 3-a) 남은 금액(50,000)을 초과하는 50,001원 MANUAL REFUND 시도 -> 거부
  begin
    perform public.record_payment_event(
      'MANUAL', 'manual-f6-over', 'REFUNDED', 50001, 'KRW', v_order_id, 'CASH',
      jsonb_build_object('source', 'ADMIN_MANUAL_REFUND', 'reason', '초과환불'), '{}'::jsonb
    );
    v_ok := false; raise notice 'TEST106d FAIL: 남은 가능액 초과 MANUAL 환불이 허용됨';
  exception when others then
    if coalesce(sqlerrm not like '%환불 금액(50001원)이 남은 환불 가능액(50000원)을 초과합니다.%', true) then
      v_ok := false; raise notice 'TEST106d FAIL: MANUAL 환불 초과 거부 문구 다름: %', sqlerrm;
    end if;
  end;

  -- 3-b) PG(TOSS)에서 온 환불은 초과여도 원장에 기록되어야 함 (실제 사실 보존 원칙)
  perform public.record_payment_event(
    'TOSS', 'toss-f6-over', 'REFUNDED', 60000, 'KRW', v_order_id, 'CARD',
    '{}'::jsonb, '{}'::jsonb
  );
  if not exists (select 1 from public.payment_events where provider_event_id = 'toss-f6-over') then
    v_ok := false; raise notice 'TEST106e FAIL: PG에서 온 환불 이벤트가 원장에 기록되지 않음';
  end if;

  -- 4) complete_course_offering_cancel: p_acknowledged jsonb 기록 확인
  -- 폐강 진행 상태로 전이
  perform public.cancel_course_offering(v_off_id, '테스트 폐강', v_admin_id, 'ADMIN');
  -- 주문 종료 처리
  perform public.close_order_without_refund(v_order_id, v_admin_id, 'ADMIN', '폐강 종료');

  -- complete_course_offering_cancel 호출
  perform public.complete_course_offering_cancel(
    v_off_id, v_admin_id, 'ADMIN',
    jsonb_build_array(jsonb_build_object('order_id', v_order_id, 'amount', 50000))
  );

  if not exists (
    select 1 from public.course_offering_events
    where course_offering_id = v_off_id
      and event_type = 'CANCEL_COMPLETED'
      and after->'acknowledged_unrefunded' @> jsonb_build_array(jsonb_build_object('order_id', v_order_id, 'amount', 50000))
  ) then
    v_ok := false; raise notice 'TEST106f FAIL: CANCEL_COMPLETED 사건에 acknowledged_unrefunded 가 기록되지 않음';
  end if;

  -- 5) entitlements 행 불변 트리거 (service_role 역할로 변이 확인)
  -- 이용권 1건 생성 (postgres 권한으로 insert)
  insert into public.entitlements (
    user_id, type, order_id, payment_event_id, grant_source, access_code, metadata
  ) values (
    v_student_id, 'COURSE_ACCESS', v_order_id, v_pe_paid_id, 'PAYMENT', 'ENT-TEST106', '{"test": 1}'::jsonb
  ) returning id into v_ent_id;

  execute 'set local role service_role';

  -- 5-a) DELETE 거부
  begin
    delete from public.entitlements where id = v_ent_id;
    v_ok := false; raise notice 'TEST106g FAIL: service_role 에서 entitlements DELETE가 허용됨';
  exception when others then
    -- 정상 거부
  end;

  -- 5-b) metadata 등 기본 정보 수정 거부
  begin
    update public.entitlements set metadata = '{"modified": true}'::jsonb where id = v_ent_id;
    v_ok := false; raise notice 'TEST106h FAIL: service_role 에서 metadata 수정이 허용됨';
  exception when others then
    -- 정상 거부
  end;

  -- 5-c) 정상 회수 1회 허용: revoked_at + revoked_reason 동반
  update public.entitlements set revoked_at = now(), revoked_reason = 'COURSE_ENDED' where id = v_ent_id;

  -- 5-d) 이미 회수된 행의 revoked_at 또는 revoked_reason 재수정 거부
  begin
    update public.entitlements set revoked_reason = 'REFUNDED' where id = v_ent_id;
    v_ok := false; raise notice 'TEST106i FAIL: 이미 회수된 행의 revoked_reason 재수정이 허용됨';
  exception when others then
    -- 정상 거부
  end;

  -- 5-e) 디스코드 역할 제거 시각 1회 업데이트 허용
  update public.entitlements set discord_role_removed_at = now() where id = v_ent_id;

  -- 5-f) 이미 기록된 디스코드 역할 제거 시각 재수정 거부
  begin
    update public.entitlements set discord_role_removed_at = now() + interval '1 day' where id = v_ent_id;
    v_ok := false; raise notice 'TEST106j FAIL: discord_role_removed_at 재수정이 허용됨';
  exception when others then
    -- 정상 거부
  end;

  execute 'reset role';

  if v_ok then
    raise notice 'TEST106 PASS: F-6 폐강 완료 조건 보강 · PG 외 환불 상한 · 환불 원장 행위자 · 이용권 행 불변 검증 완료';
  end if;
end $$;

-- =========================================================
-- TEST 201: A-1 개설강의 공지문 (set_course_offering_notice & apply_schedule_change 공지 연동)
-- =========================================================
do $$
declare
  v_admin_id uuid;
  v_student_id uuid;
  v_course_id uuid;
  v_off_id uuid;
  v_off_cancelling_id uuid;
  v_off_cancelled_id uuid;
  v_off_ended_id uuid;
  v_event_count integer;
  v_last_event record;
  v_ok boolean := true;
  v_long_text text := repeat('가', 1001);
  v_sess1_id uuid;
  v_sess2_id uuid;
  v_ret jsonb;
begin
  select id into v_admin_id from public.users where role = 'ADMIN' limit 1;
  select id into v_student_id from public.users where role = 'STUDENT' limit 1;
  select id into v_course_id from public.courses limit 1;

  -- 1) 테스트용 개설강의 생성
  insert into public.course_offerings (
    course_id, label, capacity, remaining_seats, price, recruit_opens_at, opens_at, ends_at, status
  ) values (
    v_course_id, 'A1-공지테스트', 10, 10, 10000, now() - interval '1 day', now() + interval '1 day', now() + interval '2 days', 'OPEN'
  ) returning id into v_off_id;

  insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
  values (v_off_id, current_date + 1, '10:00', '12:00')
  returning id into v_sess1_id;

  insert into public.course_sessions (course_offering_id, session_date, start_time, end_time)
  values (v_off_id, current_date + 2, '10:00', '12:00')
  returning id into v_sess2_id;

  -- 폐강 진행 중 강의
  insert into public.course_offerings (
    course_id, label, capacity, remaining_seats, price, recruit_opens_at, opens_at, ends_at, status,
    status_changed_by, status_reason, status_changed_at
  ) values (
    v_course_id, 'A1-폐강중', 10, 10, 10000, now() - interval '1 day', now() + interval '1 day', now() + interval '2 days', 'CANCELLING',
    v_admin_id, '테스트 폐강 사유', now()
  ) returning id into v_off_cancelling_id;

  -- 폐강 완료 강의
  insert into public.course_offerings (
    course_id, label, capacity, remaining_seats, price, recruit_opens_at, opens_at, ends_at, status,
    status_changed_by, status_reason, status_changed_at
  ) values (
    v_course_id, 'A1-폐강완료', 10, 10, 10000, now() - interval '1 day', now() + interval '1 day', now() + interval '2 days', 'CANCELLED',
    v_admin_id, '테스트 폐강완료 사유', now()
  ) returning id into v_off_cancelled_id;

  -- 종료된 강의
  insert into public.course_offerings (
    course_id, label, capacity, remaining_seats, price, recruit_opens_at, opens_at, ends_at, status, ended_at,
    ended_by, end_note, status_changed_by, status_reason, status_changed_at
  ) values (
    v_course_id, 'A1-종료강의', 10, 10, 10000, now() - interval '2 days', now() - interval '1 day', now() - interval '1 hour', 'CLOSED', now() - interval '30 minutes',
    v_admin_id, '테스트 종료 비고', v_admin_id, '테스트 마감 사유', now()
  ) returning id into v_off_ended_id;

  -- 2) 권한 및 역할 검증: authenticated 역할은 실행 권한 없음
  execute 'set local role authenticated';
  begin
    perform public.set_course_offering_notice(v_off_id, v_admin_id, 'ADMIN', '테스트공지', '사유');
    v_ok := false; raise notice 'TEST201a FAIL: authenticated 역할이 set_course_offering_notice 실행 가능';
  exception when insufficient_privilege then
    -- 정상 거부
  end;
  execute 'reset role';

  -- 3) service_role 권한으로 전환하여 규칙 검증
  execute 'set local role service_role';

  -- 3-a) 관리자 아닌 행위자 거부
  begin
    perform public.set_course_offering_notice(v_off_id, v_student_id, 'STUDENT', '공지', '사유');
    v_ok := false; raise notice 'TEST201b FAIL: STUDENT 행위자가 허용됨';
  exception when others then
    if sqlerrm not like '%관리자만%' then
      v_ok := false; raise notice 'TEST201b FAIL: 예상과 다른 예외 - %', sqlerrm;
    end if;
  end;

  -- 3-b) 사유 누락 거부
  begin
    perform public.set_course_offering_notice(v_off_id, v_admin_id, 'ADMIN', '공지', '   ');
    v_ok := false; raise notice 'TEST201c FAIL: 빈 사유가 허용됨';
  exception when others then
    if sqlerrm not like '%사유%' then
      v_ok := false; raise notice 'TEST201c FAIL: 예상과 다른 예외 - %', sqlerrm;
    end if;
  end;

  -- 3-c) 1000자 초과 거부
  begin
    perform public.set_course_offering_notice(v_off_id, v_admin_id, 'ADMIN', v_long_text, '사유');
    v_ok := false; raise notice 'TEST201d FAIL: 1000자 초과 공지가 허용됨';
  exception when others then
    if sqlerrm not like '%최대 1,000자%' then
      v_ok := false; raise notice 'TEST201d FAIL: 예상과 다른 예외 - %', sqlerrm;
    end if;
  end;

  -- 3-d) 폐강 완료 강의 거부
  begin
    perform public.set_course_offering_notice(v_off_cancelled_id, v_admin_id, 'ADMIN', '공지', '사유');
    v_ok := false; raise notice 'TEST201e FAIL: 폐강 완료 강의 공지 수정 허용됨';
  exception when others then
    if sqlerrm not like '%폐강 완료된%' then
      v_ok := false; raise notice 'TEST201e FAIL: 예상과 다른 예외 - %', sqlerrm;
    end if;
  end;

  -- 3-e) 종료된 강의 거부
  begin
    perform public.set_course_offering_notice(v_off_ended_id, v_admin_id, 'ADMIN', '공지', '사유');
    v_ok := false; raise notice 'TEST201f FAIL: 종료된 강의 공지 수정 허용됨';
  exception when others then
    if sqlerrm not like '%종료된 강의는%' then
      v_ok := false; raise notice 'TEST201f FAIL: 예상과 다른 예외 - %', sqlerrm;
    end if;
  end;

  -- 3-f) 폐강 진행 중(`CANCELLING`) 강의 허용
  perform public.set_course_offering_notice(v_off_cancelling_id, v_admin_id, 'ADMIN', '환불 안내 공지', '폐강 안내 공지 등록');
  if not exists (select 1 from public.course_offerings where id = v_off_cancelling_id and notice_text = '환불 안내 공지') then
    v_ok := false; raise notice 'TEST201g FAIL: 폐강 진행 중 강의 공지 반영 실패';
  end if;

  -- 3-g) 정상 등록 및 원장 UPDATED 기록 검증
  perform public.set_course_offering_notice(v_off_id, v_admin_id, 'ADMIN', '  첫 번째 공지사항입니다  ', '공지 신규 등록');
  if not exists (
    select 1 from public.course_offerings
    where id = v_off_id and notice_text = '첫 번째 공지사항입니다'
  ) then
    v_ok := false; raise notice 'TEST201h FAIL: 공지 트림 및 등록 실패';
  end if;

  if not exists (
    select 1 from public.course_offering_events
    where course_offering_id = v_off_id
      and event_type = 'UPDATED'
      and before->>'notice_text' is null
      and after->>'notice_text' = '첫 번째 공지사항입니다'
      and reason = '공지 신규 등록'
  ) then
    v_ok := false; raise notice 'TEST201i FAIL: course_offering_events 원장 UPDATED 기록 누락';
  end if;

  -- 3-h) 동일 내용 재저장 시 거부
  begin
    perform public.set_course_offering_notice(v_off_id, v_admin_id, 'ADMIN', '첫 번째 공지사항입니다', '동일 내용 재저장');
    v_ok := false; raise notice 'TEST201j FAIL: 동일 공지 재저장이 허용됨';
  exception when others then
    if sqlerrm not like '%변경된 값이 없습니다%' then
      v_ok := false; raise notice 'TEST201j FAIL: 예상과 다른 예외 - %', sqlerrm;
    end if;
  end;

  -- 3-i) 빈 문자열로 공지 삭제 및 원장 기록
  perform public.set_course_offering_notice(v_off_id, v_admin_id, 'ADMIN', '   ', '공지 삭제');
  if not exists (
    select 1 from public.course_offerings
    where id = v_off_id and notice_text is null
  ) then
    v_ok := false; raise notice 'TEST201k FAIL: 공지 삭제(null 처리) 실패';
  end if;

  if not exists (
    select 1 from public.course_offering_events
    where course_offering_id = v_off_id
      and event_type = 'UPDATED'
      and before->>'notice_text' = '첫 번째 공지사항입니다'
      and after->>'notice_text' is null
      and reason = '공지 삭제'
  ) then
    v_ok := false; raise notice 'TEST201l FAIL: 공지 삭제 원장 UPDATED 기록 누락';
  end if;

  -- 4) apply_schedule_change 에서 p_update_notice=true 연동 검증
  v_ret := public.apply_schedule_change(
    p_offering_id => v_off_id,
    p_actor => v_admin_id,
    p_actor_role => 'ADMIN',
    p_reason => '일정 및 장소 변경과 공지 게시',
    p_cancel_session_ids => array[v_sess2_id],
    p_add_sessions => jsonb_build_array(
      jsonb_build_object('date', (current_date + 3)::text, 'start', '14:00', 'end', '16:00')
    ),
    p_location => '강남역 2번 출구',
    p_notice => '일정이 변경되었으니 확인 바랍니다.',
    p_update_notice => true
  );

  if not exists (
    select 1 from public.course_offerings
    where id = v_off_id and notice_text = '일정이 변경되었으니 확인 바랍니다.' and location = '강남역 2번 출구'
  ) then
    v_ok := false; raise notice 'TEST201m FAIL: apply_schedule_change 공지 및 장소 동시 반영 실패';
  end if;

  -- SCHEDULE_CHANGED 와 별도로 UPDATED(notice_text) 사건이 함께 원장에 남았는지 확인
  if not exists (
    select 1 from public.course_offering_events
    where course_offering_id = v_off_id
      and event_type = 'UPDATED'
      and after->>'notice_text' = '일정이 변경되었으니 확인 바랍니다.'
  ) then
    v_ok := false; raise notice 'TEST201n FAIL: apply_schedule_change 연동 시 notice_text UPDATED 원장 누락';
  end if;

  execute 'reset role';

  if v_ok then
    raise notice 'TEST201 PASS: A-1 개설강의 공지문(등록/수정/삭제/폐강중허용/원장/일정변경연동) 검증 완료';
  end if;
end $$;

-- =========================================================
-- TEST 202: A-3 선별·일괄 환불 (begin_refund_request 배치 ID, operator_cause 및 OPERATOR_REFUND)
-- =========================================================
do $$
declare
  v_admin_id uuid;
  v_user1_id uuid;
  v_user2_id uuid;
  v_user3_id uuid;
  v_course_id uuid;
  v_off_id uuid;
  v_ord1_id uuid;
  v_ord2_id uuid;
  v_ord3_id uuid;
  v_batch_id uuid := gen_random_uuid();
  v_res record;
  v_meta jsonb;
  v_ok boolean := true;
  v_order_event_cause text;
  v_label text;
begin
  select id into v_admin_id from public.users where role = 'ADMIN' limit 1;

  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test202_u1@example.com', 'STUDENT')
    returning id into v_user1_id;
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test202_u2@example.com', 'STUDENT')
    returning id into v_user2_id;
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test202_u3@example.com', 'STUDENT')
    returning id into v_user3_id;

  select id into v_course_id from public.courses limit 1;

  insert into public.course_offerings (
    course_id, capacity, remaining_seats, price, status,
    recruit_opens_at, opens_at, ends_at
  ) values (
    v_course_id, 10, 7, 50000, 'OPEN',
    now() - interval '2 days', now() + interval '5 days', now() + interval '10 days'
  ) returning id into v_off_id;

  -- 주문 3건 생성, 승인, 결제 성공
  v_ord1_id := public.create_order(v_user1_id, v_off_id, null, null);
  perform public.transition_order(v_ord1_id, v_admin_id, 'ADMIN', 'APPROVED', 'APPROVED');
  perform public.record_payment_event('TOSS', 'test202-pay-1', 'PAYMENT_SUCCEEDED', 50000, 'KRW', v_ord1_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tx-test202-1');

  v_ord2_id := public.create_order(v_user2_id, v_off_id, null, null);
  perform public.transition_order(v_ord2_id, v_admin_id, 'ADMIN', 'APPROVED', 'APPROVED');
  perform public.record_payment_event('TOSS', 'test202-pay-2', 'PAYMENT_SUCCEEDED', 50000, 'KRW', v_ord2_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tx-test202-2');

  v_ord3_id := public.create_order(v_user3_id, v_off_id, null, null);
  perform public.transition_order(v_ord3_id, v_admin_id, 'ADMIN', 'APPROVED', 'APPROVED');
  perform public.record_payment_event('TOSS', 'test202-pay-3', 'PAYMENT_SUCCEEDED', 50000, 'KRW', v_ord3_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tx-test202-3');

  perform pg_temp.deliver_payment_facts();

  -- 1) non-postgres (authenticated) 역할 실행 불가 검증
  execute 'set role authenticated';
  begin
    perform public.begin_refund_request(
      p_order_id => v_ord1_id,
      p_request_key => 'test202-key-auth',
      p_amount => 50000,
      p_reason => '권한 테스트',
      p_source => 'ADMIN',
      p_actor_id => v_admin_id
    );
    v_ok := false; raise notice 'TEST202a FAIL: authenticated 역할이 begin_refund_request 실행 가능';
  exception when others then
    -- 정상 거부
  end;
  execute 'reset role';

  -- 2) 학생 사정(기본 operator_cause=false) + p_batch_id 지정 환불 요청
  select * into v_res from public.begin_refund_request(
    p_order_id => v_ord1_id,
    p_request_key => 'test202-key-1',
    p_amount => 30000,
    p_reason => '학생 사정 일괄 환불',
    p_source => 'ADMIN',
    p_student_request_event_id => null,
    p_schedule_change_notice_event_id => null,
    p_post_close => false,
    p_actor_id => v_admin_id,
    p_batch_id => v_batch_id,
    p_operator_cause => false
  );

  if v_res.outcome <> 'CREATED' then
    v_ok := false; raise notice 'TEST202b FAIL: begin_refund_request 실패 outcome=%', v_res.outcome;
  end if;

  select metadata into v_meta from public.payment_events where id = v_res.request_event_id;
  if v_meta->>'batch_id' <> v_batch_id::text or v_meta ? 'operator_cause' then
    v_ok := false; raise notice 'TEST202c FAIL: metadata batch_id 또는 operator_cause 불일치: %', v_meta;
  end if;

  -- 3) 우리 사정(p_operator_cause=true) + p_batch_id 지정 환불 요청
  select * into v_res from public.begin_refund_request(
    p_order_id => v_ord2_id,
    p_request_key => 'test202-key-2',
    p_amount => 50000,
    p_reason => '운영진 사정 전액 환불',
    p_source => 'ADMIN',
    p_student_request_event_id => null,
    p_schedule_change_notice_event_id => null,
    p_post_close => false,
    p_actor_id => v_admin_id,
    p_batch_id => v_batch_id,
    p_operator_cause => true
  );

  select metadata into v_meta from public.payment_events where id = v_res.request_event_id;
  if v_meta->>'batch_id' <> v_batch_id::text or (v_meta->>'operator_cause')::boolean is not true then
    v_ok := false; raise notice 'TEST202d FAIL: metadata operator_cause true 미반영: %', v_meta;
  end if;

  -- 4) 결제 웹훅(REFUNDED) 도착 시 cause 판정 검증
  -- 4-1) 학생 사정 건 -> ADMIN_REFUND
  perform public.record_payment_event('TOSS', 'test202-ref-1', 'REFUNDED', 30000, 'KRW', v_ord1_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tx-test202-1');
  -- 4-2) 우리 사정 건 -> OPERATOR_REFUND
  perform public.record_payment_event('TOSS', 'test202-ref-2', 'REFUNDED', 50000, 'KRW', v_ord2_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tx-test202-2');

  perform pg_temp.deliver_payment_facts();

  -- ord1 CANCELLED 주문 이벤트 확인
  select payload->>'cause' into v_order_event_cause
  from public.order_events
  where order_id = v_ord1_id and event_type = 'CANCELLED'
  order by created_at desc limit 1;

  if v_order_event_cause <> 'ADMIN_REFUND' then
    v_ok := false; raise notice 'TEST202e FAIL: ord1 환불 원인 불일치 (기대 ADMIN_REFUND, 실제 %)', v_order_event_cause;
  end if;

  -- ord2 CANCELLED 주문 이벤트 확인 (OPERATOR_REFUND 확인)
  select payload->>'cause' into v_order_event_cause
  from public.order_events
  where order_id = v_ord2_id and event_type = 'CANCELLED'
  order by created_at desc limit 1;

  if v_order_event_cause <> 'OPERATOR_REFUND' then
    v_ok := false; raise notice 'TEST202f FAIL: ord2 환불 원인 불일치 (기대 OPERATOR_REFUND, 실제 %)', v_order_event_cause;
  end if;

  -- 5) 폐강 출처(OFFERING_CANCEL)인 경우 operator_cause=true 여도 OFFERING_CANCELLED가 우선함 검증
  select * into v_res from public.begin_refund_request(
    p_order_id => v_ord3_id,
    p_request_key => 'test202-key-3',
    p_amount => 50000,
    p_reason => '폐강 환불',
    p_source => 'OFFERING_CANCEL',
    p_student_request_event_id => null,
    p_schedule_change_notice_event_id => null,
    p_post_close => false,
    p_actor_id => v_admin_id,
    p_batch_id => v_batch_id,
    p_operator_cause => true
  );

  perform public.record_payment_event('TOSS', 'test202-ref-3', 'REFUNDED', 50000, 'KRW', v_ord3_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tx-test202-3');
  perform pg_temp.deliver_payment_facts();

  select payload->>'cause' into v_order_event_cause
  from public.order_events
  where order_id = v_ord3_id and event_type = 'CANCELLED'
  order by created_at desc limit 1;

  if v_order_event_cause <> 'OFFERING_CANCELLED' then
    v_ok := false; raise notice 'TEST202g FAIL: 폐강 출처는 OFFERING_CANCELLED 우선이어야 함 (실제 %)', v_order_event_cause;
  end if;

  if v_ok then
    raise notice 'TEST202 PASS: A-3 선별·일괄 환불(begin_refund_request 배치ID/operator_cause 및 OPERATOR_REFUND 원인) 검증 완료';
  end if;
end $$;

-- =========================================================
-- TEST 203: 수강 유지 부분 환불 (회차 취소 보상 환불)
--   - p_keep_order = true 로 부분 환불 시 orders.status = 'APPROVED' 유지
--   - payment_status = 'PARTIALLY_REFUNDED' 로 갱신
--   - 좌석 유지(반환 안 함), 이용권/디스코드 역할 회수 없음 (ORDER_REFUNDED outbox 미발행)
--   - order_events 에 REFUND_APPLIED 및 keep_order: true, cause: SESSION_COMPENSATION 기록
-- =========================================================
do $$
declare
  v_admin_id uuid;
  v_user_id uuid;
  v_course_id uuid;
  v_offering_id uuid;
  v_order_id uuid;
  v_res record;
  v_ord record;
  v_event record;
  v_seats_before integer;
  v_seats_after integer;
  v_outbox_count integer;
  v_ok boolean := true;
begin
  select id into v_admin_id from public.users where role = 'ADMIN' limit 1;
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test203@example.com', 'STUDENT')
    returning id into v_user_id;

  insert into public.courses (name, category) values ('TEST203강의', 'IT') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 60000, null, false,
    now() + interval '5 days', now() + interval '20 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null, now() - interval '1 day'
  );

  v_order_id := public.create_order(v_user_id, v_offering_id, null, null);
  perform public.transition_order(v_order_id, v_admin_id, 'ADMIN', 'APPROVED', 'APPROVED');
  perform public.record_payment_event('TOSS', 'test203-pay', 'PAYMENT_SUCCEEDED', 60000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tx-test203');
  perform pg_temp.deliver_payment_facts();

  select remaining_seats into v_seats_before from public.course_offerings where id = v_offering_id;

  -- 1) keep_order = true 로 20,000원 부분 환불 요청 (1회차 보상)
  select * into v_res from public.begin_refund_request(
    p_order_id => v_order_id,
    p_request_key => 'test203-req-1',
    p_amount => 20000,
    p_reason => '1회차 휴강 보상 환불',
    p_source => 'ADMIN',
    p_student_request_event_id => null,
    p_schedule_change_notice_event_id => null,
    p_post_close => false,
    p_actor_id => v_admin_id,
    p_batch_id => null,
    p_operator_cause => false,
    p_keep_order => true
  );

  if v_res.outcome <> 'CREATED' then
    v_ok := false; raise notice 'TEST203a FAIL: begin_refund_request outcome=%', v_res.outcome;
  end if;

  -- 2) PG 환불 웹훅 반영
  perform public.record_payment_event('TOSS', 'test203-ref', 'REFUNDED', 20000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tx-test203-ref');
  perform pg_temp.deliver_payment_facts();

  -- 3) 주문 상태 및 결제 상태 검증
  select status, payment_status, refunded_amount into v_ord
  from public.orders where id = v_order_id;

  if v_ord.status <> 'APPROVED' then
    v_ok := false; raise notice 'TEST203b FAIL: status가 APPROVED가 아님 (%)', v_ord.status;
  end if;
  if v_ord.payment_status <> 'PARTIALLY_REFUNDED' or v_ord.refunded_amount <> 20000 then
    v_ok := false; raise notice 'TEST203c FAIL: payment_status=% refunded_amount=%', v_ord.payment_status, v_ord.refunded_amount;
  end if;

  -- 4) 좌석 유지 확인 (반환되지 않아야 함)
  select remaining_seats into v_seats_after from public.course_offerings where id = v_offering_id;
  if v_seats_after <> v_seats_before then
    v_ok := false; raise notice 'TEST203d FAIL: 좌석이 반환됨 (before=%, after=%)', v_seats_before, v_seats_after;
  end if;

  -- 5) ORDER_REFUNDED outbox 미발행 확인
  select count(*) into v_outbox_count
  from public.outbox_messages
  where topic = 'ORDER_REFUNDED' and payload->>'order_id' = v_order_id::text;

  if v_outbox_count <> 0 then
    v_ok := false; raise notice 'TEST203e FAIL: ORDER_REFUNDED outbox가 발행됨 (%)', v_outbox_count;
  end if;

  -- 6) order_events 확인 (REFUND_APPLIED 및 cause: SESSION_COMPENSATION, keep_order: true)
  select payload into v_event
  from public.order_events
  where order_id = v_order_id and event_type = 'REFUND_APPLIED'
  order by created_at desc limit 1;

  if (v_event.payload->>'keep_order')::boolean is not true or v_event.payload->>'cause' <> 'SESSION_COMPENSATION' then
    v_ok := false; raise notice 'TEST203f FAIL: event payload 이상: %', v_event.payload;
  end if;

  if v_ok then
    raise notice 'TEST203 PASS: C-3 수강 유지 부분 환불 (keep_order=true, APPROVED 유지, 좌석유지, 권한회수없음, SESSION_COMPENSATION) 검증 완료';
  end if;
end $$;

-- =========================================================
-- TEST 204: C-4 폐강 환불 없는 종료 사유 코드 및 귀책 (close_order_without_refund)
-- =========================================================
do $$
declare
  v_admin_id uuid;
  v_user_id uuid;
  v_course_id uuid;
  v_offering_id uuid;
  v_order_id uuid;
  v_close_evt_id uuid;
  v_event record;
  v_ok boolean := true;
begin
  select id into v_admin_id from public.users where role = 'ADMIN' limit 1;
  insert into public.users (auth_user_id, email, role)
    values (gen_random_uuid(), 'test204@example.com', 'STUDENT')
    returning id into v_user_id;

  insert into public.courses (name, category) values ('TEST204강의', 'IT') returning id into v_course_id;
  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 60000, null, false,
    now() + interval '5 days', now() + interval '20 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null, now() - interval '1 day'
  );

  v_order_id := public.create_order(v_user_id, v_offering_id, null, null);
  perform public.transition_order(v_order_id, v_admin_id, 'ADMIN', 'APPROVED', 'APPROVED');
  perform public.record_payment_event('TOSS', 'test204-pay', 'PAYMENT_SUCCEEDED', 60000, 'KRW', v_order_id, 'CARD', '{}'::jsonb, '{}'::jsonb, 'tx-test204');
  perform pg_temp.deliver_payment_facts();

  -- 폐강 시작 (cancel_course_offering)
  perform public.cancel_course_offering(v_offering_id, '폐강 테스트 사유', v_admin_id, 'ADMIN');

  -- 환불 없는 종료 호출
  v_close_evt_id := public.close_order_without_refund(
    v_order_id,
    v_admin_id,
    'ADMIN',
    '수강생 협의로 환불 없이 종료',
    'OFFERING_CANCELLED_NO_REFUND'
  );

  select payload into v_event from public.order_events where id = v_close_evt_id;

  if v_event.payload->>'cause' <> 'OFFERING_CANCELLED_NO_REFUND' then
    v_ok := false; raise notice 'TEST204a FAIL: cause=%', v_event.payload->>'cause';
  end if;

  if v_event.payload->>'fault' <> 'OPERATOR' then
    v_ok := false; raise notice 'TEST204b FAIL: fault=%', v_event.payload->>'fault';
  end if;

  if v_ok then
    raise notice 'TEST204 PASS: C-4 폐강 환불 없는 종료(cause: OFFERING_CANCELLED_NO_REFUND, fault: OPERATOR) 검증 완료';
  end if;
end $$;

-- =========================================================
-- TEST 205: C-6 폐강 철회 (revoke_course_offering_cancel)
-- =========================================================
do $$
declare
  v_admin_id uuid;
  v_course_id uuid;
  v_offering_id uuid;
  v_status text;
  v_event record;
  v_ok boolean := true;
begin
  select id into v_admin_id from public.users where role = 'ADMIN' limit 1;
  insert into public.courses (name, category) values ('TEST205강의', 'IT') returning id into v_course_id;

  v_offering_id := pg_temp.create_offering_legacy(
    v_course_id, null, 10, 50000, null, false,
    now() + interval '5 days', now() + interval '20 days', '{}'::text[], '[{"type":"COURSE_ACCESS"}]'::jsonb,
    null, null, null, now() - interval '1 day'
  );

  -- 1) 폐강 시작
  perform public.cancel_course_offering(v_offering_id, '폐강 시작 테스트', v_admin_id, 'ADMIN');

  -- 2) CANCELLING 상태에서 철회 (복귀: OPEN)
  perform public.revoke_course_offering_cancel(v_offering_id, v_admin_id, 'ADMIN', '오입력 철회', 'OPEN');

  select status into v_status from public.course_offerings where id = v_offering_id;
  if v_status <> 'OPEN' then
    v_ok := false; raise notice 'TEST205a FAIL: status가 OPEN이 아님 (%)', v_status;
  end if;

  select * into v_event from public.course_offering_events
  where course_offering_id = v_offering_id and event_type = 'CANCEL_REVOKED'
  order by created_at desc limit 1;

  if v_event.before->>'status' <> 'CANCELLING' or v_event.after->>'status' <> 'OPEN' then
    v_ok := false; raise notice 'TEST205b FAIL: 이벤트 상태 불일치 before=% after=%', v_event.before, v_event.after;
  end if;

  -- 3) 다시 폐강 시작 -> 폐강 완료 -> CANCELLED 상태에서 철회 (복귀: CLOSED)
  perform public.cancel_course_offering(v_offering_id, '재폐강', v_admin_id, 'ADMIN');
  perform public.complete_course_offering_cancel(v_offering_id, v_admin_id, 'ADMIN', '[]'::jsonb);

  perform public.revoke_course_offering_cancel(v_offering_id, v_admin_id, 'ADMIN', '완료 후 철회', 'CLOSED');

  select status into v_status from public.course_offerings where id = v_offering_id;
  if v_status <> 'CLOSED' then
    v_ok := false; raise notice 'TEST205c FAIL: status가 CLOSED가 아님 (%)', v_status;
  end if;

  -- 4) 거부 케이스 검증 (사유 공백, 관리자 외 역할, 허용되지 않는 복귀 상태)
  begin
    perform public.revoke_course_offering_cancel(v_offering_id, v_admin_id, 'ADMIN', '  ', 'CLOSED');
    v_ok := false; raise notice 'TEST205d FAIL: 빈 사유 허용됨';
  exception when others then -- 정상
  end;

  begin
    perform public.revoke_course_offering_cancel(v_offering_id, v_admin_id, 'MANAGER', '매니저 철회 시도', 'CLOSED');
    v_ok := false; raise notice 'TEST205e FAIL: MANAGER 허용됨';
  exception when others then -- 정상
  end;

  begin
    perform public.revoke_course_offering_cancel(v_offering_id, v_admin_id, 'ADMIN', '잘못된 상태', 'PENDING');
    v_ok := false; raise notice 'TEST205f FAIL: 잘못된 상태 허용됨';
  exception when others then -- 정상
  end;

  -- 권한 검증: service_role만
  if has_function_privilege('anon', 'public.revoke_course_offering_cancel(uuid,uuid,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.revoke_course_offering_cancel(uuid,uuid,text,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.revoke_course_offering_cancel(uuid,uuid,text,text,text)', 'execute') then
    v_ok := false; raise notice 'TEST205g FAIL: 권한 이상';
  end if;

  if v_ok then
    raise notice 'TEST205 PASS: C-6 폐강 철회(CANCELLING/CANCELLED 철회, OPEN/CLOSED 복귀, CANCEL_REVOKED 원장 기록, 가드 및 권한) 검증 완료';
  end if;
end $$;

rollback;






