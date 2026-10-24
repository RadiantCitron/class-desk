-- 약관 체계 국룰 적용(제안 그대로 구현 지시).
--
-- 1. "가입 시 표준약관+개인정보약관 둘 다 받는 게 국룰이다" — 기존엔 가입 시 SERVICE_USE만
--    받고 있었다(discord_id/email을 수집하면서도 그에 대한 개인정보동의가 없었음). 이제
--    complete_signup()이 SERVICE_USE + PRIVACY_USE 둘 다 원자적으로 받는다.
-- 2. "제3자제공/AI/소프트웨어판매 약관을 구분해야 하는 거 아닌가, 과목에 따라 다를 수 있다"
--    — 이 셋은 가입 시 일괄로 받지 않고(과다수집 안티패턴), 그 처리를 실제로 하는 개설강의에
--    한해서만 신청 시점에 동적으로 추가 동의를 받는다. course_offerings.required_terms_types에
--    등록해두면 그 개설강의를 신청할 때만 해당 약관 체크박스가 추가로 뜬다.

-- =========================================================
-- terms.type에 SOFTWARE_LICENSE_USE(소프트웨어 판매관련) 추가
-- =========================================================
alter table public.terms drop constraint terms_type_check;
alter table public.terms
  add constraint terms_type_check
    check (type in (
      'SERVICE_USE', 'PRIVACY_USE', 'THIRD_PARTY_SHARE', 'MARKETING_OPT_IN',
      'AI_CROSS_BORDER_TRANSFER', 'SOFTWARE_LICENSE_USE'
    ));

-- =========================================================
-- course_offerings: 과목별로 추가 필요한 약관 종류를 선언한다.
-- SERVICE_USE/PRIVACY_USE는 모든 개설강의에 공통(베이스라인)이라 여기 목록에 넣지 않는다 —
-- 실제로 제3자에게 정보를 넘기거나, AI를 쓰거나, 소스코드를 결합 판매하는 강의만 선택적으로 추가.
-- =========================================================
alter table public.course_offerings
  add column required_terms_types text[] not null default '{}';

alter table public.course_offerings
  add constraint course_offerings_required_terms_types_valid
    check (required_terms_types <@ array[
      'THIRD_PARTY_SHARE', 'MARKETING_OPT_IN', 'AI_CROSS_BORDER_TRANSFER', 'SOFTWARE_LICENSE_USE'
    ]::text[]);

-- =========================================================
-- 신규/개정 약관 원문 시드(전부 placeholder — 실제 서비스 오픈 전 전문 교체 필요, 기존 관례와 동일).
-- PRIVACY_USE는 기존 v1(신청 시점 전용 문구)을 지우지 않고(append-only 버전 이력 원칙)
-- v2를 새로 추가해 "현재 유효한 버전"으로 승격한다 — 가입 시점 수집까지
-- 포괄하는 문구로 바뀌었기 때문이다.
-- =========================================================
insert into public.terms (type, version, content) values
  (
    'THIRD_PARTY_SHARE',
    'THIRD_PARTY_SHARE_v1',
    '결제 처리를 위해 결제대행사(PG사)에 결제자 정보(이름, 연락처, 결제금액 등)를 제공합니다.

※ 이 문구는 placeholder입니다. 실제 PG 연동 시 실제 제공 항목/수탁사로 교체해야 합니다.'
  ),
  (
    'AI_CROSS_BORDER_TRANSFER',
    'AI_CROSS_BORDER_TRANSFER_v1',
    '본 강의는 AI 서비스(해외 소재 서버 포함)를 활용하며, 이 과정에서 일부 정보가 국외로 이전될 수 있습니다.

※ 이 문구는 placeholder입니다. 실제 사용하는 AI 서비스와 이전 국가/항목으로 교체해야 합니다.'
  ),
  (
    'SOFTWARE_LICENSE_USE',
    'SOFTWARE_LICENSE_USE_v1',
    '본 강의에 포함된 소스코드는 개인 학습 목적으로만 이용할 수 있으며, 재배포·상업적 이용은 금지됩니다.

※ 이 문구는 placeholder입니다. 실제 라이선스 조건으로 교체해야 합니다.'
  )
on conflict (type, version) do nothing;

insert into public.terms (type, version, content, effective_at) values (
  'PRIVACY_USE',
  'APPLICATION_PRIVACY_v2',
  '본 서비스 가입 시 계정 식별 목적으로 디스코드 ID, 이메일을 수집하며, 수강 신청 시 결제 처리 및
수강 관리를 위해 이름, 연락처 등 추가 개인정보를 수집·이용합니다.

※ 이 문구는 placeholder입니다. 실제 서비스 오픈 전 전문으로 교체해야 합니다.',
  now()
)
on conflict (type, version) do nothing;

-- =========================================================
-- complete_signup(): 가입 시 SERVICE_USE + PRIVACY_USE 둘 다 원자적으로 받도록 확장.
-- 파라미터 목록이 바뀌므로(오버로드 혼선 방지) 기존 함수를 먼저 명시적으로 drop한다.
-- =========================================================
drop function public.complete_signup(uuid, text, text, boolean, text, uuid);

create or replace function public.complete_signup(
  p_user_id uuid,
  p_discord_id text,
  p_email text,
  p_email_verified boolean,
  p_role text,
  p_service_terms_id uuid,
  p_privacy_terms_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, discord_id, email, email_verified, role)
  values (p_user_id, p_discord_id, p_email, p_email_verified, p_role);

  insert into public.terms_agreements (user_id, terms_id)
  values (p_user_id, p_service_terms_id);

  insert into public.terms_agreements (user_id, terms_id)
  values (p_user_id, p_privacy_terms_id);
end;
$$;

-- =========================================================
-- apply_for_offering(): 단일 p_terms_id 대신 p_terms_ids(배열)를 받는다 — 신청 시점엔
-- PRIVACY_USE(아직 미동의 시)뿐 아니라, 그 개설강의가 요구하는 조건부 약관(있다면)도
-- 함께 넘어온다. 파라미터 목록이 바뀌므로 기존 함수를 먼저 명시적으로 drop한다.
-- =========================================================
drop function public.apply_for_offering(uuid, uuid, uuid);

create or replace function public.apply_for_offering(
  p_user_id uuid,
  p_offering_id uuid,
  p_terms_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offering record;
  v_reserved boolean;
  v_enrollment_id uuid;
  v_terms_id uuid;
begin
  select id, price into v_offering
  from public.course_offerings
  where id = p_offering_id
    and status = 'OPEN'
    and now() >= opens_at
    and (ends_at is null or now() <= ends_at);

  if v_offering.id is null then
    raise exception '신청할 수 없는 개설강의입니다.';
  end if;

  select public.reserve_course_offering_seat(p_offering_id) into v_reserved;
  if not coalesce(v_reserved, false) then
    raise exception '정원이 마감되어 신청할 수 없습니다.';
  end if;

  begin
    insert into public.enrollments (user_id, course_offering_id, list_price, final_amount)
    values (p_user_id, p_offering_id, v_offering.price, v_offering.price)
    returning id into v_enrollment_id;
  exception when unique_violation then
    perform public.release_course_offering_seat(p_offering_id);
    raise exception '이미 신청한 강의입니다.';
  end;

  insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, payload)
  values (p_user_id, p_offering_id, 'APPLIED', 'SYSTEM', '{}'::jsonb);

  if p_terms_ids is not null then
    foreach v_terms_id in array p_terms_ids loop
      insert into public.terms_agreements (user_id, terms_id)
      values (p_user_id, v_terms_id);
    end loop;
  end if;

  return v_enrollment_id;
end;
$$;

-- 신뢰 경계: 두 함수 모두 클라이언트에서 직접 호출하지 않는다(기존과 동일).
