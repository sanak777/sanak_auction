const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '9981');

const participants = new Map(); // socket.id -> {name, joinedAt}
const balances = new Map();     // nickname -> wallet balance
const adminSockets = new Set();

let auction = {
  title: '오늘의 메인 슬롯',
  startPrice: 0,
  currentPrice: 0,
  leader: null,
  status: 'ready', // ready | live | sold
  holds: new Map(),
  logs: []
};

app.use(express.json());
app.use(express.static(__dirname));

function cleanName(v){
  return String(v || '').replace(/[<>]/g,'').trim().slice(0,20);
}
function cleanTitle(v){
  return String(v || '').replace(/[<>]/g,'').trim().slice(0,40);
}
function moneyInt(v){
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function participantList(){
  return [...participants.entries()]
    .map(([id,u])=>({
      id,
      name:u.name,
      joinedAt:u.joinedAt,
      balance:balances.get(u.name)||0,
      held:auction.holds.get(u.name)||0
    }))
    .sort((a,b)=>a.joinedAt-b.joinedAt);
}
function publicState(){
  return {
    title: auction.title,
    startPrice: auction.startPrice,
    currentPrice: auction.currentPrice,
    leader: auction.leader,
    status: auction.status,
    logs: auction.logs.slice(0,100)
  };
}
function broadcastParticipants(){ io.emit('participants', participantList()); }
function broadcastState(){ io.emit('auction_state', publicState()); }
function sendAdminState(){
  const payload = {
    participants: participantList(),
    balances: Object.fromEntries(balances),
    holds: Object.fromEntries(auction.holds)
  };
  for(const id of adminSockets){
    io.to(id).emit('admin_state', payload);
  }
}
function broadcastAll(){
  broadcastParticipants();
  broadcastState();
  sendAdminState();
}
function isAdmin(socket){ return adminSockets.has(socket.id); }
function clearHolds(){ auction.holds.clear(); }

app.get('/health', (_req,res)=>res.json({
  ok:true,
  participants:participants.size,
  auctionStatus:auction.status
}));

io.on('connection', socket=>{
  socket.emit('participants', participantList());
  socket.emit('auction_state', publicState());

  socket.on('join_auction', (payload={}, callback=()=>{})=>{
    const name = cleanName(payload.name);
    if(!name) return callback({ok:false,message:'닉네임을 입력해주세요.'});

    const duplicate = [...participants.entries()].some(
      ([id,u])=>id!==socket.id && u.name.toLowerCase()===name.toLowerCase()
    );
    if(duplicate){
      return callback({ok:false,message:'현재 접속 중인 닉네임입니다.'});
    }

    participants.set(socket.id,{name,joinedAt:Date.now()});
    if(!balances.has(name)) balances.set(name,0);

    callback({ok:true,name,balance:balances.get(name)||0});
    broadcastAll();
  });

  socket.on('admin_login', (payload={}, callback=()=>{})=>{
    if(String(payload.password||'') !== ADMIN_PASSWORD){
      return callback({ok:false,message:'비밀번호가 올바르지 않습니다.'});
    }
    adminSockets.add(socket.id);
    callback({ok:true,token:crypto.randomBytes(8).toString('hex')});
    sendAdminState();
    socket.emit('auction_state', publicState());
  });

  socket.on('admin_logout', ()=>{
    adminSockets.delete(socket.id);
  });

  socket.on('admin_set_title', (payload={}, callback=()=>{})=>{
    if(!isAdmin(socket)) return callback({ok:false,message:'방장 권한이 필요합니다.'});
    const title = cleanTitle(payload.title);
    if(!title) return callback({ok:false,message:'제목을 입력해주세요.'});

    auction.title = title;
    callback({ok:true});
    broadcastState();
  });

  socket.on('admin_set_balance', (payload={}, callback=()=>{})=>{
    if(!isAdmin(socket)) return callback({ok:false,message:'방장 권한이 필요합니다.'});

    const name = cleanName(payload.name);
    const amount = moneyInt(payload.amount);
    if(!name || amount === null){
      return callback({ok:false,message:'닉네임과 금액을 확인해주세요.'});
    }

    if(![...participants.values()].some(p=>p.name===name)){
      return callback({ok:false,message:'현재 접속 중인 참가자가 아닙니다.'});
    }

    const held = auction.holds.get(name)||0;
    if(amount < held){
      return callback({
        ok:false,
        message:`현재 입찰 보류금 ${held.toLocaleString('ko-KR')}원보다 낮게 설정할 수 없습니다.`
      });
    }

    balances.set(name,amount);
    callback({ok:true,balance:amount});
    broadcastParticipants();
    sendAdminState();
  });

  socket.on('admin_set_start_price', (payload={}, callback=()=>{})=>{
    if(!isAdmin(socket)) return callback({ok:false,message:'방장 권한이 필요합니다.'});
    if(auction.status === 'live' || auction.leader){
      return callback({ok:false,message:'경매 진행 중에는 시작가를 변경할 수 없습니다.'});
    }

    const amount = moneyInt(payload.amount);
    if(amount === null){
      return callback({ok:false,message:'올바른 시작가를 입력해주세요.'});
    }

    auction.startPrice = amount;
    auction.currentPrice = amount;
    callback({ok:true});
    broadcastState();
  });

  socket.on('admin_start_auction', (_payload={}, callback=()=>{})=>{
    if(!isAdmin(socket)) return callback({ok:false,message:'방장 권한이 필요합니다.'});
    if(auction.status === 'live'){
      return callback({ok:false,message:'이미 경매가 진행 중입니다.'});
    }

    clearHolds();
    auction.currentPrice = auction.startPrice;
    auction.leader = null;
    auction.logs = [];
    auction.status = 'live';

    callback({ok:true});
    broadcastAll();
  });

  socket.on('place_bid', (payload={}, callback=()=>{})=>{
    const me = participants.get(socket.id);
    if(!me) return callback({ok:false,message:'먼저 경매에 참가해주세요.'});
    if(auction.status !== 'live'){
      return callback({ok:false,message:'방장이 아직 경매를 시작하지 않았습니다.'});
    }

    const inc = moneyInt(payload.inc);
    if(!inc || inc <= 0){
      return callback({ok:false,message:'입찰 금액이 올바르지 않습니다.'});
    }

    const nextPrice = auction.currentPrice + inc;
    const myBalance = balances.get(me.name)||0;
    if(nextPrice > myBalance){
      return callback({ok:false,message:'보유금이 부족합니다.'});
    }

    clearHolds();
    auction.holds.set(me.name,nextPrice);
    auction.currentPrice = nextPrice;
    auction.leader = me.name;

    auction.logs.unshift({
      name:me.name,
      inc,
      total:nextPrice,
      ts:Date.now()
    });
    auction.logs = auction.logs.slice(0,100);

    callback({
      ok:true,
      balance:myBalance,
      held:nextPrice,
      available:myBalance-nextPrice
    });
    broadcastAll();
  });

  socket.on('admin_close_auction', (_payload={}, callback=()=>{})=>{
    if(!isAdmin(socket)) return callback({ok:false,message:'방장 권한이 필요합니다.'});
    if(auction.status !== 'live'){
      return callback({ok:false,message:'진행 중인 경매가 없습니다.'});
    }

    if(!auction.leader){
      clearHolds();
      auction.status = 'ready';
      callback({ok:true,sold:false});
      return broadcastAll();
    }

    const winner = auction.leader;
    const price = auction.currentPrice;
    const bal = balances.get(winner)||0;

    if(bal < price){
      return callback({ok:false,message:'낙찰자의 보유금이 부족합니다.'});
    }

    balances.set(winner,bal-price);
    clearHolds();
    auction.status = 'sold';

    callback({ok:true,sold:true,winner,price});
    broadcastAll();
  });

  socket.on('admin_cancel_auction', (_payload={}, callback=()=>{})=>{
    if(!isAdmin(socket)) return callback({ok:false,message:'방장 권한이 필요합니다.'});

    clearHolds();
    auction.currentPrice = auction.startPrice;
    auction.leader = null;
    auction.status = 'ready';
    auction.logs = [];

    callback({ok:true});
    broadcastAll();
  });

  socket.on('admin_new_auction', (_payload={}, callback=()=>{})=>{
    if(!isAdmin(socket)) return callback({ok:false,message:'방장 권한이 필요합니다.'});

    clearHolds();
    auction.currentPrice = auction.startPrice;
    auction.leader = null;
    auction.status = 'ready';
    auction.logs = [];

    callback({ok:true});
    broadcastAll();
  });

  socket.on('disconnect', ()=>{
    adminSockets.delete(socket.id);

    const u = participants.get(socket.id);
    if(u){
      participants.delete(socket.id);

      if(auction.leader === u.name){
        clearHolds();
        auction.currentPrice = auction.startPrice;
        auction.leader = null;
        auction.status = 'ready';
        auction.logs = [];
      }

      broadcastAll();
    }
  });
});

app.get('*', (_req,res)=>res.sendFile(path.join(__dirname,'index.html')));

server.listen(PORT,'0.0.0.0',()=>{
  console.log(`sanak-auction running on ${PORT}`);
});
