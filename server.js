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

pool.connect((err) => {
  if (err) console.error('DB Connection Error:', err.stack);
  else console.log('Successfully connected to PostgreSQL');
});

// --- API Endpoints ---

app.post('/api/auth/login', async (req, res) => {
  const { email } = req.body;
  console.log("Login attempt for:", email); // לוג לזיהוי
  if (!email) return res.status(400).json({ error: "Email missing" });
  try {
    const result = await pool.query('SELECT * FROM profiles WHERE email = $1', [email.toLowerCase().trim()]);
    if (result.rows.length > 0) res.json({ success: true, user: result.rows[0] });
    else res.status(404).json({ success: false, message: "User not found" });
  } catch (err) {
    console.error("LOGIN ERROR:", err); // ידפיס לוג ב-Render
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/profiles', async (req, res) => {
  const { email, role, name, position, location, salary_info, availability } = req.body;
  console.log("Registering user:", email);
  try {
    const query = `
      INSERT INTO profiles (email, role, name, position, location, salary_info, availability) 
      VALUES ($1, $2, $3, $4, $5, $6, $7) 
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
      RETURNING *`;
    const values = [email.toLowerCase().trim(), role, name, position, location, salary_info, JSON.stringify(availability)];
    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/feed/:userId', async (req, res) => {
  const { userId } = req.params;
  console.log("Fetching feed for user ID:", userId);
  try {
    // בדיקה אם ה-ID הוא UUID תקין (Render/Postgres לפעמים רגישים לזה)
    const userRes = await pool.query('SELECT role, position FROM profiles WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return res.json([]);

    const user = userRes.rows[0];
    const targetRole = user.role === 'STAFF' ? 'CLINIC' : 'STAFF';

    const query = `
      SELECT id, name, position, location, salary_info, availability, image_url
      FROM profiles 
      WHERE role = $1 AND position = $2
      AND id NOT IN (SELECT swiped_id FROM swipes WHERE swiper_id = $3)
      AND id != $3 LIMIT 20;
    `;
    const feed = await pool.query(query, [targetRole, user.position, userId]);
    res.json(feed.rows);
  } catch (err) {
    console.error("FEED ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/swipe', async (req, res) => {
  const { swiper_id, swiped_id, type } = req.body;
  try {
    await pool.query('INSERT INTO swipes (swiper_id, swiped_id, type) VALUES ($1, $2, $3)', [swiper_id, swiped_id, type]);
    res.json({ success: true });
  } catch (err) {
    console.error("SWIPE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));