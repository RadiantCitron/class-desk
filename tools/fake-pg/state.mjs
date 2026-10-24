// 가짜 PG 공용 메모리 저장소(프로세스 재시작 시 초기화).

import { randomBytes } from "node:crypto";

function id(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** @type {Map<string, object>} paymentKey → toss payment */
export const tossPayments = new Map();

export function newTossPaymentKey() {
  return id("fake_pk");
}

export function newTossTxKey() {
  return id("fake_tx");
}

export const TOSS_SECRET = "test_sk_fake0000000000000000";
