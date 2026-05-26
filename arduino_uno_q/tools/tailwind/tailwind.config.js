/** Tailwind v3 build config — produces the vendored assets/tailwind.css (offline).
 *  Run from the arduino_uno_q/ folder; see tools/tailwind/build.sh.
 *  Content paths are relative to that folder (the cwd at build time).
 */
module.exports = {
  content: ["assets/index.html", "assets/app.js"],
  // bg-phaseN is applied dynamically from app.js — keep them even if scanning misses them.
  safelist: ["bg-phase0", "bg-phase1", "bg-phase2", "bg-phase3"],
  theme: {
    extend: {
      colors: {
        phase0: "#6e7681",
        phase1: "#1f6f3d",
        phase2: "#9a6700",
        phase3: "#1f6feb",
      },
    },
  },
};
