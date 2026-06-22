// api/user/[username].js

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
}

// Valid country codes (same as before)
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

// Path segments to exclude (i18n, translations)
const EXCLUDED_SEGMENTS = ['i18n', 'translation', 'translations', 'localeData', 'messages'];

function findRegionInObject(obj, path = '', depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 15) return null;
  // Skip excluded branches
  if (EXCLUDED_SEGMENTS.some(seg => path.toLowerCase().includes(seg.toLowerCase()))) return null;

  // Priority keys
  const priority = ['region', 'accountRegion', 'country', 'countryCode'];
  for (const key of priority) {
    const val = obj[key];
    if (typeof val === 'string') {
      if (val.length === 2 && VALID_COUNTRY_CODES.has(val.toUpperCase())) {
        return { value: val.toUpperCase(), source: `${path}.${key}` };
      }
      // locale like "en-US"
      const m = val.match(/[_-]([A-Z]{2})$/);
      if (m && VALID_COUNTRY_CODES.has(m[1])) {
        return { value: m[1], source: `${path}.${key}` };
      }
    }
  }

  // Any two‑letter valid code
  for (const key in obj) {
    const val = obj[key];
    if (typeof val === 'string' && val.length === 2 && VALID_COUNTRY_CODES.has(val.toUpperCase())) {
      return { value: val.toUpperCase(), source: `${path}.${key}` };
    }
  }

  // Recurse
  for (const key in obj) {
    const newPath = path ? `${path}.${key}` : key;
    if (EXCLUDED_SEGMENTS.some(seg => newPath.toLowerCase().includes(seg.toLowerCase()))) continue;
    const found = findRegionInObject(obj[key], newPath, depth + 1);
    if (found) return found;
  }
  return null;
}

// Check if an object looks like a user profile (contains uniqueId, nickname, secUid, etc.)
function isUserLike(obj) {
  return obj && typeof obj === 'object' && ('uniqueId' in obj || 'nickname' in obj || 'secUid' in obj);
}

// Extract region from a user-like object (direct check)
function regionFromUserObject(userObj) {
  const keys = ['region', 'accountRegion', 'country', 'countryCode'];
  for (const k of keys) {
    if (userObj[k] && typeof userObj[k] === 'string' && userObj[k].length === 2 && VALID_COUNTRY_CODES.has(userObj[k].toUpperCase())) {
      return userObj[k].toUpperCase();
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

    // 1. Extract main data script
    const mainMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">(.*?)<\/script>/s);
    let universalData = null;
    if (mainMatch) {
      try { universalData = JSON.parse(mainMatch[1]); } catch (e) {}
    }

    let regionInfo = null;

    // 2. Search within the userDetail object (most reliable)
    if (universalData) {
      const userDetail = universalData?.['__DEFAULT_SCOPE__']?.['webapp.user-detail'];
      if (userDetail) {
        // First, try to find a user-like object inside userDetail and extract region directly
        // Common patterns: userDetail.userInfo.user, userDetail.user, userDetail.userInfo, etc.
        const possibleUsers = [
          userDetail.userInfo?.user,
          userDetail.user,
          userDetail.userInfo,
          userDetail
        ];

        for (const maybeUser of possibleUsers) {
          if (isUserLike(maybeUser)) {
            const r = regionFromUserObject(maybeUser);
            if (r) {
              regionInfo = { value: r, source: 'user-object-direct' };
              break;
            }
          }
        }

        // If still not found, run recursive search on the whole userDetail (with exclusions)
        if (!regionInfo) {
          const found = findRegionInObject(userDetail, 'userDetail');
          if (found) {
            regionInfo = { value: found.value, source: `userDetail.${found.source}` };
          }
        }
      }
    }

    // 3. Fallback: look for any user-like object in the entire UNIVERSAL_DATA
    if (!regionInfo && universalData) {
      // Walk the whole data but only examine user-like objects and their immediate properties
      function deepSearchForUserRegion(obj, path = '') {
        if (!obj || typeof obj !== 'object') return null;
        if (EXCLUDED_SEGMENTS.some(s => path.toLowerCase().includes(s.toLowerCase()))) return null;

        if (isUserLike(obj)) {
          const r = regionFromUserObject(obj);
          if (r) return { value: r, source: path };
          // Also try recursive search inside this user-like object (but limit depth)
          const inner = findRegionInObject(obj, path, 0);
          if (inner) return inner;
        }

        for (const key in obj) {
          const newPath = path ? `${path}.${key}` : key;
          if (EXCLUDED_SEGMENTS.some(s => newPath.toLowerCase().includes(s.toLowerCase()))) continue;
          const found = deepSearchForUserRegion(obj[key], newPath);
          if (found) return found;
        }
        return null;
      }

      const found = deepSearchForUserRegion(universalData);
      if (found) {
        regionInfo = { value: found.value, source: `universal.${found.source}` };
      }
    }

    // 4. Last resort: regex on HTML (only valid country codes)
    if (!regionInfo) {
      const regex = /"region":"([A-Z]{2})"/gi;
      let m;
      while ((m = regex.exec(html)) !== null) {
        const code = m[1];
        if (VALID_COUNTRY_CODES.has(code)) {
          // Check not obviously in app-context
          const before = html.substring(0, m.index);
          if (!before.includes('app-context')) {
            regionInfo = { value: code, source: 'html_regex' };
            break;
          }
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
