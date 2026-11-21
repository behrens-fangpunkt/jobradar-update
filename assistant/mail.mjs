import {ProviderError, base64url, fromBase64, providerConfig, tokenGrant, mailboxAddress, validAddress,
  conversation, prepareOutlook, sendProviderMessage, findSent} from "./mail-provider.mjs";

const origin = "https://jobradar-assistant.billowing-shape-d74b.workers.dev";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const providers = ["outlook","gmail"];
const idPattern = /^[a-f0-9]{64}$/;
const random = size => base64url(crypto.getRandomValues(new Uint8Array(size)));
const digest = value => crypto.subtle.digest("SHA-256",encoder.encode(value)).then(result => new Uint8Array(result));
const hash = async value => Array.from(await digest(value), byte => byte.toString(16).padStart(2,"0")).join("");
const callback = provider => origin + "/mail/callback/" + provider;
const mailboxKey = account => account.provider + ":" + account.address.toLowerCase();
const credentials = row => ({provider:row.provider,address:row.address});
const query = (db, sql, ...values) => db.prepare(sql).bind(...values);

class MailError extends Error {
  constructor(status, reason) { super(reason); this.status = status; this.reason = reason; }
}

async function encryptionKey(env) {
  const key = fromBase64(env.MAIL_TOKEN_KEY || "");
  if (key.length !== 32) throw new MailError(503,"mail_unavailable");
  return crypto.subtle.importKey("raw",key,"AES-GCM",false,["encrypt","decrypt"]);
}

async function seal(env, owner, account, tokens) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = encoder.encode(owner + ":" + mailboxKey(account));
  const encrypted = await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData},await encryptionKey(env),encoder.encode(JSON.stringify(tokens)));
  return base64url(iv) + "." + base64url(new Uint8Array(encrypted));
}

async function unseal(env, owner, account) {
  const [iv, data] = account.tokens.split(".");
  const additionalData = encoder.encode(owner + ":" + mailboxKey(account));
  const clear = await crypto.subtle.decrypt({name:"AES-GCM",iv:fromBase64(iv),additionalData},await encryptionKey(env),fromBase64(data));
  return JSON.parse(decoder.decode(clear));
}

function finishPage(code) {
  const instructions = code
    ? '<p>Kopiere den Code, wechsle zu JobRadar zurück und füge ihn dort ein.</p><input type="text" id="code" aria-label="Bestätigungscode" readonly value="' + code + '"><button type="button" id="copy">Code kopieren</button><p id="status" role="status"></p>'
    : '<p>Die Anmeldung konnte nicht abgeschlossen werden. Öffne JobRadar und starte die Verbindung erneut.</p>';
  return new Response('<!DOCTYPE html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>JobRadar · E-Mail verbinden</title><style>body{font:17px system-ui;background:#f6f5fb;color:#17162b;margin:0;padding:24px}main{max-width:460px;margin:6vh auto}input,button{padding:12px;margin:8px 0;font:inherit;width:100%;box-sizing:border-box;border-radius:10px}input{border:1px solid #777}button{background:#4f46e5;color:white;border:0}</style>' +
    '<main><h1>JobRadar</h1>' + instructions + '</main>' + (code ? '<script>document.getElementById("copy").onclick=async()=>{const input=document.getElementById("code");try{await navigator.clipboard.writeText(input.value);document.getElementById("status").textContent="Kopiert. Öffne jetzt JobRadar."}catch{input.select()}};</script>' : '') + '</html>',
  {status:code ? 200 : 400,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer",
    "Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"}});
}

async function startConnect(env, owner, provider) {
  const config = providerConfig(provider,env);
  if (!config) throw new MailError(400,"provider_unavailable");
  await encryptionKey(env);
  const state = random(32);
  const verifier = random(48);
  const expires = Date.now() + 10 * 60 * 1000;
  await env.MAIL_DB.batch([
    query(env.MAIL_DB,"DELETE FROM mail_connections WHERE expires < ? OR owner = ?",Date.now(),owner),
    query(env.MAIL_DB,"INSERT INTO mail_connections (state,owner,provider,verifier,expires) VALUES (?,?,?,?,?)",await hash(state),owner,provider,verifier,expires)
  ]);
  const params = new URLSearchParams({client_id:config.client_id, response_type:"code", redirect_uri:callback(provider),
    scope:config.scope,state,code_challenge:base64url(await digest(verifier)),code_challenge_method:"S256"});
  if (provider === "gmail") { params.set("access_type","offline"); params.set("prompt","consent select_account"); }
  else params.set("prompt","select_account");
  return {url:config.authorize + "?" + params};
}

async function completeOAuth(env, provider, url) {
  const config = providerConfig(provider,env);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!config || !state || !code || !/^[A-Za-z0-9_-]{43}$/.test(state)) return finishPage();
  const key = await hash(state);
  const claimed = await query(env.MAIL_DB,"UPDATE mail_connections SET claimed=1 WHERE state=? AND provider=? AND expires>? AND claimed=0 RETURNING owner,verifier",key,provider,Date.now()).first();
  if (!claimed) return finishPage();
  const tokens = await tokenGrant(config,{grant_type:"authorization_code",code,redirect_uri:callback(provider),code_verifier:claimed.verifier});
  const address = await mailboxAddress(provider,tokens.access);
  if (!validAddress(address)) return finishPage();
  const confirmation = random(18);
  const encrypted = await seal(env,claimed.owner,{provider,address},tokens);
  const saved = await query(env.MAIL_DB,"UPDATE mail_connections SET confirmation=?,address=?,tokens=?,verifier='' WHERE state=? AND expires>? RETURNING owner",
    await hash(confirmation),address,encrypted,key,Date.now()).first();
  return finishPage(saved ? confirmation : null);
}

async function confirmConnection(env, owner, code) {
  if (!/^[A-Za-z0-9_-]{24}$/.test(code || "")) throw new MailError(400,"invalid_confirmation");
  const pending = await query(env.MAIL_DB,"DELETE FROM mail_connections WHERE owner=? AND confirmation=? AND expires>? RETURNING provider,address,tokens",owner,await hash(code),Date.now()).first();
  if (!pending) throw new MailError(400,"invalid_confirmation");
  await query(env.MAIL_DB,"INSERT INTO mail_accounts (owner,provider,address,tokens) VALUES (?,?,?,?) ON CONFLICT(owner) DO UPDATE SET provider=excluded.provider,address=excluded.address,tokens=excluded.tokens",
    owner,pending.provider,pending.address,pending.tokens).run();
  return {account:credentials(pending)};
}

async function accessToken(env, owner, account) {
  const current = await unseal(env,owner,account);
  if (current.expires > Date.now() + 60000) return current.access;
  const config = providerConfig(account.provider,env);
  if (!config) throw new MailError(401,"mail_reconnect");
  let updated;
  try {
    updated = await tokenGrant(config,{grant_type:"refresh_token",refresh_token:current.refresh},current);
  } catch (error) {
    if (!(error instanceof ProviderError) || error.status >= 500 || error.status === 429) throw error;
    const newer = await query(env.MAIL_DB,"SELECT * FROM mail_accounts WHERE owner=?",owner).first();
    if (newer && mailboxKey(newer) === mailboxKey(account) && newer.tokens !== account.tokens) return (await unseal(env,owner,newer)).access;
    throw new MailError(401,"mail_reconnect");
  }
  await query(env.MAIL_DB,"UPDATE mail_accounts SET tokens=? WHERE owner=? AND tokens=?",await seal(env,owner,account,updated),owner,account.tokens).run();
  return updated.access;
}

async function ownedThread(env, owner, mailbox, id) {
  const thread = idPattern.test(id || "") ? await query(env.MAIL_DB,"SELECT * FROM mail_threads WHERE owner=? AND mailbox=? AND id=?",owner,mailbox,id).first() : null;
  if (!thread) throw new MailError(404,"thread_missing");
  return thread;
}

function attachmentFrom(form) {
  const data = form.get("attachment");
  if (!data) return null;
  const name = form.get("filename")?.trim();
  const type = form.get("filetype");
  const types = ["application/pdf","application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document","image/jpeg","image/png","text/plain"];
  if (!name || name.length > 120 || /[\r\n]/.test(name) || !types.includes(type) || data.length > 2796204
    || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new MailError(400,"invalid_attachment");
  return {name,type,data};
}

function readDraft(form) {
  const recipient = form.get("recipient")?.trim();
  const subject = form.get("subject")?.trim();
  const body = form.get("body")?.trim();
  const id = form.get("id");
  if (!validAddress(recipient) || !subject || subject.length > 150 || /[\r\n]/.test(subject)
    || !body || body.length > 16000 || !/^[a-f0-9]{32}$/.test(id || "")) throw new MailError(400,"invalid_draft");
  return {id,recipient,subject,body,attachment:attachmentFrom(form)};
}

async function confirmSent(db, owner, mailbox, send, ref) {
  if (!ref) return;
  await db.batch([
    query(db,"UPDATE mail_sends SET state='sent' WHERE owner=? AND mailbox=? AND id=? AND state='sending'",owner,mailbox,send.id),
    query(db,"UPDATE mail_threads SET thread_ref=COALESCE(thread_ref,?), latest_inbound=CASE WHEN latest_at<=? THEN 0 ELSE latest_inbound END, latest_at=MAX(latest_at,?) WHERE id=? AND owner=? AND mailbox=?",
      ref,send.created,send.created,send.thread_id,owner,mailbox)
  ]);
}

async function reconcileSends(env, owner, account, access, thread) {
  const mailbox = mailboxKey(account);
  await query(env.MAIL_DB,"UPDATE mail_sends SET state='failed' WHERE owner=? AND mailbox=? AND thread_id=? AND state='sending' AND provider_message IS NULL AND created<?",
    owner,mailbox,thread.id,Date.now()-120000).run();
  const {results} = await query(env.MAIL_DB,"SELECT id,thread_id,provider_message,created FROM mail_sends WHERE owner=? AND mailbox=? AND thread_id=? AND state='sending' AND provider_message IS NOT NULL ORDER BY created DESC LIMIT 5",owner,mailbox,thread.id).all();
  for (const send of results) {
    try {
      const found = await findSent(account.provider,access,send.provider_message);
      if (found) { await confirmSent(env.MAIL_DB,owner,mailbox,send,found); thread.thread_ref ||= found; }
    } catch (error) { if (!(error instanceof ProviderError) || error.status !== 404) throw error; }
  }
}

async function syncThread(env, owner, account, access, thread, includeBody) {
  await reconcileSends(env,owner,account,access,thread);
  if (!thread.thread_ref) return [];
  const messages = await conversation(account.provider,access,account.address,thread.thread_ref,includeBody);
  const last = messages.at(-1);
  if (last) await query(env.MAIL_DB,"UPDATE mail_threads SET latest_at=?,latest_inbound=? WHERE id=? AND owner=? AND mailbox=? AND latest_at<=?",
    last.at,last.outgoing ? 0 : 1,thread.id,owner,mailboxKey(account),last.at).run();
  return messages;
}

async function sendDraft(env, owner, account, access, form, existing) {
  const draft = readDraft(form);
  const db = env.MAIL_DB, mailbox = mailboxKey(account), created = Date.now();
  const previous = await query(db,"SELECT id,thread_id,state FROM mail_sends WHERE owner=? AND mailbox=? AND id=?",owner,mailbox,draft.id).first();
  if (previous) return {thread:previous.thread_id,state:previous.state};
  const threadId = existing?.id || await hash(owner + ":" + mailbox + ":" + draft.id);
  let replyTo;
  if (existing) {
    if (!existing.thread_ref) throw new MailError(409,"send_pending");
    const messages = await conversation(account.provider,access,account.address,existing.thread_ref,false);
    replyTo = messages.filter(message=>!message.outgoing).at(-1) || messages.at(-1);
    if (!replyTo) throw new MailError(409,"thread_missing");
    const recipient = replyTo.outgoing ? existing.recipient : replyTo.replyTo;
    if (!recipient || draft.recipient.toLowerCase() !== recipient.toLowerCase()) throw new MailError(409,"recipient_changed");
    draft.subject = "Re: " + (replyTo.subject || existing.subject).replace(/^Re:\s*/i, "");
  }
  const writes = [];
  if (!existing) {
    const company = form.get("company")?.trim().slice(0,200);
    const business = form.get("business")?.trim().slice(0,240);
    if (!company || !business) throw new MailError(400,"invalid_draft");
    writes.push(query(db,"INSERT OR IGNORE INTO mail_threads (id,owner,mailbox,business_id,company,recipient,subject,latest_at) VALUES (?,?,?,?,?,?,?,?)",
      threadId,owner,mailbox,business,company,draft.recipient,draft.subject,created));
  }
  writes.push(query(db,"INSERT OR IGNORE INTO mail_sends (owner,mailbox,id,thread_id,state,created) VALUES (?,?,?,?,'sending',?) RETURNING id",owner,mailbox,draft.id,threadId,created));
  const claimed = (await db.batch(writes)).at(-1).results;
  if (!claimed.length) {
    const current = await query(db,"SELECT thread_id,state FROM mail_sends WHERE owner=? AND mailbox=? AND id=?",owner,mailbox,draft.id).first();
    return {thread:current.thread_id,state:current.state};
  }

  let crossedSend = false;
  let accepted = false;
  try {
    const ref = account.provider === "gmail" ? `<jobradar-${draft.id}@${new URL(origin).hostname}>` : await prepareOutlook(access,draft,replyTo);
    const sendLock = await query(db,"UPDATE mail_sends SET provider_message=? WHERE owner=? AND mailbox=? AND id=? AND state='sending' RETURNING id",ref,owner,mailbox,draft.id).first();
    if (!sendLock) return {thread:threadId,state:"failed"};
    crossedSend = true;
    let sent = await sendProviderMessage(account.provider,access,account.address,draft,ref,draft.id,existing?.thread_ref,replyTo);
    accepted = true;
    if (account.provider === "outlook") sent = await findSent("outlook",access,ref);
    await confirmSent(db,owner,mailbox,{id:draft.id,thread_id:threadId,created},sent);
    return {thread:threadId,state:sent ? "sent" : "sending"};
  } catch (error) {
    if (accepted || (crossedSend && (!(error instanceof ProviderError) || error.status >= 500))) return {thread:threadId,state:"sending"};
    await query(db,"UPDATE mail_sends SET state='failed' WHERE owner=? AND mailbox=? AND id=?",owner,mailbox,draft.id).run();
    if (error instanceof ProviderError && error.status === 401) throw new MailError(401,"mail_reconnect");
    return {thread:threadId,state:"failed"};
  }
}

export async function handleMail(request, env, reply, readForm) {
  const url = new URL(request.url), path = url.pathname;
  try {
    if (request.method === "GET" && path.startsWith("/mail/callback/")) {
      return env.MAIL_DB ? await completeOAuth(env,path.split("/").at(-1),url) : finishPage();
    }
    if (request.method !== "POST") return reply(405,{error:"method_not_allowed"});
    if (request.headers.get("Content-Type")?.split(";")[0] !== "application/x-www-form-urlencoded") return reply(415,{error:"content_type"});
    if (!env.MAIL_DB || !env.MAIL_TOKEN_KEY) return reply(503,{error:"mail_unavailable"});
    const send = path === "/mail/send" || path === "/mail/reply";
    const form = await readForm(request,send ? 8500000 : 4096);
    if (!form) return reply(413,{error:"request_too_large"});
    const device = form.get("device");
    if (!idPattern.test(device || "")) return reply(401,{error:"invalid_device"});
    const owner = await hash(device);
    const account = await query(env.MAIL_DB,"SELECT * FROM mail_accounts WHERE owner=?",owner).first();
    if (path === "/mail/status") return reply(200,{account:account ? credentials(account) : null,providers:providers.filter(provider=>providerConfig(provider,env))});
    if (path === "/mail/connect") {
      const network = request.headers.get("CF-Connecting-IP") || owner;
      if (!(await env.DRAFT_RATE_LIMITER.limit({key:"mail-connect:" + network})).success) return reply(429,{error:"try_again_later"});
      return reply(200,await startConnect(env,owner,form.get("provider")));
    }
    if (path === "/mail/confirm") return reply(200,await confirmConnection(env,owner,form.get("confirmation")));
    if (path === "/mail/disconnect") {
      await env.MAIL_DB.batch([query(env.MAIL_DB,"DELETE FROM mail_accounts WHERE owner=?",owner),query(env.MAIL_DB,"DELETE FROM mail_connections WHERE owner=?",owner)]);
      return reply(200,{account:null});
    }
    if (!account) return reply(401,{error:"mail_disconnected"});
    const mailbox = mailboxKey(account);
    if (path === "/mail/list") {
      const {results} = await query(env.MAIL_DB,"SELECT id,business_id,company,recipient,subject,latest_at,latest_inbound,thread_ref IS NOT NULL AS sent, EXISTS(SELECT 1 FROM mail_sends WHERE owner=? AND mailbox=? AND thread_id=mail_threads.id AND state='sending') AS pending FROM mail_threads WHERE owner=? AND mailbox=? AND (thread_ref IS NOT NULL OR pending) ORDER BY latest_at DESC",owner,mailbox,owner,mailbox).all();
      return reply(200,{threads:results});
    }
    if (!["/mail/thread","/mail/sync","/mail/send","/mail/reply"].includes(path)) return reply(404,{error:"not_found"});
    const access = await accessToken(env,owner,account);
    if (path === "/mail/sync") {
      const ids = [...new Set(form.getAll("thread"))];
      if (!ids.length || ids.length > 6) throw new MailError(400,"invalid_sync");
      const results = await Promise.allSettled(ids.map(async id => syncThread(env,owner,account,access,await ownedThread(env,owner,mailbox,id),false)));
      const failures = results.filter(result=>result.status === "rejected");
      if (failures.length === results.length) throw failures[0].reason;
      return reply(200,{partial:!!failures.length});
    }
    const thread = path === "/mail/send" ? null : await ownedThread(env,owner,mailbox,form.get("thread"));
    if (path === "/mail/thread") {
      const messages = await syncThread(env,owner,account,access,thread,true);
      const lastReply = messages.filter(message=>!message.outgoing).at(-1);
      const {results:pending} = await query(env.MAIL_DB,"SELECT id FROM mail_sends WHERE owner=? AND mailbox=? AND thread_id=? AND state='sending' LIMIT 1",owner,mailbox,thread.id).all();
      return reply(200,{company:thread.company,subject:thread.subject,business_id:thread.business_id,sent:!!thread.thread_ref,latest_at:messages.at(-1)?.at || thread.latest_at,
        replyTo:lastReply?.replyTo || thread.recipient,messages,pending:!!pending.length});
    }
    return reply(200,await sendDraft(env,owner,account,access,form,thread));
  } catch (error) {
    if (request.method === "GET") return finishPage();
    if (error instanceof MailError) return reply(error.status,{error:error.reason});
    if (error instanceof ProviderError && error.status === 401) return reply(401,{error:"mail_reconnect"});
    return reply(502,{error:"mail_provider_error"});
  }
}
