import assert from "node:assert/strict";
import { randomUUID, createHash, pbkdf2Sync } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const base = process.env.ASSBOOK_TEST_URL || "http://localhost:5174";
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname), "Local-only test");
const id = randomUUID().slice(0, 8), handle = "auth_" + id, email = handle + "@example.com";
const password = "  long-unrelated-words-" + id + "  ";
const nextPassword = "Another-strong-passphrase-" + id;
const sha = s => createHash("sha256").update(s).digest("hex");
const directory = resolve(".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const files = readdirSync(directory).filter(f => f.endsWith(".sqlite") && f !== "metadata.sqlite").filter(f => {
  const check = spawnSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); sys.exit(0 if c.execute(\"SELECT name FROM sqlite_master WHERE type='table' AND name='auth_tokens'\").fetchone() else 1)", join(directory,f)]);
  return check.status === 0;
});
assert.equal(files.length, 1, "Use one initialized Assbook database for this local test");
const database = join(directory, files[0]);
function sql(query, values = []) {
  const r = spawnSync("python3", ["-c", "import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1],timeout=10); c.row_factory=sqlite3.Row; rows=c.execute(sys.argv[2],json.loads(sys.argv[3])).fetchall(); c.commit(); print(json.dumps([dict(r) for r in rows]))", database, query, JSON.stringify(values)], { encoding: "utf8" });
  if (r.status) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}
function emailFiles(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(f => f.isDirectory() ? emailFiles(join(path,f.name)) : f.name.endsWith(".txt") ? [join(path,f.name)] : []);
}
function mails(forHandle = handle) {
  return [".wrangler/tmp/email", "dist/server/.wrangler/tmp/email"].map(p => resolve(p)).filter(existsSync).flatMap(emailFiles).map(path => ({text:readFileSync(path,"utf8"),time:statSync(path).mtimeMs}))
    .filter(m => m.text.includes("@" + forHandle)).sort((a,b) => b.time-a.time);
}
async function token(purpose, forHandle = handle) {
  // Recovery mail is sent after the response, so give the file a moment.
  let mail;
  for (let i = 0; i < 30 && !mail; i++) {
    mail = mails(forHandle).find(m => m.text.includes("/#" + purpose + "="));
    if (!mail) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(mail, "Simulated email was written");
  const link = mail.text.match(/https?:\/\/[^\s]+/)[0];
  assert.equal(new URL(link).origin, base, "Local links point to this preview");
  return new URLSearchParams(new URL(link).hash.slice(1)).get(purpose);
}
async function request(session, path, data, expected = 200, extra = {}) {
  const r = await fetch(base + "/api/" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {Origin:base,"Content-Type":"application/json","CF-Connecting-IP":id,Cookie:session.cookie||"",...extra},
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (r.headers.has("set-cookie")) { session.fullCookie = r.headers.get("set-cookie"); session.cookie = session.fullCookie.split(";")[0]; }
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { error: text }; }
  if (expected !== null) assert.equal(r.status,expected,path + ": " + JSON.stringify(body));
  return {status:r.status,body};
}
const a = {}, b = {}, anon = {};
const login = (session, pass = password) => request(session,"login",{handle,password:pass});
const clearHandleLimit = () => sql("DELETE FROM limits WHERE key LIKE ?",["auth:handle:"+sha(handle)+":%"]);
let count = 0;
const pass = label => { count++; console.log("PASS " + label); };
try {
  await request(anon,"signup",{handle,password:"short",name:"Test",rules:true,email},400);
  await request(anon,"signup",null,400);
  await request(anon,"signup",{handle,password,name:"Test",rules:true,email},403,{Origin:"https://foreign.example"});
  const joined = await request(a,"signup",{handle,password,name:"Auth test",rules:true,email});
  assert.equal(joined.body.ok,true);
  assert.match(a.fullCookie,/HttpOnly/); assert.match(a.fullCookie,/SameSite=Lax/); assert.match(a.fullCookie,/Max-Age=604800/);
  const user = (await request(a,"me")).body.user;
  assert.equal(user.email,undefined);
  const stored = sql("SELECT password FROM users WHERE id=?",[user.id])[0].password;
  assert.match(stored,/^scrypt\$16384\$8\$5\$/);
  assert.notEqual(stored,password);
  await request(b,"login",{handle,password:password.trim()},401);
  await login(b);
  pass("Password policy, exact whitespace, hashing, private email, cookie flags, and origin checks");

  const before = mails().length;
  const unknown = await request(anon,"auth/recover",{email:"absent_"+id+"@example.com"});
  const unverified = await request(anon,"auth/recover",{email});
  assert.deepEqual(unknown.body,unverified.body);
  assert.equal(mails().length,before);
  const verification = await token("verify");
  assert.equal(sql("SELECT token FROM auth_tokens WHERE user_id=?",[user.id])[0].token,sha(verification));
  await request(anon,"auth/reset",{token:verification,password:nextPassword},400);
  // The browser that opens the link keeps its session; every other one is signed out.
  const confirmed = await request(a,"auth/verify-email",{token:verification});
  assert.equal(confirmed.body.signedIn,true);
  await request(a,"auth/verify-email",{token:verification},400);
  assert.equal((await request(a,"me")).body.user.handle,handle);
  assert.equal((await request(b,"me")).body.user,null);
  await login(b);
  assert.equal((await request(a,"auth/security")).body.email,email);
  pass("Verification ownership, token hashing, single use, purpose checks, and unverified recovery rejection");

  const accepted = await request(anon,"auth/recover",{email});
  assert.deepEqual(accepted.body,unknown.body);
  const recovery = await token("reset");
  const outcomes = await Promise.all([{},{}].map(s => request(s,"auth/reset",{token:recovery,password:nextPassword},null)));
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,400]);
  assert.equal((await request(a,"me")).body.user,null);
  assert.equal((await request(b,"me")).body.user,null);
  clearHandleLimit();
  await request(a,"login",{handle,password},401);
  await login(a,nextPassword); await login(b,nextPassword);
  pass("Generic recovery responses, concurrent token replay rejected, old password and sessions invalidated");

  // Fixture tokens exercise expiry and version guards without adding test hooks to the app.
  function fixture(purpose, expires = Date.now()+60000) {
    const raw = randomUUID()+randomUUID();
    const u = sql("SELECT auth_version,email FROM users WHERE id=?",[user.id])[0];
    sql("INSERT INTO auth_tokens(token,user_id,email,purpose,auth_version,expires) VALUES(?,?,?,?,?,?)",[sha(raw),user.id,u.email,purpose,u.auth_version,expires]);
    return raw;
  }
  await request(anon,"auth/reset",{token:fixture("reset",Date.now()-1),password},400);
  await request(anon,"auth/verify-email",{token:fixture("verify",Date.now()-1)},400);
  const stale = fixture("reset");
  // A signed-in member who mistypes gets a 400: a 401 would read as "sign in".
  await request(a,"auth/password",{currentPassword:"wrong",password},400);
  await request(a,"auth/email",{currentPassword:"wrong",email:"new@example.com"},400);
  await request(a,"auth/revoke-sessions",{currentPassword:nextPassword});
  assert.equal((await request(a,"me")).body.user.id,user.id);
  assert.equal((await request(b,"me")).body.user,null);
  await request(anon,"auth/reset",{token:stale,password},400);
  await request(a,"auth/password",{currentPassword:nextPassword,password});
  assert.equal((await request(a,"me")).body.user,null);
  await login(a);
  pass("Expired and revoked links rejected; sensitive changes require password; session revocation and password changes work");

  const newEmail = "new_"+email;
  await request(a,"auth/email",{currentPassword:password,email:newEmail});
  assert.equal((await request(a,"auth/security")).body.email,email);
  await request(anon,"auth/verify-email",{token:await token("verify")});
  await login(a);
  assert.equal((await request(a,"auth/security")).body.email,newEmail);
  pass("Changing recovery email retains old address until verification");

  const salt=randomUUID(), legacyPassword="legacy-account-passphrase";
  sql("UPDATE users SET password=?,salt=? WHERE id=?",[pbkdf2Sync(legacyPassword,salt,100000,32,"sha256").toString("hex"),salt,user.id]);
  clearHandleLimit();
  await login(b,legacyPassword);
  assert.match(sql("SELECT password FROM users WHERE id=?",[user.id])[0].password,/^scrypt\$/);
  pass("Existing PBKDF2 accounts sign in and upgrade automatically");

  clearHandleLimit();
  for(let i=0;i<8;i++) await request({},"login",{handle,password:"wrong"},401,{"CF-Connecting-IP":"rate_"+id+"_"+i});
  await request({},"login",{handle,password:legacyPassword},429,{"CF-Connecting-IP":"another_"+id});
  await request(anon,"auth/security",undefined,401);
  assert.equal((await fetch(base+"/assbook-source.zip")).status,200);
  pass("Per-account throttling across IPs, private settings, and public source download");
  console.log(count+" authentication integration checks passed.");
} finally {
  sql("DELETE FROM auth_tokens WHERE user_id IN (SELECT id FROM users WHERE handle=?)",[handle]);
  sql("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE handle=?)",[handle]);
  sql("DELETE FROM users WHERE handle=?",[handle]);
  clearHandleLimit();
}
