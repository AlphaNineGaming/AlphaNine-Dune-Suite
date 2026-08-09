"use strict";

const MAX_REMOTE_ARGUMENT_LENGTH = 512;
const SAFE_REMOTE_ARGUMENT = /^[A-Za-z0-9_./:=,+%@-]+$/;

class MigrationRemoteArgumentError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MigrationRemoteArgumentError";
    this.code = "migration_remote_argument_unsafe";
    this.details = details;
  }
}

function assertSafeRemoteArgument(value, label = "remote command argument") {
  const text = String(value ?? "");
  if (!text || text.length > MAX_REMOTE_ARGUMENT_LENGTH || !SAFE_REMOTE_ARGUMENT.test(text)) {
    throw new MigrationRemoteArgumentError(`The ${label} is invalid or unbounded because it contains shell syntax, whitespace, or unsupported characters.`, {
      argumentLength: String(text.length),
      label
    });
  }
  return text;
}

function assertSafeRemoteArguments(values, label = "remote command argument") {
  if (!Array.isArray(values) || values.length === 0) throw new MigrationRemoteArgumentError("The remote command argument vector is empty.", { label });
  return values.map((value, index) => assertSafeRemoteArgument(value, `${label} ${index}`));
}

module.exports = {
  MAX_REMOTE_ARGUMENT_LENGTH,
  SAFE_REMOTE_ARGUMENT,
  MigrationRemoteArgumentError,
  assertSafeRemoteArgument,
  assertSafeRemoteArguments
};
