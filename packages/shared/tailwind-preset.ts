import type { Config } from "tailwindcss";

const preset: Config = {
  content: [],
  theme: {
    extend: {
      colors: {
        ink: "#0f172a",
        muted: "#4b5563",
        line: "#e6e8ec",
        paper: "#ffffff",
        soft: "#f8fafc",
        // The three customizable tokens resolve to per-resume CSS variables set by
        // resumeStyleVars(). They're stored as space-separated RGB channels and
        // composed with <alpha-value> so Tailwind opacity modifiers (bg-mint/40,
        // ring-emerald/15, …) keep working; the literals are fallbacks for
        // anything rendered outside a styled resume root.
        mint: "rgb(var(--cv-highlight-rgb, 236 253 245) / <alpha-value>)",
        emerald: "rgb(var(--cv-accent-rgb, 5 150 105) / <alpha-value>)",
        deep: "rgb(var(--cv-accent-deep-rgb, 6 101 70) / <alpha-value>)"
      },
      fontFamily: {
        sans: ["var(--cv-font-body, Inter)", "sans-serif"],
        display: ["var(--cv-font-display, 'Plus Jakarta Sans')", "Inter", "sans-serif"]
      },
      boxShadow: {
        soft: "0 1px 2px rgba(15,23,42,.04), 0 12px 30px -15px rgba(15,23,42,.18)"
      }
    }
  },
  plugins: []
};

export default preset;
