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
  // Serif faces for the Garamond / Times resume styles.
  const garamond = [
    [400, "eb-garamond-latin-400-normal.woff2"],
    [500, "eb-garamond-latin-500-normal.woff2"],
    [600, "eb-garamond-latin-600-normal.woff2"],
    [700, "eb-garamond-latin-700-normal.woff2"]
  ] as const;
  const tinos = [
    [400, "tinos-latin-400-normal.woff2"],
    [700, "tinos-latin-700-normal.woff2"]
  ] as const;

  const families: Array<[string, string, ReadonlyArray<readonly [number, string]>]> = [
    ["Inter", "@fontsource/inter", inter],
    ["Plus Jakarta Sans", "@fontsource/plus-jakarta-sans", jakarta],
    ["EB Garamond", "@fontsource/eb-garamond", garamond],
    ["Tinos", "@fontsource/tinos", tinos]
  ];

  const rules: string[] = [];
  for (const [family, pkg, weights] of families) {
    for (const [weight, file] of weights) {
      rules.push(`@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${fontB64(pkg, file)}) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`);
    }
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
.cv-document { width: 100% !important; max-width: none !important; margin: 0 !important; padding: 0 !important; box-shadow: none !important; overflow-wrap: anywhere; }
/* Mirror the preview: wrap long tokens and let flex children shrink so nothing
   spills into the right print margin (keeps the PDF faithful to the on-screen
   paginated preview). */
.cv-document * { min-width: 0; }
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
