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
        mint: "#ecfdf5",
        emerald: "#059669",
        deep: "#065f46"
      },
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        display: ["Plus Jakarta Sans", "Inter", "sans-serif"]
      },
      boxShadow: {
        soft: "0 1px 2px rgba(15,23,42,.04), 0 12px 30px -15px rgba(15,23,42,.18)"
      }
    }
  },
  plugins: []
};

export default preset;
