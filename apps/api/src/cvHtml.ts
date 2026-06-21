import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { CvDocument, type ResumeDocument } from "@cv-tailor/shared";
import type { TailoredCv } from "@cv-tailor/shared";

const require = createRequire(import.meta.url);

function fontB64(pkg: string, file: string): string {
  const path = require.resolve(`${pkg}/files/${file}`);
  return readFileSync(path).toString("base64");
}

function buildFontFaceCSS(): string {
  const inter = [
    [400, "inter-latin-400-normal.woff2"],
    [500, "inter-latin-500-normal.woff2"],
    [600, "inter-latin-600-normal.woff2"]
  ] as const;
  const jakarta = [
    [600, "plus-jakarta-sans-latin-600-normal.woff2"],
    [700, "plus-jakarta-sans-latin-700-normal.woff2"]
  ] as const;

  const rules: string[] = [];
  for (const [weight, file] of inter) {
    rules.push(`@font-face{font-family:'Inter';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${fontB64("@fontsource/inter", file)}) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`);
  }
  for (const [weight, file] of jakarta) {
    rules.push(`@font-face{font-family:'Plus Jakarta Sans';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${fontB64("@fontsource/plus-jakarta-sans", file)}) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`);
  }
  return rules.join("\n");
}

// Resolve the compiled Tailwind CSS at module load time so it's read once.
const twCss = readFileSync(new URL("./cv.css", import.meta.url), "utf8");
const fontFaceCSS = buildFontFaceCSS();

const printCss = `
/* 0.5in margin on every page so multi-page resumes keep consistent top/bottom
   gutters — the margin lives on @page (not element padding) so page 2+ are
   spaced correctly too. */
@page { size: A4; margin: 0.5in; }
html, body { margin: 0; padding: 0; background: #fff; }
* { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box; }
/* The preview classes (max-w-640, padding, shadow) are for the small in-app
   preview; for print the page itself supplies width + margins. */
.cv-document { width: 100% !important; max-width: none !important; margin: 0 !important; padding: 0 !important; box-shadow: none !important; }
/* Keep a heading with the block it introduces, and never split an individual
   experience/education entry or bullet across the page boundary. Sections are
   allowed to flow across pages so a long section fills page 1 before page 2. */
h2 { break-after: avoid; }
.cv-document section { break-inside: auto; }
.break-inside-avoid, li { break-inside: avoid; }
/* Hide all interactive controls that exist only in edit mode */
.cv-control, .cv-page-guide { display: none !important; }
`;

export function renderCvHtml(cv: TailoredCv): string {
  const doc: ResumeDocument = cv;
  const body = renderToStaticMarkup(
    createElement(CvDocument, { cv: doc, editable: false, headline: cv.job?.title })
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>${fontFaceCSS}</style>
<style>${twCss}</style>
<style>${printCss}</style>
</head>
<body>${body}</body>
</html>`;
}
