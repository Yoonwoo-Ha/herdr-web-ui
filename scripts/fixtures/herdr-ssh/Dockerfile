FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server ca-certificates libstdc++6 procps && rm -rf /var/lib/apt/lists/* && mkdir /run/sshd && useradd -m -s /bin/bash fixture && echo 'fixture:herdr-test-only' | chpasswd
RUN printf 'PasswordAuthentication yes\nUsePAM no\nAllowUsers fixture\nAllowTcpForwarding yes\n' > /etc/ssh/sshd_config.d/fixture.conf
CMD ["/usr/sbin/sshd", "-D", "-e"]
