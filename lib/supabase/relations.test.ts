import { describe, it, expect } from "vitest";
import { one } from "./relations";

// PostgREST 임베디드 관계 런타임-타입 불일치 방어 테스트:
// PostgREST는 belongs-to(자식→부모) 관계를 단일 객체로 반환하지만, supabase-js 클라이언트의
// 일부 타입 추론은 이를 배열로 판단할 수 있다. `one()` 헬퍼는 객체와 배열 형태 모두를 단일 객체로
// 안전하게 정규화하여 런타임 `undefined` 참조 오류를 방지한다.
describe("one() — belongs-to 임베디드 관계 접근 헬퍼", () => {
  it("객체가 오면(PostgREST의 실제 런타임 동작) 그대로 반환한다", () => {
    expect(one({ name: "리액트 기초" })).toEqual({ name: "리액트 기초" });
  });

  it("배열이 오면(혹시 실제로 배열인 케이스도) 첫 원소를 반환한다", () => {
    expect(one([{ name: "A" }, { name: "B" }])).toEqual({ name: "A" });
  });

  it("빈 배열이면 undefined를 반환한다", () => {
    expect(one([])).toBeUndefined();
  });

  it("null/undefined면 그대로 undefined를 반환한다(에러를 던지지 않는다)", () => {
    expect(one(null)).toBeUndefined();
    expect(one(undefined)).toBeUndefined();
  });
});
