-- DB 구조 재정립 2단계(2026-09-23 D3): 결제 이력 단일화.
-- 결제 성공/환불 사실이 payment_events와
-- enrollment_events(PAID/REFUNDED 미러) 두 곳에 이름만 바뀌어 이중 기록되고 있었다.
-- 결제 사실은 payment_events에만 남긴다. enrollment_events는 "신청서의 업무 이력"
-- (신청/승인/반려/취소)만 남는다.

-- 1. 안전장치: 지우려는 미러 행마다 payment_events에 같은 사실이 실제로 있는지 확인한다.
--    없으면(원장에서 사라진 사실을 지우는 셈이라) 마이그레이션을 중단한다.
do $$
declare
  v_unverified integer;
begin
  select count(*) into v_unverified
  from public.enrollment_events ee
  where ee.event_type in ('PAID', 'REFUNDED')
    and not exists (
      select 1 from public.payment_events pe
      where pe.enrollment_id = ee.enrollment_id
        and pe.event_type = case ee.event_type when 'PAID' then 'PAYMENT_SUCCEEDED' else 'REFUNDED' end
    );

  if v_unverified > 0 then
    raise exception 'enrollment_events의 결제 미러 % 행이 payment_events에 대응하는 사실이 없습니다 — 마이그레이션을 중단합니다.', v_unverified;
  end if;
end $$;

-- 2. 검증을 통과한 미러 행을 지운다. 원본(payment_events)은 그대로 남는다.
delete from public.enrollment_events where event_type in ('PAID', 'REFUNDED');

-- 3. CHECK에서 두 값을 뺀다. enrollment_events는 이제 신청서 업무 이력(신청/승인/반려/취소)만
--    남긴다.
alter table public.enrollment_events drop constraint enrollment_events_event_type_check;
alter table public.enrollment_events add constraint enrollment_events_event_type_check
  check (event_type in ('APPLIED', 'APPROVED', 'REJECTED', 'CANCELLED'));

-- 4. record_payment_event() — PAID/REFUNDED 분기에서 enrollment_events insert를 뺀다.
--    나머지 로직(금액 대사, 주문 상태 검증, 좌석 반환, 아웃박스 적재)은 무변경이다.
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
      -- (2단계) 결제 성공 사실은 payment_events 행 자체로 충분하다. enrollment_events에
      -- 'PAID' 미러를 더 쓰지 않는다.
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
    -- (2단계) 환불 사실도 payment_events 행 자체로 충분하다. enrollment_events에 'REFUNDED'
    -- 미러를 더 쓰지 않는다 — 수강 취소(CANCELLED)는 여전히 위 UPDATE로 반영된다.

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
