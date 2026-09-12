"use strict";

const { randomUUID } = require("crypto");
const SENDER = Object.freeze({ user: "A9A9A90000000001", funcomId: "AlphaNineRewards#0001", name: "AlphaNine Rewards", marker: "alphanine-reward-notifications" });
const literal = value => "'" + String(value).replace(/'/g, "''") + "'";
const b64 = value => Buffer.from(String(value), "utf8").toString("base64");

function text(value, max = 180) {
  const result = String(value || "").replace(/[\x00-\x1f\x7f<>]/g, " ").replace(/\s+/g, " ").trim();
  if (!result || result.length > max) throw new Error("Invalid reward notification text.");
  return result;
}

function recipientSql(playerId) {
  const id = literal(playerId);
  return `select row_to_json(r)::text from (
    select ps.account_id::text as "accountId", ps.character_name as name,
      ac.funcom_id as "funcomId", ps.online_status::text as status
    from dune.player_state ps join dune.accounts ac on ac.id=ps.account_id
    where ps.account_id::text=${id} or ps.player_controller_id::text=${id}
      or ps.player_pawn_id::text=${id} or ps.player_state_id::text=${id}
      or lower(ps.character_name)=lower(${id}) or lower(ac."user")=lower(${id})
      or lower(ac.funcom_id)=lower(${id})
  ) r;`;
}

// Create only a dedicated chat account. Never overwrite a player or seed actors.
function senderSql() {
  return `begin;
    set local lock_timeout='3s'; set local statement_timeout='5s';
    select pg_advisory_xact_lock(19377812, 991);
    do $reward_sender$ begin
      if exists(select 1 from dune.accounts where ("user"=${literal(SENDER.user)} or funcom_id=${literal(SENDER.funcomId)})
        and ("user" is distinct from ${literal(SENDER.user)} or funcom_id is distinct from ${literal(SENDER.funcomId)}
          or platform_id is distinct from ${literal(SENDER.marker)})) then
        raise exception 'Reward notification sender identity conflict';
      end if;
      insert into dune.encrypted_accounts("user",encrypted_funcom_id,takeoverable,platform_id,platform_name)
      select ${literal(SENDER.user)},dune.encrypt_user_data(${literal(SENDER.funcomId)}),false,${literal(SENDER.marker)},${literal(SENDER.name)}
      where not exists(select 1 from dune.accounts where "user"=${literal(SENDER.user)});
    end $reward_sender$;
    commit;`;
}

function whisper(recipient, message, messageId = randomUUID()) {
  const inner = {
    m_Id: messageId, m_ChannelType: "ETextChatChannelType::Whispers",
    m_SubChannelId: text(recipient.funcomId), m_bUseSpoofedUserName: true,
    m_SpoofedUserNameFrom: { m_Id: SENDER.funcomId, m_DisplayName: SENDER.name },
    m_FuncomIdFrom: SENDER.funcomId, m_UserNameTo: text(recipient.name),
    m_Message: { m_UnlocalizedMessage: text(message, 500), m_LocalizedMessage: { m_TableId: "", m_Key: "", m_FormatArgs: [] } },
    m_TimeStamp: new Date().toISOString(), m_OriginLocation: { X: 0, Y: 0, Z: 0 }, m_HasSeenMessage: false
  };
  return { Content: JSON.stringify(inner), Type: "TextChat" };
}

function publishExpression(recipient, message) {
  const payload = whisper(recipient, message);
  // Every variable-length field is base64; never interpolate player text into Erlang.
  return `Body=base64:decode(<<"${b64(JSON.stringify(payload))}">>), Routing=base64:decode(<<"${b64(recipient.funcomId)}">>), Sender=base64:decode(<<"${b64(SENDER.user)}">>), XName=rabbit_misc:r(<<"/">>,exchange,<<"chat.whispers">>), X=rabbit_exchange:lookup_or_die(XName), P={'P_basic',<<"Content">>,undefined,[],undefined,undefined,undefined,undefined,undefined,<<"${randomUUID()}">>,undefined,<<"text_chat">>,Sender,<<"fls_backend">>,undefined}, Content=rabbit_basic:build_content(P,Body), {ok,Msg}=rabbit_basic:message(XName,Routing,Content), Result=rabbit_queue_type:publish_at_most_once(X,Msg), io:format("reward_whisper=~p~n",[Result]).`;
}

function chooseMqPod(items, namespace) {
  const matches = items.filter(p => p.metadata?.namespace === namespace && p.status?.phase === "Running"
    && /mq-game/.test(p.metadata?.name || ""));
  if (matches.length !== 1) throw new Error("A unique running mq-game pod is required in the selected battlegroup.");
  const containers = matches[0].spec?.containers || [];
  const rabbit = containers.filter(c => /rabbit|mq-game/.test(`${c.name} ${c.image}`));
  const container = rabbit.length === 1 ? rabbit[0] : containers.length === 1 ? containers[0] : null;
  if (!container) throw new Error("RabbitMQ container is ambiguous.");
  return { pod: matches[0].metadata.name, container: container.name };
}

function createRewardNotifier({ query, publish, displayName = value => value }) {
  return async function notify(result, command, enabled = true) {
    if (!enabled) return { status: "disabled", message: "Player notification disabled." };
    if (!result?.ok || result.dryRun || !["db-inserted", "live-verified"].includes(result.status)) {
      return { status: "skipped-unverified", message: "No whisper sent: item delivery was not verified." };
    }
    try {
      const identity = result.player?.accountId || result.player?.account_id || command.playerId;
      const recipients = await query(recipientSql(identity));
      if (recipients.length !== 1) throw new Error("Reward recipient is missing or ambiguous.");
      const recipient = recipients[0];
      if (recipient.status !== "Online") return { status: "skipped-offline", message: "No whisper sent: player is offline." };
      text(recipient.funcomId); text(recipient.name);
      const quantity = result.item?.qty ?? command.qty;
      if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("Invalid verified reward quantity.");
      const message = `Reward received: ${quantity} x ${text(displayName(command.template), 200)}. Check your inventory.${result.status === "db-inserted" ? " You may need to relog to see it." : ""}`;
      await query(senderSql());
      await publish(recipient, message);
      return { status: "published", message: "Reward whisper published to the player's chat; on-screen receipt is not confirmed." };
    } catch (error) {
      return { status: "failed", message: "Reward granted, but the player notification failed. Do not repeat the grant.", error: error.message };
    }
  };
}

module.exports = { SENDER, recipientSql, senderSql, whisper, publishExpression, chooseMqPod, createRewardNotifier };
