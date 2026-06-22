// api/user/[username].js

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
}

// ---------- user‑specific region extraction ----------
const EXCLUDED_PATH_SEGMENTS = ['app-context', 'appContext', 'context', 'serverContext', 'clientContext'];

function findUserRegion(obj, depth = 0, path = '') {
  if (!obj || typeof obj !== 'object' || depth > 20) return null;
  if (EXCLUDED_PATH_SEGMENTS.some(seg => path.toLowerCase().includes(seg.toLowerCase()))) return null;

  // Priority keys that are typically inside user objects
  const priorityKeys = ['region', 'accountRegion', 'country', 'countryCode', 'locale'];
  for (const key of priorityKeys) {
    if (obj[key] && typeof obj[key] === 'string') {
      const val = obj[key];
      // Two‑letter country code
      if (val.length === 2 && /^[A-Z]{2}$/.test(val)) {
        return { value: val, source: `${path}.${key}` };
      }
      // Longer locale string (e.g., "en-US") – take last two chars
      const localeMatch = val.match(/[_-]([A-Z]{2})$/);
      if (localeMatch) {
        return { value: localeMatch[1], source: `${path}.${key}` };
      }
    }
  }

  // Generic check for any two‑letter uppercase string
  for (const key in obj) {
    if (typeof obj[key] === 'string' && obj[key].length === 2 && /^[A-Z]{2}$/.test(obj[key])) {
      return { value: obj[key], source: `${path}.${key}` };
    }
  }

  // Recurse into sub‑objects (but skip excluded paths)
  for (const key in obj) {
    if (obj[key] && typeof obj[key] === 'object') {
      const newPath = path ? `${path}.${key}` : key;
      // Skip if path contains an excluded segment
      if (EXCLUDED_PATH_SEGMENTS.some(seg => newPath.toLowerCase().includes(seg.toLowerCase()))) continue;
      const found = findUserRegion(obj[key], depth + 1, newPath);
      if (found) return found;
    }
  }
  return null;
}
// ----------------------------------------------------

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    return res.status(200).end();
  }
  setCorsHeaders(res);

  const authHeader = req.headers['x-api-key'] || req.headers['authorization'];
  if (authHeader !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Missing username' });

  try {
    const url = `https://www.tiktok.com/@${username}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const html = await response.text();

    // 1. Extract the main user‑detail blob
    let userDetail = null;
    const mainMatch = html.match(
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s
    );
    if (mainMatch) {
      try {
        const data = JSON.parse(mainMatch[1]);
        userDetail = data['__DEFAULT_SCOPE__']?.['webapp.user-detail'];
      } catch (e) {}
    }

    let regionInfo = null;

    // 2. Direct check inside the user object (most reliable)
    if (userDetail?.user) {
      const user = userDetail.user;
      const directKeys = ['region', 'accountRegion', 'country', 'countryCode'];
      for (const key of directKeys) {
        if (user[key] && typeof user[key] === 'string') {
          const val = user[key];
          if (val.length === 2 && /^[A-Z]{2}$/.test(val)) {
            regionInfo = { value: val, source: `userDetail.user.${key}` };
            break;
          }
        }
      }
    }

    // 3. If still not found, run filtered deep search on the whole __UNIVERSAL_DATA
    if (!regionInfo?.value && mainMatch) {
      const data = JSON.parse(mainMatch[1]);
      const found = findUserRegion(data);
      if (found) {
        regionInfo = found;
        regionInfo.source = `universal.${regionInfo.source}`;
      }
    }

    // 4. If still missing, scan other JSON blobs (with the same exclusion logic)
    if (!regionInfo?.value) {
      const otherJsonMatches = html.match(
        /<script[^>]*type="application\/json"[^>]*>(.*?)<\/script>/gis
      ) || [];
      for (const script of otherJsonMatches) {
        const match = script.match(/>([\s\S]*?)<\/script>/);
        if (!match) continue;
        try {
          const obj = JSON.parse(match[1]);
          const found = findUserRegion(obj);
          if (found) {
            regionInfo = found;
            regionInfo.source = `other_script.${regionInfo.source}`;
            break;
          }
        } catch (e) {}
      }
    }

    // 5. Final fallback: regex on HTML (but only for a real user region, not context)
    if (!regionInfo?.value) {
      const regionRegex = /"region":"([A-Z]{2})"/gi;
      let m;
      while ((m = regionRegex.exec(html)) !== null) {
        const val = m[1];
        // Ignore if it's inside an app-context block
        const before = html.substring(0, m.index);
        const lastContextIdx = before.lastIndexOf('app-context');
        if (lastContextIdx === -1 || before.substring(lastContextIdx).includes('user-detail')) {
          regionInfo = { value: val, source: 'html_regex' };
          break;
        }
      }
    }

    res.status(200).json({
      success: true,
      username,
      region: regionInfo?.value || null,
      regionSource: regionInfo?.source || null,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
