"use strict";

function exactCoordinate(token) {
  if (!token || token.type !== "number") return { reason: "Missing or non-numeric position value" };
  const number = Number(token.raw);
  if (!Number.isFinite(number) || Math.abs(number) > 1e8) return { reason: "Position outside viewer numeric range (not a game limit)" };
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token.raw);
  if (!match) return { reason: "Unsupported position token" };
  const exponent = Number(match[4] || 0) - (match[3]?.length || 0);
  if (Math.abs(exponent) > 100 || match[2].length + (match[3]?.length || 0) > 150) return { reason: "Position precision exceeds viewer conversion support" };
  let numerator = BigInt((match[1] || "") + match[2] + (match[3] || ""));
  let denominator = 1n;
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else denominator = 10n ** BigInt(-exponent);
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(number);
  const bits = buffer.readBigUInt64BE();
  const e = Number((bits >> 52n) & 2047n);
  let binaryNumerator = (bits & ((1n << 52n) - 1n)) + (e ? 1n << 52n : 0n);
  if (bits >> 63n) binaryNumerator = -binaryNumerator;
  let binaryDenominator = 1n;
  const power = e ? e - 1023 - 52 : -1074;
  if (power >= 0) binaryNumerator <<= BigInt(power);
  else binaryDenominator <<= BigInt(-power);
  if (numerator * binaryDenominator !== binaryNumerator * denominator) return { reason: "Position would lose numeric precision in the viewport" };
  return { value: number };
}

function createReferenceSnapshot(document, evidence = null) {
  const records = document.referenceRecords().map(record => {
    const id = record.fields[record.group === "instances" ? "instance_id" : "placeable_id"];
    const type = record.fields.building_type;
    const reasons = [];
    if (!evidence) reasons.push("Position convention has not been verified for this file");
    else if (!evidence.groups.includes(record.group)) reasons.push("No verified position mapping for this record family");
    if (record.fields.transform) reasons.push("Alternate transform representation has not been verified");
    for (const field of ["rotation", "rx", "ry", "rz"]) {
      if (record.fields[field] && record.fields[field].type !== "number") reasons.push(`Malformed ${field}; no transform inferred`);
    }
    const coordinates = (evidence?.positionKeys || ["x", "y", "z"]).map(key => {
      const result = exactCoordinate(record.fields[key]);
      if (result.reason) reasons.push(`${key}: ${result.reason}`);
      return result.value;
    });
    const position = reasons.length ? null : evidence.matrix.map(row => row.reduce((sum, weight, index) => sum + weight * coordinates[index], 0));
    return Object.freeze({ ...record,
      label: `${record.group} #${id?.raw || "(missing identifier)"}`,
      typeLabel: type?.text || type?.raw || "(building type missing)",
      position: position && Object.freeze(position), reasons: Object.freeze(reasons),
      referenceOnly: true
    });
  });
  return Object.freeze({ records: Object.freeze(records), evidence: evidence ? Object.freeze({ label: evidence.label, source: evidence.source, synthetic: evidence.synthetic }) : null,
    resolved: records.filter(record => record.position).length, unresolved: records.filter(record => !record.position).length });
}
module.exports = { createReferenceSnapshot, exactCoordinate };
