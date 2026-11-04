// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "dashboard/", "node_modules/"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Adapters parse untyped external JSON (Bitrefill, 1Click, devtool); `any` is deliberate there.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
    }
  }
);
