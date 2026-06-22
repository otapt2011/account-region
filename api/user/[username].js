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

// Exhaustive scan: find any string that is a valid country code within the object,
// but only if we are inside a user-like subtree (to avoid app‑context).
// Returns the code or null.
function findAnyCountryCode(obj, depth = 0, path = '') {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;

  // Skip noise branches entirely
  const lowerPath = path.toLowerCase();
  if (lowerPath.includes('app-context') || lowerPath.includes('appcontext') ||
      lowerPath.includes('i18n') || lowerPath.includes('translations') ||
      lowerPath.includes('messages') || lowerPath.includes('__typename')) {
    return null;
  }

  // Check all string values for valid country codes
  for (const key in obj) {
    if (typeof obj[key] === 'string' && isValidCountryCode(obj[key].trim())) {
      return obj[key].trim().toUpperCase();
    }
  }

  // Recurse (skip noise keys)
  for (const key in obj) {
    if (['i18n','translations','messages','appContext','app-context','__typename'].includes(key)) continue;
    const child = obj[key];
    if (child && typeof child === 'object') {
      const found = findAnyCountryCode(child, depth + 1, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }
  return null;
}

// Find the user object within userDetail (the one that has id/uniqueId/secUid)
function findUserObject(userDetail) {
  const candidates = [
    userDetail?.userInfo?.user,
    userDetail?.user,
    userDetail?.userInfo,
    userDetail
  ];
  for (const obj of candidates) {
    if (obj && (obj.id || obj.uniqueId || obj.secUid)) return obj;
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

    const mainMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s);
    if (!mainMatch) return res.status(500).json({ error: 'Page structure changed' });

    const universal = JSON.parse(mainMatch[1]);
    const userDetail = universal?.['__DEFAULT_SCOPE__']?.['webapp.user-detail'];
    const appContext = universal?.['__DEFAULT_SCOPE__']?.['webapp.app-context'];

    // Debug: return full userDetail and app-context
    if (debug === 'all') {
      return res.status(200).json({ success: true, debug: true, userDetail, appContext });
    }

    if (!userDetail) return res.status(404).json({ error: 'User not found' });

    let region = null;
    let source = null;

    // 1. Search inside the user object (direct fields first, then exhaustive)
    const userObj = findUserObject(userDetail);
    if (userObj) {
      // Direct known keys
      region = userObj.region || userObj.accountRegion || userObj.country || userObj.countryCode;
      if (region && typeof region === 'string' && isValidCountryCode(region)) {
        region = region.trim().toUpperCase();
        source = 'user-detail-direct';
      } else {
        // Exhaustive search inside the user object (but still within that subtree)
        region = findAnyCountryCode(userObj, 0, 'user');
        if (region) source = 'user-detail-exhaustive';
      }
    }

    // 2. If still not found, fallback to app-context (only after user search fails)
    if (!region && appContext?.region && isValidCountryCode(appContext.region)) {
      region = appContext.region.toUpperCase();
      source = 'app-context';
    }

    // 3. Final fallback: avatar idc (not needed for khaby.lame but kept for completeness)
    if (!region) {
      const avatarUrl = userDetail?.userInfo?.user?.avatarLarger || userDetail?.user?.avatarLarger || '';
      const idcMatch = avatarUrl.match(/idc=([^&]+)/);
      if (idcMatch) {
        const idc = idcMatch[1].toLowerCase();
        const idcMap = { useast: 'US', europe: 'GB', asia: 'SG', ap: 'SG', au: 'AU', jp: 'JP', kr: 'KR', sa: 'SA' };
        for (const prefix of Object.keys(idcMap)) {
          if (idc.startsWith(prefix)) {
            region = idcMap[prefix];
            source = 'avatar-idc';
            break;
          }
        }
      }
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
