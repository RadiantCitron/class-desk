-- 앱 역할(anon·authenticated·service_role)의 권한을 이 파일에 명시한다.
-- 결정: 클라우드 대비 명시적 테이블 권한 마이그레이션. 원본: 로컬 ACL 스냅샷.
--
-- 왜: 지금까지 테이블 권한은 Supabase의 「새 객체에 앱 역할 권한 자동 부여」 기본값에서 왔다(마이그레이션에는 revoke만 있었다).
-- Supabase는 2026-05-30 이후 새 프로젝트, 2026-10-30부터 기존 프로젝트에서 이 기본값을 끈다(changelog #45329).
-- 이 파일은 C-1 스냅샷을 그대로 옮긴 「권한 정본」이다. 권한을 늘리거나 줄이지 않는다.
-- 이미 다른 파일에 있는 grant(함수 34개·컬럼 2개)도 다시 적는다 — 같은 grant를 반복해도 결과는 같고, 이 파일 하나만 보면 전체 권한을 알 수 있게 하려는 것이다.
-- 앞선 파일의 revoke로 빠진 권한은 여기서도 주지 않는다(예: users의 delete·truncate, audit_logs의 update·delete·truncate).
-- PUBLIC 실행 권한(Postgres 자체 기본값)은 건드리지 않는다. 앱은 위 세 역할로만 접속한다.
-- 시퀀스: public에 없다(id가 uuid). btree_gist 확장·timerange 생성자 함수(supabase_admin 소유)는 대상이 아니다.
--
-- 이후 규칙(결정 3): 테이블·뷰·시퀀스·함수를 새로 만드는 마이그레이션은 같은 파일 안에 필요한 grant를 쓴다.

-- =====================================================================
-- 1. 테이블 (24개)
-- =====================================================================
grant all on public.account_events to anon, authenticated, service_role;
grant select, insert, references, trigger, maintain on public.audit_logs to anon, authenticated, service_role;
grant all on public.course_offerings to anon, authenticated, service_role;
grant all on public.course_sessions to anon, authenticated, service_role;
grant all on public.courses to anon, authenticated, service_role;
grant all on public.dead_letters to service_role;
grant select, references, trigger, maintain on public.dead_letters to authenticated;
grant references, trigger, maintain on public.dead_letters to anon;
grant all on public.discord_accounts to anon, authenticated, service_role;
grant all on public.discount_rules to anon, authenticated, service_role;
grant all on public.entitlement_uses to anon, authenticated, service_role;
grant all on public.entitlements to anon, authenticated, service_role;
grant all on public.manager_permissions to anon, authenticated, service_role;
grant all on public.order_events to anon, authenticated, service_role;
grant all on public.orders to anon, authenticated, service_role;
grant all on public.outbox_messages to anon, authenticated, service_role;
grant all on public.payment_attempts to anon, authenticated, service_role;
grant all on public.payment_events to anon, authenticated, service_role;
grant all on public.payment_settings to anon, authenticated, service_role;
grant all on public.products to anon, authenticated, service_role;
grant all on public.rail_switches to anon, authenticated, service_role;
grant all on public.student_restrictions to anon, authenticated, service_role;
grant all on public.system_gates to anon, authenticated, service_role;
grant all on public.terms to anon, authenticated, service_role;
grant all on public.terms_agreements to service_role;
grant select, references, trigger, maintain on public.terms_agreements to authenticated;
grant references, trigger, maintain on public.terms_agreements to anon;
grant select, insert, update, references, trigger, maintain on public.users to anon, authenticated, service_role;

-- =====================================================================
-- 2. 컬럼 단위 (20261007110000:15,44와 같은 내용)
-- =====================================================================
grant update (resolution_reason, resolved, resolved_at, resolved_by) on public.dead_letters to authenticated;
grant insert (terms_id, user_id) on public.terms_agreements to authenticated;

-- =====================================================================
-- 3. 함수 실행 권한 (우리 함수 57개)
--    record_payment_event·sync_my_email의 service_role은 지금까지 기본값에서만 왔다(C-1 발견 1·2).
-- =====================================================================
grant execute on function public.assert_manager_eligible(uuid) to service_role;
grant execute on function public.audit_logs_forbid_update_delete() to anon, authenticated, service_role;
grant execute on function public.auth_account_state_by_email(text) to service_role;
grant execute on function public.begin_refund_request(uuid,text,integer,text,text) to service_role;
grant execute on function public.cancel_course_offering(uuid,text,uuid) to service_role;
grant execute on function public.cancel_orders_for_withdrawn_user(uuid) to service_role;
grant execute on function public.cancel_own_order(uuid,uuid) to service_role;
grant execute on function public.check_no_student_schedule_conflict() to anon, authenticated, service_role;
grant execute on function public.claim_outbox_messages(integer,integer) to service_role;
grant execute on function public.complete_course_offering_cancel(uuid,uuid) to service_role;
grant execute on function public.complete_signup(uuid,text,uuid,uuid,uuid) to service_role;
grant execute on function public.consume_entitlement(uuid,uuid,text,text) to service_role;
grant execute on function public.create_course_offering(uuid,text,integer,integer,text,boolean,timestamp with time zone,timestamp with time zone,text[],jsonb,time without time zone,time without time zone,smallint[],timestamp with time zone,boolean) to authenticated, service_role;
grant execute on function public.create_order(uuid,uuid,uuid,uuid[]) to service_role;
grant execute on function public.current_profile_id() to anon, authenticated, service_role;
grant execute on function public.dead_letters_freeze_resolved() to anon, authenticated, service_role;
grant execute on function public.delete_course_offering(uuid,text,uuid) to anon, authenticated, service_role;
grant execute on function public.enforce_status_transition_reason() to anon, authenticated, service_role;
grant execute on function public.event_log_forbid_app_update_delete() to anon, authenticated, service_role;
grant execute on function public.fail_refund_request(uuid,text,text) to service_role;
grant execute on function public.forbid_users_delete() to anon, authenticated, service_role;
grant execute on function public.gate_open(text) to anon, authenticated, service_role;
grant execute on function public.generate_access_code() to service_role;
grant execute on function public.get_pending_terms(uuid) to service_role;
grant execute on function public.grant_entitlements_for_order(uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.grants_shape_ok(jsonb) to anon, authenticated, service_role;
grant execute on function public.has_permission(text) to anon, authenticated, service_role;
grant execute on function public.is_admin() to anon, authenticated, service_role;
grant execute on function public.link_discord_identity(uuid,text) to service_role;
grant execute on function public.manager_permissions_forbid_closed_update() to anon, authenticated, service_role;
grant execute on function public.mark_discord_role_removed(uuid) to service_role;
grant execute on function public.on_payment_refunded(uuid,uuid,text,integer,text) to service_role;
grant execute on function public.on_payment_succeeded(uuid,uuid,text,integer,text,text,jsonb) to service_role;
grant execute on function public.payment_settings_forbid_insert_delete() to anon, authenticated, service_role;
grant execute on function public.permission_history_forbid_delete() to anon, authenticated, service_role;
grant execute on function public.rail_switches_guard_mutation() to anon, authenticated, service_role;
grant execute on function public.reactivate_user(uuid,uuid,uuid) to service_role;
grant execute on function public.record_identity_link_failed(uuid,jsonb) to service_role;
grant execute on function public.record_payment_event(text,text,text,integer,text,uuid,text,jsonb,jsonb,text) to service_role;
grant execute on function public.release_course_offering_seat(uuid) to service_role;
grant execute on function public.reserve_course_offering_seat(uuid) to service_role;
grant execute on function public.reset_dead_outbox_message(uuid) to service_role;
grant execute on function public.retired_control_tables_forbid_write() to anon, authenticated, service_role;
grant execute on function public.revoke_entitlements(uuid,uuid,text) to service_role;
grant execute on function public.revoke_manager(uuid,text,uuid) to service_role;
grant execute on function public.set_course_offering_status(uuid,text,text,uuid) to authenticated, service_role;
grant execute on function public.set_manager(uuid,uuid,boolean,boolean,boolean) to service_role;
grant execute on function public.set_payment_provider(text,text,uuid) to service_role;
grant execute on function public.set_product_status(uuid,text,text,uuid) to authenticated, service_role;
grant execute on function public.set_updated_at() to anon, authenticated, service_role;
grant execute on function public.student_restrictions_forbid_closed_update() to anon, authenticated, service_role;
grant execute on function public.sync_my_email() to authenticated, service_role;
grant execute on function public.system_gates_forbid_insert_delete() to anon, authenticated, service_role;
grant execute on function public.transition_order(uuid,uuid,text,text,text) to service_role;
grant execute on function public.update_course_offering(uuid,uuid,text,jsonb) to authenticated, service_role;
grant execute on function public.users_guard_admin_role() to anon, authenticated, service_role;
grant execute on function public.withdraw_user(uuid) to service_role;
