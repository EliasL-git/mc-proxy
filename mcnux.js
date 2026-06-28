#!/usr/bin/env node

/**
 * mcnux — Minecraft Proxy CLI
 * ===========================
 * Two-agent proxy: connect (Host) + serve (Slave).
 *
 * Architecture:
 *   Client <-> Slave :25565 <-> TCP :25566 <-> Host :25566 <-> MC Server
 *
 * Commands:
 *   connect  <listen-addr> <target-addr>    Host — listen for Slave, forward to MC server
 *   serve    <listen-addr> <host-addr>      Slave — accept clients, relay through Host
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
  reset: '\x1b[0m',    bold: '\x1b[1m',    dim: '\x1b[2m',
  red: '\x1b[31m',     green: '\x1b[32m',  yellow: '\x1b[33m',
  blue: '\x1b[34m',    magenta: '\x1b[35m', cyan: '\x1b[36m',
  gray: '\x1b[90m',    white: '\x1b[37m',
};

let color = true;
function ts() {
  const d = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return color ? `${C.gray}${d}${C.reset}` : d;
}
function c(code, text) { return color ? `${code}${text}${C.reset}` : text; }

// ───────────────────────────────────────────────────────────────
//  Logger
// ───────────────────────────────────────────────────────────────

const LOG_TAGS = {
  info:  { t: ' ▶',  c: C.blue },
  ok:    { t: ' ✓',  c: C.green },
  warn:  { t: ' ⚠',  c: C.yellow },
  error: { t: ' ✗',  c: C.red },
  conn:  { t: ' ➜',  c: C.cyan },
  disc:  { t: ' ✗',  c: C.magenta },
  data:  { t: ' ·',  c: C.gray },
  stat:  { t: ' ■',  c: C.white },
};

function log(level, msg, extra = '') {
  const l = LOG_TAGS[level] || LOG_TAGS.info;
  console.log(`${ts()} ${c(l.c, l.t)} ${msg}${extra ? ' ' + extra : ''}`);
}
function raw(t) { console.log(t); }
function die(msg) { console.error(color ? `${C.red}✗${C.reset} ${msg}` : `✗ ${msg}`); process.exit(1); }

// ───────────────────────────────────────────────────────────────
//  Utilities
// ───────────────────────────────────────────────────────────────

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
function fmtRate(n) { return `${fmtBytes(n)}/s`; }

function parseAddr(str) {
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

function fmtAddr(a) { return `${a.host}:${a.port}`; }

// ───────────────────────────────────────────────────────────────
//  Hex Dump
// ───────────────────────────────────────────────────────────────

function hexDump(buf) {
  const lines = [];
  for (let i = 0; i < buf.length; i += 16) {
    const slice = buf.slice(i, Math.min(i + 16, buf.length));
    const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(slice).map(b => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`  ${c(C.dim, i.toString(16).padStart(4, '0'))}  ${hex.padEnd(47)} \u2502${ascii}\u2502`);
  }
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────
//  Minecraft VarInt + Handshake Parser
// ───────────────────────────────────────────────────────────────

function readVarInt(buf, offset) {
  let result = 0, bytesRead = 0, byte;
  do {
    if (offset + bytesRead >= buf.length) return null;
    byte = buf[offset + bytesRead];
    result |= (byte & 0x7F) << (7 * bytesRead);
    bytesRead++;
    if (bytesRead > 5) return null;
  } while (byte & 0x80);
  return { value: result, bytesRead };
}

function readString(buf, offset) {
  const len = readVarInt(buf, offset);
  if (!len) return null;
  const start = offset + len.bytesRead;
  const end = start + len.value;
  if (end > buf.length) return null;
  return { value: buf.toString('utf8', start, end), bytesRead: len.bytesRead + len.value };
}

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
//  Stats
// ───────────────────────────────────────────────────────────────

class Stats {
  constructor(label) {
    this.label = label;
    this.total = 0;
    this.active = 0;
    this.idCounter = 0;
    this.bytesUp = 0;
    this.bytesDown = 0;
    this.start = Date.now();
    this._lu = 0; this._ld = 0; this._lt = Date.now();
  }

  open() { this.total++; this.active++; this.idCounter++; return this.idCounter; }
  close() { this.active--; }
  up(n) { this.bytesUp += n; }
  down(n) { this.bytesDown += n; }

  rate() {
    const now = Date.now();
    const e = (now - this._lt) / 1000;
    if (e < 0.1) return { up: 0, down: 0 };
    const r = { up: Math.round((this.bytesUp - this._lu) / e), down: Math.round((this.bytesDown - this._ld) / e) };
    this._lu = this.bytesUp; this._ld = this.bytesDown; this._lt = now;
    return r;
  }

  uptime() { return Math.floor((Date.now() - this.start) / 1000); }

  display() {
    const ru = this.uptime();
    const h = Math.floor(ru / 3600), m = Math.floor((ru % 3600) / 60), s = ru % 60;
    const u = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
    const rt = this.rate();
    log('stat', `${c(C.bold, this.label)} stats:`);
    log('stat', `  Uptime:   ${u}`);
    log('stat', `  Active:   ${c(C.cyan, String(this.active))} connections`);
    log('stat', `  Total:    ${this.total} connections`);
    log('stat', `  Up:       ${fmtBytes(this.bytesUp)} ${c(C.dim, `(${fmtRate(rt.up)})`)}`);
    log('stat', `  Down:     ${fmtBytes(this.bytesDown)} ${c(C.dim, `(${fmtRate(rt.down)})`)}`);
  }
}

// ───────────────────────────────────────────────────────────────
//  Session — relays data between two sockets
// ───────────────────────────────────────────────────────────────

function bridgeSockets(id, sockA, sockB, labelA, labelB, verbose) {
  let closed = false;
  let bytesAtoB = 0, bytesBtoA = 0;

  function cleanup() {
    if (closed) return;
    closed = true;
    if (!sockA.destroyed) { sockA.end(); sockA.destroy(); }
    if (!sockB.destroyed) { sockB.end(); sockB.destroy(); }
  }

  function pipe(src, dst, dir, label) {
    src.on('data', (data) => {
      if (closed) return;
      if (dir === 'up') bytesAtoB += data.length;
      else bytesBtoA += data.length;

      if (verbose) {
        log('data', c(dir === 'up' ? C.blue : C.magenta, `[${id}] ${dir === 'up' ? '↑' : '↓'} ${data.length} bytes ${label}`));
        raw(hexDump(data));
      }
      if (dst.writable) dst.write(data);
    });
  }

  pipe(sockA, sockB, 'up', labelA);
  pipe(sockB, sockA, 'down', labelB);

  sockA.once('close', () => { if (!closed) { cleanup(); } });
  sockA.once('error', (e) => { if (!closed) { log('error', `[${id}] ${labelA} error: ${e.message}`); cleanup(); } });
  sockB.once('close', () => { if (!closed) { cleanup(); } });
  sockB.once('error', (e) => { if (!closed) { log('error', `[${id}] ${labelB} error: ${e.message}`); cleanup(); } });

  return {
    getBytesUp: () => bytesAtoB,
    getBytesDown: () => bytesBtoA,
    cleanup,
    isClosed: () => closed,
  };
}

// ───────────────────────────────────────────────────────────────
//  CONNECT command — Host mode
//  Listens for Slave connections, relays to MC server
// ───────────────────────────────────────────────────────────────

function runConnect(listenAddr, targetAddr, opts) {
  const stats = new Stats('mcnux connect');
  const verbose = opts.verbose;

  log('info', `${c(C.bold, 'mcnux connect')} ${c(C.dim, `v${VERSION}`)}`);
  log('info', `  listen for Slave → ${c(C.cyan, fmtAddr(listenAddr))}`);
  log('info', `  forward to MC    → ${c(C.cyan, fmtAddr(targetAddr))}`);

  const server = net.createServer((slaveSock) => {
    const id = stats.open();
    const slaveAddr = `${slaveSock.remoteAddress}:${slaveSock.remotePort}`;
    log('conn', `[${id}] Slave connected ${c(C.cyan, slaveAddr)}`, c(C.dim, 'connecting to MC server...'));

    const resolveStart = Date.now();
    dns.lookup(targetAddr.host, { all: false }, (err, address) => {
      if (err) {
        log('error', `[${id}] DNS failed for ${targetAddr.host}: ${err.message}`);
        slaveSock.end(); stats.close(); return;
      }
      const resolveMs = Date.now() - resolveStart;
      if (resolveMs > 50) log('warn', `[${id}] DNS lookup took ${resolveMs}ms (${targetAddr.host} → ${address})`);

      const mcSock = new net.Socket();
      mcSock.once('error', (e) => {
        if (mcSock.destroyed) return;
        log('error', `[${id}] MC server ${fmtAddr(targetAddr)}: ${e.message}`);
        slaveSock.end(); stats.close();
      });

      mcSock.connect(targetAddr.port, address, () => {
        if (slaveSock.destroyed) return;
        log('ok', `[${id}] tunnel ${c(C.green, fmtAddr(targetAddr))}`);

        const bridge = bridgeSockets(id, slaveSock, mcSock,
          `Slave ${slaveAddr}`, `MC ${fmtAddr(targetAddr)}`, verbose);

        slaveSock.once('close', () => {
          if (bridge.isClosed()) return;
          log('disc', `[${id}] Slave disconnected ${c(C.dim, slaveAddr)}`);
          stats.close();
          stats.up(bridge.getBytesUp());
          stats.down(bridge.getBytesDown());
          log('info', `[${id}] tunnel closed — ↑${fmtBytes(bridge.getBytesUp())} ↓${fmtBytes(bridge.getBytesDown())}`);
          bridge.cleanup();
        });

        mcSock.once('close', () => {
          if (bridge.isClosed()) return;
          log('disc', `[${id}] MC server disconnected`);
          stats.close();
          stats.up(bridge.getBytesUp());
          stats.down(bridge.getBytesDown());
          log('info', `[${id}] tunnel closed — ↑${fmtBytes(bridge.getBytesUp())} ↓${fmtBytes(bridge.getBytesDown())}`);
          bridge.cleanup();
        });
      });
    });
  });

  return startServer(server, listenAddr, stats, 'connect');
}

// ───────────────────────────────────────────────────────────────
//  SERVE command — Slave mode
//  Listens for Minecraft clients, relays to Host
// ───────────────────────────────────────────────────────────────

function runServe(listenAddr, hostAddr, opts) {
  const stats = new Stats('mcnux serve');
  const verbose = opts.verbose;

  log('info', `${c(C.bold, 'mcnux serve')} ${c(C.dim, `v${VERSION}`)}`);
  log('info', `  listen for clients → ${c(C.cyan, fmtAddr(listenAddr))}`);
  log('info', `  relay through Host → ${c(C.cyan, fmtAddr(hostAddr))}`);

  const server = net.createServer((clientSock) => {
    const id = stats.open();
    const clientAddr = `${clientSock.remoteAddress}:${clientSock.remotePort}`;
    log('conn', `[${id}] client connected ${c(C.cyan, clientAddr)}`, c(C.dim, 'connecting to Host...'));

    // Parse Minecraft handshake from first data
    let handshakeLogged = false;

    // Connect to Host
    const hostSock = new net.Socket();
    hostSock.once('error', (e) => {
      if (hostSock.destroyed) return;
      log('error', `[${id}] Host ${fmtAddr(hostAddr)}: ${e.message}`);
      clientSock.end(); stats.close();
    });

    hostSock.connect(hostAddr.port, hostAddr.host, () => {
      if (clientSock.destroyed) return;
      log('ok', `[${id}] connected to Host ${c(C.green, fmtAddr(hostAddr))}`);

      const bridge = bridgeSockets(id, clientSock, hostSock,
        `client ${clientAddr}`, `Host ${fmtAddr(hostAddr)}`, verbose);

      clientSock.on('data', (data) => {
        // Parse handshake on first client data
        if (!handshakeLogged) {
          const hs = parseHandshake(data);
          if (hs) {
            handshakeLogged = true;
            const stateColor = hs.nextState === 2 ? C.green : C.yellow;
            log('info', `[${id}] handshake: proto=${c(C.cyan, hs.protocolVersion)} server=${c(C.bold, hs.serverAddress)}:${hs.serverPort} next=${c(stateColor, hs.nextStateName)}`);
          }
        }
      });

      clientSock.once('close', () => {
        if (bridge.isClosed()) return;
        log('disc', `[${id}] client disconnected ${c(C.dim, clientAddr)}`);
        stats.close();
        stats.up(bridge.getBytesUp());
        stats.down(bridge.getBytesDown());
        log('info', `[${id}] session closed — ↑${fmtBytes(bridge.getBytesUp())} ↓${fmtBytes(bridge.getBytesDown())}`);
        bridge.cleanup();
      });

      hostSock.once('close', () => {
        if (bridge.isClosed()) return;
        log('disc', `[${id}] Host disconnected`);
        stats.close();
        stats.up(bridge.getBytesUp());
        stats.down(bridge.getBytesDown());
        log('info', `[${id}] session closed — ↑${fmtBytes(bridge.getBytesUp())} ↓${fmtBytes(bridge.getBytesDown())}`);
        bridge.cleanup();
      });
    });
  });

  return startServer(server, listenAddr, stats, 'serve');
}

// ───────────────────────────────────────────────────────────────
//  Server runner (shared between connect/serve)
// ───────────────────────────────────────────────────────────────

function startServer(server, listenAddr, stats, cmd) {
  return new Promise((resolve) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') die(`Port ${listenAddr.port} is already in use`);
      if (err.code === 'EACCES') die(`Permission denied — port ${listenAddr.port} needs elevated privileges`);
      die(`Server error: ${err.message}`);
    });

    server.listen(listenAddr.port, listenAddr.host, () => {
      log('ok', `listening on ${c(C.bold, fmtAddr(listenAddr))}`);
      if (cmd === 'serve') {
        log('ok', `players join this IP on port ${c(C.cyan, String(listenAddr.port))}`);
      }

      const statsInterval = setInterval(() => stats.display(), 10000);

      const shutdown = () => {
        clearInterval(statsInterval);
        log('info', c(C.yellow, 'shutting down...'));
        server.close(() => {
          if (stats.active > 0) log('info', `draining ${stats.active} active connection(s)...`);
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

// ───────────────────────────────────────────────────────────────
//  CLI
// ───────────────────────────────────────────────────────────────

function help() {
  const b = color ? C.bold : '';
  const d = color ? C.dim : '';
  const r = color ? C.reset : '';

  console.log(`
${b}mcnux${r}  —  Minecraft Proxy CLI  ${d}v${VERSION}${r}

Architecture:
  Client <-> Slave :25565 <-> Host :25566 <-> MC Server

${b}COMMANDS${r}

  ${b}connect${r} <listen-addr> <target-addr>    Host mode
    Listen for Slave connections, forward to the real Minecraft server.
    Run this on the machine that can reach the MC server.

    ${d}Examples:${r}
      mcnux connect 0.0.0.0:25566 localhost:25565
      mcnux connect 0.0.0.0:25566 play.hypixel.net

  ${b}serve${r} <listen-addr> <host-addr>        Slave mode
    Accept Minecraft clients, relay all traffic through the Host.
    Run this on a public-facing machine.

    ${d}Examples:${r}
      mcnux serve 0.0.0.0:25565 10.0.0.1:25566
      mcnux serve 0.0.0.0:25565 host.example.com:25566

${b}OPTIONS${r}
  -v, --verbose              Show hex-dump of packet traffic
  --no-color                 Disable ANSI colors
  -h, --help                 Show help
  --version                  Print version

${b}HOW IT WORKS${r}
  Players connect to the ${b}Slave's${r} IP/port. The Slave tunnels everything
  through the ${b}Host${r} to the real Minecraft server.

  Start the Host first, then the Slave:
    ${d}# Machine A (near MC server):${r}
    $ mcnux connect 0.0.0.0:25566 localhost:25565

    ${d}# Machine B (public-facing):${r}
    $ mcnux serve 0.0.0.0:25565 10.0.0.1:25566
`);
}

function showCmdHelp(cmd) {
  const b = color ? C.bold : '';
  const d = color ? C.dim : '';
  const r = color ? C.reset : '';

  if (cmd === 'connect') {
    console.log(`
${b}mcnux connect${r}  —  Host mode

Listen for Slave connections, forward to the real Minecraft server.
Run this on the machine that can reach the MC server.

${b}Usage:${r}
  mcnux connect <listen-addr> <target-addr>

  <listen-addr>    Address to listen for Slave connections   ${d}(default port: 25566)${r}
  <target-addr>    Minecraft server to forward to            ${d}(default: localhost:25565)${r}

${b}Examples:${r}
  mcnux connect 0.0.0.0:25566 localhost:25565
  mcnux connect 0.0.0.0:25566 play.hypixel.net
  mcnux connect 0.0.0.0:25566 192.168.1.10:25565
`);
  } else if (cmd === 'serve') {
    console.log(`
${b}mcnux serve${r}  —  Slave mode

Accept Minecraft clients, relay all traffic through the Host.
Run this on a public-facing machine that players can connect to.

${b}Usage:${r}
  mcnux serve <listen-addr> <host-addr>

  <listen-addr>    Address to listen for Minecraft clients   ${d}(default port: 25565)${r}
  <host-addr>      Host address to relay through             ${d}(default: localhost:25566)${r}

${b}Examples:${r}
  mcnux serve 0.0.0.0:25565 host.example.com:25566
  mcnux serve 0.0.0.0:25565 10.0.0.1:25566
  mcnux serve :25565 192.168.1.5:25566
`);
  } else {
    help();
  }
}

function printVersion() { console.log(`mcnux v${VERSION}`); }

function main() {
  const args = process.argv.slice(2);

  // Parse global flags
  let argIdx = 0;
  while (argIdx < args.length && args[argIdx].startsWith('-')) {
    const flag = args[argIdx];
    if (flag === '--no-color') { color = false; argIdx++; }
    else if (flag === '-h' || flag === '--help') { help(); return; }
    else if (flag === '--version') { printVersion(); return; }
    else if (flag === '-v' || flag === '--verbose') {
      // Will be passed to subcommand
      break;
    }
    else break;
  }

  const cmd = args[argIdx];
  const cmdArgs = args.slice(argIdx + 1);

  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    help();
    return;
  }

  if (cmd === 'version' || cmd === '--version') {
    printVersion();
    return;
  }

  // Parse shared opts from remaining flags
  const opts = { verbose: false };
  const positional = [];
  for (let i = 0; i < cmdArgs.length; i++) {
    const a = cmdArgs[i];
    if (a === '-v' || a === '--verbose') opts.verbose = true;
    else if (a === '--no-color') color = false;
    else if (a === '-h' || a === '--help') { showCmdHelp(cmd); return; }
    else if (a.startsWith('-')) die(`Unknown option: ${a}`);
    else positional.push(a);
  }

  switch (cmd) {
    case 'connect': {
      if (positional.length < 1) die('Usage: mcnux connect <listen-addr> <target-addr>\n  Example: mcnux connect 0.0.0.0:25566 localhost:25565');
      const listenAddr = parseAddr(positional[0]);
      if (!listenAddr || isNaN(listenAddr.port) || listenAddr.port < 1) die(`Invalid listen address: ${positional[0]}`);
      const targetAddr = parseAddr(positional[1] || 'localhost:25565');
      if (!targetAddr || isNaN(targetAddr.port) || targetAddr.port < 1) die(`Invalid target address: ${positional[1] || 'localhost:25565'}`);
      runConnect(listenAddr, targetAddr, opts);
      break;
    }

    case 'serve': {
      if (positional.length < 1) die('Usage: mcnux serve <listen-addr> <host-addr>\n  Example: mcnux serve 0.0.0.0:25565 host.example.com:25566');
      const listenAddr = parseAddr(positional[0]);
      if (!listenAddr || isNaN(listenAddr.port) || listenAddr.port < 1) die(`Invalid listen address: ${positional[0]}`);
      const hostAddr = parseAddr(positional[1] || 'localhost:25566');
      if (!hostAddr || isNaN(hostAddr.port) || hostAddr.port < 1) die(`Invalid host address: ${positional[1] || 'localhost:25566'}`);
      runServe(listenAddr, hostAddr, opts);
      break;
    }

    default:
      die(`Unknown command: ${cmd}\n  Usage: mcnux connect ...  or  mcnux serve ...`);
  }
}

main();
