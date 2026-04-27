if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const bcrypt = require('bcrypt');
const session = require('express-session');
const CryptoJS = require('crypto-js');

// ─── Encryption ───────────────────────────────────────────────────────────────

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';
if (!ENCRYPTION_KEY) console.warn('⚠️  ENCRYPTION_KEY לא מוגדר — נתונים נשמרים ללא הצפנה');

function encrypt(text) {
  if (!text || !ENCRYPTION_KEY) return text || '';
  return CryptoJS.AES.encrypt(String(text), ENCRYPTION_KEY).toString();
}

function decrypt(ciphertext) {
  if (!ciphertext || !ENCRYPTION_KEY) return ciphertext || '';
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY);
    const result = bytes.toString(CryptoJS.enc.Utf8);
    return result || ciphertext; // fallback לנתונים ישנים לא מוצפנים
  } catch {
    return ciphertext; // fallback לנתונים ישנים לא מוצפנים
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Database ──────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── DB helpers ─────────────────────────────────────────────────────────────

const dbRun = (sql, p = []) => pool.query(sql, p);

const dbGet = async (sql, p = []) => {
  const res = await pool.query(sql, p);
  return res.rows[0];
};

const dbAll = async (sql, p = []) => {
  const res = await pool.query(sql, p);
  return res.rows;
};

// ─── PG Session Store ────────────────────────────────────────────────────────

class PGSessionStore extends session.Store {
  constructor() {
    super();
    setInterval(() => pool.query('DELETE FROM sessions WHERE expires < $1', [Date.now()]), 3600000);
  }

  get(sid, cb) {
    pool.query('SELECT data, expires FROM sessions WHERE sid = $1', [sid])
      .then(res => {
        const row = res.rows[0];
        if (!row || row.expires < Date.now()) return cb(null, null);
        try { cb(null, JSON.parse(row.data)); } catch (e) { cb(e); }
      })
      .catch(cb);
  }

  set(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + 30 * 24 * 60 * 60 * 1000;
    pool.query(
      'INSERT INTO sessions (sid, data, expires) VALUES ($1, $2, $3) ON CONFLICT (sid) DO UPDATE SET data = EXCLUDED.data, expires = EXCLUDED.expires',
      [sid, JSON.stringify(sess), expires]
    ).then(() => cb && cb()).catch(cb);
  }

  destroy(sid, cb) {
    pool.query('DELETE FROM sessions WHERE sid = $1', [sid])
      .then(() => cb && cb()).catch(cb);
  }
}

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(session({
  store: new PGSessionStore(),
  secret: process.env.SESSION_SECRET || 'act-app-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — stays logged in after browser close
    httpOnly: true,
    sameSite: 'lax'
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('public')) fs.mkdirSync('public');

// ─── Database Tables ─────────────────────────────────────────────────────────

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires BIGINT NOT NULL
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS anxiety_entries (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    date TEXT,
    intensity INTEGER,
    event TEXT,
    thoughts TEXT,
    body TEXT,
    duration TEXT,
    claude_response TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS dream_entries (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    date TEXT,
    content TEXT,
    symbols TEXT,
    claude_interpretation TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS values_map (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    domain TEXT,
    description TEXT,
    score INTEGER DEFAULT 5,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS user_profile (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE,
    name TEXT DEFAULT '',
    description TEXT DEFAULT '',
    uploaded_files TEXT DEFAULT '[]',
    file_contents TEXT DEFAULT ''
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS avoidance_entries (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    date TEXT,
    description TEXT,
    small_step TEXT DEFAULT '',
    completed INTEGER DEFAULT 0,
    what_i_miss TEXT DEFAULT '',
    claude_response TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS free_consult_chat (
    user_id INTEGER PRIMARY KEY,
    messages TEXT DEFAULT '',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
}

// ─── Migration ────────────────────────────────────────────────────────────────

async function migrate() {
  for (const table of ['anxiety_entries', 'dream_entries', 'user_profile', 'avoidance_entries', 'values_map']) {
    const exists = await dbGet(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'user_id'`,
      [table]
    );
    if (!exists) {
      try { await pool.query(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER`); } catch (_) {}
    }
  }
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'יש להתחבר תחילה' });
  next();
}

// ─── Startup ──────────────────────────────────────────────────────────────────

(async () => {
  try {
    await initDB();
    await migrate();
  } catch (e) { console.error('Startup error:', e); }
})();

// ─── Claude helpers ──────────────────────────────────────────────────────────

const getClient = () => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === 'your_key_here') throw new Error('מפתח ANTHROPIC_API_KEY לא מוגדר בסביבת השרת');
  return new Anthropic({ apiKey: key });
};

const FREE_CONSULT_SYSTEM = `אתה מטפל ACT (Acceptance and Commitment Therapy) מנוסה, אמפתי ולא שיפוטי. אתה מקשיב, מבין, ומשלב בטבעיות עקרונות ACT כמו קבלה, נוכחות, ערכים ומחויבות — אבל לא בצורה נוקשה או תיאורטית. המשתמש יכול לדבר על כל נושא.`;

const buildSystemPrompt = async (userId) => {
  const profile = await dbGet('SELECT * FROM user_profile WHERE user_id = $1', [userId]) || {};
  const anxietyRows = await dbAll(
    'SELECT date, intensity, event FROM anxiety_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5',
    [userId]
  );
  const dreamRows = await dbAll(
    'SELECT date, content FROM dream_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 3',
    [userId]
  );

  const history = [
    ...anxietyRows.map(r => `  • חרדה (${r.date}): עצמה ${r.intensity}/10 — ${(decrypt(r.event) || '').slice(0, 80)}`),
    ...dreamRows.map(r => `  • חלום (${r.date}): ${(decrypt(r.content) || '').slice(0, 80)}`)
  ].join('\n') || '  אין היסטוריה עדיין';

  return `אתה מלווה נפשי אישי שמשתמש בגישת ACT (Acceptance and Commitment Therapy) ובפסיכולוגיה יונגיאנית לפרשנות חלומות.

העקרונות שלך:
• קבלה ללא שיפוטיות
• עידוד חיבור לערכים
• דפיוזיה קוגניטיבית — מחשבות הן לא עובדות
• נוכחות ברגע הנוכחי
• לפרשנות חלומות: שילוב ACT ויונג — ארכיטיפים, סמלים, צל, עצמי

הסגנון שלך:
• עברית, חמה, לא קלינית
• קצר וממוקד — לא יותר מ-3 פסקאות
• תמיד מסיים עם שאלה אחת או תרגיל קצר
• מכיר את המשתמש לפי ההיסטוריה שנשמרה

מידע על המשתמש:
שם: ${profile.name || 'לא ידוע'}
תיאור עצמי: ${decrypt(profile.description) || 'לא סופק עדיין'}
${profile.file_contents ? `\nתוכן קבצים אישיים שהועלו:\n${decrypt(profile.file_contents).slice(0, 2000)}` : ''}

אירועים אחרונים:
${history}`;
};

const SSE = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'Access-Control-Allow-Origin': '*'
};

async function streamClaude(res, systemPrompt, userMessage, maxTokens = 2000) {
  const client = getClient();
  const stream = client.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });

  let full = '';
  for await (const evt of stream) {
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
      full += evt.delta.text;
      res.write(`data: ${JSON.stringify({ text: evt.delta.text })}\n\n`);
    }
  }
  return full;
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'שם משתמש וסיסמה נדרשים' });
    if (username.trim().length < 2) return res.status(400).json({ error: 'שם משתמש חייב להכיל לפחות 2 תווים' });
    if (password.length < 6) return res.status(400).json({ error: 'הסיסמה חייבת להכיל לפחות 6 תווים' });

    const existing = await dbGet('SELECT id FROM users WHERE username = $1', [username.trim()]);
    if (existing) return res.status(400).json({ error: 'שם המשתמש כבר תפוס' });

    const hash = await bcrypt.hash(password, 10);
    const result = await dbGet('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id', [username.trim(), hash]);
    const userId = result.id;

    await dbRun('INSERT INTO user_profile (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);

    req.session.userId = userId;
    req.session.username = username.trim();
    res.json({ user: { id: userId, username: username.trim() } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'שם משתמש וסיסמה נדרשים' });

    const user = await dbGet('SELECT * FROM users WHERE username = $1', [username.trim()]);
    if (!user) return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });

    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ user: { id: user.id, username: user.username } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'לא מחובר' });
  res.json({ user: { id: req.session.userId, username: req.session.username } });
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/anxiety
app.post('/api/anxiety', requireAuth, async (req, res) => {
  res.set(SSE);
  const { intensity, event, thoughts, body, duration } = req.body;
  const userId = req.session.userId;
  try {
    const sys = await buildSystemPrompt(userId);
    const msg = `אני חווה חרדה עכשיו.

עוצמה: ${intensity}/10
מה קרה: ${event || 'לא פורט'}
מחשבות: ${thoughts || 'לא פורט'}
תחושות גוף: ${body || 'לא פורט'}
משך הזמן: ${duration || 'לא פורט'}

אנא הגב עם: הכרה ואמפתיה, כלי ACT מותאם לסיטואציה, תרגיל קצר ומיידי, ושאלה אחת לעומק.`;

    const full = await streamClaude(res, sys, msg, 2000);
    const date = new Date().toISOString().split('T')[0];
    await dbRun(
      `INSERT INTO anxiety_entries (user_id, date, intensity, event, thoughts, body, duration, claude_response) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, date, intensity, encrypt(event), encrypt(thoughts), encrypt(body), encrypt(duration), encrypt(full)]
    );
    res.write(`data: [DONE]\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// POST /api/dreams
app.post('/api/dreams', requireAuth, async (req, res) => {
  res.set(SSE);
  const { content } = req.body;
  const userId = req.session.userId;
  try {
    const sys = await buildSystemPrompt(userId);
    const msg = `פרש את החלום הבא לפי ACT ויונג:

"${content}"

אנא:
1. **ארכיטיפים יונגיאניים**: זהה צל, אנימה/אנימוס, עצמי, פרסונה, ילד, חכם, גיבור
2. **סמלים קולקטיביים**: מה הסמלים הנוכחים אומרים מבחינה אוניברסלית?
3. **עדשת ACT**: מה החלום חושף על ערכים, דפוסי הימנעות, קשיחות קוגניטיבית?
4. **קישור אישי**: כיצד זה מתחבר לאירועים ורגשות האחרונים שלי?`;

    const full = await streamClaude(res, sys, msg, 4000);
    const date = new Date().toISOString().split('T')[0];
    const symbolWords = ['מים', 'אש', 'בית', 'דרך', 'ים', 'הר', 'נחש', 'ילד', 'אור', 'חשיכה', 'טיסה', 'נפילה', 'דלת', 'מראה', 'יער', 'בעל חיים'];
    const symbols = symbolWords.filter(s => content.includes(s));
    await dbRun(
      `INSERT INTO dream_entries (user_id, date, content, symbols, claude_interpretation) VALUES ($1, $2, $3, $4, $5)`,
      [userId, date, encrypt(content), encrypt(JSON.stringify(symbols)), encrypt(full)]
    );
    res.write(`data: [DONE]\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// POST /api/avoidance
app.post('/api/avoidance', requireAuth, async (req, res) => {
  res.set(SSE);
  const { description } = req.body;
  const userId = req.session.userId;
  let entryId = null;
  try {
    const date = new Date().toISOString().split('T')[0];
    const result = await dbGet(
      `INSERT INTO avoidance_entries (user_id, date, description) VALUES ($1, $2, $3) RETURNING id`,
      [userId, date, encrypt(description)]
    );
    entryId = result.id;

    const sys = await buildSystemPrompt(userId);
    const msg = `אני נמנע מ: "${description}"

אנא:
1. **צעד קטן**: שבור את זה לצעד אחד קטן מאוד וספציפי (פחות מ-2 דקות) שאוכל לעשות היום — תן דוגמה ממוקדת, לא כללית
2. **מה אני מפסיד**: שאל אותי "מה היית עושה אם החרדה לא הייתה כאן?" — חבר את ההימנעות לערכים שלי
3. **פרספקטיבה**: הזכר לי שהימנעות מדבר חשוב היא סימן שזה חשוב לי — לא חולשה אלא ראיה לאכפתיות`;

    const full = await streamClaude(res, sys, msg, 2000);
    await dbRun(`UPDATE avoidance_entries SET claude_response = $1 WHERE id = $2`, [encrypt(full), entryId]);
    res.write(`data: ${JSON.stringify({ id: entryId, done: true })}\n\n`);
    res.write(`data: [DONE]\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// GET /api/free-consult — persisted free-form ACT chat history
app.get('/api/free-consult', requireAuth, async (req, res) => {
  try {
    const row = await dbGet('SELECT messages FROM free_consult_chat WHERE user_id = $1', [req.session.userId]);
    if (!row || !row.messages) return res.json({ messages: [] });
    try {
      const parsed = JSON.parse(decrypt(row.messages));
      res.json({ messages: Array.isArray(parsed) ? parsed : [] });
    } catch {
      res.json({ messages: [] });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/free-consult/chat — streaming; saves full thread after completion
app.post('/api/free-consult/chat', requireAuth, async (req, res) => {
  res.set(SSE);
  const { messages } = req.body;
  const userId = req.session.userId;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.write(`data: ${JSON.stringify({ error: 'הודעות חסרות' })}\n\n`);
    res.end();
    return;
  }
  const trimmed = messages.slice(-60).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 32000)
  })).filter(m => m.content);
  if (!trimmed.length) {
    res.write(`data: ${JSON.stringify({ error: 'אין תוכן להודעה' })}\n\n`);
    res.end();
    return;
  }
  try {
    const client = getClient();
    const stream = client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      system: FREE_CONSULT_SYSTEM,
      messages: trimmed
    });
    let full = '';
    for await (const evt of stream) {
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        full += evt.delta.text;
        res.write(`data: ${JSON.stringify({ text: evt.delta.text })}\n\n`);
      }
    }
    const toSave = [...trimmed, { role: 'assistant', content: full }];
    await dbRun(
      `INSERT INTO free_consult_chat (user_id, messages, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE SET messages = EXCLUDED.messages, updated_at = CURRENT_TIMESTAMP`,
      [userId, encrypt(JSON.stringify(toSave))]
    );
    res.write(`data: [DONE]\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// POST /api/chat — conversational follow-up
app.post('/api/chat', requireAuth, async (req, res) => {
  res.set(SSE);
  const { messages } = req.body; // [{role:'user'|'assistant', content:string}]
  const userId = req.session.userId;
  try {
    const sys = await buildSystemPrompt(userId);
    const client = getClient();
    const stream = client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      system: sys,
      messages
    });
    for await (const evt of stream) {
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: evt.delta.text })}\n\n`);
      }
    }
    res.write(`data: [DONE]\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// PUT /api/avoidance/:id
app.put('/api/avoidance/:id', requireAuth, async (req, res) => {
  try {
    const { completed, small_step, what_i_miss } = req.body;
    await dbRun(
      `UPDATE avoidance_entries SET completed = $1, small_step = COALESCE(NULLIF($2, ''), small_step), what_i_miss = COALESCE(NULLIF($3, ''), what_i_miss) WHERE id = $4 AND user_id = $5`,
      [completed ? 1 : 0, encrypt(small_step || ''), encrypt(what_i_miss || ''), req.params.id, req.session.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/avoidance
app.get('/api/avoidance', requireAuth, async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM avoidance_entries WHERE user_id = $1 ORDER BY created_at DESC', [req.session.userId]);
    res.json(rows.map(r => ({
      ...r,
      description: decrypt(r.description),
      claude_response: decrypt(r.claude_response),
      small_step: decrypt(r.small_step),
      what_i_miss: decrypt(r.what_i_miss)
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/avoidance/wins
app.get('/api/avoidance/wins', requireAuth, async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM avoidance_entries WHERE user_id = $1 AND completed = 1 ORDER BY created_at DESC', [req.session.userId]);
    res.json(rows.map(r => ({
      ...r,
      description: decrypt(r.description),
      claude_response: decrypt(r.claude_response),
      small_step: decrypt(r.small_step),
      what_i_miss: decrypt(r.what_i_miss)
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/entries
app.get('/api/entries', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const anxietyRaw = await dbAll('SELECT * FROM anxiety_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]);
    const dreamsRaw = await dbAll('SELECT * FROM dream_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [userId]);
    const anxiety = anxietyRaw.map(r => ({
      ...r,
      event: decrypt(r.event),
      thoughts: decrypt(r.thoughts),
      body: decrypt(r.body),
      duration: decrypt(r.duration),
      claude_response: decrypt(r.claude_response)
    }));
    const dreams = dreamsRaw.map(r => ({
      ...r,
      content: decrypt(r.content),
      symbols: decrypt(r.symbols),
      claude_interpretation: decrypt(r.claude_interpretation)
    }));
    res.json({ anxiety, dreams });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const anxiety = await dbAll('SELECT date, intensity FROM anxiety_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30', [userId]);
    const avoidance = await dbAll('SELECT date, completed FROM avoidance_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30', [userId]);
    const dreams = await dbAll('SELECT date FROM dream_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [userId]);

    const patterns = [];
    if (anxiety.length > 0) {
      const avg = anxiety.reduce((a, b) => a + b.intensity, 0) / anxiety.length;
      const recent5 = anxiety.slice(0, 5);
      const recentAvg = recent5.reduce((a, b) => a + b.intensity, 0) / recent5.length;
      patterns.push(`ממוצע עוצמת חרדה: ${avg.toFixed(1)}/10`);
      if (recent5.length >= 3) {
        patterns.push(recentAvg < avg ? 'מגמה: שיפור לאחרונה' : 'מגמה: ימים מאתגרים לאחרונה');
      }
    }
    const wins = avoidance.filter(a => a.completed).length;
    if (avoidance.length > 0) {
      patterns.push(`${wins}/${avoidance.length} צעדים קטנים הושלמו (${Math.round(wins / avoidance.length * 100)}%)`);
    }

    res.json({ anxiety, avoidance, dreams, patterns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/profile
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const profile = await dbGet('SELECT * FROM user_profile WHERE user_id = $1', [req.session.userId]);
    if (profile) {
      profile.description = decrypt(profile.description);
      profile.file_contents = decrypt(profile.file_contents);
    }
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/profile
app.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const { name, description } = req.body;
    await dbRun('UPDATE user_profile SET name = $1, description = $2 WHERE user_id = $3', [name, encrypt(description), req.session.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload
const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'לא הועלה קובץ' });

    let text = '';
    const filePath = req.file.path;

    if (req.file.mimetype === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const buf = fs.readFileSync(filePath);
      const data = await pdfParse(buf);
      text = data.text;
    } else {
      text = fs.readFileSync(filePath, 'utf-8');
    }

    const userId = req.session.userId;
    const profile = await dbGet('SELECT * FROM user_profile WHERE user_id = $1', [userId]);
    const files = JSON.parse(profile?.uploaded_files || '[]');
    files.push(req.file.originalname);

    const existing = decrypt(profile?.file_contents || '');
    const newContent = (existing + `\n\n--- ${req.file.originalname} ---\n${text.slice(0, 3000)}`).slice(0, 10000);

    await dbRun(
      'UPDATE user_profile SET uploaded_files = $1, file_contents = $2 WHERE user_id = $3',
      [JSON.stringify(files), encrypt(newContent), userId]
    );

    fs.unlinkSync(filePath);
    res.json({ success: true, filename: req.file.originalname, chars: text.length });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/upload/:filename
app.delete('/api/upload/:filename', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const filename = req.params.filename;
    const profile = await dbGet('SELECT * FROM user_profile WHERE user_id = $1', [userId]);
    const files = JSON.parse(profile?.uploaded_files || '[]').filter(f => f !== filename);
    const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\n\\n--- ${escaped} ---\\n[\\s\\S]*?(?=\\n\\n---|$)`, 'g');
    const newContents = decrypt(profile?.file_contents || '').replace(regex, '');
    await dbRun(
      'UPDATE user_profile SET uploaded_files = $1, file_contents = $2 WHERE user_id = $3',
      [JSON.stringify(files), encrypt(newContents), userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/exercises
app.get('/api/exercises', (req, res) => {
  res.json([
    { id: 'breathing', name: 'נשימה סרעפתית', duration: '5 דקות', description: 'נשימה עמוקה לרגיעה מיידית' },
    { id: 'bodyscan', name: 'סריקת גוף', duration: '10 דקות', description: 'מודעות מלאה לתחושות גופניות' },
    { id: 'defusion', name: 'דפיוזיה קוגניטיבית', duration: '3 דקות', description: '"אני מבחין שאני חושב ש..."' },
    { id: 'senses', name: '5-4-3-2-1 חושים', duration: '2 דקות', description: 'עוגן לרגע הנוכחי דרך החושים' }
  ]);
});

// POST /api/values
app.post('/api/values', requireAuth, async (req, res) => {
  try {
    const { values } = req.body;
    const userId = req.session.userId;
    for (const v of values) {
      const exists = await dbGet('SELECT id FROM values_map WHERE domain = $1 AND user_id = $2', [v.domain, userId]);
      if (exists) {
        await dbRun(
          'UPDATE values_map SET description = $1, score = $2, updated_at = CURRENT_TIMESTAMP WHERE domain = $3 AND user_id = $4',
          [encrypt(v.description), v.score, v.domain, userId]
        );
      } else {
        await dbRun(
          'INSERT INTO values_map (user_id, domain, description, score) VALUES ($1, $2, $3, $4)',
          [userId, v.domain, encrypt(v.description), v.score]
        );
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/values
app.get('/api/values', requireAuth, async (req, res) => {
  try {
    const values = await dbAll('SELECT * FROM values_map WHERE user_id = $1', [req.session.userId]);
    res.json(values.map(v => ({ ...v, description: decrypt(v.description) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/values/feedback
app.post('/api/values/feedback', requireAuth, async (req, res) => {
  res.set(SSE);
  const { values } = req.body;
  try {
    const sys = await buildSystemPrompt(req.session.userId);
    const valuesText = values.map(v =>
      `• ${v.domain}: ${v.description || 'לא פורט'} — חי לפיו: ${v.score}/10`
    ).join('\n');

    const msg = `הנה מפת הערכים שלי:\n${valuesText}\n\nאנא תן פידבק ממוקד על הפערים הגדולים ביותר בין מה שחשוב לי לבין כמה אני חי לפיו. מה צעד אחד קטן שאוכל לקחת השבוע עבור הערך עם הפער הגדול ביותר?`;

    await streamClaude(res, sys, msg, 2000);
    res.write(`data: [DONE]\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM settings');
    const obj = {};
    rows.forEach(r => { obj[r.key] = r.value; });
    obj.hasApiKey = !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_key_here');
    res.json(obj);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings
app.put('/api/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (key === 'ANTHROPIC_API_KEY') return res.status(403).json({ error: 'מפתח API מוגדר בסביבת השרת בלבד' });
    await dbRun('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   ACT — מלווה נפשי אישי              ║
  ║   פורט: ${PORT}                           ║
  ║   פתח: http://localhost:${PORT}           ║
  ╚═══════════════════════════════════════╝
  `);
});
