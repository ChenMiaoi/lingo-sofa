import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/target/**",
      "**/node_modules/**",
      "**/resources/**",
      "**/gen/**",
      ".cache/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
);
