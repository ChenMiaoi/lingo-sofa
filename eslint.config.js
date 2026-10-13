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
      ".cache/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["apps/*/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  tseslint.configs.recommended,
);
