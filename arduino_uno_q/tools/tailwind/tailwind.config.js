/** Tailwind v3 build config — produces the vendored assets/tailwind.css (offline).
 *  Run from the arduino_uno_q/ folder; see tools/tailwind/build.sh.
 *  Content paths are relative to that folder (the cwd at build time).
 *
 *  daisyUI is added as a Tailwind PLUGIN (pure CSS — no React, no runtime JS): it gives us
 *  consistent component classes (btn, select, drawer, badge, stats, divider, ...) without a
 *  framework. The compiled assets/tailwind.css is still vendored offline; only the BUILD step
 *  needs node_modules (one-shot `npm install` in this folder).
 *
 *  Theme strategy: we keep the existing CSS vars (--bg/--text/--border/--chart-*) for the
 *  Chart.js canvas + utility classes like bg-[var(--bg)]; daisyUI runs on its own `data-theme`
 *  attribute (set by the FOUC script + applyTheme()). The two custom themes below mirror the
 *  same palette so daisyUI components match the rest of the UI.
 */
module.exports = {
  content: ["assets/index.html", "assets/app.js"],
  // Tell Tailwind which "dark" trigger to use — daisyUI flips theme via data-theme, but the
  // existing utility classes (bg-[var(--…)]) read CSS vars driven by the `.dark` class. We keep
  // both signals in sync from applyTheme() so neither side flickers.
  darkMode: "class",
  theme: { extend: {} },
  plugins: [require("daisyui")],
  daisyui: {
    logs: false,
    themes: [
      {
        "moonwalk-light": {
          "primary":         "#1f6feb",
          "primary-content": "#ffffff",
          "secondary":       "#57606a",
          "accent":          "#bc4c00",
          "neutral":         "#1f2328",
          "neutral-content": "#ffffff",
          "base-100":        "#ffffff",
          "base-200":        "#f6f8fa",
          "base-300":        "#eaeef2",
          "base-content":    "#1f2328",
          "info":            "#0969da",
          "success":         "#1a7f37",
          "warning":         "#b08800",
          "error":           "#cf222e",
        },
      },
      {
        "moonwalk-dark": {
          "primary":         "#1f6feb",
          "primary-content": "#ffffff",
          "secondary":       "#8b949e",
          "accent":          "#e16f24",
          "neutral":         "#e6edf3",
          "neutral-content": "#0e1116",
          "base-100":        "#0e1116",
          "base-200":        "#161b22",
          "base-300":        "#21262d",
          "base-content":    "#e6edf3",
          "info":            "#218bff",
          "success":         "#2ea043",
          "warning":         "#d18616",
          "error":           "#f85149",
        },
      },
    ],
  },
};
