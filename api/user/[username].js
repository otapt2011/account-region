// api/user/[username].js

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
}

// ---------- ISO 3166‑1 alpha‑2 country code whitelist ----------
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
// ----------------------------------------------------------------

// Paths to exclude (app context, translations, etc.)
const EXCLUDED_PATH_SEGMENTS = [
  'app-context', 'appContext', 'context', 'serverContext', 'clientContext',
  'i18n', 'translation', 'translations', 'localeData', 'messages'
];

function findUserRegion(obj, depth = 0, path = '') {
  if (!obj || typeof obj !== 'object' || depth > 20) return null;
  // Skip entire branches that should never contain user location
  if (EXCLUDED_PATH_SEGMENTS.some(seg => path.toLowerCase().includes(seg.toLowerCase()))) return null;

  // Priority keys inside user objects
  const priorityKeys = ['region', 'accountRegion', 'country', 'countryCode', 'locale'];
  for (const key of priorityKeys) {
    if (obj[key] && typeof obj[key] === 'string') {
      const val = obj[key];
      // Direct two‑letter country code
      if (val.length === 2 && /^[A-Z]{2}$/.test(val) && VALID_COUNTRY_CODES.has(val)) {
        return { value: val, source: `${path}.${key}` };
      }
      // Locale string like "en-US"
      const localeMatch = val.match(/[_-]([A-Z]{2})$/);
      if (localeMatch && VALID_COUNTRY_CODES.has(localeMatch[1])) {
        return { value: localeMatch[1], source: `${path}.${key}` };
      }
    }
  }

  // Any two‑letter uppercase string that is a valid country code
  for (const key in obj) {
    if (typeof obj[key] === 'string' && obj[key].length === 2 && /^[A-Z]{2}$/.test(obj[key]) && VALID_COUNTRY_CODES.has(obj[key])) {
      return { value: obj[key], source: `${path}.${key}` };
    }
  }

  // Recurse into sub‑objects (skip excluded paths)
  for (const key in obj) {
    if (obj[key] && typeof obj[key] === 'object') {
      const newPath = path ? `${path}.${key}` : key;
      if (EXCLUDED_PATH_SEGMENTS.some(seg => newPath.toLowerCase().includes(seg.toLowerCase()))) continue;
      const found = findUserRegion(obj[key], depth + 1, newPath);
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

    // 1. Extract main user‑detail blob
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

    // 2. Direct check inside user object
    if (userDetail?.user) {
      const user = userDetail.user;
      const directKeys = ['region', 'accountRegion', 'country', 'countryCode'];
      for (const key of directKeys) {
        if (user[key] && typeof user[key] === 'string') {
          const val = user[key];
          if (val.length === 2 && /^[A-Z]{2}$/.test(val) && VALID_COUNTRY_CODES.has(val)) {
            regionInfo = { value: val, source: `userDetail.user.${key}` };
            break;
          }
        }
      }
    }

    // 3. Filtered deep search on the full UNIVERSAL_DATA
    if (!regionInfo?.value && mainMatch) {
      const data = JSON.parse(mainMatch[1]);
      const found = findUserRegion(data);
      if (found) {
        regionInfo = found;
        regionInfo.source = `universal.${regionInfo.source}`;
      }
    }

    // 4. Scan other JSON blobs (excluded paths already in the function)
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

    // 5. Final regex fallback (with validation)
    if (!regionInfo?.value) {
      const regionRegex = /"region":"([A-Z]{2})"/gi;
      let m;
      while ((m = regionRegex.exec(html)) !== null) {
        const val = m[1];
        if (!VALID_COUNTRY_CODES.has(val)) continue;
        // Check it's not inside an app‑context block
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
