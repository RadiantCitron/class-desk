-- 서비스 오픈 전 크리티컬 수정 2단계(2026-09-23): 결제 확정 시 가드 3종.
-- 진단 전문은 .
--
-- record_payment_event()는 "원장에는 사실 그대로 기록하되, 반영할 수 없는 건은 상태를
-- 바꾸지 않고 DLQ에 남긴다"는 기존 이중결제 처리 철학을 따른다. 이번에 그 철학을 적용받는
-- 경우를 셋 더 추가한다.
--
--   ⑥ 금액 대사 부재 — p_amount를 원장에 그대로 넣을 뿐 enrollments.final_amount와 한 번도
--      비교하지 않았다. "금액은 DB 값만 쓴다"는 보장은 체크아웃 생성 시점에만 있었고 확정
--      시점엔 아무 검증이 없어서, PG가 위·변조되거나 오류로 적은 금액을 보내면 그대로
--      PAID가 찍히고 권한까지 부여됐다.
--   ② 주문 상태 미검증 — payment_status만 보고 enrollment_status를 안 봐서, 학생이 PG
--      결제창에 머무는 동안 관리자가 취소하면 (CANCELLED, PAID) 행이 만들어지고
--      entitlements·디스코드 역할까지 부여됐다. 좌석은 이미 남에게 팔린 뒤다.
--   ⑦ 환불 경로에 조건부 가드 부재 — 성공 분기에만 가드가 있고 환불 분기엔 없었다. UNPAID
--      건에 환불 웹훅이 오면 enrollments_payment_consistency CHECK(REFUNDED는 paid_at·
--      payment_method NOT NULL 요구)에 걸려 트랜잭션 전체가 롤백돼, 환불 시도 사실이
--      원장에도 안 남았다.
--
-- 세 경우 모두 상태를 바꾸지 않고 webhook_failures(기존 /admin/dlq 화면)에 남긴다 —
-- 자동 환불은 하지 않는다(환불 개시 수단 자체가 아직 없고 정책도 미정, "찾아서 보여주기"
-- 까지만 한다는 lib/integrity/checks.ts와 같은 원칙).

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
    -- 상태·금액을 UPDATE 이전 시점 기준으로 함께 읽어둔다(아래에서 실패 원인을 구분해
    -- DLQ 메시지에 적기 위해 필요하다).
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
      -- ⑥ 금액 대사. 단독 구매(enrollment_id 없음)는 대조할 청구액이 없어 이 검사를 건너뛴다.
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

      -- ② 결제 상태와 수강 상태를 함께 본다. 둘 중 하나라도 어긋나면 반영하지 않는다.
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

    -- 위 가드에 걸린 경우는 이미 return true로 빠져나갔으므로, 여기까지 온 건만 권한을
    -- 받는다 — 취소된 신청에 entitlements·디스코드 역할이 부여되던 경로가 닫힌다.
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
    -- ⑦ 결제완료 건만 환불 처리한다. 예전엔 가드가 없어 UNPAID 건에 환불 웹훅이 오면
    -- CHECK 위반으로 트랜잭션 전체가 롤백돼 원장 기록조차 남지 않았다.
    update public.enrollments
    set payment_status = 'REFUNDED', payment_cancelled_at = now()
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
