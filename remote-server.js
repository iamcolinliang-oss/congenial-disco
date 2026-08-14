const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const rooms = new Map();
const scavPlayers = new Map();
const gameFile = path.join(__dirname, "kof97_98_style_fighter.html");

function send(ws, data) {
  if (!ws.writable) return;
  const payload = Buffer.from(JSON.stringify(data));
  let head;
  if (payload.length < 126) {
    head = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  ws.write(Buffer.concat([head, payload]));
}

function readFrames(socket, onText) {
  let buffer = Buffer.alloc(0);
  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const lenByte = buffer[1] & 127;
      let offset = 2, len = lenByte;
      if (lenByte === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (lenByte === 127) {
        if (buffer.length < 10) return;
        const bigLen = buffer.readBigUInt64BE(2);
        if (bigLen > 1024n * 1024n) return socket.destroy();
        len = Number(bigLen);
        offset = 10;
      }
      const masked = (buffer[1] & 128) !== 0;
      const maskOffset = masked ? 4 : 0;
      if (buffer.length < offset + maskOffset + len) return;
      const mask = masked ? buffer.slice(offset, offset + 4) : null;
      const payload = Buffer.from(buffer.slice(offset + maskOffset, offset + maskOffset + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.slice(offset + maskOffset + len);
      try { onText(JSON.parse(payload.toString("utf8"))); } catch {}
    }
  });
}

function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { host: null, guest: null });
  return rooms.get(code);
}

function leave(socket) {
  const code = socket.room;
  if (!code || !rooms.has(code)) return;
  const room = rooms.get(code);
  if (room.host === socket) room.host = null;
  if (room.guest === socket) room.guest = null;
  const peer = room.host || room.guest;
  if (peer) send(peer, { type: "error", message: "对手已离开房间" });
  if (!room.host && !room.guest) rooms.delete(code);
  scavPlayers.delete(socket);
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/health") {
    const hasGameFile = fs.existsSync(gameFile);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, port: PORT, host: HOST, gameFile: hasGameFile }));
    return;
  }
  if (pathname === "/" || pathname === "/game" || pathname === "/kof97_98_style_fighter.html") {
    fs.readFile(gameFile, (err, data) => {
      if (err) {
        res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
        res.end(`<h1>游戏文件没有找到</h1><p>服务器已经启动，但没有在同一个仓库根目录找到 kof97_98_style_fighter.html。</p><p>请确认这个文件和 remote-server.js 放在一起。</p><p><a href="/health">查看健康检查</a></p>`);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(data);
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found\n");
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  socket.on("close", () => leave(socket));
  socket.on("error", () => leave(socket));
  readFrames(socket, msg => {
    const code = String(msg.room || "").slice(0, 12);
    if (!code) return send(socket, { type: "error", message: "缺少房间号" });
    const room = getRoom(code);
    if (msg.type === "create") {
      room.host = socket;
      socket.room = code;
      socket.role = "host";
      send(socket, { type: "created", room: code });
      if (room.guest) send(socket, { type: "joined", room: code });
      return;
    }
    if (msg.type === "join") {
      if (!room.host) return send(socket, { type: "error", message: "房间不存在，请先让房主创建" });
      room.guest = socket;
      socket.room = code;
      socket.role = "guest";
      send(socket, { type: "joined", room: code });
      send(room.host, { type: "joined", room: code });
      return;
    }
    if (msg.type === "scavJoin" || msg.type === "scavPos") {
      socket.room = code;
      scavPlayers.set(socket, {
        id: String(socket.remotePort || Math.random()),
        map: String(msg.map || ""),
        name: String(msg.name || "玩家").slice(0, 20),
        x: Number(msg.x || 0),
        y: Number(msg.y || 0),
        hp: Number(msg.hp || 100),
        bag: Array.isArray(msg.bag) ? msg.bag.slice(0, 8) : [],
        t: Date.now(),
      });
      const now = Date.now();
      for (const [peer, p] of scavPlayers) {
        if (now - p.t > 15000) scavPlayers.delete(peer);
      }
      const mine = scavPlayers.get(socket);
      const players = [...scavPlayers.entries()]
        .filter(([peer, p]) => peer !== socket && p.map === mine.map)
        .map(([, p]) => p);
      send(socket, { type: "scavPlayers", players });
      return;
    }
    if (msg.type === "scavHit") {
      const target = String(msg.target || "");
      for (const [peer, p] of scavPlayers) {
        if (p.id === target) {
          send(peer, { type: "scavHit", damage: Number(msg.damage || 0), from: String(msg.from || "玩家").slice(0, 20) });
          break;
        }
      }
      return;
    }
    const peer = socket === room.host ? room.guest : room.host;
    if (peer) send(peer, msg);
  });
});

server.on("error", err => {
  console.error(`Server failed: ${err.message}`);
  if (err.code === "EPERM") console.error("Try another port, for example: PORT=8090 npm start");
});

server.listen(PORT, HOST, () => {
  console.log(`Fighter remote server listening on ws://${HOST}:${PORT}`);
});
