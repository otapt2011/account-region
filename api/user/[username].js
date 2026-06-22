// api/user/[username].js

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
}

// ISO 3166-1 alpha-2 whitelist
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

// Detect if a string is a valid country code (exactly 2 letters, known code)
function isValidCountryCode(val) {
  return typeof val === 'string' && val.length === 2 && VALID_COUNTRY_CODES.has(val.toUpperCase());
}

// Recursively search an object for any property whose name contains "region" or "country"
// (case-insensitive), and whose value is a valid country code.
function findRegionByKeyName(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;

  for (const key in obj) {
    const lowerKey = key.toLowerCase();
    // Look for property names that contain 'region' or 'country'
    if (lowerKey.includes('region') || lowerKey.includes('country')) {
      const val = obj[key];
      if (typeof val === 'string') {
        const code = val.trim().toUpperCase();
        if (isValidCountryCode(code)) return code;
        // Locale fallback: e.g., "en-US"
        const m = code.match(/[_-]([A-Z]{2})$/);
        if (m && isValidCountryCode(m[1])) return m[1];
      }
    }
  }

  // Recurse into sub-objects, but skip translation / i18n noise
  for (const key in obj) {
    if (['i18n', 'translations', 'messages', 'appContext', 'app-context', '__typename'].includes(key)) continue;
    const child = obj[key];
    if (child && typeof child === 'object') {
      const found = findRegionByKeyName(child, depth + 1);
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

    const match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s);
    if (!match) return res.status(500).json({ error: 'Page structure changed – script not found' });

    const universal = JSON.parse(match[1]);
    const userDetail = universal?.['__DEFAULT_SCOPE__']?.['webapp.user-detail'];

    if (debug === '1') {
      return res.status(200).json({ debug: true, userDetail });
    }

    if (!userDetail) return res.status(404).json({ error: 'User not found in page data' });

    // Search inside userDetail only
    const region = findRegionByKeyName(userDetail);

    res.status(200).json({
      success: true,
      username,
      region: region || null,
      regionSource: region ? 'property-name-match' : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
