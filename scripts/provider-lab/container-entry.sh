#!/bin/sh
set -eu
# All writes target this disposable container's filesystem; no host data mounts.
install -d -m 700 -o diagnostic -g diagnostic /home/diagnostic/.ssh
install -m 600 -o diagnostic -g diagnostic /run/lab/client.pub /home/diagnostic/.ssh/authorized_keys
ssh-keygen -A
cat > /etc/ssh/sshd_config <<'EOF'
Port 22
HostKey /etc/ssh/ssh_host_ed25519_key
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers diagnostic
AllowTcpForwarding no
X11Forwarding no
UsePAM no
PidFile /run/sshd/lab.pid
EOF
root=/srv/dune
mkdir -p "$root/DuneSandbox/Binaries/Linux" "$root/DuneSandbox/Content/Paks" "$root/DuneSandbox/Saved/Config/LinuxServer" "$root/steamapps" /srv/unknown /srv/denied
cp /tmp/fixture-game "$root/DuneSandbox/Binaries/Linux/DuneSandboxServer-Linux-Shipping"
printf 'SYNTHETIC PAK; NOT GAME DATA\n' > "$root/DuneSandbox/Content/Paks/fixture.pak"
printf '[/Script/DuneSandbox.Test]\nm_GlobalXPMultiplier=2\nFixturePassword=canary-must-not-export\n' > "$root/DuneSandbox/Saved/Config/LinuxServer/UserGame.ini"
printf 'Port=1234\n' > "$root/DuneSandbox/Saved/Config/LinuxServer/UserEngine.ini"
printf '"appid" "4754530" "buildid" "123456"\n' > "$root/steamapps/appmanifest_4754530.acf"
chmod 700 /srv/denied
chown -R diagnostic:diagnostic "$root"
runuser -u diagnostic -- "$root/DuneSandbox/Binaries/Linux/DuneSandboxServer-Linux-Shipping" &
install -d -m 755 -o diagnostic -g diagnostic /srv/lab
runuser -u diagnostic -- python3 -B /tmp/fixture-engine.py &
mkdir -p /srv/lab-pg
chown postgres:postgres /srv/lab-pg
runuser -u postgres -- /usr/lib/postgresql/15/bin/initdb -D /srv/lab-pg -A trust >/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' -keyout /srv/lab-pg/server.key -out /srv/lab-pg/server.crt >/dev/null 2>&1
chmod 600 /srv/lab-pg/server.key
chown postgres:postgres /srv/lab-pg/server.key /srv/lab-pg/server.crt
cat >> /srv/lab-pg/postgresql.conf <<'EOF'
listen_addresses = '*'
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
EOF
printf 'local all all trust\nhostssl all all all scram-sha-256\nhostnossl all all all reject\n' > /srv/lab-pg/pg_hba.conf
runuser -u postgres -- /usr/lib/postgresql/15/bin/pg_ctl -D /srv/lab-pg -l /srv/lab-pg/log start >/dev/null
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -f /tmp/fixture-init.sql >/dev/null
touch /run/lab-ready
exec /usr/sbin/sshd -D -e
