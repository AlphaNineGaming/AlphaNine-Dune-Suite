"use strict";
const assert = require("node:assert/strict");
const { createRewardNotifier, whisper, publishExpression, chooseMqPod, senderSql } = require("../lib/reward-notifications");
const command = { playerId: "AlphaNine", template: "PlantFiber", qty: 2 };
const recipient = { name: "AlphaNine", funcomId: "AlphaNine#45674", status: "Online" };
const verified = { ok: true, dryRun: false, status: "live-verified" };

async function main() {
  let reads = 0, sends = [];
  const notify = createRewardNotifier({
    query: async sql => { reads++; return sql.startsWith("select row_to_json") ? [recipient] : []; },
    publish: async (target, message) => sends.push({ target, message }), displayName: () => "Plant Fiber"
  });
  for (const result of [{ ok: false }, { ...verified, dryRun: true }, { ...verified, status: "live-published" }, { ...verified, status: "recipe-unlocked" }]) {
    assert.equal((await notify(result, command)).status, "skipped-unverified");
  }
  assert.equal(reads, 0); assert.equal(sends.length, 0);
  assert.equal((await notify(verified, command, false)).status, "disabled");
  assert.equal((await notify(verified, command)).status, "published");
  assert.equal(sends[0].message, "Reward received: 2 x Plant Fiber. Check your inventory.");
  assert.equal((await notify({ ...verified, status: "db-inserted", item: { qty: 1 } }, command)).status, "published");
  assert.match(sends[1].message, /1 x Plant Fiber.*relog/);
  for (const targets of [[], [recipient, recipient], [{ ...recipient, status: "Offline" }]]) {
    const n = createRewardNotifier({ query: async () => targets, publish: async () => assert.fail("must not publish") });
    assert.notEqual((await n(verified, command)).status, "published");
  }
  let attempts = 0;
  const broken = createRewardNotifier({ query: async () => [recipient], publish: async () => { attempts++; throw Error("timeout"); } });
  const original = JSON.stringify(verified);
  assert.equal((await broken(verified, command)).status, "failed");
  assert.equal(attempts, 1); assert.equal(JSON.stringify(verified), original);
  const envelope = whisper(recipient, "Reward received: 2 x Plant Fiber.", "test-message-id");
  assert.equal(envelope.Type, "TextChat");
  assert.equal(typeof envelope.Content, "string");
  const body = JSON.parse(envelope.Content);
  assert.equal(body.m_ChannelType, "ETextChatChannelType::Whispers");
  assert.equal(body.m_SubChannelId, recipient.funcomId);
  assert.equal(body.m_SpoofedUserNameFrom.m_DisplayName, "AlphaNine Rewards");
  assert.ok(body.m_TimeStamp); assert.equal(body.m_Timestamp, undefined);
  assert.deepEqual(body.m_Message.m_LocalizedMessage.m_FormatArgs, []);
  const expression = publishExpression(recipient, "quote '\" $() ` ; message");
  assert.ok(!expression.includes("$()")); assert.ok(expression.includes('<<"text_chat">>'));
  assert.match(senderSql(), /identity conflict/); assert.doesNotMatch(senderSql(), /delete from|update dune/i);
  const pod = { metadata: { namespace: "chosen", name: "chosen-mq-game-0" }, status: { phase: "Running" }, spec: { containers: [{ name: "rabbitmq", image: "rabbitmq" }] } };
  assert.equal(chooseMqPod([pod], "chosen").pod, pod.metadata.name);
  assert.throws(() => chooseMqPod([pod], "other"));
  assert.throws(() => chooseMqPod([pod, pod], "chosen"));
  console.log("PASS: reward gates, offline/ambiguous recipients, publish failures, quantity, protocol, encoding, and battlegroup isolation.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
