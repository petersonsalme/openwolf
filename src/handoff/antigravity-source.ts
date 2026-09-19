import * as fs from 'node:fs';
import * as path from 'node:path';
import {reconcileActive} from '../hooks/handoff-state.js';
import type {EventKind,EvidenceEvent,SessionMeta,SessionRead,SessionSource} from './types.js';

// Antigravity has no decodable session transcript (its native conversation
// storage isn't a stable, documented format), so unlike LocalSessions this
// reader never touches a transcript file. It replays the same hook-captured
// checkpoint state that already accumulates in .wolf/handoff/active/ during
// a normal session — the same evidence source OpenWolf already trusts for
// live context injection — instead of pretending to recover a full history.

const activeDir=(root:string)=>path.join(root,'.wolf','handoff','active');

function toEventKind(kind:string):EventKind {
  if(kind==='request')return 'user';
  if(kind==='compaction')return 'compaction';
  if(kind==='semantic-checkpoint'||kind==='handover-import')return 'assistant';
  if(kind==='turn-end'||kind==='session-end')return 'boundary';
  return 'tool-result';
}

export class AntigravitySessions implements SessionSource {
  constructor(private root:string){}
  async list():Promise<{sessions:SessionMeta[];gaps:string[]}> {
    const dir=activeDir(this.root);let names:string[]=[];
    try{names=fs.readdirSync(dir).filter(n=>n.endsWith('.json')&&!n.endsWith('.json.events'))}catch{}
    const sessions:SessionMeta[]=[];
    for(const n of names){
      try{
        const file=path.join(dir,n);const state=JSON.parse(fs.readFileSync(file,'utf8'));
        if(state.agent!=='antigravity'||!state.session)continue;
        sessions.push({agent:'antigravity',id:state.session,title:(state.objective||'(no objective captured)').slice(0,120),cwd:this.root,file,updated_at:state.updated_at||new Date(0).toISOString(),sidechain:false});
      }catch{}
    }
    const gaps=sessions.length?[]:['No antigravity checkpoint state found; Antigravity conversation text is not decoded, so evidence exists only after hooks have captured a session'];
    return {sessions:sessions.sort((a,b)=>b.updated_at.localeCompare(a.updated_at)),gaps};
  }
  async read(id:string,cursor=0,limit=200):Promise<SessionRead> {
    if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(limit)||limit<1||limit>5000)throw Error('Invalid event page');
    const state=reconcileActive(this.root,'antigravity',id);
    if(!state.updated_at)throw Error('Session is unavailable in this worktree');
    const events:EvidenceEvent[]=state.recent.map(e=>({id:e.id,at:e.at,kind:toEventKind(e.kind),text:e.text,paths:[],source:{file:'hook-capture',line:0,sha256:''}}));
    const session:SessionMeta={agent:'antigravity',id,title:(state.objective||'(no objective captured)').slice(0,120),cwd:this.root,file:'hook-capture',updated_at:state.updated_at,sidechain:false};
    const gaps=['Antigravity conversation text is not decoded; events are derived from hook-captured checkpoints only, not a full transcript'];
    return {schema:1,session,events:events.slice(cursor,cursor+limit),sources:[],gaps,next_cursor:cursor+limit<events.length?cursor+limit:null,total_events:events.length};
  }
}
