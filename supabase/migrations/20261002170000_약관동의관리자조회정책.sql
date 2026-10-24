-- terms_agreements에 관리자 조회 정책을 추가한다(설계 검토).
-- 관리자 주문 상세(app/admin/orders/[id]/page.tsx)의 "학생이 결제할 수 없는 이유"(CS-A)는 관리자 세션(RLS 적용)으로
-- loadEligibilityContext를 불러 그 학생의 약관 동의를 읽는다. 지금 정책은 "본인 동의 이력만"이라 관리자에게 0건이 보여
-- TERMS_UP_TO_DATE 실패가 거짓으로 표시됐다(로컬 시뮬레이션: 관리자 세션에서 3,364건 중 본인 3건만 보임).
-- 다른 회원 테이블(users·orders·payment_events 등)과 같은 기준(is_admin())으로 맞춘다. 쓰기 정책은 바꾸지 않는다.
-- 매니저 조회는 이번에 넣지 않는다(매니저 화면과 함께 따로 정한다).

create policy "관리자는 전체 동의 이력 조회 가능"
  on public.terms_agreements for select
  using (public.is_admin());
