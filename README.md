# mc-proxy

Two-agent Minecraft proxy — **Host** connects to the real server, **Slave** accepts players.

```
Client  <->  Slave :25565  <->  TCP :25566  <->  Host :25566  <->  MC Server
```

## Why two agents?

- **Host** handles the upstream connection to Minecraft. Runs in the datacenter near the MC server.
- **Slave** takes player connections. Run it on a public-facing box, point it at the Host.

Players join the Slave's IP and play on the Host's MC server.

## Usage

```bash
# Terminal 1 — Host (connect to real MC server, listen for Slave)
mc-proxy-host -t your-server.com:25565

# Terminal 2 — Slave (players connect here, relay through Host)
mc-proxy-slave -h localhost:25566 -l 25565
```

## CLI

### Host
```
mc-proxy-host [options] [<host> [<port>]]

  -t, --target <host:port>   Target Minecraft server (default: localhost:25565)
  -l, --listen <port>        Listen for Slave connections (default: 25566)
  -b, --bind <address>       Bind address (default: 0.0.0.0)
  -m, --max <n>              Max concurrent tunnels (default: unlimited)
  -v, --verbose              Hex-dump tunnel traffic
  -s, --stats                Show live statistics
  --no-color                 Disable ANSI colors
```

### Slave
```
mc-proxy-slave [options] [<host:port>]

  -h, --host <host:port>     Host relay address (default: localhost:25566)
  -l, --listen <port>        Port for clients (default: 25565)
  -b, --bind <address>       Bind address (default: 0.0.0.0)
  -m, --max <n>              Max concurrent clients (default: unlimited)
  -v, --verbose              Hex-dump packet traffic
  -s, --stats                Show live statistics
  --no-color                 Disable ANSI colors
```

## Features

- **Zero npm dependencies** — uses only Node.js built-ins (`net`, `dns`)
- **Minecraft-aware** — parses and logs handshake packets (protocol version, server address, next state)
- **Hex dump** — `-v` shows packet-level traffic in hexdump -C format
- **Stats** — live byte counters, rates, connection counts, uptime
- **Clean shutdown** — drains active connections on SIGINT/SIGTERM
- **Connection limiting** — cap concurrent tunnels/clients with `-m`

## Install

```bash
git clone https://github.com/EliasL-git/mc-proxy.git
cd mc-proxy
npm link
```

Or run directly:
```bash
node mc-proxy-host.js --help
node mc-proxy-slave.js --help
```

## License

MIT
