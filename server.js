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
  @import url('https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Lato,Arial,sans-serif;background:#fdf3e7;color:#1a1a1a;font-size:13px}
  .page{max-width:820px;margin:0 auto;background:#fdf3e7;padding:32px 40px}
  .print-btn{position:fixed;bottom:24px;right:24px;background:#1a4a1a;color:#fff;border:none;
    padding:14px 28px;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;
    box-shadow:0 4px 16px rgba(26,74,26,.4);z-index:999;display:flex;align-items:center;gap:8px}
  .print-btn:hover{background:#2d7a2d}
  .header{display:flex;justify-content:space-between;align-items:center;
    margin-bottom:20px;padding-bottom:14px;border-bottom:3px solid #1a4a1a}
  .logo{height:60px;width:auto;background:#fdf3e7;border-radius:8px;padding:4px;object-fit:contain}
  .header-right{text-align:right;font-size:11px;color:#5a5a4a;line-height:1.8}
  .badge{display:inline-block;background:#1a4a1a;color:#fff;font-size:10px;font-weight:700;
    padding:3px 10px;border-radius:4px;margin-bottom:6px}
  .anr-title{font-size:20px;font-weight:700;color:#1a4a1a;margin-bottom:3px}
  .anr-date{font-size:11px;color:#aaa;margin-bottom:16px}
  .rbox{background:#fef9f0;border:1px solid #e8d5b0;border-radius:8px;
    padding:12px 16px;margin-bottom:16px;display:inline-block}
  .rbox .nm{font-size:13px;font-weight:700;color:#1a4a1a;margin-bottom:2px}
  .rbox .ad{font-size:11px;color:#5a5a4a;line-height:1.7}
  .intro{font-size:12.5px;color:#444;line-height:1.8;margin-bottom:20px}
  .sec{font-size:10px;font-weight:700;color:#1a4a1a;letter-spacing:.9px;text-transform:uppercase;
    margin:16px 0 8px;padding-bottom:4px;border-bottom:2px solid #f5b800}
  .tgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
  .titem{background:#fef9f0;border:1px solid #e8d5b0;border-radius:6px;padding:8px 10px}
  .tlabel{font-size:9px;color:#aaa;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
  .tval{font-size:12px;font-weight:700;color:#1a4a1a}
  .pos-header{background:#1a4a1a;color:#fff;padding:7px 10px;font-size:10px;font-weight:700;margin-top:10px}
  .pos-row{border:1px solid #e8d5b0;border-top:none;padding:10px;background:#fef9f0}
  .pos-row .pt{font-weight:700;font-size:12px;color:#1a4a1a;margin-bottom:2px}
  .pos-row .pd{font-size:11px;color:#5a5a4a;line-height:1.5}
  .prod-wrap{display:flex;gap:14px;align-items:flex-start}
  .prod-img{width:120px;height:120px;object-fit:contain;border:1px solid #e8d5b0;
    border-radius:6px;background:#fff;padding:6px;flex-shrink:0}
  table.pos-tbl{width:100%;border-collapse:collapse;margin-top:8px}
  table.pos-tbl th{background:#1a4a1a;color:#fff;padding:6px 8px;text-align:left;font-size:10px}
  table.pos-tbl td{padding:6px 8px;border-bottom:1px solid #e8d5b0;font-size:11px;vertical-align:top}
  table.pos-tbl tr:nth-child(even) td{background:#fef9f0}
  .pn{width:28px;font-weight:700;color:#1a4a1a;font-size:11px}
  .price-box{background:#1a4a1a;border-radius:10px;padding:16px 20px;margin:16px 0}
  .pr{display:flex;justify-content:space-between;padding:3px 0;font-size:12px;color:rgba(255,255,255,.6)}
  .pr.main{border-top:1px solid rgba(255,255,255,.2);margin-top:7px;padding-top:10px;
    font-size:16px;color:#fff;font-weight:700}
  .pr.fo{color:#f5b800;font-weight:700;font-size:13px}
  .pr.eg{color:#7ec87e;font-weight:700;font-size:13px}
  .sig-line{width:200px;border-top:1px solid #1a4a1a;margin:28px 0 4px}
  .sig-label{font-size:10px;color:#aaa}
  .footer{margin-top:20px;padding-top:12px;border-top:2px solid #1a4a1a;
    font-size:10px;color:#5a5a4a;line-height:1.8}
  .disclaimer{font-size:9.5px;color:#aaa;line-height:1.6;margin-top:8px;
    padding-top:8px;border-top:1px solid #e8d5b0}
  .contact-box{background:#1a4a1a;border-radius:8px;padding:10px 16px;
    text-align:center;font-size:11px;color:#fff;margin:14px 0}
  .map-img{width:100%;height:180px;object-fit:cover;border-radius:8px;
    border:1px solid #e8d5b0;margin-bottom:14px}
  .cond-box{background:#fffbe6;border-left:4px solid #f5b800;padding:12px 16px;
    border-radius:0 6px 6px 0;margin-bottom:12px}
  .cond-title{font-weight:700;color:#1a4a1a;margin-bottom:5px;font-size:12px}
  .cond-text{font-size:11px;color:#3a3a2a;line-height:1.7}
  table.data-tbl{width:100%;border-collapse:collapse;margin-bottom:14px}
  table.data-tbl td{padding:7px 10px;border:1px solid #e8d5b0;font-size:11px}
  table.data-tbl td:first-child{background:#fef9f0;color:#5a5a4a;width:36%}
  table.zahl{width:100%;border-collapse:collapse;margin-bottom:14px;font-size:12px}
  table.zahl td{padding:6px 0;border-bottom:1px solid #e8d5b0}
  table.zahl td:last-child{text-align:right;font-weight:700;color:#1a4a1a}
  @media print{
    .print-btn{display:none!important}
    body{background:#fff}
    .page{padding:16px 20px}
    .pos-header{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .price-box{-webkit-print-color-adjust:exact;print-color-adjust:exact}
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
<style>${CSS}</style>
</head><body>

<button class="print-btn" onclick="window.print()">
  <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
    <path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z"/>
  </svg>
  Als PDF speichern
</button>

<div class="page">

  <div class="header">
    <img src="${LOGO_URL}" class="logo" alt="${FIRMA.name}" onerror="this.style.display='none'">
    <div class="header-right">
      ${FIRMA.adresse}<br>Tel: ${FIRMA.tel}<br>${FIRMA.mail}
    </div>
  </div>

  <div class="badge">Wärmepumpen Angebot</div>
  <div class="anr-title">Ihr persönliches Angebot ${d.angebotNr||''}</div>
  <div class="anr-date">Erstellt am ${d.date||new Date().toLocaleDateString('de-DE')}</div>

  <div class="rbox">
    <div class="nm">${d.salutation} ${d.firstName} ${d.lastName}${d.companyName?' / '+d.companyName:''}</div>
    <div class="ad">
      ${d.street} ${d.houseNumber} · ${d.zip} ${d.city}<br>
      ${d.phoneNumber}${d.mobileNumber?' · '+d.mobileNumber:''}<br>
      ${d.emailAddress}
    </div>
  </div>

  ${satUrl ? `<img src="${satUrl}" class="map-img" alt="Satellitenansicht" onerror="this.style.display='none'">` : ''}

  <p class="intro">
    Sehr geehrte${d.salutation==='Frau'?'':'r'} ${d.salutation} ${d.lastName},<br><br>
    wir freuen uns, Ihnen heute das Angebot für Ihre Wärmepumpe zusenden zu können.
    Gerne stehen wir Ihnen jederzeit mit Rat und Tat zur Seite.<br><br>
    Bei Fragen erreichen Sie uns unter <strong>${FIRMA.tel}</strong> oder <strong>${FIRMA.mail}</strong>.
  </p>

  <div style="border-top:2px solid #1a4a1a;margin:20px 0 16px"></div>
  <div style="font-size:16px;font-weight:700;color:#1a4a1a;text-align:center">Angebotsdetails ${d.angebotNr||''}</div>
  <div style="font-size:10px;color:#aaa;text-align:center;margin-bottom:14px">Beratung | Planung | Finanzservice | Logistik | Montage durch unsere zertifizierten Fachkräfte</div>

  <div class="sec">Technische Eckdaten</div>
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
        <div class="pd">R290 (Propan) · Vorlauftemperatur bis 70°C · Förderfähig nach BEG · Inverter-Technologie · 3-phasig</div>
      </div>
    </div>
  </div>

  <div class="pos-header">POS 2 — Wärmepumpen Inneneinheit</div>
  <div class="pos-row">
    <div class="pd">Kompakte Inneneinheit inkl. Umwälzpumpe, Umschaltventil und Sicherheitsarmaturen. Vorlauftemperatur bis 70°C.</div>
  </div>

  <table class="pos-tbl" style="margin-top:10px">
    <thead><tr><th class="pn">POS</th><th>Bezeichnung</th></tr></thead>
    <tbody>
      <tr><td class="pn">3</td><td><strong>Hochleistungs-Pufferspeicher 75L</strong><br><span style="color:#5a5a4a">✓ Max. 3 bar · bis 110°C · Vliesdämmung</span></td></tr>
      <tr><td class="pn">4</td><td><strong>Hochleistungs-Hygienespeicher 300L</strong><br><span style="color:#5a5a4a">✓ Max. 10 bar · Max. 95°C · El. Zusatzheizung 3kW · Klasse A+++</span></td></tr>
      <tr><td class="pn">5</td><td><strong>Elektrische Zusatzheizung (pauschal)</strong><br><span style="color:#5a5a4a">✓ Bis 9 kW · Automatischer Zuschaltbetrieb · Förderfähig nach BEG</span></td></tr>
      <tr><td class="pn">6</td><td><strong>Verrohrungssystem (pauschal)</strong><br><span style="color:#5a5a4a">✓ Gemäß GEG · Druckprüfung und Dichtheitsnachweis</span></td></tr>
      <tr><td class="pn">7</td><td><strong>Demontage Altanlage & Montage Neuanlage (pauschal)</strong><br><span style="color:#5a5a4a">✓ Fachgerechte Stilllegung · Aufstellung und Einbindung Wärmepumpe</span></td></tr>
      <tr><td class="pn">8</td><td><strong>Projektierung – Planung & technische Auslegung (pauschal)</strong><br><span style="color:#5a5a4a">✓ Heizlastberechnung DIN EN 12831 · Hydraulikschema · Förderantrag BEG EM</span></td></tr>
      <tr><td class="pn">9</td><td><strong>Fördermittel – Unterstützung & Abwicklung (pauschal)</strong><br><span style="color:#5a5a4a">✓ BEG EM über KfW · Optimale Förderoption · Vollständige Abwicklung</span></td></tr>
      <tr><td class="pn">10</td><td><strong>Anmeldung und Fertigmeldung beim Netzbetreiber (pauschal)</strong><br><span style="color:#5a5a4a">✓ EVU-Anmeldung · Betriebsschaltbild · Prüfprotokoll</span></td></tr>
      <tr><td class="pn">11</td><td><strong>Elektroinstallation Anschluss & Steuerung (pauschal)</strong><br><span style="color:#5a5a4a">✓ Fachgerechte Verlegung · FI-Schalter · Eingetragener Elektrofachbetrieb</span></td></tr>
      <tr><td class="pn">12</td><td><strong>Erstinbetriebnahme gemäß Herstellervorgaben (pauschal)</strong><br><span style="color:#5a5a4a">✓ Druckprüfung · Parametrierung · Einweisung des Betreibers</span></td></tr>
      <tr><td class="pn">13</td><td><strong>Hydraulischer Abgleich – Verfahren B nach VdZ (pauschal)</strong><br><span style="color:#5a5a4a">✓ VdZ-Nachweis · Voraussetzung für BEG EM Förderung</span></td></tr>
      <tr><td class="pn">14</td><td><strong>Technischer Support (pauschal)</strong><br><span style="color:#5a5a4a">✓ Hersteller & ${FIRMA.name} Service-Team</span></td></tr>
      <tr><td class="pn">15</td><td><strong>${FIRMA.name} – Garantieversprechen</strong><br><span style="color:#5a5a4a">✓ Bestpreisgarantie · Festpreisgarantie · 100% Käuferschutz · Keine Vorkasse</span></td></tr>
    </tbody>
  </table>

  ${agreementsHtml ? `
  <div class="sec">Zusatzvereinbarungen</div>
  <table class="pos-tbl"><tbody>${agreementsHtml}</tbody></table>` : ''}

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
    Bei Rückfragen: <strong>${FIRMA.tel}</strong> · <strong>${FIRMA.mail}</strong> · ${FIRMA.web}
  </div>

  <p style="font-size:11px;color:#555;margin-bottom:24px">
    Hiermit nehme ich das Angebot vom ${d.date||new Date().toLocaleDateString('de-DE')} an
    und beauftrage die <strong>${FIRMA.name}</strong> zur Durchführung meines Projektes.
  </p>

  <div style="display:flex;justify-content:space-between;margin-top:20px">
    <div><div class="sig-line"></div><div class="sig-label">Ort, Datum</div></div>
    <div style="text-align:right"><div class="sig-line" style="margin-left:auto"></div><div class="sig-label">Unterschrift — ${d.salutation} ${d.firstName} ${d.lastName}</div></div>
  </div>

  <div class="footer">
    <strong>${FIRMA.name}</strong> · ${FIRMA.adresse} · Tel: ${FIRMA.tel} · ${FIRMA.mail}<br>
    ${FIRMA.hrb} ${FIRMA.gericht} · EUID: ${FIRMA.euid} · Geschäftsführer: ${FIRMA.gf}
  </div>
  <div class="disclaimer">
    Sofern eine Teilzahlungsvereinbarung geschlossen wird, wird diese zum wesentlichen Bestandteil dieses Auftrages.
    Die staatlichen Fördermittel sind nicht Bestandteil dieses Angebots. ${FIRMA.name} übernimmt keine Haftung dafür.
    Mündliche Abmachungen sind nicht Bestandteil des Vertrags.
  </div>

</div>
<script>${PRINT_SCRIPT}</script>
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
</body></html>`;
}

app.listen(PORT, () => console.log('Volksenergie Schwaben PDF Service v5 running on port ' + PORT));
