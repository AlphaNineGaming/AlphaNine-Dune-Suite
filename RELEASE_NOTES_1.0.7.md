# AlphaNine Dune Suite 1.0.7

AlphaNine Dune Suite 1.0.7 is a Market Bot setup hotfix.

## Fixed

- Fresh Suite installs can now automatically adopt the Market Bot API token from the deployed Kubernetes secret.
- Market Bot connection save no longer leaves users stuck with health working but authenticated config/status actions failing.
- Suite keeps the token hidden and stores it locally after discovery.

## Notes

- Users still do not need to manage the token manually after setup.
- If the server-side bot token changes, Suite will use the saved token until the config is refreshed or replaced.
- The Sietch Rename tool from 1.0.6 remains included.
