// Konfiguracja ESLint 9 (flat config) dla Next.js 16 + TypeScript.
// eslint-config-next 16 eksportuje flat config natywnie — nie używamy FlatCompat.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "coverage/**",
      "data/**",
      "backups/**",
      // Skrypty operacyjne to CommonJS uruchamiane bezpośrednio przez Node —
      // `require` jest tam celowy (brak etapu budowania dla CLI).
      "scripts/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // Kod serwerowy używa `any` w miejscach, gdzie typy better-sqlite3 są zbyt wąskie.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Reguła React Compilera: odczyt API przeglądarki (localStorage, DOM) musi
      // odbywać się w efekcie — inaczej SSR i klient dają różny pierwszy render.
      // Zostawiamy jako ostrzeżenie, bo wzorzec jest tu poprawny i zamierzony.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default config;
