require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('public')) fs.mkdirSync('public');

// ─── Database ──────────────────────────────────────────────────────────────

const db = new sqlite3.Database(path.join(__dirname, 'act_app.db'));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS anxiety_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    intensity INTEGER,
    event TEXT,
    thoughts TEXT,
    body TEXT,
    duration TEXT,
    claude_response TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS dream_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    content TEXT,
    symbols TEXT,
    claude_interpretation TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS values_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT UNIQUE,
    description TEXT,
    score INTEGER DEFAULT 5,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_profile (
    id INTEGER PRIMARY KEY DEFAULT 1,
    name TEXT DEFAULT '',
    description TEXT DEFAULT '',
    uploaded_files TEXT DEFAULT '[]',
    file_contents TEXT DEFAULT ''
  )`);

  db.run(`INSERT OR IGNORE INTO user_profile (id) VALUES (1)`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS avoidance_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    description TEXT,
    small_step TEXT DEFAULT '',
    completed INTEGER DEFAULT 0,
    what_i_miss TEXT DEFAULT '',
    claude_response TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ─── DB helpers ─────────────────────────────────────────────────────────────

const dbRun = (sql, p = []) => new Promise((res, rej) =>
  db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

const dbGet = (sql, p = []) => new Promise((res, rej) =>
  db.get(sql, p, (e, row) => { e ? rej(e) : res(row); }));

const dbAll = (sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (e, rows) => { e ? rej(e) : res(rows); }));

// Load saved API key on startup
(async () => {
  try {
    const row = await dbGet('SELECT value FROM settings WHERE key = ?', ['ANTHROPIC_API_KEY']);
    if (row?.value && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = row.value;
  } catch (_) {}
})();

// ─── Claude helpers ──────────────────────────────────────────────────────────

const getClient = () => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === 'your_key_here') throw new Error('מפתח API לא הוגדר — אנא הגדר אותו בהגדרות');
  return new Anthropic({ apiKey: key });
};

const buildSystemPrompt = async () => {
  const profile = await dbGet('SELECT * FROM user_profile WHERE id = 1') || {};
  const anxietyRows = await dbAll(
    'SELECT date, intensity, event FROM anxiety_entries ORDER BY created_at DESC LIMIT 5'
  );
  const dreamRows = await dbAll(
    'SELECT date, content FROM dream_entries ORDER BY created_at DESC LIMIT 3'
  );

  const history = [
    ...anxietyRows.map(r => `  • חרדה (${r.date}): עצמה ${r.intensity}/10 — ${(r.event || '').slice(0, 80)}`),
    ...dreamRows.map(r => `  • חלום (${r.date}): ${(r.content || '').slice(0, 80)}`)
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
תיאור עצמי: ${profile.description || 'לא סופק עדיין'}
${profile.file_contents ? `\nתוכן קבצים אישיים שהועלו:\n${profile.file_contents.slice(0, 2000)}` : ''}

אירועים אחרונים:
${history}`;
};

const SSE = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'Access-Control-Allow-Origin': '*'
};

async function streamClaude(res, systemPrompt, userMessage, maxTokens = 800) {
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

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/anxiety
app.post('/api/anxiety', async (req, res) => {
  res.set(SSE);
  const { intensity, event, thoughts, body, duration } = req.body;
  try {
    const sys = await buildSystemPrompt();
    const msg = `אני חווה חרדה עכשיו.

עוצמה: ${intensity}/10
מה קרה: ${event || 'לא פורט'}
מחשבות: ${thoughts || 'לא פורט'}
תחושות גוף: ${body || 'לא פורט'}
משך הזמן: ${duration || 'לא פורט'}

אנא הגב עם: הכרה ואמפתיה, כלי ACT מותאם לסיטואציה, תרגיל קצר ומיידי, ושאלה אחת לעומק.`;

    const full = await streamClaude(res, sys, msg, 800);
    const date = new Date().toISOString().split('T')[0];
    await dbRun(
      `INSERT INTO anxiety_entries (date, intensity, event, thoughts, body, duration, claude_response) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [date, intensity, event, thoughts, body, duration, full]
    );
    res.write(`data: [DONE]\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// POST /api/dreams
app.post('/api/dreams', async (req, res) => {
  res.set(SSE);
  const { content } = req.body;
  try {
    const sys = await buildSystemPrompt();
    const msg = `פרש את החלום הבא לפי ACT ויונג:

"${content}"

אנא:
1. **ארכיטיפים יונגיאניים**: זהה צל, אנימה/אנימוס, עצמי, פרסונה, ילד, חכם, גיבור
2. **סמלים קולקטיביים**: מה הסמלים הנוכחים אומרים מבחינה אוניברסלית?
3. **עדשת ACT**: מה החלום חושף על ערכים, דפוסי הימנעות, קשיחות קוגניטיבית?
4. **קישור אישי**: כיצד זה מתחבר לאירועים ורגשות האחרונים שלי?`;

    const full = await streamClaude(res, sys, msg, 1000);
    const date = new Date().toISOString().split('T')[0];
    const symbolWords = ['מים', 'אש', 'בית', 'דרך', 'ים', 'הר', 'נחש', 'ילד', 'אור', 'חשיכה', 'טיסה', 'נפילה', 'דלת', 'מראה', 'יער', 'בעל חיים'];
    const symbols = symbolWords.filter(s => content.includes(s));
    await dbRun(
      `INSERT INTO dream_entries (date, content, symbols, claude_interpretation) VALUES (?, ?, ?, ?)`,
      [date, content, JSON.stringify(symbols), full]
    );
    res.write(`data: [DONE]\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// POST /api/avoidance
app.post('/api/avoidance', async (req, res) => {
  res.set(SSE);
  const { description } = req.body;
  let entryId = null;
  try {
    const date = new Date().toISOString().split('T')[0];
    const result = await dbRun(
      `INSERT INTO avoidance_entries (date, description) VALUES (?, ?)`,
      [date, description]
    );
    entryId = result.lastID;

    const sys = await buildSystemPrompt();
    const msg = `אני נמנע מ: "${description}"

אנא:
1. **צעד קטן**: שבור את זה לצעד אחד קטן מאוד וספציפי (פחות מ-2 דקות) שאוכל לעשות היום — תן דוגמה ממוקדת, לא כללית
2. **מה אני מפסיד**: שאל אותי "מה היית עושה אם החרדה לא הייתה כאן?" — חבר את ההימנעות לערכים שלי
3. **פרספקטיבה**: הזכר לי שהימנעות מדבר חשוב היא סימן שזה חשוב לי — לא חולשה אלא ראיה לאכפתיות`;

    const full = await streamClaude(res, sys, msg, 600);
    await dbRun(`UPDATE avoidance_entries SET claude_response = ? WHERE id = ?`, [full, entryId]);
    res.write(`data: ${JSON.stringify({ id: entryId, done: true })}\n\n`);
    res.write(`data: [DONE]\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.end();
});

// PUT /api/avoidance/:id
app.put('/api/avoidance/:id', async (req, res) => {
  try {
    const { completed, small_step, what_i_miss } = req.body;
    await dbRun(
      `UPDATE avoidance_entries SET completed = ?, small_step = COALESCE(NULLIF(?, ''), small_step), what_i_miss = COALESCE(NULLIF(?, ''), what_i_miss) WHERE id = ?`,
      [completed ? 1 : 0, small_step || '', what_i_miss || '', req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/avoidance
app.get('/api/avoidance', async (req, res) => {
  try {
    res.json(await dbAll('SELECT * FROM avoidance_entries ORDER BY created_at DESC'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/avoidance/wins
app.get('/api/avoidance/wins', async (req, res) => {
  try {
    res.json(await dbAll('SELECT * FROM avoidance_entries WHERE completed = 1 ORDER BY created_at DESC'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/entries
app.get('/api/entries', async (req, res) => {
  try {
    const anxiety = await dbAll('SELECT * FROM anxiety_entries ORDER BY created_at DESC LIMIT 50');
    const dreams = await dbAll('SELECT * FROM dream_entries ORDER BY created_at DESC LIMIT 20');
    res.json({ anxiety, dreams });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard
app.get('/api/dashboard', async (req, res) => {
  try {
    const anxiety = await dbAll('SELECT date, intensity FROM anxiety_entries ORDER BY created_at DESC LIMIT 30');
    const avoidance = await dbAll('SELECT date, completed FROM avoidance_entries ORDER BY created_at DESC LIMIT 30');
    const dreams = await dbAll('SELECT date FROM dream_entries ORDER BY created_at DESC LIMIT 10');

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
app.get('/api/profile', async (req, res) => {
  try {
    res.json(await dbGet('SELECT * FROM user_profile WHERE id = 1'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/profile
app.put('/api/profile', async (req, res) => {
  try {
    const { name, description } = req.body;
    await dbRun('UPDATE user_profile SET name = ?, description = ? WHERE id = 1', [name, description]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload
const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/upload', upload.single('file'), async (req, res) => {
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

    const profile = await dbGet('SELECT * FROM user_profile WHERE id = 1');
    const files = JSON.parse(profile.uploaded_files || '[]');
    files.push(req.file.originalname);

    const existing = profile.file_contents || '';
    const newContent = (existing + `\n\n--- ${req.file.originalname} ---\n${text.slice(0, 3000)}`).slice(0, 10000);

    await dbRun(
      'UPDATE user_profile SET uploaded_files = ?, file_contents = ? WHERE id = 1',
      [JSON.stringify(files), newContent]
    );

    fs.unlinkSync(filePath);
    res.json({ success: true, filename: req.file.originalname, chars: text.length });
  } catch (err) {
    console.error('Upload error:', err);
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
app.post('/api/values', async (req, res) => {
  try {
    const { values } = req.body;
    for (const v of values) {
      const exists = await dbGet('SELECT id FROM values_map WHERE domain = ?', [v.domain]);
      if (exists) {
        await dbRun('UPDATE values_map SET description = ?, score = ?, updated_at = CURRENT_TIMESTAMP WHERE domain = ?',
          [v.description, v.score, v.domain]);
      } else {
        await dbRun('INSERT INTO values_map (domain, description, score) VALUES (?, ?, ?)',
          [v.domain, v.description, v.score]);
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/values
app.get('/api/values', async (req, res) => {
  try {
    res.json(await dbAll('SELECT * FROM values_map'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/values/feedback
app.post('/api/values/feedback', async (req, res) => {
  res.set(SSE);
  const { values } = req.body;
  try {
    const sys = await buildSystemPrompt();
    const valuesText = values.map(v =>
      `• ${v.domain}: ${v.description || 'לא פורט'} — חי לפיו: ${v.score}/10`
    ).join('\n');

    const msg = `הנה מפת הערכים שלי:\n${valuesText}\n\nאנא תן פידבק ממוקד על הפערים הגדולים ביותר בין מה שחשוב לי לבין כמה אני חי לפיו. מה צעד אחד קטן שאוכל לקחת השבוע עבור הערך עם הפער הגדול ביותר?`;

    await streamClaude(res, sys, msg, 800);
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
    rows.forEach(r => {
      obj[r.key] = r.key === 'ANTHROPIC_API_KEY' && r.value ? '***' : r.value;
    });
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
    await dbRun('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    if (key === 'ANTHROPIC_API_KEY') process.env.ANTHROPIC_API_KEY = value;
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
