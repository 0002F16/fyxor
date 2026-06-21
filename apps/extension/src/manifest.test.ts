import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("apps/extension/public/manifest.json", "utf8"));

describe("extension popup manifest", () => {
  it("uses the toolbar popup and only injects the LinkedIn integration", () => {
    expect(manifest.action.default_popup).toBe("popup.html");
    expect(manifest.permissions).toContain("contextMenus");
    expect(manifest.permissions).toContain("scripting");
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts[0].matches).toEqual(["https://*.linkedin.com/jobs/*"]);
  });

  it("bundles a muted looping instructional video", () => {
    const popup = readFileSync("apps/extension/src/Popup.tsx", "utf8");
    expect(popup).toContain("selection-demo.webm");
    expect(popup).toContain("autoPlay loop muted playsInline");
  });
});
