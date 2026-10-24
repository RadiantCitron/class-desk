import { describe, it, expect } from "vitest";
import { normalizeOfferingNotice } from "@/lib/shared/offering-notice";
import * as fs from "fs";
import * as path from "path";

describe("A-1 offering notice pure function", () => {
  it("normalizes empty strings and whitespace to null", () => {
    expect(normalizeOfferingNotice(null)).toBeNull();
    expect(normalizeOfferingNotice(undefined)).toBeNull();
    expect(normalizeOfferingNotice("")).toBeNull();
    expect(normalizeOfferingNotice("   \n\t  ")).toBeNull();
  });

  it("trims whitespace from text", () => {
    expect(normalizeOfferingNotice("  수업 공지입니다  ")).toBe("수업 공지입니다");
  });

  it("throws on strings exceeding 1000 characters", () => {
    const longText = "a".repeat(1001);
    expect(() => normalizeOfferingNotice(longText)).toThrow("공지문은 최대 1,000자까지 입력할 수 있습니다.");
    const exact1000 = "a".repeat(1000);
    expect(normalizeOfferingNotice(exact1000)).toBe(exact1000);
  });
});

describe("A-1 guard: no dangerouslySetInnerHTML in notice rendering components", () => {
  const filesToCheck = [
    "ui/screens/student/ApplyScreen.tsx",
    "ui/screens/student/StudentHomeScreen.tsx",
    "ui/screens/admin/course-offerings/OfferingNoticePanel.tsx",
  ];

  for (const relPath of filesToCheck) {
    it(`checks that ${relPath} does not use dangerouslySetInnerHTML`, () => {
      const fullPath = path.resolve(process.cwd(), relPath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        expect(content).not.toContain("dangerouslySetInnerHTML");
      }
    });
  }
});
