// api/user/[username].js

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
}

const VALID_COUNTRY_CODES = new Set([
  'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ',
  'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS',
  'BT','BV','BW','BY','BZ','CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN',
  'CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE',
  'EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR','GA','GB','GD','GE','GF',
  'GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HM',
  'HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM',
  'JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC',
  'LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MH','MK',
  'ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA',
  'NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG',
  'PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW',
  'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS',
  'ST','SV','SX','SY','SZ','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO',
  'TR','TT','TV','TW','TZ','UA','UG','UM','US','UY','UZ','VA','VC','VE','VG','VI',
  'VN','VU','WF','WS','YE','YT','ZA','ZM','ZW'
]);

function isValidCountryCode(val) {
  return typeof val === 'string' && val.length === 2 && VALID_COUNTRY_CODES.has(val.toUpperCase());
}

// Extract every JSON blob from the HTML
function extractAllJsonBlobs(html) {
  const blobs = [];

  // __UNIVERSAL_DATA_FOR_REHYDRATION__
  const mainMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s);
  if (mainMatch) {
    try { blobs.push({ source: 'UNIVERSAL_DATA', data: JSON.parse(mainMatch[1]) }); } catch(e) {}
  }

  // Other application/json scripts
  const otherScripts = html.match(/<script[^>]*type="application\/json"[^>]*>(.*?)<\/script>/gis);
  if (otherScripts) {
    for (const script of otherScripts) {
      const m = script.match(/>([\s\S]*?)<\/script>/);
      if (m) {
        try { blobs.push({ source: 'other_json', data: JSON.parse(m[1]) }); } catch(e) {}
      }
    }
  }

  // Inline scripts with __NEXT_DATA__ or __INITIAL_STATE__
  const inlineScripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  if (inlineScripts) {
    for (const script of inlineScripts) {
      const nextMatch = script.match(/__NEXT_DATA__\s*=\s*({[\s\S]*?});/);
      if (nextMatch) {
        try { blobs.push({ source: 'NEXT_DATA', data: JSON.parse(nextMatch[1]) }); } catch(e) {}
      }
      const initMatch = script.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/);
      if (initMatch) {
        try { blobs.push({ source: 'INITIAL_STATE', data: JSON.parse(initMatch[1]) }); } catch(e) {}
      }
    }
  }

  return blobs;
}

// Search a single JSON object for any property name that contains "region" or "country"
function findRegionInBlob(obj, depth = 0, path = '') {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;

  // Check all properties whose name includes region/country (case-insensitive)
  for (const key in obj) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('region') || lowerKey.includes('country')) {
      const val = obj[key];
      if (typeof val === 'string') {
        const code = val.trim().toUpperCase();
        if (isValidCountryCode(code)) return { value: code, source: `${path}.${key}` };
        // Locale like "en-US"
        const m = code.match(/[_-]([A-Z]{2})$/);
        if (m && isValidCountryCode(m[1])) return { value: m[1], source: `${path}.${key}` };
      }
    }
  }

  // Recurse, but skip obvious noise
  for (const key in obj) {
    if (['i18n','translations','messages','appContext','app-context','__typename'].includes(key)) continue;
    const child = obj[key];
    if (child && typeof child === 'object') {
      const found = findRegionInBlob(child, depth + 1, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }
  return null;
}

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

  const { username, debug } = req.query;
  if (!username) return res.status(400).json({ error: 'Missing username' });

  try {
    const url = `https://www.tiktok.com/@${username}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const html = await resp.text();

    const blobs = extractAllJsonBlobs(html);

    // Full debug mode: return all extracted JSON blobs
    if (debug === 'all') {
      return res.status(200).json({ success: true, debug: true, blobs });
    }

    if (blobs.length === 0) {
      return res.status(500).json({ error: 'No JSON data found on page' });
    }

    // Search each blob for a region field
    for (const blob of blobs) {
      const found = findRegionInBlob(blob.data, 0, blob.source);
      if (found) {
        return res.status(200).json({
          success: true,
          username,
          region: found.value,
          regionSource: `${blob.source} -> ${found.source}`
        });
      }
    }

    // Not found
    return res.status(200).json({
      success: true,
      username,
      region: null,
      regionSource: null,
      note: 'No property containing "region" or "country" with a valid country code was found in any JSON blob. Use debug=all to inspect all data.'
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
