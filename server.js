
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '9981';

const users = new Map(); // nickname -> { online, socketIds:Set, balance, lastSeen }
const socketNick = new Map();

const state = {
  title: '현재 경매 준비중',
  startPrice: 0,
  price: 0,
  leader: '운영자 START',
  status: '경매 준비중',
  locked: false,
  logs: []
};

function serialUsers() {
  return [...users.entries()]
    .map(([nickname, u]) => ({
      nickname,
      online: u.online,
      balance: u.balance || 0,
      lastSeen: u.lastSeen || Date.now()
    }))
    .sort((a,b) => Number(b.online)-Number(a.online) || a.nickname.localeCompare(b.nickname, 'ko'));
}

function snapshot() {
  return { users: serialUsers(), state };
}

function broadcast() {
  io.emit('snapshot', snapshot());
}

function cleanOldOffline() {
  const cutoff = Date.now() - 5 * 60 * 1000; // 5분간 빨간불 표시 후 목록에서 제거
  for (const [nickname, u] of users) {
    if (!u.online && u.lastSeen < cutoff) users.delete(nickname);
  }
  broadcast();
}
setInterval(cleanOldOffline, 30 * 1000);

io.on('connection', (socket) => {
  socket.emit('snapshot', snapshot());

  socket.on('join', (nickname, ack) => {
    nickname = String(nickname || '').trim().slice(0,20);
    if (!nickname) return ack && ack({ok:false, message:'닉네임을 입력해주세요.'});

    let u = users.get(nickname);
    if (!u) u = { online:false, socketIds:new Set(), balance:0, lastSeen:Date.now() };
    u.socketIds.add(socket.id);
    u.online = true;
    u.lastSeen = Date.now();
    users.set(nickname, u);
    socketNick.set(socket.id, nickname);
    socket.join('auction');
    broadcast();
    ack && ack({ok:true, nickname});
  });

  socket.on('adminLogin', (pw, ack) => {
    const ok = String(pw) === ADMIN_PASSWORD;
    if (ok) socket.data.admin = true;
    ack && ack({ok});
  });

  socket.on('setTitle', (title) => {
    if (!socket.data.admin) return;
    title = String(title || '').trim().slice(0,40);
    if (!title) return;
    state.title = title;
    state.status = '경매 준비중';
    broadcast();
  });

  socket.on('setStartPrice', (value) => {
    if (!socket.data.admin) return;
    if (state.logs.length) return;
    const n = Math.max(0, Math.floor(Number(value)||0));
    state.startPrice = n;
    state.price = n;
    state.leader = '운영자 START';
    broadcast();
  });

  socket.on('giveMoney', ({nickname, amount}) => {
    if (!socket.data.admin) return;
    const u = users.get(String(nickname||''));
    const n = Math.max(0, Math.floor(Number(amount)||0));
    if (!u || !n) return;
    u.balance = (u.balance || 0) + n;
    users.set(nickname, u);
    broadcast();
  });

  socket.on('bid', (inc, ack) => {
    const nickname = socketNick.get(socket.id);
    if (!nickname) return ack && ack({ok:false, message:'먼저 입장해주세요.'});
    if (state.locked) return ack && ack({ok:false, message:'경매가 종료된 상태입니다.'});

    const u = users.get(nickname);
    const n = Math.max(0, Math.floor(Number(inc)||0));
    if (!u || !n) return;
    if ((u.balance||0) < n) return ack && ack({ok:false, message:'보유금이 부족합니다.'});

    u.balance -= n;
    state.price += n;
    state.leader = nickname;
    state.status = '실시간 경매 진행중';
    const item = { nickname, inc:n, total:state.price, time:Date.now() };
    state.logs.unshift(item);
    state.logs = state.logs.slice(0,100);
    broadcast();
    io.emit('bidFlash', { ...item, balance:u.balance });
    ack && ack({ok:true});
  });

  socket.on('endAuction', () => {
    if (!socket.data.admin) return;
    state.locked = true;
    state.status = `경매 종료 · 낙찰자 ${state.leader}`;
    broadcast();
    io.emit('sold', {leader:state.leader, price:state.price});
  });

  socket.on('resetAuction', () => {
    if (!socket.data.admin) return;
    state.title = '현재 경매 준비중';
    state.startPrice = 0;
    state.price = 0;
    state.leader = '운영자 START';
    state.status = '경매 준비중';
    state.locked = false;
    state.logs = [];
    broadcast();
  });

  socket.on('disconnect', () => {
    const nickname = socketNick.get(socket.id);
    socketNick.delete(socket.id);
    if (!nickname) return;
    const u = users.get(nickname);
    if (!u) return;
    u.socketIds.delete(socket.id);
    u.online = u.socketIds.size > 0;
    u.lastSeen = Date.now();
    users.set(nickname, u);
    broadcast();
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Listening on ${PORT}`));
