import { describe, expect, it } from "vitest";
import { makeDocx, makePdf } from "./export";
import type { TailoredCv } from "@cv-tailor/shared";

const cv: TailoredCv = {
  id: "cv1", baseProfileId: "p1", outputLanguage: "pl",
  contact: { name: "Łukasz Żółć", email: "lukasz@example.com", phone: "", location: "Łódź", linkedIn: "" },
  job: { title: "Kierownik", company: "Ćma", location: "Łódź", description: "A sufficiently long description for testing export output.", url: "", source: "manual" },
  summary: "Doświadczony specjalista: ą, ę, ś, ź, ż, ó, ć, ł, ń.",
  experiences: [{ id: "e1", sourceExperienceId: "e1", sourceBulletIndexes: [0], company: "Ćma", role: "Kierownik", startDate: "2020", endDate: "Now", bullets: ["Prowadził zespół."] }],
  education: [{ id: "ed1", school: "Uniwersytet Łódzki", degree: "Magister Zarządzania", location: "Łódź", graduationDate: "2015", gpa: "", honors: "", coursework: [] }],
  skills: ["Zarządzanie"], skillCategories: {},
  certifications: ["PMP — Project Management Institute"], languages: [{ language: "Polski", level: "Native" }],
  sectionOrder: [],
  style: { preset: "garamond" },
  dismissedChecks: [],
  unsupportedClaims: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
};

describe("exports", () => {
  it("creates valid PDF and DOCX buffers", async () => {
    const [pdf, docx] = await Promise.all([makePdf(cv), makeDocx(cv)]);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(docx.subarray(0, 2).toString()).toBe("PK");
    expect(pdf.length).toBeGreaterThan(10_000);
    expect(docx.length).toBeGreaterThan(1000);
  }, 30_000);
});
