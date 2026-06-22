// api/user/[username].js

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
}

// ------------------ region extraction ------------------
function findRegionDeep(obj, depth = 0, path = '') {
  if (!obj || typeof obj !== 'object' || depth > 20) return null;
  const possibleKeys = ['region', 'accountRegion', 'regionCode', 'country', 'countryCode', 'locale', 'geo', 'location'];

  for (const actualKey in obj) {
    for (const key of possibleKeys) {
      if (actualKey.toLowerCase() === key.toLowerCase() && typeof obj[actualKey] === 'string') {
        const val = obj[actualKey];
        if (val.length === 2 && /^[A-Z]{2}$/.test(val)) return { value: val, source: `${path}.${actualKey}` };
      }
    }
  }
  // any two-letter uppercase string
  for (const key in obj) {
    if (typeof obj[key] === 'string' && obj[key].length === 2 && /^[A-Z]{2}$/.test(obj[key]))
      return { value: obj[key], source: `${path}.${key}` };
  }
  // recurse
  for (const key in obj) {
    if (obj[key] && typeof obj[key] === 'object') {
      const found = findRegionDeep(obj[key], depth + 1, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }
  return null;
}

function extractAllJsonFromHtml(html) {
  const jsonData = [];
  // __UNIVERSAL_DATA_FOR_REHYDRATION__
  const mainMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s);
  if (mainMatch) {
    try { jsonData.push(JSON.parse(mainMatch[1])); } catch (e) {}
  }
  // Other application/json scripts
  const allScripts = html.match(/<script[^>]*type="application\/json"[^>]*>(.*?)<\/script>/gis);
  if (allScripts) {
    for (const script of allScripts) {
      const match = script.match(/>([\s\S]*?)<\/script>/);
      if (match) try { jsonData.push(JSON.parse(match[1])); } catch (e) {}
    }
  }
  // __NEXT_DATA__ / __INITIAL_STATE__
  const inlineScripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  if (inlineScripts) {
    for (const script of inlineScripts) {
      const nextDataMatch = script.match(/__NEXT_DATA__\s*=\s*({[\s\S]*?});/);
      if (nextDataMatch) try { jsonData.push(JSON.parse(nextDataMatch[1])); } catch (e) {}
      const initStateMatch = script.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/);
      if (initStateMatch) try { jsonData.push(JSON.parse(initStateMatch[1])); } catch (e) {}
    }
  }
  return jsonData;
}
// -----------------------------------------------------

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    return res.status(200).end();
  }
  setCorsHeaders(res);

  // simple auth check
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

    // main user data
    let userDetail = null;
    const mainMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s);
    if (mainMatch) {
      try {
        const data = JSON.parse(mainMatch[1]);
        userDetail = data['__DEFAULT_SCOPE__']?.['webapp.user-detail'];
      } catch (e) {}
    }

    let regionInfo = null;
    if (userDetail) {
      regionInfo = findRegionDeep(userDetail);
      if (regionInfo?.value) regionInfo.source = `userDetail.${regionInfo.source}`;
    }

    // search all other JSON blobs
    if (!regionInfo?.value) {
      const allJsonData = extractAllJsonFromHtml(html);
      for (const jsonObj of allJsonData) {
        const found = findRegionDeep(jsonObj);
        if (found?.value) {
          regionInfo = found;
          regionInfo.source = `other_script.${regionInfo.source}`;
          break;
        }
      }
    }

    // fallback regex
    if (!regionInfo?.value) {
      const match = html.match(/"region":"([A-Z]{2})"/i) || html.match(/"accountRegion":"([A-Z]{2})"/i);
      if (match) regionInfo = { value: match[1], source: 'html_regex' };
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
