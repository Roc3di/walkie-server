import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const rooms = new Map();
const clients = new Map();

function sanitize(value = '', max = 32) {
  return String(value).trim().toLowerCase().replace(/\s+/g, '-').slice(0, max);
}
function display(value = '', max = 24) {
  return String(value).trim().slice(0, max);
}
function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      pin: '',
      locked: false,
      createdAt: Date.now(),
      members: new Map(),
      banned: new Set(),
      speaking: null
    });
  }
  return rooms.get(roomId);
}
function roomSnapshot(room) {
  return {
    id: room.id,
    locked: room.locked,
    members: [...room.members.values()].map(m => ({
      clientId: m.clientId,
      nickname: m.nickname,
      role: m.role,
      channel: m.channel,
      muted: m.muted,
      priority: m.priority
    }))
  };
}
function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}
function broadcast(room, payload, exceptId = null) {
  for (const member of room.members.values()) {
    if (member.clientId === exceptId) continue;
    const ws = clients.get(member.clientId)?.ws;
    if (ws) send(ws, payload);
  }
}
function removeClient(clientId) {
  const info = clients.get(clientId);
  if (!info) return;
  const room = rooms.get(info.roomId);
  if (room) {
    room.members.delete(clientId);
    if (room.speaking === clientId) room.speaking = null;
    broadcast(room, { type: 'peer-left', clientId, nickname: info.nickname, roomId: info.roomId });
    if (room.members.size === 0) rooms.delete(info.roomId);
  }
  clients.delete(clientId);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, users: clients.size, ts: Date.now() });
});

app.get('/rooms/:roomId', (req, res) => {
  const roomId = sanitize(req.params.roomId);
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: 'room_not_found' });
  res.json(roomSnapshot(room));
});

app.post('/rooms/:roomId/lock', (req, res) => {
  const roomId = sanitize(req.params.roomId);
  const room = getRoom(roomId);
  room.locked = !!req.body.locked;
  if (typeof req.body.pin === 'string') room.pin = req.body.pin.trim().slice(0, 12);
  broadcast(room, { type: 'room-lock', locked: room.locked, roomId, pinProtected: !!room.pin });
  res.json({ ok: true, locked: room.locked, pinProtected: !!room.pin });
});

wss.on('connection', (ws) => {
  const clientId = crypto.randomUUID();

  ws.on('message', (raw) => {
    console.log('WS MESSAGE RAW', String(raw));
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'join') {
      console.log('JOIN RECEIVED', roomId, msg.nickname, msg.channel, msg.role);
      const roomId = sanitize(msg.roomId);
      const room = getRoom(roomId);
      const nickname = display(msg.nickname || `user-${clientId.slice(0, 4)}`);
      const role = sanitize(msg.role || 'guest', 16) || 'guest';
      const channel = sanitize(msg.channel || 'generale', 18) || 'generale';
      const pin = String(msg.pin || '').trim().slice(0, 12);
      if (room.banned.has(nickname)) {
        return send(ws, { type: 'join-rejected', reason: 'banned' });
      }
      if (room.locked && room.pin && room.pin !== pin) {
        return send(ws, { type: 'join-rejected', reason: 'invalid_pin' });
      }
      if (!room.pin && pin) room.pin = pin;

      const member = { clientId, ws, nickname, role, channel, muted: false, priority: !!msg.priority };
      room.members.set(clientId, member);
      clients.set(clientId, { ws, roomId, nickname });

      console.log('JOIN', { roomId, clientId, nickname, role, channel, pinOk: true, roomLocked: room.locked });
      send(ws, { type: 'joined', clientId, room: roomSnapshot(room), debug: { roomId, nickname, role, channel, roomLocked: room.locked } });
      console.log('JOIN ACK SENT', roomId, clientId, nickname);
      broadcast(room, { type: 'peer-joined', peer: { clientId, nickname, role, channel, muted: false, priority: !!msg.priority } }, clientId);
      return;
    }

    const info = clients.get(clientId);
    if (!info) return;
    const room = rooms.get(info.roomId);
    if (!room) return;
    const me = room.members.get(clientId);
    if (!me) return;

    if (msg.type === 'signal' && msg.targetId && room.members.has(msg.targetId)) {
      const target = room.members.get(msg.targetId);
      send(target.ws, { type: 'signal', fromId: clientId, data: msg.data });
      return;
    }

    if (msg.type === 'channel') {
      me.channel = sanitize(msg.channel || 'generale', 18) || 'generale';
      broadcast(room, { type: 'peer-channel', clientId, channel: me.channel });
      return;
    }

    if (msg.type === 'speaking') {
      if (me.muted) return;
      room.speaking = msg.value ? clientId : null;
      broadcast(room, { type: 'peer-speaking', clientId, value: !!msg.value, channel: me.channel });
      return;
    }

    if (msg.type === 'priority') {
      me.priority = !!msg.value;
      broadcast(room, { type: 'peer-priority', clientId, value: me.priority });
      return;
    }

    if (msg.type === 'mute-peer') {
      if (!['host', 'admin', 'moderator'].includes(me.role)) return;
      const target = room.members.get(msg.targetId);
      if (!target) return;
      target.muted = !!msg.value;
      send(target.ws, { type: 'muted', value: target.muted });
      broadcast(room, { type: 'peer-muted', clientId: target.clientId, value: target.muted });
      return;
    }

    if (msg.type === 'kick-peer') {
      if (!['host', 'admin', 'moderator'].includes(me.role)) return;
      const target = room.members.get(msg.targetId);
      if (!target) return;
      send(target.ws, { type: 'kicked' });
      target.ws.close();
      return;
    }

    if (msg.type === 'ban-peer') {
      if (!['host', 'admin', 'moderator'].includes(me.role)) return;
      const target = room.members.get(msg.targetId);
      if (!target) return;
      room.banned.add(target.nickname);
      send(target.ws, { type: 'banned' });
      target.ws.close();
      return;
    }

    if (msg.type === 'lock-room') {
      if (!['host', 'admin'].includes(me.role)) return;
      room.locked = !!msg.locked;
      room.pin = String(msg.pin || room.pin || '').trim().slice(0, 12);
      broadcast(room, { type: 'room-lock', locked: room.locked, pinProtected: !!room.pin });
      return;
    }
  });

  ws.on('close', () => removeClient(clientId));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Walkie server listening on http://localhost:${PORT}`);
});
