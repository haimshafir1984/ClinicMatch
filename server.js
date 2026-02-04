const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const jwt = require('jsonwebtoken'); 
require('dotenv').config();

const app = express();
app.use(cors()); 
app.use(express.json()); 

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } 
});

// סוד להצפנת הטוקנים
const JWT_SECRET = process.env.JWT_SECRET || 'my_super_secret_key_12345';

// --- Middleware: בדיקת טוקן ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: "Authentication required" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid or expired token" });
    req.user = user;
    next();
  });
};

// --- API Endpoints ---

// 1. התחברות (Login)
app.post('/api/auth/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email missing" });
  try {
    const result = await pool.query('SELECT * FROM profiles WHERE email = $1', [email.toLowerCase().trim()]);
    if (result.rows.length > 0) {
      const user = result.rows[0];
      const token = jwt.sign({ id: user.id, role: user.role, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ success: true, user, token });
    } else {
      res.status(404).json({ success: false, message: "User not found" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. רישום/עדכון פרופיל (כולל מערכים ותחומים)
app.post('/api/profiles', async (req, res) => {
  console.log("Saving Profile Body:", req.body); 

  const { email, role, name, position, location, salary_info, availability, workplace_types, positions } = req.body;
  
  if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: "Valid email is required" });
  }

  // טיפול בשכר: המרה מטווח לממוצע
  let finalSalary = salary_info;
  if (typeof salary_info === 'object' && salary_info !== null) {
      const min = parseInt(salary_info.min) || 0;
      const max = parseInt(salary_info.max) || 0;
      finalSalary = (max > 0) ? Math.round((min + max) / 2) : min;
  }

  try {
    const query = `
      INSERT INTO profiles (
        email, role, name, position, location, salary_info, availability, 
        workplace_types, positions
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
      ON CONFLICT (email) DO UPDATE SET 
        name = EXCLUDED.name, 
        position = EXCLUDED.position,
        location = EXCLUDED.location,
        salary_info = EXCLUDED.salary_info,
        availability = EXCLUDED.availability,
        workplace_types = EXCLUDED.workplace_types,
        positions = EXCLUDED.positions
      RETURNING *`;
      
    // הגנה מפני מערכים ריקים
    const safeWorkplaceTypes = Array.isArray(workplace_types) ? workplace_types : [];
    const safePositions = Array.isArray(positions) ? positions : [];

    const values = [
        email.toLowerCase().trim(), 
        role, 
        name, 
        position || "", // תאימות לאחור
        location, 
        finalSalary,
        JSON.stringify(availability),
        safeWorkplaceTypes, 
        safePositions       
    ];
    
    const result = await pool.query(query, values);
    const user = result.rows[0];
    
    if (!user) {
        return res.status(500).json({ error: "Database save failed" });
    }

    const token = jwt.sign({ id: user.id, role: user.role, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
    
    res.status(201).json({ user, token });

  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// 3. פיד (מוגן - תומך במערכים)
app.get('/api/feed/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (req.user.id !== userId && !req.user.is_admin) {
        return res.status(403).json({ error: "Access denied" });
    }

    const userRes = await pool.query('SELECT role, positions, workplace_types, location FROM profiles WHERE id = $1', [userId]);
    
    if (userRes.rows.length === 0) return res.json([]);
    const user = userRes.rows[0];
    
    const targetRole = user.role === 'STAFF' ? 'CLINIC' : 'STAFF';

    // שאילתה בודקת חפיפה (Overlap) בין המערכים
    const query = `
      SELECT id, name, positions, workplace_types, location, salary_info, availability, created_at
      FROM profiles 
      WHERE role = $1 
      AND (workplace_types && $2 OR $2 = '{}') 
      AND (positions && $3 OR $3 = '{}')
      AND location = $4
      AND id NOT IN (SELECT swiped_id FROM swipes WHERE swiper_id = $5)
      AND id != $5
      ORDER BY created_at DESC LIMIT 20;
    `;
    
    // הערה: הוספתי OR $2 = '{}' כדי שאם המשתמש לא בחר כלום, הוא עדיין יראה תוצאות כלליות
    
    const feed = await pool.query(query, [
        targetRole, 
        user.workplace_types || [], 
        user.positions || [],       
        user.location, 
        userId
    ]);
    
    res.json(feed.rows);
  } catch (err) {
    console.error("Feed Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 4. סוויפ (Swipe)
app.post('/api/swipe', authenticateToken, async (req, res) => {
  const { swiper_id, swiped_id, type } = req.body;
  
  if (req.user.id !== swiper_id) return res.status(403).json({ error: "Identity mismatch" });

  try {
    // בדיקה שהצד השני קיים
    const targetCheck = await pool.query('SELECT role FROM profiles WHERE id = $1', [swiped_id]);
    if (targetCheck.rows.length === 0) return res.status(404).json({ error: "User not found" });
    
    // מניעת סוויפ על אותו תפקיד
    if (req.user.role === targetCheck.rows[0].role) {
        return res.status(400).json({ error: "Cannot swipe on same role" });
    }

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
    console.error("Swipe Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 5. מאצ'ים
app.get('/api/matches/:userId', authenticateToken, async (req, res) => {
    if (req.user.id !== req.params.userId) return res.status(403).json({ error: "Access denied" });
    try {
        const query = `
          SELECT m.id as match_id, p.id as profile_id, p.name, p.positions, p.location
          FROM matches m
          JOIN profiles p ON (p.id = m.user_one_id OR p.id = m.user_two_id)
          WHERE (m.user_one_id = $1 OR m.user_two_id = $1) AND p.id != $1
          ORDER BY m.created_at DESC;
        `;
        const result = await pool.query(query, [req.params.userId]);
        res.json(result.rows);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
});

// 6. הודעות
app.get('/api/messages/:matchId', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM messages WHERE match_id = $1 ORDER BY created_at ASC', [req.params.matchId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/messages', authenticateToken, async (req, res) => {
    if (req.user.id !== req.body.sender_id) return res.status(403).json({ error: "Identity mismatch" });
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

// --- ADMIN ---
const verifyAdminRole = (req, res, next) => {
    if (!req.user || !req.user.is_admin) return res.status(403).json({ error: "Admin access required" });
    next();
};

app.post('/api/admin/stats', authenticateToken, verifyAdminRole, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM admin_stats'); // וודא שיש לך View כזה או שנה לשאילתה רגילה
    res.json(result.rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users', authenticateToken, verifyAdminRole, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, role, positions, is_blocked, created_at FROM profiles ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/toggle-block', authenticateToken, verifyAdminRole, async (req, res) => {
  const { userIdToBlock, blockStatus } = req.body;
  try {
    await pool.query('UPDATE profiles SET is_blocked = $1 WHERE id = $2', [blockStatus, userIdToBlock]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`ClinicMatch Backend Running on port ${PORT}`));