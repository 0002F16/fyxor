import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CvDocument, type ResumeDocument } from "@cv-tailor/shared";
import { paginate, pageCount, type Block, PAGE_WIDTH_PX, PAGE_HEIGHT_PX } from "./pagination";

// Faithful A4 preview of the resume. The export (apps/api/src/cvHtml.ts) renders
// the SAME CvDocument with editable={false}, so a read-only render measured at
// print geometry is exactly what the PDF prints — no placeholders, no empty-GPA
// or blank-coursework artifacts that only appear while editing.
//
// We measure one hidden copy to find safe page breaks (between `data-cvblock`
// atomic units), then render each page as a fixed A4 sheet that "windows" a copy
// of the document translated up to its page band — this avoids splitting the
// React tree across sheets.
export function PaginatedPreview({ cv, headline, showSheets, onPageCount }: {
  cv: ResumeDocument;
  headline?: string;
  // When false, only the hidden measurement renders (drives the badge in edit
  // mode); when true, the visible A4 sheets render too.
  showSheets: boolean;
  onPageCount?: (pages: number) => void;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const sheetsRef = useRef<HTMLDivElement>(null);
  const [starts, setStarts] = useState<number[]>([0]);
  // Scale the fixed 794px A4 sheets down to fit a narrower column so the 48px
  // print margins stay symmetric instead of the right margin collapsing.
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    let cancelled = false;
    const measure = () => {
      const root = measureRef.current?.querySelector("article");
      if (!root) return;
      const rootTop = root.getBoundingClientRect().top;
      const blocks: Block[] = Array.from(root.querySelectorAll<HTMLElement>("[data-cvblock]")).map((el) => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top - rootTop, height: rect.height, type: el.dataset.cvblock === "heading" ? "heading" : "block" };
      });
      const next = paginate(blocks);
      if (!cancelled) setStarts((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next));
    };
    measure();
    // Webfonts change line-wrapping after they load; re-measure once ready so the
    // preview matches the embedded-font PDF.
    void document.fonts?.ready?.then(() => { if (!cancelled) measure(); });
    const root = measureRef.current?.querySelector("article");
    const observer = root ? new ResizeObserver(measure) : null;
    if (root && observer) observer.observe(root);
    return () => { cancelled = true; observer?.disconnect(); };
  }, [cv, headline]);

  const pages = pageCount(starts);
  useEffect(() => { onPageCount?.(pages); }, [pages, onPageCount]);

  useLayoutEffect(() => {
    if (!showSheets) return;
    const el = sheetsRef.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / PAGE_WIDTH_PX));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [showSheets]);

  return (
    <>
      <div ref={measureRef} className="cv-measure" aria-hidden>
        <CvDocument cv={cv} editable={false} headline={headline} />
      </div>
      {showSheets && (
        <div className="cv-sheets" ref={sheetsRef}>
          {starts.map((start, index) => (
            // The frame reserves the scaled height; the sheet renders at fixed A4
            // size and is scaled to fit, keeping print margins symmetric.
            <div className="cv-sheet-frame" style={{ height: PAGE_HEIGHT_PX * scale }} key={index}>
              <div className="cv-sheet" style={{ transform: `scale(${scale})`, transformOrigin: "top center" }}>
                <div className="cv-sheet-window">
                  <div style={{ transform: `translateY(${-start}px)` }}>
                    <CvDocument cv={cv} editable={false} headline={headline} />
                  </div>
                </div>
                <span className="cv-sheet-label">Page {index + 1}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
