// server.js
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3001;

// === Middleware ===
app.use(cors({ origin: 'https://personalpage.vercel.app', credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(
  session({
    secret: 'secretKey',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
  })
);

// === PostgreSQL DB ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// === Multer for image upload ===
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png'];
    cb(null, allowedTypes.includes(file.mimetype));
  },
});

// === Routes ===
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('INSERT INTO users (username, password) VALUES ($1, $2) RETURNING *', [username, password]);
    req.session.user = result.rows[0];
    res.json({ success: true });
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
      res.json({ success: true });
    } else {
      res.json({ success: false });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/me', (req, res) => {
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

app.listen(port, () => console.log(`Server running on port ${port}`));
