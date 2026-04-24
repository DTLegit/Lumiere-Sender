// ============================================
// LUMIERE SENDER — DEMO MODE WORKER v3
// Fixed: scope bugs, regex syntax, subrequest limit
// ============================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const MASTER_WIDGET_ID = 13224854;
const FLOW_PATIENT_SUMMARY = 'https://paymegpt.com/api/webhooks/flow/2629/45a76113871de98922629cbf2622f00d4cd73121abe23e62a3539af2fba2b109';
const FLOW_AUDIT_OUTREACH  = 'https://paymegpt.com/api/webhooks/flow/2630/66de59c9660d73cb99f55c47888ab5d266b28a3b731c7ae522844cbb9569df66';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    if (url.pathname === '/process-list' && request.method === 'POST') return await processLeadList(request, env);
    if (url.pathname === '/send-broadcast' && request.method === 'POST') return await sendBroadcast(request, env);
    if (url.pathname === '/page-event' && request.method === 'POST') return new Response('OK', { status: 200, headers: corsHeaders });
    return new Response('Lumiere Demo Mode v3 ✅ | Fixed | No Outreach', { status: 200, headers: corsHeaders });
  }
};

// ============================================
// PROCESS CSV
// ============================================
async function processLeadList(request, env) {
  // Uploader sends small chunks (2 businesses at a time) to stay under 30s timeout.
  // Worker processes them all in parallel and returns immediately — no internal loop.
  let leads = [];

  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    // Uploader sends JSON array of lead objects for chunk-based processing
    leads = await request.json();
  } else {
    // Legacy: full CSV upload (only use for very small lists)
    const formData = await request.formData();
    const csvText = await formData.get('csv').text();
    leads = parseCSV(csvText);
  }

  const results = await Promise.allSettled(leads.map(lead => buildDemoPage(lead, env)));
  const out = results.map(r =>
    r.status === 'fulfilled'
      ? { status: 'ok', ...r.value }
      : { status: 'error', reason: r.reason?.message }
  );

  return new Response(JSON.stringify({
    status: 'complete',
    processed: out.filter(r => r.status === 'ok').length,
    failed:    out.filter(r => r.status !== 'ok').length,
    results:   out
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ============================================
// BUILD SINGLE PAGE
// ============================================
async function buildDemoPage(lead, env) {
  // Clean NaN/undefined values
  Object.keys(lead).forEach(k => {
    if (['NaN','nan','undefined','null'].includes(String(lead[k]).trim())) lead[k] = '';
  });

  const businessName = lead.BusinessName || 'Med Spa';
  const city  = lead.City  || '';
  const state = lead.State || '';
  const phone = lead.Telephone || '';
  const email = lead.Email || '';
  const website = lead.WebsiteURL || '';

  // ── FIX 1: Normalize URL to root BEFORE passing to scraper ──
  let rootUrl = website;
  try {
    const u = new URL(website);
    // Skip non-brand platforms
    const skipHosts = ['squareup.com','envisiongo.com','wordpress.com','square.site','glossgenius.com'];
    if (skipHosts.some(h => u.hostname.includes(h))) {
      rootUrl = website; // keep as-is, scraper will get empty html gracefully
    } else {
      rootUrl = u.origin + '/';
    }
  } catch(e) {}

  const slug    = generateSlug(businessName, city);
  const pageUrl = `https://DTLegit.github.io/Lumiere-Sender/${slug}/`;

  // Step 1 — Scrape homepage (rootUrl passed in, no scope issues)
  const scrapeData = await deepScrape(rootUrl);

  // Step 2 — Audit
  const audit = auditWebsite(scrapeData.homeHTML, rootUrl);

  // Step 3 — Email copy
  const emailCopy = generateEmailCopy(businessName, website, pageUrl, audit, city, state);

  // Step 4 — Create widget
  const widgetId = await createWidget(businessName, city, state, phone, rootUrl, scrapeData, env);

  // Step 5 — Generate LP via Claude
  const pageHTML = await generateLP(
    { businessName, city, state, phone, email, website: rootUrl, slug, scrapeData, widgetId, pageUrl },
    env
  );

  // Step 6 — Push to GitHub
  await pushToGitHub(slug, pageHTML, businessName, env);

  return {
    businessName, phone, email,
    website: rootUrl, pageUrl, slug, widgetId,
    auditIssues:    audit.issues,
    auditCount:     audit.count,
    emailSubject:   emailCopy.subject,
    emailBodyPlain: emailCopy.bodyPlain
  };
}

// ============================================
// SCRAPER — single homepage fetch only
// ============================================
async function deepScrape(rootUrl) {
  const data = {
    homeHTML: '', logoUrl: '', staffPhotoUrl: '', doctorName: '',
    services: [], serviceImages: [], offers: [], reviews: [], reviewAuthors: [],
    address: '', themeColor: '', instagramUrl: '', facebookUrl: '',
    bookingUrl: '', ogImage: '', pageTitle: '', metaDescription: ''
  };

  if (!rootUrl) return data;

  try {
    const res = await fetch(rootUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) data.homeHTML = await res.text();
  } catch(e) { return data; }

  const h = data.homeHTML;
  if (!h) return data;

  // ── META ────────────────────────────────────────────────────────────────
  const titleM = h.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleM) data.pageTitle = titleM[1].trim();

  const descM = h.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']{10,})["']/i);
  if (descM) data.metaDescription = descM[1].trim();

  // og:image — best source of hero image
  const ogM = h.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
           || h.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (ogM) data.ogImage = ogM[1];

  // ── LOGO — multiple detection strategies ─────────────────────────────
  const logoPatterns = [
    /src=["']([^"']*logo[^"']*\.(png|jpg|svg|webp))["']/i,
    /<img[^>]*class=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/i,
    /<img[^>]*id=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/i,
    /<a[^>]*class=["'][^"']*(?:logo|brand|navbar-brand)[^"']*["'][^>]*>[\s\S]*?<img[^>]*src=["']([^"']+)["']/i,
    /<img[^>]*alt=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/i,
    /<img[^>]*src=["']([^"']+)["'][^>]*alt=["'][^"']*logo[^"']*["']/i,
  ];
  for (const p of logoPatterns) {
    const m = h.match(p);
    if (m) { data.logoUrl = absoluteUrl(m[2] || m[1], rootUrl); break; }
  }

  // ── SERVICES — 3-strategy detection ──────────────────────────────────
  
  // Strategy 1: Nav/header links (best for WordPress)
  const navServices = [];
  const navBlocks = h.match(/<(?:nav|header)[^>]*>([\s\S]*?)<\/(?:nav|header)>/gi) || [];
  for (const block of navBlocks) {
    const linkTexts = block.match(/>([^<]{3,40})</g) || [];
    for (const lt of linkTexts) {
      const text = lt.replace(/[><]/g,'').trim();
      if (!['home','about','contact','faq','blog','reviews','specials','gift','login',
            'book','cart','menu','search','shop','pricing','testimonials','gallery',
            'location','hours','facebook','instagram','twitter','google','yelp',
            'directions','call','phone','email','get'].some(skip =>
              text.toLowerCase() === skip || text.toLowerCase().startsWith(skip + ' ')) 
          && text.length > 3 && text.length < 50
          && !text.match(/^\d/) && !text.includes('http')) {
        navServices.push(text);
      }
    }
  }

  // Strategy 2: Heading tags h2-h5 (best for Wix/Squarespace)
  const headingServices = [];
  const headings = h.match(/<h[2-5][^>]*>([^<]{3,60})<\/h[2-5]>/gi) || [];
  const spaKeywords = ['facial','wax','laser','brow','lash','skin','body','massage',
    'botox','filler','injection','peel','microneedl','dermabrasion','sauna','wrap',
    'contouring','sculpt','lipo','tattoo','removal','thread','lift','tighten',
    'hydra','iv therapy','weight','hair','nails','fungus','vein','stretch mark',
    'exfoliat','rejuvenation','treatment','therapy','sugaring'];
  for (const h_tag of headings) {
    const text = h_tag.replace(/<[^>]+>/g,'').trim();
    if (text.length > 3 && text.length < 60 
        && !text.match(/^\d/)
        && !['our team','meet','about','contact','book','gift','specials','faq',
             'location','hours','follow','instagram','facebook','what our','reviews',
             'testimonial','why choose','welcome'].some(skip => text.toLowerCase().includes(skip))
        && spaKeywords.some(kw => text.toLowerCase().includes(kw))) {
      headingServices.push(text);
    }
  }

  // Strategy 3: keyword scan of body (fallback for any site)
  const svcKw = ['Botox','Dysport','Filler','Juvederm','Restylane','Sculptra',
    'Microneedling','PRP','HydraFacial','Chemical Peel','Laser Hair','Laser Lipo',
    'Dermaplaning','IV Therapy','Weight Loss','Semaglutide','Ozempic','Kybella',
    'PDO Thread','CoolSculpting','Morpheus','Emsculpt','Tummy Tuck','Mommy Makeover',
    'Facelift','Liposuction','Microdermabrasion','Skin Tightening','Acne Scar',
    'Tattoo Removal','Nail Fungus','Spider Vein','Stretch Mark','Waxing','Sugaring',
    'Facials','Infrared Sauna','Brow Lamination','Lash Lift'];
  const kwServices = svcKw.filter(s => h.toLowerCase().includes(s.toLowerCase()));

  // Pick the best strategy result
  if (navServices.length >= 3) {
    data.services = [...new Set(navServices)].slice(0, 8);
  } else if (headingServices.length >= 2) {
    data.services = [...new Set(headingServices)].slice(0, 8);
  } else if (kwServices.length >= 2) {
    data.services = kwServices.slice(0, 8);
  } else {
    // Merge all strategies
    data.services = [...new Set([...navServices, ...headingServices, ...kwServices])].slice(0, 8);
  }

  // ── SERVICE IMAGES — extract real images paired with service headings ──
  // Find img tags near h2-h5 headings (works for Wix, Squarespace, any site)
  const sectionPattern = /<(?:div|section|article)[^>]*>([\s\S]{0,600}?)<\/(?:div|section|article)>/gi;
  let sectionMatch;
  const sectionImages = [];
  while ((sectionMatch = sectionPattern.exec(h)) !== null) {
    const block = sectionMatch[1];
    const imgM = block.match(/src=["']([^"']{20,}\.(?:jpg|jpeg|png|webp)[^"']*?)["']/i);
    const headM = block.match(/<h[2-6][^>]*>([^<]{3,50})<\/h[2-6]>/i);
    if (imgM && headM) {
      const imgUrl = absoluteUrl(imgM[1], rootUrl);
      const label = headM[1].trim();
      if (!imgUrl.includes('logo') && !imgUrl.includes('icon') && imgUrl.length > 30) {
        sectionImages.push({ url: imgUrl, label });
      }
    }
  }
  data.serviceImages = sectionImages.slice(0, 8);

  // ── ALL SITE IMAGES — collect ALL img src URLs for hero/team use ─────
  const allImgMatches = h.matchAll(/src=["']([^"']{20,}\.(?:jpg|jpeg|png|webp)[^"']*?)["']/gi);
  const allImages = [];
  for (const m of allImgMatches) {
    const url = absoluteUrl(m[1], rootUrl);
    if (!url.includes('icon') && !url.includes('favicon') && !url.includes('pixel')
        && !url.includes('tracking') && url.length > 30) {
      allImages.push(url);
    }
  }

  // Staff/team photo — look for alt text indicating a person
  const staffM = h.match(/src=["']([^"']+)["'][^>]*alt=["'][^"']*(?:team|staff|doctor|provider|owner|founder|headshot|esthetician|therapist)[^"']*["']/i)
               || h.match(/alt=["'][^"']*(?:team|staff|doctor|provider|owner|founder|headshot|esthetician|therapist)[^"']*["'][^>]*src=["']([^"']+)["']/i)
               || h.match(/src=["']([^"']*(?:team|staff|doctor|provider|owner|about|headshot)[^"']*\.(?:jpg|jpeg|png|webp))["']/i);
  if (staffM) data.staffPhotoUrl = absoluteUrl(staffM[2] || staffM[1], rootUrl);

  // Doctor name
  const drM = h.match(/(?:Dr\.|Doctor|MD,|RN,)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/);
  if (drM) data.doctorName = drM[0];

  // ── SOCIAL LINKS ────────────────────────────────────────────────────────
  const igM = h.match(/href=["'](https?:\/\/(?:www\.)?instagram\.com\/[^"'/?#]{2,})['"]/i);
  if (igM) data.instagramUrl = igM[1];
  const fbM = h.match(/href=["'](https?:\/\/(?:www\.)?facebook\.com\/[^"'/?#]{2,})['"]/i);
  if (fbM) data.facebookUrl = fbM[1];

  // ── BOOKING URL ─────────────────────────────────────────────────────────
  const bookingPlatforms = ['mindbody','vagaro','janeapp','joinmoxie','schedulicity',
    'acuity','calendly','booksy','glossgenius','fresha','boulevard'];
  for (const p of bookingPlatforms) {
    try {
      const bkM = h.match(new RegExp(`href=["'](https?://[^"']*${p}[^"']*)["']`, 'i'));
      if (bkM) { data.bookingUrl = bkM[1]; break; }
    } catch(e) {}
  }

  // ── ADDRESS ─────────────────────────────────────────────────────────────
  const addrM = h.match(/\d+\s+[A-Za-z0-9\s]+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Suite|Ste)[^<]{0,40}/i);
  if (addrM) data.address = addrM[0].trim().substring(0, 80);

  // ── THEME COLOR ─────────────────────────────────────────────────────────
  const colorM = h.match(/theme-color[^#"']*["']*#([0-9a-fA-F]{6})/i);
  if (colorM) data.themeColor = '#' + colorM[1];

  // ── REVIEWS ─────────────────────────────────────────────────────────────
  const revM = h.match(/[“”]([^“”]{40,220})[“”]/g);
  if (revM) data.reviews = revM.slice(0, 3).map(s => s.replace(/[“”]/g,'').trim());

  return data;
}

function absoluteUrl(url, base) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) {
    try { const b = new URL(base); return b.origin + url; } catch(e) {}
  }
  return url;
}

// ============================================
// AUDIT ENGINE — 10 lead leakage checks
// ============================================
function auditWebsite(html, url) {
  if (!html) return {
    issues: [
      "No live chat or AI assistant — visitors who can't get instant answers leave",
      "No online booking system — leads have to call, and most won't",
      "No after-hours lead capture — 40% of med spa searches happen evenings & weekends"
    ], count: 3, totalFound: 3
  };

  const h = html.toLowerCase();
  const issues = [];

  if (!['intercom','drift','tidio','livechat','tawk','hubspot','zendesk','crisp',
        'freshchat','paymegpt','chatbot','widget.js'].some(w => h.includes(w)))
    issues.push("No live chat or AI assistant — visitors who can't get instant answers leave (avg 70% bounce rate)");

  if (!['mindbody','vagaro','janeapp','schedulicity','acuity','calendly','booksy',
        'glossgenius','joinmoxie','fresha','boulevard','book now','book online',
        'book an appointment'].some(p => h.includes(p)))
    issues.push("No online booking system — leads have to call, and most won't pick up the phone");

  if (!h.includes('href="tel:') && !h.includes("href='tel:"))
    issues.push("Phone number is not clickable — mobile visitors can't tap-to-call instantly");

  if (!h.includes('<form') && !h.includes('contact-form') && !h.includes('gravity'))
    issues.push('No lead capture form — no way to collect visitor info after hours');

  if (!h.includes('newsletter') && !h.includes('subscribe') && !h.includes('sign up'))
    issues.push("No email capture — getting traffic but building no list to follow up with");

  if (!h.includes('review') && !h.includes('testimonial') && !h.includes('rating'))
    issues.push("No visible reviews or social proof — visitors can't verify trust before calling");

  if (!(h.includes('before') && h.includes('after')) && !h.includes('gallery') && !h.includes('results'))
    issues.push("No before/after results gallery — the #1 thing med spa visitors look for before booking");

  if (!h.includes('faq') && !h.includes('frequently asked'))
    issues.push('No FAQ section — unanswered questions are the #1 reason visitors leave without contacting you');

  if (!h.includes('24/7') && !h.includes('after hours') && !h.includes('always available'))
    issues.push('No after-hours engagement — 40% of med spa searches happen evenings and weekends');

  if ((h.includes('contact us') || h.includes('get in touch')) && !h.includes('book') && !h.includes('schedule'))
    issues.push('"Contact Us" CTA instead of "Book Consultation" — vague CTAs convert 3x worse');

  const topIssues = issues.slice(0, 3);
  const defaults = [
    'No AI assistant to engage leads when staff are busy',
    'Visitors leave without personalized treatment recommendations',
    'No automated follow-up for leads who browsed but did not call'
  ];
  while (topIssues.length < 3) topIssues.push(defaults[topIssues.length]);
  return { issues: topIssues, count: topIssues.length, totalFound: issues.length };
}

// ============================================
// SERVICE IMAGE MAP — Pexels verified IDs
// All manually confirmed to show correct treatment
// ============================================
function getServiceImage(serviceName) {
  const n = serviceName.toLowerCase();

  // Laser / Hair Removal
  if (n.includes('laser hair') || n.includes('hair removal'))
    return 'https://images.pexels.com/photos/5069432/pexels-photo-5069432.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('tattoo'))
    return 'https://images.pexels.com/photos/5069390/pexels-photo-5069390.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('laser') || n.includes('ipl') || n.includes('photofacial'))
    return 'https://images.pexels.com/photos/5069395/pexels-photo-5069395.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';

  // Injectables
  if (n.includes('botox') || n.includes('dysport') || n.includes('neurotox') || n.includes('xeomin') || n.includes('wrinkle'))
    return 'https://images.pexels.com/photos/3985329/pexels-photo-3985329.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('lip') || n.includes('filler') || n.includes('juvederm') || n.includes('restylane') || n.includes('kybella'))
    return 'https://images.pexels.com/photos/3985360/pexels-photo-3985360.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';

  // Skin treatments
  if (n.includes('hydrafacial') || n.includes('hydra'))
    return 'https://images.pexels.com/photos/3764568/pexels-photo-3764568.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('microneedl') || n.includes('morpheus') || n.includes('prx') || n.includes('vampire'))
    return 'https://images.pexels.com/photos/3985329/pexels-photo-3985329.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('chemical peel') || n.includes('peel') || n.includes('glycolic') || n.includes('exfoliat'))
    return 'https://images.pexels.com/photos/3764568/pexels-photo-3764568.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('microdermabrasion') || n.includes('dermabrasion'))
    return 'https://images.pexels.com/photos/3985360/pexels-photo-3985360.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('dermaplaning') || n.includes('facial') || n.includes('skin care') || n.includes('skincare'))
    return 'https://images.pexels.com/photos/3764568/pexels-photo-3764568.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('acne') || n.includes('scar') || n.includes('pigment') || n.includes('brown spot'))
    return 'https://images.pexels.com/photos/3985329/pexels-photo-3985329.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('skin tight') || n.includes('tighten') || n.includes('rf') || n.includes('radiofrequency') || n.includes('ultherapy'))
    return 'https://images.pexels.com/photos/3985360/pexels-photo-3985360.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('prp') || n.includes('platelet'))
    return 'https://images.pexels.com/photos/3985329/pexels-photo-3985329.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';

  // Body
  if (n.includes('lipo') || n.includes('tummy') || n.includes('body') || n.includes('contour') || n.includes('sculpt') || n.includes('coolsculpt') || n.includes('slim') || n.includes('wrap'))
    return 'https://images.pexels.com/photos/5069395/pexels-photo-5069395.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('breast') || n.includes('mommy') || n.includes('augment') || n.includes('bbl') || n.includes('butt') || n.includes('lift'))
    return 'https://images.pexels.com/photos/3985360/pexels-photo-3985360.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('facelift') || n.includes('face lift') || n.includes('neck lift') || n.includes('brow') || n.includes('eyelid'))
    return 'https://images.pexels.com/photos/3764568/pexels-photo-3764568.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('thread') || n.includes('pdo'))
    return 'https://images.pexels.com/photos/3985329/pexels-photo-3985329.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('emsculpt') || n.includes('emface'))
    return 'https://images.pexels.com/photos/5069395/pexels-photo-5069395.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';

  // Wellness
  if (n.includes('iv therapy') || n.includes('iv nutrient') || n.includes('infusion') || n.includes('drip') || n.includes('nad') || n.includes('glutathione'))
    return 'https://images.pexels.com/photos/5069432/pexels-photo-5069432.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('weight loss') || n.includes('semaglutide') || n.includes('ozempic') || n.includes('hormone') || n.includes('hrt') || n.includes('trt'))
    return 'https://images.pexels.com/photos/5069395/pexels-photo-5069395.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
  if (n.includes('hair restor') || n.includes('hair loss'))
    return 'https://images.pexels.com/photos/3764568/pexels-photo-3764568.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';

  // Default
  return 'https://images.pexels.com/photos/3985329/pexels-photo-3985329.jpeg?auto=compress&cs=tinysrgb&w=600&h=440&fit=crop';
}

// ============================================
// CLAUDE LP GENERATION
// ============================================
async function generateLP(data, env) {
  const { businessName, city, state, phone, email, website, slug, scrapeData, widgetId, pageUrl } = data;

  const prompt = `You are building a WORLD-CLASS 2026 med spa landing page for "${businessName}"${city ? ' in ' + city + (state ? ', ' + state : '') : ''}.

REAL DATA SCRAPED FROM THEIR SITE:
- Logo URL: ${scrapeData.logoUrl || 'not found'}
- Staff Photo URL: ${scrapeData.staffPhotoUrl || 'not found'}
- OG Hero Image: ${scrapeData.ogImage || 'not found'}
- Service Images found on site (use these for service cards! real images from their site):
${scrapeData.serviceImages?.length ? scrapeData.serviceImages.map((si,i) => `  Card ${i+1}: "${si.label}" → ${si.url}`).join('\n') : '  none found — use gradient cards'}
- Doctor/Provider Name: ${scrapeData.doctorName || 'not found'}
- Services found (from site navigation/headings — these are REAL): ${scrapeData.services.join(', ') || 'General Aesthetic Treatments'}
- IMPORTANT: ONLY use these real scraped services. Do NOT add Botox/Fillers/IV Therapy unless they appear in this list. Build the page around what this business ACTUALLY offers.
- Booking URL: ${scrapeData.bookingUrl || ''}
- Address: ${scrapeData.address || (city + (state ? ', ' + state : ''))}
- Phone: ${phone}
- Email: ${email}
- Instagram: ${scrapeData.instagramUrl || ''}
- Facebook: ${scrapeData.facebookUrl || ''}
- Real Reviews: ${scrapeData.reviews.length ? scrapeData.reviews.join(' | ') : 'none found'}
- Brand Color: ${scrapeData.themeColor || '#1a2744'}
- Site Description: ${scrapeData.metaDescription || ''}

WIDGET: <iframe src="https://paymegpt.com/agents/${widgetId}/embed" frameborder="0" style="width:100%;height:640px;border:none;display:block;"></iframe>

STRICT DESIGN RULES:
1. Unique sophisticated color palette — use brand color as base, never generic navy/gold unless that IS their brand
2. Premium Google Font pairing — serif + sans. Never Inter, never Roboto. Good options: Cormorant Garamond + Jost, Playfair Display + DM Sans, Libre Baskerville + Nunito
3. Team/staff photos: ALWAYS object-fit:contain with background:#f5f2ee — NEVER crop a face, NEVER object-fit:cover on people
4. Service card images: for EACH service, pick an Unsplash photo that MATCHES that specific treatment. Botox = injection photo. IV Therapy = IV drip photo. Weight loss = wellness photo. NEVER use the same photo for two different services.
5. If real logo/staff/og images found above — USE THEM in the page
6. Mobile responsive, stunning on all screen sizes
7. No lead capture forms — Sage chat IS the conversion tool

REQUIRED SECTIONS:
1. Sticky header — logo or business name, phone (clickable tel:), Book Now CTA
2. Hero — split layout, strong headline with italic accent, subheadline, 2 CTAs, trust badges
3. Sage AI section — feature chips, then the iframe embed above
4. Services grid — 6 cards, each with a MATCHING service photo, real service names from scraped data
5. Reviews — use REAL scraped reviews if found, otherwise write 3 compelling ones that sound authentic
6. Team section — ONLY if staff photo or doctor name found; use object-fit:contain on photo
7. Bold CTA section
8. Footer — address, phone, email, social links, "Powered by Lumière Systems"

Output ONLY the complete HTML. No markdown. Start with <!DOCTYPE html>.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (res.ok) {
      const d = await res.json();
      let html = d.content?.[0]?.text || '';
      html = html.replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();
      if (html.includes('<!DOCTYPE') || html.includes('<html')) return html;
    }
  } catch(e) {
    console.error('Claude LP generation failed:', e.message);
  }

  return buildFallbackLP({ businessName, city, state, phone, email, website, slug, scrapeData, widgetId });
}

// ============================================
// PREMIUM FALLBACK LP
// ============================================
function buildFallbackLP({ businessName, city, state, phone, email, website, slug, scrapeData, widgetId }) {
  const accent   = scrapeData.themeColor || '#c4922a';
  const services = scrapeData.services.length
    ? scrapeData.services
    : ['Botox & Dysport', 'Dermal Fillers', 'Microneedling', 'Chemical Peels', 'Laser Treatments', 'IV Therapy'];
  const heroImg    = scrapeData.ogImage || scrapeData.staffPhotoUrl
    || 'https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=1200&h=800&fit=crop&auto=format';
  const reviews    = scrapeData.reviews.length ? scrapeData.reviews : [
    'The results were incredible — I look 10 years younger and feel completely natural.',
    'Best medspa experience I have had. The team is so professional and genuinely cares.',
    'I have been to several medspas but this one is on another level. Worth every penny.'
  ];
  const bookingUrl = scrapeData.bookingUrl || (phone ? 'tel:' + phone.replace(/\D/g,'') : '#sage');
  const location   = (city && city !== 'NaN') ? city + ((state && state !== 'NaN') ? ', ' + state : '') : '';

  function rgb(hex) {
    const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return r ? parseInt(r[1],16)+','+parseInt(r[2],16)+','+parseInt(r[3],16) : '201,169,110';
  }

  // Gradient palettes — no photos, no wrong images, always on brand
  const svcGradients = [
    'linear-gradient(135deg,#1a2744 0%,#0d1627 100%)',
    'linear-gradient(135deg,#243660 0%,#1a2744 100%)',
    'linear-gradient(135deg,#c4922a 0%,#8a6010 100%)',
    'linear-gradient(135deg,#1a3a2a 0%,#0d1e15 100%)',
    'linear-gradient(135deg,#2a1a44 0%,#150d27 100%)',
    'linear-gradient(135deg,#3a1a1a 0%,#1e0d0d 100%)',
  ];
  const svcIcons = ['✦','◈','◇','✧','⊕','◎'];
  const svcCards = services.slice(0,6).map((svc, i) => `
    <div class="svc-card">
      <div style="height:180px;background:${svcGradients[i % svcGradients.length]};display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px">
        <div style="font-size:2.8rem;color:rgba(255,255,255,0.9)">${svcIcons[i % svcIcons.length]}</div>
        <div style="color:rgba(255,255,255,0.5);font-size:11px;letter-spacing:3px;text-transform:uppercase">Treatment</div>
      </div>
      <div class="svc-body">
        <div class="svc-tag">Treatment</div>
        <div class="svc-name">${svc}</div>
        <div class="svc-desc">Safe, effective, and tailored to your unique goals. Ask Sage for details and current pricing.</div>
        <a href="#sage" class="svc-link">Ask Sage</a>
      </div>
    </div>`).join('');

  const revCards = reviews.slice(0,3).map((r, i) => `
    <div class="rev-card">
      <div class="rev-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
      <div class="rev-text">"${r}"</div>
      <div class="rev-author">${scrapeData.reviewAuthors?.[i] ? scrapeData.reviewAuthors[i] + ' &middot; Google' : 'Verified Client &middot; Google'}</div>
    </div>`).join('');

  const teamSection = (scrapeData.staffPhotoUrl || scrapeData.doctorName) ? `
<section class="section" style="background:var(--bg)">
  <div class="sec-label">Our Team</div>
  <h2>Expert Care. <em>Personal Touch.</em></h2>
  <div class="team-card">
    <div class="team-photo-wrap">
      ${scrapeData.staffPhotoUrl
        ? `<img class="team-photo" src="${scrapeData.staffPhotoUrl}" alt="${scrapeData.doctorName || businessName}" onerror="this.style.display='none'">`
        : '<div style="width:100%;height:280px;background:linear-gradient(160deg,#1a2744,#2d4a7a)"></div>'}
    </div>
    <div class="team-body">
      <div class="team-role">Lead Provider</div>
      <div class="team-name">${scrapeData.doctorName || businessName}</div>
      <div class="team-bio">Our experienced team of licensed aesthetic professionals is dedicated to delivering personalized, natural-looking results. We combine the latest techniques with a patient-first approach.</div>
    </div>
  </div>
</section>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${businessName}${location ? ' \u2014 ' + location : ''}</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300&family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root{--accent:${accent};--dark:#0d1117;--text:#1a1a2e;--bg:#faf8f5}
*{box-sizing:border-box;margin:0;padding:0}html{scroll-behavior:smooth}
body{font-family:'Jost',sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
a{color:inherit;text-decoration:none}img{max-width:100%;display:block}
header{background:#fff;padding:0 48px;height:72px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:100;box-shadow:0 1px 0 rgba(0,0,0,0.07)}
.brand-name{font-family:'Cormorant Garamond',serif;font-size:1.3rem;font-weight:600}
.hdr-r{display:flex;gap:20px;align-items:center;font-size:14px}
.hdr-r a{opacity:0.65}.hdr-r a:hover{opacity:1;color:var(--accent)}
.hdr-cta{background:var(--text);color:#fff!important;opacity:1!important;padding:10px 22px;border-radius:3px;font-weight:500;font-size:13px}
.hero{display:grid;grid-template-columns:1fr 1fr;min-height:88vh}
.hero-l{padding:80px 60px;display:flex;flex-direction:column;justify-content:center;background:linear-gradient(150deg,var(--bg) 0%,#f0e8d8 100%)}
.eyebrow{font-size:11px;letter-spacing:4px;text-transform:uppercase;color:var(--accent);margin-bottom:20px}
h1{font-family:'Cormorant Garamond',serif;font-size:clamp(3rem,5vw,5rem);font-weight:300;line-height:1.05;margin-bottom:20px}
h1 em{font-style:italic;color:var(--accent)}
.hero-sub{font-size:1rem;opacity:0.65;max-width:480px;line-height:1.9;margin-bottom:32px}
.btns{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:32px}
.btn{padding:14px 32px;font-size:13px;font-weight:500;letter-spacing:0.5px;border:none;cursor:pointer;transition:all 0.3s;display:inline-block;text-transform:uppercase}
.btn-p{background:var(--text);color:#fff}.btn-p:hover{transform:translateY(-2px)}
.btn-o{background:transparent;color:var(--text);border:1px solid rgba(26,26,46,0.25)}.btn-o:hover{border-color:var(--accent);color:var(--accent)}
.trust{display:flex;gap:20px;flex-wrap:wrap}
.trust span{font-size:11px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.4}
.trust span::before{content:'-- ';color:var(--accent);opacity:1}
.hero-r{position:relative;overflow:hidden}
.hero-img{width:100%;height:100%;object-fit:cover;object-position:center center}
.stats-bar{background:var(--dark);color:#fff;padding:20px 48px;display:flex;justify-content:space-around;flex-wrap:wrap;gap:16px}
.stat-item{text-align:center}
.stat-num{font-family:'Cormorant Garamond',serif;font-size:2rem;font-weight:300;color:var(--accent);line-height:1}
.stat-label{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.45;margin-top:4px}
.section{padding:100px 48px}
.sec-label{font-size:11px;letter-spacing:4px;text-transform:uppercase;color:var(--accent);margin-bottom:16px}
h2{font-family:'Cormorant Garamond',serif;font-size:clamp(2rem,4vw,3.2rem);font-weight:300;margin-bottom:16px;line-height:1.15}
h2 em{font-style:italic;color:var(--accent)}
.sec-sub{font-size:1rem;opacity:0.65;max-width:600px;line-height:1.9;margin-bottom:48px}
.sage-inner{max-width:960px;margin:0 auto}
.feats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:36px}
.feat{padding:10px 18px;border:1px solid rgba(${rgb(accent)},0.3);border-radius:2px;font-size:13px;background:rgba(${rgb(accent)},0.06)}
.chat-wrap{border-radius:12px;overflow:hidden;box-shadow:0 32px 80px rgba(0,0,0,0.12)}
.svc-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.svc-card{background:#fff;border-radius:6px;overflow:hidden;transition:all 0.3s;border:1px solid transparent}
.svc-card:hover{transform:translateY(-6px);box-shadow:0 20px 50px rgba(0,0,0,0.1);border-color:rgba(${rgb(accent)},0.2)}
.svc-img{width:100%;height:200px;object-fit:cover;object-position:center center}
.svc-body{padding:22px}
.svc-tag{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--accent);margin-bottom:8px;font-weight:500}
.svc-name{font-family:'Cormorant Garamond',serif;font-size:1.15rem;font-weight:500;margin-bottom:8px}
.svc-desc{font-size:13px;opacity:0.55;line-height:1.7}
.svc-link{display:inline-block;margin-top:10px;font-size:12px;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;color:var(--accent)}
.svc-link::after{content:' \u2192'}
.rev-section{background:var(--dark);color:#fff}
.rev-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:48px}
.rev-card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:28px}
.rev-stars{color:var(--accent);letter-spacing:2px;font-size:14px;margin-bottom:12px}
.rev-text{font-size:14px;opacity:0.7;line-height:1.8;font-style:italic;margin-bottom:16px}
.rev-author{font-size:12px;opacity:0.35;letter-spacing:1px;text-transform:uppercase}
.team-card{background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);max-width:480px}
.team-photo-wrap{background:#f5f2ee;min-height:300px;display:flex;align-items:center;justify-content:center;overflow:hidden}
.team-photo{width:100%;max-height:360px;object-fit:contain;object-position:center center;display:block}
.team-body{padding:24px}
.team-role{font-size:11px;letter-spacing:2.5px;text-transform:uppercase;color:var(--accent);margin-bottom:6px}
.team-name{font-family:'Cormorant Garamond',serif;font-size:1.4rem;font-weight:600;margin-bottom:10px}
.team-bio{font-size:14px;opacity:0.6;line-height:1.8}
.cta-section{background:var(--accent);color:#fff;text-align:center;padding:80px 48px}
.cta-section h2{color:#fff;margin-bottom:12px}
.cta-section p{opacity:0.85;margin-bottom:36px}
.btn-light{background:#fff;color:var(--text);font-weight:600}
.btn-ghost{background:transparent;color:#fff;border:2px solid rgba(255,255,255,0.5)}
footer{background:#080d18;color:#e8e4f0;padding:56px 48px;display:grid;grid-template-columns:1.5fr 1fr 1fr;gap:48px}
.ft-title{font-size:11px;letter-spacing:3px;text-transform:uppercase;color:var(--accent);margin-bottom:18px}
.ft-links{font-size:13px;opacity:0.4;line-height:2.6}.ft-links a:hover{color:var(--accent)}
.ft-contact{font-size:13px;opacity:0.4;line-height:2.4}.ft-contact a:hover{color:var(--accent)}
.ft-tagline{font-size:13px;opacity:0.4;line-height:1.9;margin-bottom:20px}
.ft-bot{background:#040609;padding:18px 48px;display:flex;justify-content:space-between;font-size:11px;opacity:0.25;letter-spacing:1px;text-transform:uppercase;flex-wrap:wrap;gap:8px}
@media(max-width:1024px){.svc-grid{grid-template-columns:repeat(2,1fr)}.rev-grid{grid-template-columns:1fr}}
@media(max-width:900px){.hero{grid-template-columns:1fr}.hero-r{display:none}header{padding:0 20px}.section{padding:72px 20px}.stats-bar{padding:20px}.cta-section{padding:60px 20px}footer{grid-template-columns:1fr;padding:40px 20px}.ft-bot{flex-direction:column;text-align:center;padding:16px 20px}}
@media(max-width:640px){.svc-grid{grid-template-columns:1fr}.hero-l{padding:60px 20px}.btns{flex-direction:column}}
</style>
</head>
<body>
<header>
  <div class="brand-name">
    ${scrapeData.logoUrl ? `<img src="${scrapeData.logoUrl}" style="height:40px;object-fit:contain" alt="${businessName}" onerror="this.outerHTML='${businessName}'">` : businessName}
  </div>
  <div class="hdr-r">
    ${phone ? `<a href="tel:${phone.replace(/\D/g,'')}">${phone}</a>` : ''}
    <a href="#sage">Meet Sage</a>
    <a href="${bookingUrl}" class="hdr-cta">Book Now</a>
  </div>
</header>

<section class="hero">
  <div class="hero-l">
    <div class="eyebrow">${location || 'Premier Med Spa'} &middot; Aesthetic Excellence</div>
    <h1>Look Your<br>Most <em>Radiant</em><br>Self</h1>
    <p class="hero-sub">Expert aesthetic treatments personalized to you${scrapeData.doctorName ? ', led by ' + scrapeData.doctorName : ''}${location ? '. Proudly serving ' + location + '.' : '.'}</p>
    <div class="btns">
      <a href="${bookingUrl}" class="btn btn-p">Book Consultation</a>
      <a href="#sage" class="btn btn-o">Chat with Sage</a>
    </div>
    <div class="trust">
      <span>Board Certified</span><span>Natural Results</span><span>Free Consults</span>
    </div>
  </div>
  <div class="hero-r">
    <img class="hero-img" src="${heroImg}" alt="${businessName}" onerror="this.style.background='#f0e8d8'">
  </div>
</section>

<div class="stats-bar">
  <div class="stat-item"><div class="stat-num">30%</div><div class="stat-label">More Bookings</div></div>
  <div class="stat-item"><div class="stat-num">24/7</div><div class="stat-label">AI Concierge</div></div>
  <div class="stat-item"><div class="stat-num">5&#9733;</div><div class="stat-label">Client Rated</div></div>
  <div class="stat-item"><div class="stat-num">Free</div><div class="stat-label">Consultations</div></div>
</div>

<section class="section" id="sage" style="background:var(--bg)">
  <div class="sage-inner">
    <div class="sec-label">Available 24/7</div>
    <h2>Meet Sage &mdash;<br><em>Your Aesthetic Guide</em></h2>
    <p class="sec-sub">Sage knows every service at ${businessName}. Ask anything, explore your options, or upload a photo for personalized talking points before your consultation.</p>
    <div class="feats">
      <div class="feat">&#128248; Photo Analysis</div>
      <div class="feat">&#128172; Treatment Guidance</div>
      <div class="feat">&#128197; Book Consultation</div>
      <div class="feat">&#127777; Available 24/7</div>
    </div>
    <div class="chat-wrap">
      <iframe src="https://paymegpt.com/agents/${widgetId}/embed" frameborder="0" style="width:100%;height:640px;border:none;display:block;"></iframe>
      <script src="https://paymegpt.com/iframe-auto-resize.js"></script>
    </div>
  </div>
</section>

<section class="section" style="background:#fff">
  <div class="sec-label">Treatments</div>
  <h2>Our <em>Services</em></h2>
  <div class="svc-grid">${svcCards}</div>
</section>

<section class="section rev-section">
  <div class="sec-label" style="color:var(--accent)">Client Reviews</div>
  <h2 style="color:#fff">What Our <em>Clients Say</em></h2>
  <div class="rev-grid">${revCards}</div>
</section>

${teamSection}

<section class="cta-section">
  <h2>Ready to Look Your Best?</h2>
  <p>Chat with Sage for instant guidance or call us to schedule your free consultation.</p>
  <div class="btns" style="justify-content:center">
    <a href="#sage" class="btn btn-light">Talk to Sage</a>
    ${phone ? `<a href="tel:${phone.replace(/\D/g,'')}" class="btn btn-ghost">Call ${phone}</a>` : ''}
  </div>
</section>

<footer>
  <div>
    <p class="ft-tagline">${scrapeData.metaDescription || 'Personalized aesthetic treatments delivered by licensed professionals' + (location ? ' in ' + location : '') + '.'}</p>
    <div class="ft-contact">
      ${scrapeData.address ? scrapeData.address + '<br>' : ''}
      ${location ? location + '<br>' : ''}
      ${phone ? `<a href="tel:${phone.replace(/\D/g,'')}">${phone}</a><br>` : ''}
      ${email ? `<a href="mailto:${email}">${email}</a>` : ''}
    </div>
  </div>
  <div>
    <div class="ft-title">Treatments</div>
    <div class="ft-links">${services.slice(0,6).map(s => `<a href="#sage">${s}</a>`).join('')}</div>
  </div>
  <div>
    <div class="ft-title">Connect</div>
    <div class="ft-contact">
      ${scrapeData.instagramUrl ? `<a href="${scrapeData.instagramUrl}" target="_blank">Instagram &rarr;</a><br>` : ''}
      ${scrapeData.facebookUrl  ? `<a href="${scrapeData.facebookUrl}"  target="_blank">Facebook &rarr;</a><br>` : ''}
      ${scrapeData.bookingUrl   ? `<a href="${scrapeData.bookingUrl}"   target="_blank">Book Online &rarr;</a>` : ''}
    </div>
  </div>
</footer>
<div class="ft-bot">
  <span>&copy; ${businessName}${location ? ' &mdash; ' + location : ''}</span>
  <span>Powered by Lumi&egrave;re Systems</span>
</div>
</body>
</html>`;
}

// ============================================
// CREATE WIDGET
// ============================================
async function createWidget(businessName, city, state, phone, website, scrapeData, env) {
  const services = scrapeData.services?.length
    ? scrapeData.services.join(', ')
    : 'Botox, Fillers, Laser, Microneedling, IV Therapy, Weight Loss';
  const location = (city && city !== 'NaN') ? city + ((state && state !== 'NaN') ? ', ' + state : '') : '';

  try {
    const res = await fetch('https://paymegpt.com/api/v1/widgets', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.PAYMEGPT_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${businessName} — Sage AI Concierge`,
        systemPrompt: `You are Sage, the AI aesthetic concierge for ${businessName}${location ? ' in ' + location : ''}.
${scrapeData.doctorName ? 'Led by ' + scrapeData.doctorName + '.' : ''}
SERVICES: ${services}
${phone ? 'PHONE: ' + phone : ''}
${scrapeData.bookingUrl ? 'BOOKING: ' + scrapeData.bookingUrl : ''}

PHOTO ANALYSIS — STRICT RULES:
Use warm everyday language only. Acknowledge 2-3 areas gently. Frame EVERYTHING as consultation talking points.
NEVER use clinical terms, diagnose, recommend as medical advice, or guarantee results.
ALWAYS END WITH: "Just a reminder — everything I share is simply a starting point for your consultation, not medical advice! Please book with our team for a personalized plan."

After photo analysis or treatment discussion, collect name, phone, email then POST to:
${FLOW_PATIENT_SUMMARY}

STAY ON TOPIC: Only discuss this practice, aesthetic wellness, services, and booking.`,
        welcomeMessage: `Hi! I'm Sage, your personal aesthetic concierge at ${businessName}. Ask me anything about our treatments, upload a photo for personalized talking points, or let me help you book a consultation!`,
        primaryColor: scrapeData.themeColor || '#1a2744',
        iceBreakers: ['What treatments do you offer?', 'Can you analyze my photo?', 'What are your prices?', 'Book a consultation'],
        guardrails: 'NEVER diagnose. NEVER use clinical medical terms. NEVER guarantee results. NEVER mention competitors. Only discuss this practice.',
        useVoice: true,
        voiceProvider: 'openai',
        voiceName: 'coral'
      })
    });
    if (res.ok) { const w = await res.json(); return w.id || w.widgetId || MASTER_WIDGET_ID; }
  } catch(e) { console.error('Widget creation failed:', e.message); }
  return MASTER_WIDGET_ID;
}

// ============================================
// EMAIL COPY
// ============================================
function generateEmailCopy(businessName, website, pageUrl, audit, city, state) {
  const location = (city && city !== 'NaN') ? city + ((state && state !== 'NaN') ? ', ' + state : '') : '';
  const domain   = website ? website.replace(/https?:\/\//, '').split('/')[0] : 'your website';
  const subject  = `We found ${audit.count} lead leaks on ${businessName}'s website`;
  const bodyPlain = `Hi ${businessName} team,

We do this thing where we review med spa websites and look for the exact spots where you're losing leads before they ever contact you.

We took a look at ${domain} — here's what we found:

X ${audit.issues[0]}
X ${audit.issues[1]}
X ${audit.issues[2]}

So we built you something to fix all of it.

Meet Sage — ${businessName}'s new AI concierge. She's already live, already branded for your practice:

- Engaging visitors the moment they land — 24/7
- Analyzing photos and creating personalized talking points for consultations
- Answering treatment questions and booking consultations automatically
- Capturing leads that would have bounced

Med spas using this system have seen a 30% increase in booked consultations within the first 30 days.

Yours is already built. Take 30 seconds to see it:
${pageUrl}

Love it? It's $2,500 to keep + $897/month.
Hate it? Reply and tell us what to change.

— The Lumiere Team

P.S. Sage already knows your treatments${location ? ' and your ' + location + ' location' : ''}. She's ready right now.

Reply STOP to opt out.`;
  return { subject, bodyPlain };
}

// ============================================
// SEND BROADCAST
// ============================================
async function sendBroadcast(request, env) {
  const { results } = await request.json();
  if (!results?.length) return new Response(JSON.stringify({ error: 'No results' }), { status: 400, headers: corsHeaders });
  let sent = 0, failed = 0;
  for (const batch of chunkArray(results.filter(r => r.status === 'ok' && r.email), 10)) {
    await Promise.allSettled(batch.map(async (biz) => {
      try {
        const res = await fetch(FLOW_AUDIT_OUTREACH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contactName: biz.businessName, contactPhone: biz.phone || '', contactEmail: biz.email || '',
            data: {
              page_url: biz.pageUrl, business_name: biz.businessName, website: biz.website || '',
              audit_1: biz.auditIssues?.[0] || '', audit_2: biz.auditIssues?.[1] || '',
              audit_3: biz.auditIssues?.[2] || '', audit_count: String(biz.auditCount || 3)
            }
          })
        });
        if (res.ok) sent++; else failed++;
      } catch(e) { failed++; }
    }));
    await sleep(1000);
  }
  return new Response(JSON.stringify({ status: 'complete', sent, failed }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ============================================
// GITHUB
// ============================================
async function pushToGitHub(slug, html, businessName, env) {
  const content = btoa(unescape(encodeURIComponent(html)));
  const apiUrl  = `https://api.github.com/repos/DTLegit/Lumiere-Sender/contents/${slug}/index.html`;
  let sha = null;
  try {
    const c = await fetch(apiUrl, { headers: { 'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'Lumiere-Sender' } });
    if (c.ok) { const e = await c.json(); sha = e.sha; }
  } catch(e) {}
  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'Lumiere-Sender' },
    body: JSON.stringify({ message: `Lumiere Demo: ${businessName}`, content, ...(sha ? { sha } : {}) })
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`GitHub failed: ${err.substring(0,200)}`); }
}

// ============================================
// HELPERS
// ============================================
function generateSlug(name, city) {
  const cleanCity = (city &&
    !city.includes('http') && !city.includes('www') && !city.includes('.com') &&
    !city.includes('linkedin') && !city.includes('twitter') &&
    city !== 'NaN' && city !== 'nan' && city !== 'undefined' && city.length < 40) ? city : '';
  return (name + (cleanCity ? '-' + cleanCity : ''))
    .toLowerCase().replace(/[^a-z0-9\s-]/g,'').replace(/\s+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').substring(0,55);
}
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g,''));
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const values = smartSplit(line);
    return headers.reduce((obj,h,i) => { obj[h]=(values[i]||'').trim().replace(/^"|"$/g,''); return obj; }, {});
  }).filter(l => l.BusinessName || l.WebsiteURL);
}
function smartSplit(line) {
  const r=[]; let c=''; let q=false;
  for (const ch of line) { if(ch==='"'){q=!q;}else if(ch===','&&!q){r.push(c);c='';}else{c+=ch;} }
  r.push(c); return r;
}
function chunkArray(arr,size){const c=[];for(let i=0;i<arr.length;i+=size)c.push(arr.slice(i,i+size));return c;}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
