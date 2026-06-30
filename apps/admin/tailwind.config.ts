import type { Config } from "tailwindcss";
import cvPreset from "../../packages/shared/tailwind-preset";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  presets: [cvPreset],
  plugins: []
} satisfies Config;
