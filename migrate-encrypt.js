/**
 * migrate-encrypt.js
 *
 * סקריפט חד-פעמי שמצפין את כל הנתונים הקיימים ב-Supabase.
 * הרץ פעם אחת אחרי הגדרת ENCRYPTION_KEY בסביבת הייצור.
 *
 * שימוש:
 *   node migrate-encrypt.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const CryptoJS = require('crypto-js');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  console.error('❌  ENCRYPTION_KEY לא מוגדר. הגדר אותו ב-.env לפני הרצת הסקריפט.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function isEncrypted(value) {
  // CryptoJS AES מייצר base64 שתמיד מתחיל ב-"U2FsdGVkX1" ("Salted__")
  return typeof value === 'string' && value.startsWith('U2FsdGVkX1');
}

function encrypt(text) {
  if (!text) return text || '';
  if (isEncrypted(text)) return text; // כבר מוצפן
  return CryptoJS.AES.encrypt(String(text), ENCRYPTION_KEY).toString();
}

async function migrateTable(tableName, fields, idField = 'id') {
  console.log(`\n📋  מעבד טבלה: ${tableName}`);
  const res = await pool.query(`SELECT * FROM ${tableName}`);
  const rows = res.rows;
  console.log(`   נמצאו ${rows.length} רשומות`);

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const alreadyEncrypted = fields.every(f => !row[f] || isEncrypted(row[f]));
    if (alreadyEncrypted) {
      skipped++;
      continue;
    }

    const setClauses = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = fields.map(f => encrypt(row[f]));
    values.push(row[idField]);

    try {
      await pool.query(
        `UPDATE ${tableName} SET ${setClauses} WHERE ${idField} = $${fields.length + 1}`,
        values
      );
      updated++;
    } catch (rowErr) {
      console.error(`   ⚠️  שגיאה ברשומה ${row[idField]}:`, rowErr.message, rowErr.code);
    }
  }

  console.log(`   ✅  עודכנו: ${updated} | דולגו (כבר מוצפנים): ${skipped}`);
}

async function run() {
  console.log('🔐  מתחיל מיגרציית הצפנה...');
  console.log(`   DATABASE_URL: ${process.env.DATABASE_URL?.slice(0, 30)}...`);

  try {
    await migrateTable('anxiety_entries',
      ['event', 'thoughts', 'body', 'duration', 'claude_response']);

    await migrateTable('dream_entries',
      ['content', 'symbols', 'claude_interpretation']);

    await migrateTable('avoidance_entries',
      ['description', 'claude_response', 'small_step', 'what_i_miss']);

    await migrateTable('values_map',
      ['description']);

    await migrateTable('user_profile',
      ['description', 'file_contents'], 'user_id');

    await migrateTable('free_consult_chat',
      ['messages'], 'user_id');

    console.log('\n✅  מיגרציה הושלמה בהצלחה!');
  } catch (err) {
    console.error('\n❌  שגיאה במיגרציה:');
    console.error('  message:', err.message);
    console.error('  code:', err.code);
    console.error('  stack:', err.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
