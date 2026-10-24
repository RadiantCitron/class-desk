// 대사 점검용 조회 보조 — PostgREST의 두 가지 제약을 다룬다.
//  1) 한 번에 최대 1000행만 돌려준다 → fetchAllPages로 페이지를 이어 붙인다.
//  2) `in (...)` 조건이 길면 URL이 너무 길어진다 → fetchInChunks로 100개씩 나눠 조회한다.
// 후보마다 조회하는 N+1을 집합 조회로 바꾸기 위한 것이다.

export const PAGE_SIZE = 1000;
export const IN_CHUNK = 100;

type PageResult<T> = { data: T[] | null; error: { message: string } | null };

/** 한 페이지를 가져오는 함수를 받아 1000행씩 이어 붙인다. 정렬 기준은 호출하는 쪽이 정해야 페이지 사이 중복·누락이 없다. */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

/** id 목록을 100개씩 나눠, 각 조각마다 (필요하면 페이지를 이어 붙이며) 조회한 결과를 합친다. */
export async function fetchInChunks<T>(
  ids: string[],
  fetchPage: (chunk: string[], from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    out.push(...(await fetchAllPages<T>((from, to) => fetchPage(chunk, from, to))));
  }
  return out;
}

// 시각 비교는 결제 모듈(시도-결과 매칭)도 같이 써서 공용 위치로 옮겼다 — 기존 import 경로는 그대로 둔다.
export { compareTimestamps } from "@/lib/shared/datetime";
