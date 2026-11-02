FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 openssh-server iproute2 fail2ban && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /run/sshd && ssh-keygen -A
COPY systemctl /usr/local/bin/systemctl
COPY systemd-run /usr/local/bin/systemd-run
RUN chmod 755 /usr/local/bin/systemctl /usr/local/bin/systemd-run
COPY verify.py /test/verify.py
CMD ["python3", "/test/verify.py"]
