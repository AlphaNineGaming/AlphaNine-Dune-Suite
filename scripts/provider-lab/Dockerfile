# Optional disposable SSH lab. Supply an immutable Alpine image digest.
# Build packages are NOT fully locked: record resolved package versions and the
# resulting image digest before claiming this container environment reproducible.
ARG ALPINE_IMAGE
FROM ${ALPINE_IMAGE}
RUN apk add --no-cache openssh-server && adduser -D diagnostic && passwd -u diagnostic && mkdir -p /srv/dune /home/diagnostic/.ssh && chown -R diagnostic:diagnostic /srv/dune /home/diagnostic
COPY sshd_config /etc/ssh/sshd_config
COPY start-lab.sh /usr/local/bin/start-lab
EXPOSE 2222
ENTRYPOINT ["/bin/sh", "/usr/local/bin/start-lab"]
