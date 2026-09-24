const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#0984E3', '#E17055', '#FDCB6E', '#E84393', '#00CEC9', '#D63031'];

// ---------- Auth helpers ----------
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

// ---------- Routes ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.trim().length < 3 || password.length < 4) {
    return res.status(400).json({ error: 'الاسم يجب أن يكون 3 أحرف على الأقل، والباسورد 4 أحرف على الأقل' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) return res.status(400).json({ error: 'الاسم ده مستخدم بالفعل' });

  const hash = bcrypt.hashSync(password, 10);
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const info = db.prepare('INSERT INTO users (username, password, avatar_color) VALUES (?, ?, ?)').run(username.trim(), hash, color);
  const user = { id: info.lastInsertRowid, username: username.trim(), avatar_color: color };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get((username || '').trim());
  if (!row || !bcrypt.compareSync(password || '', row.password)) {
    return res.status(400).json({ error: 'الاسم أو الباسورد غلط' });
  }
  const user = { id: row.id, username: row.username, avatar_color: row.avatar_color };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user });
});

app.get('/api/members', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT id, username, avatar_color FROM users WHERE id != ? ORDER BY username').all(req.user.id);
  res.json(rows);
});

app.get('/api/messages/:otherId', authMiddleware, (req, res) => {
  const otherId = parseInt(req.params.otherId, 10);
  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
    ORDER BY id ASC
  `).all(req.user.id, otherId, otherId, req.user.id);

  db.prepare('UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?').run(otherId, req.user.id);

  res.json(rows);
});

// ---------- Socket.io realtime ----------
const onlineUsers = new Map(); // userId -> socketId

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

  socket.on('private-message', ({ toUserId, content }) => {
    if (!content || !content.trim()) return;
    const info = db.prepare('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)')
      .run(socket.user.id, toUserId, content.trim());

    const message = {
      id: info.lastInsertRowid,
      sender_id: socket.user.id,
      receiver_id: toUserId,
      content: content.trim(),
      created_at: new Date().toISOString(),
      is_read: 0
    };

    const targetSocketId = onlineUsers.get(toUserId);
    if (targetSocketId) io.to(targetSocketId).emit('new-message', message);
    socket.emit('message-sent', message);
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

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
