import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { Generator } from "./openai";

const profile = {
  id: "p1",
  contact: { name: "Karol", email: "", phone: "", location: "", linkedIn: "" },
  targetRole: "Product Manager",
  outputLanguage: "en" as const,
  summary: "Product manager",
  experiences: [],
  education: [],
  skills: ["Product strategy"],
  rawText: "Product manager with product strategy experience.",
  updatedAt: new Date().toISOString()
};

const job = {
  title: "Product Manager",
  company: "Acme",
  location: "Warsaw",
  description: "A sufficiently long job description requiring product strategy and stakeholder management.",
  url: "",
  source: "manual" as const
};

let closeServer: (() => Promise<void>) | undefined;
afterEach(async () => closeServer?.());

describe("API routes", () => {
  it("serves health and validates a mocked tailored CV response", async () => {
    const now = new Date().toISOString();
    const generator: Generator = {
      generate: async () => ({
        id: "cv1",
        baseProfileId: "p1",
        job,
        outputLanguage: "en",
        contact: profile.contact,
        summary: "Product manager focused on product strategy.",
        experiences: [],
        education: [],
        skills: ["Product strategy", "Roadmapping"],
        skillCategories: [{ name: "Strategy", skills: ["Product strategy", "Roadmapping"] }],
        unsupportedClaims: [],
        createdAt: now,
        updatedAt: now
      }) as never
    };
    const server = createApp(() => generator).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    closeServer = () => new Promise((resolve) => server.close(() => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/health`).then((response) => response.json());
    expect(health.configured).toBe(true);

    const response = await fetch(`${base}/api/cvs/tailor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, job })
    });
    expect(response.status).toBe(200);
    const tailored = await response.json();
    expect(tailored.id).toBe("cv1");
    // The built-in tailor folds the LLM's array-form categories into the record
    // shape and re-derives the flat union (regression: categories used to drop).
    expect(tailored.skillCategories).toEqual({ Strategy: ["Product strategy", "Roadmapping"] });
    expect(tailored.skills).toEqual(["Product strategy", "Roadmapping"]);
  });

  it("folds extracted skill categories into a record and a flat union", async () => {
    const now = new Date().toISOString();
    const generator: Generator = {
      generate: async () => ({
        id: "p1",
        contact: profile.contact,
        targetRole: "Product Manager",
        outputLanguage: "en",
        summary: "Product manager",
        experiences: [],
        education: [],
        skills: [],
        skillCategories: [
          { name: "Strategy", skills: ["Roadmapping", "Discovery"] },
          { name: "Tools", skills: ["Jira", "Roadmapping"] },
          { name: "", skills: ["ignored"] }
        ],
        rawText: "",
        updatedAt: now
      }) as never
    };
    const server = createApp(() => generator).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    closeServer = () => new Promise((resolve) => server.close(() => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/api/profile/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "A CV with more than thirty characters of content.", outputLanguage: "en" })
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.skillCategories).toEqual({ Strategy: ["Roadmapping", "Discovery"], Tools: ["Jira", "Roadmapping"] });
    // Flat union is de-duplicated and drops the empty-named category.
    expect(result.skills).toEqual(["Roadmapping", "Discovery", "Jira"]);
  });
});
