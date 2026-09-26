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

app.use(express.static('public'));
app.use(express.json());

app.post('/register', (req, res) => {
  const { name } = req.body;
  
  if (!name || name.trim().length === 0) {
    return res.status(400).json({ error: 'At gerek' });
  }
  
  try {
    const existing = db.prepare('SELECT * FROM users WHERE name = ?').get(name.trim());
    
    if (existing) {
      // Если имя занято, но пользователь неактивен, разрешаем повторную регистрацию
      if (existing.is_active === 0) {
        // Обновляем существующего пользователя
        db.prepare('UPDATE users SET is_active = 1, socket_id = NULL WHERE id = ?').run(existing.id);
        res.json({ success: true, userId: existing.id, name: name.trim() });
      } else {
        // Пользователь активен — имя действительно занято
        return res.status(400).json({ error: 'Bu isim eýýäm ulanylyar' });
      }
    } else {
      // Новое имя — создаём пользователя
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
  const user = db.prepare('SELECT id, name FROM users WHERE id = ? AND is_active = 1').get(userId);
  res.json(user ? { success: true, user } : { success: false });
});

app.get('/players', (req, res) => {
  // Очищаем неактивных перед отправкой списка
  db.prepare('UPDATE users SET is_active = 0, socket_id = NULL WHERE is_active = 1 AND socket_id IS NULL').run();
  const users = db.prepare('SELECT id, name FROM users WHERE is_active = 1').all();
  res.json(users);
});

app.get('/game-state', (req, res) => {
  res.json(gameState);
});

io.on('connection', (socket) => {
  console.log('Täze birikme:', socket.id);
  
  // Замени обработчик restore-session на это:
socket.on('restore-session', (userId) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  
  if (user) {
    // Восстанавливаем сессию независимо от is_active
    db.prepare('UPDATE users SET socket_id = ?, is_active = 1 WHERE id = ?').run(socket.id, userId);
    socket.userId = userId;
    socket.userName = user.name;
    
    socket.emit('game-state', gameState);
    socket.emit('session-restored', { userId: userId, name: user.name });
    
    // Уведомляем всех об обновлении списка
    io.emit('players-updated');
    
    console.log(`Сессия восстановлена для: ${user.name}`);
  } else {
    socket.emit('session-invalid');
  }
});
  
  socket.on('register', (userId) => {
    db.prepare('UPDATE users SET socket_id = ?, is_active = 1 WHERE id = ?').run(socket.id, userId);
    socket.userId = userId;
    
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    socket.userName = user.name;
    
    io.emit('player-joined', { userId: userId, name: user.name });
    io.emit('players-updated');
  });
  
  socket.on('spin-bottle', () => {
    if (gameState.isSpinning) return;
    if (gameState.currentSpinner !== null && gameState.currentSpinner !== socket.userId) return;
    
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
  
  socket.on('chat-message', (data) => {
    io.emit('chat-message', {
      author: socket.userName,
      text: data.text,
      timestamp: Date.now()
    });
  });
  
  socket.on('disconnect', () => {
    console.log('Aýryldy:', socket.id);
    if (socket.userId) {
      const userName = socket.userName;
      const userId = socket.userId;
      
      db.prepare('UPDATE users SET is_active = 0, socket_id = NULL WHERE id = ?').run(userId);
      
      // Если этот игрок был тем, кто должен крутить, сбрасываем
      if (gameState.currentSpinner === userId) {
        gameState.currentSpinner = null;
      }
      
      io.emit('player-left', { userId: userId, name: userName });
      io.emit('players-updated');
      io.emit('game-state', gameState);
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Serwer ${PORT} portda işleýär`);
});