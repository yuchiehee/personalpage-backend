// server.js
const express = require('express');
const session = require('express-session');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3001;

const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const upload = multer();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// === Middleware ===
app.use(cors({
  origin: 'https://yuchiehee.github.io',
  credentials: true,
  methods: ['GET', 'POST', 'DELETE'],
  optionsSuccessStatus: 200
}));

app.options('*', cors({
  origin: 'https://yuchiehee.github.io',
  credentials: true
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.set('trust proxy', 1); // ⭐⭐ 告訴 Express：「我後面有反向代理，請當作 HTTPS」

app.use(session({
  secret: 'secretKey',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,              
    sameSite: 'none'            
  }
}));


// === PostgreSQL DB ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 確保 uploads 資料夾存在
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// 啟動時自動建立資料表（users / comments）
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        avatar TEXT
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        content TEXT NOT NULL
      );
    `);
    console.log('✅ 資料表初始化完成');
  } catch (err) {
    console.error('❌ 資料表初始化失敗：', err.message);
  }
}

// === Routes ===
app.post('/register', upload.single('avatar'), async (req, res) => {
  const { username, password } = req.body;
  const file = req.file;

  if (!username || !password || !file) {
    return res.status(400).json({ success: false, message: '缺少欄位' });
  }

  try {
    // 建立上傳 stream
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'avatars', resource_type: 'image' },
      async (error, result) => {
        if (error) return res.status(500).json({ success: false, error: error.message });

        const avatarUrl = result.secure_url;

        const dbRes = await pool.query(
          'INSERT INTO users (username, password, avatar) VALUES ($1, $2, $3) RETURNING *',
          [username, password, avatarUrl]
        );

        req.session.user = dbRes.rows[0];
        res.json({ success: true, user: dbRes.rows[0] });
      }
    );

    // 傳入檔案內容
    stream.end(file.buffer);

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username=$1 AND password=$2', [username, password]);
    if (result.rows.length > 0) {
      req.session.user = result.rows[0];

      // ✅ 強制儲存 session，才會送出 Set-Cookie
      req.session.save(() => {
        console.log('✅ 登入成功，session 已儲存');
        res.json({ success: true });
      });
    } else {
      res.json({ success: false, message: '帳號或密碼錯誤' });
    }
  } catch (err) {
    console.error('❌ 登入錯誤:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/me', (req, res) => {
  console.log('🧠 session:', req.session.user);
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

app.post('/upload-avatar', upload.single('avatar'), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const filePath = `/uploads/${req.file.filename}`;
  try {
    await pool.query('UPDATE users SET avatar=$1 WHERE id=$2', [filePath, req.session.user.id]);
    req.session.user.avatar = filePath;
    res.json({ success: true, avatar: filePath });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/comment', async (req, res) => {
  const { content } = req.body;
  if (!req.session.user) return res.status(401).json({ success: false });
  try {
    await pool.query('INSERT INTO comments (user_id, content) VALUES ($1, $2)', [req.session.user.id, content]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/comments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT comments.id, comments.content, comments.user_id, users.username, users.avatar
      FROM comments
      JOIN users ON comments.user_id = users.id
      ORDER BY comments.id DESC
    `);
    res.json({ success: true, comments: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/comment/:id', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false });
  const commentId = req.params.id;
  try {
    const result = await pool.query('DELETE FROM comments WHERE id=$1 AND user_id=$2', [commentId, req.session.user.id]);
    res.json({ success: result.rowCount > 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

initDatabase().then(() => {
  app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
});

app.post('/gpt-alt', async (req, res) => {
  const { prompt } = req.body;

  try {
    const response = await fetch(
      'https://api-inference.huggingface.co/models/meta-llama/Llama-2-7b-chat-hf',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.HF_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: { max_new_tokens: 100 }
        })
      }
    );

    const data = await response.json();

    if (Array.isArray(data) && data[0]?.generated_text) {
      res.json({ success: true, result: data[0].generated_text });
    } else {
      res.json({ success: false, result: '[HuggingFace 無回應]' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

