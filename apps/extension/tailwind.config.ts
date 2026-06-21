import type { Config } from "tailwindcss";
import cvPreset from "../../packages/shared/tailwind-preset";

export default {
  content: ["./index.html", "./popup.html", "./sidepanel.html", "./src/**/*.{ts,tsx}"],
  presets: [cvPreset],
  plugins: []
} satisfies Config;
