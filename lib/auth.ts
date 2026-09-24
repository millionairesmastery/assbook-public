import { env } from "cloudflare:workers";
import { background, body, clientIp, cookie, db, hash, HttpError, json, newSession, rate, rateCount, rateReset, requireUser, sessionToken, str } from "./server";
import { legacyHash, passwordHash, passwordInput, verifyPassword } from "./password";

type Account = { id: string; handle: string; password: string; salt: string; email: string | null; auth_version: number };
const genericRecovery = "If that email is verified on an account, a recovery link is on its way. Check your inbox and spam folder.";
const invalidLink = "This link has expired or was already used. Please request a new one.";

function emailInput(value: unknown) {
  const email = str(value, 254, 3).toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email))
    throw new HttpError(400, "Enter a valid email address.");
  return email;
}
async function ipLimit(req: Request, category: string, max = 20) {
  await rate(category + ":ip:" + await hash(clientIp(req)), max, 900000);
}
const handleWindow = 900000;
// Handles nobody may register: the site's own names and words that would
// look official or confuse links.
export const reservedHandles = ["admin", "assbook", "support", "moderator", "help", "official", "staff", "team", "mod", "root", "system"];
export const handlePattern = /^[a-z0-9_]{3,24}$/;
/** Whether a handle can still be registered, and why not if it cannot. */
export async function handleAvailability(raw: string) {
  const handle = raw.trim().toLowerCase();
  if (!handlePattern.test(handle)) return { handle, available: false, reason: "invalid" as const };
  if (reservedHandles.includes(handle)) return { handle, available: false, reason: "reserved" as const };
  const taken = await db().prepare("SELECT 1 FROM users WHERE handle=?").bind(handle).first();
  return taken ? { handle, available: false, reason: "taken" as const } : { handle, available: true as const };
}
async function account(id: string) {
  const user = await db().prepare("SELECT id,handle,password,salt,email,auth_version FROM users WHERE id=? AND demo=0").bind(id).first<Account>();
  if (!user) throw new HttpError(401, "Please sign in again.");
  return user;
}
async function confirmPassword(req: Request, data: Record<string, unknown>) {
  const me = await requireUser(req);
  await ipLimit(req, "sensitive");
  await rate("sensitive:user:" + me.id, 8, 900000);
  const user = await account(me.id);
  // 400, not 401: the member is signed in, and clients read a 401 as "join
  // or sign in", which is the wrong thing to tell them about a typo.
  if (!await verifyPassword(passwordInput(data.currentPassword), user.password, user.salt))
    throw new HttpError(400, "Your current password does not match.");
  return user;
}
function origin(req: Request) {
  const url = new URL(req.url);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return url.origin;
  // Never derive live reset links from the request Host header.
  const configured = new URL(env.APP_ORIGIN);
  if (configured.protocol !== "https:") throw new HttpError(503, "Account email is not configured.");
  return configured.origin;
}
async function sendLink(req: Request, user: Account, email: string, purpose: "verify" | "reset") {
  const token = crypto.randomUUID() + crypto.randomUUID(), digest = await hash(token);
  const expires = Date.now() + (purpose === "reset" ? 20 : 30) * 60000;
  await db().batch([
    db().prepare("DELETE FROM auth_tokens WHERE expires<?").bind(Date.now()),
    db().prepare("INSERT INTO auth_tokens(token,user_id,email,purpose,auth_version,expires) VALUES(?,?,?,?,?,?)")
      .bind(digest, user.id, email, purpose, user.auth_version, expires),
  ]);
  // Fragments stay out of HTTP requests, proxy logs, and Referer headers.
  try {
    const link = origin(req) + "/#" + purpose + "=" + token;
    await env.EMAIL.send({
      from: { email: env.EMAIL_FROM, name: "Assbook" }, to: email,
      subject: purpose === "reset" ? "Reset your Assbook password" : "Verify your Assbook recovery email",
      text: purpose === "reset"
        ? `Someone requested a password reset for @${user.handle}.\n\nOpen this link and choose a new password within 20 minutes:\n${link}\n\nIf you didn't request this, ignore this email. Your password has not changed.`
        : `Verify this recovery email for @${user.handle} within 30 minutes:\n${link}\n\nOnly confirm if this is your Assbook account. If you didn't request this, ignore this email.`,
    });
    return true;
  } catch {
    await db().prepare("DELETE FROM auth_tokens WHERE token=?").bind(digest).run();
    // Keep recipients, tokens, and provider error payloads out of logs.
    console.error(JSON.stringify({ event: "account_email_failed", purpose }));
    return false;
  }
}
// After an account version bump: drop the consumed link and every session or
// pending link that belongs to the old version. Scoped to one user, so cost
// does not grow with the size of the site.
async function invalidate(userId: string, digest: string) {
  await db().batch([
    db().prepare("DELETE FROM auth_tokens WHERE token=?").bind(digest),
    db().prepare("DELETE FROM auth_tokens WHERE user_id=? AND auth_version<(SELECT auth_version FROM users WHERE id=?)").bind(userId, userId),
    db().prepare("DELETE FROM sessions WHERE user_id=? AND auth_version<(SELECT auth_version FROM users WHERE id=?)").bind(userId, userId),
  ]);
}
async function tokenDigest(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9-]{72}$/.test(value)) throw new HttpError(400, invalidLink);
  return hash(value);
}

export async function authRoute(req: Request, path: string): Promise<Response | null> {
  const method = req.method;
  if ((path === "signup" || path === "login") && method === "POST") {
    await ipLimit(req, "auth");
    const data = await body(req), handle = str(data.handle, 24, 3).toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(handle)) throw new HttpError(400, "Use 3 to 24 letters, numbers, or underscores.");
    const handleKey = "auth:handle:" + await hash(handle);
    // Sign-in counts failures only, so a stranger cannot lock an account by
    // guessing wrong on purpose while the real owner keeps signing in fine.
    if (path === "signup") await rate(handleKey, 8, handleWindow);
    else if (await rateCount(handleKey, handleWindow) >= 8)
      throw new HttpError(429, "A little breather. Please try again shortly.");
    const password = passwordInput(data.password, path === "signup");
    if (path === "signup") {
      if (data.rules !== true) throw new HttpError(400, "Please agree to the community rules.");
      if (reservedHandles.includes(handle)) throw new HttpError(400, "Please choose another handle.");
      const email = emailInput(data.email), name = str(data.name, 40, 1), salt = crypto.randomUUID(), id = crypto.randomUUID();
      await rate("verify:email:" + await hash(email), 3, 3600000);
      const stored = await passwordHash(password, salt);
      try {
        await db().prepare("INSERT INTO users(id,handle,name,password,salt,created) VALUES(?,?,?,?,?,?)").bind(id,handle,name,stored,salt,Date.now()).run();
      } catch (e) {
        if (String(e).includes("UNIQUE")) throw new HttpError(409, "That handle is already taken.");
        throw e;
      }
      // An address already verified on another account is never mailed from
      // signup, so nobody can use the sender domain to poke at strangers.
      const claimed = await db().prepare("SELECT 1 FROM users WHERE email=?").bind(email).first();
      if (!claimed) await sendLink(req, { id, handle, password: stored, salt, email: null, auth_version: 0 }, email, "verify");
      return json({ ok: true }, 200, { "Set-Cookie": await newSession(req, id, 0) });
    }
    const user = await db().prepare("SELECT id,handle,password,salt,email,auth_version FROM users WHERE handle=? AND demo=0").bind(handle).first<Account>();
    if (!await verifyPassword(password, user?.password ?? null, user?.salt ?? null) || !user) {
      await rate(handleKey, 8, handleWindow);
      throw new HttpError(401, "That handle and password do not match.");
    }
    await rateReset(handleKey, handleWindow);
    if (legacyHash(user.password)) {
      const salt = crypto.randomUUID();
      await db().prepare("UPDATE users SET password=?,salt=? WHERE id=? AND password=? AND auth_version=?")
        .bind(await passwordHash(password, salt), salt, user.id, user.password, user.auth_version).run();
    }
    return json({ ok: true }, 200, { "Set-Cookie": await newSession(req, user.id, user.auth_version) });
  }
  if (path === "auth/recover" && method === "POST") {
    await ipLimit(req, "recover", 10);
    const email = emailInput((await body(req)).email);
    try { await rate("recover:email:" + await hash(email), 3, 3600000); }
    catch (e) { if (e instanceof HttpError && e.status === 429) return json({ message: genericRecovery }); throw e; }
    const user = await db().prepare("SELECT id,handle,password,salt,email,auth_version FROM users WHERE email=? AND demo=0").bind(email).first<Account>();
    // The send runs after the response so timing does not reveal which
    // addresses have accounts.
    if (user) background(sendLink(req, user, email, "reset"));
    return json({ message: genericRecovery });
  }
  if (path === "auth/reset" && method === "POST") {
    await ipLimit(req, "reset", 10);
    const data = await body(req), digest = await tokenDigest(data.token), password = passwordInput(data.password, true);
    const salt = crypto.randomUUID(), stored = await passwordHash(password, salt);
    // Atomic conditional UPDATE: concurrent submissions can consume a link only once.
    // Versioned sessions/tokens also reject any sign-in racing this change.
    const updated = await db().prepare("UPDATE users SET password=?,salt=?,auth_version=auth_version+1 WHERE EXISTS(SELECT 1 FROM auth_tokens t WHERE t.token=? AND t.purpose='reset' AND t.expires>? AND t.user_id=users.id AND t.email=users.email AND t.auth_version=users.auth_version) RETURNING id")
      .bind(stored, salt, digest, Date.now()).first<{ id: string }>();
    if (!updated) throw new HttpError(400, invalidLink);
    await invalidate(updated.id, digest);
    return json({ ok: true }, 200, { "Set-Cookie": cookie(req, "") });
  }
  if (path === "auth/verify-email" && method === "POST") {
    await ipLimit(req, "verify", 10);
    const digest = await tokenDigest((await body(req)).token);
    let updated: { id: string } | null;
    try {
      updated = await db().prepare("UPDATE users SET email=(SELECT email FROM auth_tokens WHERE token=?),auth_version=auth_version+1 WHERE EXISTS(SELECT 1 FROM auth_tokens t WHERE t.token=? AND t.purpose='verify' AND t.expires>? AND t.user_id=users.id AND t.auth_version=users.auth_version) RETURNING id")
        .bind(digest, digest, Date.now()).first<{ id: string }>();
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new HttpError(400, "This email cannot be linked. Try account recovery or use another email.");
      throw e;
    }
    if (!updated) throw new HttpError(400, invalidLink);
    // The browser that opened the link stays signed in if it already holds a
    // session for this account. Every other session is signed out.
    const current = sessionToken(req);
    let signedIn = false;
    if (/^[a-f0-9-]{72}$/.test(current)) {
      const kept = await db().prepare("UPDATE sessions SET auth_version=(SELECT auth_version FROM users WHERE id=?) WHERE token=? AND user_id=? AND expires>?")
        .bind(updated.id, await hash(current), updated.id, Date.now()).run();
      signedIn = !!kept.meta.changes;
    }
    await invalidate(updated.id, digest);
    return json({ ok: true, signedIn }, 200, signedIn ? {} : { "Set-Cookie": cookie(req, "") });
  }
  if (path === "auth/security" && method === "GET") {
    const me = await requireUser(req), user = await account(me.id);
    const pending = await db().prepare("SELECT email FROM auth_tokens WHERE user_id=? AND purpose='verify' AND auth_version=? AND expires>? ORDER BY expires DESC LIMIT 1").bind(me.id,user.auth_version,Date.now()).first<{email:string}>();
    const sessions = await db().prepare("SELECT count(*) count FROM sessions WHERE user_id=? AND auth_version=? AND expires>?").bind(me.id,user.auth_version,Date.now()).first<{count:number}>();
    return json({ email: user.email, pendingEmail: pending?.email ?? null, sessions: sessions?.count ?? 0 });
  }
  if (path === "auth/email" && method === "POST") {
    const data = await body(req), user = await confirmPassword(req, data), email = emailInput(data.email);
    await rate("verify:user:" + user.id, 3, 3600000);
    await rate("verify:email:" + await hash(email), 3, 3600000);
    if (!await sendLink(req, user, email, "verify")) throw new HttpError(503, "We couldn't send the email. Please try again later.");
    return json({ message: "Check your inbox to verify this recovery email. Your current recovery email stays active until you confirm." });
  }
  if (path === "auth/password" && method === "POST") {
    const data = await body(req), user = await confirmPassword(req, data);
    const password = passwordInput(data.password, true), salt = crypto.randomUUID();
    const results = await db().batch([
      db().prepare("UPDATE users SET password=?,salt=?,auth_version=auth_version+1 WHERE id=? AND auth_version=? RETURNING id")
        .bind(await passwordHash(password,salt),salt,user.id,user.auth_version),
      db().prepare("DELETE FROM sessions WHERE user_id=? AND auth_version<=?").bind(user.id,user.auth_version),
    ]);
    if (!results[0].results.length) throw new HttpError(401, "Your account changed. Please sign in again.");
    return json({ ok: true }, 200, { "Set-Cookie": cookie(req, "") });
  }
  if (path === "auth/revoke-sessions" && method === "POST") {
    const user = await confirmPassword(req, await body(req)), current = await hash(sessionToken(req));
    const results = await db().batch([
      db().prepare("UPDATE users SET auth_version=auth_version+1 WHERE id=? AND auth_version=? RETURNING id").bind(user.id,user.auth_version),
      db().prepare("UPDATE sessions SET auth_version=? WHERE token=? AND user_id=? AND auth_version=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND auth_version=?)")
        .bind(user.auth_version+1,current,user.id,user.auth_version,user.id,user.auth_version+1),
      db().prepare("DELETE FROM sessions WHERE user_id=? AND auth_version<=?").bind(user.id,user.auth_version),
    ]);
    if (!results[0].results.length || !results[1].meta.changes) throw new HttpError(401, "Please sign in again.");
    return json({ ok: true });
  }
  return null;
}
