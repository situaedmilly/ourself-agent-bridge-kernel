#!/usr/bin/env bash
set -Eeuo pipefail

# Safe, idempotent host preparation only. Does not install trust keys,
# enroll devices, publish ingress, or start the broker.
ROOT="${OURSELF_REPO_ROOT:-/opt/ourself/ourself-agent-bridge-kernel}"
SERVICE_USER="ourtunnelself"
CONFIG_DIR="/etc/ourtunnelself"
STATE_DIR="/var/lib/ourtunnelself"
SYSTEMD_UNIT="/etc/systemd/system/ourtunnelself.service"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf 'OURTUNNELSELF-PREPARE: %s\n' "$*"; }

[[ "$(id -u)" -eq 0 ]] || fail "Run as root: sudo OURSELF_REPO_ROOT=/opt/ourself/ourself-agent-bridge-kernel $0"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required for this deployment profile."
command -v node >/dev/null 2>&1 || fail "Install Node.js 22+ before preparing the service."
node -e 'const [major] = process.versions.node.split(".").map(Number); if (major < 22) process.exit(1)' || fail "Node.js 22+ required; found $(node --version)."
[[ -f "$ROOT/runtime/ourtunnelself/broker.js" ]] || fail "Broker source not found under $ROOT."
[[ -f "$ROOT/deploy/ourtunnelself/ourtunnelself.service" ]] || fail "systemd unit template missing."

if ! getent group "$SERVICE_USER" >/dev/null; then
  groupadd --system "$SERVICE_USER"
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_USER" --home-dir /var/lib/ourtunnelself --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -o root -g "$SERVICE_USER" -m 0750 "$CONFIG_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$STATE_DIR"

if [[ ! -e "$CONFIG_DIR/ourtunnelself.env" ]]; then
  install -o root -g root -m 0600 "$ROOT/deploy/ourtunnelself/ourtunnelself.env.example" "$CONFIG_DIR/ourtunnelself.env"
  note "Created $CONFIG_DIR/ourtunnelself.env from the example; issuer placeholders must be replaced."
else
  note "Preserved existing $CONFIG_DIR/ourtunnelself.env."
fi

if [[ ! -e "$CONFIG_DIR/devices.json" ]]; then
  install -o root -g "$SERVICE_USER" -m 0640 /dev/null "$CONFIG_DIR/devices.json"
  printf '{"devices":[]}\n' > "$CONFIG_DIR/devices.json"
  chown root:"$SERVICE_USER" "$CONFIG_DIR/devices.json"
  chmod 0640 "$CONFIG_DIR/devices.json"
  note "Created an empty, fail-closed device registry."
else
  note "Preserved existing device registry."
fi

if [[ ! -e "$SYSTEMD_UNIT" ]]; then
  install -o root -g root -m 0644 "$ROOT/deploy/ourtunnelself/ourtunnelself.service" "$SYSTEMD_UNIT"
  note "Installed systemd unit."
else
  note "Preserved existing $SYSTEMD_UNIT; review it manually against the repository template."
fi

systemctl daemon-reload
note "Host directories and unit prepared. Broker NOT started."
note "Next: replace issuer placeholders; install OSOS seat and PORTAL public keys from their authorities; generate broker keypair; install admitted device records; configure an HTTPS ingress adapter."
note "No trust keys were generated or copied. No service was started. No firewall or DNS settings were changed."
