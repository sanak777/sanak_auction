const express=require('express'),http=require('http'),path=require('path'),crypto=require('crypto');
const {Server}=require('socket.io');const app=express(),server=http.createServer(app),io=new Server(server);
const PORT=process.env.PORT||10000,ADMIN_PASSWORD=String(process.env.ADMIN_PASSWORD||'9981');
const participants=new Map(),balances=new Map(),admins=new Set(),adminTokens=new Map();
const ADMIN_TOKEN_TTL=1000*60*60*24*30;
let auction={title:'오늘의 메인 슬롯',slot:{name:'',image:''},startPrice:0,currentPrice:0,leader:null,status:'ready',holds:new Map(),logs:[]};
app.use(express.json());app.use(express.static(__dirname));
const clean=v=>String(v||'').replace(/[<>]/g,'').trim().slice(0,20),title=v=>String(v||'').replace(/[<>]/g,'').trim().slice(0,40);
const mi=v=>{const n=Math.floor(Number(v));return Number.isFinite(n)&&n>=0?n:null};
const plist=()=>[...participants.entries()].map(([id,u])=>({id,name:u.name,joinedAt:u.joinedAt,balance:balances.get(u.name)||0,held:auction.holds.get(u.name)||0})).sort((a,b)=>a.joinedAt-b.joinedAt);
const state=()=>({title:auction.title,slot:auction.slot||{name:'',image:''},startPrice:auction.startPrice,currentPrice:auction.currentPrice,leader:auction.leader,status:auction.status,logs:auction.logs.slice(0,100)});
function adminState(){const p={participants:plist(),balances:Object.fromEntries(balances),holds:Object.fromEntries(auction.holds)};for(const id of admins)io.to(id).emit('admin_state',p)}
function all(){io.emit('participants',plist());io.emit('auction_state',state());adminState()}
function isA(s){return admins.has(s.id)}
function clearH(){auction.holds.clear()}
function makeAdminToken(){const token=crypto.randomBytes(24).toString('hex');adminTokens.set(token,Date.now()+ADMIN_TOKEN_TTL);return token}
function validAdminToken(token){if(!token)return false;const exp=adminTokens.get(String(token));if(!exp)return false;if(exp<Date.now()){adminTokens.delete(String(token));return false}adminTokens.set(String(token),Date.now()+ADMIN_TOKEN_TTL);return true}
app.get('/health',(_q,r)=>r.json({ok:true,participants:participants.size,status:auction.status}));
io.on('connection',s=>{
 s.emit('participants',plist());s.emit('auction_state',state());
 s.on('join_auction',(p={},cb=()=>{})=>{const n=clean(p.name);if(!n)return cb({ok:false,message:'닉네임을 입력해주세요.'});const d=[...participants.entries()].some(([id,u])=>id!==s.id&&u.name.toLowerCase()===n.toLowerCase());if(d)return cb({ok:false,message:'현재 접속 중인 닉네임입니다.'});participants.set(s.id,{name:n,joinedAt:Date.now()});if(!balances.has(n))balances.set(n,0);cb({ok:true,name:n,balance:balances.get(n)||0});all()});
 s.on('admin_login',(p={},cb=()=>{})=>{if(String(p.password||'')!==ADMIN_PASSWORD)return cb({ok:false,message:'비밀번호가 올바르지 않습니다.'});admins.add(s.id);const token=makeAdminToken();cb({ok:true,token});adminState();s.emit('auction_state',state())});
 s.on('admin_resume',(p={},cb=()=>{})=>{if(!validAdminToken(p.token))return cb({ok:false,message:'관리자 인증이 만료되었습니다.'});admins.add(s.id);cb({ok:true});adminState();s.emit('auction_state',state())});
 s.on('admin_set_slot',(p={},cb=()=>{})=>{if(!isA(s))return cb({ok:false,message:'방장 권한이 필요합니다.'});const n=title(p.name),img=String(p.image||'').replace(/[^a-zA-Z0-9_./-]/g,'').slice(0,120);if(!n||!img)return cb({ok:false,message:'슬롯을 선택해주세요.'});auction.slot={name:n,image:img};auction.title=n;cb({ok:true});io.emit('auction_state',state())});
 s.on('admin_set_title',(p={},cb=()=>{})=>{if(!isA(s))return cb({ok:false,message:'방장 권한이 필요합니다.'});const t=title(p.title);if(!t)return cb({ok:false,message:'제목을 입력해주세요.'});auction.title=t;cb({ok:true});io.emit('auction_state',state())});
 s.on('admin_set_balance',(p={},cb=()=>{})=>{if(!isA(s))return cb({ok:false,message:'방장 권한이 필요합니다.'});const n=clean(p.name),a=mi(p.amount);if(!n||a===null)return cb({ok:false,message:'닉네임과 금액을 확인해주세요.'});if(![...participants.values()].some(x=>x.name===n))return cb({ok:false,message:'현재 접속 중인 참가자가 아닙니다.'});const h=auction.holds.get(n)||0;if(a<h)return cb({ok:false,message:'현재 입찰 보류금보다 낮게 설정할 수 없습니다.'});balances.set(n,a);cb({ok:true,balance:a});all()});
 s.on('admin_set_start_price',(p={},cb=()=>{})=>{if(!isA(s))return cb({ok:false,message:'방장 권한이 필요합니다.'});if(auction.status==='live'||auction.leader)return cb({ok:false,message:'진행 중에는 시작가를 바꿀 수 없습니다.'});const a=mi(p.amount);if(a===null)return cb({ok:false,message:'올바른 시작가를 입력해주세요.'});auction.startPrice=a;auction.currentPrice=a;cb({ok:true});io.emit('auction_state',state())});
 s.on('admin_start_auction',(_p={},cb=()=>{})=>{if(!isA(s))return cb({ok:false,message:'방장 권한이 필요합니다.'});clearH();auction.currentPrice=auction.startPrice;auction.leader=null;auction.logs=[];auction.status='live';cb({ok:true});all()});
 s.on('place_bid',(p={},cb=()=>{})=>{const u=participants.get(s.id);if(!u)return cb({ok:false,message:'먼저 경매에 참가해주세요.'});if(auction.status!=='live')return cb({ok:false,message:'방장이 아직 경매를 시작하지 않았습니다.'});const inc=mi(p.inc);if(!inc)return cb({ok:false,message:'입찰 금액이 올바르지 않습니다.'});const next=auction.currentPrice+inc,bal=balances.get(u.name)||0;if(next>bal)return cb({ok:false,message:'보유금이 부족합니다.'});clearH();auction.holds.set(u.name,next);auction.currentPrice=next;auction.leader=u.name;auction.logs.unshift({name:u.name,inc,total:next,ts:Date.now()});auction.logs=auction.logs.slice(0,100);cb({ok:true});all()});
 s.on('admin_close_auction',(_p={},cb=()=>{})=>{if(!isA(s))return cb({ok:false,message:'방장 권한이 필요합니다.'});if(!auction.leader)return cb({ok:false,message:'낙찰할 최고 입찰자가 없습니다.'});const w=auction.leader,pr=auction.currentPrice,b=balances.get(w)||0;if(b<pr)return cb({ok:false,message:'낙찰자의 보유금이 부족합니다.'});balances.set(w,b-pr);clearH();auction.status='sold';cb({ok:true,sold:true,winner:w,price:pr});all()});
 s.on('admin_cancel_auction',(_p={},cb=()=>{})=>{if(!isA(s))return cb({ok:false,message:'방장 권한이 필요합니다.'});clearH();auction.currentPrice=auction.startPrice;auction.leader=null;auction.status='ended';cb({ok:true});all()});
 s.on('admin_new_auction',(_p={},cb=()=>{})=>{if(!isA(s))return cb({ok:false,message:'방장 권한이 필요합니다.'});clearH();auction={...auction,startPrice:0,currentPrice:0,leader:null,status:'ready',holds:new Map(),logs:[]};cb({ok:true});all()});
 s.on('admin_end_auction',(_p={},cb=()=>{})=>{if(!isA(s))return cb({ok:false,message:'방장 권한이 필요합니다.'});clearH();auction.status='ended';cb({ok:true});all()});
 s.on('admin_off_auction',(_p={},cb=()=>{})=>{if(!isA(s))return cb({ok:false,message:'방장 권한이 필요합니다.'});participants.clear();balances.clear();clearH();auction={title:'오늘의 메인 슬롯',slot:{name:'',image:''},startPrice:0,currentPrice:0,leader:null,status:'ready',holds:new Map(),logs:[]};cb({ok:true});io.emit('auction_off');all()});
 s.on('disconnect',()=>{admins.delete(s.id);if(participants.delete(s.id))all()});
});
app.get('*',(_q,r)=>r.sendFile(path.join(__dirname,'index.html')));server.listen(PORT,'0.0.0.0',()=>console.log('sanak-auction running on '+PORT));
