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

// Recursively find a valid country code, skipping known noise branches
function findRegionInObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;

  // Direct keys to try first
  for (const key of ['region', 'accountRegion', 'country', 'countryCode']) {
    const val = obj[key];
    if (typeof val === 'string' && val.length === 2 && VALID_COUNTRY_CODES.has(val.toUpperCase()))
      return val.toUpperCase();
    // Locale fallback: "en-US"
    if (typeof val === 'string') {
      const m = val.match(/[_-]([A-Z]{2})$/);
      if (m && VALID_COUNTRY_CODES.has(m[1])) return m[1];
    }
  }

  // Recurse into sub-objects, but skip translation/app-context/i18n
  for (const key in obj) {
    if (['i18n', 'translations', 'messages', 'appContext', 'app-context', '__typename'].includes(key)) continue;
    const val = obj[key];
    if (typeof val === 'object' && val !== null) {
      const found = findRegionInObject(val, depth + 1);
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
    if (!match) return res.status(500).json({ error: 'Page structure changed' });

    const universal = JSON.parse(match[1]);
    const userDetail = universal?.['__DEFAULT_SCOPE__']?.['webapp.user-detail'];

    if (debug === '1') {
      return res.status(200).json({ debug: true, userDetail });
    }

    if (!userDetail) return res.status(404).json({ error: 'User not found' });

    // Focus only on user-like objects: try known paths, then the whole userDetail
    const possibleUserObjects = [
      userDetail?.userInfo?.user,
      userDetail?.user,
      userDetail?.userInfo,
      userDetail
    ];

    let region = null;
    for (const obj of possibleUserObjects) {
      if (!obj) continue;
      // Must look like a user (has id or uniqueId)
      if (obj.id || obj.uniqueId || obj.secUid) {
        // Direct region check
        region = obj.region || obj.accountRegion || obj.country || obj.countryCode;
        if (region && typeof region === 'string' && region.length === 2 && VALID_COUNTRY_CODES.has(region.toUpperCase())) {
          region = region.toUpperCase();
          break;
        }
        // If direct check fails, try deeper search inside this user object
        region = findRegionInObject(obj);
        if (region) break;
      }
    }

    // If still nothing, try the entire userDetail with the same safe search
    if (!region) {
      region = findRegionInObject(userDetail);
    }

    res.status(200).json({
      success: true,
      username,
      region: region || null,
      regionSource: region ? 'extracted' : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
