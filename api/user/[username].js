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

// Search INSIDE an object, but skip any path containing excluded segments.
// We also skip keys that are not user-related if we are outside the user-detail scope.
function findRegionSafe(obj, depth = 0, path = '') {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;

  // Skip entire branches that are definitely noise
  const lowerPath = path.toLowerCase();
  if (lowerPath.includes('app-context') || lowerPath.includes('appcontext') ||
      lowerPath.includes('i18n') || lowerPath.includes('translations') ||
      lowerPath.includes('messages') || lowerPath.includes('__typename')) {
    return null;
  }

  // Check keys whose name contains "region" or "country"
  for (const key in obj) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('region') || lowerKey.includes('country')) {
      const val = obj[key];
      if (typeof val === 'string') {
        const code = val.trim().toUpperCase();
        if (isValidCountryCode(code)) return code;
        const m = code.match(/[_-]([A-Z]{2})$/);
        if (m && isValidCountryCode(m[1])) return m[1];
      }
    }
  }

  // Recurse into sub‑objects (but skip noise keys)
  for (const key in obj) {
    if (['i18n','translations','messages','appContext','app-context','__typename'].includes(key)) continue;
    const child = obj[key];
    if (child && typeof child === 'object') {
      const found = findRegionSafe(child, depth + 1, path ? `${path}.${key}` : key);
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

    // Extract main script
    const mainMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s);
    if (!mainMatch) return res.status(500).json({ error: 'Page structure changed' });

    const universal = JSON.parse(mainMatch[1]);
    const userDetail = universal?.['__DEFAULT_SCOPE__']?.['webapp.user-detail'];

    // Debug: return the raw userDetail (the only relevant part)
    if (debug === '1' || debug === 'all') {
      return res.status(200).json({ success: true, debug: true, userDetail });
    }

    if (!userDetail) return res.status(404).json({ error: 'User not found' });

    // 1. Direct extraction from the most common user‑object paths
    const userObjectsToTry = [
      userDetail?.userInfo?.user,
      userDetail?.user,
      userDetail?.userInfo,
      userDetail
    ];

    let region = null;
    for (const obj of userObjectsToTry) {
      if (!obj) continue;
      // Only consider objects that look like a user (have id, uniqueId, or secUid)
      if (obj.id || obj.uniqueId || obj.secUid) {
        const direct = obj.region || obj.accountRegion || obj.country || obj.countryCode;
        if (typeof direct === 'string' && isValidCountryCode(direct)) {
          region = direct.trim().toUpperCase();
          break;
        }
        // Also try a safe recursive scan inside this user object
        region = findRegionSafe(obj, 0, 'user');
        if (region) break;
      }
    }

    // 2. If still not found, perform a safe recursive scan over the whole userDetail
    if (!region) {
      region = findRegionSafe(userDetail, 0, 'userDetail');
    }

    res.status(200).json({
      success: true,
      username,
      region: region || null,
      regionSource: region ? 'user-detail' : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
