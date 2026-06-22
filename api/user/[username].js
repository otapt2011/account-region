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

// IDC → country mapping (most common data centres)
const IDC_MAP = {
  'useast': 'US',
  'uswest': 'US',
  'europe': 'GB',
  'asia': 'SG',
  'ap': 'SG',
  'au': 'AU',
  'jp': 'JP',
  'kr': 'KR',
  'sa': 'SA',
};

function isValidCountryCode(val) {
  return typeof val === 'string' && val.length === 2 && VALID_COUNTRY_CODES.has(val.toUpperCase());
}

// Extract country from avatar URL's "idc" parameter
function extractCountryFromAvatar(url) {
  if (!url) return null;
  const match = url.match(/idc=([^&]+)/);
  if (!match) return null;
  const idc = match[1].toLowerCase();
  // Direct match
  if (IDC_MAP[idc]) return IDC_MAP[idc];
  // Prefix match (e.g., useast8 → useast)
  for (const prefix of Object.keys(IDC_MAP)) {
    if (idc.startsWith(prefix)) return IDC_MAP[prefix];
  }
  return null;
}

// Find region inside userDetail only (no app-context)
function findRegionInUserDetail(userDetail) {
  if (!userDetail) return null;

  // Direct fields inside user object
  const user = userDetail?.userInfo?.user || userDetail?.user || userDetail?.userInfo || userDetail;
  if (user?.id || user?.uniqueId || user?.secUid) {
    const direct = user.region || user.accountRegion || user.country || user.countryCode;
    if (isValidCountryCode(direct)) return direct.trim().toUpperCase();
  }

  // Safe recursive scan (exclude app-context, i18n, etc.)
  function scan(obj, depth = 0, path = '') {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    const lowerPath = path.toLowerCase();
    if (lowerPath.includes('app-context') || lowerPath.includes('appcontext') ||
        lowerPath.includes('i18n') || lowerPath.includes('translations') ||
        lowerPath.includes('messages') || lowerPath.includes('__typename')) return null;

    for (const key in obj) {
      if (['i18n','translations','messages','appContext','app-context','__typename'].includes(key)) continue;
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
      const child = obj[key];
      if (child && typeof child === 'object') {
        const found = scan(child, depth + 1, path ? `${path}.${key}` : key);
        if (found) return found;
      }
    }
    return null;
  }

  return scan(userDetail, 0, 'userDetail');
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

    const mainMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s);
    if (!mainMatch) return res.status(500).json({ error: 'Page structure changed' });

    const universal = JSON.parse(mainMatch[1]);
    const userDetail = universal?.['__DEFAULT_SCOPE__']?.['webapp.user-detail'];

    if (debug === '1' || debug === 'all') {
      return res.status(200).json({ success: true, debug: true, userDetail });
    }

    if (!userDetail) return res.status(404).json({ error: 'User not found' });

    // 1. Try to find region inside userDetail (ignoring app-context)
    let region = findRegionInUserDetail(userDetail);
    let source = 'user-detail';

    // 2. Fallback: app-context.region (now it's acceptable because we've confirmed userDetail lacks one)
    if (!region) {
      const appContext = universal?.['__DEFAULT_SCOPE__']?.['webapp.app-context'];
      if (appContext?.region && isValidCountryCode(appContext.region)) {
        region = appContext.region.toUpperCase();
        source = 'app-context';
      }
    }

    // 3. Last resort: avatar URL idc parameter
    if (!region) {
      const avatarUrl = userDetail?.userInfo?.user?.avatarLarger || userDetail?.user?.avatarLarger || '';
      region = extractCountryFromAvatar(avatarUrl);
      source = region ? 'avatar-idc' : null;
    }

    res.status(200).json({
      success: true,
      username,
      region: region || null,
      regionSource: source,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
