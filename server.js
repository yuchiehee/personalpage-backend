// server.js
import express from 'express';
import session from 'express-session';
import bodyParser from 'body-parser';
import SequelizePkg from 'sequelize';
import bcrypt from 'bcrypt';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

const { Sequelize, DataTypes } = SequelizePkg;
const __dirname = path.resolve();

const app = express();
const PORT = process.env.PORT || 3000;

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  }
});

const User = sequelize.define('User', {
  username: { type: DataTypes.STRING, unique: true, allowNull: false },
  passwordHash: { type: DataTypes.STRING, allowNull: false },
  avatarUrl: { type: DataTypes.STRING }
});

const Message = sequelize.define('Message', {
  content: { type: DataTypes.TEXT, allowNull: false }
});

User.hasMany(Message);
Message.belongsTo(User);

app.use(bodyParser.json());
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false
}));

app.use(express.static(path.join(__dirname, '../personalpage-gh-pages')));
app.use('/avatars', express.static(path.join(__dirname, 'avatars')));

app.use(cors({
  origin: 'https://yuchiehee.github.io',
  credentials: true
}));

if (!fs.existsSync('./avatars')) {
  fs.mkdirSync('./avatars');
}

const storage = multer.diskStorage({
  destination: './avatars',
  filename: (req, file, cb) => {
    cb(null, `${req.session.userId}-${Date.now()}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') {
      return cb(new Error('Only JPG and PNG allowed'));
    }
    cb(null, true);
  }
});

app.post('/api/users', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, passwordHash: hash });
    res.json({ id: user.id, username: user.username });
  } catch (err) {
    res.status(500).json({ error: 'User creation failed' });
  }
});

app.get('/api/users', async (req, res) => {
  const users = await User.findAll({ attributes: ['id', 'username', 'avatarUrl'] });
  res.json(users);
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ where: { username } });
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(400).json({ error: 'Invalid credentials' });

  req.session.userId = user.id;
  res.json({ id: user.id, username: user.username });
});

app.get('/api/profile', async (req, res) => {
  if (!req.session.userId) return res.status(403).json({ error: 'Not logged in' });
  const user = await User.findByPk(req.session.userId, { attributes: ['id', 'username', 'avatarUrl'] });
  res.json(user);
});

app.post('/api/upload-avatar', upload.single('avatar'), async (req, res) => {
  if (!req.session.userId) return res.status(403).json({ error: 'Not logged in' });
  const user = await User.findByPk(req.session.userId);
  user.avatarUrl = `/avatars/${req.file.filename}`;
  await user.save();
  res.json({ avatarUrl: user.avatarUrl });
});

app.post('/api/messages', async (req, res) => {
  if (!req.session.userId) return res.status(403).json({ error: 'Not logged in' });
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Message is empty' });
  const message = await Message.create({ content, UserId: req.session.userId });
  res.json(message);
});

app.get('/api/messages', async (req, res) => {
  const messages = await Message.findAll({
    include: {
      model: User,
      attributes: ['id', 'username', 'avatarUrl']
    },
    order: [['createdAt', 'DESC']]
  });
  res.json(messages);
});

app.delete('/api/messages/:id', async (req, res) => {
  if (!req.session.userId) return res.status(403).json({ error: 'Not logged in' });
  const message = await Message.findByPk(req.params.id);
  if (!message || message.UserId !== req.session.userId) {
    return res.status(403).json({ error: 'Not allowed to delete this message' });
  }
  await message.destroy();
  res.json({ success: true });
});

sequelize.sync().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
});
