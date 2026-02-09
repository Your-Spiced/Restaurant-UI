import express from "express";
import Twilio from "twilio";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------
// Environment variables
// --------------------
const {
  // Twilio
  TWILIO_ACCOUNT_SID: accountSid,
  TWILIO_AUTH_TOKEN: authToken,
  TWILIO_FROM_SMS: fromNumber,

  // Retell
  RETELL_API_KEY,

  // Auth
  ADMIN_USER,
  ADMIN_PASS,
  SESSION_SECRET,

  // Hosting
  NODE_ENV
} = process.env;

if (!RETELL_API_KEY) {
  console.error("Missing env var: RETELL_API_KEY");
  process.exit(1);
}

if (!accountSid || !authToken || !fromNumber) {
  console.error("Missing env vars. Please set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_SMS.");
  process.exit(1);
}
if (!ADMIN_USER || !ADMIN_PASS || !SESSION_SECRET) {
  console.error("Missing env vars. Please set ADMIN_USER, ADMIN_PASS, SESSION_SECRET.");
  process.exit(1);
}

const client = Twilio(accountSid, authToken);

// --------------------
// Sessions (cookie auth)
// --------------------
app.set("trust proxy", 1); // important on Render (behind proxy)

app.use(session({
  name: "ops_session",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: NODE_ENV === "production", // must be true on HTTPS
    maxAge: 1000 * 60 * 60 * 10 // 10 hours
  }
}));

function requireAuth(req, res, next) {
  if (req.session?.user === "admin") return next();
  return res.redirect("/login");
}

// --------------------
// Static files (public)
// --------------------
// Allow login page without auth
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Protect these pages (adjust list as you want)
app.get(["/orders.html", "/marketting.html", "/settings.html"], requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", req.path));
});

// Serve other public assets freely (logo.png, css, etc.)
app.use(express.static(path.join(__dirname, "public")));

// Default: go to login (or orders if logged in)
app.get("/", (req, res) => {
  if (req.session?.user === "admin") return res.redirect("/orders.html");
  return res.redirect("/login");
});

// --------------------
// Auth API
// --------------------
app.post("/api/login", (req, res) => {
  const user = String(req.body?.user || "").trim();
  const pass = String(req.body?.pass || "").trim();

  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    req.session.user = "admin";
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Invalid login or password." });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("ops_session");
    res.json({ ok: true });
  });
});

// --------------------
// Retell API proxy (protected)
// --------------------
app.post("/api/retell/list-calls", (req, res, next) => {
  if (req.session?.user === "admin") return next();
  return res.status(401).json({ error: "Unauthorized. Please login." });
}, async (req, res) => {
  try {
    const limitRaw = req.body?.limit;
    const limit = Number.isFinite(Number(limitRaw)) ? Math.max(1, Math.min(1000, Number(limitRaw))) : 700;

    const r = await fetch("https://api.retellai.com/v2/list-calls", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RETELL_API_KEY}`
      },
      body: JSON.stringify({ limit })
    });

    const text = await r.text();
    if (!r.ok) {
      return res.status(r.status).json({
        error: `Retell API error: ${r.status} ${r.statusText}`,
        details: text
      });
    }

    // Retell returns JSON; parse it
    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(502).json({ error: "Retell returned non-JSON response", details: text });
    }

    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// --------------------
// Twilio send API (protected)
// --------------------
function isE164(phone) {
  return /^\+\d{8,15}$/.test(phone);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

app.post("/api/send-deal", (req, res, next) => {
  // auth for API: return 401 JSON instead of redirect
  if (req.session?.user === "admin") return next();
  return res.status(401).json({ error: "Unauthorized. Please login." });
}, async (req, res) => {
  try {
    const { to, message, channel } = req.body || {};

    if (channel !== "sms") {
      return res.status(400).json({ error: "Only SMS supported here. Set channel='sms'." });
    }
    if (!Array.isArray(to) || to.length === 0) {
      return res.status(400).json({ error: "`to` must be a non-empty array of E.164 numbers like +15551234567" });
    }
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "`message` is required" });
    }

    const invalid = to.filter(n => !isE164(n));
    if (invalid.length) {
      return res.status(400).json({ error: "Invalid phone(s). Must be E.164 format", invalid });
    }

    const CONCURRENCY = 5;
    const results = await mapLimit(to, CONCURRENCY, async (dest) => {
      try {
        const msg = await client.messages.create({
          from: fromNumber,
          to: dest,
          body: message.trim(),
        });
        return { to: dest, sid: msg.sid, status: msg.status };
      } catch (e) {
        return { to: dest, error: e.message, code: e.code, moreInfo: e.moreInfo };
      }
    });

    const sent = results.filter(r => r.sid).length;
    const failed = results.filter(r => r.error).length;

    const payload = { from: fromNumber, total: to.length, sent, failed, results };

    // make frontend show failure properly if none sent
    if (sent === 0) return res.status(400).json({ error: "All messages failed.", ...payload });
    if (failed > 0) return res.status(207).json({ warning: "Some messages failed.", ...payload });

    return res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// --------------------
// Start server
// --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));