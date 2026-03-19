const express  = require('express');
const https    = require('https');
const puppeteer = require('puppeteer-core');
const chromium  = require('@sparticuz/chromium');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.static('public'));

// ── FIRMA BİLGİLERİ ──────────────────────────────────────────
const FIRMA = {
  name:        'Volksenergie Schwaben GmbH',
  adresse:     'Neue Straße 95, 89073 Ulm',
  tel:         '+49 731 14395542',
  mail:        'info@volksenergieschwaben.de',
  web:         'volksenergieschwaben.de',
  steuer:      'DE999999999',
  hrb:         'HRB 750663',
  euid:        'DEB8537.HRB750663',
  gf:          'Denizer Yasar',
  iban:        'DE00 0000 0000 0000 0000 00',
  bic:         'XXXXXXXX',
  gericht:     'Amtsgericht Ulm',
};

// Marka renkleri
const C = {
  primary:   '#1a4a1a',   // koyu yeşil
  secondary: '#2d7a2d',   // orta yeşil
  accent:    '#f5b800',   // sarı/altın
  bg:        '#fdf3e7',   // arka plan
  bgLight:   '#fef9f0',   // açık arka plan
  border:    '#e8d5b0',   // border
  text:      '#1a1a1a',
  muted:     '#5a5a4a',
};

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Volksenergie Schwaben PDF Service', version: '2.0.0' });
});

// ── KEEP ALIVE — Wix her 10 dakikada bir buraya ping atar ─────
app.get('/ping', (req, res) => {
  res.json({ pong: true, time: new Date().toISOString() });
});

// ── BROSCHÜRE REDIRECT — harici üretici URL'leri ─────────────
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';

// ── ÜRÜN RESİMLERİ (local /public/images/) ───────────────────
const BASE_URL = process.env.RENDER_EXTERNAL_URL || 'https://vemail-jqp4.onrender.com';
const PRODUKT_IMAGES = {
  viessmann_250_aussen: BASE_URL + '/images/vitocal-250a.png',
  viessmann_250_innen:  BASE_URL + '/images/vitocal-250a.png',
  viessmann_150_aussen: BASE_URL + '/images/vitocal-150a.png',
  viessmann_150_innen:  BASE_URL + '/images/vitocal-150a.png',
  buderus_aussen:       BASE_URL + '/images/buderus-wlw186i.png',
  buderus_innen:        BASE_URL + '/images/buderus-wlw186i.png',
};

const BROSCHURE_URLS = {
  viessmann_250: BASE_URL + '/pdfs/broschure-vitocal-250a.pdf',
  viessmann_150: BASE_URL + '/pdfs/broschure-vitocal-150a.pdf',
  buderus:       BASE_URL + '/pdfs/broschure-buderus-wlw186i.pdf',
};

app.get('/broschure', (req, res) => {
  const modul = (req.query.module || '').toString();
  let url = BROSCHURE_URLS.viessmann_250;
  if (modul.includes('150')) url = BROSCHURE_URLS.viessmann_150;
  else if (modul.includes('BUDERUS') || modul.includes('WLW') || modul.includes('2194') || modul.includes('2195') || modul.includes('2184') || modul.includes('2182')) url = BROSCHURE_URLS.buderus;
  res.redirect(302, url);
});

// Eski endpoint — geriye dönük uyumluluk
app.get('/viessmann-broschure', (req, res) => {
  res.redirect(302, BROSCHURE_URLS.viessmann_250);
});

// ── PDF ENDPOINTS ─────────────────────────────────────────────
app.post('/angebot', async (req, res) => {
  const d = req.body;
  const address = `${d.street||''} ${d.houseNumber||''}, ${d.zip||''} ${d.city||''}, Deutschland`;
  const satelliteUrl = await getSatelliteUrl(address);
  await generateAndSend(buildAngebot(d, satelliteUrl), 'Angebot', d.lastName, res);
});
app.post('/aufschiebende',         async (req, res) => await generateAndSend(buildAufschiebende(req.body),      'Aufschiebende-Bed',     req.body.lastName, res));
app.post('/vollmacht',             async (req, res) => await generateAndSend(buildVollmacht(req.body),          'Vollmacht',             req.body.lastName, res));

app.get('/angebot', async (req, res) => {
  if (!req.query.data) return res.status(400).send('Veri eksik');
  try {
    const b64  = req.query.data.replace(/-/g, '+').replace(/_/g, '/');
    const d    = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
    const address = `${d.street||''} ${d.houseNumber||''}, ${d.zip||''} ${d.city||''}, Deutschland`;
    const satelliteUrl = await getSatelliteUrl(address);
    await generateAndSend(buildAngebot(d, satelliteUrl), 'Angebot', d.lastName||'Kunde', res);
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});
app.get('/aufschiebende',          async (req, res) => await handleGet(req, buildAufschiebende,  'Aufschiebende-Bed', res));
app.get('/vollmacht',              async (req, res) => await handleGet(req, buildVollmacht,       'Vollmacht',         res));

async function handleGet(req, builder, name, res) {
  if (!req.query.data) return res.status(400).send('Veri eksik');
  try {
    const b64  = req.query.data.replace(/-/g, '+').replace(/_/g, '/');
    const data = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
    await generateAndSend(builder(data), name, data.lastName || 'Kunde', res);
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
}

// Geocoding + Static Maps URL oluştur
async function getSatelliteUrl(address) {
  return new Promise((resolve) => {
    const query = encodeURIComponent(address);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${GOOGLE_MAPS_KEY}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.results && json.results[0]) {
            const loc = json.results[0].geometry.location;
            const lat = loc.lat;
            const lng = loc.lng;
            const staticUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=18&size=800x300&maptype=satellite&markers=color:red%7C${lat},${lng}&key=${GOOGLE_MAPS_KEY}`;
            resolve(staticUrl);
          } else {
            resolve('');
          }
        } catch(e) { resolve(''); }
      });
    }).on('error', () => resolve(''));
  });
}

async function generateAndSend(html, name, lastName, res) {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: await chromium.executablePath(),
      headless:       chromium.headless,
      args:           chromium.args,
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const pdfBuffer = await page.pdf({
      format: 'A4', printBackground: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    });
    await browser.close();
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `inline; filename="${name}_${lastName}.pdf"`,
      'Content-Length':      pdfBuffer.length,
      'Cache-Control':       'no-cache',
    });
    res.send(pdfBuffer);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
}

// ── HELPER ────────────────────────────────────────────────────
function fmt(n) { return (parseFloat(n)||0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function firmaFooter() {
  return `<div class="footer-bar">
    <strong>${FIRMA.name}</strong> &bull; ${FIRMA.adresse} &bull; Tel: ${FIRMA.tel} &bull; ${FIRMA.mail}<br>
    ${FIRMA.hrb} ${FIRMA.gericht} &bull; EUID: ${FIRMA.euid} &bull; Geschäftsführer: ${FIRMA.gf}
  </div>`;
}

function baseStyle() {
  const LOGO_URL = BASE_URL + '/images/logo.png';
  return `<style>
    @import url('https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap');
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Lato,Arial,sans-serif;color:#1a1a1a;background:#fdf3e7;font-size:13px;line-height:1.5}
    .page{padding:36px 44px;min-height:297mm;background:#fdf3e7}
    .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #1a4a1a}
    .logo-img{height:56px;width:auto;object-fit:contain}
    .header-right{text-align:right;font-size:11px;color:#5a5a4a;line-height:1.8}
    .badge{display:inline-block;background:#1a4a1a;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;margin-bottom:6px}
    .sec{font-size:10px;font-weight:700;color:#1a4a1a;letter-spacing:0.9px;text-transform:uppercase;margin:18px 0 8px;padding-bottom:5px;border-bottom:2px solid #f5b800}
    table.pos{width:100%;border-collapse:collapse;margin-bottom:16px;page-break-inside:auto}
    table.pos th{background:#1a4a1a;color:#fff;padding:7px 10px;text-align:left;font-size:10px}
    table.pos td{padding:7px 10px;border-bottom:1px solid #e8d5b0;vertical-align:top;page-break-inside:avoid}
    table.pos tr:nth-child(even) td{background:#fef9f0}
    .pn{width:32px;font-weight:700;color:#1a4a1a;font-size:12px}
    .pt{font-weight:700;margin-bottom:2px;font-size:12px;color:#1a4a1a}
    .pd{font-size:11px;color:#5a5a4a;line-height:1.5}
    table.zahl{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:12px}
    table.zahl td{padding:7px 0;border-bottom:1px solid #e8d5b0}
    table.zahl td:last-child{text-align:right;font-weight:700;color:#1a4a1a}
    .pricebox{background:#1a4a1a;border-radius:10px;padding:18px 22px;margin-bottom:16px}
    .prow{display:flex;justify-content:space-between;padding:4px 0;font-size:12px;color:rgba(255,255,255,0.6)}
    .prow.main{border-top:1px solid rgba(255,255,255,0.2);margin-top:8px;padding-top:12px;font-size:17px;color:#fff;font-weight:700}
    .prow.fo{color:#f5b800;font-weight:700;font-size:13px}
    .prow.eg{color:#7ec87e;font-weight:700;font-size:13px}
    .sig-line{width:200px;border-top:1px solid #1a4a1a;margin:28px 0 5px}
    .sig-label{font-size:10px;color:#5a5a4a}
    .tgrid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px}
    .titem{background:#fef9f0;border-radius:6px;padding:9px 12px;border:1px solid #e8d5b0}
    .tlabel{font-size:9px;color:#5a5a4a;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px}
    .tval{font-size:12px;font-weight:700;color:#1a4a1a}
    table.zahl-t{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:12px}
    table.zahl-t td{padding:6px 0;border-bottom:1px solid #e8d5b0}
    table.zahl-t td:last-child{text-align:right;font-weight:700}
    .rbox{background:#fef9f0;border:1px solid #e8d5b0;border-radius:8px;padding:14px 18px;margin-bottom:18px;display:inline-block}
    .rbox .nm{font-size:14px;font-weight:700;color:#1a4a1a;margin-bottom:3px}
    .rbox .ad{font-size:12px;color:#5a5a4a;line-height:1.7}
    .highlight{background:#fef9f0;border-left:4px solid #1a4a1a;padding:14px 18px;border-radius:0 6px 6px 0;margin-bottom:14px}
    .condition-box{background:#fffbe6;border-left:4px solid #f5b800;padding:14px 18px;border-radius:0 6px 6px 0;margin-bottom:14px}
    .condition-title{font-weight:700;color:#1a4a1a;margin-bottom:6px;font-size:13px}
    .condition-text{font-size:12px;color:#3a3a2a;line-height:1.7}
    .pos-header{background:#1a4a1a;color:#fff;padding:8px 12px;font-size:11px;font-weight:700;letter-spacing:0.3px;margin-bottom:0;margin-top:12px}
    .pos-row{border:1px solid #e8d5b0;border-top:none;padding:12px;margin-bottom:4px;background:#fef9f0;page-break-inside:avoid}
    .tuv-note{background:#fef9f0;border:1px solid #e8d5b0;border-radius:6px;padding:10px 14px;font-size:11px;color:#5a5a4a;margin:14px 0;line-height:1.6}
    .contact-box{background:#1a4a1a;border-radius:8px;padding:12px 18px;text-align:center;margin-bottom:20px;font-size:12px;color:#fff}
    .footer-bar{margin-top:20px;padding-top:12px;border-top:2px solid #1a4a1a;font-size:10px;color:#5a5a4a;line-height:1.8}
    .disclaimer{margin-top:8px;padding-top:8px;border-top:1px solid #e8d5b0;font-size:9.5px;color:#8a8a7a;line-height:1.7}
  </style>`;
}

function firmaFooter() {
  return `<div class="footer-bar">
    <strong>${FIRMA.name}</strong> &bull; ${FIRMA.adresse} &bull; Tel: ${FIRMA.tel} &bull; ${FIRMA.mail}<br>
    ${FIRMA.hrb} ${FIRMA.gericht} &bull; EUID: ${FIRMA.euid} &bull; Geschäftsführer: ${FIRMA.gf}
  </div>`;
}

function baseStyle() {
  return `<style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Arial,sans-serif;color:#1a1a1a;background:#fff;font-size:13px;line-height:1.5}
    .page{padding:40px 48px}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;padding-bottom:18px;border-bottom:2.5px solid #1a4a1a}
    .logo{font-size:24px;font-weight:700;color:#1a4a1a}
    .logo-sub{font-size:9px;color:#aaa;text-transform:uppercase;margin-top:2px;letter-spacing:0.5px}
    .header-right{text-align:right;font-size:11px;color:#666;line-height:1.8}
    .badge{display:inline-block;background:#1a4a1a;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:4px;margin-bottom:6px}
    .sec{font-size:10px;font-weight:700;color:#1a4a1a;letter-spacing:0.9px;text-transform:uppercase;margin:20px 0 10px;padding-bottom:5px;border-bottom:1px solid #e8d5b0}
    table.pos{width:100%;border-collapse:collapse;margin-bottom:18px}
    table.pos th{background:#1a4a1a;color:#fff;padding:7px 10px;text-align:left;font-size:10px}
    table.pos td{padding:8px 10px;border-bottom:1px solid #f0ede6;vertical-align:top}
    table.pos tr:nth-child(even) td{background:#fef9f0}
    .pn{width:32px;font-weight:700;color:#1a4a1a;font-size:12px}
    .pt{font-weight:600;margin-bottom:2px;font-size:12px}
    .pd{font-size:11px;color:#777;line-height:1.5}
    .pricebox{background:#1a1a1a;border-radius:10px;padding:18px 22px;margin-bottom:18px}
    .prow{display:flex;justify-content:space-between;padding:4px 0;font-size:12px;color:rgba(255,255,255,0.55)}
    .prow.main{border-top:1px solid rgba(255,255,255,0.2);margin-top:7px;padding-top:11px;font-size:16px;color:#fff;font-weight:700}
    .prow.fo{color:#f5b800;font-weight:700;font-size:13px}
    .prow.eg{color:#1D9E75;font-weight:700;font-size:13px}
    .sig-line{width:200px;border-top:1px solid #1a1a1a;margin:32px 0 5px}
    .sig-label{font-size:10px;color:#aaa}
    .disclaimer{margin-top:10px;padding-top:8px;border-top:1px solid #f0ede6;font-size:9.5px;color:#bbb;line-height:1.7}
    .tgrid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:18px}
    .titem{background:#fef9f0;border-radius:6px;padding:9px 12px;border:1px solid #e8d5b0}
    .tlabel{font-size:9px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px}
    .tval{font-size:12px;font-weight:600}
    table.zahl{width:100%;border-collapse:collapse;margin-bottom:18px;font-size:12px}
    table.zahl td{padding:6px 0;border-bottom:1px solid #f0ede6}
    table.zahl td:last-child{text-align:right;font-weight:600}
    .rbox{background:#fef9f0;border:1px solid #e8d5b0;border-radius:8px;padding:14px 18px;margin-bottom:20px;display:inline-block}
    .rbox .nm{font-size:14px;font-weight:600;margin-bottom:3px}
    .rbox .ad{font-size:12px;color:#555;line-height:1.7}
    .highlight{background:#e8d5b0;border-left:4px solid #1a4a1a;padding:14px 18px;border-radius:0 6px 6px 0;margin-bottom:16px}
    .condition-box{background:#fef9e7;border-left:4px solid #f5b800;padding:14px 18px;border-radius:0 6px 6px 0;margin-bottom:14px}
    .condition-title{font-weight:700;color:#1a1a1a;margin-bottom:6px;font-size:13px}
    .condition-text{font-size:12px;color:#444;line-height:1.7}
  </style>`;
}

function pageHeader(title) {
  const logoUrl = BASE_URL + '/images/logo.png';
  return `<div class="header">
    <img src="${logoUrl}" class="logo-img" alt="${FIRMA.name}" onerror="this.style.display='none'">
    <div class="header-right">
      ${FIRMA.adresse}<br>Tel: ${FIRMA.tel}<br>${FIRMA.mail}
    </div>
  </div>
  <div class="badge">${title}</div>`;
}


// ── 1. ANGEBOT ────────────────────────────────────────────────
function buildAngebot(d, satelliteUrl) {
  const brutto      = parseFloat(d.totalIncl) || 0;
  const netto       = brutto / 1.19;
  const mwst        = brutto - netto;
  const foerder     = parseFloat(d.foerderSumme) || 0;
  const eigenanteil = brutto - foerder;

  const agreementLabels = {
    '22143':'inkl. SG Ready Schnittstelle-PV/WP (Aufputz/bis 5m)',
    '22142':'inkl. Aufstellort Außen bis 2m - ab 2m je Meter 250 EUR',
    '22141':'inkl. Erdung 2x je 10m, falls nicht vorhanden',
    '22140':'inkl. zwei Heizkreise (Fußbodenheizung/Heizkörper)',
    '22139':'inkl. Fußbodenheizkreisverteiler Austausch',
    '22138':'inkl. Niedertemperaturheizkörper mit Kühlfunktion',
    '22137':'inkl. Heizkörpertausch gemäß Heizlastberechnung',
    '22135':'inkl. Solarthermie-Anbindung',
    '22134':'inkl. Unterverteilung für 2. Stromzähler (WP-Tarif)',
    '22133':'inkl. 14A Schrank (APZ & RFZ Feld)',
    '22114':'KfW-Ablehnungsklausel: Kostenfreie Stornierung bei Ablehnung',
    '22049':'inkl. neuem separaten 2-Zählerfeld Aufputz Zählerschrank',
    '22048':'inkl. Ausbau und Entsorgung des Öltanks',
    '22044':'inkl. neuem separaten 4-Zählerfeld Aufputz Zählerschrank',
    '22043':'inkl. neuem separaten 3-Zählerfeld Aufputz Zählerschrank',
  };

  const agreementsHtml = (d.agreements || [])
    .map(v => `<tr><td style="padding:6px 12px;font-size:12px;border-bottom:1px solid #f0ede6">✓ ${agreementLabels[v]||v}</td></tr>`)
    .join('');

  // Ürüne göre resim seç
  // Ürüne göre değişkenler
  const isViessmann250 = (d.moduleName||d.module||'').toString().includes('250');
  const isViessmann150 = (d.moduleName||d.module||'').toString().includes('150');
  const isBuderus      = (d.moduleName||d.module||'').toString().includes('BUDERUS') || (d.moduleName||d.module||'').toString().includes('WLW');
  const moduleName     = d.moduleName || d.module || '–';

  // Ürüne göre resim seç
  let imgAussen = PRODUKT_IMAGES.viessmann_250_aussen;
  let imgInnen  = PRODUKT_IMAGES.viessmann_250_innen;
  if (isViessmann150) {
    imgAussen = PRODUKT_IMAGES.viessmann_150_aussen;
    imgInnen  = PRODUKT_IMAGES.viessmann_150_innen;
  } else if (isBuderus) {
    imgAussen = PRODUKT_IMAGES.buderus_aussen;
    imgInnen  = PRODUKT_IMAGES.buderus_innen;
  }

  let produktDetails = '';
  if (isViessmann250) {
    produktDetails = `
      <div style="margin-top:8px">
        <table style="width:100%;font-size:11px;border-collapse:collapse">
          <tr><td style="padding:3px 8px;color:#666;width:55%">Leistung</td><td style="padding:3px 8px;font-weight:600">${moduleName.match(/\d+kW/)?.[0]||'–'}</td></tr>
          <tr style="background:#fef9f0"><td style="padding:3px 8px;color:#666">Modulierender Kompressor</td><td style="padding:3px 8px;font-weight:600">Ja (Inverter)</td></tr>
          <tr><td style="padding:3px 8px;color:#666">Max. Vorlauftemperatur</td><td style="padding:3px 8px;font-weight:600">70 °C (bis -10 °C Außentemp.)</td></tr>
          <tr style="background:#fef9f0"><td style="padding:3px 8px;color:#666">Kältemittel</td><td style="padding:3px 8px;font-weight:600">R290 (Propan, GWP 0,02)</td></tr>
          <tr><td style="padding:3px 8px;color:#666">Heizbetrieb bis</td><td style="padding:3px 8px;font-weight:600">-20 °C Außentemperatur</td></tr>
          <tr style="background:#fef9f0"><td style="padding:3px 8px;color:#666">Anzahl der Phasen</td><td style="padding:3px 8px;font-weight:600">3-phasig</td></tr>
          <tr><td style="padding:3px 8px;color:#666">Abmessungen (B/T/H)</td><td style="padding:3px 8px;font-weight:600">1144 x 600 x 1382 mm</td></tr>
          <tr style="background:#fef9f0"><td style="padding:3px 8px;color:#666">Förderfähig nach BEG</td><td style="padding:3px 8px;font-weight:600;color:#1a4a1a">Ja</td></tr>
          <tr><td style="padding:3px 8px;color:#666">Auszeichnung</td><td style="padding:3px 8px;font-weight:600">Testsieger Stiftung Warentest 2025</td></tr>
        </table>
      </div>`;
  } else if (isViessmann150) {
    produktDetails = `
      <div style="margin-top:8px">
        <table style="width:100%;font-size:11px;border-collapse:collapse">
          <tr><td style="padding:3px 8px;color:#666;width:55%">Leistung</td><td style="padding:3px 8px;font-weight:600">${moduleName.match(/\d+kW/)?.[0]||'–'}</td></tr>
          <tr style="background:#fef9f0"><td style="padding:3px 8px;color:#666">Modulierender Kompressor</td><td style="padding:3px 8px;font-weight:600">Ja (Inverter)</td></tr>
          <tr><td style="padding:3px 8px;color:#666">Max. Vorlauftemperatur</td><td style="padding:3px 8px;font-weight:600">70 °C (A10/A13 Modelle)</td></tr>
          <tr style="background:#fef9f0"><td style="padding:3px 8px;color:#666">Kältemittel</td><td style="padding:3px 8px;font-weight:600">R290 (Propan, GWP 0,02)</td></tr>
          <tr><td style="padding:3px 8px;color:#666">Leistungsbereich</td><td style="padding:3px 8px;font-weight:600">2,1 bis 14,9 kW</td></tr>
          <tr style="background:#fef9f0"><td style="padding:3px 8px;color:#666">Ausführung</td><td style="padding:3px 8px;font-weight:600">Monoblock</td></tr>
          <tr><td style="padding:3px 8px;color:#666">Förderfähig nach BEG</td><td style="padding:3px 8px;font-weight:600;color:#1a4a1a">Ja</td></tr>
          <tr style="background:#fef9f0"><td style="padding:3px 8px;color:#666">Einsatzbereich</td><td style="padding:3px 8px;font-weight:600">Neubau & Modernisierung</td></tr>
        </table>
      </div>`;
  } else if (isBuderus) {
    produktDetails = `
      <div style="margin-top:8px">
        <table style="width:100%;font-size:11px;border-collapse:collapse">
          <tr><td style="padding:3px 8px;color:#666;width:55%">Leistung</td><td style="padding:3px 8px;font-weight:600">${moduleName.match(/\d+/g)?.[moduleName.match(/\d+/g).length-1]||'–'} kW</td></tr>
          <tr style="background:#fef9f0"><td style="padding:3px 8px;color:#666">Kältemittel</td><td style="padding:3px 8px;font-weight:600">R290 (Propan, GWP 0,02)</td></tr>
          <tr><td style="padding:3px 8px;color:#666">Max. Vorlauftemperatur</td><td style="padding:3px 8px;font-weight:600">70 °C</td></tr>
          <tr style="background:#fef9f0"><td style="padding:3px 8px;color:#666">Integrierter Pufferspeicher</td><td style="padding:3px 8px;font-weight:600">70 Liter</td></tr>
          <tr><td style="padding:3px 8px;color:#666">Elektrischer Zuheizer</td><td style="padding:3px 8px;font-weight:600">9 kW</td></tr>
          <tr style="background:#fef9f0"><td style="padding:3px 8px;color:#666">Ausführung</td><td style="padding:3px 8px;font-weight:600">Monoblock (Split-System)</td></tr>
          <tr><td style="padding:3px 8px;color:#666">Förderfähig nach BEG</td><td style="padding:3px 8px;font-weight:600;color:#1a4a1a">Ja</td></tr>
          <tr style="background:#fef9f0"><td style="padding:3px 8px;color:#666">Smart Grid Ready</td><td style="padding:3px 8px;font-weight:600">Ja</td></tr>
        </table>
      </div>`;
  }

  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">${baseStyle()}
  <style>
    .cover{background:#1a4a1a;color:#fff;padding:48px;min-height:220px;position:relative;overflow:hidden}
    .cover::after{content:'';position:absolute;right:-40px;top:-40px;width:220px;height:220px;border-radius:50%;background:rgba(245,184,0,0.1)}
    .cover h1{font-size:32px;font-weight:700;margin-bottom:6px}
    .cover .sub{font-size:14px;opacity:0.7;margin-bottom:20px}
    .cover .nr{font-size:13px;background:rgba(245,184,0,0.2);border:1px solid rgba(245,184,0,0.4);display:inline-block;padding:5px 14px;border-radius:4px;color:#f5b800}
    .berater-box{background:#f5b800;color:#1a4a1a;padding:10px 14px;font-size:12px;font-weight:700;display:inline-block;border-radius:4px;margin-bottom:6px}
  </style>
  </head><body><div class="page" style="padding:0">

  <!-- KAPAK SAYFASI -->
  <div class="cover">
    <img src="${BASE_URL}/images/logo.png" style="height:70px;width:auto;margin-bottom:20px;display:block" onerror="this.style.display='none'">
    <h1>Ihr persönliches Angebot</h1>
    <div class="sub">${d.salutation} ${d.firstName} ${d.lastName} &bull; ${d.street} ${d.houseNumber}, ${d.zip} ${d.city}</div>
    <div class="nr">Angebot ${d.angebotNr||''} &nbsp;&bull;&nbsp; ${d.date||new Date().toLocaleDateString('de-DE')}</div>
  </div>

  <div style="padding:40px 48px">

  <!-- UYDU GÖRSELİ -->
  <div style="margin-bottom:24px;border-radius:10px;overflow:hidden;border:2px solid #e8d5b0">
    <img src="${satelliteUrl}" style="width:100%;height:200px;object-fit:cover;display:block" onerror="this.style.display='none'">
    <div style="padding:6px 12px;background:#fef9f0;font-size:10px;color:#888">
      ${d.street} ${d.houseNumber}, ${d.zip} ${d.city} — Satellitenansicht
    </div>
  </div>

  <!-- BERATER + KONTAKT -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid #e0ddd5">
    <div>
      <div class="berater-box">Ihr persönlicher Berater: ${FIRMA.gf}</div><br>
      <div style="font-size:12px;color:#666;margin-top:4px">
        Tel: ${FIRMA.tel} &bull; ${FIRMA.mail}<br>
        Erreichbar: Mo–Fr 9:00–17:00 Uhr
      </div>
    </div>
    <div style="text-align:right;font-size:11px;color:#aaa;line-height:1.8">
      ${FIRMA.adresse}<br>${FIRMA.web}
    </div>
  </div>

  <!-- ANSCHREIBEN -->
  <p style="font-size:13px;color:#444;line-height:1.8;margin-bottom:28px">
    Sehr geehrte${d.salutation==='Frau'?'':'r'} ${d.salutation} ${d.lastName},<br><br>
    wir freuen uns, Ihnen heute das Angebot für Ihre Wärmepumpe zusenden zu können.
    Gerne stehen wir Ihnen jederzeit mit Rat und Tat zur Seite und unterstützen Sie
    in der zügigen Planung, Errichtung und Installation Ihrer Wärmepumpe.<br><br>
    Sie erreichen uns Montags bis Freitags zwischen 9:00 und 17:00 Uhr unter
    <strong>${FIRMA.tel}</strong>. Außerhalb unserer Geschäftszeiten erreichen Sie uns
    per E-Mail: <strong>${FIRMA.mail}</strong>.<br><br>
    Auf den folgenden Seiten finden Sie Ihr persönliches Angebot sowie alle relevanten Unterlagen.<br><br>
    Wir freuen uns auf Ihre Bestellung und sichern Ihnen pünktliche Lieferung und Montage zu.
  </p>
  <div style="font-size:13px;color:#444;margin-bottom:32px">
    Mit freundlichen Grüßen,<br>
    <strong>${FIRMA.name}</strong>
  </div>

  <!-- TRENNLINIE -->
  <div style="border-top:2.5px solid #1a4a1a;margin:32px 0 28px"></div>

  <!-- ANGEBOTSDETAILS TITEL -->
  <div style="text-align:center;margin-bottom:24px">
    <div style="font-size:22px;font-weight:700;color:#1a4a1a">Angebotsdetails ${d.angebotNr||''}</div>
    <div style="font-size:11px;color:#aaa;margin-top:4px">Leistungsübersicht der ${FIRMA.name}</div>
    <div style="font-size:11px;color:#666;margin-top:2px">Beratung | Planung | Finanzservice | Logistik | Montage und Inbetriebnahme durch unsere zertifizierten Fachkräfte</div>
  </div>

  <!-- TECHNISCHE ECKDATEN -->
  <div class="sec">Technische Eckdaten des Objektes</div>
  <div class="tgrid" style="margin-bottom:24px">
    <div class="titem"><div class="tlabel">Wohnfläche</div><div class="tval">${d.wohnflaeche||'–'} m²</div></div>
    <div class="titem"><div class="tlabel">Baujahr</div><div class="tval">${d.baujahr||'–'}</div></div>
    <div class="titem"><div class="tlabel">Heizkörper</div><div class="tval">${d.heizkoerper||'–'}</div></div>
    <div class="titem"><div class="tlabel">Heizenergieart</div><div class="tval">${d.heizenergieart||'–'}</div></div>
    <div class="titem"><div class="tlabel">Verbrauch/Jahr</div><div class="tval">${d.energy?parseInt(d.energy).toLocaleString('de-DE')+' kWh':'–'}</div></div>
    <div class="titem"><div class="tlabel">Heizkosten/Jahr</div><div class="tval">${d.kwhprice?parseFloat(d.kwhprice).toLocaleString('de-DE',{minimumFractionDigits:2})+' €':'–'}</div></div>
  </div>

  <!-- POS 1: AUSSENGERÄT -->
  <div class="pos-header">POS 1 — Wärmepumpen Außengerät</div>
  <div class="pos-row">
    <div style="display:flex;gap:16px;align-items:flex-start">
      <img src="${imgAussen}" alt="${moduleName}" style="width:140px;height:140px;object-fit:contain;flex-shrink:0;border-radius:6px;border:1px solid #e8d5b0;padding:6px;background:#fef9f0" onerror="this.style.display='none'">
      <div style="flex:1">
        <div style="font-size:13px;font-weight:700;color:#1a4a1a;margin-bottom:6px">${moduleName}</div>
        ${produktDetails}
      </div>
    </div>
  </div>

  <!-- POS 2: INNENEINHEIT -->
  <div class="pos-header">POS 2 — Wärmepumpen Inneneinheit</div>
  <div class="pos-row">
    <div style="display:flex;gap:16px;align-items:flex-start">
      <img src="${imgInnen}" alt="Inneneinheit" style="width:140px;height:140px;object-fit:contain;flex-shrink:0;border-radius:6px;border:1px solid #e8d5b0;padding:6px;background:#fef9f0" onerror="this.style.display='none'">
      <div style="flex:1;font-size:12px;color:#444;line-height:1.7">
      Kompakte Inneneinheit für effizientes Heizen und Kühlen. Die Inneneinheit übernimmt die
      komplette hydraulische Einbindung der Wärmepumpe und enthält alle wichtigen Komponenten
      wie Umwälzpumpe, Umschaltventil und Sicherheitsarmaturen. Dank Vorlauftemperaturen bis
      70 °C eignet sie sich ideal für Neubauten und Modernisierungen.
    </div>
  </div>

  <!-- POS 3-15 KOMPAKT -->
  <table class="pos">
    <thead><tr><th class="pn">POS</th><th>Bezeichnung</th></tr></thead>
    <tbody>
      <tr><td class="pn">3</td><td><div class="pt">Hochleistungs-Pufferspeicher 75L</div><div class="pd">✓ 75 Liter &bull; Innen roh, außen grundiert &bull; Max. 3 bar &bull; bis 110°C &bull; Vliesdämmung</div></td></tr>
      <tr><td class="pn">4</td><td><div class="pt">Hochleistungs-Hygienespeicher 300L</div><div class="pd">✓ 300 Liter &bull; Stahl S235JR &bull; Max. 10 bar &bull; Max. 95°C &bull; El. Zusatzheizung 3kW &bull; Energieklasse A+++</div></td></tr>
      <tr><td class="pn">5</td><td><div class="pt">Elektrische Zusatzheizung (pauschal)</div><div class="pd">✓ Bis 9 kW &bull; Werkseitig verbaut &bull; Automatischer Zuschaltbetrieb &bull; Förderfähig nach BEG &bull; Kein Dauerbetrieb</div></td></tr>
      <tr><td class="pn">6</td><td><div class="pt">Verrohrungssystem (pauschal)</div><div class="pd">✓ Systemkonform &bull; Wärme-/Kälteisolierung gemäß GEG &bull; Druckprüfung &bull; Dichtheitsnachweis &bull; TÜV-geprüfte Komponenten</div></td></tr>
      <tr><td class="pn">7</td><td><div class="pt">Demontage Altanlage & Montage Neuanlage (pauschal)</div><div class="pd">✓ Fachgerechte Stilllegung &bull; Ausbau Altheizung &bull; Gasleitungsverschluss gemäß DVGW &bull; Aufstellung & Einbindung WP</div></td></tr>
      <tr><td class="pn">8</td><td><div class="pt">Projektierung – Planung & technische Auslegung (pauschal)</div><div class="pd">✓ Heizlastberechnung DIN EN 12831 &bull; Hydraulikschema &bull; Abstimmung Netzbetreiber/Schornsteinfeger &bull; Förderantrag BEG EM</div></td></tr>
      <tr><td class="pn">9</td><td><div class="pt">Fördermittel – Unterstützung & Abwicklung (pauschal)</div><div class="pd">✓ BEG EM über KfW &bull; Effizienz-/Emissionsbonus &bull; BzA/BnD Erstellung &bull; Koordination Energieeffizienz-Experte &bull; Vollständige Abwicklung</div></td></tr>
      <tr><td class="pn">10</td><td><div class="pt">Anmeldung und Fertigmeldung beim Netzbetreiber (pauschal)</div><div class="pd">✓ EVU-Anmeldung &bull; Betriebsschaltbild &bull; Prüfprotokoll &bull; Fertigmeldung &bull; Schriftverkehr komplett</div></td></tr>
      <tr><td class="pn">11</td><td><div class="pt">Elektroinstallation Anschluss & Steuerung (pauschal)</div><div class="pd">✓ Stromzuleitung &bull; FI-/Leitungsschutzschalter &bull; Steuer-/Datenleitungen &bull; Eingetragener Elektrofachbetrieb mit Nachweis</div></td></tr>
      <tr><td class="pn">12</td><td><div class="pt">Erstinbetriebnahme gemäß Herstellervorgaben (pauschal)</div><div class="pd">✓ Druckprüfung &bull; Parametrierung Heizkurven &bull; Testlauf &bull; Betreibereinweisung &bull; Vollständige Anlagendokumentation</div></td></tr>
      <tr><td class="pn">13</td><td><div class="pt">Hydraulischer Abgleich – Verfahren B nach VdZ (pauschal)</div><div class="pd">✓ VdZ-Nachweis &bull; Raumweise Heizlastberechnung DIN EN 12831 &bull; Volumenströme je Heizkreis &bull; Pflicht für BEG EM Förderung</div></td></tr>
      <tr><td class="pn">14</td><td><div class="pt">Technischer Support (pauschal)</div><div class="pd">✓ Hersteller-Service-Team direkt &bull; ${FIRMA.name} Service-Team &bull; Ferndiagnose möglich</div></td></tr>
      <tr><td class="pn">15</td><td><div class="pt">${FIRMA.name} – Garantieversprechen</div><div class="pd">✓ Bestpreisgarantie &bull; Festpreisgarantie: schlüsselfertig ohne Mehrpreisrisiken &bull; 100% Käuferschutz &bull; Keine Vorkasse &bull; Mündliche Abmachungen nicht Vertragsbestandteil</div></td></tr>
    </tbody>
  </table>

  ${agreementsHtml?`
  <div class="sec">Zusatzvereinbarungen</div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px;border:1px solid #e8d5b0;border-radius:6px;overflow:hidden">
    <tbody>${agreementsHtml}</tbody>
  </table>`:''}

  <div class="tuv-note">
    Unsere Fachpartner verwenden ausschließlich <strong>TÜV-geprüfte Komponenten</strong>, die sämtlichen gängigen Normen
    und Zertifizierungen entsprechen. Es gelten die Garantien nach Herstellerangaben.
  </div>

  <!-- ZAHLUNG -->
  <div class="sec">Zahlungsmodalitäten</div>
  <table class="zahl">
    <tr><td style="font-weight:500">1. Abschlag, 80%, bei Warenlieferung</td><td style="color:#1a4a1a;font-size:14px">${fmt(brutto*0.8)} €</td></tr>
    <tr><td style="font-weight:500">2. Abschlag, 20%, bei Inbetriebnahme</td><td style="color:#1a4a1a;font-size:14px">${fmt(brutto*0.2)} €</td></tr>
  </table>

  <!-- PREISBOX -->
  <div class="pricebox">
    <div class="prow"><span>Gesamtsumme Netto</span><span>${fmt(netto)} €</span></div>
    <div class="prow"><span>19% MwSt.</span><span>${fmt(mwst)} €</span></div>
    <div class="prow main"><span>Gesamtsumme Brutto</span><span>${fmt(brutto)} €</span></div>
    ${foerder>0?`
    <div class="prow fo"><span>Ihre Fördersumme (${d.heatingcosts||''}% KfW BEG)</span><span>${fmt(foerder)} €</span></div>
    <div class="prow eg"><span>Ihr Eigenanteil nach Förderung</span><span>${fmt(eigenanteil)} €</span></div>`:''}
  </div>

  <!-- KONTAKT BOX -->
  <div style="background:#e8d5b0;border-radius:8px;padding:14px 18px;text-align:center;margin-bottom:24px;font-size:12px;color:#1a4a1a">
    <strong>Bei Rückfragen stehen wir Ihnen jederzeit zur Verfügung</strong><br>
    Telefon: ${FIRMA.tel} &nbsp;&bull;&nbsp; E-Mail: ${FIRMA.mail} &nbsp;&bull;&nbsp; ${FIRMA.web}
  </div>

  <!-- UNTERSCHRIFT -->
  <p style="font-size:12px;color:#555;line-height:1.7;margin-bottom:6px">
    Hiermit nehme ich das Angebot vom ${d.date||new Date().toLocaleDateString('de-DE')} an
    und beauftrage die <strong>${FIRMA.name}</strong> zur Durchführung meines Projektes.
  </p>
  <div style="display:flex;justify-content:space-between;margin-top:24px">
    <div>
      <div style="font-size:11px;color:#aaa;margin-bottom:28px">${d.city||'___________'}, ${d.date||'___________'}</div>
      <div class="sig-line" style="width:200px"></div>
      <div class="sig-label">Ort, Datum</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:11px;color:#aaa;margin-bottom:28px">&nbsp;</div>
      <div class="sig-line" style="width:240px"></div>
      <div class="sig-label">Unterschrift — ${d.salutation} ${d.firstName} ${d.lastName}</div>
    </div>
  </div>

  ${firmaFooter()}
  <div class="disclaimer">
    Sofern eine Teilzahlungsvereinbarung geschlossen wird, wird diese zum wesentlichen Bestandteil dieses Auftrages.
    Die o.g. Zahlungsbedingungen entfallen dann; der Zahlungsausgleich erfolgt nach Abnahme durch die refinanzierende Bank.
    Die staatlichen Fördermittel sind nicht Bestandteil dieses Angebots. ${FIRMA.name} übernimmt keine Haftung dafür.
    Mündliche Abmachungen oder Vereinbarungen sind nicht Bestandteil des Vertrags.
  </div>

  </div><!-- /padding -->
  </div></body></html>`;
}

// ── 2. AUFSCHIEBENDE BEDINGUNGEN ─────────────────────────────
function buildAufschiebende(d) {
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">${baseStyle()}</head><body><div class="page">
  ${pageHeader('Aufschiebende Bedingungen')}
  <br>
  <div class="condition-box">
    <div class="condition-title">Aufschiebende Bedingung:</div>
    <div class="condition-text">
      Dieser (Kauf-)Vertrag tritt hinsichtlich der Liefer- und Leistungspflichten zur Umsetzung erst und nur insoweit in Kraft,
      wenn und soweit die KfW den Antrag zur Heizungsmodernisierung bewilligt und die Förderung mit einer Zusage gegenüber
      der antragstellenden Vertragspartei zugesagt hat. Die antragstellende Vertragspartei wird die jeweils andere Vertragspartei
      über den Eintritt und den Umfang des Eintritts der Bedingung unverzüglich in Kenntnis setzen.
    </div>
  </div>

  <div class="condition-box">
    <div class="condition-title">Auflösende Bedingung:</div>
    <div class="condition-text">
      Dieser (Kauf-)Vertrag erlischt hinsichtlich der Liefer- und Leistungspflichten zur Umsetzung, sobald und soweit die KfW
      den Antrag zur Heizungsmodernisierung nicht bewilligt, sondern ablehnt und die Förderung nicht mit einer Zusage gegenüber
      der antragstellenden Vertragspartei zusagt, sondern mit einem Ablehnungsbescheid versagt.<br><br>
      Die antragstellende Vertragspartei wird die jeweils andere Vertragspartei über den Eintritt und den Umfang des Eintritts
      der Bedingung unverzüglich in Kenntnis setzen.
    </div>
  </div>

  <div class="sec">Widerrufsrecht</div>
  <p style="font-size:12px;color:#444;line-height:1.8;margin-bottom:12px">
    Sie haben das Recht, binnen 14 Tagen ohne Angaben von Gründen diesen Vertrag zu widerrufen.<br><br>
    Die Widerrufsfrist beträgt 14 Tage ab dem Tag des Vertragsabschlusses. Sie beginnt nicht zu laufen, bevor Sie diese
    Belehrung in Textform erhalten haben.<br><br>
    Um Ihr Widerrufsrecht auszuüben, müssen Sie uns mittels einer eindeutigen Erklärung (z.B. Brief, Telefax oder E-Mail)
    über Ihren Entschluss, diesen Vertrag zu widerrufen, informieren.<br><br>
    Zur Wahrung der Widerrufsfrist reicht es aus, dass Sie die Erklärung über die Ausübung des Widerrufsrechts vor Ablauf
    der Widerrufsfrist absenden.
  </p>

  <div class="sec">Folgen des Widerrufs</div>
  <p style="font-size:12px;color:#444;line-height:1.8;margin-bottom:32px">
    Wenn Sie diesen Vertrag widerrufen, haben wir Ihnen alle Zahlungen, die wir von Ihnen erhalten haben, unverzüglich
    zurückzuzahlen.<br><br>
    Sie müssen uns im Falle des Widerrufs alle Leistungen zurückgeben, die Sie bis zum Widerruf von uns erhalten haben.
    Ist die Rückgewähr einer Leistung ihrer Natur nach ausgeschlossen, lassen sich etwa verwendete Baumaterialien nicht
    ohne Zerstörung entfernen, müssen Sie Wertersatz dafür bezahlen.
  </p>

  <div style="display:flex;justify-content:space-between;margin-top:40px">
    <div><div class="sig-line" style="width:220px"></div><div class="sig-label">Ort, Datum</div></div>
    <div><div class="sig-line" style="width:220px"></div><div class="sig-label">Unterschrift Auftraggeber${d.firstName?' — '+d.salutation+' '+d.firstName+' '+d.lastName:''}</div></div>
  </div>
  ${firmaFooter()}
</div></body></html>`;
}

// ── 3. VOLLMACHT ──────────────────────────────────────────────
function buildVollmacht(d) {
  function row(label, val) {
    return `<tr>
      <td style="padding:8px 12px;font-size:12px;color:#666;background:#fef9f0;border:1px solid #e8d5b0;width:35%">${label}</td>
      <td style="padding:8px 12px;font-size:12px;font-weight:500;border:1px solid #e8d5b0">${val||''}</td>
    </tr>`;
  }

  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">${baseStyle()}</head><body><div class="page">
  ${pageHeader('Vollmacht')}
  <p style="font-size:13px;font-weight:600;margin-bottom:16px">
    für die Abwicklung und Erledigung der erforderlichen An- und Fertigmeldungen meines Bauvorhabens beim zuständigen Netzbetreiber.
  </p>

  <div class="sec">Hiermit bevollmächtige(n) ich/wir:</div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
    <tbody>
      ${row('Vorname', d.firstName)}
      ${row('Name', d.lastName)}
      ${row('Straße / Nr.', (d.street||'') + ' ' + (d.houseNumber||''))}
      ${row('PLZ / Ort', (d.zip||'') + ' ' + (d.city||''))}
      ${row('Geburtsdatum', '')}
      ${row('Mobil', d.mobileNumber||'')}
      ${row('Telefon', d.phoneNumber||'')}
      ${row('E-Mail', d.emailAddress||'')}
    </tbody>
  </table>

  <div class="highlight" style="margin-bottom:20px">
    <p style="font-size:12px;line-height:1.8;color:#1a1a1a">
      Die Firma <strong>${FIRMA.name}</strong>, ${FIRMA.adresse} bzw. deren ausgewiesenen Repräsentanten oder Vertragspartnern,
      alle erforderlichen Unterlagen, im Rahmen der elektronischen Antragsstellung zur An- und Fertigmeldung meines
      Bauvorhabens beim zuständigen Netzbetreiber, für den Antragsteller und den Grundstückseigentümer in meinem/unseren
      Namen auszufüllen, zu unterzeichnen und einzureichen.
    </p>
  </div>

  <div class="sec">Adresse des Bauvorhabens:</div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
    <tbody>
      ${row('Straße, Hr.', (d.street||'') + ' ' + (d.houseNumber||''))}
      ${row('PLZ, Ort', (d.zip||'') + ' ' + (d.city||''))}
      ${row('Germarkung', '')}
      ${row('Flurnummer', '')}
      ${row('Zählernummer', '')}
      ${row('Netzbetreiber', '')}
    </tbody>
  </table>

  <div class="sec">Die Einspeisevergütung soll auf folgendes Konto überwiesen werden:</div>
  <table style="width:100%;border-collapse:collapse;margin-bottom:28px">
    <tbody>
      ${row('Kontoinhaber', '')}
      ${row('Steuernummer', '')}
      ${row('IBAN, BIC', '')}
    </tbody>
  </table>

  <p style="font-size:12px;font-weight:600;text-align:center;margin-bottom:32px">
    Diese Vollmacht ist gültig bis zum Abschluss o.g. Maßnahme.
  </p>

  <div style="display:flex;justify-content:space-between;margin-top:20px">
    <div><div class="sig-line" style="width:220px"></div><div class="sig-label">Datum, Ort</div></div>
    <div><div class="sig-line" style="width:220px"></div><div class="sig-label">Unterschrift(en) Auftraggeber(in)</div></div>
  </div>
  ${firmaFooter()}
</div></body></html>`;
}

app.listen(PORT, function() {
  console.log('Volksenergie Schwaben PDF Service running on port ' + PORT);
});
