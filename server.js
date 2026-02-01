const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors()); // מאפשר ל-Lovable לתקשר עם השרת

// חיבור ל-Render PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // חובה ב-Render
});

// --- API Endpoints ---

// 1. קבלת פיד (עובדים רואים מרפאות ולהפך)
app.get('/api/feed/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const userRes = await pool.query('SELECT * FROM profiles WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    if (!user) return res.status(404).json({ error: "User not found" });

    const targetRole = user.role === 'STAFF' ? 'CLINIC' : 'STAFF';

    // אלגוריתם התאמה: תפקיד זהה + לא ראיתי אותם עדיין
    const query = `
      SELECT * FROM profiles 
      WHERE role = $1 
      AND position = $2
      AND id NOT IN (SELECT swiped_id FROM swipes WHERE swiper_id = $3)
      LIMIT 20;
    `;
    
    const feed = await pool.query(query, [targetRole, user.position, userId]);
    res.json(feed.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. ביצוע Swipe ובדיקת Match
app.post('/api/swipe', async (req, res) => {
  const { swiper_id, swiped_id, type } = req.body;

  try {
    // שמירת הסוויפ
    await pool.query(
      'INSERT INTO swipes (swiper_id, swiped_id, type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [swiper_id, swiped_id, type]
    );

    if (type === 'LIKE') {
      // בדיקה אם יש לייק חוזר
      const matchCheck = await pool.query(
        'SELECT * FROM swipes WHERE swiper_id = $1 AND swiped_id = $2 AND type = $3',
        [swiped_id, swiper_id, 'LIKE']
      );

      if (matchCheck.rows.length > 0) {
        // יצירת Match
        await pool.query(
          'INSERT INTO matches (user_one_id, user_two_id) VALUES ($1, $2)',
          [swiper_id, swiped_id]
        );
        return res.json({ isMatch: true });
      }
    }
    res.json({ isMatch: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. יצירת פרופיל (Register)
app.post('/api/profiles', async (req, res) => {
  const { email, role, name, position, location, salary_info, availability } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO profiles (email, role, name, position, location, salary_info, availability) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [email, role, name, position, location, salary_info, JSON.stringify(availability)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));