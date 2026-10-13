import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const v = (n) => `hsl(var(--${n}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: [path.join(here, "client/index.html"), path.join(here, "client/src/**/*.{ts,tsx}")],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: { sans: ["Open Sans", "ui-sans-serif", "system-ui", "sans-serif"] },
      borderRadius: { lg: ".5rem", md: ".375rem", sm: ".25rem" },
      colors: {
        background: v("background"), foreground: v("foreground"), border: v("border"), input: v("input"), ring: v("ring"),
        card: { DEFAULT: v("card"), foreground: v("card-foreground"), border: v("card-border") },
        muted: { DEFAULT: v("muted"), foreground: v("muted-foreground") },
        primary: { DEFAULT: v("primary"), foreground: v("primary-foreground") },
        accent: { DEFAULT: v("accent"), foreground: v("accent-foreground") },
        destructive: { DEFAULT: v("destructive"), foreground: v("destructive-foreground") },
        brand: { 50: "hsl(210 85% 96%)", 100: "hsl(210 85% 90%)", 500: "hsl(210 85% 45%)", 600: "hsl(210 85% 35%)", 700: "hsl(210 85% 28%)", 900: "hsl(210 60% 12%)" },
      },
    },
  },
  plugins: [],
};
