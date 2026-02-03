const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors()); 
app.use(express.json()); 

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } 
});

// --- API Endpoints ---

// 1. התחברות (Login)
app.post('/api/auth/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email missing" });
  try {
    const result = await pool.query('SELECT * FROM profiles WHERE email = $1', [email.toLowerCase().trim()]);
    if (result.rows.length > 0) res.json({ success: true, user: result.rows[0] });
    else res.status(404).json({ success: false, message: "User not found" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. רישום (Register)
app.post('/api/profiles', async (req, res) => {
  const { email, role, name, position, location, salary_info, availability } = req.body;
  try {
    const query = `
      INSERT INTO profiles (email, role, name, position, location, salary_info, availability) 
      VALUES ($1, $2, $3, $4, $5, $6, $7) 
      ON CONFLICT (email) DO UPDATE SET 
        name = EXCLUDED.name, 
        position = EXCLUDED.position,
        location = EXCLUDED.location
      RETURNING *`;
    const values = [email.toLowerCase().trim(), role, name, position, location, salary_info, JSON.stringify(availability)];
    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. פיד חכם (Feed): סינון לפי עיר + מיון לפי זמן
app.get('/api/feed/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // שליפת פרטי המשתמש הנוכחי
    const userRes = await pool.query('SELECT role, position, location FROM profiles WHERE id = $1', [userId]);
    
    if (userRes.rows.length === 0) return res.json([]);
    const user = userRes.rows[0];
    
    const targetRole = user.role === 'STAFF' ? 'CLINIC' : 'STAFF';

    // השאילתה המעודכנת: התאמת תפקיד, מיקום זהה, והסרת משתמשים שכבר נצפו
    const query = `
      SELECT id, name, position, location, salary_info, availability, created_at
      FROM profiles 
      WHERE role = $1 
      AND position = $2
      AND location = $3
      AND id NOT IN (SELECT swiped_id FROM swipes WHERE swiper_id = $4)
      AND id != $4
      ORDER BY created_at DESC
      LIMIT 20;
    `;
    
    // שליחת המיקום של המשתמש כפרמטר לסינון
    const feed = await pool.query(query, [targetRole, user.position, user.location, userId]);
    
    res.json(feed.rows);
  } catch (err) {
    console.error("FEED ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// 4. סוויפ ובדיקת מאץ'
app.post('/api/swipe', async (req, res) => {
  const { swiper_id, swiped_id, type } = req.body;
  try {
    await pool.query('INSERT INTO swipes (swiper_id, swiped_id, type) VALUES ($1, $2, $3)', [swiper_id, swiped_id, type]);
    
    if (type === 'LIKE') {
      const matchCheck = await pool.query('SELECT * FROM swipes WHERE swiper_id = $1 AND swiped_id = $2 AND type = $3', [swiped_id, swiper_id, 'LIKE']);
      
      if (matchCheck.rows.length > 0) {
        const matchRes = await pool.query(
          'INSERT INTO matches (user_one_id, user_two_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id',
          [swiper_id, swiped_id]
        );
        return res.json({ isMatch: true, matchId: matchRes.rows[0]?.id });
      }
    }
    res.json({ isMatch: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. קבלת רשימת מאצ'ים (My Matches)
app.get('/api/matches/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const query = `
      SELECT m.id as match_id, p.id as profile_id, p.name, p.position, p.location
      FROM matches m
      JOIN profiles p ON (p.id = m.user_one_id OR p.id = m.user_two_id)
      WHERE (m.user_one_id = $1 OR m.user_two_id = $1) AND p.id != $1
      ORDER BY m.created_at DESC;
    `;
    const result = await pool.query(query, [userId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. שליפת הודעות צ'אט
app.get('/api/messages/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;
    const result = await pool.query('SELECT * FROM messages WHERE match_id = $1 ORDER BY created_at ASC', [matchId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. שליחת הודעה
app.post('/api/messages', async (req, res) => {
  const { match_id, sender_id, content } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO messages (match_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *',
      [match_id, sender_id, content]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// --- ADMIN PANEL ENDPOINTS ---

// בדיקת הרשאת אדמין (Middleware פשוט)
const checkAdmin = async (req, res, next) => {
  const { adminId } = req.body; // נשלח את ה-ID של המבקש בגוף הבקשה או ב-Query
  // הערה: במוצר סופי נשתמש ב-Token, ל-MVP זה מספיק
  if (!adminId) return res.status(403).json({ error: "Access denied" });
  
  const result = await pool.query('SELECT is_admin FROM profiles WHERE id = $1', [adminId]);
  if (result.rows.length > 0 && result.rows[0].is_admin) {
    next();
  } else {
    res.status(403).json({ error: "Admin access required" });
  }
};

// 1. קבלת סטטיסטיקות
app.post('/api/admin/stats', checkAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM admin_stats');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. קבלת רשימת כל המשתמשים
app.post('/api/admin/users', checkAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, role, position, is_blocked, created_at FROM profiles ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. חסימה/שחרור משתמש
app.post('/api/admin/toggle-block', checkAdmin, async (req, res) => {
  const { userIdToBlock, blockStatus } = req.body;
  try {
    await pool.query('UPDATE profiles SET is_blocked = $1 WHERE id = $2', [blockStatus, userIdToBlock]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`ClinicMatch Backend Pro live on port ${PORT}`));