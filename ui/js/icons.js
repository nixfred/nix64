// A small icon set, drawn for Nix64 (stroke icons on a 16 grid). No emoji and no icon font: they look the
// same on every computer and follow the text colour.
const P = {
  power: "M8 1.8v5.4 M4.5 4a5.5 5.5 0 1 0 7 0",
  reset: "M3 8a5 5 0 1 0 1.7-3.8 M3 2.2v3.2h3.2",
  cycle: "M13 8a5 5 0 0 1-8.8 3.2 M3 8a5 5 0 0 1 8.8-3.2 M12.2 1.8v3h-3 M3.8 14.2v-3h3",
  warp: "M2 3.2l5.5 4.8L2 12.8z M8.5 3.2L14 8l-5.5 4.8z",
  joystick: "M8 1.8a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8 M8 5.6v4 M3.5 14.2h9 M4.5 9.6h7l1 4.6h-9z",
  camera: "M1.8 4.8h3l1.2-2h4l1.2 2h3v8.4H1.8z M8 9m-2.3 0a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0-4.6 0",
  record: "M8 8m-4.2 0a4.2 4.2 0 1 0 8.4 0a4.2 4.2 0 1 0-8.4 0",
  stop: "M4 4h8v8H4z",
  fullscreen: "M2 5.8V2h3.8 M10.2 2H14v3.8 M14 10.2V14h-3.8 M5.8 14H2v-3.8",
  bell: "M3.8 11V7.2a4.2 4.2 0 0 1 8.4 0V11l1.2 1.6H2.6z M6.6 14.4a1.5 1.5 0 0 0 2.8 0",
  "bell-off": "M3.8 11V7.2a4.2 4.2 0 0 1 8.4 0V11l1.2 1.6H2.6z M6.6 14.4a1.5 1.5 0 0 0 2.8 0 M2 2l12 12",
  volume: "M1.8 6h2.8L8.6 2.6v10.8L4.6 10H1.8z M11.2 5.4a3.6 3.6 0 0 1 0 5.2",
  "volume-off": "M1.8 6h2.8L8.6 2.6v10.8L4.6 10H1.8z M11 6l3.2 4 M14.2 6L11 10",
  gear: "M8 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2 M8 1v2 M8 13v2 M1 8h2 M13 8h2 M3 3l1.4 1.4 M11.6 11.6L13 13 M3 13l1.4-1.4 M11.6 4.4L13 3",
  help: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M6 6.2a2 2 0 1 1 3 1.7c-.7.5-1 1-1 1.6 M8 11.8v.1",
  hub: "M2 2h5v5H2z M9 2h5v5H9z M2 9h5v5H2z M9 9h5v5H9z",
  plus: "M8 3v10 M3 8h10",
  disk: "M2 2h10l2 2v10H2z M5 2v4h6V2 M5 14V9h6v5",
  tape: "M1.8 3.8h12.4v8.4H1.8z M5 8m-1.3 0a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0 M11 8m-1.3 0a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0 M5 10.8h6",
  cart: "M3 2.5h10v11H3z M5.2 2.5v3.2h5.6V2.5 M6 9h4 M6 11.2h4",
  play: "M4 2.5l9 5.5-9 5.5z",
  file: "M3 1.5h6.5l3.5 3.5v9.5H3z M9.5 1.5V5H13",
  snow: "M8 1v14 M1.9 4.5l12.2 7 M14.1 4.5l-12.2 7",
  plug: "M5.8 1.8v3.6 M10.2 1.8v3.6 M3.8 5.4h8.4v3a4.2 4.2 0 0 1-8.4 0z M8 12.6v2",
  list: "M3 4h10 M3 8h10 M3 12h10",
  eject: "M8 2.2l6 7H2z M2 12.4h12",
  edit: "M2 14l.9-3.6 8.6-8.6 2.7 2.7-8.6 8.6z M9.6 3.8l2.7 2.7",
  upload: "M8 10.6V2 M4.6 5.4L8 2l3.4 3.4 M2 10v4h12v-4",
  search: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10 M10.8 10.8l3.6 3.6",
  x: "M3 3l10 10 M13 3L3 13",
  spark: "M8 1.2l1.6 4.6 4.6 1.6-4.6 1.6L8 13.6 6.4 9 1.8 7.4l4.6-1.6z",
  back: "M10 3L5 8l5 5",
  down: "M3 6l5 5 5-5",
  check: "M2.5 8.5l3.8 3.8L13.5 4",
  "keys-joy": "M2 3h12v10H2z M4.5 6h1.8 M7.1 6h1.8 M9.7 6h1.8 M4.5 9h7",
};
const FILLED = new Set(["record", "play"]);

/** inline SVG for `name`; sized in em so it scales with the interface */
export function icon(name, size = 1.05) {
  const d = P[name] ?? P.file;
  return `<svg class="ic" viewBox="0 0 16 16" width="${size}em" height="${size}em" fill="${FILLED.has(name) ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}
