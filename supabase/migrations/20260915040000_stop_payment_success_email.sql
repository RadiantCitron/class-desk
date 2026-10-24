-- 결제 완료 메일을 보내지 않는다. 결제는 사이트에서 이미 끝난다.
-- record_payment_event가 SEND_EMAIL/PAYMENT_SUCCESS를 넣지 않게 한다.
-- GRANT_ENTITLEMENTS / REVOKE_ENTITLEMENTS / payment_method 기록은 그대로다.
-- outbox topic 제약에 SEND_EMAIL은 남겨 둔다(이미 쌓인 메시지·테스트 삽입용). drain이
-- 그 토픽을 만나도 메일은 보내지 않는다.

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
    return false;
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
  elsif p_event_type = 'REFUNDED' and p_enrollment_id is not null then
    update public.enrollments
    set payment_status = 'REFUNDED', payment_cancelled_at = now()
    where id = p_enrollment_id;

    insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, payload)
    values (v_owner_id, v_offering_id, 'REFUNDED', 'SYSTEM', p_raw_payload);

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
