#!/usr/bin/env node

/**
 * mc-proxy-host — Host Agent for Minecraft Proxy
 * ===============================================
 * Listens for Slave connections and relays to the real Minecraft server.
 *
 * Part of the two-agent proxy architecture:
 *   Client <-> Slave :25565 <-> TCP :25566 <-> Host :25566 <-> MC Server :25565
 *
 * Usage:
 *   mc-proxy-host -t localhost:25565
 *   mc-proxy-host -t hypixel.net -l 25566 -v
 *
 * MIT License
 */

'use strict';

const net = require('net');
const dns = require('dns');

// ───────────────────────────────────────────────────────────────
//  Version
// ───────────────────────────────────────────────────────────────

const VERSION = '1.0.0';

// ───────────────────────────────────────────────────────────────
//  ANSI Colors
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
};

let color = true;

function ts() {
  const d = new Date();
  const s = d.toISOString().replace('T', ' ').slice(0, 19);
  return color ? `${C.gray}${s}${C.reset}` : s;
}

function c(code, text) {
  return color ? `${code}${text}${C.reset}` : text;
}

// ───────────────────────────────────────────────────────────────
//  Logger
// ───────────────────────────────────────────────────────────────

const LOG_TAGS = {
  info:  { tag: ' ▶',  c: C.blue },
  ok:    { tag: ' ✓',  c: C.green },
  warn:  { tag: ' ⚠',  c: C.yellow },
  error: { tag: ' ✗',  c: C.red },
  conn:  { tag: ' ➜',  c: C.cyan },
  disc:  { tag: ' ✗',  c: C.magenta },
  data:  { tag: ' ·',  c: C.gray },
  stat:  { tag: ' ■',  c: C.white },
};

function log(level, msg, extra = '') {
  const t = ts();
  const l = LOG_TAGS[level] || LOG_TAGS.info;
  const tag = c(l.c, l.tag);
  console.log(`${t} ${tag} ${msg}${extra ? ' ' + extra : ''}`);
}

function raw(text) {
  console.log(text);
}

// ───────────────────────────────────────────────────────────────
//  CLI Argument Parser
// ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    listen: 25566,
    bind: '0.0.0.0',
    target: null,
    verbose: false,
    maxConnections: 0,
    help: false,
    version: false,
    stats: false,
  };

  const positional = [];

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[i + 1];

    switch (arg) {
      case '-t': case '--target':
        args.target = next();
        i++;
        break;
      case '-l': case '--listen':
        args.listen = parseInt(next(), 10);
        if (isNaN(args.listen)) die(`Invalid port: ${next()}`);
        i++;
        break;
      case '-b': case '--bind':
        args.bind = next();
        i++;
        break;
      case '-m': case '--max':
        args.maxConnections = parseInt(next(), 10);
        if (isNaN(args.maxConnections)) die(`Invalid max: ${next()}`);
        i++;
        break;
      case '-v': case '--verbose':
        args.verbose = true;
        break;
      case '-s': case '--stats':
        args.stats = true;
        break;
      case '--no-color':
        color = false;
        break;
      case '-h': case '--help':
        args.help = true;
        break;
      case '--version':
        args.version = true;
        break;
      default:
        if (arg.startsWith('-')) die(`Unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  // Positional: [host] [port] or host:port
  if (!args.target && positional.length > 0) {
    if (positional.length === 1 && positional[0].includes(':')) {
      args.target = positional[0];
    } else if (positional.length === 1) {
      args.target = `${positional[0]}:25565`;
    } else if (positional.length >= 2) {
      args.target = `${positional[0]}:${positional[1]}`;
    }
  }

  return args;
}

// ───────────────────────────────────────────────────────────────
//  Target Parser
// ───────────────────────────────────────────────────────────────

function parseTarget(str) {
  if (!str) return null;
  const colon = str.lastIndexOf(':');
  if (colon === -1) return { host: str, port: 25565 };
  const host = str.slice(0, colon);
  const portStr = colon > 0 && str[colon - 1] === ']'
    ? str.slice(str.lastIndexOf(']:') + 2)
    : str.slice(colon + 1);
  const port = parseInt(portStr, 10);
  if (isNaN(port)) return { host: str, port: 25565 };
  return { host: host || 'localhost', port };
}

// ───────────────────────────────────────────────────────────────
//  Helpers
// ───────────────────────────────────────────────────────────────

function die(msg) {
  console.error(color ? `${C.red}✗${C.reset} ${msg}` : `✗ ${msg}`);
  process.exit(1);
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function fmtRate(n) {
  return `${fmtBytes(n)}/s`;
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
    lines.push(`  ${c(C.dim, addr)}  ${hex.padEnd(47)} \u2502${ascii}\u2502`);
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

  connOpen() {
    this.totalConnections++;
    this.activeConnections++;
    this.sessionId++;
    return this.sessionId;
  }

  connClose() {
    this.activeConnections--;
  }

  bytesUp(n) { this.totalBytesUp += n; }
  bytesDown(n) { this.totalBytesDown += n; }

  currentRate() {
    const now = Date.now();
    const elapsed = (now - this._tickTime) / 1000;
    if (elapsed < 0.1) return { up: 0, down: 0 };
    const r = {
      up: Math.round((this.totalBytesUp - this._lastTickUp) / elapsed),
      down: Math.round((this.totalBytesDown - this._lastTickDown) / elapsed),
    };
    this._lastTickUp = this.totalBytesUp;
    this._lastTickDown = this.totalBytesDown;
    this._tickTime = now;
    return r;
  }

  uptime() {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  display() {
    const rate = this.currentRate();
    const u = this.uptime();
    const h = Math.floor(u / 3600);
    const m = Math.floor((u % 3600) / 60);
    const s2 = u % 60;
    const uptimeStr = h > 0 ? `${h}h ${m}m ${s2}s` : m > 0 ? `${m}m ${s2}s` : `${s2}s`;

    log('stat', `${c(C.bold, 'mc-proxy-host')} stats:`);
    log('stat', `  Uptime:    ${uptimeStr}`);
    log('stat', `  Active:    ${c(C.cyan, String(this.activeConnections))} tunnels`);
    log('stat', `  Total:     ${this.totalConnections} tunnels`);
    log('stat', `  Up:        ${fmtBytes(this.totalBytesUp)} ${c(C.dim, `(${fmtRate(rate.up)})`)}`);
    log('stat', `  Down:      ${fmtBytes(this.totalBytesDown)} ${c(C.dim, `(${fmtRate(rate.down)})`)}`);
  }
}

// ───────────────────────────────────────────────────────────────
//  Session — bridges Slave ↔ Minecraft Server
// ───────────────────────────────────────────────────────────────

class Session {
  constructor(slaveSocket, target, stats, opts) {
    this.id = stats.connOpen();
    this.slave = slaveSocket;
    this.target = target;
    this.stats = stats;
    this.opts = opts;
    this.mcServer = null;
    this.slaveAddr = `${slaveSocket.remoteAddress}:${slaveSocket.remotePort}`;
    this.bytesUp = 0;    // slave → server
    this.bytesDown = 0;  // server → slave
    this.closed = false;
  }

  start() {
    log('conn', `[${this.id}] slave connected ${c(C.cyan, this.slaveAddr)}`, c(C.dim, 'connecting to MC server...'));

    // Resolve DNS before connecting (track latency)
    const resolveStart = Date.now();
    dns.lookup(this.target.host, { all: false }, (err, address) => {
      if (err) {
        log('error', `[${this.id}] DNS lookup failed for ${this.target.host}: ${err.message}`);
        this.slave.end();
        this.cleanup();
        return;
      }
      const resolveMs = Date.now() - resolveStart;
      if (resolveMs > 50) {
        log('warn', `[${this.id}] DNS lookup took ${resolveMs}ms (${this.target.host} -> ${address})`);
      }

      // Connect to MC server
      this.mcServer = new net.Socket();

      this.mcServer.once('error', (err) => {
        if (this.closed) return;
        log('error', `[${this.id}] connection to ${c(C.yellow, `${this.target.host}:${this.target.port}`)} failed: ${err.message}`);
        this.slave.end();
        this.cleanup();
      });

      this.mcServer.connect(this.target.port, address, () => {
        if (this.closed) return;
        log('ok', `[${this.id}] tunnel established ${c(C.green, `${this.target.host}:${this.target.port}`)}`);

        // ── Slave → MC Server ──
        this.slave.on('data', (data) => {
          if (this.closed) return;
          this.bytesUp += data.length;
          this.stats.bytesUp(data.length);

          if (this.opts.verbose) {
            log('data', c(C.blue, `[${this.id}] ↑ ${data.length} bytes → MC server`));
            raw(hexDump(data));
          }

          if (this.mcServer.writable) this.mcServer.write(data);
        });

        // ── MC Server → Slave ──
        this.mcServer.on('data', (data) => {
          if (this.closed) return;
          this.bytesDown += data.length;
          this.stats.bytesDown(data.length);

          if (this.opts.verbose) {
            log('data', c(C.magenta, `[${this.id}] ↓ ${data.length} bytes ← MC server`));
            raw(hexDump(data));
          }

          if (this.slave.writable) this.slave.write(data);
        });

        // ── Close handlers ──
        this.slave.once('close', () => {
          if (this.closed) return;
          log('disc', `[${this.id}] slave disconnected ${c(C.dim, this.slaveAddr)}`);
          this.cleanup();
        });

        this.slave.once('error', (err) => {
          if (this.closed) return;
          log('error', `[${this.id}] slave error: ${err.message}`);
          this.cleanup();
        });

        this.mcServer.once('close', () => {
          if (this.closed) return;
          log('disc', `[${this.id}] MC server disconnected`);
          this.cleanup();
        });

        this.mcServer.once('error', (err) => {
          if (this.closed) return;
          log('error', `[${this.id}] MC server error: ${err.message}`);
          this.cleanup();
        });
      });
    });
  }

  cleanup() {
    if (this.closed) return;
    this.closed = true;

    if (this.slave && !this.slave.destroyed) {
      this.slave.end();
      this.slave.destroy();
    }
    if (this.mcServer && !this.mcServer.destroyed) {
      this.mcServer.end();
      this.mcServer.destroy();
    }

    this.stats.connClose();

    const total = fmtBytes(this.bytesUp + this.bytesDown);
    log('info', `[${this.id}] tunnel closed — ↑${fmtBytes(this.bytesUp)} ↓${fmtBytes(this.bytesDown)} ${c(C.dim, `(${total})`)}`);
  }
}

// ───────────────────────────────────────────────────────────────
//  Help
// ───────────────────────────────────────────────────────────────

function printHelp() {
  const b = color ? C.bold : '';
  const d = color ? C.dim : '';
  const r = color ? C.reset : '';

  console.log(`
${b}mc-proxy-host${r}  —  Host Agent  ${d}v${VERSION}${r}

Architecture:
  Client <-> Slave :25565 <-> TCP :25566 <-> ${b}Host :25566${r} <-> MC Server

The Host listens for Slave connections and relays to the real Minecraft server.

${b}USAGE${r}
  mc-proxy-host [options] [<host> [<port>]]

${b}OPTIONS${r}
  ${b}-t, --target${r} <host:port>   Target Minecraft server ${d}(default: localhost:25565)${r}
  ${b}-l, --listen${r} <port>        Listen for Slave connections ${d}(default: 25566)${r}
  ${b}-b, --bind${r} <address>       Bind address ${d}(default: 0.0.0.0)${r}
  ${b}-m, --max${r} <n>             Max concurrent tunnels ${d}(default: unlimited)${r}
  ${b}-v, --verbose${r}              Show hex-dump of tunnel traffic
  ${b}-s, --stats${r}               Show live statistics
  ${b}--no-color${r}                 Disable ANSI colored output
  ${b}--version${r}                  Print version
  ${b}-h, --help${r}                 Show this help

${b}EXAMPLES${r}
  mc-proxy-host -t localhost:25565              ${d}# Relay to local MC server${r}
  mc-proxy-host -t hypixel.net -l 25566 -v      ${d}# Verbose mode${r}
  mc-proxy-host -t play.example.com -m 100      ${d}# Limit tunnels${r}
`);
}

// ───────────────────────────────────────────────────────────────
//  Main
// ───────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) { printHelp(); return; }
  if (args.version) { console.log(`mc-proxy-host v${VERSION}`); return; }

  // Resolve target
  const target = parseTarget(args.target);
  if (!target) {
    die('No target specified. Use -t <host:port> or pass host/port as arguments.');
  }
  if (isNaN(target.port) || target.port < 1 || target.port > 65535) {
    die(`Invalid target port: ${target.port}`);
  }
  if (isNaN(args.listen) || args.listen < 1 || args.listen > 65535) {
    die(`Invalid listen port: ${args.listen}`);
  }

  const stats = new Stats();
  const v = args.verbose ? `${c(C.dim, ' +verbose')}${C.reset}` : '';
  const m = args.maxConnections > 0 ? ` max ${args.maxConnections}` : '';

  log('info', `${c(C.bold, 'mc-proxy-host')} ${c(C.dim, `v${VERSION}`)} ${c(C.cyan, `${target.host}:${target.port}`)}${v}${m}`);

  const server = net.createServer((slaveSocket) => {
    if (args.maxConnections > 0 && stats.activeConnections >= args.maxConnections) {
      log('warn', `max tunnels (${args.maxConnections}) reached, rejecting ${slaveSocket.remoteAddress}`);
      slaveSocket.end();
      return;
    }
    const session = new Session(slaveSocket, target, stats, args);
    session.start();
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') die(`Port ${args.listen} is already in use`);
      if (err.code === 'EACCES') die(`Permission denied — port ${args.listen} needs elevated privileges`);
      die(`Server error: ${err.message}`);
    });

    server.listen(args.listen, args.bind, () => {
      const addr = server.address();
      log('ok', `listening on ${c(C.bold, `${addr.address}:${addr.port}`)} ${c(C.green, '→')} ${c(C.cyan, `${target.host}:${target.port}`)}`);

      if (args.stats) setInterval(() => stats.display(), 10000);

      const shutdown = () => {
        log('info', c(C.yellow, 'shutting down...'));
        server.close(() => {
          if (stats.activeConnections > 0) {
            log('info', `waiting for ${stats.activeConnections} active tunnel(s) to close...`);
          }
          stats.display();
          log('ok', 'goodbye');
          resolve();
        });
        setTimeout(() => { log('warn', 'force exit'); process.exit(0); }, 5000);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  });
}

main().catch(err => die(err.message));
