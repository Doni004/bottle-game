const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const db = new Database('game.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    socket_id TEXT,
    is_active INTEGER DEFAULT 0
  )
`);

// Очистка неактивных пользователей при старте
db.prepare('UPDATE users SET is_active = 0, socket_id = NULL').run();

let gameState = {
  currentSpinner: null,
  isSpinning: false
};

// Таймер ожидания переподключения
let reconnectTimer = null;
let reconnectUserId = null;
const RECONNECT_TIMEOUT = 30000; // 30 секунд

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectUserId = null;
  }
}

function startReconnectTimer(userId, userName) {
  clearReconnectTimer();
  reconnectUserId = userId;

  io.emit('waiting-for-reconnect', {
    userId: userId,
    userName: userName,
    timeout: RECONNECT_TIMEOUT / 1000
  });

  reconnectTimer = setTimeout(() => {
    if (reconnectUserId === null || reconnectUserId !== userId) return;

    const user = db.prepare('SELECT is_active FROM users WHERE id = ?').get(userId);

    if (!user || user.is_active === 0) {
      const activePlayers = db.prepare('SELECT id, name FROM users WHERE is_active = 1').all();

      if (activePlayers.length > 0) {
        const next = activePlayers[Math.floor(Math.random() * activePlayers.length)];
        gameState.currentSpinner = next.id;

        io.emit('reconnect-timeout', {
          oldSpinner: userName,
          newSpinnerId: next.id,
          newSpinnerName: next.name
        });

        io.emit('game-state', gameState);
      } else {
        gameState.currentSpinner = null;
        io.emit('game-state', gameState);
      }
    }

    clearReconnectTimer();
  }, RECONNECT_TIMEOUT);
}

app.use(express.static('public'));
app.use(express.json());

// Регистрация
app.post('/register', (req, res) => {
  const { name } = req.body;

  if (!name || name.trim().length === 0) {
    return res.status(400).json({ error: 'Isim gerek' });
  }

  if (name.trim().length < 2) {
    return res.status(400).json({ error: 'Isim gysga' });
  }

  if (name.trim().length > 20) {
    return res.status(400).json({ error: 'Isim uzyn' });
  }

  try {
    const existing = db.prepare('SELECT * FROM users WHERE name = ?').get(name.trim());

    if (existing) {
      if (existing.is_active === 0) {
        db.prepare('UPDATE users SET is_active = 1, socket_id = NULL WHERE id = ?').run(existing.id);
        res.json({ success: true, userId: existing.id, name: name.trim() });
      } else {
        return res.status(400).json({ error: 'Bu isim eýýäm ulanylyar' });
      }
    } else {
      const result = db.prepare('INSERT INTO users (name) VALUES (?)').run(name.trim());
      res.json({ success: true, userId: result.lastInsertRowid, name: name.trim() });
    }
  } catch (err) {
    console.error('Ошибка регистрации:', err);
    res.status(500).json({ error: 'Ýalňyşlyk' });
  }
});

// Проверка сессии
app.get('/session/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
  res.json(user ? { success: true, user } : { success: false });
});

// Список игроков
app.get('/players', (req, res) => {
  const users = db.prepare('SELECT id, name FROM users WHERE is_active = 1').all();
  res.json(users);
});

// Состояние игры
app.get('/game-state', (req, res) => {
  res.json(gameState);
});

// WebSocket
io.on('connection', (socket) => {
  console.log('Täze birikme:', socket.id);

  // Восстановление сессии
  socket.on('restore-session', (userId) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

    if (user) {
      // Отключаем старые сессии этого пользователя
      for (const [id, s] of io.sockets.sockets) {
        if (s.userId === userId && s.id !== socket.id) {
          s.emit('session-taken');
          s.disconnect(true);
        }
      }

      db.prepare('UPDATE users SET socket_id = ?, is_active = 1 WHERE id = ?').run(socket.id, userId);
      socket.userId = userId;
      socket.userName = user.name;

      // Если ждали этого игрока — отменяем таймер
      if (reconnectUserId === userId) {
        clearReconnectTimer();
        io.emit('player-reconnected', { userId: userId, name: user.name });
      }

      socket.emit('game-state', gameState);
      socket.emit('session-restored', { userId: userId, name: user.name });
      io.emit('players-updated');
    } else {
      socket.emit('session-invalid');
    }
  });

  // Новая регистрация
  socket.on('register', (userId) => {
    db.prepare('UPDATE users SET socket_id = ?, is_active = 1 WHERE id = ?').run(socket.id, userId);
    socket.userId = userId;

    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    socket.userName = user.name;

    if (reconnectUserId === userId) {
      clearReconnectTimer();
      io.emit('player-reconnected', { userId: userId, name: user.name });
    }

    io.emit('player-joined', { userId: userId, name: user.name });
    io.emit('players-updated');
  });

  // Вращение бутылочки
  socket.on('spin-bottle', () => {
    if (gameState.isSpinning) return;
    if (gameState.currentSpinner !== null && gameState.currentSpinner !== socket.userId) return;

    clearReconnectTimer();
    gameState.isSpinning = true;

    const players = db.prepare('SELECT id, name FROM users WHERE is_active = 1').all();
    const otherPlayers = players.filter(p => p.id !== socket.userId);

    if (otherPlayers.length === 0) {
      socket.emit('spin-error', 'Başga oýunçy ýok!');
      gameState.isSpinning = false;
      return;
    }

    const target = otherPlayers[Math.floor(Math.random() * otherPlayers.length)];

    io.emit('bottle-spinning', {
      spinner: socket.userName,
      targetId: target.id,
      targetName: target.name
    });

    setTimeout(() => {
      gameState.currentSpinner = target.id;
      gameState.isSpinning = false;

      io.emit('spin-result', {
        targetId: target.id,
        targetName: target.name,
        nextSpinner: target.id
      });
    }, 3000);
  });

  // Чат
  socket.on('chat-message', (data) => {
    if (!data.text || typeof data.text !== 'string') return;
    const text = data.text.trim().slice(0, 500);
    if (!text) return;

    io.emit('chat-message', {
      author: socket.userName,
      text: text,
      timestamp: Date.now()
    });
  });

  // Отключение
  socket.on('disconnect', () => {
    console.log('Aýryldy:', socket.id);
    if (socket.userId) {
      const userName = socket.userName;
      const userId = socket.userId;

      db.prepare('UPDATE users SET is_active = 0, socket_id = NULL WHERE id = ?').run(userId);

      if (gameState.currentSpinner === userId) {
        startReconnectTimer(userId, userName);
      }

      io.emit('player-left', { userId: userId, name: userName });
      io.emit('players-updated');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serwer ${PORT} portda işleýär`);
});