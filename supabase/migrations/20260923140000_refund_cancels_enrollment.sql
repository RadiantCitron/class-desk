-- 서비스 오픈 전 크리티컬 수정 1차 마무리(2026-09-23): 환불 = 수강 종료.
--
-- 2026-09-23 "환불받고 나간 학생이 정원 1자리를 영구 점유한다"는 문제가 확인됐지만,
-- 좌석만 반환하면 enrollment_status가 ENROLLED로 남아 "수강 중인데 좌석은 남에게 넘어간"
-- 새 모순이 생긴다. 그래서 2단계(20260923110000)에서는 일부러 손대지 않고 정책 결정을
-- 기다렸다.
--
-- (2026-09-23): **환불 = 수강 종료**. 따라서 환불 시
--   ① payment_status = 'REFUNDED' (기존)
--   ② enrollment_status = 'CANCELLED' (신규)
--   ③ 좌석 반환 (신규)
-- 을 한 트랜잭션에서 함께 처리한다.
--
-- CHECK 제약 충족 확인(20260911100000_enrollment_status_split.sql):
--   - enrollments_status_consistency: CANCELLED는 enrollment_cancelled_at만 요구 → 채운다.
--   - enrollments_payment_consistency: REFUNDED는 paid_at·payment_method·payment_cancelled_at을
--     요구 → PAID였던 건만 대상이므로 앞의 둘은 이미 채워져 있다.
--
-- 참고: "(ENROLLED, REFUNDED)" 조합 자체는 여전히 스키마가 표현할 수 있다(2축 분리의 취지).
-- 다만 **환불 웹훅이 만들어내는 결과**는 이제 (CANCELLED, REFUNDED)다.

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
    -- 환불 = 수강 종료. 결제완료 건만 대상으로 하고, 수강 상태와
    -- 좌석까지 한 트랜잭션에서 함께 정리한다.
    update public.enrollments
    set payment_status = 'REFUNDED',
        payment_cancelled_at = now(),
        enrollment_status = 'CANCELLED',
        -- 이미 취소 시각이 있으면 원래 시각을 보존한다(덮어쓰지 않는다).
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

    insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, payload)
    values (v_owner_id, v_offering_id, 'REFUNDED', 'SYSTEM', p_raw_payload);

    -- 좌석 반환. 이미 취소·반려 상태였던 건(과거 데이터나 이례적 경로)이라면 그때 이미
    -- 반환됐으므로 이중 반환을 피한다.
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
