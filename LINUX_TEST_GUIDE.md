# AlphaNine Dune Suite Linux Test Build

This package runs the Suite as a headless HTTPS web service on Ubuntu or Debian. Node.js 20+ and Python 3 are required.

## Install

```sh
tar -xzf AlphaNine-Dune-Suite-1.0.43-linux-x64.tar.gz
cd alphanine-dune-suite-1.0.43-linux-x64
sudo sh ./linux/install.sh
sudo alphanine-dune-suite-password
```

The local maintenance portal listens only on `http://127.0.0.1:8810`. The authenticated portal listens on `https://0.0.0.0:8811`.

The automatically generated certificate is self-signed. Browsers will show a warning until it is trusted. For a public deployment, set `ALPHANINE_TLS_CERT_PATH` and `ALPHANINE_TLS_KEY_PATH` in `/etc/alphanine-dune-suite/env` and restart the service.

Do not expose port 8810. If remote access is required, permit only TCP 8811 through the firewall after setting the administrator password.

## Operations

```sh
systemctl status alphanine-dune-suite
journalctl -u alphanine-dune-suite -f
sudo systemctl restart alphanine-dune-suite
sudo alphanine-dune-suite-password --username admin
```

Hyper-V controls are unavailable on Linux. Configure the Dune appliance SSH address and key; server, Kubernetes, database, progression, map, market, and receiver operations then use SSH as usual.
