const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const jwt = require('jsonwebtoken'); 
const OpenAI = require('openai'); // הספרייה החדשה
require('dotenv').config();

const app = express();
app.use(cors()); 
app.use(express.json()); 

// הגדרת החיבור ל-DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } 
});

// הגדרת OpenAI
// וודא שהגדרת את OPENAI_API_KEY במשתני הסביבה ב-Render
const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY 
});

const JWT_SECRET = process.env.JWT_SECRET || 'my_super_secret_key_12345';

// --- Middleware: אימות משתמש ---
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

// ==========================================
//               AI ENDPOINTS
// ==========================================

// 1. Magic Bio Writer - כתיבת אודות אוטומטית
app.post('/api/ai/generate-bio', authenticateToken, async (req, res) => {
  const { keywords, role } = req.body; 
  
  if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OpenAI Key is missing in server settings" });
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a professional HR copywriter for the medical industry. Write in Hebrew." },
        { role: "user", content: `Write a short, professional, and impressive LinkedIn-style summary (2-3 sentences) for a ${role} based on these traits: ${keywords}. Write in first person.` }
      ],
      max_tokens: 200
    });
    
    res.json({ bio: response.choices[0].message.content });
  } catch (err) {
    console.error("AI Bio Error:", err);
    res.status(500).json({ error: "Failed to generate bio" });
  }
});

// 2. Screening Questions Generator - יצירת שאלות למרפאות
app.post('/api/ai/generate-questions', authenticateToken, async (req, res) => {
  const { position, workplace_type } = req.body;
  
  if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OpenAI Key is missing" });
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a recruiting expert. Generate 3 screening questions in Hebrew." },
        { role: "user", content: `Generate 3 tough but polite yes/no or short-answer screening questions for a ${position} candidate applying to a ${workplace_type} clinic. Return only the questions text, numbered 1, 2, 3.` }
      ],
    });
    
    // מפרק את הטקסט למערך של שאלות (אם אפשר), או מחזיר כטקסט
    const text = response.choices[0].message.content;
    const questions = text.split('\n').filter(q => q.trim().length > 0);

    res.json({ questions: questions }); 
  } catch (err) {
    console.error("AI Questions Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
//               CORE ENDPOINTS
// ==========================================

// התחברות
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

// רישום ועדכון פרופיל (כולל שדות AI וחיפוש דחוף)
app.post('/api/profiles', async (req, res) => {
  console.log("Saving Profile:", req.body.email); 

  const { 
      email, role, name, position, location, salary_info, availability, 
      workplace_types, positions, 
      screening_questions, is_auto_screener_active, is_urgent 
  } = req.body;
  
  if (!email) return res.status(400).json({ error: "Email required" });

  // חישוב שכר ממוצע
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
        workplace_types, positions, 
        screening_questions, is_auto_screener_active, is_urgent
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
      ON CONFLICT (email) DO UPDATE SET 
        name = EXCLUDED.name, 
        position = EXCLUDED.position,
        location = EXCLUDED.location,
        salary_info = EXCLUDED.salary_info,
        availability = EXCLUDED.availability,
        workplace_types = EXCLUDED.workplace_types,
        positions = EXCLUDED.positions,
        screening_questions = EXCLUDED.screening_questions,
        is_auto_screener_active = EXCLUDED.is_auto_screener_active,
        is_urgent = EXCLUDED.is_urgent
      RETURNING *`;
      
    const values = [
        email.toLowerCase().trim(), 
        role, 
        name, 
        position || "", 
        location, 
        finalSalary,
        JSON.stringify(availability),
        Array.isArray(workplace_types) ? workplace_types : [], 
        Array.isArray(positions) ? positions : [],
        Array.isArray(screening_questions) ? screening_questions : [], // $10
        is_auto_screener_active || false, // $11
        is_urgent || false                // $12
    ];
    
    const result = await pool.query(query, values);
    const user = result.rows[0];
    
    const token = jwt.sign({ id: user.id, role: user.role, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ user, token });

  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// פיד (Feed) - מציג קודם את הדחופים (is_urgent)
app.get('/api/feed/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user.id !== userId && !req.user.is_admin) return res.status(403).json({ error: "Access denied" });

    const userRes = await pool.query('SELECT role, positions, workplace_types, location FROM profiles WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return res.json([]);
    const user = userRes.rows[0];
    
    const targetRole = user.role === 'STAFF' ? 'CLINIC' : 'STAFF';

    const query = `
      SELECT id, name, positions, workplace_types, location, salary_info, availability, is_urgent, created_at
      FROM profiles 
      WHERE role = $1 
      AND (workplace_types && $2 OR $2 = '{}') 
      AND (positions && $3 OR $3 = '{}')
      AND location = $4
      AND id NOT IN (SELECT swiped_id FROM swipes WHERE swiper_id = $5)
      AND id != $5
      ORDER BY is_urgent DESC, created_at DESC LIMIT 20;
    `;
    
    const feed = await pool.query(query, [
        targetRole, 
        user.workplace_types || [], 
        user.positions || [],       
        user.location, 
        userId
    ]);
    
    res.json(feed.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// סוויפ (Swipe) + בוט סינון אוטומטי
app.post('/api/swipe', authenticateToken, async (req, res) => {
  const { swiper_id, swiped_id, type } = req.body;
  if (req.user.id !== swiper_id) return res.status(403).json({ error: "Identity mismatch" });

  try {
    // 1. רישום הסוויפ
    await pool.query('INSERT INTO swipes (swiper_id, swiped_id, type) VALUES ($1, $2, $3)', [swiper_id, swiped_id, type]);
    
    if (type === 'LIKE') {
      // 2. בדיקה אם יש מאץ' (גם הצד השני עשה לייק)
      const matchCheck = await pool.query('SELECT * FROM swipes WHERE swiper_id = $1 AND swiped_id = $2 AND type = $3', [swiped_id, swiper_id, 'LIKE']);
      
      if (matchCheck.rows.length > 0) {
        // יש מאץ'! יצירת רשומה בטבלת matches
        const matchRes = await pool.query(
          'INSERT INTO matches (user_one_id, user_two_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id',
          [swiper_id, swiped_id]
        );
        
        const matchId = matchRes.rows[0]?.id;

        // --- לוגיקת הבוט האוטומטי (AI Screener) ---
        if (matchId) {
            // שולף את הפרטים של שני הצדדים כדי לבדוק מי המרפאה והאם הבוט פעיל
            const profiles = await pool.query('SELECT id, role, is_auto_screener_active, screening_questions FROM profiles WHERE id IN ($1, $2)', [swiper_id, swiped_id]);
            
            const clinic = profiles.rows.find(p => p.role === 'CLINIC' && p.is_auto_screener_active === true);
            // בדיקה שבאמת יש שאלות לשלוח
            if (clinic && clinic.screening_questions && clinic.screening_questions.length > 0) {
                
                // המרת מערך השאלות לטקסט קריא
                const questionsList = clinic.screening_questions.map(q => `• ${q}`).join("\n");
                const botMessage = `היי, שמחים על ההתאמה! 👋\nכדי להתקדם, נשמח שתענה/י על מספר שאלות קצרות:\n\n${questionsList}`;
                
                // הבוט שולח הודעה אוטומטית בשם המרפאה
                await pool.query(
                    'INSERT INTO messages (match_id, sender_id, content) VALUES ($1, $2, $3)',
                    [matchId, clinic.id, botMessage]
                );
                console.log(`Auto-screener sent message for match ${matchId}`);
            }
        }
        // --- סוף לוגיקת הבוט ---

        return res.json({ isMatch: true, matchId: matchId });
      }
    }
    res.json({ isMatch: false });
  } catch (err) {
    console.error("Swipe Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// שאר ה-Endpoints (מאצ'ים, הודעות, אדמין)
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
      } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/messages/:matchId', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM messages WHERE match_id = $1 ORDER BY created_at ASC', [req.params.matchId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
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
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`ClinicMatch Backend Running on port ${PORT}`));