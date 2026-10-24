-- 감사 모듈 재설계 3단계: 재배포 없이 감사를 끌 수 있는 런타임 스위치.
-- system_gates(20260920100000_system_gates.sql)에 AUDIT 행을 추가한다 — 이미 있는
-- 테이블·RLS·토글 UI·감사 기록을 그대로 재사용한다(새 테이블을 만들지 않는다).
--
-- AUDIT은 학생에게 보이는 봉쇄가 아니다(components/GateBanner.tsx가
-- USER_FACING_GATE_CODES만 순회하도록 lib/system/gates.ts에서 별도로 뺀다). 그래서 다른
-- 게이트처럼 신청·결제 화면에 배너를 띄우지 않는다 — /admin/system 화면에서만 보이고
-- 조작된다.

-- 시드 INSERT는 반드시 INSERT 금지 트리거 이전에 실행해야 한다(20260920100000과 동일 원칙).
drop trigger system_gates_forbid_insert on public.system_gates;

insert into public.system_gates (code) values ('AUDIT');

create trigger system_gates_forbid_insert
  before insert on public.system_gates
  for each row execute function public.system_gates_forbid_insert_delete();
