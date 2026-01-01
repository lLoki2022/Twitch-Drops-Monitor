// Background Service Worker for Twitch Drops Monitor
import { 
  getDropCampaigns, getDropDetails, sendTelegramNotification, checkAuth, getTwitchHeaders,
  findStreamersWithDrops, checkStreamerOnline, getDropsInventory, claimDrop, gameToSlug,
  getSpadeUrl, sendWatchEvent, getCurrentUser, getChannelPoints, claimChannelPoints
} from '../utils/twitch-api.js';

// Константи
const ALARM_NAME = 'checkDrops';
const ALARM_REFRESH_TOKEN = 'refreshToken';
const ALARM_FARMING = 'farmingCheck';
const ALARM_WATCH = 'sendWatch';
const ALARM_POINTS = 'claimPoints'; // Новий alarm для збору поінтів
const DEFAULT_INTERVAL = 15; // хвилини
const TOKEN_REFRESH_INTERVAL = 720; // 12 годин в хвилинах
const FARMING_CHECK_INTERVAL = 5; // перевірка фарму кожні 5 хвилин
const WATCH_INTERVAL = 0.33; // відправка watch кожні 20 секунд (0.33 хвилини)
const POINTS_CHECK_INTERVAL = 2; // перевірка поінтів кожні 2 хвилини

// Налаштування авто-збору (можна змінювати через storage)
const DEFAULT_FARMING_CONFIG = {
  AUTO_CLAIM_DROPS: true,      // Автоклейм дропів коли 100%
  AUTO_CLAIM_POINTS: true,     // Автозбір бонусних поінтів каналу
  AUTO_START_FARMING: false,   // Автозапуск фарму при появі дропа в відслідковуваних іграх
};

// Стан фарму
let farmingState = {
  active: false,
  gameId: null,
  gameName: null,
  gameSlug: null,
  currentStreamer: null,
  spadeUrl: null,
  userId: null,
  startTime: null,
  dropsProgress: [],
  claimedDrops: 0,
  claimedPoints: 0,       // Лічильник зібраних поінтів
  totalWatchTime: 0,
  watchCount: 0,
  lastWatchSuccess: false,
  currentDropId: null,     // ID текущего фармящегося дропа
  campaignNotFoundCount: 0 // Счетчик проверок без найденной кампании
};

// Очередь дропов для автофарма
let dropQueue = [];

// Отримання налаштувань фарму
async function getFarmingConfig() {
  const { farmingConfig } = await chrome.storage.local.get('farmingConfig');
  return { ...DEFAULT_FARMING_CONFIG, ...farmingConfig };
}

// ============================================
// АВТОМАТИЧНИЙ ЗАХВАТ ЗАГОЛОВКІВ TWITCH
// ============================================

const HEADERS_TO_CAPTURE = [
  'client-integrity',
  'client-session-id', 
  'client-version',
  'authorization'
];

// Перехоплення заголовків з запитів до Twitch GQL
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.method !== 'POST') return;
    
    const capturedHeaders = {};
    let hasNewIntegrity = false;
    
    for (const header of details.requestHeaders || []) {
      const headerName = header.name.toLowerCase();
      
      if (HEADERS_TO_CAPTURE.includes(headerName)) {
        capturedHeaders[headerName] = header.value;
        
        if (headerName === 'client-integrity') {
          hasNewIntegrity = true;
         // console.log('🔐 Captured Client-Integrity:', header.value.substring(0, 50) + '...');
        }
      }
    }
    
    if (hasNewIntegrity) {
      saveCapturedHeaders(capturedHeaders);
    }
  },
  { urls: ['https://gql.twitch.tv/*'] },
  ['requestHeaders']
);

// Збереження захоплених заголовків
async function saveCapturedHeaders(headers) {
  try {
    const existing = await chrome.storage.local.get(['twitchHeaders']);
    const merged = { ...existing.twitchHeaders, ...headers };
    
    await chrome.storage.local.set({
      twitchHeaders: merged,
      twitchHeadersTimestamp: Date.now()
    });
    
   // console.log('✅ Twitch headers saved:', Object.keys(merged));
    
    await closeRefreshTab();
  } catch (error) {
    console.error('Error saving headers:', error);
  }
}

// ============================================
// АВТОМАТИЧНЕ ОНОВЛЕННЯ ТОКЕНА
// ============================================

let refreshTabId = null;

async function refreshTokenAutomatically() {
  console.log('🔄 Starting automatic token refresh...');
  
  const { autoRefreshToken } = await chrome.storage.local.get('autoRefreshToken');
  
  if (autoRefreshToken === false) {
    console.log('Auto refresh is disabled');
    return { success: false, reason: 'disabled' };
  }
  
  const { isExpired, hasIntegrity } = await getTwitchHeaders();
  
  if (hasIntegrity && !isExpired) {
    console.log('Token is still valid, skipping refresh');
    return { success: true, reason: 'still_valid' };
  }
  
  try {
    const tab = await chrome.tabs.create({
      url: 'https://www.twitch.tv/drops/campaigns',
      active: false,
      pinned: false
    });
    
    refreshTabId = tab.id;
    console.log('📑 Created background tab:', tab.id);
    
    setTimeout(() => closeRefreshTab(), 30000);
    
    return { success: true, reason: 'refresh_started', tabId: tab.id };
  } catch (error) {
    console.error('Error creating refresh tab:', error);
    return { success: false, reason: error.message };
  }
}

async function closeRefreshTab() {
  if (refreshTabId) {
    try {
      await chrome.tabs.remove(refreshTabId);
      console.log('🗑️ Closed refresh tab:', refreshTabId);
    } catch (e) {
      // Вкладка вже закрита
    }
    refreshTabId = null;
  }
}

// ============================================
// ОСНОВНА ЛОГІКА РОЗШИРЕННЯ
// ============================================

// Ініціалізація при встановленні
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Twitch Drops Monitor installed');
  
  const settings = await chrome.storage.local.get(['checkInterval', 'selectedGames', 'notifiedDrops', 'dropHistory', 'autoRefreshToken']);
  
  if (!settings.checkInterval) {
    await chrome.storage.local.set({ checkInterval: DEFAULT_INTERVAL });
  }
  if (!settings.selectedGames) {
    await chrome.storage.local.set({ selectedGames: [] });
  }
  if (!settings.notifiedDrops) {
    await chrome.storage.local.set({ notifiedDrops: [] });
  }
  if (!settings.dropHistory) {
    await chrome.storage.local.set({ dropHistory: [] });
  }
  if (settings.autoRefreshToken === undefined) {
    await chrome.storage.local.set({ autoRefreshToken: true });
  }
  
  setupAlarm();
  setupTokenRefreshAlarm();
});

// При запуску браузера
chrome.runtime.onStartup.addListener(async () => {
  console.log('Browser started, checking token...');
  setupAlarm();
  setupTokenRefreshAlarm();
  
  const { hasIntegrity, isExpired } = await getTwitchHeaders();
  if (!hasIntegrity || isExpired) {
    setTimeout(() => refreshTokenAutomatically(), 10000);
  }
});

// Налаштування alarm для перевірки дропів
async function setupAlarm() {
  const { checkInterval, monitoringEnabled } = await chrome.storage.local.get(['checkInterval', 'monitoringEnabled']);
  
  await chrome.alarms.clear(ALARM_NAME);
  
  if (monitoringEnabled !== false) {
    const interval = checkInterval || DEFAULT_INTERVAL;
    chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: interval,
      delayInMinutes: 0.5
    });
    console.log(`Alarm set for every ${interval} minutes`);
  }
}

// Налаштування alarm для оновлення токена
async function setupTokenRefreshAlarm() {
  await chrome.alarms.clear(ALARM_REFRESH_TOKEN);
  
  chrome.alarms.create(ALARM_REFRESH_TOKEN, {
    periodInMinutes: TOKEN_REFRESH_INTERVAL,
    delayInMinutes: 60
  });
  console.log('Token refresh alarm set for every 12 hours');
}

// Обробка alarm
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    const { hasIntegrity, isExpired } = await getTwitchHeaders();
    if (!hasIntegrity || isExpired) {
      await refreshTokenAutomatically();
      setTimeout(() => checkDrops(), 35000);
    } else {
      await checkDrops();
    }
  }
  
  if (alarm.name === ALARM_REFRESH_TOKEN) {
    await refreshTokenAutomatically();
  }
});

// Основна функція перевірки дропів
async function checkDrops() {
  console.log('=== Checking drops ===', new Date().toLocaleString());
  
  const { hasIntegrity, isExpired } = await getTwitchHeaders();
  if (!hasIntegrity) {
    console.log('⚠️ No Client-Integrity token.');
    return { 
      checked: true, 
      found: 0, 
      message: 'Нет Client-Integrity. Откройте Twitch для захвата токена.',
      needsHeaders: true
    };
  }
  
  if (isExpired) {
    console.log('⚠️ Client-Integrity may be expired. Will try anyway...');
  }
  
  const { selectedGames, notifiedDrops, telegramBotToken, telegramChatId, soundEnabled } = 
    await chrome.storage.local.get(['selectedGames', 'notifiedDrops', 'telegramBotToken', 'telegramChatId', 'soundEnabled']);
  
  console.log('Selected games:', selectedGames);
  
  if (!selectedGames || selectedGames.length === 0) {
    console.log('No games selected for monitoring');
    return { checked: true, found: 0, message: 'Нет выбранных игр' };
  }
  
  const selectedGameIds = selectedGames.map(g => g.id);
  const selectedGameNames = selectedGames.map(g => g.displayName?.toLowerCase() || g.name?.toLowerCase());
  console.log('Selected game IDs:', selectedGameIds);
  console.log('Selected game names:', selectedGameNames);
  
  const result = await getDropCampaigns();
  console.log('Drop campaigns result:', result);
  
  if (!result.success) {
    console.error('Failed to get drops:', result.error);
    return { checked: true, found: 0, message: 'Ошибка получения дропов: ' + result.error };
  }
  
  console.log(`Total drops from Twitch: ${result.drops.length}`);
  
  const newDrops = [];
  const currentNotified = notifiedDrops || [];
  
  for (const drop of result.drops) {
    const gameId = drop.game?.id;
    const gameName = drop.game?.displayName?.toLowerCase() || drop.game?.name?.toLowerCase();
    
    console.log(`Checking drop: ${drop.name}, game: ${drop.game?.displayName} (${gameId}), status: ${drop.status}`);
    
    const matchById = selectedGameIds.includes(gameId);
    const matchByName = selectedGameNames.some(name => gameName?.includes(name) || name?.includes(gameName));
    
    if (!matchById && !matchByName) {
      console.log(`  -> Skipped: game not in selected list`);
      continue;
    }
    
    if (drop.status === 'EXPIRED') {
      console.log(`  -> Skipped: expired`);
      continue;
    }
    
    if (currentNotified.includes(drop.id)) {
      console.log(`  -> Skipped: already notified`);
      continue;
    }
    
    console.log(`  -> NEW DROP FOUND!`);
    newDrops.push(drop);
  }
  
  if (newDrops.length === 0) {
    console.log('No new drops found for selected games');
    return { checked: true, found: 0, message: 'Новых дропов нет' };
  }
  
  console.log(`Found ${newDrops.length} new drops!`);
  
  for (const drop of newDrops) {
    const details = await getDropDetails(drop.id, result.userId);
    
    const statusEmoji = drop.status === 'ACTIVE' ? '🟢' : '🟡';
    const statusText = drop.status === 'ACTIVE' ? 'Активен' : 'Скоро';
    
    const formatDate = (d) => new Date(d).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    
    let message = `🎮 <b>TWITCH DROP - ${drop.game?.displayName || 'Unknown'}</b>\n`;
    message += `${statusEmoji} <b>Статус:</b> ${statusText}\n`;
    message += `🏢 <b>Организатор:</b> ${drop.owner?.name || 'Unknown'}\n`;
    message += `📦 <b>Кампания:</b> ${drop.name}\n`;
    
    if (details) {
      message += `📅 Начало: ${formatDate(details.startAt)}\n`;
      message += `📅 Конец: ${formatDate(details.endAt)}\n`;
      
      if (details.timeBasedDrops) {
        message += `\n<b>Награды:</b>\n`;
        for (const reward of details.timeBasedDrops) {
          message += `🎁 ${reward.name} - ${reward.requiredMinutesWatched} мин.\n`;
        }
      }
    }
    
    chrome.notifications.create(`drop_${drop.id}`, {
      type: 'basic',
      iconUrl: drop.game?.boxArtURL || '../icons/icon128.png',
      title: `🎮 Новый Drop: ${drop.game?.displayName}`,
      message: `${drop.name}\n${statusText}`,
      priority: 2,
      requireInteraction: true
    });
    
    if (telegramBotToken && telegramChatId) {
      await sendTelegramNotification(
        telegramBotToken,
        telegramChatId,
        message,
        drop.game?.boxArtURL
      );
    }
    
    await addToHistory(drop, details);
    currentNotified.push(drop.id);
  }
  
  const trimmedNotified = currentNotified.slice(-100);
  await chrome.storage.local.set({ notifiedDrops: trimmedNotified });
  
  await updateBadge(newDrops.length);
  
  return { checked: true, found: newDrops.length, message: `Найдено ${newDrops.length} новых дропов!` };
}

// Додавання в історію
async function addToHistory(drop, details) {
  const { dropHistory } = await chrome.storage.local.get('dropHistory');
  const history = dropHistory || [];
  
  // Беремо дати з drop або details
  const startAt = drop.startAt || details?.startAt;
  const endAt = drop.endAt || details?.endAt;
  
  const historyItem = {
    id: drop.id,
    gameName: drop.game?.displayName,
    gameId: drop.game?.id,
    boxArtURL: drop.game?.boxArtURL,
    campaignName: drop.name,
    status: drop.status,
    owner: drop.owner?.name,
    startAt: startAt,
    endAt: endAt,
    rewards: (drop.timeBasedDrops || details?.timeBasedDrops)?.map(r => ({
      name: r.name,
      minutes: r.requiredMinutesWatched
    })),
    foundAt: new Date().toISOString(),
    farmingStatus: 'idle'  // Статус фарма: idle, queued, farming, completed
  };
  
  history.unshift(historyItem);
  
  await chrome.storage.local.set({ dropHistory: history.slice(0, 50) });
  
  // Добавляем в очередь автофарма (если включено)
  await addToFarmQueue(drop, historyItem);
}

// Добавление дропа в очередь автофарма
async function addToFarmQueue(drop, historyItem) {
  const config = await getFarmingConfig();
  
  // Проверяем, включен ли автозапуск
  if (!config.AUTO_START_FARMING) {
    console.log('⚙️ AUTO_START_FARMING disabled, skip queue');
    return;
  }
  
  // Проверяем, активен ли дроп
  if (drop.status !== 'ACTIVE') {
    console.log('📭 Drop not active, skip queue');
    return;
  }
  
  // Загружаем очередь
  const { dropQueue: savedQueue } = await chrome.storage.local.get('dropQueue');
  dropQueue = savedQueue || [];
  
  // Проверяем, нет ли уже этого дропа в очереди
  if (dropQueue.some(item => item.dropId === drop.id)) {
    console.log('📋 Drop already in queue');
    return;
  }
  
  // Добавляем в очередь
  const queueItem = {
    dropId: drop.id,
    gameId: drop.game?.id,
    gameName: drop.game?.displayName || drop.game?.name,
    gameSlug: gameToSlug(drop.game?.displayName || drop.game?.name),
    boxArtURL: drop.game?.boxArtURL,
    addedAt: Date.now()
  };
  
  dropQueue.push(queueItem);
  await chrome.storage.local.set({ dropQueue });
  
  console.log(`📋 Added to queue: ${queueItem.gameName} (queue size: ${dropQueue.length})`);
  
  // Обновляем статус в истории
  await updateDropFarmingStatus(drop.id, 'queued');
  
  // Если фарм не активен, запускаем первый в очереди
  if (!farmingState.active && dropQueue.length > 0) {
    console.log('🚀 Starting farming from queue...');
    await processNextInQueue();
  }
}

// Обновление статуса фарма для дропа в истории
async function updateDropFarmingStatus(dropId, status) {
  const { dropHistory } = await chrome.storage.local.get('dropHistory');
  const history = dropHistory || [];
  
  const dropIndex = history.findIndex(item => item.id === dropId);
  if (dropIndex !== -1) {
    history[dropIndex].farmingStatus = status;
    await chrome.storage.local.set({ dropHistory: history });
    console.log(`📝 Updated drop ${dropId} status: ${status}`);
  }
}

// Обработка следующего дропа в очереди
async function processNextInQueue() {
  // Загружаем очередь
  const { dropQueue: savedQueue } = await chrome.storage.local.get('dropQueue');
  dropQueue = savedQueue || [];
  
  if (dropQueue.length === 0) {
    console.log('📭 Queue is empty');
    return { success: false, message: 'Очередь пуста' };
  }
  
  // Берем первый дроп из очереди
  const nextDrop = dropQueue[0];
  console.log(`🎮 Processing next in queue: ${nextDrop.gameName}`);
  
  // Обновляем статус на "farming"
  await updateDropFarmingStatus(nextDrop.dropId, 'farming');
  
  // Формируем объект игры для запуска фарма
  const game = {
    id: nextDrop.gameId,
    displayName: nextDrop.gameName,
    name: nextDrop.gameName,
    boxArtURL: nextDrop.boxArtURL
  };
  
  // Запускаем фарм
  const result = await startFarming(game, nextDrop.dropId);
  
  if (result.success) {
    console.log('✅ Farming started successfully');
    
    // Уведомление о запуске
    chrome.notifications.create(`queue_start_${Date.now()}`, {
      type: 'basic',
      iconUrl: nextDrop.boxArtURL || '../icons/icon128.png',
      title: '🚀 Авто-фарм запущен',
      message: `Начат фарм: ${nextDrop.gameName}`,
      priority: 1
    });
    
    return { success: true };
  } else {
    console.log('❌ Failed to start farming:', result.message);
    
    // Удаляем из очереди и пробуем следующий
    dropQueue.shift();
    await chrome.storage.local.set({ dropQueue });
    await updateDropFarmingStatus(nextDrop.dropId, 'idle');
    
    if (dropQueue.length > 0) {
      return await processNextInQueue();
    }
    
    return { success: false, message: result.message };
  }
}

// Удаление дропа из очереди
async function removeFromQueue(dropId) {
  const { dropQueue: savedQueue } = await chrome.storage.local.get('dropQueue');
  dropQueue = savedQueue || [];
  
  dropQueue = dropQueue.filter(item => item.dropId !== dropId);
  await chrome.storage.local.set({ dropQueue });
  
  console.log(`🗑️ Removed from queue: ${dropId}`);
}

// Оновлення badge
async function updateBadge(count) {
  if (count > 0) {
    await chrome.action.setBadgeText({ text: count.toString() });
    await chrome.action.setBadgeBackgroundColor({ color: '#9147ff' });
  }
}

chrome.action.onClicked.addListener(async () => {
  await chrome.action.setBadgeText({ text: '' });
});

chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.tabs.create({ url: 'https://www.twitch.tv/drops/campaigns' });
  chrome.notifications.clear(notificationId);
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    if (changes.checkInterval || changes.monitoringEnabled) {
      setupAlarm();
    }
  }
});

// ============================================
// АВТОФАРМ ДРОПІВ (через watch події, без вкладок)
// ============================================

// Запуск фарму для гри
async function startFarming(game, dropId = null) {
  console.log('🎮 Starting farming for:', game.displayName);
  
  // Отримуємо userId
  const user = await getCurrentUser();
  if (!user) {
    return { success: false, message: 'Не удалось получить данные пользователя' };
  }
  
  // Отримуємо налаштування
  const config = await getFarmingConfig();
  
  farmingState = {
    active: true,
    gameId: game.id,
    gameName: game.displayName || game.name,
    gameSlug: gameToSlug(game.displayName || game.name),
    currentStreamer: null,
    spadeUrl: null,
    userId: user.id,
    startTime: Date.now(),
    dropsProgress: [],
    claimedDrops: 0,
    claimedPoints: 0,
    totalWatchTime: 0,
    watchCount: 0,
    lastWatchSuccess: false,
    config: config,  // Зберігаємо налаштування
    currentDropId: dropId,  // ID текущего дропа
    campaignNotFoundCount: 0 // Сброс счетчика
  };
  
  await chrome.storage.local.set({ farmingState });
  
  // Знаходимо стрімера
  const result = await findAndSetupStreamer();
  if (!result.success) {
    farmingState.active = false;
    await chrome.storage.local.set({ farmingState });
    return result;
  }
  
  // Налаштовуємо alarm для відправки watch (кожні 20 сек)
  chrome.alarms.create(ALARM_WATCH, {
    periodInMinutes: WATCH_INTERVAL,
    delayInMinutes: 0.05
  });
  
  // Налаштовуємо alarm для перевірки дропів (кожні 5 хв)
  chrome.alarms.create(ALARM_FARMING, {
    periodInMinutes: FARMING_CHECK_INTERVAL,
    delayInMinutes: 1
  });
  
  // Налаштовуємо alarm для збору поінтів (кожні 2 хв)
  if (config.AUTO_CLAIM_POINTS) {
    chrome.alarms.create(ALARM_POINTS, {
      periodInMinutes: POINTS_CHECK_INTERVAL,
      delayInMinutes: 0.5
    });
    console.log('💰 Auto-claim points enabled');
  }
  
  console.log('📋 Farming config:', config);
  return { success: true, message: `Фарм запущено: ${game.displayName}` };
}

// Зупинка фарму
async function stopFarming(switchToNext = false) {
  console.log('⏹️ Stopping farming');
  
  await chrome.alarms.clear(ALARM_WATCH);
  await chrome.alarms.clear(ALARM_FARMING);
  await chrome.alarms.clear(ALARM_POINTS);
  
  const currentDropId = farmingState.currentDropId;
  
  const result = {
    gameName: farmingState.gameName,
    totalWatchTime: Math.round((Date.now() - farmingState.startTime) / 60000),
    claimedDrops: farmingState.claimedDrops,
    claimedPoints: farmingState.claimedPoints,
    watchCount: farmingState.watchCount
  };
  
  // Удаляем из очереди если там есть
  if (currentDropId) {
    await removeFromQueue(currentDropId);
    
    // Обновляем статус в истории (если не переключаемся на следующий)
    if (!switchToNext) {
      await updateDropFarmingStatus(currentDropId, 'idle');
    }
  }
  
  farmingState = {
    active: false,
    gameId: null,
    gameName: null,
    gameSlug: null,
    currentStreamer: null,
    spadeUrl: null,
    userId: null,
    startTime: null,
    dropsProgress: [],
    claimedDrops: 0,
    claimedPoints: 0,
    totalWatchTime: 0,
    watchCount: 0,
    lastWatchSuccess: false,
    currentDropId: null,
    campaignNotFoundCount: 0
  };
  
  await chrome.storage.local.set({ farmingState });
  
  return { success: true, message: 'Фарм остановлен', ...result };
}

// Пошук стрімера і налаштування для watch
async function findAndSetupStreamer() {
  if (!farmingState.active) return { success: false };
  
  console.log('🔍 Finding streamer for:', farmingState.gameName);
  
  const streamers = await findStreamersWithDrops(farmingState.gameSlug, farmingState.gameName);
  
  if (streamers.length === 0) {
    console.log('❌ No streamers with drops found');
    farmingState.currentStreamer = null;
    farmingState.spadeUrl = null;
    await chrome.storage.local.set({ farmingState });
    return { success: false, message: 'Нет стримеров с дропами' };
  }
  
  // Вибираємо першого стрімера (найбільше глядачів)
  const streamer = streamers[0];
  console.log(`✅ Found streamer: ${streamer.displayName} (${streamer.viewers} viewers)`);
  
  // Отримуємо spade_url
  const spadeUrl = await getSpadeUrl(streamer.login);
  if (!spadeUrl) {
    console.log('❌ Failed to get spade_url');
    return { success: false, message: 'Не удалось получить spade_url' };
  }
  
  farmingState.currentStreamer = streamer;
  farmingState.spadeUrl = spadeUrl;
  
  await chrome.storage.local.set({ farmingState });
  
  console.log(`📺 Ready to farm: ${streamer.login}`);
  return { success: true, streamer };
}

// Відправка watch події (викликається кожні 20 сек)
async function sendWatch() {
  if (!farmingState.active || !farmingState.currentStreamer || !farmingState.spadeUrl) {
    return;
  }
  
  const streamer = farmingState.currentStreamer;
  
  const success = await sendWatchEvent(
    farmingState.spadeUrl,
    streamer.channelId,
    streamer.login,
    streamer.broadcastId,
    farmingState.userId
  );
  
  farmingState.lastWatchSuccess = success;
  
  if (success) {
    farmingState.watchCount++;
    console.log(`📡 Watch #${farmingState.watchCount} sent to ${streamer.login}`);
  } else {
    console.log(`❌ Watch failed for ${streamer.login}`);
  }
  
  // Оновлюємо час
  farmingState.totalWatchTime = Math.round((Date.now() - farmingState.startTime) / 60000);
  await chrome.storage.local.set({ farmingState });
}

// Перевірка фарму (викликається кожні 5 хв)
async function checkFarming() {
  if (!farmingState.active) return;
  
  console.log('🔄 Checking farming status...');
  
  // Перевіряємо чи стрімер онлайн і грає потрібну гру
  if (farmingState.currentStreamer) {
    const status = await checkStreamerOnline(
      farmingState.currentStreamer.login,
      farmingState.gameName
    );
    
    if (!status.online || !status.correctGame) {
      console.log(`⚠️ Streamer ${farmingState.currentStreamer.login} is offline or changed game`);
      await findAndSetupStreamer();
    }
  } else {
    await findAndSetupStreamer();
  }
  
  // Перевіряємо прогрес дропів і клеймимо готові
  await checkAndClaimDrops();
}

// Перевірка і клейм дропів
async function checkAndClaimDrops() {
  if (!farmingState.active) return;
  
  const config = farmingState.config || await getFarmingConfig();
  const inventory = await getDropsInventory();
  
  if (!inventory.success) {
    console.log('Failed to get inventory:', inventory.error);
    return;
  }
  
  const targetSlug = farmingState.gameSlug.toLowerCase();
  farmingState.dropsProgress = [];
  
  let foundTargetCampaign = false;
  let unclaimedCount = 0;
  
  for (const campaign of inventory.campaigns) {
    const gameSlug = campaign.game?.slug?.toLowerCase();
    
    if (gameSlug !== targetSlug) continue;
    
    foundTargetCampaign = true;
    
    for (const drop of (campaign.timeBasedDrops || [])) {
      const selfData = drop.self || {};
      const benefits = drop.benefitEdges || [];
      const name = benefits.map(b => b.benefit?.name).filter(Boolean).join(', ') || drop.name || 'Drop';
      
      // Проверка 1: Статус дропа
      const dropStatus = selfData.status?.toUpperCase();
      if (dropStatus && ['EXPIRED', 'UNAVAILABLE', 'LOCKED', 'INACTIVE'].includes(dropStatus)) {
        console.log(`⚠️ Skipping unavailable drop (status ${dropStatus}): ${name}`);
        continue;
      }
      
      // Проверка 2: Прекондиции
      const preconditions = drop.preconditions;
      if (preconditions && !preconditions.isMet) {
        console.log(`⚠️ Skipping locked drop (preconditions not met): ${name}`);
        continue;
      }
      
      // Проверка 3: Время окончания
      const endAt = drop.endAt;
      if (endAt) {
        try {
          const endTime = new Date(endAt);
          if (Date.now() > endTime.getTime()) {
            console.log(`⚠️ Skipping expired drop: ${name}`);
            continue;
          }
        } catch (e) {
          // Ignore date parsing errors
        }
      }
      
      // Проверка 4: Поле isEnabled
      const isEnabled = drop.isEnabled !== false;
      if (!isEnabled) {
        console.log(`⚠️ Skipping disabled drop: ${name}`);
        continue;
      }
      
      const isClaimed = selfData.isClaimed;
      const current = selfData.currentMinutesWatched || 0;
      const required = drop.requiredMinutesWatched || 0;
      const progress = required > 0 ? Math.round((current / required) * 100) : 0;
      
      farmingState.dropsProgress.push({
        name,
        current,
        required,
        progress,
        isClaimed
      });
      
      // Подсчет незаклеймленных
      if (!isClaimed) {
        unclaimedCount++;
        
        if (required > 0) {
          console.log(`📊 ${name}: ${current}/${required} мин (${progress}%)`);
        }
      }
      
      // Клеймимо якщо готово і AUTO_CLAIM_DROPS увімкнено
      if (!isClaimed && current >= required && required > 0 && config.AUTO_CLAIM_DROPS) {
        const instanceId = selfData.dropInstanceID;
        if (instanceId) {
          console.log(`🎁 Claiming drop: ${name}`);
          const result = await claimDrop(instanceId);
          
          // Проверка 5: Ошибки от API
          if (result.error) {
            const errorLower = result.error.toLowerCase();
            if (errorLower.includes('no longer available') || 
                errorLower.includes('unavailable') || 
                errorLower.includes('недоступна')) {
              console.log(`⚠️ Drop no longer available (API error): ${name}`);
              unclaimedCount--;
              continue;
            }
          }
          
          if (result.success) {
            console.log(`✅ Claimed: ${name}`);
            farmingState.claimedDrops++;
            unclaimedCount--;
            
            // Відправляємо сповіщення
            chrome.notifications.create(`claim_${Date.now()}`, {
              type: 'basic',
              iconUrl: '../icons/icon128.png',
              title: '🎁 Дроп получен!',
              message: `${name}\n${farmingState.gameName}`,
              priority: 2
            });
            
            // Telegram сповіщення
            const { telegramBotToken, telegramChatId } = await chrome.storage.local.get(['telegramBotToken', 'telegramChatId']);
            if (telegramBotToken && telegramChatId) {
              await sendTelegramNotification(
                telegramBotToken,
                telegramChatId,
                `🎁 <b>Дроп получен!</b>\n\n🎮 ${farmingState.gameName}\n📦 ${name}`
              );
            }
          }
        }
      }
    }
  }
  
  // Проверка: найдена ли кампания для текущей игры
  if (!foundTargetCampaign) {
    farmingState.campaignNotFoundCount = (farmingState.campaignNotFoundCount || 0) + 1;
    console.log(`⚠️ Campaign not found for ${farmingState.gameName} (attempt ${farmingState.campaignNotFoundCount})`);
    
    // Если кампания не найдена 3 раза подряд, останавливаем фарм
    if (farmingState.campaignNotFoundCount >= 3) {
      console.log(`❌ Campaign not found after ${farmingState.campaignNotFoundCount} checks, stopping farm`);
      
      chrome.notifications.create(`campaign_lost_${Date.now()}`, {
        type: 'basic',
        iconUrl: '../icons/icon128.png',
        title: '⚠️ Кампания не найдена',
        message: `${farmingState.gameName}\nДропы больше недоступны. Переключаемся...`,
        priority: 2
      });
      
      // Помечаем как completed и переключаемся
      if (farmingState.currentDropId) {
        await updateDropFarmingStatus(farmingState.currentDropId, 'completed');
      }
      
      await stopFarming(true);
      
      // Пробуем следующий из очереди
      const { dropQueue: savedQueue } = await chrome.storage.local.get('dropQueue');
      if (savedQueue && savedQueue.length > 0) {
        setTimeout(() => processNextInQueue(), 5000);
      }
    }
    
    await chrome.storage.local.set({ farmingState });
    return;
  }
  
  // Сбрасываем счетчик если кампания найдена
  farmingState.campaignNotFoundCount = 0;
  
  await chrome.storage.local.set({ farmingState });
  console.log('Drops progress:', farmingState.dropsProgress);
  
  // Проверяем, все ли дропы получены для текущей игры
  if (farmingState.dropsProgress.length > 0) {
    const allClaimed = farmingState.dropsProgress.every(drop => drop.isClaimed);
    
    if (allClaimed) {
      console.log('🎉 All drops claimed for current game!');
      
      // Обновляем статус в истории на "completed"
      if (farmingState.currentDropId) {
        await updateDropFarmingStatus(farmingState.currentDropId, 'completed');
      }
      
      // Уведомление о завершении
      chrome.notifications.create(`completed_${Date.now()}`, {
        type: 'basic',
        iconUrl: '../icons/icon128.png',
        title: '✅ Все дропы получены!',
        message: `${farmingState.gameName}\nПереключаемся на следующий...`,
        priority: 2
      });
      
      // Останавливаем текущий фарм
      await stopFarming(true);
      
      // Загружаем очередь и проверяем следующий
      const { dropQueue: savedQueue } = await chrome.storage.local.get('dropQueue');
      dropQueue = savedQueue || [];
      
      if (dropQueue.length > 0) {
        console.log('📋 Processing next drop in queue...');
        // Небольшая задержка перед запуском следующего
        setTimeout(() => processNextInQueue(), 5000);
      } else {
        console.log('📭 Queue is empty, farming completed!');
        
        // Финальное уведомление
        chrome.notifications.create(`all_completed_${Date.now()}`, {
          type: 'basic',
          iconUrl: '../icons/icon128.png',
          title: '🎊 Фарм завершен!',
          message: 'Все дропы из очереди получены',
          priority: 2
        });
      }
    }
  }
}

// Перевірка і збір channel points
async function checkAndClaimPoints() {
  if (!farmingState.active || !farmingState.currentStreamer) {
    return;
  }
  
  const config = farmingState.config || await getFarmingConfig();
  if (!config.AUTO_CLAIM_POINTS) {
    return;
  }
  
  const channelLogin = farmingState.currentStreamer.login;
  console.log(`💰 Checking points for channel: ${channelLogin}`);
  
  const pointsData = await getChannelPoints(channelLogin);
  
  if (!pointsData.success) {
    console.log('Failed to get channel points:', pointsData.error);
    return;
  }
  
  console.log(`💰 Balance: ${pointsData.balance}, Available claim: ${pointsData.availableClaim ? 'YES' : 'NO'}`);
  
  // Якщо є доступний бонус для збору
  if (pointsData.availableClaim) {
    const claimId = pointsData.availableClaim.id;
    const channelId = pointsData.channelId;
    
    console.log(`🎯 Claiming bonus points...`);
    const result = await claimChannelPoints(claimId, channelId);
    
    if (result.success) {
      farmingState.claimedPoints += 50; // Зазвичай бонус = 50 поінтів
      await chrome.storage.local.set({ farmingState });
      
      console.log(`✅ +50 points claimed! Total claimed: ${farmingState.claimedPoints}`);
      
      // Сповіщення (опціонально, можна вимкнути щоб не спамити)
      // chrome.notifications.create(`points_${Date.now()}`, {
      //   type: 'basic',
      //   iconUrl: '../icons/icon128.png',
      //   title: '💰 Поинты собраны!',
      //   message: `+50 поинтов на канале ${channelLogin}`,
      //   priority: 1
      // });
    } else {
      console.log('Failed to claim points:', result.error);
    }
  }
}

// Обробка alarm для фарму
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_WATCH) {
    await sendWatch();
  }
  if (alarm.name === ALARM_FARMING) {
    await checkFarming();
  }
  if (alarm.name === ALARM_POINTS) {
    await checkAndClaimPoints();
  }
});

// Відновлення стану фарму при запуску
chrome.runtime.onStartup.addListener(async () => {
  const { farmingState: savedState, dropQueue: savedQueue } = await chrome.storage.local.get(['farmingState', 'dropQueue']);
  
  // Восстанавливаем очередь
  if (savedQueue) {
    dropQueue = savedQueue;
    console.log(`📋 Restored queue with ${dropQueue.length} items`);
  }
  
  if (savedState?.active) {
    farmingState = savedState;
    console.log('🔄 Restoring farming state for:', farmingState.gameName);
    
    const config = farmingState.config || await getFarmingConfig();
    
    // Перезапускаємо alarms
    chrome.alarms.create(ALARM_WATCH, {
      periodInMinutes: WATCH_INTERVAL,
      delayInMinutes: 0.1
    });
    
    chrome.alarms.create(ALARM_FARMING, {
      periodInMinutes: FARMING_CHECK_INTERVAL,
      delayInMinutes: 0.5
    });
    
    // Alarm для поінтів
    if (config.AUTO_CLAIM_POINTS) {
      chrome.alarms.create(ALARM_POINTS, {
        periodInMinutes: POINTS_CHECK_INTERVAL,
        delayInMinutes: 0.3
      });
    }
    
    // Перевіряємо стрімера
    await findAndSetupStreamer();
  }
});

// Обробка повідомлень від popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'checkNow') {
    checkDrops().then(result => {
      console.log('Check completed:', result);
      sendResponse(result || { checked: true, found: 0, message: 'Проверка завершена' });
    }).catch(error => {
      console.error('Check error:', error);
      sendResponse({ checked: false, found: 0, message: 'Ошибка: ' + error.message });
    });
    return true;
  }
  
  if (message.action === 'clearBadge') {
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ success: true });
  }
  
  if (message.action === 'getStatus') {
    checkAuth().then(auth => sendResponse(auth));
    return true;
  }
  
  if (message.action === 'getHeadersStatus') {
    getTwitchHeaders().then(status => sendResponse(status));
    return true;
  }
  
  if (message.action === 'refreshToken') {
    refreshTokenAutomatically().then(result => sendResponse(result));
    return true;
  }
  
  // Команди фарму
  if (message.action === 'startFarming') {
    startFarming(message.game).then(result => sendResponse(result));
    return true;
  }
  
  if (message.action === 'stopFarming') {
    stopFarming().then(result => sendResponse(result));
    return true;
  }
  
  if (message.action === 'getFarmingStatus') {
    sendResponse({
      ...farmingState,
      totalWatchTime: farmingState.startTime 
        ? Math.round((Date.now() - farmingState.startTime) / 60000)
        : 0
    });
  }
  
  // Отримання налаштувань фарму
  if (message.action === 'getFarmingConfig') {
    getFarmingConfig().then(config => sendResponse(config));
    return true;
  }
  
  // Відправляємо в service worker для оновлення активного фарму
  if (message.action === 'setFarmingConfig') {
    chrome.storage.local.set({ farmingConfig: message.config }).then(() => {
      // Оновлюємо конфіг в поточному стані фарму
      if (farmingState.active) {
        farmingState.config = { ...farmingState.config, ...message.config };
        
        // Керуємо alarm для поінтів
        if (message.config.AUTO_CLAIM_POINTS) {
          chrome.alarms.create(ALARM_POINTS, {
            periodInMinutes: POINTS_CHECK_INTERVAL,
            delayInMinutes: 0.1
          });
        } else {
          chrome.alarms.clear(ALARM_POINTS);
        }
      }
      sendResponse({ success: true });
    });
    return true;
  }
  
  // Получение состояния очереди
  if (message.action === 'getQueueStatus') {
    chrome.storage.local.get('dropQueue').then(({ dropQueue: savedQueue }) => {
      sendResponse({ queue: savedQueue || [] });
    });
    return true;
  }
});

