const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();

// הגדרות Middleware
app.use(cors()); 
app.use(express.json()); 

// חיבור למסד הנתונים PostgreSQL ב-Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false 
  }
});

// וודא חיבור תקין למסד הנתונים
pool.connect((err, client, release) => {
  if (err) {
    return console.error('Error acquiring client', err.stack);
  }
  console.log('Successfully connected to PostgreSQL on Render');
  release();
});

// --- API Endpoints ---

// 1. התחברות (Login)
app.post('/api/auth/login', async (req, res) => {
  const { email } = req.body;
  
  // בדיקה שהאימייל הגיע ואינו ריק למניעת שגיאת toLowerCase
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
    console.error(err);
    res.status(500).json({ error: "Server error during login" });
  }
});

// 2. יצירת פרופיל חדש (Register)
app.post('/api/profiles', async (req, res) => {
  const { email, role, name, position, location, salary_info, availability } = req.body;
  
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: "Valid email is required" });
  }

  try {
    const query = `
      INSERT INTO profiles (email, role, name, position, location, salary_info, availability) 
      VALUES ($1, $2, $3, $4, $5, $6, $7) 
      ON CONFLICT (email) DO UPDATE SET 
        role = EXCLUDED.role, 
        name = EXCLUDED.name,
        position = EXCLUDED.position,
        location = EXCLUDED.location,
        salary_info = EXCLUDED.salary_info,
        availability = EXCLUDED.availability
      RETURNING *`;
    
    const values = [
      email.toLowerCase().trim(), 
      role, 
      name, 
      position, 
      location, 
      salary_info, 
      typeof availability === 'object' ? JSON.stringify(availability) : availability
    ];
    
    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error creating profile" });
  }
});

// 3. קבלת פיד כרטיסי Swipe
app.get('/api/feed/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const userResult = await pool.query('SELECT * FROM profiles WHERE id = $1', [userId]);
    const user = userResult.rows[0];

    if (!user) return res.status(404).json({ error: "User not found" });

    const targetRole = user.role === 'STAFF' ? 'CLINIC' : 'STAFF';

    const query = `
      SELECT * FROM profiles 
      WHERE role = $1 
      AND position = $2
      AND id NOT IN (SELECT swiped_id FROM swipes WHERE swiper_id = $3)
      AND id != $3
      LIMIT 20;
    `;
    
    const feed = await pool.query(query, [targetRole, user.position, userId]);
    res.json(feed.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching feed" });
  }
});

// 4. ביצוע Swipe ובדיקת Match
app.post('/api/swipe', async (req, res) => {
  const { swiper_id, swiped_id, type } = req.body;

  try {
    await pool.query(
      'INSERT INTO swipes (swiper_id, swiped_id, type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [swiper_id, swiped_id, type]
    );

    if (type === 'LIKE') {
      const matchCheck = await pool.query(
        'SELECT * FROM swipes WHERE swiper_id = $1 AND swiped_id = $2 AND type = $3',
        [swiped_id, swiper_id, 'LIKE']
      );

      if (matchCheck.rows.length > 0) {
        await pool.query(
          'INSERT INTO matches (user_one_id, user_two_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [swiper_id, swiped_id]
        );
        return res.json({ isMatch: true });
      }
    }
    res.json({ isMatch: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error processing swipe" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`ClinicMatch Backend is live on port ${PORT}`);
});