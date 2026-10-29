import {randomBytes,scrypt as derive, timingSafeEqual, createHash} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(derive);
export const digest=t=>createHash('sha256').update(t).digest('hex');
export async function hashPassword(password){const salt=randomBytes(16).toString('hex');return salt+':'+(await scrypt(password,salt,64)).toString('hex');}
export async function verifyPassword(password,hash){const [salt,key]=hash.split(':'); const actual=await scrypt(password,salt,64);return timingSafeEqual(Buffer.from(key,'hex'),actual);}
export function cookieToken(req){const match=(req.headers.cookie||'').match(/(?:^|;\s*)pulse_session=([a-f0-9]{64})(?:;|$)/);return match?.[1];}
export async function getSession(db,req){const token=cookieToken(req);if(!token)return null;return (await db.query('SELECT u.id,u.username,u.display_name,u.bio,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2',[digest(token),new Date().toISOString()]))[0]||null;}
export async function issueSession(db,res,id,secure){const token=randomBytes(32).toString('hex');const expires=new Date(Date.now()+7*86400000).toISOString();await db.exec('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[digest(token),id,expires]);res.cookie('pulse_session',token,{httpOnly:true,sameSite:'lax',secure,maxAge:7*86400000,path:'/'});}
