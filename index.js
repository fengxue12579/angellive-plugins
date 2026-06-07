/**
 * 小雅直播 - LiveParse/AngelLive 插件
 * 基于M3U直播源的聚合插件
 * 动态解析M3U源中的分类
 */

// ==================== 配置 ====================
const CONFIG = {
  m3uSources: [
    {
      name: "主源",
      url: "https://7236.6h8jr4dgcb.workers.dev/live.m3u"
    }
  ]
};

// ==================== 工具函数 ====================

function lpThrow(code, message, context) {
  if (globalThis.Host && typeof Host.raise === "function") {
    Host.raise(code, message, context || {});
  }
  throw new Error(String(message || "unknown error"));
}

/**
 * 解析M3U文件内容（支持多行格式，处理换行断裂）
 */
function parseM3U(m3uContent) {
  const channels = [];
  const rawLines = m3uContent.split('\n');
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF') || line.startsWith('http') || line.startsWith('rtmp') || line.startsWith('rtp') || line.startsWith('#EXTM3U')) {
      lines.push(line);
    } else if (lines.length > 0) {
      lines[lines.length - 1] += line;
    }
  }

  let currentChannel = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTINF:')) {
      currentChannel = {};

      const durationMatch = line.match(/#EXTINF:([-\d.]+)/);
      if (durationMatch) {
        currentChannel.duration = parseFloat(durationMatch[1]);
      }

      const tvgNameMatch = line.match(/tvg-name="([^"]*)"/);
      if (tvgNameMatch) {
        currentChannel.tvgName = tvgNameMatch[1];
      }

      const tvgLogoMatch = line.match(/tvg-logo="([^"]*)"/);
      if (tvgLogoMatch) {
        currentChannel.logo = tvgLogoMatch[1];
      }

      const groupTitleMatch = line.match(/group-title="([^"]*)"/);
      if (groupTitleMatch) {
        currentChannel.category = groupTitleMatch[1];
      } else {
        currentChannel.category = "其他";
      }

      const nameMatch = line.match(/,(.+)$/);
      if (nameMatch) {
        currentChannel.name = nameMatch[1].trim();
      } else if (currentChannel.tvgName) {
        currentChannel.name = currentChannel.tvgName;
      }
    } else if ((line.startsWith('http') || line.startsWith('rtmp') || line.startsWith('rtp')) && currentChannel) {
      let url = line;
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        if (nextLine.includes('=') && !nextLine.startsWith('#EXTINF') && !nextLine.startsWith('http') && !nextLine.startsWith('rtmp') && !nextLine.startsWith('rtp')) {
          url += nextLine;
          i++;
        } else {
          break;
        }
      }
      currentChannel.url = url;
      currentChannel.id = "m3u-" + channels.length;
      channels.push(currentChannel);
      currentChannel = null;
    }
  }

  return channels;
}

function generateCategoryId(categoryName) {
  let hash = 0;
  for (let i = 0; i < categoryName.length; i++) {
    const char = categoryName.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return "cat_" + Math.abs(hash).toString(16);
}

// ==================== 缓存 ====================
let cachedChannels = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000;

async function getAllChannels() {
  const now = Date.now();
  if (cachedChannels && (now - cacheTimestamp) < CACHE_DURATION) {
    return cachedChannels;
  }

  const allChannels = [];

  for (const source of CONFIG.m3uSources) {
    try {
      const response = await fetch(source.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (response.ok) {
        const m3uContent = await response.text();
        const channels = parseM3U(m3uContent);
        allChannels.push(...channels);
      }
    } catch (error) {
      console.error(`[小雅直播] 获取M3U源失败: ${source.url}`, error);
    }
  }

  cachedChannels = allChannels;
  cacheTimestamp = now;
  return allChannels;
}

// ==================== LiveParse 插件核心方法 ====================

globalThis.LiveParsePlugin = {
  apiVersion: 1,

  async getCategories(payload) {
    const channels = await getAllChannels();
    const categoryMap = new Map();

    for (const channel of channels) {
      const category = channel.category || "其他";
      if (!categoryMap.has(category)) {
        categoryMap.set(category, {
          id: generateCategoryId(category),
          name: category,
          count: 0
        });
      }
      categoryMap.get(category).count++;
    }

    const categories = Array.from(categoryMap.values());
    categories.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

    return { categories };
  },

  async getRooms(payload) {
    const { categoryId, page = 1, pageSize = 50 } = payload || {};
    const channels = await getAllChannels();

    const filteredChannels = channels.filter(channel => {
      const channelCategoryId = generateCategoryId(channel.category || "其他");
      return channelCategoryId === categoryId;
    });

    const total = filteredChannels.length;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pageChannels = filteredChannels.slice(start, end);

    const rooms = pageChannels.map(channel => ({
      id: channel.id,
      title: channel.name,
      cover: channel.logo || "",
      anchor: channel.name,
      online: -1,
      category: channel.category
    }));

    return {
      rooms,
      pagination: {
        page,
        pageSize,
        total,
        hasMore: end < total
      }
    };
  },

  async getPlayback(payload) {
    const { roomId } = payload || {};
    const channels = await getAllChannels();
    const channel = channels.find(c => c.id === roomId);

    if (!channel) {
      lpThrow(404, `频道不存在: ${roomId}`);
    }

    return {
      url: channel.url,
      title: channel.name,
      headers: {}
    };
  },

  async search(payload) {
    const { keyword, page = 1, pageSize = 50 } = payload || {};

    if (!keyword || keyword.trim() === "") {
      return {
        rooms: [],
        pagination: { page, pageSize, total: 0, hasMore: false }
      };
    }

    const channels = await getAllChannels();
    const keywordLower = keyword.toLowerCase();

    const filteredChannels = channels.filter(channel => {
      const nameMatch = (channel.name || "").toLowerCase().includes(keywordLower);
      const categoryMatch = (channel.category || "").toLowerCase().includes(keywordLower);
      return nameMatch || categoryMatch;
    });

    const total = filteredChannels.length;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pageChannels = filteredChannels.slice(start, end);

    const rooms = pageChannels.map(channel => ({
      id: channel.id,
      title: channel.name,
      cover: channel.logo || "",
      anchor: channel.name,
      online: -1,
      category: channel.category
    }));

    return {
      rooms,
      pagination: {
        page,
        pageSize,
        total,
        hasMore: end < total
      }
    };
  },

  async getRoomDetail(payload) {
    const { roomId } = payload || {};
    const channels = await getAllChannels();
    const channel = channels.find(c => c.id === roomId);

    if (!channel) {
      lpThrow(404, `频道不存在: ${roomId}`);
    }

    return {
      id: channel.id,
      title: channel.name,
      cover: channel.logo || "",
      anchor: channel.name,
      description: `${channel.category} - ${channel.name}`,
      online: -1,
      category: channel.category,
      startTime: null,
      status: "live"
    };
  },

  async getLiveState(payload) {
    const { roomId } = payload || {};
    const channels = await getAllChannels();
    const channel = channels.find(c => c.id === roomId);

    if (!channel) {
      return { liveState: "3" };
    }

    return { liveState: "1" };
  },

  async resolveShare(payload) {
    return {};
  },

  async getDanmaku(payload) {
    return { args: {}, headers: null };
  }
};
