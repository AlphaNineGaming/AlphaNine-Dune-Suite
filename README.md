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

## Live Give-Item Transport

Admin Tools stays in dry-run mode unless a live transport is configured with environment variables. Do not commit secrets.

Common:

```text
DUNE_ADMIN_GIVE_ITEM_TRANSPORT=dry-run | http-json | rabbitmq-http
DUNE_ADMIN_GIVE_ITEM_TIMEOUT_MS=15000
```

`http-json` posts a give-item JSON payload to your own backend:

```text
DUNE_ADMIN_GIVE_ITEM_TRANSPORT=http-json
DUNE_ADMIN_GIVE_ITEM_URL=http://127.0.0.1:8080/api/give-item
DUNE_ADMIN_GIVE_ITEM_HEALTH_URL=http://127.0.0.1:8080/health
DUNE_ADMIN_GIVE_ITEM_TOKEN=optional_bearer_token
```

`rabbitmq-http` publishes a configured command envelope through RabbitMQ Management HTTP API:

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

## Notes

This is a real suite build, but still version `0.1.0-beta`. The Manager backend is started internally by the suite so users do not need to open the old Manager app separately.

## Disclaimer

This is an unofficial community tool. It is not affiliated with Funcom, Legendary, or Dune: Awakening.

Dune Awakening names, images, icons, and related game assets belong to their respective rights holders, including Funcom and Legendary where applicable. This fan-made tool is not affiliated with, endorsed by, sponsored by, or approved by Funcom, Legendary, or the official Dune Awakening team. Images and icons are included only to help players identify in-game items. Do not redistribute, sell, or reuse the bundled game artwork outside this tool unless you have permission from the rights holder.
