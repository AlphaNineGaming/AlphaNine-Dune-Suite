#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root: sudo ./linux/install.sh" >&2
  exit 1
fi

command -v node >/dev/null 2>&1 || { echo "Node.js 20 or newer is required." >&2; exit 1; }
NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js 20 or newer is required." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "Python 3 is required for the embedded manager." >&2; exit 1; }

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALL_DIR=/opt/alphanine-dune-suite
DATA_DIR=/var/lib/alphanine-dune-suite
CONFIG_DIR=/etc/alphanine-dune-suite

getent group alphanine-suite >/dev/null 2>&1 || groupadd --system alphanine-suite
id alphanine-suite >/dev/null 2>&1 || useradd --system --gid alphanine-suite --home-dir "$DATA_DIR" --shell /usr/sbin/nologin alphanine-suite

mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$DATA_DIR/manager" "$CONFIG_DIR"
find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -a "$SOURCE_DIR"/. "$INSTALL_DIR"/
cp "$INSTALL_DIR/linux/alphanine-dune-suite.service" /etc/systemd/system/alphanine-dune-suite.service
[ -f "$CONFIG_DIR/env" ] || cp "$INSTALL_DIR/linux/env.example" "$CONFIG_DIR/env"
chown -R root:alphanine-suite "$INSTALL_DIR" "$CONFIG_DIR"
chown -R alphanine-suite:alphanine-suite "$DATA_DIR"
chmod 0750 "$INSTALL_DIR" "$DATA_DIR" "$CONFIG_DIR"
chmod 0640 "$CONFIG_DIR/env"

cat > /usr/local/bin/alphanine-dune-suite-password <<'EOF'
#!/usr/bin/env sh
exec runuser -u alphanine-suite -- env ALPHANINE_DATA_DIR=/var/lib/alphanine-dune-suite node /opt/alphanine-dune-suite/scripts/set-remote-password.js "$@"
EOF
chmod 0755 /usr/local/bin/alphanine-dune-suite-password

systemctl daemon-reload
systemctl enable --now alphanine-dune-suite.service

echo "AlphaNine Dune Suite installed."
echo "Set the remote login: sudo alphanine-dune-suite-password"
echo "Status: systemctl status alphanine-dune-suite"
echo "Logs: journalctl -u alphanine-dune-suite -f"
