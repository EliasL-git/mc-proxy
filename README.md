# mcnux — Minecraft Proxy CLI

Zero-dependency Minecraft server proxy with connection approval. Works with the [mcnux-plugin](https://github.com/EliasL-git/mcnux-plugin) Paper plugin.

## Architecture

```
Player (vanilla MC client)
    │
    │  connects to play.myserver.com → points to VPS
    ▼
VPS — mcnux serve (public, lightweight)
    │  ← TCP control connection (auto-connects to home server)
    ▼
Home Server — Paper + mcnux-plugin (private, hidden)
    │  /mcnux approve <id>  or  /mcnux deny <id>
    ▼
Player joins or gets kicked back
```

- **`mcnux serve`** — runs on your VPS, accepts player connections, forwards approval requests to the plugin
- **mcnux-plugin** — runs on your Paper server, acts as the Host (validates VPS IP, receives requests, sends approve/deny)

## Install

```bash
npm install -g mcnux
```

## Usage

### On your home server (MC server):

Drop `mcnux-plugin-1.0.0.jar` into `plugins/`, start once, then set your VPS IP in `plugins/mcnux-plugin/config.yml`.

The plugin listens on `MC port + 2` (e.g. 25565 → 25567).

### On your VPS:

```bash
mcnux serve [player-port] <home-server-ip> [plugin-control-port]
```

Example:
```bash
mcnux serve 25565 123.45.67.89 25567
```

| Arg | Default | Description |
|-----|---------|-------------|
| `player-port` | `25565` | Port players connect to |
| `home-server-ip` | *required* | Your home server's IP |
| `plugin-control-port` | `25567` | Plugin's control port |

What happens:
1. Proxy connects to plugin's control port → plugin validates your VPS IP
2. Player connects to VPS on player port → proxy sends request to plugin
3. Plugin notifies in-game ops → they `/mcnux approve <id>` or `/mcnux deny <id>`
4. Proxy tunnels traffic to your home MC server

## Options

| Flag | Description |
|------|-------------|
| `--no-color` | Disable ANSI colored output |
| `-h, --help` | Show help |
| `--version` | Print version |

## Protocol

JSON lines over TCP between proxy and plugin:

**Proxy → Plugin:**
```json
{"type":"connect","connId":"1","playerName":"Notch","playerUuid":"...","playerIp":"1.2.3.4","playerPort":54321,"proxyHost":"1.2.3.4:54321"}
{"type":"disconnect","connId":"1"}
```

**Plugin → Proxy:**
```json
{"type":"hello","port":25565}
{"type":"approve","connId":"1"}
{"type":"deny","connId":"1"}
```

## Requirements

- Node.js >= 18
- Zero npm dependencies — uses only built-in `net` module
- [mcnux-plugin](https://github.com/EliasL-git/mcnux-plugin) on the MC server
