-- 실제 버그 발견(2026-09-11, Playwright E2E 테스트로 찾음): app/student/payment/[enrollmentId]/
-- page.tsx와 app/admin/payments/page.tsx가 처음부터 payment_events.payment_method를 조회하고
-- 있었는데, 이 컬럼이 DB에 없었다("column payment_events.payment_method does not exist",
-- 42703) — 결제 이력 표 자체가 늘 조용히 빈 화면으로 떴다. record_payment_event()가
-- p_payment_method 파라미터를 받으면서도 enrollments 캐시에만 반영하고 원장(payment_events)엔
-- 저장하지 않았던 게 원인. 공개 가능한 모든 정보를 기록하고 보여준다는 방침에도
-- 맞지 않았으므로, 컬럼을 지우는 대신 제대로 채워 넣는다.

alter table public.payment_events
  add column payment_method text,
  add constraint payment_events_payment_method_check
    check (payment_method is null or payment_method in ('CARD', 'BANK_TRANSFER', 'OTHER'));

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
begin
  if p_enrollment_id is not null then
    select user_id, course_offering_id into v_owner_id, v_offering_id
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
    return false; -- 이미 처리된 웹훅 재시도 — 멱등 처리로 조용히 종료.
  end if;

  if p_event_type = 'PAYMENT_SUCCEEDED' then
    if p_enrollment_id is not null then
      update public.enrollments
      set payment_status = 'PAID', paid_at = now(), payment_method = p_payment_method
      where id = p_enrollment_id and payment_status = 'UNPAID';

      if not found then
        insert into public.webhook_failures (source, payload, error_message)
        values (
          p_provider,
          p_raw_payload,
          '이미 결제완료(PAID)된 수강신청에 결제성공 이벤트가 다시 들어옴(이중결제 의심) — enrollment_id=' || p_enrollment_id::text || ', payment_event_id=' || v_event_id::text
        );
        return true;
      end if;

      insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, payload)
      values (v_owner_id, v_offering_id, 'PAID', 'SYSTEM', p_raw_payload);
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

    insert into public.outbox_messages (topic, payload)
    values (
      'SEND_EMAIL',
      jsonb_build_object(
        'template', 'PAYMENT_SUCCESS',
        'user_id', v_owner_id,
        'enrollment_id', p_enrollment_id
      )
    );
  elsif p_event_type = 'REFUNDED' and p_enrollment_id is not null then
    update public.enrollments
    set payment_status = 'REFUNDED', payment_cancelled_at = now()
    where id = p_enrollment_id;

    insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, payload)
    values (v_owner_id, v_offering_id, 'REFUNDED', 'SYSTEM', p_raw_payload);
  end if;

  return true;
end;
$$;
