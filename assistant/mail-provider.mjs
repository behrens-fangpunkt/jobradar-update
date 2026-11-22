const GRAPH = "https://graph.microsoft.com/v1.0/me";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const graphHeaders = {Prefer:'IdType="ImmutableId", outlook.body-content-type="text"'};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ProviderError extends Error {
  constructor(status, microsoftCode) {
    super(`Mail provider returned ${status}`);
    this.status = status;
    this.microsoftCode = microsoftCode;
  }
}

export function base64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}
export const base64url = bytes => base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromBase64 = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));

export function providerConfig(provider, env) {
  if (provider === "outlook" && env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
    const base = "https://login.microsoftonline.com/common/oauth2/v2.0";
    return {client_id:env.MICROSOFT_CLIENT_ID, client_secret:env.MICROSOFT_CLIENT_SECRET,
      authorize:base + "/authorize", token:base + "/token", scope:"offline_access User.Read Mail.ReadWrite Mail.Send"};
  }
  if (provider === "gmail" && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return {client_id:env.GOOGLE_CLIENT_ID, client_secret:env.GOOGLE_CLIENT_SECRET,
      authorize:"https://accounts.google.com/o/oauth2/v2/auth", token:"https://oauth2.googleapis.com/token",
      scope:"https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send"};
  }
  return null;
}

async function fetchJSON(url, options) {
  const result = await fetch(url, {...options, redirect:"manual", signal:AbortSignal.timeout(8500)});
  if (!result.ok) {
    let microsoftCode;
    if (new URL(url).hostname === "login.microsoftonline.com") {
      const info = await result.json().catch(() => null);
      if (Array.isArray(info?.error_codes)) {
        microsoftCode = info.error_codes.find(code => Number.isSafeInteger(code) && code > 0 && code <= 9999999);
      }
    }
    throw new ProviderError(result.status,microsoftCode);
  }
  if (result.status === 202 || result.status === 204) return null;
  return result.json();
}

export async function tokenGrant(config, parameters, previous) {
  const body = new URLSearchParams({client_id:config.client_id, client_secret:config.client_secret, ...parameters});
  const response = await fetchJSON(config.token,{method:"POST", body});
  if (!response.access_token || !(response.refresh_token || previous?.refresh)) throw new ProviderError(401);
  return {access:response.access_token, refresh:response.refresh_token || previous.refresh, expires:Date.now() + Number(response.expires_in || 3600) * 1000};
}

function api(provider, access, path, method = "GET", data) {
  const headers = {Authorization:`Bearer ${access}`, ...(provider === "outlook" ? graphHeaders : {})};
  if (data !== undefined) headers["Content-Type"] = "application/json";
  return fetchJSON((provider === "outlook" ? GRAPH : GMAIL) + path,{method,headers,body:data === undefined ? undefined : JSON.stringify(data)});
}

export async function mailboxAddress(provider, access) {
  if (provider === "gmail") return (await api(provider,access,"/profile")).emailAddress;
  const profile = await api(provider,access,"?$select=mail,userPrincipalName");
  return profile.mail || profile.userPrincipalName;
}

const header = (message, name) => message.payload?.headers?.find(item => item.name.toLowerCase() === name.toLowerCase())?.value || "";
const address = value => String(value || "").match(/[A-Z0-9.!#$%&'*+\-/=?^_\x60{|}~]+@[A-Z0-9.-]+\.[A-Z0-9-]+/i)?.[0] || "";
export const validAddress = value => typeof value === "string" && value.length <= 254 && address(value) === value;
const line = value => String(value || "").replace(/[\r\n]/g, " ").trim();
const messageId = value => String(value || "").match(/<[a-z0-9.!#$%&'*+\-/=?^_\x60{|}~@]+>/i)?.[0] || "";
const wrap64 = value => value.match(/.{1,76}/g)?.join("\r\n") || "";

function plainHTML(value) {
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(?:br|p|div|li|tr)\b[^>]*>/gi,"\n").replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, entity) => ({amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" ","#39":"'"}[entity]));
}

function gmailBody(part) {
  const children = part?.parts || [];
  const mime = part?.mimeType || "";
  if (part?.filename) return "";
  if (part?.body?.data && /^text\/(plain|html)$/.test(mime)) {
    const value = decoder.decode(fromBase64(part.body.data));
    return mime === "text/html" ? plainHTML(value) : value;
  }
  if (mime === "multipart/alternative") {
    const ordered = [...children].sort((a,b) => Number(b.mimeType === "text/plain") - Number(a.mimeType === "text/plain"));
    for (const child of ordered) {
      const text = gmailBody(child);
      if (text.trim()) return text;
    }
    return "";
  }
  return children.map(gmailBody).filter(Boolean).join("\n\n");
}

function gmailMessage(message, includeBody) {
  const sender = header(message,"From");
  return {id:message.id, outgoing:message.labelIds?.includes("SENT") || false,
    from:line(sender), replyTo:address(header(message,"Reply-To")) || address(sender),
    at:Number(message.internalDate || 0), subject:line(header(message,"Subject")),
    messageId:messageId(header(message,"Message-ID")), references:header(message,"References").match(/<[^<>\s]+>/g)?.map(messageId).filter(Boolean).slice(-18) || [],
    body:includeBody ? (gmailBody(message.payload).trim() || message.snippet || "").slice(0,20000) : ""};
}

function outlookMessage(message, mailbox, includeBody) {
  const sender = message.from?.emailAddress || message.sender?.emailAddress || {};
  const content = message.uniqueBody?.content || message.body?.content || "";
  const kind = message.uniqueBody?.contentType || message.body?.contentType;
  return {id:message.id, outgoing:sender.address?.toLowerCase() === mailbox.toLowerCase(),
    from:sender.name || sender.address || "", replyTo:message.replyTo?.[0]?.emailAddress?.address || sender.address || "",
    at:Date.parse(message.sentDateTime || message.receivedDateTime || "") || 0, subject:message.subject || "",
    body:includeBody ? (kind === "html" ? plainHTML(content) : content).trim().slice(0,20000) : ""};
}

export async function conversation(provider, access, mailbox, thread, includeBody) {
  if (provider === "gmail") {
    const query = includeBody ? "format=full" : "format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References";
    const result = await api(provider,access,`/threads/${encodeURIComponent(thread)}?${query}`);
    return (result.messages || []).filter(message => !message.labelIds?.includes("DRAFT"))
      .map(message => gmailMessage(message,includeBody)).sort((a,b)=>a.at-b.at);
  }
  const fields = "id,from,sender,replyTo,subject,isDraft,sentDateTime,receivedDateTime" + (includeBody ? ",body,uniqueBody" : "");
  const params = new URLSearchParams({$filter:`conversationId eq '${thread.replace(/'/g,"''")}'`, $select:fields, $top:"100"});
  let path = "/messages?" + params;
  const messages = [];
  while (path) {
    const page = await api(provider,access,path);
    messages.push(...(page.value || []).filter(item => !item.isDraft).map(item => outlookMessage(item,mailbox,includeBody)));
    const next = page["@odata.nextLink"];
    if (next && !next.startsWith(GRAPH + "/")) throw new ProviderError(502);
    path = next ? next.slice(GRAPH.length) : "";
  }
  return messages.sort((a,b)=>a.at-b.at);
}

function mimeMessage(from, message, ref, nonce, replyTo) {
  const parts = [`From: ${from}`, `To: ${message.recipient}`, `Subject: =?UTF-8?B?${base64(encoder.encode(message.subject))}?=`, `Message-ID: ${ref}`, "MIME-Version: 1.0"];
  if (replyTo?.messageId) {
    parts.push(`In-Reply-To: ${replyTo.messageId}`, `References: ${[...new Set([...replyTo.references,replyTo.messageId])].join("\r\n ")}`);
  }
  const text = ["Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: base64","",wrap64(base64(encoder.encode(message.body)))];
  if (message.attachments.length) {
    const boundary = `jobradar-${nonce}`;
    parts.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, ...text);
    for (const {name,type,data} of message.attachments) {
      const encodedName = encodeURIComponent(name).replace(/[!'()*]/g,char=>"%" + char.charCodeAt(0).toString(16));
      parts.push(`--${boundary}`, `Content-Type: ${type}`, "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename*=UTF-8''${encodedName}`, "", wrap64(data));
    }
    parts.push(`--${boundary}--`);
  } else parts.push(...text);
  return base64url(encoder.encode(parts.join("\r\n")+"\r\n"));
}

export async function prepareOutlook(access, message, replyTo) {
  const recipient = {emailAddress:{address:message.recipient}};
  const body = {contentType:"text",content:message.body};
  const draft = replyTo
    ? await api("outlook",access,`/messages/${encodeURIComponent(replyTo.id)}/createReply`,"POST")
    : await api("outlook",access,"/messages","POST",{subject:message.subject,body,toRecipients:[recipient]});
  const path = `/messages/${encodeURIComponent(draft.id)}`;
  try {
    if (replyTo) await api("outlook",access,path,"PATCH",{body,toRecipients:[recipient],ccRecipients:[],bccRecipients:[]});
    for (const {name,type,data} of message.attachments) {
      await api("outlook",access,path + "/attachments","POST",{
        "@odata.type":"#microsoft.graph.fileAttachment",name,contentType:type,contentBytes:data
      });
    }
  } catch (error) {
    await api("outlook",access,path,"DELETE").catch(() => {});
    throw error;
  }
  return draft.id;
}

export async function sendProviderMessage(provider, access, address, message, ref, nonce, thread, replyTo) {
  if (provider === "outlook") {
    await api(provider,access,`/messages/${encodeURIComponent(ref)}/send`,"POST");
    return null;
  }
  const data = {raw:mimeMessage(address,message,ref,nonce,replyTo)};
  if (thread) data.threadId = thread;
  const sent = await api(provider,access,"/messages/send","POST",data);
  return sent?.threadId || null;
}

export async function findSent(provider, access, reference) {
  if (provider === "outlook") {
    const message = await api(provider,access,`/messages/${encodeURIComponent(reference)}?$select=id,conversationId,isDraft`);
    return !message.isDraft ? message.conversationId : null;
  }
  const query = new URLSearchParams({q:`in:sent rfc822msgid:${reference.slice(1,-1)}`,maxResults:"1"});
  const result = await api(provider,access,"/messages?" + query);
  return result.messages?.[0]?.threadId || null;
}
