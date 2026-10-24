-- DB 구조 재정립 1단계(2026-09-23): 이력을 신청서 번호로 연결한다.
-- "신청서가 대장, 그 번호로 관련 이벤트를 묶는다"는
-- 요구사항을 채운다. 지금까지 enrollment_events(신청 업무 이력)와 terms_agreements(약관
-- 동의)는 신청서 번호(enrollment_id) 없이 (user_id, course_offering_id)로만 간접 식별됐다.
-- 이 마이그레이션은 동작을 바꾸지 않는다 — 기록하는 값 하나가 늘 뿐이다.

-- 1. enrollment_events.enrollment_id — NOT NULL로 만든다(이 이력은 항상 신청서 하나에
--    속하므로). 먼저 nullable로 추가하고 기존 행을 채운 뒤 조인다.
alter table public.enrollment_events
  add column enrollment_id uuid references public.enrollments (id) on delete restrict;

-- enrollments.UNIQUE(user_id, course_offering_id) 덕분에 이 매칭은 항상 1:1이다.
update public.enrollment_events ee
set enrollment_id = e.id
from public.enrollments e
where e.user_id = ee.user_id
  and e.course_offering_id = ee.course_offering_id;

-- 안전장치: 매칭이 안 된 행이 있으면(신청서가 이미 지워졌다는 뜻 — 이 저장소는 신청서를
-- 하드 삭제하지 않으므로 실제로는 일어날 수 없다) 마이그레이션을 여기서 멈춘다.
do $$
declare
  v_unmatched integer;
begin
  select count(*) into v_unmatched from public.enrollment_events where enrollment_id is null;
  if v_unmatched > 0 then
    raise exception 'enrollment_events % 행이 신청서와 매칭되지 않았습니다 — 마이그레이션을 중단합니다.', v_unmatched;
  end if;
end $$;

alter table public.enrollment_events
  alter column enrollment_id set not null;

create index enrollment_events_enrollment_id_idx on public.enrollment_events (enrollment_id);

-- 2. terms_agreements.enrollment_id — nullable로 둔다. 가입 시 한 동의(SERVICE_USE/
--    PRIVACY_USE)는 어느 신청서에도 속하지 않으므로 이 컬럼이 null인 것 자체가 정상이다.
--    신청 시 한 동의(조건부 약관 등, apply_for_offering이 만드는 행)만 값이 채워진다.
alter table public.terms_agreements
  add column enrollment_id uuid references public.enrollments (id) on delete restrict;

-- 기존 행 backfill: apply_for_offering()은 한 트랜잭션 안에서 enrollments.applied_at과
-- terms_agreements.agreed_at을 둘 다 now()로 채운다 — Postgres의 now()는 트랜잭션 안에서
-- 고정값이므로, 신청 시 동의라면 두 값이 정확히 같다. 같은 사용자·같은 시각으로 신청서가
-- 정확히 하나만 매칭될 때만 채운다(모호하면 null로 남겨 가입 동의로 취급 — 안전한 쪽으로).
update public.terms_agreements ta
set enrollment_id = matched.enrollment_id
from (
  select terms_agreement_id, enrollment_id
  from (
    select ta2.id as terms_agreement_id, e.id as enrollment_id,
           count(*) over (partition by ta2.id) as match_count
    from public.terms_agreements ta2
    join public.enrollments e
      on e.user_id = ta2.user_id and e.applied_at = ta2.agreed_at
  ) counted
  where match_count = 1
) matched
where ta.id = matched.terms_agreement_id;

create index terms_agreements_enrollment_id_idx on public.terms_agreements (enrollment_id);

-- 3. apply_for_offering() — 신청 이벤트와 신청 시 약관 동의 둘 다에 enrollment_id를 남긴다.
create or replace function public.apply_for_offering(p_user_id uuid, p_offering_id uuid, p_terms_ids uuid[])
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
    and deleted_at is null
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

  insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, payload, enrollment_id)
  values (p_user_id, p_offering_id, 'APPLIED', 'SYSTEM', '{}'::jsonb, v_enrollment_id);

  if p_terms_ids is not null then
    foreach v_terms_id in array p_terms_ids loop
      insert into public.terms_agreements (user_id, terms_id, enrollment_id)
      values (p_user_id, v_terms_id, v_enrollment_id);
    end loop;
  end if;

  return v_enrollment_id;
end;
$$;

-- 4. transition_enrollment() — 승인·반려·취소 이벤트에 enrollment_id를 남긴다.
create or replace function public.transition_enrollment(
  p_enrollment_id uuid,
  p_actor_id uuid,
  p_event_type text,
  p_next_status text,
  p_set_note boolean default false,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enrollment record;
  v_email_verified boolean;
  v_actor_role text;
  v_allowed_from text[];
begin
  v_allowed_from := case p_next_status
    when 'ENROLLED'  then array['PENDING']
    when 'REJECTED'  then array['PENDING']
    when 'CANCELLED' then array['PENDING', 'ENROLLED']
    else null
  end;

  if v_allowed_from is null then
    raise exception '허용되지 않은 전이 대상 상태입니다: %', p_next_status;
  end if;

  select id, user_id, course_offering_id, enrollment_status, payment_status
    into v_enrollment
  from public.enrollments
  where id = p_enrollment_id
  for update;

  if v_enrollment.id is null then
    raise exception '신청 내역을 찾을 수 없습니다.';
  end if;

  if not (v_enrollment.enrollment_status = any (v_allowed_from)) then
    raise exception '이미 처리된 신청입니다(현재 상태: %). 화면을 새로고침한 뒤 다시 확인해 주세요.',
      v_enrollment.enrollment_status
      using errcode = 'restrict_violation';
  end if;

  if p_next_status = 'ENROLLED' then
    select email_verified into v_email_verified
    from public.users where id = v_enrollment.user_id;

    if coalesce(v_email_verified, false) is not true then
      raise exception '이 학생은 디스코드에서 이메일 인증을 해야 합니다. 인증 후 다시 로그인하면 승인할 수 있습니다.';
    end if;
  end if;

  if p_next_status = 'CANCELLED' and v_enrollment.payment_status <> 'UNPAID' then
    raise exception '이미 결제된 건은 취소가 아니라 환불로 처리해야 합니다.';
  end if;

  update public.enrollments
  set enrollment_status = p_next_status,
      enrolled_at = case when p_next_status = 'ENROLLED' then now() else enrolled_at end,
      enrollment_cancelled_at = case when p_next_status = 'CANCELLED' then now() else enrollment_cancelled_at end
  where id = p_enrollment_id
    and enrollment_status = any (v_allowed_from);

  if not found then
    raise exception '이미 처리된 신청입니다. 화면을 새로고침한 뒤 다시 확인해 주세요.'
      using errcode = 'restrict_violation';
  end if;

  if p_set_note then
    if nullif(p_note, '') is null then
      delete from public.enrollment_admin_notes where enrollment_id = p_enrollment_id;
    else
      insert into public.enrollment_admin_notes (enrollment_id, note, written_by)
      values (p_enrollment_id, p_note, p_actor_id)
      on conflict (enrollment_id) do update
        set note = excluded.note,
            written_by = excluded.written_by,
            updated_at = now();
    end if;
  end if;

  select role into v_actor_role from public.users where id = p_actor_id;

  insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, actor_user_id, enrollment_id)
  values (
    v_enrollment.user_id,
    v_enrollment.course_offering_id,
    p_event_type,
    case when v_actor_role = 'ADMIN' then 'ADMIN' else 'MANAGER' end,
    p_actor_id,
    p_enrollment_id
  );

  if p_next_status in ('REJECTED', 'CANCELLED') then
    perform public.release_course_offering_seat(v_enrollment.course_offering_id);
  end if;
end;
$$;

-- 5. cancel_own_enrollment() — 학생 본인 취소 이벤트에 enrollment_id를 남긴다.
create or replace function public.cancel_own_enrollment(p_enrollment_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enrollment record;
begin
  select id, user_id, course_offering_id, enrollment_status, payment_status
    into v_enrollment
  from public.enrollments
  where id = p_enrollment_id
  for update;

  if v_enrollment.id is null then
    raise exception '신청 내역을 찾을 수 없습니다.';
  end if;

  if v_enrollment.user_id <> p_user_id then
    raise exception '본인의 신청 건만 취소할 수 있습니다.';
  end if;

  if v_enrollment.payment_status <> 'UNPAID' then
    raise exception '이미 결제된 건은 여기서 취소할 수 없습니다. 환불은 관리자에게 문의해 주세요.';
  end if;

  update public.enrollments
  set enrollment_status = 'CANCELLED',
      enrollment_cancelled_at = now()
  where id = p_enrollment_id
    and enrollment_status in ('PENDING', 'ENROLLED');

  if not found then
    raise exception '이미 종료되었거나 취소된 신청 건입니다.'
      using errcode = 'restrict_violation';
  end if;

  insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, actor_user_id, enrollment_id)
  values (v_enrollment.user_id, v_enrollment.course_offering_id, 'CANCELLED', 'STUDENT', p_user_id, p_enrollment_id);

  perform public.release_course_offering_seat(v_enrollment.course_offering_id);
end;
$$;

-- 6. record_payment_event() — 결제 성공/환불 미러 이벤트(PAID/REFUNDED)에 enrollment_id를
--    남긴다. 둘 다 이미 `p_enrollment_id is not null` 분기 안에서만 실행된다.
create or replace function public.record_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_amount integer,
  p_currency text,
  p_purpose text,
  p_enrollment_id uuid,
  p_user_id uuid,
  p_payment_method text,
  p_metadata jsonb,
  p_raw_payload jsonb,
  p_provider_transaction_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_owner_id uuid;
  v_offering_id uuid;
  v_final_amount integer;
  v_enrollment_status text;
  v_payment_status text;
begin
  if p_enrollment_id is not null then
    select user_id, course_offering_id, final_amount, enrollment_status, payment_status
      into v_owner_id, v_offering_id, v_final_amount, v_enrollment_status, v_payment_status
    from public.enrollments where id = p_enrollment_id;

    if v_owner_id is null then
      raise exception '존재하지 않는 수강신청: %', p_enrollment_id;
    end if;
  else
    v_owner_id := p_user_id;
  end if;

  insert into public.payment_events (
    provider, provider_event_id, provider_transaction_id, event_type, amount, currency, purpose,
    enrollment_id, user_id, payment_method, metadata, raw_payload
  ) values (
    p_provider, p_provider_event_id, p_provider_transaction_id, p_event_type, p_amount, p_currency, p_purpose,
    p_enrollment_id, v_owner_id, p_payment_method, p_metadata, p_raw_payload
  )
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return false;
  end if;

  if p_event_type = 'PAYMENT_SUCCEEDED' then
    if p_enrollment_id is not null then
      if v_final_amount is null or p_amount is distinct from v_final_amount then
        insert into public.webhook_failures (source, payload, error_message)
        values (
          p_provider,
          p_raw_payload,
          '결제 금액이 청구 금액과 다름(상태 반영 안 함, 대사·환불 확인 필요) — enrollment_id='
            || p_enrollment_id::text
            || ', 청구=' || coalesce(v_final_amount::text, 'null')
            || ', 수신=' || coalesce(p_amount::text, 'null')
            || ', payment_event_id=' || v_event_id::text
        );
        return true;
      end if;

      update public.enrollments
      set payment_status = 'PAID', paid_at = now(), payment_method = p_payment_method
      where id = p_enrollment_id
        and payment_status = 'UNPAID'
        and enrollment_status = 'ENROLLED';

      if not found then
        insert into public.webhook_failures (source, payload, error_message)
        values (
          p_provider,
          p_raw_payload,
          case
            when v_payment_status is distinct from 'UNPAID' then
              '이미 결제완료(PAID)된 수강신청에 결제성공 이벤트가 다시 들어옴(이중결제 의심) — enrollment_id='
                || p_enrollment_id::text || ', payment_event_id=' || v_event_id::text
            else
              '수강 상태가 ENROLLED가 아닌 신청 건에 결제성공 이벤트가 들어옴(결제 진행 중 취소·반려 의심, 환불 검토 필요) — enrollment_id='
                || p_enrollment_id::text
                || ', enrollment_status=' || coalesce(v_enrollment_status, 'null')
                || ', payment_event_id=' || v_event_id::text
          end
        );
        return true;
      end if;

      insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, payload, enrollment_id)
      values (v_owner_id, v_offering_id, 'PAID', 'SYSTEM', p_raw_payload, p_enrollment_id);
    end if;

    insert into public.outbox_messages (topic, payload)
    values (
      'GRANT_ENTITLEMENTS',
      jsonb_build_object(
        'payment_event_id', v_event_id,
        'user_id', v_owner_id,
        'enrollment_id', p_enrollment_id,
        'purpose', p_purpose,
        'metadata', p_metadata
      )
    );
  elsif p_event_type = 'REFUNDED' and p_enrollment_id is not null then
    update public.enrollments
    set payment_status = 'REFUNDED',
        payment_cancelled_at = now(),
        enrollment_status = 'CANCELLED',
        enrollment_cancelled_at = coalesce(enrollment_cancelled_at, now())
    where id = p_enrollment_id and payment_status = 'PAID';

    if not found then
      insert into public.webhook_failures (source, payload, error_message)
      values (
        p_provider,
        p_raw_payload,
        '결제완료 상태가 아닌 신청 건에 환불 이벤트가 들어옴(상태 반영 안 함) — enrollment_id='
          || p_enrollment_id::text
          || ', payment_status=' || coalesce(v_payment_status, 'null')
          || ', payment_event_id=' || v_event_id::text
      );
      return true;
    end if;

    insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, payload, enrollment_id)
    values (v_owner_id, v_offering_id, 'REFUNDED', 'SYSTEM', p_raw_payload, p_enrollment_id);

    if v_enrollment_status is distinct from 'CANCELLED'
       and v_enrollment_status is distinct from 'REJECTED' then
      perform public.release_course_offering_seat(v_offering_id);
    end if;

    insert into public.outbox_messages (topic, payload)
    values (
      'REVOKE_ENTITLEMENTS',
      jsonb_build_object(
        'user_id', v_owner_id,
        'enrollment_id', p_enrollment_id,
        'reason', 'REFUNDED'
      )
    );
  end if;

  return true;
end;
$$;
