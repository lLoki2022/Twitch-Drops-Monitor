// Options Page Script

// DOM Elements
const botTokenInput = document.getElementById('botToken');
const chatIdInput = document.getElementById('chatId');
const testTelegramBtn = document.getElementById('testTelegramBtn');
const telegramStatus = document.getElementById('telegramStatus');
const soundEnabledToggle = document.getElementById('soundEnabled');
const browserNotificationsToggle = document.getElementById('browserNotifications');
const autoRefreshTokenToggle = document.getElementById('autoRefreshToken');
const refreshNowBtn = document.getElementById('refreshNowBtn');
const refreshStatus = document.getElementById('refreshStatus');
const tokenInfo = document.getElementById('tokenInfo');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const resetSettingsBtn = document.getElementById('resetSettingsBtn');
const infoGamesCount = document.getElementById('infoGamesCount');
const infoInterval = document.getElementById('infoInterval');
const infoHistoryCount = document.getElementById('infoHistoryCount');
const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toastMessage');

// Farming settings elements
const autoClaimDropsToggle = document.getElementById('autoClaimDrops');
const autoClaimPointsToggle = document.getElementById('autoClaimPoints');
const autoStartFarmingToggle = document.getElementById('autoStartFarming');

// Ініціалізація
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await updateTokenInfo();
  setupEventListeners();
  updateInfo();
});

// Завантаження налаштувань
async function loadSettings() {
  const settings = await chrome.storage.local.get([
    'telegramBotToken',
    'telegramChatId',
    'soundEnabled',
    'browserNotifications',
    'autoRefreshToken',
    'farmingConfig'
  ]);
  
  botTokenInput.value = settings.telegramBotToken || '';
  chatIdInput.value = settings.telegramChatId || '';
  soundEnabledToggle.checked = settings.soundEnabled || false;
  browserNotificationsToggle.checked = settings.browserNotifications !== false;
  autoRefreshTokenToggle.checked = settings.autoRefreshToken !== false;
  
  // Farming settings (default: true for claims, false for auto-start)
  const farmingConfig = settings.farmingConfig || {};
  if (autoClaimDropsToggle) {
    autoClaimDropsToggle.checked = farmingConfig.AUTO_CLAIM_DROPS !== false;
  }
  if (autoClaimPointsToggle) {
    autoClaimPointsToggle.checked = farmingConfig.AUTO_CLAIM_POINTS !== false;
  }
  if (autoStartFarmingToggle) {
    autoStartFarmingToggle.checked = farmingConfig.AUTO_START_FARMING === true;
  }
}

// Оновлення інформації про токен
async function updateTokenInfo() {
  const data = await chrome.storage.local.get(['twitchHeaders', 'twitchHeadersTimestamp']);
  const hasIntegrity = !!data.twitchHeaders?.['client-integrity'];
  const timestamp = data.twitchHeadersTimestamp;
  
  if (hasIntegrity && timestamp) {
    const age = Date.now() - timestamp;
    const ageHours = Math.floor(age / 1000 / 60 / 60);
    const ageMinutes = Math.floor((age / 1000 / 60) % 60);
    const isExpired = age > 54000000; // 15 годин
    
    const date = new Date(timestamp).toLocaleString('ru-RU');
    
    tokenInfo.innerHTML = `
      <div class="token-status ${isExpired ? 'expired' : 'valid'}">
        <span class="token-indicator"></span>
        <div>
          <strong>Client-Integrity: ${isExpired ? 'Может быть устаревшим' : 'Активен'}</strong>
          <small>Получен: ${date} (${ageHours}ч ${ageMinutes}м назад)</small>
        </div>
      </div>
    `;
  } else {
    tokenInfo.innerHTML = `
      <div class="token-status missing">
        <span class="token-indicator"></span>
        <div>
          <strong>Client-Integrity: Отсутствует</strong>
          <small>Нажмите "Обновить токен сейчас" или откройте Twitch</small>
        </div>
      </div>
    `;
  }
}

// Налаштування обробників
function setupEventListeners() {
  botTokenInput.addEventListener('change', saveTelegramSettings);
  chatIdInput.addEventListener('change', saveTelegramSettings);
  
  testTelegramBtn.addEventListener('click', testTelegram);
  
  autoRefreshTokenToggle.addEventListener('change', async () => {
    await chrome.storage.local.set({ autoRefreshToken: autoRefreshTokenToggle.checked });
    showToast(autoRefreshTokenToggle.checked ? 'Автообновление включено' : 'Автообновление выключено');
  });
  
  refreshNowBtn.addEventListener('click', async () => {
    refreshNowBtn.disabled = true;
    refreshStatus.textContent = 'Открываем Twitch...';
    refreshStatus.className = 'status-text';
    
    try {
      const result = await chrome.runtime.sendMessage({ action: 'refreshToken' });
      
      if (result.success) {
        if (result.reason === 'still_valid') {
          refreshStatus.textContent = 'Токен ещё действителен';
          refreshStatus.className = 'status-text success';
        } else {
          refreshStatus.textContent = 'Обновление запущено...';
          refreshStatus.className = 'status-text';
          
          setTimeout(async () => {
            await updateTokenInfo();
            refreshStatus.textContent = 'Токен обновлён!';
            refreshStatus.className = 'status-text success';
          }, 5000);
        }
      } else {
        refreshStatus.textContent = result.reason || 'Ошибка';
        refreshStatus.className = 'status-text error';
      }
    } catch (error) {
      refreshStatus.textContent = 'Ошибка: ' + error.message;
      refreshStatus.className = 'status-text error';
    }
    
    refreshNowBtn.disabled = false;
  });
  
  soundEnabledToggle.addEventListener('change', async () => {
    await chrome.storage.local.set({ soundEnabled: soundEnabledToggle.checked });
    showToast('Настройки сохранены');
  });
  
  browserNotificationsToggle.addEventListener('change', async () => {
    await chrome.storage.local.set({ browserNotifications: browserNotificationsToggle.checked });
    showToast('Настройки сохранены');
  });
  
  // Farming settings handlers
  if (autoClaimDropsToggle) {
    autoClaimDropsToggle.addEventListener('change', saveFarmingSettings);
  }
  if (autoClaimPointsToggle) {
    autoClaimPointsToggle.addEventListener('change', saveFarmingSettings);
  }
  if (autoStartFarmingToggle) {
    autoStartFarmingToggle.addEventListener('change', saveFarmingSettings);
  }
  
  clearHistoryBtn.addEventListener('click', async () => {
    if (confirm('Вы уверены, что хотите очистить историю?')) {
      await chrome.storage.local.set({ dropHistory: [], notifiedDrops: [] });
      showToast('История очищена');
      updateInfo();
    }
  });
  
  resetSettingsBtn.addEventListener('click', async () => {
    if (confirm('Вы уверены, что хотите сбросить все настройки?')) {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        checkInterval: 15,
        monitoringEnabled: true,
        selectedGames: [],
        notifiedDrops: [],
        dropHistory: [],
        autoRefreshToken: true
      });
      await loadSettings();
      await updateTokenInfo();
      showToast('Настройки сброшены');
      updateInfo();
    }
  });
}

// Збереження Telegram налаштувань
async function saveTelegramSettings() {
  await chrome.storage.local.set({
    telegramBotToken: botTokenInput.value.trim(),
    telegramChatId: chatIdInput.value.trim()
  });
  showToast('Telegram настройки сохранены');
}

// Збереження налаштувань фарму
async function saveFarmingSettings() {
  const config = {
    AUTO_CLAIM_DROPS: autoClaimDropsToggle?.checked !== false,
    AUTO_CLAIM_POINTS: autoClaimPointsToggle?.checked !== false,
    AUTO_START_FARMING: autoStartFarmingToggle?.checked === true
  };
  
  // Зберігаємо в storage
  await chrome.storage.local.set({ farmingConfig: config });
  
  // Відправляємо в service worker для оновлення активного фарму
  try {
    await chrome.runtime.sendMessage({ action: 'setFarmingConfig', config });
  } catch (e) {
    // Service worker може бути неактивним
  }
  
  showToast('Настройки фарма сохранены');
}

// Тест Telegram повідомлення
async function testTelegram() {
  const botToken = botTokenInput.value.trim();
  const chatId = chatIdInput.value.trim();
  
  if (!botToken || !chatId) {
    telegramStatus.textContent = 'Заполните все поля';
    telegramStatus.className = 'status-text error';
    return;
  }
  
  telegramStatus.textContent = 'Отправка...';
  telegramStatus.className = 'status-text';
  testTelegramBtn.disabled = true;
  
  try {
    const message = `🔔 <b>Тестовое уведомление</b>\n\nВаш Twitch Drops Monitor настроен и готов к работе!\n\n✅ Telegram уведомления активны`;
    
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
    
    const data = await response.json();
    
    if (data.ok) {
      telegramStatus.textContent = 'Успешно отправлено!';
      telegramStatus.className = 'status-text success';
      showToast('Тестовое сообщение отправлено!', 'success');
    } else {
      telegramStatus.textContent = data.description || 'Ошибка отправки';
      telegramStatus.className = 'status-text error';
    }
  } catch (error) {
    telegramStatus.textContent = 'Ошибка соединения';
    telegramStatus.className = 'status-text error';
  }
  
  testTelegramBtn.disabled = false;
}

// Оновлення інформації
async function updateInfo() {
  const settings = await chrome.storage.local.get(['selectedGames', 'checkInterval', 'dropHistory']);
  
  infoGamesCount.textContent = (settings.selectedGames || []).length;
  infoInterval.textContent = `${settings.checkInterval || 15} мин.`;
  infoHistoryCount.textContent = `${(settings.dropHistory || []).length} записей`;
}

// Показ toast повідомлення
function showToast(message, type = '') {
  toastMessage.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.remove('hidden');
  
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3000);
}

