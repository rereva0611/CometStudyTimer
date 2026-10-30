// Older databases have no saved-task ID; use their latest timer record once.
export function lastTimerTask(state) {
  let latest=null,latestDate='';
  for(const [date,day] of Object.entries(state.records)){
    for(const session of day.sessions){
      if(session.source!=='timer')continue;
      if(session.id===state.lastTimerSessionId)return session.note.trim()?session:null;
      if(!latest||date>latestDate||(date===latestDate&&(session.end??-1)>=(latest.end??-1))){latest=session;latestDate=date;}
    }
  }
  return latest?.note.trim()?latest:null;
}
