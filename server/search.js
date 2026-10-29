// Durable outbox: a failed Elasticsearch write is retried, never drops a message.
// PostgreSQL remains the source of truth; search falls back to SQL when ES is unavailable.
export function startIndexer(db,url){
  if(!url)return ()=>{};
  let stopped=false,busy=false;
  async function tick(){if(stopped||busy)return;busy=true;try{
    const rows=await db.query('SELECT m.* FROM search_outbox o JOIN messages m ON m.id=o.message_id ORDER BY m.id LIMIT 100');
    if(rows.length){
      const body=rows.map(m=>JSON.stringify({index:{_index:'pulse-messages',_id:String(m.id)}})+'\n'+JSON.stringify(m)+'\n').join('');
      const r=await fetch(url+'/_bulk',{method:'POST',headers:{'content-type':'application/x-ndjson'},body,signal:AbortSignal.timeout(5000)});
      if(!r.ok)throw Error('Index HTTP '+r.status);const result=await r.json();
      for(let i=0;i<rows.length;i++)if(result.items?.[i]?.index?.status<300)await db.exec('DELETE FROM search_outbox WHERE message_id=$1',[rows[i].id]);
    }
  }catch(e){console.error('Search index retry:',e.message);}finally{busy=false;}}
  const timer=setInterval(tick,2000);timer.unref();tick();return ()=>{stopped=true;clearInterval(timer);};
}
export async function searchMessages(db,url,channel,q){
  if(url)try{
    const r=await fetch(url+'/pulse-messages/_search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({size:50,query:{bool:{filter:[{term:{'channel_id.keyword':channel}}],must:[{match_phrase:{text:q}}]}},sort:[{id:'desc'}]}),signal:AbortSignal.timeout(1500)});
    if(r.ok){const data=await r.json();const ids=data.hits.hits.map(h=>Number(h._id));if(ids.length)return {ids,engine:'elasticsearch'};}
  }catch{/* SQL fallback */}
  // Escape LIKE wildcards: user input is a literal substring.
  const pattern='%'+q.toLowerCase().replace(/[\\%_]/g,'\\$&')+'%';
  const rows=await db.query("SELECT id FROM messages WHERE channel_id=$1 AND LOWER(text) LIKE $2 ESCAPE '\\' ORDER BY id DESC LIMIT 50",[channel,pattern]);
  return {ids:rows.map(r=>Number(r.id)),engine:'sql'};
}
