import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        // Iniettato a compile-time solo nei binari standalone Bun via
        // --define (scripts/build-binaries.mjs, P40 F2). Il codice lo
        // guarda con typeof prima di leggerlo: non è mai undefined a
        // runtime nel bin compilato, e il ramo è comunque protetto nel
        // percorso npm normale.
        __SG_ATTEST_VERSION__: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    ignores: ["node_modules/", "dist/", "coverage/"],
  },
];
