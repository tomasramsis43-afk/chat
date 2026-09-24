const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { pool, init } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#0984E3', '#E17055', '#FDCB6E', '#E84393', '#00CEC9', '#D63031'];

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'مطلوب تسجيل الدخول' });
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'الجلسة منتهية، سجل دخول تاني' });
  }
}

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password || username.trim().length < 3 || password.length < 4) {
      return res.status(400).json({ error: 'الاسم يجب أن يكون 3 أحرف على الأقل، والباسورد 4 أحرف على الأقل' });
    }
    const uname = username.trim();
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [uname]);
    if (existing.rows.length) return res.status(400).json({ error: 'الاسم ده مستخدم بالفعل' });

    const hash = bcrypt.hashSync(password, 10);
    const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    const result = await pool.query(
      'INSERT INTO users (username, password, avatar_color) VALUES ($1, $2, $3) RETURNING id, username, avatar_color',
      [uname, hash, color]
    );
    const user = result.rows[0];
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حصل خطأ في السيرفر' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [(username || '').trim()]);
    const row = result.rows[0];
    if (!row || !bcrypt.compareSync(password || '', row.password)) {
      return res.status(400).json({ error: 'الاسم أو الباسورد غلط' });
    }
    const user = { id: row.id, username: row.username, avatar_color: row.avatar_color };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حصل خطأ في السيرفر' });
  }
});

app.get('/api/members', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, avatar_color FROM users WHERE id != $1 ORDER BY username',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حصل خطأ في السيرفر' });
  }
});

app.get('/api/messages/:otherId', authMiddleware, async (req, res) => {
  try {
    const otherId = parseInt(req.params.otherId, 10);
    const result = await pool.query(
      `SELECT * FROM messages
       WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
       ORDER BY id ASC`,
      [req.user.id, otherId]
    );

    await pool.query('UPDATE messages SET is_read = 1 WHERE sender_id = $1 AND receiver_id = $2', [otherId, req.user.id]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'حصل خطأ في السيرفر' });
  }
});

const onlineUsers = new Map();

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    const user = jwt.verify(token, JWT_SECRET);
    socket.user = user;
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

function broadcastOnlineList() {
  io.emit('online-users', Array.from(onlineUsers.keys()).map(Number));
}

io.on('connection', (socket) => {
  onlineUsers.set(socket.user.id, socket.id);
  broadcastOnlineList();

  socket.on('private-message', async ({ toUserId, content }) => {
    try {
      if (!content || !content.trim()) return;
      const result = await pool.query(
        'INSERT INTO messages (sender_id, receiver_id, content) VALUES ($1, $2, $3) RETURNING *',
        [socket.user.id, toUserId, content.trim()]
      );
      const message = result.rows[0];

      const targetSocketId = onlineUsers.get(toUserId);
      if (targetSocketId) io.to(targetSocketId).emit('new-message', message);
      socket.emit('message-sent', message);
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('typing', ({ toUserId }) => {
    const targetSocketId = onlineUsers.get(toUserId);
    if (targetSocketId) io.to(targetSocketId).emit('typing', { fromUserId: socket.user.id });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.user.id);
    broadcastOnlineList();
  });
});

init()
  .then(() => {
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('فشل الاتصال بقاعدة البيانات:', err.message);
    process.exit(1);
  });
