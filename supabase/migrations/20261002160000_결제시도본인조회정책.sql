-- payment_attempts에 본인 조회 정책을 추가한다(보정, 2026-10-02).
-- 결제 복귀 가드(lib/guards/checkout assertCheckoutEligibleForReturn)는 학생 세션(RLS 적용)으로
-- "이 시도 번호가 이 주문의 것인지"를 확인한다. 정책 없이 만들어서 학생에게 0건이 보였고, 결제 성공 복귀가
-- 승인 호출 전에 거부됐다(사용자 눈 확인). 원장(payment_events)의 "본인 결제 이력만 조회 가능"과 같은 기준이다.
-- 쓰기 정책은 두지 않는다(INSERT·UPDATE는 서버의 service_role만).

create policy "본인 결제 시도만 조회 가능"
  on public.payment_attempts for select
  using (
    exists (
      select 1 from public.orders o
      where o.id = payment_attempts.order_id
        and o.user_id = public.current_profile_id()
    )
  );

create policy "관리자는 전체 결제 시도 조회 가능"
  on public.payment_attempts for select
  using (public.is_admin());
