const socket = io();
let currentUser = null;
let players = [];
let gameState = { currentSpinner: null, isSpinning: false };
let sessionRestored = false;
let reconnectCountdown = null;
let countdownMessageEl = null;

// ===== ИНИЦИАЛИЗАЦИЯ =====
window.addEventListener('DOMContentLoaded', async () => {
  const savedUserId = localStorage.getItem('userId');
  const savedName = localStorage.getItem('userName');

  console.log('Проверка сессии:', { savedUserId, savedName });

  if (savedUserId && savedName) {
    currentUser = { id: parseInt(savedUserId), name: savedName };
    // Отправляем restore-session сразу
    socket.emit('restore-session', currentUser.id);
  } else {
    document.getElementById('register-screen').style.display = 'flex';
  }
});

// ===== ОБРАБОТЧИК ПЕРЕСОЕДИНЕНИЯ =====
// Срабатывает при каждом подключении (включая переподключение)
socket.on('connect', () => {
  console.log('Подключено:', socket.id);
  
  // Если есть сохранённая сессия, восстанавливаем её
  if (currentUser) {
    socket.emit('restore-session', currentUser.id);
  }
});

socket.on('disconnect', () => {
  console.log('Отключено');
});

// ===== РЕГИСТРАЦИЯ =====
async function register() {
  const nameInput = document.getElementById('name-input');
  const name = nameInput.value.trim();

  if (!name) {
    showToast('Adyňyzy giriziň!');
    return;
  }

  if (name.length < 2) {
    showToast('Isim gysga!');
    return;
  }

  if (name.length > 20) {
    showToast('Isim uzyn!');
    return;
  }

  try {
    const response = await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });

    const data = await response.json();

    if (data.error) {
      showToast(data.error);
      return;
    }

    currentUser = { id: data.userId, name: data.name };

    localStorage.setItem('userId', currentUser.id.toString());
    localStorage.setItem('userName', currentUser.name);

    socket.emit('register', currentUser.id);
    enterGame();
  } catch (err) {
    console.error('Ошибка регистрации:', err);
    showToast('Ýalňyşlyk ýüze çykdy');
  }
}

// ===== ВХОД В ИГРУ =====
async function enterGame() {
  document.getElementById('register-screen').style.display = 'none';
  document.getElementById('game-screen').style.display = 'flex';

  await loadPlayers();
  await loadGameState();
  updateUI();
}

async function loadPlayers() {
  const response = await fetch('/players');
  players = await response.json();
  renderPlayers();
}

async function loadGameState() {
  const response = await fetch('/game-state');
  gameState = await response.json();
}

// ===== УТИЛИТЫ =====
function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `linear-gradient(135deg, hsl(${hue}, 70%, 55%) 0%, hsl(${(hue + 40) % 360}, 70%, 45%) 100%)`;
}

function showToast(text) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function renderPlayers() {
  const playersList = document.getElementById('players-list');
  playersList.innerHTML = '';

  players.forEach(player => {
    const avatar = document.createElement('div');
    avatar.className = 'player-avatar';
    if (player.id === gameState.currentSpinner) {
      avatar.classList.add('active');
    }
    avatar.style.background = hashColor(player.name);
    avatar.innerHTML = `
      ${player.name[0].toUpperCase()}
      <span class="status-dot"></span>
      <span class="player-name">${player.name}</span>
    `;
    playersList.appendChild(avatar);
  });

  document.getElementById('player-count').textContent = `${players.length} adam`;
}

// ===== ВРАЩЕНИЕ БУТЫЛОЧКИ =====
function spinBottle() {
  if (gameState.isSpinning) return;

  if (gameState.currentSpinner !== null && gameState.currentSpinner !== currentUser.id) {
    showToast('Häzir siziň nobatyňyz däl!');
    return;
  }

  socket.emit('spin-bottle');
}

function updateUI() {
  renderPlayers();
  const spinButton = document.getElementById('spin-button');
  const canSpin = gameState.currentSpinner === null || gameState.currentSpinner === currentUser.id;
  spinButton.disabled = !canSpin || gameState.isSpinning;
}

// ===== ЧАТ =====
function sendMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();

  if (!message) return;

  socket.emit('chat-message', { text: message });
  input.value = '';
}

function handleKeyPress(event) {
  if (event.key === 'Enter') {
    sendMessage();
  }
}

function addSystemMessage(text) {
  const messagesDiv = document.getElementById('chat-messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message system';
  messageDiv.innerHTML = `<span class="text">${text}</span>`;
  messagesDiv.appendChild(messageDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  return messageDiv;
}

// ===== SOCKET ОБРАБОТЧИКИ =====

// Сессия восстановлена
socket.on('session-restored', (data) => {
  console.log('Сессия восстановлена:', data);
  sessionRestored = true;
  enterGame();
});

// Сессия невалидна
socket.on('session-invalid', () => {
  console.log('Сессия невалидна');
  localStorage.removeItem('userId');
  localStorage.removeItem('userName');
  currentUser = null;
  document.getElementById('register-screen').style.display = 'flex';
  document.getElementById('game-screen').style.display = 'none';
});

// Сообщения чата
socket.on('chat-message', (data) => {
  const messagesDiv = document.getElementById('chat-messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message';
  if (data.author === currentUser?.name) {
    messageDiv.classList.add('own');
  }
  messageDiv.innerHTML = `
    <div class="author">${data.author}</div>
    <div class="text">${data.text}</div>
  `;
  messagesDiv.appendChild(messageDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
});

// Игрок зашёл
socket.on('player-joined', (data) => {
  addSystemMessage(`${data.name} oýna girdi`);
});

// Игрок вышел
socket.on('player-left', (data) => {
  addSystemMessage(`${data.name} oýundan çykdy`);
});

// Обновление списка игроков
socket.on('players-updated', async () => {
  await loadPlayers();
  updateUI();
});

// Состояние игры
socket.on('game-state', (state) => {
  gameState = state;
  updateUI();
});

// Вращение бутылочки
socket.on('bottle-spinning', (data) => {
  const bottle = document.getElementById('bottle');
  const result = document.getElementById('result');

  result.textContent = '';
  gameState.isSpinning = true;
  updateUI();

  bottle.classList.add('spinning');
  const randomRotation = 1440 + Math.random() * 720;
  bottle.style.transform = `rotate(${randomRotation}deg)`;

  setTimeout(() => bottle.classList.remove('spinning'), 3500);
});

// Результат вращения
socket.on('spin-result', (data) => {
  const result = document.getElementById('result');
  result.innerHTML = `<span class="highlight">${data.targetName}</span> jogap bermeli!`;

  gameState.currentSpinner = data.nextSpinner;
  gameState.isSpinning = false;
  updateUI();
});

// Ожидание переподключения
socket.on('waiting-for-reconnect', (data) => {
  addSystemMessage(`${data.userName} aýryldy. 30 sekunt garaşýarys...`);

  const messagesDiv = document.getElementById('chat-messages');
  countdownMessageEl = document.createElement('div');
  countdownMessageEl.className = 'message system';
  messagesDiv.appendChild(countdownMessageEl);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;

  let seconds = data.timeout;
  reconnectCountdown = setInterval(() => {
    seconds--;
    if (seconds > 0 && countdownMessageEl) {
      countdownMessageEl.innerHTML = `<span class="text">${seconds} sekunt galdy...</span>`;
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    } else {
      clearInterval(reconnectCountdown);
      reconnectCountdown = null;
      countdownMessageEl = null;
    }
  }, 1000);
});

// Игрок переподключился
socket.on('player-reconnected', (data) => {
  if (reconnectCountdown) {
    clearInterval(reconnectCountdown);
    reconnectCountdown = null;
  }
  if (countdownMessageEl) {
    countdownMessageEl.remove();
    countdownMessageEl = null;
  }

  addSystemMessage(`${data.name} gaýtadan birikdi`);

  if (data.userId === currentUser?.id) {
    addSystemMessage('Nobatyňyz gaýtaryldy!');
  }

  updateUI();
});

// Таймаут переподключения
socket.on('reconnect-timeout', (data) => {
  if (reconnectCountdown) {
    clearInterval(reconnectCountdown);
    reconnectCountdown = null;
  }
  if (countdownMessageEl) {
    countdownMessageEl.remove();
    countdownMessageEl = null;
  }

  addSystemMessage(`${data.oldSpinner} gaýtadan birikmedi — nobat ${data.newSpinnerName}-a geçdi`);

  if (data.newSpinnerId === currentUser?.id) {
    addSystemMessage('Indi siziň nobatyňyz!');
  }

  updateUI();
});

// Ошибка вращения
socket.on('spin-error', (error) => {
  showToast(error);
  gameState.isSpinning = false;
  updateUI();
});

// Сессия захвачена другим устройством
socket.on('session-taken', () => {
  showToast('Bu hasap başga ýerden girildi');
  localStorage.removeItem('userId');
  localStorage.removeItem('userName');
  setTimeout(() => location.reload(), 1500);
});
