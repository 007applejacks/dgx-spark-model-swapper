/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Palette is driven by CSS variables (RGB triplets) so the whole UI re-themes by swapping
      // vars in index.css — no per-component changes. <alpha-value> keeps all the /opacity classes.
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",       // console backdrop
        panel: "rgb(var(--panel) / <alpha-value>)", // raised panel
        panel2: "rgb(var(--panel2) / <alpha-value>)", // recessed / inset
        line: "rgb(var(--line) / <alpha-value>)",   // hairline borders
        ink: "rgb(var(--ink) / <alpha-value>)",     // primary text
        muted: "rgb(var(--muted) / <alpha-value>)", // secondary text / labels
        signal: "rgb(var(--signal) / <alpha-value>)", // healthy / loaded
        amber: "rgb(var(--amber) / <alpha-value>)", // in-transit / swapping
        coral: "rgb(var(--coral) / <alpha-value>)", // wedged / danger
        cyan: "rgb(var(--cyan) / <alpha-value>)",   // structural highlight / interactive
      },
      fontFamily: {
        display: ['"Space Grotesk Variable"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono Variable"', "ui-monospace", "monospace"],
      },
      boxShadow: {
        bay: "var(--shadow-bay)",
        glow: "var(--shadow-glow)",
      },
      keyframes: {
        pulseStage: {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
        sweep: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(200%)" },
        },
      },
      animation: {
        pulseStage: "pulseStage 1.4s ease-in-out infinite",
        sweep: "sweep 1.6s linear infinite",
      },
    },
  },
  plugins: [],
};
