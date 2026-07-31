"use strict";

const fs = require("fs");
const path = require("path");

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

class StorageDepositStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxHistory = Math.max(10, Number(options.maxHistory) || 100);
    this.receipts = [];
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const rows = Array.isArray(parsed) ? parsed : parsed?.receipts;
      if (Array.isArray(rows)) this.receipts = rows.filter((row) => row && row.receiptId).slice(0, this.maxHistory);
    } catch {
      this.receipts = [];
    }
  }

  save() {
    atomicWriteJson(this.filePath, { version: 1, receipts: this.receipts.slice(0, this.maxHistory) });
  }

  add(receipt) {
    if (!receipt?.receiptId) throw new Error("Storage deposit receipt ID is required.");
    this.receipts = [receipt, ...this.receipts.filter((row) => row.receiptId !== receipt.receiptId)].slice(0, this.maxHistory);
    this.save();
    return receipt;
  }

  get(receiptId) {
    const id = String(receiptId || "").trim();
    return this.receipts.find((row) => row.receiptId === id) || null;
  }

  update(receiptId, patch = {}) {
    const current = this.get(receiptId);
    if (!current) return null;
    Object.assign(current, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return current;
  }

  list(limit = 20) {
    return this.receipts.slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
  }
}

function classifyStorageVerification(expected, observed) {
  const expectedStacks = Math.max(0, Number(expected?.stackCount) || 0);
  const expectedQuantity = Math.max(0, Number(expected?.quantity) || 0);
  const foundStacks = Math.max(0, Number(observed?.foundStacks) || 0);
  const matchingStacks = Math.max(0, Number(observed?.matchingStacks) || 0);
  const foundQuantity = Math.max(0, Number(observed?.foundQuantity) || 0);
  const duplicateSlots = Math.max(0, Number(observed?.duplicateSlots) || 0);
  const invalidPositions = Math.max(0, Number(observed?.invalidPositions) || 0);

  if (foundStacks < expectedStacks) {
    return { status: "runtime-overwrite", ok: false, message: "One or more deposited item rows disappeared after the verified write. The running game may have overwritten cached storage state." };
  }
  if (matchingStacks !== expectedStacks || foundQuantity !== expectedQuantity || duplicateSlots || invalidPositions) {
    return { status: "integrity-warning", ok: false, message: "The deposited rows exist, but the storage inventory failed slot, identity, or quantity integrity checks." };
  }
  return { status: "database-verified", ok: true, message: "The deposited rows remain correct in the database. In-game visibility still requires reopening the container or operator confirmation." };
}

module.exports = { StorageDepositStore, classifyStorageVerification };
