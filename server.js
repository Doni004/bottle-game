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

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    is_system INTEGER DEFAULT 0
  )
`);

// Ограничиваем историю последними 200 сообщениями
db.exec(`DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 200)`);

// Очистка неактивных при старте
db.prepare('UPDATE users SET is_active = 0, socket_id = NULL').run();

let gameState = {
  currentSpinner: null,
  isSpinning: false
};

let reconnectTimer = null;
let reconnectUserId = null;
const RECONNECT_TIMEOUT = 45000; // 45 секунд для мобильного интернета

// Rate limiting для чата
const chatLimits = new Map();

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectUserId = null;
  }
}

function saveSystemMessage(text) {
  const result = db.prepare(
    'INSERT INTO messages (author, text, timestamp, is_system) VALUES (?, ?, ?, 1)'
  ).run('Sistema', text, Date.now());
  return result.lastInsertRowid;
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
      const activePlayers = db.prepare(
        'SELECT id, name FROM users WHERE is_active = 1'
      ).all();

      if (activePlayers.length > 0) {
        const next = activePlayers[Math.floor(Math.random() * activePlayers.length)];
        gameState.currentSpinner = next.id;

        const msgId = saveSystemMessage(
          `${userName} gaýtadan birikmedi — nobat ${next.name}-a geçdi`
        );

        io.emit('reconnect-timeout', {
          oldSpinner: userName,
          newSpinnerId: next.id,
          newSpinnerName: next.name
        });

        io.emit('chat-message', {
          id: msgId,
          author: 'Sistema',
          text: `${userName} gaýtadan birikmedi — nobat ${next.name}-a geçdi`,
          timestamp: Date.now(),
          isSystem: true
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
        db.prepare('UPDATE users SET is_active = 1, socket_id = NULL WHERE id = ?')
          .run(existing.id);
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

app.get('/session/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
  res.json(user ? { success: true, user } : { success: false });
});

app.get('/players', (req, res) => {
  const users = db.prepare('SELECT id, name FROM users WHERE is_active = 1').all();
  res.json(users);
});

app.get('/game-state', (req, res) => {
  res.json(gameState);
});

// API для загрузки истории сообщений
app.get('/messages', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const before = parseInt(req.query.before) || 0;

  let query;
  let params;

  if (before > 0) {
    query = 'SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?';
    params = [before, limit];
  } else {
    query = 'SELECT * FROM messages ORDER BY id DESC LIMIT ?';
    params = [limit];
  }

  const messages = db.prepare(query).all(...params);
  res.json(messages.reverse());
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

      db.prepare('UPDATE users SET socket_id = ?, is_active = 1 WHERE id = ?')
        .run(socket.id, userId);
      socket.userId = userId;
      socket.userName = user.name;

      if (reconnectUserId === userId) {
        clearReconnectTimer();
        const msgId = saveSystemMessage(`${user.name} gaýtadan birikdi`);
        io.emit('player-reconnected', { userId: userId, name: user.name });
        io.emit('chat-message', {
          id: msgId,
          author: 'Sistema',
          text: `${user.name} gaýtadan birikdi`,
          timestamp: Date.now(),
          isSystem: true
        });
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
  const prevUser = db.prepare('SELECT is_active FROM users WHERE id = ?').get(userId);
  const wasActive = prevUser && prevUser.is_active === 1;

  db.prepare('UPDATE users SET socket_id = ?, is_active = 1 WHERE id = ?')
    .run(socket.id, userId);
  socket.userId = userId;

  const user = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
  socket.userName = user.name;

  // Отменяем таймер disconnect если был
  if (disconnectTimers.has(userId)) {
    clearTimeout(disconnectTimers.get(userId));
    disconnectTimers.delete(userId);
  }

  if (reconnectUserId === userId) {
    clearReconnectTimer();
    const msgId = saveSystemMessage(`${user.name} gaýtadan birikdi`);
    io.emit('player-reconnected', { userId: userId, name: user.name });
    io.emit('chat-message', {
      id: msgId,
      author: 'Sistema',
      text: `${user.name} gaýtadan birikdi`,
      timestamp: Date.now(),
      isSystem: true
    });
  } else if (!wasActive) {
    // Только если реально новый вход, а не переподключение
    const msgId = saveSystemMessage(`${user.name} oýna girdi`);
    io.emit('player-joined', { userId: userId, name: user.name });
    io.emit('chat-message', {
      id: msgId,
      author: 'Sistema',
      text: `${user.name} oýna girdi`,
      timestamp: Date.now(),
      isSystem: true
    });
  }

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

  // Чат с защитой от спама
  socket.on('chat-message', (data) => {
    if (!socket.userId || !socket.userName) return;

    const now = Date.now();
    const lastTime = chatLimits.get(socket.userId) || 0;

    if (now - lastTime < 1000) return; // не чаще 1 сообщения в секунду
    chatLimits.set(socket.userId, now);

    if (!data.text || typeof data.text !== 'string') return;
    const text = data.text.trim().slice(0, 500);
    if (!text) return;

    const result = db.prepare(
      'INSERT INTO messages (author, text, timestamp, is_system) VALUES (?, ?, ?, 0)'
    ).run(socket.userName, text, now);

    io.emit('chat-message', {
      id: result.lastInsertRowid,
      author: socket.userName,
      text: text,
      timestamp: now,
      isSystem: false
    });
  });

  // Отключение
  // Debounce таймеры для disconnect
const disconnectTimers = new Map(); // userId -> timer
const DISCONNECT_DELAY = 3000; // 3 секунды ждём перед тем как сказать "вышел"

socket.on('disconnect', () => {
  console.log('Aýryldy:', socket.id);
  if (socket.userId) {
    const userId = socket.userId;
    const userName = socket.userName;

    // Отменяем предыдущий таймер если был
    if (disconnectTimers.has(userId)) {
      clearTimeout(disconnectTimers.get(userId));
    }

    // Ждём 3 секунды — может это просто переподключение
    const timer = setTimeout(() => {
      // Проверяем, подключился ли он снова за это время
      const user = db.prepare('SELECT is_active, socket_id FROM users WHERE id = ?').get(userId);
      
      if (!user || user.is_active === 0 || !user.socket_id) {
        // Действительно вышел
        db.prepare('UPDATE users SET is_active = 0, socket_id = NULL WHERE id = ?').run(userId);

        if (gameState.currentSpinner === userId) {
          startReconnectTimer(userId, userName);
        }

        const msgId = saveSystemMessage(`${userName} oýundan çykdy`);
        io.emit('player-left', { userId: userId, name: userName });
        io.emit('chat-message', {
          id: msgId,
          author: 'Sistema',
          text: `${userName} oýundan çykdy`,
          timestamp: Date.now(),
          isSystem: true
        });
        io.emit('players-updated');
      }
      
      disconnectTimers.delete(userId);
    }, DISCONNECT_DELAY);

    disconnectTimers.set(userId, timer);
  }
});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serwer ${PORT} portda işleýär`);
});