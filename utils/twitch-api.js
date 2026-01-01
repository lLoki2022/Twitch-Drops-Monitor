// Twitch GQL API utilities
const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

// Отримання auth token з cookies
export async function getAuthToken() {
  try {
    const cookie = await chrome.cookies.get({
      url: 'https://www.twitch.tv',
      name: 'auth-token'
    });
    return cookie ? cookie.value : null;
  } catch (error) {
    console.error('Error getting auth token:', error);
    return null;
  }
}

// Отримання device ID з cookies
export async function getDeviceId() {
  try {
    const cookie = await chrome.cookies.get({
      url: 'https://www.twitch.tv',
      name: 'unique_id'
    });
    return cookie ? cookie.value : generateDeviceId();
  } catch (error) {
    return generateDeviceId();
  }
}

function generateDeviceId() {
  return 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, () => 
    Math.floor(Math.random() * 16).toString(16)
  );
}

// Отримання збережених заголовків Twitch (Client-Integrity та ін.)
export async function getTwitchHeaders() {
  try {
    const data = await chrome.storage.local.get(['twitchHeaders', 'twitchHeadersTimestamp']);
    const headers = data.twitchHeaders || {};
    const timestamp = data.twitchHeadersTimestamp || 0;
    
    // Перевіряємо свіжість (15 годин = 54000000 мс)
    const age = Date.now() - timestamp;
    const isExpired = age > 54000000;
    
    console.log('Twitch headers age:', Math.round(age / 1000 / 60), 'minutes, expired:', isExpired);
    
    return {
      headers,
      isExpired,
      hasIntegrity: !!headers['client-integrity']
    };
  } catch (error) {
    console.error('Error getting twitch headers:', error);
    return { headers: {}, isExpired: true, hasIntegrity: false };
  }
}

// Побудова заголовків для запиту
export async function buildRequestHeaders(includeAuth = true) {
  const token = await getAuthToken();
  const deviceId = await getDeviceId();
  const { headers: savedHeaders } = await getTwitchHeaders();
  
  const headers = {
    'Client-ID': TWITCH_CLIENT_ID,
    'Content-Type': 'application/json'
  };
  
  if (includeAuth && token) {
    headers['Authorization'] = `OAuth ${token}`;
  }
  
  if (deviceId) {
    headers['X-Device-Id'] = deviceId;
  }
  
  // Додаємо збережені заголовки
  if (savedHeaders['client-integrity']) {
    headers['Client-Integrity'] = savedHeaders['client-integrity'];
  }
  
  if (savedHeaders['client-session-id']) {
    headers['Client-Session-Id'] = savedHeaders['client-session-id'];
  }
  
  if (savedHeaders['client-version']) {
    headers['Client-Version'] = savedHeaders['client-version'];
  }
  
  return headers;
}

// Перевірка авторизації
export async function checkAuth() {
  const token = await getAuthToken();
  console.log('Auth token found:', token ? 'yes' : 'no');
  
  if (!token) {
    return { isAuthenticated: false, user: null };
  }
  
  try {
    const headers = await buildRequestHeaders(true);
    
    const response = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify([{
        operationName: 'CoreActionsCurrentUser',
        variables: {},
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: '6b5b63a013cf66a995d61f71a508ab5c8e4473350c5d4136f846ba65e8101e95'
          }
        }
      }])
    });
    
    const data = await response.json();
    console.log('Auth response:', data);
    
    if (data[0]?.data?.currentUser) {
      return {
        isAuthenticated: true,
        user: data[0].data.currentUser
      };
    }
    
    // Альтернативний запит
    const response2 = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: `{
          currentUser {
            id
            login
            displayName
          }
        }`
      })
    });
    
    const data2 = await response2.json();
    
    if (data2?.data?.currentUser) {
      return {
        isAuthenticated: true,
        user: data2.data.currentUser
      };
    }
    
    return { isAuthenticated: !!token, user: { login: 'user' } };
  } catch (error) {
    console.error('Auth check error:', error);
    return { isAuthenticated: !!token, user: { login: 'user' } };
  }
}

// Пошук ігор
export async function searchGames(query) {
  const headers = await buildRequestHeaders(true);
  
  try {
    const response = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify([{
        operationName: 'SearchResultsPage_SearchResults',
        variables: {
          query: query,
          options: {
            targets: [{ index: 'CATEGORY' }]
          }
        },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: '6ea6e6f66006485e41dbe3ebd69d5674c5b22896ce7b595d7fce6411a3790138'
          }
        }
      }])
    });
    
    const data = await response.json();
    console.log('Search response:', data);
    
    const items = data[0]?.data?.searchFor?.categories?.edges || [];
    const games = items.map(edge => ({
      id: edge.node.id,
      name: edge.node.name,
      displayName: edge.node.displayName || edge.node.name,
      boxArtURL: edge.node.boxArtURL
    }));
    
    if (games.length === 0) {
      // Fallback - простий GraphQL запит
      const response2 = await fetch(TWITCH_GQL_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: `
            query SearchGames($query: String!) {
              searchCategories(query: $query, first: 20) {
                edges {
                  node {
                    id
                    name
                    displayName
                    boxArtURL(width: 52, height: 72)
                  }
                }
              }
            }
          `,
          variables: { query }
        })
      });
      
      const data2 = await response2.json();
      const edges = data2?.data?.searchCategories?.edges || [];
      return edges.map(edge => ({
        id: edge.node.id,
        name: edge.node.name,
        displayName: edge.node.displayName || edge.node.name,
        boxArtURL: edge.node.boxArtURL
      }));
    }
    
    return games;
  } catch (error) {
    console.error('Search games error:', error);
    return [];
  }
}

// Отримання всіх активних дропів
export async function getDropCampaigns() {
  const token = await getAuthToken();
  if (!token) {
    return { success: false, error: 'Not authenticated', drops: [] };
  }

  const headers = await buildRequestHeaders(true);

  try {
    const response = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify([{
        operationName: 'ViewerDropsDashboard',
        variables: { fetchRewardCampaigns: true },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: '5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619'
          }
        }
      }])
    });

    const json = await response.json();
    console.log('Drop campaigns response:', json);

    const root = json?.[0]?.data;
    const user = root?.currentUser || root?.viewer;

    const campaigns =
      user?.dropCampaigns ||
      user?.rewardCampaigns ||
      [];

    if (!campaigns.length) {
      return { success: false, error: 'No drop campaigns', drops: [] };
    }

    return {
      success: true,
      drops: campaigns,
      userId: user.id
    };
  } catch (error) {
    console.error('Get drops error:', error);
    return { success: false, error: error.message, drops: [] };
  }
}


// Отримання деталей дропа
export async function getDropDetails(dropId, channelLogin) {
  const token = await getAuthToken();
  if (!token) return null;
  
  const headers = await buildRequestHeaders(true);
  
  try {
    const response = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify([{
        operationName: 'DropCampaignDetails',
        variables: {
          dropID: dropId,
          channelLogin: channelLogin
        },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: '039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1'
          }
        }
      }])
    });
    
    const data = await response.json();
    return data[0]?.data?.user?.dropCampaign || null;
  } catch (error) {
    console.error('Get drop details error:', error);
    return null;
  }
}

// Пошук стрімерів з дропами для гри
export async function findStreamersWithDrops(gameSlug, gameName) {
  const headers = await buildRequestHeaders(true);
  
  try {
    const response = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify([{
        operationName: 'DirectoryPage_Game',
        variables: {
          limit: 30,
          slug: gameSlug,
          imageWidth: 50,
          options: {
            sort: 'VIEWER_COUNT',
            systemFilters: ['DROPS_ENABLED'],
            tags: [],
            broadcasterLanguages: [],
            freeformTags: null,
            includeRestricted: ['SUB_ONLY_LIVE'],
            recommendationsContext: { platform: 'web' },
            requestID: 'JIRA-VXP-2397'
          },
          sortTypeIsRecency: false,
          includeCostreaming: false
        },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: '98a996c3c3ebb1ba4fd65d6671c6028d7ee8d615cb540b0731b3db2a911d3649'
          }
        }
      }])
    });
    
    const data = await response.json();
    const game = data[0]?.data?.game;
    
    if (!game) {
      return [];
    }
    
    const edges = game.streams?.edges || [];
    return edges.map(edge => {
      const node = edge.node;
      const broadcaster = node.broadcaster;
      return {
        channelId: broadcaster?.id,
        login: broadcaster?.login,
        displayName: broadcaster?.displayName,
        broadcastId: node.id,
        viewers: node.viewersCount || 0,
        title: node.title,
        thumbnailURL: node.previewImageURL
      };
    }).filter(s => s.login);
  } catch (error) {
    console.error('Find streamers error:', error);
    return [];
  }
}

// Перевірка чи стрімер онлайн і грає потрібну гру
export async function checkStreamerOnline(channelLogin, expectedGameName) {
  const headers = await buildRequestHeaders(true);
  
  try {
    const response = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify([{
        operationName: 'VideoPlayerStreamInfoOverlayChannel',
        variables: { channel: channelLogin },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: '198492e0857f6aedead9665c81c5a06d67b25b58034649687124083ff288597d'
          }
        }
      }])
    });
    
    const data = await response.json();
    const user = data[0]?.data?.user;
    
    if (!user || !user.stream) {
      return { online: false, correctGame: false };
    }
    
    const currentGame = user.broadcastSettings?.game?.name || '';
    const correctGame = currentGame.toLowerCase() === expectedGameName.toLowerCase();
    
    return { online: true, correctGame, currentGame };
  } catch (error) {
    console.error('Check streamer error:', error);
    return { online: false, correctGame: false };
  }
}

// Отримання інвентарю дропів (прогрес)
export async function getDropsInventory() {
  const token = await getAuthToken();
  if (!token) {
    return { success: false, error: 'Not authenticated', campaigns: [] };
  }
  
  const headers = await buildRequestHeaders(true);
  
  try {
    const response = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify([{
        operationName: 'Inventory',
        variables: { fetchRewardCampaigns: false },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: 'd86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b'
          }
        }
      }])
    });
    
    const data = await response.json();
    const inventory = data[0]?.data?.currentUser?.inventory;
    
    if (!inventory) {
      return { success: false, error: 'No inventory', campaigns: [] };
    }
    
    return {
      success: true,
      campaigns: inventory.dropCampaignsInProgress || [],
      gameEventDrops: inventory.gameEventDrops || []
    };
  } catch (error) {
    console.error('Get inventory error:', error);
    return { success: false, error: error.message, campaigns: [] };
  }
}

// === Inventory-based drop check (source of truth) ===
export async function getInventoryDropCampaigns() {
  const token = await getAuthToken();
  if (!token) return [];

  const headers = await buildRequestHeaders(true);

  try {
    const response = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify([{
        operationName: 'Inventory',
        variables: { fetchRewardCampaigns: false },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash:
              'd86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b'
          }
        }
      }])
    });

    const data = await response.json();
    return (
      data?.[0]?.data?.currentUser?.inventory?.dropCampaignsInProgress || []
    );
  } catch (error) {
    console.error('Inventory drops error:', error);
    return [];
  }
}


// Клейм дропа
export async function claimDrop(dropInstanceId) {
  const headers = await buildRequestHeaders(true);
  
  try {
    const response = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify([{
        operationName: 'DropsPage_ClaimDropRewards',
        variables: {
          input: { dropInstanceID: dropInstanceId }
        },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: 'a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930'
          }
        }
      }])
    });
    
    const data = await response.json();
    const result = data[0]?.data?.claimDropRewards;
    
    if (result) {
      return {
        success: true,
        status: result.status,
        isUserAccountConnected: result.isUserAccountConnected
      };
    }
    
    return { success: false, error: data[0]?.errors?.[0]?.message || 'Unknown error' };
  } catch (error) {
    console.error('Claim drop error:', error);
    return { success: false, error: error.message };
  }
}

// Конвертація назви гри в slug
export function gameToSlug(name) {
  let slug = name.toLowerCase().replace(/'/g, '');
  slug = slug.replace(/\W+/g, '-');
  return slug.replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}

// Статичний spade_url (Twitch рідко його змінює)
const SPADE_URL = 'https://video-edge-c4e1c4.fra02.abs.hls.ttvnw.net/v1/segment/';

// Отримання spade_url - використовуємо відомий endpoint
export async function getSpadeUrl(channelLogin) {
  // Twitch використовує стандартний spade endpoint
  // Він рідко змінюється, тому можна використовувати статичний
  const spadeUrl = 'https://spade.twitch.tv/track';
  console.log('Using spade_url:', spadeUrl);
  return spadeUrl;
}

// Відправка minute-watched події (фарм без вкладки)
export async function sendWatchEvent(spadeUrl, channelId, channelLogin, broadcastId, userId) {
  if (!channelId || !channelLogin || !broadcastId || !userId) {
    console.log('Missing required params for watch event');
    return false;
  }
  
  const payload = [{
    event: 'minute-watched',
    properties: {
      broadcast_id: String(broadcastId),
      channel_id: String(channelId),
      channel: channelLogin,
      hidden: false,
      live: true,
      location: 'channel',
      logged_in: true,
      muted: false,
      player: 'site',
      user_id: String(userId)
    }
  }];
  
  // Base64 encode (мінімізований JSON)
  const jsonStr = JSON.stringify(payload);
  const encoded = btoa(jsonStr);
  
  try {
    const response = await fetch('https://spade.twitch.tv/track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://www.twitch.tv',
        'Referer': `https://www.twitch.tv/${channelLogin}`
      },
      body: `data=${encoded}`,
      mode: 'cors',
      credentials: 'include'
    });
    
    console.log(`Watch response status: ${response.status}`);
    return response.status === 204 || response.status === 200;
  } catch (error) {
    console.error('Send watch error:', error);
    return false;
  }
}

// Отримання інформації про поточного користувача
export async function getCurrentUser() {
  const token = await getAuthToken();
  if (!token) return null;
  
  const headers = await buildRequestHeaders(true);
  
  try {
    const response = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify([{
        operationName: 'CoreActionsCurrentUser',
        variables: {},
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: '6b5b63a013cf66a995d61f71a508ab5c8e4473350c5d4136f846ba65e8101e95'
          }
        }
      }])
    });
    
    const data = await response.json();
    return data[0]?.data?.currentUser || null;
  } catch (error) {
    console.error('Get current user error:', error);
    return null;
  }
}

// Відправка в Telegram
export async function sendTelegramNotification(botToken, chatId, message, photoUrl = null) {
  if (!botToken || !chatId) {
    return { success: false, error: 'Telegram not configured' };
  }
  
  try {
    let url, body;
    
    if (photoUrl) {
      url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
      body = JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption: message,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '🎮 Открыть Twitch Drops', url: 'https://www.twitch.tv/drops/campaigns' }
          ]]
        }
      });
    } else {
      url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      body = JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '🎮 Открыть Twitch Drops', url: 'https://www.twitch.tv/drops/campaigns' }
          ]]
        }
      });
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    
    const data = await response.json();
    return { success: data.ok, error: data.description };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Отримання channel points та доступного бонусу
export async function getChannelPoints(channelLogin) {
  const headers = await buildRequestHeaders(true);
  
  try {
    const response = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify([{
        operationName: 'ChannelPointsContext',
        variables: { channelLogin },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: '374314de591e69925fce3ddc2bcf085796f56ebb8cad67a0daa3165c03adc345'
          }
        }
      }])
    });
    
    const data = await response.json();
    const channel = data[0]?.data?.community?.channel;
    
    if (!channel) {
      return { success: false, error: 'Channel not found' };
    }
    
    const points = channel.self?.communityPoints;
    if (!points) {
      return { success: false, error: 'No points data' };
    }
    
    return {
      success: true,
      channelId: channel.id,
      balance: points.balance || 0,
      availableClaim: points.availableClaim || null
    };
  } catch (error) {
    console.error('Get channel points error:', error);
    return { success: false, error: error.message };
  }
}

// Клейм бонусних channel points
export async function claimChannelPoints(claimId, channelId) {
  const headers = await buildRequestHeaders(true);
  
  try {
    const response = await fetch(TWITCH_GQL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify([{
        operationName: 'ClaimCommunityPoints',
        variables: {
          input: {
            claimID: claimId,
            channelID: String(channelId)
          }
        },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: '46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0'
          }
        }
      }])
    });
    
    const data = await response.json();
    const result = data[0]?.data?.claimCommunityPoints;
    
    if (result) {
      return {
        success: true,
        claim: result.claim,
        currentPoints: result.currentPoints
      };
    }
    
    return { success: false, error: data[0]?.errors?.[0]?.message || 'Unknown error' };
  } catch (error) {
    console.error('Claim points error:', error);
    return { success: false, error: error.message };
  }
}

