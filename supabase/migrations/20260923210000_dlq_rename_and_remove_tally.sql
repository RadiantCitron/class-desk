-- DB 구조 재정립 7단계(2026-09-23) — 남은 이름 정리(N2·N3).
-- webhook_failures는 이름과 달리 결제 웹훅 실패만 담는 곳이 아니라 아웃박스·무결성점검·
-- 감사기록 실패까지 담는 범용 DLQ다. 관리자 화면 경로도 이미 /admin/dlq다.
-- 실제 뜻에 맞는 이름 dead_letters로 바꾼다. TALLY는 Tally 외부 폼을 철거(2026-09-11)한
-- 뒤로 쓸 일이 없는 값이라 함께 뺀다(N3).

do $$
declare
  v_tally_count integer;
begin
  select count(*) into v_tally_count from public.webhook_failures where source = 'TALLY';
  if v_tally_count > 0 then
    raise exception 'webhook_failures.source=TALLY 행이 %건 있습니다 — 마이그레이션을 중단합니다.', v_tally_count;
  end if;
end $$;

alter table public.webhook_failures rename to dead_letters;
alter table public.dead_letters rename constraint webhook_failures_pkey to dead_letters_pkey;
alter table public.dead_letters rename constraint webhook_failures_resolved_by_fkey to dead_letters_resolved_by_fkey;

alter table public.dead_letters drop constraint webhook_failures_source_check;
alter table public.dead_letters add constraint dead_letters_source_check
  check (source = any (array['PAYAPP', 'MOCK', 'STEPPAY', 'OUTBOX', 'INTEGRITY', 'AUDIT', 'INTERNAL']));

-- record_payment_event()가 함수 본문 안에서 이 테이블 이름을 문자 그대로 쓴다 — 테이블
-- RENAME은 뷰·제약처럼 카탈로그 의존으로 추적되는 참조만 따라가고, 함수 본문 텍스트 속
-- 테이블 이름은 안 바뀐다(이전 4단계 이름바꾸기에서도 겪은 것과 같은 원리, 다만 그때는
-- 컬럼명이었고 이번엔 함수 본문 자체다). 매개변수 구성은 그대로라 `create or replace`로
-- 충분하다(드롭+재생성이 필요했던 이전 사례들과 달리 이번엔 REVOKE/GRANT 유실 위험이 없다).
create or replace function public.record_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_amount integer,
  p_currency text,
  p_order_id uuid,
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
  v_order_status text;
  v_payment_status text;
begin
  select user_id, course_offering_id, final_amount, status, payment_status
    into v_owner_id, v_offering_id, v_final_amount, v_order_status, v_payment_status
  from public.orders where id = p_order_id;

  if v_owner_id is null then
    raise exception '존재하지 않는 주문: %', p_order_id;
  end if;

  insert into public.payment_events (
    provider, provider_event_id, provider_transaction_id, event_type, amount, currency,
    order_id, payment_method, metadata, raw_payload
  ) values (
    p_provider, p_provider_event_id, p_provider_transaction_id, p_event_type, p_amount, p_currency,
    p_order_id, p_payment_method, p_metadata, p_raw_payload
  )
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return false;
  end if;

  if p_event_type = 'PAYMENT_SUCCEEDED' then
    if v_final_amount is null or p_amount is distinct from v_final_amount then
      insert into public.dead_letters (source, payload, error_message)
      values (
        p_provider,
        p_raw_payload,
        '결제 금액이 청구 금액과 다름(상태 반영 안 함, 대사·환불 확인 필요) — order_id='
          || p_order_id::text
          || ', 청구=' || coalesce(v_final_amount::text, 'null')
          || ', 수신=' || coalesce(p_amount::text, 'null')
          || ', payment_event_id=' || v_event_id::text
      );
      return true;
    end if;

    update public.orders
    set payment_status = 'PAID', paid_at = now(), payment_method = p_payment_method
    where id = p_order_id
      and payment_status = 'UNPAID'
      and status = 'APPROVED';

    if not found then
      insert into public.dead_letters (source, payload, error_message)
      values (
        p_provider,
        p_raw_payload,
        case
          when v_payment_status is distinct from 'UNPAID' then
            '이미 결제완료(PAID)된 신청 건에 결제성공 이벤트가 다시 들어옴(이중결제 의심) — order_id='
              || p_order_id::text || ', payment_event_id=' || v_event_id::text
          else
            '주문 상태가 APPROVED가 아닌 건에 결제성공 이벤트가 들어옴(결제 진행 중 취소·반려 의심, 환불 검토 필요) — order_id='
              || p_order_id::text
              || ', status=' || coalesce(v_order_status, 'null')
              || ', payment_event_id=' || v_event_id::text
        end
      );
      return true;
    end if;

    insert into public.outbox_messages (topic, payload)
    values (
      'GRANT_ENTITLEMENTS',
      jsonb_build_object(
        'payment_event_id', v_event_id,
        'user_id', v_owner_id,
        'order_id', p_order_id,
        'metadata', p_metadata
      )
    );
  elsif p_event_type = 'REFUNDED' then
    update public.orders
    set payment_status = 'REFUNDED',
        refunded_at = now(),
        status = 'CANCELLED',
        cancelled_at = coalesce(cancelled_at, now())
    where id = p_order_id and payment_status = 'PAID';

    if not found then
      insert into public.dead_letters (source, payload, error_message)
      values (
        p_provider,
        p_raw_payload,
        '결제완료 상태가 아닌 신청 건에 환불 이벤트가 들어옴(상태 반영 안 함) — order_id='
          || p_order_id::text
          || ', payment_status=' || coalesce(v_payment_status, 'null')
          || ', payment_event_id=' || v_event_id::text
      );
      return true;
    end if;

    if v_order_status is distinct from 'CANCELLED'
       and v_order_status is distinct from 'REJECTED'
       and v_offering_id is not null then
      perform public.release_course_offering_seat(v_offering_id);
    end if;

    insert into public.outbox_messages (topic, payload)
    values (
      'REVOKE_ENTITLEMENTS',
      jsonb_build_object(
        'user_id', v_owner_id,
        'order_id', p_order_id,
        'reason', 'REFUNDED'
      )
    );
  end if;

  return true;
end;
$$;
