import { describe, it, expect } from "vitest";
import {
  parseBlobPathname,
  downloadFilename,
  contentDispositionAttachment,
} from "./pathname";

describe("parseBlobPathname", () => {
  it("앞뒤 공백과 맨 앞 슬래시를 떼고 pathname만 남긴다", () => {
    expect(parseBlobPathname("  /source-packs/react-dump.zip  ")).toBe(
      "source-packs/react-dump.zip",
    );
  });

  it("빈 값은 거부한다", () => {
    expect(() => parseBlobPathname("   ")).toThrow("파일 경로가 비어 있습니다.");
  });

  it("전체 URL(://)은 거부한다", () => {
    expect(() =>
      parseBlobPathname("https://store.private.blob.vercel-storage.com/a.zip"),
    ).toThrow("파일 경로는 버셀 Blob pathname만 넣으세요. 전체 주소는 안 됩니다.");
  });

  it("상위 폴더 이동(..)과 백슬래시는 거부한다", () => {
    expect(() => parseBlobPathname("source-packs/../secret.zip")).toThrow(
      "파일 경로는 버셀 Blob pathname만 넣으세요. 전체 주소는 안 됩니다.",
    );
    expect(() => parseBlobPathname("source-packs\\dump.zip")).toThrow(
      "파일 경로는 버셀 Blob pathname만 넣으세요. 전체 주소는 안 됩니다.",
    );
  });

  it("허용되지 않은 문자는 거부한다", () => {
    expect(() => parseBlobPathname("source packs/a.zip")).toThrow(
      "파일 경로에 쓸 수 없는 문자가 있습니다.",
    );
  });

  it("200자를 넘는 경로는 거부한다", () => {
    expect(() => parseBlobPathname(`${"a".repeat(201)}.zip`)).toThrow("파일 경로가 너무 깁니다.");
  });
});

describe("downloadFilename", () => {
  it("마지막 경로 조각을 파일 이름으로 쓴다", () => {
    expect(downloadFilename("source-packs/react-dump.zip")).toBe("react-dump.zip");
  });
});

describe("contentDispositionAttachment", () => {
  it("ASCII 파일 이름은 filename과 filename*를 같이 넣는다", () => {
    expect(contentDispositionAttachment("react-dump.zip")).toBe(
      'attachment; filename="react-dump.zip"; filename*=UTF-8\'\'react-dump.zip',
    );
  });
});
