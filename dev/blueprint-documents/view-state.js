"use strict";
// Shared pure viewport state. Never contains a BlueprintDocument or save API.
(function(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReferenceView = api;
})(typeof globalThis === "object" ? globalThis : this, function() {
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const scale = (v, s) => v.map(x => x * s);
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const sub = (a, b) => add(a, scale(b, -1));
  function bounds(points) {
    if (!points.length) return null;
    const low = [...points[0]], high = [...points[0]];
    for (const point of points) for (let i = 0; i < 3; i++) { low[i] = Math.min(low[i], point[i]); high[i] = Math.max(high[i], point[i]); }
    return { center: low.map((v, i) => (v + high[i]) / 2), radius: Math.max(1, Math.hypot(...sub(high, low)) / 2) };
  }
  class ViewState {
    constructor(snapshot) {
      this.records = snapshot.records;
      this.byKey = new Map(this.records.map(row => [row.key, row]));
      this.selected = new Set();
      this.searchIndex = new Map(this.records.map(row => [row.key, `${row.label} ${row.typeLabel} ${row.key} ${row.reasons.join(" ")}`.toLowerCase()]));
      this.camera = { target: [0, 0, 0], yaw: .65, pitch: .42, scale: 100 };
      this.focusAll();
    }
    select(key, additive = false) {
      if (!this.byKey.has(key)) return false;
      if (!additive) this.selected.clear();
      if (additive && this.selected.has(key)) this.selected.delete(key);
      else this.selected.add(key);
      return true;
    }
    filter(query, mode = "all") {
      const text = String(query).trim().toLowerCase();
      return this.records.filter(row => (!text || this.searchIndex.get(row.key).includes(text)) && (mode === "all" || (mode === "unresolved" ? !row.position : Boolean(row.position))));
    }
    basis() {
      const { yaw, pitch } = this.camera;
      return { right: [Math.cos(yaw), 0, -Math.sin(yaw)],
        up: [-Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), -Math.cos(yaw) * Math.sin(pitch)],
        forward: [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)] };
    }
    orbit(dx, dy) {
      this.camera.yaw = (this.camera.yaw + dx * .006) % (Math.PI * 2);
      this.camera.pitch = Math.max(-1.52, Math.min(1.52, this.camera.pitch + dy * .006));
    }
    pan(dx, dy, height) {
      const basis = this.basis(), factor = this.camera.scale * 2 / Math.max(1, height);
      this.camera.target = add(this.camera.target, add(scale(basis.right, -dx * factor), scale(basis.up, dy * factor)));
    }
    zoom(delta) { this.camera.scale = Math.max(.01, Math.min(1e10, this.camera.scale * Math.exp(Math.max(-2, Math.min(2, delta * .001))))); }
    fit(points, aspect = 1) { const box = bounds(points); if (!box) return false; this.camera.target = box.center; this.camera.scale = box.radius * 1.45 / Math.max(.01, Math.min(1, aspect)); return true; }
    focusAll(aspect = 1) { return this.fit(this.records.filter(row => row.position).map(row => row.position), aspect); }
    focusSelection(aspect = 1) { return this.fit([...this.selected].map(key => this.byKey.get(key)).filter(row => row?.position).map(row => row.position), aspect); }
    project(position, width, height) {
      const basis = this.basis(), relative = sub(position, this.camera.target), factor = height / (2 * this.camera.scale);
      return { x: width / 2 + dot(relative, basis.right) * factor, y: height / 2 - dot(relative, basis.up) * factor, depth: dot(relative, basis.forward) };
    }
  }
  return { ViewState, bounds };
});
