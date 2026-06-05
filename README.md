# AlphaNine Dune Suite Beta

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/E1W220NMPA)

One local app for Dune: Awakening self-hosted server tools.

This is a beta release. Use it for testing before replacing your separate tools.

## Included

- Server Control dashboard and actions
- Manager page and internal manager backend
- Gear Codex with local icons
- Shared Dune banner and Ko-fi link
- One local URL: `http://127.0.0.1:8810`

## Run

Double-click:

```text
Start AlphaNine Dune Suite.bat
```

Accept the Administrator prompt so the suite can read Hyper-V.

## Requirements

- Windows 10/11 Pro
- Hyper-V enabled
- Official Dune: Awakening self-hosted server installed and configured
- OpenSSH client available in Windows
- Node.js 18 or newer, unless you run it from the Codex-bundled environment on this PC

## Beta Notes

- The Manager backend is started internally by the suite on `127.0.0.1:8812`.
- The suite itself runs on `127.0.0.1:8810`.
- Keep the suite window open while using the tool.
- Run as Administrator for Hyper-V status and VM controls.

## Enable Live Give Item

Admin Tools stays in dry-run mode unless a live transport is configured with environment variables. Start with `.env.example`, and do not commit real secrets.

Dry-run mode:

```text
DUNE_ADMIN_GIVE_ITEM_TRANSPORT=dry-run
DUNE_ADMIN_GIVE_ITEM_TIMEOUT_MS=15000
```

HTTP JSON transport posts a give-item JSON payload to your own backend:

```text
DUNE_ADMIN_GIVE_ITEM_TRANSPORT=http-json
DUNE_ADMIN_GIVE_ITEM_URL=http://127.0.0.1:8080/api/give-item
DUNE_ADMIN_GIVE_ITEM_HEALTH_URL=http://127.0.0.1:8080/health
DUNE_ADMIN_GIVE_ITEM_TOKEN=optional_bearer_token
```

RabbitMQ HTTP transport publishes your configured command envelope through RabbitMQ Management HTTP API:

```text
DUNE_ADMIN_GIVE_ITEM_TRANSPORT=rabbitmq-http
DUNE_ADMIN_RABBITMQ_PUBLISH_URL=http://127.0.0.1:15672/api/exchanges/%2F/amq.default/publish
DUNE_ADMIN_RABBITMQ_HEALTH_URL=http://127.0.0.1:15672/api/overview
DUNE_ADMIN_RABBITMQ_USER=admin_user
DUNE_ADMIN_RABBITMQ_PASSWORD=admin_password
DUNE_ADMIN_RABBITMQ_ROUTING_KEY=your.routing.key
DUNE_ADMIN_GIVE_ITEM_MESSAGE_TEMPLATE={"playerId":"{{playerId}}","template":"{{template}}","qty":{{qty}},"quality":{{quality}},"requestId":"{{requestId}}"}
```

Live grants become available only when the transport is configured and reachable. If anything is missing, the button remains in dry-run mode with a clear message.

### Real http-json Receiver

The Suite sender only posts JSON. To turn that JSON into a real in-game item grant, run the standalone receiver:

```text
npm run receiver:give-item
```

Configure the Suite sender to call it:

```text
DUNE_ADMIN_GIVE_ITEM_TRANSPORT=http-json
DUNE_ADMIN_GIVE_ITEM_URL=http://127.0.0.1:5055/api/give-item
DUNE_ADMIN_GIVE_ITEM_HEALTH_URL=http://127.0.0.1:5055/health
DUNE_ADMIN_GIVE_ITEM_TOKEN=optional_bearer_token
```

Configure the receiver side:

```text
DUNE_RECEIVER_HOST=127.0.0.1
DUNE_RECEIVER_PORT=5055
DUNE_RECEIVER_TOKEN=optional_same_bearer_token
DUNE_RECEIVER_SSH_HOST=192.168.1.11
DUNE_RECEIVER_SSH_USER=dune
DUNE_RECEIVER_SSH_KEY=%LOCALAPPDATA%\DuneAwakeningServer\sshKey
```

The receiver accepts:

```json
{
  "playerId": "FLS_OR_FUNCOM_PLAYER_ID",
  "template": "AluminiumBar",
  "qty": 5,
  "quality": 0,
  "requestId": "optional-id"
}
```

If `playerId` is numeric, the receiver treats it as a Dune account/actor id and resolves it through the Dune Postgres database to the FLS/Funcom id required by live server commands. If the battlegroup cannot be auto-detected, set:

```text
DUNE_RECEIVER_BG_NAMESPACE=your-namespace
DUNE_RECEIVER_BG_NAME=your-battlegroup-name
```

It converts that payload into the Dune server command:

```json
{
  "ServerCommand": "AddItemToInventory",
  "PlayerId": "FLS_OR_FUNCOM_PLAYER_ID",
  "ItemName": "AluminiumBar",
  "Quantity": 5,
  "Durability": 1.0
}
```

Then it publishes the command inside the game RabbitMQ broker with `rabbitmqctl eval`, using the `heartbeats` exchange and `notifications` routing key. The receiver auto-detects the `mq-game` pod over SSH. If auto-detect fails, set:

```text
DUNE_RECEIVER_MQ_NAMESPACE=your-namespace
DUNE_RECEIVER_MQ_POD=your-mq-game-pod
```

Known limit: the live RabbitMQ `AddItemToInventory` command has no item grade/quality field. The receiver rejects `quality > 0` instead of pretending it worked. Grade-sensitive items need a DB-backed grant path.

Test the local Admin Tools endpoints while the suite is running:

```text
npm run test:admin
```

## Notes

This is a real suite build, but still version `0.1.0-beta`. The Manager backend is started internally by the suite so users do not need to open the old Manager app separately.

## Disclaimer

This is an unofficial community tool. It is not affiliated with Funcom, Legendary, or Dune: Awakening.

Dune Awakening names, images, icons, and related game assets belong to their respective rights holders, including Funcom and Legendary where applicable. This fan-made tool is not affiliated with, endorsed by, sponsored by, or approved by Funcom, Legendary, or the official Dune Awakening team. Images and icons are included only to help players identify in-game items. Do not redistribute, sell, or reuse the bundled game artwork outside this tool unless you have permission from the rights holder.
