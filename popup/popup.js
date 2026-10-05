// Popup Script
import { checkAuth, searchGames, getAuthToken, getTwitchHeaders } from '../utils/twitch-api.js';

// DOM Elements
const authSection = document.getElementById('authSection');
const authStatus = document.getElementById('authStatus');
const mainContent = document.getElementById('mainContent');
const monitoringToggle = document.getElementById('monitoringToggle');
const intervalSlider = document.getElementById('intervalSlider');
const intervalValue = document.getElementById('intervalValue');
const gameSearch = document.getElementById('gameSearch');
const searchResults = document.getElementById('searchResults');
const selectedGamesContainer = document.getElementById('selectedGames');
const gamesCount = document.getElementById('gamesCount');
const checkNowBtn = document.getElementById('checkNowBtn');
const historyBtn = document.getElementById('historyBtn');
const historyModal = document.getElementById('historyModal');
const closeHistoryBtn = document.getElementById('closeHistoryBtn');
const historyList = document.getElementById('historyList');
const statusText = document.getElementById('statusText');
const settingsBtn = document.getElementById('settingsBtn');
const headersStatus = document.getElementById('headersStatus');

// Farming elements
const farmGameSelect = document.getElementById('farmGameSelect');
const startFarmBtn = document.getElementById('startFarmBtn');
const stopFarmBtn = document.getElementById('stopFarmBtn');
const farmingInactive = document.getElementById('farmingInactive');
const farmingActive = document.getElementById('farmingActive');
const farmingGameName = document.getElementById('farmingGameName');
const farmingStreamerLink = document.getElementById('farmingStreamerLink');
const farmingTime = document.getElementById('farmingTime');
const farmingWatchCount = document.getElementById('farmingWatchCount');
const farmingWatchStatus = document.getElementById('farmingWatchStatus');
const farmingClaimed = document.getElementById('farmingClaimed');
const farmingProgress = document.getElementById('farmingProgress');
const farmModeSelect = document.getElementById('farmModeSelect');
const manualStreamersBox = document.getElementById('manualStreamersBox');
const manualStreamerInput = document.getElementById('manualStreamerInput');
const addStreamerBtn = document.getElementById('addStreamerBtn');
const manualStreamersList = document.getElementById('manualStreamersList');

let selectedGames = [];
let searchTimeout = null;
let farmingUpdateInterval = null;

// Ініціалізація
document.addEventListener('DOMContentLoaded', async () => {
  await checkAuthentication();
  await checkHeadersStatus();
  await loadSettings();
  setupEventListeners();
  await updateFarmingUI();
  
  // Оновлюємо UI фарму кожні 10 секунд
  farmingUpdateInterval = setInterval(updateFarmingUI, 10000);
  
  chrome.runtime.sendMessage({ action: 'clearBadge' });
});

// Перевірка статусу заголовків
async function checkHeadersStatus() {
  const { hasIntegrity, isExpired } = await getTwitchHeaders();
  
  if (headersStatus) {
    if (hasIntegrity && !isExpired) {
      headersStatus.className = 'headers-status ok';
      headersStatus.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        <span>Client-Integrity: активен</span>
      `;
    } else if (hasIntegrity && isExpired) {
      headersStatus.className = 'headers-status warning';
      headersStatus.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        <span>Client-Integrity: может истечь</span>
      `;
    } else {
      headersStatus.className = 'headers-status error';
      headersStatus.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        <span>Нет Client-Integrity</span>
        <a href="https://www.twitch.tv/drops/campaigns" target="_blank" class="refresh-link">Обновить</a>
      `;
    }
  }
}

// Перевірка авторизації
async function checkAuthentication() {
  const token = await getAuthToken();
  console.log('Token exists:', !!token);
  
  const result = await checkAuth();
  console.log('Auth result:', result);
  
  if (result.isAuthenticated) {
    authStatus.className = 'auth-status authenticated';
    authStatus.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
      <div class="user-info">
        <span>Авторизован: ${result.user?.displayName || result.user?.login || 'User'}</span>
      </div>
    `;
    mainContent.classList.remove('hidden');
  } else if (token) {
    authStatus.className = 'auth-status authenticated';
    authStatus.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
      <div class="user-info">
        <span>Twitch подключён</span>
      </div>
    `;
    mainContent.classList.remove('hidden');
  } else {
    authStatus.className = 'auth-status not-authenticated';
    authStatus.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span>Войдите на Twitch</span>
      <button class="login-btn" id="loginBtn">Войти</button>
    `;
    
    document.getElementById('loginBtn')?.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://www.twitch.tv/login' });
    });
  }
}

// Завантаження налаштувань
async function loadSettings() {
  const settings = await chrome.storage.local.get([
    'monitoringEnabled',
    'checkInterval',
    'selectedGames',
    'manualStreamers'
  ]);
  
  monitoringToggle.checked = settings.monitoringEnabled !== false;
  intervalSlider.value = settings.checkInterval || 15;
  intervalValue.textContent = `${intervalSlider.value} мин.`;
  
  selectedGames = settings.selectedGames || [];
  renderSelectedGames();
  renderManualStreamers(settings.manualStreamers || []);
  updateFarmModeUI();
  updateFarmGameSelect(); // Оновлюємо dropdown для автофарма після завантаження ігор
}

// Налаштування обробників подій
function setupEventListeners() {
  monitoringToggle.addEventListener('change', async () => {
    await chrome.storage.local.set({ monitoringEnabled: monitoringToggle.checked });
    updateStatus(monitoringToggle.checked ? 'Мониторинг включен' : 'Мониторинг выключен');
  });
  
  intervalSlider.addEventListener('input', () => {
    intervalValue.textContent = `${intervalSlider.value} мин.`;
  });
  
  intervalSlider.addEventListener('change', async () => {
    await chrome.storage.local.set({ checkInterval: parseInt(intervalSlider.value) });
    updateStatus(`Интервал: ${intervalSlider.value} мин.`);
  });
  
  gameSearch.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const query = gameSearch.value.trim();
    
    if (query.length < 2) {
      searchResults.classList.add('hidden');
      return;
    }
    
    searchTimeout = setTimeout(() => searchForGames(query), 300);
  });
  
  gameSearch.addEventListener('blur', () => {
    setTimeout(() => searchResults.classList.add('hidden'), 200);
  });
  
  checkNowBtn.addEventListener('click', async () => {
    checkNowBtn.disabled = true;
    updateStatus('Проверяем дропы...');
    
    try {
      const response = await chrome.runtime.sendMessage({ action: 'checkNow' });
      console.log('Check result:', response);
      
      if (response && response.needsHeaders) {
        updateStatus('⚠️ Откройте Twitch для захвата токена');
        await checkHeadersStatus();
      } else if (response && response.message) {
        updateStatus(response.message);
      } else {
        updateStatus('Проверка завершена');
      }
    } catch (error) {
      console.error('Check error:', error);
      updateStatus('Ошибка проверки: ' + error.message);
    }
    
    checkNowBtn.disabled = false;
  });
  
  historyBtn.addEventListener('click', showHistory);
  closeHistoryBtn.addEventListener('click', () => {
    historyModal.classList.add('hidden');
    // Останавливаем автообновление при закрытии
    if (window.historyUpdateInterval) {
      clearInterval(window.historyUpdateInterval);
      window.historyUpdateInterval = null;
    }
  });
  
  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  
  historyModal.addEventListener('click', (e) => {
    if (e.target === historyModal) {
      historyModal.classList.add('hidden');
      // Останавливаем автообновление при закрытии
      if (window.historyUpdateInterval) {
        clearInterval(window.historyUpdateInterval);
        window.historyUpdateInterval = null;
      }
    }
  });
}

// Пошук ігор
async function searchForGames(query) {
  const games = await searchGames(query);
  
  if (games.length === 0) {
    searchResults.innerHTML = '<div class="empty-message">Игры не найдены</div>';
  } else {
    searchResults.innerHTML = games.map(game => `
      <div class="search-result-item" data-game='${JSON.stringify(game).replace(/'/g, "&#39;")}'>
        <img src="${game.boxArtURL?.replace('{width}', '52').replace('{height}', '72') || ''}" 
             alt="${game.displayName}" onerror="this.style.display='none'">
        <span>${game.displayName}</span>
      </div>
    `).join('');
    
    searchResults.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        const game = JSON.parse(item.dataset.game.replace(/&#39;/g, "'"));
        addGame(game);
        gameSearch.value = '';
        searchResults.classList.add('hidden');
      });
    });
  }
  
  searchResults.classList.remove('hidden');
}

// Додавання гри
async function addGame(game) {
  if (selectedGames.some(g => g.id === game.id)) {
    updateStatus('Игра уже добавлена');
    return;
  }
  
  selectedGames.push(game);
  await chrome.storage.local.set({ selectedGames });
  renderSelectedGames();
  updateFarmGameSelect(); // Оновлюємо dropdown для автофарма
  updateStatus(`Добавлена: ${game.displayName}`);
}

// Видалення гри
async function removeGame(gameId) {
  selectedGames = selectedGames.filter(g => g.id !== gameId);
  await chrome.storage.local.set({ selectedGames });
  renderSelectedGames();
  updateFarmGameSelect(); // Оновлюємо dropdown для автофарма
  updateStatus('Игра удалена');
}

// Відображення вибраних ігор
function renderSelectedGames() {
  gamesCount.textContent = selectedGames.length;
  
  if (selectedGames.length === 0) {
    selectedGamesContainer.innerHTML = '<p class="empty-message">Нет выбранных игр</p>';
    return;
  }
  
  selectedGamesContainer.innerHTML = selectedGames.map(game => `
    <div class="game-tag">
      <img src="${game.boxArtURL?.replace('{width}', '40').replace('{height}', '52') || ''}" 
           alt="" onerror="this.style.display='none'">
      <span>${game.displayName}</span>
      <button class="remove-btn" data-id="${game.id}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `).join('');
  
  selectedGamesContainer.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeGame(btn.dataset.id));
  });
}

// Показ історії
async function showHistory() {
  await updateHistoryContent();
  historyModal.classList.remove('hidden');
  
  // Запускаем автообновление истории каждые 10 секунд
  if (window.historyUpdateInterval) {
    clearInterval(window.historyUpdateInterval);
  }
  window.historyUpdateInterval = setInterval(updateHistoryContent, 10000);
}

// Обновление содержимого истории
async function updateHistoryContent() {
  const { dropHistory } = await chrome.storage.local.get('dropHistory');
  const history = dropHistory || [];
  
  if (history.length === 0) {
    historyList.innerHTML = '<p class="empty-message">История пуста</p>';
  } else {
    const formatDate = (d) => new Date(d).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    
    const getStatusClass = (status) => {
      switch (status) {
        case 'ACTIVE': return 'active';
        case 'UPCOMING': return 'upcoming';
        default: return 'expired';
      }
    };
    
    const getStatusText = (status) => {
      switch (status) {
        case 'ACTIVE': return 'Активен';
        case 'UPCOMING': return 'Скоро';
        default: return 'Завершён';
      }
    };
    
    const getFarmingStatusBadge = (farmingStatus) => {
      switch (farmingStatus) {
        case 'farming':
          return '<span class="farming-status-badge farming">Активен</span>';
        case 'queued':
          return '<span class="farming-status-badge queued">Ожидает очереди</span>';
        case 'completed':
          return '<span class="farming-status-badge completed">Дроп получен</span>';
        default:
          return '';
      }
    };
    
    historyList.innerHTML = history.map(item => `
      <div class="history-item">
        <img src="${item.boxArtURL?.replace('{width}', '80').replace('{height}', '106') || ''}" 
             alt="" onerror="this.style.display='none'">
        <div class="history-item-info">
          <div class="history-item-title">
            ${item.gameName}
            <span class="status-badge ${getStatusClass(item.status)}">${getStatusText(item.status)}</span>
          </div>
          <div class="history-item-campaign">${item.campaignName}</div>
          ${item.startAt ? `<div class="history-item-dates">📅 ${formatDate(item.startAt)} - ${item.endAt ? formatDate(item.endAt) : '?'}</div>` : ''}
          <div class="history-item-date">Найдено: ${formatDate(item.foundAt)}</div>
          ${getFarmingStatusBadge(item.farmingStatus)}
        </div>
      </div>
    `).join('');
  }
}

// Оновлення статусу
function updateStatus(text) {
  statusText.textContent = text;
}

// ============================================
// АВТОФАРМ
// ============================================

// Оновлення UI фарму
async function updateFarmingUI() {
  const status = await chrome.runtime.sendMessage({ action: 'getFarmingStatus' });
  
  // Оновлюємо список ігор в селекті
  updateFarmGameSelect();
  
  if (status && status.active) {
    farmingInactive.classList.add('hidden');
    farmingActive.classList.remove('hidden');
    
    farmingGameName.textContent = status.gameName || '-';
    
    if (status.currentStreamer) {
      farmingStreamerLink.textContent = status.currentStreamer.displayName;
      farmingStreamerLink.href = `https://www.twitch.tv/${status.currentStreamer.login}`;
    } else {
      farmingStreamerLink.textContent = 'Поиск...';
      farmingStreamerLink.href = '#';
    }
    
    farmingTime.textContent = `${status.totalWatchTime || 0} мин.`;
    farmingWatchCount.textContent = status.watchCount || 0;
    
    if (farmingWatchStatus) {
      if (status.lastWatchSuccess) {
        farmingWatchStatus.textContent = '✓';
        farmingWatchStatus.className = 'watch-status success';
      } else if (status.watchCount > 0) {
        farmingWatchStatus.textContent = '✗';
        farmingWatchStatus.className = 'watch-status error';
      } else {
        farmingWatchStatus.textContent = '';
      }
    }
    
    farmingClaimed.textContent = `${status.claimedDrops || 0} дропов, ${status.claimedPoints || 0} поинтов`;
    
    // Прогрес дропів
    if (status.dropsProgress && status.dropsProgress.length > 0) {
      farmingProgress.innerHTML = status.dropsProgress.map(drop => `
        <div class="progress-item ${drop.isClaimed ? 'claimed' : ''}">
          <div class="progress-item-header">
            <span class="progress-item-name">${drop.name}</span>
            <span class="progress-item-percent">${drop.isClaimed ? '✓' : `${drop.progress}%`}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-bar-fill" style="width: ${drop.isClaimed ? 100 : drop.progress}%"></div>
          </div>
        </div>
      `).join('');
    } else {
      farmingProgress.innerHTML = '<p class="empty-message">Ожидание данных...</p>';
    }
  } else {
    farmingInactive.classList.remove('hidden');
    farmingActive.classList.add('hidden');
  }
}

// Оновлення списку ігор в селекті
function updateFarmGameSelect() {
  const currentValue = farmGameSelect.value;
  
  farmGameSelect.innerHTML = '<option value="">-- Выберите игру --</option>';
  
  selectedGames.forEach(game => {
    const option = document.createElement('option');
    option.value = JSON.stringify(game);
    option.textContent = game.displayName;
    farmGameSelect.appendChild(option);
  });
  
  // Відновлюємо вибір
  if (currentValue) {
    farmGameSelect.value = currentValue;
  }
  
  startFarmBtn.disabled = !farmGameSelect.value;
}

// Ручной список стримеров
function normalizeStreamerLogin(value) {
  return value.trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/^@/, '').split(/[/?#\s]/)[0].toLowerCase();
}

async function getManualStreamers() {
  const { manualStreamers } = await chrome.storage.local.get('manualStreamers');
  return Array.isArray(manualStreamers) ? manualStreamers : [];
}

function updateFarmModeUI() {
  const manual = farmModeSelect?.value === 'manual';
  manualStreamersBox?.classList.toggle('hidden', !manual);
  if (manual) renderManualStreamers();
}

async function renderManualStreamers(list = null) {
  if (!manualStreamersList) return;
  const streamers = list || await getManualStreamers();
  if (!streamers.length) {
    manualStreamersList.innerHTML = '<div class="empty-message">Список пуст</div>';
    return;
  }
  manualStreamersList.innerHTML = streamers.map((login, index) => `
    <div class="manual-streamer-item">
      <span>${login}</span>
      <button type="button" class="remove-streamer-btn" data-index="${index}" title="Удалить">×</button>
    </div>
  `).join('');
  manualStreamersList.querySelectorAll('.remove-streamer-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const current = await getManualStreamers();
      current.splice(Number(btn.dataset.index), 1);
      await chrome.storage.local.set({ manualStreamers: current });
      renderManualStreamers(current);
    });
  });
}

async function addManualStreamer() {
  const login = normalizeStreamerLogin(manualStreamerInput?.value || '');
  if (!login) return;
  const current = await getManualStreamers();
  if (current.includes(login)) {
    updateStatus('Этот стример уже добавлен');
    return;
  }
  current.push(login);
  await chrome.storage.local.set({ manualStreamers: current });
  manualStreamerInput.value = '';
  renderManualStreamers(current);
  updateStatus(`Добавлен стример: ${login}`);
}

// Запуск фарму
async function startFarming() {
  const gameData = farmGameSelect.value;
  if (!gameData) return;
  
  const game = JSON.parse(gameData);
  startFarmBtn.disabled = true;
  updateStatus(`Запуск фарма: ${game.displayName}...`);
  
  try {
    const manualStreamers = await getManualStreamers();
    const manualMode = farmModeSelect?.value === 'manual';
    if (manualMode && manualStreamers.length === 0) {
      updateStatus('Добавьте хотя бы одного стримера');
      startFarmBtn.disabled = false;
      return;
    }
    const result = await chrome.runtime.sendMessage({ 
      action: 'startFarming',
      game,
      manualMode,
      manualStreamers
    });
    
    if (result.success) {
      updateStatus(result.message);
      await updateFarmingUI();
    } else {
      updateStatus('Ошибка: ' + (result.message || 'Неизвестная ошибка'));
      startFarmBtn.disabled = false;
    }
  } catch (error) {
    updateStatus('Ошибка: ' + error.message);
    startFarmBtn.disabled = false;
  }
}

// Зупинка фарму
async function stopFarming() {
  stopFarmBtn.disabled = true;
  updateStatus('Остановка фарма...');
  
  try {
    const result = await chrome.runtime.sendMessage({ action: 'stopFarming' });
    
    if (result.success) {
      updateStatus(`Фарм остановлен. Время: ${result.totalWatchTime} мин., дропов: ${result.claimedDrops}, поинтов: ${result.claimedPoints || 0}`);
    } else {
      updateStatus('Ошибка остановки');
    }
    
    await updateFarmingUI();
  } catch (error) {
    updateStatus('Ошибка: ' + error.message);
  }
  
  stopFarmBtn.disabled = false;
}

// Додаємо обробники для фарму
farmModeSelect?.addEventListener('change', updateFarmModeUI);
addStreamerBtn?.addEventListener('click', addManualStreamer);
manualStreamerInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addManualStreamer(); });

farmGameSelect?.addEventListener('change', () => {
  startFarmBtn.disabled = !farmGameSelect.value;
});

startFarmBtn?.addEventListener('click', startFarming);
stopFarmBtn?.addEventListener('click', stopFarming);

