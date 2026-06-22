// api/user/[username].js

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
}

// All ISO 3166-1 alpha-2 codes (same as before)
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

function extractRegionFromUserDetail(userDetail) {
  if (!userDetail || typeof userDetail !== 'object') return null;

  // Known paths (most → least common)
  const possiblePaths = [
    userDetail?.userInfo?.user,          // standard: { userInfo: { user: {...} } }
    userDetail?.user,                    // sometimes direct user object
    userDetail?.userInfo,                // occasionally userInfo is the user
    userDetail                           // fallback: userDetail itself could be the user
  ];

  for (const obj of possiblePaths) {
    if (!obj) continue;
    // Must look like a user (has uniqueId, id, or nickname)
    if (!obj.uniqueId && !obj.id && !obj.nickname) continue;
    // Check for region/country fields
    const region = obj.region || obj.accountRegion || obj.country || obj.countryCode;
    if (region && typeof region === 'string') {
      const code = region.trim().toUpperCase();
      if (code.length === 2 && VALID_COUNTRY_CODES.has(code)) return code;
      // If it's a locale like "en-US", extract the country part
      const m = code.match(/[_-]([A-Z]{2})$/);
      if (m && VALID_COUNTRY_CODES.has(m[1])) return m[1];
    }
  }

  // Last resort: scan only the userDetail object for any two-letter valid code
  // but skip known noise (i18n, translations)
  function deepScan(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 4) return null;
    // Ignore common noise branches
    if (obj.i18n || obj.translations || obj.messages || obj.appContext) return null;
    for (const key in obj) {
      if (['i18n','translations','messages','appContext','app-context'].includes(key)) continue;
      const val = obj[key];
      if (typeof val === 'string' && val.length === 2 && VALID_COUNTRY_CODES.has(val.toUpperCase())) {
        return val.toUpperCase();
      }
      if (typeof val === 'object') {
        const found = deepScan(val, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  return deepScan(userDetail);
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
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `TikTok returned ${response.status}` });
    }

    const html = await response.text();

    // Extract main JSON
    const mainMatch = html.match(
      /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s
    );
    if (!mainMatch) {
      return res.status(404).json({ error: 'Profile data not found (page structure changed or blocked)' });
    }

    const universalData = JSON.parse(mainMatch[1]);
    const userDetail = universalData?.['__DEFAULT_SCOPE__']?.['webapp.user-detail'];

    if (!userDetail) {
      return res.status(404).json({ error: 'User detail not found in page data' });
    }

    // If debug mode, return the raw structure (safely)
    if (debug === '1') {
      return res.status(200).json({
        success: true,
        debug: true,
        userDetail: userDetail, // full object – study it to find the correct path
      });
    }

    // Extract region
    const region = extractRegionFromUserDetail(userDetail);

    res.status(200).json({
      success: true,
      username,
      region: region || null,
      regionSource: region ? 'user-detail-direct' : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
