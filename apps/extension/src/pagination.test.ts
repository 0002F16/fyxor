import { describe, expect, it } from "vitest";
import { paginate, pageCount, type Block } from "./pagination";

const block = (top: number, height: number, type: Block["type"] = "block"): Block => ({ top, height, type });

describe("paginate", () => {
  it("keeps everything on one page when it fits", () => {
    const blocks = [block(0, 200), block(200, 300), block(500, 200)];
    const starts = paginate(blocks, 1000);
    expect(starts).toEqual([0]);
    expect(pageCount(starts)).toBe(1);
  });

  it("returns a single page for empty input", () => {
    expect(paginate([], 1000)).toEqual([0]);
    expect(pageCount(paginate([], 1000))).toBe(1);
  });

  it("breaks to a new page at the block that overflows", () => {
    // blocks of 400 each; page holds 1000 -> 3rd block (top 800, end 1200) spills
    // page 1 holds blocks 0,1 (0-800); page 2 holds blocks 2,3 (800-1600)
    const blocks = [block(0, 400), block(400, 400), block(800, 400), block(1200, 400)];
    const starts = paginate(blocks, 1000);
    expect(starts).toEqual([0, 800]);
    expect(pageCount(starts)).toBe(2);
  });

  it("collapses whitespace before a page break (new page starts at the block top)", () => {
    // a large gap before the overflowing block: the page starts at the block, not the gap
    const blocks = [block(0, 900), block(1100, 300)];
    const starts = paginate(blocks, 1000);
    expect(starts).toEqual([0, 1100]);
  });

  it("pushes an orphaned heading to the next page with its content", () => {
    // heading fits (ends at 980) but its content (ends 1180) would not share the page
    const blocks = [block(0, 800), block(800, 180, "heading"), block(980, 200)];
    const starts = paginate(blocks, 1000);
    // heading moves down so it leads page 2
    expect(starts).toEqual([0, 800]);
  });

  it("does not push a heading that is already first on its page", () => {
    const blocks = [block(0, 80, "heading"), block(80, 1200)];
    const starts = paginate(blocks, 1000);
    // heading is first on page 0 with no body yet; oversized content stays with
    // it rather than stranding the heading alone
    expect(starts).toEqual([0]);
  });

  it("lets an oversized single block overflow its own page", () => {
    const blocks = [block(0, 300), block(300, 1500), block(1800, 200)];
    const starts = paginate(blocks, 1000);
    // block 2 overflows -> own page at 300; block 3 then needs another page
    expect(starts).toEqual([0, 300, 1800]);
  });
});
