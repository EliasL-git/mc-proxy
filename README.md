# mcnux — Minecraft Proxy CLI

Two-agent Minecraft proxy. **Connect** (Host) handles the upstream to the real server. **Serve** (Slave) accepts players and relays through the Host.

```ascii
Client  <->  mcnux serve :25565  <->  mcnux connect :25566  <->  MC Server
```

Players join the **Slave's IP** and play on the **Host's** server.

## Quick start

```bash
# On the machine near the MC server (Host)
mcnux connect 0.0.0.0:25566 localhost:25565

# On the public-facing machine (Slave)
mcnux serve 0.0.0.0:25565 10.0.0.1:25566
```

## Commands

### `mcnux connect <listen-addr> <target-addr>`

**Host mode** — listens for Slave connections, forwards to the real MC server.

| Argument | Description | Default |
|---|---|---|
| `<listen-addr>` | Address to listen for Slave connections | `0.0.0.0:25566` |
| `<target-addr>` | Minecraft server to forward to | `localhost:25565` |

```bash
mcnux connect 0.0.0.0:25566 localhost:25565
mcnux connect 0.0.0.0:25566 play.hypixel.net
mcnux connect 0.0.0.0:25566 192.168.1.10:25565 -v
```

### `mcnux serve <listen-addr> <host-addr>`

**Slave mode** — accepts Minecraft clients, relays through the Host.

| Argument | Description | Default |
|---|---|---|
| `<listen-addr>` | Address to listen for players | `0.0.0.0:25565` |
| `<host-addr>` | Host address to relay through | `localhost:25566` |

```bash
mcnux serve 0.0.0.0:25565 host.example.com:25566
mcnux serve 0.0.0.0:25565 10.0.0.1:25566 -v
```

### Options

| Flag | Description |
|---|---|
| `-v`, `--verbose` | Hex-dump all packet traffic |
| `--no-color` | Disable ANSI colors |
| `-h`, `--help` | Show help |
| `--version` | Print version |

## Features

- **Zero npm dependencies** — only Node.js built-ins (`net`, `dns`)
- **Minecraft-aware** — parses and logs handshake packets (protocol version, server address, next state)
- **Hex dump** — `-v` shows packet-level traffic in `hexdump -C` format
- **Live stats** — byte counters, transfer rates, connection counts, uptime (updates every 10s)
- **Clean shutdown** — drains active connections on SIGINT/SIGTERM

## Install

```bash
npm install -g mcnux
# or from source:
git clone https://github.com/EliasL-git/mc-proxy
cd mc-proxy
npm link
```

Then `mcnux --help` anywhere.

## Legacy CLIs

The repo also ships individual scripts if you prefer:

```bash
node mc-proxy-host.js --help   # standalone Host
node mc-proxy-slave.js --help  # standalone Slave
```

## License

MIT
