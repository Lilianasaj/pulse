import 'dotenv/config';
import {createApp} from './app.js';
const service=await createApp();
service.http.listen(Number(process.env.PORT||3000),process.env.HOST||'0.0.0.0',()=>console.log(`Pulse Chat listening on port ${process.env.PORT||3000}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await service.close();process.exit(0);});
