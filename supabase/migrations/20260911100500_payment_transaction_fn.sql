-- record_payment_event(): complete_signup()/reserve_course_offering_seat()와 동일한 패턴 —
-- "결제 원장 INSERT" + "enrollments 현재상태 캐시 UPDATE" + "enrollment_events 기록" +
-- "아웃박스 메시지 적재"를 하나의 DB 트랜잭션으로 묶는다. 이 넷을 애플리케이션 코드에서
-- 순차적인 여러 insert/update로 나누면, 중간 실패 시 "돈은 받았는데 권한 부여가 안 됐다" 같은
-- 불일치가 생길 수 있다.
--
-- 멱등성: unique(provider, provider_event_id)에 on conflict do nothing으로 기댄다. 웹훅이
-- 같은 이벤트를 재전송해도 이 함수를 다시 호출하면 영향 0행으로 조용히 끝난다(false 반환).

alter table public.enrollment_events drop constraint enrollment_events_event_type_check;
alter table public.enrollment_events
  add constraint enrollment_events_event_type_check
    check (event_type in ('APPLIED', 'APPROVED', 'REJECTED', 'CANCELLED', 'PAID', 'REFUNDED'));

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
    enrollment_id, user_id, metadata, raw_payload
  ) values (
    p_provider, p_provider_event_id, p_provider_transaction_id, p_event_type, p_amount, p_currency, p_purpose,
    p_enrollment_id, v_owner_id, p_metadata, p_raw_payload
  )
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return false; -- 이미 처리된 웹훅 재시도 — 멱등 처리로 조용히 종료.
  end if;

  if p_event_type = 'PAYMENT_SUCCEEDED' then
    if p_enrollment_id is not null then
      -- 이중결제 방지: 이 UPDATE는 payment_status가 아직 UNPAID일 때만 걸린다. 두 개의 서로 다른
      -- 체크아웃 세션(예: 학생이 결제하기를 두 번 눌러 각각 성공)이 둘 다 성공 웹훅을 보내면,
      -- 원장(payment_events)엔 사실 그대로 둘 다 기록되지만(위 INSERT, 이미 끝남), 두 번째 건은
      -- enrollments/entitlements에 반영하지 않는다 — 그대로 반영하면 권한이 중복 부여되고,
      -- 실제 PG라면 학생이 두 번 결제된 상태일 수 있다(2026-09-11 결함 B).
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
        return true; -- 원장 기록은 유지, 상태갱신/권한부여만 건너뛰고 관리자 확인으로 넘긴다.
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

    -- 결제 완료 알림 메일도 같은 아웃박스 메커니즘을 탄다(발송은 lib/outbox/drain.ts,
    -- 실제 발송은 lib/email/send.ts — 로컬은 Mailpit으로 흉내만 낸다). 실제 발송(외부 I/O)은
    -- 이 트랜잭션 밖에서 일어나므로, 메일이 실패해도 결제 원장/entitlements 부여엔 영향 없다.
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
  -- PAYMENT_INITIATED / PAYMENT_FAILED: 원장에만 남기고 캐시/아웃박스는 건드리지 않는다.

  return true;
end;
$$;

-- 신뢰 경계: 클라이언트에서 직접 호출하지 않는다. 결제 웹훅 라우트(service_role)에서만 호출한다.
