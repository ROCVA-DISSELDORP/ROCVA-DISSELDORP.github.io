import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const rooms = new Map();
const missions = [
  { title:'Stroom terug in de basis', level:'Variabelen & operators', brief:'De basis is donker. Stel de energie in op 100 en bereken de reserve als de helft van de energie. Toon beide waarden met echo.', starter:'<?php\n$energy = 0;\n$reserve = 0;\n\n// Bereken de reserve en toon beide waarden.\n', check:code=>/\$energy\s*=\s*100\s*;/.test(code)&&/\$reserve\s*=\s*\$energy\s*\/\s*2\s*;/.test(code)&&/echo\s+\$energy/.test(code)&&/echo\s+\$reserve/.test(code), fail:'Zet $energy op 100, bereken $reserve met $energy / 2 en toon beide variabelen met echo.' },
  { title:'De luchtsluis openen', level:'If / else & vergelijken', brief:'De luchtsluis opent alleen als de batterij minimaal 25 is. Zet $doorOpen op true of false met een if/else.', starter:'<?php\n$battery = 40;\n$doorOpen = false;\n\n// Voeg hier de controle toe.\n', check:code=>/if\s*\(/.test(code)&&/\$battery\s*>=\s*25/.test(code)&&/\$doorOpen\s*=\s*true/.test(code)&&/else/.test(code)&&/\$doorOpen\s*=\s*false/.test(code), fail:'Gebruik if ($battery >= 25), zet de deur dan op true en gebruik else om hem op false te zetten.' },
  { title:'Repareer de panelen', level:'For-loop & teller', brief:'Er zijn vier panelen. Gebruik een for-loop om ze allemaal te repareren en verhoog per paneel $fixed met 1.', starter:'<?php\n$fixed = 0;\n\n// Herhaal de reparatie vier keer.\n', check:code=>/for\s*\(/.test(code)&&/\$fixed\s*(?:\+=\s*1|\+\+|=\s*\$fixed\s*\+\s*1)/.test(code)&&/4/.test(code), fail:'Maak een for-loop die vier keer loopt en verhoog in de loop $fixed met 1.' },
  { title:'Zoek defecte onderdelen', level:'Arrays & foreach', brief:'Loop met foreach door $parts. Tel alleen onderdelen waarvan de waarde "defect" is op in $broken.', starter:'<?php\n$parts = ["goed", "defect", "goed", "defect"];\n$broken = 0;\n\n// Loop door de onderdelen en tel defecte onderdelen.\n', check:code=>/foreach\s*\(\s*\$parts\s+as\s+\$\w+\s*\)/.test(code)&&/if\s*\(/.test(code)&&/defect/.test(code)&&/\$broken\s*(?:\+=\s*1|\+\+|=\s*\$broken\s*\+\s*1)/.test(code), fail:'Gebruik foreach ($parts as $part), controleer of $part gelijk is aan "defect" en verhoog dan $broken.' },
  { title:'Automatische noodreparatie', level:'Functies & combineren', brief:'Maak een functie repair($parts) die met foreach het aantal "defecte" onderdelen telt en dit aantal met return teruggeeft. Sla de uitkomst op in $fixed.', starter:'<?php\n$parts = ["defect", "goed", "defect"];\n\n// Maak repair($parts) en roep de functie aan.\n', check:code=>/function\s+repair\s*\(\s*\$parts\s*\)/.test(code)&&/foreach\s*\(/.test(code)&&/if\s*\(/.test(code)&&/defect/.test(code)&&/\$broken\s*(?:\+=\s*1|\+\+|=\s*\$broken\s*\+\s*1)/.test(code)&&/return\s+\$broken/.test(code)&&/\$fixed\s*=\s*repair\s*\(\s*\$parts\s*\)/.test(code), fail:'Maak function repair($parts), tel in foreach en geef de teller terug met return. Sla de functie-uitkomst op in $fixed.' }
];
const cleanName = value => String(value || '').trim().replace(/[<>]/g,'').slice(0,24);
const safeCode = value => String(value || '').slice(0,12000);
const roomView = (room, playerId) => ({
  code:room.code, name:room.name, mode:room.mode, duration:room.duration,
  startedAt:room.startedAt, endsAt:room.endsAt, endedAt:room.endedAt,
  score:room.score, heat:room.heat, taskIndex:room.taskIndex, codeText:room.codeText,
  lastRun:room.lastRun, log:room.log.slice(-14), revision:room.revision,
  players:room.players.map(({id,name,host,joinedAt,lastSeen})=>({id,name,host,joinedAt,online:Date.now()-(lastSeen||joinedAt)<6500})),
  mission:missions[room.taskIndex] ? (({title,level,brief,starter})=>({title,level,brief,starter}))(missions[room.taskIndex]) : null,
  yourRole:room.players.find(p=>p.id===playerId)?.role || null,
  yourJob:(()=>{const index=room.players.findIndex(p=>p.id===playerId),count=room.players.length;if(index<0||!count)return null;const shift=((room.taskIndex||0)*(count===2?1:2))%count,relative=(index-shift+count)%count;if(relative===0)return 'driver';if(relative===1)return count===2?'navigator + tester':'navigator';if(relative===2)return 'test lead';return 'analist';})(),
  yourSecretTask:room.players.find(p=>p.id===playerId)?.secretTask || null,
  yourQaDone:!!room.players.find(p=>p.id===playerId)?.qaDone,
  completed:room.completed,
  revealedRoles:room.endedAt ? room.players.map(p=>({id:p.id,name:p.name,role:p.role,qaDone:p.qaDone})) : null
});
const sendJson = (res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(body));};
const readJson = async req => {let body='';for await(const part of req){body+=part;if(body.length>20000)throw Error('Verzoek te groot');}return body?JSON.parse(body):{};};
const createCode = ()=>{let code;do{code=Math.random().toString(36).slice(2,6).toUpperCase();}while(rooms.has(code));return code;};
const addLog = (room, text, kind='info')=>{room.log.push({text,kind,at:Date.now()});room.log=room.log.slice(-30);room.revision++;};
async function handleApi(req,res,url){
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}).end();return true;}
  const parts=url.pathname.split('/').filter(Boolean);
  if(url.pathname==='/api/info'&&req.method==='GET'){
    const addresses=Object.values(os.networkInterfaces()).flat().filter(item=>item&&item.family==='IPv4'&&!item.internal).map(item=>item.address);
    sendJson(res,200,{port:server.address()?.port||3000,addresses});return true;
  }
  if(parts.length===2&&parts[0]==='api'&&parts[1]==='rooms'&&req.method==='GET'){
    sendJson(res,200,[...rooms.values()].map(r=>({code:r.code,name:r.name,mode:r.mode,players:r.players.length,started:!!r.startedAt,ended:!!r.endedAt})));return true;
  }
  if(url.pathname==='/api/rooms'&&req.method==='POST'){
    const body=await readJson(req),playerName=cleanName(body.playerName)||cleanName(body.name)||'Crew',name=cleanName(body.roomName)||`${playerName}'s Crew`;
    if(!['crew','undercover'].includes(body.mode))return sendJson(res,400,{error:'Kies een spelmodus.'}),true;
    const room={code:createCode(),name,mode:body.mode,duration:Math.min(20,Math.max(5,Number(body.duration)||10))*60,players:[],startedAt:null,endsAt:null,endedAt:null,score:0,heat:0,taskIndex:0,codeText:missions[0].starter,lastRun:null,log:[],revision:1,completed:false};
    const player={id:crypto.randomUUID(),name:playerName,host:true,joinedAt:Date.now(),lastSeen:Date.now(),role:'crew',qaDone:false};room.players.push(player);rooms.set(room.code,room);addLog(room,`${playerName} heeft de lobby geopend.`);
    sendJson(res,201,{room:roomView(room,player.id),playerId:player.id});return true;
  }
  if(parts.length===3&&parts[0]==='api'&&parts[1]==='rooms'){
    const room=rooms.get(parts[2].toUpperCase());if(!room){sendJson(res,404,{error:'Deze lobby bestaat niet meer.'});return true;}
    if(req.method==='GET'){
      const playerId=url.searchParams.get('playerId');if(!room.players.some(p=>p.id===playerId)){sendJson(res,403,{error:'Je hoort niet bij deze lobby.'});return true;}
      room.players.find(p=>p.id===playerId).lastSeen=Date.now();
      if(room.endsAt&&Date.now()>=room.endsAt&&!room.endedAt){room.endedAt=Date.now();addLog(room,'De timer is afgelopen. Tijd voor de nabespreking.','warn');}
      sendJson(res,200,roomView(room,playerId));return true;
    }
    if(req.method==='POST'){
      const body=await readJson(req),type=body.type,player=room.players.find(p=>p.id===body.playerId);
      if(type==='join'){
        const name=cleanName(body.name)||'Crewlid';let existing=room.players.find(p=>p.id===body.playerId);
        if(!existing){if(room.startedAt){sendJson(res,409,{error:'Deze missie is al gestart.'});return true;}if(room.players.length>=10){sendJson(res,409,{error:'Deze lobby zit vol (maximaal 10 spelers).'});return true;}existing={id:crypto.randomUUID(),name,host:false,joinedAt:Date.now(),lastSeen:Date.now(),role:'crew',qaDone:false};room.players.push(existing);addLog(room,`${name} is aangesloten.`);}
        sendJson(res,200,{room:roomView(room,existing.id),playerId:existing.id});return true;
      }
      if(!player){sendJson(res,403,{error:'Je hoort niet bij deze lobby.'});return true;}
      player.lastSeen=Date.now();
      if(type==='start'){
        if(!player.host){sendJson(res,403,{error:'Alleen de host kan de missie starten.'});return true;}
        if(room.startedAt){sendJson(res,409,{error:'De missie is al gestart.'});return true;}
        if(room.players.length<2){sendJson(res,409,{error:'Er zijn minimaal 2 spelers nodig.'});return true;}
        room.startedAt=Date.now();room.endsAt=room.startedAt+room.duration*1000;
        room.players.forEach(p=>p.role='crew');
        if(room.mode==='undercover'){const count=room.players.length>=8?2:1;const shuffled=[...room.players].sort(()=>Math.random()-.5);shuffled.slice(0,count).forEach((p,i)=>{p.role='undercover';p.secretTask=i%2===0?'Test of je oplossing ook werkt met een lege lijst of waarde 0.':'Zoek een grenswaarde waarop de deur of teller verkeerd reageert.';});}
        addLog(room,`${player.name} startte de missie. De klok loopt!`,'good');
      } else if(type==='code'){
        if(!room.startedAt||room.endedAt||room.completed){sendJson(res,409,{error:'De code is op dit moment vergrendeld.'});return true;}
        room.codeText=safeCode(body.code);room.revision++;
      } else if(type==='run'){
        if(!room.startedAt||room.endedAt||room.completed){sendJson(res,409,{error:'De missie is niet actief.'});return true;}
        const task=missions[room.taskIndex],submitted=safeCode(body.code);room.codeText=submitted;
        if(task.check(submitted)){
          room.score+=100;room.heat=Math.max(0,room.heat-1);room.lastRun={ok:true,message:'Code geaccepteerd. Het systeem is hersteld!',by:player.name,at:Date.now()};
          addLog(room,`${player.name} herstelde: ${task.title}.`,'good');room.taskIndex++;
          if(room.taskIndex>=missions.length){room.completed=true;room.endedAt=Date.now();addLog(room,'Alle systemen zijn hersteld. Missie geslaagd!','good');}
          else room.codeText=missions[room.taskIndex].starter;
        }else{
          room.heat=Math.min(5,room.heat+1);room.score=Math.max(0,room.score-10);room.lastRun={ok:false,message:task.fail,by:player.name,at:Date.now()};
          addLog(room,`${player.name} testte code. Controleer de foutmelding en probeer opnieuw.`,'warn');
        }
      } else if(type==='hint'){
        if(!room.startedAt||room.endedAt){sendJson(res,409,{error:'De missie is niet actief.'});return true;}
        room.endsAt=Math.max(Date.now(),room.endsAt-15000);room.score=Math.max(0,room.score-5);room.lastRun={ok:null,message:missions[room.taskIndex]?.fail||'Gebruik de begrippen uit de opdracht.',by:player.name,at:Date.now()};addLog(room,`${player.name} vroeg om een hint. (15 seconden en 5 punten kosten)`,'warn');
      } else if(type==='qa'){
        if(player.role!=='undercover'){sendJson(res,403,{error:'Deze geheime test hoort niet bij jouw rol.'});return true;}
        if(!player.qaDone){player.qaDone=true;room.score+=15;addLog(room,'Een geheime randgevaltest is uitgevoerd.','info');}
      } else if(type==='end'){
        if(!player.host){sendJson(res,403,{error:'Alleen de host kan de missie beëindigen.'});return true;}
        room.endedAt=Date.now();addLog(room,`${player.name} beëindigde de missie.`,'warn');
      } else if(type==='reset'){
        if(!player.host){sendJson(res,403,{error:'Alleen de host kan de lobby resetten.'});return true;}
        room.startedAt=null;room.endsAt=null;room.endedAt=null;room.score=0;room.heat=0;room.taskIndex=0;room.codeText=missions[0].starter;room.lastRun=null;room.completed=false;room.players.forEach(p=>{p.role='crew';p.qaDone=false;});addLog(room,'De host heeft een nieuwe ronde klaargezet.');
      }else{sendJson(res,400,{error:'Onbekende actie.'});return true;}
      sendJson(res,200,{room:roomView(room,player.id)});return true;
    }
  }
  return false;
}
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if(url.pathname.startsWith('/api/')){if(await handleApi(req,res,url))return;}
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filename = path.resolve(root, '.' + relative);
    if (!filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(filename);
    res.writeHead(200, { 'Content-Type':types[path.extname(filename)] || 'application/octet-stream', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer' });
    res.end(data);
  } catch { res.writeHead(404).end('Niet gevonden'); }
});
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
  const addresses=Object.values(os.networkInterfaces()).flat().filter(item=>item&&item.family==='IPv4'&&!item.internal).map(item=>item.address);
  console.log('Codegroei staat klaar op http://localhost:' + server.address().port);
  if(addresses.length)console.log('Code Crew voor studenten: '+addresses.map(address=>`http://${address}:${server.address().port}/codecrew.html`).join(' | '));
});
