import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "**/dist/**",
      "**/.wxt/**",
      "**/.output/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["apps/pi-bridge/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  tseslint.configs.recommended,
);
