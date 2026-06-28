# mcnux — Minecraft Proxy CLI

Two-agent Minecraft proxy with zero npm dependencies.

```
Client  <->  mcnux serve :25565  <->  mcnux connect :25566  <->  MC Server
```

Players join the **Slave** (public-facing), the **Host** (near the MC server) bridges to the real server.

## Install

```bash
npm install -g mcnux
```

Then `mcnux --help` anywhere. That's it — no other setup.

## Architecture

Two processes connect to create one tunnel:

- **Host** (`mcnux connect`) — runs on the machine near the Minecraft server. Listens for the Slave, relays traffic to the MC server.
- **Slave** (`mcnux serve`) — runs on a public-facing machine. Players connect here, traffic gets relayed through the Host.

The tunnel is plain TCP — no npm deps, Node built-ins only.

## Usage

### Host mode

```bash
mcnux connect <listen-addr> <target-addr>
```

| Argument | Description | Default |
|---|---|---|
| `<listen-addr>` | Address to listen for Slave connections | `0.0.0.0:25566` |
| `<target-addr>` | Minecraft server to forward to | `localhost:25565` |

```bash
# Basic — listen on :25566, forward to local MC server
mcnux connect 0.0.0.0:25566 localhost:25565

# Forward to a remote MC server
mcnux connect 0.0.0.0:25566 play.hypixel.net

# Verbose mode — see all packet traffic
mcnux connect 0.0.0.0:25566 192.168.1.10:25565 -v
```

### Slave mode

```bash
mcnux serve <listen-addr> <host-addr>
```

| Argument | Description | Default |
|---|---|---|
| `<listen-addr>` | Address to listen for players | `0.0.0.0:25565` |
| `<host-addr>` | Host address to relay through | `localhost:25566` |

```bash
# Basic — accept players on :25565, relay through Host at 10.0.0.1:25566
mcnux serve 0.0.0.0:25565 10.0.0.1:25566

# With verbose packet dump
mcnux serve 0.0.0.0:25565 host.example.com:25566 -v
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

## License

MIT
