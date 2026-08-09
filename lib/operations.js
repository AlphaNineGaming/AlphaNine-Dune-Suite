const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class OperationBusyError extends Error {
  constructor(operation) {
    super(`${operation.title} is already running.`);
    this.name = "OperationBusyError";
    this.code = "operation_busy";
    this.operation = operation;
  }
}

function operationConflictClass(key) {
  const value = String(key || "").trim().toLowerCase();
  if (value === "maintenance:mode" || value === "maintenance:bootstrap") return "maintenance-control";
  if (value === "migration:export" || value === "migration:import" || value === "migration:empty-market") return "migration";
  if (value.startsWith("database:backup") || value === "scheduler:backup") return "database-backup";
  if (value.startsWith("database:import")) return "database-import";
  if (value.startsWith("battlegroup:update")) return "server-update";
  if (/^(?:maintenance:|database:maintenance|repair:|cleanup:|storage:deposit:|market-bot:|progression:|landsraad:)/.test(value)) return "destructive-maintenance";
  if (/^(?:battlegroup:control|map:|vm:control|scheduler:restart)/.test(value)) return "server-control";
  return "other";
}

function operationsConflict(leftKey, rightKey) {
  const left = String(leftKey || "").trim();
  const right = String(rightKey || "").trim();
  if (!left || !right) return false;
  if (left === right) return true;
  const leftClass = operationConflictClass(left);
  const rightClass = operationConflictClass(right);
  if (leftClass === "maintenance-control" || rightClass === "maintenance-control") {
    const other = leftClass === "maintenance-control" ? rightClass : leftClass;
    return other !== "other";
  }
  if (leftClass === "migration" || rightClass === "migration") return leftClass !== "other" && rightClass !== "other";
  const databaseCritical = new Set(["database-backup", "database-import", "server-update", "destructive-maintenance"]);
  return databaseCritical.has(leftClass) && databaseCritical.has(rightClass);
}

class OperationRegistry {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxHistory = Number(options.maxHistory || 100);
    this.operations = [];
    this.activeByKey = new Map();
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.operations = Array.isArray(parsed.operations) ? parsed.operations.slice(0, this.maxHistory) : [];
    } catch {
      this.operations = [];
    }
    const interruptedAt = new Date().toISOString();
    let changed = false;
    for (const operation of this.operations) {
      if (operation.status === "pending" || operation.status === "running") {
        operation.status = "interrupted";
        operation.stage = "Interrupted by Suite restart";
        operation.error = "The Suite closed or restarted before this operation reported completion. Verify the target state before retrying.";
        operation.finishedAt = interruptedAt;
        operation.updatedAt = interruptedAt;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ version: 1, operations: this.operations.slice(0, this.maxHistory) }, null, 2), "utf8");
    try {
      fs.renameSync(tempPath, this.filePath);
    } catch {
      if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
      fs.renameSync(tempPath, this.filePath);
    }
  }

  public(operation) {
    if (!operation) return null;
    return {
      id: operation.id,
      key: operation.key,
      title: operation.title,
      category: operation.category,
      conflictClass: operation.conflictClass || operationConflictClass(operation.key),
      status: operation.status,
      stage: operation.stage,
      detail: operation.detail,
      startedAt: operation.startedAt,
      updatedAt: operation.updatedAt,
      finishedAt: operation.finishedAt,
      durationMs: operation.durationMs,
      error: operation.error,
      diagnostics: operation.diagnostics && typeof operation.diagnostics === "object" ? { ...operation.diagnostics } : null,
      progress: Number.isFinite(Number(operation.progress)) ? Number(operation.progress) : null,
      logTail: Array.isArray(operation.logTail) ? operation.logTail.slice(-80) : []
    };
  }

  begin(key, title, details = {}) {
    const normalizedKey = String(key || "").trim();
    const active = [...this.activeByKey.values()].find((operation) => operationsConflict(normalizedKey, operation.key));
    if (active) throw new OperationBusyError(this.public(active));
    const now = new Date().toISOString();
    const operation = {
      id: `op-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      key: normalizedKey,
      title: String(title || key || "Operation"),
      category: String(details.category || "system"),
      conflictClass: operationConflictClass(normalizedKey),
      status: "running",
      stage: String(details.stage || "Started"),
      detail: String(details.detail || ""),
      startedAt: now,
      updatedAt: now,
      finishedAt: "",
      durationMs: 0,
      error: "",
      diagnostics: details.diagnostics && typeof details.diagnostics === "object" ? { ...details.diagnostics } : null,
      progress: Number.isFinite(Number(details.progress)) ? Number(details.progress) : null,
      logTail: []
    };
    this.operations.unshift(operation);
    this.operations = this.operations.slice(0, this.maxHistory);
    this.activeByKey.set(normalizedKey, operation);
    this.persist();
    return operation;
  }

  update(operation, stage, detail = "", extra = {}) {
    if (!operation || operation.status !== "running") return;
    operation.stage = String(stage || operation.stage || "Running");
    operation.detail = String(detail || operation.detail || "");
    if (Number.isFinite(Number(extra.progress))) operation.progress = Math.max(0, Math.min(100, Number(extra.progress)));
    if (extra.diagnostics && typeof extra.diagnostics === "object") operation.diagnostics = { ...extra.diagnostics };
    if (extra.logLine) {
      operation.logTail = [...(Array.isArray(operation.logTail) ? operation.logTail : []), String(extra.logLine)].slice(-80);
    }
    operation.updatedAt = new Date().toISOString();
    this.persist();
  }

  finish(operation, status, error = "", details = {}) {
    if (!operation) return;
    const finished = new Date();
    operation.status = status;
    operation.stage = status === "success" ? "Completed" : String(details.stage || "Failed");
    operation.error = String(error || "");
    if (details.diagnostics && typeof details.diagnostics === "object") operation.diagnostics = { ...details.diagnostics };
    operation.finishedAt = finished.toISOString();
    operation.updatedAt = operation.finishedAt;
    operation.durationMs = Math.max(0, finished.getTime() - new Date(operation.startedAt).getTime());
    if (status === "success") operation.progress = 100;
    this.activeByKey.delete(operation.key);
    this.persist();
  }

  async run(key, title, task, details = {}) {
    const operation = this.begin(key, title, details);
    const update = (stage, detail) => this.update(operation, stage, detail);
    try {
      const result = await task({ operation: this.public(operation), update });
      if (result && result.ok === false) {
        const message = result.error || result.message || `${title} failed.`;
        this.finish(operation, "failed", message);
      } else {
        this.finish(operation, "success");
      }
      return { result, operation: this.public(operation) };
    } catch (error) {
      this.finish(operation, "failed", error.message);
      error.operation = this.public(operation);
      throw error;
    }
  }

  snapshot(extraOperations = []) {
    const extras = Array.isArray(extraOperations) ? extraOperations : [];
    const operations = [...extras, ...this.operations.map((operation) => this.public(operation))]
      .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
      .slice(0, this.maxHistory);
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      active: operations.filter((operation) => operation.status === "pending" || operation.status === "running"),
      operations
    };
  }

  clearCompleted() {
    this.operations = this.operations.filter((operation) => operation.status === "pending" || operation.status === "running");
    this.persist();
    return this.snapshot();
  }
}

module.exports = { OperationRegistry, OperationBusyError, operationConflictClass, operationsConflict };
