"use strict";
// Original Canvas reference-point renderer. No meshes or game-space assumptions.
class ReferenceViewport {
  constructor(canvas, onSelection) {
    this.canvas = canvas; this.context = canvas.getContext("2d", { alpha: false });
    this.onSelection = onSelection; this.projected = []; this.frameTimes = []; this.pending = false;
    this.hover = null; this.drag = null;
    this.resize = new ResizeObserver(() => this.requestDraw()); this.resize.observe(canvas);
    canvas.addEventListener("contextmenu", event => event.preventDefault());
    canvas.addEventListener("pointerdown", event => {
      if (!this.state) return;
      canvas.focus(); canvas.setPointerCapture(event.pointerId);
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, pan: event.button !== 0 || event.shiftKey, additive: event.ctrlKey };
    });
    canvas.addEventListener("pointermove", event => {
      if (!this.state) return;
      if (this.drag) {
        const drag = this.drag, dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        drag.moved ||= Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4;
        if (drag.moved) {
          if (drag.pan) this.state.pan(dx, dy, canvas.clientHeight); else this.state.orbit(dx, dy);
          this.requestDraw();
        }
        drag.x = event.clientX; drag.y = event.clientY;
      } else {
        const rect = canvas.getBoundingClientRect();
        this.hover = this.pick(event.clientX - rect.left, event.clientY - rect.top);
        const label = document.getElementById("hover-label"); label.hidden = !this.hover;
        label.textContent = this.hover ? this.state.byKey.get(this.hover).label + " · reference point" : "";
        this.requestDraw();
      }
    });
    canvas.addEventListener("pointerup", event => {
      const drag = this.drag;
      if (drag && !drag.moved && !drag.pan) {
        const rect = canvas.getBoundingClientRect(), key = this.pick(event.clientX - rect.left, event.clientY - rect.top);
        if (key) this.onSelection(key, drag.additive);
      }
      this.drag = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointercancel", () => { this.drag = null; });
    canvas.addEventListener("lostpointercapture", () => { this.drag = null; });
    canvas.addEventListener("wheel", event => { if (this.state) { event.preventDefault(); this.state.zoom(event.deltaY); this.requestDraw(); } }, { passive: false });
    canvas.addEventListener("keydown", event => { if (event.key.toLowerCase() === "f" && this.state) { event.preventDefault(); this.state.focusSelection(this.aspect()); this.requestDraw(); } });
  }
  aspect() { return this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight); }
  setState(state) { this.state = state; this.hover = null; this.projected = []; this.frameTimes = []; state?.focusAll(this.aspect()); document.getElementById("hover-label").hidden = true; this.requestDraw(); }
  requestDraw() { if (!this.pending) { this.pending = true; requestAnimationFrame(() => { this.pending = false; this.draw(); }); } }
  pick(x, y) {
    let key = null, distance = 81, depth = -Infinity;
    for (const point of this.projected) {
      const d = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (d < distance || (d === distance && point.depth > depth)) { key = point.key; distance = d; depth = point.depth; }
    }
    return key;
  }
  draw() {
    const started = performance.now(), canvas = this.canvas, ctx = this.context;
    const width = canvas.clientWidth, height = canvas.clientHeight, ratio = Math.min(2, window.devicePixelRatio || 1);
    if (!width || !height) return;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.fillStyle = "#0c0e0b"; ctx.fillRect(0, 0, width, height);
    this.projected = [];
    if (!this.state) return;
    const state = this.state, { right, up, forward } = state.basis(), target = state.camera.target, factor = height / (2 * state.camera.scale);
    ctx.fillStyle = "#8d876c"; ctx.beginPath();
    for (const row of state.records) {
      if (!row.position) continue;
      const a = row.position[0] - target[0], b = row.position[1] - target[1], c = row.position[2] - target[2];
      const x = width / 2 + (a * right[0] + b * right[1] + c * right[2]) * factor;
      const y = height / 2 - (a * up[0] + b * up[1] + c * up[2]) * factor;
      if (x < -8 || y < -8 || x > width + 8 || y > height + 8) continue;
      this.projected.push({ key: row.key, x, y, depth: a * forward[0] + b * forward[1] + c * forward[2] }); ctx.rect(x - 2, y - 2, 4, 4);
    }
    ctx.fill();
    const occupied = new Set(); let labels = 0;
    const points = [...this.projected].sort((a, b) => Number(state.selected.has(b.key)) - Number(state.selected.has(a.key)));
    ctx.font = '10px "Segoe UI", sans-serif';
    for (const point of points) {
      const selected = state.selected.has(point.key), hovered = point.key === this.hover;
      if (selected || hovered) { ctx.strokeStyle = selected ? "#edca77" : "#e4e6db"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(point.x, point.y, 6, 0, Math.PI * 2); ctx.stroke(); }
      const cell = `${Math.floor(point.x / 105)}:${Math.floor(point.y / 22)}`;
      if (labels < 80 && (selected || hovered || !occupied.has(cell))) {
        const row = state.byKey.get(point.key), text = row.label.length > 45 ? row.label.slice(0, 42) + "…" : row.label;
        const tx = Math.max(3, Math.min(width - ctx.measureText(text).width - 3, point.x + 9));
        ctx.fillStyle = selected ? "#efd494" : "#a39e88"; ctx.fillText(text, tx, Math.max(12, point.y - 7)); occupied.add(cell); labels++;
      }
    }
    ctx.fillStyle = "#88836f"; ctx.font = '10px "Segoe UI", sans-serif'; ctx.fillText(`${this.projected.length} visible points · ${labels} labels · orthographic reference view`, 12, height - 12);
    this.frameTimes.push(performance.now() - started); if (this.frameTimes.length > 200) this.frameTimes.shift();
  }
}
window.ReferenceViewport = ReferenceViewport;
