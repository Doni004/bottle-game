const socket = io();
let currentUser = null;
let players = [];
let gameState = { currentSpinner: null, isSpinning: false };
let sessionRestored = false;
let reconnectCountdown = null;
let oldestMessageId = 0;
let hasMoreMessages = true;
const processedMessages = new Set();

// XSS-защита
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Инициализация
window.addEventListener('DOMContentLoaded', () => {
  const savedUserId = localStorage.getItem('userId');
  const savedName = localStorage.getItem('userName');

  if (savedUserId && savedName) {
    currentUser = { id: parseInt(savedUserId), name: savedName };
    socket.emit('restore-session', currentUser.id);

    socket.once('session-restored', (data) => {
      sessionRestored = true;
      currentUser = { id: data.userId, name: data.name };
      enterGame();
    });

    socket.once('session-invalid', () => {
      localStorage.removeItem('userId');
      localStorage.removeItem('userName');
      currentUser = null;
      document.getElementById('register-screen').style.display = 'flex';
    });

    setTimeout(() => {
      if (!sessionRestored) {
        document.getElementById('register-screen').style.display = 'flex';
      }
    }, 3000);
  } else {
    document.getElementById('register-screen').style.display = 'flex';
  }
});

socket.on('connect', () => {
  if (currentUser) {
    socket.emit('restore-session', currentUser.id);
  }
});

socket.on('disconnect', () => {
  console.log('Отключено от сервера');
});

// Регистрация
async function register() {
  const nameInput = document.getElementById('name-input');
  const name = nameInput.value.trim();

  if (!name) { showToast('Adyňyzy giriziň!'); return; }
  if (name.length < 2) { showToast('Isim gysga!'); return; }
  if (name.length > 20) { showToast('Isim uzyn!'); return; }

  try {
    const response = await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });

    const data = await response.json();

    if (data.error) { showToast(data.error); return; }

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

// Вход в игру
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

// Загрузка истории сообщений
async function loadMessages(limit, before = 0) {
  const url = before > 0
    ? `/messages?limit=${limit}&before=${before}`
    : `/messages?limit=${limit}`;

  const response = await fetch(url);
  const messages = await response.json();

  const messagesDiv = document.getElementById('chat-messages');
  const loadMoreBtn = document.getElementById('load-more-btn');

  if (messages.length === 0) {
    hasMoreMessages = false;
    loadMoreBtn.style.display = 'none';
    return;
  }

  oldestMessageId = messages[0].id;

  if (messages.length < limit) {
    hasMoreMessages = false;
    loadMoreBtn.style.display = 'none';
  } else {
    hasMoreMessages = true;
    loadMoreBtn.style.display = 'block';
  }

  messages.forEach(msg => {
    if (processedMessages.has(msg.id)) return;
    processedMessages.add(msg.id);

    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';
    messageDiv.dataset.id = msg.id;

    if (msg.is_system === 1) {
      messageDiv.classList.add('system');
      messageDiv.innerHTML = `<span class="text">${escapeHtml(msg.text)}</span>`;
    } else {
      if (msg.author === currentUser?.name) {
        messageDiv.classList.add('own');
      }
      messageDiv.innerHTML = `
        <div class="author">${escapeHtml(msg.author)}</div>
        <div class="text">${escapeHtml(msg.text)}</div>
      `;
    }

    messagesDiv.appendChild(messageDiv);
  });

  if (before === 0) {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }
}

async function loadMoreMessages() {
  if (!hasMoreMessages) return;

  const loadMoreBtn = document.getElementById('load-more-btn');
  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = 'Ýüklenýär...';

  const messagesDiv = document.getElementById('chat-messages');
  const oldScrollHeight = messagesDiv.scrollHeight;

  await loadMessages(10, oldestMessageId);

  messagesDiv.scrollTop = messagesDiv.scrollHeight - oldScrollHeight;

  loadMoreBtn.disabled = false;
  loadMoreBtn.textContent = 'Köne habarlary ýükle';
}

// Утилиты
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
      ${escapeHtml(player.name[0].toUpperCase())}
      <span class="status-dot"></span>
      <span class="player-name">${escapeHtml(player.name)}</span>
    `;
    playersList.appendChild(avatar);
  });

  document.getElementById('player-count').textContent = `${players.length} adam`;
}

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

function sendMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;
  socket.emit('chat-message', { text: message });
  input.value = '';
}

function handleKeyPress(event) {
  if (event.key === 'Enter') sendMessage();
}

function addSystemMessage(text) {
  const messagesDiv = document.getElementById('chat-messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message system';
  messageDiv.innerHTML = `<span class="text">${escapeHtml(text)}</span>`;
  messagesDiv.appendChild(messageDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  return messageDiv;
}

// Socket обработчики
socket.on('session-restored', (data) => {
  sessionRestored = true;
  currentUser = { id: data.userId, name: data.name };
  enterGame();
});

socket.on('session-invalid', () => {
  localStorage.removeItem('userId');
  localStorage.removeItem('userName');
  currentUser = null;
  document.getElementById('register-screen').style.display = 'flex';
  document.getElementById('game-screen').style.display = 'none';
});

socket.on('chat-message', (data) => {
  if (data.id && processedMessages.has(data.id)) return;
  if (data.id) processedMessages.add(data.id);

  const messagesDiv = document.getElementById('chat-messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message';
  if (data.id) messageDiv.dataset.id = data.id;

  if (data.isSystem) {
    messageDiv.classList.add('system');
    messageDiv.innerHTML = `<span class="text">${escapeHtml(data.text)}</span>`;
  } else {
    if (data.author === currentUser?.name) messageDiv.classList.add('own');
    messageDiv.innerHTML = `
      <div class="author">${escapeHtml(data.author)}</div>
      <div class="text">${escapeHtml(data.text)}</div>
    `;
  }

  messagesDiv.appendChild(messageDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
});

socket.on('player-joined', (data) => {
  addSystemMessage(`${data.name} oýna girdi`);
});

socket.on('player-left', (data) => {
  addSystemMessage(`${data.name} oýundan çykdy`);
});

socket.on('players-updated', async () => {
  await loadPlayers();
  updateUI();
});

socket.on('game-state', (state) => {
  gameState = state;
  updateUI();
});

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

socket.on('spin-result', (data) => {
  const result = document.getElementById('result');
  result.innerHTML = `<span class="highlight">${escapeHtml(data.targetName)}</span> jogap bermeli!`;
  gameState.currentSpinner = data.nextSpinner;
  gameState.isSpinning = false;
  updateUI();
});

socket.on('waiting-for-reconnect', (data) => {
  addSystemMessage(`${data.userName} aýryldy. 45 sekunt garaşýarys...`);

  const messagesDiv = document.getElementById('chat-messages');
  const countdownEl = document.createElement('div');
  countdownEl.className = 'message system';
  countdownEl.id = 'countdown-message';
  messagesDiv.appendChild(countdownEl);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;

  let seconds = data.timeout;
  reconnectCountdown = setInterval(() => {
    seconds--;
    const el = document.getElementById('countdown-message');
    if (seconds > 0 && el) {
      el.innerHTML = `<span class="text">${seconds} sekunt galdy...</span>`;
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    } else {
      clearInterval(reconnectCountdown);
      reconnectCountdown = null;
      if (el) el.remove();
    }
  }, 1000);
});

socket.on('player-reconnected', (data) => {
  if (reconnectCountdown) {
    clearInterval(reconnectCountdown);
    reconnectCountdown = null;
  }
  const el = document.getElementById('countdown-message');
  if (el) el.remove();

  addSystemMessage(`${data.name} gaýtadan birikdi`);

  if (data.userId === currentUser?.id) {
    addSystemMessage('Nobatyňyz gaýtaryldy!');
  }

  updateUI();
});

socket.on('reconnect-timeout', (data) => {
  if (reconnectCountdown) {
    clearInterval(reconnectCountdown);
    reconnectCountdown = null;
  }
  const el = document.getElementById('countdown-message');
  if (el) el.remove();

  addSystemMessage(`${data.oldSpinner} gaýtadan birikmedi — nobat ${data.newSpinnerName}-a geçdi`);

  if (data.newSpinnerId === currentUser?.id) {
    addSystemMessage('Indi siziň nobatyňyz!');
  }

  updateUI();
});

socket.on('spin-error', (error) => {
  showToast(error);
  gameState.isSpinning = false;
  updateUI();
});

socket.on('session-taken', () => {
  showToast('Bu hasap başga ýerden girildi');
  localStorage.removeItem('userId');
  localStorage.removeItem('userName');
  setTimeout(() => location.reload(), 1500);
});