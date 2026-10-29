import 'dotenv/config';
import {spawn} from 'node:child_process';
const portIndex=process.argv.indexOf('--port');
const port=portIndex>=0?process.argv[portIndex+1]:'5173';
const serverEnv={...process.env,PUBLIC_ORIGIN:process.env.PUBLIC_ORIGIN||'http://localhost:'+port};
const children=[spawn(process.execPath,['--watch','server/index.js'],{stdio:'inherit',env:serverEnv}),spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','0.0.0.0',...process.argv.slice(2)],{stdio:'inherit'})];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');setTimeout(()=>process.exit(code),300).unref();}
for(const child of children){child.on('exit',code=>stop(code||0));child.on('error',()=>stop(1));}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
