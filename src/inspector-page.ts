import { subscribeInspector } from "./inspector";

// Dev-only inspector window script: renders the latest frame-aligned snapshot
// published by the rig (see inspector.ts for the transport).

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};

let staleTimer = 0;
const stale = $("stale");
stale.hidden = false;

subscribeInspector((s) => {
  $("frame").textContent = String(s.frame);
  $("t").textContent = `${s.t.toFixed(3)}s`;
  $("fps").textContent = String(s.fps);
  $("viewports").textContent = s.viewports.map((v) => v.label).join(" · ");
  stale.hidden = true;
  window.clearTimeout(staleTimer);
  staleTimer = window.setTimeout(() => {
    stale.hidden = false;
  }, 1500);
});
