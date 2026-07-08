# AlphaNine Dune Suite 1.0.8

AlphaNine Dune Suite 1.0.8 fixes Market Bot token setup for fresh installs and changes the default sound preference.

## Fixed

- Suite can now provision the Market Bot API token if the deployed bot secret is missing or blank.
- Suite writes the token into `market-bot-secret` on the VM, restarts the `market-bot` deployment, and saves the same token locally.
- Suite retries authenticated Market Bot requests when the saved token is stale or unauthorized.
- Runtime/environment Market Bot tokens are now persisted into Suite config so future launches do not lose them.

## Changed

- UI sounds are now off by default for fresh configs.
- Existing users keep their saved sound preference.

## Notes

- The token is never shown in the UI or release logs.
- Users should no longer need to manually enter the Market Bot API token when Suite has SSH access to the server VM.
