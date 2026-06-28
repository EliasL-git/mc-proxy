#!/usr/bin/env node

/**
 * mcnux — Minecraft Proxy CLI
 * ===========================
 * Two-agent proxy with connection approval.
 *
 * Architecture:
 *   Player → Slave :25565 (pending) → Host (approves) → Slave tunnels to Host data listener → MC Server
 *
 * Commands:
 *   host   <slave-host> <control-port>    Admin — connect to Slave, approve/deny connections
 *   serve  [player-port] [control-port]   Public — accept players, queue for approval
 *
 * MIT License
 */

'use strict';

const net = require('net');
const readline = require('readline');

// ───────────────────────────────────────────────────────────────
//  Version
// ───────────────────────────────────────────────────────────────

const VERSION = '2.0.0';

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
function die(msg) { console.error(color ? `${C.red}✗${C.reset} ${msg}` : `✗ ${msg}`); process.exit(1); }

// ───────────────────────────────────────────────────────────────
//  Utilities
// ───────────────────────────────────────────────────────────────

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function parseAddr(str, defaultPort = 25565) {
  if (!str) return null;
  const colon = str.lastIndexOf(':');
  if (colon === -1) return { host: str, port: defaultPort };
  const host = str.slice(0, colon);
  const portStr = colon > 0 && str[colon - 1] === ']'
    ? str.slice(str.lastIndexOf(']:') + 2)
    : str.slice(colon + 1);
  const port = parseInt(portStr, 10);
  if (isNaN(port)) return { host: str, port: defaultPort };
  return { host: host || 'localhost', port };
}

function fmtAddr(a) { return `${a.host}:${a.port}`; }

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

/**
 * Attempt to extract player name from buffered MC packets.
 * Looks for login start packet (0x00 in login state) which has a string field.
 * Best-effort — returns null if not found yet.
 */
function extractPlayerName(buf) {
  let offset = 0;
  while (offset < buf.length) {
    const packetLen = readVarInt(buf, offset);
    if (!packetLen) break;
    offset += packetLen.bytesRead;
    if (offset >= buf.length) break;
    const packetId = readVarInt(buf, offset);
    if (!packetId) break;
    if (packetId.value === 0x00 && offset + 3 < buf.length) {
      // Could be login start — try reading a string
      const name = readString(buf, offset + packetId.bytesRead);
      if (name && name.value && name.value.length > 0 && name.value.length <= 16) {
        return name.value;
      }
    }
    // Skip this packet
    offset += packetLen.value - packetLen.bytesRead + packetId.bytesRead;
  }
  return null;
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
//  Bridge — pipes data between two sockets
// ───────────────────────────────────────────────────────────────

function bridgeSockets(sockA, sockB, onStats) {
  let closed = false;
  let aToB = 0, bToA = 0;

  function cleanup() {
    if (closed) return;
    closed = true;
    if (!sockA.destroyed) { sockA.end(); sockA.destroy(); }
    if (!sockB.destroyed) { sockB.end(); sockB.destroy(); }
  }

  function pipe(src, dst, dir) {
    src.on('data', (data) => {
      if (closed) return;
      if (dir === 'up') aToB += data.length;
      else bToA += data.length;
      if (dst.writable) dst.write(data);
    });
  }

  pipe(sockA, sockB, 'up');
  pipe(sockB, sockA, 'down');

  sockA.once('close', cleanup);
  sockA.once('error', cleanup);
  sockB.once('close', cleanup);
  sockB.once('error', cleanup);

  return {
    cleanup,
    bytesUp: () => aToB,
    bytesDown: () => bToA,
    isClosed: () => closed,
  };
}

// ───────────────────────────────────────────────────────────────
//  SERVE — Slave mode
//  Listens for Minecraft players, connects to plugin control server
//  Protocol: JSON lines over TCP
// ───────────────────────────────────────────────────────────────

function runServe(playerPort, pluginHost, pluginPort, opts) {
  const verbose = opts.verbose;

  // ── Slave State ──────────────────────────────────────────
  let hostControlSock = null;          // socket to plugin control server
  const pendingConns = new Map();      // id -> { id, playerSock, playerAddr, bytes, handshake }
  const activeConns = new Map();       // id -> { id, playerSock, tunnelSock, bridge, bytes, handshake }
  let connIdCounter = 0;

  // Track bytes in active tunnels
  const tunnelBytes = { up: 0, down: 0 };

  function genConnId() { return String(++connIdCounter); }

  function sendToHost(msg) {
    if (!hostControlSock || hostControlSock.destroyed) return;
    try { hostControlSock.write(msg + '\n'); } catch (_) {}
  }

  // ── Connect to Plugin Control Server ─────────────────────
  function connectToPlugin() {
    log('info', `Connecting to plugin at ${c(C.cyan, `${pluginHost}:${pluginPort}`)}...`);

    const sock = new net.Socket();
    let buf = '';

    sock.connect(pluginPort, pluginHost, () => {
      log('ok', `Connected to plugin control server at ${c(C.cyan, `${pluginHost}:${pluginPort}`)}`);
      hostControlSock = sock;
    });

    sock.on('data', (chunk) => {
      buf += chunk.toString();
      while (buf.includes('\n')) {
        const nlIdx = buf.indexOf('\n');
        const line = buf.slice(0, nlIdx).trim();
        buf = buf.slice(nlIdx + 1);
        if (!line) continue;
        handleControlMsg(line);
      }
    });

    sock.once('close', () => {
      log('warn', 'Plugin disconnected');
      hostControlSock = null;
      // Kill all pending connections
      for (const [id, p] of pendingConns) {
        p.playerSock.end('Connection rejected: plugin disconnected\n');
        p.playerSock.destroy();
        pendingConns.delete(id);
      }
      // Retry connection after 5 seconds
      log('info', 'Reconnecting in 5s...');
      setTimeout(connectToPlugin, 5000);
    });

    sock.once('error', (e) => {
      log('error', `Plugin control error: ${e.message}`);
      hostControlSock = null;
      setTimeout(connectToPlugin, 5000);
    });
  }

  // Start connection
  connectToPlugin();

  function handleControlMsg(line) {
    // Parse JSON from plugin
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      sendToHost(JSON.stringify({ type: 'error', message: 'Invalid JSON: ' + e.message }));
      return;
    }

    switch (msg.type) {
      case 'hello': {
        // Plugin tells us its MC server port — we tunnel directly to it
        const mcPort = msg.port;
        if (!mcPort) {
          sendToHost(JSON.stringify({ type: 'error', message: 'HELLO missing port' }));
          return;
        }

        // The tunnel target is the plugin's address (home server IP)
        // remoteAddress comes as "::ffff:123.45.67.89:25567" — strip [host]:port
        let tunnelHost;
        if (hostControlSock.remoteAddress.startsWith('::ffff:')) {
            // IPv4-mapped IPv6: ::ffff:x.x.x.x
          tunnelHost = hostControlSock.remoteAddress.replace(/^::ffff:/, '');
        } else {
          // Plain IPv4: "1.2.3.4"
          tunnelHost = hostControlSock.remoteAddress;
        }
        // Strip port if present
        const lastColon = tunnelHost.lastIndexOf(':');
        if (lastColon >= 0) tunnelHost = tunnelHost.substring(0, lastColon);

        hostControlSock._mcTarget = { host: tunnelHost, port: mcPort };
        log('ok', `Tunnel target: ${c(C.cyan, `${tunnelHost}:${mcPort}`)} — ready for approvals`);
        break;
      }

      case 'approve': {
        const connId = msg.connId;
        const pending = pendingConns.get(connId);
        if (!pending) {
          sendToHost(JSON.stringify({ type: 'error', message: `Connection ${connId} not found` }));
          return;
        }
        pendingConns.delete(connId);

        if (!hostControlSock._mcTarget) {
          pending.playerSock.end('Proxy error: host not ready\n');
          pending.playerSock.destroy();
          sendToHost(JSON.stringify({ type: 'error', message: `No MC target for ${connId}` }));
          return;
        }

        // Connect tunnel directly to the MC server (localhost on the plugin machine)
        const tunnelSock = new net.Socket();
        const mcTarget = hostControlSock._mcTarget;

        tunnelSock.once('error', (e) => {
          log('error', `[${connId}] tunnel to MC ${fmtAddr(mcTarget)}: ${e.message}`);
          pending.playerSock.end('Proxy error: tunnel failed\n');
          pending.playerSock.destroy();
          sendToHost(JSON.stringify({ type: 'error', message: `Tunnel failed: ${e.message}`, connId }));
        });

        tunnelSock.connect(mcTarget.port, mcTarget.host, () => {
          log('ok', `[${connId}] tunnel established to MC ${c(C.green, fmtAddr(mcTarget))}`);

          // Remove buffering listener and flush buffered data
          pending.playerSock.removeListener('data', pending.onPlayerData);
          for (const chunk of pending.buffer) {
            if (tunnelSock.writable) tunnelSock.write(chunk);
          }

          // Bridge player ↔ MC server
          const bridge = bridgeSockets(pending.playerSock, tunnelSock);

          const session = {
            id: connId,
            playerSock: pending.playerSock,
            tunnelSock,
            bridge,
            handshake: pending.handshake,
            playerAddr: pending.playerAddr,
          };
          activeConns.set(connId, session);

          pending.playerSock.once('close', () => {
            if (bridge.isClosed()) return;
            tunnelBytes.up += bridge.bytesUp();
            tunnelBytes.down += bridge.bytesDown();
            activeConns.delete(connId);
            log('disc', `[${connId}] player disconnected ${c(C.dim, pending.playerAddr)}`);
            bridge.cleanup();
          });

          tunnelSock.once('close', () => {
            if (bridge.isClosed()) return;
            tunnelBytes.up += bridge.bytesUp();
            tunnelBytes.down += bridge.bytesDown();
            activeConns.delete(connId);
            log('disc', `[${connId}] tunnel closed`);
            bridge.cleanup();
          });

          const hs = pending.handshake;
          if (hs) {
            log('info', `[${connId}] tunnel active — ${c(C.dim, `${pending.playerAddr} → ${mcTarget.host}:${mcTarget.port}`)}`);
          }
        });
        break;
      }

      case 'deny': {
        const connId = msg.connId;
        const pending = pendingConns.get(connId);
        if (!pending) {
          sendToHost(JSON.stringify({ type: 'error', message: `Connection ${connId} not found` }));
          return;
        }
        pendingConns.delete(connId);
        pending.playerSock.end('Connection rejected by administrator\n');
        pending.playerSock.destroy();
        log('info', `[${connId}] denied ${c(C.dim, pending.playerAddr)}`);
        break;
      }

      default:
        sendToHost(JSON.stringify({ type: 'error', message: `Unknown type: ${msg.type}` }));
    }
  }

  // ── Player Server ─────────────────────────────────────────
  const playerServer = net.createServer((playerSock) => {
    if (!hostControlSock || hostControlSock.destroyed) {
      playerSock.end('Proxy: no host connected — try again later\n');
      playerSock.destroy();
      return;
    }

    const id = genConnId();
    const playerAddr = `${playerSock.remoteAddress}:${playerSock.remotePort}`;
    log('conn', `[${id}] player connected ${c(C.cyan, playerAddr)}`, c(C.dim, 'queued for approval'));

    // Buffer all player data while pending for replay after approval
    const playerBuf = [];
    let playerName = null;

    function onPlayerData(data) {
      const buf = Buffer.concat([...playerBuf, data]);
      // Try to extract player name from login start packet (after handshake)
      // Login start packet (0x00) contains the player name
      const extracted = extractPlayerName(buf);
      if (extracted) playerName = extracted;

      playerBuf.push(data);
    }
    playerSock.on('data', onPlayerData);

    // Create pending session
    const pending = {
      id,
      playerSock,
      playerAddr,
      handshake: null,
      bytes: 0,
      buffer: playerBuf,
      onPlayerData,
    };
    pendingConns.set(id, pending);

    // Send JSON connect request to plugin control server
    // playerName may be 'unknown' if we haven't parsed the login packet yet
    const connectMsg = JSON.stringify({
      type: 'connect',
      connId: id,
      playerName: playerName || 'unknown',
      playerUuid: 'unknown', // not available until online-mode auth
      playerIp: playerSock.remoteAddress?.replace(/^::ffff:/, '') || '0.0.0.0',
      playerPort: playerSock.remotePort || 0,
      proxyHost: playerAddr,
    }) + '\n';
    sendToHost(connectMsg);

    // Handle player disconnect while pending
    playerSock.once('close', () => {
      if (pendingConns.has(id)) {
        pendingConns.delete(id);
        log('disc', `[${id}] player disconnected (pending) ${c(C.dim, playerAddr)}`);
        sendToHost(JSON.stringify({ type: 'disconnect', connId: id }) + '\n');
      }
    });

    playerSock.once('error', (e) => {
      if (pendingConns.has(id)) {
        pendingConns.delete(id);
        log('error', `[${id}] player error: ${e.message}`);
        sendToHost(JSON.stringify({ type: 'disconnect', connId: id }));
      }
    });

    // Timeout pending connections after 2 minutes
    setTimeout(() => {
      if (pendingConns.has(id)) {
        pendingConns.delete(id);
        playerSock.end('Connection timed out awaiting approval\n');
        playerSock.destroy();
        log('warn', `[${id}] pending timeout ${c(C.dim, playerAddr)}`);
      }
    }, 120000);
  });

  // ── Start Servers ─────────────────────────────────────────
  let shutdownTimer = null;

  function shutdown() {
    log('info', c(C.yellow, 'shutting down...'));

    // Close player server (no new connections)
    playerServer.close(() => {});

    // Close control server
    controlServer.close(() => {});

    // Close all pending connections
    for (const [id, p] of pendingConns) {
      p.playerSock.end('Proxy shutting down\n');
      p.playerSock.destroy();
      pendingConns.delete(id);
    }

    // Close all active tunnels
    for (const [id, s] of activeConns) {
      s.bridge.cleanup();
      activeConns.delete(id);
    }

    // Disconnect Host
    if (hostControlSock && !hostControlSock.destroyed) {
      hostControlSock.end();
      hostControlSock.destroy();
    }

    log('ok', 'goodbye');
    clearTimeout(shutdownTimer);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start player server
  playerServer.listen(playerPort, '0.0.0.0', () => {
    log('ok', `Slave listening for players on ${c(C.bold, `:${playerPort}`)}`);
    log('info', `Players connect to this machine on port ${c(C.cyan, String(playerPort))}`);
    log('info', `Connecting to plugin control at ${c(C.cyan, `${pluginHost}:${pluginPort}`)}`);
  });

  playerServer.once('error', (err) => {
    if (err.code === 'EADDRINUSE') die(`Port ${playerPort} is already in use`);
    die(`Player server error: ${err.message}`);
  });

  // Stats display
  setInterval(() => {
    if (activeConns.size > 0 || pendingConns.size > 0) {
      log('stat', `active: ${c(C.cyan, String(activeConns.size))}  pending: ${c(C.yellow, String(pendingConns.size))}  up: ${fmtBytes(tunnelBytes.up)}  down: ${fmtBytes(tunnelBytes.down)}`);
    }
  }, 15000);

  return new Promise((resolve) => {
    shutdownTimer = setTimeout(() => {}, 1 << 30); // dummy
    process.on('SIGINT', () => resolve());
    process.on('SIGTERM', () => resolve());
  });
}

// ───────────────────────────────────────────────────────────────
//  HOST — Admin mode
//  Connects to Slave's control port, interactive approval CLI
// ───────────────────────────────────────────────────────────────

function runHost(slaveAddr, opts) {
  const mcTarget = parseAddr(opts.mcTarget || 'localhost:25565');

  log('info', `${c(C.bold, 'mcnux host')} ${c(C.dim, `v${VERSION}`)}`);
  log('info', `  Slave control     → ${c(C.cyan, fmtAddr(slaveAddr))}`);
  log('info', `  MC server target  → ${c(C.cyan, fmtAddr(mcTarget))}`);

  // ── Data Listener (Slave connects here for tunnels) ──────
  const dataServer = net.createServer((tunnelSock) => {
    let hdrBuf = Buffer.alloc(0);
    let connId = null;
    let headerDone = false;
    const pendingData = [];
    let mcSock = null;
    let tunnelBridge = null;

    function onTunnelData(chunk) {
      if (!headerDone) {
        hdrBuf = Buffer.concat([hdrBuf, chunk]);
        const nlIdx = hdrBuf.indexOf(10); // \n
        if (nlIdx === -1) return; // need more data

        connId = hdrBuf.slice(0, nlIdx).toString('utf8');
        const remaining = hdrBuf.slice(nlIdx + 1);
        hdrBuf = null;
        headerDone = true;

        log('info', `[${connId}] tunnel connected from Slave`);

        // Buffer data that arrived with the header
        if (remaining.length > 0) pendingData.push(remaining);

        // Connect to MC server
        mcSock = new net.Socket();
        mcSock.once('error', (e) => {
          log('error', `[${connId}] MC server ${fmtAddr(mcTarget)}: ${e.message}`);
          if (tunnelBridge) tunnelBridge.cleanup();
          else { tunnelSock.end(); tunnelSock.destroy(); }
        });

        mcSock.connect(mcTarget.port, mcTarget.host, () => {
          log('ok', `[${connId}] tunnel → MC ${c(C.green, fmtAddr(mcTarget))}`);

          // Flush pending data that arrived before MC connection
          for (const d of pendingData) {
            if (mcSock.writable) mcSock.write(d);
          }
          pendingData.length = 0;

          // Remove header parser before bridge takes over
          tunnelSock.removeListener('data', onTunnelData);

          // Bridge
          tunnelBridge = bridgeSockets(tunnelSock, mcSock);

          tunnelSock.once('close', () => {
            if (tunnelBridge && !tunnelBridge.isClosed()) {
              log('disc', `[${connId}] tunnel closed`);
              tunnelBridge.cleanup();
            }
          });

          mcSock.once('close', () => {
            if (tunnelBridge && !tunnelBridge.isClosed()) {
              log('disc', `[${connId}] MC server disconnected`);
              tunnelBridge.cleanup();
            }
          });
        });
        return;
      }

      // Header done but MC not yet connected — buffer
      pendingData.push(chunk);
    }

    tunnelSock.on('data', onTunnelData);
    tunnelSock.once('error', (e) => {
      if (!headerDone) log('error', `tunnel error before header: ${e.message}`);
    });
  });

  dataServer.once('error', (err) => {
    die(`Data listener error: ${err.message}`);
  });

  // ── Connect to Slave Control ──────────────────────────────
  const controlSock = new net.Socket();
  let controlBuf = '';
  let connected = false;

  function sendCtrl(msg) {
    if (!controlSock.destroyed) {
      try { controlSock.write(msg + '\n'); } catch (_) {}
    }
  }

  controlSock.on('data', (chunk) => {
    controlBuf += chunk.toString();
    while (controlBuf.includes('\n')) {
      const nlIdx = controlBuf.indexOf('\n');
      const line = controlBuf.slice(0, nlIdx).trim();
      controlBuf = controlBuf.slice(nlIdx + 1);
      if (!line) continue;
      handleCtrlMsg(line);
    }
  });

  let pendingConnections = [];  // { id, addr, handshake (optional) }
  let activeTunnels = new Map();

  function handleCtrlMsg(line) {
    const parts = line.split(' ');
    const cmd = parts[0];

    switch (cmd) {
      case 'OK': {
        log('ok', `Slave: ${parts.slice(1).join(' ')}`);
        break;
      }

      case 'ERROR': {
        log('error', `Slave: ${parts.slice(1).join(' ')}`);
        break;
      }

      case 'CONN_REQ': {
        // CONN_REQ <id> <playerAddr>
        const id = parts[1];
        const addr = parts.slice(2).join(' ');
        const entry = { id, addr, handshake: null };
        pendingConnections.push(entry);
        log('conn', `[${c(C.cyan, id)}] New connection from ${c(C.bold, addr)} ${c(C.dim, '— type "approve ' + id + '" to allow')}`);
        renderPrompt();
        break;
      }

      case 'HANDSHAKE': {
        // HANDSHAKE <id> <serverHost> <serverPort>
        const id = parts[1];
        const srvHost = parts[2];
        const srvPort = parseInt(parts[3], 10);
        const entry = pendingConnections.find(p => p.id === id);
        if (entry) {
          entry.handshake = `${srvHost}:${srvPort}`;
        }
        break;
      }

      case 'CONNS': {
        // CONNS <id>:<addr>[:<hs>] ...
        pendingConnections = [];
        for (let i = 1; i < parts.length; i++) {
          const segs = parts[i].split(':');
          if (segs.length >= 2) {
            pendingConnections.push({
              id: segs[0],
              addr: segs[1] + (segs[2] ? `:${segs[2]}` : ''),
              handshake: segs.slice(3).join(':') || null,
            });
          }
        }
        renderPrompt();
        break;
      }

      case 'CONN_LOST': {
        // CONN_LOST <id> [reason]
        const id = parts[1];
        const reason = parts.slice(2).join(' ') || 'disconnected';
        pendingConnections = pendingConnections.filter(p => p.id !== id);
        log('disc', `[${c(C.dim, id)}] ${reason}`);
        renderPrompt();
        break;
      }

      case 'ACTIVE': {
        // ACTIVE <id>:<addr> ...
        activeTunnels = new Map();
        for (let i = 1; i < parts.length; i++) {
          const segs = parts[i].split(':');
          if (segs.length >= 2) {
            activeTunnels.set(segs[0], segs.slice(1).join(':'));
          }
        }
        break;
      }

      case 'TUNNEL_CLOSE': {
        const id = parts[1];
        activeTunnels.delete(id);
        log('disc', `[${c(C.dim, id)}] tunnel closed`);
        renderPrompt();
        break;
      }

      default:
        log('info', `Slave: ${line}`);
    }
  }

  controlSock.once('close', () => {
    log('error', c(C.red, 'Lost connection to Slave'));
    if (connected) {
      process.exit(1);
    }
  });

  controlSock.once('error', (e) => {
    die(`Failed to connect to Slave at ${fmtAddr(slaveAddr)}: ${e.message}`);
  });

  // ── Interactive CLI ─────────────────────────────────────
  let rl = null;
  let promptDirty = false;

  function renderPrompt() {
    if (promptDirty) {
      // Just mark it, redraw on next user input or new connection notification
    }
  }

  function printPending() {
    if (pendingConnections.length === 0) {
      console.log('  No pending connections.');
      return;
    }
    console.log(`  ${c(C.bold, 'Pending Connections:')}`);
    for (const p of pendingConnections) {
      const hs = p.handshake ? c(C.dim, ` → ${p.handshake}`) : '';
      console.log(`    ${c(C.cyan, p.id)}  ${c(C.bold, p.addr)}${hs}`);
    }
  }

  function printActive() {
    if (activeTunnels.size === 0) {
      console.log('  No active tunnels.');
      return;
    }
    console.log(`  ${c(C.bold, 'Active Tunnels:')}`);
    for (const [id, addr] of activeTunnels) {
      console.log(`    ${c(C.green, id)}  ${addr}`);
    }
  }

  function showHelp() {
    console.log(`
  ${c(C.bold, 'Commands:')}
    ${c(C.cyan, 'connections')}     List pending player connections
    ${c(C.cyan, 'approve <id>')}   Approve a pending connection
    ${c(C.cyan, 'deny <id>')}      Deny a pending connection
    ${c(C.cyan, 'active')}         List active tunnels
    ${c(C.cyan, 'refresh')}        Refresh pending list from Slave
    ${c(C.cyan, 'help')}           Show this help
    ${c(C.cyan, 'exit')}           Disconnect and quit
`);
  }

  function shutdown() {
    log('info', c(C.yellow, 'disconnecting...'));
    if (rl) rl.close();
    if (!controlSock.destroyed) { controlSock.end(); controlSock.destroy(); }
    dataServer.close(() => {});
    log('ok', 'goodbye');
    process.exit(0);
  }

  // ── Connect to Slave ──────────────────────────────────────
  controlSock.connect(slaveAddr.port, slaveAddr.host, () => {
    connected = true;
    const localAddr = controlSock.localAddress;
    const localFamily = controlSock.localFamily;

    // Start data listener on random port
    dataServer.listen(0, '0.0.0.0', () => {
      const dataPort = dataServer.address().port;
      // Send HELLO with our data listener address and MC target
      const helloMsg = `HELLO ${localAddr} ${dataPort} ${fmtAddr(mcTarget)}`;
      sendCtrl(helloMsg);

      log('ok', `Connected to Slave at ${c(C.bold, fmtAddr(slaveAddr))}`);
      log('ok', `Data listener on ${c(C.cyan, `${localAddr}:${dataPort}`)}`);
      log('info', `MC server target: ${c(C.cyan, fmtAddr(mcTarget))}`);
      console.log('');
      console.log(`  ${c(C.bold, 'Waiting for connections...')}  Type ${c(C.cyan, 'help')} for commands`);
      console.log('');

      // Start readline interface
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: color ? `${C.cyan}mcnux host> ${C.reset}` : 'mcnux host> ',
        terminal: true,
      });

      rl.on('line', (input) => {
        const trimmed = input.trim();
        if (!trimmed) {
          rl.prompt();
          return;
        }

        const args = trimmed.split(/\s+/);
        const cmd = args[0].toLowerCase();

        switch (cmd) {
          case 'connections':
          case 'conns':
          case 'conn': {
            printPending();
            rl.prompt();
            break;
          }

          case 'approve': {
            const id = args[1];
            if (!id) {
              console.log('  Usage: approve <id>');
              rl.prompt();
              break;
            }
            const entry = pendingConnections.find(p => p.id === id);
            if (!entry) {
              console.log(`  ${c(C.red, '✗')} Connection ${id} not found`);
              rl.prompt();
              break;
            }
            sendCtrl(`APPROVE ${id}`);
            pendingConnections = pendingConnections.filter(p => p.id !== id);
            console.log(`  ${c(C.green, '✓')} Approved connection ${c(C.cyan, id)}`);
            if (entry.handshake) {
              console.log(`    Player connecting to ${c(C.dim, entry.handshake)}`);
            }
            rl.prompt();
            break;
          }

          case 'deny': {
            const id = args[1];
            if (!id) {
              console.log('  Usage: deny <id>');
              rl.prompt();
              break;
            }
            const entry = pendingConnections.find(p => p.id === id);
            if (!entry) {
              console.log(`  ${c(C.red, '✗')} Connection ${id} not found`);
              rl.prompt();
              break;
            }
            sendCtrl(`DENY ${id}`);
            pendingConnections = pendingConnections.filter(p => p.id !== id);
            console.log(`  ${c(C.yellow, '−')} Denied connection ${c(C.cyan, id)}`);
            rl.prompt();
            break;
          }

          case 'active':
          case 'act': {
            printActive();
            if (pendingConnections.length > 0) {
              console.log('');
              printPending();
            }
            rl.prompt();
            break;
          }

          case 'refresh':
          case 'ref': {
            sendCtrl('LIST_CONNS');
            sendCtrl('LIST_ACTIVE');
            console.log('  Refreshing...');
            rl.prompt();
            break;
          }

          case 'help':
          case 'h': {
            showHelp();
            rl.prompt();
            break;
          }

          case 'quit':
          case 'exit':
          case 'q': {
            shutdown();
            break;
          }

          default:
            console.log(`  Unknown command: ${cmd}  (type ${c(C.cyan, 'help')} for commands)`);
            rl.prompt();
        }
      });

      rl.on('close', () => {
        shutdown();
      });

      // Override prompt for connection notifications
      const origLog = console.log;
      console.log = function(...args) {
        origLog.apply(console, args);
        if (rl) {
          rl.prompt(true);
        }
      };

      rl.prompt();
    });
  });

  return new Promise((resolve) => {
    // Keep alive until exit
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
  Player → Slave :25565 (pending) → Host approves → tunnel → MC Server

${b}COMMANDS${r}

  ${b}host${r} <slave-host> <control-port>    Admin mode
    Connect to a Slave, view pending connections, approve or deny them.
    Players are queued until you approve.

    ${d}Examples:${r}
      mcnux host 192.168.1.100 25567
      mcnux host slave.example.com 25567 --mc-server localhost:25565

  ${b}serve${r} [player-port=25565] [control-port=25567]   Slave mode
    Accept Minecraft players and Host connections. Players are queued
    until the Host approves them.

    ${d}Examples:${r}
      mcnux serve
      mcnux serve 25565 25567

${b}OPTIONS${r}
  --mc-server <addr>         Target Minecraft server address (default: localhost:25565)
  --no-color                 Disable ANSI colors
  -h, --help                 Show help
  --version                  Print version

${b}WORKFLOW${r}
  1. Start the ${b}Slave${r} on your public machine:
       $ mcnux serve

  2. Start the ${b}Host${r} on the MC server machine:
       $ mcnux host <slave-public-ip> 25567

  3. When players connect, approve them from the Host prompt:
       mcnux host> connections
       mcnux host> approve 1
`);
}

function showCmdHelp(cmd) {
  if (cmd === 'host') {
    console.log(`
${color ? C.bold : ''}mcnux host${color ? C.reset : ''}  —  Admin mode

Connect to a Slave's control port and approve/deny incoming players.

${color ? C.bold : ''}Usage:${color ? C.reset : ''}
  mcnux host <slave-host> <control-port> [options]

  <slave-host>       Hostname or IP of the Slave machine
  <control-port>     Control port on the Slave (default: 25567)

${color ? C.bold : ''}Options:${color ? C.reset : ''}
  --mc-server <addr>   Target Minecraft server (default: localhost:25565)

${color ? C.bold : ''}Examples:${color ? C.reset : ''}
  mcnux host 192.168.1.100 25567
  mcnux host slave.example.com 25567 --mc-server play.hypixel.net
`);
  } else if (cmd === 'serve') {
    console.log(`
${color ? C.bold : ''}mcnux serve${color ? C.reset : ''}  —  Slave mode

Accept Minecraft players (pending queue) and Host control connections.

${color ? C.bold : ''}Usage:${color ? C.reset : ''}
  mcnux serve [player-port] [control-port]

  [player-port]    Port for Minecraft players to connect on  (default: 25565)
  [control-port]   Port for Host to connect on              (default: 25567)

${color ? C.bold : ''}Examples:${color ? C.reset : ''}
  mcnux serve
  mcnux serve 25565 25567
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

  // Parse opts + positional
  const opts = { verbose: false, mcTarget: null };
  const positional = [];
  for (let i = 0; i < cmdArgs.length; i++) {
    const a = cmdArgs[i];
    if (a === '--no-color') color = false;
    else if (a === '-h' || a === '--help') { showCmdHelp(cmd); return; }
    else if (a === '--mc-server') opts.mcTarget = cmdArgs[++i];
    else if (a.startsWith('-')) die(`Unknown option: ${a}`);
    else positional.push(a);
  }

  switch (cmd) {
    case 'host': {
      if (positional.length < 2) die('Usage: mcnux host <slave-host> <control-port>\n  Example: mcnux host 192.168.1.100 25567');
      const slaveHost = positional[0];
      const controlPort = parseInt(positional[1], 10);
      if (isNaN(controlPort)) die(`Invalid control port: ${positional[1]}`);
      runHost({ host: slaveHost, port: controlPort }, opts);
      break;
    }

    case 'serve': {
      const playerPort = parseInt(positional[0], 10) || 25565;
      const pluginHost = positional[1];
      const pluginPort = parseInt(positional[2], 10) || 25567;
      if (!pluginHost) die('Usage: mcnux serve [player-port] <plugin-host> <plugin-control-port>\n  Example: mcnux serve 25565 192.168.1.100 25567');
      if (isNaN(playerPort) || playerPort < 1) die(`Invalid player port: ${positional[0] || '25565'}`);
      if (isNaN(pluginPort) || pluginPort < 1) die(`Invalid plugin control port: ${positional[2] || '25567'}`);
      runServe(playerPort, pluginHost, pluginPort, opts);
      break;
    }

    default:
      die(`Unknown command: ${cmd}\n  Commands: host, serve`);
  }
}

if (require.main === module) main();
