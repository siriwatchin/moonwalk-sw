/** Tailwind v3 build config — produces the vendored assets/tailwind.css (offline).
 *  Run from the arduino_uno_q/ folder; see tools/tailwind/build.sh.
 *  Content paths are relative to that folder (the cwd at build time).
 */
module.exports = {
  content: ["assets/index.html", "assets/app.js"],
  theme: {
    extend: {},
  },
};
