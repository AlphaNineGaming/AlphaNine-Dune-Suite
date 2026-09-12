"use strict";
const element = id => document.getElementById(id);
let hasDocument = false, busy = false, state = null, filtered = [];
const viewport = new ReferenceViewport(element("viewport"), selectPiece);
function buttons() { element("open").disabled = busy; element("fixture").disabled = busy; element("save").disabled = busy || !hasDocument; }
function status(text, error = false) { element("status").textContent = text; element("status").className = error ? "error" : ""; }
function reset() {
  state = null; filtered = []; hasDocument = false; viewport.setState(null);
  element("document").hidden = true; element("empty").hidden = false;
  element("search").value = ""; element("list-mode").value = "all";
}
function selectPiece(key, additive = false) {
  if (!state?.select(key, additive)) return;
  const index = filtered.findIndex(row => row.key === key), list = element("piece-list");
  if (index >= 0 && (index * 52 < list.scrollTop || (index + 1) * 52 > list.scrollTop + list.clientHeight)) list.scrollTop = Math.max(0, index * 52 - list.clientHeight / 2);
  renderList(); inspect(); viewport.requestDraw();
}
function renderList() {
  const list = element("piece-list"), start = Math.max(0, Math.floor(list.scrollTop / 52) - 3);
  const end = Math.min(filtered.length, start + Math.ceil(list.clientHeight / 52) + 7);
  element("list-spacer").style.height = `${filtered.length * 52}px`;
  const items = element("list-items"); items.style.transform = `translateY(${start * 52}px)`; items.replaceChildren();
  for (let i = start; i < end; i++) {
    const row = filtered[i], button = document.createElement("button");
    button.className = "piece" + (state.selected.has(row.key) ? " selected" : "") + (!row.position ? " unresolved" : "");
    button.dataset.key = row.key; button.setAttribute("aria-pressed", String(state.selected.has(row.key)));
    button.title = `${row.label}\n${row.typeLabel}\n${row.position ? "Reference point — not building geometry" : row.reasons.join("; ")}`;
    const title = document.createElement("strong"), detail = document.createElement("span"); title.textContent = row.label; detail.textContent = row.typeLabel; button.append(title, detail);
    button.addEventListener("click", event => selectPiece(row.key, event.ctrlKey)); items.append(button);
  }
  element("list-count").textContent = `${filtered.length} / ${state?.records.length || 0}`;
  element("selection-count").textContent = `${state?.selected.size || 0} selected · Ctrl-click toggles`;
}
function filterList() { if (!state) return; filtered = state.filter(element("search").value, element("list-mode").value); element("piece-list").scrollTop = 0; renderList(); }
function inspect() {
  const content = element("inspector-content"); content.replaceChildren();
  const selection = state ? [...state.selected] : [], row = state?.byKey.get(selection.at(-1));
  element("focus").disabled = !selection.some(key => state.byKey.get(key).position);
  const note = document.createElement("p"); note.textContent = row ? `${selection.length} selected. Showing the last selected record.` : "Select a reference point or list entry."; content.append(note);
  if (!row) return;
  const title = document.createElement("h3"); title.textContent = `${row.label} · source row ${row.index + 1}`; content.append(title);
  const reason = document.createElement("p"); reason.className = "reason"; reason.textContent = row.position ? "Reference point only. Rotation is not interpreted or applied." : "Unresolved: " + row.reasons.join("; "); content.append(reason);
  const values = document.createElement("dl");
  for (const key of ["instance_id", "placeable_id", "building_type", "x", "y", "z", "rotation", "rx", "ry", "rz", "transform", "scale"]) {
    if (!row.fields[key] && !["x", "y", "z"].includes(key)) continue;
    const label = document.createElement("dt"), value = document.createElement("dd"); label.textContent = key + " · original JSON"; value.textContent = row.fields[key]?.raw || "(missing)"; values.append(label, value);
  }
  content.append(values);
}
async function openDocument(operation) {
  busy = true; buttons();
  try {
    const result = await operation(); if (result.canceled) return;
    reset(); if (result.error) { status(result.error, true); return; }
    hasDocument = true; element("empty").hidden = true; element("document").hidden = false;
    for (const key of ["name", "source", "instances", "placeables", "pentashields", "bytes"]) element(key).textContent = String(result[key]);
    state = new ReferenceView.ViewState(result.reference); viewport.setState(state); filterList(); inspect();
    element("viewport-empty").hidden = result.reference.resolved > 0;
    element("marker-count").textContent = `${result.reference.resolved} points · ${result.reference.unresolved} unresolved`;
    element("evidence").textContent = result.reference.evidence ? `${result.reference.evidence.label}. Synthetic test data only.` : "No verified coordinate convention. No pieces have been placed at guessed positions.";
    element("fit").disabled = !result.reference.resolved;
    status("Opened locally. Camera and selection are separate from the preserved source document.");
  } catch (error) { reset(); status(error.message, true); } finally { busy = false; buttons(); }
}
element("open").addEventListener("click", () => openDocument(() => window.blueprintDocuments.open()));
element("fixture").addEventListener("click", () => openDocument(() => window.blueprintDocuments.openReferenceFixture()));
element("search").addEventListener("input", filterList); element("list-mode").addEventListener("change", filterList);
element("piece-list").addEventListener("scroll", renderList);
new ResizeObserver(() => { if (state) renderList(); }).observe(element("piece-list"));
element("focus").addEventListener("click", () => { state?.focusSelection(viewport.aspect()); viewport.requestDraw(); });
element("fit").addEventListener("click", () => { state?.focusAll(viewport.aspect()); viewport.requestDraw(); });
element("save").addEventListener("click", async () => {
  busy = true; buttons();
  try {
    const result = await window.blueprintDocuments.saveCopy(); if (result.canceled) return;
    if (result.error) { status(result.error, true); return; }
    status(`Copy saved: ${result.destination}\n${result.bytes} bytes preserved. Original untouched.${result.cleanupWarning ? "\n" + result.cleanupWarning : ""}`, Boolean(result.cleanupWarning));
  } catch (error) { status(error.message, true); } finally { busy = false; buttons(); }
});
