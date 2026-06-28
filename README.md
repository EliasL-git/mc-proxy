# mcnux — Minecraft Proxy CLI

Zero-dependency Minecraft server proxy with connection approval.

## Architecture

```
Player → Slave :25565 (pending queue) → Host approves → tunnel → MC Server
```

Two components working together:
- **Slave** — runs on a public-facing machine, accepts player connections (but queues them for approval)
- **Host** — runs on the MC server machine, connects to Slave, shows pending connections and lets you approve/deny them

## Install

```bash
npm install -g mcnux
```

Or run directly:

```bash
node mcnux.js serve
node mcnux.js host 192.168.1.100 25567
```

## Usage

### 1. Start the Slave (public machine)

```bash
mcnux serve [player-port] [control-port]
```

Default player port: `25565` — players connect here
Default control port: `25567` — Host connects here

Players who connect are **queued pending approval**. They wait until the Host approves them.

### 2. Start the Host (MC server machine)

```bash
mcnux host <slave-host> <control-port> [--mc-server <addr>]
```

Connects to the Slave's control port and gives you an interactive prompt:

```
mcnux host>
```

#### Host Commands

| Command | Description |
|---------|-------------|
| `connections` | List pending players |
| `approve <id>` | Let a player through |
| `deny <id>` | Reject a player |
| `active` | Show active tunnels |
| `refresh` | Re-fetch pending list |
| `help` | Show available commands |
| `exit` | Disconnect and quit |

### Example

```bash
# On your public VPS (Slave):
mcnux serve

# On your Minecraft server machine (Host):
mcnux host 203.0.113.5 25567

# When a player connects, you'll see:
# ➜ [1] New connection from 203.0.113.50:54321 — type "approve 1" to allow
mcnux host> approve 1
# ✓ Approved connection 1
# Data flows through the tunnel
```

## Options

| Flag | Description |
|------|-------------|
| `--mc-server <addr>` | Target Minecraft server (default: `localhost:25565`) |
| `--no-color` | Disable ANSI colored output |
| `-h, --help` | Show help |
| `--version` | Print version |

## How it works

1. Players connect to the **Slave** on the public port
2. The Slave buffers their connection and notifies the **Host** via the control channel
3. The Host admin runs the interactive CLI — they see pending connections and **approve or deny** them
4. On approval, the Slave opens a direct TCP tunnel to the Host, which connects to the Minecraft server
5. All traffic flows: **Player ↔ Slave ↔ Host ↔ MC Server**
6. The Host controls exactly who gets through — no unwanted connections

## Requirements

- Node.js >= 18
- Zero npm dependencies — uses only built-in `net` and `readline` modules
