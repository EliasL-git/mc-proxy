#!/usr/bin/env node

/**
 * mc-proxy-slave — Slave Agent for Minecraft Proxy
 * =================================================
 * Accepts Minecraft clients and relays them to the Host agent.
 * Zero npm dependencies — uses only Node.js built-ins.
 *
 * Architecture:
 *   Minecraft Client <-> Slave :25565 <-> TCP :25566 <-> Host :25566 <-> MC Server :25565
 *
 * Usage:
 *   mc-proxy-slave
 *   mc-proxy-slave -h localhost:25566 -l 25565 -v
 *   mc-proxy-slave --host relay.example.com --listen 25566
 *
 * MIT License
 */

'use strict';

// ───────────────────────────────────────────────────────────────
//  Imports
// ───────────────────────────────────────────────────────────────

const net = require('net');

// ───────────────────────────────────────────────────────────────
//  Version & Metadata
// ───────────────────────────────────────────────────────────────

const VERSION = '1.0.0';

// ───────────────────────────────────────────────────────────────
//  ANSI Color Constants
// ───────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
};

// ───────────────────────────────────────────────────────────────
//  Color helpers
// ───────────────────────────────────────────────────────────────

function colorize(code, text) { return color ? `${code}${text}${C.reset}` : text; }
let color = true;

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ───────────────────────────────────────────────────────────────
//  Logger
// ───────────────────────────────────────────────────────────────

function log(level, msg, extra = '') {
  const t = colorize(C.dim, timestamp());

  const tags = {
    info:  colorize(C.blue,    ' ▶'),
    ok:    colorize(C.green,   ' ✓'),
    warn:  colorize(C.yellow,  ' ⚠'),
    error: colorize(C.red,     ' ✗'),
    conn:  colorize(C.cyan,    ' ➜'),
    disc:  colorize(C.magenta, ' ✗'),
    data:  colorize(C.gray,    ' ·'),
    stat:  colorize(C.white,   ' ■'),
  };

  const tag = tags[level] || tags.info;
  console.log(`${t} ${tag} ${msg}${extra ? ' ' + extra : ''}`);
}

function logRaw(text) {
  console.log(text);
}

// ───────────────────────────────────────────────────────────────
//  CLI Argument Parser
// ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    host: 'localhost:25566',
    listen: 25565,
    bind: '0.0.0.0',
    verbose: false,
    maxConnections: 0,
    help: false,
    version: false,
  };

  const positional = [];

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[i + 1];

    switch (arg) {
      case '-h': case '--host':
        args.host = next();
        i++;
        break;

      case '-l': case '--listen':
        args.listen = parseInt(next(), 10);
        if (isNaN(args.listen)) { die(`Invalid port: ${next()}`); }
        i++;
        break;

      case '-b': case '--bind':
        args.bind = next();
        i++;
        break;

      case '-m': case '--max':
        args.maxConnections = parseInt(next(), 10);
        if (isNaN(args.maxConnections)) { die(`Invalid max: ${next()}`); }
        i++;
        break;

      case '-v': case '--verbose':
        args.verbose = true;
        break;

      case '--no-color':
        color = false;
        args.color = false;
        break;

      case '--version':
        args.version = true;
        break;

      case '--help':
        args.help = true;
        break;

      default:
        if (arg.startsWith('-')) {
          die(`Unknown option: ${arg}`);
        }
        positional.push(arg);
    }
  }

  // Positional arguments: [host:port]
  if (positional.length > 0) {
    args.host = positional[0];
  }

  return args;
}

// ───────────────────────────────────────────────────────────────
//  Host address parser
// ───────────────────────────────────────────────────────────────

function parseHost(str) {
  if (!str) return null;
  const colon = str.lastIndexOf(':');
  if (colon === -1) return { host: 'localhost', port: 25566 };
  const host = str.slice(0, colon);
  // Handle IPv6: [::1]:25566
  const portStr = colon > 0 && str[colon - 1] === ']'
    ? str.slice(str.lastIndexOf(']:') + 2)
    : str.slice(colon + 1);
  const port = parseInt(portStr, 10);
  if (isNaN(port)) return { host: str, port: 25566 };
  return { host: host || 'localhost', port };
}

// ───────────────────────────────────────────────────────────────
//  Help
// ───────────────────────────────────────────────────────────────

function printHelp() {
  const bold = color ? C.bold : '';
  const dim = color ? C.dim : '';
  const reset = color ? C.reset : '';

  console.log(`
${bold}mc-proxy-slave${reset}  —  Slave Agent  ${dim}v${VERSION}${reset}

${bold}USAGE${reset}
  mc-proxy-slave [options] [<host:port>]

${bold}DESCRIPTION${reset}
  Accepts Minecraft clients and relays traffic to the Host agent.
  The Host connects to the actual Minecraft server.

  Architecture:
    Client <-> Slave :25565 <-> TCP :25566 <-> Host :25566 <-> Server :25565

${bold}OPTIONS${reset}
  ${bold}-h, --host${reset} <host:port>       Host relay address ${dim}(default: localhost:25566)${reset}
  ${bold}-l, --listen${reset} <port>          Port to listen for Minecraft clients ${dim}(default: 25565)${reset}
  ${bold}-b, --bind${reset} <address>         Bind address ${dim}(default: 0.0.0.0)${reset}
  ${bold}-m, --max${reset} <n>               Max concurrent clients ${dim}(default: unlimited)${reset}
  ${bold}-v, --verbose${reset}                Show hex-dump of relayed traffic
  ${bold}--no-color${reset}                   Disable ANSI colored output
  ${bold}--version${reset}                    Print version and exit
  ${bold}--help${reset}                       Show this help message

${bold}EXAMPLES${reset}
  mc-proxy-slave                              ${dim}# Connect to Host on localhost:25566${reset}
  mc-proxy-slave -h 10.0.0.5:25566            ${dim}# Specify Host address${reset}
  mc-proxy-slave -h relay.example.com -l 25565${dim}# Custom Host with listen port${reset}
  mc-proxy-slave -v                           ${dim}# Verbose mode with hex dumps${reset}
  mc-proxy-slave -m 100                       ${dim}# Limit to 100 concurrent clients${reset}
`);
}

// ───────────────────────────────────────────────────────────────
//  Utilities
// ───────────────────────────────────────────────────────────────

function die(msg) {
  console.error(color ? `${C.red}✗${C.reset} ${msg}` : `✗ ${msg}`);
  process.exit(1);
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function formatRate(n) {
  return `${formatBytes(n)}/s`;
}

// ───────────────────────────────────────────────────────────────
//  Minecraft Protocol: VarInt
// ───────────────────────────────────────────────────────────────

/**
 * Read a VarInt from a buffer at the given offset.
 * Returns { value, bytesRead } or null if incomplete.
 */
function readVarInt(buf, offset) {
  let result = 0;
  let bytesRead = 0;
  let byte;

  do {
    if (offset + bytesRead >= buf.length) return null;
    byte = buf[offset + bytesRead];
    result |= (byte & 0x7F) << (7 * bytesRead);
    bytesRead++;
    if (bytesRead > 5) return null; // Malformed VarInt
  } while (byte & 0x80);

  return { value: result, bytesRead };
}

/**
 * Read a Minecraft-style length-prefixed UTF-8 string.
 * Returns { value, bytesRead } or null.
 */
function readString(buf, offset) {
  const len = readVarInt(buf, offset);
  if (!len) return null;
  const start = offset + len.bytesRead;
  const end = start + len.value;
  if (end > buf.length) return null;
  return {
    value: buf.toString('utf8', start, end),
    bytesRead: len.bytesRead + len.value,
  };
}

// ───────────────────────────────────────────────────────────────
//  Minecraft Handshake Parser
// ───────────────────────────────────────────────────────────────

/**
 * Parse the first packet from a Minecraft client.
 * Format:
 *   VarInt  packetId     (0x00 = handshake)
 *   VarInt  protocolVer
 *   String  serverAddr
 *   UShort  serverPort
 *   VarInt  nextState    (1 = status, 2 = login)
 *
 * Returns parsed info or null.
 */
function parseHandshake(buf) {
  let offset = 0;

  const packetLen = readVarInt(buf, offset);
  if (!packetLen || packetLen.value < 2) return null;
  offset += packetLen.bytesRead;

  const packetId = readVarInt(buf, offset);
  if (!packetId || packetId.value !== 0x00) return null;
  offset += packetId.bytesRead;

  const protoVer = readVarInt(buf, offset);
  if (!protoVer) return null;
  offset += protoVer.bytesRead;

  const addr = readString(buf, offset);
  if (!addr) return null;
  offset += addr.bytesRead;

  // Read unsigned short (big-endian)
  if (offset + 2 > buf.length) return null;
  const serverPort = buf.readUInt16BE(offset);
  offset += 2;

  const nextState = readVarInt(buf, offset);
  if (!nextState) return null;

  return {
    protocolVersion: protoVer.value,
    serverAddress: addr.value,
    serverPort,
    nextState: nextState.value,
    nextStateName: nextState.value === 1 ? 'status' : nextState.value === 2 ? 'login' : `unknown(${nextState.value})`,
  };
}

// ───────────────────────────────────────────────────────────────
//  Hex Dump
// ───────────────────────────────────────────────────────────────

function hexDump(buf) {
  const lines = [];
  for (let i = 0; i < buf.length; i += 16) {
    const slice = buf.slice(i, Math.min(i + 16, buf.length));
    const hex = Array.from(slice)
      .map(b => b.toString(16).padStart(2, '0'))
      .join(' ');
    const ascii = Array.from(slice)
      .map(b => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
      .join('');
    const addr = i.toString(16).padStart(4, '0');
    lines.push(`  ${colorize(C.dim, addr)}  ${hex.padEnd(47)} \u2502${ascii}\u2502`);
  }
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────
//  Stats Tracker
// ───────────────────────────────────────────────────────────────

class Stats {
  constructor() {
    this.totalConnections = 0;
    this.activeConnections = 0;
    this.totalBytesUp = 0;
    this.totalBytesDown = 0;
    this.sessionId = 0;
    this.startTime = Date.now();
    this._lastTickUp = 0;
    this._lastTickDown = 0;
    this._tickTime = Date.now();
  }

  connectionOpened() {
    this.totalConnections++;
    this.activeConnections++;
    this.sessionId++;
    return this.sessionId;
  }

  connectionClosed() {
    this.activeConnections--;
  }

  bytesUp(n) { this.totalBytesUp += n; }
  bytesDown(n) { this.totalBytesDown += n; }

  currentRate() {
    const now = Date.now();
    const elapsed = (now - this._tickTime) / 1000;
    if (elapsed < 0.1) return { up: 0, down: 0 };
    const rate = {
      up: Math.round((this.totalBytesUp - this._lastTickUp) / elapsed),
      down: Math.round((this.totalBytesDown - this._lastTickDown) / elapsed),
    };
    this._lastTickUp = this.totalBytesUp;
    this._lastTickDown = this.totalBytesDown;
    this._tickTime = now;
    return rate;
  }

  uptime() {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  display() {
    const rate = this.currentRate();
    const up = formatBytes(this.totalBytesUp);
    const down = formatBytes(this.totalBytesDown);
    const rateUp = formatRate(rate.up);
    const rateDown = formatRate(rate.down);
    const uptime = this.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const secs = uptime % 60;
    const uptimeStr = hours > 0
      ? `${hours}h ${mins}m ${secs}s`
      : mins > 0
        ? `${mins}m ${secs}s`
        : `${secs}s`;

    log('stat', `${colorize(C.bold, 'mc-proxy-slave')} stats:`);
    log('stat', `  Uptime:    ${uptimeStr}`);
    log('stat', `  Active:    ${colorize(C.cyan, String(this.activeConnections))} clients`);
    log('stat', `  Total:     ${this.totalConnections} clients`);
    log('stat', `  Upload:    ${up} ${colorize(C.dim, `(${rateUp})`)}`);
    log('stat', `  Download:  ${down} ${colorize(C.dim, `(${rateDown})`)}`);
  }
}

// ───────────────────────────────────────────────────────────────
//  Session — manages one client <-> Host connection
// ───────────────────────────────────────────────────────────────

class Session {
  constructor(clientSocket, hostAddr, stats, opts) {
    this.id = stats.connectionOpened();
    this.client = clientSocket;
    this.hostAddr = hostAddr;
    this.stats = stats;
    this.opts = opts;
    this.host = null;
    this.clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
    this.bytesUp = 0;
    this.bytesDown = 0;
    this.handshakeInfo = null;
    this.closed = false;
    this._handshakeParsed = false;
  }

  start() {
    log('conn', `[${this.id}] client ${colorize(C.cyan, this.clientAddr)}`, colorize(C.dim, 'connecting to Host...'));

    this.host = new net.Socket();

    this.host.once('error', (err) => {
      if (this.closed) return;
      log('error', `[${this.id}] Host connect failed: ${err.message}`);
      this.client.end();
      this.cleanup();
    });

    this.host.connect(this.hostAddr.port, this.hostAddr.host, () => {
      if (this.closed) return;
      log('ok', `[${this.id}] connected to Host ${colorize(C.green, `${this.hostAddr.host}:${this.hostAddr.port}`)}`);

      // If we have handshake info, log it now
      if (this.handshakeInfo) {
        this._logHandshake();
      }
    });

    // ── Client -> Host ──
    this.client.on('data', (data) => {
      if (this.closed) return;

      // Try to parse handshake from first client data
      if (!this._handshakeParsed) {
        const hs = parseHandshake(data);
        if (hs) {
          this.handshakeInfo = hs;
          this._handshakeParsed = true;
          if (this.host.connecting || !this.host.writable) {
            // Don't log yet — wait for Host connect
          } else {
            this._logHandshake();
          }
        }
      }

      this.bytesUp += data.length;
      this.stats.bytesUp(data.length);

      if (this.opts.verbose) {
        log('data', colorize(C.blue, `[${this.id}] \u2191 ${data.length} bytes`));
        logRaw(hexDump(data));
      }

      if (this.host.writable) {
        this.host.write(data);
      }
    });

    // ── Host -> Client ──
    this.host.on('data', (data) => {
      if (this.closed) return;
      this.bytesDown += data.length;
      this.stats.bytesDown(data.length);

      if (this.opts.verbose) {
        log('data', colorize(C.magenta, `[${this.id}] \u2193 ${data.length} bytes`));
        logRaw(hexDump(data));
      }

      if (this.client.writable) {
        this.client.write(data);
      }
    });

    // ── Close / Error handling ──
    this.client.once('close', () => {
      if (this.closed) return;
      log('disc', `[${this.id}] client disconnected ${colorize(C.dim, this.clientAddr)}`);
      this.cleanup();
    });

    this.client.once('error', (err) => {
      if (this.closed) return;
      log('error', `[${this.id}] client error: ${err.message}`);
      this.cleanup();
    });

    this.host.once('close', () => {
      if (this.closed) return;
      log('disc', `[${this.id}] Host disconnected`);
      this.cleanup();
    });

    this.host.once('error', (err) => {
      if (this.closed) return;
      log('error', `[${this.id}] Host error: ${err.message}`);
      this.cleanup();
    });
  }

  _logHandshake() {
    const hs = this.handshakeInfo;
    if (!hs) return;
    const stateColor = hs.nextState === 2 ? C.green : C.yellow;
    log('info', `[${this.id}] handshake: protocol=${colorize(C.cyan, hs.protocolVersion)}, server=${colorize(C.bold, hs.serverAddress)}:${hs.serverPort}, next=${colorize(stateColor, hs.nextStateName)}`);
  }

  cleanup() {
    if (this.closed) return;
    this.closed = true;

    if (this.client && !this.client.destroyed) {
      this.client.end();
      this.client.destroy();
    }
    if (this.host && !this.host.destroyed) {
      this.host.end();
      this.host.destroy();
    }

    this.stats.connectionClosed();

    const total = formatBytes(this.bytesUp + this.bytesDown);
    log('info', `[${this.id}] session closed — \u2191${formatBytes(this.bytesUp)} \u2193${formatBytes(this.bytesDown)} ${colorize(C.dim, `(${total} total)`)}`);
  }
}

// ───────────────────────────────────────────────────────────────
//  Main
// ───────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  color = args.color !== false;

  if (args.help) {
    printHelp();
    return;
  }

  if (args.version) {
    console.log(`mc-proxy-slave v${VERSION}`);
    return;
  }

  // Resolve Host address
  const hostAddr = parseHost(args.host);
  if (!hostAddr) {
    die('Invalid Host address. Use -h <host:port> or pass as argument.\n  mc-proxy-slave --help for usage.');
  }

  // Validate
  if (isNaN(hostAddr.port) || hostAddr.port < 1 || hostAddr.port > 65535) {
    die(`Invalid Host port: ${hostAddr.port}`);
  }
  if (isNaN(args.listen) || args.listen < 1 || args.listen > 65535) {
    die(`Invalid listen port: ${args.listen}`);
  }

  const stats = new Stats();
  const verboseLabel = args.verbose ? ` ${color ? C.dim : '('}+ verbose${color ? C.reset : ')'}` : '';
  const maxLabel = args.maxConnections > 0 ? ` max ${args.maxConnections} clients` : '';

  log('info', `${colorize(C.bold, 'mc-proxy-slave')} ${colorize(C.dim, `v${VERSION}`)} — Slave agent${verboseLabel}${maxLabel}`);

  // ── Create listening server ──
  const server = net.createServer({ allowHalfOpen: false }, (clientSocket) => {
    if (args.maxConnections > 0 && stats.activeConnections >= args.maxConnections) {
      log('warn', `max clients (${args.maxConnections}) reached, rejecting ${clientSocket.remoteAddress}`);
      clientSocket.end();
      return;
    }

    const session = new Session(clientSocket, hostAddr, stats, args);
    session.start();
  });

  // ── Error handling ──
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      die(`Port ${args.listen} is already in use`);
    }
    if (err.code === 'EACCES') {
      die(`Permission denied — port ${args.listen} requires elevated privileges`);
    }
    die(`Server error: ${err.message}`);
  });

  // ── Start listening ──
  return new Promise((resolve, reject) => {
    server.listen(args.listen, args.bind, () => {
      const addr = server.address();
      const arrow = colorize(C.green, '\u2192');
      log('ok', `listening for clients on ${colorize(C.bold, `${addr.address}:${addr.port}`)} ${arrow} Host ${colorize(C.cyan, `${hostAddr.host}:${hostAddr.port}`)}`);

      // Graceful shutdown
      const shutdown = () => {
        log('info', colorize(C.yellow, 'shutting down...'));
        server.close(() => {
          const active = stats.activeConnections;
          if (active > 0) {
            log('info', `waiting for ${active} active connection(s) to close...`);
          }
          stats.display();
          log('ok', 'goodbye');
          resolve();
        });

        // Force exit after timeout
        setTimeout(() => {
          log('warn', 'force exit after timeout');
          process.exit(0);
        }, 5000);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  });
}

// ───────────────────────────────────────────────────────────────
//  Run
// ───────────────────────────────────────────────────────────────

main().catch((err) => {
  die(err.message);
});
