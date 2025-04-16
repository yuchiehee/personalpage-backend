// ✅ 整合 CSRF Token 流程
const express = require('express');
const session = require('express-session');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
const fs = require('fs');
const crypto = require('crypto');

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

cloudinary.uploader.upload_stream_promise = function(options, buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    stream.end(buffer);
  });
};


// === Middleware ===
const allowedOrigins = [
  'https://yuchiehee.github.io',
  'https://yuchieh-midterm.connor1999.com'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'DELETE'],
  optionsSuccessStatus: 200
}));

app.options('*', cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.set('trust proxy', 1);

app.use(session({
  secret: 'secretKey',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    sameSite: 'none'
  }
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

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

function verifyCsrf(req, res, next) {
  const token = req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).json({ success: false, message: 'Invalid CSRF token' });
  }
  next();
}

app.post('/register', upload.single('avatar'), async (req, res) => {
  const { username, password } = req.body;
  const file = req.file;

  console.log('[Debug] username:', username);
  console.log('[Debug] password:', password);
  console.log('[Debug] file:', file?.originalname, file?.mimetype);

  if (!username || !password || !file) {
    return res.status(400).json({ success: false, message: '缺少欄位' });
  }

  try {
    const result = await cloudinary.uploader.upload_stream_promise(
      {
        folder: 'avatars',
        resource_type: 'image'
      },
      file.buffer
    );

    const avatarUrl = result.secure_url;

    const dbRes = await pool.query(
      'INSERT INTO users (username, password, avatar) VALUES ($1, $2, $3) RETURNING *',
      [username, password, avatarUrl]
    );

    req.session.user = dbRes.rows[0];
    req.session.csrfToken = crypto.randomUUID();

    req.session.save(() => {
      res.json({ success: true, user: dbRes.rows[0], csrfToken: req.session.csrfToken });
    });

  } catch (err) {
    console.error('❌ 註冊錯誤:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username=$1 AND password=$2', [username, password]);
    if (result.rows.length > 0) {
      req.session.user = result.rows[0];
      req.session.csrfToken = crypto.randomUUID();
      req.session.save(() => {
        res.json({ success: true, csrfToken: req.session.csrfToken });
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
    res.json({ loggedIn: true, user: req.session.user, csrfToken: req.session.csrfToken });
  } else {
    res.json({ loggedIn: false });
  }
});

app.post('/comment', verifyCsrf, async (req, res) => {
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

app.delete('/comment/:id', verifyCsrf, async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false });
  const commentId = req.params.id;
  try {
    const result = await pool.query('DELETE FROM comments WHERE id=$1 AND user_id=$2', [commentId, req.session.user.id]);
    res.json({ success: result.rowCount > 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/gpt-alt', async (req, res) => {
  const { prompt } = req.body;
  console.log('收到 prompt：', prompt);

  const backendprompt = `
你是一位神秘且溫柔的 AI 占卜師。
請根據「最近的狀態：${prompt}」進行占卜，給予鼓勵的預測與建議。
請用詩意又神祕的語氣回答，不要問問題。

AI 占卜師說：
`.trim();

  try {
    const response = await fetch('https://api-inference.huggingface.co/models/tiiuae/falcon-rw-1b', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HF_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: backendprompt,
        parameters: {
          max_new_tokens: 300,
          return_full_text: true
        }
      })
    });

    const rawText = await response.text();
    console.log('🧪 Hugging Face 原始回傳：', rawText.slice(0, 300));

    // 嘗試解析成 JSON
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error('❌ 回傳不是 JSON：', rawText);
      return res.json({ success: false, result: '📡 模型回傳異常，請稍候再試。' });
    }

    // 處理模型忙碌錯誤
    if (data.error?.includes('Model too busy')) {
      console.warn('⚠️ 模型忙碌中');
      return res.json({ success: false, result: '📡 模型忙碌中，請稍候再試。' });
    }

    // 擷取內容
    const fullText = Array.isArray(data) ? data[0]?.generated_text : data.generated_text;
    let result = '[占卜失敗]';
    if (fullText) {
      result = fullText.includes('<|assistant|>')
        ? fullText.split('<|assistant|>')[1].trim()
        : fullText.trim();
    }

    res.json({ success: true, result });

  } catch (err) {
    console.error('❌ Hugging Face API 錯誤：', err);
    res.status(500).json({ success: false, result: '⚠️ 無法連接占卜模型，請稍後再試。' });
  }
});


initDatabase().then(() => {
  app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
});
