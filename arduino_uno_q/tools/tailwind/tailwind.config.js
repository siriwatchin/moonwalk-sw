/** Tailwind v3 build config — produces the vendored assets/tailwind.css (offline).
 *  Run from the arduino_uno_q/ folder; see tools/tailwind/build.sh.
 *  Content paths are relative to that folder (the cwd at build time).
 */
module.exports = {
  content: ["assets/index.html", "assets/app.js"],
  // Classes applied dynamically from app.js — keep them even if scanning misses them.
  safelist: [
    "bg-phase0", "bg-phase1", "bg-phase2", "bg-phase3",
    "bg-[#1f6f3d]", "border-[#1f6f3d]",   // active source-button highlight (reflectMode)
  ],
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
