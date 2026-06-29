// Client-side A4 pagination for the resume preview.
//
// The server PDF (apps/api/src/cvHtml.ts) prints A4 with a 0.5in margin and the
// print rules `h2 { break-after: avoid }` and `.break-inside-avoid, li {
// break-inside: avoid }`. We mirror that here by measuring the read-only
// CvDocument render and deciding where each printed page starts. The result
// drives both the paginated preview (windowing) and the "Fits on N pages" badge.

// A4 @96dpi and the 0.5in (48px) print margin from the export's @page rule.
export const PAGE_WIDTH_PX = 794;
export const PAGE_HEIGHT_PX = 1123;
export const PAGE_MARGIN_PX = 48;
export const CONTENT_WIDTH_PX = PAGE_WIDTH_PX - 2 * PAGE_MARGIN_PX; // 698
export const PRINTABLE_HEIGHT_PX = PAGE_HEIGHT_PX - 2 * PAGE_MARGIN_PX; // 1027

export type Block = {
  /** offsetTop of the block within the measured document. */
  top: number;
  /** offsetHeight of the block. */
  height: number;
  /** Headings must not be the last block on a page (mirrors break-after:avoid). */
  type: "heading" | "block";
};

// Returns the y-offset (within the measured document) where each printed page
// begins. Page 0 starts at the first block's top; a new entry is appended every
// time content spills past a page's printable band. Breaks only ever fall
// between blocks, so no line is ever cut in half.
export function paginate(blocks: Block[], pageHeight = PRINTABLE_HEIGHT_PX): number[] {
  if (blocks.length === 0) return [0];
  let pageStart = blocks[0]!.top;
  let pageHasBody = false; // a page made only of headings must never break
  const starts: number[] = [pageStart];

  const openPage = (i: number) => {
    pageStart = blocks[i]!.top;
    pageHasBody = false;
    starts.push(pageStart);
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const overflows = b.top + b.height - pageStart > pageHeight;
    // A block that doesn't fit moves to a fresh page — unless the current page
    // has no body yet (an oversized block, or one trailing a lone heading, just
    // overflows; breaking would only strand a heading or produce an empty page).
    if (overflows && pageHasBody) {
      openPage(i);
    }
    // Heading-orphan rule: if a heading fits but the following block would not
    // share its page, push the heading down so it stays with its content.
    else if (b.type === "heading" && i + 1 < blocks.length && pageHasBody) {
      const next = blocks[i + 1]!;
      const nextFits = next.top + next.height - pageStart <= pageHeight;
      if (!nextFits) openPage(i);
    }
    if (b.type !== "heading") pageHasBody = true;
  }

  return starts;
}

export function pageCount(starts: number[]): number {
  return Math.max(1, starts.length);
}
