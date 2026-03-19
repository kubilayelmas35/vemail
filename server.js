const express = require('express');
const cors    = require('cors');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── AYARLAR ──────────────────────────────────────────────────
const BASE_URL        = process.env.RENDER_EXTERNAL_URL || 'https://vemail-jqp4.onrender.com';
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';

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

// Renk paleti
const COL = {
  green:      '#1a4a1a',
  greenLight: '#2d7a2d',
  yellow:     '#f5b800',
  bg:         '#fdf3e7',
  bgLight:    '#fef9f0',
  border:     '#e8d5b0',
  muted:      '#5a5a4a',
  white:      '#ffffff',
  black:      '#1a1a1a',
};

const BROSCHURE_URLS = {
  viessmann_250: BASE_URL + '/pdfs/broschure-vitocal-250a.pdf',
  viessmann_150: BASE_URL + '/pdfs/broschure-vitocal-150a.pdf',
  buderus:       BASE_URL + '/pdfs/broschure-buderus-wlw186i.pdf',
};

const LOGO_URL = 'https://raw.githubusercontent.com/kubilayelmas35/vemail/refs/heads/main/public/images/logo.png';

// ── HEALTH ────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Volksenergie Schwaben PDF Service v3', engine: 'pdfmake' }));
app.get('/ping', (req, res) => res.json({ pong: true, time: new Date().toISOString() }));

// ── BROSCHÜRE REDIRECT ────────────────────────────────────────
app.get('/broschure', (req, res) => {
  const m = (req.query.module || '').toString();
  let url = BROSCHURE_URLS.viessmann_250;
  if (m.includes('150'))                              url = BROSCHURE_URLS.viessmann_150;
  else if (m.includes('BUDERUS') || m.includes('WLW')) url = BROSCHURE_URLS.buderus;
  res.redirect(302, url);
});
app.get('/viessmann-broschure', (req, res) => res.redirect(302, BROSCHURE_URLS.viessmann_250));

// ── PDF ENDPOINTS ─────────────────────────────────────────────
app.get('/angebot',       async (req, res) => { const d = await parseData(req); if (!d) return res.status(400).send('Veri eksik'); await sendPdf(buildAngebotDef(d), `Angebot_${d.angebotNr||'ANG'}_${d.lastName}`, res); });
app.get('/aufschiebende', async (req, res) => { const d = await parseData(req); if (!d) return res.status(400).send('Veri eksik'); await sendPdf(buildAufschiebendeDef(d), `Aufschiebende_${d.lastName}`, res); });
app.get('/vollmacht',     async (req, res) => { const d = await parseData(req); if (!d) return res.status(400).send('Veri eksik'); await sendPdf(buildVollmachtDef(d), `Vollmacht_${d.lastName}`, res); });

app.post('/angebot',       async (req, res) => { await sendPdf(buildAngebotDef(req.body), `Angebot_${req.body.angebotNr||'ANG'}_${req.body.lastName}`, res); });
app.post('/aufschiebende', async (req, res) => { await sendPdf(buildAufschiebendeDef(req.body), `Aufschiebende_${req.body.lastName}`, res); });
app.post('/vollmacht',     async (req, res) => { await sendPdf(buildVollmachtDef(req.body), `Vollmacht_${req.body.lastName}`, res); });

// ── HELPERS ───────────────────────────────────────────────────
async function parseData(req) {
  if (!req.query.data) return null;
  try {
    const b64 = req.query.data.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
  } catch (e) { return null; }
}

// pdfmake'i bir kez yükle
const pdfmake = require('pdfmake/build/pdfmake');
const vfsFonts = require('pdfmake/build/vfs_fonts');
// vfs_fonts modülü farklı versiyonlarda farklı export eder
pdfmake.vfs = (vfsFonts.pdfMake && vfsFonts.pdfMake.vfs)
  ? vfsFonts.pdfMake.vfs
  : vfsFonts.vfs || vfsFonts;

// Logo base64 — startup'ta bir kez yükle
let LOGO_BASE64 = null;
async function loadLogo() {
  try {
    const imgRes = await axios.get(LOGO_URL, { responseType: 'arraybuffer', timeout: 8000 });
    LOGO_BASE64 = 'data:image/png;base64,' + Buffer.from(imgRes.data).toString('base64');
    console.log('Logo yüklendi.');
  } catch (e) { console.warn('Logo yüklenemedi:', e.message); }
}
loadLogo();

async function sendPdf(docDef, filename, res) {
  try {
    // Logo placeholder'ı doldur
    if (LOGO_BASE64) {
      const defStr = JSON.stringify(docDef).replace(/"LOGO_PLACEHOLDER"/g, JSON.stringify(LOGO_BASE64));
      docDef = JSON.parse(defStr);
    } else {
      // Logo yoksa image alanlarını text ile değiştir
      const defStr = JSON.stringify(docDef).replace(
        /\{"image":"LOGO_PLACEHOLDER"[^}]*\}/g,
        JSON.stringify({ text: 'Volksenergie Schwaben GmbH', fontSize: 14, bold: true, color: '#1a4a1a' })
      );
      docDef = JSON.parse(defStr);
    }

    const pdfDoc = pdfmake.createPdf(docDef);
    pdfDoc.getBuffer((buffer) => {
      res.set({
        'Content-Type':        'application/pdf',
        'Content-Disposition': `inline; filename="${filename}.pdf"`,
        'Content-Length':      buffer.length,
        'Cache-Control':       'no-cache',
      });
      res.send(buffer);
    });
  } catch (err) {
    console.error('PDF hatası:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
}

function fmt(n) { return (parseFloat(n)||0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// ── ORTAK STILLER ─────────────────────────────────────────────
function headerContent(title) {
  return [
    {
      columns: [
        { image: 'LOGO_PLACEHOLDER', width: 120, margin: [0, 0, 0, 0] },
        {
          stack: [
            { text: FIRMA.adresse, fontSize: 9, color: COL.muted, alignment: 'right' },
            { text: `Tel: ${FIRMA.tel}`, fontSize: 9, color: COL.muted, alignment: 'right' },
            { text: FIRMA.mail, fontSize: 9, color: COL.muted, alignment: 'right' },
          ],
          alignment: 'right',
        }
      ],
      margin: [0, 0, 0, 8],
    },
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: COL.green }] },
    { text: title, fontSize: 9, bold: true, color: COL.white, background: COL.green, margin: [0, 6, 0, 10], padding: [6, 4, 6, 4] },
  ];
}

function firmaFooter() {
  return {
    stack: [
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: COL.green }] },
      {
        text: `${FIRMA.name}  |  ${FIRMA.adresse}  |  ${FIRMA.hrb} ${FIRMA.gericht}  |  ${FIRMA.euid}  |  GF: ${FIRMA.gf}`,
        fontSize: 8, color: COL.muted, margin: [0, 6, 0, 0], alignment: 'center'
      }
    ],
    margin: [0, 16, 0, 0],
  };
}

function sectionTitle(text) {
  return {
    stack: [
      { text: text, fontSize: 9, bold: true, color: COL.green, margin: [0, 12, 0, 2] },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: COL.yellow }] },
    ],
    margin: [0, 0, 0, 6],
  };
}

// ── 1. ANGEBOT ────────────────────────────────────────────────
function buildAngebotDef(d) {
  const brutto   = parseFloat(d.totalIncl) || 0;
  const netto    = brutto / 1.19;
  const mwst     = brutto - netto;
  const foerder  = parseFloat(d.foerderSumme) || 0;
  const eigen    = brutto - foerder;
  const modName  = d.moduleName || d.module || '–';

  const isBuderus = modName.includes('BUDERUS') || modName.includes('WLW');
  const is150     = modName.includes('150');

  const agreementLabels = {
    '22143': 'inkl. SG Ready Schnittstelle-PV/WP (Aufputz/bis 5m)',
    '22142': 'inkl. Aufstellort Außen bis 2m - ab 2m je Meter 250€',
    '22141': 'inkl. Erdung 2x je 10m, falls nicht vorhanden',
    '22140': 'inkl. zwei Heizkreise (Fußbodenheizung/Heizkörper)',
    '22139': 'inkl. Fußbodenheizkreisverteiler Austausch',
    '22138': 'inkl. Niedertemperaturheizkörper mit Kühlfunktion',
    '22137': 'inkl. Heizkörpertausch gemäß Heizlastberechnung',
    '22135': 'inkl. Solarthermie-Anbindung',
    '22134': 'inkl. Unterverteilung für 2. Stromzähler (WP-Tarif)',
    '22133': 'inkl. 14A Schrank (APZ & RFZ Feld)',
    '22114': 'KfW-Ablehnungsklausel: Kostenfreie Stornierung bei Ablehnung',
    '22049': 'inkl. neuem separaten 2-Zählerfeld Zählerschrank',
    '22048': 'inkl. Ausbau und Entsorgung des Öltanks',
    '22044': 'inkl. neuem separaten 4-Zählerfeld Zählerschrank',
    '22043': 'inkl. neuem separaten 3-Zählerfeld Zählerschrank',
  };

  const agreementRows = (d.agreements || []).map(v => [
    { text: '✓ ' + (agreementLabels[v] || v), fontSize: 9, color: COL.black }
  ]);

  const posRows = [
    ['1', 'Wärmepumpen Außengerät', modName + '\nR290 (Propan) · Vorlauftemperatur bis 70°C · Förderfähig nach BEG'],
    ['2', 'Wärmepumpen Inneneinheit', 'Kompakte Inneneinheit inkl. Umwälzpumpe, Umschaltventil und Sicherheitsarmaturen'],
    ['3', 'Hochleistungs-Pufferspeicher 75L', '✓ Max. 3 bar · bis 110°C · Vliesdämmung'],
    ['4', 'Hochleistungs-Hygienespeicher 300L', '✓ Max. 10 bar · Max. 95°C · El. Zusatzheizung 3kW · Klasse A+++'],
    ['5', 'Elektrische Zusatzheizung (pauschal)', '✓ Bis 9 kW · Automatischer Zuschaltbetrieb · Förderfähig nach BEG'],
    ['6', 'Verrohrungssystem (pauschal)', '✓ Gemäß GEG · Druckprüfung und Dichtheitsnachweis'],
    ['7', 'Demontage Altanlage & Montage Neuanlage (pauschal)', '✓ Fachgerechte Stilllegung · Aufstellung und Einbindung Wärmepumpe'],
    ['8', 'Projektierung – Planung & technische Auslegung (pauschal)', '✓ Heizlastberechnung DIN EN 12831 · Hydraulikschema · Förderunterstützung'],
    ['9', 'Fördermittel – Unterstützung & Abwicklung (pauschal)', '✓ BEG EM über KfW · Optimale Förderoption · Vollständige Abwicklung'],
    ['10', 'Anmeldung und Fertigmeldung beim Netzbetreiber (pauschal)', '✓ EVU-Anmeldung · Betriebsschaltbild · Prüfprotokoll'],
    ['11', 'Elektroinstallation Anschluss & Steuerung (pauschal)', '✓ Fachgerechte Verlegung · FI-Schalter · Eingetragener Elektrofachbetrieb'],
    ['12', 'Erstinbetriebnahme gemäß Herstellervorgaben (pauschal)', '✓ Druckprüfung · Parametrierung · Einweisung des Betreibers'],
    ['13', 'Hydraulischer Abgleich – Verfahren B nach VdZ (pauschal)', '✓ VdZ-Nachweis · Voraussetzung für BEG EM Förderung'],
    ['14', 'Technischer Support (pauschal)', '✓ Hersteller & Volksenergie Schwaben Service-Team'],
    ['15', 'Volksenergie Schwaben GmbH – Garantieversprechen', '✓ Bestpreisgarantie · Festpreisgarantie · 100% Käuferschutz · Keine Vorkasse'],
  ].map(([pos, title, desc]) => [
    { text: pos, fontSize: 9, bold: true, color: COL.green, alignment: 'center' },
    { stack: [{ text: title, fontSize: 9, bold: true, color: COL.black }, { text: desc, fontSize: 8, color: COL.muted, margin: [0, 2, 0, 0] }] },
  ]);

  return {
    pageSize:    'A4',
    pageMargins: [40, 40, 40, 60],
    background:  (page, pageSize) => ({ canvas: [{ type: 'rect', x: 0, y: 0, w: pageSize.width, h: pageSize.height, color: COL.bg }] }),

    footer: (page, pages) => ({
      columns: [
        { text: `${FIRMA.name}  |  ${FIRMA.adresse}  |  ${FIRMA.hrb} ${FIRMA.gericht}  |  GF: ${FIRMA.gf}`, fontSize: 7, color: COL.muted, margin: [40, 0, 40, 0] },
        { text: `Seite ${page} / ${pages}`, fontSize: 7, color: COL.muted, alignment: 'right', margin: [0, 0, 40, 0] },
      ],
      margin: [0, 8, 0, 0],
    }),

    content: [
      // KAPAK BLOK
      {
        stack: [
          { image: 'LOGO_PLACEHOLDER', width: 180, alignment: 'center', margin: [0, 0, 0, 16] },
          { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: COL.green }] },
          { text: 'Ihr persönliches Angebot', fontSize: 22, bold: true, color: COL.green, alignment: 'center', margin: [0, 12, 0, 4] },
          { text: `${d.salutation} ${d.firstName} ${d.lastName}`, fontSize: 14, color: COL.black, alignment: 'center', margin: [0, 0, 0, 4] },
          { text: `${d.street} ${d.houseNumber}, ${d.zip} ${d.city}`, fontSize: 11, color: COL.muted, alignment: 'center', margin: [0, 0, 0, 4] },
          {
            text: `Angebot ${d.angebotNr||''} · ${d.date||new Date().toLocaleDateString('de-DE')}`,
            fontSize: 10, color: COL.yellow, bold: true, alignment: 'center',
            background: COL.green, margin: [0, 8, 0, 0], padding: [8, 4],
          },
          { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: COL.green }], margin: [0, 12, 0, 0] },
        ],
        margin: [0, 0, 0, 20],
      },

      // BERATER
      {
        columns: [
          {
            stack: [
              { text: `Ihr persönlicher Berater: ${FIRMA.gf}`, fontSize: 9, bold: true, color: COL.white, background: COL.yellow, padding: [4, 3] },
              { text: `Tel: ${FIRMA.tel} · ${FIRMA.mail}`, fontSize: 8, color: COL.muted, margin: [0, 4, 0, 0] },
              { text: 'Erreichbar: Mo–Fr 9:00–17:00 Uhr', fontSize: 8, color: COL.muted },
            ]
          },
          {
            stack: [
              { text: `${d.salutation} ${d.firstName} ${d.lastName}`, fontSize: 10, bold: true, color: COL.black, alignment: 'right' },
              { text: `${d.street} ${d.houseNumber}, ${d.zip} ${d.city}`, fontSize: 9, color: COL.muted, alignment: 'right' },
              { text: d.phoneNumber || '', fontSize: 9, color: COL.muted, alignment: 'right' },
              { text: d.emailAddress || '', fontSize: 9, color: COL.muted, alignment: 'right' },
            ]
          }
        ],
        margin: [0, 0, 0, 16],
      },

      // ANSCHREIBEN
      {
        text: [
          `Sehr geehrte${d.salutation==='Frau'?'':'r'} ${d.salutation} ${d.lastName},\n\n`,
          `wir freuen uns, Ihnen heute das Angebot für Ihre Wärmepumpe zusenden zu können. `,
          `Gerne stehen wir Ihnen jederzeit mit Rat und Tat zur Seite.\n\n`,
          `Bei Fragen erreichen Sie uns unter ${FIRMA.tel} oder ${FIRMA.mail}.`,
        ],
        fontSize: 10, color: COL.black, margin: [0, 0, 0, 16],
      },

      // TRENNLINIE
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: COL.green }], margin: [0, 0, 0, 12] },

      // ANGEBOTSDETAILS TITEL
      { text: `Angebotsdetails ${d.angebotNr||''}`, fontSize: 16, bold: true, color: COL.green, alignment: 'center' },
      { text: 'Leistungsübersicht der Volksenergie Schwaben GmbH', fontSize: 9, color: COL.muted, alignment: 'center', margin: [0, 2, 0, 4] },
      { text: 'Beratung | Planung | Finanzservice | Logistik | Montage und Inbetriebnahme durch unsere zertifizierten Fachkräfte', fontSize: 8, color: COL.muted, alignment: 'center', margin: [0, 0, 0, 12] },

      // TECHNISCHE ECKDATEN
      sectionTitle('TECHNISCHE ECKDATEN DES OBJEKTES'),
      {
        table: {
          widths: ['*', '*', '*'],
          body: [
            [
              { stack: [{ text: 'WOHNFLÄCHE', fontSize: 7, color: COL.muted }, { text: (d.wohnflaeche||'–') + ' m²', fontSize: 10, bold: true, color: COL.green }], fillColor: COL.bgLight, margin: [6, 6, 6, 6] },
              { stack: [{ text: 'BAUJAHR', fontSize: 7, color: COL.muted }, { text: d.baujahr||'–', fontSize: 10, bold: true, color: COL.green }], fillColor: COL.bgLight, margin: [6, 6, 6, 6] },
              { stack: [{ text: 'HEIZKÖRPER', fontSize: 7, color: COL.muted }, { text: d.heizkoerper||'–', fontSize: 10, bold: true, color: COL.green }], fillColor: COL.bgLight, margin: [6, 6, 6, 6] },
            ],
            [
              { stack: [{ text: 'HEIZENERGIEART', fontSize: 7, color: COL.muted }, { text: d.heizenergieart||'–', fontSize: 10, bold: true, color: COL.green }], fillColor: COL.bgLight, margin: [6, 6, 6, 6] },
              { stack: [{ text: 'VERBRAUCH/JAHR', fontSize: 7, color: COL.muted }, { text: d.energy ? parseInt(d.energy).toLocaleString('de-DE') + ' kWh' : '–', fontSize: 10, bold: true, color: COL.green }], fillColor: COL.bgLight, margin: [6, 6, 6, 6] },
              { stack: [{ text: 'HEIZKOSTEN/JAHR', fontSize: 7, color: COL.muted }, { text: d.kwhprice ? parseFloat(d.kwhprice).toLocaleString('de-DE', {minimumFractionDigits:2}) + ' €' : '–', fontSize: 10, bold: true, color: COL.green }], fillColor: COL.bgLight, margin: [6, 6, 6, 6] },
            ],
          ],
        },
        layout: { hLineColor: () => COL.border, vLineColor: () => COL.border },
        margin: [0, 0, 0, 12],
      },

      // LEISTUNGSÜBERSİCHT
      sectionTitle('LEISTUNGSÜBERSICHT'),
      {
        table: {
          widths: [24, '*'],
          body: [
            [
              { text: 'POS', fontSize: 8, bold: true, color: COL.white, fillColor: COL.green, alignment: 'center', margin: [2, 4, 2, 4] },
              { text: 'BEZEICHNUNG', fontSize: 8, bold: true, color: COL.white, fillColor: COL.green, margin: [4, 4, 4, 4] },
            ],
            ...posRows.map((row, i) => row.map(cell => ({ ...cell, fillColor: i % 2 === 0 ? COL.bgLight : COL.bg, margin: [cell.alignment === 'center' ? 2 : 4, 3, 4, 3] }))),
          ],
        },
        layout: { hLineColor: () => COL.border, vLineColor: () => COL.border },
        margin: [0, 0, 0, 12],
      },

      // ZUSATZVEREINBARUNGEN
      ...(agreementRows.length > 0 ? [
        sectionTitle('ZUSATZVEREINBARUNGEN'),
        {
          table: { widths: ['*'], body: agreementRows.map(r => r.map(c => ({ ...c, margin: [4, 3, 4, 3], fillColor: COL.bgLight }))) },
          layout: { hLineColor: () => COL.border, vLineColor: () => COL.border },
          margin: [0, 0, 0, 12],
        }
      ] : []),

      // ZAHLUNGSMODALITÄTEN
      sectionTitle('ZAHLUNGSMODALITÄTEN'),
      {
        table: {
          widths: ['*', 100],
          body: [
            [{ text: '1. Abschlag, 80%, bei Warenlieferung', fontSize: 9 }, { text: fmt(brutto * 0.8) + ' €', fontSize: 9, bold: true, color: COL.green, alignment: 'right' }],
            [{ text: '2. Abschlag, 20%, bei Inbetriebnahme', fontSize: 9 }, { text: fmt(brutto * 0.2) + ' €', fontSize: 9, bold: true, color: COL.green, alignment: 'right' }],
          ],
        },
        layout: { hLineColor: () => COL.border, vLineColor: () => 'transparent' },
        margin: [0, 0, 0, 12],
      },

      // PREISBOX
      {
        table: {
          widths: ['*', 120],
          body: [
            [{ text: 'Gesamtsumme Netto', fontSize: 9, color: 'rgba(255,255,255,0.7)', margin: [8, 4, 4, 4] }, { text: fmt(netto) + ' €', fontSize: 9, color: 'rgba(255,255,255,0.7)', alignment: 'right', margin: [4, 4, 8, 4] }],
            [{ text: '19% MwSt.', fontSize: 9, color: 'rgba(255,255,255,0.7)', margin: [8, 4, 4, 4] }, { text: fmt(mwst) + ' €', fontSize: 9, color: 'rgba(255,255,255,0.7)', alignment: 'right', margin: [4, 4, 8, 4] }],
            [{ text: 'Gesamtsumme Brutto', fontSize: 13, bold: true, color: COL.white, margin: [8, 8, 4, 8] }, { text: fmt(brutto) + ' €', fontSize: 13, bold: true, color: COL.white, alignment: 'right', margin: [4, 8, 8, 8] }],
            ...(foerder > 0 ? [
              [{ text: `Ihre Fördersumme (${d.heatingcosts||''}% KfW BEG)`, fontSize: 10, bold: true, color: COL.yellow, margin: [8, 4, 4, 4] }, { text: fmt(foerder) + ' €', fontSize: 10, bold: true, color: COL.yellow, alignment: 'right', margin: [4, 4, 8, 4] }],
              [{ text: 'Ihr Eigenanteil nach Förderung', fontSize: 10, bold: true, color: '#7ec87e', margin: [8, 4, 4, 8] }, { text: fmt(eigen) + ' €', fontSize: 10, bold: true, color: '#7ec87e', alignment: 'right', margin: [4, 4, 8, 8] }],
            ] : []),
          ],
        },
        layout: {
          fillColor: () => COL.green,
          hLineColor: () => 'rgba(255,255,255,0.15)',
          vLineColor: () => 'transparent',
        },
        margin: [0, 0, 0, 16],
      },

      // TÜV NOTU
      {
        text: 'Unsere Fachpartner verwenden ausschließlich TÜV-geprüfte Komponenten, die sämtlichen gängigen Normen und Zertifizierungen entsprechen. Es gelten die Garantien nach Herstellerangaben.',
        fontSize: 8, color: COL.muted, italics: true,
        background: COL.bgLight, margin: [0, 0, 0, 16],
        padding: [6, 4],
      },

      // KONTAKT BOX
      {
        text: `Bei Rückfragen stehen wir Ihnen jederzeit zur Verfügung · ${FIRMA.tel} · ${FIRMA.mail} · ${FIRMA.web}`,
        fontSize: 9, color: COL.white, bold: true, alignment: 'center',
        background: COL.green, margin: [0, 0, 0, 16], padding: [8, 6],
      },

      // UNTERSCHRIFT
      {
        text: `Hiermit nehme ich das Angebot vom ${d.date||new Date().toLocaleDateString('de-DE')} an und beauftrage die ${FIRMA.name} zur Durchführung meines Projektes.`,
        fontSize: 9, color: COL.black, margin: [0, 0, 0, 32],
      },
      {
        columns: [
          { stack: [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 1, lineColor: COL.green }] }, { text: 'Ort, Datum', fontSize: 8, color: COL.muted, margin: [0, 4, 0, 0] }] },
          { stack: [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 1, lineColor: COL.green }] }, { text: `Unterschrift — ${d.salutation} ${d.firstName} ${d.lastName}`, fontSize: 8, color: COL.muted, margin: [0, 4, 0, 0] }], alignment: 'right' },
        ],
        margin: [0, 0, 0, 16],
      },

      // DISCLAIMER
      {
        text: `Sofern eine Teilzahlungsvereinbarung geschlossen wird, wird diese zum wesentlichen Bestandteil dieses Auftrages. Die staatlichen Fördermittel sind nicht Bestandteil dieses Angebots. ${FIRMA.name} übernimmt keine Haftung dafür. Mündliche Abmachungen sind nicht Bestandteil des Vertrags.`,
        fontSize: 7.5, color: '#8a8a7a', margin: [0, 0, 0, 0],
      },
    ],
  };
}

// ── 2. AUFSCHIEBENDE BEDINGUNGEN ─────────────────────────────
function buildAufschiebendeDef(d) {
  return {
    pageSize: 'A4', pageMargins: [40, 40, 40, 60],
    background: (page, pageSize) => ({ canvas: [{ type: 'rect', x: 0, y: 0, w: pageSize.width, h: pageSize.height, color: COL.bg }] }),
    footer: (page, pages) => ({ text: `${FIRMA.name}  |  ${FIRMA.adresse}  |  Seite ${page}/${pages}`, fontSize: 7, color: COL.muted, alignment: 'center', margin: [40, 8, 40, 0] }),
    content: [
      { image: 'LOGO_PLACEHOLDER', width: 150, alignment: 'left', margin: [0, 0, 0, 8] },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: COL.green }], margin: [0, 0, 0, 6] },
      { text: 'AUFSCHIEBENDE BEDINGUNGEN', fontSize: 9, bold: true, color: COL.white, background: COL.green, padding: [6, 4], margin: [0, 0, 0, 16] },

      sectionTitle('AUFSCHIEBENDE BEDINGUNG'),
      { text: 'Dieser (Kauf-)Vertrag tritt hinsichtlich der Liefer- und Leistungspflichten zur Umsetzung erst und nur insoweit in Kraft, wenn und soweit die KfW den Antrag zur Heizungsmodernisierung bewilligt und die Förderung mit einer Zusage gegenüber der antragstellenden Vertragspartei zugesagt hat. Die antragstellende Vertragspartei wird die jeweils andere Vertragspartei über den Eintritt und den Umfang des Eintritts der Bedingung unverzüglich in Kenntnis setzen.', fontSize: 10, color: COL.black, margin: [0, 0, 0, 14] },

      sectionTitle('AUFLÖSENDE BEDINGUNG'),
      { text: 'Dieser (Kauf-)Vertrag erlischt hinsichtlich der Liefer- und Leistungspflichten zur Umsetzung, sobald und soweit die KfW den Antrag zur Heizungsmodernisierung nicht bewilligt, sondern ablehnt und die Förderung nicht mit einer Zusage gegenüber der antragstellenden Vertragspartei zusagt, sondern mit einem Ablehnungsbescheid versagt.\n\nDie antragstellende Vertragspartei wird die jeweils andere Vertragspartei über den Eintritt und den Umfang des Eintritts der Bedingung unverzüglich in Kenntnis setzen.', fontSize: 10, color: COL.black, margin: [0, 0, 0, 14] },

      sectionTitle('WIDERRUFSRECHT'),
      { text: 'Sie haben das Recht, binnen 14 Tagen ohne Angaben von Gründen diesen Vertrag zu widerrufen.\n\nDie Widerrufsfrist beträgt 14 Tage ab dem Tag des Vertragsabschlusses. Sie beginnt nicht zu laufen, bevor Sie diese Belehrung in Textform erhalten haben.\n\nUm Ihr Widerrufsrecht auszuüben, müssen Sie uns mittels einer eindeutigen Erklärung (z.B. Brief, Telefax oder E-Mail) über Ihren Entschluss, diesen Vertrag zu widerrufen, informieren.\n\nZur Wahrung der Widerrufsfrist reicht es aus, dass Sie die Erklärung über die Ausübung des Widerrufsrechts vor Ablauf der Widerrufsfrist absenden.', fontSize: 10, color: COL.black, margin: [0, 0, 0, 14] },

      sectionTitle('FOLGEN DES WIDERRUFS'),
      { text: 'Wenn Sie diesen Vertrag widerrufen, haben wir Ihnen alle Zahlungen, die wir von Ihnen erhalten haben, unverzüglich zurückzuzahlen.\n\nSie müssen uns im Falle des Widerrufs alle Leistungen zurückgeben, die Sie bis zum Widerruf von uns erhalten haben. Ist die Rückgewähr einer Leistung ihrer Natur nach ausgeschlossen, lassen sich etwa verwendete Baumaterialien nicht ohne Zerstörung entfernen, müssen Sie Wertersatz dafür bezahlen.', fontSize: 10, color: COL.black, margin: [0, 0, 0, 32] },

      {
        columns: [
          { stack: [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 1, lineColor: COL.green }] }, { text: 'Ort, Datum', fontSize: 8, color: COL.muted, margin: [0, 4, 0, 0] }] },
          { stack: [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 1, lineColor: COL.green }] }, { text: `Unterschrift${d.firstName ? ' — ' + d.salutation + ' ' + d.firstName + ' ' + d.lastName : ''}`, fontSize: 8, color: COL.muted, margin: [0, 4, 0, 0] }], alignment: 'right' },
        ],
      },
    ],
  };
}

// ── 3. VOLLMACHT ──────────────────────────────────────────────
function buildVollmachtDef(d) {
  function dataRow(label, value) {
    return [
      { text: label, fontSize: 9, color: COL.muted, fillColor: COL.bgLight, margin: [4, 4, 4, 4] },
      { text: value || '', fontSize: 9, color: COL.black, margin: [4, 4, 4, 4] },
    ];
  }
  return {
    pageSize: 'A4', pageMargins: [40, 40, 40, 60],
    background: (page, pageSize) => ({ canvas: [{ type: 'rect', x: 0, y: 0, w: pageSize.width, h: pageSize.height, color: COL.bg }] }),
    footer: (page, pages) => ({ text: `${FIRMA.name}  |  ${FIRMA.adresse}`, fontSize: 7, color: COL.muted, alignment: 'center', margin: [40, 8, 40, 0] }),
    content: [
      { image: 'LOGO_PLACEHOLDER', width: 150, alignment: 'left', margin: [0, 0, 0, 8] },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: COL.green }], margin: [0, 0, 0, 6] },
      { text: 'VOLLMACHT', fontSize: 9, bold: true, color: COL.white, background: COL.green, padding: [6, 4], margin: [0, 0, 0, 8] },
      { text: 'für die Abwicklung und Erledigung der erforderlichen An- und Fertigmeldungen meines Bauvorhabens beim zuständigen Netzbetreiber.', fontSize: 10, bold: true, color: COL.black, margin: [0, 0, 0, 14] },

      sectionTitle('HIERMIT BEVOLLMÄCHTIGE(N) ICH/WIR:'),
      {
        table: {
          widths: ['35%', '65%'],
          body: [
            dataRow('Vorname', d.firstName),
            dataRow('Name', d.lastName),
            dataRow('Straße / Nr.', `${d.street||''} ${d.houseNumber||''}`),
            dataRow('PLZ / Ort', `${d.zip||''} ${d.city||''}`),
            dataRow('Geburtsdatum', ''),
            dataRow('Mobil', d.mobileNumber || ''),
            dataRow('Telefon', d.phoneNumber || ''),
            dataRow('E-Mail', d.emailAddress || ''),
          ],
        },
        layout: { hLineColor: () => COL.border, vLineColor: () => COL.border },
        margin: [0, 0, 0, 12],
      },

      { text: `Die Firma ${FIRMA.name}, ${FIRMA.adresse} bzw. deren ausgewiesenen Repräsentanten oder Vertragspartnern, alle erforderlichen Unterlagen, im Rahmen der elektronischen Antragsstellung zur An- und Fertigmeldung meines Bauvorhabens beim zuständigen Netzbetreiber, für den Antragsteller und den Grundstückseigentümer in meinem/unseren Namen auszufüllen, zu unterzeichnen und einzureichen.`, fontSize: 10, bold: true, color: COL.black, background: COL.bgLight, margin: [0, 0, 0, 14], padding: [6, 6] },

      sectionTitle('ADRESSE DES BAUVORHABENS:'),
      {
        table: {
          widths: ['35%', '65%'],
          body: [
            dataRow('Straße, Hr.', `${d.street||''} ${d.houseNumber||''}`),
            dataRow('PLZ, Ort', `${d.zip||''} ${d.city||''}`),
            dataRow('Germarkung', ''),
            dataRow('Flurnummer', ''),
            dataRow('Zählernummer', ''),
            dataRow('Netzbetreiber', ''),
          ],
        },
        layout: { hLineColor: () => COL.border, vLineColor: () => COL.border },
        margin: [0, 0, 0, 12],
      },

      sectionTitle('DIE EINSPEISEVERGÜTUNG SOLL AUF FOLGENDES KONTO ÜBERWIESEN WERDEN:'),
      {
        table: {
          widths: ['35%', '65%'],
          body: [
            dataRow('Kontoinhaber', ''),
            dataRow('Steuernummer', ''),
            dataRow('IBAN, BIC', ''),
          ],
        },
        layout: { hLineColor: () => COL.border, vLineColor: () => COL.border },
        margin: [0, 0, 0, 20],
      },

      { text: 'Diese Vollmacht ist gültig bis zum Abschluss o.g. Maßnahme.', fontSize: 10, bold: true, alignment: 'center', color: COL.black, margin: [0, 0, 0, 32] },

      {
        columns: [
          { stack: [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 1, lineColor: COL.green }] }, { text: 'Datum, Ort', fontSize: 8, color: COL.muted, margin: [0, 4, 0, 0] }] },
          { stack: [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 1, lineColor: COL.green }] }, { text: 'Unterschrift(en) Auftraggeber(in)', fontSize: 8, color: COL.muted, margin: [0, 4, 0, 0] }], alignment: 'right' },
        ],
      },
    ],
  };
}

app.listen(PORT, () => console.log(`Volksenergie Schwaben PDF Service v3 (pdfmake) running on port ${PORT}`));
