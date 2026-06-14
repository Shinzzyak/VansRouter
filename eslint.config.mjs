import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Server-side modules (API routes, open-sse engine, lib) are plain Node ESM
  // with no JSX — enable no-undef there to catch use-before-define /
  // undefined-identifier bugs (ReferenceError at runtime) that
  // eslint-config-next does not flag by default. Scoped away from React/JSX
  // component files where no-undef produces false positives on props/params.
  {
    files: [
      "src/app/api/**/*.js",
      "open-sse/**/*.js",
      "src/lib/**/*.js",
      "src/sse/**/*.js",
    ],
    rules: {
      "no-undef": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
