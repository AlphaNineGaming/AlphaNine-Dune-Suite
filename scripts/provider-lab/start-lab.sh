#!/bin/sh
set -eu
# All writes are inside this disposable container. Only a public key is mounted.
test -s /fixture/client.pub
cp /fixture/client.pub /home/diagnostic/.ssh/authorized_keys
chown diagnostic:diagnostic /home/diagnostic/.ssh/authorized_keys
chmod 700 /home/diagnostic/.ssh
chmod 600 /home/diagnostic/.ssh/authorized_keys
ssh-keygen -A
exec /usr/sbin/sshd -D -e
