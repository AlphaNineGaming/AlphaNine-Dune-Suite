const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { OperationRegistry, OperationBusyError } = require("../lib/operations");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphanine-operations-"));
const filePath = path.join(root, "operations.json");

try {
  const registry = new OperationRegistry(filePath, { maxHistory: 10 });
  const active = registry.begin("vm:control", "VM start", { category: "server" });
  registry.update(active, "Waiting for VM", "Hyper-V accepted the request.");
  assert.throws(
    () => registry.begin("vm:control", "VM stop"),
    (error) => error instanceof OperationBusyError && error.code === "operation_busy"
  );
  registry.finish(active, "success");

  const completed = registry.snapshot();
  assert.equal(completed.active.length, 0);
  assert.equal(completed.operations[0].status, "success");
  assert.equal(completed.operations[0].stage, "Completed");

  return registry.run("database:backup", "Database Backup", async ({ update }) => {
    update("Writing backup", "Testing failed result persistence.");
    return { ok: false, error: "simulated failure" };
  }).then(() => {
    const failed = registry.snapshot().operations.find((operation) => operation.key === "database:backup");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "simulated failure");

    registry.begin("market-bot:deployment", "Install Market Bot");
    const restarted = new OperationRegistry(filePath, { maxHistory: 10 });
    const interrupted = restarted.snapshot().operations.find((operation) => operation.key === "market-bot:deployment");
    assert.equal(interrupted.status, "interrupted");
    assert.match(interrupted.error, /Verify the target state before retrying/);

    restarted.clearCompleted();
    assert.equal(restarted.snapshot().operations.length, 0);
    console.log("Operation registry reliability test passed.");
  });
} finally {
  process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
}
