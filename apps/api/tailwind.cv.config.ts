import type { Config } from "tailwindcss";
import cvPreset from "../../packages/shared/tailwind-preset";

export default {
  content: ["packages/shared/src/CvDocument.tsx"],
  presets: [cvPreset],
  plugins: []
} satisfies Config;
