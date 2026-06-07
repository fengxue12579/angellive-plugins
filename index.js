/**
 * 小雅直播 - AngelLive 插件
 * 基于M3U直播源的IPTV聚合插件
 * 动态解析M3U源中的分类，不添加任何本地频道
 */

// ==================== 配置 ====================
const CONFIG = {
  // M3U直播源地址
  m3uSources: [
    {
      name: "主源",
      url: "https://7236.6h8jr4dgcb.workers.dev/live.m3u"
    }
  ]
};

// ==================== 工具函数 ====================

/**
 * 解析M3U文件内容（支持多行格式，处理PDF提取等导致的换行断裂）
 * @param {string} m3uContent - M3U文件原始内容
 * @returns {Array} 解析后的频道列表
 */
function parseM3U(m3uContent) {
  const channels = [];
  // 先合并因换行断裂的行：如果某行不以#EXTINF、http、rtmp、rtp开头，且不是空行，则可能是上一行的延续
  const rawLines = m3uContent.split('\n');
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF') || line.startsWith('http') || line.startsWith('rtmp') || line.startsWith('rtp') || line.startsWith('#EXTM3U')) {
      lines.push(line);
    } else if (lines.length > 0) {
      // 追加到上一行
      lines[lines.length - 1] += line;
    }
  }

  let currentChannel = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTINF:')) {
      // 解析EXTINF行
      currentChannel = {};

      // 提取时长
      const durationMatch = line.match(/#EXTINF:([-\d.]+)/);
      if (durationMatch) {
        currentChannel.duration = parseFloat(durationMatch[1]);
      }

      // 提取tvg-name
      const tvgNameMatch = line.match(/tvg-name="([^"]*)"/);
      if (tvgNameMatch) {
        currentChannel.tvgName = tvgNameMatch[1];
      }

      // 提取tvg-logo（处理可能跨行的logo URL）
      const tvgLogoMatch = line.match(/tvg-logo="([^"]*)"/);
      if (tvgLogoMatch) {
        currentChannel.logo = tvgLogoMatch[1];
      }

      // 提取group-title（分类）
      const groupTitleMatch = line.match(/group-title="([^"]*)"/);
      if (groupTitleMatch) {
        currentChannel.category = groupTitleMatch[1];
      } else {
        currentChannel.category = "其他";
      }

      // 提取频道名称（逗号后的内容）
      const nameMatch = line.match(/,(.+)$/);
      if (nameMatch) {
        currentChannel.name = nameMatch[1].trim();
      } else if (currentChannel.tvgName) {
        currentChannel.name = currentChannel.tvgName;
      }
    } else if ((line.startsWith('http') || line.startsWith('rtmp') || line.startsWith('rtp')) && currentChannel) {
      // URL行：支持http/https/rtmp/rtp，可能因换行断裂需要与下一行合并
      let url = line;
      // 检查后续行是否以查询参数形式继续（以?、&开头或包含=）
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        // 如果下一行是参数行（包含=且不以#EXTINF/http/rtmp/rtp开头）
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

/**
 * 生成分类ID（从分类名称生成安全的ID）
 * @param {string} categoryName - 分类名称
 * @returns {string} 分类ID
 */
function generateCategoryId(categoryName) {
  // 使用分类名称的hash作为ID，确保一致性
  let hash = 0;
  for (let i = 0; i < categoryName.length; i++) {
    const char = categoryName.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // 转为32位整数
  }
  return "cat_" + Math.abs(hash).toString(16);
}

// ==================== 缓存 ====================
let cachedChannels = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

/**
 * 获取所有频道（带缓存）
 * @returns {Promise<Array>} 频道列表
 */
async function getAllChannels() {
  const now = Date.now();
  if (cachedChannels && (now - cacheTimestamp) < CACHE_DURATION) {
    return cachedChannels;
  }

  const allChannels = [];

  // 从M3U源获取
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

// ==================== 插件核心方法 ====================

/**
 * 获取分类列表
 * @returns {Promise<Array>} 分类列表
 */
async function getCategories() {
  const channels = await getAllChannels();
  const categoryMap = new Map();

  // 统计每个分类的频道数
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

  // 转换为数组并按名称排序
  const categories = Array.from(categoryMap.values());
  categories.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  return categories;
}

/**
 * 获取分类下的房间列表
 * @param {string} categoryId - 分类ID
 * @param {number} page - 页码
 * @param {number} pageSize - 每页大小
 * @returns {Promise<Object>} 房间列表和分页信息
 */
async function getRooms(categoryId, page = 1, pageSize = 50) {
  const channels = await getAllChannels();

  // 过滤属于该分类的频道（通过ID匹配）
  const filteredChannels = channels.filter(channel => {
    const channelCategoryId = generateCategoryId(channel.category || "其他");
    return channelCategoryId === categoryId;
  });

  // 分页
  const total = filteredChannels.length;
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const pageChannels = filteredChannels.slice(start, end);

  // 转换为房间格式
  const rooms = pageChannels.map(channel => ({
    id: channel.id,
    title: channel.name,
    cover: channel.logo || "",
    anchor: channel.name,
    online: -1, // M3U源不显示在线人数
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
}

/**
 * 获取播放地址
 * @param {string} roomId - 房间ID
 * @returns {Promise<Object>} 播放地址信息
 */
async function getPlayback(roomId) {
  const channels = await getAllChannels();
  const channel = channels.find(c => c.id === roomId);

  if (!channel) {
    throw new Error(`频道不存在: ${roomId}`);
  }

  return {
    url: channel.url,
    title: channel.name,
    // M3U直播流通常不需要特殊headers
    headers: {}
  };
}

/**
 * 搜索频道
 * @param {string} keyword - 搜索关键词
 * @param {number} page - 页码
 * @param {number} pageSize - 每页大小
 * @returns {Promise<Object>} 搜索结果
 */
async function search(keyword, page = 1, pageSize = 50) {
  if (!keyword || keyword.trim() === "") {
    return {
      rooms: [],
      pagination: { page, pageSize, total: 0, hasMore: false }
    };
  }

  const channels = await getAllChannels();
  const keywordLower = keyword.toLowerCase();

  // 过滤匹配的频道
  const filteredChannels = channels.filter(channel => {
    const nameMatch = (channel.name || "").toLowerCase().includes(keywordLower);
    const categoryMatch = (channel.category || "").toLowerCase().includes(keywordLower);
    return nameMatch || categoryMatch;
  });

  // 分页
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
}

/**
 * 获取房间详情
 * @param {string} roomId - 房间ID
 * @returns {Promise<Object>} 房间详情
 */
async function getRoomDetail(roomId) {
  const channels = await getAllChannels();
  const channel = channels.find(c => c.id === roomId);

  if (!channel) {
    throw new Error(`频道不存在: ${roomId}`);
  }

  return {
    id: channel.id,
    title: channel.name,
    cover: channel.logo || "",
    anchor: channel.name,
    description: `${channel.category} - ${channel.name}`,
    online: -1,
    category: channel.category,
    // M3U直播通常没有开始时间
    startTime: null,
    // 直播状态：M3U源假设始终在线
    status: "live"
  };
}

/**
 * 获取直播状态
 * @param {string} roomId - 房间ID
 * @returns {Promise<Object>} 直播状态
 */
async function getLiveState(roomId) {
  const channels = await getAllChannels();
  const channel = channels.find(c => c.id === roomId);

  if (!channel) {
    return {
      isLive: false,
      viewerCount: 0,
      startTime: null
    };
  }

  // M3U源假设始终在线
  return {
    isLive: true,
    viewerCount: -1, // 未知
    startTime: null
  };
}

/**
 * 分享解析（M3U源不支持）
 * @param {string} shareUrl - 分享链接
 * @returns {Promise<null>} 始终返回null
 */
async function resolveShare(shareUrl) {
  // M3U直播源不支持分享解析
  return null;
}

/**
 * 获取弹幕连接信息（M3U源不支持弹幕）
 * @param {string} roomId - 房间ID
 * @returns {Promise<Object>} 弹幕连接信息
 */
async function getDanmakuInfo(roomId) {
  // M3U直播源不支持弹幕
  return {
    enabled: false,
    server: null,
    roomId: null,
    token: null
  };
}

// ==================== 导出 ====================

module.exports = {
  getCategories,
  getRooms,
  getPlayback,
  search,
  getRoomDetail,
  getLiveState,
  resolveShare,
  getDanmakuInfo
};
