const express = require('express');
const cors    = require('cors');
const path    = require('path');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const BASE_URL        = process.env.RENDER_EXTERNAL_URL || 'https://vemail-jqp4.onrender.com';
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY     || '';

const FIRMA = {
  name:    'Volksenergie Schwaben GmbH',
  adresse: 'Neue Straße 95, 89073 Ulm',
  tel:     '+49 731 14395542',
  mail:    'info@volksenergieschwaben.de',
  web:     'volksenergieschwaben.de',
  hrb:     'HRB 750663',
  euid:    'DEB8537.HRB750663',
  gf:      'Denizer Yasar',
  gericht: 'Amtsgericht Ulm',
};

const BROSCHURE_URLS = {
  viessmann_250: BASE_URL + '/pdfs/broschure-vitocal-250a.pdf',
  viessmann_150: BASE_URL + '/pdfs/broschure-vitocal-150a.pdf',
  buderus:       BASE_URL + '/pdfs/broschure-buderus-wlw186i.pdf',
};

const PRODUKT_IMAGES = {
  viessmann_250: BASE_URL + '/images/vitocal-250a.png',
  viessmann_150: BASE_URL + '/images/vitocal-150a.png',
  buderus:       BASE_URL + '/images/buderus-wlw186i.png',
};

const LOGO_URL = BASE_URL + '/images/logo.png';

// ── HEALTH ────────────────────────────────────────────────────
app.get('/',     (req, res) => res.json({ status: 'ok', service: 'Volksenergie Schwaben v5' }));
app.get('/ping', (req, res) => res.json({ pong: true }));

// ── SUPABASE ENDPOINTS ───────────────────────────────────────
// Angebot kaydet (http-functions.js'den çağrılır)
app.post('/save-angebot', async (req, res) => {
  try {
    const d = req.body;
    await supabase('post', 'angebote', {
      angebot_nr:        d.angebotNr,
      salutation:        d.salutation,
      first_name:        d.firstName,
      last_name:         d.lastName,
      street:            d.street,
      house_number:      d.houseNumber,
      zip:               d.zip,
      city:              d.city,
      phone:             d.phoneNumber,
      mobile:            d.mobileNumber,
      email:             d.emailAddress,
      wohnflaeche:       d.wohnflaeche,
      baujahr:           d.baujahr,
      heizkoerper:       d.heizkoerper,
      heizenergieart:    d.heizenergieart,
      energy:            d.energy,
      kwhprice:          d.kwhprice,
      module_name:       d.moduleName || d.module,
      total_excl:        parseFloat(d.totalExcl) || 0,
      total_incl:        parseFloat(d.totalIncl) || 0,
      foerder_pct:       parseInt(d.heatingcosts) || 0,
      foerder_summe:     parseFloat(d.foerderSumme) || 0,
      eigenanteil:       parseFloat(d.totalIncl) - parseFloat(d.foerderSumme) || 0,
      angebot_link:      d.angebotLink,
      aufschiebende_link: d.aufschiebendeLink,
      vollmacht_link:    d.vollmachtLink,
      broschure_link:    d.broschureLink,
      status:            'gesendet',
      angebot_date:      new Date().toISOString().split('T')[0],
      expires_at:        new Date(Date.now() + 30*24*60*60*1000).toISOString(),
    });
    res.json({ success: true });
  } catch (e) {
    console.error('Supabase save error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Görüntülendi kaydı + bildirim
app.post('/seen/:angebotNr', async (req, res) => {
  try {
    const nr = req.params.angebotNr;
    const rows = await supabase('get', 'angebote', null, 'angebot_nr=eq.' + nr + '&select=*');
    if (!rows || rows.length === 0) return res.json({ ok: true });
    const row = rows[0];

    const isFirst = !row.first_seen_at;
    await supabase('patch', 'angebote', {
      status:        row.status === 'gesendet' ? 'gesehen' : row.status,
      gezaehlt:      (row.gezaehlt || 0) + 1,
      first_seen_at: row.first_seen_at || new Date().toISOString(),
      last_seen_at:  new Date().toISOString(),
    }, 'angebot_nr=eq.' + nr);

    // İlk görüntülemede email gönder
    if (isFirst) {
      const name = (row.salutation||'') + ' ' + (row.first_name||'') + ' ' + (row.last_name||'');
      await sendNotificationEmail(nr, name.trim(), row.city);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Seen error:', e.message);
    res.json({ ok: true }); // hata olsa da sayfayı engelleme
  }
});

// İmza kaydet
app.post('/sign/:angebotNr', async (req, res) => {
  try {
    const nr = req.params.angebotNr;
    const { signature } = req.body;
    await supabase('patch', 'angebote', {
      status:            'unterschrieben',
      unterschrieben_at: new Date().toISOString(),
      signature_data:    signature,
    }, 'angebot_nr=eq.' + nr);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dashboard API — tüm angebotlar
app.get('/api/angebote', async (req, res) => {
  try {
    const rows = await supabase('get', 'angebote', null,
      'select=*&order=created_at.desc&limit=200');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bildirim emaili
async function sendNotificationEmail(nr, name, city) {
  try {
    await axios.post('https://api.resend.com/emails', {
      from: 'Volksenergie Schwaben <noreply@volksenergieschwaben.de>',
      to:   'info@volksenergieschwaben.de',
      subject: `📄 Angebot ${nr} wurde geöffnet — ${name}`,
      html: `<p><strong>${name}</strong> aus <strong>${city}</strong> hat das Angebot <strong>${nr}</strong> gerade geöffnet.</p>
             <p>Zeitpunkt: ${new Date().toLocaleString('de-DE')}</p>`
    }, {
      headers: { 'Authorization': 'Bearer ' + (process.env.RESEND_API_KEY||'') }
    });
  } catch(e) {
    console.warn('Notification email failed:', e.message);
  }
}

// ── BROSCHÜRE ─────────────────────────────────────────────────
app.get('/broschure', (req, res) => {
  const m = (req.query.module || '').toString();
  let url = BROSCHURE_URLS.viessmann_250;
  if (m.includes('150'))                               url = BROSCHURE_URLS.viessmann_150;
  else if (m.includes('BUDERUS') || m.includes('WLW')) url = BROSCHURE_URLS.buderus;
  res.redirect(302, url);
});

// ── HTML SAYFASI — tarayıcıda açılır, print ile PDF ──────────
app.get('/angebot',       (req, res) => serveHtml(req, res, 'angebot'));
app.get('/aufschiebende', (req, res) => serveHtml(req, res, 'aufschiebende'));
app.get('/vollmacht',     (req, res) => serveHtml(req, res, 'vollmacht'));

function parseQueryData(req) {
  if (!req.query.data) return null;
  try {
    const b64 = req.query.data.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  } catch (e) { return null; }
}

function serveHtml(req, res, type) {
  const d = parseQueryData(req);
  if (!d) return res.status(400).send('Veri eksik');

  const isViessmann150 = (d.moduleName||d.module||'').includes('150');
  const isBuderus      = (d.moduleName||d.module||'').includes('BUDERUS') || (d.moduleName||d.module||'').includes('WLW');
  const produktImg     = isBuderus ? PRODUKT_IMAGES.buderus : isViessmann150 ? PRODUKT_IMAGES.viessmann_150 : PRODUKT_IMAGES.viessmann_250;

  const satUrl = GOOGLE_MAPS_KEY
    ? `https://maps.googleapis.com/maps/api/staticmap?center=${encodeURIComponent(d.street+' '+d.houseNumber+', '+d.zip+' '+d.city+', Deutschland')}&zoom=18&size=600x220&maptype=satellite&markers=color:red%7C${encodeURIComponent(d.street+' '+d.houseNumber+', '+d.zip+' '+d.city+', Deutschland')}&key=${GOOGLE_MAPS_KEY}`
    : '';

  let html;
  if (type === 'angebot')       html = buildAngebotHtml(d, produktImg, satUrl);
  else if (type === 'aufschiebende') html = buildAufschiebendHtml(d);
  else                          html = buildVollmachtHtml(d);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

function fmt(n) {
  return (parseFloat(n)||0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700;900&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  html{background:#888}
  body{font-family:Lato,Arial,sans-serif;background:#888;color:#1a1a1a;font-size:13px}

  /* A4 sayfa görünümü */
  .page{
    width:210mm;min-height:297mm;
    margin:12mm auto;
    background:#fdf3e7;
    padding:14mm 16mm 14mm;
    box-shadow:0 4px 32px rgba(0,0,0,.35);
    position:relative;
  }

  /* Yazdır butonu */
  .print-btn{
    position:fixed;bottom:28px;right:28px;
    background:#1a4a1a;color:#fff;border:none;
    padding:14px 26px;border-radius:50px;font-size:14px;font-weight:700;
    cursor:pointer;box-shadow:0 4px 20px rgba(26,74,26,.5);
    z-index:999;display:flex;align-items:center;gap:10px;
    transition:all .2s;
  }
  .print-btn:hover{background:#2d7a2d;transform:translateY(-2px);box-shadow:0 8px 24px rgba(26,74,26,.5)}

  /* Header */
  .header{
    display:flex;justify-content:space-between;align-items:center;
    margin-bottom:8mm;padding-bottom:5mm;
    border-bottom:3px solid #1a4a1a;
  }
  .logo{height:72px;width:auto;background:#fdf3e7;border-radius:8px;padding:5px;object-fit:contain}
  .header-right{text-align:right;font-size:9.5px;color:#5a5a4a;line-height:2}

  /* Kapak bloğu */
  .cover-block{
    background:#1a4a1a;color:#fff;
    padding:8mm 10mm;border-radius:8px;
    margin-bottom:7mm;position:relative;overflow:hidden;
  }
  .cover-block::after{content:'';position:absolute;right:-30px;top:-30px;
    width:160px;height:160px;border-radius:50%;background:rgba(245,184,0,.12)}
  .cover-block .anr-nr{
    font-size:10px;color:rgba(255,255,255,.5);text-transform:uppercase;
    letter-spacing:1px;margin-bottom:4px;
  }
  .cover-block h1{font-size:20px;font-weight:900;margin-bottom:3px}
  .cover-block .anr-sub{font-size:11px;color:rgba(255,255,255,.65);margin-bottom:6px}
  .cover-block .anr-date{
    display:inline-block;background:rgba(245,184,0,.25);
    border:1px solid rgba(245,184,0,.5);color:#f5b800;
    font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px;
  }

  .badge{display:inline-block;background:#1a4a1a;color:#fff;font-size:9px;font-weight:700;
    padding:3px 10px;border-radius:4px;margin-bottom:5mm}

  /* İki kolon — berater + müşteri */
  .two-col{display:flex;gap:6mm;margin-bottom:6mm}
  .two-col > div{flex:1}
  .berater-box{background:#f5b800;border-radius:6px;padding:5px 10px;
    font-size:10px;font-weight:700;color:#1a4a1a;margin-bottom:5px;display:inline-block}
  .rbox{background:#fef9f0;border:1px solid #e8d5b0;border-radius:8px;padding:10px 13px}
  .rbox .nm{font-size:12px;font-weight:700;color:#1a4a1a;margin-bottom:3px}
  .rbox .ad{font-size:10px;color:#5a5a4a;line-height:1.8}

  .intro{font-size:11px;color:#444;line-height:1.85;margin-bottom:6mm}

  /* Section başlık */
  .sec{font-size:9px;font-weight:700;color:#1a4a1a;letter-spacing:1px;
    text-transform:uppercase;margin:5mm 0 3mm;
    padding-bottom:3px;border-bottom:2px solid #f5b800}

  /* Teknik grid */
  .tgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:5mm}
  .titem{background:#fef9f0;border:1px solid #e8d5b0;border-radius:5px;padding:6px 8px}
  .tlabel{font-size:8px;color:#aaa;text-transform:uppercase;letter-spacing:.5px;margin-bottom:1px}
  .tval{font-size:11px;font-weight:700;color:#1a4a1a}

  /* Pozisyon tablosu */
  .pos-header{background:#1a4a1a;color:#fff;padding:5px 8px;font-size:9px;font-weight:700;margin-top:8px;border-radius:4px 4px 0 0}
  .pos-row{border:1px solid #e8d5b0;border-top:none;padding:8px 10px;background:#fef9f0;border-radius:0 0 4px 4px;margin-bottom:2px}
  .pos-row .pt{font-weight:700;font-size:11px;color:#1a4a1a;margin-bottom:1px}
  .pos-row .pd{font-size:10px;color:#5a5a4a;line-height:1.5}
  .prod-wrap{display:flex;gap:10mm;align-items:flex-start}
  .prod-img{width:90px;height:90px;object-fit:contain;border:1px solid #e8d5b0;
    border-radius:6px;background:#fff;padding:5px;flex-shrink:0}

  table.pos-tbl{width:100%;border-collapse:collapse;margin-top:4px;font-size:10.5px}
  table.pos-tbl th{background:#1a4a1a;color:#fff;padding:5px 7px;text-align:left;font-size:9px}
  table.pos-tbl td{padding:5px 7px;border-bottom:1px solid #e8d5b0;vertical-align:top}
  table.pos-tbl tr:nth-child(even) td{background:#fef9f0}
  .pn{width:24px;font-weight:700;color:#1a4a1a;font-size:10px;text-align:center}

  /* Ödeme + fiyat */
  table.zahl{width:100%;border-collapse:collapse;margin-bottom:4mm;font-size:11px}
  table.zahl td{padding:5px 0;border-bottom:1px solid #e8d5b0}
  table.zahl td:last-child{text-align:right;font-weight:700;color:#1a4a1a}

  .price-box{background:#1a4a1a;border-radius:10px;padding:5mm 6mm;margin:4mm 0}
  .pr{display:flex;justify-content:space-between;padding:2px 0;font-size:11px;color:rgba(255,255,255,.55)}
  .pr.main{border-top:1px solid rgba(255,255,255,.2);margin-top:6px;padding-top:8px;
    font-size:15px;color:#fff;font-weight:700}
  .pr.fo{color:#f5b800;font-weight:700;font-size:12px;margin-top:4px}
  .pr.eg{color:#7ec87e;font-weight:700;font-size:12px}

  /* İmza */
  .sig-wrap{display:flex;justify-content:space-between;margin-top:8mm}
  .sig-line{border-top:1px solid #1a4a1a;margin:24px 0 4px}
  .sig-label{font-size:9px;color:#aaa}

  /* İletişim kutusu */
  .contact-box{background:#1a4a1a;border-radius:6px;padding:8px 14px;
    text-align:center;font-size:10px;color:#fff;margin:4mm 0}

  /* Footer */
  .footer{margin-top:6mm;padding-top:4mm;border-top:2px solid #1a4a1a;
    font-size:9px;color:#5a5a4a;line-height:1.9;text-align:center}
  .disclaimer{font-size:8.5px;color:#bbb;line-height:1.6;margin-top:3mm;
    padding-top:3mm;border-top:1px solid #e8d5b0}

  .map-img{width:100%;height:140px;object-fit:cover;border-radius:6px;
    border:1px solid #e8d5b0;margin-bottom:5mm}

  /* Koşul kutusu */
  .cond-box{background:#fffbe6;border-left:4px solid #f5b800;padding:10px 14px;
    border-radius:0 6px 6px 0;margin-bottom:4mm}
  .cond-title{font-weight:700;color:#1a4a1a;margin-bottom:4px;font-size:11px}
  .cond-text{font-size:10.5px;color:#3a3a2a;line-height:1.75}

  table.data-tbl{width:100%;border-collapse:collapse;margin-bottom:4mm}
  table.data-tbl td{padding:6px 9px;border:1px solid #e8d5b0;font-size:10.5px}
  table.data-tbl td:first-child{background:#fef9f0;color:#5a5a4a;width:36%;font-size:10px}

  /* PRINT — A4 görünümü koru */
  @media print{
    html{background:#fff}
    body{background:#fff}
    .print-btn{display:none!important}
    .page{
      width:100%;margin:0;padding:10mm 12mm;
      box-shadow:none;min-height:auto;
    }
    .pos-header{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .price-box{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .cover-block{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .berater-box{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .contact-box{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    table.pos-tbl th{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  }
`;

const PRINT_SCRIPT = `
  document.querySelector('.print-btn').addEventListener('click', () => {
    window.print();
  });
`;

const AGREEMENT_LABELS = {
  '22143':'inkl. SG Ready Schnittstelle-PV/WP (Aufputz/bis 5m)',
  '22142':'inkl. Aufstellort Außen bis 2m - ab 2m je Meter 250€',
  '22141':'inkl. Erdung 2x je 10m, falls nicht vorhanden',
  '22140':'inkl. zwei Heizkreise (Fußbodenheizung/Heizkörper)',
  '22139':'inkl. Fußbodenheizkreisverteiler Austausch',
  '22138':'inkl. Niedertemperaturheizkörper mit Kühlfunktion',
  '22137':'inkl. Heizkörpertausch gemäß Heizlastberechnung',
  '22135':'inkl. Solarthermie-Anbindung',
  '22134':'inkl. Unterverteilung für 2. Stromzähler (WP-Tarif)',
  '22133':'inkl. 14A Schrank (APZ & RFZ Feld)',
  '22114':'KfW-Ablehnungsklausel: Kostenfreie Stornierung bei Ablehnung',
  '22049':'inkl. neuem separaten 2-Zählerfeld Zählerschrank',
  '22048':'inkl. Ausbau und Entsorgung des Öltanks',
  '22044':'inkl. neuem separaten 4-Zählerfeld Zählerschrank',
  '22043':'inkl. neuem separaten 3-Zählerfeld Zählerschrank',
};

function buildAngebotHtml(d, produktImg, satUrl) {
  const brutto   = parseFloat(d.totalIncl) || 0;
  const netto    = brutto / 1.19;
  const mwst     = brutto - netto;
  const foerder  = parseFloat(d.foerderSumme) || 0;
  const eigen    = brutto - foerder;
  const modName  = d.moduleName || d.module || '–';

  const agreementsHtml = (d.agreements || [])
    .map(v => `<tr><td class="pn">✓</td><td>${AGREEMENT_LABELS[v]||v}</td></tr>`)
    .join('');

  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Angebot ${d.angebotNr||''} — ${d.lastName||''}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📄</text></svg>">
<style>
${CSS}
/* SAYFA YAPISI */
.sheet{
  width:210mm;min-height:297mm;
  background:#fdf3e7;
  padding:14mm 16mm 14mm;
  position:relative;
  page-break-after:always;
}
.sheet:last-child{page-break-after:auto}

/* KAPAK SAYFASI */
.cover-sheet{
  width:210mm;min-height:297mm;
  background:#1a4a1a;
  padding:0;
  position:relative;
  overflow:hidden;
  page-break-after:always;
  display:flex;
  flex-direction:column;
}
.cover-sheet::before{
  content:'';position:absolute;right:-60px;top:-60px;
  width:280px;height:280px;border-radius:50%;
  background:rgba(245,184,0,.08);
}
.cover-sheet::after{
  content:'';position:absolute;left:-40px;bottom:-40px;
  width:200px;height:200px;border-radius:50%;
  background:rgba(255,255,255,.04);
}
.cover-top{
  padding:14mm 16mm 10mm;
  flex:1;
  position:relative;z-index:1;
}
.cover-logo-wrap{
  background:#fdf3e7;
  border-radius:12px;
  padding:8px 14px;
  display:inline-block;
  margin-bottom:14mm;
}
.cover-logo{height:70px;width:auto;object-fit:contain}
.cover-tag{
  display:inline-block;background:rgba(245,184,0,.2);
  border:1px solid rgba(245,184,0,.5);color:#f5b800;
  font-size:10px;font-weight:700;padding:4px 14px;border-radius:20px;
  letter-spacing:.5px;margin-bottom:6mm;
}
.cover-h1{font-size:32px;font-weight:900;color:#fff;line-height:1.15;margin-bottom:3mm}
.cover-sub{font-size:13px;color:rgba(255,255,255,.6);margin-bottom:8mm}
.cover-nr{
  display:inline-flex;align-items:center;gap:8px;
  background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);
  color:#fff;font-size:11px;padding:6px 16px;border-radius:6px;
}
.cover-bottom{
  background:rgba(0,0,0,.2);padding:8mm 16mm;
  position:relative;z-index:1;
}
.cover-bottom table{width:100%;border-collapse:collapse}
.cover-bottom td{padding:3px 0;font-size:10px;color:rgba(255,255,255,.65);vertical-align:top}
.cover-bottom td:last-child{text-align:right;color:rgba(255,255,255,.5)}

/* SAYFA HEADER */
.page-header{
  display:flex;justify-content:space-between;align-items:center;
  margin-bottom:7mm;padding-bottom:4mm;
  border-bottom:2.5px solid #1a4a1a;
}
.page-logo{height:64px;width:auto;background:#fdf3e7;border-radius:8px;padding:5px;object-fit:contain}
.page-header-right{text-align:right;font-size:9px;color:#5a5a4a;line-height:2}
.page-badge{
  display:inline-block;background:#1a4a1a;color:#fff;
  font-size:9px;font-weight:700;padding:3px 10px;border-radius:4px;margin-bottom:4mm;
}

/* BÖLÜM BAŞLIĞI */
.sec{
  font-size:9px;font-weight:700;color:#1a4a1a;
  letter-spacing:1px;text-transform:uppercase;
  margin:5mm 0 3mm;padding-bottom:3px;
  border-bottom:2px solid #f5b800;
}

/* TEKNİK GRID */
.tgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-bottom:5mm}
.titem{background:#fef9f0;border:1px solid #e8d5b0;border-radius:5px;padding:5px 8px}
.tlabel{font-size:8px;color:#aaa;text-transform:uppercase;letter-spacing:.5px;margin-bottom:1px}
.tval{font-size:11px;font-weight:700;color:#1a4a1a}

/* POZİSYONLAR */
.pos-header{
  background:#1a4a1a;color:#fff;
  padding:5px 8px;font-size:9px;font-weight:700;
  border-radius:4px 4px 0 0;margin-top:6px;
}
.pos-row{
  border:1px solid #e8d5b0;border-top:none;padding:7px 9px;
  background:#fef9f0;border-radius:0 0 4px 4px;margin-bottom:2px;
  page-break-inside:avoid;
}
.pos-row .pt{font-weight:700;font-size:11px;color:#1a4a1a;margin-bottom:1px}
.pos-row .pd{font-size:10px;color:#5a5a4a;line-height:1.5}
.prod-wrap{display:flex;gap:8mm;align-items:flex-start}
.prod-img{width:80px;height:80px;object-fit:contain;border:1px solid #e8d5b0;
  border-radius:6px;background:#fff;padding:5px;flex-shrink:0}

table.pos-tbl{width:100%;border-collapse:collapse;margin-top:4px}
table.pos-tbl th{background:#1a4a1a;color:#fff;padding:5px 7px;text-align:left;font-size:9px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
table.pos-tbl td{padding:5px 7px;border-bottom:1px solid #e8d5b0;vertical-align:top;font-size:10px}
table.pos-tbl tr:nth-child(even) td{background:#fef9f0}
.pn{width:22px;font-weight:700;color:#1a4a1a;font-size:10px;text-align:center}

/* ÖDEME */
table.zahl{width:100%;border-collapse:collapse;margin-bottom:4mm;font-size:11px}
table.zahl td{padding:5px 0;border-bottom:1px solid #e8d5b0}
table.zahl td:last-child{text-align:right;font-weight:700;color:#1a4a1a}

/* FİYAT KUTUSU */
.price-box{
  background:#1a4a1a;border-radius:10px;padding:5mm 6mm;margin:4mm 0;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.pr{display:flex;justify-content:space-between;padding:2px 0;font-size:11px;color:rgba(255,255,255,.55)}
.pr.main{border-top:1px solid rgba(255,255,255,.2);margin-top:6px;padding-top:8px;
  font-size:15px;color:#fff;font-weight:700}
.pr.fo{color:#f5b800;font-weight:700;font-size:12px;margin-top:4px}
.pr.eg{color:#7ec87e;font-weight:700;font-size:12px}

/* İMZA */
.sig-wrap{display:flex;justify-content:space-between;margin-top:8mm}
.sig-line{border-top:1px solid #1a4a1a;margin:24px 0 4px}
.sig-label{font-size:9px;color:#aaa}

.contact-box{
  background:#1a4a1a;border-radius:6px;padding:7px 14px;
  text-align:center;font-size:10px;color:#fff;margin:4mm 0;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}

.map-img{width:100%;height:130px;object-fit:cover;border-radius:6px;
  border:1px solid #e8d5b0;margin-bottom:4mm}

.footer{
  margin-top:6mm;padding-top:4mm;border-top:2px solid #1a4a1a;
  font-size:9px;color:#5a5a4a;line-height:1.9;text-align:center;
}
.disclaimer{
  font-size:8px;color:#bbb;line-height:1.6;margin-top:3mm;
  padding-top:3mm;border-top:1px solid #e8d5b0;
}
.rbox{background:#fef9f0;border:1px solid #e8d5b0;border-radius:8px;padding:9px 12px}
.rbox .nm{font-size:12px;font-weight:700;color:#1a4a1a;margin-bottom:2px}
.rbox .ad{font-size:10px;color:#5a5a4a;line-height:1.8}
.berater-box{
  background:#f5b800;border-radius:5px;padding:4px 9px;
  font-size:10px;font-weight:700;color:#1a4a1a;
  display:inline-block;margin-bottom:5px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.two-col{display:flex;gap:5mm;margin-bottom:5mm}
.two-col>div{flex:1}
.intro{font-size:11px;color:#444;line-height:1.85;margin-bottom:5mm}

/* PRINT - Sayfa kesme düzeltmesi */
@media print{
  html,body{
    background:#fdf3e7!important;
    margin:0;padding:0;
    -webkit-print-color-adjust:exact;
    print-color-adjust:exact;
  }
  .pdf-toolbar,.pdf-sidebar{display:none!important}
  .pdf-main{
    margin:0!important;padding:0!important;
    display:block!important;
    background:transparent!important;
  }
  .sheet,.cover-sheet{
    width:210mm!important;
    min-height:297mm!important;
    height:297mm!important;
    margin:0!important;
    padding:14mm 16mm!important;
    box-shadow:none!important;
    page-break-after:always!important;
    page-break-inside:avoid!important;
    overflow:hidden!important;
    display:block!important;
  }
  .cover-sheet{
    padding:0!important;
    background:#1a4a1a!important;
    -webkit-print-color-adjust:exact!important;
    print-color-adjust:exact!important;
  }
  /* Tablo, pozisyon satırları ortadan kesilmesin */
  table{page-break-inside:avoid}
  tr{page-break-inside:avoid}
  .pos-row{page-break-inside:avoid}
  .price-box{page-break-inside:avoid}
  .sig-wrap{page-break-inside:avoid}
  /* Boşluk bırakma */
  * { orphans:3; widows:3; }
}
@page{
  size:A4;
  margin:0;
}

/* EKRAN - PDF Viewer */
@media screen{
  html,body{background:#404040;margin:0;padding:0;height:100%}
  body{display:flex;flex-direction:column}

  /* ÜST BAR */
  .pdf-toolbar{
    position:fixed;top:0;left:0;right:0;height:44px;
    background:#323232;border-bottom:1px solid #1a1a1a;
    display:flex;align-items:center;justify-content:space-between;
    padding:0 16px;z-index:10000;
    box-shadow:0 2px 8px rgba(0,0,0,.4);
  }
  .pdf-toolbar-left{display:flex;align-items:center;gap:12px}
  .pdf-toolbar-title{color:#e0e0e0;font-size:13px;font-weight:500;font-family:Arial,sans-serif}
  .pdf-toolbar-pages{color:#999;font-size:12px;font-family:Arial,sans-serif}
  .pdf-toolbar-right{display:flex;align-items:center;gap:8px}
  .pdf-btn{
    background:rgba(255,255,255,.1);color:#e0e0e0;border:none;
    padding:6px 14px;border-radius:4px;font-size:12px;
    cursor:pointer;display:flex;align-items:center;gap:6px;
    font-family:Arial,sans-serif;transition:background .15s;
  }
  .pdf-btn:hover{background:rgba(255,255,255,.2)}
  .pdf-btn.primary{background:#1a4a1a;color:#fff}
  .pdf-btn.primary:hover{background:#2d7a2d}

  /* SOL PANEL - THUMBNAIL */
  .pdf-sidebar{
    position:fixed;top:44px;left:0;bottom:0;width:160px;
    background:#2b2b2b;border-right:1px solid #1a1a1a;
    overflow-y:auto;padding:12px 8px;z-index:9999;
  }
  .pdf-sidebar::-webkit-scrollbar{width:4px}
  .pdf-sidebar::-webkit-scrollbar-thumb{background:#555;border-radius:2px}
  .thumb-item{
    margin-bottom:12px;cursor:pointer;
    display:flex;flex-direction:column;align-items:center;
  }
  .thumb-item.active .thumb-page{border:2px solid #4a8f4a;box-shadow:0 0 0 2px rgba(74,143,74,.3)}
  .thumb-page{
    width:120px;min-height:170px;background:#fdf3e7;
    border:2px solid transparent;border-radius:3px;
    overflow:hidden;position:relative;
    transform-origin:top left;
    box-shadow:0 2px 6px rgba(0,0,0,.4);
    transition:border .15s;
  }
  .thumb-page:hover{border-color:#666}
  .thumb-label{
    color:#aaa;font-size:10px;font-family:Arial,sans-serif;
    margin-top:5px;text-align:center;
  }

  /* ANA İÇERİK */
  .pdf-main{
    margin-top:44px;margin-left:160px;
    padding:20px 0;
    overflow-y:auto;
    min-height:calc(100vh - 44px);
    display:flex;flex-direction:column;align-items:center;
    background:#404040;
  }
  .sheet,.cover-sheet{
    margin:0 auto 12px;
    box-shadow:0 4px 24px rgba(0,0,0,.5);
    cursor:default;
  }
  .sheet:last-child,.cover-sheet:last-child{margin-bottom:20px}
}

/* Yazdır butonu */
.print-btn{
  position:fixed;bottom:24px;right:24px;
  background:#1a4a1a;color:#fff;border:none;
  padding:13px 24px;border-radius:50px;font-size:13px;font-weight:700;
  cursor:pointer;box-shadow:0 4px 20px rgba(26,74,26,.5);
  z-index:9999;display:flex;align-items:center;gap:8px;
  transition:all .2s;
}
.print-btn:hover{background:#2d7a2d;transform:translateY(-2px)}
@media print{.print-btn{display:none!important}}
</style>
</head><body>

<!-- PDF VIEWER TOOLBAR -->
<div class="pdf-toolbar">
  <div class="pdf-toolbar-left">
    <svg width="18" height="18" fill="none" stroke="#e0e0e0" stroke-width="2" viewBox="0 0 24 24">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
    <span class="pdf-toolbar-title">Angebot ${d.angebotNr||''} — ${d.salutation} ${d.lastName}</span>
    <span class="pdf-toolbar-pages" id="page-info">4 Seiten</span>
  </div>
  <div class="pdf-toolbar-right">
    <button class="pdf-btn" onclick="window.print()">
      <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z"/>
      </svg>
      Drucken
    </button>
    <button class="pdf-btn primary" onclick="window.print()">
      <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
      </svg>
      Als PDF speichern
    </button>
  </div>
</div>

<!-- SOL THUMBNAIL PANELİ -->
<div class="pdf-sidebar" id="pdf-sidebar">
  <div class="thumb-item active" onclick="scrollToPage(0)" id="thumb-0">
    <div class="thumb-page" id="thumb-preview-0" style="background:#1a4a1a;display:flex;align-items:center;justify-content:center">
      <svg width="32" height="32" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="1.5" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    </div>
    <div class="thumb-label">Seite 1</div>
  </div>
  <div class="thumb-item" onclick="scrollToPage(1)" id="thumb-1">
    <div class="thumb-page" id="thumb-preview-1"></div>
    <div class="thumb-label">Seite 2</div>
  </div>
  <div class="thumb-item" onclick="scrollToPage(2)" id="thumb-2">
    <div class="thumb-page" id="thumb-preview-2"></div>
    <div class="thumb-label">Seite 3</div>
  </div>
  <div class="thumb-item" onclick="scrollToPage(3)" id="thumb-3">
    <div class="thumb-page" id="thumb-preview-3"></div>
    <div class="thumb-label">Seite 4</div>
  </div>
</div>

<!-- ANA SAYFA İÇERİĞİ -->
<div class="pdf-main" id="pdf-main">

<!-- ═══════════════════════════════════════
     SAYFA 1: KAPAK
     ═══════════════════════════════════════ -->
<div class="cover-sheet">
  <div class="cover-top">
    <div class="cover-logo-wrap">
      <img src="${LOGO_URL}" class="cover-logo" alt="${FIRMA.name}" onerror="this.outerHTML='<div style=\\'font-size:16px;font-weight:900;color:#1a4a1a\\'>Volksenergie Schwaben GmbH</div>'">
    </div>
    <div class="cover-tag">WÄRMEPUMPEN ANGEBOT</div>
    <div class="cover-h1">Ihr persönliches<br>Angebot</div>
    <div class="cover-sub">${d.salutation} ${d.firstName} ${d.lastName} &bull; ${d.street} ${d.houseNumber}, ${d.zip} ${d.city}</div>
    <div class="cover-nr">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      Angebot ${d.angebotNr||'–'} &nbsp;&bull;&nbsp; ${d.date||new Date().toLocaleDateString('de-DE')}
    </div>

    <!-- ORTA ALAN - Büyük firma yazısı -->
    <div style="margin-top:14mm;position:relative;z-index:2">
      <div style="font-size:52px;font-weight:900;color:rgba(255,255,255,0.08);
                  letter-spacing:-2px;line-height:1;margin-bottom:0;
                  font-family:Lato,Arial,sans-serif">
        Volksenergie<br>Schwaben
      </div>
      <div style="display:flex;align-items:center;gap:16px;margin-top:6mm">
        <div style="flex:1;height:1px;background:rgba(245,184,0,0.3)"></div>
        <div style="font-size:13px;font-weight:700;color:rgba(245,184,0,0.7);
                    letter-spacing:4px;text-transform:uppercase">
          Unsere Region
        </div>
        <div style="flex:1;height:1px;background:rgba(245,184,0,0.3)"></div>
      </div>
      <div style="margin-top:5mm;text-align:right;padding-right:8mm">
        <span style="font-size:22px;font-weight:900;color:rgba(245,184,0,0.5);
                     letter-spacing:2px;text-transform:uppercase;
                     transform:rotate(-4deg);display:inline-block;
                     font-style:italic">
          Unsere Energie
        </span>
      </div>
    </div>
  </div>
  <div class="cover-bottom">
    <table>
      <tr>
        <td style="color:rgba(255,255,255,.9);font-weight:700">${FIRMA.name}</td>
        <td>${FIRMA.adresse}</td>
      </tr>
      <tr>
        <td style="color:rgba(255,255,255,.9)">Tel: ${FIRMA.tel}</td>
        <td>${FIRMA.mail} &bull; ${FIRMA.web}</td>
      </tr>
    </table>
  </div>
</div>

<!-- ═══════════════════════════════════════
     SAYFA 2: MEKTUP + UYDU HARİTASI
     ═══════════════════════════════════════ -->
<div class="sheet">
  <div class="page-header">
    <img src="${LOGO_URL}" class="page-logo" alt="${FIRMA.name}" onerror="this.style.display='none'">
    <div class="page-header-right">${FIRMA.adresse}<br>Tel: ${FIRMA.tel} &bull; ${FIRMA.mail}</div>
  </div>

  <div class="two-col">
    <div>
      <div class="berater-box">Ihr Berater: ${FIRMA.gf}</div>
      <div style="font-size:10px;color:#5a5a4a;line-height:1.8">
        Tel: ${FIRMA.tel}<br>${FIRMA.mail}<br>Mo–Fr 9:00–17:00 Uhr
      </div>
    </div>
    <div class="rbox">
      <div class="nm">${d.salutation} ${d.firstName} ${d.lastName}</div>
      <div class="ad">
        ${d.street} ${d.houseNumber} &bull; ${d.zip} ${d.city}<br>
        ${d.phoneNumber}${d.mobileNumber?' &bull; '+d.mobileNumber:''}<br>
        ${d.emailAddress}
      </div>
    </div>
  </div>

  ${satUrl?`<img src="${satUrl}" class="map-img" alt="Satellitenansicht" onerror="this.style.display='none'">` : ''}

  <p class="intro">
    Sehr geehrte${d.salutation==='Frau'?'':'r'} ${d.salutation} ${d.lastName},<br><br>
    wir freuen uns, Ihnen heute das Angebot für Ihre Wärmepumpe zusenden zu können. Gerne stehen wir Ihnen
    jederzeit mit Rat und Tat zur Seite und unterstützen Sie in der zügigen Planung, Errichtung und Installation
    Ihrer Wärmepumpe.<br><br>
    Sie erreichen uns Montags bis Freitags zwischen 9:00 und 17:00 Uhr unter <strong>${FIRMA.tel}</strong>.
    Außerhalb unserer Geschäftszeiten erreichen Sie uns per E-Mail: <strong>${FIRMA.mail}</strong>.<br><br>
    Auf den folgenden Seiten finden Sie Ihr persönliches Angebot sowie alle relevanten Unterlagen.<br><br>
    Wir freuen uns auf Ihre Bestellung und sichern Ihnen pünktliche Lieferung und Montage zu.
  </p>
  <p style="font-size:11px;color:#1a1a1a;margin-bottom:20px">
    Mit freundlichen Grüßen,<br>
    <strong>${FIRMA.name}</strong>
  </p>

  <div style="border-top:1.5px solid #e8d5b0;margin:6mm 0"></div>

  <div class="footer">
    <strong>${FIRMA.name}</strong> &bull; ${FIRMA.adresse} &bull; Tel: ${FIRMA.tel}<br>
    ${FIRMA.hrb} ${FIRMA.gericht} &bull; EUID: ${FIRMA.euid} &bull; GF: ${FIRMA.gf}
  </div>
</div>

<!-- ═══════════════════════════════════════
     SAYFA 3: TEKNİK ECKDATEN + POZİSYONLAR
     ═══════════════════════════════════════ -->
<div class="sheet">
  <div class="page-header">
    <img src="${LOGO_URL}" class="page-logo" alt="${FIRMA.name}" onerror="this.style.display='none'">
    <div class="page-header-right">${FIRMA.adresse}<br>Angebot ${d.angebotNr||''} &bull; ${d.date||''}</div>
  </div>

  <div class="page-badge">Angebotsdetails ${d.angebotNr||''}</div>
  <div style="font-size:9px;color:#aaa;letter-spacing:.5px;margin-bottom:5mm">BERATUNG &bull; PLANUNG &bull; FINANZSERVICE &bull; LOGISTIK &bull; MONTAGE</div>

  <div class="sec">Technische Eckdaten des Objektes</div>
  <div class="tgrid">
    <div class="titem"><div class="tlabel">Wohnfläche</div><div class="tval">${d.wohnflaeche||'–'} m²</div></div>
    <div class="titem"><div class="tlabel">Baujahr</div><div class="tval">${d.baujahr||'–'}</div></div>
    <div class="titem"><div class="tlabel">Heizkörper</div><div class="tval">${d.heizkoerper||'–'}</div></div>
    <div class="titem"><div class="tlabel">Heizenergieart</div><div class="tval">${d.heizenergieart||'–'}</div></div>
    <div class="titem"><div class="tlabel">Verbrauch/Jahr</div><div class="tval">${d.energy?parseInt(d.energy).toLocaleString('de-DE')+' kWh':'–'}</div></div>
    <div class="titem"><div class="tlabel">Heizkosten/Jahr</div><div class="tval">${d.kwhprice?parseFloat(d.kwhprice).toLocaleString('de-DE',{minimumFractionDigits:2})+' €':'–'}</div></div>
  </div>

  <div class="sec">Leistungsübersicht</div>

  <div class="pos-header">POS 1 — Wärmepumpen Außengerät</div>
  <div class="pos-row">
    <div class="prod-wrap">
      <img src="${produktImg}" class="prod-img" alt="${modName}" onerror="this.style.display='none'">
      <div>
        <div class="pt">${modName}</div>
        <div class="pd">R290 (Propan) &bull; Vorlauftemperatur bis 70°C &bull; Förderfähig nach BEG &bull; Inverter &bull; 3-phasig</div>
      </div>
    </div>
  </div>

  <div class="pos-header">POS 2 — Wärmepumpen Inneneinheit</div>
  <div class="pos-row">
    <div class="pd">Kompakte Inneneinheit inkl. Umwälzpumpe, Umschaltventil und Sicherheitsarmaturen. Vorlauftemperatur bis 70°C.</div>
  </div>

  <table class="pos-tbl" style="margin-top:6px">
    <thead><tr><th class="pn">POS</th><th>Bezeichnung</th></tr></thead>
    <tbody>
      <tr><td class="pn">3</td><td><strong>Hochleistungs-Pufferspeicher 75L</strong><br><span style="color:#5a5a4a">✓ Max. 3 bar · bis 110°C · Vliesdämmung</span></td></tr>
      <tr><td class="pn">4</td><td><strong>Hochleistungs-Hygienespeicher 300L</strong><br><span style="color:#5a5a4a">✓ Max. 10 bar · Max. 95°C · El. Zusatzheizung 3kW · Klasse A+++</span></td></tr>
      <tr><td class="pn">5</td><td><strong>Elektrische Zusatzheizung (pauschal)</strong><br><span style="color:#5a5a4a">✓ Bis 9 kW · Automatischer Zuschaltbetrieb · Förderfähig nach BEG</span></td></tr>
      <tr><td class="pn">6</td><td><strong>Verrohrungssystem (pauschal)</strong><br><span style="color:#5a5a4a">✓ Gemäß GEG · Druckprüfung · Dichtheitsnachweis · TÜV-geprüfte Komponenten</span></td></tr>
      <tr><td class="pn">7</td><td><strong>Demontage Altanlage & Montage Neuanlage (pauschal)</strong><br><span style="color:#5a5a4a">✓ Fachgerechte Stilllegung · Ausbau Altheizung · Aufstellung & Einbindung WP</span></td></tr>
      <tr><td class="pn">8</td><td><strong>Projektierung – Planung & technische Auslegung (pauschal)</strong><br><span style="color:#5a5a4a">✓ Heizlastberechnung DIN EN 12831 · Hydraulikschema · Förderantrag BEG EM</span></td></tr>
      <tr><td class="pn">9</td><td><strong>Fördermittel – Unterstützung & Abwicklung (pauschal)</strong><br><span style="color:#5a5a4a">✓ BEG EM über KfW · Optimale Förderoption · Vollständige Abwicklung</span></td></tr>
      <tr><td class="pn">10</td><td><strong>Anmeldung und Fertigmeldung beim Netzbetreiber (pauschal)</strong><br><span style="color:#5a5a4a">✓ EVU-Anmeldung · Betriebsschaltbild · Prüfprotokoll · Fertigmeldung</span></td></tr>
      <tr><td class="pn">11</td><td><strong>Elektroinstallation Anschluss & Steuerung (pauschal)</strong><br><span style="color:#5a5a4a">✓ Fachgerechte Verlegung · FI-Schalter · Eingetragener Elektrofachbetrieb</span></td></tr>
      <tr><td class="pn">12</td><td><strong>Erstinbetriebnahme gemäß Herstellervorgaben (pauschal)</strong><br><span style="color:#5a5a4a">✓ Druckprüfung · Parametrierung · Einweisung des Betreibers</span></td></tr>
      <tr><td class="pn">13</td><td><strong>Hydraulischer Abgleich – Verfahren B nach VdZ (pauschal)</strong><br><span style="color:#5a5a4a">✓ VdZ-Nachweis · Voraussetzung für BEG EM Förderung</span></td></tr>
      <tr><td class="pn">14</td><td><strong>Technischer Support (pauschal)</strong><br><span style="color:#5a5a4a">✓ Hersteller & ${FIRMA.name} Service-Team · Ferndiagnose möglich</span></td></tr>
      <tr><td class="pn">15</td><td><strong>${FIRMA.name} – Garantieversprechen</strong><br><span style="color:#5a5a4a">✓ Bestpreisgarantie · Festpreisgarantie · 100% Käuferschutz · Keine Vorkasse</span></td></tr>
    </tbody>
  </table>

  <div class="footer">
    <strong>${FIRMA.name}</strong> &bull; ${FIRMA.adresse} &bull; ${FIRMA.hrb} ${FIRMA.gericht} &bull; GF: ${FIRMA.gf}
  </div>
</div>

<!-- ═══════════════════════════════════════
     SAYFA 4: FIYAT + İMZA
     ═══════════════════════════════════════ -->
<div class="sheet">
  <div class="page-header">
    <img src="${LOGO_URL}" class="page-logo" alt="${FIRMA.name}" onerror="this.style.display='none'">
    <div class="page-header-right">${FIRMA.adresse}<br>Angebot ${d.angebotNr||''} &bull; ${d.date||''}</div>
  </div>

  ${agreementsHtml?`
  <div class="sec">Zusatzvereinbarungen</div>
  <table class="pos-tbl" style="margin-bottom:5mm"><tbody>${agreementsHtml}</tbody></table>`:''}

  <div class="sec">Zahlungsmodalitäten</div>
  <table class="zahl">
    <tr><td>1. Abschlag, 80%, bei Warenlieferung</td><td>${fmt(brutto*0.8)} €</td></tr>
    <tr><td>2. Abschlag, 20%, bei Inbetriebnahme</td><td>${fmt(brutto*0.2)} €</td></tr>
  </table>

  <div class="price-box">
    <div class="pr"><span>Gesamtsumme Netto</span><span>${fmt(netto)} €</span></div>
    <div class="pr"><span>19% MwSt.</span><span>${fmt(mwst)} €</span></div>
    <div class="pr main"><span>Gesamtsumme Brutto</span><span>${fmt(brutto)} €</span></div>
    ${foerder>0?`
    <div class="pr fo"><span>Fördersumme (${d.heatingcosts||''}% KfW BEG)</span><span>${fmt(foerder)} €</span></div>
    <div class="pr eg"><span>Ihr Eigenanteil nach Förderung</span><span>${fmt(eigen)} €</span></div>`:''}
  </div>

  <div class="contact-box">
    Bei Rückfragen: <strong>${FIRMA.tel}</strong> &nbsp;&bull;&nbsp; <strong>${FIRMA.mail}</strong> &nbsp;&bull;&nbsp; ${FIRMA.web}
  </div>

  <p style="font-size:10.5px;color:#555;line-height:1.7;margin-bottom:5mm">
    Hiermit nehme ich das Angebot vom ${d.date||new Date().toLocaleDateString('de-DE')} an
    und beauftrage die <strong>${FIRMA.name}</strong> zur Durchführung meines Projektes.
  </p>

  <!-- DİJİTAL İMZA -->
  <div id="sig-section">
    <div style="font-size:10px;color:#5a5a4a;margin-bottom:3mm">Bitte unterschreiben Sie hier digital:</div>
    <canvas id="sig-canvas" width="500" height="120"
      style="border:1.5px solid #1a4a1a;border-radius:6px;background:#fff;
             cursor:crosshair;touch-action:none;width:100%;max-width:500px;display:block"></canvas>
    <div style="display:flex;gap:8px;margin-top:6px">
      <button onclick="clearSig()" style="background:#e8d5b0;border:none;padding:5px 12px;
        border-radius:4px;font-size:11px;cursor:pointer;color:#1a4a1a;font-weight:700">
        ✕ Löschen
      </button>
      <button onclick="saveSig()" id="sig-btn" style="background:#1a4a1a;border:none;padding:5px 16px;
        border-radius:4px;font-size:11px;cursor:pointer;color:#fff;font-weight:700">
        ✓ Unterschrift speichern
      </button>
      <span id="sig-status" style="font-size:11px;color:#2d7a2d;align-self:center;display:none">
        ✓ Unterschrift gespeichert
      </span>
    </div>
  </div>

  <div class="sig-wrap" style="margin-top:5mm">
    <div style="width:45%">
      <div class="sig-line"></div>
      <div class="sig-label">Ort, Datum</div>
    </div>
    <div style="width:50%">
      <div style="border:1.5px solid #1a4a1a;border-radius:4px;height:50px;
                  background:#fff;display:flex;align-items:center;justify-content:center;
                  overflow:hidden" id="sig-preview">
        <span style="font-size:9px;color:#aaa">Unterschrift erscheint hier</span>
      </div>
      <div class="sig-label">Unterschrift — ${d.salutation} ${d.firstName} ${d.lastName}</div>
    </div>
  </div>

  <div style="margin-top:8mm">
    <div class="disclaimer">
      Sofern eine Teilzahlungsvereinbarung geschlossen wird, wird diese zum wesentlichen Bestandteil dieses Auftrages.
      Die staatlichen Fördermittel sind nicht Bestandteil dieses Angebots. ${FIRMA.name} übernimmt keine Haftung dafür.
      Mündliche Abmachungen oder Vereinbarungen sind nicht Bestandteil des Vertrags.
    </div>
  </div>

  <div class="footer">
    <strong>${FIRMA.name}</strong> &bull; ${FIRMA.adresse} &bull; ${FIRMA.hrb} ${FIRMA.gericht} &bull; GF: ${FIRMA.gf}
  </div>
</div>

</div><!-- /pdf-main -->

<script>
// ── GÖRÜNTÜLENDI PING ──────────────────────────────
const ANGEBOT_NR = '${d.angebotNr||""}';
const BASE = '${BASE_URL}';
if (ANGEBOT_NR) {
  fetch(BASE + '/seen/' + ANGEBOT_NR, { method: 'POST' }).catch(() => {});
}

// ── 30 GÜN GEÇERLİLİK KONTROLÜ ────────────────────
const expiresAt = new Date('${new Date(Date.now()+30*24*60*60*1000).toISOString()}');
if (new Date() > expiresAt) {
  document.body.innerHTML = \`
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;
                background:#1a4a1a;font-family:Arial,sans-serif;text-align:center;color:#fff">
      <div>
        <div style="font-size:64px;margin-bottom:16px">⏰</div>
        <div style="font-size:24px;font-weight:700;margin-bottom:8px">Angebot abgelaufen</div>
        <div style="font-size:14px;opacity:.7">Dieses Angebot ist nicht mehr gültig.<br>
        Bitte kontaktieren Sie uns für ein neues Angebot.</div>
        <div style="margin-top:24px;font-size:13px;opacity:.6">+49 731 14395542 · info@volksenergieschwaben.de</div>
      </div>
    </div>\`;
}

// ── DİJİTAL İMZA ───────────────────────────────────
const canvas = document.getElementById('sig-canvas');
const ctx = canvas ? canvas.getContext('2d') : null;
let drawing = false;
let hasSig = false;

function getPos(e, el) {
  const r = el.getBoundingClientRect();
  const scaleX = el.width / r.width;
  const scaleY = el.height / r.height;
  const src = e.touches ? e.touches[0] : e;
  return { x: (src.clientX - r.left) * scaleX, y: (src.clientY - r.top) * scaleY };
}

if (canvas) {
  ctx.strokeStyle = '#1a4a1a';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  canvas.addEventListener('mousedown',  e => { drawing=true; const p=getPos(e,canvas); ctx.beginPath(); ctx.moveTo(p.x,p.y); });
  canvas.addEventListener('mousemove',  e => { if(!drawing) return; const p=getPos(e,canvas); ctx.lineTo(p.x,p.y); ctx.stroke(); hasSig=true; });
  canvas.addEventListener('mouseup',    () => { drawing=false; });
  canvas.addEventListener('mouseleave', () => { drawing=false; });
  canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing=true; const p=getPos(e,canvas); ctx.beginPath(); ctx.moveTo(p.x,p.y); }, {passive:false});
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); if(!drawing) return; const p=getPos(e,canvas); ctx.lineTo(p.x,p.y); ctx.stroke(); hasSig=true; }, {passive:false});
  canvas.addEventListener('touchend',   () => { drawing=false; });
}

function clearSig() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  hasSig = false;
  document.getElementById('sig-preview').innerHTML = '<span style="font-size:9px;color:#aaa">Unterschrift erscheint hier</span>';
  document.getElementById('sig-status').style.display = 'none';
}

async function saveSig() {
  if (!hasSig) { alert('Bitte zuerst unterschreiben!'); return; }
  const sigData = canvas.toDataURL('image/png');
  const preview = document.getElementById('sig-preview');
  preview.innerHTML = '<img src="' + sigData + '" style="height:46px;object-fit:contain">';
  document.getElementById('sig-status').style.display = 'inline';
  document.getElementById('sig-btn').textContent = '✓ Gespeichert';
  document.getElementById('sig-btn').style.background = '#2d7a2d';
  if (ANGEBOT_NR) {
    fetch(BASE + '/sign/' + ANGEBOT_NR, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: sigData })
    }).catch(() => {});
  }
}

// Sayfaları bul
const pages = document.querySelectorAll('.sheet, .cover-sheet');

// Aktif sayfa takibi
function scrollToPage(idx) {
  pages[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Scroll ile aktif thumb güncelle
const main = document.getElementById('pdf-main');
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const idx = Array.from(pages).indexOf(entry.target);
      document.querySelectorAll('.thumb-item').forEach((t,i) => {
        t.classList.toggle('active', i === idx);
      });
      document.getElementById('page-info').textContent =
        (idx+1) + ' / ' + pages.length + ' Seiten';
    }
  });
}, { root: main, threshold: 0.4 });

pages.forEach(p => observer.observe(p));
</script>
</body></html>`;
}

function buildAufschiebendHtml(d) {
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
<title>Aufschiebende Bedingungen — ${d.lastName||''}</title>
<style>${CSS}</style></head><body>
<button class="print-btn" onclick="window.print()">
  <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
    <path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z"/>
  </svg>
  Als PDF speichern
</button>
<div class="page">
  <div class="header">
    <img src="${LOGO_URL}" class="logo" alt="${FIRMA.name}" onerror="this.style.display='none'">
    <div class="header-right">${FIRMA.adresse}<br>Tel: ${FIRMA.tel}</div>
  </div>
  <div class="badge">Aufschiebende Bedingungen</div>
  <div style="margin-bottom:16px"></div>

  <div class="cond-box">
    <div class="cond-title">Aufschiebende Bedingung:</div>
    <div class="cond-text">Dieser (Kauf-)Vertrag tritt hinsichtlich der Liefer- und Leistungspflichten zur Umsetzung erst und nur insoweit in Kraft, wenn und soweit die KfW den Antrag zur Heizungsmodernisierung bewilligt und die Förderung mit einer Zusage gegenüber der antragstellenden Vertragspartei zugesagt hat. Die antragstellende Vertragspartei wird die jeweils andere Vertragspartei über den Eintritt und den Umfang des Eintritts der Bedingung unverzüglich in Kenntnis setzen.</div>
  </div>

  <div class="cond-box">
    <div class="cond-title">Auflösende Bedingung:</div>
    <div class="cond-text">Dieser (Kauf-)Vertrag erlischt hinsichtlich der Liefer- und Leistungspflichten zur Umsetzung, sobald und soweit die KfW den Antrag zur Heizungsmodernisierung nicht bewilligt, sondern ablehnt und die Förderung nicht mit einer Zusage gegenüber der antragstellenden Vertragspartei zusagt, sondern mit einem Ablehnungsbescheid versagt.<br><br>Die antragstellende Vertragspartei wird die jeweils andere Vertragspartei über den Eintritt und den Umfang des Eintritts der Bedingung unverzüglich in Kenntnis setzen.</div>
  </div>

  <div class="sec">Widerrufsrecht</div>
  <p style="font-size:11px;color:#333;line-height:1.8;margin-bottom:14px">
    Sie haben das Recht, binnen 14 Tagen ohne Angaben von Gründen diesen Vertrag zu widerrufen.<br><br>
    Die Widerrufsfrist beträgt 14 Tage ab dem Tag des Vertragsabschlusses. Sie beginnt nicht zu laufen, bevor Sie diese Belehrung in Textform erhalten haben.<br><br>
    Um Ihr Widerrufsrecht auszuüben, müssen Sie uns mittels einer eindeutigen Erklärung (z.B. Brief, Telefax oder E-Mail) über Ihren Entschluss, diesen Vertrag zu widerrufen, informieren.<br><br>
    Zur Wahrung der Widerrufsfrist reicht es aus, dass Sie die Erklärung über die Ausübung des Widerrufsrechts vor Ablauf der Widerrufsfrist absenden.
  </p>

  <div class="sec">Folgen des Widerrufs</div>
  <p style="font-size:11px;color:#333;line-height:1.8;margin-bottom:32px">
    Wenn Sie diesen Vertrag widerrufen, haben wir Ihnen alle Zahlungen, die wir von Ihnen erhalten haben, unverzüglich zurückzuzahlen.<br><br>
    Sie müssen uns im Falle des Widerrufs alle Leistungen zurückgeben, die Sie bis zum Widerruf von uns erhalten haben. Ist die Rückgewähr einer Leistung ihrer Natur nach ausgeschlossen, lassen sich etwa verwendete Baumaterialien nicht ohne Zerstörung entfernen, müssen Sie Wertersatz dafür bezahlen.
  </p>

  <div style="display:flex;justify-content:space-between;margin-top:32px">
    <div><div class="sig-line"></div><div class="sig-label">Ort, Datum</div></div>
    <div style="text-align:right"><div class="sig-line" style="margin-left:auto"></div><div class="sig-label">Unterschrift${d.firstName?' — '+d.salutation+' '+d.firstName+' '+d.lastName:''}</div></div>
  </div>
  <div class="footer"><strong>${FIRMA.name}</strong> · ${FIRMA.adresse}</div>
</div>
</div><!-- /pdf-main -->

<script>
// ── GÖRÜNTÜLENDI PING ──────────────────────────────
const ANGEBOT_NR = '${d.angebotNr||""}';
const BASE = '${BASE_URL}';
if (ANGEBOT_NR) {
  fetch(BASE + '/seen/' + ANGEBOT_NR, { method: 'POST' }).catch(() => {});
}

// ── 30 GÜN GEÇERLİLİK KONTROLÜ ────────────────────
const expiresAt = new Date('${new Date(Date.now()+30*24*60*60*1000).toISOString()}');
if (new Date() > expiresAt) {
  document.body.innerHTML = \`
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;
                background:#1a4a1a;font-family:Arial,sans-serif;text-align:center;color:#fff">
      <div>
        <div style="font-size:64px;margin-bottom:16px">⏰</div>
        <div style="font-size:24px;font-weight:700;margin-bottom:8px">Angebot abgelaufen</div>
        <div style="font-size:14px;opacity:.7">Dieses Angebot ist nicht mehr gültig.<br>
        Bitte kontaktieren Sie uns für ein neues Angebot.</div>
        <div style="margin-top:24px;font-size:13px;opacity:.6">+49 731 14395542 · info@volksenergieschwaben.de</div>
      </div>
    </div>\`;
}

// ── DİJİTAL İMZA ───────────────────────────────────
const canvas = document.getElementById('sig-canvas');
const ctx = canvas ? canvas.getContext('2d') : null;
let drawing = false;
let hasSig = false;

function getPos(e, el) {
  const r = el.getBoundingClientRect();
  const scaleX = el.width / r.width;
  const scaleY = el.height / r.height;
  const src = e.touches ? e.touches[0] : e;
  return { x: (src.clientX - r.left) * scaleX, y: (src.clientY - r.top) * scaleY };
}

if (canvas) {
  ctx.strokeStyle = '#1a4a1a';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  canvas.addEventListener('mousedown',  e => { drawing=true; const p=getPos(e,canvas); ctx.beginPath(); ctx.moveTo(p.x,p.y); });
  canvas.addEventListener('mousemove',  e => { if(!drawing) return; const p=getPos(e,canvas); ctx.lineTo(p.x,p.y); ctx.stroke(); hasSig=true; });
  canvas.addEventListener('mouseup',    () => { drawing=false; });
  canvas.addEventListener('mouseleave', () => { drawing=false; });
  canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing=true; const p=getPos(e,canvas); ctx.beginPath(); ctx.moveTo(p.x,p.y); }, {passive:false});
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); if(!drawing) return; const p=getPos(e,canvas); ctx.lineTo(p.x,p.y); ctx.stroke(); hasSig=true; }, {passive:false});
  canvas.addEventListener('touchend',   () => { drawing=false; });
}

function clearSig() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  hasSig = false;
  document.getElementById('sig-preview').innerHTML = '<span style="font-size:9px;color:#aaa">Unterschrift erscheint hier</span>';
  document.getElementById('sig-status').style.display = 'none';
}

async function saveSig() {
  if (!hasSig) { alert('Bitte zuerst unterschreiben!'); return; }
  const sigData = canvas.toDataURL('image/png');
  const preview = document.getElementById('sig-preview');
  preview.innerHTML = '<img src="' + sigData + '" style="height:46px;object-fit:contain">';
  document.getElementById('sig-status').style.display = 'inline';
  document.getElementById('sig-btn').textContent = '✓ Gespeichert';
  document.getElementById('sig-btn').style.background = '#2d7a2d';
  if (ANGEBOT_NR) {
    fetch(BASE + '/sign/' + ANGEBOT_NR, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: sigData })
    }).catch(() => {});
  }
}

// Sayfaları bul
const pages = document.querySelectorAll('.sheet, .cover-sheet');

// Aktif sayfa takibi
function scrollToPage(idx) {
  pages[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Scroll ile aktif thumb güncelle
const main = document.getElementById('pdf-main');
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const idx = Array.from(pages).indexOf(entry.target);
      document.querySelectorAll('.thumb-item').forEach((t,i) => {
        t.classList.toggle('active', i === idx);
      });
      document.getElementById('page-info').textContent =
        (idx+1) + ' / ' + pages.length + ' Seiten';
    }
  });
}, { root: main, threshold: 0.4 });

pages.forEach(p => observer.observe(p));
</script>
</body></html>`;
}

function buildVollmachtHtml(d) {
  function row(label, val) {
    return `<tr><td>${label}</td><td>${val||''}</td></tr>`;
  }
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
<title>Vollmacht — ${d.lastName||''}</title>
<style>${CSS}</style></head><body>
<button class="print-btn" onclick="window.print()">
  <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
    <path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z"/>
  </svg>
  Als PDF speichern
</button>
<div class="page">
  <div class="header">
    <img src="${LOGO_URL}" class="logo" alt="${FIRMA.name}" onerror="this.style.display='none'">
    <div class="header-right">${FIRMA.adresse}<br>Tel: ${FIRMA.tel}</div>
  </div>
  <div class="badge">Vollmacht</div>
  <p style="font-size:12px;font-weight:700;color:#1a4a1a;margin:10px 0 14px">
    für die Abwicklung und Erledigung der erforderlichen An- und Fertigmeldungen meines Bauvorhabens beim zuständigen Netzbetreiber.
  </p>

  <div class="sec">Hiermit bevollmächtige(n) ich/wir:</div>
  <table class="data-tbl">
    ${row('Vorname', d.firstName)}
    ${row('Name', d.lastName)}
    ${row('Straße / Nr.', (d.street||'') + ' ' + (d.houseNumber||''))}
    ${row('PLZ / Ort', (d.zip||'') + ' ' + (d.city||''))}
    ${row('Geburtsdatum', '')}
    ${row('Mobil', d.mobileNumber||'')}
    ${row('Telefon', d.phoneNumber||'')}
    ${row('E-Mail', d.emailAddress||'')}
  </table>

  <div style="background:#fef9f0;border-left:4px solid #1a4a1a;padding:12px 16px;border-radius:0 6px 6px 0;margin-bottom:14px;font-size:11px;font-weight:700;color:#1a4a1a;line-height:1.8">
    Die Firma ${FIRMA.name}, ${FIRMA.adresse} bzw. deren ausgewiesenen Repräsentanten oder Vertragspartnern, alle erforderlichen Unterlagen, im Rahmen der elektronischen Antragsstellung zur An- und Fertigmeldung meines Bauvorhabens beim zuständigen Netzbetreiber, für den Antragsteller und den Grundstückseigentümer in meinem/unseren Namen auszufüllen, zu unterzeichnen und einzureichen.
  </div>

  <div class="sec">Adresse des Bauvorhabens:</div>
  <table class="data-tbl">
    ${row('Straße, Hr.', (d.street||'') + ' ' + (d.houseNumber||''))}
    ${row('PLZ, Ort', (d.zip||'') + ' ' + (d.city||''))}
    ${row('Germarkung', '')}
    ${row('Flurnummer', '')}
    ${row('Zählernummer', '')}
    ${row('Netzbetreiber', '')}
  </table>

  <div class="sec">Einspeisevergütung Konto:</div>
  <table class="data-tbl">
    ${row('Kontoinhaber', '')}
    ${row('Steuernummer', '')}
    ${row('IBAN, BIC', '')}
  </table>

  <p style="font-size:11px;font-weight:700;text-align:center;margin:20px 0 28px;color:#1a4a1a">
    Diese Vollmacht ist gültig bis zum Abschluss o.g. Maßnahme.
  </p>

  <div style="display:flex;justify-content:space-between">
    <div><div class="sig-line"></div><div class="sig-label">Datum, Ort</div></div>
    <div style="text-align:right"><div class="sig-line" style="margin-left:auto"></div><div class="sig-label">Unterschrift(en) Auftraggeber(in)</div></div>
  </div>
  <div class="footer"><strong>${FIRMA.name}</strong> · ${FIRMA.adresse}</div>
</div>
</div><!-- /pdf-main -->

<script>
// ── GÖRÜNTÜLENDI PING ──────────────────────────────
const ANGEBOT_NR = '${d.angebotNr||""}';
const BASE = '${BASE_URL}';
if (ANGEBOT_NR) {
  fetch(BASE + '/seen/' + ANGEBOT_NR, { method: 'POST' }).catch(() => {});
}

// ── 30 GÜN GEÇERLİLİK KONTROLÜ ────────────────────
const expiresAt = new Date('${new Date(Date.now()+30*24*60*60*1000).toISOString()}');
if (new Date() > expiresAt) {
  document.body.innerHTML = \`
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;
                background:#1a4a1a;font-family:Arial,sans-serif;text-align:center;color:#fff">
      <div>
        <div style="font-size:64px;margin-bottom:16px">⏰</div>
        <div style="font-size:24px;font-weight:700;margin-bottom:8px">Angebot abgelaufen</div>
        <div style="font-size:14px;opacity:.7">Dieses Angebot ist nicht mehr gültig.<br>
        Bitte kontaktieren Sie uns für ein neues Angebot.</div>
        <div style="margin-top:24px;font-size:13px;opacity:.6">+49 731 14395542 · info@volksenergieschwaben.de</div>
      </div>
    </div>\`;
}

// ── DİJİTAL İMZA ───────────────────────────────────
const canvas = document.getElementById('sig-canvas');
const ctx = canvas ? canvas.getContext('2d') : null;
let drawing = false;
let hasSig = false;

function getPos(e, el) {
  const r = el.getBoundingClientRect();
  const scaleX = el.width / r.width;
  const scaleY = el.height / r.height;
  const src = e.touches ? e.touches[0] : e;
  return { x: (src.clientX - r.left) * scaleX, y: (src.clientY - r.top) * scaleY };
}

if (canvas) {
  ctx.strokeStyle = '#1a4a1a';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  canvas.addEventListener('mousedown',  e => { drawing=true; const p=getPos(e,canvas); ctx.beginPath(); ctx.moveTo(p.x,p.y); });
  canvas.addEventListener('mousemove',  e => { if(!drawing) return; const p=getPos(e,canvas); ctx.lineTo(p.x,p.y); ctx.stroke(); hasSig=true; });
  canvas.addEventListener('mouseup',    () => { drawing=false; });
  canvas.addEventListener('mouseleave', () => { drawing=false; });
  canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing=true; const p=getPos(e,canvas); ctx.beginPath(); ctx.moveTo(p.x,p.y); }, {passive:false});
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); if(!drawing) return; const p=getPos(e,canvas); ctx.lineTo(p.x,p.y); ctx.stroke(); hasSig=true; }, {passive:false});
  canvas.addEventListener('touchend',   () => { drawing=false; });
}

function clearSig() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  hasSig = false;
  document.getElementById('sig-preview').innerHTML = '<span style="font-size:9px;color:#aaa">Unterschrift erscheint hier</span>';
  document.getElementById('sig-status').style.display = 'none';
}

async function saveSig() {
  if (!hasSig) { alert('Bitte zuerst unterschreiben!'); return; }
  const sigData = canvas.toDataURL('image/png');
  const preview = document.getElementById('sig-preview');
  preview.innerHTML = '<img src="' + sigData + '" style="height:46px;object-fit:contain">';
  document.getElementById('sig-status').style.display = 'inline';
  document.getElementById('sig-btn').textContent = '✓ Gespeichert';
  document.getElementById('sig-btn').style.background = '#2d7a2d';
  if (ANGEBOT_NR) {
    fetch(BASE + '/sign/' + ANGEBOT_NR, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: sigData })
    }).catch(() => {});
  }
}

// Sayfaları bul
const pages = document.querySelectorAll('.sheet, .cover-sheet');

// Aktif sayfa takibi
function scrollToPage(idx) {
  pages[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Scroll ile aktif thumb güncelle
const main = document.getElementById('pdf-main');
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const idx = Array.from(pages).indexOf(entry.target);
      document.querySelectorAll('.thumb-item').forEach((t,i) => {
        t.classList.toggle('active', i === idx);
      });
      document.getElementById('page-info').textContent =
        (idx+1) + ' / ' + pages.length + ' Seiten';
    }
  });
}, { root: main, threshold: 0.4 });

pages.forEach(p => observer.observe(p));
</script>
</body></html>`;
}

app.listen(PORT, () => console.log('Volksenergie Schwaben PDF Service v5 running on port ' + PORT));
