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
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ success: false, message: "Email is required" });
  }

  try {
    const result = await pool.query('SELECT * FROM profiles WHERE email = $1', [email.toLowerCase().trim()]);
    if (result.rows.length > 0) {
      res.json({ success: true, user: result.rows[0] });
    } else {
      res.status(404).json({ success: false, message: "User not found" });
    }
  } catch (err) {
    res.status(500).json({ error: "Server error during login" });
  }
});

// 2. יצירת פרופיל (Register)
app.post('/api/profiles', async (req, res) => {
  const { email, role, name, position, location, salary_info, availability } = req.body;
  if (!email) return res.status(400).json({ error: "Valid email is required" });

  try {
    const query = `
      INSERT INTO profiles (email, role, name, position, location, salary_info, availability) 
      VALUES ($1, $2, $3, $4, $5, $6, $7) 
      ON CONFLICT (email) DO UPDATE SET 
        role = EXCLUDED.role, name = EXCLUDED.name, position = EXCLUDED.position
      RETURNING *`;
    
    const values = [email.toLowerCase().trim(), role, name, position, location, salary_info, JSON.stringify(availability)];
    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Error creating profile" });
  }
});

// 3. פיד מאובטח (Privacy-Safe Feed)
// שים לב: כאן אנחנו שולחים רק שדות ציבוריים! האימייל לא נשלח.
app.get('/api/feed/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const userRes = await pool.query('SELECT role, position FROM profiles WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    if (!user) return res.status(404).json({ error: "User not found" });

    const targetRole = user.role === 'STAFF' ? 'CLINIC' : 'STAFF';

    // שליפת נתונים ללא אימייל וללא פרטים רגישים
    const query = `
      SELECT id, name, position, location, salary_info, availability, image_url
      FROM profiles 
      WHERE role = $1 
      AND position = $2
      AND id NOT IN (SELECT swiped_id FROM swipes WHERE swiper_id = $3)
      AND id != $3
      LIMIT 20;
    `;
    
    const feed = await pool.query(query, [targetRole, user.position, userId]);
    res.json(feed.rows);
  } catch (err) {
    res.status(500).json({ error: "Privacy-safe feed error" });
  }
});

// 4. ביצוע Swipe ובדיקת Match
app.post('/api/swipe', async (req, res) => {
  const { swiper_id, swiped_id, type } = req.body;
  try {
    await pool.query('INSERT INTO swipes (swiper_id, swiped_id, type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [swiper_id, swiped_id, type]);

    if (type === 'LIKE') {
      const matchCheck = await pool.query('SELECT * FROM swipes WHERE swiper_id = $1 AND swiped_id = $2 AND type = $3', [swiped_id, swiper_id, 'LIKE']);
      if (matchCheck.rows.length > 0) {
        await pool.query('INSERT INTO matches (user_one_id, user_two_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [swiper_id, swiped_id]);
        return res.json({ isMatch: true });
      }
    }
    res.json({ isMatch: false });
  } catch (err) {
    res.status(500).json({ error: "Error processing swipe" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));